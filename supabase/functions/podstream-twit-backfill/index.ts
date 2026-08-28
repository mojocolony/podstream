const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const feedUrl = typeof body?.feedUrl === "string" ? body.feedUrl.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!feedUrl) return json({ error: "Missing feed URL" });

    const feedHost = new URL(feedUrl).hostname.toLowerCase();
    if (feedHost !== "feeds.twit.tv" && !feedHost.endsWith(".twit.tv")) {
      return json({ catalogTotal: 0, episodes: [], source: "twit-archive" });
    }

    const feedXml = await fetchText(feedUrl, 12000);
    const channelMeta = feedXml.split(/<item\b/i)[0] || feedXml;
    const showUrl = decodeEntities(channelMeta.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    if (!/^https?:\/\/(?:www\.)?twit\.tv\/shows\//i.test(showUrl)) {
      return json({ catalogTotal: 0, episodes: [], source: "twit-archive", error: "TWiT show page was not found in the feed." });
    }

    const currentNumbers = [...feedXml.matchAll(/<item\b[\s\S]*?<\/item>/gi)]
      .map(m => decodeEntities(stripTags(m[0].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")))
      .map(extractEpisodeNumber)
      .filter(n => Number.isFinite(n) && n > 0);
    const currentMin = currentNumbers.length ? Math.min(...currentNumbers) : 0;

    const showHtml = await fetchText(showUrl, 12000);
    const showId = extractShowId(showHtml);
    if (!showId) {
      return json({ catalogTotal: 0, episodes: [], source: "twit-archive", error: "TWiT archive identifier was not found." });
    }

    const archiveBase = `https://twit.tv/episodes?filter%5Bshows%5D=${encodeURIComponent(showId)}`;
    const firstHtml = await fetchText(archiveBase, 12000);
    const firstText = stripTags(firstHtml);
    const totalPages = Math.min(80, Math.max(1, Number(firstText.match(/\bof\s+(\d+)\b/i)?.[1] || 1)));

    const pageUrls = [archiveBase];
    for (let p = 2; p <= totalPages; p++) pageUrls.push(`${archiveBase}&page=${p}`);
    const pageHtml = await mapLimit(pageUrls, 6, async (url) => {
      try { return await fetchText(url, 12000); } catch { return ""; }
    });

    const showSlug = new URL(showUrl).pathname.split("/").filter(Boolean).pop() || "";
    const image = extractFeedImage(channelMeta);
    const episodes: any[] = [];
    const seen = new Set<string>();

    for (const html of pageHtml) {
      if (!html) continue;
      const anchorRe = /<a\b([^>]*)href=["']([^"']*\/shows\/([^\/"']+)\/episodes\/(\d+)[^"']*)["']([^>]*)>([\s\S]*?)<\/a>/gi;
      for (const match of html.matchAll(anchorRe)) {
        const href = decodeEntities(match[2]);
        const slug = String(match[3] || "");
        const episodeNumber = Number(match[4] || 0);
        if (!episodeNumber || (showSlug && slug !== showSlug)) continue;
        if (currentMin && episodeNumber >= currentMin) continue;

        const pageUrl = new URL(href, "https://twit.tv").toString().replace(/\?.*$/, "");
        if (seen.has(pageUrl)) continue;
        seen.add(pageUrl);

        const inner = match[6] || "";
        const segments = textSegments(inner);
        const publishedAt = parseArchiveDate(segments.join(" "));
        const resolvedTitle = bestArchiveTitle(segments, title, episodeNumber) || `${title || "TWiT episode"} ${episodeNumber}`;
        episodes.push({
          id: `twit:${showSlug}:${episodeNumber}`,
          guid: `twit:${showSlug}:${episodeNumber}`,
          title: resolvedTitle,
          audioUrl: `twit-page:${pageUrl}`,
          publishedAt: publishedAt || new Date(0).toISOString(),
          duration: 0,
          image,
          source: "twit-archive",
        });
      }
    }

    episodes.sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());
    const total = Math.max(currentNumbers.length + episodes.length, episodes.length);
    console.log(JSON.stringify({ event: "twit-archive-backfill", feedUrl, showId, pages: totalPages, currentMin, episodes: episodes.length, total }));
    return json({
      catalogTotal: total,
      episodes,
      source: "twit-archive",
      providerEpisodeCount: episodes.length,
      showUrl,
      archivePages: totalPages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "TWiT archive backfill failed";
    console.error(JSON.stringify({ event: "twit-archive-error", message }));
    return json({ error: message, catalogTotal: 0, episodes: [], source: "twit-archive" });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

async function fetchText(url: string, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "text/html, application/rss+xml, application/xml, text/xml, */*;q=0.5",
        "user-agent": "Podstream/0.2.8 (personal podcast reader)",
      },
    });
    if (!response.ok) throw new Error(`TWiT returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function extractShowId(html: string) {
  const decoded = decodeEntities(html);
  return decoded.match(/\/episodes\?filter\[shows\]=(\d+)/i)?.[1]
    || html.match(/\/episodes\?filter%5Bshows%5D=(\d+)/i)?.[1]
    || "";
}

function extractEpisodeNumber(value: string) {
  const match = value.match(/\b(\d{3,5})(?=\s*[:\-–—])/);
  return match ? Number(match[1]) : 0;
}

function extractFeedImage(channelMeta: string) {
  const itunes = channelMeta.match(/<itunes:image\b[^>]*href=["']([^"']+)["']/i)?.[1];
  if (itunes) return decodeEntities(itunes);
  const imageBlock = channelMeta.match(/<image\b[\s\S]*?<\/image>/i)?.[0] || "";
  return decodeEntities(imageBlock.match(/<url\b[^>]*>([\s\S]*?)<\/url>/i)?.[1] || "").trim();
}

function textSegments(html: string) {
  const segments: string[] = [];
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    const text = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
    if (text) segments.push(text);
  }
  if (!segments.length) {
    const text = stripTags(html).replace(/\s+/g, " ").trim();
    if (text) segments.push(text);
  }
  return segments;
}

function bestArchiveTitle(segments: string[], showTitle: string, episodeNumber: number) {
  const dateRe = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?\s+\d{4}$/i;
  const showNorm = normalize(showTitle);
  let sawDate = false;
  for (const segment of segments) {
    const s = segment.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (dateRe.test(s)) { sawDate = true; continue; }
    if (/^[-–—]$/.test(s)) continue;
    const n = normalize(s);
    if (n === showNorm || n.includes(`${episodeNumber}`) && (n.includes(showNorm) || /macbreak weekly|\bmbw\b/i.test(s))) continue;
    if (sawDate && s.length >= 3) return s.replace(/^[-–—]\s*/, "").trim();
  }
  return "";
}

function parseArchiveDate(value: string) {
  const match = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})\b/i);
  if (!match) return "";
  const parsed = Date.parse(`${match[1]} ${match[2]} ${match[3]} 12:00:00 UTC`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function stripTags(value = "") {
  return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(value = "") {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);?/gi, (whole, hex) => { const cp = Number.parseInt(hex, 16); return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole; })
    .replace(/&#(\d+);?/g, (whole, dec) => { const cp = Number.parseInt(dec, 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole; })
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}
