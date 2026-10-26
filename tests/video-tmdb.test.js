import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { closestContent, contentList, kidsCertification, withinLimit } from "../packages/daemon/tmdb.js";
import { clip, hub, tmdbServer } from "./video-support.js";

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-read-token";

test("TMDB answers arriving after Erase never recreate metadata or retry state", async (t) => {
  for (const outcome of ["success", "missing", "busy", "refused", "network", "unreadable"]) {
    await t.test(outcome, async (t) => {
      let answer, started, signal;
      const ready = new Promise((resolve) => (started = resolve));
      const pending = new Promise((resolve, reject) => {
        answer = (value) => value instanceof Error ? reject(value) : resolve(value);
      });
      const f = await hub(t, { tmdb: { interval: 0, fetch: async (_, options) => {
        signal = options.signal;
        started();
        // A response already in transit may finish even after cancellation.
        return pending;
      } } });
      f.s.config.video = { tmdbToken: TOKEN };
      const tmdb = f.daemon.engine.video.tmdb;
      const resolving = tmdb.resolve({ kind: "movie", id: 949, key: "movie:949" }).catch(() => {});
      await ready;
      await f.call("/v1/destroy-hub", { confirmed: true });
      assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM video_meta").get().n, 0);
      answer(outcome === "network" ? new Error("Connection closed") : new Response(
        outcome === "unreadable" ? "{broken" : JSON.stringify({ id: 949, title: "Heat", overview: "Old library metadata" }),
        { status: { missing: 404, busy: 429, refused: 401 }[outcome] || 200 },
      ));
      await resolving;
      assert.equal(f.s.db.prepare("SELECT count(*) AS n FROM video_meta").get().n, 0,
        "neither a late answer nor its error handler writes after Erase");
      assert.equal(signal.aborted, true, "Erase cancels the pending lookup");
    });
  }
});

const CATALOG = {
  searchMovie: {
    inception: [
      { id: 999, title: "Inception: The Cobol Job", release_date: "2010-12-07", poster_path: null },
      { id: 27205, title: "Inception", release_date: "2010-07-15", poster_path: "/inception.jpg", overview: "Dreams." },
    ],
    heat: [{ id: 949, title: "Heat", release_date: "1995-12-15", poster_path: "/heat.jpg" }],
    "toy story": [{ id: 862, title: "Toy Story", release_date: "1995-11-22", poster_path: "/toy.jpg" }],
  },
  searchTv: {
    "breaking bad": [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: "/bb.jpg" }],
    bluey: [{ id: 82728, name: "Bluey", first_air_date: "2018-10-01", poster_path: "/bluey.jpg" }],
  },
  movies: {
    27205: {
      id: 27205,
      title: "Origen",
      release_date: "2010-07-15",
      overview: "",
      genres: [{ id: 28, name: "Acción" }, { id: 878, name: "Ciencia ficción" }],
      runtime: 148,
      vote_average: 8.369,
      poster_path: "/inception.jpg",
      backdrop_path: "/inception-wide.jpg",
      belongs_to_collection: null,
      release_dates: {
        results: [
          { iso_3166_1: "ES", release_dates: [{ type: 3, certification: "12" }] },
          { iso_3166_1: "US", release_dates: [{ type: 1, certification: "" }, { type: 3, certification: "PG-13" }] },
        ],
      },
      credits: { cast: ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page", "Tom Hardy", "Ken Watanabe", "Cillian Murphy"].map((name) => ({ name })) },
    },
    949: {
      id: 949,
      title: "Heat",
      original_language: "en",
      release_date: "1995-12-15",
      overview: "Crime.",
      genres: [{ id: 80, name: "Crime" }],
      runtime: 170,
      vote_average: 7.9,
      release_dates: { results: [{ iso_3166_1: "ES", release_dates: [{ type: 3, certification: "18" }] }] },
      credits: { cast: [{ name: "Al Pacino" }] },
      keywords: { keywords: [{ id: 9663 }, { id: 0 }, { name: "no id" }] },
      recommendations: { results: [{ id: 27205 }] },
    },
    862: {
      id: 862,
      title: "Toy Story",
      release_date: "1995-11-22",
      overview: "Toys.",
      genres: [{ id: 16, name: "Animation" }, { id: 10751, name: "Family" }],
      runtime: 81,
      belongs_to_collection: { name: "Toy Story Collection" },
      release_dates: { results: [] },
      credits: { cast: [] },
    },
  },
  tv: {
    1396: {
      id: 1396,
      name: "Breaking Bad",
      original_language: "en",
      first_air_date: "2008-01-20",
      overview: "Chemistry.",
      genres: [{ id: 18, name: "Drama" }],
      vote_average: 8.9,
      poster_path: "/bb.jpg",
      backdrop_path: "/bb-wide.jpg",
      content_ratings: { results: [{ iso_3166_1: "ES", rating: "16" }, { iso_3166_1: "US", rating: "TV-MA" }] },
      credits: { cast: [{ name: "Bryan Cranston" }] },
      seasons: [{ season_number: 1, name: "Temporada 1" }],
    },
    82728: {
      id: 82728,
      name: "Bluey",
      first_air_date: "2018-10-01",
      overview: "Dogs.",
      genres: [{ id: 16, name: "Animation" }],
      content_ratings: { results: [{ iso_3166_1: "ES", rating: "TP" }, { iso_3166_1: "US", rating: "TV-Y" }] },
      credits: { cast: [] },
    },
  },
  seasons: {
    "1396:1": {
      name: "Temporada 1",
      episodes: [{ episode_number: 1, name: "Piloto", overview: "Walt.", still_path: "/pilot.jpg", air_date: "2008-01-20", runtime: 58 }],
    },
    "82728:1": { name: "Season 1", episodes: [] },
  },
};
CATALOG.englishOverview = "Dreams within dreams.";

