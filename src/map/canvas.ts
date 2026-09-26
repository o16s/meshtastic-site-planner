/* "Canvas": a user image (PNG/JPG) laid over the map as a MapLibre image
 * source pinned by 4 corners, with draggable handles to scale it (aspect
 * locked, opposite corner fixed), rotate it, and move it.
 *
 * The image is modelled as center + width + angle in Web Mercator units
 * (MercatorCoordinate: linear, zoom-independent, y grows southward like
 * screen y), and the 4 corners are derived from that, so it never distorts. */

import maplibregl from 'maplibre-gl';
import type { CanvasGeom } from '../persist.ts';

export interface V {
  x: number;
  y: number;
}

const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const rot = (v: V, a: number): V => ({
  x: v.x * Math.cos(a) - v.y * Math.sin(a),
  y: v.x * Math.sin(a) + v.y * Math.cos(a),
});

/** Corner directions in the image's own frame: TL, TR, BR, BL (MapLibre's order). */
const SIGNS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** Corners of a rect with the given center, width, aspect (w/h) and angle. */
export function cornersOf(center: V, width: number, aspect: number, angle: number): V[] {
  const h = width / aspect;
  return SIGNS.map(([sx, sy]) => add(center, rot({ x: (sx * width) / 2, y: (sy * h) / 2 }, angle)));
}

/** Scale by dragging corner `i` while the opposite corner (`anchor`) stays
 * fixed: the drag is measured in the image's frame, the larger extent wins,
 * and the aspect ratio is kept. Never flips or shrinks below `minWidth`. */
export function scaleFromCorner(anchor: V, pointer: V, i: number, angle: number, aspect: number, minWidth: number) {
  const [sx, sy] = SIGNS[i];
  const d = rot(sub(pointer, anchor), -angle);
  const width = Math.max(sx * d.x, sy * d.y * aspect, minWidth);
  const half = rot({ x: (sx * width) / 2, y: (sy * width) / aspect / 2 }, angle);
  return { center: add(anchor, half), width };
}

/** Least-squares similarity fit (scale + rotation + translation, no shear, so
 * the image keeps its proportions) taking image-frame points onto world
 * points. Image points are in image-width units from the image center, so the
 * result is the canvas geometry directly: the image center lands at `center`,
 * width = scale, angle = rotation. Closed form with complex numbers: the
 * transform is w = a*i + t, a = sum((w-w_mean)*conj(i-i_mean)) / sum(|i-i_mean|^2). */
export function fitSimilarity(img: V[], world: V[]): { center: V; width: number; angle: number; residuals: number[] } {
  const n = img.length;
  const mean = (ps: V[]) => ({ x: ps.reduce((s, p) => s + p.x, 0) / n, y: ps.reduce((s, p) => s + p.y, 0) / n });
  const mi = mean(img);
  const mw = mean(world);
  let re = 0;
  let im = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    const i = sub(img[k], mi);
    const w = sub(world[k], mw);
    re += w.x * i.x + w.y * i.y; // Re(w * conj(i))
    im += w.y * i.x - w.x * i.y; // Im(w * conj(i))
    den += i.x * i.x + i.y * i.y;
  }
  const a = { x: re / den, y: im / den };
  const apply = (i: V): V => ({ x: a.x * i.x - a.y * i.y, y: a.x * i.y + a.y * i.x });
  const center = sub(mw, apply(mi)); // t, where the image center (i = 0) lands
  const residuals = img.map((i, k) => {
    const d = sub(add(apply(i), center), world[k]);
    return Math.hypot(d.x, d.y);
  });
  return { center, width: Math.hypot(a.x, a.y), angle: Math.atan2(a.y, a.x), residuals };
}

/** Width of the open parameters drawer overlaying the map's right edge, or 0
 * when it is closed or covers most of the map (phones). */
export function drawerInset(map: maplibregl.Map): number {
  const drawer = document.querySelector('aside[aria-label="Site parameters"][aria-hidden="false"]');
  const w = drawer?.getBoundingClientRect().width ?? 0;
  return w < map.getContainer().clientWidth / 2 ? w : 0;
}

