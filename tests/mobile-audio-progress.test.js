import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLibrary,
  episodeCaption,
  episodeDate,
  folderContext,
  formatDay,
  formatLength,
  isEpisode,
  musicSheet,
  musicTabs,
  nativeLibrary,
  orderShows,
  searchLibrary,
  shortDay,
  showRows,
  showSummary,
  showTile,
  trackContext,
  trackNodeId,
  upNext,
} from "../apps/mobile/src/music-library.js";
import {
  forget,
  fraction,
  isFinished,
  playedRow,
  positionMap,
  positionSignature,
  remember,
  resumeCandidate,
  savedPosition,
  progressSignature,
  syncedPositions,
  timeLeft,
  trackFile,
} from "../apps/mobile/src/audio-positions.js";
import {
  SLEEP_OFF,
  sleepClock,
  sleepLabel,
  sleepOptions,
  sleepRemaining,
} from "../apps/mobile/src/sleep-timer.js";
import { mergeHubPositions, singleFlight, startPositionRefresh } from "../apps/mobile/src/audio-refresh.js";
import { folderSections } from "../apps/mobile/src/home-data.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "mobile", "src");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const row = (file, tags = {}) => ({
  path: file,
  hash: `h-${file}`,
  title: null,
  artist: null,
  albumArtist: null,
  album: null,
  genre: null,
  duration: null,
  cover: null,
  added: null,
  ...tags,
});
const folder = (id, tracks, present = null) => ({
  id,
  uri: (file) => `file:///arca/${id}/${file}`,
  library: { version: "v", tracks },
  present: present || new Map(tracks.map((track) => [track.path, track.hash])),
});

const mixed = () =>
  buildLibrary([
    folder("a1", [
      row("Miles/Kind of Blue/01 So What.flac", { title: "So What", artist: "Miles Davis", album: "Kind of Blue", track: 1, duration: 562 }),
      row("Podcasts/The Wild Project/2026-10-01 #385.mp3", { title: "#385", album: "The Wild Project", genre: "Podcast", artist: "The Wild Project", duration: 4200, cover: "w1" }),
      row("Podcasts/The Wild Project/2026-10-08 #386.mp3", { title: "#386", album: "The Wild Project", genre: "podcast", duration: 5400 }),
      row("Podcasts/WORLDCAST/2026-09-24 Energy.mp3", { title: "Energy", duration: 4800 }),
      row("Podcasts/WORLDCAST/2026-10-09 Late.mp3", { title: "Late", duration: 4800 }),
      row("Talks/short.mp3", { title: "Short untagged", duration: 600 }),
    ]),
  ]);

test("episodes are Podcast-genre tracks or long tracks without an artist, grouped by show newest first", () => {
  assert.equal(isEpisode({ genre: "Podcast", artist: "X", duration: 60 }), true);
  assert.equal(isEpisode({ duration: 1200 }), true);
  assert.equal(isEpisode({ duration: 1199 }), false);
  assert.equal(isEpisode({ albumArtist: "Someone", duration: 4000 }), false);
  const library = mixed();
  assert.equal(library.albums.size, 2, "Kind of Blue and the short untagged track stay music");
  assert.ok(![...library.albums.values()].some((album) => album.title === "The Wild Project"));
  assert.ok(!library.artists.some((artist) => artist.name === "The Wild Project"), "shows are not artists");
  const shows = library.showOrder.map((id) => library.shows.get(id));
  assert.deepEqual(shows.map((show) => show.name), ["WORLDCAST", "The Wild Project"], "the show with the newest episode first");
  const wild = shows[1];
  assert.deepEqual(wild.tracks.map((id) => library.tracks.get(id).title), ["#386", "#385"], "episodes newest first");
  assert.equal(wild.cover, "w1", "the show takes the first episode artwork");
  assert.equal(library.tracks.get(wild.tracks[0]).date, "2026-10-08");
  assert.equal(library.tracks.get(wild.tracks[0]).artist, "The Wild Project", "an episode reads its show, never Unknown artist");
  assert.equal(library.tracks.get(wild.tracks[0]).hash, "h-Podcasts/The Wild Project/2026-10-08 #386.mp3");
  assert.equal(shows[0].name, "WORLDCAST", "an untagged episode belongs to its parent folder");
  assert.equal(showSummary(wild), "2 episodes · 2 h 40 min");
  const now = new Date(2026, 9, 10, 12);
  assert.deepEqual(showTile(wild, library, new Map(), now), { day: "Oct 8", fresh: true, caption: "New · Oct 8", progress: null, resume: null, left: null }, "a show whose newest episode is under a week old and unplayed is New");
  assert.deepEqual(showTile(wild, library, new Map(), new Date(2026, 9, 16, 12)).caption, "Oct 8", "after a week only the day stays");
  assert.equal(showTile(wild, library, new Map(), new Date(2027, 0, 2)).caption, "Oct 8, 2026", "the year only outside the current year");
  const [newest, older] = wild.tracks.map((id) => library.tracks.get(id));
  const playedNewest = positionMap([{ volume: newest.folder, path: newest.path, hash: newest.hash, position: 1200, duration: 4800, updated: 1 }]);
  const newestTile = showTile(wild, library, playedNewest, now);
  assert.deepEqual(
    { ...newestTile, resume: newestTile.resume.track },
    { day: "Oct 8", fresh: false, caption: "1 h 0 min left", progress: 0.25, resume: newest, left: "1 h 0 min left" },
    "a saved position on the newest episode is not New, draws the edge and reads the time left",
  );
  const playedOlder = positionMap([{ volume: older.folder, path: older.path, hash: older.hash, position: 600, duration: 2400, updated: 1 }]);
  const olderTile = showTile(wild, library, playedOlder, now);
  assert.deepEqual(
    [olderTile.caption, olderTile.fresh, olderTile.progress, olderTile.resume.track],
    ["30 min left", false, 0.25, older],
    "an older episode in progress gives the tile its play and time left",
  );
  const finishedNewest = positionMap([], [{ volume: newest.folder, path: newest.path, hash: newest.hash, updated: 2 }]);
  assert.deepEqual(showTile(wild, library, finishedNewest, now), { day: "Oct 8", fresh: false, caption: "Oct 8", progress: null, resume: null, left: null }, "a finished newest episode is played: not New, and never resumable");
  assert.equal(shortDay("2026-03-04", now), "Mar 4");
  assert.equal(shortDay(null, now), "");
  assert.equal(trackContext(library.tracks.get(wild.tracks[0])), wild.id);
});