const titleCalls = (tmdb) => tmdb.calls.filter((call) => !/^\/3\/(configuration|certification)\//.test(call.url.pathname)).length;

function server() {
  const tmdb = tmdbServer(CATALOG);
  const inner = tmdb.fetch;
  tmdb.fetch = async (href, options) => {
    const url = new URL(href);
    if (url.pathname === "/3/movie/27205" && url.searchParams.get("language") === "en-US" && !url.searchParams.has("append_to_response")) {
      tmdb.calls.push({ url, headers: options.headers || {} });
      return new Response(JSON.stringify({ id: 27205, overview: CATALOG.englishOverview }), { status: 200 });
    }
    return inner(href, options);
  };
  return tmdb;
}

test("kids limits compare movie certifications per country", () => {
  assert.equal(withinLimit("ES", "TP", "7"), true);
  assert.equal(withinLimit("ES", "7", "7"), true);
  assert.equal(withinLimit("ES", "12", "7"), false);
  assert.equal(withinLimit("US", "PG", "PG"), true);
  assert.equal(withinLimit("US", "PG-13", "PG"), false);
  assert.equal(withinLimit("US", "", "PG"), false);
  assert.equal(withinLimit("XX", "PG", "PG"), false);
});

test("the kids rule is fixed per country: movies only at the lowest level, so a PG Star Wars is not for kids", () => {
  const cases = [
    ["ES", "TP", false, true], ["ES", "7", false, false], ["ES", "12", false, false],
    ["US", "G", false, true], ["US", "PG", false, false], ["US", "PG-13", false, false],
    ["GB", "U", false, true], ["GB", "PG", false, false], ["GB", "12A", false, false],
    ["DE", "0", false, true], ["DE", "6", false, false], ["DE", "12", false, false], ["DE", "16", false, false],
    ["FR", "U", false, true], ["FR", "10", false, false], ["FR", "12", false, false],
  ];
  for (const [country, certification, , expected] of cases)
    assert.equal(kidsCertification(country, certification), expected, `${country} ${certification}`);
});

test("an older video configuration moves to the closest content choice", () => {
  assert.equal(closestContent({}), "en-US");
  assert.equal(closestContent({ content: "de-DE", language: "es-ES" }), "de-DE");
  assert.equal(closestContent({ language: "es-ES", country: "ES", kidsLimit: "7" }), "es-ES");
  assert.equal(closestContent({ language: "en-GB" }), "en-GB");
  assert.equal(closestContent({ language: "en-HK", country: "GB" }), "en-GB");
  assert.equal(closestContent({ language: "es-MX", country: "MX" }), "es-MX", "a language and country that is itself a choice keeps it");
  assert.equal(closestContent({ language: "es-CL", country: "CL" }), "es-ES");
  assert.equal(closestContent({ language: "es-CL" }, ["es-CL", "en-US"]), "es-CL");
  assert.equal(closestContent({ language: "is-IS", country: "IS" }), "en-US");
});

test("settings report the TMDB state, titles per library and content, never the token", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995).mp4", clip({ tone: 2050 }));
  await f.propose("VID_20230512_181512.mp4", clip({ tone: 2060 }));
  await f.settled();
  const contents = contentList(null);
  assert.ok(contents.length >= 25);
  for (const [id, label] of [["es-ES", "Español · España"], ["en-US", "English · United States"], ["en-GB", "English · United Kingdom"], ["de-DE", "Deutsch · Deutschland"], ["fr-FR", "Français · France"]])
    assert.deepEqual(contents.find((content) => content.id === id), { id, label });
  assert.deepEqual(contents.map((content) => content.label), [...contents.map((content) => content.label)].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(await f.call("/v1/video/settings"), {
    tokenSet: false,
    state: "none",
    matched: 0,
    total: 1,
    content: "en-US",
    contents,
    libraries: [{ volume: f.v.id, name: "Videos", movies: 1, shows: 0, unrecognised: 1 }],
  });
  const saved = await f.call("/v1/video/settings", { tmdbToken: ` ${TOKEN} `, content: "es-ES", language: "fr-FR", country: "US", kidsLimit: "R" });
  assert.equal(saved.tokenSet, true);
  assert.equal(saved.content, "es-ES", "only the content choice sets language and country");
  assert.ok(!JSON.stringify(await f.call("/v1/video/settings")).includes(TOKEN));
  assert.deepEqual(f.daemon.engine.config.video, { content: "es-ES", tmdbToken: TOKEN });
  for (const body of [{ content: "xx-QQ" }, { content: "spanish" }, { tmdbToken: "two words" }, { tmdbToken: 5 }])
    await assert.rejects(f.call("/v1/video/settings", body), { status: 400 }, JSON.stringify(body));
  const phone = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await assert.rejects(f.call("/v1/video/settings", undefined, phone.token), { status: 403 }, "a linked device never reads the hub's video settings");
  await assert.rejects(f.call("/v1/video/refresh", {}, phone.token), { status: 403 });
  assert.equal((await f.call("/v1/video/settings", { tmdbToken: "" })).state, "none");
  assert.equal(f.daemon.engine.config.video.tmdbToken, undefined);
  const config = fs.readFileSync(path.join(f.home, "config.json"), "utf8");
  assert.ok(!config.includes(TOKEN));
  await assert.rejects(f.call("/v1/video/tmdb-search?query=heat&type=movie"), { status: 409 }, "searching TMDB needs a token");
});

