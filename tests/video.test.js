import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Store, init } from "../packages/daemon/storage.js";
import { parseProbe, parseNfo, subtitleFor, subtitleText, subtitleLanguage } from "../packages/daemon/video.js";
import { playerRoute } from "../packages/daemon/machines.js";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { clip, hub, image } from "./video-support.js";

const movies = (library) => library.movies.map((movie) => [movie.title, movie.year]);
const episodes = (show) => show.seasons.flatMap((season) => season.episodes.map((episode) => `${season.season}x${episode.episode} ${episode.title}`));

test("a replaced video's queued progress cannot overwrite or finish its current copy", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const name = "Heat (1995).mp4";
  await f.propose(name, clip({ tone: 401 }));
  await f.daemon.engine.scanHub(f.v.id);
  const old = f.s.current(f.v.id, name).hash;
  fs.writeFileSync(f.s.filePath(f.v, name), clip({ tone: 402 }));
  await f.daemon.engine.scanHub(f.v.id);
  const hash = f.s.current(f.v.id, name).hash;
  const body = { volume: f.v.id, path: name, hash, position: 120, duration: 1000 };
  await f.call("/v1/video/position", body);
  for (const position of [300, 999])
    await assert.rejects(f.call("/v1/video/position", { ...body, hash: old, position }), { status: 409 });
  assert.equal(f.s.db.prepare("SELECT position FROM video_positions WHERE volume=? AND path=?").get(f.v.id, name).position, 120);
  assert.equal(f.s.db.prepare("SELECT 1 FROM video_watched WHERE volume=? AND path=?").get(f.v.id, name), undefined);
});

test("only the hub's administrator enables a video library, and a folder is one library kind only", async (t) => {
  const f = await hub(t);
  await assert.rejects(f.library(), { status: 404 }, "an ordinary folder has no video library");
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(f.call("/v1/video/mark", { volume: f.v.id }, phone.token), { status: 403 });
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.call("/v1/video/mark", { volume: f.v.id });
  const catalog = await f.call("/v1/catalog", undefined, phone.token);
  assert.equal(catalog.video, true);
  assert.equal(catalog.volumes[0].video, true);
  assert.equal(catalog.volumes[0].music, false);
  const status = await f.call("/v1/status");
  assert.equal(status.volumes.find((v) => v.id === f.v.id).video, true);
  const remote = await f.call("/v1/remote");
  assert.equal(remote.volumes.find((v) => v.id === f.v.id).video, true);
  await assert.rejects(f.call("/v1/music/mark", { volume: f.v.id }), { status: 409 }, "a video library is not an audio library");
  await assert.rejects(f.call("/v1/gallery/link", { volume: f.v.id }), { status: 409 }, "a video library is not a gallery");
  const photos = f.s.addVolume("Photos");
  await f.call("/v1/gallery/link", { volume: photos.id });
  await assert.rejects(f.call("/v1/video/mark", { volume: photos.id }), { status: 409 });
  const songs = f.s.addVolume("Songs");
  await f.call("/v1/music/mark", { volume: songs.id });
  await assert.rejects(f.call("/v1/video/mark", { volume: songs.id }), { status: 409 });
  await assert.rejects(f.call("/v1/video/mark", { volume: "missing" }), { status: 404 });
});

test("a replaced video starts from the beginning, and a mark meant for the old copy is refused", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const name = "Heat (1995).mp4";
  await f.propose(name, clip({ tone: 411 }));
  await f.daemon.engine.scanHub(f.v.id);
  const old = f.s.current(f.v.id, name).hash;
  await f.call("/v1/video/position", { volume: f.v.id, path: name, hash: old, position: 120, duration: 1000 });
  assert.equal((await f.library()).movies[0].position.position, 120);
  fs.writeFileSync(f.s.filePath(f.v, name), clip({ tone: 412 }));
  await f.daemon.engine.scanHub(f.v.id);
  assert.equal((await f.library()).movies[0].position, null, "the new copy does not inherit the old position");
  await assert.rejects(f.call("/v1/video/watched", { volume: f.v.id, path: name, hash: old, watched: true }), { status: 409 });
  await assert.rejects(f.call("/v1/video/watched", { volume: f.v.id, path: name, hash: "x", watched: true }), { status: 400 });
  assert.equal((await f.library()).movies[0].watched, false);
  await f.call("/v1/video/watched", { volume: f.v.id, path: name, hash: f.s.current(f.v.id, name).hash, watched: true });
  assert.equal((await f.library()).movies[0].watched, true);
});

test("FFmpeg output parses into duration, size and codecs, skipping attached cover art", () => {
  const sample = `Input #0, matroska,webm, from 'x.mkv':
  Duration: 01:02:03.50, start: 0.000000, bitrate: 4000 kb/s
  Stream #0:0: Video: mjpeg (Baseline), yuvj420p(pc), 600x900 [SAR 1:1 DAR 2:3], 90k tbr (attached pic)
  Stream #0:1(eng): Video: hevc (Main 10), yuv420p10le(tv, bt2020nc/bt2020/smpte2084), 3840x2160 [SAR 1:1 DAR 16:9], 23.98 fps
  Stream #0:2(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s
At least one output file must be specified`;
  assert.deepEqual(parseProbe(sample), {
    duration: 3723.5,
    width: 3840,
    height: 2160,
    videoCodec: "hevc",
    audioCodec: "eac3",
    container: "matroska",
    audioTracks: [{ stream: 0, codec: "eac3", language: "eng", title: null, default: false, channels: 6 }],
    subtitleStreams: [],
  });
  assert.equal(parseProbe("garbage").duration, null);
});

test("Kodi .nfo files give title, year, plot, genres, TMDB id and collection", () => {
  const nfo = parseNfo(`<?xml version="1.0"?><movie><title>Le Fabuleux Destin d&apos;Amélie Poulain</title><year>2001</year>
  <plot><![CDATA[A shy waitress & her schemes.]]></plot><genre>Comedy</genre><genre>Romance</genre>
  <uniqueid type="imdb">tt0211915</uniqueid><uniqueid type="tmdb" default="true">194</uniqueid>
  <set><name>Jeunet</name></set><mpaa>Rated PG</mpaa></movie>`);
  assert.deepEqual(nfo, {
    title: "Le Fabuleux Destin d'Amélie Poulain",
    year: 2001,
    plot: "A shy waitress & her schemes.",
    genres: ["Comedy", "Romance"],
    tmdb: 194,
    collection: "Jeunet",
    aired: null,
    certification: "PG",
    rating: null,
  });
  assert.equal(parseNfo("<movie><tmdbid>603</tmdbid></movie>").tmdb, 603);
});

test("SRT subtitles become WebVTT in UTF-8 or Latin-1, and VTT passes through", () => {
  const srt = "\uFEFF1\r\n00:00:01,500 --> 00:00:03,000\r\n{\\an8}<font color=\"red\">Hola</font> <i>mundo</i>\r\n\r\n2\r\n0:00:04,5 --> 0:00:05,25\r\nAdiós\r\n";
  assert.equal(
    subtitleText(Buffer.from(srt, "utf8"), "srt"),
    "WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHola <i>mundo</i>\n\n2\n00:00:04.500 --> 00:00:05.250\nAdiós\n",
  );
  assert.match(subtitleText(Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nCañón\n", "latin1"), "srt"), /Cañón/);
  assert.equal(subtitleText(Buffer.from("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n"), "vtt"), "WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n");
  const cue = "1\r\n00:00:01,000 --> 00:00:02,000\r\nPingüino\r\n";
  const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cue, "utf16le")]);
  const big = Buffer.from(little);
  big.swap16();
  for (const encoded of [little, big]) assert.equal(subtitleText(encoded, "srt"), "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nPingüino\n");
});

