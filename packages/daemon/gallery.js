import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { fail } from "./storage.js";

const images = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".gif",
]);
const videos = new Set([".mp4", ".mov", ".m4v", ".webm"]);
export function mediaKind(name) {
  const extension = path.extname(name).toLowerCase();
  return images.has(extension)
    ? "image"
    : videos.has(extension)
      ? "video"
      : null;
}
// File names retain dates for screenshots whose original format has no EXIF.
export function galleryDate(name, captured, added) {
  if (captured) return { date: captured, source: "metadata" };
  const filename = path.basename(name);
  const match = filename.match(
    /^(?:Screenshot[ _-]?|IMG[_-]?|VID[_-]?|PXL[_-]?)(\d{4})[-_]?([01]\d)[-_]?([0-3]\d)/i,
  );
  if (match) {
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    const date = new Date(day);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === day
    )
      return { date: day, source: "filename" };
  }
  const month = name.match(
    /^(?:Phone|Machine)-[a-f0-9]+\/(\d{4})\/(0[1-9]|1[0-2])\//,
  );
  if (month) return { date: `${month[1]}-${month[2]}`, source: "album folder" };
  return { date: added, source: "date added" };
}
// Derivatives are disposable and bounded; original objects remain untouched.
export class Gallery {
  constructor(store) {
    this.s = store;
    store.db.function("arca_media_kind", mediaKind);
    this.directory = path.join(store.home, "previews");
    fs.mkdirSync(this.directory, { recursive: true });
    this.queue = [];
    this.cache = new Map();
    this.cacheBytes = 0;
    this.running = 0;
    this.indexing = new Map();
  }
  close() {
    this.closed = true;
    this.queue = [];
  }
  schedule(volume, name, hash) {
    if (this.closed || mediaKind(name) !== "image" || this.queue.length >= 256)
      return;
    this.queue.push({ volume, name, hash });
    if (!this.background) {
      this.background = this.prepareQueued().finally(() => {
        this.background = null;
      });
    }
  }
  async prepareQueued() {
    while (!this.closed && this.queue.length) {
      const item = this.queue.shift();
      try {
        await this.preview(item.volume, item.name, item.hash);
      } catch {
        /* Read-time generation can retry. */
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  mark(volume) {
    this.s.volume(volume);
    this.s.db
      .prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)")
      .run(volume);
  }
  async index(volume) {
    if (this.indexing.has(volume)) return this.indexing.get(volume);
    const job = this.indexBatch(volume).finally(() =>
      this.indexing.delete(volume),
    );
    this.indexing.set(volume, job);
    return job;
  }
  async indexBatch(volume) {
    const s = this.s;
    const rows = s.db
      .prepare(
        `SELECT DISTINCT f.hash FROM files f LEFT JOIN gallery_metadata m ON m.hash=f.hash
      WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_media_kind(f.path) IS NOT NULL AND (m.hash IS NULL OR (m.captured IS NULL AND m.date_checked=0)) LIMIT 64`,
      )
      .all(volume);
    for (const row of rows) {
      let captured = null;
      try {
        const meta = await sharp(s.blob(row.hash), {
          limitInputPixels: 100000000,
        }).metadata();
        if (meta.exif?.length <= 4 * 1024 ** 2) {
          const tags = await exifr.parse(
            meta.exif.subarray(
              meta.exif.subarray(0, 6).toString() === "Exif\0\0" ? 6 : 0,
            ),
            {
              pick: ["DateTimeOriginal", "CreateDate", "ModifyDate"],
              reviveValues: false,
            },
          );
          const raw =
            tags?.DateTimeOriginal || tags?.CreateDate || tags?.ModifyDate;
          if (
            typeof raw === "string" &&
            /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
          )
            captured =
              raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11);
        }
      } catch {
        /* Missing capture metadata is a distinct, visible date group. */
      }
      // Uploaded originals are content-addressed. Do not overwrite a phone-provided capture time.
      if (this.closed) return false;
      s.db
        .prepare(
          "INSERT INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,1) ON CONFLICT(hash) DO UPDATE SET captured=coalesce(gallery_metadata.captured,excluded.captured),date_checked=1",
        )
        .run(row.hash, captured);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return rows.length === 64;
  }
  async page(volume, query) {
    const s = this.s;
    s.volume(volume);
    const excluded = s.visibleRules(volume);
    const indexing = await this.index(volume);
    s.db.function("arca_gallery_visible", (name) =>
      mediaKind(name) && !excluded(name, false) ? 1 : 0,
    );
    const month = query.get("month") || "";
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      fail("Invalid gallery month");
    const after = query.get("after") || (month ? month + "~" : "");
    if (after.length > 4096) fail("Invalid gallery cursor");
    s.db.function(
      "arca_gallery_date",
      (name, captured, added) => galleryDate(name, captured, added).date,
    );
    const source = `WITH media AS (
      SELECT f.path,f.hash,f.size,f.rev,m.captured,
        (SELECT min(r.created) FROM revisions r WHERE r.volume=f.volume AND r.path=f.path AND r.hash=f.hash) AS added
      FROM files f JOIN gallery_metadata m ON m.hash=f.hash
      WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_gallery_visible(f.path)=1
    ), dated AS (SELECT *,arca_gallery_date(path,captured,added) AS date FROM media)`;
    const rows = s.db
      .prepare(
        source +
          ` SELECT *,date || '|' || path AS cursor FROM dated
      WHERE (?='' OR date || '|' || path < ?) ORDER BY cursor DESC LIMIT 61`,
      )
      .all(volume, after, after);
    const timeline = s.db
      .prepare(
        source +
          ` SELECT substr(date,1,7) AS month,count(*) AS count
      FROM dated WHERE date IS NOT NULL GROUP BY month ORDER BY month DESC`,
      )
      .all(volume);
    return {
      indexing,
      timeline,
      items: rows.slice(0, 60).map((row) => ({
        ...row,
        dateSource: galleryDate(row.path, row.captured, row.added).source,
        kind: mediaKind(row.path),
      })),
      next: rows.length > 60 ? rows[59].cursor : null,
    };
  }

  async info(volume, name, hash) {
    this.s.volume(volume);
    const row = this.s.current(volume, name);
    if (
      !row ||
      row.deleted ||
      row.directory ||
      row.hash !== hash ||
      this.s.visibleRules(volume)(name, false)
    )
      fail("This photo is no longer available", 404);
    const revision = this.s.db
      .prepare(
        "SELECT r.created,r.author,d.name AS machine FROM revisions r LEFT JOIN devices d ON d.id=r.author WHERE r.rev=?",
      )
      .get(row.rev);
    const result = {
      hasHistory: Boolean(
        this.s.db
          .prepare(
            "SELECT 1 FROM revisions WHERE volume=? AND path=? AND rev<>? LIMIT 1",
          )
          .get(volume, name, row.rev),
      ),
      accepted: revision
        ? {
            date: revision.created,
            machine: revision.machine || null,
            revision: row.rev,
          }
        : null,
    };
    if (mediaKind(name) !== "image") return result;
    let meta;
    try {
      meta = await sharp(this.s.blob(hash), {
        limitInputPixels: 100000000,
      }).metadata();
    } catch {
      return result;
    }
    const rotated = meta.orientation >= 5 && meta.orientation <= 8;
    Object.assign(result, {
      width: rotated ? meta.height : meta.width,
      height: rotated ? meta.width : meta.height,
      format: meta.format?.toUpperCase(),
    });
    if (!meta.exif || meta.exif.length > 4 * 1024 ** 2) return result;
    try {
      const tags = await exifr.parse(
        meta.exif.subarray(
          meta.exif.subarray(0, 6).toString() === "Exif\0\0" ? 6 : 0,
        ),
        {
          pick: [
            "Make",
            "Model",
            "LensModel",
            "FNumber",
            "ExposureTime",
            "ISO",
            "FocalLength",
            "DateTimeOriginal",
            "OffsetTimeOriginal",
            "GPSLatitude",
            "GPSLatitudeRef",
            "GPSLongitude",
            "GPSLongitudeRef",
          ],
          reviveValues: false,
        },
      );
      for (const [key, tag] of Object.entries({
        make: "Make",
        model: "Model",
        lens: "LensModel",
      }))
        if (typeof tags?.[tag] === "string" && tags[tag].trim())
          result[key] = tags[tag].trim().slice(0, 256);
      for (const [key, tag] of Object.entries({
        aperture: "FNumber",
        exposure: "ExposureTime",
        iso: "ISO",
        focalLength: "FocalLength",
      }))
        if (Number.isFinite(tags?.[tag]) && tags[tag] > 0)
          result[key] = tags[tag];
      const raw = tags?.DateTimeOriginal;
      if (
        typeof raw === "string" &&
        /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ) {
        result.captured =
          raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11);
        if (/^[+-]\d{2}:\d{2}$/.test(tags.OffsetTimeOriginal || ""))
          result.offset = tags.OffsetTimeOriginal;
      }
      if (
        Number.isFinite(tags?.latitude) &&
        Math.abs(tags.latitude) <= 90 &&
        Number.isFinite(tags?.longitude) &&
        Math.abs(tags.longitude) <= 180
      )
        result.location = {
          latitude: tags.latitude,
          longitude: tags.longitude,
        };
    } catch {
      /* Malformed EXIF must not hide basic image dimensions. */
    }
    return result;
  }

  async preview(volume, name, hash, large = false) {
    const s = this.s;
    s.volume(volume);
    const row = s.current(volume, name);
    if (
      !row ||
      row.deleted ||
      row.hash !== hash ||
      s.visibleRules(volume)(name, false)
    )
      fail("This photo is no longer available", 404);
    if (mediaKind(name) !== "image") return { unavailable: true };
    const key = `${hash}:${large ? "large" : "thumb"}`;
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    const diskKey = `${hash}-${large ? "large" : "thumb"}.jpg`;
    const disk = path.join(this.directory, diskKey);
    if (fs.lstatSync(disk, { throwIfNoEntry: false })?.isFile()) {
      s.db
        .prepare("UPDATE gallery_derivatives SET used=? WHERE key=?")
        .run(Date.now(), diskKey);
      return {
        data: `data:image/jpeg;base64,${fs.readFileSync(disk).toString("base64")}`,
      };
    }
    if (this.running >= 4) fail("Previews are busy. Try again.", 429);
    this.running++;
    try {
      const data = await sharp(s.blob(hash), {
        limitInputPixels: 100000000,
        sequentialRead: true,
      })
        .rotate()
        .resize(large ? 2048 : 360, large ? 2048 : 360, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: large ? 85 : 75 })
        .timeout({ seconds: 10 })
        .toBuffer();
      if (this.closed) return { unavailable: true };
      const temporary = disk + `.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, data, { mode: 0o600 });
        fs.renameSync(temporary, disk);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      s.db
        .prepare("INSERT OR REPLACE INTO gallery_derivatives VALUES(?,?,?)")
        .run(diskKey, data.length, Date.now());
      let total = s.db
        .prepare(
          "SELECT coalesce(sum(size),0) AS total FROM gallery_derivatives",
        )
        .get().total;
      if (total > 512 * 1024 ** 2)
        for (const old of s.db
          .prepare("SELECT key,size FROM gallery_derivatives ORDER BY used")
          .all()) {
          if (total <= 512 * 1024 ** 2) break;
          fs.rmSync(path.join(this.directory, old.key), { force: true });
          s.db
            .prepare("DELETE FROM gallery_derivatives WHERE key=?")
            .run(old.key);
          total -= old.size;
        }
      const value = {
        data: `data:image/jpeg;base64,${data.toString("base64")}`,
      };
      while (
        this.cacheBytes + value.data.length > 32 * 1024 ** 2 &&
        this.cache.size
      ) {
        const first = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(first).data.length;
        this.cache.delete(first);
      }
      this.cache.set(key, value);
      this.cacheBytes += value.data.length;
      return value;
    } catch {
      return { unavailable: true };
    } finally {
      this.running--;
    }
  }
}
