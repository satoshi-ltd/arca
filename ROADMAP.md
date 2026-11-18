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

Data safety first, then the most visible defects and the largest performance costs; normal-priority work follows in the same order.

_Empty: the maintainer approves the next batch from Proposed. Suggested first batch: SEC-ROUTE-AUTH-MATRIX, SEC-ADMIN-LOOPBACK, SEC-ERASE-KNOWN-FILES, SYNC-CASE-TOMBSTONE, SYNC-BITROT, SYNC-STAGE-SPACE, then MOB-MASS-DELETE with HUB-HOLD-PROPOSED-DELETES._

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

- **DEC-VIDEO-INTEGRITY** — Require full-file integrity for Movies & TV?
  `decision · maintainer · normal`
  The video fingerprint hashes only the size and the first and last 4 MiB, so a same-size edit confined to the middle never syncs and corruption there is undetected. Recommendation: no. A film edited in place is rare and a full hash costs hub I/O and phone battery; SPEC states the limit. If yes: a bounded background full hash and a protocol field clients verify.
- **DEC-HISTORY-DEFAULT** — Should new folders default to Off for all folders or only galleries?
  `decision · maintainer · normal`
  Folders without a stored choice default to 30 days, galleries included. Off removes the only backstop for a false deletion, so decide it after MOB-MASS-DELETE and HUB-HOLD-PROPOSED-DELETES. Recommendation: keep 30 days.
- **DEC-IOS-FILE-SHARING** — iOS exposes the whole Documents tree to Files and Finder
  `decision · maintainer · normal`
  An edit made in Files enters sync like a user edit, the app-owned state JSON is visible, and deleting a synced folder's directory stops that folder until it is started again. Recommendation: keep it (Files access is part of a personal drive) and document the limits in SPEC.
- **DEC-MOB-FOLD-WIDE** — Does the unfolded Fold get the wide search and file preview?
  `decision · maintainer · normal`
  The kit draws centred search, preview panes and a Files Preview column on the Fold, but the app shows them only from 1100 dp. Recommendation: redraw the kit to show what ships.
- **DEC-CONVERTING-LEGACY** — Keep the `converting` gallery mode?
  `decision · maintainer · low`
  `gallery.js` writes it on purpose when Change album… repairs a damaged record. Recommendation: keep it, close this decision and fold SPEC's "Interrupted conversions" bullet into "Damaged records".
- **DEC-PICKER-GALLERY** — Remove the unreachable picker-only gallery path?
  `decision · maintainer · low`
  Gallery mode `local` is accepted by `parseGallery`, nulled by `galleryConfig` and written by nothing. Recommendation: remove both tokens and SPEC's "same receipt pipeline" sentence.
- **DEC-RENAME-MODIFIED** — Should the phone rename a file whose edits have not reached the hub?
  `decision · maintainer · low`
  Desktop and server replicas already do; the phone refuses with "Local file changed. Sync before renaming.". Recommendation: allow it; the hub rejects a stale deletion, so nothing is lost.
- **DEC-LAST-CHANGE-SCOPE** — Is a folder's Last change the newest event or the newest saved version?
  `decision · maintainer · low`
  After deleting a file the cell still shows the previous saved file. Recommendation: rename the label to "Last saved version".

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

Ideas not yet approved, from the source audit of 2026-11-11 and later ones, tidied on 2026-11-18: related items are merged, and what was a micro-optimisation, a legacy state or a cosmetic corner is gone. Sections run from what keeps intruders out, to data safety, to everything else; within a section, order is priority, then effort (small is one function and its tests, medium a few files or one subsystem, large a design change or native work). Unless an entry says reproduced, its cause was traced in the code and not run, so its first step is the failing test its accept describes. Performance entries start by measuring: a fix lands only for a cost the measurement shows. No task in this lane is approved for implementation.

### Security — high

