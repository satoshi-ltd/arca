# Changelog

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
