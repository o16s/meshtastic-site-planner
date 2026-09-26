/* Import receiver sites from a zipped Esri point shapefile (.shp + .dbf +
 * .prj [+ .cpg]). Pure (no DOM/map): unzip with the platform's
 * DecompressionStream, parse .shp/.dbf with DataView, and convert the
 * coordinates to WGS 84. */

export interface ImportedPoint {
  lat: number;
  lon: number;
  name: string;
}

/** Minimal zip reader: stored (0) and deflate (8) entries, keyed by lowercase name. */
export async function unzip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory offset
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = new Uint8Array(buf, start, size);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8)
      data = new Uint8Array(
        await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
      );
    else throw new Error(`Unsupported zip compression (method ${method}) for ${name}.`);
    out.set(name.toLowerCase(), data);
  }
  return out;
}

/** Point records in file order; null for Null shapes. */
export function parseShp(bytes: Uint8Array): ({ x: number; y: number } | null)[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error('Not a shapefile (.shp).');
  const type = dv.getInt32(32, true);
  if (type !== 1) throw new Error(`Unsupported shape type ${type} (only Point, type 1, is supported).`);
  const pts: ({ x: number; y: number } | null)[] = [];
  for (let p = 100; p + 12 <= bytes.byteLength; ) {
    const len = dv.getInt32(p + 4, false) * 2; // content length, 16-bit words
    const t = dv.getInt32(p + 8, true);
    if (t === 0) pts.push(null);
    else if (t === 1) pts.push({ x: dv.getFloat64(p + 12, true), y: dv.getFloat64(p + 20, true) });
    else throw new Error(`Unsupported shape type ${t} in record ${pts.length + 1}.`);
    p += 8 + len;
  }
  return pts;
}

/** dBASE rows with trimmed text values; deleted rows are flagged, not dropped. */
export function parseDbf(bytes: Uint8Array, encoding = 'utf-8'): { deleted: boolean; fields: Record<string, string> }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recLen = dv.getUint16(10, true);
  let dec: TextDecoder;
  try {
    dec = new TextDecoder(encoding);
  } catch {
    dec = new TextDecoder(`windows-${encoding}`); // .cpg often says just "1252"
  }
  const fields: { name: string; len: number }[] = [];
  for (let p = 32; p < headerLen - 1 && bytes[p] !== 0x0d; p += 32) {
    fields.push({ name: dec.decode(bytes.subarray(p, p + 11)).replace(/\0.*$/s, ''), len: bytes[p + 16] });
  }
  const rows: { deleted: boolean; fields: Record<string, string> }[] = [];
  for (let i = 0; i < n; i++) {
    let p = headerLen + i * recLen;
    const deleted = bytes[p] === 0x2a;
    p++;
    const rec: Record<string, string> = {};
    for (const f of fields) {
      rec[f.name] = dec.decode(bytes.subarray(p, p + f.len)).trim();
      p += f.len;
    }
    rows.push({ deleted, fields: rec });
  }
  return rows;
}

/** Coordinate converter for the .prj's CRS. */
export function toWgs84(wkt: string): (x: number, y: number) => { lat: number; lon: number } {
  // ponytail: only Web Mercator + WGS 84 geographic; add proj4 when a file in
  // another CRS (e.g. UTM) shows up.
  const R = 6378137;
  const deg = 180 / Math.PI;
  if (/Mercator_Auxiliary_Sphere|Pseudo[_-]Mercator|Web_Mercator/i.test(wkt))
    return (x, y) => ({ lon: (x / R) * deg, lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * deg });
  if (/^\s*GEOGCS/i.test(wkt) && /WGS_?1984|WGS 84/i.test(wkt)) return (x, y) => ({ lon: x, lat: y });
  throw new Error(`Unsupported coordinate system in .prj (Web Mercator or WGS 84 only): ${wkt.trim()}`);
}

/** Zip -> receiver points (WGS 84), skipping deleted rows and null shapes. */
export async function importShapefileZip(buf: ArrayBuffer): Promise<{ points: ImportedPoint[]; skipped: number }> {
  const files = await unzip(buf);
  const shps = [...files.keys()].filter((k) => k.endsWith('.shp'));
  if (shps.length !== 1) throw new Error(`Expected exactly one .shp in the zip, found ${shps.length}.`);
  const base = shps[0].slice(0, -4);
  const need = (ext: string) => {
    const f = files.get(base + ext);
    if (!f) throw new Error(`Missing ${base}${ext} in the zip.`);
    return f;
  };
  const shp = parseShp(need('.shp'));
  const cpg = files.get(base + '.cpg');
  const rows = parseDbf(need('.dbf'), cpg ? new TextDecoder().decode(cpg).trim() || 'utf-8' : 'utf-8');
  const conv = toWgs84(new TextDecoder().decode(need('.prj')));
  if (shp.length !== rows.length)
    throw new Error(`.shp has ${shp.length} records but .dbf has ${rows.length}.`);

  const points: ImportedPoint[] = [];
  let skipped = 0;
  shp.forEach((pt, i) => {
    if (!pt || rows[i].deleted) return void skipped++;
    const id = parseFloat(rows[i].fields['Identity_'] ?? '');
    points.push({ ...conv(pt.x, pt.y), name: Number.isFinite(id) ? `Site ${Math.trunc(id)}` : `#${i + 1}` });
  });
  return { points, skipped };
}
