import test from "node:test";
import assert from "node:assert/strict";
import {
  albumKey,
  albumRows,
  albumSummary,
  artistGroups,
  buildLibrary,
  encodeHistory,
  baseContext,
  folderContext,
  HISTORY_LIMIT,
  LIBRARY_CONTEXT,
  libraryTracks,
  musicSheet,
  musicTabs,
  searchLibrary,
  nativeLibrary,
  parseHistory,
  playlistKey,
  playlistRows,
  playlistSummary,
  recentPlayed,
  recordHistory,
  coverKeys,
  formatDuration,
  nextRepeat,
  parseTrackNode,
  trackNodeId,
  trackTitle,
  UNKNOWN_ARTIST,
  VARIOUS_ARTISTS,
} from "../apps/mobile/src/music-library.js";

const row = (path, tags = {}) => ({
  path,
  hash: `h-${path}`,
  size: 1,
  title: null,
  artist: null,
  albumArtist: null,
  album: null,
  track: null,
  disc: null,
  year: null,
  genre: null,
  duration: null,
  codec: null,
  cover: null,
  added: null,
  ...tags,
});
const folder = (id, tracks, present = null) => ({
  id,
  uri: (path) => `file:///arca/${id}/${path}`,
  library: { version: "v", tracks },
  present:
    present || new Map(tracks.map((track) => [track.path, track.hash])),
});

test("an album is its folder, album directory, album artist and title: disc folders join it, other folders and editions stay apart", () => {
  const library = buildLibrary([
    folder("m1", [
      row("Miles/Kind of Blue/02 So What.flac", { title: "So What", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 2, year: 1959, duration: 562, added: "2026-01-02T00:00:00Z" }),
      row("Miles/Kind of Blue/01 Blue in Green.flac", { title: "Blue in Green", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1, cover: "c1", duration: 337, added: "2026-01-01T00:00:00Z" }),
      row("Miles/Kind of Blue/CD2/01 Bonus.flac", { title: "Bonus", artist: "Miles Davis", albumArtist: "miles davis", album: "kind of blue", track: 1, disc: 2, cover: "c2" }),
      row("Miles/Kind of Blue (Remaster)/01 So What.flac", { title: "So What", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1, year: 1997 }),
    ]),
    folder("m2", [
      row("Miles/Kind of Blue/03 Freddie.mp3", { title: "Freddie Freeloader", artist: "Miles Davis", albumArtist: "Miles Davis", album: "Kind of Blue", track: 3 }),
    ]),
  ]);
  assert.equal(library.albums.size, 3, "the disc folder joins its album; the remaster and the other music folder stay apart");
  const album = library.albums.get(albumKey("m1", { path: "Miles/Kind of Blue/x.flac", albumArtist: "Miles Davis", album: "Kind of Blue" }));
  assert.deepEqual(
    album.tracks.map((id) => library.tracks.get(id).title),
    ["Blue in Green", "So What", "Bonus"],
  );
  assert.equal(album.cover, "c1");
  assert.equal(album.artist, "Miles Davis");
  assert.equal(album.year, 1959);
  assert.equal(album.added, "2026-01-02T00:00:00Z");
  assert.equal(album.duration, 899);
  assert.deepEqual(library.artists.map((artist) => [artist.name, artist.albums.length, artist.tracks, artist.cover]), [["Miles Davis", 3, 5, "c1"]]);
  assert.equal(library.tracks.get("m1:Miles/Kind of Blue/02 So What.flac").uri, "file:///arca/m1/Miles/Kind of Blue/02 So What.flac");
});

test("a MusicBrainz release id groups an album across directories of one folder", () => {
  const release = "8f2c1a5e-6a8e-4d2b-9a43-1d6f3a0e9b10";
  const library = buildLibrary([
    folder("m", [
      row("Rips/Kind of Blue A/01.flac", { title: "One", albumArtist: "Miles Davis", album: "Kind of Blue", track: 1, release }),
      row("Rips/Kind of Blue B/02.flac", { title: "Two", albumArtist: "Miles Davis", album: "Kind of Blue (Legacy)", track: 2, release }),
      row("Rips/Kind of Blue B/03.flac", { title: "Three", albumArtist: "Miles Davis", album: "Kind of Blue", track: 3 }),
    ]),
  ]);
  assert.equal(library.albums.get(albumKey("m", { path: "x", release })).tracks.length, 2);
  assert.equal(library.albums.get(albumKey("m", { path: "Rips/Kind of Blue B/03.flac", albumArtist: "Miles Davis", album: "Kind of Blue" })).tracks.length, 1);
  assert.equal(library.albums.size, 2);
});

