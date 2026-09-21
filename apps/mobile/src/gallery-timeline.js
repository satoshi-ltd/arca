import { galleryDate, mediaKind } from "../../../packages/core/gallery-date.js";

export const isGalleryVideo = (item) => mediaKind(item.path) === "video";
const isoDay = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
};
export const mediaDate = (path, mtime) =>
  galleryDate(path, null, mtime ? isoDay(mtime) : null).date;
const order = (item) => `${item.date || ""}|${item.path}`;

// Hub rows carry the chronology, local copies contribute file URIs, pending uploads lead.
export function mergeTimeline({ index = [], entries = [], uploads = [] }) {
  const items = new Map();
  for (const row of index) {
    const kind = mediaKind(row.path);
    if (kind)
      items.set(row.path, {
        path: row.path,
        hash: row.hash,
        rev: row.rev,
        sourcePath: row.sourcePath,
        sourceHash: row.sourceHash,
        size: row.size,
        date: row.date,
        kind,
        signature: row.hash,
        uri: null,
      });
  }
  for (const entry of entries) {
    const kind = mediaKind(entry.path);
    if (entry.directory || !kind) continue;
    const known = items.get(entry.path) || {
      path: entry.path,
      hash: null,
      kind,
      date: mediaDate(entry.path, entry.mtime),
    };
    items.set(entry.path, {
      ...known,
      uri: entry.uri,
      size: entry.size ?? known.size ?? 0,
      mtime: entry.mtime,
      signature: `${entry.size}:${entry.mtime}`,
    });
  }
  const photos = [...items.values()].sort((a, b) =>
    order(a) > order(b) ? -1 : order(a) < order(b) ? 1 : 0,
  );
  const pending = uploads
    .filter((upload) => upload.state !== "accepted")
    .sort((a, b) => (b.creationTime || 0) - (a.creationTime || 0))
    .map((upload) => ({
      path: `upload:${upload.id}`,
      kind: upload.video ? "video" : "image",
      date: null,
      uri: upload.uri || null,
      size: 0,
      upload: upload.state,
      name: upload.filename,
    }));
  return pending.concat(photos);
}
export function monthLabel(month) {
  if (month === "uploading") return "Uploading";
  if (!/^\d{4}-\d{2}$/.test(month)) return "Undated";
  return new Date(month + "-01T12:00:00").toLocaleDateString("en", {
    month: "long",
    year: "numeric",
  });
}
export function groupByMonth(items) {
  const groups = [];
  for (const item of items) {
    const month = item.upload
      ? "uploading"
      : (item.date || "").slice(0, 7) || "undated";
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.items.push(item);
    else groups.push({ month, label: monthLabel(month), items: [item] });
  }
  return groups;
}
export function dateLabel(date) {
  if (!date) return "";
  if (/^\d{4}-\d{2}$/.test(date)) return monthLabel(date);
  const dayOnly = date.length <= 10;
  const value = new Date(dayOnly ? date + "T12:00:00" : date);
  if (!Number.isFinite(value.getTime())) return "";
  return value.toLocaleString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(dayOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  });
}
export const photoCount = (items) =>
  items.filter((item) => !item.upload).length;
export function uploadStatus(source, { connected, paused, busy }) {
  const summary = source.summary || {};
  return source.mode === "converting"
    ? "Incomplete"
    : !source.enabled
      ? "Disabled"
      : paused
        ? "Paused"
        : !connected || source.issue
          ? "Needs attention"
          : busy
            ? "Syncing"
            : summary.pending || !source.scannedAt || source.after
              ? "Incomplete"
              : "Up to date";
}
