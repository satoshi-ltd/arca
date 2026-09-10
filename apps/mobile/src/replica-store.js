export class ReplicaStore {
  constructor(db) {
    this.db = db;
  }
  async init() {
    await this.db.execAsync(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
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
      `SELECT f.*, COUNT(x.path) AS files,
       COALESCE(SUM(json_extract(x.row, '$.size')), 0) AS bytes,
       COALESCE(SUM(CASE WHEN instr(x.path, '.conflict-') > 0 AND COALESCE(json_extract(x.row, '$.resolved'), 0)=0 THEN 1 ELSE 0 END),0) AS conflicts
       FROM folders f LEFT JOIN files x ON x.scope=f.scope AND x.volume=f.id
         AND COALESCE(json_extract(x.row, '$.deleted'), 0)=0 AND COALESCE(json_extract(x.row, '$.directory'), 0)=0
       WHERE f.scope=? GROUP BY f.scope,f.id ORDER BY f.name`,
      scope,
    );
  }
  folder(scope, id) {
    return this.db.getFirstAsync(
      "SELECT * FROM folders WHERE scope=? AND id=?",
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
      for (const table of ["files", "pending", "applying"])
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
