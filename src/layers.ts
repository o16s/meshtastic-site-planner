/* Branded map markers (MapLibre takes plain DOM elements).
 * The basemap catalog lives in src/map/styles.ts. */

/* Site pin: amber teardrop with the dark Octanis node glyph, inline SVG so it
 * stays crisp at any zoom/DPI. The marker is anchored at 'bottom', so the
 * teardrop tip sits on the coordinate at every zoom level.
 *
 * The glyph uses the same geometry as public/icon.svg (4 dots + 2 strokes in a
 * 48 32 76 112 viewBox, measured from the octanis.ch favicon). A nested <svg>
 * maps that viewBox into a 20-tall box centered in the teardrop head; keep the
 * two in sync if the glyph changes. */
const PIN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">
  <path d="M17 1C8.16 1 1 8.16 1 17c0 11.5 13.2 24.06 15.06 25.78a1.4 1.4 0 0 0 1.88 0C19.8 41.06 33 28.5 33 17 33 8.16 25.84 1 17 1Z"
        fill="#ffbf00" stroke="#0f1017" stroke-width="1.5"/>
  <svg x="10.2" y="7" width="13.6" height="20" viewBox="48 32 76 112">
    <g fill="#0f1017" stroke="#0f1017" stroke-width="7">
      <line x1="71.5" y1="71.5" x2="111.5" y2="43.5"/>
      <line x1="71.5" y1="71.5" x2="111.5" y2="131.5"/>
      <circle cx="111.5" cy="43.5" r="12" stroke="none"/>
      <circle cx="71.5" cy="71.5" r="12" stroke="none"/>
      <circle cx="59.5" cy="119.5" r="12" stroke="none"/>
      <circle cx="111.5" cy="131.5" r="12" stroke="none"/>
    </g>
  </svg>
</svg>`;

/** Marker element for a simulated site. */
export function sitePinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mt-pin';
  el.innerHTML = PIN_SVG;
  return el;
}

/** Draft transmitter position (before a run): same pin, pulsing halo. */
export function draftPinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mt-pin mt-pin-draft';
  el.innerHTML = `<span class="mt-pin-pulse" aria-hidden="true"></span>${PIN_SVG}`;
  return el;
}

/* Point-to-point target (receiver) pin: a blue teardrop with a hollow dot, so
 * it reads as the "other end" of a link, distinct from the amber TX pin (#14). */
const TARGET_PIN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 34 44">
  <path d="M17 1C8.16 1 1 8.16 1 17c0 11.5 13.2 24.06 15.06 25.78a1.4 1.4 0 0 0 1.88 0C19.8 41.06 33 28.5 33 17 33 8.16 25.84 1 17 1Z"
        fill="#3aa0ff" stroke="#0f1017" stroke-width="1.5"/>
  <circle cx="17" cy="17" r="6" fill="none" stroke="#0f1017" stroke-width="3"/>
</svg>`;

/** Draggable point-to-point target marker. */
export function targetPinElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mt-pin mt-pin-target';
  el.innerHTML = TARGET_PIN_SVG;
  return el;
}