test("the library lists movies, shows with seasons and episodes, and other videos with probed files and subtitles", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ seconds: 2 });
  const inception = await f.propose("Movies/Inception (2010)/Inception.2010.1080p.BluRay.x264-GRP.mp4", film);
  await f.propose("Movies/Inception (2010)/Inception.2010.1080p.BluRay.x264-GRP.es.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHola\n"));
  await f.propose("Movies/Inception (2010)/Inception.2010.1080p.BluRay.x264-GRP.en.forced.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHi\n"));
  const poster = await f.propose("Movies/Inception (2010)/poster.jpg", await image("red"));
  await f.propose("Movies/Inception (2010)/fanart.jpg", await image("blue", 1280, 720));
  await f.propose("Movies/Amelie/movie.nfo", Buffer.from("<movie><title>Amélie</title><year>2001</year><plot>Paris.</plot><genre>Comedy</genre></movie>"));
  await f.propose("Movies/Amelie/amelie.mkv", clip({ container: "mkv", tone: 500 }));
  await f.propose("Movies/Amelie/Subs/French.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nBonjour\n"));
  await f.propose("Breaking Bad/Season 1/Subs/Breaking.Bad.S01E01.Pilot/2_English.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHi\n"));
  await f.propose("Breaking Bad/Season 1/Breaking.Bad.S01E02.Cats.in.the.Bag.mkv", clip({ container: "mkv", tone: 600 }));
  await f.propose("Breaking Bad/Season 1/Breaking.Bad.S01E01.Pilot.mkv", clip({ container: "mkv", tone: 610 }));
  await f.propose("Breaking Bad/Season 2/Breaking.Bad.S02E01.mkv", clip({ container: "mkv", tone: 620 }));
  await f.propose("Breaking Bad/Specials/Breaking.Bad.S00E01.Minisode.mkv", clip({ container: "mkv", tone: 630 }));
  await f.propose("Breaking Bad/poster.jpg", await image("green"));
  await f.propose("Breaking Bad/Season 1/Breaking.Bad.S01E01.Pilot-thumb.jpg", await image("yellow", 400, 225));
  await f.propose("VID_20230512_181512.mp4", clip({ tone: 700 }));
  await f.propose("notes.txt", Buffer.from("not a video"));
  const library = await f.settled();
  assert.equal(library.indexing, false);
  assert.equal(library.matching, false, "without a TMDB token nothing is matched");
  assert.match(library.version, /^[a-f0-9]{32}$/);
  assert.deepEqual(movies(library), [["Amélie", 2001], ["Inception", 2010]]);
  const movie = library.movies.find((item) => item.title === "Inception");
  assert.equal(movie.id, "m:Movies/Inception (2010)/Inception.2010.1080p.BluRay.x264-GRP.mp4");
  assert.equal(movie.kind, "movie");
  assert.equal(movie.hash, inception);
  assert.equal(movie.size, film.length);
  assert.ok(Math.abs(movie.duration - 2) < 0.3, `duration ${movie.duration}`);
  assert.equal(movie.width, 320);
  assert.equal(movie.height, 240);
  assert.equal(movie.videoCodec, "mpeg4");
  assert.equal(movie.audioCodec, "aac");
  assert.equal(movie.container, "mp4");
  assert.equal(movie.runtime, null, "a clip under a minute has no runtime");
  assert.equal(movie.tmdb, null);
  assert.equal(movie.matched, false);
  assert.equal(movie.position, null);
  assert.equal(movie.watched, false);
  assert.ok(movie.added);
  assert.deepEqual(movie.cast, []);
  assert.equal(movie.collection, null);
  assert.deepEqual(
    movie.subtitles.map((sub) => [sub.language, sub.label]),
    [["en", "English (forced)"], ["es", "Spanish"]],
  );
  assert.match(movie.poster, /^[a-f0-9]{64}$/);
  assert.match(movie.backdrop, /^[a-f0-9]{64}$/);
  assert.notEqual(movie.poster, movie.backdrop);
  const amelie = library.movies.find((item) => item.title === "Amélie");
  assert.equal(amelie.overview, "Paris.");
  assert.deepEqual(amelie.genres, ["Comedy"]);
  assert.equal(amelie.container, "mkv");
  assert.equal(amelie.poster, null);
  assert.deepEqual(amelie.subtitles, [{ path: "Movies/Amelie/Subs/French.srt", language: "fr", label: "French" }], "a lone video takes the subtitles in its Subs folder");
  assert.equal(library.shows.length, 1);
  const [show] = library.shows;
  assert.equal(show.id, "s:breaking bad");
  assert.equal(show.title, "Breaking Bad");
  assert.match(show.poster, /^[a-f0-9]{64}$/);
  assert.deepEqual(show.seasons.map((season) => [season.season, season.name]), [[1, "Season 1"], [2, "Season 2"], [0, "Specials"]]);
  assert.deepEqual(episodes(show), ["1x1 Pilot", "1x2 Cats in the Bag", "2x1 Episode 1", "0x1 Minisode"]);
  const pilot = show.seasons[0].episodes[0];
  assert.equal(pilot.id, "e:Breaking Bad/Season 1/Breaking.Bad.S01E01.Pilot.mkv");
  assert.equal(pilot.show, show.id);
  assert.match(pilot.still, /^[a-f0-9]{64}$/);
  assert.deepEqual(pilot.subtitles.map((sub) => sub.label), ["English"], "Subs/<episode>/ belongs to that episode only");
  assert.deepEqual(show.seasons[0].episodes[1].subtitles, []);
  assert.equal(show.seasons[0].episodes[1].still, null);
  assert.deepEqual(library.other.map((item) => [item.id, item.title]), [["o:VID_20230512_181512.mp4", "VID_20230512_181512"]]);
  assert.deepEqual(library.continue, []);
  assert.deepEqual(library.nextUp, []);
  assert.equal(library.kids, false);
  assert.deepEqual(await f.library(`&version=${library.version}`), { version: library.version, indexing: false, matching: false, tmdb: "none", unchanged: true });

  const art = await f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: movie.poster, size: "large" })}`);
  assert.match(art.data, /^data:image\/jpeg;base64,/);
  const { width } = await (await import("sharp")).default(Buffer.from(art.data.split(",")[1], "base64")).metadata();
  assert.equal(width, 600);
  const small = await f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: movie.poster })}`);
  assert.equal((await (await import("sharp")).default(Buffer.from(small.data.split(",")[1], "base64")).metadata()).width, 240);
  await assert.rejects(f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: poster })}`), { status: 404 }, "only pictures the library uses are served");
  await assert.rejects(f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: "x" })}`), { status: 400 });
  assert.ok(fs.readdirSync(path.join(f.home, "video-art")).some((name) => name.startsWith(movie.poster)));
});

test("deleted and ignored files never reach the library, and deleting the share forgets its video state", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const up = await f.propose("Up (2009).mp4", clip({ tone: 300 }));
  await f.propose("Private/Secret (2001).mp4", clip({ tone: 310 }));
  await f.propose(".arcaignore", Buffer.from("Private/\n"));
  let library = await f.settled();
  assert.deepEqual(movies(library), [["Up", 2009]]);
  await f.call("/v1/video/position", { volume: f.v.id, path: "Up (2009).mp4", hash: library.movies[0].hash, position: 30, duration: 600 });
  await f.call("/v1/video/kids", { volume: f.v.id, id: library.movies[0].id, kids: true });
  f.s.db.prepare("UPDATE files SET deleted=1 WHERE volume=? AND path=?").run(f.v.id, "Up (2009).mp4");
  library = await f.settled();
  assert.deepEqual(library.movies, []);
  f.daemon.engine.video.sweep(true);
  assert.equal(f.s.db.prepare("SELECT 1 FROM video_items WHERE hash=?").get(up), undefined, "a sweep forgets probes of files no library holds");
  await f.call("/v1/delete-share", { id: f.v.id, confirmedName: "Videos" });
  for (const table of ["video_folders", "video_positions", "video_watched", "video_overrides", "video_hidden"])
    assert.equal(f.s.db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0, table);
});

