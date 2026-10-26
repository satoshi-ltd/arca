import crypto from "node:crypto";

export const WATCH_NEXT_SIZE = 10;
export const MIN_PICKS = 2;
export const NEW_DAYS = 30;
export const SEEDS = 5;
const POOL = 8;
const DAY = 86400000;

const episodesOf = (show) => show.seasons.flatMap((season) => season.episodes);
const touched = (item) => item.watched || !!item.position;
const daily = (day, id) => crypto.createHash("sha256").update(`${day}\0${id}`).digest("hex");

export function lastActivity(title, watchedAt) {
  const files = title.kind === "show" ? episodesOf(title) : [title];
  let at = -1;
  for (const file of files) at = Math.max(at, watchedAt.get(file.path) ?? -1, Number(file.position?.updated) || -1);
  return at;
}

const MONTHS = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" });

function timeLeft(item) {
  const seconds = Math.max(0, Number(item.position?.duration) - Number(item.position?.position));
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`;
}

function present(entry, { items, byId, showOf, now }) {
  const item = items.get(entry.id) || byId.get(entry.id);
  const show = showOf.get(entry.id);
  const code = show ? `S${item.season} · E${item.episode}` : "";
  const base = { ...entry, title: show ? show.title : item.title, tag: entry.reason === "next" ? "next" : entry.reason === "new" ? "new" : null, progress: null };
  if (entry.reason === "resume") {
    const done = Number(item.position?.duration) > 0 ? Math.min(100, Math.round((100 * item.position.position) / item.position.duration)) : 0;
    return { ...base, caption: show ? `${code} · ${timeLeft(item)}` : timeLeft(item), art: item.still || show?.backdrop || item.backdrop || null, progress: done };
  }
  if (entry.reason === "next") return { ...base, caption: [code, item.title].filter(Boolean).join(" · "), art: item.still || show?.backdrop || null };
  const art = item.backdrop || item.poster || null;
  if (entry.reason === "related") return { ...base, caption: `Because you watched ${byId.get(entry.because)?.title || "something"}`, art };
  const added = new Date(item.added);
  if (entry.reason === "new") return { ...base, caption: now - added.getTime() < 7 * DAY ? "Added this week" : "Added this month", art };
  const sameYear = added.getUTCFullYear() === new Date(now).getUTCFullYear();
  return { ...base, caption: `In your library since ${MONTHS.format(added)}${sameYear ? "" : ` ${added.getUTCFullYear()}`}`, art };
}

export function watchNext({ movies, shows, continueIds, nextUp, watchedAt, hidden = new Map(), now = Date.now() }) {
  const items = new Map();
  const showOf = new Map();
  for (const movie of movies) items.set(movie.id, movie);
  for (const show of shows)
    for (const episode of episodesOf(show)) {
      items.set(episode.id, episode);
      showOf.set(episode.id, show);
    }
  const taken = new Set();
  const entries = [];
  const byTitle = new Map([...movies, ...shows].map((title) => [title.id, title]));
  const away = (id) => hidden.has(id) && lastActivity(byTitle.get(id), watchedAt) <= hidden.get(id);
  for (const id of continueIds) {
    const item = items.get(id);
    const owner = item?.show || id;
    if (away(owner)) continue;
    taken.add(owner);
    entries.push({ id, reason: "resume" });
  }
  for (const id of nextUp) {
    const show = items.get(id)?.show;
    if (taken.has(show) || away(show)) continue;
    taken.add(show);
    entries.push({ id, reason: "next" });
  }
  const titles = [...movies, ...shows];
  const fresh = (title) =>
    !title.kids && !away(title.id) && !taken.has(title.id) && (title.kind === "show" ? episodesOf(title).length > 0 && !episodesOf(title).some(touched) : !touched(title));
  const byId = new Map(titles.map((title) => [title.id, title]));
  const seeds = titles
    .map((title) => [title, lastActivity(title, watchedAt)])
    .filter(([, at]) => at >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEDS)
    .map(([title]) => title);
  const related = [];
  const seen = new Set();
  for (const seed of seeds)
    for (const id of seed.related || []) {
      const title = byId.get(id);
      if (!title || seen.has(id) || !fresh(title)) continue;
      seen.add(id);
      related.push({ id, reason: "related", because: seed.id });
    }
  const day = new Date(now).toISOString().slice(0, 10);
  const rotate = (list) => list.slice(0, POOL).sort((a, b) => daily(day, a.id).localeCompare(daily(day, b.id)));
  const addedAt = (title) => Date.parse(title.added || "") || 0;
  const candidates = titles.filter(fresh);
  const arrivals = rotate(candidates.filter((title) => now - addedAt(title) < NEW_DAYS * DAY).sort((a, b) => addedAt(b) - addedAt(a))).map((title) => ({ id: title.id, reason: "new" }));
  const waiting = rotate(
    candidates
      .filter((title) => now - addedAt(title) >= NEW_DAYS * DAY)
      .sort((a, b) => (Number(b.rating) || 0) - (Number(a.rating) || 0) || addedAt(a) - addedAt(b)),
  ).map((title) => ({ id: title.id, reason: "waiting" }));
  const sources = [related, arrivals, waiting];
  const wanted = Math.max(MIN_PICKS, WATCH_NEXT_SIZE - entries.length);
  const picked = new Set();
  const picks = [];
  for (let round = 0; picks.length < wanted && sources.some((source) => source.length > round); round++)
    for (const source of sources) {
      const pick = source[round];
      if (!pick || picked.has(pick.id) || picks.length >= wanted) continue;
      picked.add(pick.id);
      picks.push(pick);
    }
  return [...entries, ...picks].map((entry) => present(entry, { items, byId, showOf, now }));
}