const ID = 'overlay-canvas';
const merc = (ll: maplibregl.LngLatLike): V => maplibregl.MercatorCoordinate.fromLngLat(ll);
const lnglat = (v: V): [number, number] => new maplibregl.MercatorCoordinate(v.x, v.y).toLngLat().toArray() as [number, number];

export class CanvasOverlay {
  private center: V;
  private width: number;
  private angle = 0;
  private readonly aspect: number;
  private readonly corners: maplibregl.Marker[] = [];
  private readonly mover: maplibregl.Marker;
  private readonly rotator: maplibregl.Marker;

  /** `geom` restores a saved placement; `onChange` fires after each drag. */
  constructor(
    private readonly map: maplibregl.Map,
    url: string,
    imgWidth: number,
    imgHeight: number,
    geom?: CanvasGeom | null,
    private readonly onChange?: (geom: CanvasGeom) => void
  ) {
    this.aspect = imgWidth / imgHeight;
    if (geom) {
      this.center = geom.center;
      this.width = geom.width;
      this.angle = geom.angle;
    } else {
      // Centered in the part of the map the drawer doesn't cover, half its
      // width wide, so every handle starts out grabbable. Upright on screen
      // even when the map is rotated: width and angle come from the screen's
      // horizontal as it lies on the map.
      const el = map.getContainer();
      const visible = el.clientWidth - drawerInset(map);
      this.center = merc(map.unproject([visible / 2, el.clientHeight / 2]));
      const half = sub(merc(map.unproject([visible * 0.75, el.clientHeight / 2])), this.center);
      this.width = 2 * Math.hypot(half.x, half.y);
      this.angle = Math.atan2(half.y, half.x);
    }

    // Above the basemap and overlays (basemap-*, overlay-*), below coverage.
    const beforeId = (map.getStyle().layers ?? []).find(
      (l) => !l.id.startsWith('basemap-') && !l.id.startsWith('overlay-')
    )?.id;
    map.addSource(ID, { type: 'image', url, coordinates: this.coords() });
    map.addLayer({ id: ID, type: 'raster', source: ID, paint: { 'raster-opacity': 0.6 } }, beforeId);

    // Corner handles: scale around the opposite corner, captured at drag start.
    for (let i = 0; i < 4; i++) {
      const m = this.handle(`mt-canvas-handle ${i % 2 ? 'mt-canvas-nesw' : 'mt-canvas-nwse'}`, 'Drag to scale');
      let anchor: V;
      let minWidth: number;
      m.on('dragstart', () => {
        anchor = cornersOf(this.center, this.width, this.aspect, this.angle)[(i + 2) % 4];
        minWidth = 20 * this.mercPerPx();
      });
      m.on('drag', () => {
        const s = scaleFromCorner(anchor, merc(m.getLngLat()), i, this.angle, this.aspect, minWidth);
        this.center = s.center;
        this.width = s.width;
        this.update();
      });
      this.corners.push(m);
    }
    // Center handle moves the image; the rotate handle above the top edge turns it.
    this.mover = this.handle('mt-canvas-move', 'Drag to move');
    this.mover.on('drag', () => {
      this.center = merc(this.mover.getLngLat());
      this.update(this.mover);
    });
    this.rotator = this.handle('mt-canvas-rotate', 'Drag to rotate');
    this.rotator.on('drag', () => {
      const d = sub(merc(this.rotator.getLngLat()), this.center);
      this.angle = Math.atan2(d.x, -d.y); // 0 = handle straight above the center
      this.update();
    });
    for (const h of this.handles()) h.on('dragend', () => this.onChange?.(this.geom()));
    this.update();
  }

  /** A map point in the image's own frame, in image-width units from its center. */
  toImage(ll: maplibregl.LngLatLike): V {
    const d = rot(sub(merc(ll), this.center), -this.angle);
    return { x: d.x / this.width, y: d.y / this.width };
  }

  /** Place the image at a fitted geometry (see fitSimilarity). */
  applyFit(f: { center: V; width: number; angle: number }) {
    this.center = f.center;
    this.width = f.width;
    this.angle = f.angle;
    this.update();
    this.onChange?.(this.geom());
  }

