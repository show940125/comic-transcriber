<script lang="ts">
  import {onMount} from 'svelte';
  import {recordKey,type CacheInventory,type CacheSelection} from './cache-inventory';

  let data=$state<CacheInventory>(),bundle=$state<{groups:{name:string;files:number;bytes:number}[]}>(),runtime=$state<any>();
  let error=$state(''),message=$state(''),busy=$state(''),inUse=$state(false),waitingForRelease=$state(false);
  let filter=$state(''),category=$state('all'),sort=$state('new'),native=$state('未檢查'),after=$state(''),before=$state('');
  let confirmation:HTMLDialogElement;
  let pending=$state<{selection:CacheSelection;label:string;count:number;unit:string;impact:string}>();
  const search=$derived(filter.trim().toLowerCase()),filtered=$derived(!!(category!=='all'||search||after||before));
  const measured=$derived((data?.pageBytes??0)+(data?.modelBytes??0));
  const within=(n:number|undefined)=>(!after&&!before)||!!n&&(!after||n>=new Date(after+'T00:00:00').getTime())&&(!before||n<=new Date(before+'T23:59:59.999').getTime());
  const size=(n:number|undefined)=>n===undefined?'尚未計量':n<1048576?((n/1024).toFixed(1)+' KiB'):((n/1048576).toFixed(2)+' MiB');
  const date=(n:number|undefined)=>n?new Date(n).toLocaleString('zh-TW'):'未記錄';
  const matches=(fields:unknown[])=>fields.some(field=>String(field??'').toLowerCase().includes(search));
  const rowSort=(a:number|undefined,b:number|undefined)=>sort==='old'?(a??0)-(b??0):(b??0)-(a??0);
  const rows=$derived((data?.pages??[]).filter(p=>matches([p.title,p.chapter,p.source,p.backend,p.hash])&&within(p.savedAt))
    .sort((a,b)=>sort==='size'?b.bytes-a.bytes:rowSort(a.savedAt,b.savedAt)));
  const models=$derived((data?.models??[]).filter(m=>matches([m.id,m.url,m.cache])&&within(m.measuredAt))
    .sort((a,b)=>sort==='size'?(b.bytes??0)-(a.bytes??0):rowSort(a.measuredAt,b.measuredAt)));
  const phase:Record<string,string>={loading:'載入中',unloaded:'未載入',released:'已釋放',running:'執行中',waiting:'待釋放'};

  async function call(channel:string,extra:object={}){
    const result=await chrome.runtime.sendMessage({channel,...extra});
    if(!result?.ok)throw new Error(result?.error??'快取管理未回應');
    return result;
  }
  async function task(label:string,work:()=>Promise<void>){
    if(busy)return;
    busy=label;error='';message='';
    try{await work();}catch(e){error=e instanceof Error?e.message:String(e);}
    finally{busy='';}
  }
  async function refresh(){
    const [inventory,state]=await Promise.all([call('cache-inventory'),call('runtime-status')]);
    data=inventory.result;inUse=inventory.busy;runtime=state.result;
    if(waitingForRelease&&state.result.phase==='released'){waitingForRelease=false;message='模型已從記憶體釋放。';}
  }
  function scan(){return task('正在逐檔掃描模型大小…',async()=>{await call('cache-scan');await refresh();message='模型大小已更新。';});}
  function requestRemoval(selection:CacheSelection,label:string,keys:string[],page=false){
    if(busy||inUse||!keys.length)return;
    if(filtered&&['pages','models'].includes(selection.kind))return;
    pending={selection:{...selection,expected:keys},label,count:keys.length,unit:page?'份':'個檔案',
      impact:page?'會移除所列頁面的原文、譯文與人工校正。':'需要時會重新下載這些模型檔案。套件內建模型依然可用。'};
    confirmation.showModal();
  }
  function closeConfirmation(){confirmation.close();pending=undefined;}
  async function remove(){
    const target=pending;closeConfirmation();if(!target)return;
    await task('正在清除快取…',async()=>{
      await call('cache-remove',{selection:target.selection});
      await refresh();message='已清除 '+target.count+' '+target.unit+'，'+target.label+'。';
    });
  }
  function release(){return task('正在檢查推論狀態…',async()=>{
    const result=await call('runtime-release');
    waitingForRelease=result.busy===true;
    await refresh();
    message=waitingForRelease?'等目前的工作收尾後釋放模型。':'模型已從記憶體釋放。';
  });}
  function checkNative(){return task('正在檢查語言包…',async()=>{
    const {chromeTranslatorAvailability}=await import('./chrome-translator');const r=await chromeTranslatorAvailability();
    native=r.status+' · 大小由 Chrome 管理';
  });}
  onMount(()=>{
    void task('正在讀取快取與推論狀態…',async()=>{
      await refresh();const result=await fetch(chrome.runtime.getURL('/bundle-inventory.json'));
      if(result.ok)bundle=await result.json();
    });
    const changed=(changes:Record<string,chrome.storage.StorageChange>,area:string)=>{
      if(area==='session'&&changes.runtimeReleasedAt&&waitingForRelease){
        waitingForRelease=false;message='模型已從記憶體釋放。';
        void refresh().catch(e=>{error=e instanceof Error?e.message:String(e);});
      }
    };
    chrome.storage.onChanged.addListener(changed);
    return ()=>chrome.storage.onChanged.removeListener(changed);
  });