test("Watch next cards can be removed and come back when the title is played again", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const names = ["Show/Season 1/Show.S01E01.mkv", "Show/Season 1/Show.S01E02.mkv", "Show/Season 1/Show.S01E03.mkv", "Heat (1995).mp4", "Up (2009).mp4", "Alien (1979).mp4"];
  const hashes = {};
  for (const [index, name] of names.entries()) hashes[name] = await f.propose(name, clip({ container: name.endsWith("mkv") ? "mkv" : "mp4", tone: 600 + index * 50 }));
  await f.settled();
  const position = (name, value) => f.call("/v1/video/position", { volume: f.v.id, path: name, hash: hashes[name], position: value, duration: 3000 });
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  await position("Heat (1995).mp4", 1200);
  await position(names[0], 2900);
  const row = async () => (await f.library()).watchNext.map((card) => `${card.reason}:${card.id}`);
  const heat = "m:Heat (1995).mp4";
  const episode = `e:${names[1]}`;
  const remove = (id) => f.call("/v1/video/watch-next/remove", { volume: f.v.id, id });
  const restore = (id) => f.call("/v1/video/watch-next/restore", { volume: f.v.id, id });
  assert.deepEqual((await row()).slice(0, 2), [`resume:${heat}`, `next:${episode}`]);
  const before = (await f.library()).version;
  const removed = await remove(heat);
  assert.notEqual(removed.version, before);
  assert.equal((await f.library()).version, removed.version);
  assert.ok(!(await row()).some((card) => card.endsWith(heat)), "a removed card leaves the row and is not suggested back");
  assert.equal((await f.library()).movies.find((movie) => movie.id === heat).position.position, 1200, "the saved position stays");
  assert.equal((await restore(heat)).version, before, "undo restores the row exactly");
  assert.deepEqual((await row()).slice(0, 2), [`resume:${heat}`, `next:${episode}`]);
  await remove(heat);
  await later();
  await position("Heat (1995).mp4", 1300);
  assert.ok((await row()).includes(`resume:${heat}`), "playing it again brings it back");
  await remove(episode);
  assert.ok(!(await row()).some((card) => card.includes("Show.S01")), "a removed next episode leaves the row, and the show is not suggested");
  await later();
  await position(names[1], 2900);
  assert.ok((await row()).includes(`next:e:${names[2]}`), "playing anything in the show brings it back");
  const pick = (await row()).find((card) => /^(new|waiting|related):/.test(card));
  const pickId = pick.slice(pick.indexOf(":") + 1);
  await remove(pickId);
  assert.ok(!(await row()).some((card) => card.endsWith(pickId)), "a removed suggestion is not suggested again");
  assert.deepEqual(await remove(pickId), { version: (await f.library()).version }, "removing a card that is not in the row changes nothing");
  await restore(pickId);
  assert.ok((await row()).some((card) => card.endsWith(pickId)), "undo brings a suggestion back");
  await assert.rejects(remove("x"), /Invalid video/);
});

test("positions resume any length, ignore the first seconds, and finishing marks watched; Continue and Next up follow", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const names = [
    "Show/Season 1/Show.S01E01.mkv",
    "Show/Season 1/Show.S01E02.mkv",
    "Show/Season 2/Show.S02E01.mkv",
    "Show/Season 2/Show.S02E02.mkv",
    "Show/Specials/Show.S00E01.mkv",
    "Show/Specials/Show.S00E02.mkv",
  ];
  const hashes = {};
  for (const [index, name] of names.entries()) hashes[name] = await f.propose(name, clip({ container: "mkv", tone: 800 + index }));
  const film = "Heat (1995).mp4";
  hashes[film] = await f.propose(film, clip({ tone: 900 }));
  await f.settled();
  const position = (name, value, duration = 3000, as) =>
    f.call("/v1/video/position", { volume: f.v.id, path: name, hash: hashes[name], position: value, duration }, as);
  assert.deepEqual(await position(film, 5), { kept: false }, "the first ten seconds are not kept");
  assert.deepEqual(await position(film, 11, 90), { kept: true }, "a 90 s clip is not finished at 11 s");
  assert.deepEqual(await position(film, 82, 90), { kept: false, finished: true }, "a short video finishes inside its last tenth");
  let library = await f.library();
  assert.equal(library.movies[0].watched, true);
  assert.equal(library.movies[0].position, null);
  await f.call("/v1/video/watched", { volume: f.v.id, path: film, watched: false });
  const before = (await f.library()).version;
  const builds = f.daemon.engine.video.memo.get(f.v.id).built;
  assert.deepEqual(await position(film, 1200, 7200), { kept: true });
  library = await f.library();
  assert.notEqual(library.version, before, "a saved position changes the library version");
  assert.equal(f.daemon.engine.video.memo.get(f.v.id).built, builds, "saving a position does not rebuild the library");
  assert.deepEqual(await f.library(`&version=${before}`), library, "a client holding the old version gets the new library");
  await position(film, 1210, 7200);
  assert.equal((await f.library()).version, library.version, "ten more seconds inside the same minute keep the version");
  assert.equal(library.movies[0].watched, false);
  assert.deepEqual(
    { ...library.movies[0].position, updated: 0 },
    { position: 1200, duration: 7200, updated: 0, device: "Video hub" },
  );
  assert.deepEqual(library.continue, [`m:${film}`]);
  assert.deepEqual(await position(film, 7200 - 360 + 1, 7200), { kept: false, finished: true }, "within 5 % of a long film it is finished");

  assert.deepEqual(await position(names[0], 2950), { kept: false, finished: true });
  library = await f.library();
  assert.deepEqual(library.nextUp, [`e:${names[1]}`]);
  assert.deepEqual(library.continue, []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await position(names[1], 400);
  library = await f.library();
  assert.deepEqual(library.continue, [`e:${names[1]}`], "an episode in progress is in Continue, not Next up");
  assert.deepEqual(library.nextUp, []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.call("/v1/video/watched", { volume: f.v.id, path: names[1], watched: true });
  library = await f.library();
  assert.deepEqual(library.nextUp, [`e:${names[2]}`], "Next up crosses into the next season and skips specials");
  assert.deepEqual(library.continue, []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.call("/v1/video/watched", { volume: f.v.id, path: names[4], watched: true });
  library = await f.library();
  assert.deepEqual(library.nextUp, [`e:${names[5]}`], "after a special comes the next special");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.call("/v1/video/watched", { volume: f.v.id, path: names[5], watched: true });
  library = await f.library();
  assert.deepEqual(library.nextUp, [`e:${names[2]}`], "after the last special comes the first unwatched episode");
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const name of names.slice(2, 4)) await f.call("/v1/video/watched", { volume: f.v.id, path: name, watched: true });
  library = await f.library();
  assert.deepEqual(library.nextUp, [], "a finished show has nothing next");
  const show = library.shows[0];
  assert.equal(show.seasons.flatMap((season) => season.episodes).every((episode) => episode.watched), true);

  await assert.rejects(f.call("/v1/video/position", { volume: f.v.id, path: "Missing.mkv", hash: hashes[film], position: 50, duration: 100 }), { status: 404 });
  await assert.rejects(f.call("/v1/video/position", { volume: f.v.id, path: film, hash: hashes[film], position: -1, duration: 100 }), { status: 400 });
  await assert.rejects(f.call("/v1/video/watched", { volume: f.v.id, path: film, watched: "yes" }), { status: 400 });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  await position(film, 500, 7200, phone.token);
  library = await f.library();
  assert.equal(library.movies[0].position.device, "Phone", "a linked device saves its own positions");
});

test("a show whose episodes sit in disc or season pack folders still takes the artwork in its own folder", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Lost/Season 1/Disc 2/Lost.S01E05.mkv", clip({ container: "mkv", tone: 1100 }));
  await f.propose("Lost/poster.jpg", await image("green"));
  await f.propose("TV/Breaking Bad/Breaking.Bad.S01.1080p/Breaking.Bad.S01E01.mkv", clip({ container: "mkv", tone: 1110 }));
  await f.propose("TV/Breaking Bad/poster.jpg", await image("red"));
  await f.propose("TV/Dark/Season 1/Dark.S01E01.mkv", clip({ container: "mkv", tone: 1120 }));
  await f.propose("TV/poster.jpg", await image("blue"));
  const library = await f.settled();
  assert.deepEqual(library.shows.map((show) => show.title).sort(), ["Breaking Bad", "Dark", "Lost"]);
  const show = (title) => library.shows.find((item) => item.title === title);
  assert.match(show("Lost").poster, /^[a-f0-9]{64}$/);
  assert.match(show("Breaking Bad").poster, /^[a-f0-9]{64}$/, "a season pack folder without art falls back to the show folder's");
  assert.notEqual(show("Breaking Bad").poster, show("Lost").poster);
  assert.equal(show("Dark").poster, null, "a generic folder's picture is never a show's poster");
});

