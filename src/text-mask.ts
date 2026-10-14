// Binary masks keep their white backing opaque; only pixels outside the mask
// retain the original image. These helpers do not reconstruct artwork.
export function fillMaskHoles(mask: Uint8Array, width: number, height: number) {
  const outside = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  const add = (p: number) => { if (!mask[p] && !outside[p]) { outside[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x++) { add(x); add((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { add(y * width); add(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % width, y = Math.floor(p / width);
    if (x) add(p - 1); if (x < width - 1) add(p + 1);
    if (y) add(p - width); if (y < height - 1) add(p + width);
  }
  return mask.map((v, i) => +(!!v || !outside[i]));
}
export function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
  const result = new Uint8Array(mask.length);
  radius = Math.max(0, Math.min(8, Math.ceil(radius)));
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const x = p % width, y = Math.floor(p / width);
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= height) continue;
      const dx = Math.floor(Math.sqrt(radius * radius - dy * dy));
      result.fill(1, yy * width + Math.max(0, x - dx), yy * width + Math.min(width, x + dx + 1));
    }
  }
  return result;
}
export function sourceInkMask(rgba: Uint8ClampedArray, width: number, height: number, anchor?: {textBounds:{x:number;y:number;width:number;height:number};interior?:Uint8Array}) {
  const luma = (p: number) => rgba[p * 4] * .299 + rgba[p * 4 + 1] * .587 + rgba[p * 4 + 2] * .114;
  const border: number[] = [];
  const step = Math.max(1, Math.floor((width + height) / 128));
  for (let x = 0; x < width; x += step) { border.push(luma(x), luma((height - 1) * width + x)); }
  for (let y = 0; y < height; y += step) { border.push(luma(y * width), luma(y * width + width - 1)); }
  border.sort((a, b) => a - b);
  const background = border[Math.floor(border.length / 2)] ?? 255, invert = background < 128;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    const v = luma(p);
    mask[p] = +(invert ? v > Math.max(155, background + 45) : v < Math.min(230, background - 30));
  }
  // Preserve long bubble/scenery contours crossing the crop boundary.
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0, tail = 1, x0 = width, x1 = 0, y0 = height, y1 = 0, border = false;
    queue[0] = start; visited[start] = 1;
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      border ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
        const q = yy * width + xx;
        if (mask[q] && !visited[q]) { visited[q] = 1; queue[tail++] = q; }
      }
    }
    const bounds=anchor?.textBounds;
    const anchored=!!bounds&&x0>=bounds.x-4&&y0>=bounds.y-4&&x1<bounds.x+bounds.width+4&&y1<bounds.y+bounds.height+4;
    let safeInterior=true;
    if(anchor?.interior){let admitted=0;for(let i=0;i<tail;i++)admitted+=anchor.interior[queue[i]];safeInterior=admitted/tail>.98;}
    if (anchor ? !(anchored&&safeInterior) : border && (x1 - x0 > width * .65 || y1 - y0 > height * .65)) {
      for (let i = 0; i < tail; i++) mask[queue[i]] = 0;
    }
  }
  return mask;
}
// Nearest unmasked colour propagation is a small CPU repair, suitable for
// paper/flat backgrounds. Text over detailed artwork still needs review.
export function repairTextBackground(source: Uint8ClampedArray, mask: Uint8Array, width: number, height: number) {
  const result = new Uint8ClampedArray(source), known = mask.map(v => +!v), queue = new Int32Array(mask.length);
  let head = 0, tail = 0;
  const neighbors = (p: number) => {
    const x = p % width, y = Math.floor(p / width), next: number[] = [];
    if (x) next.push(p - 1); if (x < width - 1) next.push(p + 1);
    if (y) next.push(p - width); if (y < height - 1) next.push(p + width);
    return next;
  };
  for (let p = 0; p < mask.length; p++) if (!mask[p] && neighbors(p).some(q => mask[q])) queue[tail++] = p;
  while (head < tail) {
    const p = queue[head++];
    for (const q of neighbors(p)) if (!known[q]) {
      known[q] = 1; for (let c = 0; c < 4; c++) result[q * 4 + c] = result[p * 4 + c]; queue[tail++] = q;
    }
  }
  return result;
}
export function glyphBackingMask(glyphs: Uint8ClampedArray, width: number, height: number, radius: number) {
  const letters = new Uint8Array(width * height);
  for (let p = 0; p < letters.length; p++) letters[p] = +(glyphs[p * 4 + 3] > 8);
  return fillMaskHoles(dilateMask(letters, width, height, radius), width, height);
}
