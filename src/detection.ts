import type { Region } from './types';
const neighbors = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
// Connected ink inside a detected bubble; outline-sized components are excluded.
export function inkBounds(rgba: Uint8ClampedArray, width: number, height: number, invert = false) {
  const mask = new Uint8Array(width * height), visited = new Uint8Array(mask.length);
  const lumas: number[] = [];
  for (let i = 0; i < mask.length; i += 13) lumas.push(rgba[i * 4] * .299 + rgba[i * 4 + 1] * .587 + rgba[i * 4 + 2] * .114);
  lumas.sort((a, b) => a - b); invert = (lumas[Math.floor(lumas.length / 2)] ?? 255) < 128;
  for (let i = 0; i < mask.length; i++) { const v = rgba[i * 4] * .299 + rgba[i * 4 + 1] * .587 + rgba[i * 4 + 2] * .114; mask[i] = +(invert ? v > 170 : v < 110); }
  let left = width, top = height, right = -1, bottom = -1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start]; visited[start] = 1;
    let x0 = width, y0 = height, x1 = -1, y1 = -1, count = 0, border = false;
    while (stack.length) {
      const p = stack.pop()!, x = p % width, y = Math.floor(p / width); count++;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) border = true;
      // Diagonal antialiased bubble contours must form one removable component.
      for (const [dx, dy] of neighbors) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx; if (mask[q] && !visited[q]) { visited[q] = 1; stack.push(q); }
      }
    }
    const cx = (x0+x1)/2, cy = (y0+y1)/2;
    const density = count / ((x1-x0+1)*(y1-y0+1));
    if (border || count < 3 || density < .12 || x1 - x0 > width * .65 || y1 - y0 > height * .65 || cx < width*.08 || cx > width*.92 || cy < height*.08 || cy > height*.92) continue;
    left = Math.min(left, x0); top = Math.min(top, y0); right = Math.max(right, x1); bottom = Math.max(bottom, y1);
  }
  return right < left ? null : { x: Math.max(0, left - 3), y: Math.max(0, top - 3), width: Math.min(width, right + 4) - Math.max(0, left - 3), height: Math.min(height, bottom + 4) - Math.max(0, top - 3) };
}
export function bubbleRegions(bitmap: ImageBitmap, raw: Region[]) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(bitmap, 0, 0);
  return raw.map(r => {
    const x = Math.floor(r.x), y = Math.floor(r.y), w = Math.max(1, Math.floor(r.width)), h = Math.max(1, Math.floor(r.height));
    const ink = inkBounds(ctx.getImageData(x, y, w, h).data, w, h);
    const ocrBox = { x, y, width: w, height: h };
    return ink ? { ...r, ocrBox, bubbleBox:ocrBox, x: x + ink.x, y: y + ink.y, width: ink.width, height: ink.height } : { ...r, ocrBox, bubbleBox:ocrBox, warnings: [...r.warnings, '氣泡內沒有明確文字，請檢查'] };
  });
}
