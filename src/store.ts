import { defineStore } from 'pinia';
// import { useLocalStorage } from '@vueuse/core';
import { randanimalSync } from 'randanimal';
import maplibregl from 'maplibre-gl';
import { type Site, type SplatParams } from './types.ts';
import { cloneObject } from './utils.ts';
import { draftPinElement, sitePinElement, targetPinElement } from './layers.ts';
import { BASEMAPS, DEFAULT_BASEMAP, applyBasemap, emptyStyle, setHillshade, setSigfox } from './map/styles.ts';
import { BasemapControl, ExportControl, MeasureControl } from './map/controls.ts';
import { SearchControl } from './map/search.ts';
import { CanvasCalibration, CanvasOverlay, drawerInset } from './map/canvas.ts';
import { coverageImage, cropToRadius } from './map/overlay.ts';
import { coverageContours } from './map/contours.ts';
import { canShareFiles, exportGeoJSON, exportKml, exportPngWorldFile, postCoverageToBridge, shareGeoJSON } from './map/export.ts';
import type { WasmCoverageEngine } from './engine/WasmCoverageEngine.ts';
import type { CoverageProgress } from './engine/CoverageEngine.ts';
import { toEngineParams, type CoverageRequest, METERS_PER_FOOT, MAX_RADIUS_METERS } from './engine/params.ts';
import { analyzeLink, linkColor, type LinkAnalysis } from './engine/link.ts';
import {
  loadCanvasImage,
  loadParams,
  loadView,
  loadWorkspace,
  mergeParams,
  saveCanvasImage,
  saveParams,
  saveView,
  type CanvasGeom,
} from './persist.ts';
import {
  decodeSharedHash,
  decodeSharedQuery,
  sharedRunRequested,
  buildShareUrl,
  clearSharedHash,
  clearSharedQuery,
} from './permalink.ts';
import { coverageStats } from './coverageStats.ts';
import { TerrainService } from './terrain/TerrainService.ts';

// Module-level singletons: workers, terrain cache, and map handles outlive
// store hot-reloads and never need to be reactive.
let engine: WasmCoverageEngine | undefined;
let terrain: TerrainService | undefined;
let abortController: AbortController | undefined;
let map: maplibregl.Map | undefined;
let currentMarker: maplibregl.Marker | undefined;
const siteMarkers = new Map<string, maplibregl.Marker>();
// Active only while "place on map" is armed.
let placeEscHandler: ((e: KeyboardEvent) => void) | undefined;
let placeClickHandler: ((e: maplibregl.MapMouseEvent) => void) | undefined;
// Point-to-point link mode (#14): receiver markers (same order as
// store.receivers), arming handlers, in-flight run.
let rxMarkers: maplibregl.Marker[] = [];
let linkEscHandler: ((e: KeyboardEvent) => void) | undefined;
let linkClickHandler: ((e: maplibregl.MapMouseEvent) => void) | undefined;
let linkAbort: AbortController | undefined;
const LINK_LINE_ID = 'mt-p2p-link';
// Measure/ruler tool (#15).
let measureControl: MeasureControl | undefined;
let measureClickHandler: ((e: maplibregl.MapMouseEvent) => void) | undefined;
let measureEscHandler: ((e: KeyboardEvent) => void) | undefined;
// Canvas: one user image overlay + its blob URL.
let canvas: CanvasOverlay | undefined;
let canvasUrl: string | undefined;
let calibration: CanvasCalibration | undefined;
let calibEscHandler: ((e: KeyboardEvent) => void) | undefined;
let measureA: { lat: number; lon: number } | null = null;
const MEASURE_SRC = 'mt-measure';

