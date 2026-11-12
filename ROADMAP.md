# Arca roadmap

Updated 2026-11-12 · Phase 1 release.

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


## In progress

_None._

## Needs maintainer

### Decisions

Each carries a recommendation; a yes or no is enough.

- **DEC-VIDEO-INTEGRITY** — Require full-file integrity for Movies & TV?
  `decision · maintainer · high`
  The video fingerprint hashes only the size and the first and last 4 MiB, and it drives two-way sync of kept libraries. A same-size edit confined to the middle never syncs; corruption there is undetected on download, upload and the periodic re-verify; Stop syncing with Delete files and incoming replacements treat such a copy as the accepted version and remove it with no conflict copy. If yes: a bounded background full hash and a protocol field clients verify, with regression cases that change only the middle and measurements of hub I/O and phone verification cost, kept separate from the fast scan fingerprint.
- **DEC-FFMPEG-SOURCE** — Where does the desktop's FFmpeg come from?
  `decision · maintainer · high`
  The desktop bundles `ffmpeg-static` 5.3.0, which is FFmpeg 6.1.1 (December 2023) downloaded without a checksum, and runs it unsandboxed on every probe, thumbnail, subtitle extraction and stream of files that arrive by sync. Docker uses Debian's patched package as a non-root user. Options: a maintained static build pinned by checksum, building FFmpeg in the release pipeline, or the system FFmpeg where one exists. Recommendation: a pinned maintained build, then SEC-RUNTIME-CHECKSUMS enforces it.
