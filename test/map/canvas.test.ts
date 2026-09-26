import { describe, it, expect } from 'vitest';

import { cornersOf, scaleFromCorner } from '../../src/map/canvas';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 9);
  expect(a.y).toBeCloseTo(b.y, 9);
};

describe('canvas geometry', () => {
  it('builds TL, TR, BR, BL corners, rotated about the center', () => {
    const c = cornersOf({ x: 0, y: 0 }, 4, 2, 0); // 4 x 2
    close(c[0], { x: -2, y: -1 });
    close(c[2], { x: 2, y: 1 });
    const r = cornersOf({ x: 0, y: 0 }, 4, 2, Math.PI / 2); // quarter turn clockwise
    close(r[0], { x: 1, y: -2 });
  });

  it('scales from any corner at any angle with the opposite corner fixed and the ratio locked', () => {
    for (const angle of [0, 0.3, Math.PI / 2, -2.1]) {
      for (let i = 0; i < 4; i++) {
        const start = cornersOf({ x: 10, y: 5 }, 4, 2, angle);
        const anchor = start[(i + 2) % 4];
        const pointer = { x: start[i].x + 1.3, y: start[i].y - 0.7 };
        const s = scaleFromCorner(anchor, pointer, i, angle, 2, 0.01);
        const after = cornersOf(s.center, s.width, 2, angle);
        close(after[(i + 2) % 4], anchor);
        const w = Math.hypot(after[1].x - after[0].x, after[1].y - after[0].y);
        const h = Math.hypot(after[3].x - after[0].x, after[3].y - after[0].y);
        expect(w / h).toBeCloseTo(2, 9);
      }
    }
  });

  it('never flips or collapses below the minimum width', () => {
    const s = scaleFromCorner({ x: 0, y: 0 }, { x: -5, y: -5 }, 2, 0, 1, 0.5); // BR dragged past TL
    expect(s.width).toBe(0.5);
  });
});
