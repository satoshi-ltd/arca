export class ReplicaStore {
  constructor(db) {
    this.db = db;
  }
  async init() {
    await this.db.execAsync(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS gallery_sources (scope TEXT, volume TEXT, config TEXT NOT NULL, PRIMARY KEY(scope,volume));
      CREATE TABLE IF NOT EXISTS gallery_assets (scope TEXT, volume TEXT, asset TEXT, state TEXT NOT NULL, retryAt INTEGER DEFAULT 0, row TEXT NOT NULL, PRIMARY KEY(scope,volume,asset));
      CREATE INDEX IF NOT EXISTS gallery_work ON gallery_assets(scope,volume,state,retryAt);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders (scope TEXT, id TEXT, name TEXT, selected INTEGER DEFAULT 1, cursor INTEGER DEFAULT 0, initialized INTEGER DEFAULT 0, completed TEXT, issue TEXT, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS files (scope TEXT, volume TEXT, path TEXT, row TEXT NOT NULL, PRIMARY KEY(scope,volume,path));
      CREATE TABLE IF NOT EXISTS pending (scope TEXT, volume TEXT, path TEXT, op TEXT NOT NULL, PRIMARY KEY(scope,volume,path));
      CREATE TABLE IF NOT EXISTS applying (scope TEXT, volume TEXT, path TEXT, row TEXT NOT NULL, PRIMARY KEY(scope,volume,path));
`);
  }
  async reset() {
    await this.db.execAsync("PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      for (const table of [
        "gallery_assets",
        "gallery_sources",
        "files",
        "pending",
        "applying",
        "folders",
        "settings",
      ])
        await this.db.execAsync(`DELETE FROM ${table}`);
      await this.db.execAsync("COMMIT");
    } catch (error) {
      await this.db.execAsync("ROLLBACK");
      throw error;
    }
    await this.db.execAsync("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  async get(key, fallback = null) {
    const row = await this.db.getFirstAsync(
      "SELECT value FROM settings WHERE key=?",
      key,
    );
    return row ? JSON.parse(row.value) : fallback;
  }
  async set(key, value) {
    await this.db.runAsync(
      "INSERT OR REPLACE INTO settings VALUES(?,?)",
      key,
      JSON.stringify(value),
    );
  }
  folders(scope) {
    return this.db.getAllAsync(
      `SELECT f.*, g.config AS gallery, COUNT(x.path) AS files,
       COALESCE(SUM(json_extract(x.row, '$.size')), 0) AS bytes,
       COALESCE(SUM(CASE WHEN instr(x.path, '.conflict-') > 0 AND COALESCE(json_extract(x.row, '$.resolved'), 0)=0 THEN 1 ELSE 0 END),0) AS conflicts
       FROM folders f LEFT JOIN gallery_sources g ON g.scope=f.scope AND g.volume=f.id LEFT JOIN files x ON x.scope=f.scope AND x.volume=f.id
         AND COALESCE(json_extract(x.row, '$.deleted'), 0)=0 AND COALESCE(json_extract(x.row, '$.directory'), 0)=0
       WHERE f.scope=? GROUP BY f.scope,f.id ORDER BY f.name`,
      scope,
    );
  }
  folder(scope, id) {
    return this.db.getFirstAsync(
      "SELECT f.*, g.config AS gallery FROM folders f LEFT JOIN gallery_sources g ON g.scope=f.scope AND g.volume=f.id WHERE f.scope=? AND f.id=?",
      scope,
      id,
    );
  }
  async select(scope, volume) {
    await this.db.runAsync(
      "INSERT INTO folders(scope,id,name) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET selected=1,name=excluded.name,completed=NULL",
      scope,
      volume.id,
      volume.name,
    );
  }
  async forgetFolder(scope, id) {
    await this.db.execAsync("BEGIN IMMEDIATE");
    try {
      for (const table of [
        "files",
        "pending",
        "applying",
        "gallery_assets",
        "gallery_sources",
      ])
        await this.db.runAsync(
          `DELETE FROM ${table} WHERE scope=? AND volume=?`,
          scope,
          id,
        );
      await this.db.runAsync(
        "DELETE FROM folders WHERE scope=? AND id=?",
        scope,
        id,
      );
      await this.db.execAsync("COMMIT");
    } catch (error) {
      await this.db.execAsync("ROLLBACK");
      throw error;
    }
  }
  async gallery(scope, volume) {
    const row = await this.db.getFirstAsync(
      "SELECT config FROM gallery_sources WHERE scope=? AND volume=?",
      scope,
      volume,
    );
    return row ? JSON.parse(row.config) : null;
  }
  async setGallery(scope, volume, config) {
    await this.db.runAsync(
      "INSERT OR REPLACE INTO gallery_sources VALUES(?,?,?)",
      scope,
      volume,
      JSON.stringify(config),
    );
  }
  async clearWorkingIndex(scope, volume) {
    await this.db.execAsync("BEGIN IMMEDIATE");
    try {
      for (const table of ["files", "pending", "applying"])
        await this.db.runAsync(
          `DELETE FROM ${table} WHERE scope=? AND volume=?`,
          scope,
          volume,
        );
      await this.db.runAsync(
        "UPDATE folders SET cursor=0,initialized=0,completed=NULL,issue=NULL WHERE scope=? AND id=?",
        scope,
        volume,
      );
      await this.db.execAsync("COMMIT");
    } catch (error) {
      await this.db.execAsync("ROLLBACK");
      throw error;
    }
  }
  async galleryAsset(scope, volume, asset) {
    const row = await this.db.getFirstAsync(
      "SELECT row FROM gallery_assets WHERE scope=? AND volume=? AND asset=?",
      scope,
      volume,
      asset,
    );
    return row ? JSON.parse(row.row) : null;
  }
  async putGalleryAsset(scope, volume, item) {
    if (item.state === "accepted" && !item.acceptedAt)
      item.acceptedAt = Date.now();
    await this.db.runAsync(
      "INSERT OR REPLACE INTO gallery_assets VALUES(?,?,?,?,?,?)",
      scope,
      volume,
      item.id,
      item.state,
      item.retryAt || 0,
      JSON.stringify(item),
    );
  }
  async galleryWork(scope, volume, now, limit = 3) {
    return (
      await this.db.getAllAsync(
        "SELECT row FROM gallery_assets WHERE scope=? AND volume=? AND state!='accepted' AND retryAt<=? ORDER BY retryAt,asset LIMIT ?",
        scope,
        volume,
        now,
        limit,
      )
    ).map((r) => JSON.parse(r.row));
  }
  async galleryReceipt(scope, volume, hash, size, pickedOnly = false) {
    const row = await this.db.getFirstAsync(
      `SELECT resource.value AS receipt FROM gallery_assets AS asset,
       json_each(asset.row, '$.resources') AS resource
       WHERE asset.scope=? AND asset.volume=?
       ${pickedOnly ? "AND asset.asset GLOB 'picked-*'" : ""}
       AND json_extract(resource.value, '$.accepted')=1
       AND json_extract(resource.value, '$.hash')=?
       AND json_extract(resource.value, '$.size')=? LIMIT 1`,
      scope,
      volume,
      hash,
      size,
    );
    return row ? JSON.parse(row.receipt) : null;
  }
  async galleryPreview(scope, volume, accepted, limit = 12, offset = 0) {
    const rows = await this.db.getAllAsync(
      `SELECT row FROM gallery_assets WHERE scope=? AND volume=? AND ${accepted ? "state='accepted'" : "state!='accepted'"}
       ORDER BY ${accepted ? "COALESCE(json_extract(row, '$.acceptedAt'), json_extract(row, '$.creationTime'),0) DESC, asset" : "CASE state WHEN 'failed' THEN 0 WHEN 'uploading' THEN 1 ELSE 2 END, asset"} LIMIT ? OFFSET ?`,
      scope,
      volume,
      Math.min(24, Math.max(1, limit)),
      offset,
    );
    return rows.map((row) => JSON.parse(row.row));
  }
  async gallerySummary(scope, volume) {
    return this.db.getFirstAsync(
      `SELECT COUNT(*) AS discovered,
      COALESCE(SUM(state='accepted'),0) AS accepted,
      COALESCE(SUM(state='failed'),0) AS failed,
      COALESCE(SUM(state!='accepted'),0) AS pending,
      (SELECT COALESCE(SUM(size),0) FROM (
        SELECT DISTINCT json_extract(resource.value, '$.path') AS path,
          json_extract(resource.value, '$.hash') AS hash,
          json_extract(resource.value, '$.size') AS size
        FROM gallery_assets AS asset, json_each(asset.row, '$.resources') AS resource
        WHERE asset.scope=? AND asset.volume=? AND json_extract(resource.value, '$.accepted')=1
      )) AS bytes
      FROM gallery_assets WHERE scope=? AND volume=?`,
      scope,
      volume,
      scope,
      volume,
    );
  }
  async retryGallery(scope, volume) {
    await this.db.runAsync(
      "UPDATE gallery_assets SET retryAt=0 WHERE scope=? AND volume=? AND state!='accepted'",
      scope,
      volume,
    );
  }
  async referencedHashes(scope) {
    const rows = await this.db.getAllAsync(
      `
      SELECT json_extract(row, '$.hash') AS hash FROM files WHERE scope=?
      UNION SELECT json_extract(op, '$.hash') FROM pending WHERE scope=?
      UNION SELECT json_extract(row, '$.hash') FROM applying WHERE scope=?`,
      scope,
      scope,
      scope,
    );
    return rows.map((row) => row.hash).filter(Boolean);
  }
  async issue(scope, id, message) {
    await this.db.runAsync(
      "UPDATE folders SET issue=?,completed=NULL WHERE scope=? AND id=?",
      message,
      scope,
      id,
    );
  }
  async resetCursor(scope, id) {
    await this.db.runAsync(
      "UPDATE folders SET cursor=0,initialized=0,completed=NULL WHERE scope=? AND id=?",
      scope,
      id,
    );
  }
  async complete(scope, id, cursor) {
    await this.db.runAsync(
      "UPDATE folders SET cursor=?,initialized=1,completed=?,issue=NULL WHERE scope=? AND id=?",
      cursor,
      new Date().toISOString(),
      scope,
      id,
    );
  }
  async rows(scope, volume) {
    return (
      await this.db.getAllAsync(
        "SELECT row FROM files WHERE scope=? AND volume=? ORDER BY path",
        scope,
        volume,
      )
    ).map((r) => JSON.parse(r.row));
  }
  async current(scope, volume, path) {
    const r = await this.db.getFirstAsync(
      "SELECT row FROM files WHERE scope=? AND volume=? AND path=?",
      scope,
      volume,
      path,
    );
    return r ? JSON.parse(r.row) : null;
  }
  async put(scope, row) {
    await this.db.runAsync(
      "INSERT OR REPLACE INTO files VALUES(?,?,?,?)",
      scope,
      row.volume,
      row.path,
      JSON.stringify(row),
    );
  }
  async queue(scope, op) {
    await this.db.runAsync(
      "INSERT OR REPLACE INTO pending VALUES(?,?,?,?)",
      scope,
      op.volume,
      op.path,
      JSON.stringify(op),
    );
  }
  async pending(scope, volume) {
    return (
      await this.db.getAllAsync(
        "SELECT op FROM pending WHERE scope=? AND volume=? ORDER BY path",
        scope,
        volume,
      )
    ).map((r) => JSON.parse(r.op));
  }
  async dequeue(scope, volume, path) {
    await this.db.runAsync(
      "DELETE FROM pending WHERE scope=? AND volume=? AND path=?",
      scope,
      volume,
      path,
    );
  }
  async journal(scope, row) {
    await this.db.runAsync(
      "INSERT OR REPLACE INTO applying VALUES(?,?,?,?)",
      scope,
      row.volume,
      row.path,
      JSON.stringify(row),
    );
  }
  async applied(scope, row) {
    await this.put(scope, row);
    await this.db.runAsync(
      "DELETE FROM applying WHERE scope=? AND volume=? AND path=?",
      scope,
      row.volume,
      row.path,
    );
  }
  async applying(scope, volume) {
    return (
      await this.db.getAllAsync(
        "SELECT row FROM applying WHERE scope=? AND volume=?",
        scope,
        volume,
      )
    ).map((r) => JSON.parse(r.row));
  }
}
