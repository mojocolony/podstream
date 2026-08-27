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
    const feedUrl = typeof body?.feedUrl === "string" ? body.feedUrl.trim() : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!feedUrl) return json({ error: "Missing feed URL" });

    const directory = await findApplePodcast(feedUrl, title);
    if (!directory) return json({ catalogTotal: 0, episodes: [] });

    const collectionId = directory.collectionId || directory.trackId;
    if (!collectionId) return json({ catalogTotal: Number(directory.trackCount) || 0, episodes: [] });

    const endpoint = new URL("https://itunes.apple.com/lookup");
    endpoint.searchParams.set("id", String(collectionId));
    endpoint.searchParams.set("entity", "podcastEpisode");
    endpoint.searchParams.set("limit", "200");
    const payload = await fetchJson(endpoint.toString());
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const episodes = results
      .filter((item: any) => item?.kind === "podcast-episode" || /podcast.?episode/i.test(String(item?.wrapperType || "")))
      .map((item: any) => {
        const audioUrl = String(item?.episodeUrl || item?.previewUrl || "");
        const guid = String(item?.episodeGuid || "");
        const trackId = String(item?.trackId || "");
        return {
          id: guid || (trackId ? `apple:${trackId}` : audioUrl),
          guid,
          title: String(item?.trackName || item?.episodeName || "Untitled episode"),
          audioUrl,
          publishedAt: item?.releaseDate || new Date().toISOString(),
          duration: item?.trackTimeMillis ? Number(item.trackTimeMillis) / 1000 : 0,
          image: item?.artworkUrl600 || item?.artworkUrl100 || directory.artworkUrl600 || directory.artworkUrl100 || "",
        };
      })
      .filter((episode: any) => episode.audioUrl);

    return json({
      catalogTotal: Number(directory.trackCount) || episodes.length,
      episodes,
      source: "apple-directory",
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Catalogue backfill failed" });
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "accept": "application/json", "user-agent": "Podstream/0.2.6 (+personal podcast reader)" },
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFeed(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    return `${host}${path}`;
  } catch {
    return value.toLowerCase().replace(/\/+$/, "");
  }
}

function queryFromFeed(feedUrl: string) {
  try {
    const url = new URL(feedUrl);
    const parts = url.pathname.split("/").filter(Boolean).reverse();
    for (const part of parts) {
      if (/^(feed|feeds|rss|podcast|podcasts|v\d+|audio|xml)$/i.test(part)) continue;
      const value = decodeURIComponent(part).replace(/\.(rss|xml)$/i, "").replace(/[-_]+/g, " ").trim();
      if (value.length >= 3) return value;
    }
  } catch {}
  return "";
}

async function findApplePodcast(feedUrl: string, title: string) {
  const term = title || queryFromFeed(feedUrl);
  if (!term) return null;
  const endpoint = new URL("https://itunes.apple.com/search");
  endpoint.searchParams.set("term", term);
  endpoint.searchParams.set("media", "podcast");
  endpoint.searchParams.set("entity", "podcast");
  endpoint.searchParams.set("limit", "25");
  const payload = await fetchJson(endpoint.toString());
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const target = normalizeFeed(feedUrl);
  return results.find((item: any) => typeof item?.feedUrl === "string" && normalizeFeed(item.feedUrl) === target) || null;
}
