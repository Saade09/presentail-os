"use strict";

const fs = require("node:fs");

const MAX_SVG_HEADER_BYTES = 64 * 1024;
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function invalidImage() {
  throw new TypeError("Unsupported or invalid image format");
}

function inputToBuffer(input) {
  if (typeof input === "string") {
    return fs.readFileSync(input);
  }
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return invalidImage();
}

function hasBytes(buffer, offset, count) {
  return offset >= 0 && count >= 0 && offset + count <= buffer.length;
}

function dimensions(width, height, type) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return invalidImage();
  }
  return { width, height, type };
}

function png(buffer) {
  if (
    !hasBytes(buffer, 0, 24) ||
    buffer.toString("ascii", 1, 4) !== "PNG" ||
    buffer[0] !== 0x89 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }
  return dimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20), "png");
}

function gif(buffer) {
  if (!hasBytes(buffer, 0, 10) || !["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return null;
  }
  return dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8), "gif");
}

function bmp(buffer) {
  if (!hasBytes(buffer, 0, 26) || buffer.toString("ascii", 0, 2) !== "BM") {
    return null;
  }
  return dimensions(buffer.readInt32LE(18), Math.abs(buffer.readInt32LE(22)), "bmp");
}

function jpeg(buffer) {
  if (!hasBytes(buffer, 0, 4) || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;

    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      continue;
    }
    if (!hasBytes(buffer, offset, 2)) break;

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || !hasBytes(buffer, offset, segmentLength)) {
      return invalidImage();
    }
    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) return invalidImage();
      return dimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3), "jpg");
    }
    offset += segmentLength;
  }
  return invalidImage();
}

function webp(buffer) {
  if (
    !hasBytes(buffer, 0, 20) ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WEBP"
  ) {
    return null;
  }

  let offset = 12;
  while (hasBytes(buffer, offset, 8)) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + chunkLength + (chunkLength % 2);
    if (nextOffset > buffer.length || nextOffset <= offset) return invalidImage();

    if (chunkType === "VP8X" && chunkLength >= 10) {
      const width = 1 + buffer.readUIntLE(dataOffset + 4, 3);
      const height = 1 + buffer.readUIntLE(dataOffset + 7, 3);
      return dimensions(width, height, "webp");
    }
    if (chunkType === "VP8 " && chunkLength >= 10 && buffer[dataOffset + 3] === 0x9d && buffer[dataOffset + 4] === 0x01 && buffer[dataOffset + 5] === 0x2a) {
      return dimensions(buffer.readUInt16LE(dataOffset + 6) & 0x3fff, buffer.readUInt16LE(dataOffset + 8) & 0x3fff, "webp");
    }
    if (chunkType === "VP8L" && chunkLength >= 5 && buffer[dataOffset] === 0x2f) {
      const bits = buffer.readUInt32LE(dataOffset + 1);
      return dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, "webp");
    }
    offset = nextOffset;
  }
  return invalidImage();
}

function psd(buffer) {
  if (!hasBytes(buffer, 0, 22) || buffer.toString("ascii", 0, 4) !== "8BPS") {
    return null;
  }
  return dimensions(buffer.readUInt32BE(18), buffer.readUInt32BE(14), "psd");
}

function ktx(buffer) {
  const ktx1 = "ab4b5458203131bb0d0a1a0a";
  const ktx2 = "ab4b5458203230bb0d0a1a0a";
  const signature = buffer.subarray(0, 12).toString("hex");
  if (signature === ktx1 && hasBytes(buffer, 36, 8)) {
    return dimensions(buffer.readUInt32LE(36), buffer.readUInt32LE(40), "ktx");
  }
  if (signature === ktx2 && hasBytes(buffer, 20, 8)) {
    return dimensions(buffer.readUInt32LE(20), buffer.readUInt32LE(24), "ktx2");
  }
  return null;
}

function svg(buffer) {
  const header = buffer.subarray(0, MAX_SVG_HEADER_BYTES).toString("utf8");
  const start = header.indexOf("<svg");
  if (start === -1) return null;
  const tagEnd = header.indexOf(">", start);
  if (tagEnd === -1) return invalidImage();
  const tag = header.slice(start, tagEnd + 1);
  const width = /\bwidth\s*=\s*["']\s*([0-9]+(?:\.[0-9]+)?)/i.exec(tag);
  const height = /\bheight\s*=\s*["']\s*([0-9]+(?:\.[0-9]+)?)/i.exec(tag);
  if (width && height) {
    return dimensions(Math.round(Number(width[1])), Math.round(Number(height[1])), "svg");
  }
  const viewBox = /\bviewBox\s*=\s*["']\s*[-+]?[0-9.]+\s+[-+]?[0-9.]+\s+([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)/i.exec(tag);
  if (viewBox) {
    return dimensions(Math.round(Number(viewBox[1])), Math.round(Number(viewBox[2])), "svg");
  }
  return invalidImage();
}

function tiff(buffer) {
  if (!hasBytes(buffer, 0, 8)) return null;
  const littleEndian = buffer.toString("ascii", 0, 2) === "II";
  const bigEndian = buffer.toString("ascii", 0, 2) === "MM";
  if (!littleEndian && !bigEndian) return null;

  const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  if (read16.call(buffer, 2) !== 42) return null;
  const ifdOffset = read32.call(buffer, 4);
  if (!hasBytes(buffer, ifdOffset, 2)) return invalidImage();
  const count = read16.call(buffer, ifdOffset);
  if (!hasBytes(buffer, ifdOffset + 2, count * 12)) return invalidImage();

  let width;
  let height;
  for (let index = 0; index < count; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    const tag = read16.call(buffer, entry);
    const fieldType = read16.call(buffer, entry + 2);
    const valueCount = read32.call(buffer, entry + 4);
    if ((tag !== 256 && tag !== 257) || valueCount !== 1) continue;
    const value = fieldType === 3 ? read16.call(buffer, entry + 8) : fieldType === 4 ? read32.call(buffer, entry + 8) : undefined;
    if (value === undefined) continue;
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return width && height ? dimensions(width, height, "tiff") : invalidImage();
}

function imageSize(input) {
  const buffer = inputToBuffer(input);
  return (
    png(buffer) ??
    gif(buffer) ??
    bmp(buffer) ??
    jpeg(buffer) ??
    webp(buffer) ??
    psd(buffer) ??
    ktx(buffer) ??
    svg(buffer) ??
    tiff(buffer) ??
    invalidImage()
  );
}

module.exports = imageSize;
module.exports.imageSize = imageSize;
module.exports.default = imageSize;