test("a saved configuration with language, country and kids limit is rewritten as one content choice on start", async (t) => {
  const f = await hub(t);
  f.daemon.engine.config.video = { tmdbToken: TOKEN, language: "en-GB", country: "GB", kidsLimit: "U" };
  f.daemon.engine.video.resume();
  assert.deepEqual(f.daemon.engine.config.video, { content: "en-GB", tmdbToken: TOKEN });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, "config.json"), "utf8")).video, { content: "en-GB", tmdbToken: TOKEN });
});

test("a file whose only audio track declares no language takes the title's original language from TMDB", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995).mp4", clip({ tone: 2090 }));
  await f.propose("Breaking Bad/Season 1/Breaking.Bad.S01E01.mp4", clip({ tone: 2091 }));
  await f.propose("Toy Story (1995).mp4", clip({ tone: 2092 }));
  const without = await f.settled();
  assert.deepEqual(without.movies.map((movie) => [movie.title, movie.audioTracks[0].language]), [["Heat", null], ["Toy Story", null]], "without TMDB nothing is guessed");
  await f.call("/v1/video/settings", { tmdbToken: TOKEN, content: "en-US" });
  const library = await f.settled();
  const heat = library.movies.find((movie) => movie.tmdb === 949);
  assert.deepEqual([heat.audioTracks[0].language, heat.audioTracks[0].label, heat.audioLanguages], ["en", "English", ["English"]]);
  const toy = library.movies.find((movie) => movie.tmdb === 862);
  assert.deepEqual([toy.audioTracks[0].language, toy.audioTracks[0].label, toy.audioLanguages], [null, "Track 1", []], "TMDB gave no original language, so none is assumed");
  const episode = library.shows[0].seasons[0].episodes[0];
  assert.deepEqual([episode.audioTracks[0].language, episode.audioTracks[0].label], ["en", "English"], "an episode takes its show's");
});

