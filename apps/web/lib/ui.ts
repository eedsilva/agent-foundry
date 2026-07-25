/**
 * Class strings shared across the app's surfaces. Token-derived utilities only —
 * no stock Tailwind palette, no raw hex, and `glass` stays on chrome
 * (header, tab strip, alert strip, dialogs), never on these content surfaces.
 */

/**
 * The one document-page container: home, versions and the router dashboard.
 * The builder is a full-height app shell, not a document page, and keeps its
 * own tighter gutter.
 */
export const PAGE = 'mx-auto w-full max-w-[1180px] px-6 py-10';
export const PANEL = 'bg-surface border-hairline rounded-panel shadow-card border p-4';
export const PANEL_HEADER = 'mb-3 flex items-center justify-between gap-3';
export const PANEL_TITLE = 'text-ink text-[15px] font-semibold';
export const SECTION_TITLE = 'text-ink text-[13px] font-semibold';
export const HINT = 'text-ink-subtle font-mono text-[11px]';
export const META = 'text-ink-muted text-[13px]';
export const ROW = 'flex items-center gap-3';
export const BTN =
  'border-hairline rounded-control text-ink hover:bg-accent-wash active:scale-[0.98] border px-3 py-1.5 text-[13px] font-medium transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-[var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-50';
/**
 * Active toggle. The label stays `--ink`, not `--accent`: `--accent` (#0FA3A3)
 * on `--accent-wash` over white (#ECF8F8) measures 2.85:1, well under the 4.5:1
 * DESIGN.md §7 requires, and axe fails the preview panel on it. The accent
 * border plus the wash carry the active state instead. Task 7's contrast audit
 * left `--accent` alone (it is a UI/fill colour at 3.09:1 ≥ 3:1) and darkened
 * only `--ink-subtle`; `--accent-strong` is the tinted *text* colour.
 */
export const BTN_ACTIVE = 'border-accent bg-accent-wash text-ink';
// `--surface` on `--accent` is 3.09:1; on `--accent-strong` it is 4.76:1. The
// hover state darkens with a filter rather than a lighter token so the label
// never drops back below 4.5:1.
export const PRIMARY_BTN =
  'bg-accent-strong hover:brightness-90 hover:shadow-pop active:scale-[0.98] rounded-control text-surface px-4 py-2 text-[14px] font-semibold transition-[filter,transform,box-shadow] duration-150 ease-[var(--ease-out)] disabled:cursor-not-allowed disabled:opacity-60';
export const FIELD =
  'border-hairline rounded-control text-ink focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-wash)] bg-surface w-full border px-3 py-2 text-[14px] outline-none transition-[border-color,box-shadow] duration-150 ease-[var(--ease-out)]';
export const TEXTAREA = `${FIELD} resize-y font-mono text-[12.5px] leading-relaxed`;
export const LABEL = 'text-ink-muted flex flex-col gap-1.5 text-[13px] font-medium';
export const RADIO = 'text-ink-muted flex items-center gap-2 text-[13px]';
// `text-err` on `bg-err/10` is 3.44:1. Same remedy as StatusPill: `--ink` for
// the text (16.15:1), the tone carried by the wash and border.
export const ERROR_BOX =
  'text-ink bg-err/10 border-err/30 rounded-control border px-3 py-2 text-[13px]';
/**
 * Same shape as ERROR_BOX for a caution that is not a failure — a `role="status"`
 * notice must not wear the error wash. `--ink` on `--warn`/10 over `--surface`
 * (#FDF6EC) is 17.07:1, and 15.20:1 over `--surface-sunken` — both well past
 * §7's 4.5:1.
 */
export const WARN_BOX =
  'text-ink bg-warn/10 border-warn/30 rounded-control border px-3 py-2 text-[13px]';
export const MONO_PANE =
  'bg-surface-sunken rounded-card text-ink max-w-full overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed';
export const EYEBROW =
  'text-ink-subtle font-mono text-[11px] font-bold tracking-[0.12em] uppercase';
export const MODAL_BACKDROP = 'bg-ink/40 fixed inset-0 z-40 grid place-items-center p-6';
export const MODAL =
  'bg-surface border-hairline rounded-sheet shadow-modal max-h-[88vh] w-[min(1000px,100%)] overflow-auto border p-6';
export const ICON_BTN =
  'border-hairline text-ink hover:bg-accent-wash active:scale-[0.96] grid size-9 shrink-0 place-items-center rounded-full border text-[20px] leading-none transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-out)]';
// Same remedy as StatusPill and ERROR_BOX: `--ok` on its own 10% wash over
// `--surface-sunken` is 2.8:1 and `--err` 3.4:1, both under §7's 4.5:1. The
// wash carries the tone, the `+`/`-` gutter character carries the meaning
// without colour, and removals keep the strike-through.
export const DIFF_ADDED = 'text-ink bg-ok/10';
export const DIFF_REMOVED = 'text-ink bg-err/10 line-through';
/** Neutral metadata chip. Anything that is a *status* uses `StatusPill` instead. */
export const CHIP =
  'bg-surface-sunken text-ink-muted inline-flex items-center rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold';
export const CARD_BUTTON =
  'border-hairline rounded-card hover:border-accent hover:shadow-card active:scale-[0.995] bg-surface flex w-full items-center justify-between gap-3 border p-3 text-left transition-[border-color,box-shadow,transform] duration-150 ease-[var(--ease-out)]';
