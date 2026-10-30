import test from "node:test";
import assert from "node:assert/strict";
import { searchFold } from "../packages/core/search.js";
import { sampleLibrary } from "./video-fixture.js";
import {
  episodeCaption,
  followingEpisode,
  librarySummary,
  languageChips,
  nextEpisode,
  normalizeLibrary,
  playLabel,
  playTarget,
  playerTitles,
  posterGrid,
  relatedShelf,
  resumeLine,
  searchVideos,
  cardLabel,
  seasonLabel,
  titleFacts,
  titleFile,
  titleActions,
  videoBackLabel,
  videoSearchRoute,
  videoSheet,
  videoShelves,
  GRID_FIRST_ROWS,
  gridColumns,
  gridRows,
  gridWindow,
  videoTabs,
  watchedLine,
  watchedTargets,
  libraryRoute,
  artRoute,
  mediaRoute,
  positionBody,
  sortTitles,
  shelfTarget,
} from "../apps/mobile/src/video-library.js";

const art = (n) => String(n).repeat(64).slice(0, 64);
const file = (path, extra = {}) => ({ path, hash: `h-${path}`, size: 4.2 * 1024 ** 3, duration: 8880, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", container: "mkv", subtitles: [], position: null, watched: false, added: 1, ...extra });
const episode = (season, number, extra = {}) => ({ id: `e:Breaking Bad/S${season}E${number}.mkv`, kind: "episode", season, episode: number, title: `Episode ${number}`, overview: "", still: null, ...file(`Breaking Bad/S${season}E${number}.mkv`, { duration: 2880 }), ...extra });

function sample(overrides = {}) {
  return {
    version: "7",
    indexing: false,
    movies: [
      { id: "m:inception|2010", kind: "movie", title: "Inception", year: 2010, overview: "Dreams.", genres: ["Action", "Sci-Fi"], runtime: 148, certification: "12", rating: 8.36, cast: ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page", "Tom Hardy", "Ken Watanabe", "Dileep Rao"], collection: null, kids: false, poster: art("a"), backdrop: art("b"), tmdb: 27205, matched: true, ...file("Movies/Inception (2010).mkv", { subtitles: [{ path: "Movies/Inception (2010).es.srt", language: "es", label: "Spanish" }, { path: "Movies/Inception (2010).en.srt", language: "en", label: "English" }], position: { position: 3730, duration: 8880, updated: 50, device: "tv" }, added: 5 }) },
      { id: "m:coco|2017", kind: "movie", title: "Coco", year: 2017, overview: "", genres: ["Animation", "Family"], runtime: 105, certification: "7", rating: 8.2, cast: [], kids: true, poster: null, backdrop: null, tmdb: 354912, matched: true, ...file("Movies/Coco (2017).mp4", { added: 9, watched: true }) },
      { id: "m:the heat", kind: "movie", title: "The Heat", year: 1995, genres: ["Action"], rating: 0, ...file("Movies/Heat.mkv", { added: 2 }) },
      { id: "bad", kind: "movie", title: "No path" },
    ],
    shows: [
      {
        id: "s:breaking bad",
        kind: "show",
        title: "Breaking Bad",
        year: 2008,
        genres: ["Drama"],
        certification: "16",
        rating: 9.5,
        cast: [],
        kids: false,
        poster: art("c"),
        backdrop: art("d"),
        seasons: [
          { season: 0, name: "", episodes: [episode(0, 1)] },
          { season: 2, name: "", episodes: [episode(2, 1)] },
          { season: 1, name: "", episodes: [episode(1, 2, { watched: true }), episode(1, 1, { watched: true }), episode(1, 3, { position: { position: 1500, duration: 2880, updated: 90 } })] },
        ],
      },
      { id: "s:bluey", kind: "show", title: "Bluey", year: 2018, genres: ["Animation"], kids: false, seasons: [{ season: 1, episodes: [{ ...episode(1, 1), id: "e:Bluey/S1E1.mkv", path: "Bluey/S1E1.mkv" }] }] },
      { id: "s:empty", kind: "show", title: "Empty", seasons: [] },
    ],
    other: [{ id: "o:Home/IMG_1.mov", kind: "other", title: "IMG_1", ...file("Home/IMG_1.mov") }],
    watchNext: [
      { id: "m:inception|2010", reason: "resume", title: "Inception", caption: "1 h 26 min left", tag: null, art: art("b"), progress: 42 },
      { id: "e:Breaking Bad/S1E3.mkv", reason: "resume", title: "Breaking Bad", caption: "S1 · E3 · 23 min left", tag: null, art: art("d"), progress: 52 },
      { id: "gone", reason: "resume", title: "Gone", caption: "x", tag: null, art: null, progress: null },
      { id: "s:bluey", reason: "related", because: "m:inception|2010", title: "Bluey", caption: "Because you watched Inception", tag: null, art: null, progress: null },
      { id: "m:the heat", reason: "new", title: "The Heat", caption: "Added this week", tag: "new", art: null, progress: null },
      { id: "m:coco|2017", reason: "waiting", title: "Coco", caption: "In your library since January", tag: null, art: null, progress: null },
      { id: "m:coco|2017", reason: "other", title: "Coco", caption: "x", tag: null, art: null, progress: null },
      { id: "m:coco|2017", reason: "waiting", title: "No caption" },
    ],
    kids: true,
    ...overrides,
  };
}

test("a hub library normalizes into movies, ordered seasons with Specials last, and drops unplayable entries", () => {
  const library = normalizeLibrary(sample());
  assert.deepEqual(library.movies.map((m) => m.id), ["m:inception|2010", "m:coco|2017", "m:the heat"]);
  assert.deepEqual(library.shows.map((s) => s.id), ["s:breaking bad", "s:bluey"], "a show without episodes is not listed");
  const show = library.items.get("s:breaking bad");
  assert.deepEqual(show.seasons.map((s) => s.season), [1, 2, 0]);
  assert.deepEqual(show.seasons[0].episodes.map((e) => e.episode), [1, 2, 3]);
  assert.equal(seasonLabel(show.seasons[2]), "Specials");
  assert.equal(seasonLabel(show.seasons[0]), "Season 1");
  assert.deepEqual(library.watchNext.map((entry) => entry.id), ["m:inception|2010", "e:Breaking Bad/S1E3.mkv", "s:bluey", "m:the heat", "m:coco|2017"], "ids the library no longer has, entries without a caption and unknown reasons, are ignored");
  assert.equal(library.items.get("m:inception|2010").cast.length, 5, "the first five cast names");
  assert.equal(normalizeLibrary(null), null);
  assert.deepEqual(normalizeLibrary({}).movies, []);
});

test("tabs follow the content: Home, Movies, TV Shows, Kids only with a kids title, Others only with one", () => {
  const library = normalizeLibrary(sample());
  assert.deepEqual(videoTabs(library), ["home", "movies", "shows", "kids", "other"]);
  const plain = normalizeLibrary(sample({ other: [], movies: sample().movies.map((m) => ({ ...m, kids: false })), shows: [sample().shows[0]] }));
  assert.deepEqual(videoTabs(plain), ["home", "movies", "shows"]);
  assert.deepEqual(videoTabs(normalizeLibrary({ version: "1", movies: [], shows: [], other: sample().other })), ["other"], "home videos alone show one tab, so no tab bar");
  assert.equal(videoBackLabel([{ kind: "shows" }, { kind: "title" }]), "TV Shows");
});

test("Home shelves resume where any device stopped, list next episodes, recently added posters and kids picks", () => {
  const library = normalizeLibrary(sample());
  const shelves = videoShelves(library);
  assert.deepEqual(shelves.map((s) => s.key), ["watch-next", "recent", "kids"]);
  assert.equal(shelves[0].title, "Watch next");
  const [movie, show] = shelves[0].cards;
  assert.equal(movie.title, "Inception");
  assert.equal(movie.caption, "1 h 26 min left");
  assert.equal(movie.art, art("b"));
  assert.ok(movie.progress > 0.4 && movie.progress < 0.43);
  assert.equal(show.title, "Breaking Bad");
  assert.equal(show.caption, "S1 · E3 · 23 min left");
  assert.equal(show.art, art("d"), "an episode without a still falls back to the show backdrop");
  assert.deepEqual(shelves[0].cards.map((card) => card.title), ["Inception", "Breaking Bad", "Bluey", "The Heat", "Coco"], "the row is the hub's list as sent: an unknown title or reason is dropped");
  const [, , related, fresh, waiting] = shelves[0].cards;
  assert.deepEqual([related.caption, fresh.caption, waiting.caption], ["Because you watched Inception", "Added this week", "In your library since January"], "captions are the hub's, drawn as sent");
  assert.deepEqual([related.next, fresh.fresh, movie.fresh, movie.next], [false, true, false, false]);
  assert.match(cardLabel(fresh), /, new$/);
  const next = videoShelves(normalizeLibrary(sample({ watchNext: [{ id: "e:Breaking Bad/S2E1.mkv", reason: "next", title: "Breaking Bad", caption: "S2 · E1 · Episode 1", tag: "next", art: null, progress: null }] })))[0].cards[0];
  assert.equal(next.caption, "S2 · E1 · Episode 1");
  assert.equal(next.next, true);
  assert.match(cardLabel(next), /, next$/, "its spoken label says it is next");
  assert.deepEqual(shelves[1].cards.map((c) => c.title), ["Inception", "The Heat", "Bluey", "Breaking Bad"], "newest first, kids films only in Kids picks; shows always stay");
  assert.deepEqual(shelves[2].cards.map((c) => c.title), ["Coco"]);
  assert.equal(shelves[2].cards[0].watched, true);
  assert.equal(shelves[2].cards[0].icon, "smile");
  const idle = normalizeLibrary(sample({ watchNext: [] }));
  assert.deepEqual(videoShelves(idle).map((s) => s.key), ["recent", "kids"], "with an empty Watch next the first shelf is absent");
});

const facts = (list) => list.map((fact) => `${fact.kind}:${fact.text}`);

test("title facts read like desktop: rating, certification badge, year, length or seasons, genres, then HD/4K and 5.1/7.1 badges", () => {
  const library = normalizeLibrary(sample());
  const movie = library.items.get("m:inception|2010");
  assert.deepEqual(facts(titleFacts(movie)), ["rating:★ 8.4", "badge:12", "text:2010", "text:2 h 28 min", "text:Action, Sci-Fi", "badge:HD"]);
  const surround = normalizeLibrary(sample({ movies: [{ ...sample().movies[0], width: 3840, height: 2160, audioTracks: [{ stream: 0, language: "en", channels: 2 }, { stream: 1, language: "es", channels: 8, default: true }] }] })).movies[0];
  assert.deepEqual(facts(titleFacts(surround)).slice(-2), ["badge:4K", "badge:7.1"]);
  const six = normalizeLibrary(sample({ movies: [{ ...sample().movies[0], audioTracks: [{ stream: 0, channels: 6 }] }] })).movies[0];
  assert.equal(facts(titleFacts(six)).at(-1), "badge:5.1");
  assert.deepEqual(facts(titleFacts(library.items.get("m:the heat"))), ["text:1995", "text:2 h 28 min", "text:Action", "badge:HD"], "no rating, no star");
  const show = library.items.get("s:breaking bad");
  assert.deepEqual(facts(titleFacts(show, library)), ["rating:★ 9.5", "badge:16", "text:2008", "text:2 seasons", "text:Drama", "badge:HD"]);
  assert.equal(resumeLine(movie), "From 1:02:10 · 1 h 26 min left");
  assert.equal(watchedLine(show), "2 of 5 watched");
  assert.equal(episodeCaption(show.seasons[0].episodes[0]), "S1 · E1 · 48 min");
  assert.equal(librarySummary(library), "3 movies · 2 shows · 1 other video");
});

test("a show plays the episode in progress, then the one after the last watched, and Up next follows the season order", () => {
  const library = normalizeLibrary(sample());
  const show = library.items.get("s:breaking bad");
  assert.equal(nextEpisode(show).id, "e:Breaking Bad/S1E3.mkv");
  assert.equal(playLabel(library, show), "Continue S1 · E3");
  assert.equal(playLabel(normalizeLibrary(sample({ shows: [{ ...sample().shows[0], seasons: [{ season: 1, episodes: [episode(1, 1, { watched: true }), episode(1, 2)] }] }] })), normalizeLibrary(sample({ shows: [{ ...sample().shows[0], seasons: [{ season: 1, episodes: [episode(1, 1, { watched: true }), episode(1, 2)] }] }] })).items.get("s:breaking bad")), "Play S1 · E2", "nothing in progress reads Play");
  assert.equal(playLabel(library, library.items.get("m:coco|2017")), "Play");
  assert.equal(playLabel(library, library.items.get("m:inception|2010")), "Resume");
  const fresh = normalizeLibrary(sample({ shows: [{ ...sample().shows[0], seasons: [{ season: 1, episodes: [episode(1, 1, { watched: true }), episode(1, 2)] }] }] }));
  assert.equal(playTarget(fresh, fresh.items.get("s:breaking bad")).episode, 2);
  assert.equal(followingEpisode(library, library.items.get("e:Breaking Bad/S1E3.mkv")).id, "e:Breaking Bad/S2E1.mkv", "the last episode of a season leads to the next season");
  assert.equal(followingEpisode(library, library.items.get("e:Breaking Bad/S2E1.mkv")), null, "Specials are never Up next after the last season");
  assert.equal(followingEpisode(library, library.items.get("m:coco|2017")), null);
  assert.deepEqual(playerTitles(library, library.items.get("e:Breaking Bad/S1E3.mkv")), { title: "Episode 3", subtitle: "Breaking Bad · S1 · E3" });
});

test("grids sort A–Z without articles, by recently added, year or rating, with no genre filter", () => {
  const library = normalizeLibrary(sample());
  assert.deepEqual(posterGrid(library, "movies").map((c) => c.title), ["The Heat", "Inception"], "Coco is a kids film, so it lives in Kids");
  assert.deepEqual(posterGrid(library, "movies", { sort: "added" }).map((c) => c.title), ["Inception", "The Heat"]);
  assert.deepEqual(posterGrid(library, "movies", { sort: "year" }).map((c) => c.title), ["Inception", "The Heat"]);
  assert.deepEqual(posterGrid(library, "movies", { sort: "rating" }).map((c) => c.title), ["Inception", "The Heat"]);
  assert.deepEqual(posterGrid(library, "movies", { genre: "Action" }).map((c) => c.title), ["The Heat", "Inception"], "a genre option is ignored");
  assert.deepEqual(posterGrid(library, "kids").map((c) => c.title), ["Coco"]);
  assert.deepEqual(posterGrid(library, "shows").map((c) => [c.caption, c.rating]), [["2018", ""], ["2008", "★ 9.5"]], "posters show the year and a rating badge only with a rating");
  assert.deepEqual(posterGrid(library, "movies").map((c) => c.rating), ["", "★ 8.4"]);
  assert.equal(videoShelves(library)[0].cards[0].rating, undefined, "16:9 stills never carry the rating");
});

test("the phone menu only marks watched: it streams, so it never deletes a title", () => {
  const library = normalizeLibrary(sample());
  const movie = library.items.get("m:inception|2010");
  assert.deepEqual(titleActions(movie), ["watched"], "kids overrides and deletes belong to the hub");
  assert.deepEqual(titleActions(library.items.get("m:coco|2017")), ["unwatched"]);
  assert.deepEqual(titleActions(library.items.get("s:bluey")), ["watched"]);
  assert.equal(watchedTargets(library.items.get("s:breaking bad")).length, 5);
  assert.deepEqual(videoSheet({ kind: "video-actions", item: movie, folder: "videos" }), { title: "Inception", icon: "clapperboard", subtitle: "2010 · Movies · videos", menu: true });
  assert.equal(videoSheet({ kind: "track-actions" }), null);
  const [first] = videoShelves(library)[0].cards;
  assert.equal(first.removable, true, "a Watch next card can be removed");
  assert.equal(videoShelves(library)[1].cards.some((card) => card.removable), false, "other shelves have nothing to remove");
  assert.deepEqual(videoSheet({ kind: "video-watch", card: first }), { title: first.title, icon: first.icon, subtitle: `Watch next · ${first.caption}`, menu: true });
});

test("Search Arca finds movies, shows and episodes and lands on their pages", () => {
  const library = normalizeLibrary(sample());
  const rows = searchVideos(library, ["break"], searchFold);
  assert.deepEqual(rows.map((r) => r.kind), ["show"]);
  assert.equal(videoSearchRoute(rows[0])[0].kind, "shows");
  assert.deepEqual(searchVideos(library, ["coco"], searchFold).map((r) => r.kids), [true]);
  const kids = searchVideos(library, ["coco"], searchFold)[0];
  assert.deepEqual(videoSearchRoute(kids), [{ kind: "kids" }, { kind: "title", id: kids.id }], "a kids title opens under Kids, the only tab that lists it");
  const episodes = searchVideos(library, ["episode", "3"], searchFold);
  assert.equal(episodes[0].kind, "episode");
  assert.equal(episodes[0].code, "S1 · E3");
  assert.deepEqual(videoSearchRoute(episodes[0]), [{ kind: "shows" }, { kind: "title", id: "s:breaking bad", episode: "e:Breaking Bad/S1E3.mkv" }]);
  assert.deepEqual(videoSearchRoute(searchVideos(library, ["incep"], searchFold)[0]), [{ kind: "movies" }, { kind: "title", id: "m:inception|2010" }]);
  assert.deepEqual(searchVideos(library, [], searchFold), []);
});

test("routes to the hub encode the folder, file and hash, and positions are whole seconds", () => {
  assert.equal(libraryRoute("v1"), "/v1/video/library?volume=v1");
  assert.equal(libraryRoute("v1", "9"), "/v1/video/library?volume=v1&version=9");
  assert.equal(artRoute("v1", art("a"), "large"), `/v1/video/art?volume=v1&key=${art("a")}&size=large`);
  assert.equal(mediaRoute("v1", { path: "Movies/A & B (2010).mkv", hash: "abc" }), "/v1/video/media?volume=v1&path=Movies%2FA+%26+B+%282010%29.mkv&hash=abc");
  assert.deepEqual(positionBody("v1", { path: "a.mkv", hash: "h", duration: 100 }, 12.6, 0), { volume: "v1", path: "a.mkv", hash: "h", position: 13, duration: 100 });
});

test("the shared contract fixture reads with ISO dates: Recently added and the added sort follow the hub's timestamps", () => {
  const library = normalizeLibrary(sampleLibrary());
  assert.equal(library.items.get("m:inception").added, Date.parse("2026-03-01T00:00:00.000Z"));
  assert.equal(library.items.get("s:bluey").added, Date.parse("2026-03-05T00:00:00.000Z"), "a show is as new as its newest episode");
  const recent = videoShelves(library).find((shelf) => shelf.key === "recent");
  assert.deepEqual(recent.cards.slice(0, 4).map((c) => c.title), ["Bluey", "Inception", "Breaking Bad", "Arrival"], "a kids show is a show, so it is recently added with the rest");
  assert.deepEqual(videoShelves(library)[0].cards.map((c) => c.title), ["Breaking Bad", "Inception", "Bluey", "The Two Towers", "Dune Part Two", "The Fellowship of the Ring"], "Watch next draws the shared fixture's row in the hub's order");
  assert.deepEqual(posterGrid(library, "movies", { sort: "added" }).map((c) => c.title).slice(0, 3), ["Inception", "Arrival", "Dune Part Two"]);
  assert.deepEqual(videoTabs(library), ["home", "movies", "shows", "kids", "other"]);
  const show = library.items.get("s:breaking bad");
  assert.equal(nextEpisode(show).title, "Cancer Man");
  assert.equal(followingEpisode(library, nextEpisode(show)).title, "Gray Matter");
  assert.equal(facts(titleFacts(library.items.get("m:inception")))[0], "rating:★ 8.4");
  assert.equal(facts(titleFacts(library.items.get("m:dune"))).at(-1), "badge:4K");
  assert.equal(normalizeLibrary({ version: "1", movies: [{ ...sampleLibrary().movies[0], added: "not a date" }] }).movies[0].added, 0);
});

test("language chips list audio codes, default first, and readable subtitle codes, three then +N, with spoken names", () => {
  const item = (audioTracks, subtitles) => normalizeLibrary(sample({ movies: [{ ...sample().movies[0], audioTracks, subtitles }] })).movies[0];
  const chips = languageChips(item(
    [{ stream: 0, language: "spa", label: "Spanish" }, { stream: 1, language: "en", label: "English · 5.1", default: true }],
    ["en", "es", "fr", "de", "it"].map((language, index) => ({ embedded: true, stream: index, language, label: language === "es" ? "Spanish · Latin American" : language })),
  ));
  assert.deepEqual(chips.audio, ["EN", "ES"]);
  assert.equal(chips.audioLabel, "Audio: English, Spanish");
  assert.deepEqual(chips.subtitles, ["EN", "ES", "FR", "+2"]);
  assert.equal(chips.subtitleLabel, "Subtitles: en, Spanish, fr, de, it");
  const bare = languageChips(item([{ stream: 0, label: "Track 1" }], [{ path: "a.srt", label: "Subtitles" }, { embedded: true, stream: 2, language: "en", label: "English (forced)", forced: true }, { embedded: true, stream: 3, language: "de", label: "German", image: true }]));
  assert.deepEqual([bare.audio, bare.subtitles, bare.subtitleLabel], [[], ["?"], "Subtitles: unknown language"], "unnamed audio has no chip; forced and picture tracks don't count");
  assert.deepEqual(languageChips(item([], [])).subtitles, []);
});

test("embedded subtitles and audio tracks survive normalisation", () => {
  const movie = normalizeLibrary(sample({ movies: [{ ...sample().movies[0], subtitles: [{ path: "a.es.srt", label: "Spanish" }, { embedded: true, stream: 2, language: "en", label: "English", forced: true }, { embedded: true, label: "no stream" }], audioTracks: [{ stream: 0, codec: "ac3", language: "en", label: "English", channels: 6, default: true }] }] })).movies[0];
  assert.deepEqual(movie.subtitles.map((sub) => sub.embedded ? `embedded:${sub.stream}` : sub.path), ["a.es.srt", "embedded:2"]);
  assert.deepEqual(movie.audioTracks, [{ stream: 0, codec: "ac3", language: "en", label: "English", channels: 6, default: true }]);
});

test("a show's languages line and quality badges come from the episode Play would start, else the first episode", () => {
  const raw = sampleLibrary();
  const bb = raw.shows[0];
  const s1 = bb.seasons.find((season) => season.season === 1);
  s1.episodes = s1.episodes.map((ep) =>
    ep.episode === 4
      ? { ...ep, width: 3840, height: 2160, audioTracks: [{ stream: 0, language: "eng", channels: 6, default: true }], audioLanguages: ["English", "Spanish"], subtitleLanguages: ["Spanish", "English"] }
      : { ...ep, audioLanguages: ["English"], subtitleLanguages: [] },
  );
  const library = normalizeLibrary(raw);
  const show = library.items.get("s:breaking bad");
  assert.equal(show.audioLanguages.length, 0, "the hub sends languages per file, not per show");
  assert.equal(titleFile(library, show).title, "Cancer Man");
  assert.deepEqual(languageChips(titleFile(library, show)).audio, ["EN"]);
  assert.deepEqual(facts(titleFacts(show, library)).slice(-2), ["badge:4K", "badge:5.1"]);
  const first = titleFile(null, show);
  assert.equal(first.season, 1);
  assert.equal(first.episode, 1);
  assert.equal(titleFile(library, library.items.get("m:inception")).title, "Inception");
});

test("Others follows the chosen sort, and rating falls back to A–Z there", () => {
  const library = normalizeLibrary(sample({ other: [
    { id: "o:b", kind: "other", title: "Beach", path: "Home/Beach.mp4", added: "2026-01-02T00:00:00.000Z" },
    { id: "o:a", kind: "other", title: "Attic", path: "Home/Attic.mp4", added: "2026-03-02T00:00:00.000Z" },
  ] }));
  assert.deepEqual(posterGrid(library, "other").map((c) => c.title), ["Attic", "Beach"]);
  assert.deepEqual(posterGrid(library, "other", { sort: "added" }).map((c) => c.title), ["Attic", "Beach"]);
  assert.deepEqual(posterGrid(library, "other", { sort: "title" }).map((c) => c.title), ["Attic", "Beach"]);
  assert.deepEqual(posterGrid(library, "other", { sort: "rating" }).map((c) => c.title), ["Attic", "Beach"]);
  const reversed = normalizeLibrary(sample({ other: [
    { id: "o:b", kind: "other", title: "Beach", path: "Home/Beach.mp4", added: "2026-04-02T00:00:00.000Z" },
    { id: "o:a", kind: "other", title: "Attic", path: "Home/Attic.mp4", added: "2026-03-02T00:00:00.000Z" },
  ] }));
  assert.deepEqual(posterGrid(reversed, "other", { sort: "added" }).map((c) => c.title), ["Beach", "Attic"]);
  const watched = normalizeLibrary(sample({ other: [{ id: "o:w", kind: "other", title: "Watched", path: "Home/W.mp4", watched: true, position: { position: 30, duration: 300 } }] }));
  const [card] = posterGrid(watched, "other");
  assert.equal(card.watched, true, "home videos carry their own watched mark instead of crashing the grid");
  assert.equal(card.progress, 0.1);
});

test("A–Z on the phone ignores the same leading articles as desktop", () => {
  const titles = sortTitles([{ title: "The Amazing Spider-Man" }, { title: "Barbie" }, { title: "La La Land" }, { title: "El Hoyo" }, { title: "Them" }], "title").map((item) => item.title);
  assert.deepEqual(titles, ["The Amazing Spider-Man", "Barbie", "El Hoyo", "La La Land", "Them"]);
});

test("every Home shelf card opens something that exists: an episode opens its show at that episode, an Other video plays", () => {
  const library = normalizeLibrary(sample());
  for (const shelf of videoShelves(library))
    for (const { item } of shelf.cards) {
      const target = shelfTarget(item);
      if (target.play) {
        assert.equal(item.kind, "other");
        continue;
      }
      const opened = library.items.get(target.route.id);
      assert.ok(opened && opened.kind !== "episode", `${shelf.key} opens a title page, never an episode as a title`);
      assert.doesNotThrow(() => titleFacts(opened), `${shelf.key}: ${item.title}`);
      if (item.kind === "episode") assert.equal(target.route.episode, item.id);
    }
  assert.deepEqual(shelfTarget({ kind: "other", id: "o:1" }), { play: true });
});

test("a card's spoken label says whether it was watched or how far along it is", () => {
  assert.equal(cardLabel({ title: "Inception", caption: "2010", watched: true, progress: null }), "Inception, 2010, watched");
  assert.equal(cardLabel({ title: "Inception", caption: "2010", watched: false, progress: 0.42 }), "Inception, 2010, 42% watched");
  assert.equal(cardLabel({ title: "Inception", caption: "", watched: false, progress: null }), "Inception");
});

test("Related renders the hub's ids in order as posters, skips missing ones and hides when empty", () => {
  const raw = sampleLibrary();
  raw.movies.find((m) => m.title === "The Fellowship of the Ring").related = ["m:missing", "m:the two towers", "s:breaking bad"];
  const library = normalizeLibrary(raw);
  const shelf = relatedShelf(library, library.items.get("m:the fellowship of the ring"));
  assert.equal(shelf.title, "Related");
  assert.equal(shelf.wide, false);
  assert.deepEqual(shelf.cards.map((c) => c.title), ["The Two Towers", "Breaking Bad"]);
  assert.equal(shelf.cards[0].caption, "2002");
  assert.equal(relatedShelf(library, library.items.get("m:the iron giant")), null);
  assert.equal(relatedShelf(library, library.items.get("m:arrival")), null);
  assert.equal(normalizeLibrary({ version: "1", movies: [{ ...raw.movies[0], related: Array.from({ length: 30 }, (_, i) => `m:${i}`) }] }).movies[0].related.length, 12);
});

test("the grid mounts only the rows near the viewport, and every card stays in some row", () => {
  assert.deepEqual([gridColumns(false), gridColumns(true)], [3, 5]);
  const cards = Array.from({ length: 500 }, (_, index) => ({ key: `c${index}` }));
  const rows = gridRows(cards, 3);
  assert.equal(rows.length, 167);
  assert.deepEqual(rows.flat().map((card) => card.key), cards.map((card) => card.key));
  assert.equal(rows.at(-1).length, 2, "the last row keeps its leftover cards");
  assert.deepEqual(gridWindow({ scroll: 0, top: 100, viewport: 800, pitch: 0, rows: 167 }), { first: 0, last: GRID_FIRST_ROWS - 1 }, "before a row is measured the first rows are mounted");
  assert.deepEqual(gridWindow({ scroll: 0, top: 100, viewport: 800, pitch: 200, rows: 167 }), { first: 0, last: 7 });
  const middle = gridWindow({ scroll: 10100, top: 100, viewport: 800, pitch: 200, rows: 167 });
  assert.deepEqual(middle, { first: 47, last: 57 });
  assert.ok(middle.last - middle.first < 15, "a 500-title library mounts a dozen rows, not all of them");
  assert.deepEqual(gridWindow({ scroll: 90000, top: 100, viewport: 800, pitch: 200, rows: 167 }), { first: 166, last: 166 }, "a fast scroll past the end clamps to the last row");
  assert.deepEqual(gridWindow({ scroll: 0, top: 100, viewport: 800, pitch: 200, rows: 0 }), { first: 0, last: -1 });
});


test("a watched episode with a leftover position never wins Play: the next unwatched episode does, and a started later episode still outranks it", () => {
  const build = (episodes) => {
    const library = normalizeLibrary(sample({ shows: [{ ...sample().shows[0], seasons: [{ season: 1, episodes }] }] }));
    return library.items.get("s:breaking bad");
  };
  const left = (updated) => ({ position: 2800, duration: 2880, updated, device: "other" });
  assert.equal(nextEpisode(build([episode(1, 1, { watched: true }), episode(1, 2, { watched: true, position: left(90) }), episode(1, 3)])).id, "e:Breaking Bad/S1E3.mkv");
  assert.equal(nextEpisode(build([episode(1, 1, { watched: true }), episode(1, 2, { watched: true, position: left(90) }), episode(1, 3, { position: { position: 600, duration: 2880, updated: 10, device: "other" } })])).id, "e:Breaking Bad/S1E3.mkv", "an unwatched episode in progress beats a newer leftover on a watched one");
});
