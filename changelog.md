# Changelog

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
