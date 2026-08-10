import fs from 'node:fs';
import path from 'node:path';

const [iconsetPath, outputPath] = process.argv.slice(2);
if (!iconsetPath || !outputPath) {
  throw new Error('Usage: node scripts/build-icns.mjs <iconset directory> <output.icns>');
}

// Modern ICNS files store each raster size as a PNG payload. Packing the
// container directly avoids iconutil, which rejects valid iconsets on some
// macOS 26 installations with only the non-actionable "Invalid Iconset".
const images = [
  ['icp4', 'icon_16x16.png', 16],
  ['icp5', 'icon_32x32.png', 32],
  ['icp6', 'icon_32x32@2x.png', 64],
  ['ic07', 'icon_128x128.png', 128],
  ['ic08', 'icon_256x256.png', 256],
  ['ic09', 'icon_512x512.png', 512],
  ['ic10', 'icon_512x512@2x.png', 1024]
];

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunks = images.map(([type, filename, expectedSize]) => {
  const png = fs.readFileSync(path.join(iconsetPath, filename));
  if (png.length < 24 || !png.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${filename} is not a PNG`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${filename} is ${width}x${height}; expected ${expectedSize}x${expectedSize}`);
  }
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
});

const payload = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(header.length + payload.length, 4);
fs.writeFileSync(outputPath, Buffer.concat([header, payload]));
