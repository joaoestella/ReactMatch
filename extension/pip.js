// Injected into the top frame of the main video's tab. Shows a picture-in-
// picture of part of another tab (the creator's cam) over the main video,
// with that tab's sound mixed in at its own volume, and a small menu on the
// cam for the things you change while watching (sync again, volumes, corner,
// size), so the panel can stay out of the way.
//
// The other tab arrives as a tab-capture stream (chrome.tabCapture), so it
// keeps playing even when its tab is in the background. Its sound stops
// playing there and plays here instead, through a gain we control.
(() => {
  if (globalThis.__reactMatchPip) return;
  const MARGIN = 0.025;
  const SVG = 'http://www.w3.org/2000/svg';
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
    const video = globalThis.__reactMatchBridge?.element(target.videoId);
    return video?.isConnected ? video.getBoundingClientRect() : null;
  }
  const area = rect => rect.width * rect.height;

  // ---- Building the UI (no innerHTML: some sites only accept "trusted" HTML) ----

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  // Line icons on a 24×24 grid; "*" paths are filled.
  const ICONS = {
    menu: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    resync: ['M20 11a8 8 0 1 0-2.4 5.7', 'M20 4v7h-7'],
    game: ['M3 5h18v12H3z', 'M8 21h8', 'M12 17v4'],
    react: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    size: ['M4 14v6h6', 'M20 10V4h-6', 'M4 20l7-7', 'M20 4l-7 7'],
    'top-left': ['M4 4h16v16H4z', '*M6 6h5v4H6z'],
    'top-right': ['M4 4h16v16H4z', '*M13 6h5v4h-5z'],
    'bottom-left': ['M4 4h16v16H4z', '*M6 14h5v4H6z'],
    'bottom-right': ['M4 4h16v16H4z', '*M13 14h5v4h-5z']
  };
  function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG, 'path');
      // A leading "*" marks a filled shape.
      path.setAttribute('d', d.replace(/^\*/, ''));
      if (d.startsWith('*')) path.setAttribute('class', 'fill');
      svg.append(path);
    }
    return svg;
  }

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:Inter,"Segoe UI",system-ui,sans-serif}
    svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}
    svg .fill{fill:currentColor;stroke:none}
    .box{position:fixed;border-radius:10px;overflow:hidden;box-shadow:0 6px 24px #0009;outline:2px solid #ffffff30;cursor:grab;touch-action:none;background:#000}
    .box:active{cursor:grabbing}
    canvas{display:block;width:100%;height:100%}
    .open{position:absolute;top:6px;right:6px;width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:#0b1019cc;color:#edf2fa;cursor:pointer;opacity:.55;transition:opacity .15s}
    .box:hover .open,.open[aria-expanded=true]{opacity:1}
    .menu{position:fixed;width:250px;padding:10px;border-radius:12px;background:#0b1019f2;color:#edf2fa;border:1px solid #273144;box-shadow:0 10px 30px #000a;font-size:12px;display:flex;flex-direction:column;gap:9px}
    .menu[hidden]{display:none}
    .status{display:flex;gap:8px;align-items:flex-start;color:#c4d1e3;line-height:1.35}
    .dot{width:8px;height:8px;border-radius:50%;margin-top:4px;flex:none;background:#5b6678}
    .dot.active{background:#b7f4ce}.dot.warning{background:#f3d991}.dot.error{background:#ffb59b}
    button.action{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border-radius:8px;border:1px solid #b7f4ce55;background:#b7f4ce14;color:#b7f4ce;font-size:12px;font-weight:600;cursor:pointer}
    button.action.quiet{border-color:#273144;background:transparent;color:#c4d1e3}
    button.action[hidden]{display:none}
    button.action:hover{filter:brightness(1.2)}
    .row{display:flex;align-items:center;gap:8px}
    .row input[type=range]{flex:1;min-width:0;accent-color:#b7f4ce}
    .row output{width:34px;text-align:right;color:#9baabd;font-variant-numeric:tabular-nums}
    .corners{display:flex;gap:6px;flex:1;justify-content:flex-end}
    .corners button{width:30px;height:28px;display:grid;place-items:center;border:1px solid #273144;border-radius:7px;background:#121a27;color:#9baabd;cursor:pointer}
    .corners button[aria-pressed=true]{border-color:#b7f4ce;color:#b7f4ce}
    .label{flex:1;color:#9baabd}
  `;

  function build(labels) {
    // A popover sits in the top layer, so it stays above a fullscreen player.
    const host = document.createElement('div');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial;position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;z-index:2147483647';
    // Keep our clicks and keys from reaching the page (no pausing, no seeking).
    for (const type of ['keydown', 'keyup', 'click', 'dblclick', 'pointerdown', 'mousedown', 'wheel']) host.addEventListener(type, event => event.stopPropagation());
    const shadow = host.attachShadow({ mode: 'closed' });
    const canvas = el('canvas');
    const open = el('button', { class: 'open', type: 'button', title: labels.menu, 'aria-label': labels.menu, 'aria-expanded': 'false' }, [icon('menu')]);
    const box = el('div', { class: 'box' }, [canvas, open]);

    const dot = el('span', { class: 'dot' });
    // Shown when the clocks moved apart and the viewer may want to follow them.
    const clockChoice = el('button', { class: 'action quiet', type: 'button', 'data-action': 'accept-clock', hidden: '' });
    const statusText = el('span');
    const range = (name, min, max) => el('input', { type: 'range', min, max, 'aria-label': labels[name], 'data-name': name });
    const gameRange = range('game', 0, 100), reactRange = range('react', 0, 100), sizeRange = range('size', 12, 50);
    const gameOut = el('output'), reactOut = el('output'), sizeOut = el('output');
    const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
      .map(corner => el('button', { type: 'button', 'data-corner': corner, title: labels[corner], 'aria-label': labels[corner] }, [icon(corner)]));
    const menu = el('div', { class: 'menu', role: 'dialog', 'aria-label': labels.menu, hidden: '' }, [
      el('div', { class: 'status' }, [dot, statusText]),
      el('button', { class: 'action', type: 'button', 'data-action': 'resync' }, [icon('resync'), labels.resync]),
      clockChoice,
      el('div', { class: 'row', title: labels.game }, [icon('game'), gameRange, gameOut]),
      el('div', { class: 'row', title: labels.react }, [icon('react'), reactRange, reactOut]),
      el('div', { class: 'row' }, [el('span', { class: 'label' }, [labels.position]), el('div', { class: 'corners' }, corners)]),
      el('div', { class: 'row', title: labels.size }, [icon('size'), sizeRange, sizeOut]),
      el('button', { class: 'action quiet', type: 'button', 'data-action': 'close' }, [icon('close'), labels.close])
    ]);
    shadow.append(el('style', {}, [CSS]), box, menu);
    document.documentElement.append(host);
    return { host, box, canvas, open, menu, dot, statusText, clockChoice, gameRange, reactRange, sizeRange, gameOut, reactOut, sizeOut, corners };
  }

  function show(host) {
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch { /* Older Chrome: plain fixed element. */ }
  }

  // Tells the panel what the viewer did here; it keeps both in step.
  function tell(action, value) {
    try { chrome.runtime.sendMessage({ type: 'reactmatch-pip', action, value }).catch(() => {}); } catch { /* Extension reloaded. */ }
  }

  // ---- Placement and drawing --------------------------------------------------

  function place() {
    if (!pip) return;
    const rect = targetRect(pip.target);
    const { box } = pip.ui;
    if (!rect || rect.width < 50) { box.style.display = 'none'; pip.ui.menu.hidden = true; return; }
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
    placeMenu({ left, top, width, height });
  }

  // The menu opens below the cam when there's room, otherwise above it.
  function placeMenu(b) {
    const { menu } = pip.ui;
    if (menu.hidden) return;
    const w = menu.offsetWidth || 250, h = menu.offsetHeight || 260, gap = 8;
    const left = Math.min(Math.max(8, b.left + b.width - w), innerWidth - w - 8);
    const below = b.top + b.height + gap;
    const top = below + h < innerHeight - 8 ? below : Math.max(8, b.top - h - gap);
    Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
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

  // ---- Interaction ------------------------------------------------------------

  // Dragging the box frees it from the corners; it then keeps its place
  // relative to the video (also in fullscreen).
  function wire() {
    const ui = pip.ui;
    let start = null;
    ui.box.addEventListener('pointerdown', event => {
      if (event.target.closest?.('.open')) return;
      const r = ui.box.getBoundingClientRect();
      start = { x: event.clientX - r.left, y: event.clientY - r.top };
      ui.box.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    ui.box.addEventListener('pointermove', event => {
      if (!start || !pip) return;
      const rect = targetRect(pip.target);
      if (!rect) return;
      pip.corner = 'custom';
      pip.free = { x: (event.clientX - start.x - rect.x) / rect.width, y: (event.clientY - start.y - rect.y) / rect.height };
      renderControls();
      place();
    });
    const end = () => { if (start && pip?.corner === 'custom') tell('position', pip.free); start = null; };
    ui.box.addEventListener('pointerup', end);
    ui.box.addEventListener('pointercancel', end);

    ui.open.addEventListener('click', () => toggleMenu());
    ui.host.addEventListener('keydown', event => { if (event.key === 'Escape') toggleMenu(false); });
    ui.menu.addEventListener('click', event => {
      const action = event.target.closest?.('[data-action]')?.dataset.action;
      if (action === 'resync') tell('resync');
      if (action === 'accept-clock') tell('accept-clock');
      if (action === 'close') tell('close');
      const corner = event.target.closest?.('[data-corner]')?.dataset.corner;
      if (corner) { pip.corner = corner; renderControls(); place(); tell('corner', corner); }
    });
    ui.gameRange.addEventListener('input', () => { pip.volumes.main = ui.gameRange.value / 100; renderControls(); tell('volume-main', pip.volumes.main); });
    ui.reactRange.addEventListener('input', () => {
      pip.volumes.react = ui.reactRange.value / 100;
      pip.gain.gain.value = pip.volumes.react;
      renderControls(); tell('volume-react', pip.volumes.react);
    });
    ui.sizeRange.addEventListener('input', () => { pip.size = ui.sizeRange.value / 100; renderControls(); place(); tell('size', pip.size); });
  }

  function toggleMenu(force) {
    const { menu, open } = pip.ui;
    menu.hidden = force === undefined ? !menu.hidden : !force;
    open.setAttribute('aria-expanded', String(!menu.hidden));
    place();
  }

  function renderControls() {
    const ui = pip.ui;
    ui.gameRange.value = Math.round(pip.volumes.main * 100); ui.gameOut.textContent = `${ui.gameRange.value}%`;
    ui.reactRange.value = Math.round(pip.volumes.react * 100); ui.reactOut.textContent = `${ui.reactRange.value}%`;
    ui.sizeRange.value = Math.round(pip.size * 100); ui.sizeOut.textContent = `${ui.sizeRange.value}%`;
    for (const button of ui.corners) button.setAttribute('aria-pressed', String(button.dataset.corner === pip.corner));
    ui.statusText.textContent = pip.status.text || '';
    ui.dot.className = `dot ${pip.status.type || ''}`;
  }

  function set(options) {
    if (!pip) return;
    if (options.crop) pip.crop = options.crop;
    if (options.tabAspect) pip.tabAspect = options.tabAspect;
    if (options.corner) pip.corner = options.corner;
    if (options.free) pip.free = options.free;
    if (Number.isFinite(options.size)) pip.size = options.size;
    if (options.target) pip.target = options.target;
    if (Number.isFinite(options.volume)) { pip.volumes.react = options.volume; pip.gain.gain.value = options.volume; }
    if (Number.isFinite(options.mainVolume)) pip.volumes.main = options.mainVolume;
    if (options.status) pip.status = options.status;
    if ('action' in options) {
      pip.ui.clockChoice.hidden = !options.action;
      pip.ui.clockChoice.textContent = options.action || '';
    }
    renderControls();
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

  globalThis.__reactMatchPip = {
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
      const ui = build(options.labels || {});
      pip = {
        stream, video, audio, gain, ui, crop: { x: 0, y: 0, w: 1, h: 1 }, corner: 'bottom-right', size: 0.28,
        free: { x: 0.7, y: 0.7 }, target: options.target, volumes: { main: 1, react: 1 }, status: {}
      };
      set(options);
      show(ui.host);
      wire();
      pip.onFullscreen = () => { setTimeout(() => { if (pip) { show(pip.ui.host); place(); } }, 50); };
      document.addEventListener('fullscreenchange', pip.onFullscreen);
      pip.timer = setInterval(place, 250);
      stream.getVideoTracks()[0].addEventListener('ended', () => { stop(); tell('ended'); });
      draw();
      return true;
    },
    set,
    stop,
    menu: open => pip && toggleMenu(open),
    active: () => !!pip && pip.stream.getVideoTracks()[0]?.readyState === 'live',
    // What is on screen, for checks: the box, its average colour, the menu.
    stats() {
      if (!pip) return null;
      const { canvas, box, menu } = pip.ui;
      const r = box.getBoundingClientRect(), m = menu.getBoundingClientRect();
      const mean = [0, 0, 0];
      if (canvas.width) {
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < d.length; i += 4) { mean[0] += d[i]; mean[1] += d[i + 1]; mean[2] += d[i + 2]; }
        for (let c = 0; c < 3; c++) mean[c] = Math.round(mean[c] / (d.length / 4));
      }
      return {
        box: { x: r.x, y: r.y, width: r.width, height: r.height }, colour: mean, volume: pip.gain.gain.value, corner: pip.corner,
        size: pip.size, menu: menu.hidden ? null : { x: m.x, y: m.y, width: m.width, height: m.height }, status: pip.status.text
      };
    },
    // For tests: press a menu control as a viewer would.
    press(what, value) {
      if (!pip) return;
      const ui = pip.ui;
      if (what === 'open') ui.open.click();
      else if (what === 'resync' || what === 'close') ui.menu.querySelector(`[data-action="${what}"]`).click();
      else if (what === 'corner') ui.menu.querySelector(`[data-corner="${value}"]`).click();
      else if (['game', 'react', 'size'].includes(what)) {
        const range = { game: ui.gameRange, react: ui.reactRange, size: ui.sizeRange }[what];
        range.value = value; range.dispatchEvent(new Event('input'));
      }
    }
  };
})();
