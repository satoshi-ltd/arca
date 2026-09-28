import { fail, validPath } from "./storage.js";
import { mediaKind } from "./gallery.js";

const identity = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
function folder(store, volume) {
  const v = store.volume(volume);
  if (
    !store.db
      .prepare("SELECT 1 FROM gallery_folders WHERE volume=?")
      .get(volume)
  )
    fail("This folder is not a shared gallery.", 409);
  return v;
}
export function registerGalleryAsset(store, body, source) {
  folder(store, body.volume);
  if (
    !identity(body.asset) ||
    !Array.isArray(body.resources) ||
    !body.resources.length ||
    body.resources.length > 8
  )
    fail("Invalid gallery asset manifest");
  const previous = store.db
    .prepare(
      "SELECT * FROM gallery_assets WHERE volume=? AND source=? AND asset=?",
    )
    .get(body.volume, source, body.asset);
  if (previous?.deleted) return { removed: true };
  const paths = new Set();
  for (const r of body.resources) {
    validPath(r.path);
    if (
      !mediaKind(r.path) ||
      !/^[a-f0-9]{64}$/.test(r.hash) ||
      !Number.isSafeInteger(r.size) ||
      r.size < 0 ||
      typeof r.key !== "string" ||
      r.key.length > 200 ||
      paths.has(r.path)
    )
      fail("Invalid gallery resource");
    paths.add(r.path);
    if (store.excluded(body.volume, r.path))
      fail("Excluded by .arcaignore", 409);
    const member = store.db
      .prepare("SELECT * FROM gallery_members WHERE volume=? AND path=?")
      .get(body.volume, r.path);
    if (member && (member.source !== source || member.asset !== body.asset))
      fail("This resource belongs to another gallery asset.", 409);
    const current = store.current(body.volume, r.path);
    if (!member && current) {
      const revision = store.db
        .prepare("SELECT author FROM revisions WHERE rev=?")
        .get(current.rev);
      if (
        current.deleted ||
        current.hash !== r.hash ||
        current.size !== r.size ||
        revision?.author !== source
      )
        fail("The original upload cannot be verified.", 409);
    }
  }
  if (
    previous &&
    JSON.parse(previous.resources).some((r) => !paths.has(r.path))
  )
    fail("Keep every resource in this gallery asset.", 409);
  const resources = body.resources
    .map(({ key, path, hash, size }) => ({ key, path, hash, size }))
    .sort(
      (a, b) =>
        Number(mediaKind(a.path) === "video") -
        Number(mediaKind(b.path) === "video"),
    );
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.db
      .prepare(
        "INSERT INTO gallery_assets VALUES(?,?,?,?,0) ON CONFLICT(volume,source,asset) DO UPDATE SET resources=excluded.resources",
      )
      .run(body.volume, source, body.asset, JSON.stringify(resources));
    for (const r of resources)
      store.db
        .prepare("INSERT OR REPLACE INTO gallery_members VALUES(?,?,?,?)")
        .run(body.volume, r.path, source, body.asset);
    store.db.exec("COMMIT");
  } catch (e) {
    store.db.exec("ROLLBACK");
    throw e;
  }
  return { removed: false };
}
export function assertGalleryUpload(store, volume, path, source) {
  const report = store.db
    .prepare("SELECT report FROM machine_reports WHERE device=?")
    .get(source);
  const selection = report && JSON.parse(report.report);
  if (
    selection?.folderIds?.includes(volume) &&
    !selection.albumFolderIds?.includes(volume)
  )
    return;
  const asset = store.db
    .prepare(
      "SELECT a.deleted FROM gallery_members m JOIN gallery_assets a USING(volume,source,asset) WHERE m.volume=? AND m.path=? AND m.source=?",
    )
    .get(volume, path, source);
  if (asset?.deleted)
    fail(
      "This gallery item was deleted. Automatic upload is suppressed.",
      409,
    );
}
export async function deleteGalleryAsset(engine, body, author) {
  const s = engine.store,
    v = folder(s, body.volume);
  validPath(body.path);
  if (!identity(body.id) || !Number.isSafeInteger(body.rev) || body.rev < 1)
    fail("Invalid gallery deletion");
  const request = JSON.stringify([body.volume, body.path, body.rev]);
  const existing = s.db
    .prepare("SELECT * FROM gallery_deletions WHERE author=? AND id=?")
    .get(author, body.id);
  if (existing) {
    if (existing.request !== request)
      fail("Deletion ID was reused for another request.", 409);
    s.recover(body.volume);
    return JSON.parse(existing.result);
  }
  const member = s.db
    .prepare("SELECT * FROM gallery_members WHERE volume=? AND path=?")
    .get(body.volume, body.path);
  const group =
    member &&
    s.db
      .prepare(
        "SELECT * FROM gallery_assets WHERE volume=? AND source=? AND asset=?",
      )
      .get(body.volume, member.source, member.asset);
  const resources = group ? JSON.parse(group.resources) : [{ path: body.path }];
  await engine.scanHub(body.volume, {
    paths: [...resources.map((r) => r.path), ".arcaignore"],
  });
  const current = s.current(body.volume, body.path);
  if (!current || current.deleted || current.rev !== body.rev)
    fail("Photo changed. Refresh the gallery before deleting.", 409);
  const before = resources.map((resource) => {
    const row = s.current(body.volume, resource.path);
    if (
      !row ||
      row.deleted ||
      row.directory ||
      !mediaKind(row.path) ||
      s.excluded(body.volume, row.path) ||
      (group && (row.hash !== resource.hash || row.size !== resource.size))
    )
      fail(
        "A photo resource changed or is still uploading. Sync and review it again.",
        409,
      );
    return { ...row, key: resource.key };
  });
  const now = Date.now(),
    rows = [];
  s.db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of before) {
      const added = s.db
        .prepare(
          "INSERT INTO revisions(volume,path,hash,size,deleted,author,created,directory) VALUES(?,?,NULL,0,1,?,?,0)",
        )
        .run(body.volume, row.path, author, new Date(now).toISOString());
      const removed = {
        volume: body.volume,
        path: row.path,
        hash: null,
        size: 0,
        deleted: 1,
        directory: 0,
        rev: Number(added.lastInsertRowid),
      };
      rows.push(removed);
      if (v.selected) s.queue(removed, row.hash);
      else s.setFile(removed);
    }
    const result = {
      id: body.id,
      volume: body.volume,
      paths: rows.map((r) => r.path),
      rows,
    };
    if (group)
      s.db
        .prepare(
          "UPDATE gallery_assets SET deleted=1 WHERE volume=? AND source=? AND asset=?",
        )
        .run(body.volume, group.source, group.asset);
    s.db
      .prepare(
        "INSERT INTO gallery_deletions(author,id,volume,request,result,source,asset,created) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        author,
        body.id,
        body.volume,
        request,
        JSON.stringify(result),
        group?.source || null,
        group?.asset || null,
        now,
      );
    s.db.exec("COMMIT");
  } catch (e) {
    s.db.exec("ROLLBACK");
    throw e;
  }
  s.recover(body.volume);
  return {
    id: body.id,
    volume: body.volume,
    paths: rows.map((r) => r.path),
    rows,
  };
}
export function galleryRemovalEvents(store, volume, source, after = 0) {
  folder(store, volume);
  if (!Number.isSafeInteger(after) || after < 0) fail("Invalid gallery cursor");
  const events = store.db
    .prepare(
      "SELECT rowid AS seq,* FROM gallery_deletions WHERE volume=? AND source=? AND rowid>? ORDER BY rowid LIMIT 100",
    )
    .all(volume, source, after)
    .map((event) => {
      return {
        suppressed: !!store.db
          .prepare(
            "SELECT deleted FROM gallery_assets WHERE volume=? AND source=? AND asset=?",
          )
          .get(volume, source, event.asset)?.deleted,
        seq: event.seq,
        id: event.id,
        asset: event.asset,
        created: event.created,
      };
    });
  return {
    head: store.db
      .prepare("SELECT coalesce(max(rowid),0) AS n FROM gallery_deletions")
      .get().n,
    events,
    next: events.length === 100 ? events.at(-1).seq : null,
  };
}
