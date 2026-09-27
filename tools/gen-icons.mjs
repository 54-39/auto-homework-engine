/* 零依赖生成插件图标：蓝底圆角方块 + 白色闪电。node tools/gen-icons.mjs */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.writeUInt32BE(((r << 24) | (g << 16) | (b << 8) | a) >>> 0, rowStart + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 闪电多边形（128 坐标系），射线法判断点在多边形内
const BOLT = [[74, 6], [28, 70], [56, 70], [44, 122], [100, 50], [66, 50], [86, 6]];
function inBolt(px, py, s) {
  const x = (px / s) * 128, y = (py / s) * 128;
  let inside = false;
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i], [xj, yj] = BOLT[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inRoundedRect(px, py, s) {
  const m = (s / 128) * 6, r = (s / 128) * 22;
  if (px < m || py < m || px >= s - m || py >= s - m) return false;
  const cx = Math.max(m + r, Math.min(px, s - m - r));
  const cy = Math.max(m + r, Math.min(py, s - m - r));
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

const dir = path.join(process.cwd(), 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  const buf = png(size, (x, y) => {
    if (inBolt(x, y, size)) return [255, 255, 255, 255];
    if (inRoundedRect(x, y, size)) return [0x25, 0x63, 0xeb, 255];
    return [0, 0, 0, 0];
  });
  fs.writeFileSync(path.join(dir, `icon${size}.png`), buf);
  console.log(`icons/icon${size}.png  ${buf.length} bytes`);
}
