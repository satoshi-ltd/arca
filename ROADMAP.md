# Arca roadmap

Updated 2026-11-04 · Phase 1 release.

This is the task pool. [SPEC.md](SPEC.md) owns current state, contracts, operations and the design system; [CHANGELOG.md](CHANGELOG.md) records what each version shipped; [AGENTS.md](AGENTS.md) defines the autonomous workflow that consumes this file.

## How this file works

Every task is one entry that a single commit can finish, with fixed fields (decisions only need their question):

- **ID** — stable, never reused. Keep an existing ID when SPEC or the changelog cites it.
- **type** — `bug`, `feature`, `chore`, `ui` (a visual change whose proposal is a board on `design/proposals.html`), `verify` (evidence from a real device or environment), `deploy` (build, install or publish outside the repository) or `decision`.
- **owner** — `agent` (Claude can finish it in the repository and prove it with tests) or `maintainer` (needs a device, a native build, Atlas or Casa, credentials or a product choice).
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

- **SEC-HEIC-MEMORY** — Four HEIC previews cannot exhaust memory
  `bug · agent · normal`
  accept: the HEIC worker caps images at 50 megapixels, hands `pixels.buffer` to sharp without a copy, runs with `resourceLimits`, and HEIC renders are limited to two at a time; a test renders a maximal image under the limit and refuses one above it.
- **SEC-FOLDER-SCOPE** — Guard replica actions against an unintended folder
  `chore · agent · normal`
  accept: on the hub `/v1/restore`, `/v1/gallery/delete`, `/v1/gallery/link` and `/v1/video/watch-next/remove|restore` from a replica require the folder in the device's latest `machine_reports.folderIds`, as `/v1/conflict-choice` and gallery uploads already do; the administrator keeps every folder and player operations remain available. Tests cover one refused replica call per route and the player paths; SPEC's API table says "linked replica, reported folder" on those rows.
  This is a guard against unintended actions, not a security boundary: the replica supplies its own report, and the single-owner model grants a linked credential access across folders. A compromised device can report another folder; per-device folder ACLs are outside the current product contract.
- **VIDEO-REMOVE-WINDOWS-SESSION** — Remove from this device fails on Windows for about a minute after closing a compatible-stream video
  `bug · agent · normal`
  Closing the desktop player never ends the hub-style HLS session the replica started on its downloaded copy, and on Windows FFmpeg keeps the file open until it finishes or the 60 s idle sweep ends it, so Remove answers 409 "Close the video before removing its download" about a closed video; a replacement download hits the same BUSY path and pruning silently leaves the file. Accept: sessions keep their source, removing or replacing a download first ends the sessions reading that file and waits for FFmpeg to exit, and `tests/video-downloads.test.js` drops its `videoSessions.halt()` stop-gap and still passes on Windows.
- **SEC-HUB-FILE-IN-USE** — Deleting a file the hub is serving answers 409
  `bug · agent · low`
  accept: on the hub, deleting a file that a stream, HLS session or probe holds open answers 409 "This file is in use" without recording a tombstone the cycle then fails to apply, proven by a Windows-shaped test that holds the file open; the daemon's `umask` stays as it is (a tight umask would also restrict files written into shared folders).
- **SEC-INDEX-SNAPSHOT** — The hub keeps a nightly copy of its index
  `feature · agent · low`
  accept: daily maintenance writes `VACUUM INTO index.backup.sqlite` beside the index (keeping one), so a corrupt index without a backup replica is recoverable; the CLI documents how to restore it.
- **SEC-ACTIONS-PIN** — Release workflows run only pinned code
  `chore · agent · normal`
  accept: every `uses:` in `.github/workflows` is pinned to a commit SHA with the version in a comment, `wrangler` is installed at an exact version, `CLOUDFLARE_*` variables are scoped to the deploy step, `.github/dependabot.yml` covers `github-actions`, npm and cargo, and the release note no longer says "No automatic updates".
