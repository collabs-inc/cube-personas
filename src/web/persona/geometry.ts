// Adapted from cube-computer: src/windows/app/src/persona/persona-geometry.ts (with the weights preference from persona/persona-preferences.ts)
//
// Changes: the three columns always show (Cube's detail column came and
// went), they are laid out by CSS flex weights rather than absolute rects in
// Cube's rail, the floor is 240 px, and the weights are kept in this page's
// `localStorage` under `personas:weights`.

/**
 * Column proportions, not pixels: the user's drag is remembered as a share of
 * the page so it survives a window resize.
 */
export type ColumnWeights = readonly [number, number, number];
export const DEFAULT_COLUMN_WEIGHTS: ColumnWeights = [2, 1, 2];

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
 * A boundary drag, in pixels, folded back into weights. `boundary` 0 divides
 * the conversation from the list, 1 the list from the pick. Both columns a
 * boundary touches keep COLUMN_MIN_PX, so a drag stops at the floor rather
 * than pushing a neighbour to nothing.
 */
export function resizeColumns(weights: ColumnWeights, boundary: 0 | 1, deltaPx: number, width: number): ColumnWeights {
  const widths = resolveWidths(width, weights);
  const before = widths[boundary]!;
  const after = widths[boundary + 1]!;
  const pair = before + after;
  if (pair < COLUMN_MIN_PX * 2) return weights;
  // A pair already under the floor (a narrow window) never jumps the
  // other way: the bounds widen to include where the boundary is now.
  const moved = Math.min(Math.max(before + deltaPx, Math.min(before, COLUMN_MIN_PX)), Math.max(before, pair - COLUMN_MIN_PX));
  widths[boundary] = moved;
  widths[boundary + 1] = pair - moved;
  // Back to weights on the same scale as before the drag.
  const totalWeight = sum(weights);
  const next = widths.map((value) => width > 0 ? value / width * totalWeight : value);
  return [next[0]!, next[1]!, next[2]!];
}

/** The remembered weights, or the default when none (or nonsense) is stored. */
export function readWeights(): ColumnWeights {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? "null");
    // A stored zero or negative would divide the page by nothing.
    if (!Array.isArray(value) || value.length !== 3) return DEFAULT_COLUMN_WEIGHTS;
    if (!value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0)) return DEFAULT_COLUMN_WEIGHTS;
    return [value[0] as number, value[1] as number, value[2] as number];
  } catch {
    return DEFAULT_COLUMN_WEIGHTS;
  }
}

export function saveWeights(weights: ColumnWeights): void {
  try {
    localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights));
  } catch { /* Storage can be unavailable; the drag still applies to this page. */ }
}
