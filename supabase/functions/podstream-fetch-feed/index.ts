const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url) return json({ error: "Missing url" }, 400);

    let parsed: URL;
    try { parsed = new URL(url); } catch { return json({ error: "Invalid URL" }, 400); }
    if (!["http:", "https:"].includes(parsed.protocol)) return json({ error: "Invalid protocol" }, 400);
    if (isBlockedHost(parsed.hostname)) return json({ error: "Private or local hosts are not allowed" }, 400);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "Podstream/0.1.1 (+personal podcast reader)",
          "accept": "application/rss+xml, application/xml, text/xml, */*;q=0.5",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) return json({ error: `Feed returned ${response.status}` }, 502);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 10_000_000) return json({ error: "Feed is too large" }, 413);

    const xml = await response.text();
    if (xml.length > 10_000_000) return json({ error: "Feed is too large" }, 413);
    return json(parseFeed(xml, parsed.toString()), 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feed fetch failed";
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

function isBlockedHost(hostname: string) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function decodeEntities(s = "") {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
}

function text(block: string, tags: string[]) {
  for (const tag of tags) {
    const safe = tag.replace(":", "\\:");
    const m = block.match(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, "i"));
    if (m) return decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  }
  return "";
}

function attr(block: string, tag: string, attrName: string) {
  const safe = tag.replace(":", "\\:");
  const m = block.match(new RegExp(`<${safe}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function parseDuration(v: string) {
  if (!v) return 0;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v);
  const p = v.split(":").map(Number);
  if (p.some(Number.isNaN)) return 0;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return 0;
}

function parseFeed(xml: string, feedUrl: string) {
  const channel = xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] || xml;
  const title = text(channel, ["title"]);
  const image = attr(channel, "itunes:image", "href") || text(channel, ["url"]) || attr(channel, "media:thumbnail", "url");
  const items = [...channel.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
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
  }).filter((e) => e.audioUrl);
  return { id: feedUrl, title, image, episodes };
}
