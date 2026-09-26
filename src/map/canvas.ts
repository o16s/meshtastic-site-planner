/* "Canvas": a user image (PNG/JPG) laid over the map as a MapLibre image
 * source pinned by 4 corners, with draggable handles to scale it (aspect
 * locked, opposite corner fixed) and move it. Scaling is done in screen
 * pixels: Web Mercator is linear there, so the image never distorts. */

import maplibregl from 'maplibre-gl';

export interface Pt {
  x: number;
  y: number;
}

const MIN_WIDTH_PX = 20;

/** Screen rect [tl, tr, br, bl] spanned from a fixed corner towards the drag
 * point, with width/height = aspect. The larger of the two drag extents wins. */
export function fitRect(anchor: Pt, drag: Pt, aspect: number): [Pt, Pt, Pt, Pt] {
  const dx = drag.x - anchor.x;
  const dy = drag.y - anchor.y;
  const w = Math.max(Math.abs(dx), Math.abs(dy) * aspect, MIN_WIDTH_PX);
  const h = w / aspect;
  const ox = anchor.x + (dx < 0 ? -w : w);
  const oy = anchor.y + (dy < 0 ? -h : h);
  const [x0, x1] = [Math.min(anchor.x, ox), Math.max(anchor.x, ox)];
  const [y0, y1] = [Math.min(anchor.y, oy), Math.max(anchor.y, oy)];
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

const ID = 'overlay-canvas';
type Corners = [[number, number], [number, number], [number, number], [number, number]];

export class CanvasOverlay {
  private corners: Corners;
  private handles: maplibregl.Marker[] = [];
  private readonly aspect: number;

  constructor(private readonly map: maplibregl.Map, url: string, width: number, height: number) {
    this.aspect = width / height;
    // Centered in the view, half the visible map width wide.
    const c = map.project(map.getCenter());
    const w = map.getContainer().clientWidth / 2;
    const h = w / this.aspect;
    this.corners = this.toLngLat(fitRect({ x: c.x - w / 2, y: c.y - h / 2 }, { x: c.x + w / 2, y: c.y + h / 2 }, this.aspect));

    // Above the basemap and overlays (basemap-*, overlay-*), below coverage.
    const beforeId = (map.getStyle().layers ?? []).find(
      (l) => !l.id.startsWith('basemap-') && !l.id.startsWith('overlay-')
    )?.id;
    map.addSource(ID, { type: 'image', url, coordinates: this.corners });
    map.addLayer({ id: ID, type: 'raster', source: ID, paint: { 'raster-opacity': 0.6 } }, beforeId);

    // Corner handles: scale around the opposite corner, captured at drag start
    // (a drag can flip the rect, which reorders the corners).
    this.corners.forEach((_, i) => {
      const el = document.createElement('div');
      el.className = `mt-canvas-handle ${i % 2 ? 'mt-canvas-nesw' : 'mt-canvas-nwse'}`;
      const m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(this.corners[i]).addTo(map);
      let anchor: Pt;
      m.on('dragstart', () => (anchor = map.project(this.corners[(i + 2) % 4])));
      m.on('drag', () => {
        this.corners = this.toLngLat(fitRect(anchor, map.project(m.getLngLat()), this.aspect));
        this.update();
      });
      m.on('dragend', () => this.update()); // snap the handle onto its corner
      this.handles.push(m);
    });

    // Center handle: move the whole image by the pixel delta.
    const el = document.createElement('div');
    el.className = 'mt-canvas-move';
    el.title = 'Drag to move the canvas';
    const mv = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(this.center()).addTo(map);
    // Measure from the image center, not the marker at dragstart: MapLibre
    // fires dragstart after the click tolerance, when the marker has moved.
    let start: { at: Pt; px: Pt[] };
    mv.on('dragstart', () => (start = { at: map.project(this.center()), px: this.corners.map((p) => map.project(p)) }));
    mv.on('dragend', () => this.update());
    mv.on('drag', () => {
      const now = map.project(mv.getLngLat());
      const [dx, dy] = [now.x - start.at.x, now.y - start.at.y];
      this.corners = this.toLngLat(start.px.map((p) => ({ x: p.x + dx, y: p.y + dy })) as [Pt, Pt, Pt, Pt]);
      this.update(mv);
    });
    this.handles.push(mv);
  }

  setOpacity(v: number) {
    if (this.map.getLayer(ID)) this.map.setPaintProperty(ID, 'raster-opacity', v);
  }

  setLocked(locked: boolean) {
    for (const h of this.handles) h.getElement().style.display = locked ? 'none' : '';
  }

  remove() {
    this.handles.forEach((h) => h.remove());
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
  }

  private update(skip?: maplibregl.Marker) {
    (this.map.getSource(ID) as maplibregl.ImageSource | undefined)?.setCoordinates(this.corners);
    this.corners.forEach((p, i) => this.handles[i].setLngLat(p));
    if (skip !== this.handles[4]) this.handles[4]?.setLngLat(this.center());
  }

  private center(): [number, number] {
    const [tl, , br] = this.corners.map((p) => this.map.project(p));
    return this.map.unproject([(tl.x + br.x) / 2, (tl.y + br.y) / 2]).toArray() as [number, number];
  }

  private toLngLat(px: Pt[]): Corners {
    return px.map((p) => this.map.unproject([p.x, p.y]).toArray()) as Corners;
  }
}
