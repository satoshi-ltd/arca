# Arca roadmap

Updated 2026-10-03 · Phase 1 functional, not release-qualified.

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

_None._

## In progress

_None._

## Needs maintainer

### Builds and deployments

- **BUILD-DESKTOP** — Desktop build from the current source
  `deploy · maintainer · high`
  accept: the running desktop app and daemon report v0.6.15 or later (unlink deletes by default, local-only previews, photo/video header counts, relink with the hub as the source of truth, 30 s keep-alive).
- **BUILD-IOS** — First iOS device build on SDK 57
  `deploy · maintainer · normal`
  accept: an iOS build installed on a physical device (only a simulator `xcodebuild` has passed, at v0.6.1).
- **P2-GALLERY-VIEW** — Ship the desktop/web gallery in installers and on Casa
  `deploy · maintainer · normal · depends: BUILD-DESKTOP`
  accept: shipped installers and Casa carry the production dependencies (Sharp, exifr) and the gallery opens on both.

### Device checks

- **OFFLINE-DEVICE** — Offline replicas on real machines
  `verify · maintainer · high · depends: BUILD-DESKTOP`
  accept: with Casa unreachable (Tailscale off or the hub stopped), the Fold and the Mac open every view, browse folders, open and share local files and show hub-only actions as unavailable; reconnecting resumes sync without restarting either app.
- **VERIFY-REVEAL-FILE** — Show in folder on real Windows and Linux
  `verify · maintainer · normal · depends: BUILD-DESKTOP`
  accept: on a Windows and a Linux desktop build, a file detail's Show in folder and the photo viewer's open the file's own folder (Explorer with the file selected on Windows, a file manager on the file's folder on Linux), including a file in a nested folder, a path with spaces and, on Windows, a path longer than 260 characters (the verbatim prefix is stripped for Explorer).
- **VERIFY-SHARE-CACHE** — Incoming shares on the Fold
  `verify · maintainer · high`
  accept: sharing one and several files, a large file and a file named like a path from another app into Arca on the Fold lists them in the Save sheet with their real names, saves them, and leaves nothing under the app's cache except generated names (`arca-incoming/<id>-<n>`) while the sheet is open and nothing after Save or Cancel.
- **FOLD-STORAGE** — Storage after the object-store fix
  `verify · maintainer · high`
  accept: after the first sync, Android's storage figure for Arca drops to about the synchronized folders' size (from about 55 GB to about 26 GB for `photos`).
- **FOLD-THUMBNAILS** — Gallery thumbnails, posters and viewer
  `verify · maintainer · high`
  accept: grid thumbnails and video posters fill in within seconds while folders sync; HEIC photos open quickly; the viewer shows the thumbnail at once; offline, every downloaded photo appears and the rest stay placeholders. Reported on the v0.6.44 build: grey tiles with every photo downloaded and a gallery crash (`Cannot read property 'uri' of undefined`, fixed in v0.6.46); if tiles stay grey on v0.6.46, connect the Fold by adb and capture the gallery's native errors so the cause can be found.
- **FOLD-GALLERY-UX** — Gallery gestures and playback
  `verify · maintainer · normal`
  accept: infinite scroll both ways, the fast-scroll thumb follows the finger with sparse year chips, pinch density levels (also on iOS), videos autoplay when opened, and Info pauses and resumes a video.
- **VERIFY-A11Y-CONTROLS** — Contrast, focus and screen-reader actions after the UX review
  `verify · maintainer · normal · depends: BUILD-DESKTOP`
  accept: on the desktop build and a phone build, button and field borders read clearly in light and dark, a toggle shows its green focus outline with the keyboard, the dark destructive button is legible, a TalkBack and a VoiceOver gallery tile announces kind, filename and date and offers Select, and the phone Stop syncing confirmation names the folder.
- **P2-VIDEO** — Video on physical devices
  `verify · maintainer · normal`
  accept: playback with audio, seeking and rotation on Android and iOS; local posters on iOS.
- **WIN-UPDATE-WATCHER** — A failed Windows update gets the daemon back
  `verify · maintainer · normal · depends: BUILD-DESKTOP`
  accept: on a real Windows machine, with an update that fails after Arca closes (for example a locked installation file), the daemon is running again within about a minute without opening Arca, `update-watch.log` in the state directory says `restored` and `%TEMP%\arca-update-watch-*` is gone; a successful update logs `relaunched` and starts no second daemon.
- **P2-GALLERY** — Album uploads on physical devices
  `verify · maintainer · normal`
  accept: original cloud access and EXIF/RAW/HEIC/Live Photo fidelity (limited access and editor workflows included), and a Samsung run with a library over 10 GiB covering screen-off/background continuity, battery restrictions, interruption and resumed completion. Verify the historical archive and real-phone uploads before removing Immich or claiming a migration.
- **P2-GALLERY-DELETE-DEVICE** — Shared gallery deletion on devices
  `verify · maintainer · normal`
  accept: with disposable photos on Android and iOS: direct shared deletion, Live Photo groups, connection failure, partial selection failure and unchanged Photos originals; deletions persist across remounts; non-recursive directory deletion works (Android `Files.delete`, iOS `rmdir`).
