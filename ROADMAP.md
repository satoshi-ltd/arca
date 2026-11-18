# Arca roadmap

Updated 2026-11-18 · Phase 1 release.

This is the task pool. [SPEC.md](SPEC.md) owns current state, contracts, operations and the design system; [CHANGELOG.md](CHANGELOG.md) records what each version shipped; [AGENTS.md](AGENTS.md) defines the autonomous workflow that consumes this file.

## How this file works

Every task is one entry that a single commit can finish, with fixed fields (decisions only need their question):

- **ID** — stable, never reused. Keep an existing ID when SPEC or the changelog cites it.
- **type** — `bug`, `feature`, `chore`, `ui` (a visual change whose proposal is a board on `design/proposals.html`), `verify` (evidence from a real device or environment), `deploy` (build, install or publish outside the repository) or `decision`.
- **owner** — `agent` (Claude can finish it in the repository and prove it with tests) or `maintainer` (needs a device, a native build, Atlas or Casa, credentials or a product choice).
- **priority** — `high`, `normal` or `low`. Within each section, order is priority, then position.
- **native** — the change includes Kotlin or Swift, so it runs only after a maintainer build; the loop ends it with its JavaScript and contract tests.
- **depends** — IDs that must finish first.
- **accept** — what proves it done. Agent tasks need evidence a test or command can show.

Lanes:

- **Queue** — approved agent tasks, in the order they will be done. Only the maintainer moves a task here, with two exceptions that enter at the top: a bug the maintainer reports, and a red pipeline on `main`.
- **In progress** — at most one agent task.
- **Needs maintainer** — decisions, and approved native work waiting for a build window.
- **Proposed** — ideas not yet approved, from the maintainer or from Claude, ordered by priority and then by effort (small, medium, large). Never worked on until approved; approving one is moving it to Queue.

A purely visual idea is not filed here as Proposed: its board in `design/proposals.html` is the proposal. Once the maintainer approves it, it enters Queue as a `ui` task with the board ID and `accept: the board`; when it ships, delete the task and the board. A task that mixes logic and a screen splits: the screen is board `UI-<TASKID>`, the logic stays under its ID and its accept says "the interface follows board UI-<TASKID>"; a board ID never equals a non-`ui` task ID. When a task ships, delete it and record it in the changelog and in the SPEC section it changes. Device evidence is never filed ahead of the code: a `verify` task is created only when its implementation has shipped and the maintainer has not yet checked it on a device.

## Queue

Approved 2026-11-18, in this order.

- **SEC-ROUTE-AUTH-MATRIX** — A replica or a player never reaches a route meant for the administrator
  `feature · agent · high` · medium
  The gate refuses a caller with no credential, but which role may call each route is decided at about 170 places (54 `requireAdmin` calls and the player allow-list), and one forgotten check gives every paired device hub administration. Accept: one test starts a hub and calls every route it serves as nobody, as a player and as a linked replica, against a committed table of the least role each route needs; a route missing from the table fails the test, and so does any answer other than 401 or 403 below that role. The routes that take a file path refuse `..`, an absolute path and a `.arca-` name for the same three callers.
- **NET-TAILSCALE-TIMEOUT** — The Tailscale listener gives a request as long as the main one
  `bug · agent · high` · small
  Confirmed in the code: the listener bound to the Tailscale address sets `requestTimeout` to 5 s (`network.js`) while the main server allows 65 s, so a 1 MiB block needs 1.7 Mbit/s of upload and an 8 MiB one 13 Mbit/s; a phone on mobile data or a relayed tailnet link is cut and retries. Accept: both listeners share one timeout, and a test sends a block slower than 5 s through the Tailscale listener.
- **SYNC-CASE-TOMBSTONE** — A changed name that differs only by letter case from a synced one never deletes it
  `bug · agent · high` · small
  A partial scan looks for the changed name by its exact spelling, while the index rows for it are read without regard to ASCII letter case; when the changed name is not on disk but a synced file with the other spelling is, those rows are recorded as deleted although the files are still there. Reproduced on a hub by the review of 0.9.8 (index and disk hold `Dir/a.txt`; marking `dir` changed tombstones `Dir/a.txt`); the replica's proposal loop has the same shape. Accept: a partial scan whose scope is absent under that spelling but present under another keeps the indexed rows, on hub and replica, with tests on both that fail today.
