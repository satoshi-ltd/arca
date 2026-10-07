# Arca roadmap

Updated 2026-10-07 · Phase 1 functional, not release-qualified.

This is the task pool. [SPEC.md](SPEC.md) owns current state, contracts, operations and the design system; [CHANGELOG.md](CHANGELOG.md) records what each version shipped; [AGENTS.md](AGENTS.md) defines the autonomous workflow that consumes this file.

## How this file works

Every task is one entry that a single commit can finish, with fixed fields (decisions only need their question):

- **ID** — stable, never reused. Keep an existing ID when SPEC or the changelog cites it.
- **type** — `bug`, `feature`, `chore`, `ui` (a visual change whose proposal is a board on `design/proposals.html`), `verify` (evidence from a real device or environment), `deploy` (build, install or publish outside the repository) or `decision`.
- **owner** — `agent` (Claude can finish it in the repository and prove it with tests) or `maintainer` (needs a device, a native build, Casa, credentials or a product choice).
- **priority** — `high`, `normal` or `low`. Within each section, order is priority, then position; Proposed sections follow the stabilization order below.
- **depends** — IDs that must finish first.
- **accept** — what proves it done. Agent tasks need evidence a test or command can show.

Lanes:

- **Queue** — approved agent tasks, in the order they will be done. Only the maintainer moves a task here, with two exceptions that enter at the top: a bug the maintainer reports, and a red pipeline on `main`.
- **In progress** — at most one agent task.
- **Needs maintainer** — `verify`, `deploy` and `decision` tasks, and agent work waiting on one of them.
- **Proposed** — ideas not yet approved, from the maintainer or from Claude. Never worked on until approved.

A purely visual idea is not filed here as Proposed: its board in `design/proposals.html` is the proposal. Once the maintainer approves it, it enters Queue as a `ui` task with the board ID and `accept: the board`; when it ships, delete the task and the board. A task that mixes logic and a screen splits: the screen is board `UI-<TASKID>`, the logic stays under its ID and its accept says "the interface follows board UI-<TASKID>"; a board ID never equals a non-`ui` task ID. When a task ships, delete it and record it in the changelog and in the SPEC section it changes. When a feature needs device evidence, split it: the implementation is an agent task; the device check is a maintainer `verify` task that depends on it. The loop never builds native code, so a `NAT-*` task ends with its JavaScript and contract tests; its compile and device evidence come from a maintainer build (BUILD-MOBILE or BUILD-IOS) recorded as a follow-up `verify`.

## Queue

_None._

## In progress

_None._

## Needs maintainer

### Builds and deployments

- **BUILD-MOBILE** — Android native build for stabilization
  `deploy · maintainer · high`
  accept: a standalone build of the chosen candidate is installed on the Fold; record its source SHA, displayed version and native build identifier. Native modules match the JavaScript bundle; cold start, pairing and one complete upload/download work before device qualification begins.
- **BUILD-IOS** — First iOS device build on SDK 57
  `deploy · maintainer · normal`
  accept: a build of the chosen candidate is installed on a physical iPhone; record source SHA, version and native build identifier. Cold start, LAN pairing, upload/download, cancellation and file replacement work; the native module compiles against the installed Expo dependencies.
- **P2-GALLERY-VIEW** — Ship the desktop/web gallery in installers and on Casa
  `verify · maintainer · normal`
  accept: shipped installers and Casa carry the production dependencies (Sharp, exifr) and the gallery opens on both.

### Device checks

- **OFFLINE-DEVICE** — Offline replicas on real machines
  `verify · maintainer · high · depends: BUILD-MOBILE`
  accept: with Casa unreachable (Tailscale off or the hub stopped), the Fold and the Mac open every view, browse folders, open and share local files and show hub-only actions as unavailable; reconnecting resumes sync without restarting either app.
- **VERIFY-SHARE-CACHE** — Incoming shares on the Fold
  `verify · maintainer · high · depends: BUILD-MOBILE`
  accept: sharing one and several files, a large file and a file named like a path from another app into Arca on the Fold lists them in the Save sheet with their real names, saves them, and leaves nothing under the app's cache except generated names (`arca-incoming/<id>-<n>`) while the sheet is open and nothing after Save or Cancel.
