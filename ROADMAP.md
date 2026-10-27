# Arca roadmap

Updated 2026-10-27 · Phase 1 functional, not release-qualified.

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

A purely visual idea is not filed here as Proposed: its board in `design/proposals.html` is the proposal. Once the maintainer approves it, it enters Queue as a `ui` task with the board ID and `accept: the board`; when it ships, delete the task and the board. A task that mixes logic and a screen splits: the screen is board `UI-<TASKID>`, the logic stays under its ID and its accept says "the interface follows board UI-<TASKID>"; a board ID never equals a non-`ui` task ID. When a task ships, delete it and record it in the changelog and in the SPEC section it changes. When a feature needs device evidence, split it: the implementation is an agent task; the device check is a maintainer `verify` task that depends on it. The loop never builds native code, so a `NAT-*` task ends with its JavaScript and contract tests; its compile and device evidence come from a maintainer build (your Android or iOS build) recorded as a follow-up `verify`.

## Queue

_None._

## In progress

_None._

## Needs maintainer

### Builds and deployments

- **VERIFY-LOCAL-WATCHERS** — Native filesystem notifications on the maintainer Mac
  `verify · maintainer · high`
  accept: raw `fs.watch` delivers repeated changes in recursive and per-directory modes on this Mac, including after streams close and reopen, and the native watcher integration tests execute without capability skips. Identify the OS or resource cause if delivery stays silent; an independent probe reproduced the loss without loading Arca. The capability guard now checks sustained delivery and reopening, while deterministic tests cover the guard itself; passing source suites does not establish that this host's native notifications recovered.

- **P2-GALLERY-VIEW** — Ship the desktop/web gallery in installers and on Casa
  `verify · maintainer · normal`
  accept: shipped installers and Casa carry the production dependencies (Sharp, exifr) and the gallery opens on both.

### Device checks

- **VERIFY-DEV-PLAYER** — The TV pairs as a Player on Casa
  `verify · maintainer · normal`
  accept: after a Casa redeploy and an arca TV build, the TV removed and paired again with the hub shows as arca TV, Player, with its version and its folders in Devices and still streams photos and music.
- **VERIFY-ERASE-PRIVACY** — Erase privacy on installed desktop and mobile clients
  `verify · maintainer · high`
  accept: identify the candidate SHA and installed binaries; using disposable Arca folders, erase online and with the hub unreachable on desktop, Android and iOS. Check unsynced local files, recent searches/listening history, thumbnails, catalog state and a playing track; interrupted cleanup resumes on launch; on Android and iOS, Arca's scheduled and delivered notifications and its background-sync registration are gone, and tapping an old notification during or after the erase does nothing. Photos originals, exports, detached folders, hub files and other devices remain. Source tests cover database free pages/WAL, configuration temporaries, open logs and late writes/reads; they do not establish the installed clients' OS storage and player behavior.

- **VERIFY-SHARE-CACHE** — Incoming shares on the Fold
  `verify · maintainer · high`
  accept: sharing one and several files, a large file and a file named like a path from another app into Arca on the Fold lists them in the Save sheet with their real names, saves them, and leaves nothing under the app's cache except generated names (`arca-incoming/<id>-<n>`) while the sheet is open and nothing after Save or Cancel.
- **FOLD-STORAGE** — Account for persistent storage on the Fold
  `verify · maintainer · high`
  accept: after sync and a restart, account separately for complete working copies, pending originals, transfer staging, databases and derivative caches. No unexplained second full copy or unbounded staging growth remains; low-space recovery preserves pending originals and existing working files. Never remove live files to meet a storage target.