test("an episode watched after another was paused moves the show on: Continue offers the next one, not the stale pause", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const names = [1, 2, 3, 4].map((number) => `Show/Season 1/Show.S01E0${number}.mkv`);
  const hashes = {};
  for (const [index, name] of names.entries()) hashes[name] = await f.propose(name, clip({ container: "mkv", tone: 1200 + index }));
  await f.settled();
  const pause = (name, position) => f.call("/v1/video/position", { volume: f.v.id, path: name, hash: hashes[name], position, duration: 3000 });
  const watched = (name, value = true) => f.call("/v1/video/watched", { volume: f.v.id, path: name, watched: value });
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  await pause(names[0], 400);
  await later();
  await watched(names[1]);
  let library = await f.library();
  assert.deepEqual([library.continue, library.nextUp], [[], [`e:${names[2]}`]]);
  await watched(names[1], false);
  await pause(names[2], 500);
  await later();
  await watched(names[1]);
  library = await f.library();
  assert.deepEqual([library.continue, library.nextUp], [[`e:${names[2]}`], []], "a paused episode right after the one just watched is the next one, so it resumes");
  await later();
  for (const name of names.slice(3)) await watched(name);
  library = await f.library();
  assert.deepEqual([library.continue, library.nextUp], [[`e:${names[2]}`], []], "with nothing after the last watched, the paused episode still resumes");
});

test("the library answer carries Watch next, and a file's own date keeps a moved title from reading as added today", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const old = new Date("2026-01-22T17:55:21.000Z");
  await f.propose("Heat (1995).mp4", clip({ tone: 3000 }));
  await f.propose("Ronin (1998).mp4", clip({ tone: 3010 }));
  const file = path.join(f.v.path, "Heat (1995).mp4");
  assert.ok(fs.existsSync(file));
  fs.utimesSync(file, old, old);
  f.daemon.engine.video.fileTimes.clear();
  await f.call("/v1/video/mark", { volume: f.v.id });
  const library = await f.settled();
  const heat = library.movies.find((m) => m.title === "Heat");
  assert.equal(heat.added, old.toISOString(), "the file's modification date is earlier than its first revision");
  assert.ok(Date.parse(library.movies.find((m) => m.title === "Ronin").added) > old.getTime());
  assert.deepEqual(library.watchNext.map((entry) => [entry.id.slice(2), entry.reason]).sort(), [["Heat (1995).mp4", "waiting"], ["Ronin (1998).mp4", "new"]]);
  const position = await f.call("/v1/video/position", { volume: f.v.id, path: "Heat (1995).mp4", hash: heat.hash, position: 1200, duration: 7200 });
  assert.deepEqual(position, { kept: true });
  const before = library.version;
  const resumed = await f.library();
  assert.notEqual(resumed.version, before, "the version follows what Watch next says, so a client holding the old one gets the new row");
  assert.deepEqual(resumed.watchNext.map((entry) => [entry.id.slice(2), entry.reason]), [["Heat (1995).mp4", "resume"], ["Ronin (1998).mp4", "new"]]);
});

test("Kids comes from kids folders, family genres in .nfo files and overrides, which win", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Kids/Peppa Pig/Season 1/01 Muddy Puddles.mp4", clip({ tone: 1000 }));
  await f.propose("Niños/Coco (2017).mp4", clip({ tone: 1010 }));
  await f.propose("Movies/Up (2009)/Up (2009).mp4", clip({ tone: 1020 }));
  await f.propose("Movies/Up (2009)/Up (2009).nfo", Buffer.from("<movie><title>Up</title><genre>Family</genre></movie>"));
  await f.propose("Movies/Heat (1995).mp4", clip({ tone: 1030 }));
  await f.propose("Home videos/Beach.mp4", clip({ tone: 1040 }));
  let library = await f.settled();
  const kids = (value) => [...value.movies.filter((m) => m.kids).map((m) => m.title), ...value.shows.filter((s) => s.kids).map((s) => s.title)];
  assert.deepEqual(kids(library), ["Coco", "Up"], "a show in a Kids folder still stays in TV Shows");
  assert.equal(library.kids, true);
  const heat = library.movies.find((m) => m.title === "Heat");
  const coco = library.movies.find((m) => m.title === "Coco");
  await f.call("/v1/video/kids", { volume: f.v.id, id: heat.id, kids: true });
  await f.call("/v1/video/kids", { volume: f.v.id, id: coco.id, kids: false });
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: library.shows[0].id, kids: true }), { status: 400 }, "a show can't go under Kids");
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: library.shows[0].seasons[0].episodes[0].id, kids: true }), { status: 400 }, "nor can an episode");
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: library.other[0].id, kids: true }), { status: 400 }, "nor a video under Others");
  library = await f.library();
  assert.deepEqual(kids(library), ["Heat", "Up"]);
  await f.call("/v1/video/kids", { volume: f.v.id, id: coco.id, kids: null });
  library = await f.library();
  assert.deepEqual(kids(library), ["Coco", "Heat", "Up"]);
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: coco.id, kids: "yes" }), { status: 400 });
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: "m:nothing.mp4", kids: true }), { status: 404 });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  assert.equal((await f.library("", phone.token)).movies.find((m) => m.id === coco.id).kids, true, "a linked phone reads kids without selecting the folder");
  for (const [route, body] of [
    ["/v1/video/kids", { volume: f.v.id, id: coco.id, kids: false }],
    ["/v1/video/match", { volume: f.v.id, id: coco.id, none: true }],
    ["/v1/video/settings", { country: "US" }],
    ["/v1/video/settings"],
    ["/v1/video/tmdb-search?query=coco&type=movie"],
    ["/v1/video/tmdb-image?path=%2Fcoco.jpg"],
  ])
    await assert.rejects(f.call(route, body, phone.token), { status: 403 }, `a phone never administers the hub: ${route}`);
  const player = await pairPlayer(f);
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: coco.id, kids: true }, player.token), { status: 403 });
});

