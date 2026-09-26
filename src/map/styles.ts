/* MapLibre basemaps: keyless raster sources, defined as plain raster-source
 * specs so they can be swapped IN PLACE rather than via setStyle().
 *
 * Every basemap here must render without an API key (Terrain: see STADIA_KEY). CARTO withdrew keyless
 * access to basemaps.cartocdn.com and now paints "API KEY REQUIRED" into the
 * tile itself, so the three CARTO styles this file used to serve (Dark,
 * Streets, Light) returned HTTP 200 and a defaced image — including the
 * default (#77). Esri's Canvas services replace them from a provider the
 * file already depends on for Topographic and Satellite.
 *
 * Swapping the whole style (map.setStyle) tears down and rebuilds all GL
 * resources; in practice that left raster basemaps failing to re-fetch
 * their tiles after the first switch. Instead we keep one style for the
 * map's whole lifetime and only add/remove the basemap's raster
 * source+layer, which is faster (no flash) and avoids that teardown. */

import type { RasterDEMSourceSpecification, RasterSourceSpecification, StyleSpecification } from 'maplibre-gl';

const ESRI_CANVAS_ATTR =
  'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS User Community';
const ESRI_IMG_ATTR =
  'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics';
const ESRI_TOPO_ATTR =
  'Tiles &copy; Esri &mdash; Esri, USGS, NGA, NASA, & the GIS community';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const STADIA_ATTR =
  '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a> &copy; <a href="https://stamen.com/">Stamen Design</a> &copy; <a href="https://openmaptiles.org/">OpenMapTiles</a> &copy; OpenStreetMap contributors';

// Stadia (Stamen) tiles are keyless on localhost; production needs a free
// API key (or a domain allowlisted in the Stadia dashboard). Set
// VITE_STADIA_API_KEY at build time to embed a key.
const STADIA_KEY = import.meta.env.VITE_STADIA_API_KEY;

function esriTiles(service: string): string[] {
  return [
    `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
  ];
}

function usgsTiles(service: string): string[] {
  return [`https://basemap.nationalmap.gov/arcgis/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`];
}

/** MapLibre has no {s} subdomain token (Leaflet does): expand it. */
function abc(url: string): string[] {
  return ['a', 'b', 'c'].map((s) => url.replace('{s}', s));
}

function stadiaTiles(style: string): string[] {
  const suffix = STADIA_KEY ? `?api_key=${STADIA_KEY}` : '';
  // Retina @2x tiles (512px) for crispness. NB: MapLibre has no '{r}'
  // retina token (that's Leaflet) — it would be sent literally and 404.
  return [`https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}@2x.png${suffix}`];
}

/** A basemap is one or more stacked raster sources (e.g. imagery + labels).
 * Each entry's id is suffixed per-basemap so multiple never collide. */
export interface BasemapLayerSpec {
  source: RasterSourceSpecification;
}

export const BASEMAPS: Record<string, BasemapLayerSpec[]> = {
  // Esri's Canvas services are split base + reference (labels), so each is
  // stacked the way Satellite already stacks imagery + boundaries below.
  Dark: [
    { source: raster(esriTiles('Canvas/World_Dark_Gray_Base'), 256, ESRI_CANVAS_ATTR, 19) },
    { source: raster(esriTiles('Canvas/World_Dark_Gray_Reference'), 256, 'Labels &copy; Esri', 19) },
  ],
  Light: [
    { source: raster(esriTiles('Canvas/World_Light_Gray_Base'), 256, ESRI_CANVAS_ATTR, 19) },
    { source: raster(esriTiles('Canvas/World_Light_Gray_Reference'), 256, 'Labels &copy; Esri', 19) },
  ],
  // Replaces CARTO Voyager: the labelled street map for finding an address.
  Streets: [{ source: raster(esriTiles('World_Street_Map'), 256, ESRI_CANVAS_ATTR, 19) }],
  // Shaded-relief terrain (Stadia Stamen): keyless on localhost, needs a
  // key/domain allowlist in production. The no-key "Topographic" below is
  // the always-available terrain fallback.
  Terrain: [{ source: raster(stadiaTiles('stamen_terrain'), 512, STADIA_ATTR, 18) }],
  // No-key colored topographic with terrain shading (Esri).
  Topographic: [{ source: raster(esriTiles('World_Topo_Map'), 256, ESRI_TOPO_ATTR, 19) }],
  Satellite: [
    { source: raster(esriTiles('World_Imagery'), 256, ESRI_IMG_ATTR, 19) },
    { source: raster(esriTiles('Reference/World_Boundaries_and_Places'), 256, 'Labels &copy; Esri', 19) },
  ],
  // Free alternatives that often carry more detail in remote areas.
  // Contours + hillshade from SRTM over OSM data.
  OpenTopoMap: [{ source: raster(abc('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png'), 256, `${OSM_ATTR}, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`, 17) }],
  // OSM styled for villages/tracks/buildings (Humanitarian OSM Team).
  'OSM Humanitarian': [{ source: raster(abc('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png'), 256, `${OSM_ATTR}, tiles by <a href="https://www.hotosm.org/">HOT</a> hosted by OSM France`, 19) }],
  // USGS National Map (public domain); blank outside the US and territories.
  'USGS Topo (US)': [{ source: raster(usgsTiles('USGSTopo'), 256, 'USGS The National Map', 16) }],
  'USGS Imagery (US)': [{ source: raster(usgsTiles('USGSImageryOnly'), 256, 'USDA, USGS The National Map: Orthoimagery', 16) }],
  // Global 10 m cloud-free mosaic. The un-yeared layer is the 2016 edition
  // (CC-BY 4.0); the yearly 2017+ layers are non-commercial only.
  'Sentinel-2 (2016)': [{ source: raster(['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'], 256, '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016), CC-BY 4.0', 14) }],
};

/** Toggleable relief overlay drawn above any basemap, below coverage:
 * MapLibre's native hillshade (transparent shadows/highlights, so it darkens
 * relief without washing out the basemap) from AWS Terrain Tiles, the same
 * free bucket the engine reads SRTM from. */
const HILLSHADE_ID = 'overlay-hillshade';
const HILLSHADE_DEM: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  tileSize: 256,
  encoding: 'terrarium',
  maxzoom: 15,
  attribution: 'Hillshade: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>',
};

