(() => {
  const APP_VERSION = '0.1.0';
  const LS_KEY = 'podstream-state-v1';
  const SETTINGS_KEY = 'podstream-settings-v1';
  const state = {
    view: 'stream',
    subscriptions: [],
    episodes: {},
    playback: {},
    starredEpisodes: {},
    starredShows: {},
    currentEpisodeId: null,
    enhanceVoices: false,
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
    bindEvents();
    render();
    lucide.createIcons();
    await initSupabaseFromSettings();
    if (state.remoteReady) await hydrateRemote();
  }

  function cacheEls() {
    ['content','viewTitle','viewSubtitle','addPodcastButton','addPodcastDialog','addPodcastForm','feedUrlInput','feedError','settingsDialog','settingsButton','syncButton','menuButton','sidebar','audio','player','playerTitle','playerShow','playerArtButton','playPause','back15','forward15','seek','currentTime','duration','enhanceButton','starEpisodeButton','supabaseUrlInput','supabaseKeyInput','emailInput','saveSettingsButton','signOutButton','authStatus','toast'].forEach(id => els[id] = document.getElementById(id));
  }

  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
    els.addPodcastButton.addEventListener('click', () => { els.feedError.classList.add('hidden'); els.feedUrlInput.value=''; els.addPodcastDialog.showModal(); });
    els.addPodcastForm.addEventListener('submit', handleAddPodcast);
    els.settingsButton.addEventListener('click', openSettings);
    els.saveSettingsButton.addEventListener('click', saveSettingsAndSignIn);
    els.signOutButton.addEventListener('click', signOut);
    els.syncButton.addEventListener('click', refreshAllFeeds);
    els.menuButton.addEventListener('click', () => els.sidebar.classList.toggle('open'));
    els.playPause.addEventListener('click', togglePlay);
    els.back15.addEventListener('click', () => { els.audio.currentTime = Math.max(0, els.audio.currentTime - 15); });
    els.forward15.addEventListener('click', () => { els.audio.currentTime = Math.min(els.audio.duration || Infinity, els.audio.currentTime + 15); });
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

  function resetAudioPipeline() {
    if (!audioCtx) return;
    try { sourceNode?.disconnect(); highPass?.disconnect(); presence?.disconnect(); compressor?.disconnect(); audioCtx.close(); } catch (_) {}
    audioCtx = sourceNode = highPass = presence = compressor = null;
    const old = els.audio;
    const fresh = document.createElement('audio');
    fresh.id = 'audio';
    fresh.preload = 'metadata';
    old.replaceWith(fresh);
    els.audio = fresh;
    bindAudioEvents();
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
      progress: ['In Progress','Pick up where you left off.'],
      starred: ['Starred','Episodes and podcasts you want to keep close.'],
      subscriptions: ['Subscriptions','The podcasts you follow.'],
    }[state.view];
    els.viewTitle.textContent = meta[0];
    els.viewSubtitle.textContent = meta[1];
    els.addPodcastButton.style.display = state.view === 'subscriptions' || state.subscriptions.length === 0 ? 'inline-flex' : '';

    if (state.view === 'subscriptions') renderSubscriptions();
    else renderEpisodesView();
    renderPlayer();
    lucide.createIcons();
  }

  function renderEpisodesView() {
    let eps = Object.values(state.episodes);
    if (state.view === 'stream') eps.sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    if (state.view === 'progress') {
      eps = eps.filter(e => {
        const p = state.playback[e.id];
        return p && p.position > 5 && !p.completed;
      }).sort((a,b) => (state.playback[b.id]?.updatedAt || 0) - (state.playback[a.id]?.updatedAt || 0));
    }
    if (state.view === 'starred') {
      const starredShowIds = new Set(Object.keys(state.starredShows).filter(k => state.starredShows[k]));
      eps = eps.filter(e => state.starredEpisodes[e.id] || starredShowIds.has(e.showId))
        .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    }

    if (!eps.length) {
      const copy = state.view === 'stream' && !state.subscriptions.length
        ? ['No podcasts yet','Add a podcast RSS feed and its latest episodes will appear here.','rss']
        : state.view === 'progress'
        ? ['Nothing in progress','Episodes you start will appear here until you finish them.','circle-play']
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
      els.content.innerHTML = emptyMarkup('No subscriptions','Add a podcast using its RSS feed URL.','rss');
      return;
    }
    els.content.innerHTML = `<div class="subscription-grid">${state.subscriptions.map(s => `<article class="subscription">
      ${coverMarkup(s.image, s.title)}
      <div><div class="subscription-title">${esc(s.title)}</div><div class="subscription-meta">${s.episodeCount || 0} episodes loaded</div></div>
      <button class="icon-button star-show ${state.starredShows[s.id] ? 'active':''}" data-star-show="${escAttr(s.id)}" aria-label="Star podcast"><i data-lucide="star"></i></button>
    </article>`).join('')}</div>`;
    els.content.querySelectorAll('[data-star-show]').forEach(el => el.addEventListener('click', () => toggleStarShow(el.dataset.starShow)));
  }

  function emptyMarkup(title, body, icon) {
    return `<div class="empty"><div class="empty-inner"><div class="empty-icon"><i data-lucide="${icon}"></i></div><h3>${title}</h3><p>${body}</p></div></div>`;
  }

  async function handleAddPodcast(ev) {
    ev.preventDefault();
    const url = els.feedUrlInput.value.trim();
    if (!url) return;
    els.feedError.classList.add('hidden');
    try {
      const feed = await fetchFeed(url);
      upsertFeed(feed, url);
      await syncSubscriptionToRemote(url, feed);
      els.addPodcastDialog.close();
      setView('stream');
      toast('Podcast added');
    } catch (err) {
      console.error(err);
      els.feedError.textContent = err.message || 'Could not read that feed.';
      els.feedError.classList.remove('hidden');
    }
  }

  async function fetchFeed(url) {
    const settings = getSettings();
    if (settings.url && settings.key) {
      const endpoint = `${settings.url.replace(/\/$/,'')}/functions/v1/fetch-feed?url=${encodeURIComponent(url)}`;
      const res = await fetch(endpoint, { headers: { apikey: settings.key, Authorization: `Bearer ${settings.key}` } });
      if (!res.ok) throw new Error(`Feed request failed (${res.status}). Deploy the included fetch-feed Edge Function.`);
      return res.json();
    }
    throw new Error('Connect Supabase first so Podstream can fetch RSS feeds without browser CORS restrictions.');
  }

  function upsertFeed(feed, feedUrl) {
    const showId = feed.id || hash(feedUrl);
    const sub = {
      id: showId,
      feedUrl,
      title: feed.title || 'Untitled podcast',
      image: feed.image || '',
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
      // A Web Audio graph cannot safely be reused with a later stream that lacks CORS.
      // Recreate the media element between episodes so ordinary playback always has a clean fallback.
      resetAudioPipeline();
      state.currentEpisodeId = id;
      els.audio.src = ep.audioUrl;
      els.audio.load();
      renderPlayer();
    }
    if (state.enhanceVoices) {
      const ok = await streamSupportsEnhancement(ep.audioUrl);
      if (ok) await ensureAudioGraph();
      else {
        state.enhanceVoices = false;
        saveLocal();
        renderPlayer();
        toast('Enhance Voices is unavailable for this stream; normal playback will continue.');
      }
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
      const ok = await streamSupportsEnhancement(ep.audioUrl);
      if (!ok) return toast('This podcast host does not allow browser voice enhancement. Normal playback is unaffected.');
      state.enhanceVoices = true;
      saveLocal();
      await ensureAudioGraph();
      applyEnhanceState();
    } else {
      state.enhanceVoices = false;
      saveLocal();
      applyEnhanceState();
    }
    renderPlayer();
  }

  async function ensureAudioGraph() {
    if (audioCtx) { if (audioCtx.state === 'suspended') await audioCtx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = new Ctx();
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
    if (!highPass || !presence || !compressor) return;
    if (state.enhanceVoices) {
      highPass.frequency.value = 85; presence.gain.value = 3.5; compressor.threshold.value = -26; compressor.ratio.value = 3;
    } else {
      highPass.frequency.value = 20; presence.gain.value = 0; compressor.threshold.value = 0; compressor.ratio.value = 1;
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

  function openSettings() {
    const s = getSettings();
    els.supabaseUrlInput.value = s.url || '';
    els.supabaseKeyInput.value = s.key || '';
    els.emailInput.value = s.email || '';
    els.authStatus.textContent = state.user ? `Signed in as ${state.user.email}` : 'Not signed in.';
    els.settingsDialog.showModal();
  }

  function getSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }

  async function saveSettingsAndSignIn() {
    const settings = { url: els.supabaseUrlInput.value.trim(), key: els.supabaseKeyInput.value.trim(), email: els.emailInput.value.trim() };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    await initSupabaseFromSettings();
    if (!state.supabase || !settings.email) { els.authStatus.textContent = 'Saved locally. Add an email to sign in.'; return; }
    els.authStatus.textContent = 'Sending magic link…';
    const { error } = await state.supabase.auth.signInWithOtp({ email: settings.email, options: { emailRedirectTo: location.href.split('#')[0] } });
    els.authStatus.textContent = error ? error.message : 'Magic link sent. Open it on this device to finish signing in.';
  }

  async function initSupabaseFromSettings() {
    const s = getSettings();
    if (!s.url || !s.key || !window.supabase?.createClient) return;
    try {
      state.supabase = window.supabase.createClient(s.url, s.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      const { data } = await state.supabase.auth.getSession();
      state.user = data.session?.user || null;
      state.remoteReady = !!state.user;
      state.supabase.auth.onAuthStateChange(async (_event, session) => {
        state.user = session?.user || null; state.remoteReady = !!state.user;
        if (state.remoteReady) await hydrateRemote();
      });
    } catch (e) { console.warn(e); }
  }

  async function signOut() {
    if (state.supabase) await state.supabase.auth.signOut();
    state.user = null; state.remoteReady = false;
    els.authStatus.textContent = 'Signed out.';
  }

  async function hydrateRemote() {
    if (!state.remoteReady) return;
    try {
      const [{ data: subs }, { data: plays }, { data: stars }] = await Promise.all([
        state.supabase.from('subscriptions').select('*').order('created_at'),
        state.supabase.from('playback_positions').select('*'),
        state.supabase.from('stars').select('*'),
      ]);
      if (subs?.length) {
        for (const s of subs) {
          if (!state.subscriptions.find(x => x.feedUrl === s.feed_url)) {
            try { const feed = await fetchFeed(s.feed_url); upsertFeed(feed, s.feed_url); } catch (e) { console.warn(e); }
          }
        }
      }
      for (const p of plays || []) state.playback[p.episode_id] = { position:Number(p.position_seconds)||0, duration:Number(p.duration_seconds)||0, completed:!!p.completed, updatedAt:new Date(p.updated_at).getTime() };
      for (const st of stars || []) {
        if (st.item_type === 'episode') state.starredEpisodes[st.item_id] = true;
        if (st.item_type === 'show') state.starredShows[st.item_id] = true;
      }
      saveLocal(); render();
    } catch (e) { console.warn('Remote hydration failed', e); }
  }

  async function syncSubscriptionToRemote(feedUrl, feed) {
    if (!state.remoteReady) return;
    await state.supabase.from('subscriptions').upsert({ user_id: state.user.id, feed_url: feedUrl, title: feed.title || null, image_url: feed.image || null }, { onConflict: 'user_id,feed_url' });
  }

  async function syncPlaybackToRemote(id) {
    if (!state.remoteReady || !id) return;
    const p = state.playback[id]; if (!p) return;
    await state.supabase.from('playback_positions').upsert({ user_id: state.user.id, episode_id:id, position_seconds:p.position, duration_seconds:p.duration, completed:p.completed, updated_at:new Date().toISOString() }, { onConflict:'user_id,episode_id' });
  }

  async function syncEpisodeStarToRemote(id) { await syncStar('episode', id, !!state.starredEpisodes[id]); }
  async function syncShowStarToRemote(id) { await syncStar('show', id, !!state.starredShows[id]); }
  async function syncStar(type,id,on) {
    if (!state.remoteReady) return;
    if (on) await state.supabase.from('stars').upsert({ user_id:state.user.id, item_type:type, item_id:id }, { onConflict:'user_id,item_type,item_id' });
    else await state.supabase.from('stars').delete().eq('user_id',state.user.id).eq('item_type',type).eq('item_id',id);
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
