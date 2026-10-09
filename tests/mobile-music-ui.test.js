import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) =>
  fs.readFileSync(new URL(`../apps/mobile/${file}`, import.meta.url), "utf8");
const app = read("src/App.jsx");
const library = read("src/MusicLibrary.jsx");
const native = "modules/arca-network/android/src/main";

test("a music folder opens on its library, keeps View files in the folder menu and drops the album actions", () => {
  assert.match(app, /const musicFolder =\s+!!folder && !photoFolder && isMusicFolder\(catalog, folder\.id\);/);
  assert.match(app, /const musicView = musicFolder && fileView === "music";/);
  assert.match(app, /isMusicFolder\(catalog, f\.id\) && !galleryConfig\(f\)\s+\? "music"/, "opening a music folder starts on the library");
  const content = app.slice(app.indexOf(") : musicView ? ("), app.indexOf("<View style={s.detailGrid}>"));
  assert.match(content, /<MusicLibrary/);
  assert.match(content, /canPlay=\{playerAvailable\}/);
  assert.match(app, /!photoFolder &&\s+!musicView && \(\s+<View style=\{\[s\.group, s\.statsGrid\]\}>/, "the files stats stay out of the library");
  const actions = app.slice(app.indexOf('shownSheet.kind === "folder-actions" &&'), app.indexOf('label="View history"'));
  assert.match(actions, /label=\{musicView \? "View files" : "View library"\}/);
  assert.match(actions, /\{!!folder\.selected && !musicFolder && \(\s+<ActionRow\s+label="Add photos…"/);
  assert.match(actions, /\{!musicFolder && \(\s+<ActionRow\s+label=\{source \? "Change album…" : "Link album…"\}/);
  assert.match(app, /: isMusicFolder\(catalog, f\.id\)\s+\? "audio"\s+: "folders"/, "a selected music folder sits in Audio");
  assert.match(app, /: section\.kind === "audio"\s+\? audioSymbols\[f\.id\] \|\| "music"\s+: "folders"/, "and shows the music tile, or the podcast tile for a podcasts-only library");
});

test("Android back leaves library screens before the folder, and the mini player opens Now playing", () => {
  const back = app.slice(app.indexOf("const handler = () => {"), app.indexOf("const selectTab"));
  assert.ok(back.indexOf("musicRoute.length > 1") < back.indexOf("setFolder(null)"));
  assert.match(back, /\[\s*sheet,\s*folder,\s*view,\s*fileActionsOpen,\s*musicView,\s*musicRoute,\s*shownMusic,\s*musicSearch,?\s*\]/);
  assert.ok(back.indexOf('typeof musicSearch === "string"') < back.indexOf("musicRoute.length > 1"), "Back closes an open search before leaving the folder");
  assert.match(back, /musicRoute\.length > 1 &&\s+shownMusic\?\.library\?\.tracks\.size/, "an empty library leaves the folder at once");
  assert.match(app, /musicFolder && !sheet && \(\s+<MiniPlayer[\s\S]*?open=\{\(\) => setNowPlayingOpen\(true\)\}/);
  assert.ok(app.indexOf("<MiniPlayer") < app.indexOf("<Navigation\n", app.indexOf("<MiniPlayer")), "the mini player sits above the tab bar");
  assert.match(app, /<NowPlayingPage\s+visible=\{nowPlayingOpen\}/);
});

test("playing publishes the car library first on Android and opens the file on iPhone", () => {
  const play = app.slice(app.indexOf("function playMusic("), app.indexOf("function musicChanged("));
  assert.match(play, /if \(!playerAvailable\) \{\s+if \(engine\.current\)\s+recordMusicPlay\(engine\.current, baseContext\(context\)\)[\s\S]*?openFileDetail\(\{ path: track\.path, uri: track\.uri \}\)/, "an iPhone records the album it opens a track from");
  assert.match(play, /await publishMusic\(engine\.current\)\.catch\(\(\) => \{\}\);\s+musicRepeat\.current = await spokenRepeat\([^;]+\);\s+await player\.play\(\s*context,\s*track\.id,\s*shuffle,\s*Number\.isSafeInteger\(position\) \? position : -1,\s*\);/, "Play publishes first, after any publish in flight, so a playlist just edited or a track just downloaded is in the service's library; a failed publish never blocks playback, and a track carries its position in the queue");
  const player = read("src/music-player.js");
  assert.match(player, /Platform\.OS === "android" && typeof native\.musicPlay === "function"/);
  assert.match(player, /native\.addListener\("musicState", update\)/);
  assert.match(read("src/runtime.js"), /player: Platform\.OS === "android" \? player : null,/, "only Android publishes the car library");
});

test("the library opens on the Artists tab, Recent lists this phone's plays, and playback hides where it cannot play", () => {
  assert.doesNotMatch(library, /kind === "root"/, "there is no root list before the music");
  assert.match(library, /const tabs = musicTabs\(library\);\s+const tab = tabs\.includes\(route\[0\]\?\.kind\) \? route\[0\]\.kind : tabs\[0\];/);
  assert.match(library, /<SegmentedControl\s+options=\{tabs\.map\(\(value\) => \(\{ value, label: TAB_LABELS\[value\] \}\)\)\}\s+value=\{tab\}\s+onChange=\{\(kind\) => \{\s+setSearch\(null\);\s+select\(kind\);/, "changing tab closes the search");
  assert.match(library, /item\.kind === "albums"\) return albums\(albumsOf\(library\.albumOrder\)\);/);
  const recent = library.slice(library.indexOf('item.kind === "recent"'), library.indexOf('item.kind === "podcasts"'));
  assert.match(recent, /recentPlayed\(library, history \|\| \[\]\)/);
  assert.ok(recent.indexOf("RECENTLY PLAYED") < recent.indexOf("RECENTLY ADDED"), "played history first, recently added only while it is empty");
  assert.match(recent, /albumRow\(entry, index, entry\.artist\)/);
  assert.match(app, /useState\(\[\{ kind: "artists" \}\]\)/, "the library opens on Artists");
  assert.match(app, /select=\{\(kind\) => setMusicRoute\(\[\{ kind \}\]\)\}/);
  assert.match(app, /readMusicHistory\(replica\)\.then/);
  assert.match(library, /<View style=\{s\.folderToolbar\}>[\s\S]*?<SegmentedControl[\s\S]*?label=\{searching \? "Close search" : searchLabel\}/, "search sits beside the tabs as in Files");
  assert.match(library, /<Field\s+label=\{searchLabel\}\s+autoFocus=\{!query\}\s+placeholder=\{searchLabel\}/);
  assert.match(library, /const found = useMemo\(\s+\(\) => \(library && searching \? searchLibrary\(library, query\) : null\),\s+\[library, searching, query\],/, "results are computed once per query");
  assert.match(app, /search=\{musicSearch\}\s+setSearch=\{setMusicSearch\}\s+folderId=\{folder\.id\}/, "the search survives opening a result and coming back");
  assert.match(library, /folderContext\(folderId, context\)/, "Shuffle plays only this folder");
  assert.match(library, /context=\{folderContext\(folderId, album\.id\)\}/, "an album plays only this folder's tracks");
  assert.match(library, /contextOf=\{\(track\) => folderContext\(folderId, trackContext\(track\)\)\}/, "a found episode plays in its show");
  assert.match(library, /autoFocus=\{!query\}/, "coming back to results keeps the keyboard closed");
  assert.match(app, /recordMusicPlay\(engine\.current, baseContext\(context\)\)/);
  assert.match(app, /typeof musicSearch === "string" &&\s+shownMusic\?\.library\?\.tracks\.size/, "an empty library leaves the folder at once, even with search open");
  assert.match(library, /canPlay && !results && tab !== "podcasts" && everything\.length > 1 &&/);
  assert.match(library, /canPlay && ids\.length > 1 &&/, "an artist with one track offers no Shuffle, like an album");
  assert.match(library, /contextOf=\{\(track\) => folderContext\(folderId, trackContext\(track\)\)\}/, "a song found by search plays within its album or show");
  assert.match(library, /shuffle\(LIBRARY_CONTEXT, everything\)/, "Shuffle plays the whole library");
  assert.match(library, /shuffle\(artist\.id, ids\)/, "an artist page shuffles that artist");
  assert.match(read(`${native}/java/expo/modules/arcanetwork/MusicLibrary.kt`), /const val ALBUMS = "albums"/);
  assert.match(app, /const settled = setTimeout\(read, 1500\);/, "Recent reads again once the service has written the play");
  assert.match(library, /\{canPlay && first && \(/);
  assert.match(library, /Playback on this iPhone comes in a later version/);
  assert.match(library, /formatDuration\(track\.duration\)/);
  assert.match(library, /label="Shuffle"/);
  const nowPage = read("src/NowPlayingPage.jsx");
  assert.match(nowPage, /command\("repeat", nextRepeat\(state\.repeat\)\)/);
  assert.match(nowPage, /accessibilityRole="adjustable"/, "the progress bar seeks");
});

test("a track still downloading stays in its album, dimmed, labelled and not playable", () => {
  const list = library.slice(library.indexOf("function TrackList("), library.indexOf("const readyRows"));
  assert.match(library, /const notes = \(offline\) => \(\{\s+pending: offline \? "Not on this phone yet" : "Downloading",\s+missing: "Not in this folder",\s+\}\);/, "offline nothing is downloading, so the note says the track is not here yet");
  assert.match(list, /const NOTES = notes\(offline\);/);
  assert.equal(library.match(/offline=\{offline\}/g).length, 4, "an album, a show, a playlist and the list inside them pass it on");
  const waiting = list.slice(list.indexOf('if (row.state !== "ready")'), list.indexOf("const { track } = row;"));
  assert.match(waiting, /<View\s+key=\{key\}\s+accessible\s+accessibilityLabel=\{`\$\{row\.title\}, \$\{NOTES\[row\.state\]\.toLowerCase\(\)\}`\}/, "read as “title, downloading”");
  const menu = waiting.slice(waiting.indexOf("{removable && ("), waiting.indexOf("</Pressable>") + "</Pressable>".length);
  assert.match(menu, /^\{removable && \(\s+<Pressable\s+accessibilityRole="button"\s+accessibilityLabel="Track actions"\s+hitSlop=\{4\}\s+onPress=\{\(\) => actions\(row\)\}/, "an editable playlist keeps its ⋯ on an entry that cannot play");
  assert.match(waiting, /accessibilityActions=\{\s+removable \? \[\{ name: "actions", label: "Track actions" \}\] : undefined\s+\}/);
  assert.doesNotMatch(waiting.replace(menu, ""), /Pressable|onPress|duration/, "a pending row ignores taps and shows no length");
  assert.match(waiting, /<Text style=\{\[s\.mono, s\.musicPending\]\}>\{row\.number\}<\/Text>/);
  assert.match(waiting, /style=\{\[s\.rowTitle, s\.musicPending\]\}/);
  assert.match(waiting, /style=\{\[s\.caption, s\.musicPending\]\}>\s+\{NOTES\[row\.state\]\}/);
  assert.match(read("src/theme.js"), /musicPending: \{ color: c\.mute \},/);
  assert.match(library, /subtitle=\{albumSummary\(album\)\}\s+coverUri=\{cover\(album\.cover, "large"\)\}\s+rows=\{albumRows\(library, album\)\}\s+tracks=\{album\.tracks\}/, "rows include pending tracks; Play and Shuffle use the tracks on the phone");
  assert.match(library, /onPress=\{\(\) =>\s+play\(context, first, false, 0, savedPosition\(positions, first\)\?\.position \|\| 0\)\s+\}/, "Play starts at the first track on the phone, where it was left");
});

test("playlists get their tab, screen, search group and Recent rows, and every track row ends in a ⋯", () => {
  assert.match(read("src/music-library.js"), /playlists: "Playlists",/);
  assert.match(library, /item\.kind === "playlists"\)\s+return \(\s+<PagedRows\s+items=\{library\.playlistOrder\.map\(\(id\) => library\.playlists\.get\(id\)\)\}/);
  assert.match(library, /<Text style=\{s\.eyebrow\}>PLAYLISTS<\/Text>/, "search has a Playlists group");
  assert.match(library, /library\.playlists\.has\(entry\.id\)\s+\? playlistRow\(entry, index, plural\(entry\.tracks\.length, "track", "tracks"\)\)/, "Recent lists played playlists with albums");
  const screen = library.slice(library.indexOf('const playlist = item.kind === "playlist"'), library.indexOf("const gone ="));
  assert.match(screen, /subtitle=\{playlistSummary\(playlist\)\}/);
  assert.match(screen, /coverUri=\{cover\(playlist\.cover, "large"\)\}\s+icon="playlist"\s+rows=\{playlistRows\(library, playlist\)\}/);
  assert.match(screen, /context=\{folderContext\(folderId, playlist\.id\)\}/);
  assert.match(screen, /baseContext\(node\.context\) === playlist\.id &&\s+\(node\.position === null \|\| node\.position === row\.position\)/, "only the appearance that plays carries the accent");
  assert.match(screen, /trackActions\(\{\s+track: row\.track,\s+title: row\.title,\s+path: row\.path,\s+playlist,\s+entry: row\.entry,\s+\}\)\s+\}\s+removable=\{playlist\.editable\}/, "a playlist row removes the entry it shows, playable or not");
  assert.match(screen, /menu=\{playlist\.editable \? \(\) => playlistActions\(playlist\) : undefined\}/, "the playlist ⋯ sits in its head's actions");
  assert.match(library, /\{menu && <Button iconOnly label="Playlist actions" icon="more" onPress=\{menu\} \/>\}/);
  assert.match(library, /actions=\{\(row\) => trackActions\(\{ track: row\.track \}\)\}/, "an album's tracks open the same sheet");
  const list = library.slice(library.indexOf("function TrackList("), library.indexOf("const readyRows"));
  assert.match(list, /\{actions && \(\s+<Pressable\s+accessibilityRole="button"\s+accessibilityLabel="Track actions"[\s\S]*?onPress=\{\(\) => actions\(row\)\}[\s\S]*?<Icon name="more"/);
  assert.match(list, /accessibilityActions=\{\s+actions \? \[\{ name: "actions", label: "Track actions" \}\] : undefined\s+\}/, "screen readers reach the ⋯ as a row action");
  assert.match(list, /play\(contextOf \? contextOf\(track\) : context, track, false, row\.position, saved\?\.position \|\| 0\)/);
  const sheet = library.slice(library.indexOf("export function MusicSheet("), library.indexOf("const playingTrack"));
  assert.match(sheet, /\{sheet\.track && \(\s+<ActionRow\s+label="Add to playlist…"[\s\S]*?open\(\{ kind: "add-to-playlist", track: sheet\.track \}\)/, "an entry naming no track offers only Remove");
  assert.match(sheet, /\{sheet\.playlist\?\.editable && \(\s+<ActionRow\s+label="Remove from playlist"[\s\S]*?change\("remove", sheet\)/);
  assert.match(sheet, /\.filter\(\(playlist\) => playlist\.editable\)/, "only .m3u8 playlists take new tracks");
  assert.match(sheet, /title="New playlist…"\s+caption="Saved as a file in Playlists\/"/);
  assert.match(sheet, /change\("create", \{ name, track: sheet\.track \}\)/);
  assert.match(sheet, /change\("rename", \{ name, playlist: sheet\.playlist \}\)/);
  assert.match(sheet, /<View style=\{s\.destructiveActionGroup\}>\s+<ActionRow\s+label="Delete playlist…"\s+icon="trash"\s+danger/);
  assert.match(app, /trackActions=\{\(value\) =>\s+setSheet\(\{ kind: "track-actions", \.\.\.value \}\)\s+\}\s+playlistActions=\{\(playlist\) =>\s+setSheet\(\{ kind: "playlist-actions", playlist \}\)/);
  assert.match(app, /\{!!musicSheet\(shownSheet\) && \(\s+<MusicSheet/);
  const change = app.slice(app.indexOf("function changePlaylist("), app.indexOf("function deletePlaylist("));
  for (const call of ["r.addToPlaylist(folder.id, value.playlist.path, value.track.path)", "r.createPlaylist(folder.id, value.name, value.track.path)", "r.renamePlaylist(folder.id, value.playlist.path, value.name)"])
    assert.ok(change.includes(call), call);
  assert.match(change, /r\.removeFromPlaylist\(\s+folder\.id,\s+value\.playlist\.path,\s+value\.entry,\s+value\.path,\s+\)/);
  assert.match(change, /id: playlistKey\(folder\.id, result\.path\)/, "a renamed playlist stays open");
  assert.match(change, /await renameMusicPlay\(r, value\.playlist\.id, playlistKey\(folder\.id, result\.path\)\)\.catch\(\(\) => \{\}\);\s+setHistoryTick\(\(tick\) => tick \+ 1\);/, "a history that cannot be renamed never strands the renamed file, and Recent reads the renamed entry");
  const remove = app.slice(app.indexOf("function deletePlaylist("), app.indexOf("useEffect(", app.indexOf("function deletePlaylist(")));
  assert.match(remove, /await engine\.current\.removeFile\(folder\.id, playlist\.path\);/, "Delete playlist… is the phone's file deletion, so history keeps it");
  assert.match(remove, /hasUnsyncedContent\(folder\.id, playlist\.path\)[\s\S]*Its latest changes have not reached the hub, so this cannot be undone\./, "a playlist the hub never received says it cannot be undone");
  assert.match(app, /hasUnsyncedContent\(sheet\.volume, sheet\.path\)[\s\S]*Its latest changes have not reached the hub, so this cannot be undone\./, "and so does a file");
  const changed = app.slice(app.indexOf("function musicChanged("), app.indexOf("function changePlaylist("));
  assert.match(changed, /setMusicEdits\(\(count\) => count \+ 1\);\s+publishMusic\(engine\.current\)\.catch\(\(\) => \{\}\);\s+if \(connected && !status\.paused\) startSync\(\);/, "an edit shows at once, reaches the car and syncs");
  assert.match(app, /\[musicFolder, folder\?\.id, replica, status\.last, status\.musicTick, musicEdits\]/);
});

test("the native module ships the media library service, cover provider and car metadata on Media3 1.9.0", () => {
  const manifest = read(`${native}/AndroidManifest.xml`);
  assert.match(manifest, /FOREGROUND_SERVICE_MEDIA_PLAYBACK/);
  assert.match(manifest, /<service android:name="\.MusicService" android:exported="true" android:foregroundServiceType="mediaPlayback">\s+<intent-filter>\s+<action android:name="androidx\.media3\.session\.MediaLibraryService" \/>\s+<action android:name="android\.media\.browse\.MediaBrowserService" \/>/);
  assert.match(manifest, /<provider android:name="\.CoverProvider" android:authorities="\$\{applicationId\}\.arcamusic" android:exported="true" \/>/);
  assert.match(manifest, /android:name="com\.google\.android\.gms\.car\.application" android:resource="@xml\/automotive_app_desc"/);
  assert.match(read(`${native}/res/xml/automotive_app_desc.xml`), /<uses name="media" \/>/);
  const gradle = read("modules/arca-network/android/build.gradle");
  const versions = [...gradle.matchAll(/androidx\.media3:media3-[a-z]+:([0-9.]+)/g)].map((match) => match[1]);
  assert.equal(versions.length, 2);
  assert.equal(new Set(versions).size, 1, "exoplayer and session share one Media3 version");
  assert.match(gradle, /implementation\("androidx\.exifinterface:exifinterface:1\.4\.1"\)/, "the module asks for the exifinterface the app already resolves, so a release build never fetches Media3's older 1.3.6");
  const video = new URL("../apps/mobile/node_modules/expo-video/android/build.gradle", import.meta.url);
  if (fs.existsSync(video))
    assert.equal(fs.readFileSync(video, "utf8").match(/androidxMedia3Version = "([0-9.]+)"/)?.[1], versions[0], "the app links one Media3 version with expo-video");
  const module = read(`${native}/java/expo/modules/arcanetwork/ArcaNetworkModule.kt`);
  assert.match(module, /Events\("transferStopped", "musicState"\)/);
  for (const name of ["musicReload", "musicPlay", "musicCommand"]) assert.match(module, new RegExp(`AsyncFunction\\("${name}"\\)`));
  const provider = read(`${native}/java/expo/modules/arcanetwork/CoverProvider.kt`);
  assert.match(provider, /if \(mode != "r"\) throw SecurityException/);
  assert.match(provider, /Regex\("\^\[a-f0-9\]\{64\}-\(small\|large\)\\\\\.jpg\$"\)/);
  assert.match(provider, /File\(root, "arca\/\$scope\/music-covers\/\$name"\)/);
  const service = read(`${native}/java/expo/modules/arcanetwork/MusicService.kt`);
  assert.match(service, /File\(root\(context\), "music-library\.json"\)/, "the car reads the library the phone publishes");
  assert.match(service, /override fun onPlaybackResumption\(/);
  assert.doesNotMatch(service, /prepare\(\)|\.play\(\)/, "the service never starts playback on its own");
  const reload = service.slice(service.indexOf("fun reloadRunning("), service.indexOf("fun reloadRunning(") + 500);
  assert.match(reload, /instance\?\.let \{\s+it\.reload\(done\)\s+return\s+\}/);
  assert.match(reload, /\} finally \{\s+done\(\)\s+\}/, "a reload with the service stopped still answers");
  const applying = service.slice(service.indexOf("  fun reload(done"), service.indexOf("  fun applyRename("));
  assert.match(applying, /main\.post \{\s+try \{\s+if \(session == null\) return@post\s+tree = tree\.reloaded\(next\)[\s\S]*?\} finally \{\s+done\(\)\s+\}/, "musicReload answers only once the service holds the new library");
  assert.match(module, /AsyncFunction\("musicReload"\) Coroutine \{ ->\s+val applied = CompletableDeferred<Unit>\(\)\s+MusicService\.reloadRunning\(appContext\.reactContext \?: error\("App is unavailable"\)\) \{ applied\.complete\(Unit\) \}\s+applied\.await\(\)/);
  assert.match(module, /AsyncFunction\("musicRenameHistory"\) Coroutine \{ from: String, to: String ->[\s\S]*?MusicService\.renameHistory\([^)]*\), from, to\) \{ applied\.complete\(Unit\) \}\s+applied\.await\(\)/);
  const renaming = service.slice(service.indexOf("fun renameHistory("), service.indexOf("  private val main"));
  assert.match(renaming, /current\.renamed\(from, to\)\?\.let \{ saveHistory\(app, scope, it\.history\) \}[\s\S]*?instance\?\.applyRename\(from, to, done\) \?: done\(\)/, "a renamed playlist is renamed in the history file and in the running service's memory");
  assert.match(service, /if \(session != null && loaded\.isDone\) tree\.renamed\(from, to\)\?\.let\(::adopt\)/);
  assert.match(read("src/music-player.js"), /renameHistory: \(from, to\) => native\.musicRenameHistory\(from, to\),/);
  assert.match(reload, /if \(tree\(app\)\.expand\(item\) == null\) prefs\.edit\(\)\.clear\(\)\.apply\(\)/, "erasing clears the resume point even when the service is not running");
  assert.match(service, /File\(root\(context\), "music-history\.json"\)/, "the car reads the history the phone shows");
  assert.match(service, /MusicTree\.parseTrackNodeId\(mediaItems\[0\]\.mediaId\)\?\.let \{ played\(it\.first\) \}/, "every album started from the phone or the car is recorded");
  assert.match(service, /staged\.renameTo\(File\(directory, "music-history\.json"\)\)/);
  assert.match(service, /putString\(MediaConstants\.EXTRAS_KEY_CONTENT_STYLE_GROUP_TITLE, it\)/);
  assert.match(service, /tree = tree\.reloaded\(next\)/, "a reload never drops a play the file has not caught up with");
  assert.match(service, /out\.fd\.sync\(\)/);
  assert.match(service, /\.putBoolean\("shuffle", player\.shuffleModeEnabled\)/);
  assert.match(service, /return if \(seen\.containsKey\(slot\)\) seen\[slot\] else cover\(key, large\)\.also \{ seen\[slot\] = it \}/, "a long queue checks a missing cover once, not once per track");
  assert.match(service, /player\.shuffleModeEnabled = saved\.getBoolean\("shuffle", false\)\s+Futures\.immediateFuture\(restored\)/, "a resumed shuffle keeps shuffling");
  assert.match(read("src/files.js"), /musicHistory: \(\) => new File\(root, "music-history\.json"\)\.uri/, "the phone and the service share one history file");
  assert.match(module, /MusicService\.reloadRunning\(appContext\.reactContext/);
  assert.match(service, /tree\.stale\(current\.mediaId, current\.localConfiguration\?\.uri\?\.path\) \{ File\(it\)\.isFile \}/, "a track still on the phone keeps playing");
});

test("the phone and the native tree agree on the track node id format", () => {
  const kotlin = read(`${native}/java/expo/modules/arcanetwork/MusicLibrary.kt`);
  assert.match(kotlin, /private const val SEPARATOR = '\\u001F'/);
  assert.match(kotlin, /"track\$SEPARATOR\$context\$SEPARATOR\$track"/);
  assert.match(kotlin, /if \(position == null\) id else "\$id\$SEPARATOR\$position"/);
  assert.match(read("src/music-library.js"), /export const NODE_SEPARATOR = "\\u001F";/);
  assert.match(read("src/music-player.js"), /native\.musicPlay\(context, track, shuffle, position\)/);
  assert.match(read(`${native}/java/expo/modules/arcanetwork/ArcaNetworkModule.kt`), /AsyncFunction\("musicPlay"\) Coroutine \{ context: String, track: String, shuffle: Boolean, position: Int ->\s+music\(\)\.play\(context, track, shuffle, position\)/);
  assert.match(read(`${native}/java/expo/modules/arcanetwork/MusicRemote.kt`), /MusicTree\.trackNodeId\(contextId, trackId, position\.takeIf \{ it >= 0 \}\)/);
  const service = read(`${native}/java/expo/modules/arcanetwork/MusicService.kt`);
  assert.match(service, /tracks\.mapIndexed \{ index, track -> playable\(if \(context != null\) MusicTree\.trackNodeId\(context, track\.id, index\) else track\.id/, "every appearance in a queue has its own media id");
  assert.match(service, /id == MusicTree\.PLAYLISTS -> MediaMetadata\.MEDIA_TYPE_FOLDER_PLAYLISTS/);
});

test("Artists lists letter groups 120 artists at a time, no artist cover is round, and the car gets the letters as headings", () => {
  const index = library.slice(library.indexOf("function ArtistIndex("), library.indexOf("const resumeSeen"));
  assert.match(index, /artistGroups\(artists\.slice\(0, shown\)\)\.map\(\(group\) => \(\s+<Section key=\{group\.letter\}>\s+<Text style=\{s\.eyebrow\}>\{group\.letter\}<\/Text>\s+<View style=\{s\.group\}>/);
  assert.match(index, /artists\.length > shown && \(\s+<Button label="Show more" onPress=\{\(\) => setShown\(shown \+ PAGE\)\} \/>/);
  assert.match(library, /item\.kind === "artists"\)\s+return \(\s+<ArtistIndex\s+artists=\{library\.artists\}/);
  assert.doesNotMatch(library, /(?<!Math\.)\bround\b/);
  assert.doesNotMatch(read("src/theme.js"), /musicCoverRound/);
  const kotlin = read(`${native}/java/expo/modules/arcanetwork/MusicLibrary.kt`);
  assert.match(kotlin, /text\(item, "letter"\)\.takeIf \{ LETTER\.matches\(it\) \}/);
  assert.match(kotlin, /private fun artistNode\(artist: MusicArtist\) =\s+MusicNode\([^\n]*group = artist\.letter\)/);
});

test("Now playing is a full page whose artist and album go to their screens, and a playlist's rows name each track's album", () => {
  const page = read("src/NowPlayingPage.jsx");
  assert.match(page, /export function NowPlayingPage\(\{ visible, library, cover, command, play, openAlbum, openArtist, openShow, onClose, sleep, setSleep, seeked, positions \}\)/);
  assert.match(page, /accessibilityLabel=\{`Album \$\{track\?\.album \|\| state\.album\}`\}\s+disabled=\{!track\}\s+onPress=\{\(\) => track && openAlbum\(track\)\}/, "only a track this folder's library knows links to its album");
  assert.match(app, /openAlbum=\{\(track\) => openPlaying\(\[\{ kind: "albums" \}, \{ kind: "album", id: track\.albumId \}\]\)\}/);
  const opening = app.slice(app.indexOf("function openPlaying("), app.indexOf("function musicCommand("));
  assert.match(opening, /setNowPlayingOpen\(false\);[\s\S]*setFileView\("music"\);\s+setMusicSearch\(null\);\s+setMusicRoute\(route\);/, "it closes the page and opens the album in the library, even from View files");
  const list = library.slice(library.indexOf("function TrackList("), library.indexOf("const readyRows"));
  assert.match(library, /: numbered && !withAlbum\s+\? track\.artist\s+: `\$\{track\.artist\} · \$\{track\.album\}`;/);
  assert.match(list, /caption=\{trackCaption\(track, numbered, withAlbum\)\}/);
  const screen = library.slice(library.indexOf('const playlist = item.kind === "playlist"'), library.indexOf("const gone ="));
  assert.match(screen, /removable=\{playlist\.editable\}\s+withAlbum/, "a playlist's rows read “artist · album”");
  const album = library.slice(library.indexOf('item.kind === "album"'), library.indexOf('const playlist = item.kind === "playlist"'));
  assert.doesNotMatch(album, /withAlbum/, "an album's rows keep the artist alone");
  assert.match(library, /<TrackList[\s\S]*?withAlbum=\{withAlbum\}/);
});

test("the car names its queue and lists each track with its length, and a playlist's tracks with their album", () => {
  const service = read(`${native}/java/expo/modules/arcanetwork/MusicService.kt`);
  const tree = read(`${native}/java/expo/modules/arcanetwork/MusicLibrary.kt`);
  assert.match(service, /node\.track\?\.let \{ return playable\(node\.id, it, false, subtitle = node\.subtitle\) \}/, "browse rows carry the tree's subtitle");
  assert.match(service, /\.apply \{ if \(subtitle != null\) setDisplayTitle\(track\.title\)\.setSubtitle\(subtitle\) \}/, "a display title makes Media3 send the subtitle instead of the artist and album");
  assert.doesNotMatch(service.slice(service.indexOf("private fun queue("), service.indexOf("private inner class Callback")), /subtitle =/, "Now Playing keeps the artist and album");
  assert.match(service, /player\.playlistMetadata = MediaMetadata\.Builder\(\)\.setTitle\(context\?\.let\(tree::queueTitle\)\)\.build\(\)/, "the queue's name reaches Android Auto as the legacy queue title");
  assert.match(service, /played\(it\.first\) \}\s+nameQueue\(mediaItems\[0\]\.mediaId\)/);
  assert.match(service, /nameQueue\(null\)/, "a hand-built queue drops the previous name");
  assert.match(service, /nameQueue\(item\)\s+player\.shuffleModeEnabled/, "a resumed queue keeps its name");
  assert.match(tree, /val album = track\.album\.takeIf \{ base\(context\)\.startsWith\("playlist:"\) \}/);
  assert.match(tree, /listOfNotNull\(track\.artist, album, length\(track\.durationMs\)\)\.filter\(String::isNotBlank\)\.joinToString\(" · "\)/);
});

test("cover paths accept only hex keys and the two sizes", async () => {
  const vm = await import("node:vm");
  const source = read("src/files.js")
    .replace(/^import .*;\r?$/gm, "")
    .replace("export const files", "const files");
  class Entry {
    constructor(...parts) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
  }
  const files = vm.runInNewContext(source + "\nfiles;", { File: Entry, Directory: Entry, Paths: { document: "root" } });
  const key = "a".repeat(64);
  assert.equal(files.musicCover("hub-1", key, "small"), `root/arca/hub-1/music-covers/${key}-small.jpg`);
  for (const [scope, value, size] of [["hub-1", "../" + key, "small"], ["hub-1", key.toUpperCase(), "small"], ["hub-1", key, "huge"], ["../hub", key, "large"]])
    assert.throws(() => files.musicCover(scope, value, size));
});

test("the library has one back, the header's, and draws tabs only when there are two or more", () => {
  assert.doesNotMatch(library, /icon="back"/, "the body never adds a back row");
  assert.match(library, /\{tabs\.length > 1 && \(\s+<View style=\{s\.folderToolbar\}>\s+<View style=\{s\.flex\}>\s+<SegmentedControl/, "a podcasts-only folder has no one-segment control");
  assert.match(library, /\{!wide && \(\s+<View style=\{s\.musicHeader\}>\s+<Cover uri=\{cover\(artist\.cover, "small"\)\} size=\{72\} icon="artist" \/>/, "on the Fold the artist heads the screen instead");
  const header = app.slice(app.indexOf('{folder && screen === "Folders" && (\n                      <View style={s.compactActions}>'), app.indexOf("{historyDetail && ("));
  assert.match(header, /label=\{\s+musicDeep\s+\? musicBackLabel\(\s+musicRoute,\s+musicAt\.level,\s+musicShown,\s+folder\.name,\s+musicSearching,\s+\)\s+: "Folders"\s+\}/);
  assert.match(header, /musicDeep\s+\? setMusicRoute\(musicRoute\.slice\(0, musicAt\.level\)\)\s+: setFolder\(null\)/, "the header back leaves the level");
  assert.match(header, /\{!onboarding && \(detail \|\| !\(musicDeep && !musicArtist\)\) && \(/, "a show, album or playlist page keeps only the back arrow");
  assert.match(header, /\) : musicArtist \? \(\s+<ScreenTitle\s+contentIcon="artist"/, "the Fold heads an artist level with the artist");
  assert.match(app, /const musicHeaderSearch = !!musicShown && !musicDeep && musicTabs\(musicShown\)\.length < 2;/);
  assert.match(app, /\{musicHeaderSearch && \(\s+<Button\s+iconOnly\s+label=\{musicSearching \? "Close search" : musicSearchLabel\(musicShown\)\}/, "without tabs, search joins the header actions");
  assert.match(app, /musicView && shownMusic \? librarySummary\(shownMusic\.library\) :/, "the header counts episodes and shows like desktop");
  assert.match(app, /musicFolder\s+\? librarySymbol\(shownMusic\?\.library\)/);
  assert.match(app, /go=\{setMusicRoute\}/);
  assert.match(app, /const saved = await replica\.store\.musicLibrary\(replica\.scope, id\)\.catch\(\(\) => null\);\s+if \(saved\) symbols\[id\] = savedSymbol\(saved\.value\);/, "Folders learns which audio folders hold only podcasts");
});

test("the Fold opens a show, album or playlist beside its list under one header", () => {
  assert.match(library, /const pane = musicPane\(route, wide\);/);
  assert.match(library, /pane\.detail \? go\(\[\.\.\.route\.slice\(0, pane\.level \+ 1\), next\]\) : push\(next\)/, "choosing another item replaces the detail instead of stacking it");
  assert.match(library, /\{pane\.detail \? \(\s+<View style=\{s\.musicSplit\}>\s+<View style=\{s\.musicSplitList\}>\{main\}<\/View>\s+<View style=\{s\.musicSplitPane\}>/);
  assert.match(library, /selected && s\.musicSelected/);
  assert.match(library, /pane\.detail \? \(\s+<PagedRows items=\{list\} render=\{\(album, index\) => albumRow\(album, index, caption\(album\)\)\} \/>/, "albums list as rows beside the open album");
  assert.match(library, /\[album\.year, plural\(album\.tracks\.length, "track", "tracks"\)\]\.filter\(Boolean\)\.join\(" · "\)/, "an artist's albums read year and track count");
  const theme = read("src/theme.js");
  assert.match(theme, /musicSplitList: \{ width: g\.detailSideWidth, flexShrink: 0, gap: 16 \}/);
  assert.match(theme, /musicSelected: \{ backgroundColor: c\.tint \}/);
});

test("the mini player shows the playing track's cover from its own folder's library", () => {
  assert.match(app, /folderLibrary\(replica, playingVolume\)\.then\(/);
  assert.match(app, /<MiniPlayer\s+library=\{playingLibrary\}/);
  assert.match(app, /playingVolume && playingVolume !== folder\?\.id/);
});

test("Just arrived cards keep each name on one line with an ellipsis", () => {
  const strip = read("src/components.jsx");
  assert.match(strip, /<View style=\{\[s\.stack, s\.arrivalText\]\}>\s+<Text numberOfLines=\{1\} style=\{s\.rowTitle\}>\s+\{row\.path\.split\("\/"\)\.pop\(\)\}/);
  assert.match(read("src/theme.js"), /arrivalText: \{ flexShrink: 1 \}/);
});

test("Now playing reads the playing track's own folder and its links open that folder's library", () => {
  assert.match(app, /<NowPlayingPage\s+visible=\{nowPlayingOpen\}\s+library=\{playingLibrary\}/);
  const opening = app.slice(app.indexOf("function openPlaying("), app.indexOf("function musicCommand("));
  assert.match(opening, /playingVolume && playingVolume !== folder\?\.id\s+\? locals\.find\(\(f\) => f\.id === playingVolume\)\s+: null;\s+if \(other\) openFolder\(other\)/);
  assert.ok(opening.indexOf("openFolder(other)") < opening.indexOf("setMusicRoute(route)"), "the route is set after opening the folder resets it");
  assert.match(app, /openShow=\{\(track\) => openPlaying\(\[\{ kind: "podcasts" \}, \{ kind: "show", id: track\.show \}\]\)\}/);
  assert.match(app, /openArtist=\{\(artist\) => openPlaying\(\[\{ kind: "artists" \}, \{ kind: "artist", id: artist\.id \}\]\)\}/);
});

test("library search lists Shows and Episodes like desktop, and an episode plays in its show", () => {
  const search = library.slice(library.indexOf('if (item.kind === "search")'), library.indexOf('if (item.kind === "artists")'));
  assert.match(search, /<Text style=\{s\.eyebrow\}>SHOWS<\/Text>\s+<PagedRows items=\{results\.shows\} render=\{\(show, index\) => showRow\(show, index\)\} \/>/);
  assert.match(search, /<Text style=\{s\.eyebrow\}>EPISODES<\/Text>\s+<TrackList\s+rows=\{episodeRows\(library, results\.episodes\)\}\s+contextOf=\{\(track\) => folderContext\(folderId, track\.show\)\}/, "an episode plays or resumes in its show's queue");
  assert.match(search, /\{albums\(results\.albums\)\}/, "albums found list as rows beside an open album on the Fold");
  assert.match(search, /onPress=\{\(\) => open\(\{ kind: "artist", id: artist\.id \}\)\}/);
  assert.match(library, /const showRow = \(show, index\) => \([\s\S]*?onPress=\{\(\) => open\(\{ kind: "show", id: show\.id \}\)\}/, "a found show opens like one in the list, in the right pane on the Fold");
  assert.match(library, /\? withAlbum\s+\? \[track\.artist, formatDay\(track\.date\)\]\.filter\(Boolean\)\.join\(" · "\)/, "a found episode names its show");
});

test("on the Fold the open show or album is the pane's own list, without a card inside the card", () => {
  assert.match(library, /\{page\(pane\.detail, true\) \|\| gone\}/);
  assert.match(library, /<View style=\{flat \? s\.musicPaneList : s\.group\}>/);
  assert.equal((library.match(/flat=\{flat\}/g) || []).length, 4, "show, album and playlist pass it through Collection to the list");
  const theme = read("src/theme.js");
  assert.match(theme, /musicPaneList: \{ marginHorizontal: -g\.rowPaddingX, borderTopWidth: 1, borderColor: c\.divider \}/);
  assert.match(theme, /borderRadius: g\.cardRadius,\s+backgroundColor: c\.surface,\s+\},\s+musicPaneList/);
});

test("episode rows give their length in hours and minutes as desktop does, music keeps m:ss", () => {
  assert.match(library, /\{track\.podcast \? formatLength\(track\.duration\) : formatDuration\(track\.duration\)\}/);
});

test("header and folder captions only wrap between their · segments", () => {
  assert.match(app, /const folderSubtitle = unbroken\(`/);
  assert.match(app, /description=\{unbroken\(`\$\{f\.files\} files · \$\{bytes\(f\.bytes\)\} local`\)\}/);
  assert.match(app, /totals=\{unbroken\(`/);
  assert.match(read("src/format.js"), /\? unbroken\(`\$\{folder\.files/);
});
