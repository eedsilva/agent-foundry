'use client';

import React, { useEffect, useRef, type ReactNode } from 'react';
import { EYEBROW, ICON_BTN, MODAL, MODAL_BACKDROP, PANEL_HEADER, PANEL_TITLE } from '@/lib/ui';
import { cn } from '@/lib/utils';

/**
 * Right-hand slide-over (DESIGN.md §5.4). A sheet is chrome, so §3.3's glass
 * applies here — the table stays legible behind it, which is the whole point
 * of a sheet over a centred dialog.
 */
const SHEET = 'glass rounded-l-sheet shadow-modal h-full w-[min(560px,100%)] overflow-auto p-6';

/**
 * The one modal shell in the app. A native `<dialog>` opened with
 * `showModal()` — that is where the focus trap, `Escape` to dismiss, the
 * `inert` background and focus-return-to-opener come from. None of it is
 * hand-rolled; DESIGN.md §7's keyboard requirements are the platform's job.
 *
 * Two lifecycles share this shell and both have to keep focus return working:
 *
 * - The router overlays stay mounted and flip `open`. The UA's
 *   `dialog:not([open]) { display: none }`, plus an explicit `hidden` so
 *   server-rendered markup can still be asserted without a DOM harness, hide
 *   the closed element. `showModal()` therefore runs in an effect, never
 *   during render, and is a no-op on the server.
 * - The builder dialogs `return null` when their target is cleared, so the
 *   whole element is removed while still open. The HTML "dialog removing
 *   steps" destroy the close watcher *without* running the close-the-dialog
 *   algorithm, which is what returns focus to the opener — and React runs a
 *   passive effect's unmount cleanup *after* detaching the node, too late for
 *   `close()` to restore it either (measured: the e2e's `toBeFocused` after
 *   "Fechar" fails with the cleanup alone). So the shell remembers the opener
 *   at `showModal()` time and re-focuses it itself. Escape happens to work
 *   without any of this only because the UA close algorithm runs first.
 *
 * The `<dialog>` itself is the full-viewport backdrop, so a click that lands
 * on it rather than on the panel is an outside-click and dismisses.
 *
 * The title bar is part of the shell: every caller wants the same
 * `PANEL_HEADER` + optional eyebrow + `aria-label="Fechar"` control, and the
 * e2e depends on that accessible name.
 */
export function Overlay({
  open,
  onClose,
  testId,
  label,
  eyebrow,
  title,
  actions,
  placement = 'center',
  children,
}: {
  open: boolean;
  onClose: () => void;
  testId: string;
  /** The dialog's accessible name, and the heading unless `title` overrides it. */
  label: string;
  eyebrow?: string;
  title?: ReactNode;
  /** Extra controls, rendered left of the close button. */
  actions?: ReactNode;
  placement?: 'center' | 'right';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // `close()` fires its `close` event in a queued task, so a close *we* caused
  // arrives after the effect has already re-run. Without this flag React's
  // StrictMode dev double-invoke (effect → cleanup → effect) would hand the
  // caller an `onClose` it never asked for, and the builder dialogs — whose
  // `open` is a literal `true` — would clear their own target and vanish on
  // mount.
  const selfClosing = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const sheet = placement === 'right';

  useEffect(() => {
    const dialog = ref.current;
    // `showModal` is missing in non-DOM test environments; the markup-only
    // tests never open anything, so degrading to "stays closed" is fine.
    if (!dialog || typeof dialog.showModal !== 'function') return;
    const close = () => {
      selfClosing.current = true;
      dialog.close();
      opener.current?.focus();
    };
    if (open && !dialog.open) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!open && dialog.open) close();
    return () => {
      if (dialog.open) close();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      data-testid={testId}
      // Fires for `Escape` and for the effect's own `close()`; only the former
      // is the user asking to dismiss.
      onClose={() => {
        if (selfClosing.current) {
          selfClosing.current = false;
          return;
        }
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        MODAL_BACKDROP,
        // The UA `::backdrop` would double up on MODAL_BACKDROP's own scrim.
        'text-ink m-0 h-full max-h-none w-full max-w-none border-0 backdrop:bg-transparent',
        sheet && 'flex justify-end p-0',
        !open && 'hidden',
      )}
    >
      <div className={cn(sheet ? SHEET : MODAL, 'overlay-surface')} data-placement={placement}>
        <div className={PANEL_HEADER}>
          <div>
            {eyebrow ? <p className={EYEBROW}>{eyebrow}</p> : null}
            <h2 className={PANEL_TITLE}>{title ?? label}</h2>
          </div>
          <div className="flex items-center gap-2">
            {actions}
            <button type="button" className={ICON_BTN} aria-label="Fechar" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        {children}
      </div>
    </dialog>
  );
}
