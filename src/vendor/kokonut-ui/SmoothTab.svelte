<script lang="ts">
  // Kokonut UI Smooth Tab, @dorianbaffier, MIT.
  // Source: kokonut-labs/kokonutui @ 87ec36a60e857eed56f3784e60e8d28cf6971fd7
  // The measured indicator and keyboard selection are ported from the React component.
  import {moveToolbarFocus} from './toolbar';

  let {items, label, value, disabled = false, onChange}: {
    items: readonly {id: string; title: string}[];
    label: string;
    value: string;
    disabled?: boolean;
    onChange: (id: string) => void;
  } = $props();
  let container = $state<HTMLDivElement>();
  let indicator = $state<{left: number; width: number}>();

  $effect(() => {
    const index = items.findIndex(item => item.id === value);
    const group = container;
    const button = group?.querySelectorAll('button')[index];
    if (!group || !button) return;

    const measure = () => {
      let left = 0;
      let node: Element | null = button;
      while (node instanceof HTMLElement && node !== group) {
        left += node.offsetLeft;
        node = node.offsetParent;
      }
      indicator = {left, width: button.offsetWidth};
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    observer.observe(button);
    return () => observer.disconnect();
  });

  function selectWithKeyboard(event: KeyboardEvent) {
    if (!container) return;
    const button = moveToolbarFocus(event, Array.from(container.querySelectorAll('button')));
    if (button?.dataset.option) onChange(button.dataset.option);
  }
</script>

<div class="smooth-tabs" class:measured={!!indicator} bind:this={container} role="group" aria-label={label}>
  {#if indicator}
    <span class="indicator" aria-hidden="true"
      style:width={`${indicator.width - 8}px`} style:transform={`translateX(${indicator.left + 4}px)`}></span>
  {/if}
  {#each items as item (item.id)}
    <button type="button" data-option={item.id} aria-pressed={item.id === value}
      tabindex={item.id === value ? 0 : -1} {disabled} onclick={() => onChange(item.id)}
      onkeydown={selectWithKeyboard}>{item.title}</button>
  {/each}
</div>

<style>
  .smooth-tabs {
    position: relative;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--mx-line);
    border-radius: 11px;
    background: var(--mx-tint);
  }

  .indicator {
    position: absolute;
    top: 4px;
    bottom: 4px;
    inset-inline-start: 0;
    border-radius: 7px;
    background: var(--mx-green);
    box-shadow: 0 2px 5px #1843322e;
    pointer-events: none;
    transition: transform 250ms cubic-bezier(.32, .72, 0, 1), width 250ms cubic-bezier(.32, .72, 0, 1);
  }

  .smooth-tabs button {
    position: relative;
    min-width: 66px;
    min-height: 33px;
    padding: 4px 8px;
    border: 0;
    background: transparent;
    color: var(--mx-muted);
  }

  .smooth-tabs button:hover:not([aria-pressed=true]):not(:disabled) { background: #cddcce88; }
  .measured button[aria-pressed=true] { color: white; font-weight: 650; background: transparent; }

  @media (prefers-reduced-motion: reduce) {
    .indicator { transition: none; }
  }
</style>
