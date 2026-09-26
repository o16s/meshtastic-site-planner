/* LoRa receiver sensitivity by chip and modem setting (spreading factor +
 * bandwidth), from the chip datasheets, for the Receiver "Device"/"Modem"
 * quick-fill.
 *
 * - SX1262: Semtech SX1261/2 DS Rev 1.2, RXS_LB (RX boosted gain) publishes
 *   only SF7 and SF12 at 125/250/500 kHz. SF8-SF11 are interpolated from the
 *   SF7 point with the datasheet's demodulator SNR table (-2.5 dB per SF
 *   step); that reproduces the published SF12 points within 0.5 dB.
 * - LSM100A: SJI datasheet table 3-4-2-1, full SF7-SF12 x 125/250/500 kHz.
 * - Bandwidths outside the tables (62.5 kHz) scale from 125 kHz by
 *   10*log10(bw/125), the thermal-noise bandwidth term.
 * Anything not read straight off a table is flagged as an estimate. */

export type Chip = 'sx1262' | 'lsm100a';

type Table = Record<number, Partial<Record<number, number>>>; // bwKHz -> sf -> dBm

const TABLES: Record<Chip, Table> = {
  sx1262: {
    125: { 7: -124, 12: -137 },
    250: { 7: -121, 12: -134 },
    500: { 7: -117, 12: -129 },
  },
  lsm100a: {
    125: { 7: -123, 8: -126, 9: -128, 10: -131, 11: -134, 12: -136 },
    250: { 7: -120, 8: -122, 9: -125, 10: -128, 11: -131, 12: -132 },
    500: { 7: -115, 8: -118, 9: -121, 10: -123, 11: -125, 12: -128 },
  },
};

const SNR_STEP_DB = 2.5; // demodulator SNR per SF step (SX1261/2 DS 6.1.1.1)

export function sensitivityDbm(chip: Chip, sf: number, bwKHz: number): { dbm: number; estimate: boolean } {
  const table = TABLES[chip];
  const exact = table[bwKHz]?.[sf];
  if (exact !== undefined) return { dbm: exact, estimate: false };
  if (table[bwKHz]) {
    const sf7 = table[bwKHz][7]!; // every table row has SF7
    return { dbm: sf7 - SNR_STEP_DB * (sf - 7), estimate: true };
  }
  const at125 = sensitivityDbm(chip, sf, 125).dbm;
  return { dbm: at125 + 10 * Math.log10(bwKHz / 125), estimate: true };
}

export interface Modem {
  label: string;
  group: 'Meshtastic' | 'LoRa';
  sf: number;
  bwKHz: number;
}

export const MODEMS: Modem[] = [
  ...(
    [
      ['SHORT_TURBO', 7, 500],
      ['SHORT_FAST', 7, 250],
      ['SHORT_SLOW', 8, 250],
      ['MEDIUM_FAST', 9, 250],
      ['MEDIUM_SLOW', 10, 250],
      ['LONG_FAST', 11, 250],
      ['LONG_MODERATE', 11, 125],
      ['LONG_SLOW', 12, 125],
      ['VERY_LONG_SLOW', 12, 62.5],
    ] as const
  ).map(([name, sf, bwKHz]) => ({ label: `${name} (SF${sf} / ${bwKHz} kHz)`, group: 'Meshtastic' as const, sf, bwKHz })),
  ...[125, 250, 500].flatMap((bwKHz) =>
    [7, 8, 9, 10, 11, 12].map((sf) => ({ label: `SF${sf} / ${bwKHz} kHz`, group: 'LoRa' as const, sf, bwKHz }))
  ),
];
