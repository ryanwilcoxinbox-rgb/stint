// One-off generator for the app/tray icons. Run with: node assets/generate-icons.js
// Produces assets/tray-icon.png (32x32) and assets/icon.ico (256x256 PNG-in-ICO).
// No external dependencies — builds PNGs by hand with zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Draw the Stint mark into an RGBA buffer of size n x n: a rounded gradient
// app-tile holding a white stopwatch whose hand reaches a green "live" dot.
// Matches the in-app SVG logo in renderer/index.html.
// state: 'idle' (stopped) | 'running' (counting) | 'paused' (session held)
function drawStopwatch(n, state) {
  const px = Buffer.alloc(n * n * 4, 0); // transparent
  const cx = n / 2, cy = n * 0.54;
  const rOuter = n * 0.30;        // watch-face radius
  const rRing = rOuter * 0.80;
  // Tile gradient signals the timer state at a glance from the tray:
  //   idle/stopped → indigo→violet, running → emerald, paused → amber.
  const TILE = {
    idle:    [[99, 102, 241], [168, 85, 247]],
    running: [[52, 211, 153], [5, 150, 105]],
    paused:  [[251, 191, 36], [217, 119, 6]],
  };
  const [C0, C1] = TILE[state] || TILE.idle;
  const white = [255, 255, 255];
  const green = [52, 211, 153];

  function set(x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const i = (y * n + x) * 4;
    // simple source-over compositing so soft edges blend over the tile
    const sa = a / 255, da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    for (let k = 0; k < 3; k++) {
      px[i + k] = Math.round((rgb[k] * sa + px[i + k] * da * (1 - sa)) / oa);
    }
    px[i + 3] = Math.round(oa * 255);
  }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Rounded-square app tile with a vertical gradient (signed-distance rounded
  // rect for clean anti-aliased corners).
  const margin = n * 0.07;
  const hx = n / 2 - margin, hy = n / 2 - margin;
  const rr = n * 0.22;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const qx = Math.abs(x + 0.5 - n / 2) - (hx - rr);
      const qy = Math.abs(y + 0.5 - n / 2) - (hy - rr);
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
      const d = Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - rr;
      const c = clamp(0.5 - d, 0, 1); // ~1px anti-aliased edge
      if (c > 0) {
        const t = clamp((y - margin) / (n - 2 * margin), 0, 1);
        set(x, y, lerp(C0, C1, t), Math.round(255 * c));
      }
    }
  }

  // White watch-face ring (outline only).
  const ringW = Math.max(1, n * 0.024);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const cvg = clamp((ringW / 2) - Math.abs(d - rOuter) + 0.5, 0, 1);
      if (cvg > 0) set(x, y, white, Math.round(150 * cvg));
    }
  }

  function line(x0, y0, x1, y1, w, rgb, a) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3 + 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let oy = -w; oy <= w; oy++)
        for (let ox = -w; ox <= w; ox++)
          if (ox * ox + oy * oy <= w * w) set(Math.round(x + ox), Math.round(y + oy), rgb, a);
    }
  }

  // Single hand reaching the live "now" point (upper-right), plus center hub.
  const hw = Math.max(1, Math.round(n * 0.020));
  const tipx = cx + rRing * 0.72, tipy = cy - rRing * 0.72;
  line(cx, cy, tipx, tipy, hw, white, 255);
  for (let y = -hw * 2; y <= hw * 2; y++)
    for (let x = -hw * 2; x <= hw * 2; x++)
      if (x * x + y * y <= (hw * 1.8) ** 2) set(Math.round(cx + x), Math.round(cy + y), white, 255);

  // Live tracking dot at the hand tip — emerald on the idle tile to carry the
  // brand accent; white on the coloured (running/paused) tiles so it still reads.
  const dotR = Math.max(1.5, n * 0.065);
  const dotC = state === 'idle' ? green : white;
  for (let y = Math.floor(tipy - dotR - 1); y <= Math.ceil(tipy + dotR + 1); y++)
    for (let x = Math.floor(tipx - dotR - 1); x <= Math.ceil(tipx + dotR + 1); x++) {
      const d = Math.sqrt((x + 0.5 - tipx) ** 2 + (y + 0.5 - tipy) ** 2);
      const c = clamp(dotR - d + 0.5, 0, 1);
      if (c > 0) set(x, y, dotC, Math.round(255 * c));
    }

  return px;
}

function encodePNG(n, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines with filter byte 0
  const raw = Buffer.alloc(n * (n * 4 + 1));
  for (let y = 0; y < n; y++) {
    raw[y * (n * 4 + 1)] = 0;
    rgba.copy(raw, y * (n * 4 + 1) + 1, y * n * 4, (y + 1) * n * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeIco(pngBuf, size) {
  // ICONDIR (6) + ICONDIRENTRY (16) + PNG data
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // color planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset
  return Buffer.concat([header, entry, pngBuf]);
}

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'tray-icon.png'), encodePNG(32, drawStopwatch(32, 'idle')));
fs.writeFileSync(path.join(outDir, 'tray-icon-active.png'), encodePNG(32, drawStopwatch(32, 'running')));
fs.writeFileSync(path.join(outDir, 'tray-icon-paused.png'), encodePNG(32, drawStopwatch(32, 'paused')));

const png256 = encodePNG(256, drawStopwatch(256, 'idle'));
fs.writeFileSync(path.join(outDir, 'icon.ico'), makeIco(png256, 256));

console.log('Wrote tray-icon.png, tray-icon-active.png, tray-icon-paused.png and icon.ico to', outDir);
