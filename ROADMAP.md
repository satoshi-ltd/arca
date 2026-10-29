# Arca roadmap

Updated 2026-10-29 · Phase 1 functional, not release-qualified.

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

- **SEC-REGEX-BOUNDS** — Subtitle and `.nfo` parsing stay linear
  `bug · agent · high`
  accept: `subtitleText` strips `{\…}` and `<font…>` with bounded quantifiers or one manual pass, `detectLanguage` reads at most 64 KiB, and `parseNfo` bounds tag bodies or bails after 50 `<title` occurrences; tests time a 2 MiB `.srt` of `{\` and a 256 KiB `.nfo` of unclosed tags under 200 ms each.
- **SEC-ERASE-CASE** — Erase never reaches an ancestor spelled in another case
  `bug · agent · high`
  accept: `resolveLocation`, `addVolume`, `assertVolume` and both reset checks canonicalise with `fs.realpathSync.native` and compare ancestry case-insensitively on macOS and Windows (or by `dev/ino` of the state directory's ancestors); registering `/USERS/<name>` or `c:\Users\<name>` as a folder answers 409 and `resetTargets` refuses it; tests cover both spellings.
- **SEC-ERASE-MARKER** — Erase deletes only directories that are still Arca's
  `bug · agent · high`
  accept: `resetTargets` skips a volume whose directory lacks a `.arca-volume` marker with this volume's id and a backup path without `state/config.json` of role `backup`, keeping the dev/ino journal check; a folder stopped with "Stop syncing here", removed by hand and recreated with other content survives Erase, proven by a test. DEC-ERASE-SCOPE may widen this.

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

### Security and data safety (audit of 2026-10-29)

Findings of the read-only audit of v0.8.9, ordered by severity. Each task is one commit; the decisions come first because some tasks depend on them.

- **DEC-PLAINTEXT-POLICY** — Which plaintext peers need the LAN HTTP opt-in?
  `decision · maintainer · high`
  Today `allowLanHttp` guards only private IPv4 peers (10/8, 172.16/12, 192.168/16): IPv6, link-local, CGNAT outside Tailscale mode and public addresses pass device authentication with the opt-in off, browser sign-in and sessions ignore it entirely, and the Docker image always binds `0.0.0.0 --private-network`. Proposal: every plaintext peer except loopback and verified tailnet peers needs the opt-in, browsers included. Behind the Umbrel access proxy every client shares the proxy's address, so the opt-in would become mandatory for Umbrel web access and per-address limits collapse into one bucket; decide whether a trusted-proxy setting (accept a peer header only when the socket peer is the configured proxy) is wanted or whether SPEC documents the limitation.
- **DEC-VIDEO-DELETE-TRASH** — A Movies & TV deletion keeps a copy somewhere
  `decision · maintainer · high`
  Stream-only folders keep no object and no history, so a deletion, now also from a TV remote, destroys the only copy. Options: move the file to the hub's per-volume trash (`settle` with `moveToTrash` when `streamOnly`) or require the administrator for stream-only deletions.
- **DEC-ERASE-SCOPE** — What may Erase delete outside the state directory?
  `decision · maintainer · normal`
  `addVolume` accepts any existing non-empty directory (a mount point such as `/Volumes/Disk` or `~/Documents`), and Erase later removes it wholesale. Decide between refusing a non-empty directory without this volume's marker at registration, restricting Erase to files Arca knows (as `deleteSyncedCopy` does), or keeping today's contract with a mount-point refusal (`stat.dev` differs from the parent's).
- **DEC-UMBREL-VERSION** — The Umbrel package pins hub image 0.4.1
  `decision · maintainer · normal`
  `deploy/umbrel/arca/docker-compose.yml` and `umbrel-app.yml` ship 0.4.1 while clients target 0.8.x headers; say whether the submission is intentionally frozen or bump the digest with each release.
- **DEC-IOS-FILE-SHARING** — iOS exposes the whole Documents tree to Files and Finder
  `decision · maintainer · low`
  `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` let any edit made in Files enter sync like a user edit and show app-owned state JSON; keep and document, or disable.

- **SEC-PLAYER-SCOPE** — A TV deletes only inside video and music folders
  `bug · agent · high`
  accept: `/v1/delete-file` from a player answers 403 unless the folder is a video or audio library; a test shows a player cannot tombstone a file in a plain folder it reads through `/v1/catalog`.
- **SEC-LAN-POLICY** — The plaintext opt-in covers every untrusted peer
  `bug · agent · high · depends: DEC-PLAINTEXT-POLICY`
  accept: as decided; at minimum `requireLanAccess` applies to every non-loopback, non-verified-tailnet plaintext peer (IPv6 included), to `/auth/*` and to browser-session requests, turning the opt-in off ends browser sessions, and the Docker image documents or drops the implicit `--private-network`; tests cover an IPv6 peer, a 100.64/10 peer in standalone mode and a browser sign-in with the opt-in off.
- **SEC-FOLDER-SCOPE** — Linked devices act only in folders they report
  `bug · agent · normal`
  accept: on the hub `/v1/restore`, `/v1/gallery/delete`, `/v1/gallery/link` and `/v1/video/watch-next/remove|restore` from a replica require the folder in the device's latest `machine_reports.folderIds`, as `/v1/conflict-choice` and gallery uploads already do; the administrator keeps every folder; tests cover one refused call per route and SPEC's API table says "linked, reported folder" on those rows.
- **SEC-OPEN-LAUNCHERS** — Open never launches a synced executable
  `bug · agent · normal`
  accept: the desktop `open_file` command refuses launcher and executable extensions (`app, command, tool, terminal, workflow, pkg, dmg, exe, lnk, scr, bat, cmd, ps1, hta, js, vbs, msi, desktop, sh, run, AppImage`) when not revealing and reveals the file instead, and the web UI mirrors the rule; a Rust test covers the list. Follow-up `verify` on macOS and Windows after a desktop build.
- **SEC-COOKIE-HOST** — The browser session cookie is bound to Arca's origin
  `chore · agent · normal`
  accept: under `ARCA_WEB_ORIGIN` the cookie is `__Host-arca_session` (Secure, Path=/, no Domain); over plain HTTP SPEC states that Arca needs a hostname of its own because another service on the same host and another port receives the cookie; a test checks the cookie name and attributes in both modes.
- **SEC-SIGNING-STEP** — The updater key never enters the build graph
  `chore · agent · normal`
  accept: `publish.yml` builds with `createUpdaterArtifacts` and no signing key, then signs each artifact in a separate step that only runs `tauri signer sign` with the key, so no npm or crates.io build script can read it; the manifest step verifies the signatures. Follow-up `verify` on the next real release.
- **SEC-ACTIONS-PIN** — Release workflows run only pinned code
  `chore · agent · normal`
  accept: every `uses:` in `.github/workflows` is pinned to a commit SHA with the version in a comment, `wrangler` is installed at an exact version, `CLOUDFLARE_*` variables are scoped to the deploy step, `.github/dependabot.yml` covers `github-actions`, npm and cargo, and the release note no longer says "No automatic updates".
- **SEC-STATE-MODE** — The state directory is private even when it already exists
  `bug · agent · normal`
  accept: `init`, `initializeServer` and `Store` chmod the home to 0700 and the daemon sets `umask 077` before creating `index.sqlite`, `objects/`, `uploads/`, `previews/` and `files/`; the Dockerfile creates `/data/state` as 700; a test starts in a 755 home and checks the modes.
- **SEC-ERROR-BODY** — Unexpected errors never echo internals
  `bug · agent · normal`
  accept: a response without a status answers 500 with "Internal error" and logs the exception on the hub, so replicas and players never read absolute paths or stack text; tests force an ENOENT and a TypeError and check both bodies.
- **SEC-INPUT-STRICT** — Every stored string is validated
  `chore · agent · normal`
  accept: `/pair` names refuse control characters like `/v1/settings` does, `/v1/connect` checks `catalog.id`, names and `historyRetention` types and lengths and a missing `volumes` array, and `validPath` refuses a component over 255 bytes; one test per rule.
- **SEC-HEIC-MEMORY** — Four HEIC previews cannot exhaust memory
  `bug · agent · normal`
  accept: the HEIC worker caps images at 50 megapixels, hands `pixels.buffer` to sharp without a copy, runs with `resourceLimits`, and HEIC renders are limited to two at a time; a test renders a maximal image under the limit and refuses one above it.
- **SEC-BACKUP-SCRUB** — A damaged object never stalls the backup or the hub's history
  `bug · agent · normal`
  accept: the backup loop records a row whose object fails verification as missing, names the hash in `backupError` and continues, so `backup-ack` advances and hub retention is not frozen; hourly maintenance verifies a bounded batch of stored objects against their names and counts corrupt ones in status; tests corrupt one object and check both.
- **SEC-WINDOWS-BUSY** — An open file never breaks a cycle or a deletion on Windows
  `bug · agent · normal`
  accept: `collectUnusedObjects` catches per object so an EBUSY on a served blob skips that object and the cycle completes; deleting a file the hub is streaming or probing answers 409 "File in use" instead of 500; the Windows trash batches paths by byte length under the 32 KiB environment limit; `update-watch.js` removes its directory with `fs.rmSync` retries instead of `cmd.exe`; tests simulate the open handle.
- **SEC-MOBILE-MANIFEST** — The Android manifest ships only what the app needs
  `chore · agent · normal`
  accept: `allowBackup` is off (or `databases/` and `files/arca` are excluded from cloud backup), `SYSTEM_ALERT_WINDOW` is removed like `CAMERA`, and `CoverProvider` is not exported or requires a permission; config-plugin tests cover the manifest. Needs a native build, so the device evidence is a follow-up `verify`.
- **SEC-SESSION-APPROVER** — Revoking an approver ends the sessions it granted
  `chore · agent · low`
  accept: a browser session stores the device that approved it and `forgetDevice` and disabling an approver drop those sessions; a test approves, revokes and sees 401.
- **SEC-RATE-CAPS** — One client cannot exhaust shared capacity
  `chore · agent · low`
  accept: `/v1/events` allows at most four waiters per credential before 503 and web-approval requests at most three pending per address; tests fill both.
- **SEC-DELETE-RACE** — A replica deletion re-checks the file before unlinking
  `bug · agent · low`
  accept: replica `deleteFile` captures the file signature before hashing and answers 409 "Local file changed" when it differs right before the unlink or trash, as `deleteSyncedCopy` does; a test writes during the hash.
- **SEC-RENAME-FALLBACK** — Rename works on volumes without hard links
  `bug · agent · low`
  accept: a replica rename that gets `EPERM`, `ENOTSUP` or `EXDEV` from `linkSync` falls back to `renameSync` when the destination does not exist; a test stubs the error.
- **SEC-SCHEMA-INSERTS** — An older daemon fails safely on a newer index
  `chore · agent · low`
  accept: every `INSERT … VALUES` names its columns and the schema carries `PRAGMA user_version`, bumped with each migration; opening a newer schema refuses with a clear message instead of failing on the first insert; a test opens a database with an extra column.
- **SEC-UPLOAD-REHASH** — Upload status never re-hashes a complete object
  `chore · agent · low`
  accept: `GET /v1/uploads/<hash>` and a chunk against an existing object answer from the verified object store (or a signature cache) without hashing the whole blob; a test counts hash calls.
- **SEC-DOCKER-HYGIENE** — The image is reproducible and attested
  `chore · agent · low`
  accept: the Dockerfile pins the base image by digest and ffmpeg by version, adds a `HEALTHCHECK` on `arca.js status`, and `publish-docker.yml` publishes provenance and an SBOM; `SHA256SUMS` in `publish.yml` is signed. Needs a Casa redeploy to verify.
- **SEC-DEPS** — Dependency advisories are checked in CI
  `chore · agent · low`
  accept: `npm audit fix` (non-major) in `apps/mobile`, `cargo audit --locked` in the `rust-tests` job, and `npm audit --omit=dev` at the root in `publish.yml`, all green or with each exception named.
- **SEC-INDEX-SNAPSHOT** — The hub keeps a nightly copy of its index
  `feature · agent · low`
  accept: daily maintenance writes `VACUUM INTO index.backup.sqlite` beside the index (keeping one), so a corrupt index without a backup replica is recoverable; the CLI documents how to restore it.

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

- **UX-DESK-WEB-APPROVAL-TRAY** — A web sign-in request reaches a closed desktop window
  `feature · maintainer · low`
  accept: decision: the tray lists a "Web sign-in request / Review" attention row so a desktop running in the tray can approve a browser; today approval reaches only the foreground window, which SPEC states.

- **UX-PHOTO-RANGE** — Shift-click selects a range of photos
  `feature · maintainer · low`
  accept: decision: Shift-click extends the photo selection from the last toggled tile and the selection bar may offer Download besides Delete; today selection is click by click and Delete only.

- **UX-FILES-TIME-REPLICA** — Files rows show their last-change time on replicas
  `chore · agent · normal`
  accept: a desktop replica's Files rows carry the time the hub recorded for each file's current revision, not only the hub's own rows; a test pins a replica store without local revisions.

- **UX-MOB-SECTION-A11Y** — File rows are announced with their size and kind
  `chore · agent · low`
  accept: a video tile in a photo folder reads its duration besides its date; the phone's gallery rows carry no duration today, so this needs the hub or the native index to report it first.

- **UX-MOB-VIDEO-FOLD** — The video player does not rotate on the nearly square Fold
  `bug · maintainer · normal`
  accept: verify on the unfolded Fold: skip the manual rotation when the aspect ratio is under about 1.2 or the layout is wide; needs the device.

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
