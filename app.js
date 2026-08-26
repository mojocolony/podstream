(() => {
  const APP_VERSION = '0.1.14';
  const LS_KEY = 'podstream-state-v1';
  const SETTINGS_KEY = 'podstream-settings-v1';
  const SUPABASE_URL = 'https://appesztafatypbxzdunr.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_70RugEcKQxZWUa5eQfmyeg_y7AkVz9V';
  const FEED_FUNCTION = 'podstream-fetch-feed';
  const state = {
    view: 'stream',
    subscriptions: [],
    episodes: {},
    playback: {},
    starredEpisodes: {},
    starredShows: {},
    currentEpisodeId: null,
    enhanceVoices: false,
    textSize: 'medium',
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

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    cacheEls();
    loadLocal();
    applyTextSize();
    bindEvents();
    render();
    lucide.createIcons();
    await initSupabase();
    if (state.remoteReady) await hydrateRemote();
  }

  function cacheEls() {
    ['content','viewTitle','viewSubtitle','addPodcastButton','addPodcastDialog','addPodcastForm','feedUrlInput','feedError','feedChoices','settingsDialog','settingsButton','syncButton','menuButton','sidebar','audio','player','playerTitle','playerShow','playerArtButton','playPause','back15','forward15','seek','currentTime','duration','enhanceButton','starEpisodeButton','emailInput','saveSettingsButton','signOutButton','authStatus','toast'].forEach(id => els[id] = document.getElementById(id));
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    els.addPodcastButton.addEventListener('click', () => {
      if (!state.remoteReady) {
        openSettings();
        els.authStatus.textContent = 'Sign in before adding a podcast.';
        return;
      }
      els.feedError.classList.add('hidden');
      els.feedChoices.classList.add('hidden');
      els.feedChoices.innerHTML = '';
      els.feedUrlInput.value = '';
      els.addPodcastDialog.showModal();
    });
    els.addPodcastForm.addEventListener('submit', handleAddPodcast);
    document.querySelectorAll('[data-dialog-close]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog')?.close()));
    [els.addPodcastDialog, els.settingsDialog].forEach(dialog => {
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
    els.settingsButton.addEventListener('click', openSettings);
    document.querySelectorAll('[data-text-size]').forEach(btn => btn.addEventListener('click', () => setTextSize(btn.dataset.textSize)));
    els.saveSettingsButton.addEventListener('click', saveSettingsAndSignIn);
    els.signOutButton.addEventListener('click', signOut);
    els.syncButton.addEventListener('click', refreshAllFeeds);
    els.menuButton.addEventListener('click', () => els.sidebar.classList.toggle('open'));
    els.playPause.addEventListener('click', togglePlay);
    els.back15.addEventListener('click', () => jumpPlayback(-15));
    els.forward15.addEventListener('click', () => jumpPlayback(15));
    document.addEventListener('keydown', handlePlaybackShortcuts);
    els.seek.addEventListener('input', () => { if (Number.isFinite(els.audio.duration)) els.audio.currentTime = Number(els.seek.value) / 100 * els.audio.duration; });
    bindAudioEvents();
    els.enhanceButton.addEventListener('click', toggleEnhance);
    els.starEpisodeButton.addEventListener('click', () => toggleStarEpisode(state.currentEpisodeId));
    els.playerArtButton.addEventListener('click', () => toggleStarEpisode(state.currentEpisodeId));
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
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
      Object.assign(state, {
        subscriptions: raw.subscriptions || [],
        episodes: raw.episodes || {},
        playback: raw.playback || {},
        starredEpisodes: raw.starredEpisodes || {},
        starredShows: raw.starredShows || {},
        enhanceVoices: !!raw.enhanceVoices,
      });
    } catch (_) {}
  }

  function saveLocal() {
    localStorage.setItem(LS_KEY, JSON.stringify({
      subscriptions: state.subscriptions,
      episodes: state.episodes,
      playback: state.playback,
      starredEpisodes: state.starredEpisodes,
      starredShows: state.starredShows,
      enhanceVoices: state.enhanceVoices,
    }));
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    els.sidebar.classList.remove('open');
    render();
  }

  function render() {
    const meta = {
      stream: ['Stream','Newest episodes from your subscriptions.'],
      podcasts: ['Podcasts','The podcasts you follow.'],
      starred: ['Starred','Episodes and podcasts you want to keep close.'],
      history: ['History','What you have been listening to.'],
    }[state.view];
    els.viewTitle.textContent = meta[0];
    els.viewSubtitle.textContent = meta[1];
    els.addPodcastButton.style.display = 'inline-flex';

    if (state.view === 'podcasts') renderSubscriptions();
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
        <div class="episode-sub"><span class="show">${esc(e.showTitle)}</span><span>•</span><span>${friendlyDate(e.publishedAt)}</span>${e.duration ? `<span>•</span><span>${formatTime(e.duration)}</span>`:''}</div>
        ${pct > 1 ? `<div class="progress-line"><span style="width:${pct}%"></span></div>` : ''}
      </div>
      <div class="episode-actions">
        <button class="icon-button ${state.starredEpisodes[e.id] ? 'active':''}" data-star-episode="${escAttr(e.id)}" aria-label="Star episode"><i data-lucide="star"></i></button>
        <button class="icon-button" data-play="${escAttr(e.id)}" aria-label="Play"><i data-lucide="play"></i></button>
      </div>
    </article>`;
  }

  function renderSubscriptions() {
    if (!state.subscriptions.length) {
      els.content.innerHTML = emptyMarkup('No subscriptions','Add a podcast using its website or RSS feed URL.','rss');
      return;
    }
    const subscriptions = [...state.subscriptions].sort((a, b) =>
      (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base', numeric: true })
    );
    els.content.innerHTML = `<div class="subscription-list">${subscriptions.map(s => `<article class="subscription-row">
      ${coverMarkup(s.image, s.title)}
      <div class="subscription-main">
        <div class="subscription-title">${esc(s.title)}</div>
        ${s.description ? `<div class="subscription-description">${esc(s.description)}</div>` : `<div class="subscription-description muted">No description supplied by this podcast.</div>`}
        <div class="subscription-meta">${s.episodeCount || 0} episodes loaded</div>
      </div>
      <div class="subscription-actions">
        <button class="icon-button star-show ${state.starredShows[s.id] ? 'active':''}" data-star-show="${escAttr(s.id)}" aria-label="Star podcast" title="Star podcast"><i data-lucide="star"></i></button>
        <button class="icon-button remove-show" data-remove-show="${escAttr(s.id)}" aria-label="Remove podcast" title="Remove podcast"><i data-lucide="trash-2"></i></button>
      </div>
    </article>`).join('')}</div>`;
    els.content.querySelectorAll('[data-star-show]').forEach(el => el.addEventListener('click', () => toggleStarShow(el.dataset.starShow)));
    els.content.querySelectorAll('[data-remove-show]').forEach(el => el.addEventListener('click', () => removeSubscription(el.dataset.removeShow)));
  }

  async function removeSubscription(showId) {
    const sub = state.subscriptions.find(s => s.id === showId);
    if (!sub) return;
    const ok = window.confirm(`Remove “${sub.title}” from Podcasts?\n\nListening history and individually starred episodes will be kept.`);
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
      const result = await fetchFeed(url);
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
    const feedUrl = feed.feedUrl || feed.id;
    if (!feedUrl) throw new Error('The discovered feed did not include a usable URL.');
    upsertFeed(feed, feedUrl);
    await syncSubscriptionToRemote(feedUrl, feed);
    els.addPodcastDialog.close();
    setView('stream');
    toast('Podcast added');
  }

  async function fetchFeed(url) {
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

  function upsertFeed(feed, feedUrl) {
    const showId = feed.id || hash(feedUrl);
    const sub = {
      id: showId,
      feedUrl,
      title: feed.title || 'Untitled podcast',
      image: feed.image || '',
      description: feed.description || '',
      episodeCount: (feed.episodes || []).length,
      updatedAt: Date.now(),
    };
    const idx = state.subscriptions.findIndex(s => s.id === showId || s.feedUrl === feedUrl);
    if (idx >= 0) state.subscriptions[idx] = { ...state.subscriptions[idx], ...sub };
    else state.subscriptions.push(sub);

    for (const ep of (feed.episodes || [])) {
      const id = ep.id || hash(`${showId}|${ep.audioUrl}|${ep.title}`);
      state.episodes[id] = {
        id, showId, showTitle: sub.title, title: ep.title || 'Untitled episode', audioUrl: ep.audioUrl,
        publishedAt: ep.publishedAt || new Date().toISOString(), image: ep.image || sub.image || '', duration: Number(ep.duration) || 0,
      };
    }
    saveLocal();
  }

  async function refreshAllFeeds() {
    if (!state.remoteReady) { openSettings(); els.authStatus.textContent = 'Sign in before refreshing feeds.'; return; }
    if (!state.subscriptions.length) return toast('No subscriptions yet');
    els.syncButton.disabled = true;
    try {
      for (const s of state.subscriptions) {
        try {
          const feed = await fetchFeed(s.feedUrl);
          upsertFeed(feed, s.feedUrl);
          await syncSubscriptionToRemote(s.feedUrl, feed);
        } catch (e) { console.warn('Feed refresh failed', s.feedUrl, e); }
      }
      render();
      toast('Feeds refreshed');
    } finally { els.syncButton.disabled = false; }
  }

  async function playEpisode(id) {
    const ep = state.episodes[id];
    if (!ep?.audioUrl) return;

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
    if (!ep) { els.player.classList.add('hidden'); return; }
    els.player.classList.remove('hidden');
    els.playerTitle.textContent = ep.title;
    els.playerShow.textContent = ep.showTitle;
    els.playerArtButton.innerHTML = ep.image ? `<img src="${escAttr(ep.image)}" alt="">` : `<div class="art-placeholder"><i data-lucide="radio"></i></div>`;
    els.enhanceButton.setAttribute('aria-pressed', String(state.enhanceVoices));
    els.starEpisodeButton.classList.toggle('active', !!state.starredEpisodes[ep.id]);
    els.starEpisodeButton.innerHTML = `<i data-lucide="star"></i>`;
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

    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="textbox"]')) return;
    if (document.querySelector('dialog[open]')) return;

    if (event.code === 'Space') {
      event.preventDefault();
      togglePlay();
    } else if (event.key === 'ArrowLeft') {
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
  }

  function updatePlayButton() {
    els.playPause.innerHTML = els.audio.paused ? '<i data-lucide="play"></i>' : '<i data-lucide="pause"></i>';
    els.playPause.setAttribute('aria-label', els.audio.paused ? 'Play' : 'Pause');
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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, textSize: size }));
    applyTextSize();
  }

  function updateTextSizeButtons() {
    document.querySelectorAll('[data-text-size]').forEach(btn => {
      const active = btn.dataset.textSize === state.textSize;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  function openSettings() {
    const s = getSettings();
    els.emailInput.value = state.user?.email || s.email || '';
    els.authStatus.textContent = state.user ? `Signed in as ${state.user.email}` : 'Not signed in.';
    updateTextSizeButtons();
    els.settingsDialog.showModal();
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }

  async function saveSettingsAndSignIn() {
    const email = els.emailInput.value.trim();
    const settings = getSettings();
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, email }));
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
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      const { data, error } = await state.supabase.auth.getSession();
      if (error) throw error;
      state.user = data.session?.user || null;
      state.remoteReady = !!state.user;
      state.supabase.auth.onAuthStateChange((_event, session) => {
        state.user = session?.user || null;
        state.remoteReady = !!state.user;
        if (state.remoteReady) setTimeout(() => hydrateRemote(), 0);
      });
    } catch (e) { console.warn('Supabase initialization failed', e); }
  }

  async function signOut() {
    if (state.supabase) await state.supabase.auth.signOut();
    state.user = null; state.remoteReady = false;
    els.authStatus.textContent = 'Signed out.';
  }

  async function hydrateRemote() {
    if (!state.remoteReady) return;
    try {
      const [subsRes, playsRes, starsRes, settingsRes] = await Promise.all([
        state.supabase.from('podstream_subscriptions').select('*').order('created_at'),
        state.supabase.from('podstream_playback_positions').select('*'),
        state.supabase.from('podstream_stars').select('*'),
        state.supabase.from('podstream_settings').select('*').maybeSingle(),
      ]);
      for (const result of [subsRes, playsRes, starsRes, settingsRes]) {
        if (result.error) throw result.error;
      }

      const subs = subsRes.data || [];
      const plays = playsRes.data || [];
      const stars = starsRes.data || [];
      const remoteSettings = settingsRes.data;

      for (const sub of subs) {
        const local = state.subscriptions.find(x => x.feedUrl === sub.feed_url);
        if (local) {
          local.title = sub.title || local.title;
          local.image = sub.image_url || local.image;
          local.description = sub.description || local.description || '';
        }
        if (!local || !local.description) {
          try {
            const feed = await fetchFeed(sub.feed_url);
            upsertFeed(feed, sub.feed_url);
            await syncSubscriptionToRemote(sub.feed_url, feed);
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
      render();
    } catch (e) {
      console.warn('Remote hydration failed', e);
      toast('Cloud sync could not be refreshed.');
    }
  }

  async function syncSubscriptionToRemote(feedUrl, feed) {
    if (!state.remoteReady) return;
    const { error } = await state.supabase.from('podstream_subscriptions').upsert({
      user_id: state.user.id,
      feed_url: feedUrl,
      title: feed.title || null,
      image_url: feed.image || null,
      description: feed.description || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,feed_url' });
    if (error) console.warn('Subscription sync failed', error);
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
  function esc(s='') { return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function escAttr(s='') { return esc(s); }
  function toast(msg) { clearTimeout(toastTimer); els.toast.textContent=msg; els.toast.classList.remove('hidden'); toastTimer=setTimeout(()=>els.toast.classList.add('hidden'),2600); }
})();
