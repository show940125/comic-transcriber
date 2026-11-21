// Kokonut UI Toolbar, @dorianbaffier, MIT.
// Source: kokonut-labs/kokonutui @ 1c850ae0c113592fc3ce8aaa5a5a5aa0dc720a58
// The original roving tab stop is used with native buttons and DOM events.
export function moveToolbarFocus(event: KeyboardEvent, buttons: HTMLButtonElement[]) {
  const current = buttons.findIndex(button => button === event.currentTarget);
  if (current === -1) return;

  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = (current + 1) % buttons.length;
      break;
    case 'ArrowLeft':
      next = (current - 1 + buttons.length) % buttons.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = buttons.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  buttons[next].focus();
  return buttons[next];
}

export function attachToolbar(toolbar: HTMLElement) {
  const buttons = Array.from(toolbar.querySelectorAll('button'));
  for (const button of buttons) {
    button.addEventListener('focus', () => {
      for (const item of buttons) item.tabIndex = item === button ? 0 : -1;
    });
    button.addEventListener('keydown', event => moveToolbarFocus(event, buttons));
  }
}
