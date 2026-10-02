# Arca roadmap

Updated 2026-10-02 · Phase 1 functional, not release-qualified.

This is the task pool. [SPEC.md](SPEC.md) owns current state, contracts, operations and the design system; [CHANGELOG.md](CHANGELOG.md) records what each version shipped; [AGENTS.md](AGENTS.md) defines the autonomous workflow that consumes this file.

## How this file works

Every task is one entry that a single commit can finish, with fixed fields (decisions only need their question):

- **ID** — stable, never reused. Keep an existing ID when SPEC or the changelog cites it.
- **type** — `bug`, `feature`, `chore`, `ui` (a visual change whose proposal is a board on `design/proposals.html`), `verify` (evidence from a real device or environment), `deploy` (build, install or publish outside the repository) or `decision`.
- **owner** — `agent` (Claude can finish it in the repository and prove it with tests) or `maintainer` (needs a device, a native build, Casa, credentials or a product choice).
- **priority** — `high`, `normal` or `low`. Within a lane, order is priority, then position.
- **depends** — IDs that must finish first.
- **accept** — what proves it done. Agent tasks need evidence a test or command can show.

Lanes:

- **Queue** — approved agent tasks, in the order they will be done. Only the maintainer moves a task here, with two exceptions that enter at the top: a bug the maintainer reports, and a red pipeline on `main`.
- **In progress** — at most one agent task.
- **Needs maintainer** — `verify`, `deploy` and `decision` tasks, and agent work waiting on one of them.
- **Proposed** — ideas not yet approved, from the maintainer or from Claude. Never worked on until approved.

A purely visual idea is not filed here as Proposed: its board in `design/proposals.html` is the proposal. Once the maintainer approves it, it enters Queue as a `ui` task with the board ID and `accept: the board`; when it ships, delete the task and the board. A task that mixes logic and a screen splits: the screen is board `UI-<TASKID>`, the logic stays under its ID and its accept says "the interface follows board UI-<TASKID>"; a board ID never equals a non-`ui` task ID. When a task ships, delete it and record it in the changelog and in the SPEC section it changes. When a feature needs device evidence, split it: the implementation is an agent task; the device check is a maintainer `verify` task that depends on it. The loop never builds native code, so a `NAT-*` task ends with its JavaScript and contract tests; its compile and device evidence come from a maintainer build (BUILD-MOBILE or BUILD-IOS) recorded as a follow-up `verify`.

## Queue

