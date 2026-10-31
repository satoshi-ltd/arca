# Arca roadmap

Updated 2026-10-31 · Phase 1 functional, not release-qualified.

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

- **VERIFY-WINDOWS-CI** — Confirm the offline backup test on Windows CI
  `verify · maintainer · high`
  accept: after the candidate containing the test correction is committed and pushed, its exact SHA passes the Windows `publish` job and the downstream `publish-docker` and `publish-site` workflows complete successfully. The existing failed run on `main` remains red until a later candidate passes; local tests do not establish the Windows result.

- **VERIFY-DOCKER-NET** — Network policy through Docker's published ports
  `verify · maintainer · high`
  accept: with a disposable candidate container, confirm first web login through the default localhost binding, then pairing and authenticated requests through Tailscale and LAN bindings with the LAN option on and off. Record the socket peer seen inside the container and verify a gateway address does not get mistaken for a verified tailnet peer. Check a configured HTTPS proxy and Umbrel separately; do not expose or alter the pilot.

- **VERIFY-LOCAL-WATCHERS** — Native filesystem notifications on the maintainer Mac
  `verify · maintainer · high`
  accept: raw `fs.watch` delivers repeated changes in recursive and per-directory modes on this Mac, including after streams close and reopen, and the native watcher integration tests execute without capability skips. Identify the OS or resource cause if delivery stays silent; an independent probe reproduced the loss without loading Arca. The capability guard now checks sustained delivery and reopening, while deterministic tests cover the guard itself; passing source suites does not establish that this host's native notifications recovered.

- **P2-GALLERY-VIEW** — Ship the desktop/web gallery in installers and on Casa
  `verify · maintainer · normal`
  accept: shipped installers and Casa carry the production dependencies (Sharp, exifr) and the gallery opens on both.

### Device checks

- **VERIFY-ANDROID-SECURITY** — Verify Android backup and permissions
  `verify · maintainer · normal`
  accept: inspect the merged manifest in a new Android build: cloud backup is disabled and the overlay permission is absent; on a disposable install check pairing, gallery, background sync, music notifications and Android Auto. Check whether the device manufacturer still transfers app data device-to-device. Source configuration alone does not establish the installed manifest or device behavior.

- **VERIFY-PLAYER-SECURITY** — Player media after hub hardening
  `verify · maintainer · normal`
  accept: after deploying the candidate hub, arca TV plays gallery images and videos and Audio tracks, including seeks, and no longer opens removed or replaced media; record the hub and TV versions. Source tests do not establish behavior on the installed TV.

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

Suggested order for approval: exposed security boundaries and preservation of user files, synchronization recovery, release reliability, then usability and cleanup. No task in this lane is approved for implementation.

### Video delete follow-ups (review of 2026-10-30)

- **VIDEO-DELETE-REPLICA-ERROR** — A replica deleting in a folder that is no longer a video library gets the hub's video-library message
  `bug · agent · low`
  The hub's `/v1/delete-file` answers a linked replica outside a video library with "Local administrator credential required" instead of "This folder is not a video library", which a stale replica catalog can surface. Accept: the hub's linked branch fails with the video-library message (404), with a test through a replica's `/v1/video/delete`.
- **VIDEO-DELETE-SELECTED-REPLICA** — A replica that selected a video folder keeps its local delete checks
  `bug · agent · low`
  `/v1/video/delete` on a replica always forwards to the hub, so a selected copy skips the local rescan, signature check, Trash for unsynced content and Windows "in use", and the local file goes on the next cycle. Accept: either the selected path keeps `engine.deleteFile` locally (then forgets the download) or SPEC states the trade-off; a selected-replica test proves a local unsynced edit is preserved. Drop the desktop `/v1/history` rev fallback, which sends a local rev to the hub.
- **VIDEO-DELETE-TESTS** — Error paths of a replica's video delete
  `chore · agent · low`
  Accept: tests for a stale rev from a replica (409 "File changed. Reload before deleting." through `hubError`), the hub away (503), and a player or browser session against a replica's `/v1/video/delete`.

### Security and data safety

Findings from source audits of 2026-10-29 and 2026-10-31. Priority reflects exposure and impact, not proof of exploitation. Decisions precede dependent work; security, data preservation and defense-in-depth are distinguished below.

