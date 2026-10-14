import type { Region } from './types';
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
    const fill = r.render === 'fill' || (r.render === 'auto' && canFill(ctx, r));
    ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.width, r.height); ctx.clip();
    ctx.fillStyle = fill ? '#ffffff' : 'rgba(255,255,255,.94)'; ctx.fillRect(r.x, r.y, r.width, r.height);
    const pad = Math.min(6, r.width / 10, r.height / 10), width = r.width - pad * 2, height = r.height - pad * 2;
    let size = Math.min(42, Math.floor(height * .7)), lines: string[] = [];
    while (size >= 6) { ctx.font = `${size}px "ComicTC", "Microsoft JhengHei", sans-serif`; lines = wrapText(ctx, r.translation, width); if (lines.length * size * 1.25 <= height) break; size--; }
    ctx.fillStyle = '#171717'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lineHeight = size * 1.25, top = r.y + (r.height - lines.length * lineHeight) / 2;
    for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], r.x + r.width / 2, top + (i + .5) * lineHeight, width);
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
