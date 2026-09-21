import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { uprightJpeg } from "../packages/daemon/jpeg-orientation.js";
import { encodeHeic, imageEncoder } from "../packages/daemon/image-encoder.js";

test("installed HEIC encoder preserves dimensions and capture metadata without modifying JPEG", async (t) => {
  if (!(await imageEncoder()).available)
    return t.skip("HEVC encoder is not installed on this runner");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arca-encoder-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, "original.jpg");
  const output = path.join(directory, "converted.heic");
  await sharp({
    create: { width: 1000, height: 500, channels: 3, background: "orange" },
  })
    .jpeg()
    .withExif({
      IFD0: { Artist: "Arca test" },
      IFD2: { DateTimeOriginal: "2020:01:02 03:04:05" },
    })
    .toFile(input);
  const original = fs.readFileSync(input);
  assert.ok(await encodeHeic(input, output));
  assert.deepEqual(fs.readFileSync(input), original);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 1000);
  assert.equal(metadata.height, 500);
});

test("HEIC conversion preserves all eight EXIF orientations and camera metadata", async (t) => {
  if (!(await imageEncoder()).available)
    return t.skip("HEVC encoder is not installed on this runner");
  const { heicPreview } = await import("../packages/daemon/heic-preview.js");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "arca-orientation-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pattern = Buffer.from(
    '<svg width="96" height="64"><rect width="48" height="32" fill="red"/><rect x="48" width="48" height="32" fill="lime"/><rect y="32" width="48" height="32" fill="blue"/><rect x="48" y="32" width="48" height="32" fill="yellow"/></svg>',
  );
  for (let orientation = 1; orientation <= 8; orientation++) {
    const input = path.join(directory, `${orientation}.jpg`);
    const output = path.join(directory, `${orientation}.heic`);
    await sharp(pattern)
      .resize(101, 67)
      .jpeg()
      .withMetadata({ orientation })
      .withExifMerge({
        IFD0: { Make: "Arca test camera", Model: "Orientation test" },
        IFD2: { DateTimeOriginal: "2020:01:02 03:04:05" },
      })
      .toFile(input);
    const original = fs.readFileSync(input);
    const stages = [];
    await encodeHeic(input, output, (stage) => stages.push(stage));
    assert.equal(stages[0], "Reading metadata");
    assert.equal(stages.at(-1), "Verifying decoded image");
    assert.ok(stages.includes("Encoding HEIC"));
    assert.deepEqual(fs.readFileSync(input), original);
    const actual = await heicPreview(output, true, true);
    const expected = await sharp(input)
      .rotate()
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(
      actual.width,
      expected.info.width,
      `orientation ${orientation}`,
    );
    assert.equal(
      actual.height,
      expected.info.height,
      `orientation ${orientation}`,
    );
    const pixels = await sharp(actual.bytes).removeAlpha().raw().toBuffer();
    // Distinct corners detect rotations and reflections, including square-axis
    // flips that a dimensions-only check cannot distinguish.
    for (const y of [8, actual.height - 9])
      for (const x of [8, actual.width - 9])
        for (let channel = 0; channel < 3; channel++) {
          const offset = (y * actual.width + x) * 3 + channel;
          assert.ok(
            Math.abs(pixels[offset] - expected.data[offset]) < 30,
            `orientation ${orientation}, corner ${x},${y}`,
          );
        }
  }
});

test("orientation preparation preserves partial edge pixels without JPEG recompression", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "arca-edge-orientation-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (let orientation = 1; orientation <= 8; orientation++) {
    // Sharp can retain file handles in its cache after a pipeline completes.
    // Each orientation needs independent files, including on Windows.
    const input = path.join(directory, `input-${orientation}.jpg`);
    const output = path.join(directory, `upright-${orientation}.png`);
    await sharp({
      create: { width: 101, height: 67, channels: 3, background: "orange" },
    })
      .jpeg()
      .withMetadata({ orientation })
      .withExifMerge({ IFD0: { Make: "Samsung", Model: "Test camera" } })
      .toFile(input);
    const original = fs.readFileSync(input);
    await uprightJpeg(input, output, orientation);
    const expected = await sharp(input)
      .autoOrient()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const actual = await sharp(output)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual(actual, expected, `orientation ${orientation}`);
    assert.equal((await sharp(output).metadata()).orientation, 1);
    assert.deepEqual(fs.readFileSync(input), original);
  }
});