- **HUB-HOLD-PROPOSED-DELETES** — The hub holds a mass deletion a device sends it
  `bug · agent · high` · medium
  The 0.9.40 guard holds deletions a scan finds, not deletions a device proposes: a phone whose app storage was emptied, or a replica running an older version, still sends every deletion and the hub applies them for everyone. Holding them on the hub covers every device and every version, so the phone needs no rule of its own. Accept: the hub applies the same rolling-hour rule (at least 50 files and more than a quarter of the folder, renames excused one to one) to accepted deletion proposals per folder, answers held proposals so the device keeps its rows as pending, shows the folder's attention on the hub with the same Review, and the phone's folder row says the deletion is waiting for the hub; tests cover a replica that knows the answer and one that does not.
- **SYNC-BITROT** — Content that changed under an unchanged file signature is flagged, not synced as an edit
  `bug · agent · high` · medium
  The periodic re-hash of a trusted file commits a mismatch as the new head revision, so a flipped bit on one disk replaces the good copy on every device and the good one leaves history after retention. Accept: with bytes changed and the stat signature identical, no revision or proposal is created, the folder names the file, and it is repaired from the hub's object when available. Filesystems without a reliable ctime (FAT, exFAT) keep today's behaviour.

## In progress

_None._

## Needs maintainer

### Deploy and verify

- **DEPLOY-0954** — Put 0.9.52 to 0.9.54 on the live devices
  `deploy · maintainer · normal`
  Native build for the phone (0.9.52 fields and empty states, 0.9.53 header buttons and choice sheets); desktop build (0.9.52 Settings and status card, 0.9.54 first-run Folders step); hub redeploy so the catalog carries `rules` and Start syncing can say that `.arcaignore` excludes files (an older hub shows no note); server replica redeploy for the 0.9.54 web wizard.
- **VERIFY-WIZARD-FOLDERS** — The first-run Folders step starts empty and scrolls
  `verify · maintainer · normal · depends: DEPLOY-0954`
  accept: on the built desktop app and on a server's web wizard, pairing with a hub that has more folders than the window shows lists them with none chosen, scrolls to Start syncing, and Choose folders stays disabled until one is switched on.

### Decisions

Each carries a recommendation; a yes or no is enough.

- **DEC-RENAME-MODIFIED** — Should the phone rename a file whose edits have not reached the hub?
  `decision · maintainer · low`
  Desktop and server replicas already do; the phone refuses with "Local file changed. Sync before renaming.". Recommendation: allow it; the hub rejects a stale deletion, so nothing is lost.
- **DEC-CONVERTING-LEGACY** — Keep the `converting` gallery mode?
  `decision · maintainer · low`
  `gallery.js` writes it on purpose when Change album… repairs a damaged record. Recommendation: keep it, close this decision and fold SPEC's "Interrupted conversions" bullet into "Damaged records".

### Native work waiting for a build

Agent tasks that end with JavaScript and contract tests and run only after a maintainer build; schedule them together to share one.

- **NAT-IOS-HASH** — Native hashing on iOS
  `feature · agent · high · native`
  accept: a Swift `hashFile` using CryptoKit reads 1 MiB at a time off the main thread with the same storage check as Android's, and a JS test shows the native path is used instead of the JavaScript SHA-256 fallback in `files.js` (today every download verification, scan and preview check on iOS hashes in JavaScript and blocks the UI).
