import test from "node:test";
import assert from "node:assert/strict";
import { MIN_PICKS, WATCH_NEXT_SIZE, watchNext } from "../packages/core/video-watch-next.js";

const NOW = Date.parse("2026-10-25T12:00:00.000Z");
const DAY = 86400000;
const added = (days) => new Date(NOW - days * DAY).toISOString();
const movie = (title, extra = {}) => ({ id: `m:${title}`, kind: "movie", path: `${title}.mkv`, title, rating: 7, added: added(200), watched: false, position: null, related: [], ...extra });
const show = (title, episodes, extra = {}) => ({
  id: `s:${title}`,
  kind: "show",
  title,
  rating: 8,
  added: added(200),
  related: [],
  seasons: [{ season: 1, episodes: episodes.map((episode, index) => ({ id: `e:${title}/${index + 1}`, kind: "episode", show: `s:${title}`, path: `${title}/${index + 1}.mkv`, watched: false, position: null, ...episode })) }],
  ...extra,
});

function library() {
  const solo = movie("Solo", { position: { position: 5000, duration: 7000, updated: NOW - DAY }, related: ["m:Force Awakens", "s:Andor"] });
  const batch = show("Bad Batch", [{ watched: true }, {}], { related: ["s:Andor", "s:Ahsoka", "m:Solo"] });
  const mando = show("Mandalorian", [{ watched: true }, {}]);
  const titles = {
    movies: [
      solo,
      movie("Force Awakens", { rating: 7.2 }),
      movie("Mad Max", { added: added(2), rating: 7.6 }),
      movie("Gattaca", { added: added(3), rating: 7.6 }),
      movie("Saving Private Ryan", { rating: 8.2 }),
      movie("Arrival", { rating: 9, watched: true }),
      movie("Totoro", { rating: 9.5, kids: true }),
    ],
    shows: [batch, mando, show("Andor", [{}, {}], { rating: 8.3 }), show("Ahsoka", [{}], { rating: 7.4 })],
  };
  const watchedAt = new Map([
    ["Bad Batch/1.mkv", NOW - 2 * DAY],
    ["Mandalorian/1.mkv", NOW - 3 * DAY],
    ["Arrival.mkv", NOW - 30 * DAY],
  ]);
  return { ...titles, continueIds: ["m:Solo"], nextUp: ["e:Bad Batch/2", "e:Mandalorian/2"], watchedAt, now: NOW };
}

test("Watch next lists what is in progress, then each show's next episode, then picks up to ten cards", () => {
  const row = watchNext(library());
  assert.deepEqual(row.slice(0, 3).map(({ id, reason }) => ({ id, reason })), [
    { id: "m:Solo", reason: "resume" },
    { id: "e:Bad Batch/2", reason: "next" },
    { id: "e:Mandalorian/2", reason: "next" },
  ]);
  const picks = row.slice(3);
  assert.deepEqual(picks.slice(0, 3).map((pick) => pick.reason), ["related", "new", "waiting"], "the sources take turns");
  assert.deepEqual([picks[0].id, picks[0].reason, picks[0].because], ["m:Force Awakens", "related", "m:Solo"], "the most recent activity seeds first");
  assert.ok(picks.some((pick) => pick.id === "s:Andor" && pick.because === "m:Solo"), "an untouched show can be picked");
  assert.ok(row.length <= WATCH_NEXT_SIZE);
  const ids = row.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, "never the same title twice");
  for (const id of ["m:Arrival", "m:Totoro", "s:Bad Batch", "s:Mandalorian"]) assert.ok(!ids.includes(id), `${id} is watched, a kids title or already in the row`);
  assert.ok(picks.filter((pick) => pick.reason === "new").every((pick) => ["m:Mad Max", "m:Gattaca"].includes(pick.id)), "New is only what arrived in the last 30 days");
  assert.ok(picks.some((pick) => pick.id === "m:Saving Private Ryan" && pick.reason === "waiting"));
});