- **SEC-TOPOLOGY-DOCS** — Reconcile the pilot network and role documentation
  `chore · agent · normal`
  accept: using read-only observations, identify the current hub and Casa roles, their published bind addresses, the TV's actual route and the candidate versions; correct SPEC's operational description without recording credentials. Distinguish what was observed from assumptions, and never restart or reconfigure a running service.

- **DEC-ERASE-SCOPE** — What may Erase delete outside the state directory?
  `decision · maintainer · normal`
  `addVolume` accepts any existing non-empty directory (a mount point such as `/Volumes/Disk` or `~/Documents`), and Erase later removes it wholesale. Decide between refusing a non-empty directory without this volume's marker at registration, restricting Erase to files Arca knows (as `deleteSyncedCopy` does), or keeping today's contract with a mount-point refusal (`stat.dev` differs from the parent's).
- **DEC-IOS-FILE-SHARING** — iOS exposes the whole Documents tree to Files and Finder
  `decision · maintainer · low`
  `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` let any edit made in Files enter sync like a user edit and show app-owned state JSON; keep and document, or disable.
- **DEC-ANDROID-TRANSFER** — Exclude app data from Android device-to-device migration?
  `decision · maintainer · normal`
  Some manufacturers may transfer app data despite the cloud backup opt-out. Excluding it can protect private local content but may also leave unsynced work behind on the old device; decide the intended migration behavior before adding data extraction rules.

- **SEC-RELEASE-PENTEST** — Exercise the security boundaries before distribution
  `verify · maintainer · high`
  accept: record the exact release candidate and isolated test environment; exercise unauthenticated, browser, replica and player access, code exhaustion and concurrent redemption, revocation during transfers, browser origin and host checks, LAN/IPv6/Tailscale and proxy paths, malicious paths and media, and resource limits. Test installed desktop and phone builds as well as the hub. Record evidence, impact and remediation for findings, retest fixes, and separate untested scenarios from passing results; never use real data or the live pilot for destructive tests.
- **SEC-FOLDER-SCOPE** — Guard replica actions against an unintended folder
  `chore · agent · normal`
  accept: on the hub `/v1/restore`, `/v1/gallery/delete`, `/v1/gallery/link` and `/v1/video/watch-next/remove|restore` from a replica require the folder in the device's latest `machine_reports.folderIds`, as `/v1/conflict-choice` and gallery uploads already do; the administrator keeps every folder and player operations remain available. Tests cover one refused replica call per route and the player paths; SPEC's API table says "linked replica, reported folder" on those rows.
  This is a guard against unintended actions, not a security boundary: the replica supplies its own report, and the single-owner model grants a linked credential access across folders. A compromised device can report another folder; per-device folder ACLs are outside the current product contract.
- **SEC-OPEN-LAUNCHERS** — Open never launches a synced executable
  `bug · agent · normal`
  accept: the desktop `open_file` command refuses launcher and executable extensions (`app, command, tool, terminal, workflow, pkg, dmg, exe, lnk, scr, bat, cmd, ps1, hta, js, vbs, msi, desktop, sh, run, AppImage`) when not revealing and reveals the file instead, and the web UI mirrors the rule; a Rust test covers the list. Follow-up `verify` on macOS and Windows after a desktop build.
- **SEC-SIGNING-STEP** — The updater key never enters the build graph
  `chore · agent · normal`
  accept: establish a supported Tauri build and separate signing sequence, then build without the updater key and sign the final artifacts in a separate step that only runs the signer with the key; the manifest step verifies the signatures. Tests or a local release-tooling check cover artifact names and signatures. Follow-up `verify` on the next real release; do not assume `createUpdaterArtifacts` succeeds without a key.
- **SEC-ACTIONS-PIN** — Release workflows run only pinned code
  `chore · agent · normal`
  accept: every `uses:` in `.github/workflows` is pinned to a commit SHA with the version in a comment, `wrangler` is installed at an exact version, `CLOUDFLARE_*` variables are scoped to the deploy step, `.github/dependabot.yml` covers `github-actions`, npm and cargo, and the release note no longer says "No automatic updates".
- **SEC-HEIC-MEMORY** — Four HEIC previews cannot exhaust memory
  `bug · agent · normal`
  accept: the HEIC worker caps images at 50 megapixels, hands `pixels.buffer` to sharp without a copy, runs with `resourceLimits`, and HEIC renders are limited to two at a time; a test renders a maximal image under the limit and refuses one above it.
- **SEC-BACKUP-SCRUB** — Detect damaged objects without falsely acknowledging backup
  `bug · agent · normal`
  accept: detect and report corrupt objects by hash without logging contents, continue checking unrelated objects, and allow retry or repair. Never acknowledge a revision as backed up without its verified content, or release its retention hold; tests corrupt an object and verify both the error and the acknowledgement boundary. Hourly maintenance checks a bounded batch of stored objects and reports corruption.
- **SEC-MOBILE-MANIFEST** — Limit Android cover-provider access without breaking external players
  `chore · agent · normal`
  accept: limit `CoverProvider` to authorized cover consumers with URI grants or another appropriate mechanism, while preserving Media3 notifications and Android Auto; tests exercise access and grants. A follow-up `verify` checks external controllers in a native build. The provider currently serves covers to other apps, so making it private without working grants is not sufficient.
- **SEC-DEPS** — Dependency advisories are checked in CI
  `chore · agent · normal`
  accept: audit the locked root, mobile and Rust dependency graphs in CI; fix compatible advisories or document each remaining advisory's affected component, reachability, owner and review date. Verify changes against Expo compatibility and the mobile build-tooling tests; do not blindly apply `npm audit fix` or accept an automatic major downgrade. Distinguish build tooling from installed runtime and reconcile the lockfile with installed dependencies.
- **SEC-HUB-FILE-IN-USE** — Deleting a file the hub is serving answers 409
  `bug · agent · low`
  accept: on the hub, deleting a file that a stream, HLS session or probe holds open answers 409 "This file is in use" without recording a tombstone the cycle then fails to apply, proven by a Windows-shaped test that holds the file open; the daemon's `umask` stays as it is (a tight umask would also restrict files written into shared folders).
- **SEC-DOCKER-HYGIENE** — The image is reproducible and attested
  `chore · agent · low`
  accept: the Dockerfile pins the base image by digest and ffmpeg by version, adds a `HEALTHCHECK` on `arca.js status`, and `publish-docker.yml` publishes provenance and an SBOM; `SHA256SUMS` in `publish.yml` is signed. Needs a Casa redeploy to verify.
- **SEC-INDEX-SNAPSHOT** — The hub keeps a nightly copy of its index
  `feature · agent · low`
  accept: daily maintenance writes `VACUUM INTO index.backup.sqlite` beside the index (keeping one), so a corrupt index without a backup replica is recoverable; the CLI documents how to restore it.

- **SEC-ERASE-KEPT** — Erase says which folders it left in place
  `feature · maintainer · low`
  accept: decision: `/v1/destroy-*` returns the registered paths it skipped because they no longer carried Arca's marker or backup state, and the Erase result names them, so a device wiped to give away does not keep a folder silently; today they are left untouched and unreported.

### File preservation and synchronization

- **DEC-HISTORY-DEFAULT** — Should new folders default to Off for all folders or only galleries?
  `decision · maintainer · normal`
  Today folders without a stored choice default to 30 days, including galleries; Movies & TV has no history. The maintainer wants a zero-history default; decide its scope and how to preserve existing folders that rely on the implicit default.
- **HISTORY-DEFAULT-OFF** — Default new folders to no version history
  `feature · agent · normal · depends: DEC-HISTORY-DEFAULT`
  accept: apply the decided default consistently to newly created folders, the catalog and settings while preserving the effective retention of existing folders, including those with no stored choice; tests cover both existing implicit and explicit policies and new folders. Update SPEC.

### Release and native reliability

- **DESK-UPDATER-TESTS** — The Rust updater tests also run on Windows
  `chore · agent · normal`
  accept: the `rust-tests` job also runs on `windows-2022` with Windows versions of the two Unix-only tests, so the PowerShell listing and non-Unix exit handling execute; both pass in CI. Stubbing `install_update` is out of scope.

### Deferred usability and cleanup

- **PHOTO-PLACES** — Search Arca finds photos by place ("hua hin", "thailand", "tailandia")
  `feature · agent · normal · depends: DEC-PHOTO-PLACES`
  accept: the hub reads GPS during gallery indexing and stores only a place label and a folded search text (city, district, province, country), never coordinates; names come from a bundled offline GeoNames extract (CC BY, attributed; no cloud geocoding, no new npm dependency), including Spanish and English alternate names for countries and first-level regions so "thailand" and "tailandia" both match; existing photos re-index once; Search Arca gains a Places group (one row per place with its count, opening the gallery filtered to it) on desktop, web and phone, offline on the phone from the synchronized labels; photos without GPS are explained in the empty result; tests cover lookup (Hua Hin, open sea, antimeridian, invalid coordinates), indexing with and without GPS, and the "hua hin"/"thailand"/"tailandia" queries on hub and phone. Feasibility study: GPS read 0.17 ms per photo, compact dataset about 2.5 MB plus alternate names, grid lookup about 13 µs.

### Sizing review (2026-10-29)

These are the parts of the desktop and mobile sizing audit that are not purely visual; its visual findings have shipped.

- **DESK-ZOOM-CHROME** — Window-control offsets follow the zoom level
  `bug · agent · normal`
  accept: `installDesktopZoom` publishes the zoom as a CSS custom property and the window-controls inset, the controls drop and `.window-drag` divide by it, so at 70% the photo viewer's Back button and the sidebar lockup clear the native traffic lights and at 150% they do not drift away; the 760 px breakpoint is evaluated in unzoomed window pixels so a normal window at 130–150% keeps the full sidebar. Tests cover the property and the computed offsets; a follow-up `verify` checks a macOS desktop build at 70%, 100% and 150%.
- **DESK-DIALOG-SCROLL** — Long dialogs keep their actions in view
  `bug · agent · low`
  accept: dialogs whose content outgrows the window (Choose folders, Restore versions with many rows) scroll their body while the title and the action row stay visible at the 620 px minimum height, as form dialogs already do; a DOM test fills a dialog past the window height.
- **DEC-MOB-FOLD-WIDE** — Does the unfolded Fold get the wide search and file preview?
  `decision · maintainer · normal`
  The kit draws the Fold with the centred search dialog and preview panes and a Files Preview column, but the app shows them only from 1100 dp, so the Fold gets the phone search (rows 8 dp from the edge, four photo cells of 150–190 dp) and no preview. Either let the Fold use them or redraw the kit to show what ships.
- **MOB-MEDIA-TARGETS** — Players are easy to scrub and tap
  `feature · agent · normal`
  accept: the video scrubber and the Now Playing track get a visible thumb, drag seeking and a hit area of at least the touch height; the sleep chip and the 44 dp ghost, segment, switch, breadcrumb and row-action targets get hit slop to 48 dp on Android; component tests check the hit areas. Device feel is a follow-up `verify`.
- **VERIFY-MOB-VIDEO-INSETS** — The video player clears the cutout and the gesture bar
  `verify · maintainer · normal`
  accept: on an edge-to-edge Android phone and the Fold, Close, the title and both ends of the scrubber sit outside the camera cutout and the gesture bar in portrait and landscape; `VideoPlayer.jsx` places its top and bottom chrome at 0 with no safe-area insets, so fix it as an agent task if they overlap.
- **KIT-HYGIENE** — The kit keeps no duplicate or dead rules
  `chore · agent · low`
  accept: `.kit-tray` stops re-declaring `#tray-content` and reuses the production rule, and the `.kit-video-*` rules no page uses are deleted; `npm run design -- --check` and the design tests pass.

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

### Media libraries: Stream or Download per device (proposal 2026-10-30)

Desktop and server replicas choose **Stream from the hub** or **Keep on this device** at Start syncing, and Android phones and the Fold stream the Audio libraries they start and download per artist, album, show or track, while a library they kept before stays a complete copy (SPEC Audio libraries, Music on the phone). The hub always holds everything and never asks; players (arca TV) and the hub's web admin are unchanged. What remains is the device evidence.

- **VERIFY-MEDIA-MODE** — Stream and Keep on real devices
  `verify · maintainer · normal`
  accept: after a Casa redeploy, a desktop build and an Android build: a desktop replica starts an Audio library as Stream, downloads an album and plays it with the hub away, then Stop syncing and again as Keep; the Fold streams an Audio library with the screen off, over Bluetooth and in Android Auto, downloads an album, an artist and a show and plays them in airplane mode, and a library it kept before stays untouched; desktop Keep on a Movies & TV library fills, survives a restart, stops at the space floor and follows a title added and one deleted on the hub.

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
