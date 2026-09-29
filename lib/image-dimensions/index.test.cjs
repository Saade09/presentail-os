"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const imageSize = require("./index.cjs");

test("measures PNG, GIF, BMP, JPEG, and WebP assets", () => {
  const png = Buffer.alloc(24);
  png[0] = 0x89;
  png.write("PNG", 1);
  png.write("IHDR", 12);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(240, 20);

  const gif = Buffer.alloc(10);
  gif.write("GIF89a");
  gif.writeUInt16LE(320, 6);
  gif.writeUInt16LE(240, 8);

  const bmp = Buffer.alloc(26);
  bmp.write("BM");
  bmp.writeInt32LE(320, 18);
  bmp.writeInt32LE(-240, 22);

  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0xf0, 0x01, 0x40,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);

  const webp = Buffer.alloc(30);
  webp.write("RIFF");
  webp.write("WEBP", 8);
  webp.write("VP8X", 12);
  webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(319, 24, 3);
  webp.writeUIntLE(239, 27, 3);

  for (const input of [png, gif, bmp, jpeg, webp]) {
    assert.deepEqual(imageSize(input), { width: 320, height: 240, type: imageSize(input).type });
  }
});

test("rejects malformed inputs without looping", () => {
  const malformedJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00]);
  const malformedWebp = Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8X", "binary");

  assert.throws(() => imageSize(malformedJpeg), /unsupported or invalid/i);
  assert.throws(() => imageSize(malformedWebp), /unsupported or invalid/i);
});