- **SEC-ROUTE-AUTH-MATRIX** — Every route refuses a caller it should refuse, proven by one test
  `feature · agent · high`
  Access is checked route by route across about 170 routes and nothing proves that a new or old one cannot be reached without its credential. Accept: a test starts a hub, a desktop replica and a server replica, finds every route the daemon serves, and with no credential, an expired or foreign-host session, a player ticket and a linked-device token asserts that each answers 401, 403, 404 or 405 except an allow-list of public routes (pairing, connect, discovery, web login, health), and that a route missing from both the list and the table fails the test; every route that takes a path, folder or file ID refuses `..`, an absolute path and a symlink that leaves its folder.
- **SEC-ADMIN-LOOPBACK** — The local administrator credential never authenticates from another machine
  `bug · agent · high`
  The admin token is accepted from any socket, yet its only users (the CLI and the desktop app) are on loopback and it rotates only on Erase, so a copied `config.json` is permanent remote administration. Accept: an admin bearer from a non-loopback socket answers 401, browser sessions are unchanged, tests cover both, and SPEC notes that a proxy on the same host still looks like loopback.
- **SEC-ERASE-KNOWN-FILES** — Erase deletes only what Arca knows, and leaves nothing behind in the index
  `bug · agent · high`
  Decided (recorded under the maintainer's delegation of security choices; veto by moving it back to Decisions): `addVolume` accepts any existing directory, such as a mount point or `~/Documents`, and Erase removes it wholesale, including files Arca never synced. Accept: Erase removes the files the index knows plus the marker, as `deleteSyncedCopy` does, never an unknown file or a directory that lost its marker, and names those it skipped in the same result as the folders the OS refused; and after Erase every table is empty whatever the order (`file_generations` is emptied before `local_files` writes it again), with a test on a replica holding `local_files` rows that fails today.
- **SEC-DEPS** — Dependency advisories are checked in CI
  `chore · agent · high`
  accept: audit the locked root, mobile and Rust dependency graphs in CI; fix compatible advisories or document each remaining one's affected component, reachability, owner and review date. Verify changes against Expo compatibility and the mobile build-tooling tests; do not blindly apply `npm audit fix` or accept an automatic major downgrade. Distinguish build tooling from installed runtime.
- **SEC-RUNTIME-CHECKSUMS** — The bundled Node and FFmpeg are pinned by committed checksums
  `chore · agent · high`
  Decided: the desktop bundles `ffmpeg-static` (FFmpeg 6.1.1, December 2023) fetched without a checksum and runs it unsandboxed on every probe, thumbnail and stream of files that arrive by sync, and `stage-runtime.js` takes Node's hash from the same origin as the binary. Accept: a maintained static FFmpeg build chosen at implementation and a committed checksum table per platform for it and for Node, checked by `stage-runtime.js` and `verify-bundle.js` (a test swaps a byte and the stage fails), and a CI check that fails when the bundled FFmpeg is older than a recorded minimum.
- **SEC-ANDROID-EXPOSURE** — Another app on the phone cannot browse the library, read covers or copy app data
  `bug · agent · high · native`
  `MusicService` is exported and accepts every controller; `CoverProvider` serves covers to other apps; Android 12+ copies app data in a phone-to-phone migration whatever `allowBackup` says. Decided: exclude app data from device-to-device transfer with a `<device-transfer>` exclusion in `dataExtractionRules` (the phone syncs again from the hub). Accept: `onConnect` accepts only its own UID, trusted system controllers and an allowlist (Android Auto, Assistant, Wear); `CoverProvider` is limited to authorized consumers by URI grants while Media3 notifications and Android Auto keep working; the exclusion is pinned by the manifest test; JVM and contract tests cover access and grants.
- **SEC-IOS-HARDENING** — The iPhone credential survives a locked background sync, and plaintext loads are never allowed
  `bug · agent · high · native`
  Decided: the credential is stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so a background task that starts on a locked phone cannot load it and ends as failed; use after-first-unlock, this device only, re-saved once. Separately `NSAllowsArbitraryLoads` is on although the native module already refuses HTTP outside verified private or tailnet addresses. Accept: the keychain option and the migration are pinned by a test, `NSAllowsLocalNetworking` replaces `NSAllowsArbitraryLoads` and the config test pins it.

### Security — normal

- **SEC-APPROVAL-FOCUS** — The web sign-in approval opens on Deny, never on Allow
  `bug · agent · normal`
  `modal()` gives Cancel the initial focus only when a confirmation option exists, so the approval prompt opens focused on "Raw details". Accept: every confirmation dialog, the approval prompt included, opens with Cancel (Deny) focused, with a DOM test.
- **SEC-OPEN-LAUNCHERS-2** — More file kinds that run code are revealed, never opened
  `bug · agent · normal`
  Synced files carry no quarantine or Mark-of-the-Web, so the OS never warns. Not yet in the list: `com pif cpl msc vbe jse wsf wsh url chm reg msp application appref-ms fileloc inetloc webloc mpkg jar py pyw settingcontent-ms appx msix appinstaller diagcab xll iso img vhd vhdx scf library-ms psm1 psd1 ps1xml jnlp mobileconfig`; an extensionless Unix file with an executable bit opens in Terminal on macOS. Accept: the desktop and Rust lists gain these kinds, a Unix file with `mode & 0o111` and no extension is revealed, with tests; SPEC lists them and says the phone opens a synced `.apk` in the installer on purpose.
- **SEC-FORM-ACTION** — Injected markup cannot submit a form, and hub-supplied IDs and revisions never reach HTML raw
  `bug · agent · normal`
  Neither content security policy sets `form-action`; a folder ID from the hub's catalog becomes an element `id` unvalidated on refresh, and `rev` values are rendered raw in History. Reaching them needs a malicious hub. Accept: `form-action 'self'` on the web and `'none'` in Tauri, the catalog refresh validates IDs as `hubCatalog` does, `rev` renders through a number, with DOM tests for a hostile ID and a string `rev`.

### Security — low

- **SEC-SIGNING-STEP** — The updater key never enters the build graph
  `chore · agent · low`
  accept: establish a supported Tauri build and separate signing sequence, then build without the updater key and sign the final artifacts in a separate step that only runs the signer with the key; the manifest step verifies the signatures. Do not assume `createUpdaterArtifacts` succeeds without a key.

### Data safety and availability — high

- **SYNC-CASE-TOMBSTONE** — A changed name that differs only by letter case from a synced one never deletes it
  `bug · agent · high`
  A partial scan looks for the changed name by its exact spelling, while the index rows for it are read without regard to ASCII letter case; when the changed name is not on disk but a synced file with the other spelling is, those rows are recorded as deleted although the files are still there. Reproduced on a hub by the review of 0.9.8 (index and disk hold `Dir/a.txt`; marking `dir` changed tombstones `Dir/a.txt`); the replica's proposal loop has the same shape. Accept: a partial scan whose scope is absent under that spelling but present under another keeps the indexed rows, on hub and replica, with tests on both that fail today.
- **SYNC-BITROT** — Content that changed under an unchanged file signature is flagged, not synced as an edit
  `bug · agent · high`
  The periodic re-hash of a trusted file commits a mismatch as the new head revision, so a flipped bit on one disk replaces the good copy on every device. Accept: with bytes changed and the stat signature identical, no revision or proposal is created, the folder names the file, and it is repaired from the hub's object when available. Filesystems without a reliable ctime (FAT, exFAT) keep today's behaviour.
- **SYNC-STAGE-SPACE** — A replica with less free space than its new content still uploads
  `bug · agent · high`
  A replica stages every new file into `objects` before the first upload; when they do not fit, the scan fails with "Insufficient free disk space" and the cycle repeats forever with nothing uploaded. Accept: a replica whose free space is below its new content uploads file by file until done.
- **UX-PAIR-ORPHAN** — A pairing the hub accepted is not lost when the next request fails
  `bug · agent · high`
  Outside the first-run wizard, `/v1/connect` redeems the code, the hub registers the device, and when the catalog request then fails at the network level the replica drops the credential: the retry says the code was already used and the hub keeps an orphan device. Accept: the accepted credential is saved before the catalog request as the wizard already does, a retry continues without a new code, and a test fails the catalog once.
- **MOB-MASS-DELETE** — The phone holds a sudden mass disappearance as the hub and computers do
  `bug · agent · high`
  Since 0.9.40 the hub and desktop or server replicas hold a scan's mass deletion until someone confirms it, but the phone still queues a deletion for every indexed file missing from its app storage, guarded only by a missing root. Accept: the same rule (at least 50 files and more than a quarter of the folder within a rolling hour, renames excused one to one, empty files never a move) holds the phone's deletions, persisted across launches; the folder row shows the attention and a confirmation sheet offers Check again and Delete from every device with the desktop's words; source-contract and fake-engine tests.
- **HUB-HOLD-PROPOSED-DELETES** — The hub holds a mass deletion a device sends it
  `bug · agent · high`
  The 0.9.40 guard holds deletions a scan finds, not deletions a device proposes: a phone or a replica that empties its own copy (or runs an older version) still sends every deletion and the hub applies them for everyone. Accept: the hub applies the same rolling-hour rule to accepted deletion proposals per folder, answers held proposals so the device keeps its row as pending, shows the folder's attention on the hub and offers the same Review, with tests on old and new replica versions.
- **MOB-CONVERTING-STUCK** — An album repair that cannot finish never blocks its folder for good
  `bug · agent · high`
  The phone's repair of a linked album restores every missing indexed file before anything else runs, and a row whose content the hub no longer has fails every cycle: scan, uploads and pulls never run and the only way out is Stop syncing. Accept: the repair restores missing rows against the hub's current head (a row the hub has since edited takes the new revision, one it deleted counts as applied), isolates each row, and always finishes without proposing a deletion, with a test where the indexed revision is gone from the hub.
- **PERF-MOB-REDISCOVERY** — The phone does not re-read the whole photo library every minute
  `feature · agent · high`
  The foreground rediscovery pages the whole camera roll every 60 s and every 4 pages runs another full sync cycle: about 75 cycles per pass for 30,000 photos. Accept: the minute pass stops at the first fully known, unchanged page (full passes stay for the first scan, Sync now and the inventory schedule); a test with 3,000 known assets pages at most twice and runs no follow-up cycle, a new asset is still queued, and `force` pages everything. SPEC §5's "rediscovered every minute" changes with it.
- **HUB-ASYNC-APPLY** — The daemon keeps answering while it writes a large file
  `feature · agent · high`
  Accepting or pulling a file hashes it, copies it and fsyncs it synchronously on the main thread; hub reselection recovers every row with no yield. A 4 GB upload freezes the hub for about a minute on a hard disk: every device shows the hub unavailable and the Compose healthcheck fails. Accept: with a stubbed slow copy, `/v1/status` answers within a second while a row materializes and during hub reselection, spies see no synchronous hash or copy on the main thread, and the journal and recovery tests keep passing. SPEC "Storage" changes with it.
- **HUB-SCAN-LOCK** — Uploads and proposals do not wait behind a full hub scan
  `feature · agent · high`
  The hub's whole cycle, every folder, is one entry in the exclusive queue that upload blocks and `/v1/propose` also wait in, so during a restart scan or the six-hour reconciliation replicas shrink their blocks and then mark the hub unavailable. Accept: with a hub scan held open by a stubbed scanner, an upload block and a proposal for another folder complete.

### Data safety and availability — normal

- **SYNC-DIRTY-INVALID** — An invalid-name error clears when the file is renamed
  `bug · agent · normal`
  An incremental scan validates a dirty path before checking that it still exists, so after renaming `Why not?.docx` the folder keeps failing on the old name until the next full scan, up to six hours. Accept: a dirty path that is invalid and absent is dropped and the folder syncs on the next incremental cycle; one still present still stops the scan.
- **NET-TAILSCALE-TIMEOUT** — The Tailscale listener gives a request as long as the main one
  `bug · agent · normal`
  The listener bound to the Tailscale address sets `requestTimeout` to 5 s while serving the whole API (the main server allows 65 s), so an 8 MiB upload block over a slow or relayed tailnet link may be cut. Accept: both listeners share one timeout, and a test sends a block slower than 5 s through the Tailscale listener.
- **UX-ERRORS** — Errors name their real cause and sit at their field
  `bug · agent · normal`
  Four small defects: losing access mid-cycle reads "Cannot read properties of null" because the cycle reads `connection.id` after it was cleared (reproduced); a 401 passed through from `/v1/connect` in a server replica's web UI is taken for the browser session ending and shows sign-in; a replica deleting where it may not gets "Local administrator credential required" instead of the library kinds; "Enter all six digits." and "Enter the full hub address…" appear as the "Could not complete action" card instead of inline, and the code cells stay filled after a rejected code. Accept: revoking during a scan reports the lost access; only a 401 about the browser's own session shows sign-in; the hub's linked branch names the library kinds (404) and a stale rev answers 409 through `hubError`; an invalid field sets `aria-invalid` with an error message tied by `aria-describedby`, and a rejected code clears its cells; one test each.
- **SYNC-SCAN-RESUME** — An interrupted scan keeps the hashes it computed
  `feature · agent · normal`
  The scanner worker writes its hash cache only after the whole scan returns, so a pause, a restore or a restart during the first scan of a large folder throws away hours of hashing. Accept: a scan interrupted after N files re-hashes none of them the next time.
- **MOB-UPLOAD-BACKOFF** — A photo that cannot upload is not exported and hashed again every minute
  `bug · agent · normal`
  Every failure retries after a fixed minute, and the export runs before the exclusion check, so excluded or failing videos are copied and hashed three per cycle indefinitely. Accept: an excluded resource with a saved manifest is refused before `media.export`, repeated failures back off from one minute to one hour and reset on Retry or Sync now, with a test counting exports. SPEC's "back off for a minute" changes.
- **MOB-SHARE-WAIT** — Saving a shared file neither waits without bound nor needs twice its size free
  `bug · agent · normal`
  Save awaits the running cycle with no deadline; `importFile` requires twice the file's size because it copies the inbox file instead of moving it; Add files… copies each pick with no stall deadline while holding `picking`, which stops every sync until the app restarts. Accept: Save gives the running cycle a bounded time and says what it is waiting for, the inbox copy is moved into place, and Add files… uses the share's stall deadline, with tests for each.
- **SYNC-ROLLBACK-ANCHOR** — A hub restored whole and changed again is still told apart on the next incremental sync
  `feature · agent · normal`
  When `history.json` is restored together with the index and the hub then records enough new revisions to pass a replica's cursor, an incremental cycle sees only higher revisions, so a path the hub changed again replaces the replica's newer file as an ordinary update. Accept: `/v1/changes` carries a digest of the revision at the replica's cursor, a mismatch is treated as the hub having gone back, and a test restores a hub whole, changes the same path past the cursor and sees the replica's version kept as a conflict copy.
- **ROLLBACK-CLIENTS** — The phone and the full backup notice a hub that went back in time
  `feature · agent · normal · depends: SYNC-ROLLBACK-ANCHOR`
  The phone skips hub rows older than its own and then stays diverged (its newer files never upload and its edits are refused as stale); the backup worker's cursor gets 409 and later leaves a silent gap. Accept: both read the catalog's `history` epoch and head and, on a changed epoch or a cursor ahead of the head, relink as the desktop does, keeping newer local content as conflict copies or uploads, with a test against a restored hub each.
- **MOB-EXPORT-DEADLINE** — A large video's export is limited by stalls, not by total time
  `bug · agent · normal · native`
  iOS and Android give the whole export one 90 s deadline, so an iCloud original that needs longer never uploads. Accept: the deadline restarts on each chunk in Swift and Kotlin; the JS contract test covers the error codes.
- **CI-FLAKY-LIVE-DAEMON** — The Rust test that finds a live daemon does not fail by chance
  `chore · agent · normal`
  `a_live_daemon_for_this_state_directory_is_found` failed once on the 0.9.52 pipeline and passed on rerun. Accept: the cause (a port or a timing race) is found and the test made deterministic, proven by running it in a loop.

### Performance — measure first

- **PERF-DAEMON-STATEMENTS** — The daemon's hot paths run the statements they need and no more
  `feature · agent · normal`
  Traced costs: each accepted proposal scans the folder's revision index for `MAX(rev)`, prunes with a 10,000-row `NOT IN` and makes five to seven fsync'd commits; the hourly retention pass loads every revision and hash; every replica cycle reads the whole index to collect an empty object store; a full pass writes two autocommit upserts per photo although nothing changed; a thumbnail served from disk costs an fsync'd write; `visibleRules()` does a SELECT and an `lstat` per row; search folds every path per query; `/v1/browse` re-aggregates its subtree per page. Accept: a script counts statements and fsyncs per operation on a 30,000-file fixture and the three largest costs it finds are fixed, each with a test that counts statements through a wrapper; the rest stay unfixed unless the numbers justify them.
- **PERF-MOB-CACHES** — The phone does not rebuild or re-read what has not changed
  `feature · agent · normal`
  Traced costs: an open folder is walked, sorted and written as one JSON value on every refresh (20,000 photos is about 40,000 native calls); every cycle rebuilds each music library although the hub answered `unchanged`; inventory scans make one SQLite read per file; phone search parses every accented row. Accept: the same measure-first rule as PERF-DAEMON-STATEMENTS on a 20,000-photo folder and a large music library, the largest costs fixed with tests (unchanged walk keeps the previous array, a memoized library, one query per folder).
- **PERF-APPROVAL-POLL** — A device that cannot approve web sign-ins does not ask for them every three seconds
  `feature · agent · normal`
  Desktop and phone poll `/v1/web-approvals` every 3 s while visible, authorised or not. Since 0.9.44 `/v1/events` returns an `approvals` generation only to a device that may approve, which is the signal to drive the request. Accept: after one unauthorised answer no further request is sent, and an authorised client polls only after an events signal or at a slower bounded cadence; tests count requests on desktop and phone.

### Interface and documents — normal

- **MOB-UI-FIXES** — Five small phone defects
  `bug · agent · normal`
  Android Back closes the Audio or Subtitles panel before the film; the Off position of a switch uses `line` (about 1.5:1) where desktop and SPEC §9 use `control` (3:1); the video player rotates on the nearly square Fold; the Photo uploads sheet shows no sign that a selected album is gone and Save is disabled without a reason; the player and photo viewer bars ignore the cutout and the gesture bar. Accept: `onRequestClose` closes an open panel first; `switchTrack` uses the control token with a 3:1 test in both palettes; a pure rotation rule skips the rotation under an aspect ratio of about 1.2 or on a wide layout; the album row reads "Unavailable" and the button carries its reason; a `layout.js` helper gives both bars their four margins, tested for portrait, landscape and the rotated player; the kit is regenerated.
- **UX-DESK-A11Y** — The photo viewer shows its errors, and focus survives clearing a selection
  `bug · agent · normal`
  An action's error in the full-height viewer is written below the window and its result notice lands under the modal layer; Clear selection hides its own toolbar, a confirmed delete returns focus to a hidden opener and Pause rebuilds the button it disabled, so focus falls to the page. Accept: opening the viewer with the hub away and pressing Delete shows the explanation inside the viewer's box and a result notice above it; after Clear selection and after a confirmed delete focus is a photo tile or the header's back button, and after Pause it is Resume; DOM tests.
- **UX-COPY-SWEEP** — Dialogs, confirmations and labels follow the copy rules
  `bug · agent · normal`
  Desktop: "Create a shared folder on hub <name>" and "Path on <name>" use the hub's configured name, "Stop syncing on this hub?" does not name the folder, Connect stacks three hints under one field, Restore says "rev" and "sha", a video in a gallery is called a photo. Phone: "Photos deleted" for one photo or a video, "Originals stay in Photos" in a folder with no linked album, "File renamed" and "Diagnostics copied" toasts against Quiet successes, Up next counts "tracks" for episodes, tab labels can ellipsize at large text. Deleting with history Off says it cannot be undone (the wording is part of the approval). Accept: each string follows SPEC's rules and is pinned by a string test; SPEC settles the hub-name rule, which §5 Offline contradicts; the kit pages match; a tab-label cap constant is tested like `railLabelFontCap`.
- **DOC-KIT-DRIFT** — SPEC and the kit say what the code does
  `chore · agent · normal`
  Stale SPEC sentences found by the audit: the tray's Now playing row (§4 against §9), the phone's Devices hub actions menu, gallery tile announcements, the Movies & TV search group, the Stream and Keep labels, the Playlists tab in Android Auto, the 2,000-entry folder listing, the one-time photo picks, and §4 Gallery's Deletion bullet, which names `/v1/delete-file` where the desktop uses `/v1/gallery/delete`. In the kit: `.kit-tray` re-declares production rules with drifted literals, and the Fold's music pane draws the ⋯ only for a show although its caption names the album's and artist's. Accept: each sentence and drawing matches the shipped behaviour; `npm run design -- --check` and the design tests pass; no code changes.

### Low priority

- **SYNC-RELINK-NO-COPY** — Relinking a folder does not copy unchanged files into the state directory
  `feature · agent · low`
  A relink scan has no index to trust, so `capture` copies and hashes every file into `objects`: linking an existing folder, and the automatic relink after a hub went back, needs free space of about the folder's size on the state volume. Accept: a relink trusts a `scan_cache` record whose signature matches and stages only what must upload, with a test counting object copies for a folder identical to the hub's.
- **NAV-BACK-LEVELS** — Back goes up one folder level, on the web and on Android
  `feature · agent · low`
  Idea. Files navigation keeps the subfolder out of the route, so Back in the web admin leaves the folder from three levels deep; Android Back from three levels deep, or with a hundred photos selected, drops to Folders. Accept: each level is a route entry (DOM test for Back and reload) and a pure `backStep(state)` reducer on the phone clears a photo selection first, with a test and no new control.
- **DESK-DIALOG-SCROLL** — Long dialogs and the first-run wizard keep their actions in view
  `bug · agent · low`
  Today the whole dialog scrolls and no dialog pins its action row; the wizard's Start syncing sits below a long folder list. Accept: dialogs whose content outgrows the window (Choose folders, Add to playlist, the Erase path list, Pair a device, the conflict dialog) and the wizard scroll their body while the title and the action row stay visible at the 620 px minimum height; a DOM test fills one past the window height.
- **MOB-VIDEO-ASSISTIVE** — The film player waits for people who use a switch, a keyboard or a screen reader's focus
  `feature · agent · low · native`
  Controls stay while TalkBack or VoiceOver is on, but Switch Access, Voice Access, Switch Control and external keyboards are not detected; the Up next card advances after ten seconds without being announced; opening the Audio or Subtitles panel does not move accessibility focus. Accept: the controls also stay while any of those is in use, Up next is announced and holds its countdown for a screen reader, and a panel takes focus when it opens; tests cover the rules.
- **MOB-IOS-ERRORS** — iPhone file errors say what failed
  `bug · agent · low · native`
  The Swift `replaceFile` and partial-file checks throw `NetworkUnavailable` for a failed rename, so the phone shows "Connect to the hub's local Wi-Fi…" as a file's issue; Kotlin names each cause. Accept: Swift throws the same named errors and the JS contract maps them.
- **SEC-INDEX-SNAPSHOT** — The hub keeps a nightly copy of its index
  `feature · agent · low`
  accept: daily maintenance writes `VACUUM INTO index.backup.sqlite` beside the index from the scanner worker (keeping one, mode 0600), Erase removes it, and the CLI documents how to restore it with the daemon stopped; `history.json` stays in place, so the restored index starts a new history epoch and replicas reconcile instead of reverting; after such a start the hub finishes one full scan before it serves heads; with tests.
- **DESK-UPDATER-TESTS** — The Rust updater tests also run on Windows
  `chore · agent · low`
  accept: the `rust-tests` job also runs on `windows-2022` with Windows versions of the two Unix-only tests, so the PowerShell listing and non-Unix exit handling execute; both pass in CI. Stubbing `install_update` is out of scope.
- **BRAND-ONE-LINE** — Arca is described with one tagline and one descriptor everywhere
  `chore · agent · low`
  Idea. Four descriptions coexist: “Your files. Your devices.” (site hero and social image), “Your files, at home.” (design kit), “Free self-hosted cloud for files, photos, music & movies” (site title) and “A personal drive for your own devices” (README, AGENTS). Accept: the tagline “Your files. Your devices.” and the descriptor “personal drive” are the only two, used in the site title and description, the social image, the kit's introduction, README's first line and the app manifests' descriptions; a test reads those sources and fails on another descriptor. The exact words are part of the approval.

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