- **NAT-REVEAL-FILE** — Show a file in its own folder on Windows and Linux
  `feature · agent · low`
  accept: `open_file` with `reveal` works on every platform (Windows `explorer /select,<path>`, Linux the file's parent directory) and the file detail's Show in folder, and the photo viewer's, open the file's own folder instead of the shared folder's root; a Rust test next to the existing `open_file` code; native change, so a desktop build and a maintainer `verify` on real Windows and Linux follow.
- **NAT-F29-SHARE-CACHE** — Safe cache names for incoming shares (security)
  `bug · agent · high`
  accept: Android shared files land under generated cache names, never `cacheDir/<sender display name>`; native change, device evidence follows in a `verify`.
- **MOB-PICKED-DURABLE** — Picked photos outlive a long offline stretch
  `bug · agent · low`
  accept: a photo picked with Add photos… is copied into app-owned storage when it is journaled, so the OS clearing the picker cache or an iOS container path change cannot lose it, and picks still upload when library permission is revoked or the linked album is gone (today the cycle's permission and album checks run first); a picked photo whose file is gone can be dismissed instead of staying failed until picked again, and Sync now makes failed manual picks retry at once while automatic uploads are off; replica tests for each.
- **MOB-GALLERY-ASSET-ROWS** — Tolerate a corrupt gallery asset row
  `bug · agent · low`
  accept: a malformed `gallery_assets` row no longer stops the app from starting (`clearInterrupted` and the SQLite `json_extract` queries) or blocks other assets, and never publishes deletions; a replica test with a corrupt asset row.
- **MOB-FULLSCAN-FAILING** — Full verification while one folder keeps failing
  `bug · agent · low`
  accept: a folder that fails every cycle no longer keeps `lastFullScan` from advancing, so healthy folders are not fully re-hashed on every sync after the first hour; a replica test with one permanently failing folder shows scheduled cycles stop forcing full verification once the healthy folders complete it.
- **MOB-PICKED-RETRY** — Retry on the offline notice reopens the photo picker
  `bug · agent · low`
  accept: after an offline Add photos… failure, the notice's retry starts a sync instead of reopening the picker; a replica or layout test.
- **MOB-GALLERY-IGNORE-POLICY** — Photos the folder's `.arcaignore` excludes still show as phone-only in the online gallery
  `bug · agent · low`
  accept: online, local photos and videos the folder's `.arcaignore` ignores never appear in the phone gallery (today only the fixed exclusion list filters them); a pure-helper test with a policy and a replica test reading the real `.arcaignore`.
- **NODE-LTS-UPDATE** — Move to the latest Node 24 LTS security release
  `chore · agent · normal`
  accept: `.node-version`, the Dockerfile and the EAS profiles move from 24.14.0 to the newest Node 24 LTS release that includes the 24.14.1, 24.17.0 and 24.18.1 security fixes; CI, runtime staging and the guard test pass. The shipped desktop runtime and Docker image then need a desktop build and a Casa redeploy (maintainer).

## In progress

_None._

## Needs maintainer

### Builds and deployments

- **BUILD-MOBILE** — Native mobile build from the current source
  `deploy · maintainer · high`
  accept: an Android production build of v0.6.20 or later installed on the Fold. It carries the v0.6.13 `ArcaNetwork.thumbnail` module, the Android screen-off TransferSession fix, the v0.6.18 damaged-album-record handling and the v0.6.20 conflict-recovery lease fix, and drops the obsolete exports and permission text of the removed deletion review.
- **BUILD-DESKTOP** — Desktop build from the current source
  `deploy · maintainer · high`
  accept: the running desktop app and daemon report v0.6.15 or later (unlink deletes by default, local-only previews, photo/video header counts, relink with the hub as the source of truth, 30 s keep-alive).
- **BUILD-IOS** — First iOS device build on SDK 57
  `deploy · maintainer · normal`
  accept: an iOS build installed on a physical device (only a simulator `xcodebuild` has passed, at v0.6.1).
- **CASA-VERSION** — Record Casa's running version
  `verify · maintainer · high`
  accept: Casa's running version is reported to the maintainer and recorded in P1-CASA-DEPLOY, which depends on it.
- **P1-CASA-DEPLOY** — Redeploy Casa
  `deploy · maintainer · high · depends: CASA-VERSION`
  accept: Casa runs v0.6.15 or later. Pending hub-side changes: v0.6.11 per-month video counts; v0.6.7 per-month newest revision; v0.6.6 lease renewal on page reads; removal of obsolete gallery endpoints; the v0.6.0 hub audit changes (503/412 gating, error codes, lease replacement, stored-part upload verification, lost-reply fast-forward). Order: Casa first, then desktop; from 0.6.2 on, replicas and phones go before or together with the hub.
- **P2-GALLERY-VIEW** — Ship the desktop/web gallery in installers and on Casa
  `deploy · maintainer · normal · depends: BUILD-DESKTOP, P1-CASA-DEPLOY`
  accept: shipped installers and Casa carry the production dependencies (Sharp, exifr) and the gallery opens on both.

### Device checks

- **OFFLINE-DEVICE** — Offline replicas on real machines
  `verify · maintainer · high · depends: BUILD-MOBILE, BUILD-DESKTOP`
  accept: with Casa unreachable (Tailscale off or the hub stopped), the Fold and the Mac open every view, browse folders, open and share local files and show hub-only actions as unavailable; reconnecting resumes sync without restarting either app.
- **FOLD-STORAGE** — Storage after the object-store fix
  `verify · maintainer · high · depends: BUILD-MOBILE`
  accept: after the first sync, Android's storage figure for Arca drops to about the synchronized folders' size (from about 55 GB to about 26 GB for `photos`).
- **FOLD-THUMBNAILS** — Gallery thumbnails, posters and viewer
  `verify · maintainer · high · depends: BUILD-MOBILE`
  accept: grid thumbnails and video posters fill in within seconds while folders sync; HEIC photos open quickly; the viewer shows the thumbnail at once; offline, every downloaded photo appears and the rest stay placeholders. Reported on the v0.6.44 build: grey tiles with every photo downloaded and a gallery crash (`Cannot read property 'uri' of undefined`, fixed in v0.6.46); if tiles stay grey on v0.6.46, connect the Fold by adb and capture the gallery's native errors so the cause can be found.
- **FOLD-GALLERY-UX** — Gallery gestures and playback
  `verify · maintainer · normal · depends: BUILD-MOBILE`
  accept: infinite scroll both ways, the fast-scroll thumb follows the finger with sparse year chips, pinch density levels (also on iOS), videos autoplay when opened, and Info pauses and resumes a video.
- **P2-VIDEO** — Video on physical devices
  `verify · maintainer · normal · depends: BUILD-MOBILE`
  accept: playback with audio, seeking and rotation on Android and iOS; local posters on iOS.
- **WIN-UPDATE-WATCHER** — A failed Windows update gets the daemon back
  `verify · maintainer · normal · depends: BUILD-DESKTOP`
  accept: on a real Windows machine, with an update that fails after Arca closes (for example a locked installation file), the daemon is running again within about a minute without opening Arca, `update-watch.log` in the state directory says `restored` and `%TEMP%\arca-update-watch-*` is gone; a successful update logs `relaunched` and starts no second daemon.
- **P2-GALLERY** — Album uploads on physical devices
  `verify · maintainer · normal · depends: BUILD-MOBILE`
  accept: original cloud access and EXIF/RAW/HEIC/Live Photo fidelity (limited access and editor workflows included), and a Samsung run with a library over 10 GiB covering screen-off/background continuity, battery restrictions, interruption and resumed completion. Verify the historical archive and real-phone uploads before removing Immich or claiming a migration.
- **P2-GALLERY-DELETE-DEVICE** — Shared gallery deletion on devices
  `verify · maintainer · normal · depends: BUILD-MOBILE`
  accept: with disposable photos on Android and iOS: direct shared deletion, Live Photo groups, connection failure, partial selection failure and unchanged Photos originals; deletions persist across remounts; non-recursive directory deletion works (Android `Files.delete`, iOS `rmdir`).
- **P2-MOBILE** — Mobile replica acceptance
  `verify · maintainer · normal · depends: BUILD-MOBILE`
  accept: complete persistent copies, honest incomplete-work reporting, imports reaching the hub, resumable transfers without corruption, no data loss on suspension; low storage, interrupted downloads, revoked credentials and offline access; keyboard handling on phone, Fold and iOS; text scaling; launcher and splash in a standalone build; rename; APK opening on Samsung; Fold sticky scroll; settings visuals; iOS LAN pairing; name propagation; Fold throughput.
- **P2-SHARING** — Incoming sharing
  `verify · maintainer · low · depends: BUILD-MOBILE`
  accept: the iOS Share Extension works; cold-start, foreground and multiple-file shares work. Known gaps stay documented: text/plain streams, links and text are not imported, and duplicate temporary filenames must be shared separately.
- **P2-FOLD-SCALING** — Fold scaling
  `verify · maintainer · low · depends: BUILD-MOBILE`
  accept: the original Fold scaling issue no longer reproduces with the text-size setting, or a new bug is filed.

### Phase 1 qualification

Phase 1 acceptance: a real hub and replica demonstrate creation, initial full sync, independent destinations, offline edits, reconnection, conflict preservation, deletion, restoration, revocation and restart recovery; backup restore is checked independently; web authentication and unauthorized access are verified; users can identify the managed machine and recover from errors without guessing.

- **P1-LOAD** — Sustained load
  `verify · maintainer · normal`
  accept: a large hub folder while unrelated replicas upload and receive, measuring proposal/mutation queue latency, pause/unlink responsiveness and abandoned snapshot leases; large application-state folders per workload. The bounded Docker run (100,000 entries, three concurrent snapshots, a verified 1 MiB transfer) already passed.
- **P1-SCHEDULER** — Scheduler measurements
  `verify · maintainer · normal`
  accept: idle wakeups, CPU, disk reads, traffic, battery and recovery correctness measured before any timing default changes.
- **P1-UX** — Native binary acceptance
  `verify · maintainer · normal · depends: BUILD-DESKTOP`
  accept: tray transitions, light/dark menu bars, reduced motion, long paths, dialogs, offline startup and error recovery; real sleep/wake on macOS, Windows and Linux; OS notifications, activation and click routing on Windows and Linux; the native gallery Save dialog and Maps launch; the 320 px tray viewport, role chips in Tauri and WebKit/Windows motion.
- **P1-RECOVERY** — Recovery drill
  `verify · maintainer · normal`
  accept: a prolonged soak, a physical power loss and an independent real backup/restore drill (the pilot has no separate real backup yet).
- **P1-RELEASE** — Installer acceptance
  `verify · maintainer · normal`
  accept: release bundles install and run on each supported platform; a hosted confirmation of direct publication (draft assets, Docker Hub push) and of the macOS installer retry. Hosted `publish` passed for v0.6.7–v0.6.13 (v0.6.13 after a rerun) and v0.6.15.
- **P1-UPDATER** — Real desktop update
  `verify · maintainer · normal`
  accept: an update between two published versions on macOS (with and without Launch at login), Windows NSIS and Linux AppImage/deb, each ending with the daemon answering under the new version; hosted `.deb.sig` generation.
- **P1-SERVER-ONBOARDING** — Server onboarding acceptance
  `verify · maintainer · normal`
  accept: real-device replica pairing and selection from the new wizard, ARM, image upgrades. See [Server onboarding](SPEC.md#server-onboarding).
- **P1-CASA-CPU** — Casa CPU stall
  `verify · maintainer · normal`
  accept: a capture or reproducer of the 98–103% CPU stall with HTTP and discovery timeouts. Do not repeat live evaluator-based profiling.
- **WIN-RECYCLE** — Recycle Bin on real Windows
  `verify · maintainer · normal · depends: BUILD-DESKTOP`
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
  accept: `arca.satoshi-ltd.com` serves the Pages project and Git auto-deploys are off. Publication itself already works: `publish-site` deployed to Cloudflare Pages on September 29.
- **P1-PUBLIC-ACCESS** — Store listings
  `deploy · maintainer · low`
  accept: `APP_STORE_URL` and `PLAY_STORE_URL` name real listings so the site's mobile card shows store buttons instead of saying the apps are not in the stores yet. Anonymous GitHub and Docker Hub downloads already work.
- **P1-SIGNING** — Code signing
  `decision · maintainer · low`
  accept: a decision on Windows signing; optionally one signed macOS run with `sign_macos` checked and `publish` unchecked.

### Decisions

- **DEC-LAN-PERMISSION** — Cache LAN permission?
  `decision · maintainer · normal`
- **DEC-FIRST-PAGE** — Serve the first snapshot page without a hub scan?
  `decision · maintainer · normal`
- **DEC-BLOB-SIGNATURES** — Trust recorded blob signatures instead of re-hashing completed blobs?
  `decision · maintainer · normal`
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
- **DEC-CONVERTING-LEGACY** — Remove the legacy `converting` mode on phones?
  `decision · maintainer · normal`
  accept: a yes or no. `replica.js`, `App.jsx` and a test still recover a folder interrupted mid-way through the former upload-only-to-working-copy transition (`converting` mode, restoring missing indexed files before switching to `source`); AGENTS.md forbids legacy modes, yet a phone could still hold that state.
- **DEC-SITE-PALETTE** — Should the site share the app's tokens?
  `decision · maintainer · low`
  accept: `site/styles.css` keeps its own palette (paper `#f4f6ef` versus the app's `#F4F6F1`) or adopts the app tokens with a guard test.
- **LOCAL-CLEANUP** — Old pre-SPEC documents
  `decision · maintainer · low`
  accept: keep, archive or delete `.cache/docs-before-consolidation` (PLAN, PROTOCOL, STATUS and the legacy Syncthing spec from before SPEC existed). APKs and the Cargo cache now prune themselves.
- **P1-CASA-POLICIES** — Remove redundant Casa policy lines
  `deploy · maintainer · low · depends: every device on 0.6.2 or later`
  accept: the `.DS_Store`/`Thumbs.db`/`desktop.ini`/`.git`/cache lines are gone from Casa's `alpi-workspace`, `alpi-mirai-workspace` and `alpi-host` policies.

### Confirm and close

Older notes listed these as open while later evidence suggests they are resolved. SPEC no longer carries those notes; confirm each and Claude deletes it (an item that turns out still open becomes its own task):

- F44, resuming snapshots across turns — implemented in v0.6.6.
- The Umbrel helper's first real update and the `update-docker` end-to-end run — both recorded as done.
- Fold/emulator sync after the port 17831 migration — the Fold syncs with Casa since.
- Pending Windows/Ubuntu CI reruns from September — hosted runs have passed since.
- Cache-first navigation marked proposed — partly implemented since.
- Web approval delivery and Android incoming sharing via COROS — confirmed by the maintainer.
- The cause of an earlier Fold pause — likely the album-first ordering fixed in v0.6.6.
- The emulator storage decision — the emulator had 9.3 GB free on September 29.

## Proposed

Claude's suggested order for approval comes first. Each entry is ready to move to Queue as written.

- **DESK-FILES-PAGING** — Files, History and a file's history grow by appending
  `chore · agent · low`
  accept: the desktop folder browser keeps the rows it has and appends the next cursor page instead of replacing them, up to a bounded number of rows, and typed search and scroll survive; History and a file's history keep appending; JSDOM tests cover the three lists. The interface follows board UI-DESK-FILES-PAGING.
- **DESIGN-COVERAGE** — Draw the shipped views the design kit still lacks
  `chore · agent · low`
  accept: `design/mobile.html` draws Files and Recent of an ordinary folder, the file detail, History, Devices (connected and unpaired), Settings, the incoming share sheet, the viewer and the approval sheet as the app renders them; `design/desktop.html` draws the file detail, the gallery viewer with Info, the Daemon stopped page, web access, the approval dialog, Settings → Network and the danger zone; the design tests keep passing and no board is added.
- **DOC-README-SLIM** — Keep README to orientation and entry commands
  `chore · agent · low`
  accept: README keeps only its one-line status banner; dated or status sentences ("September 10 checkout", "implemented locally", "prepared locally, not deployed", the site's pending-verification note) and feature narration that SPEC already owns become short descriptions or pointers into SPEC.
- **DESK-CLEANUP-KEEPS** — The cleanup dialog's kept counts follow Settings' older-versions count
  `chore · agent · low`
  accept: in Clean up older versions the per-folder and total kept figures count older versions only, like Settings → History, so the two numbers never disagree; a JSDOM or daemon test with current and superseded revisions.
- **DEV-TEST-CONCURRENCY** — Cap test parallelism so a full run does not saturate the maintainer's machine
  `chore · agent · low`
  accept: `scripts/validate-local.js` and `.githooks/pre-push` run `node --test` with a bounded `--test-concurrency` (for example half the cores) and the suite still passes within CI's time budget; the maintainer's local deploy scripts are not touched.
- **MOB-HUB-LIVENESS** — Hub-busy liveness probe on mobile
  `feature · agent · low`
  accept: a busy hub is told apart from an unreachable one before the phone marks itself offline; client tests cover both, including a hub that needs more than the 10-second catalog deadline (it is now marked offline on every cycle); a deadline that grows on consecutive timeouts while no cycle has connected is one option.
- **MOB-ADAPTIVE-CHUNKS** — Adaptive mobile download blocks
  `feature · agent · low · depends: a Fold throughput measurement`
  accept: block size grows toward desktop's 8 MiB on fast links and shrinks on slow ones, measured on the Fold before and after.
- **MOB-401-IDENTITY** (F73) — Credential identity check on 401
  `feature · agent · low`
  accept: a 401 from a different hub identity is told apart from a revoked credential, while a hub destroyed and set up again at the same address still unpairs replicas.
- **P2-MEDIA-LIBRARY** — Migrate to the new media library API
  `chore · agent · low`
  accept: the gallery uses `expo-media-library`'s `Query`/`Asset`/`Album` model instead of `expo-media-library/legacy`, with tests; device evidence is a follow-up `verify`.

- **NAT-F01-F10-COPIES** — Android picker/share copies off the UI thread
  `bug · agent · normal`
  accept: picker and share copies (F01, F10 native half, F35) run off the UI and module threads with verified completion; device evidence follows.
- **NAT-F12-F32-ERRORS** — Native error codes and write watchdog
  `feature · agent · normal`
  accept: native requests return error codes, Android cancels before connect, and a write watchdog bounds stalled writes; device evidence follows.
- **NAT-F03-IOS-CANCEL** — iOS cancel/session race
  `bug · agent · normal`
  accept: cancelling during session setup never leaves a request running; device evidence follows.
- **NAT-IOS-HASH** — Native hashing on iOS
  `feature · agent · low`
- **NAT-ICLOUD-PICKER** — Per-item iCloud photo picker
  `feature · agent · low`
- **NAT-SHARE-FEEDBACK** — Share-extension failure feedback
  `feature · agent · low`
- **ORG-DESKTOP-SCRIPTS** — Move desktop tooling into `apps/desktop/scripts`
  `chore · agent · low`
  accept: `desktop-dev`, `stage-runtime`, `sign-local`, `build-release`, `collect-release`, `updater-manifest` and `verify-bundle` live under `apps/desktop/scripts`; the workflows, `apps/desktop/package.json`, tests and SPEC references follow; a CI run passes.
- **ORG-TAILSCALE-EXPORT** — Move the Casa Tailscale exporter to `deploy/`
  `chore · agent · low · depends: a maintainer check of Casa's cron path`
  accept: `scripts/export-tailscale.py` lives under `deploy/` with SPEC updated, and Casa's cron keeps working.
- **ORG-FORMAT** — Decide what `npm run format` covers
  `chore · agent · low`
  accept: the `format` script covers every hand-written source (mobile, design, site, deploy) or is removed; running it changes nothing unexpected.
- **UI-LUCIDE-TRIM** — Ship only the Lucide icons in use
  `chore · agent · low`
  accept: `apps/desktop/src/vendor/lucide.js` (356 KB) holds only the icons the desktop and mobile registries use, and the mobile geometry test still passes.
- **P2-PERFORMANCE** — Mobile and desktop performance measurements
  `verify · maintainer · low`
  accept: native first paint, cold load and large-directory listing latency measured; follow-up agent tasks only where the numbers justify them (native asynchronous inventory, narrower desktop DOM updates).
- **P2-WEB-TRUST** — Web trust and pairing features (product proposals)
  `decision · maintainer · low`
  accept: a decision on console-free initial trust, passkeys, background push for web approval, QR pairing, replica-to-replica pairing, remote hub-admin switching and one-click bidirectional pairing; each approved one becomes its own agent task.

- **DESK-UPDATER-TESTS** — Rust tests for the update install flow and Windows
  `chore · agent · low`
  accept: `install_update`, daemon stop and the restore marker (`with_recovery`, resume on next launch) are covered by Rust unit tests with the process and plugin boundaries stubbed, and `rust-tests` also runs on `windows-2022` so the PowerShell listing and non-Unix exit handling execute; both pass in CI.

- **DOCKER-RELEASE-REF** — Build the Docker image from the released commit
  `bug · agent · normal`
  accept: `publish-docker.yml` checks out `workflow_run.head_sha` on automatic runs, as `publish-site.yml` does, so rapid pushes can never publish a newer image or record its `docker-v` tag before that version's release exists; a workflow contract test covers it.

- **WEB-REPLICA-CONFLICT-LINKS** — Conflict download links on a replica's web view
  `bug · agent · low`
  accept: the conflict dialog's download links on a server replica's web view use a route the replica serves (today they point to the hub-only `/v1/blobs/<hash>`, which answers 409); DOM and API tests.
- **DESK-GALLERY-COUNT** — Gallery header counts only dated months
  `bug · agent · low`
  accept: the desktop gallery header counts every loaded photo and video, including those still waiting for a capture date (it read "0 photos" over three tiles); a DOM test.

- **DESK-SELECT-CATALOG** — A folder selected while paused is missing from History
  `bug · agent · low`
  accept: `select` adds the folder to the saved catalog so History includes it before the next cycle; a replica test with a paused replica.
- **DESK-PREVIEW-TIMEOUT** — Retained-revision preview times out as "Hub unavailable" on a slow healthy hub
  `bug · agent · low`
  accept: a 3-second timeout on a reachable hub reads "The hub took too long to prepare this preview" instead of claiming it is unreachable, and `size=large` gets a longer cap; a daemon test with a slow hub.

- **CI-WIN-INTERRUPT-FLAKY** — Windows timing of the interrupted-sync interface test
  `chore · agent · low`
  accept: `interrupting sync does not abort an independent interface request` (`tests/sync.test.js`) no longer depends on a 6-second limit that a loaded Windows runner exceeded once (v0.6.27 run, green on rerun); raise the limit or wait on the events the test already observes, and explain the choice in the commit.

- **DESK-NATIVE-TRAY-OFFLINE** — The native tray still says "needs attention" while the hub is unavailable
  `bug · agent · normal`
  accept: on macOS and Windows the tray icon, tooltip and status menu item read Offline (not the alert icon or "Arca · needs attention") while the hub is unavailable and the replica is not paused; today `tray_state` in `apps/desktop/src-tauri/src/main.rs` returns the alert state whenever `status.error` is set and any unknown phase, including "offline", falls to "needs attention"; a Rust test next to the existing `tray_state` test. Needs a desktop build.

- **MOB-PAIR-QR** — Pair a phone by scanning a code from the hub
  `feature · agent · low`
  accept: the hub's Pair a machine dialog also shows a QR code carrying the hub address and the single-use code, and the phone's pairing step can scan it with the camera and fill both fields; the code stays single use, ten minutes and under the same failure budgets, and a pure parser test covers a valid payload, a malformed one and an expired code. Needs a camera module, so a native build and a maintainer `verify`; the dialog and the scan screen need a board before approval.

## Later phases

- **P3-I18N** — Localization
  `feature · agent · planned for phase 3`
  accept: strings in catalogs for Tauri, Expo and the shared web frontend; language selection; localized dates, numbers and sizes; dialogs, errors, tray menus and notifications; user content is never translated. English-only through phases 1 and 2.
- **P3-AUTO-LINK** — Automatic machine linking under a same-Tailscale-owner policy
  `feature · maintainer · paused, not in target`