- **P2-MOBILE** — Mobile replica acceptance
  `verify · maintainer · normal`
  accept: complete persistent copies, honest incomplete-work reporting, imports reaching the hub, resumable transfers without corruption, no data loss on suspension; low storage, interrupted downloads, revoked credentials and offline access; keyboard handling on phone, Fold and iOS; text scaling; launcher and splash in a standalone build; rename; APK opening on Samsung; Fold sticky scroll; settings visuals; iOS LAN pairing; name propagation; Fold throughput.
- **P2-SHARING** — Incoming sharing
  `verify · maintainer · low`
  accept: the iOS Share Extension works; cold-start, foreground and multiple-file shares work. Known gaps stay documented: text/plain streams, links and text are not imported, and duplicate temporary filenames must be shared separately.
- **P2-FOLD-SCALING** — Fold scaling
  `verify · maintainer · low`
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
- **DEC-LAST-CHANGE-SCOPE** — Should Last change count deletions and conflict copies, or be named "Last saved version"?
  `decision · maintainer · low`
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

- **DESK-INFO-PANEL-MOTION** — The photo Info panel animates only opacity and transform
  `bug · agent · low`
  accept: the Info panel in the photo viewer opens and closes with opacity and transform only, as SPEC's motion rule says, instead of transitioning `width` and `right`; the viewer image does not jump; reduced motion makes it instant; a stylesheet contract test checks the rule.
- **MOTION-GALLERY-SETTLE** — Thumbnails fade in and the selection scale eases
  `chore · agent · low`
  accept: gallery thumbnails fade in over `--motion-fast` on desktop and phone (no fade under reduced motion, and the Android `Image` default fade no longer ignores the tokens) and the 94% selection scale transitions over the same duration; `tests/motion.test.js` covers both.
- **SITE-HERO-TRUE-UI** — The site hero draws the real app
  `chore · agent · low`
  accept: the hero window shows only elements that exist in `design/desktop.html` (no invented subtitle, a Lucide icon instead of the text check glyph, a gallery row and one row syncing with nine dots), and a site test lists them.
- **MOB-VIEWER-CHROME-TAP** — A tap hides the photo viewer's chrome
  `chore · agent · low`
  accept: a single tap on the photo viewer fades its top bar over `--motion-enter`, Back still works, the video surface uses the safe-area insets instead of fixed margins and reduced motion makes the change instant; this adds a gesture, so it needs the maintainer's validation before it enters Queue.

- **DEV-FLAKY-MOBILE** — Find the mobile test that failed twice under load
  `chore · agent · low`
  accept: `tests/mobile-*.test.js` run repeatedly at full concurrency on a loaded machine; the test that failed once in `validate-local` for v0.6.79 and once for v0.6.80 (green when rerun alone) is named and its timing made deterministic, or the finding is recorded here as not reproducible.
- **DESK-FILES-PAGING** — Files, History and a file's history grow by appending
  `chore · agent · low`
  accept: the desktop folder browser keeps the rows it has and appends the next cursor page instead of replacing them, up to a bounded number of rows, and typed search and scroll survive; History and a file's history keep appending; JSDOM tests cover the three lists. The interface follows board UI-DESK-FILES-PAGING.
- **DESIGN-COVERAGE** — Draw the shipped views the design kit still lacks
  `chore · agent · low`
  accept: `design/mobile.html` draws Files and Recent of an ordinary folder, the file detail, History, Devices (connected and unpaired), Settings, the incoming share sheet, the viewer and the approval sheet as the app renders them; `design/desktop.html` draws the file detail, the gallery viewer with Info, the Daemon stopped page, web access (with its sign-in help), the approval dialog, Settings → Network and Allow HTTP connections, the Erase this hub dialog, the file-list error and the danger zone; the design tests keep passing and no board is added.
- **DOC-README-SLIM** — Keep README to orientation and entry commands
  `chore · agent · low`
  accept: README keeps only its one-line status banner; dated or status sentences ("September 10 checkout", "implemented locally", "prepared locally, not deployed", the site's pending-verification note) and feature narration that SPEC already owns become short descriptions or pointers into SPEC.
- **DOCKER-LATEST-ORDER** — An older release's Docker run can move `latest` back
  `bug · agent · low`
  accept: `publish-docker.yml` publishes `latest` only when the run's commit is the current `main` tip (a re-run or a late run of an older version still pushes its version tag but never `latest`); a workflow contract test covers the condition.
- **MOB-GALLERY-ALBUM-RELEASE** — Changing the selected albums releases pending uploads instead of refusing
  `feature · agent · low`
  accept: changing the albums or the videos setting while uploads are pending no longer fails with "Finish pending uploads…"; the pending and failed library photos (not manual picks, not picked files) are released to unavailable and the next scan re-adds those that belong to the new selection; uploaded files are never touched; a replica test covers adding and removing an album with pending uploads.
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

- **WEB-REPLICA-CONFLICT-LINKS** — Conflict download links on a replica's web view
  `bug · agent · low`
  accept: the conflict dialog's download links on a server replica's web view use a route the replica serves (today they point to the hub-only `/v1/blobs/<hash>`, which answers 409); DOM and API tests.
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