test("Refresh metadata forgets cached TMDB answers but keeps fixed matches, and matches everything again", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN, content: "en-US" });
  await f.propose("Heat (1995).mp4", clip({ tone: 2070 }));
  await f.propose("Toy Story (1995).mp4", clip({ tone: 2080 }));
  let library = await f.settled();
  const heat = library.movies.find((movie) => movie.tmdb === 949);
  await f.call("/v1/video/match", { volume: f.v.id, id: heat.id, tmdb: { type: "movie", id: 27205 } });
  library = await f.settled();
  let settings = await f.call("/v1/video/settings");
  assert.equal(settings.state, "connected");
  assert.equal(settings.matched, 2);
  assert.equal(settings.total, 2);
  const before = tmdb.calls.length;
  CATALOG.movies[862].title = "Toy Story (refreshed)";
  try {
    settings = await f.call("/v1/video/refresh", {});
    assert.equal(settings.state, "matching");
    library = await f.settled();
  } finally {
    CATALOG.movies[862].title = "Toy Story";
  }
  assert.ok(tmdb.calls.length > before, "titles are asked again");
  assert.deepEqual(library.movies.map((movie) => [movie.title, movie.tmdb]).sort(), [["Origen", 27205], ["Toy Story (refreshed)", 862]]);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM video_overrides").get().n, 1, "a fixed match survives a refresh");
});