- **NAT-TRANSFER-STREAM** — Phone transfers stream over one connection
  `feature · agent · high · native`
  Today every block and every API call opens a new connection, and each 1 MiB block is fsynced. Accept: `ArcaNetwork` downloads and uploads an object as a resumable stream (or windows up to the hub's `maxChunkBytes`) over a kept-alive connection, writes blocks without an fsync each and fsyncs once before the hash check; `replica.js` uses it when the binary has it and keeps 1 MiB blocks otherwise; contract tests with a mocked native module cover resume offsets, cancellation, the yield between turns and a failed verification.
- **NAT-REPLACE-ASYNC** — `replaceFile` leaves the JavaScript thread
  `feature · agent · normal · native`
  Importing or sharing a GB-size file flushes it all on the JavaScript thread. Accept: `replaceFile` runs its fsyncs and rename as an async native function on Android and iOS, `files.js` awaits it, and the recovery contract (a failure before the rename leaves the destination untouched) keeps its tests.
- **NAT-IOS-BACKGROUND-DOWNLOAD** — iPhone downloads continue in the background
  `feature · agent · normal · native · depends: SEC-IOS-HARDENING`
  accept: an iOS background `URLSession` keeps fetching a pending download into its partial file while the app is suspended; the next cycle verifies the hash before materializing, pause, Stop syncing and Erase cancel it, and no file reaches the working copy without the journal; JS tests cover the hand-off contract.
- **MOB-SLEEP-FADE** — The phone's sleep timer fades out before pausing
  `feature · agent · low · native`
  accept: `MusicService` gains a volume command (or a timed fade) and the phone's sleep timer ramps the player volume to silence over about 5 s before pausing and restoring it, as desktop does; reduced motion keeps the fade because it is audio; JVM and contract tests cover it.

## Proposed

Ideas not yet approved, from the source audit of 2026-11-11 and later ones, reviewed against the code on 2026-11-18. The security model is sound as built: every `/v1` route passes one gate that refuses a missing or unknown credential, a player has an allow-list, every synced path passes `validPath`, the daemon listens on loopback unless told otherwise and the Docker image runs unprivileged. What stays here is what an intruder or a failing disk could really use; hardening against a hostile hub, against the owner's own files, or for a case that needs an unlikely coincidence is gone, because the hub and the owner's devices are the root of trust (SPEC §1, Single-owner trust). Unless an entry says reproduced or confirmed, its cause was traced in the code and not run, so its first step is the failing test its accept describes. Effort: small is one function and its tests, medium a few files or one subsystem, large a design change. No task in this lane is approved for implementation.

### Security

- **SEC-DEPS** — Advisories in the libraries that read your files are checked in CI
  `chore · agent · normal` · small
  The daemon has five runtime dependencies and all of them parse files that arrive by sync (`sharp`, `libheif-js`, `exifr`, `music-metadata`, `ffmpeg-static`). Accept: CI runs `npm audit --omit=dev --audit-level=high` on the root lockfile and fails on a finding; anything it reports today is fixed or listed with its reason in SPEC. Build tooling, the mobile graph and the Rust graph are audited once by hand and not gated.
- **SEC-RUNTIME-CHECKSUMS** — The desktop's FFmpeg is current and pinned by a committed checksum
  `chore · agent · normal` · medium
  The desktop bundles `ffmpeg-static` (FFmpeg 6.1.1, December 2023), fetched without a checksum, and runs it on every probe, thumbnail and stream; the Docker image uses the distribution's package and is not affected. Accept: a maintained static build chosen at implementation, with a committed checksum per platform that `stage-runtime.js` and `verify-bundle.js` check (a test swaps a byte and the stage fails). Node keeps its official checksum file.

### Security — native

- **SEC-ANDROID-EXPOSURE** — A phone-to-phone transfer does not clone the device
  `bug · agent · normal · native` · small
  Android 12+ copies app data in a device-to-device migration whatever `allowBackup` says, so the new phone starts with the old one's credential and device identity, and two phones then sync as one. Accept: a `<device-transfer>` exclusion in `dataExtractionRules`, pinned by the manifest test; the new phone pairs and syncs again from the hub.
- **SEC-IOS-HARDENING** — The iPhone's background sync can read its credential while the phone is locked
  `bug · agent · normal · native` · small
  The credential is stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so a background task that starts on a locked phone cannot load it and ends as failed. Accept: after-first-unlock, this device only, re-saved once, pinned by a test; in the same change `NSAllowsLocalNetworking` replaces `NSAllowsArbitraryLoads` (the native module already refuses plain HTTP outside verified addresses) and the config test pins it.

### Data safety — high

- **SYNC-STAGE-SPACE** — A replica does not need its content's size free a second time
  `bug · agent · high` · medium
  A replica stages every new file into `objects` before the first upload, and a relink (linking an existing folder, or after a hub went back) copies and hashes every file there too. When they do not fit, the scan fails with "Insufficient free disk space" and the cycle repeats forever with nothing uploaded. Accept: a replica whose free space is below its new content uploads file by file until done, and a relink of a folder identical to the hub's stages nothing (a test counts object copies).
- **PERF-MOB-REDISCOVERY** — The phone does not re-read the whole photo library every minute
  `feature · agent · high` · medium
  The foreground rediscovery pages the whole camera roll every 60 s and every 4 pages runs another full sync cycle: about 75 cycles per pass for 30,000 photos. Accept: the minute pass stops at the first fully known, unchanged page (full passes stay for the first scan, Sync now and the inventory schedule); a test with 3,000 known assets pages at most twice and runs no follow-up cycle, a new asset is still queued, and `force` pages everything. SPEC §5's "rediscovered every minute" changes with it.

### Reliability — normal

- **HUB-SCAN-LOCK** — Uploads and proposals do not wait behind a full hub scan
  `feature · agent · normal` · medium
  The hub's whole cycle, every folder, is one entry in the exclusive queue that upload blocks and `/v1/propose` also wait in, so during a restart scan or the six-hour reconciliation replicas shrink their blocks and then mark the hub unavailable. Accept: with a hub scan held open by a stubbed scanner, an upload block and a proposal for another folder complete.
- **SYNC-SCAN-RESUME** — An interrupted scan keeps the hashes it computed
  `feature · agent · normal` · small
  The scanner worker writes its hash cache only after the whole scan returns, so a pause, a restore or a restart (every redeploy) during the first scan of a large folder throws away hours of hashing. Accept: a scan interrupted after N files re-hashes none of them the next time.
- **SYNC-DIRTY-INVALID** — An invalid-name error clears when the file is renamed
  `bug · agent · normal` · small
  An incremental scan validates a dirty path before checking that it still exists, so after renaming `Why not?.docx` the folder keeps failing on the old name until the next full scan, up to six hours. Accept: a dirty path that is invalid and absent is dropped and the folder syncs on the next incremental cycle; one still present still stops the scan.
- **MOB-UPLOAD-BACKOFF** — A photo that cannot upload is not exported and hashed again every minute
  `bug · agent · normal` · small
  Every failure retries after a fixed minute, and the export runs before the exclusion check, so excluded or failing videos are copied and hashed three per cycle indefinitely. Accept: an excluded resource with a saved manifest is refused before `media.export`, repeated failures back off from one minute to one hour and reset on Retry or Sync now, with a test counting exports. SPEC's "back off for a minute" changes.
- **MOB-SHARE-WAIT** — Adding or saving a file on the phone never stops sync until a restart
  `bug · agent · normal` · small
  Add files… copies each pick with no stall deadline while holding `picking`, which stops every sync until the app restarts; Save awaits the running cycle with no deadline; `importFile` needs twice the file's size because it copies the inbox file instead of moving it. Accept: Add files… uses the share's stall deadline and always releases `picking`, Save gives the running cycle a bounded time and says what it is waiting for, and the inbox copy is moved into place, with a test for each.
- **MOB-CONVERTING-STUCK** — An album repair that cannot finish never blocks its folder for good
  `bug · agent · normal` · medium
  The phone's repair of a linked album restores every missing indexed file before anything else runs, and a row whose content the hub no longer has fails every cycle: scan, uploads and pulls never run and the only way out is Stop syncing. Accept: the repair restores missing rows against the hub's current head (a row the hub has since edited takes the new revision, one it deleted counts as applied), isolates each row, and always finishes without proposing a deletion, with a test where the indexed revision is gone from the hub.
- **UX-PAIR-ORPHAN** — A pairing the hub accepted is not lost when the next request fails
  `bug · agent · normal` · small
  Outside the first-run wizard, `/v1/connect` redeems the code, the hub registers the device, and when the catalog request then fails at the network level the replica drops the credential: the retry says the code was already used and the hub keeps an orphan device. Accept: the accepted credential is saved before the catalog request as the wizard already does, a retry continues without a new code, and a test fails the catalog once.
- **UX-ERRORS** — Three errors name their real cause
  `bug · agent · normal` · small
  Losing access mid-cycle reads "Cannot read properties of null" because the cycle reads `connection.id` after it was cleared (reproduced); a 401 passed through from `/v1/connect` in a server replica's web UI is taken for the browser session ending and shows sign-in; a replica deleting where it may not gets "Local administrator credential required" instead of the library kinds. Accept: revoking during a scan reports the lost access; only a 401 about the browser's own session shows sign-in; the hub's linked branch names the library kinds; one test each.
- **HUB-ASYNC-APPLY** — The daemon keeps answering while it writes a large file
  `feature · agent · normal` · large
  Accepting or pulling a file hashes it, copies it and fsyncs it synchronously on the main thread; hub reselection recovers every row with no yield. A 4 GB upload freezes the hub for about a minute on a hard disk: every device shows the hub unavailable and the Compose healthcheck fails. Measure it first on Atlas-like hardware with a real film; do it only if the freeze is confirmed. Accept: with a stubbed slow copy, `/v1/status` answers within a second while a row materializes and during hub reselection, and the journal and recovery tests keep passing. SPEC "Storage" changes with it.
- **MOB-EXPORT-DEADLINE** — A large video's export is limited by stalls, not by total time
  `bug · agent · normal · native` · small
  iOS and Android give the whole export one 90 s deadline, so an original that needs longer (an iCloud download, a long 4K clip) never uploads. Accept: the deadline restarts on each chunk in Swift and Kotlin; the JS contract test covers the error codes.

### Performance — measure first

A fix lands only for a cost the measurement shows.

- **PERF-DAEMON-STATEMENTS** — The daemon's hot paths run the statements they need and no more
  `feature · agent · normal` · medium
  Traced costs: each accepted proposal scans the folder's revision index for `MAX(rev)`, prunes with a 10,000-row `NOT IN` and makes five to seven fsync'd commits; the hourly retention pass loads every revision and hash; every replica cycle reads the whole index to collect an empty object store; a full pass writes two autocommit upserts per photo although nothing changed. Accept: a script counts statements and fsyncs per operation on a 30,000-file fixture and the three largest costs it finds are fixed, each with a test that counts statements through a wrapper; the rest stay unfixed.
- **PERF-MOB-CACHES** — The phone does not rebuild or re-read what has not changed
  `feature · agent · normal` · medium
  Traced costs: an open folder is walked, sorted and written as one JSON value on every refresh (20,000 photos is about 40,000 native calls); every cycle rebuilds each music library although the hub answered `unchanged`. Accept: measured on a 20,000-photo folder and a large music library, then an unchanged walk keeps the previous array and the library is memoized, with tests.

### Interface and documents

- **MOB-UI-FIXES** — Five small phone defects
  `bug · agent · normal` · medium
  Android Back closes the Audio or Subtitles panel before the film; the Off position of a switch uses `line` (about 1.5:1) where desktop and SPEC §9 use `control` (3:1); the video player rotates on the nearly square Fold; the Photo uploads sheet shows no sign that a selected album is gone and Save is disabled without a reason; the player and photo viewer bars ignore the cutout and the gesture bar. Accept: `onRequestClose` closes an open panel first; `switchTrack` uses the control token with a 3:1 test in both palettes; a pure rotation rule skips the rotation under an aspect ratio of about 1.2 or on a wide layout; the album row reads "Unavailable" and the button carries its reason; a `layout.js` helper gives both bars their four margins, tested for portrait, landscape and the rotated player; the kit is regenerated.
- **UX-DESK-A11Y** — The photo viewer shows its errors
  `bug · agent · normal` · small
  An action's error in the full-height viewer is written below the window and its result notice lands under the modal layer, so a failed Delete looks like nothing happened. Accept: opening the viewer with the hub away and pressing Delete shows the explanation inside the viewer's box and a result notice above it; DOM test.
- **DOC-KIT-DRIFT** — SPEC and the kit say what the code does
  `chore · agent · normal` · medium
  Stale SPEC sentences found by the audit: the tray's Now playing row (§4 against §9), the phone's Devices hub actions menu, gallery tile announcements, the Movies & TV search group, the Stream and Keep labels, the Playlists tab in Android Auto, the 2,000-entry folder listing, the one-time photo picks, and §4 Gallery's Deletion bullet, which names `/v1/delete-file` where the desktop uses `/v1/gallery/delete`. SPEC also gains the limits of iOS exposing the Documents tree to Files (an edit there syncs like any edit; deleting a synced folder's directory stops that folder). In the kit: `.kit-tray` re-declares production rules with drifted literals, the Fold's music pane draws the ⋯ only for a show, and the unfolded Fold draws a centred search and preview panes the app shows only from 1100 dp, redrawn to what ships. Accept: each sentence and drawing matches the shipped behaviour; `npm run design -- --check` and the design tests pass; no code changes.