test("untagged and partly tagged tracks fall back to folder names and compilations read Various artists", () => {
  const library = buildLibrary([
    folder("m", [
      row("Loose/Field Recording 3.wav"),
      row("Mix 2020/01.mp3", { title: "One", artist: "A", album: "Mix 2020" }),
      row("Mix 2020/02.mp3", { title: "Two", artist: "B", album: "Mix 2020" }),
      row("top.mp3"),
    ]),
  ]);
  const titles = [...library.albums.values()].map((album) => [album.title, album.artist, album.tracks.length]);
  assert.deepEqual(titles, [
    ["Loose", UNKNOWN_ARTIST, 1],
    ["Mix 2020", VARIOUS_ARTISTS, 2],
    ["Unknown album", UNKNOWN_ARTIST, 1],
  ]);
  assert.equal(library.tracks.get("m:Loose/Field Recording 3.wav").title, "Field Recording 3");
  assert.deepEqual(library.artists.map((artist) => artist.name), [UNKNOWN_ARTIST, VARIOUS_ARTISTS]);
});

test("a track whose copy is missing or older stays in its album as pending, out of every count, search, queue and the car", () => {
  const tag = (track, title) => ({ title, artist: "Ann", albumArtist: "Ann", album: "X", year: 2001, track, duration: 60 });
  const tracks = [
    row("X/4.mp3", tag(4, "Four")),
    row("X/2.mp3", tag(2, "Two")),
    row("X/1.mp3", tag(1, "One")),
    row("X/3.mp3", tag(3, "Three")),
    row("Y/1.mp3", { title: "Lonely", album: "Y" }),
  ];
  const present = new Map([["X/1.mp3", "h-X/1.mp3"], ["X/2.mp3", "older"], ["X/3.mp3", "h-X/3.mp3"]]);
  const library = buildLibrary([folder("m", tracks, present)]);
  assert.deepEqual([...library.tracks.keys()], ["m:X/1.mp3", "m:X/3.mp3"]);
  assert.deepEqual([...library.pending.keys()], ["m:X/4.mp3", "m:X/2.mp3", "m:Y/1.mp3"]);
  assert.deepEqual(library.albumOrder.map((id) => library.albums.get(id).title), ["X"], "an album with no track on the phone stays out");
  const album = library.albums.get(library.albumOrder[0]);
  assert.deepEqual(album.tracks, ["m:X/1.mp3", "m:X/3.mp3"]);
  assert.deepEqual(album.rows, ["m:X/1.mp3", "m:X/2.mp3", "m:X/3.mp3", "m:X/4.mp3"], "pending tracks keep their disc order");
  assert.equal(album.duration, 120);
  assert.equal(albumSummary(album), "Ann · 2001 · 2 of 4 on this phone");
  assert.deepEqual(
    albumRows(library, album).map((item) => [item.number, item.title, item.state, item.position]),
    [[1, "One", "ready", 0], [2, "Two", "pending", null], [3, "Three", "ready", 1], [4, "Four", "pending", null]],
  );
  assert.deepEqual(library.artists.map((artist) => [artist.name, artist.tracks]), [["Ann", 2]]);
  assert.deepEqual(libraryTracks(library), ["m:X/1.mp3", "m:X/3.mp3"]);
  assert.deepEqual(searchLibrary(library, "two"), { tracks: [], albums: [], artists: [], playlists: [] });
  const car = nativeLibrary(library, "hub");
  assert.deepEqual(car.tracks.map((track) => track.id), ["m:X/1.mp3", "m:X/3.mp3"]);
  assert.deepEqual(car.albums[0].tracks, ["m:X/1.mp3", "m:X/3.mp3"]);
  const complete = buildLibrary([folder("m", tracks)]);
  assert.equal(albumSummary(complete.albums.get(album.id)), "Ann · 2001 · 4 tracks · 4:00");
  assert.equal(complete.pending.size, 0);
});

