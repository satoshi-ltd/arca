import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildLibrary,
  episodeDate,
  folderContext,
  formatDay,
  formatLength,
  isEpisode,
  musicSheet,
  musicTabs,
  nativeLibrary,
  searchLibrary,
  showCaption,
  showRows,
  showSummary,
  trackContext,
  trackNodeId,
  upNext,
} from "../apps/mobile/src/music-library.js";
import {
  fraction,
  positionMap,
  positionToSave,
  remember,
  resumeCandidate,
  savedPosition,
  shouldSave,
  timeLeft,
  trackFile,
} from "../apps/mobile/src/audio-positions.js";
import {
  SLEEP_OFF,
  sleepClock,
  sleepCheck,
  sleepLabel,
  sleepOptions,
  sleepRemaining,
  startSleep,
} from "../apps/mobile/src/sleep-timer.js";
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
  assert.equal(showCaption(wild), "2 episodes · Oct 8, 2026");
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
  const entry = native.albums.find((album) => album.id === show.id);
  assert.deepEqual(entry.tracks, show.tracks);
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

test("positions save every 15 s while playing, never in the first 10 s, while seeking or for tracks under 20 minutes", () => {
  const base = { position: 600, duration: 3600, now: 100000, last: 80000 };
  assert.equal(shouldSave(base), true);
  assert.equal(shouldSave({ ...base, last: 90000 }), false, "less than 15 s since the last save");
  assert.equal(shouldSave({ ...base, last: 90000, force: true }), true, "pause and end save at once");
  assert.equal(shouldSave({ ...base, position: 9 }), false);
  assert.equal(shouldSave({ ...base, position: 9, force: true }), false);
  assert.equal(shouldSave({ ...base, seeking: true, force: true }), false);
  assert.equal(shouldSave({ ...base, duration: 1199 }), false);
  assert.equal(shouldSave({ ...base, duration: 1200 }), true);
});

test("the player's transitions decide what is saved: playing, pausing, ending and switching tracks", () => {
  const playing = { id: "n1", position: 60000, duration: 3600000, playing: true, ended: false };
  assert.deepEqual(positionToSave(playing, { ...playing, position: 75000 }), { snapshot: { ...playing, position: 75000 }, force: false });
  const paused = { ...playing, position: 80000, playing: false };
  assert.deepEqual(positionToSave(playing, paused), { snapshot: paused, force: true });
  const ended = { ...playing, position: 3600000, playing: false, ended: true };
  assert.equal(positionToSave(playing, ended).snapshot.position, 3600000, "the end clears the saved position");
  const next = { id: "n2", position: 0, duration: 3000000, playing: true, ended: false };
  assert.deepEqual(positionToSave(playing, next), { snapshot: playing, force: true }, "switching mid-episode keeps its place");
  assert.equal(positionToSave({ ...playing, position: 3599000 }, next).snapshot.position, 3600000, "an episode that ran out is finished");
  assert.equal(positionToSave({ ...playing, duration: 200000 }, next), null, "short tracks are never saved");
  assert.equal(positionToSave(paused, { ...paused }), null);
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
  assert.equal(resumeCandidate(positions, library, "a1", older.id), null, "hidden while that item plays");
  const next = remember(positions, { volume: "a1", path: older.path, hash: older.hash, position: 4150, duration: 4200 }, { id: "d1", name: "Android" }, 5);
  assert.equal(savedPosition(next, older), null, "the last minute clears the position");
  const kept = remember(positions, { volume: "a1", path: older.path, hash: older.hash, position: 2000, duration: 4200 }, { id: "d1", name: "Android" }, 5);
  assert.deepEqual(savedPosition(kept, older), { volume: "a1", path: older.path, hash: older.hash, position: 2000, duration: 4200, device: "d1", name: "Android", updated: 5 });
});

test("the sleep timer offers 30 minutes, 1 hour and the end of the item, and fires once it is due", () => {
  assert.deepEqual(sleepOptions(true).map((option) => option.label), ["30 minutes", "1 hour", "End of episode"]);
  assert.deepEqual(sleepOptions(false).map((option) => option.label), ["30 minutes", "1 hour", "End of track"]);
  const half = startSleep("30", 1000, "t1");
  assert.equal(half.mode, "duration");
  assert.equal(sleepRemaining(half, 1000), 30 * 60000);
  assert.equal(sleepLabel(half, 1000 + 19000), "29:41");
  assert.equal(sleepCheck(half, half.endsAt - 1), null);
  assert.equal(sleepCheck(half, half.endsAt), "due");
  assert.equal(sleepCheck(half, half.endsAt - 1, { track: "t2", ended: true }), null, "a duration timer survives track changes");
  assert.equal(sleepClock(3600000), "1:00:00");
  const end = startSleep("end", 1000, "t1");
  assert.equal(sleepLabel(end, 1000), "End of episode");
  assert.equal(sleepLabel(end, 1000, false), "End of track");
  assert.equal(sleepCheck(end, 1e12, { track: "t1", position: 1000, duration: 600000 }), null, "time alone never ends it");
  assert.equal(sleepCheck(end, 0, { track: "t1", position: 599000, duration: 600000 }), "due");
  assert.equal(sleepCheck(end, 0, { track: "t1", position: 597000, duration: 600000 }), "near");
  assert.equal(sleepCheck({ ...end, near: true }, 0, { track: "t2", position: 0, duration: 600000 }), "due", "the item that was playing ran out into the next one");
  assert.equal(sleepCheck(end, 0, { track: "t2", position: 0, duration: 600000 }), "cancel", "choosing another item mid-way turns the timer off instead of pausing the new one");
  assert.equal(sleepCheck(end, 0, { track: "t1", ended: true }), "due");
  assert.deepEqual(startSleep("end", 0, null), SLEEP_OFF);
  assert.deepEqual(startSleep("nope", 0, "t1"), SLEEP_OFF);
  assert.equal(sleepCheck(SLEEP_OFF, 1e12), null);
});