- **SEC-SIGNING-STEP** — The updater key never enters the build graph
  `chore · agent · normal`
  accept: establish a supported Tauri build and separate signing sequence, then build without the updater key and sign the final artifacts in a separate step that only runs the signer with the key; the manifest step verifies the signatures. Tests or a local release-tooling check cover artifact names and signatures. Follow-up `verify` on the next real release; do not assume `createUpdaterArtifacts` succeeds without a key.
- **SEC-DEPS** — Dependency advisories are checked in CI
  `chore · agent · normal`
  accept: audit the locked root, mobile and Rust dependency graphs in CI; fix compatible advisories or document each remaining advisory's affected component, reachability, owner and review date. Verify changes against Expo compatibility and the mobile build-tooling tests; do not blindly apply `npm audit fix` or accept an automatic major downgrade. Distinguish build tooling from installed runtime and reconcile the lockfile with installed dependencies.
- **SEC-MOBILE-MANIFEST** — Limit Android cover-provider access without breaking external players
  `chore · agent · normal`
  accept: limit `CoverProvider` to authorized cover consumers with URI grants or another appropriate mechanism, while preserving Media3 notifications and Android Auto; tests exercise access and grants. A follow-up `verify` checks external controllers in a native build. The provider currently serves covers to other apps, so making it private without working grants is not sufficient.
- **VIDEO-DELETE-REPLICA-ERROR** — A replica deleting in a folder that is no longer a video library gets the hub's video-library message
  `bug · agent · low`
  The hub's `/v1/delete-file` answers a linked replica outside a video library with "Local administrator credential required" instead of "This folder is not a video library", which a stale replica catalog can surface. Accept: the hub's linked branch fails with the video-library message (404), with a test through a replica's `/v1/video/delete`.
- **VIDEO-DELETE-TESTS** — Error paths of a replica's video delete
  `chore · agent · low`
  Accept: tests for a stale rev from a replica (409 "File changed. Reload before deleting." through `hubError`), the hub away (503), and a player or browser session against a replica's `/v1/video/delete`.
- **SEC-DOCKER-HYGIENE** — The image is reproducible and attested
  `chore · agent · low`
  accept: the Dockerfile pins the base image by digest and ffmpeg by version, adds a `HEALTHCHECK` on `arca.js status`, and `publish-docker.yml` publishes provenance and an SBOM; `SHA256SUMS` in `publish.yml` is signed. Needs a hub redeploy to verify.
- **DESK-ZOOM-CHROME** — Window-control offsets follow the zoom level
  `bug · agent · normal`
  accept: `installDesktopZoom` publishes the zoom as a CSS custom property and the window-controls inset, the controls drop and `.window-drag` divide by it, so at 70% the photo viewer's Back button and the sidebar lockup clear the native traffic lights and at 150% they do not drift away; the 760 px breakpoint is evaluated in unzoomed window pixels so a normal window at 130–150% keeps the full sidebar. Tests cover the property and the computed offsets; a follow-up `verify` checks a macOS desktop build at 70%, 100% and 150%.
- **DESK-DIALOG-SCROLL** — Long dialogs keep their actions in view
  `bug · agent · low`
  accept: dialogs whose content outgrows the window (Choose folders, Restore versions with many rows) scroll their body while the title and the action row stay visible at the 620 px minimum height, as form dialogs already do; a DOM test fills a dialog past the window height.

## In progress

_None._

## Needs maintainer

### Device checks

- **VERIFY-OPEN-LAUNCHERS** — Programs are revealed, never opened, on installed desktops
  `verify · maintainer · normal`
  accept: on macOS and Windows desktop builds from v0.8.39 or later, a synced `.command`/`.app`-style file and a `.bat`/`.exe` show no Open file and are revealed in Finder or Explorer, and a conflict's Open reveals them too.

### Waiting for evidence