- **FOLD-STORAGE** — Account for persistent storage on the Fold
  `verify · maintainer · high · depends: BUILD-MOBILE`
  accept: after sync and a restart, account separately for complete working copies, pending originals, transfer staging, databases and derivative caches. No unexplained second full copy or unbounded staging growth remains; low-space recovery preserves pending originals and existing working files. Never remove live files to meet a storage target.
- **FOLD-THUMBNAILS** — Gallery thumbnails, posters and viewer
  `verify · maintainer · high · depends: BUILD-MOBILE`
  accept: on the candidate, grid thumbnails and video posters fill in while folders sync; HEIC photos open and the viewer shows the thumbnail immediately. Offline, downloaded photos remain viewable, unavailable originals are identified and failed derivatives can recover. Record timings and native errors for persistent grey tiles or crashes, including after suspension and cold start.
- **WIN-UPDATE-WATCHER** — A failed Windows update gets the daemon back
  `verify · maintainer · high`
  accept: on a real Windows machine, with an update that fails after Arca closes (for example a locked installation file), the daemon is running again within about a minute without opening Arca, `update-watch.log` in the state directory says `restored` and `%TEMP%\arca-update-watch-*` is gone; a successful update logs `relaunched` and starts no second daemon.
- **P2-GALLERY** — Album uploads on physical devices
  `verify · maintainer · high · depends: BUILD-MOBILE, BUILD-IOS`
  accept: original cloud access and EXIF/RAW/HEIC/Live Photo fidelity (limited access and editor workflows included), and a Samsung run with a library over 10 GiB covering screen-off/background continuity, battery restrictions, interruption and resumed completion. Pending picks survive process termination, lost upload responses and low storage without losing names, duplicating accepted paths or deleting Photos originals. Verify the historical archive and real-phone uploads before removing Immich or claiming a migration.
- **P2-GALLERY-DELETE-DEVICE** — Shared gallery deletion on devices
  `verify · maintainer · high · depends: BUILD-MOBILE, BUILD-IOS`
  accept: with disposable photos on Android and iOS: direct shared deletion, Live Photo groups, connection failure, partial selection failure and unchanged Photos originals; deletions persist across remounts; non-recursive directory deletion works (Android `Files.delete`, iOS `rmdir`).
- **P2-MOBILE** — Mobile replica acceptance
  `verify · maintainer · high · depends: BUILD-MOBILE, BUILD-IOS`
  accept: complete persistent copies, honest incomplete-work reporting, imports reaching the hub, resumable transfers without corruption, no data loss on suspension; low storage, interrupted downloads, revoked credentials and offline access. Reimporting a file preserves edited conflict copies; failed imports preserve existing files. Cached views remain usable during slow refreshes and back navigation. Check keyboard handling and text scaling on phone, Fold and iOS; launcher and splash in a standalone build; rename; APK opening on Samsung; Fold sticky scroll; settings visuals; iOS LAN pairing; name propagation; Fold throughput.
- **VERIFY-REVEAL-FILE** — Show in folder on real Windows and Linux
  `verify · maintainer · normal`
  accept: on a Windows and a Linux desktop build, a file detail's Show in folder and the photo viewer's open the file's own folder (Explorer with the file selected on Windows, a file manager on the file's folder on Linux), including a file in a nested folder, a path with spaces and, on Windows, a path longer than 260 characters (the verbatim prefix is stripped for Explorer).
- **FOLD-GALLERY-UX** — Gallery gestures and playback
  `verify · maintainer · normal`
  accept: infinite scroll both ways, the fast-scroll thumb follows the finger with sparse year chips, pinch density levels (also on iOS), videos autoplay when opened, and Info pauses and resumes a video.
- **P2-VIDEO** — Video on physical devices
  `verify · maintainer · normal`
  accept: playback with audio, seeking and rotation on Android and iOS; local posters on iOS.
- **P2-SHARING** — Incoming sharing
  `verify · maintainer · low`
  accept: the iOS Share Extension works; cold-start, foreground and multiple-file shares work. Known gaps stay documented: text/plain streams, links and text are not imported, and duplicate temporary filenames must be shared separately.

- **VERIFY-ANDROID-AUTO** — Arca plays in the car
  `verify · maintainer · normal · depends: MOB-ANDROID-AUTO`
  accept: a sideloaded build on the Fold with Unknown sources enabled in Android Auto's developer settings appears on the Desktop Head Unit on the Mac and in the car; Artists, Albums, Playlists and Recent browse with covers; a track plays with lock-screen and steering-wheel controls; the car starts Arca cold with the phone locked and offline; nothing auto-plays on connection.