  geom(): CanvasGeom {
    return { center: { x: this.center.x, y: this.center.y }, width: this.width, angle: this.angle };
  }

  setOpacity(v: number) {
    if (this.map.getLayer(ID)) this.map.setPaintProperty(ID, 'raster-opacity', v);
  }

  setLocked(locked: boolean) {
    for (const h of this.handles()) h.getElement().style.display = locked ? 'none' : '';
  }

  remove() {
    this.handles().forEach((h) => h.remove());
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
  }

  private handles() {
    return [...this.corners, this.mover, this.rotator];
  }

  private handle(className: string, title: string): maplibregl.Marker {
    const el = document.createElement('div');
    el.className = className;
    el.title = title;
    return new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lnglat(this.center)).addTo(this.map);
  }

  private coords(): [[number, number], [number, number], [number, number], [number, number]] {
    return cornersOf(this.center, this.width, this.aspect, this.angle).map(lnglat) as never;
  }

  /** Mercator units per screen pixel at the current zoom. */
  private mercPerPx(): number {
    const d = sub(merc(this.map.unproject([1, 0])), merc(this.map.unproject([0, 0])));
    return Math.hypot(d.x, d.y); // rotation-independent
  }

  /** Push the geometry to the image source and snap every handle (except the
   * one being dragged freely) onto it. */
  private update(skip?: maplibregl.Marker) {
    const coords = this.coords();
    (this.map.getSource(ID) as maplibregl.ImageSource | undefined)?.setCoordinates(coords);
    coords.forEach((p, i) => this.corners[i].setLngLat(p));
    if (skip !== this.mover) this.mover.setLngLat(lnglat(this.center));
    const h = this.width / this.aspect;
    this.rotator.setLngLat(lnglat(add(this.center, rot({ x: 0, y: -(h / 2) * 1.25 }, this.angle))));
  }
}

/** Three-point calibration: alternately click a feature on the canvas image and
 * the same feature on the map; after the third pair the image is fitted
 * (fitSimilarity) and the per-point misfit is reported in metres. */
export class CanvasCalibration {
  static readonly PAIRS = 3;
  private readonly img: V[] = [];
  private readonly world: V[] = [];
  private readonly markers: maplibregl.Marker[] = [];

  constructor(
    private readonly map: maplibregl.Map,
    private readonly overlay: CanvasOverlay,
    private readonly onStatus: (message: string, done: boolean) => void
  ) {
    map.on('click', this.click);
    map.getCanvas().style.cursor = 'crosshair';
    this.report();
  }

  cancel() {
    this.map.off('click', this.click);
    this.map.getCanvas().style.cursor = '';
    this.markers.forEach((m) => m.remove());
  }

  private readonly click = (e: maplibregl.MapMouseEvent) => {
    const onImage = this.img.length === this.world.length;
    if (onImage) this.img.push(this.overlay.toImage(e.lngLat));
    else this.world.push(merc(e.lngLat));
    const el = document.createElement('div');
    el.className = `mt-calib-pt ${onImage ? 'mt-calib-img' : 'mt-calib-world'}`;
    el.textContent = String(this.world.length + (onImage ? 1 : 0));
    this.markers.push(new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(this.map));
    if (this.world.length < CanvasCalibration.PAIRS) return this.report();

    const fit = fitSimilarity(this.img, this.world);
    this.overlay.applyFit(fit);
    this.cancel();
    const metres = fit.residuals.map((r, k) => {
      const at = new maplibregl.MercatorCoordinate(this.world[k].x, this.world[k].y);
      return Math.round(r / at.meterInMercatorCoordinateUnits());
    });
    this.onStatus(`Fitted. Point misfit: ${metres.map((m, k) => `#${k + 1} ${m} m`).join(', ')}.`, true);
  };

  private report() {
    const n = this.world.length + 1;
    this.onStatus(
      this.img.length === this.world.length
        ? `Point ${n} of ${CanvasCalibration.PAIRS}: click a feature on the image.`
        : `Point ${n} of ${CanvasCalibration.PAIRS}: now click the same feature on the map.`,
      false
    );
  }
}
