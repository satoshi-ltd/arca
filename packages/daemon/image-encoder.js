import { uprightJpeg } from "./jpeg-orientation.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import sharp from "sharp";
import exifr from "exifr";
import { heicPreview } from "./heic-preview.js";

const run = promisify(execFile);
const metadataFields = [
  "Make",
  "Model",
  "LensModel",
  "LensMake",
  "DateTimeOriginal",
  "CreateDate",
  "ModifyDate",
  "OffsetTimeOriginal",
  "OffsetTimeDigitized",
  "SubSecTimeOriginal",
  "ExposureTime",
  "FNumber",
  "ISO",
  "FocalLength",
  "FocalLengthIn35mmFormat",
  "Artist",
  "Copyright",
  "ImageDescription",
  "GPSLatitude",
  "GPSLongitude",
  "GPSLatitudeRef",
  "GPSLongitudeRef",
  "GPSAltitude",
  "GPSAltitudeRef",
  "GPSTimeStamp",
  "GPSDateStamp",
  "MakerNote",
];
export async function imageEncoder() {
  if (process.platform === "darwin")
    return { available: true, name: "macOS HEIC encoder" };
  try {
    await run("heif-enc", ["--help"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { available: true, name: "libheif HEVC encoder · fast preset" };
  } catch {
    return {
      available: false,
      name: "HEIC encoding unavailable. Install libheif with heif-enc, an HEVC encoder on this hub. The Arca Docker image includes it.",
    };
  }
}
export async function encodeHeic(source, destination, progress = () => {}) {
  progress("Reading metadata");
  if (fs.statSync(source).size > 128 * 1024 ** 2)
    throw new Error("Image exceeds the conversion limit");
  const before = await sharp(source, {
    limitInputPixels: 100000000,
  }).metadata();
  if (before.format !== "jpeg")
    throw new Error("Only JPEG originals can be optimized");
  const options = {
    timeout: 60000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  };
  progress("Encoding HEIC");
  if (process.platform === "darwin")
    await run(
      "/usr/bin/sips",
      [
        "-s",
        "format",
        "heic",
        "-s",
        "formatOptions",
        "85",
        source,
        "--out",
        destination,
      ],
      options,
    );
  else {
    const temporary = destination + ".upright.png";
    try {
      let input = source;
      if (before.orientation > 1) {
        progress("Normalizing orientation without loss");
        await uprightJpeg(source, temporary, before.orientation);
        input = temporary;
      }
      progress("Encoding HEIC");
      await run(
        "heif-enc",
        ["-q", "85", "-p", "preset=fast", "-o", destination, input],
        options,
      );
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  progress("Checking metadata");
  const after = await sharp(destination).metadata();
  for (const key of ["icc", "xmp", "iptc"])
    if (before[key] && !before[key].equals(after[key] || Buffer.alloc(0)))
      throw new Error(
        `Conversion did not preserve ${key.toUpperCase()} metadata`,
      );
  // Sharp exposes the HEIF item's TIFF payload directly. exifr's container
  // parser cannot read every valid HEIC layout (including libheif 1.15 output).
  const read = (meta) => {
    if (!meta.exif) return null;
    const payload =
      meta.exif.subarray(0, 6).toString() === "Exif\0\0"
        ? meta.exif.subarray(6)
        : meta.exif;
    return exifr.parse(payload, {
      tiff: true,
      exif: true,
      gps: true,
      translateValues: false,
      reviveValues: false,
    });
  };
  const [original, converted] = await Promise.all([read(before), read(after)]);
  for (const key of metadataFields)
    if (
      original?.[key] !== undefined &&
      JSON.stringify(original[key]) !== JSON.stringify(converted?.[key])
    )
      throw new Error(`Conversion did not preserve ${key}`);
  progress("Verifying decoded image");
  // HEIF container transforms may replace the JPEG EXIF orientation. Compare
  // the displayed geometry after decoding, not raw storage dimensions/tags.
  const decoded = await heicPreview(destination, true, true);
  const rotated = before.orientation >= 5 && before.orientation <= 8;
  if (
    decoded.width !== (rotated ? before.height : before.width) ||
    decoded.height !== (rotated ? before.width : before.height)
  )
    throw new Error("Conversion did not preserve image geometry");
  return fs.statSync(destination).size;
}
