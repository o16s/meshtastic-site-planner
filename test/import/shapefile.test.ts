import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { importShapefileZip, toWgs84 } from '../../src/import/shapefile';

/* Synthetic, anonymised ArcGIS-style point export (Web Mercator .prj,
 * scientific-notation dBASE floats, one deleted row, mixed-case extensions). */
function fixture(): ArrayBuffer {
  const b = readFileSync(new URL('../fixtures/sample-sites.zip', import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

describe('importShapefileZip', () => {
  it('reads points, converts Web Mercator to WGS 84, and skips deleted rows', async () => {
    const { points, skipped } = await importShapefileZip(fixture());
    expect(points).toHaveLength(7);
    expect(skipped).toBe(1);
    const s5 = points.find((p) => p.name === 'Site 5')!; // Identity_ "5.00000e+00"
    expect(s5.lat).toBeCloseTo(51.1, 6);
    expect(s5.lon).toBeCloseTo(-114.1, 6);
    for (const p of points) {
      expect(p.lat).toBeGreaterThan(51.08);
      expect(p.lat).toBeLessThan(51.12);
      expect(p.lon).toBeGreaterThan(-114.13);
      expect(p.lon).toBeLessThan(-114.08);
    }
    expect(points.map((p) => p.name).sort()).toEqual(['Site 1', 'Site 2', 'Site 3', 'Site 4', 'Site 5', 'Site 6', 'Site 7']);
  });

  it('rejects coordinate systems it cannot convert, showing the WKT', () => {
    const utm = 'PROJCS["WGS_1984_UTM_Zone_5N",GEOGCS["GCS_WGS_1984"],PROJECTION["Transverse_Mercator"]]';
    expect(() => toWgs84(utm)).toThrow(/UTM_Zone_5N/);
  });
});
