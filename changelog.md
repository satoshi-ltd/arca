# Changelog

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
