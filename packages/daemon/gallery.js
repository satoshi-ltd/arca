import { isHeic, isHeifContent, heicPreview } from "./heic-preview.js";
import { videoPreview, videoCaptureDate } from "./video-preview.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import exifr from "exifr";
import { fail } from "./storage.js";
import { withoutConflictSuffix } from "./file-preview.js";
import { PREVIEW_SIZES } from "./preview-sizes.js";
import { mediaKind, galleryDate, realDate } from "../core/gallery-date.js";

// Cached input files keep working copies open, which blocks renames and deletes on Windows.
sharp.cache({ files: 0 });

export { mediaKind, galleryDate };
// Revisit videos checked before container capture dates were supported.
const needsCaptureDate = `(m.hash IS NULL OR (m.captured IS NULL AND
  (m.date_checked=0 OR (arca_media_kind(f.path)='video' AND m.date_checked<2))))`;
const bytewise = (a, b) => (a === b ? 0 : Buffer.compare(Buffer.from(a), Buffer.from(b)));
const cursor = (row) => (row.date ?? "!") + "|" + row.path;
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
    this.kept = new Map();
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
    if (used >= PREVIEW_SIZES.thumb.budget) return;
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
            rendered = !(await this.derivative(volume, row.path, row.hash))
              .unavailable;
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
      if (used >= PREVIEW_SIZES.large.budget * 0.9) return;
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
            rendered = !(
              await this.derivative(volume, row.path, row.hash, "large")
            ).unavailable;
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
      .prepare("INSERT OR IGNORE INTO gallery_folders(volume) VALUES(?)")
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
        `SELECT f.hash,min(f.path) AS path FROM ${s.fileSource()} f LEFT JOIN gallery_metadata m ON m.hash=f.hash
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
            captured =
              ["DateTimeOriginal", "CreateDate", "ModifyDate"]
                .map((tag) => tags?.[tag])
                .filter(
                  (raw) =>
                    typeof raw === "string" &&
                    /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw),
                )
                .map((raw) =>
                  realDate(
                    raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11),
                  ),
                )
                .find(Boolean) || null;
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
  // Every gallery read shares these rows; they are kept until a counter that a write to any table they read from bumps has moved.
  media(volume) {
    const s = this.s;
    const kept = this.kept.get(volume);
    this.kept.delete(volume);
    s.volume(volume);
    const excluded = s.visibleRules(volume);
    const files = s.fileSource();
    const stamp = s.db
      .prepare(
        "SELECT (SELECT generation FROM file_generations WHERE volume=?) AS files,(SELECT generation FROM row_generations WHERE name='gallery') AS gallery,(SELECT generation FROM row_generations WHERE name='revisions:' || ?) AS revisions",
      )
      .get(volume, volume);
    const key = `${files}:${stamp.files}:${stamp.gallery}:${stamp.revisions}`;
    if (kept?.key === key && kept.excluded === excluded) {
      this.kept.set(volume, kept);
      return kept;
    }
    s.db.function("arca_gallery_visible", (name) =>
      mediaKind(name) && !excluded(name, false) ? 1 : 0,
    );
    s.db.function("arca_gallery_date", (name, captured, added, modified) => galleryDate(name, captured, added, modified).date);
    const indexing = Boolean(
      s.db
        .prepare(
          `SELECT 1 FROM ${files} f LEFT JOIN gallery_metadata m ON m.hash=f.hash
       WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_media_kind(f.path) IS NOT NULL
       AND ${needsCaptureDate} LIMIT 1`,
        )
        .get(volume),
    );
    const rows = [];
    const months = new Map();
    for (const row of s.db
      .prepare(
        `WITH media AS (
      SELECT f.path,f.hash,f.size,f.rev,m.captured,m.modified,
        coalesce((SELECT min(r.created) FROM revisions r WHERE r.volume=f.volume AND r.path=f.path AND r.hash=f.hash),(SELECT a.added FROM added_dates a WHERE a.volume=f.volume AND a.path=f.path AND a.hash=f.hash)) AS added
      FROM ${files} f LEFT JOIN gallery_metadata m ON m.hash=f.hash
      WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND arca_gallery_visible(f.path)=1
      AND NOT EXISTS (SELECT 1 FROM gallery_members gm JOIN gallery_assets ga USING(volume,source,asset)
        WHERE gm.volume=f.volume AND gm.path=f.path AND ga.deleted=0 AND f.path<>json_extract(ga.resources,'$[0].path')
        AND EXISTS (SELECT 1 FROM ${files} primary_file WHERE primary_file.volume=f.volume AND primary_file.path=json_extract(ga.resources,'$[0].path') AND primary_file.deleted=0 AND arca_gallery_visible(primary_file.path)=1))
    ) SELECT * FROM media ORDER BY coalesce(arca_gallery_date(path,captured,added,modified),'!') || '|' || path DESC`,
      )
      .iterate(volume)) {
      const date = galleryDate(row.path, row.captured, row.added, row.modified).date;
      rows.push({ path: row.path, hash: row.hash, size: row.size, rev: row.rev, captured: row.captured, modified: row.modified, added: row.added, date });
      const month = date === null ? null : date.slice(0, 7);
      const group = months.get(month) || { month, count: 0, rev: 0, videos: 0 };
      group.count++;
      group.rev = Math.max(group.rev, row.rev);
      if (mediaKind(row.path) === "video") group.videos++;
      months.set(month, group);
    }
    const next = { key, excluded, indexing, rows, months };
    this.kept.set(volume, next);
    if (this.kept.size > 2) this.kept.delete(this.kept.keys().next().value);
    return next;
  }
  async page(volume, query) {
    const month = query.get("month") || "";
    const media = this.media(volume);
    if (media.indexing) this.prepare(volume);
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
      fail("Invalid gallery month");
    const after = query.get("after") || (month ? month + "~" : "");
    const from = query.get("after") ? "" : query.get("from") || "";
    const before = query.get("before") || "";
    if (Math.max(after.length, from.length, before.length) > 4096)
      fail("Invalid gallery cursor");
    const all = media.rows;
    const below = (bound, inclusive) => {
      let low = 0,
        high = all.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        const order = bytewise(cursor(all[middle]), bound);
        if (order < 0 || (inclusive && !order)) high = middle;
        else low = middle + 1;
      }
      return low;
    };
    let rows, previous, next;
    if (before) {
      const end = below(before, true);
      rows = all.slice(Math.max(0, end - 60), end);
      previous = end > 60 ? cursor(rows[0]) : null;
      next = null;
    } else {
      const start = after ? below(after, false) : from ? below(from, true) : 0;
      rows = all.slice(start, start + 60);
      next = all.length > start + 60 ? cursor(rows[59]) : null;
      previous =
        (month || from) && !query.get("after") && rows.length && start > 0
          ? cursor(rows[0])
          : null;
    }
    const timeline = [...media.months.values()]
      .filter((row) => row.month !== null)
      .sort((a, b) => bytewise(b.month, a.month))
      .map((row) => ({ ...row }));
    const undated = media.months.get(null);
    return {
      indexing: media.indexing,
      timeline,
      undated: {
        count: undated?.count || 0,
        videos: undated?.videos || 0,
        rev: undated?.rev || 0,
      },
      items: rows.map((row) => ({
        ...row,
        cursor: cursor(row),
        dateSource: galleryDate(row.path, row.captured, row.added, row.modified)
          .source,
        kind: mediaKind(row.path),
      })),
      next,
      previous,
    };
  }
  // Covers order by date and then path, not by cursor: dates differ in length, so the two orders disagree.
  grouped(rows, group, first) {
    const groups = new Map();
    for (const row of rows) {
      const name = group(row);
      const entry = groups.get(name);
      if (!entry) groups.set(name, { name, count: 1, row });
      else {
        entry.count++;
        const order = bytewise(row.date, entry.row.date) || bytewise(row.path, entry.row.path);
        if (first ? order < 0 : order > 0) entry.row = row;
      }
    }
    return [...groups.values()].sort((a, b) => bytewise(b.name, a.name));
  }
  periods(volume, query) {
    const level = query.get("level") || "year";
    if (!["year", "month"].includes(level)) fail("Invalid gallery level");
    const size = level === "year" ? 4 : 7;
    const dated = this.media(volume).rows.filter((row) => row.date !== null);
    return {
      level,
      periods: this.grouped(dated, (row) => row.date.slice(0, size), false).map(({ name, count, row }) => ({
        period: name,
        latest: row.date.slice(0, 7),
        count,
        path: row.path,
        hash: row.hash,
        rev: row.rev,
        kind: mediaKind(row.path),
      })),
    };
  }
  memories(volume, query) {
    const day = query.get("day") || "";
    const year = query.get("year") || "";
    if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day) || !/^\d{4}$/.test(year))
      fail("Invalid gallery day");
    const dated = this.media(volume).rows.filter(
      (row) => row.date !== null && row.date.slice(5, 10) === day && bytewise(row.date.slice(0, 4), year) < 0,
    );
    return {
      day,
      memories: this.grouped(dated, (row) => row.date.slice(0, 4), true)
        .slice(0, 12)
        .map(({ name, count, row }) => ({
          year: name,
          count,
          path: row.path,
          hash: row.hash,
          rev: row.rev,
          cursor: cursor(row),
          kind: mediaKind(row.path),
        })),
    };
  }

  async info(volume, name, hash) {
    this.s.volume(volume);
    const row = this.s.viewCurrent(volume, name);
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
      const taken =
        typeof raw === "string" &&
        /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) &&
        realDate(raw.slice(0, 10).replaceAll(":", "-") + "T" + raw.slice(11));
      if (taken) {
        result.captured = taken;
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

  async preview(volume, name, hash, size = "thumb", revision = null) {
    const result = await this.derivative(
      volume,
      name,
      hash,
      size,
      false,
      revision,
    );
    return result.bytes
      ? { data: `data:image/jpeg;base64,${result.bytes.toString("base64")}` }
      : result;
  }
  async derivative(
    volume,
    name,
    hash,
    size = "thumb",
    regenerate = false,
    revision = null,
  ) {
    const s = this.s;
    if (!Object.hasOwn(PREVIEW_SIZES, size)) fail("Invalid preview size", 400);
    const folder = s.volume(volume);
    if (s.config.role !== "hub" && !folder.selected)
      fail("Select this folder first", 403);
    if (
      revision !== null &&
      (!Number.isSafeInteger(Number(revision)) || Number(revision) < 1)
    )
      fail("Invalid revision", 400);
    const row =
      revision === null
        ? s.viewCurrent(volume, name)
        : s.db
            .prepare(
              "SELECT * FROM revisions WHERE volume=? AND path=? AND rev=?",
            )
            .get(volume, name, Number(revision));
    if (
      !row ||
      row.deleted ||
      row.hash !== hash ||
      s.visibleRules(volume)(name, false)
    )
      fail("This photo is no longer available", 404);
    const typed = withoutConflictSuffix(name);
    if (!mediaKind(typed)) return { unavailable: true };
    const key = `${hash}:${size}`;
    if (regenerate) await this.discard(hash, size);
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    const diskKey = `${hash}-${size}.jpg`;
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
    const original = () => s.localContent(volume, name, hash);
    const scaled = size === "medium" && this.cachedLarge(hash);
    const source = scaled || original();
    if (!source) fail("Sync this photo before previewing it", 409);
    const job = this.render(typed, source, size, key, diskKey, disk, scaled && original).finally(
      () => this.pending.delete(key),
    );
    this.pending.set(key, job);
    return job;
  }
  async discard(hash, size) {
    const key = `${hash}:${size}`;
    await this.pending.get(key);
    if (this.closed) fail("Gallery is stopping", 409);
    const previous = this.cache.get(key);
    if (previous) this.cacheBytes -= previous.bytes.length;
    this.cache.delete(key);
    const diskKey = `${hash}-${size}.jpg`;
    fs.rmSync(path.join(this.directory, diskKey), { force: true });
    this.s.db.prepare("DELETE FROM gallery_derivatives WHERE key=?").run(diskKey);
  }
  cachedLarge(hash) {
    try {
      return fs.readFileSync(path.join(this.directory, `${hash}-large.jpg`));
    } catch {
      return null;
    }
  }
  async render(name, source, size, key, diskKey, disk, original = null) {
    const s = this.s;
    if (this.running >= 4) fail("Previews are busy. Try again.", 429);
    this.running++;
    const { edge, quality, budget } = PREVIEW_SIZES[size];
    const decode = (input, scaled) =>
      !scaled && mediaKind(name) === "video"
        ? videoPreview(input, name, size)
        : !scaled && isHeic(name) && isHeifContent(input)
          ? heicPreview(input, size)
          : sharp(input, {
              limitInputPixels: 100000000,
              sequentialRead: true,
            })
              .rotate()
              .resize(edge, edge, {
                fit: "inside",
                withoutEnlargement: true,
              })
              .jpeg({ quality })
              .timeout({ seconds: 10 })
              .toBuffer();
    try {
      const data = await decode(source, Boolean(original)).catch((error) => {
        const fallback = original?.();
        if (!fallback) throw error;
        return decode(fallback, false);
      });
      if (this.closed) return { unavailable: true };
      const temporary = disk + `.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, data, { mode: 0o600 });
        fs.renameSync(temporary, disk);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      s.db
        .prepare("INSERT OR REPLACE INTO gallery_derivatives(key,size,used) VALUES(?,?,?)")
        .run(diskKey, data.length, Date.now());
      const kind = `%-${size}.jpg`;
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
