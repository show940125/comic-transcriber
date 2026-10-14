import type { Region } from './types';
import { dilateMask, fillMaskHoles, sourceInkMask, repairTextBackground, glyphBackingMask } from './text-mask';
export function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = []; let line = '';
  for (const char of text) {
    if (char === '\n') { lines.push(line); line = ''; continue; }
    if (line && ctx.measureText(line + char).width > width) { lines.push(line); line = char; } else line += char;
  }
  if (line) lines.push(line); return lines;
}
export function canFill(ctx: CanvasRenderingContext2D, region: Region) {
  if (region.kind === 'free') return false;
  const { x, y, width, height } = region;
  const data = ctx.getImageData(Math.floor(x), Math.floor(y), Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
  let white = 0, total = 0;
  for (let yy = 0; yy < data.height; yy++) for (let xx = 0; xx < data.width; xx++) {
    if (xx > 2 && xx < data.width - 3 && yy > 2 && yy < data.height - 3) continue;
    const i = (yy * data.width + xx) * 4; total++;
    if (data.data[i] > 242 && data.data[i + 1] > 242 && data.data[i + 2] > 242) white++;
  }
  return total > 0 && white / total > .98;
}
export function renderPage(image: HTMLImageElement, regions: Region[], original = false): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(image, 0, 0);
  if (original) return canvas;
  for (const r of regions) {
    if (!r.translation.trim()) continue;
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.width, r.height); ctx.clip();
    const pad = Math.min(6, r.width / 10, r.height / 10), width = r.width - pad * 2, height = r.height - pad * 2;
    let size = Math.min(42, Math.floor(height * .7)), lines: string[] = [];
    while (size >= 6) { ctx.font = `${size}px "ComicTC", "Microsoft JhengHei", sans-serif`; lines = wrapText(ctx, r.translation, width); if (lines.length * size * 1.25 <= height) break; size--; }
    const lineHeight = size * 1.25, top = r.y + (r.height - lines.length * lineHeight) / 2;
    const x = Math.floor(r.x), y = Math.floor(r.y), w = Math.max(1, Math.ceil(r.x + r.width) - x), h = Math.max(1, Math.ceil(r.y + r.height) - y);
    const glyphs = document.createElement('canvas'); glyphs.width = w; glyphs.height = h;
    const text = glyphs.getContext('2d', { willReadFrequently: true })!;
    text.font = ctx.font; text.fillStyle = '#171717'; text.textAlign = 'center'; text.textBaseline = 'middle';
    for (let i = 0; i < lines.length; i++) text.fillText(lines[i], r.x - x + r.width / 2, top - y + (i + .5) * lineHeight, width);
    if (r.render === 'fill' || r.render === 'rectangle') {
      ctx.fillStyle = r.render === 'fill' ? '#ffffff' : 'rgba(255,255,255,.94)';
      ctx.fillRect(r.x, r.y, r.width, r.height);
    } else {
      // Read the original, not an earlier translated layer when boxes overlap.
      const source = document.createElement('canvas'); source.width = w; source.height = h;
      const sourceCtx = source.getContext('2d', { willReadFrequently: true })!;
      sourceCtx.drawImage(image, x, y, w, h, 0, 0, w, h);
      const sourcePixels = sourceCtx.getImageData(0, 0, w, h);
      const eraseMask = dilateMask(fillMaskHoles(sourceInkMask(sourcePixels.data, w, h), w, h), w, h, 2);
      const repaired = repairTextBackground(sourcePixels.data, eraseMask, w, h);
      const mask = glyphBackingMask(text.getImageData(0, 0, w, h).data, w, h, Math.max(2, Math.ceil(size * .09)));
      const backing = sourceCtx.createImageData(w, h);
      for (let p = 0; p < eraseMask.length; p++) if (eraseMask[p]) {
        for (let c = 0; c < 4; c++) backing.data[p * 4 + c] = repaired[p * 4 + c];
      }
      for (let p = 0; p < mask.length; p++) if (mask[p]) {
        backing.data[p * 4] = backing.data[p * 4 + 1] = backing.data[p * 4 + 2] = 255;
        backing.data[p * 4 + 3] = 255;
      }
      sourceCtx.putImageData(backing, 0, 0); ctx.drawImage(source, x, y);
    }
    ctx.drawImage(glyphs, x, y);
    ctx.restore();
  }
  return canvas;
}
let fontPromise:Promise<void>|undefined;
export function loadFont(throughBackground=false):Promise<void> {
  fontPromise??=loadFontOnce(throughBackground).catch(error=>{fontPromise=undefined;throw error;});return fontPromise;
}
async function loadFontOnce(throughBackground:boolean) {
  let source:string|ArrayBuffer=`url("${chrome.runtime.getURL('/fonts/NotoSansCJKtc-Regular.otf')}")`;
  if(throughBackground){const result=await chrome.runtime.sendMessage({channel:'comic-font'});if(!result?.ok)throw new Error(result?.error??'字型讀取失敗');const binary=atob(result.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));source=bytes.buffer;}
  const face = new FontFace('ComicTC', source);
  document.fonts.add(await face.load());
}
