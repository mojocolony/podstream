const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BYTES = 10_000_000;
const MAX_REDIRECTS = 5;
const MAX_CANDIDATES = 12;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const input = typeof body?.url === "string" ? body.url.trim() : "";
    if (!input) return json({ error: "Missing url" });

    const startUrl = normalizeUrl(input);
    if (!startUrl) return json({ error: "Invalid URL" });

    const first = await safeFetchText(startUrl, "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*;q=0.5");

    if (looksLikeFeed(first.text, first.contentType)) {
      const feed = parseFeed(first.text, first.url);
      if (feed.episodes.length) return json(feed);
    }

    if (!looksLikeHtml(first.text, first.contentType)) {
      return json({ error: "No podcast feed found. Try pasting the RSS feed directly." });
    }

    const candidateUrls = discoverFeedUrls(first.text, first.url).slice(0, MAX_CANDIDATES);
    const feeds = [];

    for (const candidate of candidateUrls) {
      try {
        const fetched = await safeFetchText(candidate, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5");
        if (!looksLikeFeed(fetched.text, fetched.contentType)) continue;
        const feed = parseFeed(fetched.text, fetched.url);
        if (!feed.episodes.length) continue;
        if (!feeds.some((existing) => existing.feedUrl === feed.feedUrl)) feeds.push(feed);
      } catch {
        // Candidate discovery is best effort. Invalid/unreachable candidates are ignored.
      }
    }

    if (!feeds.length) {
      const directoryFeeds = await discoverViaPodcastDirectory(first.text, first.url);
      for (const feed of directoryFeeds) {
        if (!feeds.some((existing) => existing.feedUrl === feed.feedUrl)) feeds.push(feed);
      }
    }

    // User-facing discovery failures are returned as JSON with HTTP 200 so the
    // browser can display the useful message instead of Supabase's generic
    // FunctionsHttpError text for non-2xx responses. Authentication failures
    // still happen at the Supabase gateway before this code runs.
    if (!feeds.length) {
      return json({ error: "No podcast feed found. Try pasting the RSS feed directly." });
    }
    if (feeds.length === 1) return json(feeds[0]);
    return json({ choices: feeds.slice(0, 8) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed discovery failed";
    return json({ error: message });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeUrl(value: string) {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || isBlockedHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function safeFetchText(input: string, accept: string) {
  let current = new URL(input);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    if (!["http:", "https:"].includes(current.protocol) || isBlockedHost(current.hostname)) {
      throw new Error("Private or local hosts are not allowed");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response: Response;
    try {
      response = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "Podstream/0.1.13 (+personal podcast reader)",
          accept,
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Feed redirect was missing a destination");
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) throw new Error(`Address returned ${response.status}`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) throw new Error("Response is too large");
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error("Response is too large");
    return {
      url: current.toString(),
      text,
      contentType: (response.headers.get("content-type") || "").toLowerCase(),
    };
  }
  throw new Error("Too many redirects");
}

function isBlockedHost(hostname: string) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fc|fd|fe80):/i.test(h)) return true;
  return false;
}

function looksLikeFeed(text: string, contentType: string) {
  const head = text.slice(0, 4000).toLowerCase();
  return contentType.includes("rss") || contentType.includes("atom") || contentType.includes("application/xml") || contentType.includes("text/xml") ||
    /<(rss|feed|rdf:rdf)\b/i.test(head);
}

function looksLikeHtml(text: string, contentType: string) {
  const head = text.slice(0, 4000).toLowerCase();
  return contentType.includes("text/html") || /<!doctype\s+html|<html\b|<head\b|<body\b/i.test(head);
}

function discoverFeedUrls(html: string, pageUrl: string) {
  const candidates: { url: string; score: number }[] = [];
  const add = (href: string, score: number) => {
    try {
      const resolved = new URL(decodeHtml(href), pageUrl);
      if (!["http:", "https:"].includes(resolved.protocol) || isBlockedHost(resolved.hostname)) return;
      const url = resolved.toString();
      const existing = candidates.find((item) => item.url === url);
      if (existing) existing.score = Math.max(existing.score, score);
      else candidates.push({ url, score });
    } catch {
      // Ignore malformed links.
    }
  };

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const href = htmlAttr(tag, "href");
    if (!href) continue;
    const rel = (htmlAttr(tag, "rel") || "").toLowerCase();
    const type = (htmlAttr(tag, "type") || "").toLowerCase();
    const title = (htmlAttr(tag, "title") || "").toLowerCase();
    if (rel.includes("alternate") && /(rss|atom|xml)/.test(type)) add(href, 100);
    else if (/(podcast|rss|feed)/.test(title) || /(rss|feed)/.test(type)) add(href, 80);
  }

  for (const match of html.matchAll(/<a\b[^>]*href=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/gi)) {
    const tag = match[0];
    const href = htmlAttr(tag, "href");
    if (!href) continue;
    const text = stripTags(tag).toLowerCase();
    const hrefLower = href.toLowerCase();
    if (/\b(rss|podcast feed|subscribe via rss|feed)\b/.test(text)) add(href, 65);
    else if (/(\/|\b)(rss|feed)(\/|\.|\?|$)/.test(hrefLower) || /\.(rss|xml)(\?|$)/.test(hrefLower)) add(href, 45);
  }

  // Common feed endpoints are attempted last and only survive if they contain audio enclosures.
  const base = new URL(pageUrl);
  for (const path of ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/podcast.xml", "/podcast/feed/"]) {
    add(new URL(path, base.origin).toString(), 10);
  }

  return candidates.sort((a, b) => b.score - a.score).map((item) => item.url);
}


