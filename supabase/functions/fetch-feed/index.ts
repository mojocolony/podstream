import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = new URL(req.url).searchParams.get("url");
    if (!url) return json({ error: "Missing url" }, 400);
    const parsed = new URL(url);
    if (!['http:','https:'].includes(parsed.protocol)) return json({ error: 'Invalid protocol' }, 400);

    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Podstream/0.1 (+personal podcast reader)' }
    });
    if (!response.ok) return json({ error: `Feed returned ${response.status}` }, 502);
    const xml = await response.text();
    const result = parseFeed(xml, url);
    return json(result, 200);
  } catch (error) {
    return json({ error: error?.message || 'Feed fetch failed' }, 500);
  }
});

function json(body: unknown, status=200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'content-type':'application/json; charset=utf-8' } });
}

function decodeEntities(s = '') {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").trim();
}
function text(block:string, tags:string[]) {
  for (const tag of tags) {
    const safe = tag.replace(':','\\:');
    const m = block.match(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, 'i'));
    if (m) return decodeEntities(m[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' '));
  }
  return '';
}
function attr(block:string, tag:string, attrName:string) {
  const safe = tag.replace(':','\\:');
  const m = block.match(new RegExp(`<${safe}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}
function parseDuration(v:string) {
  if (!v) return 0;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Number(v);
  const p=v.split(':').map(Number); if(p.some(Number.isNaN)) return 0;
  if(p.length===3) return p[0]*3600+p[1]*60+p[2];
  if(p.length===2) return p[0]*60+p[1];
  return 0;
}
function parseFeed(xml:string, feedUrl:string) {
  const channel = xml.match(/<channel\b[\s\S]*?<\/channel>/i)?.[0] || xml;
  const title = text(channel,['title']);
  const image = attr(channel,'itunes:image','href') || text(channel,['url']) || attr(channel,'media:thumbnail','url');
  const items = [...channel.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(m=>m[0]);
  const episodes = items.slice(0,150).map(item => {
    const enclosure = attr(item,'enclosure','url') || attr(item,'media:content','url');
    const guid = text(item,['guid']);
    return {
      id: guid || `${feedUrl}|${enclosure}|${text(item,['title'])}`,
      title: text(item,['title']),
      audioUrl: enclosure,
      publishedAt: text(item,['pubDate','dc:date']) || new Date().toISOString(),
      duration: parseDuration(text(item,['itunes:duration'])),
      image: attr(item,'itunes:image','href') || attr(item,'media:thumbnail','url') || image,
    };
  }).filter(e => e.audioUrl);
  return { id: feedUrl, title, image, episodes };
}
