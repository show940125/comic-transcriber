<script lang="ts">
  // AI Loading State v2.0.0, Kokonut UI (MIT). StepRow, StepLog, WaveText and
  // elapsed formatting ported from the supplied source. Runtime supplies the steps.
  import type {ChapterStep} from '../../chapter-progress';
  let {steps, started, ended}: {steps:ChapterStep[]; started:number; ended?:number}=$props();
  let now=$state(performance.now());
  const seconds=$derived(Math.max(0,Math.floor(((ended??now)-started)/1000)));
  const labels={pending:'待處理',running:'進行中',done:'完成',held:'已中止',error:'失敗'};
  const formatDuration=(s:number)=>s<60?`${s}s`:`${Math.floor(s/60)}m ${(s%60).toString().padStart(2,'0')}s`;
  $effect(()=>{
    if(ended!==undefined)return;
    const timer=setInterval(()=>{now=performance.now();},500);
    return ()=>clearInterval(timer);
  });
</script>

<div class="step-card" aria-label="執行進度">
  <div class="step-head">
    <h3>執行進度</h3>
    <time aria-label={`已用 ${seconds} 秒`} datetime={`PT${seconds}S`}>{formatDuration(seconds)}</time>
  </div>
  <ol aria-label="處理步驟">
    {#each steps as step (step.id)}
      <li class="step-row" data-status={step.status} data-phase={step.id}>
        <span class="step-icon" aria-hidden="true">{step.status==='done'?'✓':step.status==='error'?'!':step.status==='held'?'‖':''}</span>
        <div class="step-content">
          <div class="step-line">
            <span class="step-title">
              {#if step.status==='running'}
                <span class="sr">{step.label}</span>
                <span aria-hidden="true">{#each Array.from(step.label) as char,i}<span class="wave" style:animation-delay={`${i*.05}s`}>{char}</span>{/each}</span>
              {:else}{step.label}{/if}
              <span class="sr">，{labels[step.status]}</span>
            </span>
            <span class="step-count">{step.summary}</span>
          </div>
          {#if step.detail.length}
            <details>
              <summary>{step.id==='gemini'?'請求細節':'逐頁細節'}<span class="sr">，{step.label}</span></summary>
              <ul>{#each step.detail as line}<li>{line}</li>{/each}</ul>
            </details>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
</div>

<style>
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
  .step-card { padding:7px 9px 6px; background:var(--mx-surface); border:1px solid var(--mx-line); border-radius:11px; }
  .step-head { display:flex; align-items:center; justify-content:space-between; gap:7px; }
  h3 { margin:0; font-size:14px; }
  time, .step-count { font-variant-numeric:tabular-nums; color:var(--mx-muted); font-size:12px; }
  ol { list-style:none; padding:1px 0 0; margin:0; }
  .step-row { position:relative; display:flex; gap:8px; padding:6px 0 3px; }
  .step-row:not(:last-child)::before { content:""; position:absolute; left:7px; top:21px; bottom:-7px; width:1px; background:var(--mx-line); }
  .step-row[data-status=done]:not(:last-child)::before { background:#78a685; }
  .step-icon { z-index:1; flex:0 0 15px; height:15px; margin-top:3px; border:1px solid var(--mx-border); border-radius:50%; display:grid; place-items:center; background:var(--mx-surface); font-size:10px; line-height:1; }
  [data-status=done] .step-icon { background:#d8e9da; color:#164f34; border-color:#8eb49b; }
  [data-status=running] .step-icon { border:4px solid #85b197; background:var(--mx-green); }
  [data-status=held] .step-icon,[data-status=error] .step-icon { background:var(--mx-review-bg); color:var(--mx-review); border-color:#c19a67; font-weight:750; }
  .step-content { min-width:0; flex:1; }
  .step-line { display:flex; justify-content:space-between; align-items:baseline; gap:3px 7px; flex-wrap:wrap; }
  .step-title { font-size:13px; color:var(--mx-muted); }
  [data-status=running] .step-title { color:var(--mx-ink); font-weight:700; }
  details { font-size:11px; color:var(--mx-muted); }
  summary { min-height:22px; width:fit-content; }
  ul { margin:1px 0 3px; padding:3px 5px 3px 17px; max-height:80px; overflow:auto; background:var(--mx-tint); border-radius:5px; overflow-wrap:anywhere; }
  .wave { animation:brightness 1.6s ease-in-out infinite both; }
  @keyframes brightness { 50% { opacity:.68; } }
  @media (prefers-reduced-motion:reduce) { .wave { animation:none; } }
</style>
