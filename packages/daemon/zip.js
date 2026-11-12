import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { fail } from "./storage.js";

const MAX32 = 0xffffffff;
const MADE_BY = (3 << 8) | 45;
const UTF8 = 0x0800;
const FILE_MODE = (0o100644 << 16) >>> 0;

function dosStamp(date) {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function zip64Extra(values) {
  if (!values.length) return Buffer.alloc(0);
  const extra = Buffer.alloc(4 + 8 * values.length);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8 * values.length, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * index));
  return extra;
}

export function localHeader(entry) {
  const name = Buffer.from(entry.name, "utf8");
  const large = entry.size >= MAX32;
  const extra = zip64Extra(large ? [entry.size, entry.size] : []);
  const { time, date } = dosStamp(entry.mtime);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(large ? 45 : 20, 4);
  header.writeUInt16LE(UTF8, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(large ? MAX32 : entry.size, 18);
  header.writeUInt32LE(large ? MAX32 : entry.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
}

export function centralHeader(entry, offset) {
  const name = Buffer.from(entry.name, "utf8");
  const large = entry.size >= MAX32;
  const far = offset >= MAX32;
  const extra = zip64Extra([...(large ? [entry.size, entry.size] : []), ...(far ? [offset] : [])]);
  const { time, date } = dosStamp(entry.mtime);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(MADE_BY, 4);
  header.writeUInt16LE(large || far ? 45 : 20, 6);
  header.writeUInt16LE(UTF8, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(large ? MAX32 : entry.size, 20);
  header.writeUInt32LE(large ? MAX32 : entry.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt32LE(FILE_MODE, 38);
  header.writeUInt32LE(far ? MAX32 : offset, 42);
  return Buffer.concat([header, name, extra]);
}

export function endRecords(count, start, size) {
  const records = [];
  const wide = count >= 0xffff || start >= MAX32 || size >= MAX32;
  if (wide) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(MADE_BY, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(size), 40);
    record.writeBigUInt64LE(BigInt(start), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(start + size), 8);
    locator.writeUInt32LE(1, 16);
    records.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, 0xffff), 8);
  end.writeUInt16LE(Math.min(count, 0xffff), 10);
  end.writeUInt32LE(Math.min(size, MAX32), 12);
  end.writeUInt32LE(Math.min(start, MAX32), 16);
  records.push(end);
  return Buffer.concat(records);
}

export async function scanFile(file) {
  const hash = crypto.createHash("sha256");
  let crc = 0;
  let size = 0;
  const input = fs.createReadStream(file, {
    flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    highWaterMark: 1024 * 1024,
  });
  for await (const chunk of input) {
    hash.update(chunk);
    crc = zlib.crc32(chunk, crc);
    size += chunk.length;
  }
  return { hash: hash.digest("hex"), crc, size };
}

export async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  for await (const entry of entries) {
    const header = localHeader(entry);
    central.push(centralHeader(entry, offset));
    yield header;
    offset += header.length;
    let crc = 0;
    let read = 0;
    if (entry.size)
      for await (const chunk of fs.createReadStream(entry.file, {
        flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
        start: 0,
        end: entry.size - 1,
        highWaterMark: 1024 * 1024,
      })) {
        crc = zlib.crc32(chunk, crc);
        read += chunk.length;
        yield chunk;
      }
    if (read !== entry.size || crc !== entry.crc)
      fail("File changed. Sync before downloading.", 409);
    offset += read;
  }
  const directory = Buffer.concat(central);
  yield directory;
  yield endRecords(central.length, offset, directory.length);
}
