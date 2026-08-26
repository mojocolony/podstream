# Podstream v0.1.0

A deliberately small podcast web app.

## What it does

- Subscribe by RSS feed URL
- Stream episodes — no downloads
- Star podcasts and episodes
- Skip back/forward 15 seconds
- In Progress view
- Cross-device playback position sync through Supabase
- Enhance Voices toggle using Web Audio EQ + compression

## Run locally

Because podcast feeds and audio are fetched from other domains, use a small local server rather than opening `index.html` directly:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Supabase setup

1. Create a Supabase project.
2. In **SQL Editor**, run `supabase/schema.sql`.
3. Deploy the RSS proxy Edge Function:

```bash
supabase functions deploy fetch-feed --no-verify-jwt
```

4. In Supabase Authentication, enable Email / Magic Link sign-in.
5. Add your GitHub Pages URL (or local URL during testing) to the allowed redirect URLs.
6. Open Podstream → **Settings** and enter:
   - Supabase project URL
   - Supabase anon key
   - Your email
7. Click **Save & sign in**, then use the magic link.

## GitHub Pages

The root files are static and can be deployed directly to GitHub Pages. The Supabase Edge Function handles RSS fetching, which avoids browser CORS problems.

## Enhance Voices

The toggle uses browser Web Audio processing:

- high-pass filter around 85 Hz
- gentle presence lift around 2.6 kHz
- moderate dynamic compression

It does not download or rewrite audio. Processing occurs while audio streams.

## Important audio caveat

Some podcast hosts do not include permissive CORS headers on their MP3 files. Browsers may still play those files normally, but Web Audio processing can be blocked for such streams. In that case playback should still work, while **Enhance Voices** may not. A later build can add an optional audio relay through Supabase if needed.