/** Wrap a longitude into [-180, 180). */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Great-circle distance in km (for sizing the link's terrain region). */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from A to B, degrees (0 = north, clockwise). */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Lazily import the WASM engine so it (and the wasm glue) stays out of the
// initial bundle — it's only needed once the user runs a simulation, link, or
// highpoint search (#16, code-split).
async function getEngine(): Promise<WasmCoverageEngine> {
  if (!engine) {
    const { WasmCoverageEngine } = await import('./engine/WasmCoverageEngine.ts');
    engine = new WasmCoverageEngine();
  }
  return engine;
}

function getTerrain(): TerrainService {
  terrain ??= new TerrainService();
  return terrain;
}

/** Map popup DOM for a simulated site: parameters + georeferenced export
 * buttons (#64). Built as a DOM element so the export buttons can be wired
 * directly. */
function buildSitePopup(site: Site): HTMLElement {
  const t = site.params.transmitter;
  const s = site.stats;
  const km2 = s.areaKm2 >= 100 ? String(Math.round(s.areaKm2)) : s.areaKm2.toFixed(1);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const el = document.createElement('div');
  el.className = 'mt-popup';
  el.innerHTML = `
    <div class="mt-popup-title">${esc(t.name)}</div>
    <div class="mt-popup-row"><span>Frequency</span><span>${t.tx_freq} MHz</span></div>
    <div class="mt-popup-row"><span>Power</span><span>${t.tx_power} W</span></div>
    <div class="mt-popup-row"><span>Antenna height</span><span>${t.tx_height} m</span></div>
    <div class="mt-popup-row"><span>Plot radius</span><span>${site.params.simulation.simulation_extent} km</span></div>
    <div class="mt-popup-row"><span>Coverage (≥ ${s.thresholdDbm} dBm)</span><span>${km2} km²</span></div>
    <div class="mt-popup-row"><span>Max usable range</span><span>${s.maxRangeKm.toFixed(1)} km</span></div>
    <div class="mt-popup-row"><span>Disk covered</span><span>${Math.round(s.coveredFraction * 100)}%</span></div>
    <div class="mt-popup-export">
      <span>Export</span>
      <button type="button" data-fmt="geojson">GeoJSON</button>
      <button type="button" data-fmt="png">PNG</button>
      <button type="button" data-fmt="kml">KML</button>
      ${canShareFiles() ? '<button type="button" data-fmt="share">Send to App</button>' : ''}
    </div>`;
  el.querySelectorAll<HTMLButtonElement>('button[data-fmt]').forEach((b) =>
    b.addEventListener('click', () => {
      const fmt = b.dataset.fmt;
      if (fmt === 'geojson') exportGeoJSON(site);
      else if (fmt === 'png') void exportPngWorldFile(site);
      else if (fmt === 'kml') void exportKml(site);
      else if (fmt === 'share') void shareGeoJSON(site);
    })
  );
  return el;
}

/** The legacy /predict payload shape, now consumed locally. */
function buildCoverageRequest(p: SplatParams): CoverageRequest {
  return {
    lat: p.transmitter.tx_lat,
    lon: p.transmitter.tx_lon,
    tx_height: p.transmitter.tx_height,
    tx_power: 10 * Math.log10(p.transmitter.tx_power) + 30, // W -> dBm
    tx_gain: p.transmitter.tx_gain,
    system_loss: p.receiver.rx_loss,
    frequency_mhz: p.transmitter.tx_freq,
    rx_height: p.receiver.rx_height,
    clutter_height: p.environment.clutter_height,
    ground_dielectric: p.environment.ground_dielectric,
    ground_conductivity: p.environment.ground_conductivity,
    atmosphere_bending: p.environment.atmosphere_bending,
    radio_climate: p.environment.radio_climate,
    polarization: p.environment.polarization,
    radius: p.simulation.simulation_extent * 1000, // km -> m
    situation_fraction: p.simulation.situation_fraction,
    time_fraction: p.simulation.time_fraction,
    high_resolution: p.simulation.high_resolution,
  };
}

/** Fresh factory-default site parameters (new object each call so callers
 * never share nested references; the site name is randomized per call). */
function defaultParams(): SplatParams {
  return {
    transmitter: {
      name: randanimalSync(),
      tx_lat: 51.102167,
      tx_lon: -114.098667,
      tx_power: 0.1,
      tx_freq: 907.0,
      tx_height: 2.0,
      tx_gain: 2.0,
    },
    receiver: { rx_sensitivity: -130.0, rx_height: 1.0, rx_gain: 2.0, rx_loss: 2.0 },
    environment: {
      radio_climate: 'continental_temperate',
      polarization: 'vertical',
      clutter_height: 1.0,
      ground_dielectric: 15.0,
      ground_conductivity: 0.005,
      atmosphere_bending: 301.0,
    },
    simulation: {
      situation_fraction: 95.0,
      time_fraction: 95.0,
      simulation_extent: 30.0,
      high_resolution: false,
    },
    display: { color_scale: 'plasma', min_dbm: -130.0, max_dbm: -80.0, overlay_transparency: 50 },
  };
}

/** Initial params: a shared permalink (#9) wins over the persisted params
 * (#12), which win over the factory defaults. */
function initialParams(): SplatParams {
  const d = defaultParams();
  const cfg = decodeSharedHash();
  const query = decodeSharedQuery();
  // An explicit deep link — a shared #cfg permalink (#9) or the flat ?lat=&lon=…
  // app hand-off — wins over persisted params (#12); cfg is the base and the
  // query overrides it, so `#cfg=…` and `?lat=…` can be combined.
  if (cfg || query) {
    let p = cfg ? mergeParams(d, cfg) : d;
    if (query) p = mergeParams(p, query);
    return p;
  }
  return loadParams(d);
}

/** Opened from a shared #cfg permalink or ?lat= hand-off. Read at module load:
 * main.ts clears the hash/query right after mount (consumeSharedLink). */
const openedFromLink = !!(decodeSharedHash() || decodeSharedQuery());

const useStore = defineStore('store', {
  state() {
    const workspace = loadWorkspace(); // receivers + canvas from the last session
    return {
      localSites: [] as Site[], //useLocalStorage('localSites', ),
      simulationState: 'idle',
      progress: null as CoverageProgress | null,
      errorMessage: '' as string,
      /** True while "place on map" is armed (drives crosshair + hint). */
      placingMode: false,
      /** Live, global render style for every coverage overlay. */
      overlayStyle: 'heatmap' as 'heatmap' | 'contours',
      /** Point-to-point link mode (#14): receivers of the one Receiver type,
       * each linked to the transmitter being edited. */
      receivers: workspace.receivers.map((r) => ({ ...r, analysis: null, azimuthDeg: 0 })) as {
        lat: number;
        lon: number;
        name?: string;
        analysis: LinkAnalysis | null;
        azimuthDeg: number;
      }[],
      /** Index into receivers shown in the detail view, -1 for none. */
      selectedRx: workspace.receivers.length ? 0 : -1,
      linkState: 'idle' as 'idle' | 'placing' | 'computing' | 'done' | 'error',
      linkError: '' as string,
      /** Find-highpoint (#39) status. */
      highpointBusy: false,
      highpointMessage: '' as string,
      // Restore from a shared link (#9) or the last-used params (#12).
      splatParams: initialParams(),
      /** App hand-off: run coverage as soon as the map is ready (#cfg/?run=1).
       * Captured at store creation, before consumeSharedLink() clears the URL. */
      autoRun: sharedRunRequested(),
      /** Transient "Copied!" feedback for the share button (#9). */
      shareCopied: false,
      /** Measure/ruler tool (#15). */
      measureMode: false,
      measureResult: null as { distanceKm: number; bearingDeg: number } | null,
      /** Canvas image overlay (file name empty when none). */
      canvasName: workspace.canvas?.name ?? '',
      canvasOpacity: workspace.canvas?.opacity ?? 60,
      canvasLocked: workspace.canvas?.locked ?? false,
      canvasGeom: (workspace.canvas?.geom ?? null) as CanvasGeom | null,
      /** Three-point canvas calibration: running flag + step/result text. */
      calibrating: false,
      calibStatus: '',
    }
  },
  actions: {
    /** Non-reactive map handle for components (markers, click handlers). */
    getMap(): maplibregl.Map | undefined {
      return map;
    },
    setTxCoords(lat: number, lon: number) {
      this.splatParams.transmitter.tx_lat = lat
      this.splatParams.transmitter.tx_lon = lon
    },
    /** Place or move the draggable draft transmitter marker. */
    setDraftMarker(lat: number, lon: number) {
      if (!map) return;
      if (currentMarker) {
        currentMarker.setLngLat([lon, lat]);
        return;
      }
      currentMarker = new maplibregl.Marker({
        element: draftPinElement(),
        anchor: 'bottom',
        draggable: true,
      })
        .setLngLat([lon, lat])
        .addTo(map);
      // Dragging the pin updates the transmitter coordinates live.
      currentMarker.on('dragend', () => {
        const ll = currentMarker!.getLngLat();
        const lng = ((((ll.lng + 180) % 360) + 360) % 360) - 180;
        this.setTxCoords(Number(ll.lat.toFixed(6)), Number(lng.toFixed(6)));
      });
    },
    clearDraftMarker() {
      currentMarker?.remove();
      currentMarker = undefined;
    },
    /** Arm (or disarm) click-to-place mode: crosshair + Esc to cancel. */
    beginPlaceOnMap() {
      if (!map) return;
      if (this.placingMode) {
        this.cancelPlaceOnMap();
        return;
      }
      this.cancelCalibration();
      this.placingMode = true;
      map.getCanvas().style.cursor = 'crosshair';
      placeClickHandler = (e: maplibregl.MapMouseEvent) => {
        const lng = ((((e.lngLat.lng + 180) % 360) + 360) % 360) - 180;
        this.setTxCoords(Number(e.lngLat.lat.toFixed(6)), Number(lng.toFixed(6)));
        this.setDraftMarker(e.lngLat.lat, lng);
        this.cancelPlaceOnMap();
      };
      map.on('click', placeClickHandler);
      placeEscHandler = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') this.cancelPlaceOnMap();
      };
      window.addEventListener('keydown', placeEscHandler);
    },
    cancelPlaceOnMap() {
      this.placingMode = false;
      if (map) map.getCanvas().style.cursor = '';
      if (placeClickHandler) {
        map?.off('click', placeClickHandler);
        placeClickHandler = undefined;
      }
      if (placeEscHandler) {
        window.removeEventListener('keydown', placeEscHandler);
        placeEscHandler = undefined;
      }
    },

    /* ---- Point-to-point link mode (#14) ---- */
    /** Arm click-to-place for a new receiver (crosshair + Esc to cancel). */
    beginPlaceTarget() {
      if (!map) return;
      if (this.linkState === 'placing') {
        this.cancelPlaceTarget();
        return;
      }
      this.cancelPlaceOnMap(); // never arm both at once
      this.cancelCalibration();
      this.linkState = 'placing';
      map.getCanvas().style.cursor = 'crosshair';
      linkClickHandler = (e: maplibregl.MapMouseEvent) => {
        const lon = wrapLon(e.lngLat.lng);
        this.cancelPlaceTarget();
        this.addReceiver(Number(e.lngLat.lat.toFixed(6)), Number(lon.toFixed(6)));
      };
      map.on('click', linkClickHandler);
      linkEscHandler = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') this.cancelPlaceTarget();
      };
      window.addEventListener('keydown', linkEscHandler);
    },
    cancelPlaceTarget() {
      if (this.linkState === 'placing')
        this.linkState = this.receivers.some((r) => r.analysis) ? 'done' : 'idle';
      if (map) map.getCanvas().style.cursor = '';
      if (linkClickHandler) {
        map?.off('click', linkClickHandler);
        linkClickHandler = undefined;
      }
      if (linkEscHandler) {
        window.removeEventListener('keydown', linkEscHandler);
        linkEscHandler = undefined;
      }
    },
    addReceiver(lat: number, lon: number) {
      this.receivers.push({ lat, lon, analysis: null, azimuthDeg: 0 });
      this.selectedRx = this.receivers.length - 1;
      this.drawLink();
      void this.computeLink();
    },
    /** Replace all receivers with imported points, put the transmitter at
     * their bounding-box center, and fit the map to them. */
    importReceivers(points: { lat: number; lon: number; name: string }[]) {
      if (!points.length) return;
      this.clearLink();
      this.receivers = points.map((p) => ({ ...p, analysis: null, azimuthDeg: 0 }));
      this.selectedRx = 0;
      const lats = points.map((p) => p.lat);
      const lons = points.map((p) => p.lon);
      const [s, n, w, e] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
      const lat = Number(((s + n) / 2).toFixed(6));
      const lon = Number(((w + e) / 2).toFixed(6));
      this.setTxCoords(lat, lon);
      this.setDraftMarker(lat, lon);
      if (map) {
        // Keep the points clear of the open parameters drawer.
        const right = drawerInset(map) + 60;
        map.fitBounds([[w, s], [e, n]], { padding: { top: 170, bottom: 90, left: 60, right }, maxZoom: 15, duration: 0 });
      }
      this.drawLink();
      void this.computeLink();
    },
    moveReceiver(i: number, lat: number, lon: number) {
      const r = this.receivers[i];
      if (!r) return;
      r.lat = lat;
      r.lon = lon;
      r.analysis = null;
      this.drawLink();
      void this.computeLink();
    },
    removeReceiver(i: number) {
      if (!this.receivers[i]) return;
      if (this.receivers.length === 1) return this.clearLink();
      this.receivers.splice(i, 1);
      if (this.selectedRx >= this.receivers.length || this.selectedRx === i)
        this.selectedRx = Math.min(i, this.receivers.length - 1);
      else if (this.selectedRx > i) this.selectedRx--;
      // Rebuild markers so their order (and drag indices) match the list.
      rxMarkers.forEach((m) => m.remove());
      rxMarkers = [];
      this.drawLink();
    },
    /** (Re)compute every receiver's link with the current settings. */
    async computeLink() {
      if (!this.receivers.length) return;
      linkAbort?.abort();
      linkAbort = new AbortController();
      const signal = linkAbort.signal;
      this.linkState = 'computing';
      this.linkError = '';
      try {
        const p = this.splatParams;
        // ponytail: recomputes all receivers sequentially (one ITM path each,
        // terrain cached); batch runLinks in one EngineContext if tens of
        // receivers get slow.
        for (const r of this.receivers) {
          const request = buildCoverageRequest(p);
          // The engine region is a disk around the TX; widen the radius so it
          // reaches the receiver (plus margin), capped at the terrain-data limit.
          const distKm = haversineKm(request.lat, request.lon, r.lat, r.lon);
          request.radius = Math.min(MAX_RADIUS_METERS, (distKm * 1.2 + 2) * 1000);
          request.high_resolution = false; // a single path doesn't need HD pages
          const target = { lat: r.lat, lon: r.lon, altFeet: p.receiver.rx_height / METERS_PER_FOOT };
          const link = await (await getEngine()).runLink(toEngineParams(request), target, {
            terrain: getTerrain(),
            signal,
          });
          if (signal.aborted) return;
          r.azimuthDeg = link.azimuthDeg;
          r.analysis = analyzeLink({
            profile: link.profile,
            txHeightM: p.transmitter.tx_height,
            rxHeightM: p.receiver.rx_height,
            frequencyMhz: p.transmitter.tx_freq,
            dbm: link.dbm,
            rxGainDbi: p.receiver.rx_gain,
            rxSensitivityDbm: p.receiver.rx_sensitivity,
          });
        }
        this.linkState = 'done';
        this.drawLink(); // recolor the lines by viability
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.linkError = error instanceof Error ? error.message : String(error);
        this.linkState = 'error';
      }
    },
    clearLink() {
      linkAbort?.abort();
      this.cancelPlaceTarget();
      this.receivers = [];
      this.selectedRx = -1;
      this.linkState = 'idle';
      this.linkError = '';
      rxMarkers.forEach((m) => m.remove());
      rxMarkers = [];
      if (map?.getLayer(LINK_LINE_ID)) map.removeLayer(LINK_LINE_ID);
      if (map?.getSource(LINK_LINE_ID)) map.removeSource(LINK_LINE_ID);
    },
    /** Draw or update the receiver markers and the TX->receiver lines. */
    drawLink() {
      if (!map || !this.receivers.length) return;
      const m = map;
      const tx = this.splatParams.transmitter;
      this.receivers.forEach((r, i) => {
        let marker = rxMarkers[i];
        if (!marker) {
          const el = targetPinElement();
          marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true })
            .setLngLat([r.lon, r.lat])
            .addTo(m);
          const mk = marker;
          el.addEventListener('click', () => (this.selectedRx = rxMarkers.indexOf(mk)));
          mk.on('dragend', () => {
            const ll = mk.getLngLat();
            const idx = rxMarkers.indexOf(mk);
            this.selectedRx = idx;
            this.moveReceiver(idx, Number(ll.lat.toFixed(6)), Number(wrapLon(ll.lng).toFixed(6)));
          });
          rxMarkers[i] = mk;
        }
        marker.setLngLat([r.lon, r.lat]);
      });
      const geojson = {
        type: 'FeatureCollection' as const,
        features: this.receivers.map((r) => ({
          type: 'Feature' as const,
          geometry: {
            type: 'LineString' as const,
            coordinates: [
              [tx.tx_lon, tx.tx_lat],
              [r.lon, r.lat],
            ],
          },
          properties: { color: linkColor(r.analysis) },
        })),
      };
      const draw = () => {
        if (!map) return;
        const src = map.getSource(LINK_LINE_ID) as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(geojson);
        } else {
          map.addSource(LINK_LINE_ID, { type: 'geojson', data: geojson });
          map.addLayer({
            id: LINK_LINE_ID,
            type: 'line',
            source: LINK_LINE_ID,
            layout: { 'line-cap': 'round' },
            paint: { 'line-color': ['get', 'color'], 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
          });
        }
      };
      // addSource/addLayer succeed once the style spec is parsed (even while
      // tiles stream and isStyleLoaded() is false); only the brief initial
      // load / a basemap switch can throw, so try now and retry on idle.
      try {
        draw();
      } catch {
        map.once('idle', () => {
          try {
            draw();
          } catch {
            /* ignore */
          }
        });
      }
    },

    /* ---- Find highpoint (#39) ---- */
    /** Move the transmitter to the highest terrain within radiusKm of it. */
    async findHighpoint(radiusKm = 1) {
      if (this.highpointBusy) return;
      this.highpointBusy = true;
      this.highpointMessage = '';
      const ac = new AbortController();
      try {
        const request = buildCoverageRequest(this.splatParams);
        const r = Math.max(0.2, Math.min(10, radiusKm));
        request.radius = r * 1000; // search disk = engine region
        request.high_resolution = false;
        const params = toEngineParams(request);
        const hp = await (await getEngine()).findHighpoint(params, r, {
          terrain: getTerrain(),
          signal: ac.signal,
        });
        const movedM = haversineKm(request.lat, request.lon, hp.lat, hp.lon) * 1000;
        if (movedM < 5) {
          this.highpointMessage = `Already at the local high point (${Math.round(hp.elevationM)} m).`;
        } else {
          this.setTxCoords(Number(hp.lat.toFixed(6)), Number(hp.lon.toFixed(6)));
          this.setDraftMarker(hp.lat, hp.lon);
          map?.flyTo({ center: [hp.lon, hp.lat] });
          this.highpointMessage = `Moved ${Math.round(movedM)} m to a ${Math.round(hp.elevationM)} m high point.`;
        }
      } catch (error) {
        this.highpointMessage =
          error instanceof Error ? error.message : String(error);
      } finally {
        this.highpointBusy = false;
      }
    },

    /* ---- Shareable permalink (#9) ---- */
    /** Copy a link encoding the current parameters to the clipboard. */
    async copyShareLink() {
      const url = buildShareUrl(this.splatParams);
      try {
        await navigator.clipboard.writeText(url);
        this.shareCopied = true;
        setTimeout(() => {
          this.shareCopied = false;
        }, 2000);
      } catch {
        // Clipboard unavailable (e.g. insecure context): show the URL instead.
        window.prompt('Copy this link:', url);
      }
      return url;
    },
    /** If the page opened from a shared link, persist those params and drop the
     * hash so later edits aren't overridden by the link on the next reload. */
    consumeSharedLink() {
      if (decodeSharedHash() || decodeSharedQuery()) {
        saveParams(this.splatParams);
        clearSharedHash();
        clearSharedQuery();
      }
    },

    /* ---- Canvas: user image overlay ---- */
    async importCanvas(file: File) {
      if (!map) return;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        URL.revokeObjectURL(url);
        throw new Error(`${file.name} is not a readable PNG or JPG image.`);
      }
      this.removeCanvas();
      this.showCanvas(url, img, null);
      this.canvasName = file.name;
      void saveCanvasImage(file); // survives reloads (IndexedDB)
    },
    /** Put a decoded image on the map at `geom` (or the default placement). */
    showCanvas(url: string, img: HTMLImageElement, geom: CanvasGeom | null) {
      if (!map) return;
      canvas = new CanvasOverlay(map, url, img.naturalWidth, img.naturalHeight, geom, (g) => (this.canvasGeom = g));
      canvasUrl = url;
      this.canvasGeom = canvas.geom();
      canvas.setOpacity(this.canvasOpacity / 100);
      canvas.setLocked(this.canvasLocked);
    },
    /** Re-show the canvas saved from the previous session, if any. */
    async restoreCanvas() {
      if (!this.canvasName || canvas) return;
      const blob = await loadCanvasImage();
      if (!blob) return void (this.canvasName = ''); // image gone: drop the stale settings
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch {
        URL.revokeObjectURL(url);
        return void (this.canvasName = '');
      }
      this.showCanvas(url, img, this.canvasGeom);
    },
    setCanvasOpacity(v: number) {
      this.canvasOpacity = v;
      canvas?.setOpacity(v / 100);
    },
    setCanvasLocked(on: boolean) {
      this.canvasLocked = on;
      canvas?.setLocked(on);
    },
    /** Start (or restart) three-point calibration of the canvas. */
    startCalibration() {
      if (!map || !canvas) return;
      this.cancelCalibration();
      this.cancelPlaceOnMap(); // one click mode at a time
      this.cancelPlaceTarget();
      this.endMeasure();
      this.calibrating = true;
      calibration = new CanvasCalibration(map, canvas, (message, done) => {
        this.calibStatus = message;
        if (done) this.cancelCalibration(true);
      });
      calibEscHandler = (e) => e.key === 'Escape' && this.cancelCalibration();
      window.addEventListener('keydown', calibEscHandler);
    },
    /** Stop calibrating; keep the status text only when a fit just finished. */
    cancelCalibration(keepStatus = false) {
      calibration?.cancel();
      calibration = undefined;
      if (calibEscHandler) window.removeEventListener('keydown', calibEscHandler);
      calibEscHandler = undefined;
      this.calibrating = false;
      if (!keepStatus) this.calibStatus = '';
    },
    removeCanvas() {
      this.cancelCalibration();
      canvas?.remove();
      canvas = undefined;
      if (canvasUrl) URL.revokeObjectURL(canvasUrl);
      canvasUrl = undefined;
      this.canvasName = '';
      this.canvasGeom = null;
      // Forget the stored image too. On re-import the following save runs
      // after this delete (IndexedDB transactions on one store are ordered).
      void saveCanvasImage(null);
    },

    /* ---- Measure / ruler tool (#15) ---- */
    toggleMeasure() {
      if (this.measureMode) {
        this.endMeasure();
        return;
      }
      this.cancelPlaceOnMap();
      this.cancelPlaceTarget();
      this.cancelCalibration();
      this.measureMode = true;
      this.measureResult = null;
      measureA = null;
      measureControl?.setActive(true);
      if (map) map.getCanvas().style.cursor = 'crosshair';
      measureClickHandler = (e: maplibregl.MapMouseEvent) => {
        const lat = e.lngLat.lat;
        const lon = wrapLon(e.lngLat.lng);
        if (!measureA) {
          measureA = { lat, lon };
          this.measureResult = null;
          this.drawMeasure(measureA, null);
        } else {
          const b = { lat, lon };
          this.measureResult = {
            distanceKm: haversineKm(measureA.lat, measureA.lon, b.lat, b.lon),
            bearingDeg: bearingDeg(measureA.lat, measureA.lon, b.lat, b.lon),
          };
          this.drawMeasure(measureA, b);
          measureA = null; // next click starts a new measurement
        }
      };
      map?.on('click', measureClickHandler);
      measureEscHandler = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') this.endMeasure();
      };
      window.addEventListener('keydown', measureEscHandler);
    },
    endMeasure() {
      this.measureMode = false;
      this.measureResult = null;
      measureA = null;
      measureControl?.setActive(false);
      if (map) map.getCanvas().style.cursor = '';
      if (measureClickHandler) {
        map?.off('click', measureClickHandler);
        measureClickHandler = undefined;
      }
      if (measureEscHandler) {
        window.removeEventListener('keydown', measureEscHandler);
        measureEscHandler = undefined;
      }
      if (map?.getLayer(`${MEASURE_SRC}-line`)) map.removeLayer(`${MEASURE_SRC}-line`);
      if (map?.getLayer(`${MEASURE_SRC}-pts`)) map.removeLayer(`${MEASURE_SRC}-pts`);
      if (map?.getSource(MEASURE_SRC)) map.removeSource(MEASURE_SRC);
    },
    drawMeasure(a: { lat: number; lon: number } | null, b: { lat: number; lon: number } | null) {
      if (!map) return;
      const features: GeoJSON.Feature[] = [];
      if (a) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] }, properties: {} });
      if (b) features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, properties: {} });
      if (a && b)
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] },
          properties: {},
        });
      const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
      const draw = () => {
        if (!map) return;
        const src = map.getSource(MEASURE_SRC) as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData(fc);
          return;
        }
        map.addSource(MEASURE_SRC, { type: 'geojson', data: fc });
        map.addLayer({
          id: `${MEASURE_SRC}-line`,
          type: 'line',
          source: MEASURE_SRC,
          filter: ['==', ['geometry-type'], 'LineString'],
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': '#ffbf00', 'line-width': 2.5, 'line-dasharray': [2, 1.5] },
        });
        map.addLayer({
          id: `${MEASURE_SRC}-pts`,
          type: 'circle',
          source: MEASURE_SRC,
          filter: ['==', ['geometry-type'], 'Point'],
          paint: {
            'circle-radius': 4,
            'circle-color': '#ffbf00',
            'circle-stroke-color': '#0f1017',
            'circle-stroke-width': 2,
          },
        });
      };
      // addSource/addLayer succeed once the style spec is parsed (even while
      // tiles stream and isStyleLoaded() is false); only the brief initial
      // load / a basemap switch can throw, so try now and retry on idle.
      try {
        draw();
      } catch {
        map.once('idle', () => {
          try {
            draw();
          } catch {
            /* ignore */
          }
        });
      }
    },

    removeSite(index: number) {
      const [removed] = this.localSites.splice(index, 1)
      if (removed) {
        siteMarkers.get(removed.id)?.remove();
        siteMarkers.delete(removed.id);
        if (map) this.removeOverlay(removed.id);
      }
    },
    /** Show/hide one site's overlay + marker (#61). */
    toggleSiteVisibility(index: number) {
      const site = this.localSites[index];
      if (!site) return;
      site.visible = !site.visible;
      const el = siteMarkers.get(site.id)?.getElement();
      if (el) el.style.display = site.visible ? '' : 'none';
      this.syncOverlays();
    },
    /** Remove every layer/source for one site's overlay (either style). */
    removeOverlay(siteId: string) {
      if (!map) return;
      const id = `coverage-${siteId}`;
      for (const layerId of [`${id}-line`, id]) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      if (map.getSource(id)) map.removeSource(id);
    },
    /** Switch all overlays between the raster heatmap and vector contours. */
    setOverlayStyle(style: 'heatmap' | 'contours') {
      if (this.overlayStyle === style) return;
      this.overlayStyle = style;
      this.syncOverlays();
    },
    /** Live-apply the Display panel to every existing overlay without
     * recomputing (#1). The engine output is cached per site, so re-coloring
     * (and re-thresholding/opacity) is a pure re-render — instant even after a
     * slow HD run. Mirrors the panel onto each site so the list swatches and
     * the on-map legend stay in sync. */
    applyDisplayLive() {
      const d = this.splatParams.display;
      for (const site of this.localSites) Object.assign(site.params.display, d);
      this.syncOverlays();
    },
    /** (Re-)adds every site's overlay in the current style; safe after
     * style switches and idempotent. */
    syncOverlays() {
      if (!map) return;
      // addSource/addLayer throw if the style is mid-load (initial load, or
      // a basemap switch still settling). Defer until the map is idle.
      if (!map.isStyleLoaded()) {
        map.once('idle', () => this.syncOverlays());
        return;
      }
      this.localSites.forEach((site: Site) => {
        const id = `coverage-${site.id}`;
        this.removeOverlay(site.id);
        if (site.visible === false) return; // hidden via the site-list toggle
        const opacity = 1 - site.params.display.overlay_transparency / 100;

        if (this.overlayStyle === 'contours') {
          const geojson = coverageContours(site.result, {
            colorScale: site.params.display.color_scale,
            minDbm: site.params.display.min_dbm,
            maxDbm: site.params.display.max_dbm,
            sensitivityDbm: site.params.receiver.rx_sensitivity,
          });
          map!.addSource(id, { type: 'geojson', data: geojson });
          // Features are ordered weakest→strongest, so the stronger bands
          // paint on top and the visible color is the highest level reached.
          map!.addLayer({
            id,
            type: 'fill',
            source: id,
            paint: { 'fill-color': ['get', 'color'], 'fill-opacity': opacity },
          });
          map!.addLayer({
            id: `${id}-line`,
            type: 'line',
            source: id,
            paint: { 'line-color': ['get', 'color'], 'line-width': 0.6, 'line-opacity': Math.min(1, opacity + 0.25) },
          });
        } else {
          const image = coverageImage(
            site.result,
            site.params.display,
            site.params.receiver.rx_sensitivity
          );
          map!.addSource(id, {
            type: 'image',
            url: image.url,
            coordinates: image.coordinates,
          });
          map!.addLayer({
            id,
            type: 'raster',
            source: id,
            paint: { 'raster-opacity': 1, 'raster-resampling': 'nearest' },
          });
        }
      });
    },
    initMap() {
      // Reopen where the user left the map, unless a link says where to look.
      const view = openedFromLink ? null : loadView();
      map = new maplibregl.Map({
        container: 'map',
        // Start from an empty style and add the basemap in place (see
        // src/map/styles.ts for why setStyle-based switching is avoided).
        style: emptyStyle(),
        center: view?.center ?? [this.splatParams.transmitter.tx_lon, this.splatParams.transmitter.tx_lat],
        zoom: view?.zoom ?? 9,
        bearing: view?.bearing ?? 0,
        pitch: view?.pitch ?? 0,
        // Needed so the export control can read the WebGL canvas.
        canvasContextAttributes: { preserveDrawingBuffer: true },
        // Default attribution disabled; added explicitly below at bottom-left
        // (the right sidebar would otherwise cover a bottom-right control).
        attributionControl: false,
      });

      map.on('moveend', () => {
        if (!map) return;
        const c = map.getCenter();
        saveView({ center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() });
      });

      map.addControl(new SearchControl(), 'top-left');
      // Compass: drag it (or right-drag / two-finger twist the map) to rotate;
      // click it to reset north-up.
      map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-left');
      map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
      map.addControl(
        new maplibregl.GeolocateControl({
          positionOptions: { enableHighAccuracy: true },
          showUserLocation: true,
        }),
        'bottom-left'
      );
      map.addControl(new ExportControl(), 'bottom-left');
      measureControl = new MeasureControl(() => this.toggleMeasure());
      map.addControl(measureControl, 'bottom-left');
      map.addControl(
        new BasemapControl(Object.keys(BASEMAPS), DEFAULT_BASEMAP, (name) => {
          // Swap the basemap raster source/layers in place (keeps overlays,
          // markers, and the GL context intact).
          if (map) applyBasemap(map, name);
        }, [
          ['Hillshade', (on) => map && setHillshade(map, on)],
          ['Sigfox coverage', (on) => map && void setSigfox(map, on)],
        ]),
        'bottom-left'
      );
      // Compact (collapsed to an "i" that expands on click) so the required
      // per-basemap credits — e.g. Stamen Terrain needs four — don't crowd the
      // map. Bottom-left keeps it in the map's always-visible area, clear of
      // the right sidebar. Credits are already per-selected-basemap.
      map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

      // Apply the default basemap and (re-)add overlays once the empty
      // style is ready.
      map.on('load', () => {
        if (!map) return;
        applyBasemap(map, DEFAULT_BASEMAP);
        this.syncOverlays();
        // Restore the previous session's receivers and canvas.
        if (this.receivers.length) {
          this.drawLink();
          void this.computeLink();
        }
        void this.restoreCanvas();
        // App hand-off (#cfg/?run=1): compute coverage once the map is ready, so
        // the resulting overlay and site marker have somewhere to attach.
        if (this.autoRun) {
          this.autoRun = false;
          void this.runSimulation();
        }
      });

      // Tap a contour band to read its signal level (vector-only). Querying
      // the live coverage fill layers each click keeps it correct as sites
      // are added/removed; ignored while placing a transmitter.
      map.on('click', (e: maplibregl.MapMouseEvent) => {
        if (!map || this.placingMode || this.measureMode || this.overlayStyle !== 'contours') return;
        const layerIds = this.localSites
          .map((s) => `coverage-${s.id}`)
          .filter((id) => map!.getLayer(id));
        if (layerIds.length === 0) return;
        const hits = map.queryRenderedFeatures(e.point, { layers: layerIds });
        if (hits.length === 0) return;
        const strongest = hits.reduce((a, b) =>
          ((b.properties?.dbm ?? -999) > (a.properties?.dbm ?? -999) ? b : a)
        );
        new maplibregl.Popup({ closeButton: false })
          .setLngLat(e.lngLat)
          .setHTML(
            `<div class="mt-popup"><div class="mt-popup-row"><span>Signal</span>` +
            `<span>${strongest.properties?.label ?? ''}</span></div></div>`
          )
          .addTo(map);
      });
      map.on('mousemove', (e: maplibregl.MapMouseEvent) => {
        // Leave the cursor alone while placing (crosshair) or in heatmap mode.
        if (!map || this.placingMode || this.measureMode || this.overlayStyle !== 'contours') return;
        const layerIds = this.localSites
          .map((s) => `coverage-${s.id}`)
          .filter((id) => map!.getLayer(id));
        if (layerIds.length === 0) return;
        const over = map.queryRenderedFeatures(e.point, { layers: layerIds }).length > 0;
        map.getCanvas().style.cursor = over ? 'pointer' : '';
      });

      // The map can construct before the page has its final layout
      // (embedded webviews size the window late), leaving the GL canvas at
      // its pre-layout size. Track the container explicitly and fall back
      // to window resize for environments where ResizeObserver is quiet.
      const container = document.getElementById('map');
      if (container && typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => map?.resize()).observe(container);
      }
      window.addEventListener('resize', () => map?.resize());
      map.once('load', () => map?.resize());

      this.setDraftMarker(
        this.splatParams.transmitter.tx_lat,
        this.splatParams.transmitter.tx_lon
      );
      // Site markers survive in-session navigation.
      for (const marker of siteMarkers.values()) marker.addTo(map);
    },
    focusSite(index: number) {
      const site = this.localSites[index];
      if (!site || !map) return;
      const { tx_lat, tx_lon } = site.params.transmitter;
      map.flyTo({ center: [tx_lon, tx_lat], zoom: Math.max(map.getZoom(), 9) });
      const marker = siteMarkers.get(site.id);
      if (marker && !marker.getPopup()?.isOpen()) marker.togglePopup();
    },
    cancelSimulation() {
      abortController?.abort();
    },
    async runSimulation() {
      if (this.simulationState === 'running') {
        return;
      }
      console.log('Simulation running...');
      this.simulationState = 'running';
      this.errorMessage = '';
      this.progress = { phase: 'terrain', completed: 0, total: 1, fraction: 0 };
      abortController = new AbortController();

      try {
        const request = buildCoverageRequest(this.splatParams);
        // Correct meters -> feet conversion for the transmitter height.
        // (The legacy backend passed it through unconverted, so SPLAT!
        // consumed meters as feet; toEngineParams can replicate that with
        // legacyTxHeightAsFeet for comparisons.)
        const params = toEngineParams(request);
        console.log('Coverage request:', request);

        const result = await (await getEngine()).run(params, {
          terrain: getTerrain(),
          signal: abortController.signal,
          onProgress: (p) => {
            this.progress = p;
          },
        });
        console.log(
          `Computed ${result.stats.radials} radials over ${result.stats.pages} pages ` +
            `in ${(result.stats.elapsedMs / 1000).toFixed(1)}s using ${result.stats.workers} workers`
        );

        const cropped = cropToRadius(result, request.lat, request.lon, request.radius);
        const siteParams = cloneObject(this.splatParams);
        // crypto.randomUUID only exists in secure contexts (HTTPS/localhost);
        // the id is just a local map/layer key, so fall back for plain-HTTP LAN use.
        const id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const stats = coverageStats(
          cropped,
          request.lat,
          request.lon,
          siteParams.receiver.rx_sensitivity
        );
        const site: Site = { params: siteParams, id, result: cropped, visible: true, stats };
        this.localSites.push(site);

        // The draft pin becomes a persistent, labeled site marker.
        this.cancelPlaceOnMap();
        this.clearDraftMarker();
        if (map) {
          const popup = new maplibregl.Popup({ closeButton: true, offset: 46 })
            .setDOMContent(buildSitePopup(site));
          const marker = new maplibregl.Marker({ element: sitePinElement(), anchor: 'bottom' })
            .setLngLat([request.lon, request.lat])
            .setPopup(popup)
            .addTo(map);
          siteMarkers.set(id, marker);
        }

        this.syncOverlays();
        this.simulationState = 'completed';
        // Headless/native hand-off (Android WebView): push the styled GeoJSON to
        // the injected bridge, before the name is randomized below, so it carries
        // the source site's name. No-op in a normal browser.
        postCoverageToBridge(site);
        this.splatParams.transmitter.name = randanimalSync();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          console.log('Simulation cancelled');
          this.simulationState = 'idle';
        } else {
          console.error('Simulation error:', error);
          this.errorMessage = error instanceof Error ? error.message : String(error);
          this.simulationState = 'failed';
        }
      } finally {
        this.progress = null;
        abortController = undefined;
      }
    }
  }
});

export { useStore }
