(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PodstreamAddMode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeMode(mode) {
    return mode === 'open' ? 'open' : 'subscribe';
  }

  function persistentEpisodes(episodes) {
    const out = {};
    for (const [id, episode] of Object.entries(episodes || {})) {
      if (!episode?.transient) out[id] = episode;
    }
    return out;
  }

  function retainEpisode(episode) {
    return episode ? { ...episode, transient: false } : episode;
  }

  return { normalizeMode, persistentEpisodes, retainEpisode };
});