test("an episode date comes from the YYYY-MM-DD filename prefix and lengths read in hours and minutes", () => {
  assert.equal(episodeDate(path.join("a", "2026-10-08 #386.mp3").split(path.sep).join("/")), "2026-10-08");
  assert.equal(episodeDate("Show/2026-10-081.mp3"), null);
  assert.equal(episodeDate("Show/Episode 2026-10-08.mp3"), null);
  assert.equal(formatDay("2026-10-08"), "Oct 8, 2026");
  assert.equal(formatDay(null), "");
  assert.equal(formatLength(5400), "1 h 30 min");
  assert.equal(formatLength(2520), "42 min");
  assert.equal(formatLength(0), "");
});

test("an episode row reads date and length on its second line until it is started, then the date alone", () => {
  const episode = { title: "#384 · El futuro de la energía nuclear en Europa", artist: "The Wild Project", date: "2026-09-24", duration: 4800 };
  assert.equal(episodeCaption(episode, false, false), "Sep 24, 2026 · 1 h 20 min");
  assert.equal(episodeCaption(episode, false, true), "Sep 24, 2026", "a started episode leaves the time to its time left");
  assert.equal(episodeCaption(episode, true, false), "The Wild Project · Sep 24, 2026 · 1 h 20 min", "in a playlist it names its show first");
  assert.equal(episodeCaption({ ...episode, date: null }, false, false), "The Wild Project · 1 h 20 min", "an undated episode falls back to its show");
  assert.equal(episodeCaption({ ...episode, duration: 0 }, false, false), "Sep 24, 2026");
  assert.equal(episodeCaption(episode, true, true), "The Wild Project · Sep 24, 2026", "a started episode in a playlist keeps its show and date only");
  assert.equal(episodeCaption({ ...episode, date: null, duration: 0 }, false, false), "The Wild Project");
});

test("the Podcasts tab joins the music tabs and is the only tab of a library without music", () => {
  assert.deepEqual(musicTabs(mixed()), ["artists", "albums", "recent", "podcasts"]);
  const onlyShows = buildLibrary([folder("p", [row("Show/2026-01-01 One.mp3", { genre: "Podcast", album: "Show", duration: 3000 })])]);
  assert.deepEqual(musicTabs(onlyShows), ["podcasts"]);
  const onlyMusic = buildLibrary([folder("m", [row("A/B/01.flac", { artist: "A", album: "B", duration: 200 })])]);
  assert.deepEqual(musicTabs(onlyMusic), ["artists", "albums", "recent"]);
});

test("shows reach the native player as queues so an episode plays on through its show", () => {
  const library = mixed();
  const native = nativeLibrary(library, "scope");
  const show = library.shows.get(library.showOrder[1]);
  assert.deepEqual(native.shows.find((item) => item.id === show.id), { id: show.id, title: show.name, cover: show.cover, tracks: show.tracks });
  assert.ok(!native.albums.some((album) => album.id.startsWith("show:")), "shows leave the car's Albums tab");
  assert.ok(!native.artists.some((artist) => artist.name === show.name));
  const queue = upNext(library, { id: trackNodeId(folderContext("a1", show.id), show.tracks[0], 0) });
  assert.equal(queue.name, "The Wild Project");
  assert.equal(queue.show, show);
  assert.deepEqual(queue.rows.map((entry) => entry.track.id), [show.tracks[1]]);
  assert.ok(searchLibrary(library, "#386").episodes.includes(show.tracks[0]), "episodes are found by search");
});

test("a show keeps episodes still downloading in its rows and plays only those on the phone", () => {
  const tracks = [
    row("S/2026-01-02 B.mp3", { genre: "Podcast", album: "S", duration: 3000 }),
    row("S/2026-01-01 A.mp3", { genre: "Podcast", album: "S", duration: 3000 }),
  ];
  const library = buildLibrary([folder("p", tracks, new Map([[tracks[1].path, tracks[1].hash]]))]);
  const show = library.shows.get(library.showOrder[0]);
  assert.equal(show.rows.length, 2);
  assert.equal(show.tracks.length, 1);
  assert.deepEqual(showRows(library, show).map((item) => item.state), ["pending", "ready"]);
  assert.equal(musicSheet({ kind: "track-actions", track: library.tracks.get(show.tracks[0]) }).subtitle, "S · Jan 1, 2026");
});

