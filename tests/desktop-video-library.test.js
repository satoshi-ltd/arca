import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVideoLibrary,
  fullyWatched,
  episodeAfter,
  episodeMeta,
  hasKids,
  nextEpisode,
  showSubtitle,
  sortVideos,
  timeLeftLabel,
  upNextDue,
  posterSubtitle,
  videoFacts,
  languageChips,
  videoFinished,
  videoClock,
  videoFormat,
  videoLength,
  videoProgressLabel,
  videoShelves,
  videoTabs,
} from "../apps/desktop/src/video-library.js";
import { sampleLibrary } from "./video-fixture.js";

test("labels read the way the boards draw them", () => {
  assert.equal(videoLength(8880), "2 h 28 min");
  assert.equal(videoLength(3480), "58 min");
  assert.equal(videoLength(0), "");
  assert.equal(timeLeftLabel(4320), "1 h 12 min left");
  assert.equal(timeLeftLabel(20), "1 min left");
  assert.equal(videoClock(3730), "1:02:10");
  assert.equal(videoClock(65), "1:05");
  const library = buildVideoLibrary(sampleLibrary());
  const inception = library.items.get("m:inception");
  const cancer = library.items.get("e:Breaking Bad/S1E4");
  assert.equal(videoProgressLabel(inception), "1 h 26 min left");
  assert.equal(videoProgressLabel(cancer), "S1 · E4 · 23 min left");
  assert.equal(episodeMeta(library.items.get("e:Breaking Bad/S1E1")), "S1 · E1 · 58 min");
  assert.equal(episodeMeta(cancer), "S1 · E4 · 23 min left");
  assert.equal(videoFormat(library.items.get("m:dune")), "HEVC video, E-AC3 audio");
  assert.equal(showSubtitle(library.items.get("s:breaking bad")), "3 of 7 watched");
  assert.equal(showSubtitle(library.items.get("s:bluey")), "1 season");
  assert.deepEqual(videoFacts(inception), [
    { text: "★ 8.4" },
    { text: "12", badge: true },
    { text: "2010" },
    { text: "2 h 28 min" },
    { text: "Action, Sci-Fi" },
    { text: "HD", badge: true },
    { text: "5.1", badge: true },
  ]);
  assert.deepEqual(videoFacts(library.items.get("m:dune")).map((fact) => fact.text), ["2024", "48 min", "4K"]);
  assert.deepEqual(videoFacts(library.items.get("s:bluey")).map((fact) => fact.text), ["TP", "2018", "1 season", "Animation, Kids", "HD"]);
  assert.deepEqual(languageChips(inception), { audio: ["EN", "ES"], subtitles: ["ES", "EN", "FR"], audioLabel: "Audio: English, Spanish", subtitleLabel: "Subtitles: Spanish, English, French" }, "picture subtitles can't be shown, so German is left out");
  const many = { kind: "movie", audioTracks: [{ language: "es", label: "Spanish" }, { language: "en", label: "English", default: true }], subtitles: ["en", "es", "fr", "de", "it"].map((language, index) => ({ embedded: true, stream: index, language, label: language })) };
  assert.deepEqual(languageChips(many).audio, ["EN", "ES"], "the default audio track comes first");
  assert.deepEqual(languageChips(many).subtitles, ["EN", "ES", "FR", "+2"]);
  assert.deepEqual(languageChips({ kind: "movie", audioTracks: [{ label: "Track 1" }], subtitles: [{ path: "a.srt", label: "Subtitles" }, { embedded: true, stream: 1, language: "en", label: "English (forced)", forced: true }] }), { audio: [], subtitles: ["?"], audioLabel: "Audio: ", subtitleLabel: "Subtitles: unknown language" }, "unnamed audio shows no chip; an unnamed sidecar still shows subtitles exist");
  assert.equal(posterSubtitle(inception), "2010", "the rating stays out of the caption");
  assert.equal(posterSubtitle(library.items.get("m:dune")), "2024");
});

test("a library keeps seasons in order with Specials last, finds the next episode and the one after", () => {
  const library = buildVideoLibrary(sampleLibrary());
  const show = library.items.get("s:breaking bad");
  assert.deepEqual(show.seasons.map((season) => season.name), ["Season 1", "Season 2", "Specials"]);
  assert.deepEqual(show.seasons[0].episodes.map((item) => item.episode), [1, 2, 3, 4, 5]);
  assert.equal(show.episodes[0].showTitle, "Breaking Bad");
  assert.equal(nextEpisode(show).title, "Cancer Man", "the episode in progress comes first");
  assert.equal(episodeAfter(show, nextEpisode(show)).title, "Gray Matter");
  assert.equal(episodeAfter(show, show.seasons[0].episodes[4]).title, "Seven Thirty-Seven", "the next season follows");
  assert.equal(episodeAfter(show, show.seasons[1].episodes[0]), null, "Specials never auto-play after a season");
  const fresh = library.items.get("s:bluey");
  assert.equal(nextEpisode(fresh).title, "Magic Xylophone");
  fresh.episodes[0].watched = true;
  assert.equal(nextEpisode(fresh).title, "Hospital");
  fresh.episodes[1].watched = true;
  assert.equal(nextEpisode(fresh), null);
  assert.equal(fresh.added, "2026-03-05T00:00:00.000Z", "a show without a date takes its newest episode");
});

