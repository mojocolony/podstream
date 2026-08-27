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
    if (!directory) return json({ catalogTotal: 0, episodes: [], source: "apple-directory" });

    const collectionId = directory.collectionId || directory.trackId;
    const catalogTotal = Number(directory.trackCount) || 0;
    if (!collectionId) return json({ catalogTotal, episodes: [], source: "apple-directory" });

    // Apple episode lookup is somewhat finicky: explicitly specifying country + media
    // is necessary for reliable podcastEpisode results on some shows/storefronts.
    const lookup = new URL("https://itunes.apple.com/lookup");
    lookup.searchParams.set("id", String(collectionId));
    lookup.searchParams.set("country", "US");
    lookup.searchParams.set("media", "podcast");
    lookup.searchParams.set("entity", "podcastEpisode");
    lookup.searchParams.set("limit", "200");

    const lookupPayload = await fetchJson(lookup.toString());
    const lookupResults = Array.isArray(lookupPayload?.results) ? lookupPayload.results : [];

    // Fallback: Apple's search endpoint can expose podcastEpisode rows even when
    // lookup only returns the collection. Filter strictly by collectionId so a
    // similarly named show cannot contaminate the archive.
    let searchResults: any[] = [];
    const lookupEpisodeCount = episodeRows(lookupResults, collectionId).length;
    const expectedRecentCount = catalogTotal > 0 ? Math.min(200, catalogTotal) : 200;
    const searchTerm = String(directory.collectionName || directory.trackName || title || "").trim();
    if (searchTerm && lookupEpisodeCount < expectedRecentCount) {
      const search = new URL("https://itunes.apple.com/search");
      search.searchParams.set("term", searchTerm);
      search.searchParams.set("country", "US");
      search.searchParams.set("media", "podcast");
      search.searchParams.set("entity", "podcastEpisode");
      search.searchParams.set("limit", "200");
      const searchPayload = await fetchJson(search.toString());
      searchResults = Array.isArray(searchPayload?.results) ? searchPayload.results : [];
    }

    const candidates = [
      ...episodeRows(lookupResults, collectionId),
      ...episodeRows(searchResults, collectionId),
    ];

    const episodes: any[] = [];
    const seen = new Set<string>();
    for (const item of candidates) {
      const audioUrl = String(item?.episodeUrl || item?.previewUrl || "").trim();
      if (!audioUrl) continue;
      const guid = String(item?.episodeGuid || "").trim();
      const trackId = String(item?.trackId || "").trim();
      const id = guid || (trackId ? `apple:${trackId}` : audioUrl);
      const dedupe = guid || trackId || audioUrl;
      if (!dedupe || seen.has(dedupe)) continue;
      seen.add(dedupe);
      episodes.push({
        id,
        guid,
        title: String(item?.trackName || item?.episodeName || "Untitled episode"),
        audioUrl,
        publishedAt: item?.releaseDate || new Date().toISOString(),
        duration: item?.trackTimeMillis ? Number(item.trackTimeMillis) / 1000 : 0,
        image: item?.artworkUrl600 || item?.artworkUrl100 || directory.artworkUrl600 || directory.artworkUrl100 || "",
      });
    }

    episodes.sort((a, b) => new Date(b.publishedAt || 0).getTime() - new Date(a.publishedAt || 0).getTime());

    return json({
      catalogTotal: catalogTotal || episodes.length,
      episodes,
      source: "apple-directory",
      providerEpisodeCount: episodes.length,
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
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "accept": "application/json", "user-agent": "Podstream/0.2.7 (+personal podcast reader)" },
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

function isEpisode(item: any) {
  const kind = String(item?.kind || "").toLowerCase();
  const wrapper = String(item?.wrapperType || "").toLowerCase().replace(/[^a-z]/g, "");
  return kind === "podcast-episode" || wrapper === "podcastepisode";
}

function episodeRows(results: any[], collectionId: string | number) {
  const wanted = String(collectionId);
  return (results || []).filter((item: any) => {
    if (!isEpisode(item)) return false;
    const itemCollection = String(item?.collectionId || item?.collectionId === 0 ? item.collectionId : "");
    return !itemCollection || itemCollection === wanted;
  });
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
  endpoint.searchParams.set("country", "US");
  endpoint.searchParams.set("media", "podcast");
  endpoint.searchParams.set("entity", "podcast");
  endpoint.searchParams.set("limit", "25");
  const payload = await fetchJson(endpoint.toString());
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const target = normalizeFeed(feedUrl);
  return results.find((item: any) => typeof item?.feedUrl === "string" && normalizeFeed(item.feedUrl) === target) || null;
}
