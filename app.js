(() => {
  const APP_VERSION = '0.2.8';
  const LS_KEY = 'podstream-state-v2';
  const LEGACY_LS_KEY = 'podstream-state-v1';
  const CACHE_DB = 'podstream-cache-v1';
  const CACHE_STORE = 'cache';
  const SETTINGS_KEY = 'podstream-settings-v1';
  const SUPABASE_URL = 'https://appesztafatypbxzdunr.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_70RugEcKQxZWUa5eQfmyeg_y7AkVz9V';
  const FEED_FUNCTION = 'podstream-fetch-feed';
  const CATALOG_FUNCTION = 'podstream-catalog-backfill';
  const TWIT_CATALOG_FUNCTION = 'podstream-twit-backfill';
  const TWIT_RESOLVE_FUNCTION = 'podstream-resolve-twit-episode';
  const AUTH_STORAGE_PREFIX = 'podstream-auth-v1:';
  const DARK_QUERY = window.matchMedia('(prefers-color-scheme: dark)');
  const podstreamAuthStorage = {
    getItem: (key) => localStorage.getItem(AUTH_STORAGE_PREFIX + key),
    setItem: (key, value) => localStorage.setItem(AUTH_STORAGE_PREFIX + key, value),
    removeItem: (key) => localStorage.removeItem(AUTH_STORAGE_PREFIX + key),
  };

  const state = {
    view: 'stream',
    selectedPodcastId: null,
    subscriptions: [],
    episodes: {},
    playback: {},
    starredEpisodes: {},
    starredShows: {},
    currentEpisodeId: null,
    enhanceVoices: false,
    textSize: 'medium',
    theme: 'system',
    user: null,
    supabase: null,
    remoteReady: false,
  };

  const els = {};
  let audioCtx = null;
  let sourceNode = null;
  let highPass = null;
  let presence = null;
  let compressor = null;
  let saveTimer = null;
  let toastTimer = null;
  let episodeCacheTimer = null;
  let legacyEpisodesForMigration = null;

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    cacheEls();
    loadLocal();
    await loadEpisodeCache();
    applyTextSize();
    applyTheme();
    bindEvents();
    render();
    lucide.createIcons();
    await initSupabase();
    if (state.remoteReady) await hydrateRemote();
  }

  function cacheEls() {
    ['content','viewTitle','viewSubtitle','addPodcastButton','addPodcastDialog','addPodcastForm','feedUrlInput','feedError','feedChoices','podcastInfoDialog','podcastInfoTitle','podcastInfoMeta','podcastInfoBody','podcastInfoStarButton','podcastInfoRemoveButton','podcastInfoEpisodesButton','nowPlayingDialog','nowPlayingArt','nowPlayingTitle','nowPlayingShow','nowPlayingPodcastButton','nowPlayingBack15','nowPlayingPlayPause','nowPlayingForward15','nowPlayingSeek','nowPlayingCurrentTime','nowPlayingDuration','nowPlayingEnhanceButton','nowPlayingStarButton','settingsDialog','settingsButton','settingsSubtitle','syncButton','menuButton','sidebar','sidebarScrim','audio','player','playerTitle','playerShow','playerArtButton','playPause','back15','forward15','seek','currentTime','duration','enhanceButton','starEpisodeButton','emailInput','saveSettingsButton','signOutButton','authStatus','toast'].forEach(id => els[id] = document.getElementById(id));
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    els.addPodcastButton.addEventListener('click', () => {
      els.feedError.classList.add('hidden');
      els.feedChoices.classList.add('hidden');
      els.feedChoices.innerHTML = '';
      els.feedUrlInput.value = '';
      els.addPodcastDialog.showModal();
      requestAnimationFrame(() => els.feedUrlInput.focus());
    });
    els.addPodcastForm.addEventListener('submit', handleAddPodcast);
    document.querySelectorAll('[data-dialog-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog')?.close()));
    [els.addPodcastDialog, els.podcastInfoDialog, els.nowPlayingDialog, els.settingsDialog].forEach(dialog => {
      dialog.addEventListener('click', (ev) => {
        if (ev.target === dialog) dialog.close();
      });
      dialog.addEventListener('cancel', () => {
        if (dialog === els.addPodcastDialog) {
          els.feedError.classList.add('hidden');
          els.feedChoices.classList.add('hidden');
          els.feedChoices.innerHTML = '';
        }
      });
    });
    els.podcastInfoEpisodesButton.addEventListener('click', () => {
      const showId = els.podcastInfoDialog.dataset.showId;
      if (!showId) return;
      els.podcastInfoDialog.close();
      openPodcast(showId);
    });
    els.podcastInfoStarButton.addEventListener('click', async () => {
      const showId = els.podcastInfoDialog.dataset.showId;
      if (!showId) return;
      await toggleStarShow(showId);
      if (els.podcastInfoDialog.open) updatePodcastInfoDialog(showId);
    });
    els.podcastInfoRemoveButton.addEventListener('click', async () => {
      const showId = els.podcastInfoDialog.dataset.showId;
      if (!showId) return;
      els.podcastInfoDialog.close();
      await removeSubscription(showId);
    });
    els.settingsButton.addEventListener('click', openSettings);
    document.querySelectorAll('[data-text-size]').forEach(btn => btn.addEventListener('click', () => setTextSize(btn.dataset.textSize)));
    document.querySelectorAll('[data-theme-choice]').forEach(btn => btn.addEventListener('click', () => setTheme(btn.dataset.themeChoice)));
    DARK_QUERY.addEventListener?.('change', () => { if (state.theme === 'system') applyTheme(); });
    els.saveSettingsButton.addEventListener('click', saveSettingsAndSignIn);
    els.signOutButton.addEventListener('click', signOut);
    els.syncButton.addEventListener('click', refreshAllFeeds);
    els.menuButton.addEventListener('click', toggleMenu);
    els.sidebarScrim.addEventListener('click', closeMenu);
    window.addEventListener('resize', () => { if (window.innerWidth > 850) closeMenu(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && els.sidebar.classList.contains('open')) closeMenu(); });
    els.playPause.addEventListener('click', togglePlay);
    els.back15.addEventListener('click', () => jumpPlayback(-15));
    els.forward15.addEventListener('click', () => jumpPlayback(15));
    document.addEventListener('keydown', handlePlaybackShortcuts);
    els.seek.addEventListener('input', () => { if (Number.isFinite(els.audio.duration)) els.audio.currentTime = Number(els.seek.value) / 100 * els.audio.duration; });
    bindAudioEvents();
    els.enhanceButton.addEventListener('click', toggleEnhance);
    els.starEpisodeButton.addEventListener('click', () => toggleStarEpisode(state.currentEpisodeId));
    els.playerArtButton.addEventListener('click', openNowPlaying);
    els.player.querySelector('.player-titles')?.addEventListener('click', openNowPlaying);
    els.player.querySelector('.player-titles')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openNowPlaying(); }
    });
    els.nowPlayingBack15.addEventListener('click', () => jumpPlayback(-15));
    els.nowPlayingPlayPause.addEventListener('click', togglePlay);
    els.nowPlayingForward15.addEventListener('click', () => jumpPlayback(15));
    els.nowPlayingSeek.addEventListener('input', () => {
      if (Number.isFinite(els.audio.duration)) els.audio.currentTime = Number(els.nowPlayingSeek.value) / 100 * els.audio.duration;
    });
    els.nowPlayingEnhanceButton.addEventListener('click', toggleEnhance);
    els.nowPlayingStarButton.addEventListener('click', () => toggleStarEpisode(state.currentEpisodeId));
    els.nowPlayingPodcastButton.addEventListener('click', () => {
      const ep = state.episodes[state.currentEpisodeId];
      if (!ep) return;
      els.nowPlayingDialog.close();
      setView('podcasts');
      openPodcast(ep.showId);
    });
    window.addEventListener('beforeunload', () => persistPlayback(false));
  }


  function bindAudioEvents() {
    els.audio.addEventListener('loadedmetadata', onLoadedMetadata);
    els.audio.addEventListener('timeupdate', onTimeUpdate);
    els.audio.addEventListener('play', updatePlayButton);
    els.audio.addEventListener('pause', () => { updatePlayButton(); persistPlayback(true); });
    els.audio.addEventListener('ended', onEnded);
  }

  function disconnectAudioGraph({ closeContext = true } = {}) {
    try { sourceNode?.disconnect(); } catch (_) {}
    try { highPass?.disconnect(); } catch (_) {}
    try { presence?.disconnect(); } catch (_) {}
    try { compressor?.disconnect(); } catch (_) {}
    sourceNode = highPass = presence = compressor = null;
    if (closeContext && audioCtx) {
      try { audioCtx.close(); } catch (_) {}
      audioCtx = null;
    }
  }

  function resetAudioPipeline() {
    disconnectAudioGraph({ closeContext: true });
    const old = els.audio;
    const fresh = document.createElement('audio');
    fresh.id = 'audio';
    fresh.preload = 'metadata';
    old.replaceWith(fresh);
    els.audio = fresh;
    bindAudioEvents();
  }

  function snapshotAudio() {
    return {
      src: els.audio.currentSrc || els.audio.src || '',
      time: Number.isFinite(els.audio.currentTime) ? els.audio.currentTime : 0,
      wasPlaying: !els.audio.paused,
      volume: els.audio.volume,
      muted: els.audio.muted,
      playbackRate: els.audio.playbackRate,
    };
  }

  async function rebuildAudioElement({ cors = false, snapshot = snapshotAudio(), autoplay = false } = {}) {
    const old = els.audio;
    try { old.pause(); } catch (_) {}
    disconnectAudioGraph({ closeContext: false });

    const fresh = document.createElement('audio');
    fresh.id = 'audio';
    fresh.preload = 'metadata';
    if (cors) fresh.crossOrigin = 'anonymous';
    fresh.volume = snapshot.volume ?? 1;
    fresh.muted = !!snapshot.muted;
    fresh.playbackRate = snapshot.playbackRate || 1;
    old.replaceWith(fresh);
    els.audio = fresh;
    bindAudioEvents();

    if (!snapshot.src) return snapshot;

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Audio stream did not become ready.')), 10000);
      const cleanup = () => {
        clearTimeout(timer);
        fresh.removeEventListener('loadedmetadata', onReady);
        fresh.removeEventListener('error', onError);
      };
      const onReady = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('This stream cannot be processed by the browser.')); };
      fresh.addEventListener('loadedmetadata', onReady, { once: true });
      fresh.addEventListener('error', onError, { once: true });
    });

    fresh.src = snapshot.src;
    fresh.load();
    await ready;
    if (snapshot.time > 0 && Number.isFinite(fresh.duration)) {
      fresh.currentTime = Math.min(snapshot.time, Math.max(0, fresh.duration - 0.25));
    }
    if (autoplay && snapshot.wasPlaying) await fresh.play();
    return snapshot;
  }

  async function streamSupportsEnhancement(url) {
    try {
      const res = await fetch(url, { method: 'GET', mode: 'cors', headers: { Range: 'bytes=0-1' } });
      try { await res.body?.cancel(); } catch (_) {}
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  function loadLocal() {
    try {
      const settings = getSettings();
      state.textSize = ['small','medium','large'].includes(settings.textSize) ? settings.textSize : 'medium';
      state.theme = ['system','light','dark'].includes(settings.theme) ? settings.theme : 'system';

      let raw = {};
      const current = localStorage.getItem(LS_KEY);
      if (current) {
        raw = JSON.parse(current);
      } else {
        const legacy = localStorage.getItem(LEGACY_LS_KEY);
        if (legacy) {
          raw = JSON.parse(legacy);
          legacyEpisodesForMigration = raw.episodes || null;
          // The old key could contain entire podcast archives and consume the
          // browser's localStorage quota. Free that space immediately; the
          // episodes are migrated to IndexedDB during startup.
          localStorage.removeItem(LEGACY_LS_KEY);
        }
      }

      Object.assign(state, {
        subscriptions: raw.subscriptions || [],
        playback: raw.playback || {},
        starredEpisodes: raw.starredEpisodes || {},
        starredShows: raw.starredShows || {},
        enhanceVoices: !!raw.enhanceVoices,
      });
      saveLocal();
    } catch (error) {
      console.warn('Local state could not be loaded', error);
      try { localStorage.removeItem(LEGACY_LS_KEY); } catch (_) {}
    }
  }

  function saveLocal() {
    // Keep localStorage deliberately small. Full episode archives live in
    // IndexedDB; localStorage is shared by every app on mojocolony.github.io
    // and has a comparatively tiny quota. A cache failure must never block an
    // Add/Star/Playback action.
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        subscriptions: state.subscriptions,
        playback: state.playback,
        starredEpisodes: state.starredEpisodes,
        starredShows: state.starredShows,
        enhanceVoices: state.enhanceVoices,
      }));
    } catch (error) {
      console.warn('Lightweight local state could not be saved', error);
    }
  }

  function openCacheDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable'));
      const request = indexedDB.open(CACHE_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open podcast cache'));
    });
  }

  async function cacheGet(key) {
    const db = await openCacheDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readonly');
        const request = tx.objectStore(CACHE_STORE).get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function cacheSet(key, value) {
    const db = await openCacheDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(CACHE_STORE, 'readwrite');
        tx.objectStore(CACHE_STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Podcast cache write failed'));
        tx.onabort = () => reject(tx.error || new Error('Podcast cache write aborted'));
      });
    } finally { db.close(); }
  }

  async function loadEpisodeCache() {
    try {
      const cached = await cacheGet('episodes');
      if (cached && typeof cached === 'object') state.episodes = cached;
      if (legacyEpisodesForMigration && typeof legacyEpisodesForMigration === 'object') {
        state.episodes = { ...state.episodes, ...legacyEpisodesForMigration };
        legacyEpisodesForMigration = null;
        await cacheSet('episodes', state.episodes);
      }
    } catch (error) {
      console.warn('Episode cache could not be loaded', error);
      if (legacyEpisodesForMigration && typeof legacyEpisodesForMigration === 'object') {
        state.episodes = { ...state.episodes, ...legacyEpisodesForMigration };
        legacyEpisodesForMigration = null;
      }
    }
  }

  function queueEpisodeCacheSave() {
    clearTimeout(episodeCacheTimer);
    episodeCacheTimer = setTimeout(async () => {
      try { await cacheSet('episodes', state.episodes); }
      catch (error) { console.warn('Episode cache could not be saved', error); }
    }, 250);
  }

  function openMenu() {
    els.sidebar.classList.add('open');
    els.sidebarScrim.classList.add('open');
    document.body.classList.add('menu-open');
    els.menuButton.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    els.sidebar.classList.remove('open');
    els.sidebarScrim.classList.remove('open');
    document.body.classList.remove('menu-open');
    els.menuButton.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    if (els.sidebar.classList.contains('open')) closeMenu();
    else openMenu();
  }

  function setView(view) {
    state.view = view;
    state.selectedPodcastId = null;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    closeMenu();
    render();
  }

  function render() {
    let meta = {
      stream: ['Stream','Newest episodes from your subscriptions.'],
      podcasts: ['Podcasts','The podcasts you follow.'],
      starred: ['Starred','Episodes and podcasts you want to keep close.'],
      history: ['History','What you have been listening to.'],
    }[state.view];
    if (state.view === 'podcasts' && state.selectedPodcastId) {
      const selected = state.subscriptions.find(s => s.id === state.selectedPodcastId);
      if (selected) meta = [selected.title || 'Podcast', 'Episodes'];
      else state.selectedPodcastId = null;
    }
    els.viewTitle.textContent = decodeHtmlText(meta[0]);
    els.viewSubtitle.textContent = decodeHtmlText(meta[1]);
    els.addPodcastButton.style.display = 'inline-flex';

    if (state.view === 'podcasts' && state.selectedPodcastId) renderPodcastEpisodes(state.selectedPodcastId);
    else if (state.view === 'podcasts') renderSubscriptions();
    else if (state.view === 'history') renderHistory();
    else renderEpisodesView();
    renderPlayer();
    lucide.createIcons();
  }

  function renderEpisodesView() {
    let eps = Object.values(state.episodes);
    if (state.view === 'stream') {
      const activeShowIds = new Set(state.subscriptions.map(s => s.id));
      eps = eps.filter(e => activeShowIds.has(e.showId))
        .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    }
    if (state.view === 'starred') {
      const starredShowIds = new Set(Object.keys(state.starredShows).filter(k => state.starredShows[k]));
      eps = eps.filter(e => state.starredEpisodes[e.id] || starredShowIds.has(e.showId))
        .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    }

    if (!eps.length) {
      const copy = state.view === 'stream' && !state.subscriptions.length
        ? ['No podcasts yet','Add a podcast website or RSS feed and its latest episodes will appear here.','rss']
        : state.view === 'starred'
        ? ['Nothing starred','Star an episode or podcast and it will appear here.','star']
        : ['Nothing here yet','Refresh your feeds to load episodes.','radio'];
      els.content.innerHTML = emptyMarkup(...copy);
      return;
    }

    els.content.innerHTML = `<div class="episode-list">${eps.map(episodeMarkup).join('')}</div>`;
    els.content.querySelectorAll('[data-play]').forEach(el => el.addEventListener('click', () => playEpisode(el.dataset.play)));
    els.content.querySelectorAll('[data-star-episode]').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); toggleStarEpisode(el.dataset.starEpisode); }));
  }

  function renderHistory() {
    const played = Object.values(state.episodes)
      .filter(e => {
        const p = state.playback[e.id];
        return p && (Number(p.position) > 0.5 || p.completed);
      })
      .sort((a,b) => (state.playback[b.id]?.updatedAt || 0) - (state.playback[a.id]?.updatedAt || 0));

    const inProgress = played.filter(e => {
      const p = state.playback[e.id];
      return p && p.position > 5 && !p.completed;
    });
    const recentlyPlayed = played.filter(e => !inProgress.some(ip => ip.id === e.id));

    if (!played.length) {
      els.content.innerHTML = emptyMarkup('No listening history','Episodes you play will appear here.','history');
      return;
    }

    const section = (title, episodes) => episodes.length ? `
      <section class="history-section">
        <div class="section-heading"><h2>${title}</h2><span>${episodes.length}</span></div>
        <div class="episode-list">${episodes.map(episodeMarkup).join('')}</div>
      </section>` : '';

    els.content.innerHTML = `${section('In Progress', inProgress)}${section('Recently Played', recentlyPlayed)}`;
    els.content.querySelectorAll('[data-play]').forEach(el => el.addEventListener('click', () => playEpisode(el.dataset.play)));
    els.content.querySelectorAll('[data-star-episode]').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); toggleStarEpisode(el.dataset.starEpisode); }));
  }

  function episodeMarkup(e) {
    const pb = state.playback[e.id];
    const pct = pb?.duration ? Math.min(100, pb.position / pb.duration * 100) : 0;
    return `<article class="episode">
      ${coverMarkup(e.image, e.showTitle)}
      <div class="episode-main" data-play="${escAttr(e.id)}">
        <div class="episode-title">${esc(e.title)}</div>
        <div class="episode-sub"><span class="show">${esc(e.showTitle)}</span><span class="episode-sep">•</span><span class="episode-date">${friendlyDate(e.publishedAt)}</span>${e.duration ? `<span class="episode-sep">•</span><span class="episode-duration">${formatTime(e.duration)}</span>`:''}</div>
        ${pct > 1 ? `<div class="progress-line"><span style="width:${pct}%"></span></div>` : ''}
      </div>
      <div class="episode-actions">
        <button class="icon-button ${state.starredEpisodes[e.id] ? 'active':''}" data-star-episode="${escAttr(e.id)}" aria-label="Star episode"><i data-lucide="star"></i></button>
        <button class="icon-button" data-play="${escAttr(e.id)}" aria-label="Play"><i data-lucide="play"></i></button>
      </div>
    </article>`;
  }

  function sortablePodcastTitle(title) {
    return decodeHtmlText(title).trim().replace(/^(?:the|an|a)\s+/i, '').trim();
  }

  function renderSubscriptions() {
    if (!state.subscriptions.length) {
      els.content.innerHTML = emptyMarkup('No subscriptions','Add a podcast using its website or RSS feed URL.','rss');
      return;
    }
    const subscriptions = [...state.subscriptions].sort((a, b) => {
      const aTitle = sortablePodcastTitle(a.title || '');
      const bTitle = sortablePodcastTitle(b.title || '');
      const primary = aTitle.localeCompare(bTitle, undefined, { sensitivity: 'base', numeric: true });
      if (primary) return primary;
      return (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true });
    });
    els.content.innerHTML = `<div class="subscription-grid">${subscriptions.map(s => `<article class="podcast-card" data-open-show="${escAttr(s.id)}" tabindex="0" role="button" aria-label="Open ${escAttr(s.title || 'podcast')} episodes">
      <div class="podcast-card-art">
        ${coverMarkup(s.image, s.title)}
        <div class="podcast-card-actions">
          <button class="icon-button podcast-info-button" data-info-show="${escAttr(s.id)}" aria-label="Podcast information" title="Podcast information"><i data-lucide="info"></i></button>
          <button class="icon-button star-show ${state.starredShows[s.id] ? 'active':''}" data-star-show="${escAttr(s.id)}" aria-label="Star podcast" title="Star podcast"><i data-lucide="star"></i></button>
        </div>
      </div>
      <div class="podcast-card-main">
        <div class="subscription-title">${esc(s.title || 'Untitled podcast')}</div>
        ${s.description ? `<div class="subscription-description">${esc(s.description)}</div>` : `<div class="subscription-description muted">No description supplied by this podcast.</div>`}
        <div class="subscription-meta">${episodeCountForShow(s.id)} episodes available</div>
      </div>
      <span class="subscription-open-icon" aria-hidden="true"><i data-lucide="chevron-right"></i></span>
    </article>`).join('')}</div>`;
    els.content.querySelectorAll('[data-open-show]').forEach(el => {
      const open = () => openPodcast(el.dataset.openShow);
      el.addEventListener('click', open);
      el.addEventListener('keydown', ev => { if (ev.target !== el) return; if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
    });
    els.content.querySelectorAll('[data-info-show]').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); openPodcastInfo(el.dataset.infoShow); }));
    els.content.querySelectorAll('[data-star-show]').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); toggleStarShow(el.dataset.starShow); }));
  }

  function updatePodcastInfoDialog(showId) {
    const sub = state.subscriptions.find(s => s.id === showId);
    if (!sub) return;
    const episodes = Object.values(state.episodes).filter(e => e.showId === showId);
    els.podcastInfoDialog.dataset.showId = showId;
    els.podcastInfoTitle.textContent = decodeHtmlText(sub.title || 'Untitled podcast');
    els.podcastInfoMeta.textContent = `${episodes.length} episode${episodes.length === 1 ? '' : 's'} available${sub.catalogTotal && sub.catalogTotal > episodes.length ? ` · ${sub.catalogTotal} listed by Apple` : ''}`;
    els.podcastInfoBody.innerHTML = `<div class="podcast-info-summary">
      ${coverMarkup(sub.image, sub.title)}
      <div class="podcast-info-description">${sub.description ? esc(sub.description) : '<span class="muted">No description supplied by this podcast.</span>'}</div>
    </div>`;
    const starred = !!state.starredShows[showId];
    els.podcastInfoStarButton.classList.toggle('active', starred);
    els.podcastInfoStarButton.setAttribute('aria-pressed', String(starred));
    els.podcastInfoStarButton.innerHTML = `<i data-lucide="star"></i><span>${starred ? 'Starred' : 'Star'}</span>`;
    lucide.createIcons();
  }

  function openPodcastInfo(showId) {
    if (!state.subscriptions.some(s => s.id === showId)) return;
    updatePodcastInfoDialog(showId);
    els.podcastInfoDialog.showModal();
  }

  function openPodcast(showId) {
    if (!state.subscriptions.some(s => s.id === showId)) return;
    state.selectedPodcastId = showId;
    render();
  }

  function renderPodcastEpisodes(showId) {
    const sub = state.subscriptions.find(s => s.id === showId);
    if (!sub) {
      state.selectedPodcastId = null;
      renderSubscriptions();
      return;
    }
    const episodes = Object.values(state.episodes)
      .filter(e => e.showId === showId)
      .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const body = episodes.length
      ? `<div class="episode-list">${episodes.map(episodeMarkup).join('')}</div>`
      : emptyMarkup('No episodes loaded','Refresh feeds to load episodes for this podcast.','radio');

    els.content.innerHTML = `<div class="podcast-detail-head">
      <button class="secondary-button podcast-back-button" type="button" id="podcastBackButton"><i data-lucide="arrow-left"></i><span>Back to Podcasts</span></button>
      <div class="podcast-detail-summary">
        ${coverMarkup(sub.image, sub.title)}
        <div>
          ${sub.description ? `<p>${esc(sub.description)}</p>` : ''}
          <div class="subscription-meta">${episodes.length} episode${episodes.length === 1 ? '' : 's'} loaded</div>
        </div>
      </div>
    </div>${body}`;

    document.getElementById('podcastBackButton')?.addEventListener('click', () => { state.selectedPodcastId = null; render(); });
    els.content.querySelectorAll('[data-play]').forEach(el => el.addEventListener('click', () => playEpisode(el.dataset.play)));
    els.content.querySelectorAll('[data-star-episode]').forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); toggleStarEpisode(el.dataset.starEpisode); }));
  }

  async function removeSubscription(showId) {
    const sub = state.subscriptions.find(s => s.id === showId);
    if (!sub) return;
    const ok = window.confirm(`Remove “${decodeHtmlText(sub.title)}” from Podcasts?\n\nListening history and individually starred episodes will be kept.`);
    if (!ok) return;

    state.subscriptions = state.subscriptions.filter(s => s.id !== showId);
    if (state.starredShows[showId]) {
      delete state.starredShows[showId];
      await syncShowStarToRemote(showId);
    }
    saveLocal();
    render();

    if (state.remoteReady) {
      const { error } = await state.supabase.from('podstream_subscriptions')
        .delete()
        .eq('user_id', state.user.id)
        .eq('feed_url', sub.feedUrl);
      if (error) {
        console.warn('Subscription removal failed', error);
        toast('Removed locally, but cloud sync failed.');
        return;
      }
    }
    toast('Podcast removed');
  }

  function emptyMarkup(title, body, icon) {
    return `<div class="empty"><div class="empty-inner"><div class="empty-icon"><i data-lucide="${icon}"></i></div><h3>${title}</h3><p>${body}</p></div></div>`;
  }

  async function handleAddPodcast(ev) {
    ev.preventDefault();
    const url = els.feedUrlInput.value.trim();
    if (!url) return;
    els.feedError.classList.add('hidden');
    els.feedChoices.classList.add('hidden');
    els.feedChoices.innerHTML = '';
    const submit = document.getElementById('addFeedSubmit');
    if (submit) submit.disabled = true;
    try {
      const result = await fetchFeed(url, { backfill: false });
      if (Array.isArray(result?.choices) && result.choices.length > 1) {
        renderFeedChoices(result.choices);
        return;
      }
      const feed = Array.isArray(result?.choices) ? result.choices[0] : result;
      if (!feed) throw new Error('No podcast feed found. Try pasting the RSS feed directly.');
      await addDiscoveredFeed(feed);
    } catch (err) {
      console.error(err);
      els.feedError.textContent = err.message || 'Could not find a podcast feed at that address.';
      els.feedError.classList.remove('hidden');
    } finally {
      if (submit) submit.disabled = false;
    }
  }

  function renderFeedChoices(choices) {
    els.feedChoices.innerHTML = `<div class="feed-choice-heading">Choose a podcast feed</div>${choices.map((feed, index) => `
      <button type="button" class="feed-choice" data-feed-choice="${index}">
        ${coverMarkup(feed.image, feed.title)}
        <span><strong>${esc(feed.title || 'Podcast')}</strong><small>${esc(feed.feedUrl || feed.id || '')}</small></span>
      </button>`).join('')}`;
    els.feedChoices.classList.remove('hidden');
    els.feedChoices.querySelectorAll('[data-feed-choice]').forEach(button => {
      button.addEventListener('click', async () => {
        const feed = choices[Number(button.dataset.feedChoice)];
        if (!feed) return;
        button.disabled = true;
        try { await addDiscoveredFeed(feed); }
        catch (err) {
          console.error(err);
          els.feedError.textContent = err.message || 'Could not add that podcast.';
          els.feedError.classList.remove('hidden');
          button.disabled = false;
        }
      });
    });
    lucide.createIcons();
  }

  async function addDiscoveredFeed(feed) {
    let finalFeed = feed;
    let feedUrl = finalFeed.feedUrl || finalFeed.id;
    if (!feedUrl) throw new Error('The discovered feed did not include a usable URL.');

    // Re-fetch the chosen canonical feed, then ask the dedicated catalogue
    // backfill function for older Apple-indexed episodes. Discovery itself
    // stays lightweight even when a website exposes several candidate feeds.
    try {
      const refreshed = await fetchFeed(feedUrl);
      if (refreshed && !Array.isArray(refreshed.choices)) finalFeed = refreshed;
    } catch (error) {
      console.warn('Canonical feed refresh failed; using discovered feed.', error);
    }
    finalFeed = await applyCatalogBackfill(finalFeed);

    feedUrl = finalFeed.feedUrl || finalFeed.id || feedUrl;
    const archived = upsertFeed(finalFeed, feedUrl);
    await syncSubscriptionToRemote(feedUrl, finalFeed);
    await syncEpisodesToRemote(archived, feedUrl);
    els.addPodcastDialog.close();
    setView('stream');
    toast(finalFeed.catalogAdded ? `Podcast added · ${finalFeed.catalogAdded} older episodes found` : 'Podcast added');
  }

  async function fetchFeed(url, { backfill = false } = {}) {
    if (!state.supabase || !state.remoteReady) {
      throw new Error('Sign in first so Podstream can securely find podcast feeds and sync your library.');
    }
    const { data, error } = await state.supabase.functions.invoke(FEED_FUNCTION, { body: { url } });
    if (error) {
      let message = error.message || 'Could not find a podcast feed at that address.';
      try {
        const response = error.context;
        if (response && typeof response.clone === 'function') {
          const detail = await response.clone().json();
          if (detail?.error) message = detail.error;
        }
      } catch { /* Keep the fallback message. */ }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function fetchCatalogBackfill(feed) {
    if (!state.supabase || !state.remoteReady || !feed?.feedUrl) return null;

    // TWiT deliberately limits most public RSS feeds to the newest 10 episodes.
    // Its public website carries the long-term archive, so use that source before
    // the general-purpose podcast index for feeds.twit.tv subscriptions.
    try {
      const host = new URL(feed.feedUrl).hostname.toLowerCase();
      if (host === 'feeds.twit.tv' || host.endsWith('.twit.tv')) {
        const { data, error } = await state.supabase.functions.invoke(TWIT_CATALOG_FUNCTION, {
          body: { feedUrl: feed.feedUrl, title: feed.title || '' },
        });
        if (!error && !data?.error && (data?.episodes || []).length) return data;
        if (error) console.warn('TWiT archive backfill failed', error);
        else if (data?.error) console.warn('TWiT archive unavailable', data.error);
      }
    } catch { /* Not a TWiT feed; continue to the normal catalogue. */ }

    const { data, error } = await state.supabase.functions.invoke(CATALOG_FUNCTION, {
      body: { feedUrl: feed.feedUrl, title: feed.title || '' },
    });
    if (error) {
      console.warn('Catalogue backfill function failed', error);
      return null;
    }
    if (data?.error) {
      console.warn('Catalogue backfill unavailable', data.error);
      return null;
    }
    return data || null;
  }

  async function applyCatalogBackfill(feed) {
    if (!feed) return feed;
    const catalog = await fetchCatalogBackfill(feed);
    feed.backfillAttempted = !!catalog;
    if (!catalog) return feed;
    feed.catalogTotal = Number(catalog.catalogTotal) || Number(feed.catalogTotal) || 0;
    const existingGuids = new Set((feed.episodes || []).map(ep => String(ep?.guid || ep?.id || '')).filter(Boolean));
    const existingAudio = new Set((feed.episodes || []).map(ep => ep?.audioUrl || '').filter(Boolean));
    let added = 0;
    for (const ep of (catalog.episodes || [])) {
      if (!ep?.audioUrl) continue;
      const guid = String(ep.guid || ep.id || '');
      if ((guid && existingGuids.has(guid)) || existingAudio.has(ep.audioUrl)) continue;
      (feed.episodes ||= []).push({ ...ep, source: ep.source || catalog.source || 'catalog' });
      if (guid) existingGuids.add(guid);
      existingAudio.add(ep.audioUrl);
      added += 1;
    }
    feed.catalogAdded = added;
    feed.episodes.sort((a,b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    return feed;
  }

  function upsertFeed(feed, feedUrl, previousFeedUrl = null) {
    const showId = feed.id || hash(feedUrl);
    const idx = state.subscriptions.findIndex(s => s.id === showId || s.feedUrl === feedUrl || (previousFeedUrl && s.feedUrl === previousFeedUrl));
    const previous = idx >= 0 ? state.subscriptions[idx] : null;
    const sub = {
      id: showId,
      feedUrl,
      title: feed.title || previous?.title || 'Untitled podcast',
      image: feed.image || previous?.image || '',
      description: feed.description || previous?.description || '',
      episodeCount: previous?.episodeCount || 0,
      catalogTotal: Number(feed.catalogTotal) || Number(previous?.catalogTotal) || 0,
      backfilledAt: feed.backfillAttempted ? Date.now() : (previous?.backfilledAt || null),
      updatedAt: Date.now(),
    };

    if (idx >= 0) {
      if (previous?.id && previous.id !== showId) {
        if (state.starredShows[previous.id]) {
          state.starredShows[showId] = true;
          delete state.starredShows[previous.id];
        }
        for (const episode of Object.values(state.episodes)) {
          if (episode.showId === previous.id) episode.showId = showId;
        }
        if (state.selectedPodcastId === previous.id) state.selectedPodcastId = showId;
      }
      state.subscriptions[idx] = { ...state.subscriptions[idx], ...sub };
    } else state.subscriptions.push(sub);

    const archived = [];
    for (const ep of (feed.episodes || [])) {
      if (!ep?.audioUrl) continue;
      let id = ep.id || hash(`${showId}|${ep.audioUrl}|${ep.title}`);
      const sameAudio = Object.values(state.episodes).find(existing => existing.showId === showId && existing.audioUrl === ep.audioUrl);
      if (sameAudio) id = sameAudio.id;
      const normalized = {
        id, showId, feedUrl, showTitle: sub.title, title: ep.title || sameAudio?.title || 'Untitled episode', audioUrl: ep.audioUrl,
        publishedAt: ep.publishedAt || sameAudio?.publishedAt || new Date().toISOString(), image: ep.image || sameAudio?.image || sub.image || '',
        duration: Number(ep.duration) || Number(sameAudio?.duration) || 0, source: ep.source || sameAudio?.source || 'rss',
      };
      state.episodes[id] = { ...sameAudio, ...state.episodes[id], ...normalized };
      archived.push(state.episodes[id]);
    }
    sub.episodeCount = episodeCountForShow(showId);
    const subIndex = state.subscriptions.findIndex(x => x.id === showId);
    if (subIndex >= 0) state.subscriptions[subIndex] = { ...state.subscriptions[subIndex], episodeCount: sub.episodeCount };
    saveLocal();
    queueEpisodeCacheSave();
    return archived;
  }

  function episodeCountForShow(showId) {
    let count = 0;
    for (const episode of Object.values(state.episodes)) if (episode.showId === showId) count += 1;
    return count;
  }

  async function refreshAllFeeds() {
    if (!state.remoteReady) { openSettings(); els.authStatus.textContent = 'Sign in before refreshing feeds.'; return; }
    if (!state.subscriptions.length) return toast('No subscriptions yet');

    const total = state.subscriptions.length;
    let updated = 0;
    let failed = 0;
    els.syncButton.disabled = true;
    els.syncButton.classList.add('is-refreshing');
    els.syncButton.setAttribute('aria-busy', 'true');
    els.syncButton.setAttribute('aria-label', 'Refreshing feeds');
    els.syncButton.title = 'Refreshing feeds';
    toast(`Refreshing ${total} podcast${total === 1 ? '' : 's'}…`);

    try {
      for (const s of state.subscriptions) {
        try {
          let feed = await fetchFeed(s.feedUrl);
          const currentCount = episodeCountForShow(s.id);
          const needsCatalogRetry = currentCount <= 75 && Number(s.catalogTotal || 0) > currentCount;
          if ((!s.backfilledAt && (feed.episodes || []).length <= 75) || needsCatalogRetry) {
            feed = await applyCatalogBackfill(feed);
          }
          const canonicalUrl = feed.feedUrl || feed.id || s.feedUrl;
          const oldUrl = s.feedUrl;
          const archived = upsertFeed(feed, canonicalUrl, oldUrl);
          await syncSubscriptionToRemote(canonicalUrl, feed);
          await syncEpisodesToRemote(archived, canonicalUrl);
          if (canonicalUrl !== oldUrl) await removeRemoteSubscriptionByUrl(oldUrl);
          updated += 1;
        } catch (e) {
          failed += 1;
          console.warn('Feed refresh failed', s.feedUrl, e);
        }
      }
      render();
      if (failed === 0) {
        toast(`${updated} podcast${updated === 1 ? '' : 's'} refreshed`);
      } else if (updated === 0) {
        toast(`Refresh failed for ${failed} podcast${failed === 1 ? '' : 's'}`);
      } else {
        toast(`${updated} refreshed · ${failed} failed`);
      }
    } finally {
      els.syncButton.disabled = false;
      els.syncButton.classList.remove('is-refreshing');
      els.syncButton.removeAttribute('aria-busy');
      els.syncButton.setAttribute('aria-label', 'Refresh feeds');
      els.syncButton.title = 'Refresh feeds';
      els.syncButton.blur();
    }
  }

  async function playEpisode(id) {
    const ep = state.episodes[id];
    if (!ep?.audioUrl) return;

    if (ep.audioUrl.startsWith('twit-page:')) {
      const pageUrl = ep.audioUrl.slice('twit-page:'.length);
      toast('Loading archived TWiT episode…');
      const { data, error } = await state.supabase.functions.invoke(TWIT_RESOLVE_FUNCTION, {
        body: { pageUrl },
      });
      if (error || data?.error || !data?.audioUrl) {
        console.warn('TWiT episode audio resolution failed', error || data?.error);
        toast(data?.error || error?.message || 'Could not load this archived TWiT episode.');
        return;
      }
      ep.audioUrl = data.audioUrl;
      if (data.title) ep.title = data.title;
      saveLocal();
      queueEpisodeCacheSave();
      await syncEpisodesToRemote([ep], ep.feedUrl || '');
      render();
    }

    if (state.currentEpisodeId !== id) {
      persistPlayback(false);
      const shouldEnhance = state.enhanceVoices;
      resetAudioPipeline();
      state.currentEpisodeId = id;
      if (shouldEnhance) els.audio.crossOrigin = 'anonymous';
      els.audio.src = ep.audioUrl;
      els.audio.load();
      renderPlayer();
    }

    if (state.enhanceVoices) {
      try {
        await ensureAudioGraph();
        await els.audio.play();
      } catch (err) {
        console.warn('Enhanced playback failed; restoring normal playback.', err);
        const snapshot = snapshotAudio();
        state.enhanceVoices = false;
        disconnectAudioGraph({ closeContext: true });
        try {
          await rebuildAudioElement({ cors: false, snapshot, autoplay: false });
          await els.audio.play();
        } catch (_) {
          // If the browser no longer considers this a user-initiated play, the user can tap Play once.
        }
        saveLocal();
        renderPlayer();
        syncSettingsToRemote();
        toast('Enhance Voices is unavailable for this stream; normal playback has been restored.');
      }
      return;
    }

    els.audio.play().catch(err => toast(`Playback failed: ${err.message}`));
  }

  function renderPlayer() {
    const ep = state.episodes[state.currentEpisodeId];
    if (!ep) {
      els.player.classList.add('hidden');
      document.body.classList.remove('player-visible');
      if (els.nowPlayingDialog?.open) els.nowPlayingDialog.close();
      return;
    }
    els.player.classList.remove('hidden');
    document.body.classList.add('player-visible');
    els.playerTitle.textContent = decodeHtmlText(ep.title);
    els.playerShow.textContent = decodeHtmlText(ep.showTitle);
    els.playerArtButton.innerHTML = ep.image ? `<img src="${escAttr(ep.image)}" alt="">` : `<div class="art-placeholder"><i data-lucide="radio"></i></div>`;
    els.enhanceButton.setAttribute('aria-pressed', String(state.enhanceVoices));
    els.starEpisodeButton.classList.toggle('active', !!state.starredEpisodes[ep.id]);
    els.starEpisodeButton.innerHTML = `<i data-lucide="star"></i>`;
    updatePlayButton();
    updateScrub();
    if (els.nowPlayingDialog?.open) renderNowPlaying();
    lucide.createIcons();
  }

  function openNowPlaying() {
    if (!state.currentEpisodeId || !state.episodes[state.currentEpisodeId]) return;
    renderNowPlaying();
    if (!els.nowPlayingDialog.open) els.nowPlayingDialog.showModal();
  }

  function renderNowPlaying() {
    const ep = state.episodes[state.currentEpisodeId];
    if (!ep) return;
    els.nowPlayingArt.innerHTML = ep.image ? `<img src="${escAttr(ep.image)}" alt="">` : `<div class="art-placeholder"><i data-lucide="radio"></i></div>`;
    els.nowPlayingTitle.textContent = decodeHtmlText(ep.title);
    els.nowPlayingShow.textContent = decodeHtmlText(ep.showTitle);
    els.nowPlayingEnhanceButton.setAttribute('aria-pressed', String(state.enhanceVoices));
    els.nowPlayingStarButton.classList.toggle('active', !!state.starredEpisodes[ep.id]);
    els.nowPlayingStarButton.setAttribute('aria-pressed', String(!!state.starredEpisodes[ep.id]));
    updatePlayButton();
    updateScrub();
    lucide.createIcons();
  }

  async function togglePlay() {
    if (!state.currentEpisodeId) return;
    if (els.audio.paused) els.audio.play().catch(err => toast(`Playback failed: ${err.message}`));
    else els.audio.pause();
  }

  function jumpPlayback(seconds) {
    if (!state.currentEpisodeId || !Number.isFinite(els.audio.currentTime)) return;
    const duration = Number.isFinite(els.audio.duration) ? els.audio.duration : Infinity;
    els.audio.currentTime = Math.max(0, Math.min(duration, els.audio.currentTime + seconds));
    updateScrub();
    persistPlayback(true);
  }

  function handlePlaybackShortcuts(event) {
    if (!state.currentEpisodeId || els.player.classList.contains('hidden')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target instanceof Element ? event.target : null;
    const typing = target?.closest('input:not([type="range"]), textarea, select, [contenteditable="true"], [role="textbox"]');
    const blockingDialog = [...document.querySelectorAll('dialog[open]')].some(dialog => dialog !== els.nowPlayingDialog);
    if (typing || blockingDialog) return;

    if (event.code === 'Space') {
      // Space is a global playback shortcut. Do not let a previously focused
      // toolbar button steal it after a mouse/touch interaction.
      event.preventDefault();
      togglePlay();
      return;
    }

    // Preserve normal keyboard behavior for sliders/buttons when using arrows.
    if (target?.closest('input, textarea, select, button, a, [contenteditable="true"]')) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      jumpPlayback(-15);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      jumpPlayback(15);
    }
  }

  function onLoadedMetadata() {
    const pb = state.playback[state.currentEpisodeId];
    if (pb?.position && pb.position < els.audio.duration - 2) els.audio.currentTime = pb.position;
    els.duration.textContent = formatTime(els.audio.duration);
    updateScrub();
  }

  function onTimeUpdate() {
    updateScrub();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistPlayback(true), 3000);
  }

  function updateScrub() {
    const d = els.audio.duration;
    const t = els.audio.currentTime;
    els.currentTime.textContent = formatTime(t);
    els.duration.textContent = formatTime(d);
    els.seek.value = Number.isFinite(d) && d > 0 ? (t / d * 100) : 0;
    if (els.nowPlayingSeek) {
      els.nowPlayingCurrentTime.textContent = formatTime(t);
      els.nowPlayingDuration.textContent = formatTime(d);
      els.nowPlayingSeek.value = Number.isFinite(d) && d > 0 ? (t / d * 100) : 0;
    }
  }

  function updatePlayButton() {
    els.playPause.innerHTML = els.audio.paused ? '<i data-lucide="play"></i>' : '<i data-lucide="pause"></i>';
    els.playPause.setAttribute('aria-label', els.audio.paused ? 'Play' : 'Pause');
    if (els.nowPlayingPlayPause) {
      els.nowPlayingPlayPause.innerHTML = els.audio.paused ? '<i data-lucide="play"></i>' : '<i data-lucide="pause"></i>';
      els.nowPlayingPlayPause.setAttribute('aria-label', els.audio.paused ? 'Play' : 'Pause');
    }
    lucide.createIcons();
  }

  async function onEnded() {
    const id = state.currentEpisodeId;
    if (!id) return;
    state.playback[id] = { position: els.audio.duration || 0, duration: els.audio.duration || 0, completed: true, updatedAt: Date.now() };
    saveLocal();
    await syncPlaybackToRemote(id);
    render();
  }

  async function persistPlayback(remote = true) {
    const id = state.currentEpisodeId;
    if (!id || !Number.isFinite(els.audio.currentTime)) return;
    const duration = Number.isFinite(els.audio.duration) ? els.audio.duration : (state.episodes[id]?.duration || 0);
    const completed = duration > 0 && els.audio.currentTime >= duration - 5;
    state.playback[id] = { position: els.audio.currentTime, duration, completed, updatedAt: Date.now() };
    saveLocal();
    if (remote) await syncPlaybackToRemote(id);
  }

  async function toggleEnhance() {
    const ep = state.episodes[state.currentEpisodeId];
    if (!ep) return;

    if (!state.enhanceVoices) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return toast('Enhance Voices is not supported by this browser.');

      // Start/resume the AudioContext immediately from the user's click. On iOS/Safari,
      // waiting for a network check first can lose the user gesture and leave the graph suspended.
      try {
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === 'suspended') await audioCtx.resume();
      } catch (_) {
        return toast('Enhance Voices could not start. Normal playback is unaffected.');
      }

      const ok = await streamSupportsEnhancement(ep.audioUrl);
      if (!ok) return toast('This podcast host does not allow browser voice enhancement. Normal playback is unaffected.');

      const snapshot = snapshotAudio();
      try {
        // MediaElementAudioSource requires the media element itself to have loaded the
        // stream with CORS enabled. Rebuild it in CORS mode, then attach the filters.
        await rebuildAudioElement({ cors: true, snapshot, autoplay: false });
        state.enhanceVoices = true;
        await ensureAudioGraph();
        applyEnhanceState();
        if (snapshot.wasPlaying) await els.audio.play();
      } catch (err) {
        console.warn('Voice enhancement unavailable; restoring normal playback.', err);
        state.enhanceVoices = false;
        disconnectAudioGraph({ closeContext: true });
        try {
          await rebuildAudioElement({ cors: false, snapshot, autoplay: snapshot.wasPlaying });
        } catch (_) {
          // If restoration itself fails, leave the player visible and let the user retry Play.
        }
        saveLocal();
        renderPlayer();
        return toast('Enhance Voices is unavailable for this stream; normal playback has been restored.');
      }
    } else {
      state.enhanceVoices = false;
      saveLocal();
      applyEnhanceState();
    }

    saveLocal();
    await syncSettingsToRemote();
    renderPlayer();
  }

  async function ensureAudioGraph() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is unavailable.');
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (sourceNode) return;

    sourceNode = audioCtx.createMediaElementSource(els.audio);
    highPass = audioCtx.createBiquadFilter();
    highPass.type = 'highpass'; highPass.frequency.value = 85; highPass.Q.value = 0.7;
    presence = audioCtx.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 2600; presence.Q.value = 0.8; presence.gain.value = 3.5;
    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -26; compressor.knee.value = 24; compressor.ratio.value = 3; compressor.attack.value = 0.01; compressor.release.value = 0.22;
    sourceNode.connect(highPass).connect(presence).connect(compressor).connect(audioCtx.destination);
    applyEnhanceState();
  }

  function applyEnhanceState() {
    if (!sourceNode || !audioCtx) return;
    try { sourceNode.disconnect(); } catch (_) {}
    try { highPass?.disconnect(); } catch (_) {}
    try { presence?.disconnect(); } catch (_) {}
    try { compressor?.disconnect(); } catch (_) {}

    if (state.enhanceVoices && highPass && presence && compressor) {
      highPass.frequency.value = 85;
      presence.gain.value = 3.5;
      compressor.threshold.value = -26;
      compressor.ratio.value = 3;
      sourceNode.connect(highPass).connect(presence).connect(compressor).connect(audioCtx.destination);
    } else {
      // True bypass: when Enhance Voices is off, route the media source directly
      // to the speakers rather than leaving it inside a near-neutral filter chain.
      sourceNode.connect(audioCtx.destination);
    }
  }

  async function toggleStarEpisode(id) {
    if (!id) return;
    state.starredEpisodes[id] = !state.starredEpisodes[id];
    saveLocal(); render();
    await syncEpisodeStarToRemote(id);
  }

  async function toggleStarShow(id) {
    state.starredShows[id] = !state.starredShows[id];
    saveLocal(); render();
    await syncShowStarToRemote(id);
  }

  function applyTextSize() {
    document.documentElement.dataset.textSize = state.textSize || 'medium';
    updateTextSizeButtons();
  }

  function setTextSize(size) {
    if (!['small','medium','large'].includes(size)) return;
    state.textSize = size;
    const settings = getSettings();
    safeLocalSet(SETTINGS_KEY, JSON.stringify({ ...settings, textSize: size }));
    applyTextSize();
  }

  function updateTextSizeButtons() {
    document.querySelectorAll('[data-text-size]').forEach(btn => {
      const active = btn.dataset.textSize === state.textSize;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function effectiveTheme() {
    if (state.theme === 'dark') return 'dark';
    if (state.theme === 'light') return 'light';
    return DARK_QUERY.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme || 'system';
    document.documentElement.style.colorScheme = effectiveTheme();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', effectiveTheme() === 'dark' ? '#151c23' : '#e6ecf2');
    updateThemeButtons();
  }

  function setTheme(theme) {
    if (!['system','light','dark'].includes(theme)) return;
    state.theme = theme;
    const settings = getSettings();
    safeLocalSet(SETTINGS_KEY, JSON.stringify({ ...settings, theme }));
    applyTheme();
  }

  function updateThemeButtons() {
    document.querySelectorAll('[data-theme-choice]').forEach(btn => {
      const active = btn.dataset.themeChoice === state.theme;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function openSettings() {
    const s = getSettings();
    els.emailInput.value = state.user?.email || s.email || '';
    updateTextSizeButtons();
    updateThemeButtons();
    updateAuthControls();
    els.settingsDialog.showModal();
  }

  function updateAuthControls() {
    const signedIn = !!state.user;
    els.emailInput.disabled = signedIn;
    els.saveSettingsButton.classList.toggle('hidden', signedIn);
    els.signOutButton.classList.toggle('hidden', !signedIn);
    els.settingsSubtitle.textContent = signedIn ? 'Your Podstream sync account.' : 'Sign in for cross-device sync.';
    els.authStatus.textContent = signedIn ? `Signed in as ${state.user.email}` : 'Not signed in.';
  }

  function safeLocalSet(key, value) {
    try { localStorage.setItem(key, value); }
    catch (error) { console.warn(`Could not save ${key}`, error); }
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }

  async function saveSettingsAndSignIn() {
    const email = els.emailInput.value.trim();
    const settings = getSettings();
    safeLocalSet(SETTINGS_KEY, JSON.stringify({ ...settings, email }));
    if (!state.supabase || !email) { els.authStatus.textContent = 'Enter your email to sign in.'; return; }
    if (state.user?.email?.toLowerCase() === email.toLowerCase()) {
      els.authStatus.textContent = `Already signed in as ${state.user.email}`;
      return;
    }
    els.authStatus.textContent = 'Sending sign-in link…';
    const redirectTo = `${location.origin}${location.pathname}`;
    const { error } = await state.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
    });
    els.authStatus.textContent = error ? error.message : 'Sign-in link sent. Open it to finish signing in.';
  }

  async function initSupabase() {
    if (!window.supabase?.createClient) return;
    try {
      state.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: podstreamAuthStorage },
      });
      const { data, error } = await state.supabase.auth.getSession();
      if (error) throw error;
      state.user = data.session?.user || null;
      state.remoteReady = !!state.user;
      state.supabase.auth.onAuthStateChange((_event, session) => {
        state.user = session?.user || null;
        state.remoteReady = !!state.user;
        if (els.settingsDialog?.open) updateAuthControls();
        if (state.remoteReady) setTimeout(() => hydrateRemote(), 0);
      });
    } catch (e) { console.warn('Supabase initialization failed', e); }
  }

  async function signOut() {
    if (state.supabase) await state.supabase.auth.signOut();
    state.user = null; state.remoteReady = false;
    updateAuthControls();
    els.authStatus.textContent = 'Signed out.';
    render();
  }

  async function hydrateRemote() {
    if (!state.remoteReady) return;
    try {
      const [subsRes, playsRes, starsRes, settingsRes, archivedRows] = await Promise.all([
        state.supabase.from('podstream_subscriptions').select('*').order('created_at'),
        state.supabase.from('podstream_playback_positions').select('*'),
        state.supabase.from('podstream_stars').select('*'),
        state.supabase.from('podstream_settings').select('*').maybeSingle(),
        fetchRemoteEpisodeArchive(),
      ]);
      for (const result of [subsRes, playsRes, starsRes, settingsRes]) {
        if (result.error) throw result.error;
      }

      const subs = subsRes.data || [];
      const plays = playsRes.data || [];
      const stars = starsRes.data || [];
      const remoteSettings = settingsRes.data;
      mergeRemoteEpisodeArchive(archivedRows);

      for (const sub of subs) {
        const local = state.subscriptions.find(x => x.feedUrl === sub.feed_url);
        if (local) {
          local.title = sub.title || local.title;
          local.image = sub.image_url || local.image;
          local.description = sub.description || local.description || '';
          local.catalogTotal = Number(sub.catalog_total) || Number(local.catalogTotal) || 0;
          local.backfilledAt = sub.backfilled_at ? new Date(sub.backfilled_at).getTime() : (local.backfilledAt || null);
        }
        const localShow = local || state.subscriptions.find(x => x.feedUrl === sub.feed_url);
        const cachedCount = localShow ? episodeCountForShow(localShow.id) : 0;
        const hasCachedEpisodes = cachedCount > 0;
        const catalogTotal = Number(sub.catalog_total) || Number(localShow?.catalogTotal) || 0;
        const shouldBackfillCached = cachedCount > 0 && cachedCount <= 75 && (!sub.backfilled_at || catalogTotal > cachedCount);
        if (!local || !hasCachedEpisodes || !local?.description || !local?.title || /^Untitled podcast$/i.test(local?.title || '') || shouldBackfillCached) {
          try {
            let feed = await fetchFeed(sub.feed_url);
            const feedCount = (feed.episodes || []).length;
            const shouldBackfillFeed = feedCount <= 75 && (!sub.backfilled_at || catalogTotal > feedCount);
            if (shouldBackfillCached || shouldBackfillFeed) feed = await applyCatalogBackfill(feed);
            const canonicalUrl = feed.feedUrl || feed.id || sub.feed_url;
            const archived = upsertFeed(feed, canonicalUrl, sub.feed_url);
            await syncSubscriptionToRemote(canonicalUrl, feed);
            await syncEpisodesToRemote(archived, canonicalUrl);
            if (canonicalUrl !== sub.feed_url) await removeRemoteSubscriptionByUrl(sub.feed_url);
          } catch (e) { console.warn('Feed hydration failed', e); }
        }
      }

      for (const p of plays) {
        const remote = {
          position: Number(p.position_seconds) || 0,
          duration: Number(p.duration_seconds) || 0,
          completed: !!p.completed,
          updatedAt: new Date(p.updated_at).getTime(),
        };
        const local = state.playback[p.episode_id];
        if (!local || remote.updatedAt >= (local.updatedAt || 0)) state.playback[p.episode_id] = remote;
        else await syncPlaybackToRemote(p.episode_id);
      }

      state.starredEpisodes = {};
      state.starredShows = {};
      for (const st of stars) {
        if (st.item_type === 'episode') state.starredEpisodes[st.item_id] = true;
        if (st.item_type === 'show') state.starredShows[st.item_id] = true;
      }

      if (remoteSettings) state.enhanceVoices = !!remoteSettings.enhance_voices;
      else await syncSettingsToRemote();

      saveLocal();
      queueEpisodeCacheSave();
      render();
      // One-time/bootstrap upload of any episodes learned before the server-side
      // archive existed. This runs after the UI is usable.
      if ((archivedRows?.length || 0) < Object.keys(state.episodes).length) {
        setTimeout(() => syncEpisodesToRemote(Object.values(state.episodes)), 0);
      }
    } catch (e) {
      console.warn('Remote hydration failed', e);
      toast('Cloud sync could not be refreshed.');
    }
  }

  async function removeRemoteSubscriptionByUrl(feedUrl) {
    if (!state.remoteReady || !feedUrl) return;
    const { error } = await state.supabase.from('podstream_subscriptions')
      .delete()
      .eq('user_id', state.user.id)
      .eq('feed_url', feedUrl);
    if (error) console.warn('Old subscription cleanup failed', error);
  }

  async function syncSubscriptionToRemote(feedUrl, feed) {
    if (!state.remoteReady) return;
    const payload = {
      user_id: state.user.id,
      feed_url: feedUrl,
      title: feed.title || null,
      image_url: feed.image || null,
      description: feed.description || null,
      updated_at: new Date().toISOString(),
    };
    if (Number(feed.catalogTotal) > 0) payload.catalog_total = Number(feed.catalogTotal);
    if (feed.backfillAttempted) payload.backfilled_at = new Date().toISOString();
    const { error } = await state.supabase.from('podstream_subscriptions').upsert(payload, { onConflict: 'user_id,feed_url' });
    if (error) console.warn('Subscription sync failed', error);
  }

  async function fetchRemoteEpisodeArchive() {
    if (!state.remoteReady) return [];
    const rows = [];
    const pageSize = 1000;
    for (let start = 0; ; start += pageSize) {
      const { data, error } = await state.supabase.from('podstream_episode_archive')
        .select('*')
        .order('published_at', { ascending: false, nullsFirst: false })
        .range(start, start + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  function mergeRemoteEpisodeArchive(rows) {
    for (const row of rows || []) {
      if (!row?.episode_id || !row?.audio_url) continue;
      const existing = state.episodes[row.episode_id] || {};
      state.episodes[row.episode_id] = {
        ...existing,
        id: row.episode_id,
        showId: row.show_id || existing.showId,
        feedUrl: row.feed_url || existing.feedUrl || '',
        showTitle: row.show_title || existing.showTitle || '',
        title: row.title || existing.title || 'Untitled episode',
        audioUrl: row.audio_url,
        publishedAt: row.published_at || existing.publishedAt || new Date().toISOString(),
        duration: Number(row.duration_seconds) || Number(existing.duration) || 0,
        image: row.image_url || existing.image || '',
        source: row.source || existing.source || 'rss',
      };
    }
  }

  async function syncEpisodesToRemote(episodes, explicitFeedUrl = '') {
    if (!state.remoteReady || !episodes?.length) return;
    const rows = [];
    for (const ep of episodes) {
      if (!ep?.id || !ep?.audioUrl || !ep?.showId) continue;
      const sub = state.subscriptions.find(s => s.id === ep.showId);
      rows.push({
        user_id: state.user.id,
        episode_id: ep.id,
        show_id: ep.showId,
        feed_url: explicitFeedUrl || ep.feedUrl || sub?.feedUrl || null,
        show_title: ep.showTitle || sub?.title || null,
        title: ep.title || null,
        audio_url: ep.audioUrl,
        published_at: ep.publishedAt || null,
        duration_seconds: Math.max(0, Number(ep.duration) || 0),
        image_url: ep.image || null,
        source: ep.source || 'rss',
        updated_at: new Date().toISOString(),
      });
    }
    const chunkSize = 250;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const { error } = await state.supabase.from('podstream_episode_archive')
        .upsert(rows.slice(i, i + chunkSize), { onConflict: 'user_id,episode_id' });
      if (error) { console.warn('Episode archive sync failed', error); break; }
    }
  }

  async function syncPlaybackToRemote(id) {
    if (!state.remoteReady || !id) return;
    const p = state.playback[id];
    if (!p) return;
    const updatedAt = p.updatedAt || Date.now();
    const { error } = await state.supabase.from('podstream_playback_positions').upsert({
      user_id: state.user.id,
      episode_id: id,
      position_seconds: Math.max(0, Number(p.position) || 0),
      duration_seconds: Math.max(0, Number(p.duration) || 0),
      completed: !!p.completed,
      updated_at: new Date(updatedAt).toISOString(),
    }, { onConflict: 'user_id,episode_id' });
    if (error) console.warn('Playback sync failed', error);
  }

  async function syncEpisodeStarToRemote(id) { await syncStar('episode', id, !!state.starredEpisodes[id]); }
  async function syncShowStarToRemote(id) { await syncStar('show', id, !!state.starredShows[id]); }
  async function syncStar(type, id, on) {
    if (!state.remoteReady) return;
    const query = state.supabase.from('podstream_stars');
    const { error } = on
      ? await query.upsert({ user_id: state.user.id, item_type: type, item_id: id }, { onConflict: 'user_id,item_type,item_id' })
      : await query.delete().eq('user_id', state.user.id).eq('item_type', type).eq('item_id', id);
    if (error) console.warn('Star sync failed', error);
  }

  async function syncSettingsToRemote() {
    if (!state.remoteReady) return;
    const { error } = await state.supabase.from('podstream_settings').upsert({
      user_id: state.user.id,
      enhance_voices: !!state.enhanceVoices,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });
    if (error) console.warn('Settings sync failed', error);
  }

  function coverMarkup(src, alt) {
    return src ? `<img class="cover" src="${escAttr(src)}" alt="${escAttr(alt || '')}" loading="lazy">` : `<div class="cover fallback"><i data-lucide="radio"></i></div>`;
  }
  function formatTime(s) { if (!Number.isFinite(s) || s < 0) return '0:00'; s=Math.floor(s); const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60; return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`; }
  function friendlyDate(v) { try { const d=new Date(v); const diff=(Date.now()-d)/86400000; if (diff < 1) return 'Today'; if (diff < 2) return 'Yesterday'; return d.toLocaleDateString(undefined,{month:'short',day:'numeric'}); } catch { return ''; } }
  function hash(str) { let h=2166136261; for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619)} return (h>>>0).toString(36); }
  const entityDecoder = document.createElement('textarea');
  function decodeHtmlText(s='') {
    let out = String(s);
    for (let i = 0; i < 2; i++) {
      entityDecoder.innerHTML = out;
      const decoded = entityDecoder.value;
      if (decoded === out) break;
      out = decoded;
    }
    return out;
  }
  function esc(s='') { return decodeHtmlText(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function escAttr(s='') { return esc(s); }
  function toast(msg) { clearTimeout(toastTimer); els.toast.textContent=msg; els.toast.classList.remove('hidden'); toastTimer=setTimeout(()=>els.toast.classList.add('hidden'),2600); }
})();
