/** Select chapter panels in document order, keeping lazy-loaded pages eligible. */
export function expectedImageAssignment(image:Pick<HTMLImageElement,'src'> & Partial<Pick<HTMLImageElement,'srcset'>>,attribute:string|null,expected?:string):boolean {
  return (attribute==='src'||attribute==='srcset'&&!image.srcset?.trim())&&!!expected&&image.src===expected;
}
export function imageSource(image:HTMLImageElement):string {
  const source=image.dataset.comicOriginal || image.dataset.src || image.dataset.original || image.currentSrc || image.src;
  return source ? new URL(source,image.ownerDocument.baseURI).href : '';
}
export function chapterImages(doc:Document=document):HTMLImageElement[] {
  const roots=[...doc.querySelectorAll('[data-image-data],#readerarea,.reading-content,.chapter-content,.comic-reader,.manga-reader,[data-comic-reader]')];
  const excluded='header,nav,footer,[role="navigation"],[data-comic-studio],[data-comic-dock],.comment-area,#full-comments';
  function eligible(image:HTMLImageElement,reader=false){
    if(image.closest(excluded))return false;
    const source=imageSource(image),name=source.split('/').at(-1)??'';
    if(!source||/^(?:logo|avatar|upvote|funny|love|surprised|angry|sad)(?:[-_.]|$)/i.test(name))return false;
    // Replacing src resets natural dimensions until the PNG decodes. Keep an
    // already admitted translated page in the chapter during that interval.
    if(image.dataset.comicOriginal&&image.dataset.comicResult)return true;
    return image.naturalWidth>=300&&image.naturalHeight>=300 || reader&&!!(image.dataset.src||image.dataset.original||(!image.complete&&image.src));
  }
  const candidates=roots.map(root=>[...root.querySelectorAll('img')].filter(i=>eligible(i,true)));
  const group=candidates.sort((a,b)=>b.length-a.length)[0];
  const images=group?.length?group:[...doc.images].filter(i=>eligible(i));
  const seen=new Set<string>();
  return images.filter(image=>{const source=imageSource(image);if(seen.has(source))return false;seen.add(source);return true;});
}
