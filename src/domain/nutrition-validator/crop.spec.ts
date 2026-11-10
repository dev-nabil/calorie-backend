import { cropFromBox } from './crop';

const contains = (c: { x: number; y: number; w: number; h: number }, box: [number, number, number, number]) => {
  const [y0, x0, y1, x1] = box.map((v) => v / 1000) as [number, number, number, number];
  const eps = 0.0011;
  return c.x <= x0 + eps && c.y <= y0 + eps && c.x + c.w >= x1 - eps && c.y + c.h >= y1 - eps;
};

describe('cropFromBox', () => {
  it('adds a margin on every side so the whole vessel is inside', () => {
    const box: [number, number, number, number] = [300, 250, 700, 750];
    const c = cropFromBox(box)!;
    expect(c).toEqual({ x: 0.2, y: 0.26, w: 0.6, h: 0.48 });
    expect(contains(c, box)).toBe(true);
  });

  it('keeps a box that touches the photo edge inside the photo', () => {
    const box: [number, number, number, number] = [550, 0, 998, 1000];
    const c = cropFromBox(box)!;
    expect(c.x).toBe(0);
    expect(c.x + c.w).toBeLessThanOrEqual(1);
    expect(c.y + c.h).toBeLessThanOrEqual(1);
    expect(contains(c, box)).toBe(true);
  });

  it('never zooms in past 45 % of the photo, and slides back inside at an edge', () => {
    const c = cropFromBox([20, 20, 180, 180])!; // a small corner box
    expect(c.w).toBeGreaterThanOrEqual(0.45);
    expect(c.h).toBeGreaterThanOrEqual(0.45);
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(contains(c, [20, 20, 180, 180])).toBe(true);
  });

  it('returns null when the photo is already about the food', () => {
    expect(cropFromBox([0, 0, 1000, 1000])).toBeNull();
    expect(cropFromBox([30, 40, 960, 950])).toBeNull();
  });

  it('keeps a wide box in a tall crop that still shows it all', () => {
    const box: [number, number, number, number] = [420, 50, 640, 960];
    const c = cropFromBox(box)!;
    expect(c.h).toBeGreaterThanOrEqual(0.45);
    expect(contains(c, box)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['short', [1, 2, 3]],
    ['long', [1, 2, 3, 4, 5]],
    ['not numbers', [0, 0, Number.NaN, 5]],
    ['inverted', [700, 700, 300, 300]],
    ['a sliver', [500, 500, 520, 900]],
  ])('returns null for %s', (_name, box) => {
    expect(cropFromBox(box as number[] | null | undefined)).toBeNull();
  });

  it('clamps values the model put outside 0 to 1000', () => {
    const c = cropFromBox([-40, 200, 1300, 800])!;
    expect(c).not.toBeNull();
    expect(c.y).toBe(0);
    expect(c.y + c.h).toBeLessThanOrEqual(1);
  });
});