- **MOB-SHARE-SAVE** — Sending a file to Arca on the phone sometimes does not save it
  `bug · agent · high`
  Reported by the maintainer on 2026-11-04 and still happening; waiting for the maintainer's screenshots the next time it fails, with the entry point, device and source app. Known weak spots in `IncomingShare.jsx` and `incoming-files.js`: on Android `native.receiveShared` has no timeout, so a stalled provider leaves "Preparing files…" up and ignores later shares; a size mismatch reports "The shared file is incomplete". Accept: a test that reproduces the reported failure and passes with the fix; a stalled receive ends with an actionable error and the next share is accepted.

### Phone sync (native follow-ups)

The JavaScript side of the phone sync audit shipped (per-file verification, no re-hash of downloads, one inventory per run, deferred download recovery, outage hold, 1 Hz progress, the long-lived preview queue). What remains needs native code; the loop writes it with JS and contract tests, a maintainer build proves it.

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

### Music

- **MOB-SLEEP-FADE** — The phone's sleep timer fades out before pausing
  `feature · maintainer · low`
  accept: `MusicService` gains a volume command (or a timed fade) and the phone's sleep timer ramps the player volume to silence over about 5 s before pausing and restoring it, as desktop does; reduced motion keeps the fade because it is audio. Needs a native build, so the JavaScript and contract tests land as an agent task once the maintainer schedules the build.

### Decisions

- **DEC-VIDEO-INTEGRITY** — Require full-file integrity for Movies & TV?
  `decision · maintainer · high`
  accept: decide whether video identity and completed-download verification must cover every byte. The video fingerprint hashes only the size and first/last 4 MiB, and it now drives two-way sync of kept Movies & TV libraries: a same-size edit confined to the middle of a file never syncs to the hub or other devices, and download or upload corruption there is undetected; it also cannot distinguish those versions for resume. If full integrity is required, approve a bounded background full hash and a protocol field for clients to verify, with regression cases changing only the middle and measurements of hub I/O and phone verification cost. Keep this separate from the fast scan fingerprint.
- **DEC-CONVERTING-LEGACY** — Remove the legacy `converting` mode on phones?
  `decision · maintainer · normal`
  accept: a yes or no. `replica.js`, `App.jsx` and a test still recover a folder interrupted mid-way through the former upload-only-to-working-copy transition (`converting` mode, restoring missing indexed files before switching to `source`); AGENTS.md forbids legacy modes, yet a phone could still hold that state.
- **DEC-PHOTO-PLACES** — Approve offline photo place indexing and place search as described by PHOTO-PLACES?
  `decision · maintainer · normal`
- **DEC-RENAME-MODIFIED** — Allow renaming modified synced files?
  `decision · maintainer · low`
- **DEC-PICKER-GALLERY** — Remove the unreachable picker-only gallery path?
  `decision · maintainer · low`
- **DEC-LAST-CHANGE-SCOPE** — Should Last change count deletions and conflict copies, or be named "Last saved version"?
  `decision · maintainer · low`

## Proposed

Suggested order for approval: exposed security boundaries and preservation of user files, synchronization recovery, release reliability, then usability and cleanup. No task in this lane is approved for implementation.

### Video delete follow-ups (review of 2026-10-30)

### Video downloads on Windows (review of 2026-11-02)

### Performance and caching (audit of 2026-11-04)

Source reading only, no measurements; figures are estimates from the code.

- **PERF-GALLERY-PAGE** — A gallery page does not re-read the whole photo library
  `feature · agent · high`
  `gallery.js` `page()` builds and sorts every visible photo before `LIMIT 61` and reads it again for `months`; the open desktop gallery re-requests every loaded page with `fresh=true` every 5 s (`refreshGallery`), 20 pages for 1,200 photos. Accept: the ordered rows are memoized on the folder's file generation, the rules and a gallery counter bumped by every metadata, member and asset write; the 5 s timer runs only while `/v1/events` is stale; a test counts the `WITH media` statements across two unchanged pages (0 the second time) and sees a new photo.
