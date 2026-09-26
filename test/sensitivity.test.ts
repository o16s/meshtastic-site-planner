import { describe, it, expect } from 'vitest';

import { MODEMS, sensitivityDbm } from '../src/sensitivity';

describe('sensitivityDbm', () => {
  it('returns SX1262 published points exactly', () => {
    expect(sensitivityDbm('sx1262', 7, 125)).toEqual({ dbm: -124, estimate: false });
    expect(sensitivityDbm('sx1262', 12, 125)).toEqual({ dbm: -137, estimate: false });
    expect(sensitivityDbm('sx1262', 12, 500)).toEqual({ dbm: -129, estimate: false }); // = LSM110A's published figure
  });

  it('interpolates SX1262 SF8-SF11 with the -2.5 dB/SF demodulator SNR step', () => {
    expect(sensitivityDbm('sx1262', 10, 125)).toEqual({ dbm: -131.5, estimate: true });
    expect(sensitivityDbm('sx1262', 11, 250)).toEqual({ dbm: -131, estimate: true }); // Meshtastic LONG_FAST
  });

  it('uses the full LSM100A table verbatim', () => {
    expect(sensitivityDbm('lsm100a', 11, 250)).toEqual({ dbm: -131, estimate: false });
    expect(sensitivityDbm('lsm100a', 12, 125)).toEqual({ dbm: -136, estimate: false });
  });

  it('scales bandwidths outside the tables from 125 kHz and flags them', () => {
    const r = sensitivityDbm('sx1262', 12, 62.5); // Meshtastic VERY_LONG_SLOW
    expect(r.dbm).toBeCloseTo(-140, 1);
    expect(r.estimate).toBe(true);
  });

  it('resolves every modem for both chips', () => {
    expect(MODEMS).toHaveLength(9 + 18);
    for (const chip of ['sx1262', 'lsm100a'] as const)
      for (const m of MODEMS) expect(Number.isFinite(sensitivityDbm(chip, m.sf, m.bwKHz).dbm)).toBe(true);
  });
});
