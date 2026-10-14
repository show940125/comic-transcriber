import {readFile,writeFile} from 'node:fs/promises';
import {googleWebTranslate} from '../src/google-web';
import type {Region} from '../src/types';
import {defaults} from '../src/types';
import {prompt,parseTranslations} from '../src/core';
import {traditional} from '../src/language';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {needsOcrReview,ocrReviewWarning} from '../src/ocr-quality';
const directory=new URL('../artifacts/real-corpus/',import.meta.url);
const inference=JSON.parse(await readFile(new URL('inference.json',directory),'utf8'));
for(const page of inference.pages)for(const r of page.regions)if(needsOcrReview(r.source)){r.needsReview=true;r.warnings=[...r.warnings,ocrReviewWarning];}
const result={...inference,translationBackend:'google-web/unofficial',translationQuality:'pending human review',pages:[] as any[],errors:[] as any[],requests:0};
const resume=process.argv.includes('--resume'),fallback=process.argv.includes('--fallback-cpu');
let prior:any;try{if(resume)prior=JSON.parse(await readFile(new URL('translations.json',directory),'utf8'));}catch{}
const priorPages=new Map<string,any>((prior?.pages??[]).map((p:any)=>[p.file,p]));
let localOnly=Boolean(fallback&&prior?.errors?.length),previous='';
async function cpu(regions:Region[]){
 const nonempty=regions.filter(r=>r.source.trim()&&!r.needsReview),messages=prompt(nonempty,{...defaults,title:'ブラックジャックによろしく',chapter:'第1巻'},previous);
 const value=await new Promise<any>((resolve,reject)=>{
  const child=spawn('python',[fileURLToPath(new URL('../backend/native_pipe.py',import.meta.url))],{cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8'}});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>{if(code!==0)reject(new Error(stderr||`CPU exit ${code}`));else try{resolve(JSON.parse(stdout));}catch(error){reject(error);}});child.stdin.end(JSON.stringify({messages,model:'qwen3.5-2b'}));
 });
 const mapped=parseTranslations(value.content,nonempty);return regions.map(r=>({...r,translation:mapped.has(r.id)?traditional(mapped.get(r.id)!):r.translation}));
}
// This corpus contains author-published text, and no pictures leave the machine.
// No credential, retry, proxy rotation or billing service is involved.
const remembered=new Map<string,Response>();
const transport:typeof fetch=async(input,init)=>{
 const key=String(input);if(remembered.has(key))return remembered.get(key)!.clone();
 result.requests++;const response=await fetch(input,init);if(response.ok)remembered.set(key,response.clone());return response;
};
for(const page of inference.pages){
 const started=performance.now();
 try{
  const cached=priorPages.get(page.file);
  if(cached&&cached.sha256===page.sha256&&JSON.stringify(cached.regions.map((r:Region)=>[r.id,r.source]))===JSON.stringify(page.regions.map((r:Region)=>[r.id,r.source]))){const regions=cached.regions.map((r:Region)=>needsOcrReview(r.source)?{...r,needsReview:true,translation:'',warnings:[...r.warnings.filter(w=>w!==ocrReviewWarning),ocrReviewWarning]}:r);result.pages.push({...cached,regions,translationBackend:cached.translationBackend??'google-web/unofficial'});previous=regions.map((r:Region)=>r.translation).join('\n').slice(-1000);console.log(`PDF page ${page.pdfPage}: reused completed translation`);continue;}
  let regions:Region[],backend='google-web/unofficial',failure='';
  if(!page.regions.some((r:Region)=>r.source.trim()&&!r.needsReview))regions=page.regions;
  else if(localOnly){regions=await cpu(page.regions);backend='llama.cpp-cpu';}
  else try{regions=await googleWebTranslate(page.regions as Region[],undefined,undefined,transport);}
  catch(error){if(!fallback)throw error;failure=String(error);localOnly=true;regions=await cpu(page.regions);backend='llama.cpp-cpu';}
  result.pages.push({...page,regions,translationBackend:backend,googleFailure:failure,translationMs:performance.now()-started});previous=regions.map(r=>r.translation).join('\n').slice(-1000);
  console.log(`PDF page ${page.pdfPage}: ${regions.length} regions, ${(performance.now()-started).toFixed(0)}ms translation`);
 }catch(error){result.errors.push({file:page.file,error:String(error)});console.error(String(error));break;}
 await writeFile(new URL('translations.partial.json',directory),JSON.stringify(result,null,2));
}
Object.assign(result,{status:result.errors.length?'incomplete; stopped on first error':'executed-pending-human-review',translationBackend:fallback?'Google web + explicitly selected CPU fallback':'google-web/unofficial',fallbackEnabled:fallback,priorGoogleFailure:prior?.errors??[],metrics:{...inference.metrics,translatedRegions:result.pages.reduce((sum:number,p:any)=>sum+p.regions.filter((r:Region)=>r.translation).length,0),translatedPages:result.pages.length,humanTranslationAcceptance:null}});
await writeFile(new URL('translations.json',directory),JSON.stringify(result,null,2));
console.log(JSON.stringify({status:(result as any).status,requests:result.requests,pages:result.pages.length,metrics:(result as any).metrics}));
if(result.errors.length)process.exitCode=1;