- **PERF-STATUS-TOTALS** — `/v1/status` does not scan the index, and the hidden tray does not poll
  `feature · agent · high`
  Per-folder totals, conflict counts and `historyRevisions` are full scans on each call; the hidden tray window polls every 2 s for the whole run, about 42 status calls a minute while idle. Accept: totals memoized on `file_generations.generation` and a revision counter; the tray refreshes only while visible; a test shows a second unchanged `status()` runs no counting query and that a commit and retention update the counts.
- **PERF-THUMB-HITS** — A thumbnail served from disk costs no fsync'd write
  `feature · agent · normal`
  A disk hit does `UPDATE gallery_derivatives SET used` (fsync under `synchronous=FULL`) and a synchronous read, and never enters the 32 MB memory LRU. Accept: disk hits enter the LRU and `used` is flushed in one transaction about once a minute and on close; a test sees at most one update and one read across two requests.
- **PERF-SEARCH-FOLD** — Search does not re-fold every path per keystroke
  `feature · agent · normal`
  `instr(arca_fold(f.path),?)` calls a JavaScript fold for every file on every keystroke, and stale searches are never cancelled. Accept: a per-folder folded path list keyed on the file generation, as the music and video indexes do; a test sees no fold calls on a repeated search and finds a newly committed file.
- **PERF-RULES-HOIST** — Exclusion rules resolve once per loop, not once per file
  `feature · agent · normal`
  `visibleRules()` does a folder SELECT and an `lstat` of `.arcaignore` per call and runs per row in `replaceLocal` and several engine loops, about 200k of each for 100k files. Accept: rules resolved once per loop or page (the cycle keeps its `.arcaignore` hash check); a test counts at most two `lstat` calls for 1,000 entries with an unchanged result.
- **PERF-WEB-ASSETS** — The web UI revalidates its assets instead of downloading them again
  `feature · agent · normal`
  About 1.2 MB (`app.js`, lucide, CSS, fonts) is read from disk and sent uncompressed with `no-store` on every browser load. Accept: assets hashed once (re-read when mtime changes), `ETag` with `no-cache`, 304 on `If-None-Match`, optional gzip with `Vary`; CSP stays on 200; tests cover 304 and gzip round trip.
- **PERF-PREVIEW-BUDGET** — The preview budget check does not scan the table per render
  `feature · agent · low`
  After each render `SUM(size) … WHERE key LIKE '%…'` scans every derivative, quadratic over a large folder's first preparation. Accept: per-size totals in memory, adjusted by render, discard and eviction and resynchronised at start; a test renders 50 images with at most one sum query and stays under a small budget.
- **PERF-WEB-IMAGE-CACHE** — Pages and thumbnails get separate browser quotas
  `feature · agent · low`
  Thumbnails, covers and art travel as base64 JSON with `no-store`, and the IndexedDB store holds 128 entries shared by pages and thumbnails, so two or three pages of thumbnails evict every stored page. Accept: separate quotas (pages by count, thumbnails by bytes) in a pure module with a test; whether private images may be cached by the browser is a maintainer decision.
- **PERF-MOB-REDISCOVERY** — The phone does not re-read the whole photo library every minute
  `feature · agent · high`
  The foreground rediscovery pages the whole camera roll every 60 s, 100 assets per page with one store read each, and every 4 pages runs another full sync cycle with hub requests: about 75 cycles per pass for 30,000 photos. Accept: the minute pass stops at the first fully known, unchanged page (full passes stay for first scan, Sync now and the inventory schedule); a test with 3,000 known assets pages at most twice and runs no follow-up cycle, a new asset is still queued, and `force` pages everything. SPEC §5's "rediscovered every minute" changes, so this needs the maintainer's approval of that wording.
- **PERF-MOB-PROGRESS** — Finished files respect the 1 Hz progress limit
  `feature · agent · high`
  The throttle skips ticks where `bytesDone === bytesTotal`, so every small file fires `changed()`, a notification post and a full snapshot read, up to 10 a second. Accept: completion ticks are throttled too and the last tick of a run is always shown; a test of 50 completions in one second sees at most two `changed()` calls.
