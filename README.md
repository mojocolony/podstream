# Podstream v0.1.3

A deliberately small podcast web app.

## Features

- Subscribe by RSS feed URL
- Stream episodes — no downloads
- Star podcasts and episodes
- Skip back/forward 15 seconds
- History view with In Progress and Recently Played sections
- Cross-device subscriptions, stars and playback-position sync
- Synced Enhance Voices preference
- Enhance Voices using Web Audio EQ + compression

## Backend

Podstream is connected to the existing shared personal Supabase project, but its application data is logically isolated from the other apps:

- `podstream_subscriptions`
- `podstream_playback_positions`
- `podstream_stars`
- `podstream_settings`
- Edge Function: `podstream-fetch-feed`

All four tables have Row Level Security enabled and are restricted to the signed-in user's own rows. The GitHub Pages client contains only the project's public/publishable key; no secret or service-role key is included.

## Sign in

Open **Settings**, enter your email, and choose **Send sign-in link**. Once signed in, Podstream can securely fetch RSS feeds and synchronize your library across devices.

For GitHub Pages magic-link sign-in, `https://mojocolony.github.io/podstream/` must be present in the Supabase Auth redirect allow-list.

## GitHub Pages

Copy the root files of this folder into the `podstream` repository. `index.html` should remain at the repository root.

## Enhance Voices

The toggle uses browser Web Audio processing:

- high-pass filter around 85 Hz
- gentle presence lift around 2.6 kHz
- moderate dynamic compression

Processing occurs locally while audio streams. Some podcast hosts do not permit the browser CORS access needed for Web Audio processing; on those streams normal playback continues, but Enhance Voices is unavailable.


## v0.1.2
- Sidebar simplified to Stream, Podcasts, Starred, and History.
- History groups unfinished episodes under In Progress and other listening under Recently Played.
- Refresh and Settings moved to the top bar; version number moved to the bottom of the sidebar.

## v0.1.3
- New Reader-inspired blue-grey palette anchored by `#e6ecf2`.
- Softer blue navigation selection, primary controls, player controls, panels and focus states.
- Keeps Podstream's layout and functionality unchanged.
