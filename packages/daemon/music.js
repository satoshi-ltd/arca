import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { parseBlob, selectCover } from "music-metadata";
import { fail, digest, fileSignature } from "./storage.js";
import {
  PLAYLIST_BYTES,
  PLAYLIST_DIRECTORY,
  isPlaylistPath,
  isEditablePlaylist,
  parsePlaylist,
} from "../core/playlist.js";

export const AUDIO_TYPES = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
};
const COVER_NAMES = ["cover", "folder", "front", "album"];
const COVER_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
export const COVER_SIZES = { small: 360, large: 1024 };
const INDEX_VERSION = 2;
const RELEASE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const BATCH = 32;
const PICTURE_BYTES = 16 * 1024 ** 2;
const PLAYLIST_ENTRIES = 5000;
const playlistOrder = new Intl.Collator("en", { sensitivity: "base", numeric: true });
function playlistText(bytes, name) {
  if (/\.m3u8$/i.test(name)) return new TextDecoder("utf-8").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}
const COVER_FILE_BYTES = 32 * 1024 ** 2;
const PARSE_MS = 30000;
const RETRY_MS = 3600000;
const BUSY_MS = 600000;
const SWEEP_MS = 3600000;

const extension = (name) => name.slice(name.lastIndexOf(".") + 1).toLowerCase();
export const audioType = (name) =>
  name.includes(".") ? AUDIO_TYPES[extension(name)] || null : null;
export function coverRank(name) {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 1) return -1;
  const stem = COVER_NAMES.indexOf(base.slice(0, dot));
  const kind = COVER_EXTENSIONS.indexOf(base.slice(dot + 1));
  return stem < 0 || kind < 0 ? -1 : stem * COVER_EXTENSIONS.length + kind;
}
const directoryOf = (name) =>
  name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
const text = (value, limit = 256) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : null;
const transient = (error) =>
  /^E[A-Z]+$/.test(error?.code || "") ||
  error?.name === "NotReadableError" ||
  error?.name === "NotFoundError";
const count = (value, max) =>
  Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;

export function deadlineBlob(blob, deadline) {
  return {
    size: blob.size,
    type: blob.type,
    slice(start, end) {
      const part = blob.slice(start, end);
      return {
        arrayBuffer: async () => {
          if (Date.now() > deadline) throw new Error("Tag reading took too long");
          return part.arrayBuffer();
        },
      };
    },
  };
}

const EMPTY = Object.freeze({
  title: null,
  artist: null,
  albumArtist: null,
  album: null,
  track: null,
  disc: null,
  year: null,
  genre: null,
  duration: null,
  codec: null,
  cover: null,
  release: null,
});

