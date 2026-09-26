(() => {
  if (globalThis.__syncVideoBridge) return;
  const ids = new WeakMap();
  const videos = new Map();
  let sequence = 0;

  function collect(root = document) {
    const found = [...root.querySelectorAll('video')];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) found.push(...collect(el.shadowRoot));
    return found;
  }

  function read(video, id) {
    const rect = video.getBoundingClientRect();
    return {
      id, time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused, ended: video.ended, ready: video.readyState,
      seeking: video.seeking, rate: video.playbackRate,
      ranges: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]),
      area: rect.width * rect.height, source: video.currentSrc,
      ad: !!document.querySelector('.html5-video-player.ad-showing'),
      title: video.getAttribute('aria-label') || video.title || document.title,
      sampledAt: Date.now()
    };
  }

  globalThis.__syncVideoBridge = {
    list() {
      videos.clear();
      return collect().map(video => {
        if (!ids.has(video)) ids.set(video, `v${++sequence}`);
        const id = ids.get(video);
        videos.set(id, video);
        return read(video, id);
      }).sort((a, b) => b.area - a.area);
    },
    async run(id, operation, value) {
      const video = videos.get(id);
      if (!video?.isConnected) throw new Error('O player mudou. Conecte esta aba novamente.');
      if (operation === 'snapshot') return read(video, id);
      if (operation === 'pause') video.pause();
      else if (operation === 'play') {
        try { await video.play(); }
        catch { throw new Error('Clique em reproduzir no próprio vídeo para liberar a reprodução.'); }
      } else if (operation === 'seek') {
        const state = read(video, id);
        if (!Number.isFinite(value) || !state.ranges.some(([a, b]) => value >= a && value <= b - 0.08)) {
          throw new Error('O player não disponibiliza esse trecho. Talvez a live não permita voltar.');
        }
        video.currentTime = value;
      } else throw new Error('Comando desconhecido.');
      return read(video, id);
    }
  };
})();