### Phase 1 qualification

Phase 1 acceptance: a real hub and replica demonstrate creation, initial full sync, independent destinations, offline edits, reconnection, conflict preservation, deletion, restoration, revocation and restart recovery; backup restore is checked independently; web authentication and unauthorized access are verified; users can identify the managed machine and recover from errors without guessing.

Qualification evidence identifies one candidate version/SHA and the running builds, dataset, duration and result. Source tests, published artifacts, deployment and real-device verification are separate gates. Data-preservation fixes and recovery qualification take precedence over new features and visual work; pending Proposed fixes still need approval before implementation.

- **P1-LOAD** — Sustained load
  `verify · maintainer · high`
  accept: a 24-hour run on a disposable dataset of at least 100,000 entries with concurrent replicas, edits, reconnects and large transfers; record CPU/RSS/disk growth, HTTP and mutation latency, pause/unlink responsiveness and snapshot-lease cleanup. After activity settles, content hashes agree, queues drain and resource use returns to a bounded idle level. Workloads containing application state use safe test copies.
- **P1-RECOVERY** — Recovery drill
  `verify · maintainer · high`
  accept: on disposable state, interrupt a transfer and an acknowledged replacement with process termination and physical power loss, then restart and reconcile. Independently restore a full backup into a fresh isolated hub after the original hub is unavailable; compare current file hashes, retained history and deletions against the expected dataset, including after retention/GC. Record any lost acknowledgement or bytes; never reset the live pilot or enable its backup incidentally. A directory flush that fails after the rename is reported but not repeated on recovery (the file already matches, so `replaceFile` is not called again), and iOS `fsync` is not `F_FULLFSYNC`; decide whether the drill needs either.
- **P1-RELEASE** — Installer acceptance
  `verify · maintainer · high`
  accept: the candidate's exact SHA has successful hosted `publish`, `publish-docker` and `publish-site` runs; its installers install and launch on each supported platform. Published assets, updater signatures and image tags identify that candidate; Docker amd64/arm64 smoke checks and the macOS installer retry pass. Record hosted evidence separately from `validate-local`.
- **P1-UPDATER** — Real desktop update
  `verify · maintainer · high`
  accept: update to the candidate from a prior published version on macOS (with and without Launch at login), Windows NSIS and Linux AppImage/deb. Verify signatures, unchanged identity/selections/files, exactly one running daemon answering under the new version, and recovery after a failed install or spawn. Verify hosted `.deb.sig` generation; qualify Windows unattended recovery under WIN-UPDATE-WATCHER.
- **P1-CASA-CPU** — Casa CPU stall
  `verify · maintainer · high`
  accept: obtain a bounded capture of the CPU stall with HTTP/discovery timeouts, identify the triggering workload and create an isolated reproducer before a fix. Validate the fix against that workload and record responsiveness and CPU afterwards; a version upgrade alone does not close this task. Do not repeat live evaluator-based profiling.
- **P1-SCHEDULER** — Scheduler measurements
  `verify · maintainer · normal`
  accept: idle wakeups, CPU, disk reads, traffic, battery and recovery correctness measured before any timing default changes.
- **P1-UX** — Native binary acceptance
  `verify · maintainer · normal`
  accept: tray transitions, light/dark menu bars, reduced motion, long paths, dialogs, offline startup and error recovery; real sleep/wake on macOS, Windows and Linux; OS notifications, activation and click routing on Windows and Linux; the native gallery Save dialog and Maps launch; the 320 px tray viewport, device identity and hub-only role labels in Tauri, and WebKit/Windows motion.
