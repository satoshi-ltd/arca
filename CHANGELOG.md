# Changelog

## 0.6.81 — 2026-10-02

- On the phone, photos and videos that the folder's .arcaignore excludes no longer show up in the online gallery as "only on this phone".

Needs: native build

## 0.6.80 — 2026-10-02

- On the phone, one folder that keeps failing no longer makes every sync re-check all the other folders' files from scratch: the hourly full check now counts as done once the healthy folders have finished it.
- After an Add photos… failure while offline, Retry on the notice now starts a sync of the photos already queued instead of reopening the photo picker.

Needs: native build

## 0.6.79 — 2026-10-02

- A damaged record in the phone's photo upload list no longer stops Arca from starting or blocks other photos: it is set aside, and the photo it described is found again on the next scan (or, for a picked photo, from its saved copy) without deleting anything on the hub.

Needs: native build

## 0.6.78 — 2026-10-02

- Photos picked with Add photos… are now kept in Arca's own storage until the hub has them, so a cleared cache or a long offline stretch no longer loses them; they also upload when photo access is revoked or the album is gone, and Sync now retries failed picks at once even with automatic uploads off.
- A picked photo whose copy is gone can be dismissed from the Pending uploads strip instead of staying failed.

Needs: native build

## 0.6.77 — 2026-10-02

- Files shared into Arca on Android are now copied to generated names inside Arca's own inbox, so another app's file name can never decide where a shared file is written or overwrite one.

Needs: native build

## 0.6.76 — 2026-10-02

- Show in folder now works on Windows and Linux: from a file's detail or the photo viewer it opens the file's own folder (Explorer selects the file on Windows) instead of the shared folder's root.

Needs: desktop build

## 0.6.75 — 2026-10-02

- In Clean up older versions, changing either number after See the count clears the counts and goes back to counting, so Apply cleanup only removes what the screen showed.

Needs: desktop build · Casa redeploy

## 0.6.74 — 2026-10-02

- Settings → History counts only older versions: a hub with a hundred untouched files no longer reads "100 kept", because each file's current version and current deletions are left out.

Needs: desktop build · Casa redeploy

## 0.6.73 — 2026-10-02

- Plainer wording where people meet Arca cold: the erase-hub dialog says what it erases, the server sign-in help gives the Docker command and says to enter the six-digit code, the pair dialog covers phones as well as computers, and the local-network and file-listing messages say what is happening in everyday words.

Needs: desktop build · Casa redeploy

## 0.6.72 — 2026-10-02

- Every package manifest, the desktop crate, the iOS module (which said MIT), the Docker image and the Umbrel listing now state the PolyForm Strict License 1.0.0, so a copy of Arca always says what it may be used for.

## 0.6.71 — 2026-10-02

- A folder's summary on desktop, web and phone now shows three cells that add to its title: Status with when the last sync completed, Last change (when, which file and which device, or No changes yet) and Version history; the Files cell and the internal revision counter are gone.

Needs: native build · desktop build · Casa redeploy

## 0.6.70 — 2026-10-02

- Desktop, web and phone now use the same words: Devices (not Machines, and no Replica label), Start syncing and Stop syncing (not Select, Keep a local copy and Unlink), Version (not revision) and Erase (not Destroy); on the hub, a machine's Disconnect is now Remove device.
- The daemon's own messages, the tray and the update notices follow the same words.

Needs: native build · desktop build · Casa redeploy

## 0.6.69 — 2026-10-02

- On Windows, if the installer fails after Arca closes during an update, a small background watcher now starts the sync service again instead of leaving it stopped until you reopen Arca.

Needs: desktop build

## 0.6.68 — 2026-10-02

- Settings → History now has one row, Older revisions, with Clean up… and a line saying cleanup shows what it would remove first and never touches current files, pending changes or history not yet backed up. The dialog is titled Clean up older revisions, phrases its two fields as a sentence and shows the count before Apply cleanup; nothing is removed until then.
- If the hub's history changes between the count and Apply cleanup, the refused apply now takes the dialog back to counting instead of retrying the stale figures, and its message says "Count again before applying."

Needs: desktop build · Casa redeploy

## 0.6.67 — 2026-10-02

- On the hub, a folder's revision history choice moves from the summary into a Revision history panel in the side column, with full labels (Off, 1 day, 1 week, 30 days, Forever) and a sentence on what it keeps; the summary now only reads, on every role.

Needs: desktop build · Casa redeploy

## 0.6.66 — 2026-10-02

- A file's ⋯ menu reveals it as Show in Finder on macOS and Show in folder on Windows and Linux, where the item is new and opens the shared folder because only macOS can reveal a single file; the folder header still says Open in Finder or Open folder.

Needs: desktop build

## 0.6.65 — 2026-10-02

- An empty Folders shows Choose folders (replica) or Create shared folder (hub) once, in the header, instead of repeating it inside the empty state; on a replica the empty text points to the available folders below when there are any.

Needs: desktop build · Casa redeploy

## 0.6.64 — 2026-10-02