export function setHillshade(map: import('maplibre-gl').Map, on: boolean): void {
  if (map.getLayer(HILLSHADE_ID)) map.removeLayer(HILLSHADE_ID);
  if (map.getSource(HILLSHADE_ID)) map.removeSource(HILLSHADE_ID);
  if (!on) return;
  // Just above the basemap. applyBasemap inserts basemaps below the lowest
  // non-basemap layer (this one), so the overlay survives basemap switches.
  const beforeId = (map.getStyle().layers ?? []).find((l) => !l.id.startsWith(BASEMAP_PREFIX))?.id;
  map.addSource(HILLSHADE_ID, HILLSHADE_DEM);
  map.addLayer(
    { id: HILLSHADE_ID, type: 'hillshade', source: HILLSHADE_ID, paint: { 'hillshade-exaggeration': 0.5 } },
    beforeId
  );
}


function raster(
  tiles: string[],
  tileSize: number,
  attribution: string,
  maxzoom?: number
): RasterSourceSpecification {
  return { type: 'raster', tiles, tileSize, attribution, ...(maxzoom ? { maxzoom } : {}) };
}

/* Topographic, not a canvas style: a site planner is read against terrain,
 * and this is the one basemap that needs no key and shows relief. */
export const DEFAULT_BASEMAP = 'Topographic';

/** Stable id prefix for basemap sources/layers so they can be found+removed. */
export const BASEMAP_PREFIX = 'basemap-';

/** Minimal style; the actual basemap is applied in-place via applyBasemap. */
export function emptyStyle(): StyleSpecification {
  return { version: 8, sources: {}, layers: [] };
}

/**
 * Swap the basemap in place: remove any existing basemap source/layers and
 * add the requested one. Basemap layers are inserted BELOW everything else
 * (beforeId = the lowest non-basemap layer) so coverage overlays stay on top.
 */
export function applyBasemap(map: import('maplibre-gl').Map, name: string): void {
  const specs = BASEMAPS[name] ?? BASEMAPS[DEFAULT_BASEMAP];

  // Remove previous basemap layers + sources.
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.id.startsWith(BASEMAP_PREFIX)) map.removeLayer(layer.id);
  }
  for (const sourceId of Object.keys(map.getStyle().sources ?? {})) {
    if (sourceId.startsWith(BASEMAP_PREFIX)) map.removeSource(sourceId);
  }

  // First remaining (non-basemap) layer; new basemap layers go beneath it.
  const beforeId = (map.getStyle().layers ?? []).find(
    (l) => !l.id.startsWith(BASEMAP_PREFIX)
  )?.id;

  specs.forEach((spec, i) => {
    const id = `${BASEMAP_PREFIX}${i}`;
    map.addSource(id, spec.source);
    map.addLayer({ id, type: 'raster', source: id }, beforeId);
  });
}
