// Adapted from cube-computer: src/windows/app/src/persona/persona-geometry.ts (with the weights preference from persona/persona-preferences.ts)
//
// Conversation and workspace use CSS flex weights, kept in this page's
// localStorage. The persona list has its own fixed width.

/**
 * Column proportions, not pixels: the user's drag is remembered as a share of
 * the page so it survives a window resize.
 */
export type ColumnWeights = readonly [number, number];
export const DEFAULT_COLUMN_WEIGHTS: ColumnWeights = [2, 3];

/** No column is dragged narrower than this; the CSS holds the same floor. */
export const COLUMN_MIN_PX = 240;

export const WEIGHTS_KEY = "personas:weights";

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** Weights to pixels. */
export function resolveWidths(width: number, weights: readonly number[]): number[] {
  const total = sum(weights);
  return weights.map((weight) => total > 0 ? width * weight / total : width / weights.length);
}

/**
 * A boundary drag, in pixels, folded back into weights. Conversation and
 * workspace each keep COLUMN_MIN_PX rather than squeezing the other away.
 */
export function resizeColumns(weights: ColumnWeights, deltaPx: number, width: number): ColumnWeights {
  const widths = resolveWidths(width, weights);
  const before = widths[0]!;
  const after = widths[1]!;
  const pair = before + after;
  if (pair < COLUMN_MIN_PX * 2) return weights;
  // A pair already under the floor (a narrow window) never jumps the
  // other way: the bounds widen to include where the boundary is now.
  const moved = Math.min(Math.max(before + deltaPx, Math.min(before, COLUMN_MIN_PX)), Math.max(before, pair - COLUMN_MIN_PX));
  widths[0] = moved;
  widths[1] = pair - moved;
  // Back to weights on the same scale as before the drag.
  const totalWeight = sum(weights);
  const next = widths.map((value) => width > 0 ? value / width * totalWeight : value);
  return [next[0]!, next[1]!];
}

/** The remembered weights, or the default when none (or nonsense) is stored. */
export function readWeights(): ColumnWeights {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? "null");
    // A stored zero or negative would divide the page by nothing.
    if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) return DEFAULT_COLUMN_WEIGHTS;
    if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0)) return DEFAULT_COLUMN_WEIGHTS;
    // The former workspace list and detail now share one workspace.
    return [value[0] as number, (value[1] as number) + (value.length === 3 ? value[2] as number : 0)];
  } catch {
    return DEFAULT_COLUMN_WEIGHTS;
  }
}

export function saveWeights(weights: ColumnWeights): void {
  try {
    localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights));
  } catch { /* Storage can be unavailable; the drag still applies to this page. */ }
}