- **UX-COPY-SWEEP** — Dialogs, confirmations and labels follow the copy rules
  `bug · agent · low` · medium
  Desktop: "Create a shared folder on hub <name>" and "Path on <name>" use the hub's configured name, "Stop syncing on this hub?" does not name the folder, Connect stacks three hints under one field, Restore says "rev" and "sha", a video in a gallery is called a photo, and a folder's "Last change" shows the last saved version after a deletion (rename it "Last saved version"). Phone: "Photos deleted" for one photo or a video, "Originals stay in Photos" in a folder with no linked album, "File renamed" and "Diagnostics copied" toasts against Quiet successes, Up next counts "tracks" for episodes. Deleting with history Off says it cannot be undone. The wording is part of the approval. Accept: each string follows SPEC's rules and is pinned by a string test; SPEC settles the hub-name rule, which §5 Offline contradicts; the kit pages match.

### Low priority

- **ROLLBACK-CLIENTS** — The phone and the full backup notice a hub that went back in time
  `feature · agent · low` · medium
  After a hub is restored from an older copy, the phone skips hub rows older than its own and stays diverged (its newer files never upload and its edits are refused as stale); the backup worker's cursor gets 409 and later leaves a silent gap. Accept: both read the catalog's `history` epoch and head and, on a changed epoch or a cursor ahead of the head, relink as the desktop does, keeping newer local content as conflict copies or uploads, with a test against a restored hub each.
