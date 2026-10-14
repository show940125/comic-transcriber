import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const root=new URL('../',import.meta.url),source=path.join(os.homedir(),'AppData/Local/Google/Chrome/User Data/Default/Extensions/bpoadfkcbjbfhfodiogcnhhhpibjhbnh/1.33.3_0');
const evidence={observed:new Date().toISOString(),extension:{version:'1.33.3',root:source,files:[]},repositories:[],boundaries:{confirmed:'installed-bundle static call paths and public source',inferred:'runtime characteristics from static source',unknown:['proprietary server model weights','live proprietary server implementation','actual proprietary runtime performance']}};
for(const file of ['manifest.json','offscreen.js','content_main.js']){
  const data=await readFile(path.join(source,file)),text=data.toString('utf8');
  const terms=file==='offscreen.js'?['async function _1','Tesseract.recognize','function I1']:file==='content_main.js'?['function QHe','function YHe','async function KHe','function QP','function due']:[];
  evidence.extension.files.push({file,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length,locations:terms.map(term=>({term,offsetUtf16:text.indexOf(term)}))});
}
for(const [repo,revision,license] of [['mrdhnto/libre-manga-translator','8f5d0196406f13502e4c977a9d94613441ed4775','AGPL-3.0-or-later'],['Unheat/Kites','e0c633e109160c4e873292703e828a4efa83c629','GPL-3.0'],['zyddnys/manga-image-translator','d6de6ab62a7be6afc0d07a3184149cdefbcd32f2','GPL-3.0'],['ogkalu2/comic-translate','8977b91a4f7a40c3917c5a268e9e7d78e1d818da','Apache-2.0']])evidence.repositories.push({repo,revision,license,url:`https://github.com/${repo}/tree/${revision}`,codeReuse:'none; independently implemented core'});
await mkdir(new URL('artifacts/research/',root),{recursive:true});await writeFile(new URL('artifacts/research/evidence.json',root),JSON.stringify(evidence,null,2));
const report=`# 漫畫翻譯研究證據\n\n查核時間：${evidence.observed}\n\n本機沉浸式翻譯 1.33.3 的 OCR 路徑：offscreen → ONNX 偵測與裁切 → Tesseract WASM → 原文與座標。前端交由翻譯服務與 Canvas 重排。\n\n漫畫雲端呼叫鏈：v1/img/img-upload-url → 預簽名 PUT → comics/trigger → task-state → 結果圖。未呼叫這些私有服務，亦未上傳使用者漫畫。\n\n精確套件 SHA-256 與 UTF-16 字元定位見 evidence.json。此分析確認前端流程；伺服器模型、權重、內部修圖演算法仍未知。\n\n## 原始碼研究\n\n${evidence.repositories.map(r=>`- [${r.repo}](${r.url}) — ${r.license}。用途：流程與限制研究，插件核心獨立實作。`).join('\n')}\n\n## 實測發現\n\n- 固定版 RT-DETR ONNX 的 orig_target_sizes 實際採 [width,height]。非正方形原創頁面驗證後修正。\n- Manga-OCR 的 decoder 可能再次產生 CLS，輸出需排除特殊 token。\n- 僅文字類別偵測在直排合成頁面漏框，故結合氣泡偵測與氣泡內 connected ink bounds。\n- GPU、WASM、模型品質與離線能力以 artifacts 中實際執行報告為準。\n\n## 次階段研究\n\n[Chrome Translator](https://developer.chrome.com/docs/ai/translator-api)、[LiteRT.js](https://developers.google.com/edge/litert/web/get_started)、[WebNN](https://onnxruntime.ai/docs/tutorials/web/ep-webnn.html)、[LlamaWeb 論文](https://arxiv.org/abs/2605.20706) 保留獨立驗證，不套用論文速度到 UHD 730。\n`;
await writeFile(new URL('artifacts/research/REPORT.md',root),report);
const licenseRes=await fetch('https://www.apache.org/licenses/LICENSE-2.0.txt');if(!licenseRes.ok)throw Error('License unavailable');await writeFile(new URL('LICENSE',root),await licenseRes.text());
console.log('Research evidence and Apache-2.0 license saved.');