const mix = (entries, extra = {}) => ({ path: "Playlists/Mix.m3u8", name: "Mix", hash: "p".repeat(64), editable: true, entries, ...extra });

test("playlists keep every entry in file order with its state, and the car gets only what plays", () => {
  const tracks = [row("A/1.mp3", { title: "One", album: "A", duration: 60, cover: "k1" }), row("A/2.mp3", { title: "Two", album: "A", duration: 30, cover: "k2" }), row("A/3.mp3", { title: "Three", album: "A" })];
  const library = buildLibrary([
    {
      ...folder("m", tracks, new Map([["A/1.mp3", "h-A/1.mp3"], ["A/2.mp3", "h-A/2.mp3"]])),
      library: {
        version: "v",
        tracks,
        playlists: [
          mix(["A/3.mp3", "A/2.mp3", "gone.mp3", null, "A/1.mp3", "A/2.mp3"]),
          { path: "Playlists/old.m3u", name: "", hash: "q".repeat(64), entries: ["A/3.mp3"] },
          { path: "Elsewhere/x.m3u8", name: "Outside", entries: ["A/1.mp3"] },
          null,
        ],
      },
    },
  ]);
  assert.deepEqual(musicTabs(library), ["artists", "albums", "playlists", "recent"]);
  assert.deepEqual(library.playlistOrder, [playlistKey("m", "Playlists/Mix.m3u8"), playlistKey("m", "Playlists/old.m3u")]);
  assert.match(library.playlistOrder[0], /^playlist:[0-9a-f]{16}$/);
  assert.notEqual(playlistKey("m", "Playlists/Mix.m3u8"), playlistKey("n", "Playlists/Mix.m3u8"));
  const playlist = library.playlists.get(library.playlistOrder[0]);
  assert.deepEqual(
    playlist.entries.map((entry) => [entry.track, entry.state]),
    [["m:A/3.mp3", "pending"], ["m:A/2.mp3", "ready"], [null, "missing"], [null, "missing"], ["m:A/1.mp3", "ready"], ["m:A/2.mp3", "ready"]],
  );
  assert.deepEqual(playlist.tracks, ["m:A/2.mp3", "m:A/1.mp3", "m:A/2.mp3"], "a song may appear twice");
  assert.equal(playlist.cover, "k2", "the first track on the phone gives the cover");
  assert.equal(playlist.editable, true);
  assert.equal(playlistSummary(playlist), "3 tracks · 2:00");
  assert.deepEqual(
    playlistRows(library, playlist).map((item) => [item.number, item.title, item.state, item.position, item.entry, item.path]),
    [[1, "Three", "pending", null, 0, "A/3.mp3"], [2, "Two", "ready", 0, 1, "A/2.mp3"], [3, "gone", "missing", null, 2, "gone.mp3"], [4, "Unknown track", "missing", null, 3, null], [5, "One", "ready", 1, 4, "A/1.mp3"], [6, "Two", "ready", 2, 5, "A/2.mp3"]],
    "every row carries the path its entry names, so Remove works on entries that cannot play",
  );
  const old = library.playlists.get(library.playlistOrder[1]);
  assert.equal(old.name, "old", "a playlist without a name is named after its file");
  assert.equal(old.editable, false, "only .m3u8 files are edited");
  assert.deepEqual(nativeLibrary(library, "hub").playlists, [{ id: playlist.id, name: "Mix", tracks: playlist.tracks }], "the car lists only playlists with a track on the phone");
  assert.deepEqual(searchLibrary(library, "MIX").playlists, [playlist]);
  assert.deepEqual(recentPlayed(library, [playlist.id, "playlist:gone"]).map((item) => item.name), ["Mix"]);
  assert.deepEqual(musicTabs(buildLibrary([folder("m", tracks)])), ["artists", "albums", "recent"]);
});

