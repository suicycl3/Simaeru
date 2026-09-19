/** 動的に開く・入れ子になるダイアログのフォーカスと背面操作を一か所で管理する。 */
export function installDialogFocus(root: HTMLElement): () => void {
  const selector = '.modal, [role="dialog"][aria-modal="true"]';
  const focusable = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  let active: HTMLElement | null = null;
  const returns = new Map<HTMLElement, HTMLElement | null>();
  let undo: Array<() => void> = [];
  const candidates = (): HTMLElement[] => active ? [...active.querySelectorAll<HTMLElement>(focusable)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]')) : [];
  const first = (): void => (candidates()[0] ?? active)?.focus();
  const refresh = (): void => {
    const dialogs = [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => el.getClientRects().length > 0);
    const next = dialogs.at(-1) ?? null;
    if (next === active) return;
    for (const restore of undo) restore();
    undo = [];
    const previous = active;
    active = next;
    if (previous && !previous.isConnected) {
      returns.get(previous)?.focus();
      returns.delete(previous);
    }
    if (!next) return;
    if (!returns.has(next)) returns.set(next, document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!next.hasAttribute('tabindex')) next.tabIndex = -1;
    // ダイアログを含む枝を残し、すべての兄弟要素を操作不可にする。
    let branch: HTMLElement = next;
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
        const wasInert = sibling.inert;
        sibling.inert = true;
        undo.push(() => { sibling.inert = wasInert; });
      }
      if (branch.parentElement === root) break;
      branch = branch.parentElement;
    }
    if (!next.contains(document.activeElement)) first();
  };
  const onFocus = (event: FocusEvent): void => {
    if (active && !active.contains(event.target as Node)) first();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (!active) return;
    if ((event.ctrlKey && event.key.toLowerCase() === 'f') || event.key === 'Escape') {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (event.key === 'Escape') active.querySelector<HTMLButtonElement>('.detail__close')?.click();
    }
    if (event.key !== 'Tab') return;
    const list = candidates();
    const index = list.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    if (!list.length) active.focus();
    else list[(index + (event.shiftKey ? -1 : 1) + list.length) % list.length].focus();
  };
  const observer = new MutationObserver(refresh);
  observer.observe(root, { childList: true, subtree: true });
  document.addEventListener('focusin', onFocus, true);
  window.addEventListener('keydown', onKey, true);
  refresh();
  return () => {
    observer.disconnect();
    for (const restore of undo) restore();
    document.removeEventListener('focusin', onFocus, true);
    window.removeEventListener('keydown', onKey, true);
  };
}