</script>

<main class="moyu">
  <a href="options.html">返回模型與閱讀設定</a>
  <h1>快取與推論資源</h1>
  <section aria-labelledby="runtime-title">
    <h2 id="runtime-title">推論記憶體 · {waitingForRelease?'待釋放':phase[runtime?.phase]??'讀取中'}</h2>
    <p class="mx-note">所有分頁閒置 60 秒後，墨譯會釋放模型。已顯示的譯圖仍可閱讀。</p>
    <div class="actions"><button disabled={!!busy} onclick={()=>task('正在重新計量…',refresh)}>重新計量</button><button disabled={!!busy||waitingForRelease} onclick={release}>釋放閒置模型</button></div>
    {#if runtime?.worker}<p>載入模型 {runtime.models??0} 組 · WASM 設定 {runtime.threads??'未初始化'} · 實際 pthread {runtime.spawnedPthreads??0} · 跨來源隔離 {runtime.crossOriginIsolated?'已啟用':'未啟用'}</p>{#if runtime.reason}<p>{runtime.reason}</p>{/if}{/if}
    {#if runtime?.translatorLoaded}<p>Chrome Translator 翻譯會話已載入</p>{/if}
  </section>
  <div class="notice">
    {#if busy||message||waitingForRelease}<p role="status">{busy||message||'等目前的工作收尾後釋放模型。'}</p>{/if}
    {#if error}<p class="mx-alert" role="alert">{error}</p>{/if}
  </div>
  {#if data}
    <section>
      <h2>儲存用量</h2>
      <div class="meter-number"><strong>{size(measured)}</strong><span>已計量的快取</span></div>
      <div class="meter" aria-hidden="true">
        {#if measured}
          <i class="page-segment" style:width={`${100*data.pageBytes/measured}%`}></i><i class="model-segment" style:width={`${100*data.modelBytes/measured}%`}></i>
        {/if}
      </div>
      <div class="meter-legend" role="group" aria-label="快取用量分類">
        <button aria-pressed={category==='pages'} onclick={()=>category=category==='pages'?'all':'pages'}><i class="page-segment"></i><span>頁面快取</span><b>{size(data.pageBytes)}</b></button>
        <button aria-pressed={category==='models'} onclick={()=>category=category==='models'?'all':'models'}><i class="model-segment"></i><span>下載模型</span><b>{size(data.modelBytes)}</b></button>
      </div>
      <p>頁面文字與校正 {size(data.pageBytes)}（{data.pages.length} 份，上限 30 份）</p>
      <p>已計量下載模型 {size(data.modelBytes)}，尚有 {data.unmeasured} 個檔案待掃描。</p>
      <p class="mx-note">Chrome 估算此擴充套件使用 {size(data.estimate?.usage)}。此數字涵蓋瀏覽器管理的內容。</p>
      <button disabled={!!busy||inUse} onclick={scan}>串流掃描模型大小</button>
    </section>

    <div role="group" class="filters" aria-label="篩選與排序">
      <label>顯示類型 <select bind:value={category}><option value="all">全部</option><option value="pages">頁面文字</option><option value="models">下載模型</option><option value="bundle">套件資源</option></select></label>
      <label>來源 <input aria-label="篩選快取來源" bind:value={filter} placeholder="作品、網址或圖片雜湊"></label>
      <label>排序 <select aria-label="快取排序" bind:value={sort}><option value="new">最新保存</option><option value="old">最早保存</option><option value="size">大小</option></select></label>
      <label>起日 <input type="date" bind:value={after}></label><label>迄日 <input type="date" bind:value={before}></label>
      {#if filtered}<button onclick={()=>{filter='';after='';before='';category='all';}}>清除篩選</button>{/if}
    </div>

    {#if category==='all'||category==='pages'}
      <section>
        <h2>頁面文字與校正</h2>
        {#if rows.length}
          <div class="table-scroll">
            <table><thead><tr><th scope="col">頁面／來源</th><th scope="col">區域</th><th scope="col">保存時間</th><th scope="col">大小</th><th scope="col">操作</th></tr></thead>
            <tbody>{#each rows as p (p.key)}
              <tr><td>{p.title||p.hash?.slice(0,12)||'未命名'} {p.chapter??''} {p.pageIndex===undefined?'':'第 '+(p.pageIndex+1)+' 張'}<small>{p.backend} · {p.source||'來源未記錄'}</small></td>
                <td>{p.regions}</td><td>{date(p.savedAt)}</td><td>{size(p.bytes)}</td>
                <td><button class="danger" disabled={!!busy||inUse} onclick={()=>requestRemoval({kind:'page',key:p.key},p.title||'此頁文字與校正',[p.key],true)}>刪除此頁</button></td>
              </tr>
            {/each}</tbody></table>
          </div>
        {:else}<p class="mx-note">{filtered?'沒有符合篩選的頁面快取。':'目前沒有頁面快取。'}</p>{/if}
      </section>
    {/if}
    {#if category==='all'||category==='models'}
      <section>
        <h2>下載模型</h2>
        {#each models as m (recordKey(m.cache,m.url))}
          {@const group=data.models.filter(row=>row.id===m.id)}
          <article><strong>{m.id} · {m.url.split('/').at(-1)}</strong><small>{m.cache} · {m.version} · {m.url}</small>
            <p>群組已存 {group.length}/{m.expected??'未記錄'} 檔 · {size(m.bytes)} · {date(m.measuredAt)} · {m.verified?'已驗證雜湊':'完整性未記錄'}</p>
            <div class="actions">
              <button class="danger" disabled={!!busy||inUse} onclick={()=>requestRemoval({kind:'model',cache:m.cache,url:m.url},m.url.split('/').at(-1)??m.id,[recordKey(m.cache,m.url)])}>刪除此檔</button>
              <button class="danger" disabled={!!busy||inUse} onclick={()=>requestRemoval({kind:'model-group',group:m.id},m.id,group.map(r=>recordKey(r.cache,r.url)))}>刪除此模型群組</button>
            </div>
          </article>
        {:else}<p class="mx-note">{filtered?'沒有符合篩選的下載模型。':'目前沒有下載模型。'}</p>{/each}
      </section>
    {/if}
    {#if category==='all'||category==='bundle'}
      <section><h2>套件內建資源</h2>
        {#each (bundle?.groups??[]).filter(group=>matches([group.name])) as group}<p>{group.name} · {group.files} 個檔案 · {size(group.bytes)}</p>
        {:else}<p class="mx-note">{bundle?'沒有符合篩選的內建資源。':'目前套件未提供資源清單。'}</p>{/each}
      </section>
    {/if}
    {#if !filtered}
      <section class="maintenance" aria-label="快取維護"><h2>快取維護</h2>
        <p class="mx-note">{inUse?'目前有推論任務。工作收尾後可重新計量並清除快取。':'整批刪除前會先顯示類別、筆數與影響。'}</p>
        <div class="actions">
          <button class="danger" disabled={!!busy||inUse||!data.pages.length} onclick={()=>requestRemoval({kind:'pages'},'全部頁面文字與校正',data!.pages.map(p=>p.key),true)}>清除全部頁面文字</button>
          <button class="danger" disabled={!!busy||inUse||!data.models.length} onclick={()=>requestRemoval({kind:'models'},'全部下載模型',data!.models.map(m=>recordKey(m.cache,m.url)))}>清除全部下載模型</button>
        </div>
      </section>
    {/if}
  {/if}
  <section><h2>Chrome 翻譯語言包</h2><p class="mx-note">狀態 {native}</p><button disabled={!!busy} onclick={checkNative}>檢查語言包狀態</button></section>

  <dialog bind:this={confirmation} aria-labelledby="remove-title" oncancel={event=>{event.preventDefault();closeConfirmation();}}>
    <h2 id="remove-title">刪除 {pending?.label}？</h2>
    <p>這次會刪除 {pending?.count} {pending?.unit}。{pending?.impact}</p>
    <div class="actions"><button onclick={closeConfirmation}>取消</button><button class="danger" onclick={remove}>確認刪除</button></div>
  </dialog>
</main>

<style>
  :global(body) { margin: 0; background: #eef1e9; }
  main { max-width: 1030px; margin: auto; padding: clamp(14px, 3vw, 28px); }
  h1 { font-size: 25px; margin-bottom: 10px; }
  h2 { font-size: 16px; margin: 0; }
  p { margin: 6px 0 9px; }
  section { background: var(--mx-paper); border: 1px solid var(--mx-line); border-radius: 10px; margin: 12px 0; padding: 16px; }
  .meter-number { display:flex; flex-wrap:wrap; gap:4px 8px; align-items:baseline; color:var(--mx-muted); }
  .meter-number strong { color:var(--mx-ink); font-size:clamp(24px,4vw,38px); font-variant-numeric:tabular-nums; }
  .meter { display:flex; min-height:10px; border-radius:8px; overflow:hidden; background:var(--mx-tint); }
  .page-segment { background:#2f654c; }
  .model-segment { background:#8b7864; }
  .meter-legend { display:flex; flex-wrap:wrap; gap:5px; margin:8px 0; }
  .meter-legend button { display:flex; flex:1 1 150px; gap:5px; align-items:center; }
  .meter-legend i { width:8px; height:8px; border-radius:2px; flex:none; }
  .meter-legend b { margin-left:auto; font-variant-numeric:tabular-nums; }
  .meter-legend button[aria-pressed=true] { background:var(--mx-tint); border-color:var(--mx-green); }
  .filters, .actions { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
  .filters label { display: grid; gap: 3px; color: var(--mx-muted); font-size: 13px; }
  .filters label input { max-width: 100%; }
  .notice p[role=status] { padding: 8px; color: var(--mx-green); }
  .table-scroll { overflow: auto; border: 1px solid var(--mx-line); border-radius: 8px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px; border-bottom: 1px solid var(--mx-line); }
  th { background: var(--mx-tint); }
  td:not(:first-child) { white-space: nowrap; font-variant-numeric: tabular-nums; }
  td:first-child { min-width: 140px; }
  small { display: block; overflow-wrap: anywhere; color: var(--mx-muted); }
  article { border-bottom: 1px solid var(--mx-line); padding: 10px 0; overflow-wrap: anywhere; }
  .maintenance { border-color: #d8b6a9; }
  dialog { width: min(440px, calc(100% - 24px)); overflow-wrap: anywhere; padding: 18px; }
</style>
