import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url),directory=new URL('artifacts/real-corpus/',root);
let source;try{source=JSON.parse(await readFile(new URL('native-browser-translations.json',directory),'utf8'));}catch{try{source=JSON.parse(await readFile(new URL('translations.json',directory),'utf8'));}catch{source=JSON.parse(await readFile(new URL('inference.json',directory),'utf8'));}}
const data={sourceManifestSha256:source.sourceManifestSha256,credit:source.credit,reviewer:'',pages:source.pages.map(p=>({...p,reviewComplete:false,regions:p.regions.map(r=>({...r,predictionBox:{x:r.x,y:r.y,width:r.width,height:r.height},review:{category:'unknown',referenceSource:'',referenceTranslation:'',sourceVerified:false,boxVerified:false,meaning:'unknown',address:'unknown',tone:'unknown',traditional:'unknown'}}))}))};
const template=await readFile(new URL('scripts/review-template.html',root),'utf8'),model=(await readFile(new URL('scripts/review-model.mjs',root),'utf8')).replace(/^export /gm,'');
const html=template.replace('__DATA__',JSON.stringify(data).replace(/</g,'\\u003c')).replace('__REVIEW_MODEL__',model);
await writeFile(new URL('review.html',directory),html);console.log('Created local review workbench:',data.pages.length,'pages; all judgments unreviewed.');