test("Not a movie or show moves an item to Other videos, and Reset brings it back", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995).mp4", clip({ tone: 1100 }));
  await f.propose("Show/Season 1/Show.S01E01.mp4", clip({ tone: 1110 }));
  let library = await f.settled();
  await f.call("/v1/video/match", { volume: f.v.id, id: library.movies[0].id, none: true });
  await f.call("/v1/video/match", { volume: f.v.id, id: library.shows[0].id, none: true });
  library = await f.library();
  assert.deepEqual(library.movies, []);
  assert.deepEqual(library.shows, []);
  assert.deepEqual(library.other.map((item) => item.id), ["o:Heat (1995).mp4", "o:Show/Season 1/Show.S01E01.mp4"]);
  await f.call("/v1/video/match", { volume: f.v.id, id: "o:Heat (1995).mp4", reset: true });
  await f.call("/v1/video/match", { volume: f.v.id, id: "s:show", reset: true });
  library = await f.library();
  assert.deepEqual(movies(library), [["Heat", 1995]]);
  assert.equal(library.shows.length, 1);
  await assert.rejects(f.call("/v1/video/match", { volume: f.v.id, id: library.shows[0].id, tmdb: { type: "movie", id: 5 } }), { status: 400 });
  await assert.rejects(f.call("/v1/video/match", { volume: f.v.id, id: library.movies[0].id, tmdb: { type: "movie", id: -5 } }), { status: 400 });
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM video_overrides").get().n, 0, "a reset with nothing left removes the override");
});

async function pairPlayer(f) {
  const { code } = await f.call("/v1/pairing", { name: "TV" });
  const response = await fetch(`http://127.0.0.1:${f.daemon.port}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, kind: "player", name: "salon-tv" }),
  });
  return response.json();
}

test("a player reads the library and art, streams and saves positions, and nothing else of video", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ tone: 1200 });
  const hash = await f.propose("Heat (1995)/Heat (1995).mp4", film);
  await f.propose("Heat (1995)/poster.jpg", await image("red"));
  await f.propose("Heat (1995)/Heat (1995).en.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHi\n"));
  await f.settled();
  const player = await pairPlayer(f);
  const library = await f.library("", player.token);
  const [movie] = library.movies;
  assert.match((await f.call(`/v1/video/art?${new URLSearchParams({ volume: f.v.id, key: movie.poster })}`, undefined, player.token)).data, /^data:image/);
  const query = new URLSearchParams({ volume: f.v.id, path: movie.path, hash });
  const r = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${query}`, { headers: { Authorization: `Bearer ${player.token}`, Range: "bytes=0-9" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), film.subarray(0, 10));
  const subtitles = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: movie.subtitles[0].path })}`, {
    headers: { Authorization: `Bearer ${player.token}` },
  });
  assert.equal(subtitles.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.match(await subtitles.text(), /^WEBVTT\n\n1\n00:00:01\.000 --> 00:00:02\.000\nHi/);
  assert.deepEqual(await f.call("/v1/video/position", { volume: f.v.id, path: movie.path, hash, position: 120, duration: 6000 }, player.token), { kept: true });
  assert.deepEqual(await f.call("/v1/video/watched", { volume: f.v.id, path: movie.path, watched: true }, player.token), { watched: true });
  for (const [route, body] of [
    [`/v1/video/playback?${query}`],
    ["/v1/video/settings"],
    ["/v1/video/tmdb-search?query=heat&type=movie"],
    ["/v1/video/match", { volume: f.v.id, id: movie.id, none: true }],
    ["/v1/video/settings", { country: "US" }],
    ["/v1/video/mark", { volume: f.v.id }],
  ])
    await assert.rejects(f.call(route, body, player.token), { status: 403 }, route);
  for (const route of ["/v1/video/library", "/v1/video/art", "/v1/video/media", "/v1/video/subtitles"]) assert.equal(playerRoute("GET", route), true, route);
  for (const route of ["/v1/video/position", "/v1/video/watched"]) assert.equal(playerRoute("POST", route), true, route);
  for (const [method, route] of [["GET", "/v1/video/playback"], ["GET", "/v1/video/settings"], ["POST", "/v1/video/match"], ["POST", "/v1/video/kids"], ["POST", "/v1/video/mark"]])
    assert.equal(playerRoute(method, route), false, `${method} ${route}`);
});

test("the hub streams a video with ranges to its desktop app with tickets and to a web session, never other files or callers", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ tone: 1300 });
  const hash = await f.propose("Heat (1995).mp4", film);
  await f.propose("Heat (1995).es.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHola\n"));
  await f.propose("Heat (1995).en.vtt", Buffer.from("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n"));
  const loose = await f.propose("notes.txt", Buffer.from("plain"));
  await f.settled();
  const query = new URLSearchParams({ volume: f.v.id, path: "Heat (1995).mp4", hash });
  const playback = await f.call(`/v1/video/playback?${query}`);
  assert.match(playback.url, new RegExp(`^http://127\\.0\\.0\\.1:${f.daemon.port}/v1/video/media\\?ticket=`));
  assert.deepEqual(playback.subtitles.map((sub) => [sub.label, sub.language]), [["English", "en"], ["Spanish", "es"]]);
  assert.ok(!JSON.stringify(playback).includes(f.daemon.engine.config.adminToken));
  let r = await fetch(playback.url, { headers: { Range: "bytes=2-9", Origin: "tauri://localhost" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 2-9/${film.length}`);
  assert.equal(r.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), film.subarray(2, 10));
  assert.equal((await fetch(playback.url, { headers: { Origin: "https://evil.example" } })).status, 401);
  assert.equal((await fetch(playback.url.replace("/v1/video/media", "/v1/video/subtitles"))).status, 401, "a media ticket opens no subtitles");
  assert.equal((await fetch(playback.url.replace("/v1/video/media", "/v1/music/media"))).status, 401);
  assert.deepEqual(playback.subtitles[1], { path: "Heat (1995).es.srt", label: "Spanish", language: "es" }, "the desktop app gets subtitle paths, not tickets");
  const json = await f.call(`/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: playback.subtitles[1].path, format: "json" })}`);
  assert.match(json.text, /00:00:01\.000 --> 00:00:02\.000\nHola/);
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 3600000 + 1000;
  try {
    assert.equal((await fetch(playback.url)).status, 401, "tickets expire after two hours");
  } finally {
    Date.now = realNow;
  }
  assert.equal((await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${query}`)).status, 401);
  await assert.rejects(f.call(`/v1/video/playback?${new URLSearchParams({ volume: f.v.id, path: "notes.txt", hash: loose })}`), { status: 404 });
  await assert.rejects(f.call(`/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: "notes.txt" })}`), { status: 404 });
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  await assert.rejects(f.call(`/v1/video/playback?${query}`, undefined, phone.token), { status: 403 });
  r = await fetch(`http://127.0.0.1:${f.daemon.port}/v1/video/media?${query}`, { headers: { Authorization: `Bearer ${phone.token}`, Range: "bytes=-4" } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), film.subarray(-4));
  const other = f.s.addVolume("Other");
  const outside = await f.propose("Heat (1995).mp4", film, other.id);
  await assert.rejects(
    f.call(`/v1/video/playback?${new URLSearchParams({ volume: other.id, path: "Heat (1995).mp4", hash: outside })}`),
    { status: 404 },
    "a video outside a video library does not play",
  );

  const { issueWebCode } = await import("../packages/daemon/web.js");
  const base = `http://127.0.0.1:${f.daemon.port}`;
  const login = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ code: issueWebCode(f.home).code }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const web = await (await fetch(`${base}/v1/video/playback?${query}`, { headers: { Cookie: cookie } })).json();
  assert.equal(web.url, `/v1/video/media?${query}`);
  assert.equal(web.subtitles[1].url, `/v1/video/subtitles?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995).es.srt" })}`);
  assert.equal(web.subtitles[1].path, "Heat (1995).es.srt");
  r = await fetch(base + web.url, { headers: { Cookie: cookie, Range: "bytes=0-3" } });
  assert.equal(r.status, 206);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), film.subarray(0, 4));
  r = await fetch(base + web.subtitles[0].url, { headers: { Cookie: cookie } });
  assert.match(await r.text(), /^WEBVTT/);
});

