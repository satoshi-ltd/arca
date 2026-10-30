import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const read = (file) => fs.readFileSync(new URL(`../apps/mobile/src/${file}`, import.meta.url), "utf8");
const app = read("App.jsx");
const library = read("VideoLibrary.jsx");
const player = read("VideoPlayer.jsx");
const theme = read("theme.js");

test("a video folder opens on its library with the clapperboard tile, even when it is not selected", () => {
  assert.match(app, /const videoFolder =\s+!!folder && !photoFolder && !musicFolder && isVideoFolder\(catalog, folder\.id\);/);
  assert.match(app, /const videoStreaming = videoFolder;/, "a Movies & TV folder always streams: the phone never keeps it");
  assert.match(app, /isVideoFolder\(catalog, f\.id\) && !galleryConfig\(f\)\s+\? "video"/, "opening a video folder starts on the library");
  const glyph = app.match(/const folderIcon = ([^;]+);/)[1];
  assert.equal(vm.runInNewContext(glyph, { photoFolder: false, musicFolder: false, videoFolder: true, librarySymbol: () => "music", shownMusic: null }), "clapperboard");
  assert.match(app, /const streamedVolumes = volumes\.filter\(\(v\) => isVideoFolder\(catalog, v\.id\) && !locals\.some\(\(f\) => f\.id === v\.id\)\);/);
  assert.match(app, /onPress=\{\(\) => openFolder\(\{ id: v\.id, name: v\.name, selected: 0 \}\)\.catch/, "a video folder on the hub opens to stream instead of asking to sync");
  const streamed = app.slice(app.indexOf("const streamedRow"), app.indexOf("const streamedRow") + 600);
  assert.doesNotMatch(streamed, /disabled=/, "its cached list stays browsable offline");
  const home = app.slice(app.indexOf("{folderSections(folderRows"), app.indexOf("Loading shared folders"));
  assert.match(home, /\{section\.kind === "video" &&\s+streamedVolumes\.map\(\(v, index\) => streamedRow\(v, section\.folders\.length \+ index\)\)\}/, "streamed folders join the Movies & TV section");
  assert.match(home, /<Eyebrow>Movies & TV<\/Eyebrow>\s+<View style=\{s\.group\}>\{streamedVolumes\.map\(streamedRow\)\}<\/View>/, "or form it when no selected video folder does");
  assert.match(home, /!locals\.some\(\(f\) => f\.id === v\.id\) && !isVideoFolder\(catalog, v\.id\)/, "and never sit under On hub · not selected");
  assert.match(read("home-data.js"), /\{ kind: "video", label: "MOVIES & TV" \}/);
  assert.match(app, /\{\(!videoStreaming \|\| !!currentFolder\?\.selected\) && \(\s+<Button\s+iconOnly\s+label="Folder actions"/, "a streamed folder offers no syncing; an old copy still has its actions so it can be removed");
  assert.doesNotMatch(app, /videoStreaming\s+\? volumes\.some/);
  assert.match(app, /\{videoFolder && !!folder\.selected && \(\s+<ActionRow\s+label=\{videoView \? "View files" : "View library"\}/);
  assert.match(app, /if \(folder && !folder\.selected && currentFolder\?\.selected\) setFolder\(currentFolder\);/, "starting to sync a streamed folder turns it into the selected folder");
  assert.match(app, /const writable = acceptsWrites\(catalog, folder\);/);
  assert.match(app, /\{writable && \(\s+<ActionRow\s+label="Add files…"/, "an old copy of a Movies & TV folder takes no new files");
  assert.match(app, /\{writable && !musicFolder && \(\s+<ActionRow\s+label="Add photos…"/);
  assert.match(app, /<ActionRow\s+label="Stop syncing…"\s+icon="unlink"\s+danger\s+disabled=\{busy \|\| !engine\.current\}/, "Stop syncing stays so the old copy can be removed");
  const incoming = read("IncomingShare.jsx");
  assert.equal(incoming.match(/locals\.filter\(\(f\) => acceptsWrites\(catalog, f\) && !galleryConfig\(f\)\)/g).length, 2, "shares into Arca never land in a Movies & TV folder");
});

test("the library reads the cache first, refreshes from the hub, and keeps the list when the hub is out of reach", () => {
  const load = app.slice(app.indexOf("const cached = await cachedVideoLibrary(replica, folder.id);"), app.indexOf("const shownVideo ="));
  assert.ok(load.indexOf("cachedVideoLibrary") < load.indexOf("refreshVideoLibrary"));
  assert.match(load, /if \(!connected\) \{\s+if \(active\) setVideoData\(\{ key, library: cached, offline: true \}\);/);
  assert.match(load, /catch \{\s+if \(active\) setVideoData\(\{ key, library: cached, offline: true \}\);/);
  assert.match(app, /pruneVideoLibraries\(replica, catalog\)/);
  assert.match(app, /videoArtLoader\.current\?\.request\(folder\.id, key, size\)/);
  assert.match(app, /connected && !status\.offline && folder\)\s+videoArtLoader/, "art is only asked for while the hub is reachable");
});

test("title pages own their header: the backdrop band carries back and the menu, and Back leaves the title first", () => {
  assert.match(app, /const videoTitleOpen = videoDeep && !!shownVideo\?\.library;/);
  assert.match(app, /\{!onboarding && !videoTitleOpen && \(\s+<View\s+style=\{\[\s+s\.viewHeader,/);
  const back = app.slice(app.indexOf("const handler = () => {"), app.indexOf("const selectTab"));
  assert.ok(back.indexOf("videoBack.current()") < back.lastIndexOf("setFolder(null)"));
  assert.match(library, /<Band item=\{item\} art=\{art\} back=\{back\} backLabel=\{videoBackLabel\(route\)\} more=\{\(\) => more\(item, season\?\.season\)\} \/>/);
  assert.match(library, /Resume|playLabel\(library, item\)/);
  assert.match(library, /<DockTile label="Start over" icon="rotate-ccw" onPress=\{\(\) => play\(target, 0\)\} \/>/);
  assert.match(library, /spoken=\{watched \? "Mark as unwatched" : "Mark as watched"\}/);
  assert.match(library, /\{wide \? \(\s+<View style=\{s\.videoSplit\}>/, "unfolded, the page splits in two columns");
});

test("tabs show only with two or more, the Kids tab stays, and the caption says where the videos come from", () => {
  assert.match(library, /\{tabs\.length > 1 && \(\s+<View style=\{s\.videoToolbar\}>\s+<View style=\{!wide && s\.flex\}>\s+<SegmentedControl\s+scroll=\{!wide\}\s+options=\{tabs\.map/, "five tabs scroll sideways on a narrow phone instead of wrapping");
  assert.match(library, /const sorting = current !== "home";/, "Movies, TV Shows, Kids and Others all show the sort that orders them");
  assert.match(library, /const caption = <Text style=\{s\.caption\}>Streaming from hub<\/Text>;/, "online, the caption says the videos come from the hub");
  assert.doesNotMatch(library, /localCaption|streaming|retry/);
  assert.match(read("video-library.js"), /if \(hasKids\(library\)\) tabs\.push\("kids"\);/);
  assert.match(library, /title="Connect to your hub to watch"/);
  assert.match(library, /Join your home network or Tailscale to browse and play\./);
  assert.match(library, /action=\{<Button label="Open Devices" onPress=\{openDevices\} \/>\}/, "offline always offers Devices");
  assert.doesNotMatch(library, /label="Retry"/);
});

test("the ⋯ sheet holds watched marks, Remove from this device and the destructive group; deletion goes through the confirm dialog, never the offline queue", () => {
  assert.match(app, /: musicSheet\(shownSheet\) \|\| videoSheet\(shownSheet\)\)\}/);
  assert.match(app, /<VideoSheet\s+sheet=\{shownSheet\}\s+locked=\{actionLocked\}\s+act=\{\(name\) => videoAction\(name, shownSheet\)\}/);
  assert.match(library, /<View style=\{s\.destructiveActionGroup\}>/);
  assert.doesNotMatch(app.slice(app.indexOf("function deleteVideoTitles("), app.indexOf("function videoAction(")), /queue|withQueuedPositions/i);
  assert.doesNotMatch(library + app, /Mark as kids|Not for kids|\/v1\/video\/kids/, "kids overrides are hub admin only");
});

test("the player streams with the token in a header, saves positions and plays Up next in landscape", () => {
  assert.match(app, /<VideoPlayer\s+session=\{videoSession\}/);
  assert.match(app, /videoSource\(\{\s+client,\s+volume: session\.volume,\s+item: session\.item,\s+networkType,/);
  assert.doesNotMatch(app, /selected: !videoStreaming|selected: session\.selected/, "the phone never plays a local copy");
  assert.match(app, /sendPosition\(\{ client, replica: engine\.current, volume: session\.volume, item: session\.item, position, duration \}\)\.catch\(\(\) => \{\}\)/);
  assert.match(app, /nextOf=\{\(item\) => \(videoSession \? followingEpisode\(videoSession\.library, item\) : null\)\}/);
  assert.match(app, /requireOptionalNativeModule\("ExpoNetwork"\) \? require\("expo-network"\) : null/);
  assert.match(player, /replaceAsync\(\{ uri: current\.uri, \.\.\.\(current\.headers \? \{ headers: current\.headers \} : \{\}\)/);
  assert.match(player, /nativeControls=\{false\}/);
  assert.match(player, /const portrait = height > width;/);
  assert.match(player, /transform: \[\{ rotate: "90deg" \}\]/, "a portrait phone shows the player turned to landscape without a native orientation lock");
  assert.match(player, /send\(\{ type: "exit", position \}\);/, "closing saves the position before the native player is released");
  assert.match(player, /send\(\{ type: "pause", position: absoluteTime\(currentRef\.current, player\.currentTime\) \}\)/);
  assert.match(player, /`Up next · in \$\{left\} s`/);
  assert.match(player, /label="Play now"/);
  assert.match(player, /label="Cancel"/);
  assert.doesNotMatch(player, /not available on this phone yet/);
  assert.match(player, /const options = subtitleOptions\(\{ availableSubtitleTracks \}, session\.item\.subtitles \|\| \[\]\);/, "the panel lists Off, embedded tracks and each sidecar file");
  assert.match(player, /player\.subtitleTrack = choice\.track;/, "choosing a sidecar turns embedded tracks off");
  assert.match(player, /remembered\.set\(titleKey\(session\.item\)/, "the choice is remembered per title");
  assert.match(player, /player\.timeUpdateEventInterval = 0\.25;/);
  assert.match(player, /const cue = sidecar && cues \? cueText\(cues, absoluteTime\(current, currentTime\)\) : null;/);
  assert.match(player, /<View pointerEvents="none" style=\{\[s\.videoCueBox, controls && s\.videoCueRaised\]\}>/, "the cue lifts above visible controls");
  assert.match(player, /cueCache\.current\.set\(sidecar, value\)/);
  assert.match(app, /loadSubtitles\(\{ client, volume: session\.volume, path, item: session\.item \}\)/);
  assert.match(player, /\.then\(\(\) => \{\s+if \(!mounted\) return;\s+if \(!engineTrack\.current\)\s+try \{\s+player\.subtitleTrack = null;/, "an engine's default or forced track never shows while the panel says Off");
  assert.match(player, /engineTrack\.current = choice\.track;/);
  assert.match(player, /if \(!option\) \{\s+if \(!engineTrack\.current\)\s+try \{\s+player\.subtitleTrack = null;\s+\} catch \{\}\s+return;\s+\}\s+restored\.current = true;/, "tracks that arrive after loading never bring the engine's default back while the panel says Off");
  assert.match(theme, /videoCue: \{\s+color: c\.onMedia,\s+backgroundColor: c\.mediaBar,[^}]*fontSize: wide \? 24 : 18,/);
  assert.match(app, /onNext=\{\(item\) => setVideoSession\(\(old\) => \(old \? \{ \.\.\.old, item, at: item\.position\?\.position \|\| 0 \} : old\)\)\}/, "Up next resumes the next episode where it stopped");
  assert.match(player, /\.then\(\(value\) => live && setSource\(\{ key, value \}\)\)/);
  assert.match(player, /\{session && source\?\.key === key \? \(/, "a new episode never mounts with the previous episode's stream");
  assert.match(player, /watchNetwork\?\.\(current, \(\) => \{[\s\S]*?send\(\{ type: "pause", position \}\);\s+player\.replaceAsync\(null\)/, "leaving Wi-Fi saves the position and drops the stream");
  assert.match(app, /watchPrivateNetwork\(source, \(listener\) => \{/);
  assert.match(player, /accessibilityActions=\{\[\s+\{ name: "increment", label: "Forward 30 seconds" \},\s+\{ name: "decrement", label: "Back 10 seconds" \},/);
  assert.match(player, /animationType="none"/);
});

test("Kids mode is gone: no Settings switch, stored setting or Kids-only filters, and Search Arca lists Videos", () => {
  for (const file of ["App.jsx", "VideoLibrary.jsx", "video-library.js", "video-sync.js", "theme.js"])
    assert.doesNotMatch(read(file), /kidsMode|KidsMode|KIDS_MODE|Kids mode|kidsLibrary|videoCardKids/, file);
  assert.match(app, /if \(library\) videos\.push\(\{ volume: \{ id: v\.id, name: v\.name \}, rows: searchVideos\(library, tokens, searchFold\) \}\);/);
  assert.match(app, /if \(item\.type === "video"\) \{/);
  assert.match(app, /pruneVideoLibraries\(replica, catalog\)\s+\.then\(\(\) => pruneVideoArt\(replica\)\)/);
});

test("posters carry a rating badge, title pages show facts and languages instead of the file line, and offline shows one message", () => {
  assert.match(library, /\{!wide && !!card\.rating && \(\s+<View style=\{s\.videoRating\} pointerEvents="none">/);
  assert.match(theme, /videoRating: \{\s+position: "absolute",\s+left: 6,\s+bottom: 6,/);
  assert.match(library, /<Facts facts=\{titleFacts\(item, library\)\} \/>/);
  assert.match(library, /const languages = titleFile\(library, item\) \? languageChips\(titleFile\(library, item\)\) : null;/);
  assert.match(library, /<Facts facts=\{titleFacts\(item, library\)\} \/>\s+\{!!languages && <Languages languages=\{languages\} \/>\}/, "the language chips sit under the facts row");
  assert.match(library, /<LanguageGroup icon="audio-lines" label=\{languages\.audioLabel\} codes=\{languages\.audio\} media=\{media\} \/>\s+<LanguageGroup icon="captions" label=\{languages\.subtitleLabel\} codes=\{languages\.subtitles\} media=\{media\} \/>/);
  assert.match(library, /<View style=\{s\.videoLanguageGroup\} accessible accessibilityLabel=\{label\}>\s+<Icon name=\{icon\} size=\{14\} color=\{media \? c\.onMedia : c\.soft\} \/>/, "the icon sits outside the chips, in the secondary colour");
  assert.doesNotMatch(library, /fileLine|subtitleLine/);
  assert.match(theme, /videoBadge: \{[^}]*borderWidth: 1,\s+borderColor: c\.line,/);
  assert.match(app, /\{!connected && !videoView && \(\s+<Card/, "the library's own empty state is the only offline message");
});

test("files with several audio tracks get an Audio panel that remembers the language per show", () => {
  assert.match(player, /useEvent\(player, "availableAudioTracksChange", \{ availableAudioTracks: \[\] \}\)/);
  assert.match(player, /: audioOptions\(availableAudioTracks, session\.item\.audioTracks\);/);
  assert.match(player, /\{!failed && audios\.length > 1 && <Round icon="audio-lines" label="Audio"/);
  assert.match(player, /player\.audioTrack = option\.track;/);
  assert.match(player, /rememberedLanguage\.set\(titleKey\(session\.item\), option\.language\)/);
  assert.match(player, /rememberedAudio\(audios, rememberedLanguage\.get\(titleKey\(session\.item\)\)\)/);
});

test("on the title page only the poster overlaps the backdrop band; the heading text starts below it", () => {
  const rule = (name) => theme.match(new RegExp(`\\b${name}: \\{[^}]*\\}`))[0];
  assert.doesNotMatch(rule("videoHead"), /marginTop|alignItems: "flex-end"|position/, "the heading row starts where the band ends");
  assert.match(rule("videoHead"), /alignItems: "flex-start"/);
  assert.match(rule("videoHeadPoster"), /marginTop: -64/);
  assert.doesNotMatch(rule("videoHeadText"), /marginTop: -|position|top:/, "the text column never moves up under the band");
  const head = library.slice(library.indexOf("<View style={s.videoHead}>"), library.indexOf("const playRow"));
  assert.match(head, /<View style=\{s\.videoHeadPoster\}>[\s\S]*<\/View>\s+<View style=\{s\.videoHeadText\}>/);
  assert.ok(library.indexOf("<Band ") < library.indexOf("{head}"), "the band is drawn before the heading");
});

test("sort and season pickers use the app's segmented control, there is no genre filter, sort joins the tabs row unfolded, and the last tab is Others", () => {
  assert.doesNotMatch(library, /function Chip|videoChip/);
  assert.doesNotMatch(theme, /videoChip/);
  assert.doesNotMatch(library, /genre|Filters/);
  assert.doesNotMatch(read("video-library.js"), /export function genres|genre = ""/);
  assert.match(library, /const sorter = <SegmentedControl scroll=\{!wide\} options=\{MOVIE_SORTS\} value=\{sort\} onChange=\{setSort\} \/>;/);
  assert.match(library, /\{sorting && \(!wide \|\| tabs\.length < 2\) && sorter\}/, "on the phone sort has its own row");
  assert.match(library, /\{wide && sorting && sorter\}\s+<\/View>/, "unfolded, sort sits at the end of the tabs row");
  assert.match(theme, /videoToolbar: \{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between"/, "it wraps below the tabs when it does not fit");
  assert.match(library, /options=\{show\.seasons\.map\(\(entry\) => \(\{ value: entry\.season, label: seasonLabel\(entry\) \}\)\)\}/);
  const components = read("components.jsx");
  assert.match(components, /export function SegmentedControl\(\{ options, value, onChange, scroll = false, fit = false, clearable = false \}\)/);
  assert.match(components, /return scroll \|\| fit \? \(\s+<ScrollView\s+horizontal\s+showsHorizontalScrollIndicator=\{false\}/);
  assert.match(theme, /segmentScroll: \{ flex: 0, paddingHorizontal: 12 \}/, "scrolling segments size to their labels");
  assert.match(read("video-library.js"), /other: "Others",/);
});

test("library kinds read Photos, Audio and Movies & TV to people", () => {
  assert.match(app, /\{ label: "Photos", value: "gallery" \}/, "the folder view toggle says Photos");
  assert.doesNotMatch(app, /label: "Gallery"|"Video library"|shared gallery/);
  assert.match(app, /: "Streams from hub · not on this phone";/);
  assert.match(read("search-local.js"), /videos: \["Movies & TV", "title", "Movies & TV"\]/);
  assert.match(read("MusicLibrary.jsx"), /load this Audio library\./);
  for (const file of ["gallery.js", "gallery-deletions.js"]) assert.doesNotMatch(read(file), /"[^"]*\bgallery (items|source|photos)\b[^"]*"/, file);
});

test("the player plays directly, falls back to a compatible stream, and keeps absolute time through seeks and audio changes", () => {
  assert.match(app, /mode: session\.mode \|\| "auto",\s+start: session\.start \|\| 0,\s+audio: session\.audio \?\? null,/);
  assert.match(player, /audio: audioForLanguage\(value\.item, rememberedLanguage\.get\(titleKey\(value\.item\)\), sameLanguage\)/, "the remembered language chooses the first session's audio");
  assert.match(player, /reopen=\{\(request\) => resolve\(\{ \.\.\.opening\(session\), \.\.\.request \}\)\}/);
  assert.match(player, /position: absoluteTime\(currentRef\.current, player\.currentTime\),\s+duration: fullDuration\(currentRef\.current, session\.item, player\.duration\),/);
  assert.match(player, /cueText\(cues, absoluteTime\(current, currentTime\)\)/, "subtitles follow absolute time");
  assert.match(player, /restarter\.current\.request\(target, \{ audio: chosenAudio\.current \}\);/, "seeking a compatible stream restarts it, debounced");
  assert.match(player, /if \(plan === "fallback"\) fellBack\.current = true;\s+else retried\.current = true;\s+restarter\.current\.now\(\{ start: model\.current\.position, audio: chosenAudio\.current \}\);/, "errors recover once from the current position with the chosen audio");
  assert.match(player, /if \(status === "readyToPlay" && currentRef\.current\.compatible && !holding\.current\) retried\.current = false;/, "a stream that plays again may recover again later");
  assert.match(player, /const plan = seekPlan\(currentRef\.current, target, \{ duration: player\.duration, buffered: player\.bufferedPosition, currentTime: player\.currentTime, produced: produced\.current \}\);/);
  assert.match(player, /if \(Number\.isFinite\(player\.bufferedPosition\)\) produced\.current = Math\.max\(produced\.current, player\.bufferedPosition\);/, "the furthest buffered point stands in for a growing playlist's missing duration");
  assert.match(player, /produced\.current = 0;\s+player\s+\.replaceAsync/, "a new session starts with nothing produced");
  assert.match(player, /if \(!plan\.local \|\| holding\.current \|\| restarter\.current\.pending\(\)\) \{/, "only seeks beyond the produced range, or during a switch, open a session");
  assert.match(player, /player\.currentTime = plan\.time;/);
  assert.match(player, /initialAudio=\{opening\(session\)\.audio\}/);
  assert.match(player, /restarter\.current\.now\(\{ start: model\.current\.position, audio: option\.stream \}\);/, "a new audio track opens a new session");
  assert.match(player, /const audios = current\.compatible \? libraryAudioOptions\(session\.item\.audioTracks\)/);
  assert.match(player, /useEffect\(\(\) => \(\) => restarter\.current\.stop\(\), \[\]\);/, "closing drops pending sessions");
  assert.match(player, /position = switching\.current \|\| holding\.current \? null : absoluteTime\(current, player\.currentTime\);/, "switching streams keeps the seek target as the saved position");
});

test("new video sources carry no comments and take colours from the palette", () => {
  for (const file of ["VideoLibrary.jsx", "VideoPlayer.jsx", "video-library.js", "video-sync.js", "video-player-state.js", "video-audio.js", "subtitles.js", "video-compatible.js", "video-downloads.js"]) {
    const source = read(file);
    assert.doesNotMatch(source, /^\s*(\/\/|\/\*)/m, file);
  }
  const styles = theme.slice(theme.indexOf("videoArt: {"), theme.indexOf("musicPage: { gap: 16 },"));
  assert.match(styles, /videoBandScrim: \{[^}]*backgroundColor: c\.mediaScrim/);
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});

test("title pages end with the hub's Related row, in the right pane on the Fold and above a show's episodes", () => {
  assert.match(library, /const relatedRow = related && <Shelf shelf=\{related\} art=\{art\} open=\{open\} \/>;/);
  assert.match(library, /<View style=\{s\.videoSplitMain\}>\s+\{!show && facts\}\s+\{relatedRow\}\s+\{episodesPane\}/);
  assert.match(library, /\{facts\}\s+\{relatedRow\}\s+\{episodesPane\}/);
  assert.match(library, /mark=\{mark\}\s+open=\{open\}/, "tapping a related poster opens its page");
});

test("the title page poster carries the watched mark the moment the title is marked", () => {
  assert.match(library, /<Art uri=\{art\(item\.poster, "small"\)\} shape="poster" icon=\{show \? "tv" : "clapperboard"\} \/>\s+\{watched && <Watched \/>\}/);
});

test("Mark as unwatched uses the eye-off icon on the page and in the sheet, like desktop", () => {
  assert.match(library, /icon=\{watched \? "eye-off" : "check"\}/);
  assert.match(library, /label=\{watched \? "Unwatch" : "Watched"\}/);
  assert.match(library, /unwatched: \["Mark as unwatched", "eye-off"\]/);
});

test("a movie page offers Download in its dock and every episode row shows only its download state", () => {
  assert.match(library, /const tile = show \? null : downloadTile\(row, allowed\);/, "the movie action is a tile in the dock beside Start over and Watched");
  assert.match(library, /const note = show \? "" : downloadNote\(row, allowed, item, Platform\.OS\);/, "one line below the tiles says why Download is off, or that a download runs");
  assert.match(library, /\{!!note && <Text style=\{s\.caption\}>\{note\}<\/Text>\}/);
  assert.match(library, /const tileAction = \{ start: \(\) => startDownload\(\[item\]\), cancel: \(\) => cancelDownload\(\[item\]\), manage: \(\) => more\(item\), none: undefined \};/);
  assert.match(library, /spoken=\{tile\.disabled \? `Download unavailable\. \$\{note\}` : tile\.action === "cancel" \? `\$\{tile\.label\}, cancel download` : tile\.label\}/);
  const dock = library.slice(library.indexOf("function DockMain("), library.indexOf("function EpisodeState("));
  assert.match(dock, /<View style=\{s\.videoDockEdge\} pointerEvents="none">/, "Resume carries its progress on its bottom edge");
  assert.match(dock, /\{ring \? <Ring large value=\{value\} \/> : <Icon name=\{icon\} size=\{20\} color=\{c\.ink\} \/>\}/);
  assert.match(theme, /videoDockTile: \{\s+flex: 1,\s+minWidth: 0,/, "the tiles share the column equally");
  const episode = library.slice(library.indexOf("function EpisodeState("), library.indexOf("function VideoCard("));
  assert.match(episode, /\{ep\.watched && <Icon name="check" size=\{20\} color=\{c\.accent\} \/>\}\s+\{chip && \(\s+<View accessible accessibilityLabel=\{downloadLabel\(row\)\}>\s+<Tag variant=\{chip\.variant\}>\{chip\.label\}<\/Tag>/, "the watched check stays beside the state tag in every state");
  assert.doesNotMatch(episode, /Pressable|onPress|cancel|Ring|"download"/, "an episode row holds no download or cancel button");
  assert.match(library, /<EpisodeState ep=\{ep\} row=\{row\} \/>\s+\{!!more && \([\s\S]*?\)\}\s+<\/PressScale>/);
  assert.doesNotMatch(library, /Downloading season|seasonProgress|running\.active/, "the season has no progress line and no Cancel");
  assert.doesNotMatch(library, /Download season|missing\.length/, "the season picker has no general download; each episode downloads on its own");
  assert.match(library, /"remove-download": \["Remove from this device", "phone"\]/);
  assert.match(library, /"cancel-download": \["Cancel download", "x"\]/);
  assert.match(library, /download: \[downloadTile\(row, true\)\.label, "download"\]/, "the sheet says Download, Download again or Try again like the tile");
  assert.match(library, /const actions = titleActions\(sheet\.item, saved\);/);
  assert.match(library, /\{card\.saved && <Saved \/>\}/);
  assert.match(library, /<Icon name="arrow-down-to-line" size=\{14\} color=\{c\.onMedia\} \/>/, "posters carry a small download badge");
  assert.match(theme, /videoSaved: \{\s+position: "absolute",\s+top: 6,\s+left: 6,/);
});

test("offline, the library shows its downloads, or asks to connect when there are none", () => {
  const offline = library.slice(library.indexOf("  if (offline) {"), library.indexOf("const caption ="));
  assert.match(offline, /const saved = downloadedTitles\(shown, download\);/);
  assert.match(offline, /if \(!saved\.length\) return <VideoOffline hubName=\{hubName\} openDevices=\{openDevices\} \/>;/);
  assert.match(offline, /<Text style=\{s\.caption\}>\{OFFLINE_DOWNLOADS\}<\/Text>\s+<Grid key="downloads" cards=\{saved\} art=\{art\} open=\{open\} scrollRef=\{scrollRef\} scrollY=\{scrollY\} \/>/);
  assert.ok(library.indexOf('route[1]?.kind === "title"') < library.indexOf("  if (offline) {"), "a downloaded title still opens offline");
  assert.match(library, /videoShelves\(shown, download\)\.map/);
});

test("the app plays downloads without the hub, queues positions and resumes downloads when Wi-Fi or the hub returns", () => {
  assert.match(app, /playbackSource\(\{\s+downloads: downloads\.current,\s+volume: session\.volume,\s+item: session\.item,\s+mode: session\.mode \|\| "auto",\s+audio: session\.audio \?\? null,\s+stream: \(\) =>\s+videoSource\(/);
  assert.match(app, /playbackCues\(\{\s+downloads: downloads\.current,[\s\S]{0,200}load: \(\) => loadSubtitles\(/);
  assert.match(app, /const manager = createVideoDownloads\(\{ replica, client, onChange: setVideoDownloads \}\);/, "downloads run on any network that reaches the hub");
  assert.match(app, /const fresh = await refreshVideoLibrary\(replica, folder\.id, \{ signal: controller\.signal, downloads: downloads\.current \}\);/, "only a fresh library from the hub removes downloads");
  assert.match(app, /if \(catalog\) downloads\.current\?\.pruneVolumes\(catalog\)\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(app, /cachedVideoLibrary\([^)]*downloads/);
  assert.match(app, /if \(!connected \|\| status\.offline \|\| !replica\?\.scope\) return;\s+downloads\.current\?\.resume\(\)\.catch\(\(\) => \{\}\);\s+flushPositions\(\{ client, replica \}\)/);
  assert.match(app, /network\?\.addNetworkStateListener\(\(\) => downloads\.current\?\.resume\(\)/);
  const load = app.slice(app.indexOf("const cached = await cachedVideoLibrary(replica, folder.id);"), app.indexOf("const shownVideo ="));
  assert.match(load, /await withQueuedPositions\(replica, folder\.id, cached\);/, "offline, the list resumes from positions still queued");
  assert.ok(load.indexOf("flushPositions") < load.indexOf("refreshVideoLibrary"), "queued positions reach the hub before the list is read again");
  const action = app.slice(app.indexOf("function videoAction("), app.indexOf("\n  }\n", app.indexOf("function videoAction(")));
  assert.match(action, /if \(name === "download"\) \{\s+startDownload\(\[item\]\);\s+return;\s+\}/);
  assert.match(action, /if \(name === "remove-download" \|\| name === "cancel-download"\) \{\s+removeDownloads\(volume, downloadTargets\(item\)\);/);
  assert.match(app, /<VideoSheet\s+sheet=\{shownSheet\}\s+locked=\{actionLocked\}\s+act=\{\(name\) => videoAction\(name, shownSheet\)\}\s+download=\{videoDownload\}\s+canDownload=\{\(item\) => downloadable\(item, Platform\.OS\)\}/, "the sheet reads the live download state");
  assert.doesNotMatch(app, /downloaded: downloadTargets/);
});

test("titles this phone cannot play from a file offer Download disabled with the reason on its own row", () => {
  assert.match(app, /canDownload=\{\(item\) => downloadable\(item, Platform\.OS\)\}/);
  assert.match(app, /mode: session\.mode \|\| "auto",\s+audio: session\.audio \?\? null,\s+stream: \(\) =>/, "the chosen audio decides whether the file can play alone");
  assert.match(library, /const allowed = show \? false : canDownload\(item\);/);
  assert.match(app, /itemDownload\(videoDownloads\.get\(downloadKey\(folder\.id, item\.path\)\), item\)/, "a copy of an older version reads Download again");
  assert.match(library, /disabled=\{locked \|\| \(name === "download" && blocked\)\}\s+note=\{name === "download" && blocked \? downloadNote\(row, false, sheet\.item, Platform\.OS\) : undefined\}/, "an episode that cannot be downloaded shows Download disabled with the reason in its sheet");
});

test("Watch next marks a next episode NEXT and a recent arrival NEW over its still", () => {
  assert.match(library, /\{\(card\.next \|\| card\.fresh\) && \(\s+<View style=\{s\.videoNext\} pointerEvents="none">\s+<Text style=\{s\.videoRatingText\}>\{card\.next \? "NEXT" : "NEW"\}<\/Text>/);
  assert.match(theme, /videoNext: \{\s+position: "absolute",\s+left: 6,\s+top: 6,/);
});

test("a Watch next card opens a sheet on long press with Details and Remove, and Undo restores it", () => {
  assert.match(library, /onLongPress=\{removable \? \(\) => hold\(card\) : undefined\}/);
  assert.match(library, /accessibilityActions=\{removable \? \[\{ name: "remove", label: "Remove from Watch next" \}\] : undefined\}/, "TalkBack offers the same action");
  assert.match(library, /<ActionRow label="Remove from Watch next" icon="circle-minus"/);
  assert.match(app, /hold=\{\(card\) => setSheet\(\{ kind: "video-watch", card, volume: folder\.id \}\)\}/);
  assert.match(app, /client\.api\("\/v1\/video\/watch-next\/remove", \{ volume, id \}\)/);
  assert.match(app, /action: "video-watch-undo", actionLabel: "Undo"/);
  assert.match(app, /client\.api\("\/v1\/video\/watch-next\/restore", \{ volume: item\.volume, id: item\.videoId \}\)/);
});

test("phone badges centre their label: fixed tag height and no font padding", () => {
  assert.match(theme, /videoBadge: \{\s+minHeight: g\.tagHeight,\s+justifyContent: "center",\s+alignItems: "center",/);
  for (const name of ["videoBadgeText", "videoRatingText"]) assert.match(theme, new RegExp(`${name}: \\{[^}]*includeFontPadding: false, textAlignVertical: "center" \\}`), name);
});

test("the phone's poster grids hold every title without paging: rows are virtualized by the screen's own scroll", () => {
  const start = library.indexOf("function Grid(");
  const grid = library.slice(start, library.indexOf("function ", start + 10));
  assert.doesNotMatch(library, /Show more|const PAGE\b/);
  assert.match(grid, /scrollRef\.current = \(y\) => follow\.current\(y\)/, "the grid follows the scroll the screen already reports");
  assert.match(grid, /position\?\.measure\(root\.current/, "its offset inside the scroller is measured, not guessed");
  assert.match(grid, /rows\.slice\(first, last \+ 1\)/, "only the rows in range are mounted");
  assert.match(library, /\(!!card\.caption \|\| fill\) && \(/, "a card without a year keeps the row height of the others");
  assert.match(app, /<VideoLibrary[\s\S]*?scrollRef=\{galleryScroll\}\s+scrollY=\{galleryScrollY\}/);
  assert.match(theme, /videoGridRow: \{ flexDirection: "row", gap: 12, marginBottom: 12 \}/);
});

test("an open video library refreshes by itself every minute and when the app returns to the foreground, redrawing only when the hub's answer changed", () => {
  const start = app.indexOf("const timer = setInterval(refresh, VIDEO_REFRESH_MS);");
  const effect = app.slice(app.lastIndexOf("useEffect(() => {", start), app.indexOf("}, [videoFolder, folder?.id, replica, connected]);", start));
  assert.match(effect, /AppState\.currentState !== "active"/, "never while the app is in the background");
  assert.match(effect, /if \(!fresh\.changed\) return;/, "an unchanged answer redraws nothing");
  assert.match(effect, /AppState\.addEventListener\("change", \(value\) => value === "active" && refresh\(\)\)/);
  assert.match(effect, /clearInterval\(timer\);\s+listener\.remove\(\);/);
  assert.match(read("sync-cadence.js"), /export const VIDEO_REFRESH_MS = 60000;/);
});


test("the sheet separates Remove from this device (neutral smartphone) from the danger group that owns the only trash icon", () => {
  const sheet = library.slice(library.indexOf("export function VideoSheet("));
  assert.doesNotMatch(library, /Remove download/);
  assert.match(sheet, /<ActionRow\s+key=\{name\}\s+label=\{labels\[name\]\[0\]\}\s+icon=\{labels\[name\]\[1\]\}\s+divider=\{index > 0\}/);
  assert.doesNotMatch(sheet.slice(0, sheet.indexOf("destructiveActionGroup")), /"trash"|danger/);
  assert.match(sheet.slice(sheet.indexOf("destructiveActionGroup")), /icon="trash" danger/);
  assert.equal((sheet.match(/"trash"/g) || []).length, 1);
});

test("every episode row on the phone and the Fold ends with one ⋯ that opens the same sheet as the long press", () => {
  const row = library.slice(library.indexOf("function EpisodeRow("), library.indexOf("function Seasons("));
  assert.doesNotMatch(row, /compact && !!more/, "the ⋯ is not limited to the Fold");
  assert.equal((row.match(/accessibilityLabel="Episode actions"/g) || []).length, 1);
  assert.equal((row.match(/<Pressable/g) || []).length, 1, "the ⋯ is the row's only button");
  assert.match(row, /onLongPress=\{more \? \(\) => more\(ep\) : undefined\}/);
  assert.match(row, /accessibilityLabel="Episode actions" hitSlop=\{4\} onPress=\{\(\) => more\(ep\)\}/);
  assert.ok(row.indexOf("<EpisodeState") < row.indexOf('accessibilityLabel="Episode actions"'), "the state comes before the ⋯");
  assert.doesNotMatch(theme, /videoEpisodeMore|videoDownload:|videoSeasonBar/);
});

test("the episode sheet lists Mark as watched, the download action for its state, then Delete episode… in the destructive group", () => {
  const sheet = library.slice(library.indexOf("export function VideoSheet("));
  assert.match(sheet, /const saved = show \? downloadTargets\(sheet\.item\)\.some\(\(target\) => !!download\(target\)\) && "remove-download" : downloadAction\(row\);/);
  assert.ok(sheet.indexOf("actions.map") < sheet.indexOf("destructiveActionGroup"), "the destructive group comes last");
  const pane = library.slice(library.indexOf("const episodesPane"), library.indexOf("const heroActions"));
  assert.doesNotMatch(pane, /Button|cancelDownload|startDownload/, "the season holds no progress line, no Cancel and no Download season");
});
