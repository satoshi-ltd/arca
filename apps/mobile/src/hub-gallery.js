import { mergeTimeline, mediaDate } from "./gallery-timeline.js";
import { mediaKind } from "../../../packages/core/gallery-date.js";
import { builtinExcluded } from "../../../packages/core/builtin-exclusions.js";

const compact = (item) => ({
  path: item.path,
  hash: item.hash,
  ...(item.rev != null ? { rev: item.rev } : {}),
  size: item.size,
  date: item.date,
  kind: item.kind,
});
export const galleryMonth = (item) =>
  (item.date || "").slice(0, 7) || "undated";
// Mirrors the hub cursor `date|path`: undated rows ("|path") sort above every dated month.
const rank = (month) => (month === "undated" ? "~" : month);
const cursorOf = (item) => `${item.date || ""}|${item.path}`;
const CACHE_ITEMS = 600;
const empty = () => ({ timeline: [], total: 0, months: {}, indexing: false });

const monthOfCursor = (cursor) =>
  cursor.startsWith("|") ? "undated" : cursor.slice(0, 7);
const signature = (row) => `${row.count}:${row.rev ?? ""}`;
const sameItems = (a, b) =>
  a.length === b.length &&
  a.every(
    (item, index) =>
      item.path === b[index].path &&
      item.hash === b[index].hash &&
      item.rev === b[index].rev &&
      item.date === b[index].date,
  );