test("search finds movies, shows and episodes in a Videos group, not their files", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995).mp4", clip({ tone: 1400 }));
  await f.propose("Breaking Bad/Season 1/Breaking.Bad.S01E01.Pilot.mp4", clip({ tone: 1410 }));
  await f.settled();
  const search = (q) => f.call(`/v1/search?${new URLSearchParams({ q, limit: "10" })}`);
  let result = await search("heat");
  const group = (value, type) => value.groups.find((entry) => entry.type === type);
  assert.deepEqual(group(result, "videos").rows.map((row) => [row.kind, row.title]), [["movie", "Heat"]]);
  assert.equal(group(result, "photos"), undefined, "the video file itself is not listed again");
  result = await search("breaking");
  assert.deepEqual(group(result, "videos").rows.map((row) => [row.kind, row.title]), [["show", "Breaking Bad"], ["episode", "Pilot"]]);
  assert.equal(group(result, "videos").rows[1].showId, "s:breaking bad");
  assert.deepEqual(group(result, "videos").rows.map((row) => row.kids), [false, false]);
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: "s:breaking bad", kids: true }), { status: 400 });
  result = await search("pilot");
  assert.equal(group(result, "videos").rows[0].kids, false, "an episode follows its show, which never goes under Kids");
});

test("a database created before video gains every video table when opened", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-old-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  init(home, { port: 0 });
  new Store(home).close();
  const tables = ["video_folders", "video_items", "video_meta", "video_overrides", "video_positions", "video_watched"];
  const old = new DatabaseSync(path.join(home, "index.sqlite"));
  for (const table of tables) old.exec(`DROP TABLE ${table}`);
  old.close();
  const store = new Store(home);
  try {
    for (const table of tables) assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
  } finally {
    store.close();
  }
});

test("Erase removes the TMDB token and the video art", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/settings", { tmdbToken: "secret-token-value" });
  fs.mkdirSync(path.join(f.home, "video-art"), { recursive: true });
  fs.writeFileSync(path.join(f.home, "video-art", `${"a".repeat(64)}-small.jpg`), "x");
  await f.call("/v1/destroy-hub", { confirmed: true });
  assert.equal(fs.existsSync(path.join(f.home, "video-art")), false);
  const config = fs.readFileSync(path.join(f.home, "config.json"), "utf8");
  assert.ok(!config.includes("secret-token-value"));
});

test("a picture still rendering when Erase runs never writes into the erased installation", async (t) => {
  const f = await hub(t);
  const video = f.daemon.engine.video;
  let release;
  const input = new Promise((resolve) => (release = resolve));
  const rendering = video.renderArt("b".repeat(64), "poster", () => input);
  await f.call("/v1/destroy-hub", { confirmed: true });
  release(await image("#204060"));
  assert.equal(await rendering, null);
  assert.equal(fs.existsSync(path.join(f.home, "video-art")), false);
});

test("while the hub reads videos the library says how many are done, and nothing once finished", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const video = f.daemon.engine.video;
  const real = video.probe;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  video.probe = async (...args) => {
    if (calls++ === 1) await gate;
    return real(...args);
  };
  await f.propose("Heat (1995).mp4", clip({ tone: 1500 }));
  await f.propose("Up (2009).mp4", clip({ tone: 1510 }));
  await f.propose("Coco (2017).mp4", clip({ tone: 1520 }));
  let library;
  for (let i = 0; i < 200; i++) {
    library = await f.library();
    if (library.indexing?.done === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(library.indexing, { done: 1, total: 3 });
  assert.equal(library.matching, false);
  release();
  library = await f.settled();
  assert.equal(library.indexing, false);
});

test("a video takes only subtitles named after it, never a longer name that shares its start", async (t) => {
  assert.equal(subtitleFor("show.s01e01", "show.s01e01"), true);
  assert.equal(subtitleFor("show.s01e01.en", "show.s01e01"), true);
  assert.equal(subtitleFor("show.s01e01.en.forced", "show.s01e01"), true);
  assert.equal(subtitleFor("show.s01e01.part2.en", "show.s01e01"), false);
  assert.equal(subtitleFor("show.s01e010.en", "show.s01e01"), false);
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Show/Season 1/Show.S01E01.mp4", clip({ tone: 1600 }));
  await f.propose("Show/Season 1/Show.S01E01.Part2.mp4", clip({ tone: 1610 }));
  await f.propose("Show/Season 1/Show.S01E01.es.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nUno\n"));
  await f.propose("Show/Season 1/Show.S01E01.Part2.en.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nTwo\n"));
  await f.propose("Show/Season 1/Spanish.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nLoose\n"));
  const library = await f.settled();
  const subs = Object.fromEntries(library.shows[0].seasons[0].episodes.map((episode) => [episode.path, episode.subtitles.map((sub) => sub.path)]));
  assert.deepEqual(subs, {
    "Show/Season 1/Show.S01E01.mp4": ["Show/Season 1/Show.S01E01.es.srt"],
    "Show/Season 1/Show.S01E01.Part2.mp4": ["Show/Season 1/Show.S01E01.Part2.en.srt"],
  });
});

test("an unreadable video is probed again after one hour, six hours and a day, then left alone until it changes", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const video = f.daemon.engine.video;
  let probes = 0;
  video.probe = async () => {
    probes++;
    return null;
  };
  const hash = await f.propose("Broken (2000).mp4", Buffer.from("not really a video"));
  const realNow = Date.now;
  const retries = [];
  try {
    let offset = 0;
    for (let i = 0; i < 4; i++) {
      Date.now = () => realNow() + offset;
      video.prepare(f.v.id);
      await video.background;
      const row = f.s.db.prepare("SELECT checked,retry FROM video_items WHERE hash=?").get(hash);
      retries.push(row.retry === Number.MAX_SAFE_INTEGER ? "never" : Math.round((row.retry - Date.now()) / 3600000));
      offset = row.retry === Number.MAX_SAFE_INTEGER ? offset + 48 * 3600000 : row.retry - realNow() + 1000;
    }
    Date.now = () => realNow() + offset;
    video.prepare(f.v.id);
    await video.background;
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(retries, [1, 6, 24, "never"]);
  assert.equal(probes, 4);
});

test("the sweep forgets progress of files that no longer exist", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const hash = await f.propose("Heat (1995).mp4", clip({ tone: 1700 }));
  const keep = await f.propose("Up (2009).mp4", clip({ tone: 1710 }));
  await f.settled();
  await f.call("/v1/video/position", { volume: f.v.id, path: "Heat (1995).mp4", hash, position: 300, duration: 6000 });
  await f.call("/v1/video/watched", { volume: f.v.id, path: "Up (2009).mp4", watched: true });
  f.s.db.prepare("UPDATE files SET deleted=1 WHERE volume=? AND path=?").run(f.v.id, "Heat (1995).mp4");
  f.daemon.engine.video.sweep(true);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM video_positions WHERE path='Heat (1995).mp4'").get().n, 0);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM video_watched WHERE path='Up (2009).mp4'").get().n, 1);
  assert.ok(keep);
});

