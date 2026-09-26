/* "Canvas": a user image (PNG/JPG) laid over the map as a MapLibre image
 * source pinned by 4 corners, with draggable handles to scale it (aspect
 * locked, opposite corner fixed), rotate it, and move it.
 *
 * The image is modelled as center + width + angle in Web Mercator units
 * (MercatorCoordinate: linear, zoom-independent, y grows southward like
 * screen y), and the 4 corners are derived from that, so it never distorts. */

import maplibregl from 'maplibre-gl';

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

  constructor(private readonly map: maplibregl.Map, url: string, imgWidth: number, imgHeight: number) {
    this.aspect = imgWidth / imgHeight;
    // Centered in the part of the map the drawer doesn't cover, half its width
    // wide, so every handle starts out grabbable.
    const el = map.getContainer();
    const visible = el.clientWidth - drawerInset(map);
    const mid = map.unproject([visible / 2, el.clientHeight / 2]);
    const right = map.unproject([visible * 0.75, el.clientHeight / 2]);
    this.center = merc(mid);
    this.width = 2 * (merc(right).x - this.center.x);

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
    this.update();
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
    return merc(this.map.unproject([1, 0])).x - merc(this.map.unproject([0, 0])).x;
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