test("Folders splits selected folders into Folders, Photos and Audio, leaving out empty sections", () => {
  const kinds = { a: "folders", b: "audio", c: "photos", d: "audio" };
  const sections = folderSections(["a", "b", "c", "d"].map((id) => ({ id })), (f) => kinds[f.id]);
  assert.deepEqual(sections.map((section) => [section.label, section.folders.map((f) => f.id)]), [
    ["FOLDERS", ["a"]],
    ["PHOTOS", ["c"]],
    ["AUDIO", ["b", "d"]],
  ]);
  assert.deepEqual(folderSections([{ id: "b" }], (f) => kinds[f.id]).map((section) => section.kind), ["audio"]);
});

test("the phone reads and writes hub positions with its device credential and pauses on the sleep timer", () => {
  const session = read("audio-session.js");
  assert.match(session, /api\("\/v1\/audio-positions"\)/);
  assert.match(session, /api\("\/v1\/audio-position", body\)/);
  assert.match(session, /const body = \{ volume: file\.volume, path: file\.path, hash: info\.hash, position, duration \};/);
  assert.match(session, /native\.addListener\("musicState"/);
  assert.match(session, /const step = sleepCheck\(sleepRef\.current, now, \{ \.\.\.state, track \}\);/);
  assert.match(session, /if \(step === "cancel"\) return;\n\s+const snapshot/, "a cancelled timer never pauses");
  assert.match(session, /state\.playing \? player\.command\("toggle"\)/, "the timer pauses through the existing command bridge");
  assert.match(session, /pause\.then\(\(\) => save\(snapshot, true\)/, "and force-saves the position");
  const app = read("App.jsx");
  assert.match(app, /const audio = useAudioSession\(\{\s+enabled: !!connected,\s+api: \(route, body\) => client\.api\(route, body\),/);
  assert.match(app, /if \(at > 0\) \{\s+audio\.seeked\(\);\s+await player\.command\("seek", at \* 1000\);/, "a saved row resumes where it stopped");
  assert.match(app, /positions=\{audio\.positions\}\s+deviceId=\{connection\?\.id\}/);
  assert.match(app, /sleep=\{audio\.sleep\}\s+setSleep=\{audio\.setSleep\}\s+seeked=\{audio\.seeked\}/);
});

test("the library draws progress, the resume card, the Podcasts tab and a track Delete…", () => {
  const library = read("MusicLibrary.jsx");
  assert.match(library, /<Text style=\{s\.eyebrow\}>PICK UP WHERE YOU LEFT OFF<\/Text>/);
  assert.match(library, /label="Continue" icon="play" onPress=\{\(\) => start\(row\.position\)\}/);
  assert.match(library, /label="Start over" icon="rotate-ccw" onPress=\{\(\) => start\(0\)\}/);
  assert.match(library, /resumeCandidate\(positions, library, folderId, playing\)/);
  assert.match(library, /item\.kind === "podcasts"\)\s+return \(\s+<PagedRows\s+items=\{library\.showOrder/);
  assert.match(library, /episodes\s+flat=\{flat\}\s+\/>/, "a show page plays episodes without Shuffle");
  assert.match(library, /canPlay && tracks\.length > 1 && !episodes && \(/);
  assert.match(library, /label="Delete…"\s+icon="trash"\s+danger\s+disabled=\{locked\}\s+onPress=\{\(\) => removeTrack\(sheet\.track\)\}/);
  assert.match(library, /<View style=\{s\.miniProgress\} pointerEvents="none">/, "the mini player draws progress on its bottom edge");
  assert.match(library, /<Icon name="moon" size=\{14\} color=\{c\.accent\} \/>/, "and the moon with the countdown while the timer runs");
  const app = read("App.jsx");
  assert.match(app, /`Delete “\$\{track\.title\}”\?`,\s+"It is removed from every device\. History keeps it/);
  assert.match(app, /await engine\.current\.removeFile\(track\.folder, track\.path\);/, "through the phone's synchronized file delete");
});

test("Now playing offers the sleep timer and episode controls without shuffle or repeat", () => {
  const page = read("NowPlayingPage.jsx");
  assert.match(page, /<SleepButton sleep=\{sleep\} podcast=\{podcast\} onPress=\{\(\) => setSleepOpen\(true\)\} \/>/);
  assert.match(page, /\.\.\.\(active \? \[\{ value: "off", label: "Off" \}\] : \[\]\)/, "Off only while running");
  assert.match(page, /<Sheet\s+title="Sleep timer"/, "a sheet on the phone, the centred dialog on the Fold");
  assert.match(page, /podcast\s+\? control\("Back 15 seconds", "rotate-ccw", \(\) => seek\(position - 15000\)\)/);
  assert.match(page, /\? control\("Forward 30 seconds", "rotate-cw", \(\) => seek\(position \+ 30000\)\)/);
  assert.match(page, /seeked\?\.\(\);/, "seeking holds position saves");
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