test("the phone's own copy of a playlist wins over the hub's answer, and one deleted here leaves the list", () => {
  const tracks = [row("A/1.mp3", { title: "One", album: "A" }), row("A/2.mp3", { title: "Two", album: "A" })];
  const present = new Map([...tracks.map((track) => [track.path, track.hash]), ["Playlists/Mix.m3u8", "p1"], ["Playlists/Gone.m3u8", "p2"]]);
  const library = buildLibrary([
    {
      ...folder("m", tracks, present),
      library: {
        version: "v",
        tracks,
        playlists: [
          mix(["A/1.mp3"]),
          { path: "Playlists/Gone.m3u8", name: "Gone", entries: ["A/1.mp3"] },
          { path: "Playlists/Later.m3u8", name: "Later", entries: ["A/2.mp3"] },
          { path: "Playlists/Café.m3u", name: "Café", entries: ["A/1.mp3", "A/2.mp3"] },
        ],
      },
      playlists: new Map([
        ["Playlists/Mix.m3u8", "#EXTM3U\r\n#PLAYLIST:Mix edited\r\n../A/2.mp3\r\nhttp://radio/x\r\n../A/1.mp3\r\n"],
        ["Playlists/New.m3u8", "../A/2.mp3\n"],
        ["Playlists/Café.m3u", "#PLAYLIST:Caf\uFFFD\n../A/1.mp3\n"],
        ["Playlists/.arca-copy-x", "../A/1.mp3\n"],
      ]),
    },
  ]);
  const shown = library.playlistOrder.map((id) => library.playlists.get(id));
  assert.deepEqual(shown.map((playlist) => [playlist.name, playlist.tracks]), [
    ["Café", ["m:A/1.mp3", "m:A/2.mp3"]],
    ["Later", ["m:A/2.mp3"]],
    ["Mix edited", ["m:A/2.mp3", "m:A/1.mp3"]],
    ["New", ["m:A/2.mp3"]],
  ], "a read-only .m3u keeps the hub's reading, which knows its encoding");
  shown.shift();
  assert.deepEqual(shown[1].entries.map((entry) => entry.state), ["ready", "missing", "ready"], "positions follow the file this phone edits");
  assert.equal(shown[1].hash, "p".repeat(64));
  assert.equal(shown[2].hash, null);
});

