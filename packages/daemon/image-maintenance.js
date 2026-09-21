import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { encodeHeic, imageEncoder } from "./image-encoder.js";
import { fail } from "./storage.js";
import { galleryDate, mediaKind } from "../core/gallery-date.js";

// One bounded worker per hub. A restart stops work; accepted replacements use the
// same durable two-path journal as Rename, so originals cannot be lost mid-write.
export class ImageMaintenance {
  constructor(engine, encoder = encodeHeic) {
    this.engine = engine;
    this.s = engine.store;
    this.encoder = encoder;
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
  async status() {
    const folders = new Map();
    for (const file of this.rows()) {
      const item = folders.get(file.volume) || {
        id: file.volume,
        name: file.folder,
        photos: 0,
        videos: 0,
        jpeg: 0,
        bytes: 0,
      };
      item[mediaKind(file.path) === "image" ? "photos" : "videos"]++;
      item.jpeg += Number(/\.jpe?g$/i.test(file.path));
      item.bytes += file.size;
      folders.set(file.volume, item);
    }
    return {
      folders: [...folders.values()],
      encoder: await imageEncoder(),
      job: this.job,
    };
  }
  start(kind, confirmation) {
    if (this.closed || this.engine.destroying || this.s.config.destroyPending)
      fail("Hub is stopping", 409);
    if (this.task) fail("An image operation is already running", 409);
    if (!["analyze", "optimize", "regenerate"].includes(kind))
      fail("Unknown image operation");
    if (
      kind === "optimize" &&
      (!this.plan ||
        this.plan.token !== confirmation ||
        Date.now() > this.plan.expires)
    )
      fail("Analyze the library again before confirming conversion", 409);
    const rows = kind === "optimize" ? this.plan.rows : this.rows();
    const candidates =
      kind === "regenerate"
        ? rows
        : rows.filter((row) => /\.jpe?g$/i.test(row.path));
    const chosen =
      kind === "analyze"
        ? candidates
            .filter(
              (_, i) =>
                i % Math.max(1, Math.ceil(candidates.length / 10)) === 0,
            )
            .slice(0, 10)
        : candidates;
    this.plan = null;
    this.cancelled = false;
    this.job = {
      kind,
      state: "running",
      startedAt: Date.now(),
      phase: "Preparing",
      total: chosen.length,
      done: 0,
      changed: 0,
      skipped: 0,
      before: 0,
      after: 0,
      errors: [],
    };
    this.task = this.work(kind, chosen)
      .then(() => {
        this.job.finishedAt = Date.now();
        this.job.current = null;
        this.job.state =
          this.cancelled || this.closed ? "cancelled" : "complete";
        if (
          kind === "analyze" &&
          this.job.state === "complete" &&
          (this.job.changed || candidates.length > chosen.length)
        ) {
          this.plan = {
            rows: candidates,
            token: crypto.randomUUID(),
            expires: Date.now() + 20 * 60 * 1000,
          };
          this.job.confirmation = this.plan.token;
          this.job.candidates = candidates.length;
        }
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
  async work(kind, rows) {
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
      this.job.phase =
        kind === "regenerate" ? "Regenerating previews" : "Preparing";
      let temp;
      try {
        if (kind === "regenerate") {
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
        } else {
          temp = path.join(
            this.s.home,
            `image-conversion-${crypto.randomUUID()}.heic`,
          );
          const size = await this.encoder(
            this.s.blob(row.hash),
            temp,
            (phase) => {
              this.job.phase = phase;
            },
          );
          if (size >= row.size * 0.9) {
            this.job.skipped++;
            continue;
          }
          if (kind === "optimize") {
            if (this.closed || this.cancelled) break;
            this.job.phase = "Saving verified image";
            await this.engine.exclusive(async () => {
              if (
                this.closed ||
                this.cancelled ||
                this.engine.destroying ||
                this.s.config.destroyPending
              )
                fail("Conversion stopped", 409);
              const current = this.s.current(row.volume, row.path);
              if (
                !current ||
                current.deleted ||
                current.rev !== row.rev ||
                current.hash !== row.hash
              )
                fail("Photo changed since analysis; original kept", 409);
              const replacement = this.s.capture(temp);
              const metadata = this.s.db
                .prepare("SELECT captured FROM gallery_metadata WHERE hash=?")
                .get(row.hash);
              const first = this.s.db
                .prepare(
                  "SELECT min(created) AS date FROM revisions WHERE volume=? AND path=? AND hash=?",
                )
                .get(row.volume, row.path, row.hash);
              const captured = galleryDate(
                row.path,
                metadata?.captured,
                first?.date,
              ).date;
              this.s.db
                .prepare(
                  "INSERT OR REPLACE INTO gallery_metadata(hash,captured,date_checked) VALUES(?,?,1)",
                )
                .run(replacement.hash, captured);

              const destination = path.posix
                .basename(row.path)
                .replace(/\.jpe?g$/i, ".heic");
              await this.engine.renameFile(
                row.volume,
                row.path,
                destination,
                row.rev,
                replacement,
              );
              this.engine.gallery.prepare(row.volume);
            });
          }
          this.job.changed++;
          this.job.before += row.size;
          this.job.after += size;
        }
      } catch (error) {
        this.job.skipped++;
        if (this.job.errors.length < 20)
          this.job.errors.push({ path: row.path, error: error.message });
      } finally {
        if (temp) fs.rmSync(temp, { force: true });
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