test("with a token the hub matches titles on TMDB, caches metadata and art, falls back to English overviews and applies certifications", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN, content: "es-ES" });
  await f.propose("Inception.2010.1080p.BluRay.x264-GRP.mp4", clip({ tone: 2000 }));
  await f.propose("Toy Story (1995).mp4", clip({ tone: 2010 }));
  await f.propose("Heat (1995).mp4", clip({ tone: 2015 }));
  await f.propose("Breaking Bad/Season 1/Breaking.Bad.S01E01.mp4", clip({ tone: 2020 }));
  await f.propose("Bluey/Season 1/Bluey.S01E01.mp4", clip({ tone: 2030 }));
  await f.propose("VID_20230512_181512.mp4", clip({ tone: 2040 }));
  const library = await f.settled();
  const inception = library.movies.find((movie) => movie.tmdb === 27205);
  assert.equal(inception.title, "Origen");
  assert.equal(inception.year, 2010);
  assert.equal(inception.overview, "Dreams within dreams.", "an empty overview in the chosen language falls back to English");
  assert.deepEqual(inception.genres, ["Acción", "Ciencia ficción"]);
  assert.equal(inception.runtime, 148);
  assert.equal(inception.certification, "12");
  assert.equal(inception.rating, 8.4);
  assert.deepEqual(inception.cast, ["Leonardo DiCaprio", "Joseph Gordon-Levitt", "Elliot Page", "Tom Hardy", "Ken Watanabe"]);
  assert.equal(inception.matched, true);
  assert.equal(inception.kids, false);
  const toy = library.movies.find((movie) => movie.tmdb === 862);
  assert.equal(toy.kids, true, "the Family genre is kids");
  assert.equal(toy.collection, "Toy Story", "TMDB names lose their trailing Collection");
  const heat = library.movies.find((movie) => movie.tmdb === 949);
  assert.ok(heat.related.includes(inception.id), "TMDB recommending Inception for Heat makes them related, worked out on the hub");
  assert.ok(inception.related.includes(heat.id), "in both directions");
  assert.equal(toy.related.includes(inception.id), false, "a kids film never relates to a grown-up one");
  const key = "tmdb:movie:949";
  const cached = JSON.parse(f.s.db.prepare("SELECT data FROM video_meta WHERE key=?").get(key).data);
  delete cached.recommended;
  f.s.db.prepare("UPDATE video_meta SET data=? WHERE key=?").run(JSON.stringify(cached), key);
  const asked = tmdb.calls.length;
  f.daemon.engine.video.generation++;
  await f.settled();
  assert.ok(tmdb.calls.slice(asked).some((call) => String(call.url).includes("/movie/949")), "a title cached before relations existed is asked again once");
  assert.ok(Array.isArray(JSON.parse(f.s.db.prepare("SELECT data FROM video_meta WHERE key=?").get(key).data).recommended));
  const [bb, bluey] = [library.shows.find((show) => show.tmdb === 1396), library.shows.find((show) => show.tmdb === 82728)];
  assert.equal(bb.certification, "16");
  assert.equal(bb.kids, false);
  assert.equal(bluey.kids, false, "a show always stays in TV Shows, even with a kids rating");
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: bluey.id, kids: true }), { status: 400 }, "a show can't be marked for kids");
  assert.equal(bb.seasons[0].name, "Temporada 1");
  const pilot = bb.seasons[0].episodes[0];
  assert.equal(pilot.title, "Piloto");
  assert.equal(pilot.aired, "2008-01-20");
  assert.match(pilot.still, /^[a-f0-9]{64}$/);
  assert.equal(library.kids, true);
  const searches = tmdb.calls.filter((call) => call.url.pathname.startsWith("/3/search/")).map((call) => call.url.searchParams.get("query"));
  assert.deepEqual(searches.sort(), ["Bluey", "Breaking Bad", "Heat", "Inception", "Toy Story"], "only parsed titles are sent; home videos never");
  assert.ok(tmdb.calls.filter((call) => call.url.hostname === "api.themoviedb.org").every((call) => call.headers.Authorization === `Bearer ${TOKEN}`));

  const art = await f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: inception.backdrop, size: "large" })}`);
  assert.equal((await sharp(Buffer.from(art.data.split(",")[1], "base64")).metadata()).width, 780, "a backdrop is never enlarged");
  const poster = await f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: inception.poster })}`);
  assert.equal((await sharp(Buffer.from(poster.data.split(",")[1], "base64")).metadata()).width, 240);
  const before = tmdb.calls.length;
  await f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: inception.poster, size: "large" })}`);
  assert.equal(tmdb.calls.length, before, "art is downloaded once");

  f.daemon.engine.video.memo.clear();
  const again = await f.library();
  assert.equal(again.version, library.version);
  assert.equal(tmdb.calls.length, before, "cached metadata is not fetched again");

  await f.call("/v1/video/settings", { content: "en-US" });
  const us = await f.settled();
  assert.equal(us.movies.find((movie) => movie.tmdb === 27205).kids, false, "PG-13 is over the US kids limit");
  assert.equal(us.shows.find((show) => show.tmdb === 82728).kids, false, "shows never go under Kids");
  assert.equal(us.shows.find((show) => show.tmdb === 1396).kids, false);
});

test("Fix match searches TMDB, shows poster thumbnails through the hub and pins the chosen title", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN, content: "en-US" });
  await f.propose("Heat (1995).mp4", clip({ tone: 2100 }));
  let library = await f.settled();
  const heat = library.movies[0];
  assert.equal(heat.tmdb, 949);
  const results = await f.call(`/v1/video/tmdb-search?${new URLSearchParams({ query: "inception", type: "movie", year: "2010" })}`);
  assert.deepEqual(results.results.map((row) => [row.type, row.id, row.title, row.year]), [["movie", 999, "Inception: The Cobol Job", 2010], ["movie", 27205, "Inception", 2010]]);
  assert.equal(results.results[0].poster, null);
  assert.equal(results.results[1].poster, "/v1/video/tmdb-image?path=%2Finception.jpg");
  const thumb = await f.call(results.results[1].poster);
  assert.match(thumb.data, /^data:image\/jpeg;base64,/);
  await assert.rejects(f.call("/v1/video/tmdb-image?path=../etc/passwd"), { status: 400 });
  await assert.rejects(f.call("/v1/video/tmdb-search?query=x&type=book"), { status: 400 });
  await f.call("/v1/video/match", { volume: f.v.id, id: heat.id, tmdb: { type: "movie", id: 27205 } });
  library = await f.settled();
  assert.equal(library.movies[0].tmdb, 27205);
  assert.equal(library.movies[0].title, "Origen");
  await f.call("/v1/video/match", { volume: f.v.id, id: heat.id, reset: true });
  library = await f.settled();
  assert.equal(library.movies[0].tmdb, 949);
  const desk = await f.call("/v1/devices", { name: "Desk", role: "replica" });
  await assert.rejects(f.call("/v1/video/tmdb-search?query=heat&type=movie", undefined, desk.token), { status: 403 });
  await assert.rejects(f.call("/v1/video/match", { volume: f.v.id, id: heat.id, none: true }, desk.token), { status: 403 });
});

test("TMDB errors and rate limits back off persistently instead of hammering, and a refused token is reported", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  tmdb.state.status = 429;
  tmdb.state.headers = { "retry-after": "120" };
  await f.propose("Heat (1995).mp4", clip({ tone: 2200 }));
  let library;
  for (let i = 0; i < 100; i++) {
    await f.daemon.engine.video.background;
    library = await f.library();
    await f.daemon.engine.video.matcher;
    if (!library.indexing && f.daemon.engine.video.tmdb.waiting()) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual(library.matching, { done: 0, total: 1 }, "the title is still waiting for TMDB");
  assert.equal(library.movies[0].matched, false);
  const calls = titleCalls(tmdb);
  assert.equal(calls, 1);
  await f.library();
  await f.daemon.engine.video.matcher;
  assert.equal(titleCalls(tmdb), calls, "no request is sent while backing off");
  const saved = f.s.db.prepare("SELECT fetched FROM video_meta WHERE key='backoff'").get();
  assert.ok(saved.fetched >= Date.now() + 110000, "the backoff honours Retry-After and is saved");
  await assert.rejects(f.call("/v1/video/tmdb-search?query=heat&type=movie"), { status: 503 });

  tmdb.state.status = 401;
  f.daemon.engine.video.tmdb.until = 0;
  await assert.rejects(f.call("/v1/video/tmdb-search?query=heat&type=movie"), { status: 502 });
  assert.equal((await f.call("/v1/video/settings")).state, "refused");
  tmdb.state.status = null;
  await f.call("/v1/video/settings", { tmdbToken: `${TOKEN}-new` });
  assert.equal(f.s.db.prepare("SELECT 1 FROM video_meta WHERE key='backoff'").get(), undefined, "a new token starts without backoff");
  library = await f.settled();
  assert.equal(library.movies[0].tmdb, 949);
});

test("a title TMDB does not know stays in file-name mode and is not searched again at once", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  await f.propose("Unknown Film (2003).mp4", clip({ tone: 2300 }));
  let library = await f.settled();
  assert.equal(library.movies[0].title, "Unknown Film");
  assert.equal(library.movies[0].matched, false);
  const calls = titleCalls(tmdb);
  assert.equal(calls, 2, "one search with the year and one without");
  f.daemon.engine.video.memo.clear();
  library = await f.settled();
  assert.equal(titleCalls(tmdb), calls);
});

test("unreadable TMDB answers back off persistently until a complete response succeeds", async (t) => {
  const f = await hub(t, { tmdb: { fetch: async () => new Response("{broken"), interval: 0 } });
  f.daemon.engine.config.video = { tmdbToken: TOKEN };
  const tmdb = f.daemon.engine.video.tmdb;
  tmdb.failures = 2;
  await assert.rejects(tmdb.call("/search/movie"), { status: 502 });
  assert.equal(tmdb.failures, 3, "headers alone do not reset failures");
  assert.ok(tmdb.waiting());
  assert.ok(f.s.db.prepare("SELECT fetched FROM video_meta WHERE key='backoff'").get().fetched > Date.now());
  tmdb.until = 0;
  tmdb.fetch = async () => new Response('{"results":[]}');
  assert.deepEqual(await tmdb.call("/search/movie"), { results: [] });
  assert.equal(tmdb.failures, 0);
});

test("TMDB pictures wait out a backoff and refuse bodies over 16 MiB while streaming", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  const client = f.daemon.engine.video.tmdb;
  client.until = Date.now() + 60000;
  const calls = tmdb.calls.length;
  assert.equal(await client.image("/heat.jpg", "w780"), null);
  assert.equal(tmdb.calls.length, calls, "no picture is fetched while backing off");
  client.until = 0;
  let sent = 0;
  client.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          sent += 1024 * 1024;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (sent > 40 * 1024 * 1024) controller.close();
        },
      }),
      { status: 200 },
    );
  assert.equal(await client.image("/huge.jpg", "w780"), false);
  assert.ok(sent <= 18 * 1024 * 1024, `stopped after ${sent} bytes`);
});

test("a 32-character v3 API key goes in the api_key parameter, a read token as Bearer, and neither leaks into errors", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  const key = "0123456789abcdef0123456789ABCDEF";
  await f.call("/v1/video/settings", { tmdbToken: key });
  await f.call("/v1/video/tmdb-search?query=heat&type=movie");
  let call = tmdb.calls.at(-1);
  assert.equal(call.url.searchParams.get("api_key"), key);
  assert.equal(call.headers.Authorization, undefined);
  await f.call(results(await f.call("/v1/video/tmdb-search?query=inception&type=movie")));
  const image = tmdb.calls.at(-1);
  assert.equal(image.url.hostname, "image.tmdb.org");
  assert.equal(image.url.searchParams.get("api_key"), null, "pictures never carry the key");
  tmdb.state.status = 401;
  const refused = await f.call("/v1/video/tmdb-search?query=heat&type=movie").catch((error) => error);
  assert.equal(refused.status, 502);
  assert.ok(!JSON.stringify(refused.body).includes(key) && !refused.message.includes(key));
  assert.equal((await f.call("/v1/video/settings")).state, "refused");
  f.daemon.engine.video.tmdb.until = 0;
  const thrown = await f.daemon.engine.video.tmdb.call("/search/movie", { query: "heat" }).catch((error) => error);
  assert.ok(!String(thrown.message).includes(key) && !String(thrown.stack).includes(key));
  tmdb.state.status = null;
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  await f.call("/v1/video/tmdb-search?query=heat&type=movie");
  call = tmdb.calls.at(-1);
  assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.url.searchParams.get("api_key"), null);
});

const results = (answer) => answer.results.find((row) => row.poster).poster;

test("with TMDB lists every language and country it certifies is a content choice, and kids movies are its lowest level", async (t) => {
  const levels = (...names) => names.map((certification, index) => ({ certification, meaning: "", order: index + 1 }));
  const catalog = {
    primaryTranslations: ["es-MX", "en-US", "ja-JP", "xx-YY", "pt-BR"],
    certifications: {
      movie: { MX: levels("AA", "A", "B", "B15", "C"), US: levels("G", "PG", "PG-13", "R"), JP: levels("G", "PG12", "R15+") },
      tv: { MX: levels("AA", "A", "B"), US: levels("TV-Y", "TV-Y7", "TV-G", "TV-PG") },
    },
    searchMovie: { heat: [{ id: 949, title: "Heat", release_date: "1995-12-15" }], coco: [{ id: 354912, title: "Coco", release_date: "2017-10-27" }] },
    movies: {
      949: { id: 949, title: "Heat", release_date: "1995-12-15", release_dates: { results: [{ iso_3166_1: "MX", release_dates: [{ type: 3, certification: "B15" }] }] } },
      354912: { id: 354912, title: "Coco", release_date: "2017-10-27", release_dates: { results: [{ iso_3166_1: "MX", release_dates: [{ type: 3, certification: "AA" }] }] } },
    },
  };
  const tmdb = tmdbServer(catalog);
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  await f.propose("Heat (1995).mp4", clip({ tone: 2500 }));
  await f.propose("Coco (2017).mp4", clip({ tone: 2510 }));
  await f.settled();
  const settings = await f.call("/v1/video/settings");
  const ids = settings.contents.map((content) => content.id);
  assert.deepEqual(settings.contents.find((content) => content.id === "es-MX"), { id: "es-MX", label: "Español · México" });
  assert.ok(ids.includes("ja-JP") && ids.includes("en-US"));
  assert.ok(!ids.includes("xx-YY") && !ids.includes("pt-BR"), "only pairs whose country TMDB certifies");
  for (const id of ["es-ES", "en-GB", "de-DE", "fr-FR"]) assert.ok(ids.includes(id), `${id} stays valid`);
  await f.call("/v1/video/settings", { content: "es-MX" });
  const library = await f.settled();
  const kids = Object.fromEntries(library.movies.map((movie) => [movie.title, [movie.certification, movie.kids]]));
  assert.deepEqual(kids, { Coco: ["AA", true], Heat: ["B15", false] });
  const fetched = () => tmdb.calls.filter((call) => call.url.pathname === "/3/certification/movie/list").length;
  const before = fetched();
  await f.library();
  await f.daemon.engine.video.matcher;
  assert.equal(fetched(), before, "the lists are not fetched again within a week");
  f.s.db.prepare("UPDATE video_meta SET fetched=? WHERE key='tmdb:contents'").run(Date.now() - 8 * 86400000);
  await f.library();
  await f.daemon.engine.video.matcher;
  assert.equal(fetched(), before + 1, "a week later they are fetched again");
});

test("the kids rule takes TMDB's lowest movie level when it has it, else the fixed table", () => {
  const lists = { movie: { MX: [["B", 3], ["AA", 1], ["A", 2]] }, tv: { US: [["TV-Y", 1], ["TV-Y7", 2], ["TV-G", 3]] } };
  assert.equal(kidsCertification("MX", "AA", lists), true);
  assert.equal(kidsCertification("MX", "aa", lists), true);
  assert.equal(kidsCertification("MX", "A", lists), false, "the second movie level is not for kids");
  assert.equal(kidsCertification("MX", "B", lists), false);
  assert.equal(kidsCertification("US", "PG", lists), false, "no US movie list falls back to the table, where only G is for kids");
  assert.equal(kidsCertification("US", "G", lists), true);
  assert.equal(kidsCertification("JP", "G", lists), false, "no list and no table is never kids by certification");
});

test("real TMDB certification lists ignore unrated entries and take the lowest movie level", () => {
  const raw = {
    US: [
      { certification: "NR", meaning: "No rating information.", order: 0 },
      { certification: "G", meaning: "All ages admitted.", order: 1 },
      { certification: "PG", meaning: "Some material may not be suitable for children.", order: 2 },
      { certification: "PG-13", meaning: "Some material may be inappropriate for children under 13.", order: 3 },
      { certification: "R", meaning: "Under 17 requires accompanying parent.", order: 4 },
      { certification: "NC-17", meaning: "No one 17 and under admitted.", order: 5 },
    ],
    XX: [
      { certification: "U", meaning: "", order: 1 },
      { certification: "Tous", meaning: "", order: 1 },
      { certification: "Unrated", meaning: "", order: 2 },
      { certification: "10", meaning: "", order: 2 },
      { certification: "16", meaning: "", order: 3 },
    ],
  };
  const tvRaw = {
    US: [
      { certification: "NR", meaning: "No rating information.", order: 0 },
      { certification: "TV-Y", meaning: "All children.", order: 1 },
      { certification: "TV-Y7", meaning: "Directed to older children.", order: 2 },
      { certification: "TV-G", meaning: "General audience.", order: 3 },
    ],
  };
  const compact = (body) => Object.fromEntries(Object.entries(body).map(([country, list]) => [country, list.map((row) => [row.certification, row.order])]));
  const lists = { movie: compact(raw), tv: compact(tvRaw) };
  assert.deepEqual(["NR", "G", "PG", "PG-13"].map((cert) => kidsCertification("US", cert, lists)), [false, true, false, false]);
  assert.deepEqual(["U", "Tous", "10", "16", "Unrated"].map((cert) => kidsCertification("XX", cert, lists)), [true, true, false, false, false], "ties at a level all count");
  assert.equal(kidsCertification("US", "Not Rated", null), false, "an unrated .nfo certification is never kids");
});

test("TMDB stores lists without unrated levels", async (t) => {
  const tmdb = tmdbServer({
    primaryTranslations: ["en-US"],
    certifications: { movie: { US: [{ certification: "NR", meaning: "No rating information.", order: 0 }, { certification: "G", meaning: "", order: 1 }] }, tv: {} },
  });
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  await f.daemon.engine.video.matcher;
  assert.deepEqual(f.daemon.engine.video.tmdb.contentsData().movie, { US: [["G", 1]] });
});

test("a refused key stays refused after a restart until any key is saved again, even the same one", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  await f.daemon.engine.video.matcher;
  tmdb.state.status = 401;
  f.daemon.engine.video.tmdb.until = 0;
  await assert.rejects(f.call("/v1/video/tmdb-search?query=heat&type=movie"), { status: 502 });
  const { Tmdb } = await import("../packages/daemon/tmdb.js");
  const restarted = new Tmdb(f.s);
  assert.equal(restarted.tokenRefused, true);
  assert.ok(restarted.waiting());
  tmdb.state.status = null;
  const saved = await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  assert.notEqual(saved.state, "refused");
  assert.equal(new Tmdb(f.s).tokenRefused, false);
  assert.equal(f.daemon.engine.video.tmdb.waiting(), false);
});

test("Refresh keeps serving cached answers until fresh ones arrive, needs a key and keeps a backoff", async (t) => {
  const tmdb = server();
  const f = await hub(t, { tmdb: { fetch: tmdb.fetch, interval: 0 } });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await assert.rejects(f.call("/v1/video/refresh", {}), { status: 409 });
  await f.call("/v1/video/settings", { tmdbToken: TOKEN, content: "en-US" });
  await f.propose("Toy Story (1995).mp4", clip({ tone: 2600 }));
  await f.settled();
  tmdb.state.status = 429;
  tmdb.state.headers = { "retry-after": "300" };
  await f.call("/v1/video/refresh", {});
  for (let i = 0; i < 50 && !f.daemon.engine.video.tmdb.waiting(); i++) {
    await f.library();
    await f.daemon.engine.video.matcher;
  }
  assert.ok(f.daemon.engine.video.tmdb.waiting(), "the 429 backoff is kept");
  f.daemon.engine.video.memo.clear();
  const library = await f.library();
  assert.equal(library.movies[0].tmdb, 862, "the old answer is still served");
  assert.equal(library.movies[0].collection, "Toy Story");
  assert.equal(library.tmdb, "matching");
  assert.ok(f.s.db.prepare("SELECT count(*) n FROM video_meta WHERE key LIKE 'tmdb:movie:%'").get().n > 0);
  tmdb.state.status = null;
  await f.call("/v1/video/settings", { tmdbToken: TOKEN });
  const settled = await f.settled();
  assert.equal(settled.tmdb, "connected");
});
