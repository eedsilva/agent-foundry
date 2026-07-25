'use client';

import React, { useEffect, useRef, type ReactNode } from 'react';
import { MODAL, MODAL_BACKDROP } from '@/lib/ui';
import { cn } from '@/lib/utils';

/**
 * Right-hand slide-over (DESIGN.md §5.4). A sheet is chrome, so §3.3's glass
 * applies here — the table stays legible behind it, which is the whole point
 * of a sheet over a centred dialog.
 */
export const SHEET =
  'glass rounded-l-sheet shadow-modal h-full w-[min(560px,100%)] overflow-auto p-6';

/**
 * The one modal shell in the app. A native `<dialog>` opened with
 * `showModal()` — that is where the focus trap, `Escape` to dismiss, the
 * `inert` background and focus-return-to-opener come from. None of it is
 * hand-rolled; DESIGN.md §7's keyboard requirements are the platform's job.
 *
 * The element stays mounted when closed (the UA's `dialog:not([open])
 * { display: none }`, plus an explicit `hidden` so server-rendered markup can
 * still be asserted without a DOM harness). `showModal()` therefore runs in an
 * effect, never during render, and is a no-op on the server.
 *
 * The `<dialog>` itself is the full-viewport backdrop, so a click that lands
 * on it rather than on the panel is an outside-click and dismisses.
 */
export function Overlay({
  open,
  onClose,
  testId,
  label,
  placement = 'center',
  children,
}: {
  open: boolean;
  onClose: () => void;
  testId: string;
  label: string;
  placement?: 'center' | 'right';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const sheet = placement === 'right';

  useEffect(() => {
    const dialog = ref.current;
    // `showModal` is missing in non-DOM test environments; the markup-only
    // tests never open anything, so degrading to "stays closed" is fine.
    if (!dialog || typeof dialog.showModal !== 'function') return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      data-testid={testId}
      // Fires for `Escape` and for the effect's own `close()`; the latter is a
      // no-op because the caller's state is already closed by then.
      onClose={onClose}
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
      <div className={sheet ? SHEET : MODAL}>{children}</div>
    </dialog>
  );
}
