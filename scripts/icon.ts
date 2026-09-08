/**
 * The Marketplace icon, generated rather than committed as an opaque binary.
 *
 * `resources/icon.png` has to agree with `resources/activity-bar.svg` - they are
 * the same mark at two sizes - and a hand-edited PNG drifts from the SVG the
 * first time either is touched, with nothing to catch it. This draws the icon
 * from the same numbers the SVG uses, so changing the mark means changing one
 * set of coordinates and running this.
 *
 * No dependencies, because the extension has none and a build-time image
 * library would be the only one. PNG is a container this can write in fifty
 * lines: `node:zlib` does the compression, and the rest is four chunks and a
 * CRC.
 *
 *   node scripts/icon.ts
 */

import { crc32, deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const SIZE = 128;
/** Samples per pixel per axis. Enough that a curve has no visible stair. */
const SUPERSAMPLE = 4;

// The activity-bar SVG is a 24-unit box. Everything below is those coordinates,
// mapped once, so the two files cannot disagree about the shape.
const SCALE = 4.6;
const OFFSET_X = 8.79;
const OFFSET_Y = 5.59;
const x = (unit: number): number => OFFSET_X + SCALE * unit;
const y = (unit: number): number => OFFSET_Y + SCALE * unit;
const size = (unit: number): number => SCALE * unit;

type Rgb = readonly [number, number, number];

/** The family's dark tile, the light mark on it, and one accent. */
const BACKGROUND: Rgb = [0x19, 0x1d, 0x27];
const MARK: Rgb = [0xe9, 0xed, 0xf3];
// The branch node, and only that one: an accent on every node would be
// decoration, whereas one says "this line went somewhere else".
const ACCENT: Rgb = [0x4f, 0x8f, 0xe0];

const STROKE = size(1.5);
const NODE = size(1.9);

interface Point {
  readonly x: number;
  readonly y: number;
}

const at = (ux: number, uy: number): Point => ({ x: x(ux), y: y(uy) });

/** The folder, as the SVG draws it: `M2.6 20.8V4.6h6l1.7 2.3h11.1v13.9z`. */
const FOLDER: readonly Point[] = [
  at(2.6, 20.8),
  at(2.6, 4.6),
  at(8.6, 4.6),
  at(10.3, 6.9),
  at(21.4, 6.9),
  at(21.4, 20.8),
];

function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lengthSquared));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function distanceToPolygon(px: number, py: number, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    best = Math.min(best, distanceToSegment(px, py, a, b));
  }
  return best;
}

/**
 * Distance to a quarter arc, for the elbow the branch turns through.
 *
 * Outside the arc's angular span the nearest point is an endpoint, not the
 * projection onto the circle - without that the corner would grow a spur.
 */
function distanceToArc(
  px: number,
  py: number,
  centre: Point,
  radius: number,
  fromDegrees: number,
  toDegrees: number,
): number {
  const angle = Math.atan2(py - centre.y, px - centre.x);
  const degrees = ((angle * 180) / Math.PI + 360) % 360;
  if (degrees >= fromDegrees && degrees <= toDegrees) {
    return Math.abs(Math.hypot(px - centre.x, py - centre.y) - radius);
  }
  const end = (degrees_: number): Point => ({
    x: centre.x + radius * Math.cos((degrees_ * Math.PI) / 180),
    y: centre.y + radius * Math.sin((degrees_ * Math.PI) / 180),
  });
  const a = end(fromDegrees);
  const b = end(toDegrees);
  return Math.min(Math.hypot(px - a.x, py - a.y), Math.hypot(px - b.x, py - b.y));
}

/** The rounded tile every icon in this family sits on. */
function insideTile(px: number, py: number): boolean {
  const radius = 28;
  const dx = Math.max(radius - px, px - (SIZE - radius), 0);
  const dy = Math.max(radius - py, py - (SIZE - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

/** What colour a single sample lands on, or `undefined` for outside the tile. */
function sample(px: number, py: number): Rgb | undefined {
  if (!insideTile(px, py)) {
    return undefined;
  }

  const half = STROKE / 2;

  // The branch node is drawn last in the SVG and wins here for the same reason.
  if (Math.hypot(px - x(16), py - y(10.8)) <= NODE) {
    return ACCENT;
  }
  if (Math.hypot(px - x(8.6), py - y(10.6)) <= NODE) {
    return MARK;
  }
  if (Math.hypot(px - x(8.6), py - y(18.2)) <= NODE) {
    return MARK;
  }

  // `M8.6 12.4v4.2`
  if (distanceToSegment(px, py, at(8.6, 12.4), at(8.6, 16.6)) <= half) {
    return MARK;
  }
  // `M16 12.6v.6`, then the quarter turn, then `H8.6`.
  if (distanceToSegment(px, py, at(16, 12.6), at(16, 13.2)) <= half) {
    return MARK;
  }
  if (distanceToArc(px, py, at(13.4, 13.2), size(2.6), 0, 90) <= half) {
    return MARK;
  }
  if (distanceToSegment(px, py, at(13.4, 15.8), at(8.6, 15.8)) <= half) {
    return MARK;
  }

  if (distanceToPolygon(px, py, FOLDER) <= half) {
    return MARK;
  }

  return BACKGROUND;
}

// --- the raster --------------------------------------------------------------

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
const step = 1 / SUPERSAMPLE;
const samples = SUPERSAMPLE * SUPERSAMPLE;

for (let row = 0; row < SIZE; row += 1) {
  // One filter byte per scanline, and the filter is None: the image is 64 KB
  // before compression and zlib does the work that a per-row filter would.
  const rowStart = row * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  for (let column = 0; column < SIZE; column += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let alpha = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
      for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
        const colour = sample(column + (sx + 0.5) * step, row + (sy + 0.5) * step);
        if (colour) {
          r += colour[0];
          g += colour[1];
          b += colour[2];
          alpha += 1;
        }
      }
    }
    const offset = rowStart + 1 + column * 4;
    // Averaged over the covering samples only, so an edge pixel takes the
    // colour of what is actually there rather than a blend with black.
    raw[offset] = alpha === 0 ? 0 : Math.round(r / alpha);
    raw[offset + 1] = alpha === 0 ? 0 : Math.round(g / alpha);
    raw[offset + 2] = alpha === 0 ? 0 : Math.round(b / alpha);
    raw[offset + 3] = Math.round((alpha / samples) * 255);
  }
}

// --- the container -----------------------------------------------------------

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, check]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(SIZE, 0);
header.writeUInt32BE(SIZE, 4);
header[8] = 8; // bit depth
header[9] = 6; // truecolour with alpha
header[10] = 0; // deflate
header[11] = 0; // adaptive filtering
header[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = new URL('../resources/icon.png', import.meta.url);
writeFileSync(target, png);
console.log(`wrote ${target.pathname.slice(1)} (${png.length} bytes)`);