test("a video with many subtitles keeps its playback ticket, since subtitles are never ticketed", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const film = clip({ tone: 1800 });
  const hash = await f.propose("Heat (1995)/Heat (1995).mp4", film);
  for (let i = 0; i < 40; i++) await f.propose(`Heat (1995)/Subs/Heat (1995).${i}.srt`, Buffer.from(`1\n00:00:01,000 --> 00:00:02,000\nLine ${i}\n`));
  const library = await f.settled();
  assert.equal(library.movies[0].subtitles.length, 40);
  const playback = await f.call(`/v1/video/playback?${new URLSearchParams({ volume: f.v.id, path: "Heat (1995)/Heat (1995).mp4", hash })}`);
  assert.equal(playback.subtitles.length, 40);
  assert.ok(playback.subtitles.every((sub) => sub.path && !sub.url));
  assert.equal((await fetch(playback.url, { headers: { Range: "bytes=0-1" } })).status, 206);
});

test("a missing FFmpeg or local copy is not a probe failure, and given-up probes are tried again on startup", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const video = f.daemon.engine.video;
  const real = video.probe;
  video.probe = async () => undefined;
  const hash = await f.propose("Heat (1995).mp4", clip({ tone: 1900 }));
  video.prepare(f.v.id);
  await video.background;
  let row = f.s.db.prepare("SELECT checked,retry FROM video_items WHERE hash=?").get(hash);
  assert.equal(row.checked, 0, "a missing FFmpeg does not count");
  f.s.db.prepare("UPDATE video_items SET checked=-3,retry=? WHERE hash=?").run(Number.MAX_SAFE_INTEGER, hash);
  video.probe = real;
  video.quiet.clear();
  video.resume();
  await video.background;
  row = f.s.db.prepare("SELECT checked,retry FROM video_items WHERE hash=?").get(hash);
  assert.equal(row.checked, 2, "startup clears a given-up probe and reads the file again");
});

test("at most two pictures render at once and a freed slot passes straight to the next one", async (t) => {
  const f = await hub(t);
  const video = f.daemon.engine.video;
  let running = 0;
  let peak = 0;
  const jobs = Array.from({ length: 6 }, (_, index) =>
    video.renderArt(`k${index}`.padEnd(64, "0"), "poster", async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running--;
      return false;
    }),
  );
  assert.deepEqual(await Promise.all(jobs), [false, false, false, false, false, false]);
  assert.equal(peak, 2);
  assert.equal(video.renderers, 0);
  assert.deepEqual(video.renderQueue, []);
});

test("a subtitle file without a language in its name is labelled from its text, or just Subtitles", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("300 (2006)/300.2006.BluRay.1080p.x264.YIFY.mp4", clip({ tone: 2400 }));
  const english = ["I don't know what you want from me.", "They were here when the war began.", "You can't go back there, it's not safe.", "What did she say to him?", "We have been waiting for this all night.", "Tell me the truth and I will help you."];
  await f.propose("300 (2006)/300.2006.BluRay.1080p.x264.YIFY.srt", Buffer.from(english.map((line, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\n${line}\n`).join("\n")));
  await f.propose("Heat (1995)/Heat (1995).mp4", clip({ tone: 2410 }));
  await f.propose("Heat (1995)/Heat (1995).srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nOkay.\n"));
  const library = await f.settled();
  const subtitles = Object.fromEntries(library.movies.map((movie) => [movie.title, movie.subtitles.map(({ language, label }) => ({ language, label }))]));
  assert.deepEqual(subtitles, { "300": [{ language: "en", label: "English" }], Heat: [{ language: null, label: "Subtitles" }] });
});

test("the library lists a file's audio tracks and embedded subtitles with language summaries", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-streams-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const srt = path.join(scratch, "es.srt");
  fs.writeFileSync(srt, "1\n00:00:00,100 --> 00:00:00,900\nHola\n");
  const output = path.join(scratch, "film.mkv");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=5",
    "-f", "lavfi", "-i", "sine=frequency=500:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=700:duration=1",
    "-i", srt,
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
    "-c:v", "mpeg4", "-c:a:0", "aac", "-c:a:1", "ac3", "-c:s", "srt",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=spa", "-metadata:s:a:1", "title=Castellano",
    "-metadata:s:s:0", "language=spa",
    "-disposition:a:0", "0", "-disposition:a:1", "default", "-disposition:s:0", "default",
    "-shortest", output,
  ]);
  await f.propose("Heat (1995)/Heat (1995).mkv", fs.readFileSync(output));
  await f.propose("Heat (1995)/Heat (1995).en.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nHi\n"));
  const [movie] = (await f.settled()).movies;
  assert.deepEqual(movie.audioTracks, [
    { stream: 0, codec: "aac", language: "en", label: "English", channels: 1, default: false },
    { stream: 1, codec: "ac3", language: "es", label: "Spanish · Castellano", channels: 1, default: true },
  ]);
  assert.deepEqual(movie.subtitles, [
    { path: "Heat (1995)/Heat (1995).en.srt", language: "en", label: "English" },
    { embedded: true, stream: 0, language: "es", label: "Spanish", forced: false, image: false },
  ]);
  assert.deepEqual(movie.audioLanguages, ["Spanish", "English"]);
  assert.deepEqual(movie.subtitleLanguages, ["Spanish", "English"]);
  const probe = parseProbe(`Input #0, matroska,webm, from 'x':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 1 kb/s
  Stream #0:0[0x1](eng): Video: h264, yuv420p, 1920x1080, 24 fps
  Stream #0:1(jpn): Audio: truehd, 48000 Hz, 7.1, s32
    Metadata:
      title           : Japanese Atmos
  Stream #0:2(eng): Subtitle: hdmv_pgs_subtitle, 1920x1080 (forced)
  Stream #0:3(und): Subtitle: ass`);
  assert.deepEqual(probe.audioTracks, [{ stream: 0, codec: "truehd", language: "jpn", title: "Japanese Atmos", default: false, channels: 8 }]);
  assert.deepEqual(probe.subtitleStreams, [
    { stream: 0, codec: "hdmv_pgs_subtitle", language: "eng", title: null, default: false, forced: true },
    { stream: 1, codec: "ass", language: null, title: null, default: false, forced: false },
  ]);
});

test("language summaries list only real languages, never track placeholders or titles", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "arca-video-summary-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const output = path.join(scratch, "lost.mkv");
  execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120:rate=5",
    "-f", "lavfi", "-i", "sine=frequency=500:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=700:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=900:duration=1",
    "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:a",
    "-c:v", "mpeg4", "-c:a", "aac",
    "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=und", "-metadata:s:a:2", "language=und", "-metadata:s:a:2", "title=Commentary",
    "-shortest", output,
  ]);
  await f.propose("Lost/Season 1/Lost.S01E01.mkv", fs.readFileSync(output));
  await f.propose("Lost/Season 1/Lost.S01E01.srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nOkay.\n"));
  const [episode] = (await f.settled()).shows[0].seasons[0].episodes;
  assert.deepEqual(episode.audioTracks.map((track) => track.label), ["English", "Track 2", "Commentary"]);
  assert.deepEqual(episode.audioLanguages, ["English"]);
  assert.deepEqual(episode.subtitles.map((sub) => sub.label), ["Subtitles"]);
  assert.deepEqual(episode.subtitleLanguages, []);
});