function pagePodcastName(html: string, pageUrl: string) {
  const metaCandidates = [
    metaContent(html, "property", "og:site_name"),
    metaContent(html, "property", "og:title"),
    metaContent(html, "name", "twitter:title"),
  ].filter(Boolean);
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  if (titleTag) metaCandidates.push(stripTags(titleTag));
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./i, "").split(".")[0];
    if (host) metaCandidates.push(host);
  } catch { /* ignore */ }

  for (const candidate of metaCandidates) {
    const cleaned = cleanPodcastName(candidate);
    if (cleaned.length >= 3) return cleaned;
  }
  return "";
}

function metaContent(html: string, key: string, value: string) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if ((htmlAttr(tag, key) || "").toLowerCase() === value.toLowerCase()) return decodeEntities(htmlAttr(tag, "content"));
  }
  return "";
}

function cleanPodcastName(value: string) {
  let s = stripTags(value).replace(/\s+/g, " ").trim();
  s = s.replace(/^(home|official site|podcast)\s*[|:\-–—]\s*/i, "");
  s = s.replace(/\s*[|:\-–—]\s*(home|official site|podcast)$/i, "");
  // Wix and similar sites often emit titles such as "Home | smartless".
  const parts = s.split(/\s*[|]\s*/).filter(Boolean);
  if (parts.length > 1) {
    const nonGeneric = parts.filter((part) => !/^(home|episodes?|about|podcast)$/i.test(part.trim()));
    if (nonGeneric.length) s = nonGeneric.sort((a, b) => b.length - a.length)[0].trim();
  }
  return s.trim();
}