- Every empty list on the phone and Fold (Folders, Files, Recent, History, a file's history, Machines and the photo grid) now looks the same: a dashed frame with an icon, a heading and one line, and the offline cases keep Retry inside it.

Needs: native build

## 0.6.63 — 2026-10-02

- A folder's header keeps Open in Finder (Open folder elsewhere) and, on gallery folders, the Gallery toggle; on the hub, Enable gallery, Rename and .arcaignore… move into a Folder actions ⋯ menu like the one in the file detail.
- Desktop and server replicas no longer offer Enable gallery: only the hub sets a folder's gallery type (phones do it by linking an album), and a replica's daemon now refuses `/v1/gallery/link` like every hub-only route.

Needs: desktop build · Casa redeploy

## 0.6.62 — 2026-10-01

- Offline, a file's history on desktop and web shows only the saved revisions that follow each other without gaps, says it is showing recent entries only, and keeps Restore for when the hub is back instead of offering it.

Needs: desktop build · Casa redeploy

## 0.6.61 — 2026-10-01

- On a server replica's web administration, a file's detail now offers Download file, served from the replica's own copy, as the hub's already did.

Needs: Casa redeploy

## 0.6.60 — 2026-10-01

- Info notices (saved, copied, unlinked) are now the primary green with its on-green text on desktop, web and phones, instead of inverting the page's colours for the least important message.

Needs: native build · desktop build · Casa redeploy

## 0.6.59 — 2026-10-01

- Internal: the site and the weekly cleanup workflows use the same checkout and Node setup actions as the release workflows, and a test now keeps them aligned.

## 0.6.58 — 2026-10-01

- On phones, when Arca closes because of an uncaught error, the next launch shows one notice ("Arca closed unexpectedly") with the saved error under Details and a Copy button, so it can be reported; nothing is sent anywhere.

Needs: native build

## 0.6.57 — 2026-10-01

- Phone previews from the hub verify the local photo's contents first, so an edit that keeps the same size cannot display an older image.
- Manually picked library photos deleted before upload stop retrying even with automatic uploads disabled. Restricted or unavailable library access still keeps them retryable.

## 0.6.56 — 2026-10-01

- On phones, a photo deleted from the library before it uploads no longer stays as "Needs attention" and retried forever: it leaves the pending uploads, stops blocking Change album and Up to date, and nothing already in the hub is touched.

Needs: native build

## 0.6.55 — 2026-10-01

- On phones, opening a photo the phone cannot decode itself now shows the hub's large preview instead of "could not be displayed", and keeps it for offline use.

Needs: native build

## 0.6.54 — 2026-10-01

- On phones, a photo or video the phone cannot decode itself (such as a large HEIC on Android) now gets its preview from the hub, requested once and kept for offline use, instead of staying a grey tile.

Needs: native build

## 0.6.53 — 2026-10-01

- On phones, an open photo folder now prepares the previews of every photo it holds, newest first, instead of only the ones on screen, and a row above the grid shows how many are done or that some could not be made, with Retry.

Needs: native build

## 0.6.52 — 2026-10-01

- On phones, photo previews that cannot be made are no longer retried at every scroll, so unreadable files stop taking time from the readable ones.

Needs: native build

## 0.6.51 — 2026-10-01

- Internal: the setup wizard's detected-hubs list moved to a maintainer decision, because a fresh desktop installation has no daemon to ask before pairing.

## 0.6.50 — 2026-10-01

- On a Docker server, the first-run access step now shows the command that issues the web access code, with a Copy button, and says the code is the `code` value of its JSON reply, instead of a bare command with no container to run it in.

Needs: Casa redeploy

## 0.6.49 — 2026-10-01

- On desktop, web and server, the setup wizard now asks for the machine's name and role on one page, says who each role is for, and shows a three-step rail (This machine, Connect, Folders) in which Connect reads Not needed for a hub.

Needs: desktop build · Casa redeploy

## 0.6.48 — 2026-10-01

- On phones, the pairing screen now says that the hub's Machines → Pair a machine shows the address and the code, and asks for them in that order, then the phone's name, which keeps its default.

Needs: native build

## 0.6.47 — 2026-10-01

- On phones, the welcome screen now says where the hub comes from: install Arca on a computer or a server, make it the hub and open Machines → Pair a machine there for the code, instead of ending with a bare "You will need a hub and a pairing code."

Needs: native build

## 0.6.46 — 2026-10-01

- On phones, the photo gallery no longer crashes with "Cannot read property 'uri' of undefined" when it shows an item without a content hash, such as a pending or failed upload.

Needs: native build

## 0.6.45 — 2026-10-01

- Internal: six new proposal boards (five for onboarding on desktop, web, server and phones, one for preview progress in photo folders) and a fix so the mobile boards in the design kit render with their styles.

## 0.6.44 — 2026-10-01

- On phones, offline Recent, a file's detail and a photo folder with nothing saved now say "No saved revisions" or "Nothing saved on this phone" with a Retry that probes the hub again, instead of a bare error or a claim that there is no history or no photos.

Needs: native build

## 0.6.43 — 2026-10-01

- On desktop and web, a replica whose hub is unreachable now says Offline in its own Machines pill and in the tray heading instead of Syncing, other machines in the saved list read Offline and last known, and Recent and a file with no saved revisions say so ("No saved revisions") instead of claiming the hub has none.

Needs: desktop build

## 0.6.42 — 2026-10-01

- Internal: the design kit becomes a self-contained module with its own contract, a Proposals tab for visual ideas that are still proposals and a generator (`npm run design`) for the mobile tokens and the favicon.

## 0.6.41 — 2026-10-01

- On a phone with a slow hub, the saved copies of History and Recent now reach every folder instead of only the first ones in the list: the missing or oldest pages are fetched first, four at a time, so going offline later still shows each folder's recent changes.

Needs: native build

## 0.6.40 — 2026-10-01

- Internal: two daemon tests no longer depend on the filesystem's timestamp resolution, which made the Windows pipeline fail intermittently.

## 0.6.39 — 2026-10-01

- On Android, a sync that starts while the hub is known to be unreachable no longer raises the "Synchronizing folders" notification or asks for notification permission: it checks the hub first and starts the foreground service only once the hub answers.

Needs: native build

## 0.6.38 — 2026-10-01

- On a phone, Recent, Machines and an open file detail now refresh by themselves when the hub comes back, instead of staying on saved data until the next sync finishes. An open file detail gets its Restore button back without being reopened, and Machines only says it shows saved information when it really does.

Needs: native build

## 0.6.37 — 2026-09-30

- GitHub Actions now tidies itself every Monday: completed runs beyond the newest 10 per workflow that are a week old, and week-old artifacts, are deleted. A manual run can list what it would delete first.

## 0.6.36 — 2026-09-30

- On a phone without a hub connection, a file's detail now shows the phone's own copy as the current revision when the saved history does not include it or is older, and says "No saved revisions for this file" instead of implying it has no history.

Needs: native build

## 0.6.35 — 2026-09-30

- On a phone, shared gallery Delete (in the viewer and when several photos are selected) and Link album are disabled with "Needs the hub, which is unavailable." while the hub is unreachable, and failures of actions that need the hub no longer say your edits were saved locally.
- Disconnecting while offline now works: the phone records it, shows "Disconnect pending" and leaves the hub when it is reachable again, instead of showing an error. Renaming the phone offline confirms that the name was saved on the phone.

Needs: native build

## 0.6.34 — 2026-09-30

- On a desktop or server replica, Restore, Resolve conflict, Choose folders, Select, Enable gallery, gallery Delete and Disconnect… are disabled with a short reason while the hub is unavailable, instead of waiting 10 to 25 seconds and failing.
- Hub failures no longer read "Hub your hub unreachable", and an action that needs the hub no longer says your edits were saved locally.

Needs: desktop build

## 0.6.33 — 2026-09-30

- A phone applying a downloaded file no longer needs room for two copies of it: the verified download is moved into place, which matters for large videos on a nearly full phone. Identical files still download once.

Needs: native build

## 0.6.32 — 2026-09-30

- Offline, the phone's gallery keeps each photo in the month and order the hub gave it instead of moving everything to the day it was downloaded, and keeps its revision so Info still works.

Needs: native build

## 0.6.31 — 2026-09-30

- The phone's folder gallery now shows photos and videos that exist only on the phone (for example, imported while sync was paused) while the hub is reachable; before, it listed only what the hub's index already knew and could read "No photos yet" over a folder with photos.

Needs: native build

## 0.6.30 — 2026-09-30

- The phone's folder list now refreshes when a folder or file appears, disappears or changes only in case (`one.txt` to `ONE.txt`); before, it kept the old names until you reopened the folder.

Needs: native build

## 0.6.29 — 2026-09-30

- Add photos… on a linked album now keeps the photos you pick when the hub is unreachable and uploads them once it is back, even with automatic uploads off, instead of dropping them while the notice said your edits were saved. A picked photo that disappeared meanwhile says it must be picked again.

Needs: native build

## 0.6.28 — 2026-09-30

- A phone now calls a silent hub offline after 10 seconds instead of 15, and a hub that answers in time stays online. Renaming, deleting, importing or pausing while that check is running no longer throws its result away: the answer is recorded when it arrives.
- Disconnecting, deleting local copies or pairing while a check is stuck cancels it at once instead of asking you to wait.
- Offline, a photo's Info shows the local copy's details without contacting the hub.

Needs: native build

## 0.6.27 — 2026-09-30

- History on a desktop or server replica no longer waits on the hub once per folder when the hub is unreachable: it reads all folders together from saved data (seven folders took 24 seconds, past the web view's 20-second limit, and now take about 3), and phones read their History pages together too.
- Offline, a file's history comes from the saved folder history instead of showing only the local copy, Machines shows the machines saved after the last sync even if it was never opened, and a preview of an older revision fails at once instead of stalling row thumbnails for 60 seconds.

Needs: desktop build · native build

## 0.6.26 — 2026-09-30

- On desktop and web, opening a folder lists its local files at once instead of waiting for the hub's recent revisions, which took 7 to 10 seconds or more when the hub was unreachable; Recent and the latest-revision figure fill in when the hub, or its saved copy, answers.

Needs: desktop build · server image for server replicas

## 0.6.25 — 2026-09-30

- A desktop or server replica notices a hub that stops answering (for example a Tailscale peer that is down) within about 10 seconds when a sync starts, or 25 seconds between syncs, instead of 60–70 seconds, so the Offline state and saved views appear sooner. It also notices the hub coming back within about 10–15 seconds instead of up to 46.

Needs: desktop build

## 0.6.24 — 2026-09-30

- A desktop or server replica no longer reopens a stale "Allow this browser…" prompt every few seconds, even after restarts, while the hub is offline; Allow or Deny now fails at once when the hub is known unreachable instead of waiting 60 seconds.

Needs: desktop build

## 0.6.23 — 2026-09-30

- CI, the bundled desktop runtime and local validation read the Node version from one file, `.node-version`, and a test keeps the Dockerfile and the EAS profiles equal to it. EAS builds move from 24.14.1 to 24.14.0, the version everything else already used.

## 0.6.22 — 2026-09-30

- The release check now verifies every place the version bump writes, from one shared list, including the README, SPEC and design-kit banners, and names the files that disagree.

## 0.6.21 — 2026-09-30

- The release pipeline runs the desktop app's Rust unit tests (daemon identity and locks that guard self-updates, tray states) on pushes to `main` and on pull requests, and a failing test now blocks publication.

## 0.6.20 — 2026-09-30

- A phone retrying an interrupted photo upload no longer restarts a paused first download of that folder. Checking whether the hub had kept the upload as a conflict copy opened its own snapshot, which replaced the download's saved hub lease; it now reads the folder's change feed, which takes no lease.

Needs: native build

## 0.6.19 — 2026-09-30

- A web sign-in request made with "Approve on a machine" always lasts exactly ten minutes. Its creation and expiry times came from two clock reads that could land a millisecond apart, which made one test fail intermittently on Windows CI.

## 0.6.18 — 2026-09-30

- A phone whose Photo uploads settings for a folder become unreadable no longer fails to start or crashes its screens. That folder stops with "Photo uploads settings are damaged. Choose Change album… to repair them." and is not scanned, and its local files cannot be renamed or deleted, so a lost record can never turn missing files into deletions on the hub. Change album… repairs it, turning uploads back on after the usual confirmation and restoring any missing files before syncing again.

Needs: native build

## 0.6.17 — 2026-09-30

- SPEC describes how Arca works today instead of how it got there: every dated note, validation log and stale status is folded into the section that owns it, in the present tense, or dropped when git and this changelog already keep it. It opens with a short current-state summary, and the API reference now names the real pairing endpoints.
- SPEC is reorganized into product decisions, architecture and access, synchronization, desktop and web, mobile, API reference, operations and the design system. Superseded details are corrected on the way: the 17831 port for Casa and Umbrel, the backup's `state/`-only layout, the current CLI commands and desktop motion.
- README's pilot-update sections become pointers into SPEC operations, and links from README and ROADMAP follow the renamed headings.

## 0.6.16 — 2026-09-30

- The project runs as an autonomous loop: `ROADMAP.md` is a task pool with owners, priorities and acceptance criteria, and `AGENTS.md` wires the maintainer's `next-task` workflow (implement, test, adversarial review, release, watch CI) and defines what each document owns; the changelog is now `CHANGELOG.md`.
- New release tooling: `scripts/bump-version.js` moves every version manifest at once and `scripts/validate-local.js` validates a clean copy of the working tree with the CI's Node version.
- Desktop start, build and release prune the Cargo cache past 10 GB (incremental caches first), Android builds keep only the latest dev and production APK, and staged desktop runtimes no longer carry deleted modules.
- The scale and resilience qualification tools and the tray icon generator are now tracked and pass on the current product; unused dependencies, duplicate files, dead code and the `npm run build:site` alias are gone (use `npm run site:build`, which now clears its old output).

## 0.6.15 — 2026-09-30

- Documentation catches up with the product. README: gallery folders open in Gallery, the site's motion is CSS-only, web approvals expire after ten minutes, desktop installs update themselves, Docker images publish to Docker Hub only, and Umbrel helper updates have run for real. SPEC: dated notes that read as current status are marked as history (source versions, the desktop updater, long polling). The two documentation-debt items leave ROADMAP.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 396 tests with two platform skips and all 223 mobile source tests pass. An adversarial review confirmed every claim against the code; its corrections (the folder view's tabs, SPEC still describing itself as the roadmap, one dated note) are applied.

## 0.6.14 — 2026-09-29

- Relinking a desktop or server replica treats the hub as the source of truth, and so does any first sync that has not completed yet. Local files the hub deleted, or holds in a different version, go to the system Trash before anything is proposed, and the hub's version downloads. A relink no longer brings deleted files back or leaves conflict copies (the `photos-yuri` case). Files the hub never had still upload, and identical files are adopted.
- Each volume uses its own trash, as the operating system does, so stale files on an external disk are never copied onto the startup disk. On macOS they go to the Trash, without Finder's Put Back. On Windows they go to the Recycle Bin, on fixed drives only, and never when the bin is turned off or too small (Windows would delete the file permanently instead). Linux follows the freedesktop Trash, and Docker replicas keep theirs in the state volume. If a file cannot be trashed, the folder stops with an error that names the files to move by hand, nothing is proposed, and the hub is not re-read on every retry.
- The 0.6.13 release pipeline failed on one Windows test with `fetch failed`, which reran green. The likely cause is Node's 5-second keep-alive: a client reused an idle connection just as the daemon closed it. Daemons now keep idle connections for 30 seconds, which also removes that rare transient error between replicas and the hub. The test helpers report the underlying network error.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 396 tests with two platform skips and all 223 mobile source tests pass. An adversarial review's findings (Windows permanently deleting files the Recycle Bin cannot hold, a possible hang on a Recycle Bin dialog, stale files on other volumes copied onto the startup disk, a hub re-read on every failing cycle, the scope wording) are fixed with tests. The Windows Recycle Bin path is exercised with a simulated PowerShell only; a real Windows run is still open.

## 0.6.13 — 2026-09-29

- Phones keep each synchronized file once. Downloads and captured local edits used to stay in the app's object store after reaching the folder, doubling the space used: the Fold held about 55 GB for 26 GB of photos. The store now keeps only files still in transit (queued uploads and downloads being applied), and every successful sync collects the rest, so existing duplicates are freed on the first sync after updating.
- The mobile gallery shows its thumbnails. The folder listing restarted on every sync status change, and thumbnail preparation waited for it, so on a large syncing folder it almost never ran; the grid then decoded full-resolution originals, which Android cannot show for HEIC. Now one listing runs per folder (a request during it runs it once more), thumbnails prepare while folders sync, three at a time, and a tile shows a placeholder until its thumbnail is ready.
- Thumbnails and video posters come from the operating system: Android `ImageDecoder`/`MediaMetadataRetriever` and iOS ImageIO/AVFoundation decode directly at the target size instead of decoding each full-resolution original. The derivative cache is pruned in batches with separate budgets for grid thumbnails (512 MiB) and viewer renditions (256 MiB). HEIC photos open in the viewer from a 2048 px rendition made the same way, and the viewer shows the thumbnail at once while the full image loads. Needs a new native build; older binaries fall back to the previous renderers.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 390 tests with two platform skips and all 223 mobile source tests pass. The Android module compiles in debug and release builds and `Thumbnails.swift` typechecks against the iOS 16.4 SDK. Two adversarial reviews: a Swift line that would not compile, a stale folder shown while switching, cache pruning on every thumbnail with too small a budget, space not reclaimed when a folder fails, listings never refreshed after remote renames (and then refreshed every cycle through the hub-wide cursor), soft HEIC thumbnails and leftover partial files are fixed with tests. An emulator check crashed before reaching the gallery; acceptance on the Fold is open.

## 0.6.12 — 2026-09-29

- New `ROADMAP.md` owns everything still to do: next steps, maintainer decisions, pending Casa and desktop deployments, the phase 1 qualification gates, mobile, web, Umbrel, signing and website work, documentation debt, items to verify and close, and later phases, each with an ID, a status and its acceptance evidence. SPEC's remaining-work table moves there; AGENTS.md and README point to it.
- SPEC passages that still described replicas falling back to hub previews (superseded by v0.6.9) are corrected.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 390 tests with two platform skips and all 216 mobile source tests pass. An adversarial review found no missing task; its corrections (a Casa redeploy listed for catalog totals every current hub already returns, the hosted CI history, the desktop build version, dated relink notes and two dropped SPEC links) are applied.

## 0.6.11 — 2026-09-29

- Opening Info on a playing video pauses it and closing Info resumes it, instead of restarting it from the beginning. A video paused by hand, before or while Info is open, stays paused.
- Phones no longer reuse previews cached from the hub by earlier versions: the gallery's derivative cache only accepts its own flat files, and the old nested hub cache is deleted at the next thumbnail render, so every thumbnail comes from the phone's own files.
- The desktop and web gallery header counts videos apart from photos (“3,560 photos · 38 videos · 26.0 GB local”). The gallery timeline now reports each month's video count, and every refresh corrects a count read from an older cached page. The desktop header needs the new desktop build and the web header needs the hub (Casa) redeployed.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 390 tests with two platform skips and all 216 mobile source tests pass. An adversarial review's findings (a header left stale by pages cached before this version, a race deleting the old nested cache, Info resuming a video paused while it was open, the missing desktop-build note) are fixed with tests. No native build or deployment performed.

## 0.6.10 — 2026-09-29

- Mobile video tiles, year mosaics and the viewer show a poster made from the first frame of the phone's own file, like photos, instead of a play placeholder. It is generated locally with the video player already in the app and kept in the regenerable gallery cache. A video whose frame cannot be read keeps the placeholder.
- Opening a video in the mobile viewer starts playing it right away, as on desktop. Play remains only to retry after an error.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 390 tests with two platform skips and all 214 mobile source tests pass. Two adversarial reviews: posters that would never appear on iOS (the player attaches its item asynchronously, so the frame request now retries), repeated attempts for undecodable videos (now remembered until the file changes or the app returns to the foreground), photos waiting behind videos and malformed paths are fixed with tests. No native build or device verification performed.

## 0.6.9 — 2026-09-29

- Replicas show only their own files. The mobile gallery, viewer and video tiles read the phone's synchronized file or its own Photos original and never fetch hub previews. Offline, every downloaded photo appears, and a photo not downloaded yet stays a placeholder: the viewer says so instead of staying busy. The gallery keeps its cached hub order while linked. It falls back to the phone's own files once offline is detected or after two failed hub refreshes in a row.
- Desktop and web replicas no longer ask the hub for the preview of a current photo they do not hold. They answer “Sync this photo before previewing it”. Recent and file-history rows render the current revision from the local copy, and only other retained revisions come from the hub.
- Unlinking a folder on a desktop or web replica deletes its verified synced copy by default, so a stale copy cannot come back as local content on a later relink. Turn the option off to keep the files.
- Folder progress counts files and their size (“402 / 1,269 files sent · 4.3 GB / 14.0 GB”), never directories or deletions. A full download takes its totals from the hub's folder size, including what the same cycle uploaded.
- The desktop gallery header counts photos, and History revision numbers stay on one line. Mobile shows the gallery icon for shared photo folders that are not selected, both in the list and in the Select sheet, whose caption reads “Needs 1.6 GB · 41.2 GB free”.
- The `design/` kit mirrors these changes. SPEC moves the media placeholder and fast-scroll thumb contracts into the design section and lists relinking with the hub as the source of truth as a proposal (P1-RELINK).
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 390 tests with two platform skips and all 209 mobile source tests pass. Two adversarial reviews: the first review's findings (a revision column rule that never applied, the mobile gallery switching source on open, stale receive totals, current-revision previews still proxied to the hub, missing tests, stale docs) and the second's (totals doubled by files the hub already had, the kit version) are fixed with regression tests. Stale hub previews already cached on phones are left for the system to clear. No native build or deployment performed.

## 0.6.8 — 2026-09-29

- Desktop and web replicas show each unselected shared folder's file count and size instead of “Not counted yet”. Replicas now keep the hub catalog's totals. The selection dialog shows the folder's size on the hub and the space it needs next to the free space.
- Mobile unselected folder rows, the Select sheet and the pairing folder list show the hub's file count and size through one shared helper, with singular wording and “Not counted yet” when the hub has no count.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 383 tests with two platform skips and all 207 mobile source tests pass. An adversarial review found no blocking defect; its one suggestion (the pairing list wording) is applied. No native build or deployment performed.

## 0.6.7 — 2026-09-29

- Mobile gallery scrolls infinitely in both directions with no “Show more” button: it lays out the whole timeline from the hub's per-month counts, mounts only rows near the viewport and fetches the months you scroll to. Photos not yet fetched show as neutral squares. Returning to the present after a jump is plain scrolling.
- The mobile date rail is now a fast-scroll thumb on the right edge: an accent pill with up/down chevrons. It appears while scrolling, stays under the finger and drags continuously through the whole timeline. While dragging it shows a thin track, the month in an accent bubble and only sparse year chips, with no month ticks. Only the thumb takes touches, so edge photos stay tappable.
- Photos without a thumbnail look the same everywhere: desktop tiles, the mobile month grid, year mosaics and album previews share one `placeholder` design token and a soft image or play glyph. Dense mobile tiles show only the fill.
- Mobile gallery refresh reads one hub page every five seconds instead of every loaded page. Each page replaces the rows it covers, so edited, deleted and renamed photos never stay stale. A month that changed stays visible while it is re-read. Rows added above the viewport no longer move the photos being viewed. Offline, the gallery shows the phone's own working copy.
- Mobile sheets use the desktop dialog header: drag handle, icon tile, title, context subtitle and a divider, aligned with their content. Folder actions become a compact menu with the folder's icon, name and summary and 48 dp rows. Every sheet keeps an explicit Close on phones and the Fold, like desktop dialogs.
- The hub gallery timeline includes each month's newest revision, so clients notice edits that keep a month's count. Requires deploying the hub; older hubs fall back to counts.
- Desktop gallery: the bottom “Load more” button is gone. The page loads the next batch whenever its end stays in view after a load, and failed loads retry automatically.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 381 tests with two platform skips and all 206 mobile source tests pass. An adversarial review's findings (stale edited rows, blanking months during uploads, desktop first-page retry, scroll jumps, undated thumbnail pruning) are fixed with regression tests. A second, full-context adversarial review's findings (an unchanged refresh re-reading the newest month, a paired-but-offline gallery ignoring the local copy, the rail model re-rendering the app for every page) are fixed too. No native build or deployment performed; physical-device scrolling acceptance is pending.

## 0.6.6 — 2026-09-28

- Linked phone albums upload before the shared folder download in every cycle, with their own transfer turn. A large first download (the Fold's 26.6 GB `photos` copy) no longer blocks album uploads or keeps a stale album warning. A yielded or failing upload pass (for example, revoked Photos access) still lets the download run; the upload failure is reported after it.
- The first download of a folder resumes where it stopped instead of relisting and rechecking every downloaded file: the phone keeps its snapshot lease, page position, cursor and deferred rows across yielded turns, pauses, file operations, background expiry and lost connections. An expired lease restarts the snapshot; any other failure releases the lease and drops the saved position. Rows the phone pushed between turns are never rolled back by the older snapshot, and deferred rows are kept once. Unlinking a folder, a policy change or completion clears the saved position.
- The hub renews a snapshot lease whenever a page is read, so long downloads keep the same snapshot (desktop replicas benefit too). Takes effect when the hub runs 0.6.6; until then a lease still expires 10 minutes after it was created and the phone restarts that snapshot.
- Pinching out in the yearly gallery view works again when the fingers are below the last year card, and a grid pinch below a month's last row anchors to an existing tile.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 380 tests with two platform skips and all 195 mobile source tests pass. Two adversarial reviews: the first review's findings (snapshot rollback, upload failures skipping the download, lost resume position, duplicate deferred rows) and the second's low-severity leftovers (a finished listing's stale position, album failures hidden while the download yields) are fixed with regression tests. No native build or deployment performed.

## 0.6.5 — 2026-09-28

- Fix an intermittent mobile startup/reload crash when a saved hub connection becomes available before the replica runtime: Machines, automatic History and the Recent tab now wait for runtime readiness and load when it becomes ready.
- Mobile downloads re-read a local file before replacing or removing it whenever the size/mtime cache reports it unchanged, so a same-size edit hidden from that cache is kept as a conflict copy instead of being overwritten (a risk introduced by 0.6.4's cached-hash reuse).
- Reduce mobile download reconciliation overhead: build the case-insensitive path index once per pull instead of loading the whole folder for every file, and avoid rewriting already accepted rows after verifying unchanged bytes and revision. Preserve conflict checks and crash-journal recovery.
- Bump all project manifests to 0.6.5 and Android/iOS build numbers to 28. Source changes only; no native build or deployment performed.
- Keep photo-item failures in Photo uploads without duplicating them as folder failures; stop export batches when storage is exhausted and separate readable storage guidance from native diagnostics. A pass without a new failure shows the most recent failed photo's own reason instead of an older warning from another cause. Inside a folder, folder and photo-upload problems reappear as the explanatory notice (with Retry) instead of inline caption text, and Pending uploads separates waiting photos from those that need attention.
- Mobile gallery: float the transparent timeline over full-width photos, track the visible month, and keep its accent label on one line. Pinch through four columns (six on the Fold, the default), ten columns (twelve on the Fold, compact), and an annual mosaic overview. Reverse the gesture to return; tap a year to open its photos in the compact grid. The density follows folding or unfolding the Fold, dense grids keep loading while scrolling, and undated photos are labelled instead of showing an invalid date. Annual cards show total counts and bounded thumbnail samples; the timeline tracks the visible year.
- Recover a stale folder error caused by an unavailable local photo album without changing the album selection or hiding unrelated synchronization failures; show the album warning once.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 379 tests with two platform skips and all 186 mobile source tests pass. Two adversarial reviews found no data-loss or crash defect in the final state. No native build or deployment performed.

## 0.6.4 — 2026-09-28

- Clean commit validation on macOS with Node 24.14.0 and root-only dependencies: exact macOS CI command 378 passed/two skipped; mobile source suite 173 passed. Hosted CI and physical-device qualification remain pending.

- Keep foreground-started Android folder synchronization active when the screen turns off: acquire the existing transfer service for ordinary downloads/uploads as well as album uploads, retain it across continuation turns and release on completion/pause/failure. Scheduled background runs do not start it. Notifications describe file synchronization and report the Android service time limit. Source-only; no new native build or device validation for this fix. Local `npm test`: 551 passed, two platform skips.

- Include the shared timeline module in EAS build inputs; regenerated the signed Android 0.6.4/build 27 APK with the gallery corrections. Device visual acceptance remains pending.

- Align mobile date navigation with desktop: shared month spacing, muted years, compact accent drag label and no rail background. Mobile uses thin horizontal month ticks and the full measured gallery viewport, with a side gutter that keeps navigation off the photos.

- Mobile gallery shows the actual synchronization or album-upload error below the header instead of the generic “Needs attention” text; disabled uploads are identified explicitly.

- Fix an intermittent watcher test failure blocking update preflight: after changing exclusion rules, wait for the replacement parent watcher to receive an event before testing directory removal. Verified with 100 consecutive watcher runs and the complete `npm test` update preflight (546 passed, two platform skips).

- Mobile snapshot retries reuse verified hashes of unchanged local files instead of rereading their full contents; changed files and forced verification still check the bytes and preserve conflicts.

- An unavailable linked phone album now warns about photo uploads without failing shared-folder synchronization; incoming files continue downloading when the hub is reachable.

- Remove the remaining mobile deletion-review screen, menu actions, opt-in, pending queue and native original-removal code, plus the hub’s special restore/check endpoints and recovery pins. Confirmed shared deletions go directly to the hub; failures are reported without queuing. Live Photo grouping and source re-upload suppression remain, and Photos originals stay untouched.

- Desktop gallery uses an accent “View folder” header action and restores the gallery position when returning.
- Files, Recent and History load small media previews without blocking rows. Historical previews identify the retained revision exactly; unavailable previews keep their icons.
- Mobile galleries show a draggable date rail during scrolling and hide it after two idle seconds. Selecting a month jumps directly to its page; single-month galleries omit the rail.
- Fix mobile gallery Play opening file details: use an embedded player with native controls, resolve the current local video at playback time, and stop playback on navigation or backgrounding. Requires the rebuilt mobile client with `expo-video`.
- Mobile native build number 27; source changes do not update installed apps or the hub.
- Local post-review validation: 546 tests pass with two platform skips (complete sequential suite), Android/iOS JavaScript exports, version agreement and whitespace checks pass. Physical-device feedback and clean release qualification remain separate.

## 0.6.3 — 2026-09-28

- Excluded paths are outside Arca: when a folder's `.arcaignore` or the fixed exclusion list changes, the hub, desktop replicas and phones forget the excluded index rows. Their hub history then ages out under the folder's history setting as if they had been deleted at that moment (Off: at the next retention pass; Forever: kept), respecting backups and pins, and unused objects are collected afterwards. Files on disk are never touched and no deletion is propagated. Re-including a path imports it again; identical replica copies are adopted without conflicts and different content keeps both versions.
- Browsing and folder totals read the index directly instead of evaluating exclusion rules for every row, and no longer keep a totals cache.
- Fix the remaining v0.6.2 Windows CI failure: the gallery recovery test corrupts and restores the stored object in place, because Windows refuses to truncate a file another process has mapped.
- The EAS input test no longer inherits a Git hook's `GIT_DIR`; run from a linked worktree's pre-push hook, its `git init` had reinitialized the real repository as bare.
- Make the Linux watcher test wait until its directory watcher is live.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 376 tests with two platform skips and all 162 mobile source tests pass.

## 0.6.2 — 2026-09-27

- Always exclude OS metadata, temporary and lock files, trash, NAS thumbnails, other sync tools' state and regenerable caches (including `.git`, `node_modules`, `.venv`, `.cache` and `.m2/repository`) on the hub, desktop and phones, with or without `.arcaignore`; `!` rules cannot re-include them. Names that may be content (`cache/`, `build/`, `logs/`, `*.lock`, `.env`) still sync, as do `.gitignore` and `.github/`.
- macOS custom folder icons (`Icon\r`), unreadable volume folders and `.venv` environments no longer stop a hub or desktop folder scan; unlinking with local deletion also tolerates unreadable folders.
- New hub folders are always created with a rule-free `.arcaignore` of two comment lines; the create-folder checkbox is gone and the hub always shows the `.arcaignore…` button.
- Deleting an unlinked copy never removes a folder that still holds temporaries, caches or `.git`.
- On Linux (Docker hubs, Umbrel, Linux desktops), watch only non-excluded directories instead of Node's recursive watcher, which spent inotify watches on every excluded directory until the system limit ran out and folders fell back to hours-late scans (Casa: 46,394 watched directories down to 975). macOS and Windows keep their native recursive watcher. The host-only `fs.inotify.max_user_watches` setting, which a container cannot change, is documented for very large Linux trees.
- Faster folder browsing in large folders with many excluded files: subfolders read only their own rows through the index and exclusion results are remembered per directory (Casa: 1–2 s per click down to 20–200 ms).
- Deploy desktop and mobile replicas before or together with the hub: a 0.6.2 hub rejects proposals for fixed-excluded paths, which would stop those folders on older replicas.
- Verified locally: clean export on macOS with Node 24.14.0 and root-only dependencies; the exact macOS CI command passes 372 tests with two platform skips and all 161 mobile source tests pass. Windows fixes still need hosted CI.
- Fix the two Windows CI failures from 0.6.1: the gallery recovery test now waits for background preview preparation before rewriting a stored object, and the machine-rename test waits for the rename report before resetting its throttle.

## 0.6.1 — 2026-09-27

- Linked mobile albums now keep a complete synchronized local copy, including files contributed by other devices. Linking preserves existing files; previously upload-only phones download the shared folder, and disabling uploads keeps downloads active. Gallery images prefer local files and thumbnail progress survives refresh. Verified with all 161 mobile tests, Android/iOS JavaScript exports and version agreement; device installation remains separate.
- Shared gallery deletion: participants can request deletion from source phones and ordinary copies, including photos not yet downloaded. Explicit requests have durable IDs; verified Live Photo resources are deleted as a group. Mobile pending requests survive restart and can be reviewed and canceled before submission. Desktop/web keeps selection → Delete → confirmation, sends requests directly to the hub and reports failures without queuing or automatic retries.
- Gallery sources keep durable hub suppression for explicitly deleted assets, preventing automatic re-upload. Ordinary Photos deletions remain upload-only and never delete the Arca copy.
- Optional original-removal review is off by default per phone and album, applies only to future events, and requires foreground confirmation and a complete unchanged-resource check. Recovery content is pinned for seven days; restore, expiry and History Off block original removal. Android uses trash; iOS uses PhotoKit with local-only verification exports. Native build number 26 requires rebuilding/installing the app.
- Align iOS configuration with the installed SDK’s 16.4 minimum and describe the optional confirmed removal in photo-access permission text. Album changes clear original-removal opt-in.
- Final commit validation: clean staged-source export on macOS with Node 24.14.0 and root-only dependencies; exact macOS CI command passes 368 tests with two platform skips, and all 161 mobile source tests pass separately (529 passed total). Android/iOS JavaScript exports pass. Earlier native build checks do not replace physical-device qualification. No hosted CI, hub deployment or app installation is implied.

## 0.6.0 — 2026-09-26

- Show a connection loss as Offline on phones, desktop and web instead of a folder failure: Tailscale turned off, an interrupted transfer, iOS network errors and gateway answers now count as outages, while picker, provider and photo-export failures are reported as local problems rather than a hub outage.
- Keep phones paired when the hub briefly refuses a Tailscale address; only a revoked credential unpairs. The hub now answers such network gating with 503 and a machine-readable code.
- Keep local actions responsive while the hub is slow or unreachable. On the phone, Add files opens its picker at once, and Open and Share never wait behind other actions. Actions that need the hub are disabled while it is unreachable. A file never uploaded can be renamed offline. On desktop and web, restore, select, conflict choice, gallery link and backup acknowledgement fail at once while the hub is unavailable and no longer hold the local queue.
- Let slow links finish transfers: phone blocks get time proportional to their size, desktop uploads shrink their block after a timeout, and desktop downloads stop only when nothing arrives for 60 seconds. Pending phone uploads are no longer re-hashed on every retry.
- Never let a repeated old request change later content: a deletion or write the hub already accepted, sent again after newer edits from the same machine, is rejected or kept as a conflict copy, including after response-cache eviction, restart or history pruning. Durable receipts preserve that protection independently of cached responses. Finished uploads are verified from the bytes stored on the hub, so damage on disk between blocks is rejected.
- Release interrupted snapshot leases and let a device's new snapshot replace its own abandoned ones, so pauses, imports and connection drops no longer end in “Too many active snapshots”. A lost proposal reply followed by another edit from the same machine no longer creates a conflict.
- Leave Offline promptly when the hub returns: desktop connection backoff is capped at one minute and ends on the first successful hub event.
- Stop sheets on the phone from becoming invisible touch traps, let a cancelled share be followed by a new one, and show a Reload screen instead of a blank app after an unexpected error.
- Time out web admin requests and keep a submitting dialog closable. The desktop window shows Start service when its daemon stops mid-session and recovers on its own.
- Fix the replica gallery link, which failed after the hub had already linked the folder.
- Stop re-copying and re-hashing unchanged files on every full reconciliation: a file whose device, inode, size and nanosecond timestamps are unchanged reuses its cached capture, and is re-hashed only once every one to two weeks to catch same-size rewrites on coarse-timestamp disks; the hub also repairs a damaged stored copy then. A restarted hub no longer spends minutes rereading every photo while replicas wait and time out.
- Record each change the hub accepts as soon as it is accepted, so an interrupted desktop sync resumes where it stopped instead of proposing every file again.
- Date photos without capture metadata by their original file modification time, sent by desktop and server replicas, before falling back to the date added. The hub passes each date on to every replica, so desktop and server galleries show the same dates, offline too. Imported Immich libraries no longer pile undated photos into the current month, and undated photos no longer stop the gallery from loading further pages.
- Rebuild the gallery's date rail: it fits the window without scrolling, gives busier months more space without leaving long gaps, keeps year labels from overlapping while always showing the newest and oldest year, lights the viewed month's dot, and shows a date chip beside the dots while hovering, dragging or scrolling. After jumping to a month, scrolling up loads newer photos above it instead of ending the gallery there.
- Fit portrait videos to the viewer instead of letting them overflow the screen.
- Show the date rail while a gallery is still dating new photos, and let a month jump interrupt a page that is still loading. During a long sync the rail was hidden until every new photo had been dated.
- Stop replicas from storing every file twice. A replica now keeps content only in its folders: an upload or download is held in Arca's internal store just until it completes, unchanged files are never copied, hashed or downloaded again, and orphaned objects are collected every cycle and on unlink. Photo previews and video on a replica read the folder. On the pilot this frees about 56 GB on the Mac and 33 GB on Umbrel. Hub history cleanup no longer forces every unchanged file to be re-read, and promoting a replica to hub captures its files into the new hub's store.
- Let a replica delete its local copy when unlinking a folder, through a Delete the files on this Mac option, off by default, inside the usual compact confirmation, which now says the hub keeps the shared folder, its files and history. The folder is unlinked first and each file is deleted only after a fresh hash matches what the hub already has, so a failure can never reach the hub; files excluded by .arcaignore, changed since the last sync or never synced stay on disk, and the confirmation says how many were deleted and kept.
- Make the full backup a mirror of the hub: it keeps what each folder's history setting keeps and prunes what the hub prunes, instead of every version forever, and it no longer stores a second browsable copy of every file. Deleted shared folders stay in existing backups and recovery is unchanged. On the Umbrel pilot this removes about 25 GB of duplicates.
- Show a full backup's progress: the sidebar says Backing up… and Settings shows how many history revisions have been copied. A backup interrupted because the hub is unreachable now waits for it instead of reporting Needs attention, and hub folders not counted yet no longer show 0 files.
- Keep an Umbrel hub backup across container recreation: the package mounts `/data/backup`. In Docker a backup must now be on a mounted folder, an empty existing folder is accepted for a new backup, and a backup whose data vanished says so and can be restarted in the same empty folder. A missing backup location is never recreated, and a backup never restarts on an empty mount point whose disk is not mounted.
- Keep a thumbnail for every photo so the gallery scrolls without waiting: thumbnails are generated for the whole folder first and never evicted by large previews, which now fill only their own budget, newest photos first. Previously large previews pushed out about half the thumbnails.
- Use the accent colour for the gallery date chip, matching primary buttons in dark mode.
- On phones and the Fold, show folder summary values (status, files, last completed, history) at the row-title size instead of an oversized 20 dp.
- Give every dialog one type scale and layout: 16 px titles, 13 px text the size of their buttons, the same padding and icon tile, a red tile only for destructive actions and the filled red button for every destructive action.
- Give every dialog the same width: confirmations, restore, pairing, recovery and approval now use the default 480 px, and only conflict comparison, the .arcaignore editor and Destroy use the single wide size.
- Show Scanning and Syncing in the accent colour in the folder Status card and machine rows, as the sidebar and phone already did. The separate blue state colour is gone: a detected Arca and the Backs up hub tag are neutral.
- Remove JPEG-to-HEIC library conversion (Optimize space). The macOS encoder rewrites colour profiles and XMP and rounds GPS, so verification rejected almost every real photo, Windows had no encoder, and lossy recompression contradicts keeping originals. Regenerate previews stays; the Docker image no longer installs heif-enc.
- Show previews for JPEG files saved with a .HEIC name instead of failing to decode them.

## 0.5.6 — 2026-09-25

- Make the desktop update card more compact, with a neutral border matching the sync card, a single available-version heading and a small secondary Update and restart button.

## 0.5.5 — 2026-09-23

- Keep folder copy badges focused on machine roles: Hub, Replica, Album source and This machine. Stale reports or an unavailable hub no longer replace those roles with Last reported; revoked access and the shared cached-list explanation remain explicit.

## 0.5.4 — 2026-09-23

- Update the packaged desktop application from inside it. A card appears at the bottom of the sidebar only when a signed update exists, showing the current and offered versions, and one action downloads it, installs it and restarts the app. Checks run at startup, every six hours and on reconnection, and stay silent when the manifest is unreachable.
- Stop the local daemon before installing a desktop update and start it again from the new files, because it runs the bundled runtime from inside the installation being replaced. The payload is downloaded and verified first, so a network failure never interrupts synchronization. Only a daemon for this state directory is stopped; an unreadable lock or process listing, or a daemon that cannot be identified, refuses the update. A loaded Launch at login agent is unloaded during the install and loaded again afterwards. The daemon stays marked for restart until it answers again, and the Daemon stopped page explains a failed restart. Offer Debian installations their own package rather than an AppImage they would reject.
- Sign every desktop payload with the release key and publish a rolling updater manifest after each release; a manifest missing any platform is refused rather than published. The browser interface is unchanged.
- Report the desktop version from one constant instead of two literals that could drift apart.
- Show the sidebar's Last sync line only when the machine is not up to date. The tray offers Open Arca only while the main window is hidden or minimized, closes after Sync now or Pause succeeds like any menu, closes on a click anywhere outside it even when another app was active, and drops its footer note about quitting.

## 0.5.3 — 2026-09-23

- Give each release artifact its own workflow: `publish` builds the desktop installers and the GitHub release, the new `publish-docker` ships the image after that release and records the version it published, and `publish-site` is unchanged. A pull request touching the image or its verifier smoke-tests it without pushing.
- Run the phone app's tests on Ubuntu only. They exercise sync logic that ships to phones, so a macOS or Windows runner proves nothing about it and made desktop releases wait on unrelated failures.

## 0.5.2 — 2026-09-22

- Move the phone app to Expo SDK 57 with React Native 0.86 and React 19.2.3, realigning every Expo package. Copy and move now await the asynchronous file API, the gallery reads the media library through its legacy entry after the object-oriented rewrite, and the iOS deployment target rises to 16.4. React Native ships the corrected Gradle toolchain plugin, so the postinstall patch is gone. Restore the full-screen overlays after React Native removed `StyleSheet.absoluteFillObject`. A new mobile binary is required.

- Add verbose desktop packaging diagnostics and limit the macOS retry to packaging the already compiled application; persistent errors still fail the release. Allow the hardened embedded Node runtime to load its third-party native image libraries, fixing the packaged sharp Team ID validation failure.

## 0.5.1 — 2026-09-22

- Give each environment its own commands: `apps/desktop` now owns `start`, `start:clean`, `ui`, `build`, `release` and `verify:bundle`, and the repository root keeps only the daemon, tests and site. Release pipelines and documentation use the relocated commands.

## 0.5.0 — 2026-09-22

**Alpha prerelease — stabilization and user acceptance are still in progress. Not release-qualified.**

- Add a persistent global mobile Offline indicator; recognize LAN reachability failures and keep saved Machines and recent History available across offline cold starts, with bounded metadata preparation during sync.

- Show Offline once in the desktop sidebar rather than on every folder. Prepare bounded recent History metadata during replica sync for offline browsing and refresh it when folder retention changes.

- Prevent mobile Folder actions from crashing during its closing animation after a local folder or album link is removed, including shares already deleted on the hub.

- Pin the DOM test dependency to a version supporting the CI Node 24.14.0 runtime.

- Close snapshot worker SQLite handles before reporting completion, preventing a Windows file-lock race during immediate cleanup.

- Align desktop, daemon, CLI, Expo and native module versions at 0.5.0; advance the mobile native build number to 24.

- Prevent large sync snapshots from scanning newer revisions for every deleted entry; use the path-key index for replacement lookups. Read-only Casa diagnostics reproduced the expensive query behind prolonged HTTP unavailability; deployment of the fix remains pending.

- Capture sync snapshots in the existing worker, share overlapping captures of unchanged folders, and persist independent authenticated snapshots in bounded batches so HTTP remains available. Preserve content during concurrent retention and clean up interrupted snapshot construction.
- Index conflict summaries, calculate cold folder totals cooperatively, and stream upload/download hash verification instead of blocking the HTTP thread. Add an isolated Docker-capable hub load qualification command.
- Persist snapshot entry counts instead of recounting every page; index only live files for visible totals, distinguish sync entries from existing files in progress, and aggregate retention summaries in one traversal. Preserve deletion propagation and independent per-folder history policies when retention changes.

- Preserve newer successful connection state when an older remote view times out; finish mobile full verification across yielded transfer turns and stop gallery batches on connection loss without failing remaining photos.

- Keep offline, paused and folder-sync indicators consistent across desktop/web and mobile; ignore optional event-channel failures when determining connectivity and prevent late failed requests from overriding newer successful connections.

- Add shared keyboard-accessible tooltips and compact ghost sync controls; hide manual sync while a cycle is running.

- Avoid brand-animation flashes from brief requests and background status checks.

- Keep folder-total caches across unrelated database activity and stop repeated per-folder waits after a hub connection failure.
- Reuse each folder's ignore policy during hub reconciliation instead of querying and checking the policy file for every indexed entry.
- Serve replica galleries and known catalogs locally; retain bounded saved machine/history views with explicit offline feedback.

- Consolidate desktop/web synchronization controls in the sidebar status card, with aligned Pause/Resume and Sync now icon buttons, tooltips and a last-sync timestamp; a backup status row links to configuration or reported copies.

- Wake replica synchronization and open desktop/web galleries on hub changes, retaining periodic fallback checks.
- Reuse mobile hash verification across cold starts, reduce idle inventories and reports, and give folders bounded transfer turns.
- Keep lifecycle cancellation out of folder errors, preserve last successful sync, and avoid replaying stale connection alerts at startup.
- Transfer mobile file blocks through native file I/O with real request cancellation; updated Android/iOS binaries are required.

## 0.4.13 — 2026-09-21

- Rework the site footer: the brand keeps the version beside it using the shared masthead style, the tagline is gone, and the credit reads "By Satoshi Ltd. · no telemetry" with the company linked.

## 0.4.12 — 2026-09-21

- Fix Windows gallery and orientation tests by reusing immutable image objects and using separate fixture files for each orientation, avoiding overwrites of files retained by image readers.
- Restore the mobile gallery's Pending uploads preview row with tappable thumbnails, remaining count and upload/error markers.
- Drain outstanding UI requests before closing onboarding and conflict-review test windows, fixing the CI teardown race.

- Preserve every edge pixel when orienting JPEGs for HEIC conversion, without an intermediate lossy encode. Verify repeated optimization, passive-replica delivery, JPEG history restoration and retention cleanup.
- Keep optimized-photo native source references in the mobile gallery cache, prefer local HEIC previews and refresh open galleries while foregrounded. Clarify that optimization reports photo-size reduction rather than immediately freed disk space.

- Group gallery inventory and image-maintenance actions in one hub Settings card, with progress bars and processed counts beneath each action title. Keep row height stable while running, replace Start with Stop process in the same position, and simplify Optimize space copy without per-file skip logs. Keep conversion details in the JPEG replacement confirmation.

- Fix HEIC analysis on Linux: use the fast encoder preset, preserve orientation through a lossless JPEG transform, read embedded TIFF metadata directly and verify decoded dimensions. Show the active file, processing stage and elapsed time; preserve expanded errors while polling.

- Add hub Settings → Images with gallery photo/video counts, sizes, background preview regeneration and cancellable JPEG → HEIC optimization after a measured sample and explicit confirmation. Skip changed files, collisions, metadata mismatches and savings below 10%; reuse the durable rename journal and preserve retained JPEG history. Include the Linux encoder in Docker.
- Resolve accepted gallery photos to the linked phone’s unchanged native original, including hub-optimized HEIC derivatives; replicas use compatible previews.
- Align release manifests at 0.4.12 and mobile build 23.
- Show linked mobile albums in folder machine lists as Album source, separately from complete working copies.

- Decode HEIC/HEIF gallery previews with a bundled libheif WebAssembly worker on desktop/server, retaining original bytes and bounded JPEG caches.
- Display compatible HEIC previews in mobile; fall back to cached/hub previews when native thumbnail conversion fails.

## 0.4.11 — 2026-09-21

- Animate desktop section/folder navigation only on route changes; slide photo information in/out and add Command-I / Control-I within the viewer. Respect reduced-motion durations.
- Keep the mobile photo viewer toolbar visible when tapping or swiping; always show Info, Share and Delete, disabling unavailable actions without hiding them. Preserve double-tap zoom and system-gallery deletion restrictions.
- Remove confirmed desktop gallery deletions immediately from the grid and viewer; keep deleted revisions hidden across stale hub responses and app reloads while allowing newer restored revisions.
- Keep desktop navigation independent of pending mutations, queue writes with per-control feedback, preserve scroll during structural polling updates and patch folder counters in place.
- Keep mobile navigation and summary refresh independent of synchronization; interrupt stalled transfers for local rename, deletion and import with regression coverage.
- Yield during daemon transfer I/O and integrity checks, and reuse unchanged folder totals without weakening durable writes or exclusion handling.
- Share motion tokens between desktop and mobile: 120 ms fast, 200 ms enter and 140 ms exit with one easing curve and the touch push distance, all collapsing to zero under system reduce-motion settings.
- Use conventional navigation motion: desktop and web navigation uses a brief content entrance, mobile tabs cross-fade, and mobile details push in from the right and return from the left.
- Animate mobile sheets like the platform bottom sheets: the panel slides up from the edge with a fading backdrop and slides back before unmounting; centered dialogs fade and scale. Replace system alerts with an in-app confirmation dialog that mirrors the desktop layout: icon tile, title, description, Cancel and a destructive or primary action.
- Stabilize desktop motion: dialogs and menus animate on entry and close immediately, full-screen photos never scale or fade again during preview upgrades, and updated notices retain expanded details without replaying their entrance.
- Align release manifests at 0.4.11 and mobile build 22.


## 0.4.10 — 2026-09-21

- Unify mobile and Fold photo folders into a chronological gallery for source phones and downloaded copies, with cached hub metadata, local thumbnails and bounded remote previews. Preserve loaded pages during refresh and the current viewer session when new photos arrive.
- Add a full-screen mobile photo viewer with swipe navigation, pinch and double-tap zoom, local sharing and confirmed deletion for ordinary working copies.
- Read JPEG capture details locally and organize photo information into cards for file details, camera, exposure and location, with a phone sheet and Fold side panel. Keep metadata loading recoverable after closing the panel. Original photos remain unchanged.
- Share filename-based gallery date handling between the daemon and mobile. Improve Android LAN network selection and stale-handle recovery; bound device discovery waits and build ARM64 development APKs. Native networking changes require a rebuilt mobile binary.
- Align release manifests at 0.4.10 and mobile build 21.

## 0.4.9 — 2026-09-20

- Open gallery folders directly in Gallery, bypass unrelated folder-history reads and retain Exit gallery access to files.
- Prepare bounded thumbnail and large-preview caches on hubs and desktop replicas; serve local large JPEGs as binary images and show thumbnails immediately while neighboring photos preload. Original files remain unchanged.
- Refresh desktop/web gallery contents in the background while preserving scroll and active interactions. Persist bounded gallery pages and thumbnails across app sessions.
- Add offline mobile/Fold gallery browsing for synchronized working copies, including nested photos from other devices, with local thumbnail generation and persistent view caches. Mobile binaries must be rebuilt for the image-manipulator module.
- Move Android build commands into apps/mobile, check release versions before building and exclude generated APKs from EAS archives.
- Route every Android build through one shared script: `build:dev`/`build:prod` on EAS cloud, `build:local:dev`/`build:local:prod` on this machine, with development builds installed on the connected device or emulator. Force LF line endings on every checkout and keep mobile build tooling tests out of the root CI suite.
- Align release manifests at 0.4.9 and mobile build 20.

## 0.4.8 — 2026-09-16

- Publish verified installers through a GitHub draft release and Docker images directly to Docker Hub. Remove intermediate Actions artifacts and GHCR publication; preserve same-commit retries and existing site download URLs.

- Fix a Windows CI navigation-test race: wait for history actions to finish before toggling filters again, with delayed-response regression coverage.

- Update core GitHub actions to Node 24 runtimes.

- Fix the Windows test failure introduced in 0.4.7: accept CRLF when extracting the UI refresh function and exercise LF/CRLF in every runner.

- Keep folder/file information sidebars sticky in desktop/web and Fold two-column layouts, with internal scrolling when needed. Move detail summaries with the main content; preserve ordinary scrolling on compact phones.
- Move app version and diagnostics into Service. Show the installed mobile version, build and runtime information; remove maturity suffixes from Settings versions and the site header.
- Add persistent mobile text-size preferences using the same segmented control as Theme, while respecting system accessibility settings.
- Align Fold/tablet Settings descriptions on the left and controls on the right, retaining stacked controls on phones.
- Include the shared file-icon registry in EAS archives to fix production Android bundling, with regression coverage for shared build inputs.
- Align all version manifests at 0.4.8 and mobile build 19.

## 0.4.7 — 2026-09-15

- Keep mobile file opening, sharing and menus available during background sync; release the foreground action lock for manual sync, selection downloads and resume.
- Coalesce mobile status reads, retain unchanged UI snapshots, memoize file browsing and yield during directory scans. Reduce unrelated desktop/web detail refreshes and preserve focused input fields.
- Retry interrupted mobile HTTP reads once and show a readable connection error; never automatically replay ambiguous writes.
- Remove the repeated folder name from file headers across desktop, web, mobile and Fold; retain it in File location.
- Tighten mobile and Fold folder/file detail navigation spacing while preserving the Back touch target.
- Unify small button and header tile tokens across desktop and Fold, make mobile icon buttons square, and show folder file-count summaries instead of duplicated desktop header paths.
- Share Lucide file-type icons across web, desktop and mobile headers and file lists; show folder icons in Fold headers.
- Place Fold file search beside Files/Recent, preserving compact header placement.
- Simplify compact Android file headers to a single Arca activity icon without the folder subtitle; use smaller folder/file title tokens and align folder summaries beneath their names. Preserve Fold/tablet and iOS layouts.
- Show a clear local-network connection message instead of native bridge exceptions when mobile LAN routing is unavailable.
- Exclude macOS `.localized` metadata and Obsidian `.obsidian` settings, plugins and themes by default across daemon and mobile sync; preserve notes, attachments, existing disk files and history.
- Fix Android APK opening: declare installation-request permission, use the APK MIME type and explain how to authorize Arca in system settings. Installation remains user-confirmed by Android. Requires an updated native build.
- Add regression coverage for the permission prompt and explicit settings action.

## 0.4.6 — 2026-09-14

- Order photos and videos together by capture date. Repair previously indexed video dates while preserving dates provided by phones and original files.
- Keep later folders accessible in the tray and preserve scroll position during status updates.
- Support composed and decomposed accented filenames in sync and renaming, preserving local spelling and rejecting ambiguous Unicode collisions.
- Show the complete folder error when selecting Review, including the affected path.
- Add Open to mobile file details and move Share into the actions menu. Older installed clients explain when a new app build is required.
- Move desktop Open in Finder into the actions menu and add a divider above Delete file, matching mobile.
- Add regressions for gallery chronology and index repair, tray navigation, Unicode sync, error review and mobile file actions.
- Align release identifiers at 0.4.6 and mobile build 17. Mobile Open requires an updated native binary. Physical Samsung Fold scaling remains under investigation.

## 0.4.5 — 2026-09-14

- Add file renaming across web, desktop and mobile, with portable-name validation, collision protection, stale-content checks and case-only rename support. Retained history remains under the previous name.
- Journal hub renames and recover the destination before removing the source; support catalog-only hubs and offline mobile renaming of synchronized files.
- Group Rename and Delete in a header ellipsis menu across clients. Use an anchored dropdown on mobile, keep View folder visible in File location, and support outside-touch and Back dismissal.
- Refresh the single-page website with concise product copy, five setup points and ten practical FAQs. Fold storage ownership into the benefits section.
- Replace the setup diagram with illustrated laptop, phone, tablet and server devices, subtle transfer animation and reduced-motion support.
- Add API, sync, recovery, web-menu and mobile-layout regressions.
- Align release identifiers at 0.4.5 and mobile build 16. No deployment, native installation or publication workflow changes.

## 0.4.4 — 2026-09-14

- Preview the first three seconds of a video silently on mouse hover in desktop/web Gallery. Stop on pointer exit, scrolling or navigation, and respect reduced motion.
- Start video playback when opening the viewer, retaining manual controls when browser autoplay policy blocks it. Open every photo/video with Info closed.
- Keep last-known folder files and revisions visible while refreshing. Scope bounded session caches by machine, folder and query, and preserve known data when refresh fails.
- Retain mobile local file lists and Recent revisions during refresh; prevent delayed reads from replacing another folder’s contents.
- Replace the top loading line with the shared Busy inside the Arca logo. Keep its green rounded tile and replace only the inner glyph on desktop/web, Fold sidebar and narrow mobile headers.
- Wait for onboarding UI completion in its regression test, including delayed server replies, before closing the test window.
- Align release identifiers at 0.4.4 and mobile build 15. No storage conversion, automatic mobile publication or workflow changes.

## 0.4.3 — 2026-09-13

- Fix the Tauri gallery regression test clicking before folder-detail loading completes; retain delayed API responses to reproduce the Ubuntu timing race locally.
- Align release identifiers at 0.4.3 and mobile build 14. No application behavior or publication workflow changes.

## 0.4.2 — 2026-09-13

- Bound mobile response-body reads by the request deadline and preserve connections when an unfinished authorization response is cancelled.
- Verify that bundled FFmpeg actually runs during runtime staging and packaged desktop checks.

- Publish mobile machine names before file transfers, isolate manual renaming from sync cancellation, and show failures to update the hub instead of a misleading success notice.

- Coordinate desktop development restarts with the matching macOS login service, preventing KeepAlive from starting a competing daemon.
- Add `dev:clean` for Vite-cache-only development startup and check the UI port before replacing the local daemon.

- Prepare existing gallery folders in the background on activation and hub startup: persist capture metadata and thumbnail preparation, resume unfinished work, reuse derivatives and coalesce duplicate preview requests.
- Reuse gallery pages across desktop/web navigation with background refresh and catalog/write invalidation. Reserve separate thumbnail/large-preview pools so browsing full-size photos cannot evict the grid, retaining the total 64 MiB memory budget.
- Play gallery videos through authenticated byte-range streaming, independently of poster generation. Native playback uses short-lived, file-scoped loopback tickets; closing or changing the viewer stops playback. Browser/OS codec support still applies; unsupported formats retain original download.
- Add authenticated first-run server setup, an Umbrel code-access gateway and packaging templates, and use 17831 for new installations. Existing configured ports remain unchanged. Umbrel templates still pin the published 0.4.1 image until release packaging updates it.
- Add explicit hub destruction with recoverable cleanup journals, offline replica reset/unlink behavior, and cancellation isolated to the active sync operation. Preserve confirmation and file-loss boundaries.
- Keep Docker container port aligned during upgrades and allow `ARCA_PORT` to preserve an existing external client address.
- Use shared desktop tokens for onboarding dimensions and simplify retention maintenance work.

- Upload desktop/server replica files in bounded batches of three, negotiate blocks up to 8 MiB with the hub, deduplicate identical blobs within each batch and keep ordered publication, pause and resumability.

- Generate cached video poster frames, keep a visible video badge in the gallery and use the shared Busy indicator while loading/indexing. Bundle FFmpeg for desktop and install it in the hub container.

- Add local Android development build/install for the Fold emulator and a locally compiled, EAS-signed production APK command, without cloud build usage or automatic Metro startup.

- Keep Android photo uploads running after leaving the app using a foreground data-sync service, Headless JS, progress notification and Pause. Release the service and wake lock when finished; respect Android timeouts and preserve resumable transfers.
- Hash private Android files natively and avoid hashing freshly prepared gallery originals twice. The hub still verifies uploaded content before acceptance.
- Continue queued gallery batches during an active Android transfer without repeatedly forcing a full album scan.
- Retain a bounded 64 MB gallery preview cache across desktop/web navigation, share concurrent reads and let the selected photo load without waiting behind queued prefetch.
- Enable gallery view for ordinary shared folders from hub or selected desktop replicas, without changing files or sync mode.
- Align version 0.4.2 and mobile build 13. A new Android binary is required; physical Samsung/background qualification is pending.

## 0.4.1 — 2026-09-12

- Rename the main workflow to `publish` and connect `publish-site` to successful main-branch runs. Deploy the exact validated commit, exclude pull requests and failed/cancelled runs, and restrict manual site deployment to main.

- Fix clean CI installs: declare the mobile gallery hash dependency in root devDependencies so the root test suite can load mobile-replica tests without an Expo installation.

- Request web administrator access from authorized machines using the shared confirmation modal on desktop/web and mobile.
- Reproduce the access design with one segmented login card, grouped comparison reference, ten-minute countdown and browser/IP/request details; mobile approval uses the shared bottom sheet.
- Add explicit per-machine web-approval permission, expiring browser-bound requests, Allow/Deny, cancellation, rate limits and one-time session redemption.
- Close pending prompts when another machine responds; retain shell login codes for initial access and recovery.
- Align manifests at 0.4.1 and mobile build 12. Foreground delivery uses polling; background push and deployment are not included.

## 0.4.0 — 2026-09-11

- Add upload-only mobile gallery sources with verified conversion, resumable photo uploads, edited-photo revisions and native gallery export support.
- Add desktop/web Gallery mode with date grouping, timeline navigation, selection/deletion, adjacent-photo prefetch and EXIF information.
- Add per-folder revision retention: Off, 1 day, 1 week, 30 days (default) and Forever, with confirmed cleanup and replica policy display.
- Fix delayed object cleanup, gallery/source recovery and disconnected tray feedback; expand synchronization regression coverage.
- Unify folder/history copy, retention summaries and shared loading scaffolds across desktop/web and mobile.
- Align application versions at 0.4.0 and mobile native build numbers at 11. Updated native clients are required for native changes; physical-device qualification remains open.

## 0.3.8 — 2026-09-10

- Fix Windows development-launcher test cleanup: remove the isolated runtime asynchronously with bounded retries after stopping the daemon, allowing executable/file handles to be released. Persistent cleanup errors still fail the test.
- Make desktop/web main-view navigation immediate using current data while status and view-specific reads refresh in the background. Fetch discovery/roster concurrently, coalesce equivalent reads, cache history by scope/filter and retain updating feedback without locking navigation. Reject stale responses and preserve active settings edits.
- Fix Windows browser tests leaving ESM imports inside JSDOM when checkout uses CRLF. Accept both line endings and exercise CRLF on every runner; release jobs and build dependencies are unchanged.
- Add Arca identity to phone screen titles, align Fold sidebar branding with the main header and unify root-header height.
- Share section, list-row and touch typography tokens across phone/Fold and desktop. Group headings with their content, remove empty sections and keep row heights stable with or without actions. Preserve touch-sized controls and desktop-scale Fold titles.
- Align all release manifests at 0.3.8 and mobile native build numbers at 10.

## 0.3.7 — 2026-09-10

- Reduce notification noise: group hub connection/access failures, distinguish permissions from sign-in, remove redundant setting/export/busy notices and show an empty folder selector in context. Restore actions share Show links, including above mobile sheets.
- Use authoritative hub conflict resolution and revision markers so resolved conflicts disappear and new conflicts can notify while previous ones remain.

- Normalize web, desktop and mobile notices through one shared contract and token set: info/warning/error, three-item stack, four-second info timeout, stable incident dismissal, text actions and collapsed Details/Copy. Preserve native mobile confirmations.
- Match desktop confirmation and empty-state composition to the notification reference. Route mobile operational errors through the shared component instead of duplicate alerts.
- Use common condition copy for background system alerts; deduplicate by condition/folder, suppress foreground/completed-sync notifications and delay unreachable-hub alerts by one minute. Add mobile notification destinations and native clipboard support. Add desktop OS activation/action callbacks for macOS, Windows and Linux; clicking opens the corresponding screen and the explicit Retry now action requests synchronization.
- Align release manifests at 0.3.7 and mobile native build numbers at 9. Native clipboard and notification changes require rebuilt clients; no deployment or pipeline changes.

## 0.3.6 — 2026-09-10

- Stabilize mobile single-line input height before text entry, including icon fields and accessibility font scaling. Share explicit 48-dp mobile control sizing alongside desktop 32-px controls and enforce token parity.

- Apply the supplied desktop/mobile onboarding composition through shared design primitives, preserving the desktop step order and mobile pairing/first-folder flow. Mobile uses open welcome rows, grouped code cells, selection checks and bottom progress indicators; destinations remain app-owned.
- Standardize separate list-card spacing at 12 logical units across desktop/web and mobile through a shared token with automated parity coverage. Apply it to folder lists and selectors, including mobile onboarding; keep grouped rows contiguous and section spacing independent.
- Match desktop onboarding proportions and typography to the supplied reference, with leading feature icons, left-aligned code cells and separate capacity cards; visually review all five screens.
- Persist accepted pairing before catalog retrieval, resume unfinished setup safely and defer automatic synchronization until setup completes. Validate empty/new desktop roots and preflight aggregate mobile download space.
- Cover code expiry, concurrent single-use redemption and setup recovery; retain persistent guessing budgets and verified transport requirements.

- Make `npm run desktop` replace the local daemon with the current checkout before opening Tauri, preserving files, pairing and pause. Wait for daemon readiness; leave first-run initialization to onboarding and keep installed-app closing behavior unchanged.
- Add Destroy replica to desktop and mobile Settings with a concise Danger zone card and an explicit irreversible confirmation; desktop lists the affected local paths. Keep Disconnect unchanged.
- Remove the replica's hub registration and permanently delete its local folders, unsynced changes, configured desktop full backup, credentials, indexes, queues and caches. Preserve hub content/history, other machines and unrelated local files.
- Resume interrupted cleanup through durable deletion intent, reject changed desktop folder identities, and prevent normal synchronization while destruction is pending.
- Return to first-run setup with a fresh desktop identity/credential or cleared mobile pairing and settings. Support configuring the existing daemon again through its native bridge or authenticated web setup.
- Align all release versions at 0.3.6 and advance mobile native build numbers to 8. Expo builds remain manual; these changes are prepared locally and have not been deployed.
- Validation: 223 tests passed, one platform skip; desktop web build, Android/iOS JavaScript exports, Rust compilation checks and release-version agreement pass.

## 0.3.5 — 2026-09-10

- Fix stale proposal retries, incomplete backup restoration, hub local-copy reselection and corrupt object repair while preserving local edits and retained backup content.
- Isolate pending failures by folder on desktop/server and mobile; prevent incremental cursors from skipping unpublished revisions.
- Support safe file/directory transitions and case-only renames, including repeated renames, history and excluded local content. Require the new `pathTransitions` capability: update hub and replicas together.
- Persist pause and its optional deadline across daemon restarts. Report invalid exclusion policies per folder, bound failed watcher retries and identify nonportable filenames without accepting incomplete inventories.
- Reconcile removed remote exclusion policies, discard obsolete mobile pending deletions, flush desktop conflict copies before removing originals, and verify folder relocation through private staging with failure cleanup.
- Prevent promotion while the previous hub returns any HTTP response. Consolidate the audit into SPEC and regression coverage; remove the duplicate findings report.
- Align desktop, mobile, native modules, runtime versions and lockfiles at 0.3.5; advance mobile native build numbers to 7. Release pipeline remains desktop/Docker; Expo builds remain manual.
- Validation: 207 tests passed, one platform skip; desktop web build and Android/iOS JavaScript exports passed before the version-only bump. Native-device, cross-platform and sustained-operation qualification remain open. These local changes have not been deployed.

## 0.3.4 — 2026-09-09

- Remove automatic Expo/Android builds and the required APK artifact from release publication. Keep macOS, Windows, Linux and Docker builds; mobile EAS builds remain manual.
- Remove the unused APK collector and correct release notes and documentation so publication no longer requires Expo credentials.
- Align desktop, mobile, native modules, runtime versions and lockfiles at 0.3.4; advance mobile native build numbers to 6.

## 0.3.3 — 2026-09-09

- Fix Windows incoming-share integration fixtures by converting file URLs with Node URL helpers; cover source names containing spaces, `#` and `%`.
- Read production website release metadata from `site/release.json` by default, matching the release lookup. Explain missing metadata and document production preparation and local preview commands.
- Add isolated site-build coverage for default metadata, explicit overrides, missing files and preview mode.
- Align desktop, mobile, native modules and runtime versions at 0.3.3; advance mobile native build numbers to 5.

## 0.3.2 — 2026-09-09

- Add the first static Arca landing page, with responsive product illustrations, accessible CSS motion, macOS-first desktop downloads, mobile store destinations/direct APK and Docker setup.
- Generate download links and release notes from published GitHub assets; add automatic Cloudflare Pages publication after successful releases and an EAS Android release artifact. Store URLs currently use user-requested generic destinations until configured.
- Show ordinary revisions by default in desktop/mobile History, with separate conflicts and deleted filters. Simplify unverified-state copy and clarify mobile synchronization errors.
- Fix a macOS CI test teardown race by waiting for conflict restoration and its UI refresh to finish.
- Align versions at 0.3.2 and mobile native build numbers at 4. Cloudflare deployment and the new EAS release workflow still require live qualification.

## 0.3.1 — 2026-09-09

### Synchronization and file operations

- Synchronize empty directories across hub, desktop and mobile, with safe non-recursive removal and file-only counts.
- Scope replica History to selected folders still shared by the hub; handle unavailable history explicitly and allow confirmed mobile copy removal offline, including orphaned shares and unsynced local changes.
- Add confirmed, restorable file deletion on web/desktop; protect stale or unsynced file content on desktop/mobile. Yield background scans/transfers for interactive operations and schedule propagation after delete, restore and conflict resolution.
- Apply current exclusion rules to browsing and counts while retaining existing disk content and history.

### Mobile and interface

- Make incoming sharing transient: cancellation discards unsaved temporary copies. Allow correcting incompatible sender filenames before saving; preserve original files and binary contents.
- Unify file details and History across entry points and phone/Fold/desktop layouts; simplify file actions, empty states and synchronization feedback.
- Keep forms visible above the keyboard, allow inline device renaming, and refine shared sidebar widths, role chips, accent colors and disconnect icons.
- Prevent scrolling from dismissing the desktop/web exclusion editor. Give Android launcher and themed icons more breathing room.

### Cleanup and qualification

- Mobile is replica-only; remove full-backup UI/runtime/export support and the internal text editor. Remove obsolete schema/protocol compatibility branches and unused dependencies/helpers; desktop/server optional backup remains supported.
- Align runtime, desktop, mobile and native module versions at 0.3.1; advance mobile build numbers to 3. Docker publication derives its tag from this version.
- Validation: 165 tests passed, one platform skip; focused file-operation/conflict checks passed after the final queue change, Android/iOS exports and desktop frontend build passed, and release manifests agree.
- User confirmed COROS import and Android launcher appearance. Broader native, installer and cross-platform qualification remains open. Current daemon schema/protocol is required; this commit does not deploy or reset existing installations.

## 0.3.0 — 2026-09-08

### Added

- Expo iOS/Android replica with secure pairing, persistent whole-folder synchronization, resumable verified transfers, offline files and independent portable backup.
- Mobile file/photo import, incoming-share inbox and destination selection, existing-text editing, history/restore and OS background/notification integration.
- Desktop/web file explorer with scoped search, breadcrumbs and Files/Recent navigation; shared mobile file detail across explorer and history.
- Bounded blob downloads, explicit local-network HTTP opt-in and native mobile LAN/Tailscale routing.

### Fixed and refined

- Persist conflict resolution and propagate resolved state across clients while preserving both copies; guard unselected folders and stale decisions.
- Protect unsynced mobile content during explicit removal, recover interrupted cleanup and remove obsolete retained-copy states.
- Share built-in system-metadata exclusions across daemon and mobile.
- Align responsive phone/Fold layouts, typography, role chips, Lucide icons, machine identity, sheets and action feedback with the design system.
- Preserve incoming files when dismissing their destination sheet; update mobile icon and splash assets.
- Consolidate project documentation into AGENTS.md, README.md and SPEC.md (including the design system); retain changelog as the version ledger. Expose the private Casa-only deployment helper through npm.
- Remove unused generated Tauri icon variants, the empty root Expo placeholder, old demo/live-smoke helpers and the superseded Ubuntu test Dockerfile; retain active assets and maintained isolated checks.

### Version and qualification

- Align desktop, mobile, native modules and Docker runtime to 0.3.0; advance mobile build numbers to 2.
- Functional alpha: physical-device/native integration, installer acceptance, sustained load and independent recovery qualification remain open. No release or deployment is implied by this entry.

## 0.2.3 — 2026-09-07

- Fix legacy `.arcaignore` exceptions when the template uses Windows CRLF line endings. Preserve existing user rules.
- Cover LF/CRLF migration and isolate the symlink check with an explicit skip when Windows denies symlink creation privileges.
- Local validation: 108 tests passed, one skipped. Hosted Windows confirmation remains pending.

## 0.2.2 — 2026-09-07

### Fixed

- Open temporary content files with write access before flushing them to disk, fixing Windows EPERM errors during scans, uploads and materialization.
- Register desktop test server cleanup before initial synchronization so setup failures do not leave the test process running.

### Validation status

Local suite: 105 passed, one skipped; the regression covers bidirectional transfers under Windows flush restrictions and read-only source files. Windows hosted CI must confirm the fix. Native installer qualification remains open.

## 0.2.1 — 2026-09-07

### Changed

- Unify CI into one workflow: cross-platform tests first, desktop and Docker builds in parallel, then publication after all package checks pass. Pull requests run tests only.
- Limit macOS packages to Apple Silicon; retain Windows/Linux x64 and Docker amd64/arm64.
- Add persistent desktop zoom shortcuts: Command/Control +, − and 0, bounded to 70–150%.
- Use the theme accent for progress bars and simplify the tray header with a compact 24-hour completion time.
- Keep arca as the web login heading, with the server identity beneath it.
- Clarify system notification and backup report labels; show launch-at-login only on supported macOS desktops.
- Clarify recovery prerequisites and last-sync dates; wrap long settings labels and login addresses.

### Fixed

- Enforce the active-backup restriction in hub promotion, and reject known folder errors, pending transfers and unavailable local directories.
- Distinguish pending backup reports from received reports; omit backup size until a completed backup is recorded.
- Bound CI test execution and emit TAP diagnostics; report packaged Node startup failures separately from architecture mismatches.

### Validation status

This remains an alpha. Windows CI failures and downloaded macOS runtime startup require further investigation; these changes do not claim installer qualification. No automatic updater is included.

## 0.2.0 — 2026-09-07

- Initial alpha source baseline: hub/replica synchronization, revision history, optional full backup, shared desktop/server UI, and desktop/Docker packaging workflows.
