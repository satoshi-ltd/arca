# Changelog

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
