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
    const pageUrl = typeof body?.pageUrl === "string" ? body.pageUrl.trim() : "";
    if (!pageUrl) return json({ error: "Missing episode page URL" });
    const url = new URL(pageUrl);
    if (url.hostname.toLowerCase() !== "twit.tv" && url.hostname.toLowerCase() !== "www.twit.tv") {
      return json({ error: "Only TWiT episode pages can be resolved." });
    }
    if (!/^\/shows\/[^/]+\/episodes\/\d+/.test(url.pathname)) return json({ error: "Invalid TWiT episode page." });

    const html = await fetchText(url.toString());
    let audioUrl = "";
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = decodeEntities(match[1]).trim();
      const label = stripTags(match[2]).toLowerCase();
      let host = "";
      try { host = new URL(href, url).hostname.toLowerCase(); } catch { /* ignore */ }
      const looksAudio = /^(?:pdst\.fm|pscrb\.fm|cdn\.twit\.tv)$/.test(host) || /\.mp3(?:\?|$)/i.test(href);
      if (looksAudio && label === "audio") { audioUrl = new URL(href, url).toString(); break; }
    }
    if (!audioUrl) {
      const direct = html.match(/https?:\/\/[^"'\s<>]+\.mp3(?:\?[^"'\s<>]*)?/i)?.[0] || "";
      if (direct) audioUrl = decodeEntities(direct);
    }
    if (!audioUrl) return json({ error: "TWiT audio link was not found for this episode." });

    const h1 = stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
    const h2 = stripTags(html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "");
    const episodeNumber = url.pathname.match(/\/episodes\/(\d+)/)?.[1] || "";
    const title = h2 ? `${h1 || "TWiT"}${episodeNumber && !h1.includes(episodeNumber) ? ` ${episodeNumber}` : ""}: ${h2}` : h1;
    return json({ audioUrl, title: title || null });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not resolve TWiT episode." });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
}

async function fetchText(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "accept": "text/html,*/*;q=0.5", "user-agent": "Podstream/0.2.8 (personal podcast reader)" } });
    if (!response.ok) throw new Error(`TWiT returned ${response.status}`);
    return await response.text();
  } finally { clearTimeout(timeout); }
}

function stripTags(value = "") { return decodeEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function decodeEntities(value = "") {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);?/gi, (whole, hex) => { const cp = Number.parseInt(hex, 16); return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole; })
    .replace(/&#(\d+);?/g, (whole, dec) => { const cp = Number.parseInt(dec, 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : whole; })
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}
