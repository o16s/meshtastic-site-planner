/* Land-cover clutter in the engine (per-page clutter grids):
 *  - a clutter grid filled with v is bit-identical to uniform clutter v
 *  - an all-unknown (255) grid falls back to the uniform clutter exactly
 *  - partial canopy lands between no clutter and full canopy
 *  - the point-to-point profile reports the clutter it used (none on the ends)
 */

import { describe, expect, it } from 'vitest';

import createSplatModule from '../../src/engine/generated/splat_driver.mjs';
import { CLUTTER_IPPD, EngineContext, runCoverageSlice } from '../../src/engine/core';
import { toEngineParams } from '../../src/engine/params';
import { loadCase, loadPageData } from '../helpers';

const modulePromise = createSplatModule();
const CELLS = CLUTTER_IPPD * CLUTTER_IPPD;

async function sweep(clutterHeightM: number, fill?: (i: number) => Uint8Array | null) {
  const m = await modulePromise;
  const params = { ...toEngineParams(loadCase('london_15km'), { legacyTxHeightAsFeet: true }), clutterHeightM };
  const ctx = EngineContext.create(m, params);
  const refs = ctx.pages();
  ctx.destroy();
  const pages = refs.map(loadPageData);
  const clutter = fill ? refs.map((_, i) => (pages[i] ? fill(i) : null)) : [];
  return runCoverageSlice(m, params, pages, { chunk: 1024 }, clutter);
}

const covered = (r: { mask: Uint8Array; signal: Uint8Array }, dbm = -100) =>
  r.signal.reduce((n, s, i) => n + ((r.mask[i] & 248) !== 0 && s - 200 >= dbm ? 1 : 0), 0);

describe('land-cover clutter', () => {
  it('a grid of 10 m everywhere equals uniform 10 m clutter (bit-identical)', async () => {
    const uniform = await sweep(10);
    const grid = await sweep(0, () => new Uint8Array(CELLS).fill(10));
    expect(Buffer.from(grid.signal).equals(Buffer.from(uniform.signal))).toBe(true);
    expect(Buffer.from(grid.mask).equals(Buffer.from(uniform.mask))).toBe(true);
  }, 120000);

  it('unknown cells (255) fall back to the uniform clutter exactly', async () => {
    const uniform = await sweep(3);
    const unknown = await sweep(3, () => new Uint8Array(CELLS).fill(255));
    expect(Buffer.from(unknown.signal).equals(Buffer.from(uniform.signal))).toBe(true);
  }, 120000);

  it('partial canopy sits between bare ground and full canopy', async () => {
    const bare = covered(await sweep(0));
    const full = covered(await sweep(0, () => new Uint8Array(CELLS).fill(20)));
    const half = covered(
      await sweep(0, () => {
        const c = new Uint8Array(CELLS);
        c.fill(20, 0, CELLS / 2); // southern half of every page
        return c;
      })
    );
    expect(full).toBeLessThan(bare);
    expect(half).toBeLessThan(bare);
    expect(half).toBeGreaterThan(full);
  }, 240000);

  it('the link profile carries the clutter used, none on the endpoints', async () => {
    const m = await modulePromise;
    const params = { ...toEngineParams(loadCase('london_15km')), clutterHeightM: 0 };
    const ctx = EngineContext.create(m, params);
    try {
      ctx.pages().forEach((ref, i) => {
        const data = loadPageData(ref);
        if (data) {
          ctx.loadPage(i, data);
          ctx.loadClutter(i, new Uint8Array(CELLS).fill(12));
        }
      });
      const link = ctx.pointToPoint(params.lat + 0.05, params.lon + 0.05, 5);
      const p = link.profile;
      expect(p[0].clutterM).toBe(0);
      expect(p[p.length - 1].clutterM).toBe(0);
      const interior = p.slice(1, -1).filter((q) => q.groundM !== 0);
      expect(interior.length).toBeGreaterThan(0);
      for (const q of interior) expect(q.clutterM).toBeCloseTo(12, 6);
    } finally {
      ctx.destroy();
    }
  });
});