test("play on a paused episode reaches the native player untouched, which alone decides on a newer synced place", () => {
  const session = read("audio-session.js");
  assert.doesNotMatch(session, /command\("seek"|const toggle|touched|syncedSeek/, "the app never seeks before play; the service sees every play, seek and restart");
  const app = read("App.jsx");
  assert.match(app, /function musicCommand\(name, value\) \{\s+player\.command\(name, value\)\.catch/);
  assert.match(app, /if \(at === null\) \{\s+runLocal\(async \(\) => \{\s+const state = await player\.command\("state"\);\s+if \(!state\?\.playing && !state\?\.playWhenReady\) await player\.command\("toggle"\);/);
  assert.match(read("MusicLibrary.jsx"), /play\(context, track, false, row\.position, current && track\.podcast \? null : saved\?\.position \|\| 0\)/, "tapping the loaded episode continues it instead of restarting it");
  assert.match(app, /if \(engine\.current && audio\.loaded\) publishSynced\(engine\.current, audio\.positions, connection\?\.id \?\? null\)/);
  const episodes = new Map([["a1:Show/ep.mp3", "h"], ["a1:Show/new.mp3", "h2"]]);
  const positions = positionMap([
    { volume: "a1", path: "Show/ep.mp3", hash: "h", position: 3480.2, duration: 4200, updated: 2000 },
    { volume: "a1", path: "Show/new.mp3", hash: "changed", position: 900, duration: 4200, updated: 2000 },
    { volume: "a1", path: "Mix/long.mp3", hash: "m", position: 900, duration: 4200, updated: 2000 },
  ]);
  assert.deepEqual(syncedPositions(positions, episodes, "hub").tracks, { "a1:Show/ep.mp3": { position: 3480200, updated: 2000 } }, "only podcast episodes whose copy matches reach the service");
  const own = positionMap([{ volume: "a1", path: "Show/ep.mp3", hash: "h", position: 3480.2, duration: 4200, updated: 2000, device: "phone" }]);
  assert.deepEqual(syncedPositions(own, episodes, "hub", "phone").tracks, {}, "this phone's own save is never another device's place");
  assert.equal(Object.keys(syncedPositions(own, episodes, "hub", "mac").tracks).length, 1);
});

test("the car gets every podcast episode's completion: partly played with a percentage, finished, and this phone's own saves", () => {
  const episodes = new Map([["a1:Show/a.mp3", "ha"], ["a1:Show/b.mp3", "hb"], ["a1:Show/c.mp3", "hc"], ["a1:Show/d.mp3", "hd"]]);
  const positions = positionMap(
    [
      { volume: "a1", path: "Show/a.mp3", hash: "ha", position: 1050, duration: 4200, updated: 2000, device: "phone" },
      { volume: "a1", path: "Show/b.mp3", hash: "stale", position: 900, duration: 4200, updated: 3000 },
      { volume: "a1", path: "Show/d.mp3", hash: "hd", position: 4190, duration: 4200, updated: 1000 },
      { volume: "a1", path: "Mix/long.mp3", hash: "m", position: 900, duration: 4200, updated: 5000 },
    ],
    [{ volume: "a1", path: "Show/c.mp3", hash: "hc", updated: 4000 }],
  );
  const synced = syncedPositions(positions, episodes, "hub", "phone");
  assert.deepEqual(synced.tracks, { "a1:Show/d.mp3": { position: 4190000, updated: 1000 } }, "resume keeps its own-device rule");
  assert.deepEqual(synced.progress, {
    "a1:Show/a.mp3": { state: "partial", percent: 25, position: 1050000, updated: 2000 },
    "a1:Show/c.mp3": { state: "full", updated: 4000 },
    "a1:Show/d.mp3": { state: "partial", percent: 99, position: 4190000, updated: 1000 },
  });
  assert.equal(syncedPositions(new Map(), episodes, "hub").progress && Object.keys(syncedPositions(new Map(), episodes, "hub").progress).length, 0);
});

test("the car list refreshes only when a badge bucket, a finish or the Continue episode changes", () => {
  const episodes = new Map([["a1:Show/a.mp3", "ha"], ["a1:Show/b.mp3", "hb"]]);
  const sign = (a, b) =>
    progressSignature(
      syncedPositions(
        positionMap([
          { volume: "a1", path: "Show/a.mp3", hash: "ha", position: a.position, duration: 4200, updated: a.updated },
          ...(b ? [{ volume: "a1", path: "Show/b.mp3", hash: "hb", position: b.position, duration: 4200, updated: b.updated }] : []),
        ]),
        episodes,
        "hub",
      ),
    );
  const base = sign({ position: 1050, updated: 1 });
  assert.equal(sign({ position: 1060, updated: 2 }), base, "a few seconds of playing never refresh the car");
  assert.notEqual(sign({ position: 1500, updated: 2 }), base);
  assert.notEqual(sign({ position: 1050, updated: 1 }, { position: 60, updated: 9 }), base, "a newer Continue episode does");
});

test("a show's play resumes only an episode the phone holds", () => {
  const tracks = [
    row("Podcasts/The Wild Project/2026-10-01 #385.mp3", { title: "#385", album: "The Wild Project", genre: "Podcast", duration: 4200 }),
    row("Podcasts/The Wild Project/2026-10-08 #386.mp3", { title: "#386", album: "The Wild Project", genre: "Podcast", duration: 5400 }),
  ];
  const library = buildLibrary([folder("a1", tracks, new Map([[tracks[0].path, tracks[0].hash]]))]);
  const show = library.shows.values().next().value;
  const [ready, pending] = show.rows.map((id) => library.tracks.get(id) || library.pending.get(id)).sort((a, b) => a.title.localeCompare(b.title));
  const now = new Date(2026, 9, 10, 12);
  const onlyPending = positionMap([{ volume: "a1", path: pending.path, hash: pending.hash, position: 600, duration: 5400, updated: 2 }]);
  assert.equal(showTile(show, library, onlyPending, now).resume, null, "an episode still downloading offers no play");
  const both = positionMap([
    { volume: "a1", path: pending.path, hash: pending.hash, position: 600, duration: 5400, updated: 2 },
    { volume: "a1", path: ready.path, hash: ready.hash, position: 300, duration: 4200, updated: 1 },
  ]);
  assert.equal(showTile(show, library, both, now).resume.track, ready, "the newest progress on a downloaded episode wins");
});

test("saved positions show time left and progress, and the resume card offers the newest one not playing", () => {
  assert.equal(timeLeft(4500), "1 h 15 min left");
  assert.equal(timeLeft(2520), "42 min left");
  assert.equal(timeLeft(5), "1 min left");
  assert.equal(fraction(900, 3600), 0.25);
  assert.deepEqual(trackFile("vol:Podcasts/a:b.mp3"), { volume: "vol", path: "Podcasts/a:b.mp3" });
  const library = mixed();
  const [newer, older] = library.shows.get(library.showOrder[1]).tracks.map((id) => library.tracks.get(id));
  const positions = positionMap([
    { volume: "a1", path: older.path, hash: older.hash, position: 1680, duration: 4200, device: "d2", name: "macbook-pro", updated: 2 },
    { volume: "a1", path: newer.path, hash: newer.hash, position: 900, duration: 5400, device: "d1", name: "Android", updated: 1 },
    { volume: "a1", path: "gone.mp3", hash: "x", position: 900, duration: 5400, updated: 9 },
    { volume: "other", path: newer.path, hash: newer.hash, position: 900, duration: 5400, updated: 10 },
    { volume: "a1", path: "broken.mp3" },
  ]);
  assert.equal(positions.size, 4);
  assert.equal(savedPosition(positions, newer).position, 900);
  assert.equal(savedPosition(positions, { ...newer, hash: "changed" }), null, "a changed file starts over");
  assert.equal(resumeCandidate(positions, library, "a1").track, older, "the newest position from any device");
  assert.equal(resumeCandidate(positions, library, "a1", older.id).track, newer, "while the newest item plays the card offers the next one, as on the desktop");
  assert.equal(resumeCandidate(positionMap([positions.get(`a1\0${older.path}`)]), library, "a1", older.id), null, "and nothing when only the playing item is saved");
  assert.equal(resumeCandidate(positions, library, "a1", null, (track) => track.id !== older.id).track, newer, "a filter skips to the newest accepted item");
  const next = remember(positions, { volume: "a1", path: older.path, hash: older.hash, position: 4150, duration: 4200 }, { id: "d1", name: "Android" }, 5);
  assert.equal(savedPosition(next, older), null, "the last minute clears the position");
  assert.deepEqual([playedRow(next, older).finished, playedRow(next, older).position, playedRow(next, older).updated], [true, 0, 5], "and keeps a finished mark with its time");
  assert.equal(resumeCandidate(next, library, "a1").track, newer, "a finished item is never offered");
  const kept = remember(positions, { volume: "a1", path: older.path, hash: older.hash, position: 2000, duration: 4200 }, { id: "d1", name: "Android" }, 5);
  assert.deepEqual(savedPosition(kept, older), { volume: "a1", path: older.path, hash: older.hash, position: 2000, duration: 4200, device: "d1", name: "Android", updated: 5 });
});

test("the sleep timer offers 30 minutes, 1 hour and the end of the item, and labels what the service reports", () => {
  assert.deepEqual(sleepOptions(true).map((option) => option.label), ["30 minutes", "1 hour", "End of episode"]);
  assert.deepEqual(sleepOptions(false).map((option) => option.label), ["30 minutes", "1 hour", "End of track"]);
  const half = { mode: "duration", value: "30", endsAt: 1000 + 30 * 60000 };
  assert.equal(sleepRemaining(half, 1000), 30 * 60000);
  assert.equal(sleepLabel(half, 1000 + 19000), "29:41");
  assert.equal(sleepClock(3600000), "1:00:00");
  const end = { mode: "end", value: "end" };
  assert.equal(sleepLabel(end, 1000), "End of episode");
  assert.equal(sleepLabel(end, 1000, false), "End of track");
  assert.equal(sleepRemaining(end, 1000), null);
  assert.equal(sleepLabel(SLEEP_OFF, 1000), "");
});

test("Folders splits selected folders into Folders, Photos, Audio and Movies & TV, leaving out empty sections", () => {
  const kinds = { a: "folders", b: "audio", c: "photos", d: "audio", e: "video" };
  const sections = folderSections(["a", "b", "c", "d", "e"].map((id) => ({ id })), (f) => kinds[f.id]);
  assert.deepEqual(sections.map((section) => [section.label, section.folders.map((f) => f.id)]), [
    ["FOLDERS", ["a"]],
    ["PHOTOS", ["c"]],
    ["AUDIO", ["b", "d"]],
    ["MOVIES & TV", ["e"]],
  ]);
  assert.deepEqual(folderSections([{ id: "b" }], (f) => kinds[f.id]).map((section) => section.kind), ["audio"]);
});

test("the phone reads hub positions with its device credential and leaves saving and the sleep timer to the service", () => {
  const session = read("audio-session.js");
  assert.match(session, /api\("\/v1\/audio-positions"\)/);
  assert.match(session, /send: \(body\) => deps\.current\.api\("\/v1\/audio-position", body\)/, "queued positions reach the hub through the drain");
  assert.match(session, /native\.addListener\("musicState"/);
  assert.doesNotMatch(session, /sleepCheck|startSleep|sleepRef|positionToSave|shouldSave|toggle|lookup|seeked/, "the app runs no timer and makes no save decision of its own");
  const app = read("App.jsx");
  assert.match(app, /const audio = useAudioSession\(\{\s+enabled: !!connected,\s+watching: musicFolder && screen === "Folders" && !status\.offline,\s+api: \(route, body\) => client\.api\(route, body\),\s+device: \{ id: connection\?\.id \?\? null, name \},\s+scope: \(\) => engine\.current\?\.scope,/);
  assert.match(app, /if \(at > 0\) await player\.command\("seek", at \* 1000\);/, "a saved row resumes where it stopped");
  assert.match(app, /positions=\{audio\.positions\}\s+loaded=\{audio\.loaded\}\s+command=\{musicCommand\}\s+deviceId=\{connection\?\.id\}/);
  assert.match(session, /const \{ positions: rows, finished \} = await deps\.current\.api\("\/v1\/audio-positions"\);\s+const next = apply\(\(current\) => mergeHubPositions\(current, rows, finished, deps\.current\.device\.id\)\);\s+setLoaded\(positionSignature\(next\)\);/, "the hub's finished marks join the positions and each load is signed");
  assert.match(app, /sleep=\{audio\.sleep\}\s+setSleep=\{audio\.setSleep\}\s+positions=/);
});

test("the library draws progress, the resume card, the Podcasts tab and a track Delete…", () => {
  const library = read("MusicLibrary.jsx");
  assert.match(library, /<Eyebrow>Pick up where you left off<\/Eyebrow>/);
  assert.match(library, /label="Continue" icon="play" onPress=\{\(\) => start\(row\.position\)\}/);
  assert.match(library, /label="Start over" icon="rotate-ccw" onPress=\{\(\) => start\(0\)\}/);
  assert.match(library, /route\.length === 1 && tab !== "podcasts"\s+\? resumeCandidate\(positions, library, folderId, playing\)/, "the podcasts root has no resume card");
  assert.doesNotMatch(library, /ContinueTile|track\.podcast\)/, "the podcasts root has no Continue tile");
  assert.match(library, /item\.kind === "podcasts"\) \{\s+const shows = \(order \|\| library\.showOrder\)\.map[\s\S]*?<ShowGrid\s+memory=\{memory\}\s+shows=\{shows\}/, "shows render as the cover grid in order c");
  assert.match(library, /episodes\s+flat=\{flat\}\s+\/>/, "a show page plays episodes without Shuffle");
  assert.match(library, /canPlay && tracks\.length > 1 && !episodes && \(/);
  assert.match(library, /label="Delete…"\s+icon="trash"\s+danger\s+disabled=\{locked\}\s+onPress=\{\(\) => removeTrack\(sheet\.track\)\}/);
  assert.match(library, /<View style=\{s\.miniProgress\} pointerEvents="none">/, "the mini player draws progress on its bottom edge");
  assert.match(library, /<Icon name="moon" size=\{14\} color=\{c\.accent\} \/>/, "and the moon with the countdown while the timer runs");
  const app = read("App.jsx");
  assert.match(app, /confirmCopy\.deleteTrack\(track\.title, /);
  assert.match(app, /await engine\.current\.removeFile\(track\.folder, track\.path\);/, "through the phone's synchronized file delete");
});

test("every show in progress carries its own play, time left and resume sheet; there is no Continue tile", () => {
  const library = read("MusicLibrary.jsx");
  const theme = read("theme.js");
  const grid = library.slice(library.indexOf("function ShowPlay("), library.indexOf("function AlbumGrid("));
  assert.match(grid, /<Text numberOfLines=\{2\} style=\{s\.rowTitle\}>\s+\{show\.name\}/, "the name on two lines");
  assert.match(grid, /tile\.progress != null && <ProgressLine value=\{tile\.progress\} edge \/>\}\s+\{tile\.fresh && \(\s+<View style=\{s\.newPill\} pointerEvents="none">\s+<Text style=\{s\.newPillText\}>New<\/Text>\s+<\/View>\s+\)\}\s+<\/View>/, "a New show carries the pill inside its cover");
  assert.match(grid, /const line = tile\.fresh \? tile\.day : tile\.caption;[\s\S]*?\{!!line && \(\s+<Text numberOfLines=\{1\} style=\{s\.caption\}>\s+\{line\}/, "its caption keeps only the day");
  assert.match(grid, /accessibilityLabel=\{tile\.caption \? `\$\{show\.name\}, \$\{tile\.caption\}` : show\.name\}/, "TalkBack still hears New");
  assert.doesNotMatch(grid, /newWord/);
  assert.match(theme, /newPill: \{\s+position: "absolute",\s+top: 6,\s+left: 6,\s+paddingVertical: g\.pillY,\s+paddingHorizontal: g\.pillLeft,\s+borderRadius: g\.pillRadius,\s+backgroundColor: c\.surface,\s+\}/, "the pill sits at the play button's 6 dp inset with surface fill");
  assert.match(theme, /newPillText: \{\s+fontFamily: "InstrumentSans_600SemiBold",\s+fontSize: g\.pillFont,\s+lineHeight: g\.pillLine,\s+color: c\.accent,/, "and accent ink at the pill size");
  assert.match(grid, /tile\.progress != null && <ProgressLine value=\{tile\.progress\} edge \/>/, "a show in progress draws the edge");
  assert.match(grid, /accessibilityLabel=\{`\$\{show\.name\}, \$\{tile\.left\}`\}/, "the tile reads its time left");
  assert.match(grid, /\{ name: "continue", label: "Continue" \},\s+\{ name: "startover", label: "Start over" \},[\s\S]*?\{ name: "favorite", label: favorite\.label \}/, "TalkBack offers Continue, Start over and the favorite toggle");
  assert.match(grid, /onPress=\{press\}\s+onLongPress=\{more\}/, "a long press opens the resume sheet");
  assert.match(grid, /\{canPlay && \(\s+<View style=\{s\.showPlaySlot\} pointerEvents="box-none">\s+<ShowPlay/, "the play is its own control over the cover, only where the phone plays");
  assert.match(grid, /accessibilityLabel=\{`\$\{playing \? "Pause" : "Continue"\} \$\{item\.track\.title\}`\}\s+hitSlop=\{6\}/, "named after the episode, with a 48 dp target");
  assert.match(grid, /onPress=\{\(\) => \(loaded \? toggle\(\) : resume\(item\.row\.position\)\)\}/, "the loaded episode's button mirrors the player instead of restarting it");
  assert.match(grid, /<Icon name=\{playing \? "pause" : "play"\}/);
  assert.match(grid, /if \(!item\)\s+return \(\s+<Pressable\s+\{\.\.\.hold\}/, "shows without progress keep the favorite long press and no play");
  assert.match(grid, /split && s\.musicAlbumSplit/, "the Fold split keeps three per row");
  assert.match(grid, /selected && s\.musicTileSelected/);
  assert.match(grid, /usePaged\(`\$\{memory\}:shows`, 60, 60\)/);
  assert.match(theme, /continuePlay: \{\s+position: "absolute",\s+right: 6,\s+bottom: 8,\s+width: 36,\s+height: 36,/);
  assert.match(theme, /showPlaySlot: \{ position: "absolute", top: 0, left: 0, right: 0, aspectRatio: 1 \}/, "the play sits on the square cover");
  assert.match(theme, /musicAlbum: \{ width: wide \? "18%" : "30\.5%", gap: 4 \}/, "five across the Fold root, three on the phone");
  assert.match(theme, /musicAlbumSplit: \{ width: "30\.5%" \}/);
  assert.match(library, /label="Continue"\s+icon="play"[\s\S]*?label="Start over"\s+icon="rotate-ccw"[\s\S]*?label="Open show"[\s\S]*?favorite\.has\(sheet\.favorite\) \? "Remove from Favorites" : "Add to Favorites"/, "the sheet offers Continue, Start over, Open show and the favorite toggle");
  assert.match(library, /entry\.track\.id === playing && at > 0\s+\? player\s+\.command\("state"\)\s+\.then\(\(state\) => !isPlaying\(state\) && command\("toggle"\)\)/, "Continue on the loaded episode only resumes it");
  assert.deepEqual(
    musicSheet({ kind: "resume-actions", show: { name: "The Wild Project" }, track: { title: "#385", artist: "The Wild Project" }, row: { position: 1680, duration: 4200 } }),
    { title: "The Wild Project", icon: "podcast", subtitle: "#385 · 42 min left", menu: true },
  );
  assert.match(read("App.jsx"), /resumeActions=\{\(value\) =>\s+setSheet\(\{ kind: "resume-actions", \.\.\.value \}\)/);
  assert.doesNotMatch(library, /showCaption|showRow\b|ContinueTile/);
});

test("shows follow order c: in progress by last played, then New by newest, then the rest, recomputed only on open and reload", () => {
  const day = (offset) => {
    const date = new Date(Date.UTC(2026, 9, 10 - offset, 12));
    return date.toISOString().slice(0, 10);
  };
  const shows = [
    ["Lex Fridman Podcast", 1],
    ["Al Corte", 2],
    ["The Wild Project", 2],
    ["Julian Dorey Podcast", 3],
    ["La Escobula", 7],
    ["Salud en la radio", 10],
    ["Acquired", 19],
    ["Hardcore History", 69],
  ];
  const library = buildLibrary([
    folder(
      "p",
      shows.flatMap(([name, offset]) => [
        row(`${name}/${day(offset)} New.mp3`, { genre: "Podcast", album: name, duration: 6000 }),
        row(`${name}/${day(offset + 30)} Old.mp3`, { genre: "Podcast", album: name, duration: 6000 }),
      ]),
    ),
  ]);
  const byName = new Map([...library.shows.values()].map((show) => [show.name, show]));
  const episode = (name, index) => library.tracks.get(byName.get(name).rows[index]);
  const at = (name, index, extra) => {
    const track = episode(name, index);
    return { volume: "p", path: track.path, hash: track.hash, ...extra };
  };
  const positions = positionMap(
    [
      at("The Wild Project", 0, { position: 900, duration: 6000, updated: 300 }),
      at("Acquired", 0, { position: 600, duration: 6000, updated: 200 }),
      at("Salud en la radio", 1, { position: 3000, duration: 6000, updated: 100 }),
      at("La Escobula", 0, { position: 0, duration: 6000, updated: 50 }),
    ],
    [at("Al Corte", 0, { updated: 400 })],
  );
  const now = new Date(Date.UTC(2026, 9, 10, 18));
  const all = library.showOrder.map((id) => library.shows.get(id));
  assert.deepEqual(orderShows(all, library, positions, now).map((show) => show.name), [
    "The Wild Project",
    "Acquired",
    "Salud en la radio",
    "Lex Fridman Podcast",
    "Julian Dorey Podcast",
    "Al Corte",
    "La Escobula",
    "Hardcore History",
  ]);
  assert.equal(isFinished(positions.get(`p\0${episode("Al Corte", 0).path}`)), true, "a hub finished mark is kept as finished");
  assert.equal(isFinished(positions.get(`p\0${episode("La Escobula", 0).path}`)), true, "and so is a position-0 row");
  assert.equal(savedPosition(positions, episode("La Escobula", 0)), null, "finished never resumes");
  assert.equal(showTile(byName.get("Al Corte"), library, positions, now).caption, "Oct 8", "a finished newest episode is not New");
  assert.equal(showTile(byName.get("Lex Fridman Podcast"), library, positions, now).caption, "New · Oct 9");
  assert.equal(positionSignature(positions), positionSignature(positionMap([...positions.values()])), "a reload with the same rows signs the same");
  assert.notEqual(positionSignature(positions), positionSignature(positionMap([at("Acquired", 0, { position: 1800, duration: 6000, updated: 500 })])));
  const page = read("MusicLibrary.jsx");
  assert.match(page, /const order = useShowOrder\(library, positions, loaded, showsOpen\(library, route, wide\)\);/);
  assert.match(page, /if \(!active\) \{\s+kept\.current = null;\s+return null;\s+\}\s+if \(kept\.current\?\.library !== library \|\| kept\.current\.loaded !== loaded\)/, "local saves never move a tile; a new library, a changed hub load or reopening the root do");
  assert.match(page, /return tab === "podcasts" && musicPane\(route, wide\)\.level === 0;/);
});

test("Now playing offers the sleep timer and episode controls without shuffle or repeat", () => {
  const page = read("NowPlayingPage.jsx");
  assert.match(page, /<SleepButton sleep=\{sleep\} podcast=\{podcast\} onPress=\{\(\) => setSleepOpen\(true\)\} \/>/);
  assert.match(page, /\.\.\.\(active \? \[\{ value: "off", label: "Off" \}\] : \[\]\)/, "Off only while running");
  assert.match(page, /<Sheet\s+title="Sleep timer"/, "a sheet on the phone, the centred dialog on the Fold");
  assert.match(page, /podcast\s+\? control\("Back 15 seconds", "rotate-ccw", \(\) => seek\(position - 15000\)\)/);
  assert.match(page, /\? control\("Forward 30 seconds", "rotate-cw", \(\) => seek\(position \+ 30000\)\)/);
  assert.doesNotMatch(page, /seeked/, "the service sees every seek itself");
  assert.match(page, /podcast \? "Podcast" : queue\.name \|\| "Music"/);
});

test("an episode plays without music's repeat, and music gets its repeat back afterwards", async () => {
  const { spokenRepeat } = await import("../apps/mobile/src/music-library.js");
  const native = (repeat) => {
    const sent = [];
    return {
      sent,
      command: async (name, value) => {
        if (name === "state") return { repeat };
        sent.push([name, value]);
        repeat = value;
      },
    };
  };
  const control = native("one");
  const kept = await spokenRepeat(true, null, control);
  assert.equal(kept, "one");
  assert.deepEqual(control.sent, [["repeat", "off"]]);
  assert.equal(await spokenRepeat(true, kept, control), "one", "a second episode keeps music's choice");
  assert.equal(await spokenRepeat(false, kept, control), null);
  assert.deepEqual(control.sent, [["repeat", "off"], ["repeat", "one"]]);
  const quiet = native("all");
  assert.equal(await spokenRepeat(false, null, quiet), null);
  assert.deepEqual(quiet.sent, [], "music alone never touches repeat");
  assert.match(read("App.jsx"), /musicRepeat\.current = await spokenRepeat\(!!track\.podcast, musicRepeat\.current, player\);\n\s+await player\.play\(/);
});

const fakeTimer = () => {
  const jobs = new Map();
  let id = 0;
  return {
    set: (fn) => (jobs.set(++id, fn), id),
    clear: (handle) => jobs.delete(handle),
    tick: () => Promise.all([...jobs.values()].map((fn) => fn())),
    live: () => jobs.size,
  };
};

const hubRow = (updated, position, device = "other") => ({ volume: "a1", path: "Show/ep.mp3", hash: "h", position, duration: 4200, updated, device });
const readFile = read;
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a hub read adds a position saved elsewhere and never replaces a newer own row with an older hub row", () => {
  const key = "a1\0Show/ep.mp3";
  const mine = remember(new Map(), { volume: "a1", path: "Show/ep.mp3", hash: "h", position: 900, duration: 4200 }, { id: "phone" }, 5000);
  assert.equal(mergeHubPositions(mine, [hubRow(4000, 100)], [], "phone").get(key).position, 900);
  assert.equal(mergeHubPositions(mine, [hubRow(6000, 1500)], [], "phone").get(key).position, 1500);
  const added = mergeHubPositions(mine, [hubRow(4000, 100), { ...hubRow(7000, 50), path: "Show/new.mp3" }], [], "phone");
  assert.equal(added.get("a1\0Show/new.mp3").position, 50);
  assert.equal(mergeHubPositions(mine, [], [], "phone").get(key).position, 900, "an own save not yet at the hub survives a read");
  assert.equal(mergeHubPositions(new Map([[key, hubRow(1, 10)]]), [], [], "phone").size, 0, "a row the hub no longer lists is dropped");
});

test("the positions refresh reads on a quiet interval, only in the foreground, never overlaps, reads on return and stops", async () => {
  const timer = fakeTimer();
  let state = "active";
  let calls = 0;
  let release = null;
  let wake = null;
  const stop = startPositionRefresh({
    refresh: () => {
      calls++;
      return new Promise((resolve) => (release = resolve));
    },
    interval: 30000,
    foreground: () => state === "active",
    onForeground: (run) => ((wake = run), () => (wake = null)),
    timer,
  });
  assert.equal(calls, 1, "it reads at once");
  await timer.tick();
  assert.equal(calls, 1, "a read still in flight is not overlapped");
  release();
  await settle();
  state = "background";
  await timer.tick();
  assert.equal(calls, 1, "nothing is read in the background");
  state = "active";
  wake();
  assert.equal(calls, 2, "returning to the app reads at once");
  release();
  await settle();
  timer.tick();
  assert.equal(calls, 3);
  release();
  await settle();
  stop();
  assert.equal(timer.live(), 0);
  assert.equal(wake, null);
  await timer.tick();
  assert.equal(calls, 3, "a stopped refresh reads no more");
});

test("the phone watches positions only while a music folder is open, connected and not offline, and still publishes the synced file", () => {
  const session = read("audio-session.js");
  assert.match(session, /if \(!enabled \|\| !watching\) return undefined;\s+return startPositionRefresh\(/);
  assert.match(session, /AppState\.currentState === "active"/);
  assert.doesNotMatch(read("App.jsx"), /audio\.refresh\(\)/);
  assert.match(read("App.jsx"), /\}, \[audio\.positions, connection\?\.id\]\);/);
});

test("a read that changes nothing keeps the same positions, and a changed row replaces them", () => {
  const key = "a1\0Show/ep.mp3";
  const known = mergeHubPositions(new Map(), [hubRow(4000, 100)], [], "phone");
  assert.equal(mergeHubPositions(known, [hubRow(4000, 100)], [], "phone"), known);
  assert.notEqual(mergeHubPositions(known, [hubRow(4000, 200)], [], "phone"), known);
  assert.notEqual(mergeHubPositions(known, [hubRow(5000, 100)], [], "phone"), known);
  assert.notEqual(mergeHubPositions(known, [hubRow(4000, 100), { ...hubRow(4000, 1), path: "x.mp3" }], [], "phone"), known);
  assert.notEqual(mergeHubPositions(known, [], [], "phone"), known);
  assert.equal(mergeHubPositions(new Map(), [], [], "phone").size, 0);
  assert.equal(known.get(key).position, 100);
  const session = read("audio-session.js");
  assert.match(session, /if \(next !== known\.current\) \{\s+known\.current = next;\s+setPositions\(next\);/);
});

test("the merge settles ties, a missing device id, finished own rows and a finished hub row", () => {
  const key = "a1\0Show/ep.mp3";
  const own = (at, position) => remember(new Map(), { volume: "a1", path: "Show/ep.mp3", hash: "h", position, duration: 4200 }, { id: "phone" }, at);
  assert.equal(mergeHubPositions(own(5000, 900), [hubRow(5000, 100)], [], "phone").get(key).position, 100, "a tie takes the hub row");
  assert.equal(mergeHubPositions(own(5000, 900), [], [], null).size, 0, "without a device id no row counts as own");
  const finished = own(5000, 4190);
  assert.equal(finished.get(key).finished, true);
  assert.equal(mergeHubPositions(finished, [], [], "phone").get(key).finished, true, "an own finished row not yet at the hub stays");
  assert.equal(mergeHubPositions(finished, [hubRow(4000, 100)], [], "phone").get(key).finished, true, "a newer own finished row beats an older hub row");
  const older = mergeHubPositions(own(3000, 900), [], [{ volume: "a1", path: "Show/ep.mp3", updated: 4000 }], "phone");
  assert.equal(older.get(key).finished, true, "a hub finished row beats an older own row");
});

test("concurrent reads share one request", async () => {
  let calls = 0;
  const shared = singleFlight(async () => {
    calls++;
    await settle();
  });
  await Promise.all([shared(), shared()]);
  assert.equal(calls, 1);
  await shared();
  assert.equal(calls, 2);
  const session = readFile("audio-session.js");
  assert.match(session, /read\.current \|\|= singleFlight\(/);
  assert.match(session, /enabled \? read\.current\(\) : Promise\.resolve\(\)/);
});

test("removing from Continue marks the row finished so the next newest position takes the card, in memory and in the car's file", () => {
  const library = mixed();
  const [newer, older] = library.shows.get(library.showOrder[1]).tracks.map((id) => library.tracks.get(id));
  const positions = positionMap([
    { volume: "a1", path: older.path, hash: older.hash, position: 1680, duration: 4200, device: "d2", name: "macbook-pro", updated: 2 },
    { volume: "a1", path: newer.path, hash: newer.hash, position: 900, duration: 5400, device: "d1", name: "Android", updated: 1 },
  ]);
  assert.equal(resumeCandidate(positions, library, "a1").track, older);
  const cleared = forget(positions, positions.get(`a1\0${older.path}`), { id: "d1", name: "Android" }, 7);
  assert.equal(resumeCandidate(cleared, library, "a1").track, newer, "the next newest position takes the card");
  assert.equal(savedPosition(cleared, older), null);
  assert.deepEqual([playedRow(cleared, older).finished, playedRow(cleared, older).updated], [true, 7]);
  const hubRead = mergeHubPositions(cleared, [{ volume: "a1", path: older.path, hash: older.hash, position: 1680, duration: 4200, device: "d2", updated: 2 }], [], "d1");
  assert.equal(savedPosition(hubRead, older), null, "an older hub row never brings it back");
  assert.equal(syncedPositions(cleared, new Map([[older.id, older.hash], [newer.id, newer.hash]]), "scope", "d9").tracks[older.id], undefined, "the car's Continue drops it");
  assert.ok(syncedPositions(cleared, new Map([[newer.id, newer.hash]]), "scope", "d9").tracks[newer.id]);
});

test("a show tile's sheet and TalkBack actions offer Remove from Continue through the same forget", () => {
  const library = read("MusicLibrary.jsx");
  assert.match(library, /forget: \(\) => forgetResume\(entry\.row\),\s+openShow:/, "the tile's sheet passes forget");
  assert.match(library, /forget=\{forgetResume\}/);
  assert.match(library, /forget=\{tile\.resume \? \(\) => forget\(tile\.resume\.row\) : null\}/);
  assert.match(library, /\{ name: "forget", label: "Remove from Continue" \}/, "TalkBack offers it on tiles in progress");
  assert.match(library, /startover: \(\) => resume\(0\),\s+forget,/);
  assert.match(library, /label="Start over"[\s\S]*?\{!!sheet\.forget && \([\s\S]*?label="Open show"/, "between Start over and Open show");
});

test("the resume card's actions sheet offers Remove from Continue through the hub's clear route", () => {
  const session = read("audio-session.js");
  assert.match(session, /api\("\/v1\/audio-position\/clear", \{ volume: row\.volume, path: row\.path, hash: row\.hash, at \}\);[^\n]*\n[^\n]*\n\s+apply\(\(current\) => forget\(current, row, deps\.current\.device, at\)\);/, "the memory changes only after the hub accepted it");
  assert.match(session, /\(next\.get\(positionKey\(entry\.volume, entry\.path\)\)\?\.updated \|\| 0\) > entry\.at\s+\? next/, "a drained older save never replaces a newer clear");
  const library = read("MusicLibrary.jsx");
  assert.match(library, /accessibilityLabel="Resume actions"[\s\S]*?onPress=\{more\}/, "the card has one more button");
  assert.match(library, /forget: \(\) => forgetResume\(resume\.row\)/);
  assert.match(library, /label="Remove from Continue"\s+icon="close"\s+divider\s+onPress=\{\(\) => \{\s+open\(null\);\s+sheet\.forget\(\);/, "the sheet closes and clears");
  assert.match(read("App.jsx"), /await audio\.clear\(row\);[\s\S]*?Could not remove it from Continue\. Try again when connected\./);
  assert.match(read("App.jsx"), /relative=\{relative\}\s+forgetResume=\{forgetContinue\}/);
  assert.match(session, /const answer = await deps\.current\.api\("\/v1\/audio-position\/clear"[^\n]*\n\s+if \(answer\?\.cleared === false\) return read\.current\(\);\s+apply\(\(current\) => forget/, "a refusal from the hub rereads instead of forgetting");
});
