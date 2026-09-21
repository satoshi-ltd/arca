import { Image, Platform } from "react-native";
import { File } from "expo-file-system";
import { readExif } from "./exif";

const FORMATS = { jpg: "JPEG", jpeg: "JPEG", tif: "TIFF", tiff: "TIFF" };
const dimensions = (uri) =>
  new Promise((resolve) =>
    Image.getSize(
      uri,
      (width, height) => resolve({ width, height }),
      () => resolve(null),
    ),
  );
// The downloaded copy already carries its EXIF; only hub acceptance needs the network.
export async function localPhotoInfo(item) {
  const extension = item.path.split(".").pop().toLowerCase();
  const result = { format: FORMATS[extension] || extension.toUpperCase() };
  const [size, exif] = await Promise.all([
    dimensions(item.uri),
    /^jpe?g$/.test(extension) ? readLocalExif(item.uri) : null,
  ]);
  if (exif) Object.assign(result, exif);
  if (size) {
    const rotated =
      Platform.OS === "android" &&
      exif?.orientation >= 5 &&
      exif.orientation <= 8;
    result.width = rotated ? size.height : size.width;
    result.height = rotated ? size.width : size.height;
  }
  delete result.orientation;
  return result;
}
async function readLocalExif(uri) {
  const handle = new File(uri).open();
  try {
    return await readExif(async (offset, length) => {
      if (offset >= handle.size) return new Uint8Array(0);
      handle.offset = offset;
      return handle.readBytes(Math.min(length, handle.size - offset));
    });
  } catch {
    return null;
  } finally {
    handle.close();
  }
}
