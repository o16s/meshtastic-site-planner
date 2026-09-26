/* Land-cover clutter: per-cell clutter heights for an engine page from the
 * Esri Living Atlas "Sentinel-2 10m Land Use/Land Cover" image service
 * (Impact Observatory, Microsoft, Esri; CC BY 4.0). ESA WorldCover would be
 * the other obvious source, but its S3 bucket sends no CORS headers.
 *
 * The service resamples server-side (nearest neighbour) to exactly the
 * engine's clutter grid, so one request per 1-degree page returns raw U8
 * class codes. Land cover at 3 arc-seconds (~90 m) also serves HD runs:
 * clutter doesn't need 30 m. */

import type { PageRef } from '../engine/core';
import { CLUTTER_IPPD } from '../engine/core';
import { pageSignedFloorLon } from './srtm';

export const LANDCOVER_ATTRIBUTION = 'Land cover © Impact Observatory, Microsoft, Esri (CC BY 4.0)';

const SERVICE = 'https://ic.imagery1.arcgis.com/arcgis/rest/services/Sentinel2_10m_LandCover/ImageServer';
/** Engine marker: no land-cover information here, use the uniform clutter. */
export const UNKNOWN = 255;

/** Clutter height (m) per land-cover class; clouds and no-data are unknown.
 * The tree height is the user's setting (SRTM already contains part of a
 * dense canopy, so it is a clutter *above* the terrain data, not the full
 * tree height). */
export function classToClutter(cls: number, treeHeightM: number): number {
  switch (cls) {
    case 1: // water
    case 8: // bare ground (lava, rock)
    case 9: // snow / ice
      return 0;
    case 2: // trees
      return Math.max(0, Math.min(254, Math.round(treeHeightM)));
    case 4: // flooded vegetation
      return 2;
    case 5: // crops
    case 11: // rangeland
      return 1;
    case 7: // built area (low-rise average)
      return 8;
    default: // 0 no data, 10 clouds
      return UNKNOWN;
  }
}

/** Image order (rows north->south, columns west->east) to the engine's page
 * order (x south->north, y east->west): for an image spanning exactly the page
 * this is a reversal (half-cell offset, well under the clutter's precision). */
export function toPageOrder(img: Uint8Array): Uint8Array {
  return img.slice().reverse();
}

// Raw class bytes per page for the session, so a tree-height change doesn't
// refetch. ponytail: memory only; add Cache API persistence like terrain if
// repeat visits to the same area make the ~1.4 MB/page download matter.
const classCache = new Map<string, Promise<Uint8Array>>();

async function fetchClasses(ref: PageRef, signal?: AbortSignal): Promise<Uint8Array> {
  const n = CLUTTER_IPPD;
  const west = pageSignedFloorLon(ref.minWest);
  const south = ref.minNorth;
  const url =
    `${SERVICE}/exportImage?f=image&format=bsq&interpolation=RSP_NearestNeighbor` +
    `&bbox=${west},${south},${west + 1},${south + 1}&bboxSR=4326&imageSR=4326&size=${n},${n}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`land cover HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // The band is followed by a validity mask; an error comes back as short JSON.
  if (bytes.length < n * n) throw new Error('land cover: unexpected response');
  return toPageOrder(bytes.subarray(0, n * n));
}

/** Clutter heights for one engine page (CLUTTER_IPPD^2 bytes, page order). */
export async function landCoverPage(ref: PageRef, treeHeightM: number, signal?: AbortSignal): Promise<Uint8Array> {
  const key = `${ref.minNorth}:${ref.minWest}`;
  let classes = classCache.get(key);
  if (!classes) {
    classes = fetchClasses(ref, signal);
    classCache.set(key, classes);
    classes.catch(() => classCache.delete(key)); // retry next time
  }
  const cls = await classes;
  const table = new Uint8Array(256);
  for (let c = 0; c < 256; c++) table[c] = classToClutter(c, treeHeightM);
  return cls.map((c) => table[c]);
}