- **P1-SERVER-ONBOARDING** — Server onboarding acceptance
  `verify · maintainer · normal`
  accept: real-device replica pairing and selection from the new wizard, ARM, image upgrades. See [Server onboarding](SPEC.md#server-onboarding).
- **WIN-RECYCLE** — Recycle Bin on real Windows
  `verify · maintainer · normal`
  accept: relinking a replica on a fixed Windows drive moves outdated files to the Recycle Bin, and a file larger than the bin or a disabled bin is refused rather than deleted (only a simulated PowerShell covers this today).

### Distribution

- **P1-UMBREL-IMAGE** — Choose the Umbrel release image
  `decision · maintainer · normal`
  accept: keep 0.4.1, or move all three image references and the manifest version to a newer image (0.4.1 lacks the onboarding fixes). Moving it also retires `deploy/umbrel/arca/server-setup.js.template`, a copy of `packages/daemon/setup.js` mounted over the pinned image.
- **P1-UMBREL** — Umbrel submission
  `deploy · maintainer · normal · depends: P1-UMBREL-IMAGE`
  accept: ARM runtime and image-upgrade path qualified; real client addressing and `app_proxy` checked; public repository/support access resolved and the PolyForm Strict licence checked against Umbrel's App Store terms; checked screenshots and source logo attached; the real PR opened, its URL recorded in `submission`, and the full lint rerun. Keep the pilot icon override until the official gallery is published. The Umbrel update helper does not qualify arbitrary future schema upgrades or restores. See [Umbrel packaging](SPEC.md#umbrel-packaging-and-submission).
- **P1-SITE** — Website domain
  `verify · maintainer · low`
  accept: `arca.satoshi-ltd.com` serves the candidate's Pages project and Git auto-deploys are off.
- **P1-PUBLIC-ACCESS** — Store listings
  `deploy · maintainer · low`
  accept: `APP_STORE_URL` and `PLAY_STORE_URL` name real listings so the site's mobile card shows store buttons instead of saying the apps are not in the stores yet.
- **P1-SIGNING** — Code signing
  `decision · maintainer · low`
  accept: a decision on Windows signing; optionally one signed macOS run with `sign_macos` checked and `publish` unchecked.

### Decisions

- **DEC-MUSIC-SCOPE** — Music library: engine, codecs and playlists
  `decision · maintainer · normal`
  accept: three answers before MUSIC-INDEX starts. Engine: a playback and media service of Arca's own inside `arca-network` (Media3 on Android; recommended, no licence, the tree and queue live in native code) or `@rntp/player` v5 (less code, commercial licence for a company, scene delegates by hand). Codecs: MP3, AAC, FLAC and WAV as the core (ALAC on Android and Opus outside CAF/MP4 wait). Playlists: relative M3U8 files inside the folder, synchronized like any file and indexed by the hub (recommended), or a hub-owned table with its own API and conflicts. The study behind these options sits in the session notes of 2026-10-07; CarPlay, iOS and desktop playback are later phases.
- **DEC-LAN-PERMISSION** — Cache LAN permission?
  `decision · maintainer · normal`
- **DEC-FIRST-PAGE** — Serve the first snapshot page without a hub scan?
  `decision · maintainer · normal`
- **DEC-BLOB-SIGNATURES** — Trust recorded blob signatures instead of re-hashing completed blobs?
  `decision · maintainer · normal`
- **DEC-CONVERTING-LEGACY** — Remove the legacy `converting` mode on phones?
  `decision · maintainer · normal`
  accept: a yes or no. `replica.js`, `App.jsx` and a test still recover a folder interrupted mid-way through the former upload-only-to-working-copy transition (`converting` mode, restoring missing indexed files before switching to `source`); AGENTS.md forbids legacy modes, yet a phone could still hold that state.
- **DEC-DESKTOP-DISK-ENTRIES** — Merge on-disk entries into desktop browsing?
  `decision · maintainer · low`
- **DEC-OFFLINE-DELETE** — Allow offline deletion of unsynced files?
  `decision · maintainer · low`
- **DEC-RENAME-MODIFIED** — Allow renaming modified synced files?
  `decision · maintainer · low`
- **DEC-OFFLINE-DISCONNECT** — Allow Disconnect while offline?
  `decision · maintainer · low`
- **DEC-PICKER-GALLERY** — Remove the unreachable picker-only gallery path?
  `decision · maintainer · low`
- **DEC-LAST-CHANGE-SCOPE** — Should Last change count deletions and conflict copies, or be named "Last saved version"?
  `decision · maintainer · low`
- **LOCAL-CLEANUP** — Old pre-SPEC documents
  `decision · maintainer · low`
  accept: keep, archive or delete `.cache/docs-before-consolidation` (PLAN, PROTOCOL, STATUS and the legacy Syncthing spec from before SPEC existed). APKs and the Cargo cache now prune themselves.
- **P1-CASA-POLICIES** — Remove redundant Casa policy lines
  `deploy · maintainer · low`
  accept: after checking every running device's fixed exclusions and the current policy, remove only rules made redundant by that fixed list from Casa's `alpi-workspace`, `alpi-mirai-workspace` and `alpi-host` policies. Preserve intentional content rules; `cache/` is not a fixed exclusion. The `~/.alpi` policy continues to include `.env` and secrets as directed by the maintainer.

## Proposed

Suggested order for approval: preservation of user files, synchronization recovery, release reliability, then usability and cleanup. No task in this lane is approved for implementation.

### File preservation and synchronization


### Release and native reliability

- **DESK-TEST-NAVIGATION-FLAKE** — The navigation JSDOM test leaks asynchronous work after it ends
  `bug · agent · normal`
  accept: "navigation paints before slow reads, retains updating feedback and ignores responses from older tabs" (`tests/desktop.test.js`) waits for its released reads deterministically (track the pending `invoke` promises and await them in `t.after`) instead of a 50 ms sleep, so the file no longer fails with "generated asynchronous activity after the test ended" when the pre-push hook runs the suite with concurrency; seen twice on 2026-10-07 while pushing a docs-only commit, with the same suite green when run alone.
- **DESK-ONBOARDING-TRAFFIC-LIGHTS** — The onboarding rail's brand sits under the macOS window controls
  `bug · agent · low`
  accept: in the native Mac app the onboarding screens (the sidebar is hidden there) keep the brand and rail clear of the red, yellow and green controls, reusing the `mac-native` class and `--window-controls-inset`; the web interface and other platforms keep their layout; a stylesheet contract test covers it. Found by the review of 0.6.111 from reading the CSS (`.onboarding-rail` starts at the top-left); check it on the Mac first. Needs a desktop build.
- **DESK-VIEWER-DRAG** — The window cannot be dragged while the gallery viewer is open
  `bug · agent · low`
  accept: in the native app, pressing and dragging an empty strip of the full-window viewer moves the window, without starting a drag on the viewer's buttons, video controls or the Info panel; the existing titlebar drag rule (`app.js` mousedown handler returns whenever a dialog is open) is narrowed instead of removed; a JSDOM test covers it. Found by the review of 0.6.111. Needs a desktop build.
- **DOCKER-LATEST-ORDER** — An older release's Docker run can move `latest` back
  `bug · agent · high`
  accept: `publish-docker.yml` pushes `latest` only for the current eligible release at publication time; older, delayed or forced runs still publish their version tag without moving `latest` backwards. Tests cover out-of-order completion, reruns and a newer release arriving during a build; checking only at job start is insufficient.
- **NAT-F01-F10-COPIES** — Importing a large file from Files on Android no longer freezes the app
  `bug · agent · high`
  accept: on Android, Import files picks with `copyToCacheDirectory: false` and copies each file through the existing `receiveShared` into `arca-incoming`, off the UI thread, instead of expo-document-picker copying in the main-thread result handler; iOS stays as it is; a JS test covers it; device evidence follows under BUILD-MOBILE and P2-MOBILE.
- **NAT-F03-IOS-CANCEL** — iOS cancel/session race
  `bug · agent · normal`
  accept: a per-request cancelled flag, set under the lock and checked before the URL session task is created, so cancelling during session setup throws a cancellation instead of creating a task on an invalidated session; source-contract and cancellation tests cover the race, with native/device evidence under BUILD-IOS and P2-MOBILE.
- **DESK-UPDATER-TESTS** — The Rust updater tests also run on Windows
  `chore · agent · normal`
  accept: the `rust-tests` job also runs on `windows-2022` with Windows versions of the two Unix-only tests, so the PowerShell listing and non-Unix exit handling execute; both pass in CI. Stubbing `install_update` is out of scope.
- **WEB-REPLICA-CONFLICT-LINKS** — Conflict download links on a replica's web view
  `bug · agent · normal`
  accept: the conflict dialog's download links on a server replica's web view use a route the replica serves and its local hash (today they point to the hub-only `/v1/blobs/<hash>`, which answers 409), and the link is hidden when there is no local copy; DOM and API tests.

### Music library and Android Auto

Phase order: MUSIC-FOLDERS → MUSIC-INDEX → MOB-MUSIC-LIBRARY → MOB-MUSIC-PLAYER → MOB-ANDROID-AUTO, then VERIFY-ANDROID-AUTO. Android only in this phase; iOS, CarPlay and desktop playback are in Later phases.

- **MUSIC-FOLDERS** — The hub marks a folder as a music library
  `feature · agent · normal · depends: DEC-MUSIC-SCOPE`
  accept: a persistent `music_folders` marker like `gallery_folders`, set by the hub only (`POST /v1/music/mark`, 409 on replicas, refused on a gallery folder and vice versa), advertised as `music` in the catalog and status and cached by replicas; it changes nothing about sync, selection, unlink or deletion, and phones keep the whole folder offline as for any selected folder; daemon tests for the marker, the exclusions and the replica cache. The interface follows board UI-MUSIC-FOLDER.
- **MUSIC-INDEX** — The hub indexes a music library's tags and covers
  `feature · agent · normal · depends: MUSIC-FOLDERS`
  accept: for music folders the hub reads tags with `music-metadata` (ID3, Vorbis comments, MP4 atoms) into `music_tracks` by volume, path and hash (title, artist, album artist, album, track and disc numbers, year, genre, duration, codec) in the same background queue as thumbnails, with covers from embedded art or the folder's `cover.jpg`/`folder.jpg` as 360 and 1024 px derivatives through the existing Sharp pipeline; `.m3u`/`.m3u8` files in the folder become playlists resolved against the index; `GET /v1/music` (artists, albums, tracks, playlists, recent, keyset cursors) and `/v1/music/cover`; the index follows renames, deletions and ignore rules like the gallery index; tests use small tagged files generated with `ffmpeg-static`.
- **MOB-MUSIC-LIBRARY** — The phone browses a music folder as a library, offline
  `feature · agent · normal · depends: MUSIC-INDEX`
  accept: the phone keeps a saved copy of a music folder's index, refreshed with sync, and builds Artists, Albums, Playlists and Recent from it against the files present locally; covers come from derivatives kept with the local copy; the folder's actions menu offers View files; a structural mobile test and a pure test of the library builder cover it. The interface follows board UI-MOB-MUSIC-LIBRARY.
- **MOB-MUSIC-PLAYER** — The phone plays the library with a queue and lock-screen controls
  `feature · agent · normal · depends: MOB-MUSIC-LIBRARY`
  accept: Android playback lives in `arca-network` (Media3 ExoPlayer in a `mediaPlayback` foreground service with a `MediaSession`: lock screen, Bluetooth and headset controls, cover art, queue, shuffle and repeat) and plays the local copy's files; JS drives it through a small bridge (play from a list position, queue, state events) and shows the mini player and Now playing; a core-codec file of each kind plays in a Kotlin test. Needs a native build.
- **MOB-ANDROID-AUTO** — Arca appears in Android Auto with the library's browse tree
  `feature · agent · normal · depends: MOB-MUSIC-PLAYER`
  accept: `arca-network` declares `automotive_app_desc.xml` and the car meta-data by manifest merging and ships a Media3 `MediaLibraryService` whose tree (Artists → Albums → Tracks, Albums, Playlists, Recent; four roots, three levels) and covers come from the phone's saved index without JavaScript running, so the car can start Arca cold; every item has a title, subtitle and art; nothing plays until the driver picks; Kotlin tests cover the tree builder and SPEC documents the DHU and Unknown sources steps. The interface follows board UI-AUTO-BROWSE. Needs a native build.

### Deferred usability and cleanup

- **DESK-ONBOARDING-HUB-ADDRESS** — The onboarding Hub address field loses its placeholder and is forced to monospace
  `bug · agent · low`
  accept: the onboarding "Pair with your hub" step passes its placeholder `https://arca.your-network` in the placeholder position, as the Connect to hub dialog does, so the field shows it and only the typed value is monospace; a desktop test asserts the placeholder. Found by the design audit: `textField` takes no placeholder, so the sixth argument lands in `mono`.
- **DESK-EMPTY-HEADING** — The "All folders are syncing here" empty state is the only one with an unstyled heading
  `bug · agent · low`
  accept: that empty state uses the `h2` every other `.empty` styles (or the stylesheet styles it), so its heading matches the others; a desktop test asserts the heading element.

- **DESK-INFO-PANEL-MOTION** — The photo Info panel slides with opacity and transform only
  `bug · agent · low`
  accept: the Info panel in the photo viewer slides in and out with transform and opacity, and the image area resizes at once, as SPEC's motion rule requires, instead of transitioning `width` and `right`; reduced motion makes it instant; `tests/motion.test.js` bans transitions on `width`, `left` and `right` and decides what to do with the progress bar at `style.css:2397`, which breaks the same rule.
- **SITE-HERO-TRUE-UI** — The site hero draws the real app and covers no text on a phone
  `chore · agent · low`
  accept: the hero window shows only elements that exist in `design/desktop.html` (no invented subtitle, a Lucide icon instead of the text check glyph, a gallery row and one row syncing with nine dots), at 390 px its floating "Phone & tablet" card covers no text, and a site test lists the elements.
- **MOB-VIDEO-SAFE-AREA** — The photo viewer's video surface uses safe-area insets
  `bug · agent · low`
  accept: the video surface in the phone viewer uses the safe-area insets instead of the fixed 90 and 110 margins in `theme.js`; a layout test covers a device with a cutout.
- **MOB-VIEWER-CHROME-TAP** — A tap hides the photo viewer's chrome
  `feature · agent · low`
  accept: a single tap on the photo viewer fades its top bar over `--motion-enter` (a single tap waits 300 ms to be told from the double tap), Back still works and reduced motion makes the change instant; this adds a gesture, so the maintainer validates it before it enters Queue.

- **DESIGN-COVERAGE** — Draw the few shipped views the design kit still lacks
  `chore · agent · low`
  accept: `design/desktop.html` draws the gallery viewer with Info and the Daemon stopped page, and `design/mobile.html` draws History, Devices and Settings as the app renders them (the viewer is the "Now" that open motion tasks need); the design tests keep passing and no board is added.
- **DOC-README-SLIM** — Keep README to orientation and entry commands
  `chore · agent · low`
  accept: README keeps only its one-line status banner; the dated or status passages (about 16, for example "September 10 checkout", "implemented locally", "prepared locally, not deployed") and feature narration that SPEC already owns become short descriptions or pointers into SPEC; the three orphan sections after Public website are folded in or removed, the documents list names the five documents, line 152's "No commit or push without explicit authorization" no longer contradicts AGENTS' loop, and Casa's LAN IP no longer appears in the public README.
- **MOB-GALLERY-ALBUM-RELEASE** — Changing the selected albums while photos are pending is allowed
  `feature · agent · low`
  accept: changing the albums or the videos setting while uploads are pending or failed no longer fails with "Finish pending uploads…" (`gallery.js:102-116`); after the maintainer chooses whether queued photos of an unticked album keep uploading (simplest, no new state) or are dropped, a replica test covers adding and removing an album with pending uploads; uploaded files are never touched.

- **NAT-IOS-HASH** — Native hashing on iOS
  `feature · agent · low · depends: BUILD-IOS`
  accept: a Swift `hashFile` using CryptoKit reads 1 MiB at a time off the main thread with the same storage check as Android's, and a JS test shows the native path is used instead of the JavaScript SHA-256 fallback in `files.js`; device evidence follows.

## Later phases

- **MOB-MUSIC-IOS** — Music playback on iPhone
  `feature · agent · planned after Expo SDK 58`
  accept: AVPlayer-based playback in `arca-network`'s Swift side with lock-screen controls and the same queue and library screens as Android.
- **MUSIC-CARPLAY** — Arca on CarPlay
  `feature · maintainer · planned after Expo SDK 58`
  accept: the `com.apple.developer.carplay-audio` entitlement granted (request it early at developer.apple.com/contact/carplay), the app on Expo SDK 58's scene lifecycle, a CarPlay scene with list, tab bar and Now Playing templates serving the same four roots; proven on the CarPlay Simulator and in a car.
- **DESK-MUSIC** — Music on desktop and web
  `feature · agent · planned for phase 3`
  accept: `<audio>` playback over the daemon's range streaming (local copy on a desktop replica, the hub on the web) with the library screens; native Now Playing and media keys through a Tauri command; gapless and ALAC on Windows only if a native engine is adopted.
- **P3-I18N** — Localization
  `feature · agent · planned for phase 3`
  accept: strings in catalogs for Tauri, Expo and the shared web frontend; language selection; localized dates, numbers and sizes; dialogs, errors, tray menus and notifications; user content is never translated. English-only through phases 1 and 2.