- **PERF-MOB-FOLDER-LIST** — An open folder keeps its listing when nothing changed
  `feature · agent · high`
  Every refresh walks the open folder, sorts it, sets a new array and writes the whole listing as one JSON value, which recomputes the gallery model; 20,000 photos is about 40,000 native calls and 4–5 MB written per run. Accept: an unchanged walk keeps the previous array and skips the write, the listing persists on a debounce; a `folder-listing.js` test checks identity and change detection.
- **PERF-MOB-THUMB-MAP** — The gallery's thumbnail map is not rewritten while scrolling
  `feature · agent · normal`
  The whole map (full `file://` URIs, 1–4 MB) is stringified and written after scroll-driven passes, and every flush spreads it and re-creates every photo object up to four times a second. Accept: thumbnails stored as rows with only the changes written, the map passed by ref and version; a test sees three deltas write three rows and reload give the same thumbnails.
- **PERF-MOB-MUSIC-MEMO** — The phone's music library is rebuilt only when it changed
  `feature · agent · normal`
  Every cycle parses and rebuilds each music library even when the hub answers `unchanged`, and the music screen, now playing and Folders rebuild or parse it again; video parses its saved library on every request to read its version. Accept: the built library memoized on its version, journal, file rows and playlists; a test sees no store reads or `player.reload` on a second unchanged refresh and a rebuild after a local rename.
- **PERF-MOB-HASH-CACHE** — Inventory scans load the hash cache once per folder
  `feature · agent · normal`
  `cachedRecord` never keeps a store hit in memory, so each inventory makes one SQLite read per file (20,000 for a 20k-file replica). Accept: one query per folder fills the map; a test sees no per-file `cachedHash` calls and no hashing on a second scan of an unchanged folder.
- **PERF-MOB-FOLDERS-CACHE** — Folder totals survive settings writes
  `feature · agent · normal`
  `folders()` caches on a counter that every write bumps, settings included, so the aggregate over every file row runs on nearly every UI refresh during sync. Accept: a counter bumped only by methods that touch files, folders or gallery sources, with a test listing every mutating method; `store.set` then `folders()` runs no query.
- **PERF-MOB-SEARCH** — Phone search parses only matching rows
  `feature · agent · low`
  Every ASCII query also reads up to 10,000 accented rows per folder and parses each, folder after folder, and outdated searches keep running. Accept: match on `path` before parsing and stop when a newer query starts; a test with 5,000 accented rows parses only the 3 matches.

### Hub relocation follow-ups (2026-11-03)

- **HUB-DEVICE-ID** — Pairing the same device again keeps one hub registration
  `feature · agent · normal`
  Each device keeps a persistent device ID and sends it with `/pair`; the hub rotates that registration's token instead of adding a device, and a missing ID keeps today's behaviour. Accept: re-pairing with the same ID leaves one roster entry, with a test; an older client still pairs.
- **HUB-MOVED-NOTICE** — The old address tells clients where the hub went
  `feature · agent · low`
  An operator command makes the old host answer every `/v1/*` with 421 `{error: "hub-moved", hubId, url}` and serve no data; a client whose saved hub ID matches offers Change address with the same checks (confirmed on desktop and phone; a player without a UI only when the new host passes the connect-time LAN or tailnet verification). Accept: the notice never changes the hub ID, is never followed without the same verification, and is tested from a desktop replica and a player.

### Security and data safety

Findings from source audits of 2026-10-29 and 2026-10-31. Priority reflects exposure and impact, not proof of exploitation. Decisions precede dependent work; security, data preservation and defense-in-depth are distinguished below.

