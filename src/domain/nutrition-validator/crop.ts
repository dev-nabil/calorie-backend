import type { CropRect } from '../../shared';

/** Share of the food box added on every side, so the whole vessel (rim, handles) is inside the crop. */
const MARGIN = 0.1;
/** A crop never shows less than this share of the photo's width or height: a small box would blow up a low-resolution photo. */
const MIN_SHARE = 0.45;
/** A crop this close to the whole photo is not worth making. */
const WHOLE_SHARE = 0.9;
/** Smaller boxes are a model slip, not food. */
const MIN_BOX = 0.06;

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Grows `[start, start + size]` to at least `min`, around its centre, then slides it back inside 0 to 1. */
function span(start: number, size: number, min: number): [number, number] {
  const length = Math.min(1, Math.max(size, min));
  const from = clamp(start + size / 2 - length / 2, 0, 1 - length);
  return [from, length];
}

/**
 * The model's food box (`[ymin, xmin, ymax, xmax]`, 0 to 1000) as the part of the photo to show: the box plus a margin,
 * never tighter than MIN_SHARE, and null when the box is unusable or the photo is already about the food. The apps widen
 * the crop to the shape they draw it in, so it only has to contain the food and its whole vessel.
 */
export function cropFromBox(box: readonly number[] | null | undefined): CropRect | null {
  if (!box || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const [y0, x0, y1, x1] = box.map((v) => clamp(v, 0, 1000) / 1000) as [number, number, number, number];
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < MIN_BOX || h < MIN_BOX) return null;
  const [x, cw] = span(x0 - w * MARGIN, w * (1 + 2 * MARGIN), MIN_SHARE);
  const [y, ch] = span(y0 - h * MARGIN, h * (1 + 2 * MARGIN), MIN_SHARE);
  if (cw >= WHOLE_SHARE && ch >= WHOLE_SHARE) return null;
  return { x: round3(x), y: round3(y), w: round3(cw), h: round3(ch) };
}
