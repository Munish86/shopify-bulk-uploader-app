// Builds docs/review-kit/: the product template plus sample images named after its example rows, so the
// App Store reviewer (and the demo video) can run a full upload with images in a minute.
// Run: node scripts/build-review-kit.cjs
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const out = path.join(root, 'docs', 'review-kit');
const imgDir = path.join(out, 'images');
fs.mkdirSync(imgDir, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// A simple product-like picture: background, a darker "product" block and a floor line
function png(size, bg, fg) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inBlock = x > size * 0.15 && x < size * 0.85 && y > size * 0.35 && y < size * 0.72;
      const floor = y >= size * 0.72 && y < size * 0.74;
      const c = inBlock ? fg : floor ? [60, 60, 60] : bg;
      row.set(c, 1 + x * 3);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// File names follow the template's "Image Name" column: "<name>.png", "<name>_1.png", ...
const IMAGES = [
  ['Oslo 3 Seater Sofa.png', [235, 238, 242], [120, 130, 145]],
  ['Oslo 3 Seater Sofa_1.png', [235, 238, 242], [70, 100, 160]],
  ['Aria King Bed.png', [244, 240, 234], [150, 110, 90]],
  ['Nordic Coffee Table.png', [240, 244, 238], [190, 150, 100]],
];
for (const [name, bg, fg] of IMAGES) fs.writeFileSync(path.join(imgDir, name), png(800, bg, fg));

fs.copyFileSync(path.join(root, 'public', 'templates', 'Shopify-Product-Template.xlsx'), path.join(out, 'Shopify-Product-Template.xlsx'));
console.log(`Review kit written to ${out}`);
