import {test} from 'node:test';import assert from 'node:assert/strict';import {chapterImages} from '../src/site-images';
test('a translated chapter page stays admitted while replacement PNG dimensions are temporarily zero',()=>{
 const doc={querySelectorAll:()=>[],images:[]} as unknown as Document;
 const image={closest:()=>null,naturalWidth:0,naturalHeight:0,complete:false,src:'blob:result',dataset:{comicOriginal:'https://example.com/p1.png',comicResult:'blob:result'},ownerDocument:{baseURI:'https://example.com/chapter'}} as unknown as HTMLImageElement;
 (doc as any).images=[image];assert.deepEqual(chapterImages(doc),[image]);delete image.dataset.comicResult;assert.deepEqual(chapterImages(doc),[]);
});