- **DEC-ERASE-SCOPE** — What may Erase delete outside the state directory?
  `decision · maintainer · normal`
  `addVolume` accepts any existing non-empty directory (a mount point such as `/Volumes/Disk` or `~/Documents`), and Erase later removes it wholesale. Decide between refusing a non-empty directory without this volume's marker at registration, restricting Erase to files Arca knows (as `deleteSyncedCopy` does), or keeping today's contract with a mount-point refusal (`stat.dev` differs from the parent's).
- **DEC-IOS-FILE-SHARING** — iOS exposes the whole Documents tree to Files and Finder
  `decision · maintainer · low`
  `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` let any edit made in Files enter sync like a user edit and show app-owned state JSON; keep and document, or disable.
- **DEC-ANDROID-TRANSFER** — Exclude app data from Android device-to-device migration?
  `decision · maintainer · normal`
  Android 12+ copies app data in a phone-to-phone migration whatever `allowBackup` says (`IGNORE_ALLOW_BACKUP_IN_D2D`); only a `<device-transfer>` exclusion in `dataExtractionRules` stops it. Excluding it can protect private local content but may also leave unsynced work behind on the old device; decide the intended migration behavior before adding data extraction rules.

- **SEC-RELEASE-PENTEST** — Exercise the security boundaries before distribution
  `verify · maintainer · high`
  accept: record the exact release candidate and isolated test environment; exercise unauthenticated, browser, replica and player access, code exhaustion and concurrent redemption, revocation during transfers, browser origin and host checks, LAN/IPv6/Tailscale and proxy paths, malicious paths and media, and resource limits. Test installed desktop and phone builds as well as the hub. Record evidence, impact and remediation for findings, retest fixes, and separate untested scenarios from passing results; never use real data or production servers for destructive tests.

- **SEC-BACKUP-HOLD** — Damage the hourly backup check finds keeps its revision on the hub
  `decision · maintainer · normal`
  The backup's acknowledgement only rises, so damage found in an object already acknowledged cannot hold its revision: hub retention may prune it before the backup repairs it. Decide whether the hub accepts an explicit hold from a backup (a separate field, so enabling a backup with revision 0 never lowers it by accident) or keeps today's behaviour.
- **SEC-OPEN-LAUNCHERS-2** — More file kinds that run code are revealed, never opened
  `bug · agent · normal`
  Synced files carry no quarantine or Mark-of-the-Web, so the OS never warns. Not yet in the list: `com pif cpl msc vbe jse wsf wsh url chm reg msp application appref-ms fileloc inetloc webloc mpkg jar py pyw`; an extensionless Unix file with an executable bit opens in Terminal on macOS (sync never sets modes, so only a local object already executable can cause it). Accept: the desktop and Rust lists gain these kinds, a Unix file with `mode & 0o111` and no extension is revealed, with tests; SPEC lists them.
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

Desktop and server replicas choose **Stream from the hub** or **Keep on this device** at Start syncing for Audio and Movies & TV alike, where Keep is a complete two-way folder, and Android phones and the Fold stream the Audio libraries they start and download per artist, album, show or track, while a library they kept before stays a complete copy (SPEC Audio libraries, Video libraries, Music on the phone). The hub always holds everything and never asks; players (arca TV) and the hub's web admin are unchanged. What remains is the device evidence.

- **VERIFY-MEDIA-MODE** — Stream and Keep on real devices
  `verify · maintainer · normal`
  accept: after a hub redeploy, a desktop build and an Android build: a desktop replica starts an Audio library as Stream, downloads an album and plays it with the hub away, then Stop syncing and again as Keep; the Fold streams an Audio library with the screen off, over Bluetooth and in Android Auto, downloads an album, an artist and a show and plays them in airplane mode, and a library it kept before stays untouched; a desktop app and a server replica keep a Movies & TV library as a folder at its destination (View folder and Open in Finder work), play a title from it with the hub away, add a film that reaches the hub and delete one, after which the hub's Version history restores it from `.arca-versions` on Atlas's media disk with no copy into the state directory; a library kept the old way keeps its downloads until Stop syncing.

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