function normalizeName(value: string) {
  return value.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function nameMatchScore(query: string, candidate: string) {
  const q = normalizeName(query), c = normalizeName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  if (c.includes(q) || q.includes(c)) return 85;
  const qTokens = new Set(q.split(" ").filter((t) => t.length > 2));
  const cTokens = new Set(c.split(" ").filter((t) => t.length > 2));
  if (!qTokens.size || !cTokens.size) return 0;
  let shared = 0;
  for (const token of qTokens) if (cTokens.has(token)) shared++;
  return Math.round(100 * shared / Math.max(qTokens.size, cTokens.size));
}

async function discoverViaPodcastDirectory(html: string, pageUrl: string) {
  const query = pagePodcastName(html, pageUrl);
  if (query.length < 3) return [];

  try {
    const endpoint = new URL("https://itunes.apple.com/search");
    endpoint.searchParams.set("term", query);
    endpoint.searchParams.set("media", "podcast");
    endpoint.searchParams.set("entity", "podcast");
    endpoint.searchParams.set("limit", "10");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        signal: controller.signal,
        headers: { "user-agent": "Podstream/0.1.13 (+personal podcast reader)", "accept": "application/json" },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const ranked = results
      .map((result: any) => ({
        feedUrl: typeof result?.feedUrl === "string" ? result.feedUrl : "",
        name: String(result?.collectionName || result?.trackName || ""),
        score: Math.max(
          nameMatchScore(query, String(result?.collectionName || "")),
          nameMatchScore(query, String(result?.trackName || "")),
        ),
      }))
      .filter((item: any) => item.feedUrl && item.score >= 70)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 5);

    const feeds: any[] = [];
    for (const item of ranked) {
      try {
        const fetched = await safeFetchText(item.feedUrl, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5");
        if (!looksLikeFeed(fetched.text, fetched.contentType)) continue;
        const feed = parseFeed(fetched.text, fetched.url);
        if (!feed.episodes.length) continue;
        // Validate the actual feed title as well as the directory listing so a
        // broad website title cannot silently subscribe to an unrelated show.
        if (nameMatchScore(query, feed.title || item.name) < 70) continue;
        if (!feeds.some((existing) => existing.feedUrl === feed.feedUrl)) feeds.push(feed);
      } catch { /* best effort */ }
    }
    return feeds;
  } catch {
    return [];
  }
}

function htmlAttr(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? match[1] : "";
}

function decodeHtml(value = "") {
  return value.replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}

function decodeEntities(value = "") {
  return decodeHtml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function stripTags(value = "") {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function text(block: string, tags: string[]) {
  for (const tag of tags) {
    const safe = tag.replace(":", "\\:");
    const match = block.match(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, "i"));
    if (match) return stripTags(match[1]);
  }
  return "";
}

function attr(block: string, tag: string, attrName: string) {
  const safe = tag.replace(":", "\\:");
  const match = block.match(new RegExp(`<${safe}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function parseDuration(value: string) {
  if (!value) return 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const parts = value.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function parseFeed(xml: string, feedUrl: string) {
  if (/<feed\b/i.test(xml) && !/<channel\b/i.test(xml)) return parseAtomFeed(xml, feedUrl);
  return parseRssFeed(xml, feedUrl);
}

function parseRssFeed(xml: string, feedUrl: string) {
  const channel = xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] || xml;
  const title = text(channel, ["title"]);
  const image = attr(channel, "itunes:image", "href") || text(channel, ["url"]) || attr(channel, "media:thumbnail", "url");
  const items = [...channel.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((match) => match[0]);
  const episodes = items.slice(0, 150).map((item) => {
    const enclosure = attr(item, "enclosure", "url") || attr(item, "media:content", "url");
    const guid = text(item, ["guid"]);
    const episodeTitle = text(item, ["title"]);
    return {
      id: guid || `${feedUrl}|${enclosure}|${episodeTitle}`,
      title: episodeTitle,
      audioUrl: enclosure,
      publishedAt: text(item, ["pubDate", "dc:date"]) || new Date().toISOString(),
      duration: parseDuration(text(item, ["itunes:duration"])),
      image: attr(item, "itunes:image", "href") || attr(item, "media:thumbnail", "url") || image,
    };
  }).filter((episode) => episode.audioUrl);
  return { id: feedUrl, feedUrl, title, image, episodes };
}

function parseAtomFeed(xml: string, feedUrl: string) {
  const title = text(xml, ["title"]);
  const image = text(xml, ["logo", "icon"]);
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
  const episodes = entries.slice(0, 150).map((entry) => {
    const audioUrl = atomEnclosure(entry);
    const episodeTitle = text(entry, ["title"]);
    const id = text(entry, ["id"]);
    return {
      id: id || `${feedUrl}|${audioUrl}|${episodeTitle}`,
      title: episodeTitle,
      audioUrl,
      publishedAt: text(entry, ["published", "updated"]) || new Date().toISOString(),
      duration: parseDuration(text(entry, ["itunes:duration"])),
      image,
    };
  }).filter((episode) => episode.audioUrl);
  return { id: feedUrl, feedUrl, title, image, episodes };
}

function atomEnclosure(entry: string) {
  for (const match of entry.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = (htmlAttr(tag, "rel") || "").toLowerCase();
    const type = (htmlAttr(tag, "type") || "").toLowerCase();
    if (rel === "enclosure" || type.startsWith("audio/")) return htmlAttr(tag, "href");
  }
  return "";
}