- **NAV-BACK-LEVELS** — Back goes up one folder level, on the web and on Android
  `feature · agent · low` · medium
  Idea. Files navigation keeps the subfolder out of the route, so Back in the web admin leaves the folder from three levels deep; Android Back from three levels deep, or with a hundred photos selected, drops to Folders. Accept: each level is a route entry (DOM test for Back and reload) and a pure `backStep(state)` reducer on the phone clears a photo selection first, with a test and no new control.
- **DEC-PICKER-GALLERY** — Remove the unreachable picker-only gallery path
  `chore · agent · low` · small
  Gallery mode `local` is accepted by `parseGallery`, nulled by `galleryConfig` and written by nothing, which the no-unused-code rule forbids. Accept: both tokens and SPEC's "same receipt pipeline" sentence are gone and the gallery tests pass.
- **BRAND-ONE-LINE** — Arca is described with one tagline and one descriptor everywhere
  `chore · agent · low` · small
  Idea. Four descriptions coexist: “Your files. Your devices.” (site hero and social image), “Your files, at home.” (design kit), “Free self-hosted cloud for files, photos, music & movies” (site title) and “A personal drive for your own devices” (README, AGENTS). Accept: the tagline “Your files. Your devices.” and the descriptor “personal drive” are the only two, in the site title and description, the social image, the kit's introduction, README's first line and the app manifests' descriptions. The exact words are part of the approval.

## Later phases

- **PHOTO-PLACES** — Search Arca finds photos by place ("hua hin", "thailand", "tailandia")
  `feature · agent · low`
  accept: the hub reads GPS during gallery indexing and stores only a place label and a folded search text (city, district, province, country), never coordinates; names come from a bundled offline GeoNames extract (CC BY, attributed; no cloud geocoding, no new npm dependency), including Spanish and English alternate names for countries and first-level regions; existing photos re-index once; Search Arca gains a Places group (one row per place with its count, opening the gallery filtered to it) on desktop, web and phone, offline on the phone from the synchronized labels; photos without GPS are explained in the empty result; tests cover lookup (Hua Hin, open sea, antimeridian, invalid coordinates), indexing with and without GPS, and the three queries on hub and phone. Feasibility: GPS read 0.17 ms per photo, a dataset of about 2.5 MB plus alternate names, grid lookup about 13 µs.
- **MUSIC-CAR-SEARCH** — Search and voice requests in the car
  `feature · agent · low · native`
  accept: `MusicService` answers library search and "play … on Arca" voice requests by title, artist and album over the published library, and plays the best match; JVM tests cover the matching. Today search commands are not offered.
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
