export function boxIoU(a,b){const area=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return area/(a.width*a.height+b.width*b.height-area||1);}
export function editDistance(a,b){a=Array.from(a);b=Array.from(b);let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=0;i<a.length;i++){const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+(a[i]!==b[j])));row=next;}return row[b.length];}
export function normalizeOCR(s){return s.normalize('NFKC').replace(/\s/g,'');}
export function summarizeReview(pages,reviewer=''){
 const regions=pages.flatMap(p=>p.regions),texts=regions.filter(r=>['dialogue','difficult','other-text'].includes(r.review?.category));
 const general=texts.filter(r=>r.review.category==='dialogue'),criteria=['meaning','address','tone','traditional'];
 const scored=general.filter(r=>criteria.every(k=>['pass','fix'].includes(r.review[k]))),accepted=scored.filter(r=>criteria.every(k=>r.review[k]==='pass'));
 const transcribed=texts.filter(r=>r.review.sourceVerified&&r.review.boxVerified&&r.review.referenceSource?.trim());
 const complete=Boolean(reviewer.trim())&&pages.length>0&&pages.every(p=>p.reviewComplete)&&regions.every(r=>r.review?.category&&r.review.category!=='unknown')&&transcribed.length===texts.length;
 let hits=0,predictions=0,edits=0,characters=0;
 for(const page of pages){const gt=page.regions.filter(r=>['dialogue','difficult','other-text'].includes(r.review?.category)&&r.review.sourceVerified&&r.review.boxVerified),pred=page.regions.filter(r=>r.predictionBox);predictions+=pred.length;const pairs=[];
  for(let i=0;i<gt.length;i++)for(let j=0;j<pred.length;j++){const score=boxIoU(gt[i],pred[j].predictionBox);if(score>=.5)pairs.push({i,j,score});}
  const usedGT=new Set(),usedPred=new Set();for(const pair of pairs.sort((a,b)=>b.score-a.score))if(!usedGT.has(pair.i)&&!usedPred.has(pair.j)){usedGT.add(pair.i);usedPred.add(pair.j);hits++;const truth=normalizeOCR(gt[pair.i].review.referenceSource??''),hyp=normalizeOCR(pred[pair.j].source??'');characters+=Array.from(truth).length;edits+=editDistance(truth,hyp);}
  for(let i=0;i<gt.length;i++)if(!usedGT.has(i)){const truth=normalizeOCR(gt[i].review.referenceSource??'');characters+=Array.from(truth).length;edits+=Array.from(truth).length;}
 }
 const rated=complete&&scored.length===general.length,recall=complete&&texts.length?hits/texts.length:null,cer=complete&&characters?edits/characters:null,translationRate=rated&&scored.length?accepted.length/scored.length:null;
 const enough=complete&&texts.length>=300&&pages.length>=30&&rated;
 return {status:enough?'recorded-review-ready-for-assessment':'pending-review-or-sample-size',reviewer,reviewMethod:'candidate-assisted human review; self-reported, not blind annotation',pages:pages.length,candidates:regions.filter(r=>r.predictionBox).length,referenceTexts:texts.length,sourceVerified:transcribed.length,generalDialogue:general.length,graded:scored.length,accepted:accepted.length,recallIoU05:recall,precision:complete&&predictions?hits/predictions:null,endToEndCER:cer,translationAcceptance:translationRate,missingTranslations:texts.filter(r=>!r.translation?.trim()).length,thresholdsMet:enough&&recall>=.95&&cer<=.1&&translationRate>=.9};
}
