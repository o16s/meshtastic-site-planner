import { describe, it, expect } from 'vitest';

import { cornersOf, fitSimilarity, scaleFromCorner } from '../../src/map/canvas';

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

describe('fitSimilarity (three-point calibration)', () => {
  // A known placement: image center at (0.4, 0.3), width 0.02, rotated 0.7 rad.
  const truth = { center: { x: 0.4, y: 0.3 }, width: 0.02, angle: 0.7 };
  const place = (p: { x: number; y: number }) => {
    const [c, s] = [Math.cos(truth.angle), Math.sin(truth.angle)];
    return { x: truth.center.x + truth.width * (c * p.x - s * p.y), y: truth.center.y + truth.width * (s * p.x + c * p.y) };
  };
  const img = [{ x: -0.4, y: -0.1 }, { x: 0.35, y: -0.2 }, { x: 0.1, y: 0.3 }];

  it('recovers scale, rotation and translation exactly from 3 clean pairs', () => {
    const f = fitSimilarity(img, img.map(place));
    expect(f.center.x).toBeCloseTo(0.4, 12);
    expect(f.center.y).toBeCloseTo(0.3, 12);
    expect(f.width).toBeCloseTo(0.02, 12);
    expect(f.angle).toBeCloseTo(0.7, 12);
    for (const r of f.residuals) expect(r).toBeLessThan(1e-12);
  });

  it('spreads a bad click as a least-squares compromise with a visible residual', () => {
    const world = img.map(place);
    world[2] = { x: world[2].x + 0.001, y: world[2].y }; // one misclick
    const f = fitSimilarity(img, world);
    expect(f.width).toBeCloseTo(0.02, 2);
    expect(Math.max(...f.residuals)).toBeGreaterThan(1e-4);
  });
});
