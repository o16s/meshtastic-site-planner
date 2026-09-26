import { describe, it, expect } from 'vitest';

import { fitRect } from '../../src/map/canvas';

const size = (r: ReturnType<typeof fitRect>) => ({ w: r[1].x - r[0].x, h: r[3].y - r[0].y });

describe('fitRect (canvas corner scaling)', () => {
  it('keeps the anchor fixed and the aspect locked', () => {
    const r = fitRect({ x: 100, y: 100 }, { x: 300, y: 150 }, 2);
    expect(r[0]).toEqual({ x: 100, y: 100 }); // anchor stays the TL corner
    expect(size(r)).toEqual({ w: 200, h: 100 });
  });

  it('sizes from the larger drag extent (mostly vertical drag)', () => {
    const r = fitRect({ x: 0, y: 0 }, { x: 10, y: 100 }, 2);
    expect(size(r)).toEqual({ w: 200, h: 100 });
  });

  it('mirrors when dragged up and left of the anchor', () => {
    const r = fitRect({ x: 500, y: 500 }, { x: 300, y: 480 }, 2);
    expect(r[2]).toEqual({ x: 500, y: 500 }); // anchor is now the BR corner
    expect(size(r)).toEqual({ w: 200, h: 100 });
  });

  it('never collapses below the minimum width', () => {
    const r = fitRect({ x: 0, y: 0 }, { x: 1, y: 1 }, 1);
    expect(size(r)).toEqual({ w: 20, h: 20 });
  });
});
