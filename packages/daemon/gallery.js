import { isHeic, isHeifContent, heicPreview } from "./heic-preview.js";
import { videoPreview, videoCaptureDate } from "./video-preview.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { fail } from "./storage.js";
import { mediaKind, galleryDate } from "../core/gallery-date.js";

// Cached input files keep working copies open, which blocks renames and deletes on Windows.
sharp.cache({ files: 0 });

export { mediaKind, galleryDate };
// Thumbnails are never evicted by large previews; each kind has its own disk budget.
const THUMB_BUDGET = 1024 ** 3;
const LARGE_BUDGET = 512 * 1024 ** 2;
// Revisit videos checked before container capture dates were supported.
const needsCaptureDate = `(m.hash IS NULL OR (m.captured IS NULL AND
  (m.date_checked=0 OR (arca_media_kind(f.path)='video' AND m.date_checked<2))))`;
// Derivatives are disposable and bounded; original objects remain untouched.
export class Gallery {
  constructor(store) {
    this.s = store;
    store.db.function("arca_media_kind", mediaKind);
    this.directory = path.join(store.home, "previews");
    fs.mkdirSync(this.directory, { recursive: true });
    this.cache = new Map();
    this.cacheBytes = 0;
    this.running = 0;
    this.pending = new Map();
    this.indexing = new Map();
    this.volumes = new Set();
    store.db.exec(
      "CREATE TABLE IF NOT EXISTS gallery_prepared(hash TEXT PRIMARY KEY, attempted INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS gallery_revision_lookup ON revisions(volume,path,hash,created)",
    );
    if (
      !store.db
        .prepare("PRAGMA table_info(gallery_prepared)")
        .all()
        .some((column) => column.name === "large")
    )
      store.db.exec(
        "ALTER TABLE gallery_prepared ADD COLUMN large INTEGER NOT NULL DEFAULT 0",
      );
  }
  close() {
    this.closed = true;
  }
  schedule(volume, name) {
    if (this.closed || !mediaKind(name)) return;
    this.prepare(volume);
  }
  resume() {
    if (this.s.config.role !== "hub") {
      for (const volume of this.s.config.catalog || [])
        if (
          volume.gallery &&
          this.s.volumes().some((v) => v.id === volume.id && v.selected)
        )
          this.prepare(volume.id);
      return;
    }
    for (const { volume } of this.s.db
      .prepare("SELECT volume FROM gallery_folders")
      .all())
      this.prepare(volume);
  }
  prepare(volume) {
    if (this.closed) return;
    this.volumes.add(volume);
    if (!this.background)
      this.background = this.prepareQueued().finally(() => {
        this.background = null;
      });
  }
  async prepareQueued() {
    while (!this.closed && this.volumes.size) {
      const volume = this.volumes.values().next().value;
      this.volumes.delete(volume);
      try {
        if (this.s.config.role !== "hub" && !this.s.volume(volume).selected)
          continue;
        while (!this.closed && (await this.index(volume)))
          await new Promise((r) => setImmediate(r));
        await this.prepareThumbnails(volume);
        await this.prepareLarge(volume);
      } catch {
        /* Folder removal or bad policy must not stop other galleries. */
      }
    }
  }
  available(volume) {
    return this.s.config.role === "hub" || this.s.volume(volume).selected;
  }
  async prepareThumbnails(volume) {
    const used = this.s.db
      .prepare(
        "SELECT coalesce(sum(size),0) AS total FROM gallery_derivatives WHERE key LIKE '%-thumb.jpg'",
      )
      .get().total;
    if (used >= THUMB_BUDGET) return;
    let after = "";
    while (!this.closed) {
      const rows = this.s.db
        .prepare(
          `SELECT f.path,f.hash,p.large FROM files f LEFT JOIN gallery_prepared p ON p.hash=f.hash
          LEFT JOIN gallery_derivatives d ON d.key=f.hash || '-thumb.jpg'
          WHERE f.volume=? AND f.path>? AND f.deleted=0 AND arca_media_kind(f.path) IS NOT NULL
          AND d.key IS NULL AND (p.hash IS NULL OR p.large=1 OR p.attempted<?) ORDER BY f.path LIMIT 32`,
        )
        .all(volume, after, Date.now() - 86400000);
      if (!rows.length) return;
      for (const row of rows) {
        if (this.closed || !this.available(volume)) return;
        after = row.path;
        let rendered = false;
        try {
          if (this.s.localContent(volume, row.path, row.hash))
            rendered = !(await this.derivative(volume, row.path, row.hash)).unavailable;
        } catch (error) {
          if (error.status === 429) return;
        }
        if (this.closed) return;
        this.s.db
          .prepare(
            "INSERT OR REPLACE INTO gallery_prepared(hash,attempted,large) VALUES(?,?,?)",
          )
          .run(row.hash, Date.now(), rendered ? (row.large ?? 0) : 0);
        await new Promise((r) => setImmediate(r));
      }
    }
  }
  async prepareLarge(volume) {
    while (!this.closed) {
      const used = this.s.db
        .prepare(
          "SELECT coalesce(sum(size),0) AS total FROM gallery_derivatives WHERE key LIKE '%-large.jpg'",
        )
        .get().total;
      if (used >= LARGE_BUDGET * 0.9) return;
      const rows = this.s.db
        .prepare(
          `SELECT f.path,f.hash FROM files f JOIN gallery_prepared p ON p.hash=f.hash
          LEFT JOIN gallery_metadata m ON m.hash=f.hash
          WHERE f.volume=? AND f.deleted=0 AND arca_media_kind(f.path)='image' AND p.large=0
          ORDER BY m.captured DESC NULLS LAST, f.path DESC LIMIT 32`,
        )
        .all(volume);
      if (!rows.length) return;
      for (const row of rows) {
        if (this.closed || !this.available(volume) || this.volumes.size) return;
        let rendered = false;
        try {
          if (this.s.localContent(volume, row.path, row.hash))
            rendered = !(await this.derivative(volume, row.path, row.hash, true)).unavailable;
        } catch (error) {
          if (error.status === 429) return;
        }
        if (this.closed) return;
        this.s.db
          .prepare("UPDATE gallery_prepared SET large=? WHERE hash=?")
          .run(rendered ? 1 : 2, row.hash);
        await new Promise((r) => setImmediate(r));
      }
    }
  }
  mark(volume) {
    this.s.volume(volume);
    this.s.db
      .prepare("INSERT OR IGNORE INTO gallery_folders VALUES(?)")
      .run(volume);
    this.prepare(volume);
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
        `SELECT f.hash,min(f.path) AS path FROM files f LEFT JOIN gallery_metadata m ON m.hash=f.hash
      WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_media_kind(f.path) IS NOT NULL AND ${needsCaptureDate} GROUP BY f.hash LIMIT 64`,
      )
      .all(volume);
    let handled = 0;
    for (const row of rows) {
      let captured = null;
      const video = mediaKind(row.path) === "video";
      const source = s.localContent(volume, row.path, row.hash);
      // A file edited since its last scan is dated after the rescan gives it a new hash.
      if (!source && s.config.role !== "hub") continue;
      handled++;
      try {
        if (!source) fail("Content is not available locally", 404);
        if (video) captured = await videoCaptureDate(source, row.path);
        else {
          const meta = await sharp(source, {
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
        }
      } catch {
        /* Missing capture metadata is a distinct, visible date group. */
      }
      // Uploaded originals are content-addressed. Do not overwrite a phone-provided capture time.
      if (this.closed) return false;
      s.db
        .prepare(
          "INSERT INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,?) ON CONFLICT(hash) DO UPDATE SET captured=coalesce(gallery_metadata.captured,excluded.captured),date_checked=excluded.date_checked",
        )
        .run(row.hash, captured, video ? 2 : 1);
      await new Promise((resolve) => setImmediate(resolve));
    }
    return rows.length === 64 && handled > 0;
  }
  async page(volume, query) {
    const s = this.s;
    s.volume(volume);
    const excluded = s.visibleRules(volume);
    const indexing = Boolean(
      s.db
        .prepare(
          `SELECT 1 FROM files f LEFT JOIN gallery_metadata m ON m.hash=f.hash
       WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_media_kind(f.path) IS NOT NULL
       AND ${needsCaptureDate} LIMIT 1`,
        )
        .get(volume),
    );
    if (indexing) this.prepare(volume);
    s.db.function("arca_gallery_visible", (name) =>
      mediaKind(name) && !excluded(name, false) ? 1 : 0,
    );
    const month = query.get("month") || "";
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      fail("Invalid gallery month");
    const after = query.get("after") || (month ? month + "~" : "");
    const from = query.get("after") ? "" : query.get("from") || "";
    const before = query.get("before") || "";
    if (Math.max(after.length, from.length, before.length) > 4096)
      fail("Invalid gallery cursor");
    s.db.function(
      "arca_gallery_date",
      (name, captured, added, modified) =>
        galleryDate(name, captured, added, modified).date,
    );
    const source = `WITH media AS (
      SELECT f.path,f.hash,f.size,f.rev,m.captured,m.modified,
        (SELECT min(r.created) FROM revisions r WHERE r.volume=f.volume AND r.path=f.path AND r.hash=f.hash) AS added
      FROM files f LEFT JOIN gallery_metadata m ON m.hash=f.hash
      WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_gallery_visible(f.path)=1
    ), dated AS (SELECT *,arca_gallery_date(path,captured,added,modified) AS date FROM media)`;
    const cursor = "coalesce(date, '') || '|' || path";
    const select = (bound, order) =>
      s.db
        .prepare(
          source +
            ` SELECT *,${cursor} AS cursor FROM dated WHERE ${bound} ORDER BY cursor ${order} LIMIT 61`,
        )
        .all(volume, before || after || from);
    let rows, previous, next;
    if (before) {
      const newer = select(`${cursor} > ?`, "ASC");
      rows = newer.slice(0, 60).reverse();
      previous = newer.length > 60 ? rows[0].cursor : null;
      next = null;
    } else {
      const older = select(
        after ? `${cursor} < ?` : from ? `${cursor} <= ?` : "?=''",
        "DESC",
      );
      rows = older.slice(0, 60);
      next = older.length > 60 ? rows[59].cursor : null;
      previous =
        (month || from) &&
        !query.get("after") &&
        rows.length &&
        s.db
          .prepare(source + ` SELECT 1 FROM dated WHERE ${cursor} > ? LIMIT 1`)
          .get(volume, rows[0].cursor)
          ? rows[0].cursor
          : null;
    }
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
      items: rows.map((row) => ({
        ...row,
        dateSource: galleryDate(row.path, row.captured, row.added, row.modified)
          .source,
        kind: mediaKind(row.path),
      })),
      next,
      previous,
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
      meta = await sharp(this.s.localContent(volume, name, hash), {
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
    const result = await this.derivative(volume, name, hash, large);
    return result.bytes
      ? { data: `data:image/jpeg;base64,${result.bytes.toString("base64")}` }
      : result;
  }
  async derivative(volume, name, hash, large = false, regenerate = false) {
    const s = this.s;
    const folder = s.volume(volume);
    if (s.config.role !== "hub" && !folder.selected)
      fail("Select this folder first", 403);
    const row = s.current(volume, name);
    if (
      !row ||
      row.deleted ||
      row.hash !== hash ||
      s.visibleRules(volume)(name, false)
    )
      fail("This photo is no longer available", 404);
    if (!mediaKind(name)) return { unavailable: true };
    const key = `${hash}:${large ? "large" : "thumb"}`;
    if (regenerate) {
      await this.pending.get(key);
      if (this.closed) fail("Gallery is stopping", 409);
      const previous = this.cache.get(key);
      if (previous) this.cacheBytes -= previous.bytes.length;
      this.cache.delete(key);
      const diskKey = `${hash}-${large ? "large" : "thumb"}.jpg`;
      fs.rmSync(path.join(this.directory, diskKey), { force: true });
      s.db.prepare("DELETE FROM gallery_derivatives WHERE key=?").run(diskKey);
    }
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
        bytes: fs.readFileSync(disk),
      };
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const source = s.localContent(volume, name, hash);
    if (!source) fail("Sync this photo before previewing it", 409);
    const job = this.render(name, source, large, key, diskKey, disk).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, job);
    return job;
  }
  async render(name, source, large, key, diskKey, disk) {
    const s = this.s;
    if (this.running >= 4) fail("Previews are busy. Try again.", 429);
    this.running++;
    try {
      const data =
        mediaKind(name) === "video"
          ? await videoPreview(source, name, large)
          : isHeic(name) && isHeifContent(source)
            ? await heicPreview(source, large)
            : await sharp(source, {
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
      const kind = `%-${large ? "large" : "thumb"}.jpg`;
      const budget = large ? LARGE_BUDGET : THUMB_BUDGET;
      let total = s.db
        .prepare(
          "SELECT coalesce(sum(size),0) AS total FROM gallery_derivatives WHERE key LIKE ?",
        )
        .get(kind).total;
      if (total > budget)
        for (const old of s.db
          .prepare(
            "SELECT key,size FROM gallery_derivatives WHERE key LIKE ? ORDER BY used",
          )
          .all(kind)) {
          if (total <= budget) break;
          fs.rmSync(path.join(this.directory, old.key), { force: true });
          s.db
            .prepare("DELETE FROM gallery_derivatives WHERE key=?")
            .run(old.key);
          total -= old.size;
        }
      const value = {
        bytes: data,
      };
      while (
        this.cacheBytes + value.bytes.length > 32 * 1024 ** 2 &&
        this.cache.size
      ) {
        const first = this.cache.keys().next().value;
        this.cacheBytes -= this.cache.get(first).bytes.length;
        this.cache.delete(first);
      }
      this.cache.set(key, value);
      this.cacheBytes += value.bytes.length;
      return value;
    } catch {
      return { unavailable: true };
    } finally {
      this.running--;
    }
  }
}
