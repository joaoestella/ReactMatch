// Injected into the top frame of the main video's tab. Shows a picture-in-
// picture of part of another tab (the creator's cam) over the main video,
// with that tab's sound mixed in at its own volume.
//
// The other tab arrives as a tab-capture stream (chrome.tabCapture), so it
// keeps playing even when its tab is in the background. Its sound stops
// playing there and plays here instead, through a gain we control.
(() => {
  if (globalThis.__syncVideoPip) return;
  const MARGIN = 0.025;
  let pip = null;

  // Where the main video is on screen: the <video> itself when it is in this
  // frame, or the iframe that holds it (plus its rect inside that iframe).
  function targetRect(target) {
    if (target.frameOrigin) {
      const frames = [...document.querySelectorAll('iframe')].filter(frame => {
        try { return new URL(frame.src, location.href).origin === target.frameOrigin; } catch { return false; }
      });
      const frame = frames.sort((a, b) => area(b.getBoundingClientRect()) - area(a.getBoundingClientRect()))[0];
      if (!frame) return null;
      const outer = frame.getBoundingClientRect(), inner = target.innerRect;
      return inner ? { x: outer.x + inner.x, y: outer.y + inner.y, width: inner.width, height: inner.height } : outer;
    }
    const video = globalThis.__syncVideoBridge?.element(target.videoId);
    return video?.isConnected ? video.getBoundingClientRect() : null;
  }
  const area = rect => rect.width * rect.height;

  function build() {
    // A popover sits in the top layer, so it stays above a fullscreen player.
    const host = document.createElement('div');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial;position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647';
    const shadow = host.attachShadow({ mode: 'closed' });
    // Built without innerHTML: some sites (YouTube) only accept "trusted" HTML.
    const style = document.createElement('style');
    style.textContent = '.box{position:fixed;border-radius:10px;overflow:hidden;box-shadow:0 6px 24px #0009;outline:2px solid #ffffff30;cursor:grab;touch-action:none;background:#000}'
      + '.box:active{cursor:grabbing}canvas{display:block;width:100%;height:100%}';
    const box = document.createElement('div');
    box.className = 'box';
    const canvas = document.createElement('canvas');
    box.append(canvas);
    shadow.append(style, box);
    document.documentElement.append(host);
    return { host, box, canvas };
  }

  function show(host) {
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch { /* Older Chrome: plain fixed element. */ }
  }

  function place() {
    if (!pip) return;
    const rect = targetRect(pip.target);
    const { box } = pip.ui;
    if (!rect || rect.width < 50) { box.style.display = 'none'; return; }
    box.style.display = '';
    const { sw, sh } = pip.video.videoWidth ? source() : { sw: 16, sh: 9 };
    const aspect = sw && sh ? sw / sh : 16 / 9;
    const width = rect.width * pip.size;
    const height = width / aspect;
    let left, top;
    if (pip.corner === 'custom') {
      left = rect.x + pip.free.x * rect.width; top = rect.y + pip.free.y * rect.height;
    } else {
      const m = rect.width * MARGIN;
      left = pip.corner.includes('left') ? rect.x + m : rect.x + rect.width - width - m;
      top = pip.corner.includes('top') ? rect.y + m : rect.y + rect.height - height - m;
    }
    left = Math.min(Math.max(left, rect.x), rect.x + rect.width - width);
    top = Math.min(Math.max(top, rect.y), rect.y + rect.height - height);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    const dpr = devicePixelRatio || 1;
    if (pip.ui.canvas.width !== Math.round(width * dpr)) { pip.ui.canvas.width = Math.round(width * dpr); pip.ui.canvas.height = Math.round(height * dpr); }
  }

  // The crop is in 0..1 of the other tab's page. Chrome fits that page into
  // the capture frame and adds black bars when their shapes differ.
  function source() {
    const { video, crop, tabAspect } = pip;
    const W = video.videoWidth, H = video.videoHeight;
    let x = 0, y = 0, w = W, h = H;
    if (tabAspect) {
      if (W / H > tabAspect) { w = H * tabAspect; x = (W - w) / 2; } else { h = W / tabAspect; y = (H - h) / 2; }
    }
    return { sx: x + crop.x * w, sy: y + crop.y * h, sw: crop.w * w, sh: crop.h * h };
  }

  function draw() {
    if (!pip) return;
    const { video } = pip, canvas = pip.ui.canvas;
    if (video.videoWidth && canvas.width) {
      const { sx, sy, sw, sh } = source();
      canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    }
    pip.frame = requestAnimationFrame(draw);
  }

  // Dragging the box frees it from the corners; it then keeps its place
  // relative to the video (also in fullscreen).
  function draggable() {
    const { box } = pip.ui;
    let start = null;
    box.addEventListener('pointerdown', event => {
      const r = box.getBoundingClientRect();
      start = { x: event.clientX - r.left, y: event.clientY - r.top };
      box.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    box.addEventListener('pointermove', event => {
      if (!start || !pip) return;
      const rect = targetRect(pip.target);
      if (!rect) return;
      pip.corner = 'custom';
      pip.free = { x: (event.clientX - start.x - rect.x) / rect.width, y: (event.clientY - start.y - rect.y) / rect.height };
      place();
    });
    const end = () => { start = null; };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  }

  function set(options) {
    if (!pip) return;
    if (options.crop) pip.crop = options.crop;
    if (options.tabAspect) pip.tabAspect = options.tabAspect;
    if (options.corner) pip.corner = options.corner;
    if (Number.isFinite(options.size)) pip.size = options.size;
    if (options.target) pip.target = options.target;
    if (Number.isFinite(options.volume)) pip.gain.gain.value = options.volume;
    place();
  }

  // A capture size with the other tab's shape, so Chrome doesn't add bars.
  function frameSize(aspect = 16 / 9) {
    let width = 1920, height = Math.round(1920 / aspect);
    if (height > 1440) { height = 1440; width = Math.round(1440 * aspect); }
    width -= width % 2; height -= height % 2;
    return { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height };
  }

  function stop() {
    if (!pip) return;
    cancelAnimationFrame(pip.frame);
    clearInterval(pip.timer);
    document.removeEventListener('fullscreenchange', pip.onFullscreen);
    pip.stream.getTracks().forEach(track => track.stop());
    pip.audio.close().catch(() => {});
    pip.ui.host.remove();
    pip = null;
  }

  globalThis.__syncVideoPip = {
    async start(streamId, options) {
      stop();
      const constraint = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: constraint,
          video: { mandatory: { ...constraint.mandatory, ...frameSize(options.tabAspect), maxFrameRate: 30 } }
        });
      } catch (error) { throw new Error(`capture-failed: ${error.message || error.name}`); }
      const video = document.createElement('video');
      video.muted = true; video.srcObject = stream;
      await video.play().catch(() => {});
      // The captured tab goes quiet; its sound plays here, at our volume.
      const audio = new AudioContext();
      const gain = audio.createGain();
      audio.createMediaStreamSource(stream).connect(gain).connect(audio.destination);
      audio.resume().catch(() => {});
      const ui = build();
      pip = { stream, video, audio, gain, ui, crop: { x: 0, y: 0, w: 1, h: 1 }, corner: 'bottom-right', size: 0.28, free: { x: 0.7, y: 0.7 }, target: options.target };
      set(options);
      show(ui.host);
      draggable();
      pip.onFullscreen = () => { setTimeout(() => { if (pip) { show(pip.ui.host); place(); } }, 50); };
      document.addEventListener('fullscreenchange', pip.onFullscreen);
      pip.timer = setInterval(place, 250);
      stream.getVideoTracks()[0].addEventListener('ended', stop);
      draw();
      return true;
    },
    set,
    stop,
    active: () => !!pip && pip.stream.getVideoTracks()[0]?.readyState === 'live',
    // What is on screen, for checks: the box and its average colour.
    stats() {
      if (!pip) return null;
      const { canvas, box } = pip.ui;
      const r = box.getBoundingClientRect();
      const mean = [0, 0, 0];
      if (canvas.width) {
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4) { mean[0] += d[i]; mean[1] += d[i + 1]; mean[2] += d[i + 2]; }
        for (let c = 0; c < 3; c++) mean[c] = Math.round(mean[c] / (d.length / 4));
      }
      return { box: { x: r.x, y: r.y, width: r.width, height: r.height }, colour: mean, volume: pip.gain.gain.value, corner: pip.corner, capture: [pip.video.videoWidth, pip.video.videoHeight], crop: pip.crop };
    }
  };
})();
