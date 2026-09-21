const TAGS = {
  0x010f: "make",
  0x0110: "model",
  0x0112: "orientation",
  0xa434: "lens",
  0x829d: "aperture",
  0x829a: "exposure",
  0x8827: "iso",
  0x920a: "focalLength",
  0x9003: "captured",
  0x9011: "offset",
};
const GPS = {
  0x0001: "latitudeRef",
  0x0002: "latitude",
  0x0003: "longitudeRef",
  0x0004: "longitude",
};
const SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const LIMIT = 4 * 1024 ** 2;
const CHUNK = 64 * 1024;

async function grow(read, head, needed) {
  const limit = Math.min(LIMIT, Math.max(needed, head.length + CHUNK));
  while (head.length < limit) {
    const more = await read(head.length, limit - head.length);
    if (!more?.length) break;
    const next = new Uint8Array(head.length + more.length);
    next.set(head);
    next.set(more, head.length);
    head = next;
  }
  return head;
}
// Same JPEG APP1 walk and tag set as the hub, so local and hub details never disagree.
export async function readExif(read) {
  let head = await read(0, CHUNK);
  if (!head || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let offset = 2;
  for (let segment = 0; segment < 64; segment++) {
    if (offset + 4 > head.length) {
      head = await grow(read, head, offset + 4);
      if (offset + 4 > head.length) return null;
    }
    if (head[offset] !== 0xff) return null;
    const marker = head[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null;
    const length = (head[offset + 2] << 8) | head[offset + 3];
    const end = offset + 2 + length;
    if (marker === 0xe1) {
      if (end > head.length) head = await grow(read, head, end);
      if (end > head.length) return null;
      const body = head.subarray(offset + 4, end);
      if (String.fromCharCode(...body.subarray(0, 6)) === "Exif\0\0")
        return parseTiff(body.subarray(6));
    }
    offset = end;
  }
  return null;
}
export function parseTiff(bytes) {
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, little);
  const u32 = (at) => view.getUint32(at, little);
  const i32 = (at) => view.getInt32(at, little);
  if (u16(2) !== 42) return null;
  const raw = {};
  const value = (type, count, at) => {
    if (type === 2)
      return String.fromCharCode(...bytes.subarray(at, at + count))
        .replace(/\0+$/, "")
        .trim();
    const one = (position) =>
      type === 3
        ? u16(position)
        : type === 4
          ? u32(position)
          : type === 5
            ? u32(position) / u32(position + 4)
            : type === 9
              ? i32(position)
              : type === 10
                ? i32(position) / i32(position + 4)
                : bytes[position];
    if (count === 1) return one(at);
    return Array.from({ length: count }, (_, index) =>
      one(at + index * SIZES[type]),
    );
  };
  const readIfd = (start, table, depth = 0) => {
    if (depth > 2 || start + 2 > bytes.length) return;
    const count = u16(start);
    for (let index = 0; index < count; index++) {
      const entry = start + 2 + index * 12;
      if (entry + 12 > bytes.length) return;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const items = u32(entry + 4);
      const size = (SIZES[type] || 0) * items;
      if (!size || size > 4096) continue;
      const at = size > 4 ? u32(entry + 8) : entry + 8;
      if (at + size > bytes.length) continue;
      if (tag === 0x8769 && table === TAGS)
        readIfd(u32(entry + 8), TAGS, depth + 1);
      else if (tag === 0x8825 && table === TAGS)
        readIfd(u32(entry + 8), GPS, depth + 1);
      else if (table[tag]) raw[table[tag]] = value(type, items, at);
    }
  };
  readIfd(u32(4), TAGS);
  return normalize(raw);
}
const degrees = (parts, ref) => {
  if (!Array.isArray(parts) || parts.length !== 3) return null;
  const [d, m, s] = parts;
  if (![d, m, s].every(Number.isFinite)) return null;
  const decimal = d + m / 60 + s / 3600;
  return /^[SW]/i.test(ref || "") ? -decimal : decimal;
};
function normalize(raw) {
  const result = {};
  for (const key of ["make", "model", "lens"])
    if (typeof raw[key] === "string" && raw[key])
      result[key] = raw[key].slice(0, 256);
  for (const key of ["aperture", "exposure", "iso", "focalLength"]) {
    const number = Array.isArray(raw[key]) ? raw[key][0] : raw[key];
    if (Number.isFinite(number) && number > 0) result[key] = number;
  }
  if (Number.isFinite(raw.orientation)) result.orientation = raw.orientation;
  if (/^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw.captured || "")) {
    result.captured =
      raw.captured.slice(0, 10).replaceAll(":", "-") +
      "T" +
      raw.captured.slice(11);
    if (/^[+-]\d{2}:\d{2}$/.test(raw.offset || "")) result.offset = raw.offset;
  }
  const latitude = degrees(raw.latitude, raw.latitudeRef);
  const longitude = degrees(raw.longitude, raw.longitudeRef);
  if (
    latitude != null &&
    longitude != null &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  )
    result.location = { latitude, longitude };
  return result;
}