test("a show already in progress keeps one card, and a long row still ends with two picks", () => {
  const value = library();
  value.continueIds = ["e:Bad Batch/2", ...Array.from({ length: 12 }, (_, index) => `m:extra${index}`)];
  value.movies.push(...Array.from({ length: 12 }, (_, index) => movie(`extra${index}`, { position: { position: 100, duration: 7000, updated: NOW - index } })));
  const row = watchNext(value);
  assert.equal(row.filter((entry) => entry.id.startsWith("e:Bad Batch")).length, 1, "the next episode of a show in progress is left out");
  assert.equal(row.filter((entry) => !["resume", "next"].includes(entry.reason)).length, MIN_PICKS);
  assert.equal(row.at(-1).reason === "resume" || row.at(-1).reason === "next", false);
});

test("picks change once a day, never on a refresh the same day", () => {
  const value = library();
  value.movies.push(...Array.from({ length: 10 }, (_, index) => movie(`waiting${index}`, { rating: 6 })));
  const today = watchNext(value).map((entry) => entry.id);
  assert.deepEqual(watchNext({ ...value, now: NOW + 3600000 }).map((entry) => entry.id), today);
  const week = Array.from({ length: 7 }, (_, index) => watchNext({ ...value, now: NOW + (index + 1) * DAY }).map((entry) => entry.id).join());
  assert.ok(week.some((ids) => ids !== today.join()), "another day may show other picks");
});

test("with nothing watched yet the row is new arrivals and the best-rated titles that waited longest", () => {
  const row = watchNext({ movies: [movie("Old", { rating: 8 }), movie("Fresh", { added: added(1) })], shows: [], continueIds: [], nextUp: [], watchedAt: new Map(), now: NOW });
  assert.deepEqual(row.map(({ id, reason }) => ({ id, reason })), [
    { id: "m:Fresh", reason: "new" },
    { id: "m:Old", reason: "waiting" },
  ]);
});

test("every entry arrives ready to draw: title, caption, tag, art key and progress come from the hub", () => {
  const value = library();
  value.movies[0].backdrop = "bk-solo";
  value.shows[0].seasons[0].episodes[1] = { ...value.shows[0].seasons[0].episodes[1], season: 1, episode: 2, title: "Rescue on Ryloth", still: "still-2" };
  value.shows[0].backdrop = "bk-batch";
  const row = watchNext(value);
  const [solo, batch] = row;
  assert.deepEqual([solo.title, solo.caption, solo.tag, solo.art, solo.progress], ["Solo", "33 min left", null, "bk-solo", 71]);
  assert.deepEqual([batch.title, batch.caption, batch.tag, batch.art, batch.progress], ["Bad Batch", "S1 · E2 · Rescue on Ryloth", "next", "still-2", null]);
  const pick = (id) => row.find((entry) => entry.id === id);
  assert.equal(pick("m:Force Awakens").caption, "Because you watched Solo");
  assert.deepEqual([pick("m:Mad Max").caption, pick("m:Mad Max").tag], ["Added this week", "new"]);
  assert.equal(pick("m:Saving Private Ryan").caption, "In your library since April");
  assert.equal(watchNext({ movies: [movie("Ten", { added: added(10) })], shows: [], continueIds: [], nextUp: [], watchedAt: new Map(), now: NOW })[0].caption, "Added this month");
  assert.equal(watchNext({ movies: [movie("Last year", { added: "2025-02-03T00:00:00.000Z" })], shows: [], continueIds: [], nextUp: [], watchedAt: new Map(), now: NOW })[0].caption, "In your library since February 2025", "another year names the year");
  assert.equal(watchNext({ movies: [movie("Long", { position: { position: 0, duration: 4320, updated: NOW } })], shows: [], continueIds: ["m:Long"], nextUp: [], watchedAt: new Map(), now: NOW })[0].caption, "1 h 12 min left");
});