test("Fix match clears the title's kids mark, a failed re-probe keeps what was read, and undetected subtitles are read once", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995).mp4", clip({ tone: 2700 }));
  await f.propose("Heat (1995).srt", Buffer.from("1\n00:00:01,000 --> 00:00:02,000\nOkay.\n"));
  let library = await f.settled();
  const [heat] = library.movies;
  await f.call("/v1/video/kids", { volume: f.v.id, id: heat.id, kids: true });
  await f.call("/v1/video/match", { volume: f.v.id, id: heat.id, none: true });
  await f.call("/v1/video/match", { volume: f.v.id, id: `o:${heat.path}`, reset: true });
  library = await f.library();
  assert.equal(library.movies[0].kids, false, "the kids mark went with the old match");
  const video = f.daemon.engine.video;
  f.s.db.prepare("UPDATE video_items SET checked=1 WHERE hash=?").run(heat.hash);
  video.probe = async () => null;
  video.quiet.clear();
  video.prepare(f.v.id);
  await video.background;
  const row = f.s.db.prepare("SELECT width,video_codec,checked FROM video_items WHERE hash=?").get(heat.hash);
  assert.deepEqual({ ...row }, { width: 320, video_codec: "mpeg4", checked: -1 });
  const reads = [];
  const real = fs.readFileSync;
  fs.readFileSync = (...args) => {
    reads.push(String(args[0]));
    return real(...args);
  };
  try {
    video.generation++;
    await f.library();
    video.generation++;
    await f.library();
  } finally {
    fs.readFileSync = real;
  }
  const subtitleHash = f.s.current(f.v.id, "Heat (1995).srt").hash;
  assert.equal(reads.filter((file) => file.endsWith(subtitleHash)).length, 0, "an undetected language is cached");
});

test("each title says whether the hub overrides its kids value", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995).mp4", clip({ tone: 2800 }));
  await f.propose("Show/Season 1/Show.S01E01.mp4", clip({ tone: 2810 }));
  await f.propose("VID_20230512_181512.mp4", clip({ tone: 2820 }));
  let library = await f.settled();
  const overrides = (value) => [value.movies[0].kidsOverride, value.shows[0].kidsOverride, value.other[0].kidsOverride];
  assert.deepEqual(overrides(library), [null, null, undefined]);
  await f.call("/v1/video/kids", { volume: f.v.id, id: library.movies[0].id, kids: true });
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: library.shows[0].id, kids: false }), { status: 400 });
  await assert.rejects(f.call("/v1/video/kids", { volume: f.v.id, id: library.other[0].id, kids: true }), { status: 400 });
  library = await f.library();
  assert.deepEqual(overrides(library), [true, null, undefined], "only a movie carries a kids override");
  await f.call("/v1/video/kids", { volume: f.v.id, id: library.movies[0].id, kids: null });
  assert.equal((await f.library()).movies[0].kidsOverride, null);
});

test("a subtitle without a hub object is read from the video folder in place", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  await f.propose("Heat (1995)/Heat (1995).mp4", clip({ tone: 2900 }));
  const english = ["I don't know what you want from me.", "They were here when the war began.", "You can't go back there, it's not safe.", "What did she say to him?", "We have been waiting for this all night.", "Tell me the truth and I will help you."];
  const text = Buffer.from(english.map((line, i) => `${i + 1}\n00:00:0${i},000 --> 00:00:0${i},500\n${line}\n`).join("\n"));
  const hash = await f.propose("Heat (1995)/Heat (1995).srt", text);
  await f.daemon.engine.cycle();
  fs.rmSync(f.s.blob(hash));
  f.daemon.engine.video.generation++;
  const library = await f.settled();
  assert.deepEqual(library.movies[0].subtitles.map(({ language, label }) => ({ language, label })), [{ language: "en", label: "English" }]);
});

test("continuity: a movie started on the TV resumes from the same point on every other device", async (t) => {
  const f = await hub(t);
  await f.call("/v1/video/mark", { volume: f.v.id });
  const hash = await f.propose("Heat (1995)/Heat (1995).mp4", clip({ tone: 1300, seconds: 2 }));
  await f.settled();
  const tv = await pairPlayer(f);
  const phone = await f.call("/v1/devices", { name: "Phone", role: "replica" });
  const before = await f.library("", phone.token);
  const [movie] = before.movies;
  assert.equal(movie.position, null);
  await f.call("/v1/video/position", { volume: f.v.id, path: movie.path, hash, position: 1800, duration: 6000 }, tv.token);
  const cached = await f.library(`&version=${before.version}`, phone.token);
  assert.notEqual(cached.unchanged, true, "a phone holding the old list is told it changed");
  for (const [who, token] of [["phone", phone.token], ["hub", undefined], ["tv", tv.token]]) {
    const seen = await f.library("", token);
    assert.equal(seen.movies[0].position.position, 1800, `${who} resumes from the TV's point`);
    assert.ok(seen.continue.includes(movie.id), `${who} lists it in continue`);
  }
  await f.call("/v1/video/position", { volume: f.v.id, path: movie.path, hash, position: 2400, duration: 6000 }, phone.token);
  assert.equal((await f.library("", tv.token)).movies[0].position.position, 2400, "and the TV picks up where the phone left it");
});

test("subtitle and .nfo parsing stays linear on hostile files", () => {
  const time = (work) => {
    const started = performance.now();
    work();
    return performance.now() - started;
  };
  assert.ok(time(() => subtitleText(Buffer.from("{\\".repeat(1024 * 1024)), "srt")) < 200, "2 MiB of unclosed {\\ tags");
  assert.ok(time(() => subtitleText(Buffer.from("<font ".repeat(349525)), "srt")) < 200, "2 MiB of unclosed <font tags");
  assert.ok(time(() => subtitleText(Buffer.from("1:1:1,1" + " ".repeat(2 * 1024 * 1024)), "srt")) < 200, "a timestamp followed by 2 MiB of spaces");
  for (const tag of ["<title>", "<title ", "<uniqueid type=\"tmdb\">", "<set>", "<![CDATA["])
    assert.ok(time(() => parseNfo(tag.repeat(Math.floor((256 * 1024) / tag.length)))) < 200, `256 KiB of unclosed ${tag}`);
  assert.ok(time(() => parseNfo(`<set>${"<name>".repeat(40000)}</set>`)) < 200, "unclosed names inside a set");
  assert.equal(parseNfo("<movie><title><![CDATA[Heat]]></title><set><name>Heat Collection</name></set><uniqueid type=\"tmdb\"> 949 </uniqueid></movie>").tmdb, 949);
  assert.equal(parseNfo("<movie><TITLE>Heat</TITLE><title>Ignored</title></movie>").title, "Heat", "tags match in any case, first wins");
  assert.ok(time(() => parseNfo("<title ".repeat(37449))) < 200);
});

test(".nfo tags keep their positions around characters whose lower case is longer, and the first numeric TMDB id wins", () => {
  const nfo = parseNfo(`<movie><plot>İİİ İzmir</plot><title>İstanbul Hatırası</title><year>2010</year><uniqueid type="tmdb">abc</uniqueid><uniqueid type="tmdb">12</uniqueid></movie>`);
  assert.equal(nfo.title, "İstanbul Hatırası");
  assert.equal(nfo.plot, "İİİ İzmir");
  assert.equal(nfo.year, 2010);
  assert.equal(nfo.tmdb, 12);
});

test("a subtitle's language comes from its first 64 KiB of text, decoded whole first", () => {
  const english = "1\n00:00:01,000 --> 00:00:02,000\n" + "the and you that was for are with his they this have from not but what\n".repeat(40);
  const spanish = "1\n00:00:01,000 --> 00:00:02,000\n" + "qué está más aquí también cuando todo esto bien pero eso nada\n".repeat(40);
  assert.equal(subtitleLanguage(Buffer.from(english), "srt"), "en");
  assert.equal(subtitleLanguage(Buffer.from("é".repeat(70000) + "\n\n" + english), "srt"), null, "text past 64 KiB is never read");
  assert.equal(subtitleLanguage(Buffer.from(spanish + "\n\n" + "é".repeat(40000)), "srt"), "es", "a cut never garbles accented words before it");
});
