// Finds where text could be on a video frame, so OCR only has to read small
// crops. Reading a whole frame in one go is unreliable on video: noise and
// textures confuse the page layout step and clocks get skipped.
//
// Text is a row of strong, closely packed vertical edges. We mark those
// edges, join the ones that are close on the same row (characters of one
// word or one scoreboard line), and keep the connected blobs shaped like a
// line of text.

export function textBoxes({ data, width, height }, { edge = 48, gap = 0, maxBoxes = 60 } = {}) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;

  // 1. Strong horizontal changes (the vertical strokes of characters).
  const marks = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      if (Math.abs(gray[row + x + 1] - gray[row + x - 1]) >= edge) marks[row + x] = 1;
    }
  }
  // 2. Join edges that are close on the same row: one blob per word/line.
  const join = gap || Math.max(6, Math.round(width / 160));
  const filled = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let last = -1;
    for (let x = 0; x < width; x++) {
      if (!marks[row + x]) continue;
      if (last >= 0 && x - last <= join) filled.fill(1, row + last, row + x + 1);
      else filled[row + x] = 1;
      last = x;
    }
  }
  // 3. Connected blobs (union-find over runs would be faster; this is fine for ~1-2 MP).
  const label = new Int32Array(width * height).fill(-1);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < filled.length; start++) {
    if (!filled[start] || label[start] >= 0) continue;
    const id = boxes.length;
    let x0 = width, y0 = height, x1 = 0, y1 = 0, count = 0, edges = 0;
    label[start] = id; stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const x = i % width, y = (i - x) / width;
      count++; edges += marks[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && filled[i - 1] && label[i - 1] < 0) { label[i - 1] = id; stack.push(i - 1); }
      if (x < width - 1 && filled[i + 1] && label[i + 1] < 0) { label[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && filled[i - width] && label[i - width] < 0) { label[i - width] = id; stack.push(i - width); }
      if (y < height - 1 && filled[i + width] && label[i + width] < 0) { label[i + width] = id; stack.push(i + width); }
    }
    boxes.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, count, edges });
  }
  // 4. Keep blobs shaped like a short line of text.
  const minH = Math.max(7, height / 120), maxH = height / 6;
  const kept = boxes.filter(b => {
    const w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (h < minH || h > maxH || w < h * 1.2 || w > h * 25) return false;
    const fill = b.count / (w * h), density = b.edges / b.count;
    return fill > 0.35 && density > 0.12 && density < 0.85;
  });
  // 5. Words on the same line, close together, become one line ("25" + ":10",
  //    "ARG" + "25:30"). OCR then reads the whole line and we look for clocks in it.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < kept.length && !merged; i++) {
      for (let j = i + 1; j < kept.length; j++) {
        const a = kept[i], b = kept[j];
        const ha = a.y1 - a.y0, hb = b.y1 - b.y0;
        const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
        if (overlap < 0.6 * Math.min(ha, hb) || Math.max(ha, hb) > 1.6 * Math.min(ha, hb) || gapX > 0.9 * Math.max(ha, hb)) continue;
        kept[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), count: a.count + b.count, edges: a.edges + b.edges };
        kept.splice(j, 1);
        merged = true;
        break;
      }
    }
  }
  // Bigger and denser first; a frame of grass or crowd makes many small blobs.
  kept.sort((a, b) => (b.y1 - b.y0) * Math.min(b.x1 - b.x0, 8 * (b.y1 - b.y0)) - (a.y1 - a.y0) * Math.min(a.x1 - a.x0, 8 * (a.y1 - a.y0)));
  return kept.slice(0, maxBoxes).map(b => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }));
}