- **FOLD-THUMBNAILS** — Gallery thumbnails, posters and viewer
  `verify · maintainer · high`
  accept: identify the candidate SHA and installed binary; with originals fully synchronized and thumbnails already generated, measure process launch, first photo rows and first visible thumbnails after force-stop, both connected and in airplane mode, on a gallery above 2,000 photos. Also check grid thumbnails and video posters while folders sync, HEIC, the viewer's immediate thumbnail, offline originals and recovery of failed derivatives. Record timings, cache presence and native errors for grey tiles or crashes after suspension and cold start; source fixes alone do not close this task.
- **WIN-UPDATE-WATCHER** — A failed Windows update gets the daemon back
  `verify · maintainer · high`
  accept: on a real Windows machine, with an update that fails after Arca closes (for example a locked installation file), the daemon is running again within about a minute without opening Arca, `update-watch.log` in the state directory says `restored` and `%TEMP%\arca-update-watch-*` is gone; a successful update logs `relaunched` and starts no second daemon.
- **P2-GALLERY** — Album uploads on physical devices
  `verify · maintainer · high`
  accept: original cloud access and EXIF/RAW/HEIC/Live Photo fidelity (limited access and editor workflows included), and a Samsung run with a library over 10 GiB covering screen-off/background continuity, battery restrictions, interruption and resumed completion. Pending picks survive process termination, lost upload responses and low storage without losing names, duplicating accepted paths or deleting Photos originals. Verify the historical archive and real-phone uploads before removing Immich or claiming a migration.
- **P2-GALLERY-DELETE-DEVICE** — Shared gallery deletion on devices
  `verify · maintainer · high`
  accept: with disposable photos on Android and iOS: direct shared deletion, Live Photo groups, connection failure, partial selection failure and unchanged Photos originals; deletions persist across remounts; non-recursive directory deletion works (Android `Files.delete`, iOS `rmdir`).
- **P2-MOBILE** — Mobile replica acceptance
  `verify · maintainer · high`
  accept: complete persistent copies, honest incomplete-work reporting, imports reaching the hub, resumable transfers without corruption, no data loss on suspension; low storage, interrupted downloads, revoked credentials and offline access. Reimporting a file preserves edited conflict copies; failed imports preserve existing files. Cached views remain usable during slow refreshes and back navigation. Check keyboard handling and text scaling on phone, Fold and iOS; launcher and splash in a standalone build; rename; APK opening on Samsung; Fold sticky scroll; settings visuals; iOS LAN pairing; name propagation; Fold throughput.
- **VERIFY-REVEAL-FILE** — Show in folder on real Windows and Linux
  `verify · maintainer · normal`
  accept: on a Windows and a Linux desktop build, a file detail's Show in folder and the photo viewer's open the file's own folder (Explorer with the file selected on Windows, a file manager on the file's folder on Linux), including a file in a nested folder, a path with spaces and, on Windows, a path longer than 260 characters (the verbatim prefix is stripped for Explorer).
- **FOLD-GALLERY-UX** — Gallery gestures and playback
  `verify · maintainer · normal`
  accept: infinite scroll both ways, the fast-scroll thumb follows the finger with sparse year chips, pinch density levels (also on iOS), videos autoplay when opened, and Info pauses and resumes a video.
- **P2-VIDEO** — Video on physical devices
  `verify · maintainer · normal`
  accept: identify the 0.8 candidate and running builds; verify Movies & TV on desktop, web, Android, iOS and arca TV with direct and compatible playback, alternate audio, sidecar and embedded subtitles, long seeks, resume between devices, offline downloads, network loss, rotation and local posters on iOS. On disposable hub state, verify Erase stops active playback and removes temporary media; measure CPU and temporary-disk use during long high-bitrate streams, including Windows. Source tests do not establish these device results.
- **P2-SHARING** — Incoming sharing
  `verify · maintainer · low`
  accept: the iOS Share Extension works; cold-start, foreground and multiple-file shares work. Known gaps stay documented: text/plain streams, links and text are not imported, and duplicate temporary filenames must be shared separately.

### Phone sync (native follow-ups)