export class Music {
  constructor(store) {
    this.s = store;
    store.db.function("arca_audio_type", (name) => audioType(name));
    store.db.function("arca_music_side", (name) =>
      coverRank(name) >= 0 ? 1 : 0,
    );
    store.db.function("arca_music_playlist", (name) =>
      isPlaylistPath(name) ? 1 : 0,
    );
    this.lists = new Map();
    this.directory = path.join(store.home, "music-covers");
    this.volumes = new Set();
    this.rendering = new Map();
    this.failed = new Map();
    this.busy = new Map();
    this.memo = new Map();
    this.quiet = new Map();
    this.generation = 0;
    this.tagged = 0;
    this.indexed = 0;
    this.swept = 0;
  }
  close() {
    this.closed = true;
  }
  isMusic(volume) {
    if (this.s.config.role !== "hub") return this.libraries().includes(volume);
    return !!this.s.db
      .prepare("SELECT 1 FROM music_folders WHERE volume=?")
      .get(volume);
  }
  libraries() {
    if (this.s.config.role === "hub")
      return this.s.db
        .prepare("SELECT volume FROM music_folders")
        .all()
        .map((row) => row.volume);
    const marked = new Set(
      (this.s.config.catalog || [])
        .filter((folder) => folder.music)
        .map((folder) => folder.id),
    );
    return this.s
      .volumes()
      .filter((v) => v.selected && marked.has(v.id))
      .map((v) => v.id);
  }
  mark(volume) {
    this.s.volume(volume);
    if (
      this.s.db.prepare("SELECT 1 FROM gallery_folders WHERE volume=?").get(volume)
    )
      fail(
        "This folder is a gallery. A folder is a gallery or a music library, not both.",
        409,
      );
    this.s.db
      .prepare("INSERT OR IGNORE INTO music_folders VALUES(?)")
      .run(volume);
    this.prepare(volume);
  }
  resume() {
    const volumes = this.libraries();
    for (const volume of volumes) this.prepare(volume);
    if (!volumes.length) this.sweep();
  }
  schedule(volume, name) {
    if (this.closed || !audioType(name) || !this.isMusic(volume)) return;
    this.prepare(volume);
  }
  prepare(volume) {
    if (this.closed || !this.isMusic(volume)) return;
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
      const before = this.tagged;
      try {
        if (this.settled(volume)) continue;
        while (!this.closed && (await this.indexBatch(volume)))
          await new Promise((resolve) => setImmediate(resolve));
      } catch {
        /* A folder removed meanwhile must not stop other libraries. */
      }
      if (this.tagged !== before) this.indexed++;
    }
    if (!this.closed) this.sweep();
  }
  fileGeneration(volume) {
    return (
      this.s.db
        .prepare("SELECT generation FROM file_generations WHERE volume=?")
        .get(volume)?.generation || 0
    );
  }
  settled(volume) {
    const quiet = this.quiet.get(volume);
    return (
      !!quiet &&
      quiet.files === this.fileGeneration(volume) &&
      quiet.tags === this.generation &&
      quiet.rules === this.s.visibleRules(volume) &&
      !(quiet.retryAt && quiet.retryAt <= Date.now())
    );
  }
  pending(volume) {
    const excluded = this.s.visibleRules(volume);
    this.s.db.function("arca_music_visible", (name) =>
      excluded(name, false) ? 0 : 1,
    );
    return this.s.db
      .prepare(
        `SELECT f.hash,min(f.path) AS path FROM ${this.s.fileSource()} f LEFT JOIN music_tracks t ON t.hash=f.hash
        WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL
        AND arca_audio_type(f.path) IS NOT NULL AND arca_music_visible(f.path)=1
        AND (t.hash IS NULL OR (t.checked<? AND t.retry<=?))
        GROUP BY f.hash LIMIT ?`,
      )
      .all(volume, INDEX_VERSION, Date.now(), BATCH);
  }
  async indexBatch(volume) {
    const files = this.fileGeneration(volume);
    const rules = this.s.visibleRules(volume);
    const rows = this.pending(volume);
    for (const row of rows) {
      if (this.closed) return false;
      const tags = await this.read(volume, row.path, row.hash);
      if (this.closed) return false;
      if (!this.isMusic(volume)) {
        this.sweep(true);
        return false;
      }
      const retry = tags === null || !!tags.retry;
      const value = tags || EMPTY;
      const kept =
        tags === EMPTY &&
        this.s.db
          .prepare(
            "UPDATE music_tracks SET checked=0,retry=? WHERE hash=? AND (title IS NOT NULL OR album IS NOT NULL OR artist IS NOT NULL)",
          )
          .run(Date.now() + RETRY_MS, row.hash).changes;
      if (kept) {
        this.generation++;
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      if (tags) this.tagged++;
      else if (
        this.s.db
          .prepare("UPDATE music_tracks SET checked=0,retry=? WHERE hash=?")
          .run(Date.now() + RETRY_MS, row.hash).changes
      ) {
        this.generation++;
        await new Promise((resolve) => setImmediate(resolve));
        continue;
      }
      this.s.db
        .prepare(
          `INSERT OR REPLACE INTO music_tracks(hash,title,artist,album_artist,album,track,disc,year,genre,duration,codec,cover,release,checked,retry)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          row.hash,
          value.title,
          value.artist,
          value.albumArtist,
          value.album,
          value.track,
          value.disc,
          value.year,
          value.genre,
          value.duration,
          value.codec,
          value.cover,
          value.release,
          retry ? 0 : INDEX_VERSION,
          retry ? Date.now() + RETRY_MS : 0,
        );
      this.generation++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (rows.length < BATCH)
      this.quiet.set(volume, {
        files,
        rules,
        tags: this.generation,
        retryAt:
          this.s.db
            .prepare("SELECT min(retry) AS at FROM music_tracks WHERE checked<? AND retry>?")
            .get(INDEX_VERSION, Date.now())?.at || 0,
      });
    return rows.length === BATCH;
  }
  async read(volume, name, hash) {
    const source = this.s.localContent(volume, name, hash);
    if (!source) return null;
    let metadata;
    try {
      const blob = await fs.openAsBlob(source, { type: audioType(name) });
      metadata = await parseBlob(deadlineBlob(blob, Date.now() + PARSE_MS), {
        duration: false,
      });
    } catch (error) {
      return transient(error) ? null : EMPTY;
    }
    const common = metadata.common || {};
    const picture = selectCover(common.picture);
    let cover = null;
    let retry = false;
    if (picture?.data?.length && picture.data.length <= PICTURE_BYTES) {
      const key = crypto.createHash("sha256").update(picture.data).digest("hex");
      const rendered = await this.renderCover(key, () => Buffer.from(picture.data));
      if (rendered === null) retry = true;
      if (rendered) cover = key;
    }
    return {
      title: text(common.title),
      artist: text(common.artist),
      albumArtist: text(common.albumartist),
      album: text(common.album),
      track: count(common.track?.no, 9999),
      disc: count(common.disk?.no, 999),
      year: count(common.year, 9999),
      genre: text(common.genre?.[0], 64),
      duration:
        Number.isFinite(metadata.format?.duration) &&
        metadata.format.duration > 0
          ? Math.round(metadata.format.duration * 1000) / 1000
          : null,
      codec: text(metadata.format?.codec, 64),
      release: RELEASE.test(common.musicbrainz_albumid || "")
        ? common.musicbrainz_albumid.toLowerCase()
        : null,
      cover,
      retry,
    };
  }
  coverFile(key, size) {
    return path.join(this.directory, `${key}-${COVER_SIZES[size]}.jpg`);
  }
  async renderCover(key, load) {
    if (
      Object.keys(COVER_SIZES).every((size) =>
        fs.existsSync(this.coverFile(key, size)),
      )
    )
      return true;
    if (this.rendering.has(key)) return this.rendering.get(key);
    const job = (async () => {
      try {
        const input = await load();
        if (!input) return false;
        const options = { limitInputPixels: 100000000, failOn: "none" };
        const { width, height } = await sharp(input, options).metadata();
        if (!width || !height) return false;
        fs.mkdirSync(this.directory, { recursive: true });
        for (const [size, pixels] of Object.entries(COVER_SIZES)) {
          const side = Math.min(pixels, width, height);
          const data = await sharp(input, options)
            .rotate()
            .resize(side, side, { fit: "cover" })
            .jpeg({ quality: size === "large" ? 85 : 78 })
            .timeout({ seconds: 10 })
            .toBuffer();
          const target = this.coverFile(key, size);
          const temporary = `${target}.${crypto.randomUUID()}.tmp`;
          try {
            fs.writeFileSync(temporary, data, { mode: 0o600 });
            fs.renameSync(temporary, target);
          } finally {
            fs.rmSync(temporary, { force: true });
          }
        }
        return true;
      } catch (error) {
        return transient(error) ? null : false;
      }
    })().finally(() => this.rendering.delete(key));
    this.rendering.set(key, job);
    return job;
  }
  requireLibrary(volume) {
    this.s.volume(volume);
    if (!this.isMusic(volume))
      fail("This folder is not a music library", 404);
  }
  library(volume, known = null) {
    this.requireLibrary(volume);
    const rules = this.s.visibleRules(volume);
    const generation =
      this.s.db
        .prepare("SELECT generation FROM file_generations WHERE volume=?")
        .get(volume)?.generation || 0;
    let value = this.memo.get(volume);
    if (
      !value ||
      value.rules !== rules ||
      value.files !== generation ||
      value.tags !== this.generation
    ) {
      value = {
        rules,
        files: generation,
        tags: this.generation,
        ...this.build(volume, rules),
      };
      this.memo.delete(volume);
      this.memo.set(volume, value);
      if (this.memo.size > 16) this.memo.delete(this.memo.keys().next().value);
    }
    if (value.indexing || (value.retryAt && value.retryAt <= Date.now()))
      this.prepare(volume);
    const playlists = this.playlists(volume, value.lists);
    const version = crypto
      .createHash("sha256")
      .update(JSON.stringify([value.version, playlists]))
      .digest("hex")
      .slice(0, 32);
    if (known && known === version)
      return { version, indexing: value.indexing, unchanged: true };
    return {
      version,
      indexing: value.indexing,
      tracks: value.tracks,
      playlists,
    };
  }
  localPlaylists(volume, rows) {
    const v = this.s.volume(volume);
    if (this.s.config.role === "hub" || !v.selected) return [];
    const known = new Set(rows.map((row) => row.path));
    const visible = this.s.visibleRules(volume);
    try {
      const directory = path.dirname(this.s.filePath(v, `${PLAYLIST_DIRECTORY}/x`));
      return fs
        .readdirSync(directory)
        .map((entry) => ({ path: `${PLAYLIST_DIRECTORY}/${entry.normalize("NFC")}` }))
        .filter((row) => isPlaylistPath(row.path) && !known.has(row.path) && !visible(row.path, false));
    } catch {
      return [];
    }
  }
  playlists(volume, rows) {
    const v = this.s.volume(volume);
    const lists = [];
    for (const row of [...rows, ...this.localPlaylists(volume, rows)]) {
      let file = null;
      try {
        file =
          this.s.config.role === "hub"
            ? this.s.localContent(volume, row.path, row.hash)
            : v.selected
              ? this.s.filePath(v, row.path)
              : null;
      } catch {
        file = null;
      }
      const signature = file && fileSignature(file);
      if (!signature) continue;
      const key = `${volume}\0${row.path}\0${signature}`;
      if (!this.lists.has(key)) {
        let list = null;
        try {
          if (fs.statSync(file).size <= PLAYLIST_BYTES) {
            const bytes = fs.readFileSync(file);
            const parsed = parsePlaylist(playlistText(bytes, row.path), row.path);
            list = {
              path: row.path,
              name: parsed.name,
              hash: digest(bytes),
              editable: isEditablePlaylist(row.path),
              entries: parsed.entries.slice(0, PLAYLIST_ENTRIES).map((entry) => entry.path),
            };
          }
        } catch {
          list = null;
        }
        this.lists.set(key, list);
        while (this.lists.size > 256) this.lists.delete(this.lists.keys().next().value);
      }
      const list = this.lists.get(key);
      if (list) lists.push(list);
    }
    return lists.sort(
      (a, b) => playlistOrder.compare(a.name, b.name) || (a.path < b.path ? -1 : 1),
    );
  }
  build(volume, excluded) {
    if (!this.revisionIndex && this.s.config.role === "hub") {
      this.s.db.exec(
        "CREATE INDEX IF NOT EXISTS music_revision_hash ON revisions(volume,hash,created)",
      );
      this.revisionIndex = true;
    }
    const now = Date.now();
    const rows = this.s.db
      .prepare(
        `SELECT f.path,f.hash,f.size,t.checked,t.retry,t.title,t.artist,t.album_artist,t.album,t.track,t.disc,t.year,t.genre,t.duration,t.codec,t.cover,t.release,
        (SELECT min(r.created) FROM revisions r WHERE r.volume=f.volume AND r.hash=f.hash) AS added
        FROM ${this.s.fileSource()} f LEFT JOIN music_tracks t ON t.hash=f.hash
        WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL
        AND (arca_audio_type(f.path) IS NOT NULL OR arca_music_side(f.path)=1 OR arca_music_playlist(f.path)=1)
        ORDER BY f.path`,
      )
      .all(volume)
      .filter((row) => !excluded(row.path, false));
    const folderCovers = new Map();
    for (const row of rows) {
      const rank = coverRank(row.path);
      if (rank < 0 || row.size > COVER_FILE_BYTES) continue;
      const directory = directoryOf(row.path);
      const best = folderCovers.get(directory);
      if (!best || rank < best.rank)
        folderCovers.set(directory, { rank, hash: row.hash });
    }
    const folderCover = (name) => {
      const directory = directoryOf(name);
      return (
        folderCovers.get(directory)?.hash ||
        (directory ? folderCovers.get(directoryOf(directory))?.hash : null) ||
        null
      );
    };
    let indexing = false;
    let retryAt = 0;
    const tracks = [];
    for (const row of rows) {
      if (!audioType(row.path)) continue;
      if (row.checked !== INDEX_VERSION) {
        if (row.retry > now) retryAt = retryAt ? Math.min(retryAt, row.retry) : row.retry;
        else indexing = true;
      }
      tracks.push({
        path: row.path,
        hash: row.hash,
        size: row.size,
        title: row.title,
        artist: row.artist,
        albumArtist: row.album_artist,
        album: row.album,
        track: row.track,
        disc: row.disc,
        year: row.year,
        genre: row.genre,
        duration: row.duration,
        codec: row.codec,
        release: row.release,
        cover: row.cover || folderCover(row.path),
        added: row.added,
      });
    }
    const version = crypto
      .createHash("sha256")
      .update(JSON.stringify(tracks))
      .digest("hex")
      .slice(0, 32);
    const lists = rows
      .filter((row) => isPlaylistPath(row.path))
      .map((row) => ({ path: row.path, hash: row.hash }));
    return { version, indexing, retryAt, tracks, lists };
  }
  latestCovers(volume, limit = 3) {
    this.s.volume(volume);
    const generation =
      this.s.db.prepare("SELECT generation FROM file_generations WHERE volume=?").get(volume)?.generation || 0;
    this.coversCache ||= new Map();
    const hit = this.coversCache.get(volume);
    if (hit?.generation === generation && hit.limit === limit) return hit.keys;
    const excluded = this.s.visibleRules(volume);
    const seen = new Set();
    const keys = [];
    for (const row of this.s.db
      .prepare(
        `SELECT f.path,t.cover FROM ${this.s.fileSource()} f JOIN music_tracks t ON t.hash=f.hash
        WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND t.cover IS NOT NULL ORDER BY f.rev DESC LIMIT 200`,
      )
      .all(volume)) {
      if (seen.has(row.cover) || excluded(row.path, false)) continue;
      seen.add(row.cover);
      keys.push(row.cover);
      if (keys.length >= limit) break;
    }
    this.coversCache.set(volume, { generation, limit, keys });
    return keys;
  }
  async cover(volume, key, size = "small") {
    this.requireLibrary(volume);
    if (!/^[a-f0-9]{64}$/.test(key || "")) fail("Invalid cover", 400);
    if (!COVER_SIZES[size]) fail("Invalid cover size", 400);
    const excluded = this.s.visibleRules(volume);
    const embedded = this.s.db
      .prepare(
        `SELECT f.path,f.hash FROM ${this.s.fileSource()} f JOIN music_tracks t ON t.hash=f.hash
        WHERE f.volume=? AND f.deleted=0 AND f.directory=0 AND t.cover=?`,
      )
      .all(volume, key)
      .find((row) => audioType(row.path) && !excluded(row.path, false));
    const image = embedded
      ? null
      : this.s.db
          .prepare(
            `SELECT path,hash FROM ${this.s.fileSource()} WHERE volume=? AND hash=? AND deleted=0 AND directory=0 AND size<=?`,
          )
          .all(volume, key, COVER_FILE_BYTES)
          .find((row) => coverRank(row.path) >= 0 && !excluded(row.path, false));
    if (!embedded && !image) fail("This cover is no longer available", 404);
    const file = this.coverFile(key, size);
    if (!fs.existsSync(file)) {
      if (Date.now() - (this.failed.get(key) || 0) < RETRY_MS)
        return { unavailable: true };
      if (Date.now() - (this.busy.get(key) || 0) < BUSY_MS)
        return { retry: true };
      const rendered = await this.renderCover(key, async () => {
        const owner = image || embedded;
        const source = this.s.localContent(volume, owner.path, owner.hash);
        if (!source) return null;
        if (image) return fs.promises.readFile(source);
        const metadata = await parseBlob(
          deadlineBlob(
            await fs.openAsBlob(source, { type: audioType(embedded.path) }),
            Date.now() + PARSE_MS,
          ),
          { duration: false },
        );
        const picture = selectCover(metadata.common?.picture);
        return picture?.data?.length && picture.data.length <= PICTURE_BYTES
          ? Buffer.from(picture.data)
          : null;
      });
      if (!this.isMusic(volume)) this.sweep(true);
      if (!fs.existsSync(file) && rendered === null) {
        this.busy.set(key, Date.now());
        if (this.busy.size > 1024)
          this.busy.delete(this.busy.keys().next().value);
        return { retry: true };
      }
      if (!fs.existsSync(file)) {
        this.failed.set(key, Date.now());
        if (this.failed.size > 1024)
          this.failed.delete(this.failed.keys().next().value);
        return { unavailable: true };
      }
    }
    return {
      data: `data:image/jpeg;base64,${fs.readFileSync(file).toString("base64")}`,
    };
  }
  media(volume, name, hash) {
    if (this.s.config.role !== "hub" && !this.s.volume(volume).selected)
      fail("Select this folder first", 403);
    this.requireLibrary(volume);
    const row = typeof name === "string" ? this.s.viewCurrent(volume, name) : null;
    if (
      !row ||
      row.deleted ||
      row.directory ||
      row.hash !== hash ||
      !audioType(name) ||
      this.s.visibleRules(volume)(name, false)
    )
      fail("This track is no longer available", 404);
    const file = this.s.localContent(volume, name, hash);
    if (!file || fs.statSync(file, { throwIfNoEntry: false })?.size !== row.size)
      fail("Sync this track before playing it", 409);
    return { file, size: row.size, type: audioType(name) };
  }
  sweep(force = false) {
    if (this.closed || (!force && Date.now() - this.swept < SWEEP_MS)) return;
    this.swept = Date.now();
    try {
      this.removeUnreferenced();
    } catch {}
  }
  removeUnreferenced() {
    const libraries = JSON.stringify(this.libraries());
    const current = `SELECT f.hash FROM ${this.s.fileSource()} f WHERE f.volume IN (SELECT value FROM json_each(?)) AND f.deleted=0 AND f.directory=0 AND f.hash IS NOT NULL`;
    if (
      this.s.db
        .prepare(`DELETE FROM music_tracks WHERE hash NOT IN (${current})`)
        .run(libraries).changes
    )
      this.generation++;
    if (!fs.existsSync(this.directory)) return;
    const keep = new Set([
      ...this.s.db
        .prepare("SELECT cover FROM music_tracks WHERE cover IS NOT NULL")
        .all()
        .map((row) => row.cover),
      ...this.s.db
        .prepare(`${current} AND arca_music_side(f.path)=1`)
        .all(libraries)
        .map((row) => row.hash),
    ]);
    for (const name of fs.readdirSync(this.directory)) {
      const key = name.slice(0, 64);
      if (keep.has(key) && !name.endsWith(".tmp")) continue;
      if (this.rendering.has(key)) continue;
      try {
        fs.rmSync(path.join(this.directory, name), { force: true });
      } catch {
        /* A cover held open elsewhere is removed by a later sweep. */
      }
    }
  }
}
