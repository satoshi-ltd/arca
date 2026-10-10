import { galleryDate, mediaKind } from "../../../packages/core/gallery-date.js";

const isoDay = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : null;
};
export const mediaDate = (path, mtime) =>
  galleryDate(path, null, mtime ? isoDay(mtime) : null).date;
const order = (item) => `${item.date || ""}|${item.path}`;

export function timelineItem(row, entry) {
  const kind = mediaKind((row || entry).path);
  if (!kind || entry?.directory) return null;
  const known = row
    ? {
        path: row.path,
        hash: row.hash,
        rev: row.rev,
        size: row.size,
        date: row.date,
        kind,
        signature: row.hash,
        uri: null,
      }
    : {
        path: entry.path,
        hash: null,
        kind,
        date: mediaDate(entry.path, entry.mtime),
      };
  return entry
    ? {
        ...known,
        uri: entry.uri,
        size: entry.size ?? known.size ?? 0,
        mtime: entry.mtime,
        signature: `${entry.size}:${entry.mtime}`,
      }
    : known;
}
// Hub rows carry the chronology, local copies contribute file URIs, pending uploads lead.
export function mergeTimeline({ index = [], entries = [], uploads = [] }) {
  const rows = new Map(index.map((row) => [row.path, row]));
  const items = new Map();
  for (const row of index) {
    const item = timelineItem(row);
    if (item) items.set(row.path, item);
  }
  for (const entry of entries) {
    const item = timelineItem(rows.get(entry.path), entry);
    if (item) items.set(entry.path, item);
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
      upload: upload.lost ? "lost" : upload.state,
      name: upload.filename,
    }));
  return pending.concat(photos);
}
const PREVIEW_LIMIT = 5000;
export function previewCandidates(entries, excluded = () => false) {
  return mergeTimeline({
    entries: entries.filter((entry) => !excluded(entry.path)),
  })
    .sort((a, b) => (a.kind === "video") - (b.kind === "video"))
    .slice(0, PREVIEW_LIMIT);
}
export const datedMonth = (month) => /^\d{4}-\d{2}$/.test(month);
export function monthLabel(month) {
  if (!datedMonth(month)) return "Date unknown";
  return new Date(month + "-01T12:00:00").toLocaleDateString("en", {
    month: "long",
    year: "numeric",
  });
}
export function pendingUploadLabel(items, summary = {}) {
  const lost = items.filter((item) => item.upload === "lost").length;
  const failed = Math.max(
    items.filter((item) => item.upload === "failed").length,
    (summary.failed || 0) - lost,
  );
  const waiting = Math.max(
    items.filter((item) => !["failed", "lost"].includes(item.upload)).length,
    (summary.pending || 0) - (summary.failed || 0),
  );
  return [
    waiting ? `${waiting} remaining` : "",
    failed ? `${failed} ${failed === 1 ? "needs" : "need"} attention` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export const railMonthLabel = (month) =>
  datedMonth(month)
    ? new Date(month + "-01T12:00:00").toLocaleDateString("en", {
        month: "short",
        year: "numeric",
      })
    : monthLabel(month);
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