- **DEC-ERASE-SCOPE** — What may Erase delete outside the state directory?
  `decision · maintainer · normal`
  `addVolume` accepts any existing directory (a mount point such as `/Volumes/Disk`, or `~/Documents`) and writes the marker; Erase later removes it wholesale, including files Arca never synced; a server web session can also place a share, a moved folder or a backup at any absolute server path. Choose between refusing a non-empty directory without this volume's marker at registration, restricting Erase to files Arca knows (as `deleteSyncedCopy` does), or keeping today's contract with a mount-point refusal (`stat.dev` differs from the parent's). Erase already names the folders the OS refused to delete; folders skipped because they lost their marker are still unreported and should be named in the same result.
- **DEC-HISTORY-DEFAULT** — Should new folders default to Off for all folders or only galleries?
  `decision · maintainer · normal`
  Today folders without a stored choice default to 30 days, galleries included; Movies & TV has no history. Off removes the only backstop for a false deletion or overwrite, so decide it after the high-priority deletion proposals (MOB-MASS-DELETE, HUB-HOLD-PROPOSED-DELETES), or prefer a short non-zero default. If changed: every existing folder first gets its effective retention written explicitly, new folders, the catalog and settings apply the new default, tests cover implicit and explicit policies, and SPEC is updated.
- **DEC-IOS-FILE-SHARING** — iOS exposes the whole Documents tree to Files and Finder
  `decision · maintainer · normal`
  `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` let any edit made in Files enter sync like a user edit, show app-owned state JSON, and let a person delete a synced folder's directory, which stops that folder with “Local folder is unavailable” until it is started again. Keep and document, or disable.
- **DEC-IOS-KEYCHAIN** — May iPhone background sync read the hub credential while the phone is locked?
  `decision · maintainer · normal`
  The credential is stored `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so a background task that starts on a locked phone cannot load it and ends as failed. Recommendation: after-first-unlock, this device only, re-saved once, with a test pinning the option; NAT-IOS-BACKGROUND-DOWNLOAD needs it.
- **DEC-ANDROID-TRANSFER** — Exclude app data from Android device-to-device migration?
  `decision · maintainer · normal`
  Android 12+ copies app data in a phone-to-phone migration whatever `allowBackup` says (`IGNORE_ALLOW_BACKUP_IN_D2D`); only a `<device-transfer>` exclusion in `dataExtractionRules` stops it. Excluding it protects private local content but may leave unsynced work behind on the old device.
- **DEC-MOB-FOLD-WIDE** — Does the unfolded Fold get the wide search and file preview?
  `decision · maintainer · normal`
  The kit draws the Fold with the centred search dialog, preview panes and a Files Preview column, but the app shows them only from 1100 dp, so the Fold gets the phone search and no preview. Either let the Fold use them or redraw the kit to show what ships.
- **DEC-CONVERTING-LEGACY** — Keep the `converting` gallery mode?
  `decision · maintainer · low`
  It is no longer only a legacy transition: `gallery.js` writes `converting` on purpose when Change album… repairs a damaged record, so missing indexed files are restored before any scan. Recommendation: keep it, close this decision, and fold SPEC's "Interrupted conversions" bullet into "Damaged records"; MOB-CONVERTING-STUCK makes the mode always finish.
- **DEC-PICKER-GALLERY** — Remove the unreachable picker-only gallery path?
  `decision · maintainer · low`
  Gallery mode `local` is accepted by `parseGallery` and nulled by `galleryConfig`, and nothing writes it; Add photos in an ordinary folder goes through `importFile`. Recommendation: remove both tokens and SPEC's "same receipt pipeline" sentence; a phone still holding a `local` record reads as damaged and stops that folder until Change album…, with no deletion.
- **DEC-RENAME-MODIFIED** — Should the phone rename a file whose edits have not reached the hub?
  `decision · maintainer · low`
  Desktop and server replicas already do; only the phone refuses with "Local file changed. Sync before renaming.". Recommendation: allow it. The rename travels as a deletion at the old base plus a create with the edited content, and the hub rejects a stale deletion, so nothing is lost. If no, SPEC states the asymmetry.
- **DEC-LAST-CHANGE-SCOPE** — Is a folder's Last change the newest event or the newest saved version?
  `decision · maintainer · low`
  The cell shows the first activity row that is not a deletion, a conflict copy or a directory, so after deleting a file it still shows the previous saved file and its author. Recommendation: count deletions (a new activity filter on the hub, gated for older hubs, and a "Deleted <name>" rendering on desktop and phone) and keep conflict copies out; the cheap alternative is renaming the label to "Last saved version".

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
  `feature · agent · normal · native · depends: DEC-IOS-KEYCHAIN`
  accept: an iOS background `URLSession` keeps fetching a pending download into its partial file while the app is suspended; the next cycle verifies the hash before materializing, pause, Stop syncing and Erase cancel it, and no file reaches the working copy without the journal; JS tests cover the hand-off contract.
- **MOB-SLEEP-FADE** — The phone's sleep timer fades out before pausing
  `feature · agent · low · native`
  accept: `MusicService` gains a volume command (or a timed fade) and the phone's sleep timer ramps the player volume to silence over about 5 s before pausing and restoring it, as desktop does; reduced motion keeps the fade because it is audio; JVM and contract tests cover it.

## Proposed

Ideas not yet approved, from the source audit of 2026-11-11 and earlier ones. They are ordered by priority (data safety and stalls first) and, within a priority, by effort: small is one function and its tests, medium a few files or one subsystem, large a design change or native work. Unless an entry says reproduced, its cause was traced in the code and not run, so its first step is the failing test its accept describes. No task in this lane is approved for implementation.

### High priority — medium effort

- **MOB-MASS-DELETE** — The phone holds a sudden mass disappearance as the hub and computers do
  `bug · agent · high`
  Since 0.9.40 the hub and desktop or server replicas hold a scan's mass deletion until someone confirms it, but the phone still queues a deletion for every indexed file missing from its app storage (`replica.js` around the inventory), guarded only by a missing root. Accept: the same rule (at least 50 files and more than a quarter of the folder within a rolling hour, renames excused one to one, empty files never a move) holds the phone's deletions, persisted across launches; the folder row shows the attention and a confirmation sheet offers Check again and Delete from every device with the desktop's words; source-contract and fake-engine tests.
- **HUB-HOLD-PROPOSED-DELETES** — The hub holds a mass deletion a device sends it
  `bug · agent · high`
  The 0.9.40 guard holds deletions a scan finds, not deletions a device proposes: a phone or a replica that empties its own copy (or runs an older version) still sends every deletion and the hub applies them for everyone. Accept: the hub applies the same rolling-hour rule to accepted deletion proposals per folder, answers held proposals so the device keeps its row as pending, shows the folder's attention on the hub and offers the same Review, with tests on old and new replica versions.
- **MOB-CONVERTING-STUCK** — An album repair that cannot finish never blocks its folder for good
  `bug · agent · high`
  The phone's repair of a linked album restores every missing indexed file before anything else runs, and each restore is not isolated, so a row whose content the hub no longer has (an older revision collected after the hub edited or deleted the file) fails every cycle: scan, uploads and pulls never run, the folder shows a raw error forever and Enable uploads stays disabled. Since 0.9.24 Change album… no longer ends the repair (it used to, by proposing deletions), so the only way out is Stop syncing. Traced by the review of 0.9.24, not run. Accept: the repair restores missing rows against the hub's current head (a row the hub has since edited takes the new revision, one it deleted counts as applied), isolates each row, and always finishes without proposing a deletion, with a test where the indexed revision is gone from the hub.
- **SYNC-CASE-TOMBSTONE** — A changed name that differs only by letter case from a synced one never deletes it
  `bug · agent · high`
  A partial scan looks for the changed name by its exact spelling, while the index rows for it are read without regard to ASCII letter case; when the changed name is not on disk but a synced file or folder with the other spelling is, those rows are recorded as deleted although the files are still there. Reproduced on a hub by the review of 0.9.8 (index and disk hold `Dir/a.txt`; marking `dir` changed tombstones `Dir/a.txt`); the replica's proposal loop has the same shape. On a case-sensitive disk, creating and removing `notes.txt` beside a synced `Notes.txt` triggers it. Accept: a partial scan whose scope is absent under that spelling but present under another keeps the indexed rows, on hub and replica, with tests on both that fail today.
- **SYNC-STAGE-SPACE** — A replica with less free space than its new content still uploads
  `bug · agent · high`
  A replica stages every new file into `objects` before the first upload; when they do not fit, the scan fails with "Insufficient free disk space", the staged objects are released and the cycle repeats forever with nothing uploaded. Accept: a replica whose free space is below its new content uploads file by file until done.
- **SYNC-BITROT** — Content that changed under an unchanged file signature is flagged, not synced as an edit
  `bug · agent · high`
  The periodic re-hash of a trusted file commits a mismatch as the new head revision, so a flipped bit on one disk replaces the good copy on every device. Accept: with bytes changed and the stat signature identical, no revision or proposal is created, the folder names the file, and it is repaired from the hub's object when available. Filesystems without a reliable ctime (FAT, exFAT), where a same-timestamp edit is legitimate, keep today's behaviour unless the maintainer says otherwise at approval.
- **UX-PAIR-ORPHAN** — A pairing the hub accepted is not lost when the next request fails
  `bug · agent · high`
  Outside the first-run wizard, `/v1/connect` redeems the code, the hub registers the device, and when the catalog request then fails at the network level the replica drops the credential: the retry says the code was already used and the hub keeps an orphan device. Accept: the accepted credential is saved before the catalog request as the wizard already does, a retry continues without a new code, and a test fails the catalog once.
- **PERF-MOB-REDISCOVERY** — The phone does not re-read the whole photo library every minute
  `feature · agent · high`
  The foreground rediscovery pages the whole camera roll every 60 s, 100 assets per page with one store read each, and every 4 pages runs another full sync cycle: about 75 cycles per pass for 30,000 photos. Accept: the minute pass stops at the first fully known, unchanged page (full passes stay for the first scan, Sync now and the inventory schedule); a test with 3,000 known assets pages at most twice and runs no follow-up cycle, a new asset is still queued, and `force` pages everything. SPEC §5's "rediscovered every minute" changes with it.

### High priority — large effort

- **HUB-ASYNC-APPLY** — The daemon keeps answering while it writes a large file
  `feature · agent · high`
  Accepting or pulling a file hashes it, copies it and fsyncs it synchronously on the main thread (`commit`, `apply`, `settle`); hub reselection recovers every row with no yield. A 4 GB upload freezes the hub for about a minute on a hard disk: every device shows the hub unavailable, streams stall and the Compose healthcheck fails. Accept: with a stubbed slow copy, `/v1/status` answers within a second while a row materializes and during hub reselection, spies see no synchronous hash or copy on the main thread, and the journal and recovery tests keep passing. SPEC "Storage" documents the synchronous I/O as a limit and changes with it.
- **HUB-SCAN-LOCK** — Uploads and proposals do not wait behind a full hub scan
  `feature · agent · high`
  The hub's whole cycle, every folder, is one entry in the exclusive queue that upload blocks and `/v1/propose` also wait in, so during a restart scan or the six-hour reconciliation replicas shrink their blocks and then mark the hub unavailable. Accept: with a hub scan held open by a stubbed scanner, an upload block and a proposal for another folder complete; scan results still pass the existing per-row checks.

### Normal priority — small effort

- **SYNC-DIRTY-INVALID** — An invalid-name error clears when the file is renamed
  `bug · agent · normal`
  An incremental scan validates a dirty path before checking that it still exists, so after renaming `Why not?.docx` the folder keeps failing on the old name until the next full scan, up to six hours. Accept: a dirty path that is invalid and absent is dropped and the folder syncs on the next incremental cycle; one still present still stops the scan.
- **NET-TAILSCALE-TIMEOUT** — The Tailscale listener gives a request as long as the main one
  `bug · agent · normal`
  The listener bound to the Tailscale address sets `requestTimeout` to 5 s while serving the whole API (the main server allows 65 s), so an 8 MiB upload block over a slow or relayed tailnet link may be cut. Accept: both listeners share one timeout, and a test sends a block slower than 5 s through the Tailscale listener.
- **MOB-REVOKED-ERROR** — Losing access mid-cycle reports the revocation
  `bug · agent · normal`
  The cycle reads `connection.id` after the client cleared the connection, so the error reads "Cannot read properties of null" (reproduced). Accept: revoking during a scan reports the lost access.
- **UX-WEB-401-LOGOUT** — A hub's refusal of a pairing code does not sign the web administrator out
  `bug · agent · normal`
  In the web UI of a server replica, a 401 passed through from `/v1/connect` (a wrong or used code, a refused credential) is taken for the browser session ending and shows the sign-in page. Traced, not run. Accept: only a 401 about the browser's own session shows sign-in; the hub's refusal appears in the Connect dialog, with a DOM test.
- **VIDEO-DELETE-REPLICA-ERROR** — A replica deleting where it may not gets the reason, and the delete's error paths are tested
  `bug · agent · normal`
  The hub's `/v1/delete-file` answers a linked replica outside a video or audio library with "Local administrator credential required", which a stale catalog on a replica that streams the library can surface. Accept: the hub's linked branch fails with a message that names the library kinds (404), tested through a replica's `/v1/video/delete`; further tests cover a stale rev from a replica (409 "File changed. Reload before deleting." through `hubError`), the hub away (503), and a player or browser session against a replica's `/v1/video/delete`.
- **SEC-BACKUP-ACK-COLUMN** — A stored backup acknowledgement is always a revision number
  `bug · agent · normal`
  `/v1/backup-ack` refuses non-integers since 0.9.12, but a row written before that keeps its value: the upsert takes `MAX(revision, excluded.revision)` and SQLite ranks text above every integer, so honest reports never replace it; the page prints 0, yet the retention floor compares against it (text: nothing is ever removable; an inflated number: no version counts as protected) until the device is removed. Reproduced by the review of 0.9.12 on the schema; it needs a linked device that used the old hole. Accept: the upsert treats a stored value that is not an integer within the hub's revisions as 0, the retention floor ignores such rows, and a test stores text and an oversized number and sees the next honest report replace them.
- **SEC-ERASE-GENERATION-ROW** — Erase leaves no folder ID behind in the index
  `bug · agent · normal`
  `finishInstallationReset` empties the tables in catalogue order, and `file_generations` goes before `local_files`, whose delete trigger writes a `file_generations` row again; a replica that held local changes keeps one row with the erased share ID in the emptied index. Seen by the review of 0.9.10 (scratch run), not covered by a test. Accept: after Erase every table is empty whatever the order, with a test on a replica that holds `local_files` rows and fails today.
- **SEC-ADMIN-LOOPBACK** — The local administrator credential never authenticates from another machine
  `bug · agent · normal`
  The admin token is accepted from any socket, yet its only users (the CLI and the desktop app) are on loopback and it rotates only on Erase, so a copied `config.json` is permanent remote administration. Accept: an admin bearer from a non-loopback socket answers 401, browser sessions are unchanged, tests cover both, and SPEC notes that a proxy on the same host still looks like loopback.
- **SEC-OPEN-LAUNCHERS-2** — More file kinds that run code are revealed, never opened
  `bug · agent · normal`
  Synced files carry no quarantine or Mark-of-the-Web, so the OS never warns. Not yet in the list: `com pif cpl msc vbe jse wsf wsh url chm reg msp application appref-ms fileloc inetloc webloc mpkg jar py pyw settingcontent-ms appx msix appinstaller diagcab xll iso img vhd vhdx scf library-ms psm1 psd1 ps1xml jnlp mobileconfig`; an extensionless Unix file with an executable bit opens in Terminal on macOS. Accept: the desktop and Rust lists gain these kinds, a Unix file with `mode & 0o111` and no extension is revealed, with tests; SPEC lists them and says the phone opens a synced `.apk` in the installer on purpose.
- **PERF-APPROVAL-POLL** — A device that cannot approve web sign-ins does not ask for them every three seconds
  `feature · agent · normal`
  Desktop and phone poll `/v1/web-approvals` every 3 s while visible, authorised or not, although SPEC limits the poll to clients with that authority. Since 0.9.44 `/v1/events` returns an `approvals` generation only to a device that may approve, which is the signal to drive the request. Accept: after one unauthorised answer no further request is sent, and an authorised client polls only after an events signal or at a slower bounded cadence; tests count requests on desktop and phone.
- **UX-FIELD-ERRORS** — A wrong code or address is flagged at its field
  `bug · agent · normal`
  "Enter all six digits." and "Enter the full hub address…" are shown as the operation error card "Could not complete action" instead of inline, and the code cells stay filled after a rejected code. Accept: submitting Connect, Change address or the wizard with an invalid field sets `aria-invalid`, shows the error-tone message tied by `aria-describedby` and no notice card; a rejected code clears its cells.
- **MOB-VIDEO-BACK** — Android Back closes the Audio or Subtitles panel before the film
  `bug · agent · normal`
  accept: `onRequestClose` closes an open panel first, as the photo viewer does with Info, with a test.
- **MOB-SWITCH-CONTRAST** — The Off position of a switch is visible
  `bug · agent · normal`
  The phone's switch track uses the `line` colour (about 1.5:1 on a surface), where desktop and SPEC §9 use `control` (3:1). Accept: `switchTrack` uses the control token, a test asserts 3:1 in both palettes, and the kit is regenerated.
- **UX-MOB-VIDEO-FOLD** — The video player does not rotate on the nearly square Fold
  `bug · agent · normal`
  The player rotates 90° whenever height exceeds width. Accept: a pure rotation rule skips it when the aspect ratio is under about 1.2 or the layout is wide, with a test, and the kit's caption says so.
- **MOB-ALBUM-UNAVAILABLE** — The Photo uploads sheet says how to get Save changes back when an album disappeared
  `bug · agent · normal`
  Save is disabled with no reason while a selected album is missing, and the form row shows the album's name with no sign that it is gone. Accept: the row reads "Unavailable" and the button carries its reason, through a pure helper tested beside `gallerySettingsChanged`.

### Normal priority — medium effort

- **SYNC-SCAN-RESUME** — An interrupted scan keeps the hashes it computed
  `feature · agent · normal`
  The scanner worker writes its hash cache only after the whole scan returns, so a pause, a restore or a restart during the first scan of a large folder throws away hours of hashing. Accept: a scan interrupted after N files re-hashes none of them the next time.
- **MOB-UPLOAD-BACKOFF** — A photo that cannot upload is not exported and hashed again every minute
  `bug · agent · normal`
  Every failure retries after a fixed minute, and the export runs before the exclusion check, so excluded or failing videos are copied and hashed three per cycle indefinitely. Accept: an excluded resource with a saved manifest is refused before `media.export`, repeated failures back off from one minute to one hour and reset on Retry or Sync now, with a test counting exports. SPEC's "back off for a minute" changes.
- **MOB-SHARE-WAIT** — Saving a shared file neither waits without bound nor needs twice its size free
  `bug · agent · normal`
  Save stops the running cycle and awaits it with no deadline, so a cycle hashing a large file or exporting a video holds the sheet, and a process that dies meanwhile loses the batch at the next launch; `importFile` requires twice the file's size plus the headroom because it copies the inbox file instead of moving it; Add files… copies each pick with no stall deadline while holding `picking`, which stops every sync until the app restarts. Accept: Save gives the running cycle a bounded time and says what it is waiting for, the inbox copy is moved into place so one size plus the headroom is enough, and Add files… uses the share's stall deadline, with tests for each.
- **VIDEO-UNSELECTED-REPAIR** — A Movies & TV library the hub is not syncing is reported, not left losing uploads
  `bug · agent · normal`
  Before 0.9.4 a hub could end with a video library and `selected=0`; every later upload to it is committed without a working file, lives only in `objects` and is collected, and the interface offers no way out because a library has no Hub working copy panel. Accept: such a folder shows Needs attention with Start syncing on the hub, uploads to it are refused meanwhile, and a test builds that state and sees nothing collected.
- **SYNC-ROLLBACK-ANCHOR** — A hub restored whole and changed again is still told apart on the next incremental sync
  `feature · agent · normal`
  When `history.json` is restored together with the index and the hub then records enough new revisions to pass a replica's cursor, an incremental cycle sees only higher revisions, so a path the hub changed again replaces the replica's newer file as an ordinary update, and a file only the replica had is never uploaded again; the periodic full pass catches only rows that contradict. Accept: `/v1/changes` carries a digest of the revision at the replica's cursor, a mismatch is treated as the hub having gone back, and a test restores a hub whole, changes the same path on it past the replica's cursor and sees the replica's version kept as a conflict copy on an incremental cycle.
- **MOB-HUB-ROLLBACK** — A phone reconciles with a hub that went back in time
  `feature · agent · normal`
  The phone skips hub rows older than its own, so nothing is replaced, but it then stays diverged: its newer files never upload and its later edits are refused as stale. Accept: the phone reads the catalog's `history` epoch and head, and on a changed epoch or a cursor ahead of the head relinks the folder as the desktop does, keeping newer local content as conflict copies or uploads, with a test against a restored hub.
- **SEC-FORM-ACTION** — Injected markup cannot submit a form, and hub-supplied IDs and revisions never reach HTML raw
  `bug · agent · normal`
  Neither content security policy sets `form-action`; a folder ID from the hub's catalog becomes an element `id` unvalidated on refresh, and `rev` values are rendered raw in History. Reaching them needs a malicious hub. Accept: `form-action 'self'` on the web and `'none'` in Tauri, the catalog refresh validates IDs as `hubCatalog` does, `rev` renders through a number, with DOM tests for a hostile ID and a string `rev`.
- **SEC-DEPS** — Dependency advisories are checked in CI
  `chore · agent · normal`
  accept: audit the locked root, mobile and Rust dependency graphs in CI; fix compatible advisories or document each remaining advisory's affected component, reachability, owner and review date. Verify changes against Expo compatibility and the mobile build-tooling tests; do not blindly apply `npm audit fix` or accept an automatic major downgrade. Distinguish build tooling from installed runtime and reconcile the lockfile with installed dependencies.
- **SEC-RUNTIME-CHECKSUMS** — The bundled Node and FFmpeg are verified against committed checksums
  `chore · agent · normal · depends: DEC-FFMPEG-SOURCE`
  `stage-runtime.js` takes Node's expected hash from the same origin as the binary and FFmpeg has none. Accept: a committed checksum table per platform, checked by `stage-runtime.js` and `verify-bundle.js` (a test swaps a byte and the stage fails), and a CI check that fails when the bundled FFmpeg is older than a recorded minimum.
- **PERF-PROPOSE-COMMITS** — Accepting a proposal runs no folder-wide statement and commits its bookkeeping once
  `feature · agent · normal`
  Each accepted file scans the folder's revision index for `MAX(rev)`, prunes proposals with a 10,000-row `NOT IN`, opens a new `Store` in the worker and makes five to seven separate fsync'd commits. Accept: at most three commits per accepted file and no statement whose plan scans `revisions` or `proposals`, counted through a statement wrapper.
- **PERF-RETENTION-PASS** — The hourly retention pass does not load every revision into memory
  `feature · agent · normal`
  Hourly, and on the first cycle after start, the hub reads every revision row and every hash per folder and lists the object store, even when nothing is removable. Accept: candidates are selected in SQL, a folder whose every revision is current returns no revision row, and a second pass with an unchanged sequence runs no `revisions` or hash statement.
- **PERF-REPLICA-RELEASE** — A replica cycle does not read the whole index to collect an empty object store
  `feature · agent · normal`
  Every replica cycle ends by loading all current hashes and the entire `scan_cache`, although the object store is normally empty. Accept: with an empty objects directory the function prepares no statement; with one stray object it looks up only that hash.
- **PERF-FULL-PASS-DATES** — A full reconciliation does not rewrite every photo's dates
  `feature · agent · normal`
  Each full pass on a replica runs two autocommit upserts per media row that write even when nothing changed: 60,000 fsync'd transactions for 30,000 photos at every start and every six hours. Accept: one transaction per feed page and no write for an equal value; a second pass over an unchanged 500-row page writes nothing to `gallery_metadata` or `added_dates`.
- **PERF-THUMB-HITS** — A thumbnail served from disk costs no fsync'd write
  `feature · agent · normal`
  A disk hit does `UPDATE gallery_derivatives SET used` (an fsync under `synchronous=FULL`) and a synchronous read, and never enters the 32 MB memory LRU. Accept: disk hits enter the LRU and `used` is flushed in one transaction about once a minute and on close; a test sees at most one update and one read across two requests.
- **PERF-RULES-HOIST** — Exclusion rules resolve once per loop, not once per file
  `feature · agent · normal`
  `visibleRules()` does a folder SELECT and an `lstat` of `.arcaignore` per call and runs per row in `replaceLocal` and several engine loops, and two callers omit the directory argument at one more SELECT per row. Accept: rules resolved once per loop or page (the cycle keeps its `.arcaignore` hash check); a test counts at most two `lstat` calls for 1,000 entries with an unchanged result.
- **PERF-SEARCH-FOLD** — Search does not re-fold every path per search
  `feature · agent · normal`
  `instr(arca_fold(f.path),?)` calls a JavaScript fold for every file, and a superseded search still runs to completion on the daemon. Accept: a per-folder folded path list keyed on the file generation, as the music and video indexes do; a test sees no fold calls on a repeated search and finds a newly committed file.
- **PERF-BROWSE-MEMO** — An open folder does not re-aggregate its subtree for every page and status change
  `feature · agent · normal`
  `/v1/browse` groups every live row under the prefix for each page, and the desktop refetches every loaded page and replaces the view on each status change, every 5 s during a sync. Accept: two pages of one prefix run one aggregation statement, and an unchanged generation triggers no `/v1/browse` call and no repaint.
- **PERF-WEB-ASSETS** — The web UI revalidates its assets instead of downloading them again
  `feature · agent · normal`
  A browser session reads about 1.2 MB (`app.js`, lucide, CSS, fonts) from disk and receives it uncompressed with `no-store` on every load; the desktop app loads its own bundle. Accept: assets hashed once (re-read when mtime changes), `ETag` with `no-cache`, 304 on `If-None-Match`, optional gzip with `Vary`; CSP stays on 200; tests cover 304 and a gzip round trip.
- **PERF-MOB-FOLDER-LIST** — An open folder keeps its listing when nothing changed
  `feature · agent · normal`
  Every refresh walks the open folder, sorts it, sets a new array and writes the whole listing as one JSON value, which recomputes the gallery model; 20,000 photos is about 40,000 native calls and 4–5 MB written per run. Accept: an unchanged walk keeps the previous array and skips the write, the listing persists on a debounce and within the size SPEC states; a `folder-listing.js` test checks identity and change detection.
- **PERF-MOB-MUSIC-MEMO** — The phone's music library is rebuilt only when it changed
  `feature · agent · normal`
  Every cycle parses and rebuilds each music library even when the hub answers `unchanged`, and the music screen, Now playing and Folders rebuild or parse it again; video parses its saved library on every request to read its version. Accept: the built library memoized on its version, journal, file rows and playlists; a test sees no store reads or `player.reload` on a second unchanged refresh and a rebuild after a local rename.
- **PERF-MOB-HASH-CACHE** — Inventory scans load the hash cache once per folder
  `feature · agent · normal`
  `cachedRecord` never keeps a store hit in memory, so each inventory makes one SQLite read per file, and re-stats each file although the walk already returned its size and time. Accept: one query per folder fills the map and the walk's stat is reused; a test sees no per-file `cachedHash` calls and no hashing on a second scan of an unchanged folder.
- **UX-VIEWER-ERRORS** — Errors and "Needs the hub" explanations are visible in the photo viewer
  `bug · agent · normal`
  The viewer is the modal dialog at full height: an action's error is written below the window and its result notice lands under the modal layer and expires unseen. Accept: opening the viewer with the hub away and pressing Delete shows the explanation inside the viewer's visible box, and a result notice is shown above the viewer, with DOM tests.
- **UX-DESK-FOCUS-RETURN** — Keyboard focus survives clearing or deleting a photo selection and sidebar Pause
  `bug · agent · normal`
  Clear selection hides its own toolbar, a confirmed delete returns focus to a hidden opener, and Pause rebuilds the button it disabled, so focus falls to the page. Accept: after Clear selection and after a confirmed delete the focused element is a photo tile or the header's back button, and after Pause it is Resume.
- **DESK-ZOOM-CHROME** — Window-control offsets follow the zoom level
  `bug · agent · normal`
  accept: `installDesktopZoom` publishes the zoom as a CSS custom property and the window-controls inset, the controls drop, `.window-drag` and the native drag strip's `clientY` test divide by it, so at 70% the photo viewer's Back button and the sidebar lockup clear the native traffic lights and at 150% they do not drift away; the 760 px breakpoint is evaluated in unzoomed window pixels so a normal window at 130–150% keeps the full sidebar. Tests cover the property and the computed offsets.
- **UX-FILES-BACK** — Back goes up one folder level in Files, and a reload stays in the subfolder
  `feature · agent · normal`
  Idea. Files navigation keeps the subfolder out of the route, so Back in the web admin leaves the folder from three levels deep, while libraries push an entry per level. Accept: each level is a route entry, with a DOM test for Back and reload.
- **MOB-BACK-LEVELS** — Android Back goes up one folder level and clears a photo selection before leaving the folder
  `feature · agent · normal`
  Idea. Back from three levels deep, or with a hundred photos selected, drops to Folders; SPEC specifies one level up only for music. Accept: a pure `backStep(state)` reducer with a test and no new control.

### Normal priority — large effort

- **SYNC-RELINK-NO-COPY** — Relinking a folder does not copy unchanged files into the state directory
  `feature · agent · normal`
  A relink scan has no index to trust, so `capture` copies and hashes every file into `objects`: linking an existing folder, and now the automatic relink after a hub went back, needs free space of about the folder's size on the state volume on each replica, and a relink that stops midway keeps those copies. Accept: a relink trusts a `scan_cache` record whose signature matches and stages only what must upload, with a test counting object copies for a folder identical to the hub's.
- **HUB-DEVICE-ID** — Pairing the same device again keeps one hub registration
  `feature · agent · normal`
  Each device keeps a persistent device ID and a client-held secret and sends both with `/pair`; the hub rotates that registration's token instead of adding a device, and a missing ID keeps today's behaviour. Device IDs are visible to every linked device and web-approval authority is keyed by them, so the ID alone must never rotate a registration. Accept: re-pairing with the same ID and secret leaves one roster entry, the same ID with a wrong secret adds a device and grants nothing, and an older client still pairs.
- **MOB-MEDIA-INSETS** — Player and viewer controls clear the cutout and the gesture bar
  `bug · agent · normal`
  `VideoPlayer.jsx` places its top and bottom bars and the Audio and Subtitles panel at 0 with no safe-area insets (and the picture is rotated on a portrait phone, so the insets must be mapped); the photo viewer applies only top and bottom insets, so its bar sits under a notch in landscape. Accept: a `layout.js` helper gives both their four margins, tested for portrait, landscape and the rotated player.
- **MOB-EXPORT-DEADLINE** — A large video's export is limited by stalls, not by total time
  `bug · agent · normal · native`
  iOS and Android give the whole export one 90 s deadline, so an iCloud original that needs longer never uploads. Accept: the deadline restarts on each chunk in Swift and Kotlin; the JS contract test covers the error codes.
- **MOB-VIDEO-ASSISTIVE** — The film player waits for people who use a switch, a keyboard or a screen reader's focus
  `feature · agent · normal · native`
  The controls now stay while TalkBack or VoiceOver is on, but Switch Access, Voice Access, Switch Control and external keyboards are not detected, so their users must reach a control within three seconds; the Up next card advances by itself after ten seconds without being announced; opening the Audio or Subtitles panel does not move accessibility focus to it. Accept: the controls also stay while any of those is in use (Android's service list filtered to input services; iOS through native code), Up next is announced and holds its countdown for a screen reader, and a panel takes focus when it opens; tests cover the rules.
- **SEC-MOBILE-MANIFEST** — Limit Android cover-provider access without breaking external players
  `chore · agent · normal · native`
  accept: limit `CoverProvider` to authorized cover consumers with URI grants or another appropriate mechanism, while preserving Media3 notifications and Android Auto; tests exercise access and grants. The provider currently serves covers to other apps, so making it private without working grants is not sufficient.
- **SEC-MUSIC-CONTROLLERS** — Another app on the phone cannot browse or control the Arca music library
  `bug · agent · normal · native`
  `MusicService` is exported and accepts every controller. Accept: `onConnect` accepts only its own UID, trusted system controllers and an allowlist (Android Auto, Assistant, Wear), with JVM tests.

### Low priority — small effort

- **UX-DESK-VIDEO-WORDS** — A video in a gallery is called a video
  `bug · agent · low`
  In the desktop and web viewer a video's buttons read Delete photo, Download photo, Photo information, Previous photo and Next photo, and the hub's refusals say “Photo changed. Refresh the gallery before deleting.” for a video. Accept: the viewer's labels and those two messages name the kind of the item, with DOM and daemon tests.
- **UX-DELETE-RETENTION-OFF** — Deleting says when nothing will be recoverable
  `feature · agent · low`
  Idea. The gallery and file deletion confirmations say History can restore the item while retention keeps it, even when the folder's version history is Off and the version goes at the next hourly maintenance. Accept: with history Off the confirmation says the deletion cannot be undone; the wording is part of the approval.
- **UX-NOTICE-REDACTION** — Redacting credentials in a notice does not mangle host names
  `bug · agent · low`
  `safeDetails` treats `code:`, `token:`, `secret:` and `password:` as credential fields, so an address whose host ends in one of those words (`http://vscode:8080`) is shown as `[redacted]`. Accept: redaction applies to key and value pairs, not to a host and port, with a notice-contract test.
- **UX-APPROVAL-FOCUS** — The web sign-in approval opens with Deny focused
  `bug · agent · low`
  `modal()` gives Cancel the initial focus only when a confirmation option exists, so the approval prompt, a confirmation without one, opens focused on "Raw details". Accept: every confirmation dialog, the approval prompt included, opens with Cancel focused.
- **UX-FILES-TIME-REPLICA** — Files rows show their last-change time on replicas
  `feature · agent · low`
  `/v1/browse` reads the time from the local `revisions` table, which a replica does not fill, so replica rows show a size only. Accept: the hub sends the current revision's time for every file (or the change feed carries it), a desktop replica's Files rows show it, and a test pins a replica store without local revisions.
- **UX-DESK-COPY** — Dialog titles and Restore follow the copy rules
  `bug · agent · low`
  "Create a shared folder on hub <name>" and "Path on <name>" use the hub's configured name; "Stop syncing on this hub?" does not name the folder; Connect stacks three hints under one field; Restore's title and prose say "rev" and "sha" and the full path. Accept: the three titles follow SPEC's rules, one hint per field, Restore reads `Restore “name”?` with no `rev` or `sha` in prose (the mono row value stays), and the kit pages match.
- **MOB-COPY** — Phone confirmations and results follow the copy rules
  `bug · agent · low`
  "Photos deleted" for one photo or a video; "Originals stay in Photos" in a folder with no linked album; "File renamed" and "Diagnostics copied" toasts against Quiet successes; Up next counts "tracks" for episodes; ordinary copy uses the hub's configured name where SPEC says "the hub". Accept: `confirm-copy.js` and string tests pin each; SPEC settles the hub-name rule, which §5 Offline contradicts.
- **MOB-TAB-LABELS** — Bottom tab labels stay whole at large text
  `bug · agent · low`
  Phone tabs take one line at the caption size with only the global 2× cap, while the rail caps at 1.1× for this reason; "Settings" is estimated to ellipsize near 1.6×. Accept: a tab-label cap constant tested like `railLabelFontCap`.
- **DOC-SPEC-DRIFT** — SPEC says what the code and the kit already do
  `chore · agent · low`
  Stale sentences found by the audit: the tray's Now playing row (§4 against §9 and the code), the phone's Devices hub actions menu, gallery tile announcements, the Movies & TV search group, the Stream and Keep labels, the Playlists tab in Android Auto, the 2,000-entry folder listing, the one-time photo picks, and §4 Gallery's Deletion bullet, which names `/v1/delete-file` where the desktop uses `/v1/gallery/delete`. Accept: each sentence matches the shipped behaviour; no code changes.
- **KIT-HYGIENE** — The kit's tray reuses the production rule
  `chore · agent · low`
  `.kit-tray` re-declares `#tray-content` and `#tray-error` with literal sizes that have drifted from production (a 6 px gap against `--space-2`). Accept: the kit reuses the production rules; `npm run design -- --check` and the design tests pass.
- **PERF-GALLERY-QUIET-WRITES** — A gallery write that changes nothing does not make galleries read again
  `feature · agent · low`
  The `gallery` row generation is shared by every gallery and moves on any write to `gallery_metadata`, `gallery_assets` and `added_dates`, including an upsert that stores the values already there (`rememberFileDate` and `rememberAddedDate` on every uploaded or pulled photo, the added-dates re-walk), so a kept gallery is read once more although nothing it shows changed. Measured by the review of 0.9.11; results stay correct. Accept: the UPDATE triggers fire only when a column the gallery reads changed (`WHEN OLD.x IS NOT NEW.x`), `gallery_members`, `gallery_assets` and `added_dates` move a per-folder counter, and a test shows an identical upsert and a write in another gallery leave a kept gallery unread.
- **MOB-IOS-ERRORS** — iPhone file errors say what failed
  `bug · agent · low · native`
  The Swift `replaceFile` and partial-file checks throw `NetworkUnavailable` for a failed rename, so the phone shows "Connect to the hub's local Wi-Fi…" as a file's issue; Kotlin names each cause. Accept: Swift throws the same named errors and the JS contract maps them.
- **SEC-IOS-ATS** — iOS never allows arbitrary plaintext loads
  `chore · agent · low · native`
  `NSAllowsArbitraryLoads` is on although the native module already refuses HTTP outside verified private or tailnet addresses. Accept: `NSAllowsLocalNetworking` replaces it and the config test pins it.

### Low priority — medium effort

- **PERF-SCAN-STATS** — A full scan stats each file once and reads the scan cache once
  `feature · agent · low`
  Per file a scan resolves the folder, reads the marker, stats every path component and prepares one cache SELECT: 12–20 system calls where one or two are needed. Accept: scanning 1,000 unchanged files makes at most 1,100 stat-class calls, one marker read and one `scan_cache` statement.
- **PERF-MOB-THUMB-MAP** — The gallery's thumbnail map is not rewritten while scrolling
  `feature · agent · low`
  The whole map (full `file://` URIs, 1–4 MB) is stringified and written after scroll-driven passes, and every flush re-creates every photo object up to four times a second. Accept: thumbnails stored as rows with only the changes written, the map passed by reference and version; a test sees three deltas write three rows and a reload give the same thumbnails.
- **PERF-MOB-SEARCH** — Phone search parses only matching rows
  `feature · agent · low`
  Every ASCII query also reads up to 10,000 accented rows per folder and parses each, folder after folder, and outdated searches keep running. Accept: match on `path` before parsing and stop when a newer query starts; a test with 5,000 accented rows parses only the 3 matches.
- **PERF-WEB-IMAGE-CACHE** — Pages and thumbnails get separate browser quotas
  `feature · agent · low`
  The IndexedDB store holds 128 records shared by gallery pages and thumbnails, so the persistent thumbnail cache is nearly empty after a restart. Accept: separate quotas (pages by count, thumbnails by bytes) in a pure module with a test; whether private images may be cached by the browser is a maintainer decision.
- **PERF-WIN-HIDDEN-EVENTS** — A window hidden or minimized on Windows stops its background requests
  `feature · agent · low`
  WebView2 keeps reporting the page as visible while its window is hidden, so on Windows the `/v1/events` long poll (gated on `document.hidden`) continues in a tray-hidden window and asks for status on every change, and a minimized window keeps the five-second status poll; nothing fires when the window returns, so the first status answer waits for the next tick. Traced in wry, not run on Windows. Accept: the events loop, the gallery and audio-library refreshes and the status poll share one shown-window test that asks the native window (visible and not minimized) in the desktop app, a native show or restore polls once, and a DOM test covers a page that reads visible in a hidden window.
- **DESK-DIALOG-SCROLL** — Long dialogs keep their actions in view
  `bug · agent · low`
  Today the whole dialog scrolls and no dialog pins its action row. Accept: dialogs whose content outgrows the window (Choose folders, Add to playlist, the Erase path list, Pair a device, the conflict dialog) scroll their body while the title and the action row stay visible at the 620 px minimum height; a DOM test fills a dialog past the window height.
- **BACKUP-HUB-ROLLBACK** — A full backup notices that the hub went back
  `feature · agent · low`
  The backup worker's archive cursor is not compared with the hub's history: against a hub that went back it gets 409 and then, once the hub passes the cursor, a silent gap in what it copies. Accept: the worker reads the catalog's `history`, keeps the revisions it already holds, restarts its copy from the hub's head on a changed epoch or a cursor ahead, and reports it; with a test.
- **SEC-INDEX-SNAPSHOT** — The hub keeps a nightly copy of its index
  `feature · agent · low`
  accept: daily maintenance writes `VACUUM INTO index.backup.sqlite` beside the index from the scanner worker (keeping one, mode 0600), Erase removes it, and the CLI documents how to restore it with the daemon stopped; `history.json` stays in place, so the restored index starts a new history epoch and replicas reconcile instead of reverting; after such a start the hub finishes one full scan before it serves heads, so a working copy it still holds does not turn into redundant conflict copies on replicas; with tests.
- **DESK-UPDATER-TESTS** — The Rust updater tests also run on Windows
  `chore · agent · low`
  accept: the `rust-tests` job also runs on `windows-2022` with Windows versions of the two Unix-only tests, so the PowerShell listing and non-Unix exit handling execute; both pass in CI. Stubbing `install_update` is out of scope.

### Low priority — large effort

- **SEC-SIGNING-STEP** — The updater key never enters the build graph
  `chore · agent · low`
  accept: establish a supported Tauri build and separate signing sequence, then build without the updater key and sign the final artifacts in a separate step that only runs the signer with the key; the manifest step verifies the signatures. Tests or a local release-tooling check cover artifact names and signatures; do not assume `createUpdaterArtifacts` succeeds without a key.
- **PHOTO-PLACES** — Search Arca finds photos by place ("hua hin", "thailand", "tailandia")
  `feature · agent · low`
  accept: the hub reads GPS during gallery indexing and stores only a place label and a folded search text (city, district, province, country), never coordinates; names come from a bundled offline GeoNames extract (CC BY, attributed; no cloud geocoding, no new npm dependency), including Spanish and English alternate names for countries and first-level regions; existing photos re-index once; Search Arca gains a Places group (one row per place with its count, opening the gallery filtered to it) on desktop, web and phone, offline on the phone from the synchronized labels; photos without GPS are explained in the empty result; tests cover lookup (Hua Hin, open sea, antimeridian, invalid coordinates), indexing with and without GPS, and the three queries on hub and phone. Feasibility: GPS read 0.17 ms per photo, a dataset of about 2.5 MB plus alternate names, grid lookup about 13 µs.
- **MUSIC-CAR-SEARCH** — Search and voice requests in the car
  `feature · agent · low · native`
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