test("recent lists albums by the newest addition and stops at thirty", () => {
  const tracks = Array.from({ length: 35 }, (_, i) =>
    row(`Album ${String(i).padStart(2, "0")}/t.mp3`, {
      album: `Album ${String(i).padStart(2, "0")}`,
      added: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T0${i % 10}:00:00Z`,
    }),
  );
  tracks.push(row("Undated/t.mp3", { album: "Undated" }));
  const library = buildLibrary([folder("m", tracks)]);
  assert.equal(library.recent.length, 30);
  const added = library.recent.map((id) => library.albums.get(id).added);
  assert.deepEqual(added, [...added].sort().reverse());
  assert.ok(!library.recent.some((id) => library.albums.get(id).title === "Undated"));
});

test("album and artist ids cannot collide through separators or control characters in tags", () => {
  const library = buildLibrary([
    folder("m", [
      row("x/1.mp3", { title: "1", albumArtist: "a:b", album: "c" }),
      row("y/2.mp3", { title: "2", albumArtist: "a", album: "b:c" }),
      row("z/3.mp3", { title: "3", albumArtist: "Bad\u001Fname", album: "Tab\u001F" }),
    ]),
  ]);
  assert.equal(library.albums.size, 3);
  for (const id of [...library.albums.keys(), ...library.artists.map((artist) => artist.id)])
    assert.ok(!id.includes("\u001F"), id);
});

test("malformed hub rows are skipped instead of breaking the library", () => {
  const library = buildLibrary([
    { id: "m", library: null, present: new Map() },
    { id: "n", library: { tracks: [null, { path: 3 }, row("ok.mp3")] }, present: new Map([["ok.mp3", "h-ok.mp3"]]) },
  ]);
  assert.deepEqual([...library.tracks.keys()], ["n:ok.mp3"]);
  assert.equal(library.tracks.get("n:ok.mp3").uri, null);
});

test("the native library carries ids, local file URIs, cover keys and what the car's tabs list", () => {
  const library = buildLibrary([
    folder("m", [row("A/1.mp3", { title: "One", artist: "Ann", albumArtist: "Ann", album: "First", cover: "k1", duration: 61.5, added: "2026-02-01T00:00:00Z" })]),
  ]);
  const value = nativeLibrary(library, "hub-1");
  const album = albumKey("m", { path: "A/1.mp3", albumArtist: "Ann", album: "First" });
  assert.match(album, /^album:[0-9a-f]{16}$/, "album ids stay short for the car");
  assert.equal(value.format, 1);
  assert.equal(value.scope, "hub-1");
  assert.deepEqual(value.tracks, [{ id: "m:A/1.mp3", uri: "file:///arca/m/A/1.mp3", title: "One", artist: "Ann", album: "First", duration: 61.5, cover: "k1" }]);
  assert.deepEqual(value.albums, [{ id: album, title: "First", artist: "Ann", cover: "k1", tracks: ["m:A/1.mp3"] }]);
  assert.deepEqual(value.artists, [{ id: 'artist:"ann"', name: "Ann", letter: "A", cover: "k1", albums: [album] }]);
  assert.deepEqual(value.playlists, []);
  assert.deepEqual(value.recent, [album]);
  assert.deepEqual([...coverKeys(library)], ["k1"]);
});

test("artists sort into letter groups with # last, show their newest covered album and give the car its headings", () => {
  const library = buildLibrary([
    folder("m", [
      row("E/Old/1.mp3", { artist: "Évora", albumArtist: "Évora", album: "Old", year: 1990, cover: "k1" }),
      row("E/New/1.mp3", { artist: "Évora", albumArtist: "Évora", album: "New", year: 2004, cover: "k2" }),
      row("E/Bare/1.mp3", { artist: "Évora", albumArtist: "Évora", album: "Bare", year: 2010 }),
      row("E/Undated/1.mp3", { artist: "Évora", albumArtist: "Évora", album: "Undated", cover: "k3" }),
      row("P/1.mp3", { artist: "2Pac", album: "Hits" }),
      row("K/1.mp3", { artist: "Кино", album: "Gruppa" }),
      row("A/1.mp3", { artist: "abba", album: "Gold" }),
      row("Z/1.mp3", { artist: "Zappa", album: "Hot Rats" }),
    ]),
  ]);
  assert.deepEqual(
    library.artists.map((artist) => [artist.letter, artist.name]),
    [["A", "abba"], ["E", "Évora"], ["Z", "Zappa"], ["#", "2Pac"], ["#", "Кино"]],
  );
  const evora = library.artists[1];
  assert.equal(evora.cover, "k2", "the newest dated album with a cover; one without a year counts as oldest");
  assert.deepEqual(
    evora.albums.map((id) => library.albums.get(id).title),
    ["Old", "New", "Bare", "Undated"],
    "the artist page keeps its album order",
  );
  assert.deepEqual(
    artistGroups(library.artists).map((group) => [group.letter, group.artists.map((artist) => artist.name)]),
    [["A", ["abba"]], ["E", ["Évora"]], ["Z", ["Zappa"]], ["#", ["2Pac", "Кино"]]],
  );
  assert.deepEqual(
    nativeLibrary(library, "hub-1").artists.map((artist) => [artist.letter, artist.cover]),
    [["A", null], ["E", "k2"], ["Z", null], ["#", null], ["#", null]],
  );
});

test("titles, durations and track ids format for display", () => {
  assert.equal(trackTitle({ path: "a/b/03 Song.name.flac" }), "03 Song.name");
  assert.equal(trackTitle({ path: ".hidden", title: null }), ".hidden");
  assert.equal(trackTitle({ path: "x.mp3", title: "Real" }), "Real");
  assert.equal(formatDuration(61.4), "1:01");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(null), "");
});

test("track node ids round-trip with an optional position and repeat cycles off, all, one", () => {
  const id = trackNodeId('album:["ann","first"]', "vol-1:A/1.mp3");
  assert.deepEqual(parseTrackNode(id), { context: 'album:["ann","first"]', track: "vol-1:A/1.mp3", position: null });
  const repeated = trackNodeId("in:v:playlist:0123456789abcdef", "v:A/1.mp3", 4);
  assert.equal(repeated, "track\u001Fin:v:playlist:0123456789abcdef\u001Fv:A/1.mp3\u001F4");
  assert.deepEqual(parseTrackNode(repeated), { context: "in:v:playlist:0123456789abcdef", track: "v:A/1.mp3", position: 4 });
  assert.equal(trackNodeId("c", "t", -1), "track\u001Fc\u001Ft");
  for (const bad of ["01", "-1", "x", "", "1.5", "99999999999999999999"])
    assert.equal(parseTrackNode(`track\u001Fc\u001Ft\u001F${bad}`), null, bad);
  assert.equal(parseTrackNode("track\u001Fc\u001Ft\u001F1\u001F2"), null);
  assert.equal(parseTrackNode("vol-1:A/1.mp3"), null);
  assert.equal(parseTrackNode(null), null);
  assert.deepEqual([nextRepeat("off"), nextRepeat("all"), nextRepeat("one")], [2, 1, 0]);
});

test("track and playlist sheets carry their own header", () => {
  const track = { title: "So What", artist: "Miles Davis", album: "Kind of Blue" };
  const playlist = { name: "Road trip", tracks: ["a", "b"], duration: 125 };
  assert.deepEqual(musicSheet({ kind: "track-actions", track }), { title: "So What", icon: "music", subtitle: "Miles Davis · Kind of Blue", menu: true });
  assert.deepEqual(musicSheet({ kind: "add-to-playlist", track }), { title: "Add to playlist", icon: "list-plus", subtitle: "So What · Miles Davis" });
  assert.deepEqual(musicSheet({ kind: "new-playlist", track }), { title: "New playlist", icon: "list-plus", subtitle: "So What" });
  assert.deepEqual(musicSheet({ kind: "playlist-actions", playlist }), { title: "Road trip", icon: "playlist", subtitle: "2 tracks · 2:05", menu: true });
  assert.deepEqual(musicSheet({ kind: "rename-playlist", playlist }), { title: "Rename playlist", icon: "edit", subtitle: "Road trip" });
  assert.deepEqual(musicSheet({ kind: "track-actions", track: null, title: "gone" }), { title: "gone", icon: "music", subtitle: "Not in this folder", menu: true });
  assert.equal(musicSheet({ kind: "folder-actions" }), null);
});

test("Recent resolves this phone's plays to albums, newest first, skipping what left the library", () => {
  const library = buildLibrary([
    folder("v", [row("A/1.mp3", { album: "First", artist: "Ann" }), row("B/1.mp3", { album: "Second", artist: "Bo" })]),
  ]);
  const [first, second] = library.albumOrder;
  const played = recentPlayed(library, ["playlist:v:mix.m3u8", "album:gone", second, first]);
  assert.deepEqual(played.map((album) => album.title), ["Second", "First"]);
  assert.deepEqual(recentPlayed(library, []), []);
});

test("the play history keeps twenty distinct entries newest first and belongs to one hub, in the format the car reads", () => {
  let history = [];
  for (let index = 1; index <= 25; index++) history = recordHistory(history, `album:${index}`);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0], "album:25");
  assert.deepEqual(recordHistory(["a", "b", "c"], "b"), ["b", "a", "c"]);
  const text = encodeHistory("hub-1", ["album:b", "album:a"]);
  assert.deepEqual(JSON.parse(text), { format: 1, scope: "hub-1", items: ["album:b", "album:a"] });
  assert.deepEqual(parseHistory(text, "hub-1"), ["album:b", "album:a"]);
  assert.deepEqual(parseHistory(text, "hub-2"), []);
  assert.deepEqual(parseHistory(text, null), []);
  assert.deepEqual(parseHistory('{"format":2,"scope":"hub-1","items":["album:a"]}', "hub-1"), []);
  assert.deepEqual(parseHistory("not json", "hub-1"), []);
  assert.deepEqual(parseHistory('{"format":1,"scope":"hub-1","items":["album:a",1,"","album:b","album:a"]}', "hub-1"), ["album:a", "album:b"]);
});

test("search finds songs, albums and artists ignoring case and accents", () => {
  const library = buildLibrary([
    folder(
      "v",
      [
        row("Café/1.mp3", { title: "Été Indien", artist: "Joe Dassin", album: "Café Society", track: 1 }),
        row("Café/2.mp3", { title: "Other", artist: "Joe Dassin", album: "Café Society", track: 2 }),
        row("Rock/1.mp3", { title: "Enter Sandman", artist: "Metallica", album: "Metallica" }),
      ],
    ),
  ]);
  assert.equal(searchLibrary(library, "   "), null, "an empty query shows the tab");
  const cafe = searchLibrary(library, "CAFE");
  assert.deepEqual(cafe.tracks.map((id) => library.tracks.get(id).title), ["Été Indien", "Other"]);
  assert.deepEqual(cafe.albums.map((album) => album.title), ["Café Society"]);
  assert.deepEqual(searchLibrary(library, "ete").tracks.map((id) => library.tracks.get(id).title), ["Été Indien"]);
  const metal = searchLibrary(library, "metal");
  assert.deepEqual(metal.artists.map((artist) => artist.name), ["Metallica"]);
  assert.deepEqual(metal.tracks.map((id) => library.tracks.get(id).title), ["Enter Sandman"]);
  assert.deepEqual(searchLibrary(library, "zzz"), { tracks: [], albums: [], artists: [], playlists: [] });
});

test("shuffle queues the whole library or one artist in album order", () => {
  const library = buildLibrary([
    folder("v", [
      row("B/2.mp3", { title: "B2", artist: "Bo", album: "Bee", track: 2 }),
      row("B/1.mp3", { title: "B1", artist: "Bo", album: "Bee", track: 1 }),
      row("A/1.mp3", { title: "A1", artist: "Ann", album: "Aye" }),
    ]),
  ]);
  assert.equal(LIBRARY_CONTEXT, "albums", "the native tree's Albums root queues the whole library");
  assert.deepEqual(libraryTracks(library).map((id) => library.tracks.get(id).title), ["A1", "B1", "B2"]);
  const bo = library.artists.find((artist) => artist.name === "Bo");
  assert.deepEqual(libraryTracks(library, bo.albums).map((id) => library.tracks.get(id).title), ["B1", "B2"]);
});

test("search matches a compilation's album artist, and Shuffle contexts name their folder", () => {
  const library = buildLibrary([
    folder("v", [row("Mix/1.mp3", { title: "Song", artist: "Someone", albumArtist: "The Compilers", album: "Hits" })]),
  ]);
  assert.deepEqual(searchLibrary(library, "compilers").tracks, ["v:Mix/1.mp3"]);
  assert.deepEqual(searchLibrary(library, "\u0301"), null, "a query that folds to nothing shows the tab");
  assert.equal(folderContext("v", LIBRARY_CONTEXT), "in:v:albums");
  assert.equal(folderContext("v", 'artist:"ann"'), 'in:v:artist:"ann"');
  assert.equal(baseContext(folderContext("v", 'album:["ann","first"]')), 'album:["ann","first"]', "an iPhone records the album, not its folder context");
  assert.equal(baseContext('album:["a:b","c"]'), 'album:["a:b","c"]');
});

test("untagged discs take their album folder's name, and disc folders at the root stay apart from loose files", () => {
  const rows = [
    row("Miles/Kind of Blue/CD1/01.flac"),
    row("Miles/Kind of Blue/Disk 2/01.flac"),
    row("CD1/01.flac"),
    row("CD 2/01.flac"),
    row("loose.flac"),
  ];
  const library = buildLibrary([folder("f", rows)]);
  assert.deepEqual(
    [...library.albums.values()].map((album) => [album.title, album.tracks.length]).sort(),
    [["CD 2", 1], ["CD1", 1], ["Kind of Blue", 2], ["Unknown album", 1]],
  );
});
