import { fail } from "./storage.js";
import { mediaKind } from "../core/gallery-date.js";

export class ImageMaintenance {
  constructor(engine) {
    this.engine = engine;
    this.s = engine.store;
    this.job = null;
  }
  rows() {
    const rows = [];
    for (const v of this.s.volumes()) {
      if (
        !this.s.db
          .prepare("SELECT 1 FROM gallery_folders WHERE volume=?")
          .get(v.id)
      )
        continue;
      const excluded = this.s.visibleRules(v.id);
      for (const file of this.s.db
        .prepare(
          "SELECT * FROM files WHERE volume=? AND deleted=0 AND directory=0 ORDER BY path",
        )
        .all(v.id))
        if (mediaKind(file.path) && !excluded(file.path, false))
          rows.push({ ...file, folder: v.name });
    }
    return rows;
  }
  status() {
    const folders = new Map();
    for (const file of this.rows()) {
      const item = folders.get(file.volume) || {
        id: file.volume,
        name: file.folder,
        photos: 0,
        videos: 0,
        bytes: 0,
      };
      item[mediaKind(file.path) === "image" ? "photos" : "videos"]++;
      item.bytes += file.size;
      folders.set(file.volume, item);
    }
    return { folders: [...folders.values()], job: this.job };
  }
  start(kind) {
    if (this.closed || this.engine.destroying || this.s.config.destroyPending)
      fail("Hub is stopping", 409);
    if (this.task) fail("An image operation is already running", 409);
    if (kind !== "regenerate") fail("Unknown image operation");
    const rows = this.rows();
    this.cancelled = false;
    this.job = {
      kind,
      state: "running",
      startedAt: Date.now(),
      phase: "Regenerating previews",
      total: rows.length,
      done: 0,
      changed: 0,
      skipped: 0,
      errors: [],
    };
    this.task = this.work(rows)
      .then(() => {
        this.job.finishedAt = Date.now();
        this.job.current = null;
        this.job.state =
          this.cancelled || this.closed ? "cancelled" : "complete";
      })
      .catch((error) => {
        this.job.finishedAt = Date.now();
        this.job.state = "failed";
        this.job.errors.push({ error: error.message });
      })
      .finally(() => {
        this.task = null;
      });
    return this.job;
  }
  async work(rows) {
    for (const row of rows) {
      if (
        this.closed ||
        this.cancelled ||
        this.engine.destroying ||
        this.s.config.destroyPending
      )
        break;
      this.job.current = row.path;
      this.job.currentStartedAt = Date.now();
      try {
        const thumbnail = await this.engine.gallery.derivative(
          row.volume,
          row.path,
          row.hash,
          false,
          true,
        );
        const large =
          mediaKind(row.path) === "image"
            ? await this.engine.gallery.derivative(
                row.volume,
                row.path,
                row.hash,
                true,
                true,
              )
            : thumbnail;
        if (thumbnail.unavailable || large.unavailable)
          throw new Error("Preview could not be decoded");
        this.job.changed++;
      } catch (error) {
        this.job.skipped++;
        if (this.job.errors.length < 20)
          this.job.errors.push({ path: row.path, error: error.message });
      } finally {
        this.job.done++;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  cancel() {
    this.cancelled = true;
  }
  async close() {
    this.closed = true;
    await this.task;
  }
}
