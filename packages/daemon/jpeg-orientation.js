import sharp from "sharp";

// Rotate decoded pixels into a lossless intermediate, including partial JPEG
// edge blocks. No crop or second lossy JPEG encode; the source is never written.
// The caller verifies metadata and decoded dimensions before accepting HEIC.
export async function uprightJpeg(source, destination) {
  await sharp(source, { limitInputPixels: 100000000 })
    .autoOrient()
    .keepMetadata()
    .png()
    .toFile(destination);
}
