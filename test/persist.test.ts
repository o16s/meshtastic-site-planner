import { describe, it, expect } from 'vitest';

import { mergeParams, parseWorkspace } from '../src/persist';
import type { SplatParams } from '../src/types';

function defaults(): SplatParams {
  return {
    transmitter: { name: 'Default', tx_lat: 51, tx_lon: -114, tx_power: 0.1, tx_freq: 907, tx_height: 2, tx_gain: 2 },
    receiver: { rx_sensitivity: -130, rx_height: 1, rx_gain: 2, rx_loss: 2 },
    environment: { radio_climate: 'continental_temperate', polarization: 'vertical', clutter_height: 1, ground_dielectric: 15, ground_conductivity: 0.005, atmosphere_bending: 301 },
    simulation: { situation_fraction: 95, time_fraction: 95, simulation_extent: 30, high_resolution: false },
    display: { color_scale: 'plasma', min_dbm: -130, max_dbm: -80, overlay_transparency: 50 },
  };
}

describe('mergeParams', () => {
  it('overlays saved values onto the defaults', () => {
    const saved = { transmitter: { tx_lat: 40, tx_lon: -100, tx_power: 1 } };
    const merged = mergeParams(defaults(), saved);
    expect(merged.transmitter.tx_lat).toBe(40);
    expect(merged.transmitter.tx_power).toBe(1);
    // Untouched fields keep their defaults.
    expect(merged.transmitter.tx_freq).toBe(907);
    expect(merged.receiver.rx_sensitivity).toBe(-130);
  });

  it('fills a missing section from the defaults', () => {
    const merged = mergeParams(defaults(), { display: { min_dbm: -120 } });
    expect(merged.display.min_dbm).toBe(-120);
    expect(merged.display.color_scale).toBe('plasma'); // default kept
    expect(merged.simulation.simulation_extent).toBe(30); // whole section defaulted
  });

  it.each([null, undefined, 42, 'oops', []])('returns defaults for malformed input %s', (bad) => {
    expect(mergeParams(defaults(), bad)).toEqual(defaults());
  });

  it('ignores an array where a section object is expected', () => {
    const merged = mergeParams(defaults(), { receiver: [1, 2, 3] });
    expect(merged.receiver).toEqual(defaults().receiver);
  });
});

describe('parseWorkspace', () => {
  it('keeps valid receivers and canvas settings', () => {
    const w = parseWorkspace({
      receivers: [{ lat: 51.1, lon: -114.1, name: 'Site 5' }, { lat: 51.2, lon: -114.2 }],
      canvas: { name: 'plan.png', opacity: 40, locked: true, geom: { center: { x: 0.2, y: 0.3 }, width: 1e-4, angle: 0.5 } },
    });
    expect(w.receivers).toEqual([{ lat: 51.1, lon: -114.1, name: 'Site 5' }, { lat: 51.2, lon: -114.2 }]);
    expect(w.canvas).toEqual({ name: 'plan.png', opacity: 40, locked: true, geom: { center: { x: 0.2, y: 0.3 }, width: 1e-4, angle: 0.5 } });
  });

  it('drops malformed entries instead of failing', () => {
    const w = parseWorkspace({
      receivers: [{ lat: 'x', lon: 1 }, null, { lat: 1, lon: 2 }],
      canvas: { name: 'a.jpg', opacity: 500, geom: { center: { x: 1 }, width: -1, angle: 0 } },
    });
    expect(w.receivers).toEqual([{ lat: 1, lon: 2 }]);
    expect(w.canvas).toEqual({ name: 'a.jpg', opacity: 100, locked: false, geom: null });
    expect(parseWorkspace('garbage')).toEqual({ receivers: [], canvas: null });
  });
});
