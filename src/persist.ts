/* Lightweight localStorage persistence for the site parameters form, so a
 * planner's settings survive a refresh. Only splatParams (the small config) is
 * persisted — not localSites, whose coverage rasters are large and cheap to
 * recompute. Pure + storage-guarded so it is unit-testable and never throws
 * (private-browsing / quota / disabled storage all degrade to defaults). */

import type { SplatParams } from './types';

export const PARAMS_KEY = 'mt-site-params-v1';

/**
 * Merge a persisted blob over the defaults section by section, so a saved
 * payload from an older build still picks up any newly-added fields (and a
 * malformed section falls back to its default). Unknown top-level shapes
 * return the defaults untouched.
 */
export function mergeParams(defaults: SplatParams, saved: unknown): SplatParams {
  if (!saved || typeof saved !== 'object') return defaults;
  const s = saved as Partial<Record<keyof SplatParams, unknown>>;
  const section = <T>(d: T, v: unknown): T =>
    v && typeof v === 'object' && !Array.isArray(v) ? { ...d, ...(v as object) } : d;
  return {
    transmitter: section(defaults.transmitter, s.transmitter),
    receiver: section(defaults.receiver, s.receiver),
    environment: section(defaults.environment, s.environment),
    simulation: section(defaults.simulation, s.simulation),
    display: section(defaults.display, s.display),
  };
}

/** Read persisted params merged over `defaults`; returns `defaults` on any
 * problem (no saved value, corrupt JSON, storage unavailable). */
export function loadParams(defaults: SplatParams): SplatParams {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    if (raw) return mergeParams(defaults, JSON.parse(raw));
  } catch {
    /* ignore: corrupt value or storage disabled */
  }
  return defaults;
}

/** Persist params; silently no-ops if storage is unavailable or over quota. */
export function saveParams(params: SplatParams): void {
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
  } catch {
    /* ignore: quota exceeded or storage disabled */
  }
}

/* ---- Workspace: point-to-point receivers + the Canvas image overlay ----
 * Small state (receiver positions, canvas settings and geometry) lives in
 * localStorage next to the params. The canvas image itself goes to IndexedDB
 * as a Blob: localStorage caps at ~5 MB of text, which a scanned site plan
 * (base64-inflated by a third) easily exceeds. */

export const WORKSPACE_KEY = 'mt-workspace-v1';

/** Canvas placement in Web Mercator units (see src/map/canvas.ts). */
export interface CanvasGeom {
  center: { x: number; y: number };
  width: number;
  angle: number;
}

export interface Workspace {
  receivers: { lat: number; lon: number; name?: string }[];
  canvas: { name: string; opacity: number; locked: boolean; geom: CanvasGeom | null } | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate a stored workspace, dropping anything malformed. */
export function parseWorkspace(saved: unknown): Workspace {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;
  const receivers = (Array.isArray(s.receivers) ? s.receivers : [])
    .filter((r): r is { lat: number; lon: number; name?: unknown } => !!r && isNum(r.lat) && isNum(r.lon))
    .map((r) => ({ lat: r.lat, lon: r.lon, ...(typeof r.name === 'string' ? { name: r.name } : {}) }));
  const c = s.canvas as Record<string, unknown> | null | undefined;
  const g = c?.geom as Record<string, unknown> | null | undefined;
  const center = g?.center as Record<string, unknown> | undefined;
  const geom =
    g && center && isNum(center.x) && isNum(center.y) && isNum(g.width) && g.width > 0 && isNum(g.angle)
      ? { center: { x: center.x, y: center.y }, width: g.width, angle: g.angle }
      : null;
  const canvas =
    c && typeof c.name === 'string' && c.name
      ? {
          name: c.name,
          opacity: isNum(c.opacity) ? Math.min(100, Math.max(0, c.opacity)) : 60,
          locked: c.locked === true,
          geom,
        }
      : null;
  return { receivers, canvas };
}

export function loadWorkspace(): Workspace {
  try {
    return parseWorkspace(JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? 'null'));
  } catch {
    return parseWorkspace(null);
  }
}

export function saveWorkspace(w: Workspace): void {
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(w));
  } catch {
    /* ignore: quota exceeded or storage disabled */
  }
}

/** One Blob slot in IndexedDB for the canvas image. */
function withImageStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('mt-canvas', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('image');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction('image', mode).objectStore('image'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

/** Store (or with null, delete) the canvas image; never throws. */
export async function saveCanvasImage(blob: Blob | null): Promise<void> {
  try {
    await withImageStore<unknown>('readwrite', (s) => (blob ? s.put(blob, 'current') : s.delete('current')) as IDBRequest<unknown>);
  } catch {
    /* ignore: IndexedDB unavailable (e.g. some private modes) */
  }
}

export async function loadCanvasImage(): Promise<Blob | null> {
  try {
    return ((await withImageStore('readonly', (s) => s.get('current'))) as Blob | undefined) ?? null;
  } catch {
    return null;
  }
}

/* ---- Map view: where the user left the map (center, zoom, rotation, tilt) ---- */

export const VIEW_KEY = 'mt-map-view-v1';

export interface MapView {
  center: [number, number]; // [lng, lat]
  zoom: number;
  bearing: number;
  pitch: number;
}

export function parseView(v: unknown): MapView | null {
  const o = v as Partial<MapView> | null;
  const c = o?.center;
  if (!o || !Array.isArray(c) || !isNum(c[0]) || !isNum(c[1]) || Math.abs(c[1]) > 90) return null;
  if (!isNum(o.zoom) || o.zoom < 0 || o.zoom > 24) return null;
  return {
    center: [c[0], c[1]],
    zoom: o.zoom,
    bearing: isNum(o.bearing) ? o.bearing : 0,
    pitch: isNum(o.pitch) ? Math.min(85, Math.max(0, o.pitch)) : 0,
  };
}

export function loadView(): MapView | null {
  try {
    return parseView(JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function saveView(v: MapView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(v));
  } catch {
    /* ignore: quota exceeded or storage disabled */
  }
}
