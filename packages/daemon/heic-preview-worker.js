import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs/promises";
import createHeif from "libheif-js/libheif-wasm/libheif-bundle.js";
import sharp from "sharp";

// Decode outside the daemon's event loop. The worker owns and releases all
// decoder memory when finished; it never writes to the original file.
try {
  const stat = await fs.stat(workerData.file);
  if (stat.size > 128 * 1024 ** 2)
    throw new Error("HEIC original exceeds preview limit");
  const heif = await createHeif();
  const images = new heif.HeifDecoder().decode(
    await fs.readFile(workerData.file),
  );
  const image = images.find((image) => image.is_primary()) || images[0];
  if (!image) throw new Error("No HEIC image found");
  const width = image.get_width(),
    height = image.get_height();
  if (!(width > 0 && height > 0) || width * height > 100000000)
    throw new Error("HEIC dimensions exceed preview limit");
  const pixels = await new Promise((resolve, reject) => {
    image.display(
      { width, height, data: new Uint8ClampedArray(width * height * 4) },
      (data) =>
        data ? resolve(data.data) : reject(new Error("HEIC decoding failed")),
    );
  });
  const size = workerData.large ? 2048 : 360;
  // libheif applies the container's orientation during decoding.
  const jpeg = await sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 },
  })
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: workerData.large ? 85 : 75 })
    .toBuffer();
  parentPort.postMessage({ jpeg, width, height });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
