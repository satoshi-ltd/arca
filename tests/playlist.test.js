import test from "node:test";
import assert from "node:assert/strict";
import {
  appendEntry,
  createPlaylist,
  editableText,
  isEditablePlaylist,
  isPlaylistPath,
  moveTrack,
  parsePlaylist,
  playlistPath,
  removeEntry,
  renamePlaylist,
  resolveEntry,
} from "../packages/core/playlist.js";

test("playlists live directly in the music folder's Playlists directory, and only .m3u8 files are edited", () => {
  assert.equal(isPlaylistPath("Playlists/Road trip.m3u8"), true);
  assert.equal(isPlaylistPath("Playlists/old.M3U"), true);
  assert.equal(isPlaylistPath("Playlists/sub/x.m3u8"), false);
  assert.equal(isPlaylistPath("Other/x.m3u8"), false);
  assert.equal(isPlaylistPath("Playlists/.hidden.m3u8"), false);
  assert.equal(isPlaylistPath("Playlists/notes.txt"), false);
  assert.equal(isEditablePlaylist("Playlists/Road trip.m3u8"), true);
  assert.equal(isEditablePlaylist("Playlists/old.m3u"), false);
});

test("a playlist name becomes a safe file name", () => {
  assert.equal(playlistPath("  Road/trip: 2026 "), "Playlists/Road trip 2026.m3u8");
  assert.equal(playlistPath("Cafe\u0301"), "Playlists/Café.m3u8");
  assert.throws(() => playlistPath("   "), /Enter a playlist name/);
  assert.throws(() => playlistPath("..."), /Enter a playlist name/);
  assert.equal(playlistPath("x".repeat(300)).length, "Playlists/".length + 120 + ".m3u8".length);
});

test("entries resolve against the playlist's directory and never leave the folder", () => {
  const path = "Playlists/x.m3u8";
  assert.equal(resolveEntry("../Miles/Kind of Blue/01.mp3", path), "Miles/Kind of Blue/01.mp3");
  assert.equal(resolveEntry("..\\Miles\\01.mp3", path), "Miles/01.mp3");
  assert.equal(resolveEntry("./sub/../a.mp3", path), "Playlists/a.mp3");
  assert.equal(resolveEntry("../Cafe\u0301/1.mp3", path), "Café/1.mp3");
  for (const outside of ["/abs/a.mp3", "http://radio/x", "C:\\Music\\a.mp3", "../../escape.mp3", ".."])
    assert.equal(resolveEntry(outside, path), null, outside);
});

test("parsing keeps every entry in order with its line, including duplicates and lines that do not resolve", () => {
  const text = "\uFEFF#EXTM3U\r\n#PLAYLIST:Road trip\r\n#EXTINF:120,One\r\n../A/1.mp3\r\n\r\nhttp://radio/x\r\n../A/1.mp3\r\n";
  const parsed = parsePlaylist(text, "Playlists/road.m3u8");
  assert.equal(parsed.name, "Road trip");
  assert.deepEqual(parsed.entries, [
    { line: 3, path: "A/1.mp3" },
    { line: 5, path: null },
    { line: 6, path: "A/1.mp3" },
  ]);
  assert.equal(parsePlaylist("../A/1.mp3\n", "Playlists/Sunday.m3u8").name, "Sunday");
});

test("a new playlist and an appended song are written relative to the playlist", () => {
  const path = "Playlists/Road trip.m3u8";
  const text = createPlaylist("Road trip", path, ["A/1.mp3"]);
  assert.equal(text, "#EXTM3U\n#PLAYLIST:Road trip\n../A/1.mp3\n");
  assert.equal(appendEntry(text, path, "B C/2.mp3"), "#EXTM3U\n#PLAYLIST:Road trip\n../A/1.mp3\n../B C/2.mp3\n");
  const hand = "\uFEFF#EXTM3U\r\n#EXTINF:1,x\r\nhttp://radio/x\r\n";
  assert.equal(appendEntry(hand, path, "A/1.mp3"), "\uFEFF#EXTM3U\r\n#EXTINF:1,x\r\nhttp://radio/x\r\n../A/1.mp3\r\n", "line endings, BOM and unknown lines are kept");
});

test("removing an appearance removes only that one, with its #EXTINF line, and refuses a stale position", () => {
  const path = "Playlists/r.m3u8";
  const text = "#EXTM3U\n#EXTINF:1,One\n../A/1.mp3\n../missing.mp3\n#EXTINF:1,One again\n../A/1.mp3\n";
  assert.equal(removeEntry(text, path, 2, "A/1.mp3"), "#EXTM3U\n#EXTINF:1,One\n../A/1.mp3\n../missing.mp3\n");
  assert.equal(removeEntry(text, path, 0, "A/1.mp3"), "#EXTM3U\n../missing.mp3\n#EXTINF:1,One again\n../A/1.mp3\n");
  assert.equal(removeEntry(text, path, 1, "A/1.mp3"), null, "the entry at that position is a different song");
  assert.equal(removeEntry(text, path, 9, "A/1.mp3"), null);
});

test("renaming a playlist rewrites or adds its #PLAYLIST line", () => {
  assert.equal(renamePlaylist("#EXTM3U\n#PLAYLIST:Old\n../a.mp3\n", "New"), "#EXTM3U\n#PLAYLIST:New\n../a.mp3\n");
  assert.equal(renamePlaylist("#EXTM3U\n../a.mp3\n", "New"), "#EXTM3U\n#PLAYLIST:New\n../a.mp3\n");
  assert.equal(renamePlaylist("../a.mp3\n", "New"), "#EXTM3U\n#PLAYLIST:New\n../a.mp3\n");
});

test("moving a song or a folder rewrites the entries that name it, and nothing else", () => {
  const path = "Playlists/r.m3u8";
  const text = "#EXTM3U\n../A/1.mp3\n../A/2.mp3\n../B/1.mp3\nhttp://radio/x\n";
  assert.equal(moveTrack(text, path, "A/1.mp3", "A/01 One.mp3"), "#EXTM3U\n../A/01 One.mp3\n../A/2.mp3\n../B/1.mp3\nhttp://radio/x\n");
  assert.equal(moveTrack(text, path, "A", "Ann/First"), "#EXTM3U\n../Ann/First/1.mp3\n../Ann/First/2.mp3\n../B/1.mp3\nhttp://radio/x\n");
  assert.equal(moveTrack(text, path, "C/1.mp3", "D/1.mp3"), null);
  assert.equal(moveTrack(text, path, "A/1", "X"), null, "a path prefix that is not a folder does not match");
});

test("a track whose path starts with # is written so it stays an entry, and a removed entry takes every #EXTINF above it", () => {
  const path = "Playlists/r.m3u8";
  assert.equal(appendEntry("#EXTM3U\n", path, "Playlists/#1.mp3"), "#EXTM3U\n./#1.mp3\n");
  assert.deepEqual(parsePlaylist("./#1.mp3\n", path).entries, [{ line: 0, path: "Playlists/#1.mp3" }]);
  assert.equal(
    removeEntry("#EXTM3U\n../a.mp3\n#EXTINF:1,B\n#EXTVLCOPT:x\n../b.mp3\n", path, 1, "b.mp3"),
    "#EXTM3U\n../a.mp3\n#EXTVLCOPT:x\n",
  );
});

test("text that lost bytes decoding is refused instead of being written back", () => {
  assert.equal(editableText("#EXTM3U\n../Café.mp3\n"), "#EXTM3U\n../Café.mp3\n");
  assert.throws(() => editableText(Buffer.from([0x23, 0xe9, 0x0a]).toString("utf8")), /not valid UTF-8/);
});