The JavaScript side of the phone sync audit shipped (per-file verification, no re-hash of downloads, one inventory per run, deferred download recovery, outage hold, 1 Hz progress, the long-lived preview queue). What remains needs native code; the loop writes it with JS and contract tests, a maintainer build proves it.

- **VERIFY-PHONE-SYNC** — Phone sync cadence on the Fold and an iPhone
  `verify · maintainer · high`
  accept: after reloading the JavaScript on the Fold and an iPhone, a podcast folder of several 100 MB episodes downloads to the end with the app open and through a Wi-Fi drop of a minute (one Android notification throughout), an open photo folder that is still downloading shows "N photos still downloading" and its Preparing previews row reaches its total and disappears, Sync now on a large folder returns in seconds instead of re-reading every file, and the app stays responsive while it syncs.
- **NAT-IOS-HASH** — Native hashing on iOS
  `feature · agent · high`
  accept: a Swift `hashFile` using CryptoKit reads 1 MiB at a time off the main thread with the same storage check as Android's, and a JS test shows the native path is used instead of the JavaScript SHA-256 fallback in `files.js` (today every download verification, scan and preview check on iOS hashes in JavaScript and blocks the UI); device evidence under VERIFY-NAT-IOS-HASH.
- **VERIFY-NAT-IOS-HASH** — Native hashing on a real iPhone
  `verify · maintainer · high · depends: NAT-IOS-HASH`
  accept: on an iOS build, downloading a 1 GB file and opening a large photo folder keep scrolling smooth, and the hash of a downloaded file matches the hub's.