test("shelves follow the hub's lists, sorting orders movies, sagas stack and Kids is a tab", () => {
  const library = buildVideoLibrary(sampleLibrary());
  const shelves = videoShelves(library);
  assert.deepEqual(
    shelves.map((shelf) => shelf.label),
    ["Watch next", "Recently added movies", "Recently added shows", "Kids picks"],
  );
  assert.deepEqual(shelves[0].items.map((item) => item.title), ["Cancer Man", "Inception", "Hospital", "The Two Towers", "Dune Part Two", "The Fellowship of the Ring"], "the row is the hub's Watch next, in its order");
  assert.deepEqual(shelves[0].entries.map((entry) => entry.reason), ["resume", "resume", "next", "related", "new", "waiting"]);
  assert.deepEqual(shelves[0].entries.map((entry) => [entry.caption, entry.tag, entry.progress]), [["S1 · E4 · 23 min left", null, 52], ["1 h 26 min left", null, 42], ["S1 · E2 · Hospital", "next", null], ["Because you watched Inception", null, null], ["Added this week", "new", null], ["In your library since January", null, null]], "captions, tags and progress are the hub's, drawn as sent");
  assert.equal(shelves[1].items[0].title, "Inception");
  assert.deepEqual(shelves[3].items.map((item) => item.title), ["The Iron Giant"], "Kids picks are movies; Bluey stays with the shows");
  assert.ok(shelves[2].items.some((item) => item.title === "Bluey"));
  const bare = buildVideoLibrary({ ...sampleLibrary(), watchNext: [{ id: "m:gone", reason: "new", title: "x", caption: "x" }, { id: "m:dune", reason: "other", title: "x", caption: "x" }, { id: "m:dune", reason: "new" }, { id: "m:dune", reason: "new", title: "Dune", caption: "Added this week" }] });
  assert.deepEqual(bare.watchNext.map((entry) => entry.item.id), ["m:dune"], "an unknown title or reason is dropped");
  assert.deepEqual(buildVideoLibrary({ ...sampleLibrary(), watchNext: undefined }).watchNext, []);
  assert.deepEqual(sortVideos(library.movies, "az").map((item) => item.title).slice(0, 3), ["Arrival", "Dune Part Two", "The Fellowship of the Ring"]);
  assert.deepEqual(sortVideos(library.movies, "year").map((item) => item.year), [2024, 2016, 2010, 2002, 2001, 1999]);
  assert.equal(sortVideos(library.movies, "added")[0].title, "Inception");
  assert.equal(sortVideos(library.movies, "rating")[0].title, "The Fellowship of the Ring");
  assert.equal(sortVideos(library.movies, "az").length, 6, "Movies never stacks a collection");
  assert.equal(shelves.some((shelf) => shelf.id === "collections"), false, "Home has no Collections shelf");
  assert.deepEqual(
    sortVideos([{ id: "1", title: "The Amazing Spider-Man" }, { id: "2", title: "Aquaman" }, { id: "3", title: "Barbie" }, { id: "4", title: "La La Land" }, { id: "5", title: "Them" }], "az").map((item) => item.title),
    ["The Amazing Spider-Man", "Aquaman", "Barbie", "La La Land", "Them"],
    "A–Z ignores a leading article but not a word that starts like one",
  );
  assert.deepEqual(videoTabs(library), ["home", "movies", "shows", "kids", "other"]);
  assert.ok(hasKids(library));
  assert.deepEqual(videoTabs(buildVideoLibrary({ other: sampleLibrary().other })), ["other"]);
});

test("a video counts as finished near its end and Up next starts in the last 30 seconds", () => {
  assert.equal(videoFinished(545, 600), true, "a 10 min clip finishes in its last minute");
  assert.equal(videoFinished(500, 600), false, "never more than 10 % early");
  assert.equal(videoFinished(8440, 8880), true, "5 % of a long movie");
  assert.equal(videoFinished(8430, 8880), false);
  assert.equal(videoFinished(2770, 2880), true, "at least two minutes for an episode");
  assert.equal(videoFinished(10, 0), false);
  assert.equal(upNextDue(2851, 2880), true);
  assert.equal(upNextDue(2840, 2880), false);
  assert.equal(upNextDue(10, 20), false, "a clip shorter than the window never offers Up next");
});


test("a show counts as watched once every episode is, like a watched movie", () => {
  const library = buildVideoLibrary(sampleLibrary());
  const show = library.items.get("s:breaking bad");
  assert.equal(fullyWatched(show), false);
  for (const episode of show.episodes) episode.watched = true;
  assert.equal(fullyWatched(show), true);
  assert.equal(fullyWatched({ kind: "show", episodes: [] }), false);
  assert.equal(fullyWatched(library.items.get("m:arrival")), true);
  assert.equal(fullyWatched(library.items.get("m:inception")), false);
});

test("a watched episode with a leftover position never wins Play: the next unwatched episode does, and a started later episode still outranks it", () => {
  const ep = (number, extra = {}) => ({ id: `e${number}`, season: 1, episode: number, ...extra });
  const left = (updated) => ({ position: 2800, duration: 2880, updated });
  const show = (episodes) => ({ episodes });
  assert.equal(nextEpisode(show([ep(1, { watched: true }), ep(2, { watched: true, position: left(90) }), ep(3)])).id, "e3");
  assert.equal(nextEpisode(show([ep(1, { watched: true }), ep(2, { watched: true, position: left(90) }), ep(3, { position: { position: 600, duration: 2880, updated: 10 } })])).id, "e3");
});
