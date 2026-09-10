# Changelog

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
