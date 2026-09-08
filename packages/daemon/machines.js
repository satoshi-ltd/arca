import os from "node:os";
import { fail } from "./storage.js";
export function machineReport(engine) {
  const status = engine.status(),
    volumes = status.volumes.filter((v) => v.selected);
  return {
    machineId: status.id,
    name: status.name,
    platform: process.platform,
    arch: process.arch,
    kernelRelease: os.release(),
    uptimeSeconds: Math.floor(process.uptime()),
    phase: status.phase,
    lastSync: status.lastSync,
    selectedFolders: volumes.length,
    folderIds: volumes.map((v) => v.id),
    indexedFiles: volumes.reduce((n, v) => n + v.files, 0),
    indexedBytes: volumes.reduce((n, v) => n + v.bytes, 0),
  };
}
export function acceptReport(store, device, body) {
  const clean = {};
  for (const key of [
    "machineId",
    "name",
    "platform",
    "arch",
    "kernelRelease",
    "phase",
  ]) {
    if (typeof body[key] !== "string" || body[key].length > 200)
      fail(`Invalid machine report: ${key}`);
    clean[key] = body[key];
  }
  for (const key of [
    "uptimeSeconds",
    "selectedFolders",
    "indexedFiles",
    "indexedBytes",
  ]) {
    if (!Number.isSafeInteger(body[key]) || body[key] < 0)
      fail(`Invalid machine report: ${key}`);
    clean[key] = body[key];
  }
  if (
    body.lastSync !== null &&
    (!Number.isFinite(Date.parse(body.lastSync)) ||
      Date.parse(body.lastSync) > Date.now() + 60000)
  )
    fail("Invalid machine report timestamp");
  if (
    !clean.name.trim() ||
    clean.name.length > 100 ||
    /[\x00-\x1f]/.test(clean.name)
  )
    fail("Invalid machine report: name");
  if (body.folderIds !== undefined) {
    if (
      !Array.isArray(body.folderIds) ||
      body.folderIds.length > 10000 ||
      body.folderIds.some(
        (id) => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id),
      )
    )
      fail("Invalid machine report: folderIds");
    clean.folderIds = [...new Set(body.folderIds)];
  }
  clean.name = clean.name.trim();
  clean.lastSync = body.lastSync;
  clean.reportedAt = new Date().toISOString();
  store.db
    .prepare("INSERT OR REPLACE INTO machine_reports VALUES(?,?)")
    .run(device.id, JSON.stringify(clean));
  store.db
    .prepare("UPDATE devices SET name=? WHERE id=?")
    .run(clean.name, device.id);
  return { received: true };
}
export function machines(engine) {
  const s = engine.store,
    now = Date.now();
  return {
    hubId: engine.config.id,
    machines: [
      {
        ...machineReport(engine),
        role: "hub",
        isHub: true,
        credentialId: null,
        revoked: false,
        reportedAt: new Date(now).toISOString(),
        freshness: "local",
      },
      ...s.db
        .prepare(
          "SELECT d.id,d.name,d.role,d.revoked,d.last_seen,d.last_address,a.enabled,a.revision,a.updated,r.report FROM devices d LEFT JOIN backup_ack a ON a.device=d.id LEFT JOIN machine_reports r ON r.device=d.id",
        )
        .all()
        .map((row) => {
          const report = row.report ? JSON.parse(row.report) : null;
          return {
            ...report,
            credentialId: row.id,
            name: report?.name || row.name,
            role: row.role,
            isHub: false,
            revoked: !!row.revoked,
            lastContact: row.last_seen,
            lastAddress: row.last_address,
            linkState: row.revoked
              ? "revoked"
              : row.last_seen
                ? "authenticated"
                : "invited",
            freshness: report
              ? now - Date.parse(report.reportedAt) < 120000
                ? "recent"
                : "stale"
              : "not-reported",
            backup:
              row.enabled === null
                ? null
                : {
                    enabled: !!row.enabled,
                    receivedRevision: row.revision,
                    acknowledgedAt: row.updated,
                  },
          };
        }),
    ],
  };
}