- **NAT-TRANSFER-STREAM** — Phone transfers stream over one connection
  `feature · agent · high`
  accept: `ArcaNetwork` downloads and uploads an object as a resumable stream (or windows up to the hub's `maxChunkBytes`) over a kept-alive connection, writes blocks without an fsync each and fsyncs once before the hash check; `replica.js` uses it when the binary has it and keeps 1 MiB blocks otherwise; contract tests with a mocked native module cover resume offsets, cancellation, the yield between turns and a failed verification. Device evidence under VERIFY-NAT-TRANSFER-STREAM.
- **VERIFY-NAT-TRANSFER-STREAM** — Phone transfer throughput on real devices
  `verify · maintainer · high · depends: NAT-TRANSFER-STREAM`
  accept: on the Fold and an iPhone over LAN and Tailscale, record MB/s for a 1 GB download and upload before and after; an interrupted transfer resumes without corruption and the battery cost is recorded.
- **NAT-IOS-BACKGROUND-DOWNLOAD** — iPhone downloads continue in the background
  `feature · agent · normal`
  accept: an iOS background `URLSession` keeps fetching a pending download into its partial file while the app is suspended; the next cycle verifies the hash before materializing, pause, Stop syncing and Erase cancel it, and no file reaches the working copy without the journal; JS tests cover the hand-off contract. Device evidence under VERIFY-NAT-IOS-BACKGROUND-DOWNLOAD.
- **VERIFY-NAT-IOS-BACKGROUND-DOWNLOAD** — Background downloads on a real iPhone
  `verify · maintainer · normal · depends: NAT-IOS-BACKGROUND-DOWNLOAD`
  accept: a large episode started with the app open finishes with the phone locked and Arca in the background, and is playable at the next launch.
- **NAT-REPLACE-ASYNC** — `replaceFile` leaves the JavaScript thread
  `feature · agent · low`
  accept: `replaceFile` runs its fsyncs and rename as an async native function on Android and iOS, `files.js` awaits it, and the recovery contract (a failure before the rename leaves the destination untouched) keeps its tests; device evidence rides on VERIFY-NAT-TRANSFER-STREAM.

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

### Music

- **MOB-SLEEP-FADE** — The phone's sleep timer fades out before pausing
  `feature · maintainer · low`
  accept: `MusicService` gains a volume command (or a timed fade) and the phone's sleep timer ramps the player volume to silence over about 5 s before pausing and restoring it, as desktop does; reduced motion keeps the fade because it is audio. Needs a native build, so the JavaScript and contract tests land as an agent task once the maintainer schedules the build.

### Decisions

- **DEC-VIDEO-INTEGRITY** — Require full-file integrity for Movies & TV?
  `decision · maintainer · high`
  accept: decide whether video identity and completed-download verification must cover every byte. The current quick identity hashes only the size and first/last 4 MiB, so a same-size change or download corruption confined to the middle is undetected; it also cannot distinguish those versions for resume. If full integrity is required, approve a bounded background full hash and a protocol field for clients to verify, with regression cases changing only the middle and measurements of hub I/O and phone verification cost. Keep this separate from the fast scan fingerprint.
- **DEC-LAN-PERMISSION** — Cache LAN permission?
  `decision · maintainer · normal`
- **DEC-FIRST-PAGE** — Serve the first snapshot page without a hub scan?
  `decision · maintainer · normal`
- **DEC-BLOB-SIGNATURES** — Trust recorded blob signatures instead of re-hashing completed blobs?
  `decision · maintainer · normal`
- **DEC-CONVERTING-LEGACY** — Remove the legacy `converting` mode on phones?
  `decision · maintainer · normal`
  accept: a yes or no. `replica.js`, `App.jsx` and a test still recover a folder interrupted mid-way through the former upload-only-to-working-copy transition (`converting` mode, restoring missing indexed files before switching to `source`); AGENTS.md forbids legacy modes, yet a phone could still hold that state.
- **DEC-PHOTO-PLACES** — Approve offline photo place indexing and place search as described by PHOTO-PLACES?
  `decision · maintainer · normal`
- **DEC-RENAME-MODIFIED** — Allow renaming modified synced files?
  `decision · maintainer · low`
- **DEC-OFFLINE-DISCONNECT** — Allow desktop/server Disconnect while offline? Mobile already persists a pending leave.
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

- **DESK-UPDATER-TESTS** — The Rust updater tests also run on Windows
  `chore · agent · normal`
  accept: the `rust-tests` job also runs on `windows-2022` with Windows versions of the two Unix-only tests, so the PowerShell listing and non-Unix exit handling execute; both pass in CI. Stubbing `install_update` is out of scope.

### Deferred usability and cleanup

- **PHOTO-PLACES** — Search Arca finds photos by place ("hua hin", "thailand", "tailandia")
  `feature · agent · normal · depends: DEC-PHOTO-PLACES`
  accept: the hub reads GPS during gallery indexing and stores only a place label and a folded search text (city, district, province, country), never coordinates; names come from a bundled offline GeoNames extract (CC BY, attributed; no cloud geocoding, no new npm dependency), including Spanish and English alternate names for countries and first-level regions so "thailand" and "tailandia" both match; existing photos re-index once; Search Arca gains a Places group (one row per place with its count, opening the gallery filtered to it) on desktop, web and phone, offline on the phone from the synchronized labels; photos without GPS are explained in the empty result; tests cover lookup (Hua Hin, open sea, antimeridian, invalid coordinates), indexing with and without GPS, and the "hua hin"/"thailand"/"tailandia" queries on hub and phone. Feasibility study: GPS read 0.17 ms per photo, compact dataset about 2.5 MB plus alternate names, grid lookup about 13 µs.

### UI and accessibility review

- **A11Y-FOLDER-CARD** — A folder card with inline actions is not a button
  `bug · agent · normal`
  accept: a folder card that holds Locate…, Change location…, Review or another real button is a plain article that opens from its name and tile, so the inner buttons are reachable and announced on their own; cards without an inline action keep today's behaviour; a test pins both.

- **UX-FOLDER-STATUS-LINE** — The folder status line can be read in full
  `chore · agent · normal`
  accept: the folder card's status line carries its full text as a tooltip, and the byte-transfer figure comes before the path so a long path never hides it; a test pins the order and the tooltip.

- **A11Y-OLDER-MARK** — The "older than the hub" mark and the tags are readable without hover
  `chore · agent · low`
  accept: the Devices older-version marker and the video badge expose their text to keyboard and screen-reader users without a tooltip, a test pins the markup.

- **UX-DEVICE-NAME-NOTICE** — Saving the device name says so
  `chore · agent · low`
  accept: saving the device name in Settings shows "Device name saved." and a rejected name shows its error beside the field; a test pins both.

- **UX-SEARCH-ERROR** — A failed phone search is an error, not "No matches"
  `bug · agent · normal`
  accept: when the search request fails Search Arca shows the shared error notice with Retry instead of "No matches", and a failed Show more says so; a test pins both.

- **UX-MOB-SEARCH-CHIP** — Search filter chips meet the touch target
  `chore · agent · low`
  accept: the search chip and its remove button are at least the touch height or carry the standard hit slop; a source test pins it.

- **UX-MOB-SECTION-LABEL** — Section labels are one component with a header role
  `chore · agent · low`
  accept: the phone's section labels use one component that uppercases through style and carries the header role, replacing the hand-uppercased strings; a source test pins that no screen types its own casing.

- **UX-MOB-ONBOARDING-LABEL** — Onboarding does not offer "Download 0 folders"
  `chore · agent · low`
  accept: with no folder chosen the primary action reads "Choose folders to download" and stays disabled; with a choice it keeps its count; a source test pins both.

- **A11Y-FOCUS-NAV** — Navigation moves focus and sets the page title
  `chore · agent · normal`
  accept: every desktop and web view change sets `document.title` to "Heading · Arca" and moves focus to the new `h1`; the setup wizard and web sign-in focus their first field after each render and wrap the role cards in a labelled radio group; a test pins the title and the focus target.

- **UX-BUSY-SUBMIT** — Pairing, Finish and Start service show they are working
  `chore · agent · normal`
  accept: the wizard's submit buttons, the web sign-in Continue and Start service show the busy mark and a working label until they finish, and a failed Start service shows its error instead of the same page; a test pins each.

- **UX-WIZARD-ERRORS** — Wizard errors use the shared notice titles and clear when fixed
  `bug · agent · normal`
  accept: wizard errors go through the same error mapping as dialogs, `#setup-error` and the space cards are cleared at the start of every folder-root check, and the last page says "On the hub" and "1 folder" with the shared count helper; a test pins them.

- **UX-SIGNIN-HELP** — Web sign-in help matches setup, and a routine expiry is not an error
  `chore · agent · low`
  accept: the sign-in "Get a code" panel has the same Copy row as setup for both commands, "Your session has ended" uses the neutral hint style, denied and expired approvals use the error panel, and a rejected code clears the cells and focuses the first; a test pins them.

- **UX-NOTICE-TIMING** — Info notices with an action wait for the reader
  `bug · agent · normal`
  accept: an info notice that carries an action, or a long body, does not auto-dismiss on desktop or phone, and the desktop timer pauses while the card is hovered or holds focus; the contract test pins the rule for both clients.

- **UX-TRAY-WORDING** — The tray uses the app's words
  `chore · agent · low`
  accept: the tray says Service stopped, its Quit says Quit Arca (sync continues), the shortcut hints follow the platform and Sync now shows its own, and Install… is renamed Open Arca; a test pins the strings.

- **UX-DESK-WEB-APPROVAL-TRAY** — A web sign-in request reaches a closed desktop window
  `feature · maintainer · low`
  accept: decision: the tray lists a "Web sign-in request / Review" attention row so a desktop running in the tray can approve a browser; today approval reaches only the foreground window, which SPEC states.

- **UX-QUICKLOOK** — Quick Look is discoverable and honest
  `chore · agent · normal`
  accept: the Quick Look button and footer say Details (not Open), the Files list carries a "Space to preview" hint, and a failed or unsupported preview says so instead of a blank stage; a test pins the labels and the states.

- **UX-HTTP-CONFIRM** — Allowing HTTP asks first
  `bug · agent · normal`
  accept: turning on Allow HTTP connections opens the same confirmation dialog as the other risky settings with its consequence sentence and an Allow HTTP action; turning it off stays immediate; a test pins both.

- **UX-SERVICE-VALUES** — Service diagnostics never invent a value
  `bug · agent · low`
  accept: Node and Port show "Not reported" when the daemon does not report them, never a default; a test pins it.

- **UX-FORMAT-HELPERS** — Sizes and dates keep their information
  `bug · agent · low`
  accept: `bytes` has a TB tier, `date` adds the year when it is not the current one and `relative` re-renders on the status tick; a test pins each.

- **UX-FOLDER-COUNT** — A folder not yet counted does not read 0 files
  `bug · agent · normal`
  accept: the Folders list shows "Not counted yet" like the detail page when a folder has no count; a test pins it.

- **UX-DEVICES-ERRORS** — A Devices load failure is reported once and by its source
  `chore · agent · low`
  accept: a failed roster fetch shows one error notice with Retry and a hint naming the missing source (Device list or Discovery), not both; a test pins it.

- **UX-STOP-SYNC-COPY** — The Stop syncing panel names the local choice
  `chore · agent · low`
  accept: the replica panel adds "You choose whether this device's copy is kept or deleted."; a test pins the sentence.

- **UX-PLAYER-LOADING** — The video player shows it is loading and answers the keyboard
  `chore · agent · normal`
  accept: the player stage shows the busy mark until playback starts and again on a stall, the skip buttons carry 10 and 30, M, F and the up and down arrows drive the existing mute, fullscreen and volume, and the photo viewer ignores the arrow keys while a video control has focus; a test pins each.

- **UX-SLEEP-NARROW** — The sleep timer survives a narrow window
  `chore · agent · low`
  accept: at 760 px and below the sleep menu stays reachable and an active timer stays visible; a test pins the markup at that width.

- **UX-SHOW-WATCHED-FEEDBACK** — Marking a whole show watched says how many
  `chore · agent · normal`
  accept: the show-level Mark as watched and unwatched label themselves "all episodes" and end with a notice naming the count; a test pins both.

- **UX-PODCAST-PLAYED** — Finished podcast episodes are marked
  `chore · agent · normal`
  accept: a podcast episode played to the end shows the watched check or a muted Played in its length cell; unplayed and in-progress rows are unchanged; a test pins the three states.

- **UX-PHOTO-RANGE** — Shift-click selects a range of photos
  `feature · maintainer · low`
  accept: decision: Shift-click extends the photo selection from the last toggled tile and the selection bar may offer Download besides Delete; today selection is click by click and Delete only.

- **UX-MEDIA-ERRORS** — Library and viewer failures read the same and offer Retry
  `chore · agent · low`
  accept: Photos, Music and Video failures use one Retry empty state with the same wording, technical text only as a hint, and the viewer error has the image-off icon; a test pins them.

- **UX-SEARCH-PENDING** — The palette ignores Enter until its results are current
  `bug · agent · normal`
  accept: while a query is in flight the palette shows a pending state and Enter does nothing, so a fast Enter never opens a row of the previous query; a test pins it.

- **UX-MUSIC-MORE** — Show more says how many remain
  `chore · agent · low`
  accept: Show more reads "Show more · N left" for artists, albums, tracks and episodes; a test pins the label.

- **UX-TRACK-FAILED** — A track that cannot play says so in the player
  `chore · agent · normal`
  accept: a failed track shows "Can't play this track" in the player bar and mini player in the warning tone besides the toast; a test pins it.

- **UX-MOB-SHEET-DISMISS** — Tapping outside a sheet closes it
  `bug · agent · normal`
  accept: a tap on the scrim and a downward drag on the grabber dismiss a sheet unless it is busy; a source test pins both.

- **UX-MOB-NOTIFICATIONS** — A denied notification permission offers Open settings
  `bug · agent · normal`
  accept: the notification error offers Open settings instead of Retry now and the toggle reads the real permission when Settings gains focus; a test pins both.

- **UX-MOB-FIRST-SYNC** — First-sync folders say they are waiting, not incomplete
  `chore · agent · normal`
  accept: a folder with no completed sync during a running cycle reads "Waiting" with its size to download; Folders, folder detail and the Fold side card use one state word; a test pins the vocabulary.

- **UX-MOB-NOTICE-A11Y** — Notices announce themselves on iOS
  `bug · agent · normal`
  accept: a mounted notice is announced to VoiceOver and TalkBack with its title and body; a source test pins the call.

- **UX-MOB-DEVICE-NAME** — A phone pairs with its model name
  `chore · agent · low`
  accept: the pairing form prefills the device model instead of Android or iPhone and falls back to the platform name; a test pins the prefill.

- **UX-MOB-SEGMENTED** — Segmented controls meet the touch height
  `chore · agent · low`
  accept: the segmented control is at least the touch height, the Text size control scrolls and the tab labels stay on one line under the largest text size; a source test pins them.

- **UX-MOB-ERASE-COPY** — Erase and Stop syncing confirmations state what is at stake
  `chore · agent · normal`
  accept: the confirmations start with the real numbers (folders, size, files not yet on the hub) and keep the safety sentence; a test pins the text built from the counts.

- **UX-MOB-ONBOARDING-VIDEO** — A hub with only Movies & TV is not told it has no folders
  `bug · agent · low`
  accept: when every shared folder is a video library the picker says they stream and are not kept on the phone and Skip for now is the main action; a test pins it.

- **UX-MOB-SETTINGS-DUP** — Settings does not repeat itself
  `chore · agent · low`
  accept: the device name field joins the This device row, the Hub row appears once and the Runtime statement merges into Background refresh; SPEC and the test pin the order.

- **UX-MOB-OPEN-NAMES** — "Open" means one thing
  `chore · agent · normal`
  accept: the file peek sheet and the Fold preview card say View details, and Open with the external icon stays the app handoff; a test pins both.

- **UX-MOB-ACTION-NOTES** — Disabled folder actions say why
  `chore · agent · normal`
  accept: Link album, View history and Disable uploads show the same note line as the offline case when they are off for another reason; a test pins the notes.

- **UX-MOB-PAUSED-PULL** — Pulling to refresh while paused says so
  `bug · agent · normal`
  accept: a pull while sync is paused shows "Sync is paused" with Resume and the disabled Sync now says why; a test pins both.

- **UX-MOB-SAVED-NOTICE** — Saving a shared file confirms and the empty case has a way out
  `bug · agent · normal`
  accept: a saved share shows "Saved N files to folder" with an action to open it ("Waiting to upload" when offline or paused) and the no-folder state is an empty state that keeps the shared payload; tests pin both.

- **UX-MOB-CONFIRM-NAMES** — Delete and Restore confirmations name their target
  `chore · agent · normal`
  accept: Delete reads Delete "name"? and Restore names the version date and revision; confirmations pass destructive and icon explicitly, never inferring them from the label, and Disconnect is a danger confirmation; tests pin them.

- **UX-MOB-HISTORY-FILTER** — The History folder filter shows and announces its value
  `chore · agent · normal`
  accept: the filter button is announced with its value, the picking sheet marks the current folder as selected and the segments say a second tap clears; a test pins them.

- **UX-MOB-OFFLINE-EMPTY** — Recent and History offline use the offline empty state
  `chore · agent · normal`
  accept: both use the shared offline empty state with Retry and, when never connected, Open Devices; a test pins it.

- **UX-MOB-SECTION-A11Y** — File rows are announced with their size and kind
  `chore · agent · low`
  accept: file rows read "name, size" and folder rows "folder, N files, size", photo tiles read their date and a video's duration instead of the file name, and the current queue row is not a button; source tests pin them.

- **UX-MOB-VIDEO-PANELS** — Video panels close from the picture and a dropped stream can retry
  `bug · agent · normal`
  accept: a tap on the picture closes an open audio or subtitle panel, and a stopped stream offers Try again beside Close; a test pins both.

- **UX-MOB-VIDEO-FOLD** — The video player does not rotate on the nearly square Fold
  `bug · maintainer · normal`
  accept: verify on the unfolded Fold: skip the manual rotation when the aspect ratio is under about 1.2 or the layout is wide; needs the device.

- **UX-MOB-SHOW-CONTINUE** — A show's Play continues the episode you were in
  `bug · agent · normal`
  accept: the show page button reads Continue and plays the partly played episode, otherwise Play; a test pins the rule.

- **UX-MOB-LIST-RETURN** — Going back to an album or show keeps the page and position
  `bug · agent · normal`
  accept: the music grids keep their page size and scroll offset per route entry; a test pins the page size.

- **UX-MOB-MUSIC-LOADING** — Loading the library shows motion
  `chore · agent · low`
  accept: the music Loading the library state uses the shared loading scaffold with Sync now as a secondary action; a source test pins it.

- **UX-MOB-SELECTION-CUE** — Selection mode shows an empty circle on unselected tiles
  `chore · agent · low`
  accept: while a photo is selected every tile shows the empty selection circle; a source test pins it.

- **UX-MOB-NOW-PLAYING-FOLD** — Now playing is two panes on the Fold as drawn
  `bug · agent · normal`
  accept: the two-pane Now playing starts at the shared wide breakpoint instead of 1100 dp, or the Fold board draws the single pane; a source test pins the threshold.

- **UX-AUTO-EMPTY** — The car says what to do when the library is empty
  `feature · maintainer · low`
  accept: verify and decide: the Android Auto service returns a message and a resolution label ("Open Arca on your phone to sync music") for an unsynced library; needs the car or the head-unit emulator.

### Music

- **MUSIC-CAR-SEARCH** — Search and voice requests in the car
  `feature · agent · low`
  accept: `MusicService` answers library search and "play … on Arca" voice requests by title, artist and album over the published library, and plays the best match; JVM tests cover the matching. Today search commands are not offered.

## Later phases

- **MOB-MUSIC-IOS** — Music playback on iPhone
  `feature · agent · planned after Expo SDK 58`
  accept: AVPlayer-based playback in `arca-network`'s Swift side with lock-screen controls and the same queue and library screens as Android.
- **MUSIC-CARPLAY** — Arca on CarPlay
  `feature · maintainer · planned after Expo SDK 58`
  accept: the `com.apple.developer.carplay-audio` entitlement granted (request it early at developer.apple.com/contact/carplay), the app on Expo SDK 58's scene lifecycle, a CarPlay scene with list, tab bar and Now Playing templates serving the same roots as Android Auto (Artists, Albums, Recent); proven on the CarPlay Simulator and in a car.
- **DESK-MUSIC-NATIVE** — Native Now Playing and media keys on desktop
  `feature · agent · planned for phase 3`
  accept: the desktop app reports the playing track to macOS Now Playing and the Windows media overlay and answers hardware media keys through a Tauri command; gapless playback and ALAC on Windows only if a native engine is adopted.
- **P3-I18N** — Localization
  `feature · agent · planned for phase 3`
  accept: strings in catalogs for Tauri, Expo and the shared web frontend; language selection; localized dates, numbers and sizes; dialogs, errors, tray menus and notifications; user content is never translated. English-only through phases 1 and 2.
