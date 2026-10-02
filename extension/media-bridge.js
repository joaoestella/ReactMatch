// Injected into every frame of a connected tab. Lists the <video> elements of
// that frame, reads and controls them, and grabs still frames straight from
// the player so the clock can be read without capturing the whole screen.
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

  // Origins of child frames, so the panel can ask for access to an embedded
  // player that lives on another site.
  function childOrigins() {
    const origins = new Set();
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        const url = new URL(frame.src, location.href);
        if (/^https?:$/.test(url.protocol) && url.origin !== location.origin) origins.add(url.origin);
      } catch { /* about:blank, srcdoc… */ }
    }
    return [...origins];
  }

  function read(video, id) {
    const rect = video.getBoundingClientRect();
    return {
      id, time: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
      paused: video.paused, ended: video.ended, ready: video.readyState,
      seeking: video.seeking, rate: video.playbackRate,
      ranges: Array.from({ length: video.seekable.length }, (_, i) => [video.seekable.start(i), video.seekable.end(i)]),
      area: rect.width * rect.height, width: video.videoWidth, height: video.videoHeight,
      source: video.currentSrc || (video.srcObject ? 'stream' : ''),
      ad: !!document.querySelector('.html5-video-player.ad-showing'),
      title: video.getAttribute('aria-label') || video.title || document.title,
      sampledAt: Date.now()
    };
  }

  // Draws the current frame (or a region of it, in 0..1 coordinates) and
  // returns it as a data URL. Players that use DRM draw black, and videos
  // served from another site without CORS can't be read back at all; both
  // cases are reported so the panel can fall back to a tab capture.
  function grab(video, { region = null, maxWidth = 1920, minHeight = 0, type = 'image/jpeg' } = {}) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return { error: 'not-ready' };
    const r = region || { x: 0, y: 0, w: 1, h: 1 };
    const sw = Math.max(1, Math.round(r.w * vw)), sh = Math.max(1, Math.round(r.h * vh));
    let scale = Math.min(1, maxWidth / sw);
    if (minHeight && sh * scale < minHeight) scale = Math.min(4, minHeight / sh);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const time = video.currentTime;
    ctx.drawImage(video, r.x * vw, r.y * vh, sw, sh, 0, 0, canvas.width, canvas.height);
    let pixels;
    try { pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data; }
    catch { return { error: 'protected' }; }
    // A frame with no variation at all is what DRM players hand back.
    let min = 765, max = 0;
    const step = Math.max(4, Math.floor(pixels.length / 4 / 4000) * 4);
    for (let i = 0; i < pixels.length; i += step) {
      const v = pixels[i] + pixels[i + 1] + pixels[i + 2];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return {
      image: canvas.toDataURL(type, 0.92), width: canvas.width, height: canvas.height,
      blank: max - min < 6, time, paused: video.paused
    };
  }

  globalThis.__syncVideoBridge = {
    list() {
      videos.clear();
      const found = collect().map(video => {
        if (!ids.has(video)) ids.set(video, `v${++sequence}`);
        const id = ids.get(video);
        videos.set(id, video);
        return read(video, id);
      });
      return { videos: found, origin: location.origin, children: childOrigins() };
    },
    async run(id, operation, value) {
      const video = videos.get(id);
      if (!video?.isConnected) throw new Error('player-changed');
      if (operation === 'snapshot') return read(video, id);
      if (operation === 'grab') return grab(video, value || {});
      if (operation === 'pause') video.pause();
      else if (operation === 'play') {
        try { await video.play(); }
        catch { throw new Error('play-blocked'); }
      } else if (operation === 'seek') {
        const state = read(video, id);
        if (!Number.isFinite(value) || !state.ranges.some(([a, b]) => value >= a && value <= b - 0.08)) {
          throw new Error('not-seekable');
        }
        video.currentTime = value;
      } else throw new Error('unknown-command');
      return read(video, id);
    }
  };
})();
