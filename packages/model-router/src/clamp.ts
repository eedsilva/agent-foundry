/** Clamps a value to [0, 1]. Internal helper shared across router scoring/confidence/exploration math. */
export function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
