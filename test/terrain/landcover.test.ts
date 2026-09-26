import { describe, it, expect } from 'vitest';

import { UNKNOWN, classToClutter, toPageOrder } from '../../src/terrain/landcover';

describe('land cover -> clutter', () => {
  it('maps classes to heights; clouds and no-data are unknown', () => {
    expect(classToClutter(2, 17)).toBe(17); // trees -> tree height setting
    expect(classToClutter(8, 17)).toBe(0); // bare ground / lava
    expect(classToClutter(1, 17)).toBe(0); // water
    expect(classToClutter(11, 17)).toBe(1); // rangeland
    expect(classToClutter(7, 17)).toBe(8); // built area
    expect(classToClutter(10, 17)).toBe(UNKNOWN); // clouds
    expect(classToClutter(0, 17)).toBe(UNKNOWN); // no data
    expect(classToClutter(2, 999)).toBe(254); // never collides with UNKNOWN
  });

  it('reorders image rows (N->S, W->E) into page order (x S->N, y E->W)', () => {
    const n = 3;
    const img = new Uint8Array(n * n).map((_, i) => i); // img[r*n + c]
    const page = toPageOrder(img);
    // NW image corner (r=0, c=0) -> page cell x = n-1 (north), y = n-1 (west)
    expect(page[(n - 1) * n + (n - 1)]).toBe(img[0]);
    // SE image corner (r=n-1, c=n-1) -> page cell x = 0 (south), y = 0 (east)
    expect(page[0]).toBe(img[n * n - 1]);
  });
});