// A changed month keeps showing its rows until a fresh read replaces them.
function withTimeline(state, data) {
  const timeline = data.timeline || [];
  const before = new Map(state.timeline.map((row) => [row.month, signature(row)]));
  const after = new Map(timeline.map((row) => [row.month, signature(row)]));
  const changed = new Set(
    [...before.keys(), ...after.keys()].filter(
      (month) => before.get(month) !== after.get(month),
    ),
  );
  if (!changed.size) return { changed, state };
  const months = { ...state.months };
  for (const month of changed) {
    if (!after.has(month)) delete months[month];
    else if (months[month])
      months[month] = { ...months[month], fresh: 0, complete: false, next: null };
  }
  return {
    changed,
    state: {
      ...state,
      timeline,
      total: timeline.reduce((sum, row) => sum + row.count, 0),
      months,
    },
  };
}
// A page is authoritative for the cursors below `upper` (exclusive; null: all) down to its last row, or to the end.
function absorb(state, rows, next, upper) {
  const items = rows.map(compact);
  const lower = next === null || !items.length ? null : cursorOf(items[items.length - 1]);
  const top = upper === null ? null : rank(monthOfCursor(upper));
  const last = lower === null ? null : rank(galleryMonth(items[items.length - 1]));
  const pages = new Map();
  for (const item of items) {
    const month = galleryMonth(item);
    pages.set(month, [...(pages.get(month) || []), item]);
  }
  const months = { ...state.months };
  let changed = false;
  for (const month of new Set([
    "undated",
    ...state.timeline.map((row) => row.month),
    ...Object.keys(state.months),
    ...pages.keys(),
  ])) {
    const value = rank(month);
    if ((top !== null && value > top) || (last !== null && value < last))
      continue;
    const old = state.months[month];
    const kept = old && upper !== null ? old.items.filter((item) => cursorOf(item) >= upper) : [];
    const fresh = pages.get(month) || [];
    const complete = last === null || value > last;
    const entry = {
      items: [
        ...kept,
        ...fresh,
        ...(complete || !old ? [] : old.items.filter((item) => cursorOf(item) < lower)),
      ],
      fresh: kept.length + fresh.length,
      complete,
      next: complete ? null : lower,
    };
    if (
      old &&
      old.fresh === entry.fresh &&
      old.complete === entry.complete &&
      old.next === entry.next &&
      sameItems(old.items, entry.items)
    )
      continue;
    // A shorter read of an unchanged month must not discard rows verified beyond it.
    if (
      old &&
      !complete &&
      old.fresh > entry.fresh &&
      sameItems(old.items.slice(0, entry.fresh), entry.items.slice(0, entry.fresh))
    )
      continue;
    months[month] = entry;
    changed = true;
  }
  return changed ? { ...state, months } : state;
}
export function localGallery(entries) {
  const months = {};
  const counts = new Map();
  for (const item of mergeTimeline({ entries })) {
    const month = galleryMonth(item);
    (months[month] ||= { items: [], complete: true, next: null }).items.push(
      item,
    );
    if (month !== "undated") counts.set(month, (counts.get(month) || 0) + 1);
  }
  for (const entry of Object.values(months)) entry.fresh = entry.items.length;
  const timeline = [...counts]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => b.month.localeCompare(a.month));
  return {
    local: true,
    timeline,
    total: timeline.reduce((sum, row) => sum + row.count, 0),
    months,
    indexing: false,
  };
}
const before = (a, b) => `${a.date || ""}|${a.path}` > `${b.date || ""}|${b.path}`;
export function withLocalOnly(state, entries, known) {
  if (!known) return state;
  const listed = new Set(
    Object.values(state.months).flatMap((entry) => entry.items.map((item) => item.path)),
  );
  const extra = entries.filter(
    (entry) =>
      !entry.directory &&
      mediaKind(entry.path) &&
      !builtinExcluded(entry.path) &&
      !known.has(entry.path) &&
      !listed.has(entry.path),
  );
  if (!extra.length) return state;
  const months = { ...state.months };
  const counts = new Map(state.timeline.map((row) => [row.month, row.count]));
  for (const entry of extra) {
    const row = {
      path: entry.path,
      hash: null,
      size: entry.size,
      date: mediaDate(entry.path, entry.mtime),
      kind: mediaKind(entry.path),
    };
    const month = galleryMonth(row);
    const held = months[month] || {
      items: [],
      fresh: 0,
      complete: !state.timeline.some((row) => row.month === month),
      next: null,
    };
    const items = [...held.items];
    const at = items.findIndex((item) => before(row, item));
    items.splice(at < 0 ? items.length : at, 0, row);
    months[month] = { ...held, items };
    if (month !== "undated") counts.set(month, (counts.get(month) || 0) + 1);
  }
  const timeline = [...counts]
    .map(([month, count]) => ({ month, count }))
    .sort((a, b) => b.month.localeCompare(a.month));
  return {
    ...state,
    timeline,
    total: timeline.reduce((sum, row) => sum + row.count, 0),
    months,
  };
}
export function hubPhotoInfo({ api, linked, volume, item }) {
  if (!linked)
    return Promise.reject(new Error("Connect to the hub for capture details."));
  return api(
    `/v1/gallery/info?${new URLSearchParams({ volume, path: item.path, hash: item.hash })}`,
  );
}
// The phone keeps dates and hashes for ordering; photo bytes stay on the hub or in the working copy.
export function hubGallery({ api, store, scope, volume }) {
  const key = `gallery-months:${scope}:${volume}`;
  let state = null;
  let saved = "";
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const request = (params) =>
    api(`/v1/gallery?${new URLSearchParams({ volume, ...params })}`);
  const persist = async () => {
    let budget = CACHE_ITEMS;
    const months = {};
    for (const month of ["undated", ...state.timeline.map((row) => row.month)]) {
      const entry = state.months[month];
      if (!entry) continue;
      if (budget <= 0) break;
      if (entry.items.length <= budget) {
        months[month] = entry;
        budget -= entry.items.length;
      } else {
        const items = entry.items.slice(0, budget);
        const fresh = Math.min(entry.fresh, budget);
        months[month] = {
          items,
          fresh,
          complete: false,
          next: fresh ? cursorOf(items[fresh - 1]) : null,
        };
        budget = 0;
      }
    }
    const snapshot = { timeline: state.timeline, total: state.total, months };
    const text = JSON.stringify(snapshot);
    if (text === saved) return;
    saved = text;
    await store.set(key, snapshot).catch(() => {});
  };
  const finish = async (next, indexing) => {
    state =
      indexing === undefined || next.indexing === indexing
        ? next
        : { ...next, indexing };
    await persist();
    return state;
  };
  return {
    cached: () =>
      serial(async () => {
        if (!state) {
          const value = await store.get(key, null).catch(() => null);
          if (value?.months) {
            state = { ...empty(), ...value };
            saved = JSON.stringify(value);
          }
        }
        return state;
      }),
    refresh: () =>
      serial(async () => {
        const data = await request({});
        const next = withTimeline(state || empty(), data).state;
        return finish(absorb(next, data.items, data.next, null), !!data.indexing);
      }),
    load: (month) =>
      serial(async () => {
        if (month !== "undated" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
          throw new Error("Invalid gallery month");
        const current = state || empty();
        const entry = current.months[month];
        if (entry?.complete) return current;
        const after = entry?.fresh && entry.next ? entry.next : null;
        const params = after ? { after } : month === "undated" ? {} : { month };
        const data = await request(params);
        const { state: next, changed } = withTimeline(current, data);
        // A continuation cursor into a month that changed would skip its new top rows.
        if (after && changed.has(month)) return finish(next);
        return finish(
          absorb(
            next,
            data.items,
            data.next,
            after || (month === "undated" ? null : `${month}~`),
          ),
        );
      }),
    forget: (path) =>
      serial(async () => {
        if (!state) state = await store.get(key, null).catch(() => null);
        if (!state?.months) return state;
        const month = Object.keys(state.months).find((name) =>
          state.months[name].items.some((item) => item.path === path),
        );
        if (!month) return state;
        const entry = state.months[month];
        const index = entry.items.findIndex((item) => item.path === path);
        const timeline = state.timeline
          .map((row) =>
            row.month === month ? { ...row, count: row.count - 1 } : row,
          )
          .filter((row) => row.count > 0);
        return finish({
          ...state,
          timeline,
          total: Math.max(0, state.total - 1),
          months: {
            ...state.months,
            [month]: {
              ...entry,
              items: entry.items.filter((item) => item.path !== path),
              fresh: entry.fresh - (index < entry.fresh ? 1 : 0),
            },
          },
        });
      }),
  };
}
