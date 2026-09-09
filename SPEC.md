# Arca — specification and roadmap

Updated 2026-09-09. **v0.3.4 · Phase 1: functional alpha, stabilization in progress. Not a qualified public release.**

Read [README.md](README.md) for a human-oriented introduction and [AGENTS.md](AGENTS.md) for contributor instructions. This document owns implementation status, remaining work, technical contracts, operations and the shared design system. Original visual references are not competing specifications.

## Contents

- [Current state](#resume-work-here)
- [Remaining work](#remaining-work-and-task-candidates)
- [Code map](#code-map)
- [Product decisions](#1-product-and-fixed-decisions)
- [Technical contracts](#7-technical-contract-reference)
- [Operations](#operations)
- [Casa update](#update-casa-docker-from-this-checkout)
- [Release setup](#release-setup-and-publication)
- [Design system and interactions](#design-system-and-interactions)

## Resume work here

- Casa deployment is now user-managed (September 9): do not deploy or restart Docker without a new explicit request. Earlier deployment authorization is superseded; deployment records below remain historical evidence. Web and Tauri share `apps/desktop/src`; local Vite changes do not require a Casa deployment. Packaged desktop builds require rebuilding to include updated frontend sources.

- Current work (September 9): v0.3.0 was committed and pushed as `d242b69`. Casa subsequently received the corrected Docker update helper's deployment; it force-recreates the container even when the old image is unavailable for rollback. The directory-sync changes are included in v0.3.1 and were deployed to Casa and the Mac daemon on September 9 (container `916d4cc30b2b`); the user subsequently validated COROS import and icon appearance in an updated Android build. The v0.3.1 interactive-operation daemon changes have not been deployed by this review. Earlier uncommitted/deployment statements below describe their dated reviews.
- Approved task: synchronize real directories, including empty nested directories, across hub, desktop and mobile. The reported `doc/Coros` exists on Casa and contains only excluded `.DS_Store`; previously it vanished from the file-derived explorer. Current implementation and upgrade boundaries are described below. Preserve live files, selections, backup and pause state; do not restart user-managed Metro or build native binaries incidentally.

- macOS Tauri and shared web UI are implemented; Node 24/SQLite daemon and Docker hub are operational. Expo is phase 2; internationalization is phase 3.
- Most recent work: installation separation, deployed to Casa and Mac: desktop is API-only, server retains web. Shared UI role/surface separation and replica disconnect/reconnect are also deployed. The approved incremental scheduler is also implemented and deployed as described below. Earlier deployed work includes hub-only share renaming and `.arcaignore` editor, hash routing, shared copy reports and clearer hub local-sync/delete controls. These changes are deployed to Casa and the Mac LaunchAgent runtime. The macOS bundle was rebuilt and ad-hoc signed; the current desktop runs through Vite development. The pilot deployment and parity check commands below keep these artifacts aligned. Earlier deployed work includes ignore-policy safety, true replica unlink, hub share deletion, previews, notifications and native tray states.
- The September 7 Casa incident was caused by a large hub scan blocking the event loop **and** serializing snapshot reads behind the full cycle. Commits now yield between files; snapshot reads use committed revisions during an active cycle. Eight abandoned Mac snapshot sessions were manually cleared after timeouts. That cleanup was operational recovery, not a new automatic cleanup feature.
- Do not equate a successful status/catalog request with a completed synchronization. Verify selected folders' completion timestamps, content and errors. Pause is user-controlled; do not silently resume it.
- The live pilot uses real user data. Never reset state, unlink shares or run destructive diagnostics to obtain a clean test result. Use isolated tests unless a concrete pilot action is authorized.

## Pre-production review — 2026-09-08 evening

This review supersedes earlier implementation-status claims where they conflict. Conflict resolution is durably recorded and deployed to Casa/Mac; OS background task integration is implemented (the former mobile backup was removed on September 9). The v0.2.3 hosted pipeline succeeded, but does not qualify the current uncommitted mobile/core/UI changes. Older notes about these features being absent or CI never running are historical. No production build, deployment or live data mutation was performed during this review.

Before public distribution:

- Close complete cross-client workflows on isolated fixtures: offline concurrent edits, resolution propagation/reopening, unselected-folder guards, revoke/reconnect, interrupted removal/import and restart. Existing isolated coverage and one pilot conflict are bounded evidence.
- Qualify real iOS/Android networking, suspension/resume, low storage, notification permissions, document/photo import, Save a copy, incoming sharing and the new native icon/splash. The iOS receiving extension remains experimental. Use preview binaries for acceptance, not Metro exports alone.
- Finish the shared component audit: modal headers/close behavior, chips under font scaling, long text/keyboard layouts, empty/error/busy/offline states, focus/accessibility and light/dark phone/Fold/desktop/web screenshots.
- Run sustained concurrent-load and independent backup/recovery qualification. Do not enable the user's pilot backup or change live data as incidental testing.
- Verify clean-install and upgrade behavior of actual desktop packages and mobile binaries. CI success is not evidence that the earlier packaged-macOS-Node SIGKILL finding is closed.
- Add a CI mobile dependency/config/bundle check: current workflow installs only root dependencies and runs Node tests, which cannot certify React Native component bundling or native plugins. Current production EAS output is APK, buildNumber/versionCode are 2 for v0.3.0 and there is no autoIncrement policy. Define store/internal distribution and increasing build numbers before repeated distribution; no publishing is authorized.

Historical September 8 behavior kept incoming files on dismissal. The user's September 9 decision below supersedes this: incoming sharing is transient and cancellation discards unsaved copies. All app-owned Sheet headers now share heading typography and an icon-only Close action, independent of content type; the header stays outside the scroll area. Native system alerts remain system UI.

Evidence: full Node suite 142 passed, one platform skip; after the sheet correction, focused mobile tests and Android/iOS exports pass, and the Shared folder sheet was visually inspected on the existing Android with its unified heading and X; release manifests agree at 0.2.3. Android/iOS exports passed for the icon/splash changes. These checks do not replace physical-device or installer qualification. No new product features are required by this review; long polling, i18n and automatic updating remain separate work.

## Adversarial role and presentation review — September 8

Implemented locally: explicit negative API matrix for replica/backup tokens against hub administration (share creation/deletion/rename/policy, pairing, devices/revocation, settings/network, retention, promotion, backup and pause); replica local administration also cannot create hub resources. Read-only machine roster remains accessible. Existing DOM coverage verifies revocation controls are hub-only. These are authority checks, not per-share ACLs: Arca does not introduce a multiuser permission model.

Corrected mobile scoped search, import destination, recursive folder byte totals, missing breadcrumbs and divergent Recent semantics. Wide folder composition now follows desktop with summary/main/sidebar, compact segmented controls, and wide field sizing; phone remains one column. Native sheets handle keyboard/landscape. Removed address-only Tailscale claims. The design section owns exact composition and copy.

Validation: full Node suite 144 passed, one platform skip; focused role/browse checks passed again after helper cleanup. Android/iOS exports pass. Existing Android phone and Fold browsing/Recent screens were inspected without opening file contents or changing live selections. Actual desktop/web visual inspection is still pending: the Mac was initially locked, then the native Arca surface was unavailable through CUA. No claim of completed cross-platform pixel acceptance, production readiness or physical-iOS qualification. No Metro restart, native build, live conflict/removal/backup mutation, commit or push.

Explorer file-detail regression corrected: mobile Files now opens the same FileHistory component as Recent/History, replacing the reduced local-action card. Back preserves the explorer location and cancels late history navigation; local file actions are available from either origin. Fold was inspected opening README.md from Files, returning to the folder, and opening it from Recent. All history is visible at the right of the explorer toolbar. Latest targeted suite: 43 passed; Android/iOS export passed. These checks do not qualify native share/edit/delete workflows or physical iOS.

## Remaining work and task candidates

| ID           | Status                                       | Work and acceptance evidence                                                                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-SCHEDULER | Implemented and deployed; qualification open | Approved simple design: persistent dirty paths, incremental remote cursors, 15s/60s adaptive checks, six-hour safety reconciliation and cooperative scan interruption. Eight new regression tests pass. Long polling remains proposed; mobile OS background tasks are implemented but device qualification remains open; sustained load and battery measurements remain qualification work. |
| P1-LOAD      | Open qualification                           | Exercise a large hub folder while unrelated replicas upload and receive. Snapshot reads were fixed; proposal/mutation queue latency, pause/unlink responsiveness and abandoned snapshot leases still need sustained-load qualification. Do not claim the whole concurrency problem solved from a status request.                                                                            |
| P1-UX        | Open qualification                           | Validate the actual running native binary: tray transitions, light/dark menu bars, reduced motion, long paths, dialogs, offline startup and error recovery. Generated asset previews and DOM tests do not certify native pixel equality.                                                                                                                                                    |
| P1-RECOVERY  | Open qualification                           | Prolonged soak, physical power loss and an independent real backup/restore drill. Pilot currently has no separate real backup. Keep isolated tests distinct from live verification.                                                                                                                                                                                                         |
| P1-RELEASE   | Pipelines implemented; qualification pending | Optional Developer ID signing/notarization is not a release prerequisite. Release bundle checks and supported desktop distribution validation remain required. v0.2.3 hosted CI built desktop/Docker artifacts successfully; actual installer/runtime acceptance remains open. No commits/push without explicit request.                                                                    |
| P2-MOBILE    | Implemented locally; qualification open      | Expo iOS/Android replica with persistent files, explicit import and OS-aware background work. Physical-device qualification and distribution configuration remain open.                                                                                                                                                                                                                     |
| P3-I18N      | Planned                                      | Localization across clients. English-only product through phases 1 and 2.                                                                                                                                                                                                                                                                                                                   |

For a new task, cite the relevant row and contract, define a bounded outcome, affected code, validation and deployment target. Mark implementation, deployment and validation separately. Do not turn proposals into active tasks or create a Codex task unless the user asks.

## Release pipelines — 2026-09-07

Implemented; hosted v0.2.3 execution succeeded. Signed distribution and complete installer acceptance remain unverified. `.github/workflows/release.yml` automatically builds and publishes a new version on push to main, with manual artifact-only runs retained. An existing remote version tag skips builds/publication; remote lookup failures stop the run. The Release setup and publication section below owns repository setup and signing secret names. Reference reviewed: Alf's desktop/Docker workflows; Arca uses one version rather than independent CLI/desktop release cadences.

Three desktop runners build macOS Apple Silicon (arm64) DMGs, Windows x64 NSIS and Linux x64 AppImage/deb. Version agreement is checked before work; the separate test matrix executes the JavaScript suite before any packaging starts. Package runtime checks mount the DMG, extract both Linux packages or silently install NSIS, then initialize an isolated state and verify the packaged Node daemon's authenticated API and absence of desktop web access. They do not certify the native UI, tray, OS integration or complete cross-machine workflows.

Docker builds and smoke-tests amd64 and emulated arm64, including shutdown/restart and persistent identity/files, then exports a multiarch OCI archive. Publication requires all build/test jobs to pass. The user selected direct-download distribution without an Apple Developer account: ad-hoc macOS and unsigned Windows installers can be published. Developer ID signing/notarization is optional and checked only when explicitly selected; no App Store submission is involved. Following the user's Alf parity correction, it uploads versioned images and latest aliases to both Docker Hub (`satoshiltd/arca`) and GHCR, plus a GitHub prerelease with architecture-labelled installers and SHA256SUMS. Latest currently points to alpha builds; no updater or pilot deployment. Docker Hub uses the same DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secret names as Alf, checked before publication builds. The two registries and aliases are not an atomic publication. The GitHub release is created after image upload; failure between those external operations can leave the image published without a release. Inspect before retrying with unchanged source/version.

Unsigned artifact runs require no custom secrets. Signed macOS builds use Developer ID/notarization secrets and sign the embedded Node executable with its JIT entitlement before the enclosing app. The local ad-hoc post-build hook is not invoked by the release script. Windows signing remains unimplemented; its alpha installer is explicitly labelled unsigned. Launch-at-login remains macOS-only. Runtime staging now includes the Node license on Windows as well. Two filesystem Unix-socket tests are skipped on Windows because Windows named pipes do not exercise that filesystem behavior; coverage remains active on Unix runners.

Local verification: JavaScript suite 101 passed, one case-sensitive-filesystem skip; actionlint accepted both workflows. An isolated macOS arm64 release build produced an ad-hoc signed DMG; mounting that installer, verifying its nested signatures and running its embedded daemon/API and architecture/license checks passed. Installer collection passed, and an isolated mismatched-version fixture was rejected. The release builder explicitly enables CI mode to avoid interactive Finder customization; the first local DMG attempt without it failed. Hosted Windows/Linux/Docker packaging subsequently passed for v0.2.3; optional Apple credentials remain unverified. No commit, push, release, signing-secret access or live pilot deployment was performed.

## Validation record

The September 8 pre-production review above is the current qualification summary. Earlier isolated resilience checks exercised interrupted uploads, concurrent edits, restart and recovery, but do not replace sustained-load, actual installer or physical-device acceptance. The pilot has no separate real backup. Historical passing test counts are not a claim that the current checkout is deployed.

## Code map

| Path                                                                       | Responsibility                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `packages/daemon/engine.js`                                                | Sync cycles, pause/interruption, hub scans, proposals, backup and promotion |
| `packages/daemon/server.js`                                                | Authenticated API, watcher/timer scheduling and web serving                 |
| `packages/daemon/storage.js`, `scanner*.js`, `snapshots.js`                | Durable files/revisions, background capture, immutable snapshot sessions    |
| `packages/daemon/exclusions.js`, `default.arcaignore`, `folder-preview.js` | Rules, optional template and read-only preview                              |
| `apps/desktop/src/`                                                        | Shared desktop/web UI, tokens and tray popover                              |
| `apps/desktop/src-tauri/src/main.rs`                                       | Native bridge, window lifecycle and tray icon states                        |
| `scripts/local/tray-badges.swift`                                          | Reproducible native tray assets                                             |
| `tests/`, `scripts/verify-*.js`                                            | Regression and bounded integration/scale verification                       |

## Scheduling: actual implementation

Automatic working sync now uses a persistent SQLite dirty-path queue and a persistent remote cursor per folder. This replaces the former 3,000ms full-cycle timer; automatic scheduling uses the current scheduler constants.

- Already-ignored local events are discarded using the current policy. Other local filesystem events are deduplicated for 1,000ms and flushed to SQLite in a batch. Only affected paths/subtrees are scanned; deletion checks are restricted to the same scope. More than 2,048 pending paths, unknown event filenames or a root `.arcaignore` change request a complete reconciliation. Events received during work are retained using queue sequence numbers; restarting registers watchers and requests a complete scan, covering the pre-flush crash window.
- Replicas check remote changes every 15 seconds, stretching to 60 seconds after five minutes without activity. Network/operation failures back off from 30 seconds up to five minutes; watcher events do not bypass that delay. Explicit Sync now can retry immediately and requests a full reconciliation. No overlapping cycles; work arriving mid-cycle gets a follow-up attempt.
- Hub idle scheduling checks for due/pending work every 60 seconds without scanning clean folders. Startup, watcher loss and a six-hour safety interval trigger full reconciliation. A missing/failed watcher is retried and conservatively requests reconciliation. The service does not deliberately wake a sleeping device; normal OS suspension pauses timers. Native mobile OS scheduling remains phase 2, not implemented by this desktop daemon.
- `GET /v1/changes?volume=ID&after=REV[&through=REV]` returns up to 500 current file/tombstone rows changed after the cursor, with a fixed upper revision bound and continuation. Catalog capability `changes:true` advertises support. Changes arriving during pagination are fetched on the next check. The cursor advances only after the folder's received work is successfully applied; invalid cursors and policy changes request reconciliation. Full reconciliation and internal backup workers use paginated snapshots. Full backup remains separate from working synchronization.
- Incoming paths outside the local scan are checked before materialization. A missed local edit is queued for upload/conflict resolution without advancing the cursor or overwriting that edit. Local `.arcaignore` validation and concurrent-policy protection remain in effect.
- Pause/unlink/delete interrupt worker scans cooperatively between files and hub catalog work between commits. Partial scans are never treated as complete inventories. A single file copy/hash, an in-flight network request or a synchronous database operation can still delay interruption; no instantaneous cancellation is promised.

The UI/status loop and Tailscale discovery/export remain separate from file synchronization. There are no WebSockets, push service or long polling in this change. Tests verify no scanner call on an empty incremental check, scoped edits/deletions/renames, missed-event conflict preservation, queue persistence, pagination races, ignore-policy reconciliation and real watcher debounce. These are correctness/work-avoidance checks, not measured battery-life claims.

### Proton Drive comparison — research, not implementation (2026-09-07)

The user requested studying Proton Drive before choosing the scheduler redesign. Public source is implementation evidence for the inspected branch, not proof of the exact code shipped to every platform:

- The [SDK guidance](https://github.com/ProtonDriveApps/sdk) recommends Drive events, caching, bounded parallelism and backoff instead of frequent recursive tree traversal. Its [JS event manager](https://github.com/ProtonDriveApps/sdk/blob/main/client/js/src/internal/events/eventManager.ts) polls incrementally using a last event ID, advances it after listeners succeed and increases retry delays. Event-based does not necessarily mean server push; the inspected implementation still polls.
- Windows uses a [local filesystem watcher](https://github.com/ProtonDriveApps/windows-drive/blob/main/sync/cs/src/Proton.Drive.Sdk.Sync.Windows/FileSystem/Client/EventLogClient.cs) carrying paths, identities and change metadata. Watcher failure reports skipped events explicitly. Its [remote event client](https://github.com/ProtonDriveApps/windows-drive/blob/main/sync/cs/src/Proton.Drive.Sdk.Sync.Client/RemoteEventLogClient.cs) has resume tokens, persisted anchors, throttling, pagination and refresh-required handling.
- The [macOS event timing policy](https://github.com/ProtonDriveApps/mac-drive/blob/main/PDCore/PDCore/EventsProcessor/Timing/Domain/EventLoopTimingConstants.swift) varies event polling by application state and volume activity: production constants include 30 seconds for own foreground volumes and 30 minutes for own background volumes. These are specific event-loop policies, not general file-transfer latency guarantees or proposed Arca defaults.
- Proton documents OS-controlled [iOS photo background execution](https://proton.me/support/drive-ios-background-uploads) and [Android battery restrictions](https://proton.me/support/efficiency-photo-backup). Photo backup is not evidence of unrestricted mobile folder mirroring.

Original research recommendation (the simpler incremental schedule above was subsequently approved and implemented): durable incremental remote cursors and a bounded persistent queue of dirty local paths first; inexpensive adaptive event checks next, with long polling considered separately for desktop foreground/daemon use. Local watcher failures, invalid/expired remote cursors and interrupted baselines require reconciliation; never treat an incomplete scan as evidence of deletion. Keep scan cadence, network checks and transfer concurrency independent. Mobile background work must use OS scheduling, with no guaranteed immediate background synchronization. Measure idle wakeups, CPU, disk reads, traffic and recovery correctness before adopting fixed timing defaults. No scheduler code or live settings changed as part of this research.

## Implementation labels

This revision supersedes the earlier automatic-linking proposal. The vocabulary is **Machine** (singular) and **Machines** (plural) in the product. Existing `device` identifiers in code, API routes and CLI commands are compatibility names, not approved product wording.

| Status                             | Meaning in this document                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Implemented / deployed alpha       | Available in the last verified Casa/Mac build. See the design section for current approved presentation. |
| Approved, pending implementation   | Part of the v0.1 target the designer may cover, but must be annotated as pending engineering.            |
| Paused / not in the current target | Must not be represented as a working v0.1 capability.                                                    |

**Implemented:** visible Machine/Machines terminology, separate six-digit web and pairing codes, persisted failure budgets, and an authenticated read-only machine roster. The shared frontend now implements the approved design handoff; platform visual qualification is tracked separately.

**Paused:** automatic machine linking, including the proposed same-Tailscale-owner policy. Detection only identifies candidates; authorization stays explicit in standalone and Tailscale modes. No automatic hub selection, code-free linking or Tailscale web login is promised.

Design scope readiness is separate from implementation completion. v0.1 is not a fully validated production release.

## 1. Product and fixed decisions

Arca synchronizes personal files across hardware owned by one user. It has its own daemon and synchronization protocol: no Syncthing, external account, public relay or telemetry.

- The user chooses one hub: a PC, Mac or server. Ubuntu/Docker is a deployment option, not the definition of a hub.
- **Only the hub creates shared folders.** It may adopt existing folders or create new ones at independent paths. An empty hub can be configured and linked before its first folder exists.
- Other machines select whole shared folders and choose an independent local destination for each. A folder ID identifies the share; its name and source path do not dictate destination paths.
- Existing destination files participate in bidirectional synchronization. A replica can add, edit or delete files; it cannot create a new share.
- Files remain complete on disk, available offline after downloading. No placeholders, on-demand eviction or automatic removal to save space.
- Replica unlink removes its mapping, local index and matching `.arca-volume` marker; ordinary files, `.arcaignore` and conflict copies remain. Pause retains the mapping. Changing an established destination uses explicit copy-and-verify relocation and retains the original.
- Hub Delete share requires the exact name, removes the catalog/history registration, and retains physical files and existing backups. Removing a directory manually does not delete its registration. Hub local-copy unselection is a different operation and retains catalog/history.
- The hub coordinates the catalog, revisions and distribution. It retains full content objects and history even if its visible copy is unselected. The current alpha exposes this option; unselecting never removes the share from the catalog.
- Backup is an optional capability of a desktop/server replica (never mobile), independent of selected working folders. It stores every hub folder and historical revision in a separate dedicated directory while normal bidirectional sync continues. Its backup copy never publishes edits. Full backup uses an internal worker; public daemons and invitations support only hub/replica roles, never a standalone backup machine.
- Restoring a version creates a new revision. Accepted revisions are versioned, not every keystroke or every intermediate save between scans. Deleted files can be restored.
- The public product term is **Machine / Machines**, including pairing and current-machine references. The terminology change does not change roles or permissions.
- All product copy is English during phases 1 and 2. Preserve user names, paths and file contents. Internationalization is phase 3.

Example: the hub creates `iPhone Images`; a desktop subscribes at a path it chooses. In phase 2, an iPhone subscribes inside persistent app storage and can import photos into that share. Photo-library access is an additional permissioned feature, not automatic folder synchronization.

## 2. Components and access

| Component     | Responsibility                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Daemon        | Persistent identity, catalog, local scanning, transfers, revisions, materialization and API     |
| CLI           | Auxiliary installation, startup, diagnostics, web sign-in codes, offline recovery and scripting |
| Tauri desktop | Local daemon administration, onboarding, tray and opening local folders                         |
| Web           | Administration of the daemon serving the page, using the same frontend as Tauri                 |
| Expo mobile   | Phase 2 client with persistent files and OS-aware synchronization                               |

**Web is the primary server administration interface.** Daily folder, machine, backup, history and settings workflows must be available there. Tauri shares those flows while managing its local daemon. The CLI is an auxiliary operational tool, not a parallel product interface: no interactive terminal menus and no requirement to duplicate every screen as a command. Existing scripting commands remain compatible. Installation and offline recovery may require a shell.

The v0.1 functional scope is ready for desktop/web design. The implementation and release validation are tracked separately below; design readiness does not imply production readiness. Expo screens belong to phase 2.

One service port per machine, **47831** by default:

| Path                          | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `/`                           | Web UI                                                        |
| `/auth/login`, `/auth/logout` | Browser session                                               |
| `/v1/*`                       | Authenticated management and synchronization API              |
| `/.well-known/arca`           | Minimal discovery metadata, without file paths or credentials |

Pairing/onboarding no longer ask for a private-network checkbox. For non-loopback HTTP without a explicit trusted-network API/CLI option, the daemon reads current Tailscale status, resolves the hostname and requires every resolved address to belong to a known tailnet peer/self and a Tailscale address range. It pins the request and saved hub URL to a verified IP, avoiding a second DNS resolution when sending credentials. Unknown/mixed addresses or a disconnected tailnet are rejected before sending the pairing code; HTTPS retains normal certificate validation. Pairing, catalog and later synchronization requests reject redirects. Local loopback support and the explicit CLI/API `privateNetwork` option remain supported. This verifies the configured route at connection time, not an independent audit of the operating system or every future network change.

The recovery form removes its redundant reconcile checkbox; explicit entry into replacement-hub recovery and the “Replace hub and reconnect” action still select reconciliation. Normal reconnect never silently switches hub identity. Both flows preserve existing file-consequence safeguards. The disconnected machine badge is static and warning-colored rather than animated blue.

Standalone uses loopback by default; remote HTTP requires an explicitly encrypted private network, or an appropriate TLS deployment. Tailscale mode discovers the local installation and peers and restricts remote access using current tailnet status. It does not replace application authorization. Native loopback and Tailscale bindings can share the same port on different addresses; Docker publishes only the host Tailscale address in the pilot.

Installation and machine role are independent. The desktop runtime is stamped `arcaInstallation: "desktop"` in its package metadata by `stage-runtime.js`; initialization and startup persist `installation: "desktop"` in local config, including existing installations. This migration changes no identity, credentials, selected folders or backup settings. Source/server runtimes default to server for compatibility; a saved desktop installation remains API-only even if started with the source CLI.

Desktop does not instantiate browser sessions or serve UI/assets, `/auth/*`, or `/v1/web-sessions/revoke`; these return 404. `web-code` rejects desktop installations. Browser Origin requests cannot authenticate to its API. Native bearer-authenticated API, discovery, pairing on desktop hubs and synchronization remain available. Server installs retain web UI and browser sessions regardless of hub/replica role. Tauri’s WebView and the explicit Vite development server are not daemon-hosted web administration. The bundle smoke test and pilot verifier check desktop web absence and server web presence separately.

Tauri keeps the local admin credential in its native bridge. Linked machines use individual revocable credentials; folder selection is not a per-folder permission system. Native desktop has no browser session to sign out of: it uses the OS account’s local administrator credential. Quit closes the app while the daemon continues. Browser-session revocation does not unlink a replica or revoke its synchronization credential.

The shared frontend now separates hub authority from replica connection management across every view. `#/machines` displays Machines on both hubs and replicas. Browser sessions are web-only; launch at login and notifications are native-only. Settings puts replica connection first and keeps all sections expanded, including network/service diagnostics and recovery. Disconnected copies remain visible without remote-only actions.

Admin `POST /v1/disconnect {confirmed:true}` is replica-only. It pauses cooperatively, interrupts scanners, waits for the serialized cycle, removes the active hub token and optional backup runtime token, disables optional backup, and retains local volumes, files, indexes and saved destinations. It preserves an existing user pause. It first removes its own hub registration through authenticated POST /v1/leave (no arbitrary device ID), then clears local credentials. The request has a five-second network timeout; failure leaves local credentials available for retry and restores the previous pause state. A hub Disconnect uses the existing admin removal endpoint. A rejected credential (HTTP 401) clears the replica connection at its next authenticated contact. Offline or paused replicas reflect this after reconnecting/resuming; no additional polling is introduced. Historical config checkpoints and hub history are not erased. Waiting for an already running serialized operation can still delay completion. Status exposes `disconnectedHub` with only hub ID/URL and `hubName` from the last authenticated catalog.

Normal reconnect uses a fresh pairing code with `/v1/connect`, retains selections and marks them for reconciliation. Switching hub IDs with saved folders requires explicit replacement-hub recovery; that path clears incremental cursors together with indexes and preserves its recovery checkpoint. Reconnect does not enable backup. UI cancellation, confirmation, retained files, fresh-code reconnect with offline edits, and the web/native × hub/replica context matrix are isolated test coverage. Implemented and deployed to Casa and Mac; see the latest validation evidence for the bounded verification scope.

Web sign-in uses a one-time server-generated code valid for 10 minutes and an HttpOnly, SameSite=Strict session lasting up to 24 hours or daemon restart. Same-origin checks protect browser mutations. No auto-pairing based on discovery.

### Authentication and pairing

| Access             | Implemented behavior                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web administration | Server generates six numeric digits, preserving leading zeroes. Single use; ten minutes from generation. Browser session ends at sign-out, after 24 hours, or on daemon restart. |
| Local desktop/CLI  | Uses the local administrator credential under the OS user's account. Tauri keeps it in the native bridge. No normal manual login step.                                           |
| Machine pairing    | Hub administrator generates a separate six-digit code valid ten minutes. Explicit exchange creates a long, revocable persistent credential.                                      |

Spaces/hyphens are accepted, so `381-924` is a fictional valid-format example. There is one active code per purpose on a daemon; generating a replacement invalidates the previous code for that purpose. Web access and pairing codes are not interchangeable. Administrator, session and machine tokens remain long secrets. Legacy long codes are accepted until their original expiry for compatibility; newly issued codes are numeric.

Cryptographically random generation, expiry and one-time consumption are enforced on the server. Five incorrect attempts against an active challenge invalidate it; failure counts survive daemon restart. Generate a new code after invalidation. Each endpoint also limits requests to five per source address per minute and fifty in aggregate per minute; issuing a new code does not reset these in-memory rate windows. A throttled request returns 429 and a one-minute retry instruction. Invalid/expired/used codes share a 401 response; failure-budget exhaustion returns 429 with a generate-new-code instruction. No remaining-attempt countdown or pre-login expiry timestamp is supplied. The designer owns how to present these cases.

For an HTTPS reverse proxy, configure `ARCA_WEB_ORIGIN=https://arca.example` with the exact external origin. The proxy must preserve Host and restrict access to its backend. Arca checks both Origin and Host and sets Secure cookies; arbitrary forwarded headers do not enable trust. This does not provision certificates or turn Tailscale HTTP into TLS.

A browser page does not mint its own sign-in code, deliver email/SMS, or read SSH credentials. From a terminal with SSH access, the Casa example is:

```sh
ssh casa 'docker exec arca node packages/cli/arca.js web-code'
```

The outer command runs on the SSH client, and `web-code` runs inside the server container. It is an installation-specific example, not a universal command to hard-code for every hub. No real credential belongs in a mockup or document.

### Discovery, explicit pairing and authority

- Tailscale discovery can identify Arca candidates and their reported hub/replica roles. It does not install Arca, choose a hub, authorize a machine, subscribe folders or start synchronization by itself.
- Discovered, unlinked machines appear only after a valid Arca response, including an incompatible Arca version. An incompatible machine is not pairable. Unrecognized tailnet peers are excluded.
- Previously linked Arca machines remain known when offline or not responding. Lack of a response is not evidence of uninstallation.
- Tailscale remains an attribute in one Machines inventory; any grouping must not imply a separate authorization model. Both standalone and Tailscale require explicit pairing.
- **Only the hub administrator can issue pairing codes or revoke access.** The desktop manages its local daemon. A linked replica does not thereby acquire permission to invite other machines on behalf of the hub.
- The existing discovery action can prefill a detected hub address when connecting an unlinked replica. Pairing a discovered replica directly from another replica, remote hub-administration switching and one-click bidirectional pairing are not implemented.
- Creating a credential/invitation is not proof that the recipient has connected. Authenticated contact is separate from issuance, and neither proves selected folders are up to date.
- Connecting to a different hub with existing local state requires explicit replacement-hub reconciliation; discovery never silently switches it.

Removal uses the hub-admin `/v1/revoke {id}` endpoint, now deleting the device row (name, credential hash, last address/contact), machine report, backup acknowledgement, snapshot leases/rows and partial uploads owned by that credential. A missing credential remains unauthorized; no denylist is needed. Queued work rechecks authorization when it starts, and POST requests recheck after reading the body, so a request authenticated before removal cannot recreate reports or uploads afterwards. Already-delivered bytes cannot be recalled.

Physical working files and revision history are preserved. Revisions retain their opaque author IDs for provenance; removal does not rewrite conflict filenames, independent backups, config checkpoints or historical content. This is registration/data minimization, not a claim of forensic erasure or complete anonymity. Removing backup acknowledgement also removes that machine’s retention hold; actual history cleanup remains an explicit preview/apply action.

### Facts that a Machines mockup must not invent

Tailscale connectivity is not TLS. The Casa pilot uses HTTP over Tailscale. Discovery exposes configured network mode and the daemon-side HTTP/HTTPS transport, not proof of browser-side TLS behind a reverse proxy.

`GET /v1/machines` supplies the hub's read-only credential roster to authenticated linked machines and hub administrators. A replica's local administrator can request the same roster through its daemon. It includes current registrations, last authenticated contact, backup acknowledgements and optional machine reports. It does not grant remote administration. Invited and authenticated states remain distinct. Removed credentials are absent; no revoked-machine list is retained.

Reports contain selected-folder IDs and totals, indexed files/bytes, coarse platform, kernel release, daemon uptime, last completed sync and server receipt time. They are self-reported after successful cycles, at most once per fifteen seconds; after two minutes they become stale. Missing reports stay unknown. This is not a live heartbeat, OS marketing-version lookup, whole-disk usage, revision-lag calculation or proof that all remote files match. Credentials and local paths are excluded. The folder detail Copies list uses this same hub roster on web and desktop, plus authoritative local selection. Selection/unlink publish an updated report even while paused; offline failures retry on later cycles. Unknown old-client folder lists remain unknown. Stale or unreachable reports are labelled as last known; they do not prove current file integrity. Unlinked physical files are retained but are no longer reported as managed copies. Additional report counters remain API-only: the approved Machines view follows the hub/self/linked/discovered scope in the visual baseline.

An offline machine can still have backup configured. A backup acknowledgement is the last reported enabled/revision/time state, not a fresh integrity audit or recovery drill. No acknowledgement means unknown, not disabled. Local backup disabled does not mean the network has no backup.

## 3. Phase 1 — desktop, server and web

**Status: phase-1 functional alpha implemented for macOS and Ubuntu/Docker server/web testing.** The approved design is integrated in the shared frontend; public-release qualification remains separate. Implemented does not mean production readiness.

### Available now

- JavaScript/Node 24 daemon and CLI; SQLite WAL; persistent IDs; state lock; SHA-256 content objects and revision index. No TypeScript.
- Full-file uploads in chunks, range downloads, resumable transfer and integrity checks. Serialized sync cycles and a journal for materialization recovery.
- Bidirectional edits, offline changes, conflict copies, stale-deletion rejection, tombstones, history and restoration.
- Hub-only folder creation, independent local paths, `~/` expansion, existing-folder adoption and unselection retaining files.
- Desktop Settings → Hub backup on connected replicas: enable/disable, dedicated path, last completed backup, folder/revision counts and separate error reporting. Disabling retains the backup. Recovery uses its `state` subdirectory to reconstruct a new hub offline.
- Tauri macOS onboarding, tray, folders, linked machines, history, settings and English UI. The daemon runs independently of the window.
- Shared web UI with sign-in/sign-out and server-side path semantics. No browser access to arbitrary client-machine paths.
- Unified Machines inventory with Tailscale as a per-machine connection attribute; network mode controls in Settings. Tailscale detection, peer inventory, Arca probes and recent desktop/mobile heartbeat metadata. An absent response means not detected, not uninstalled. Mobile metadata support does not imply a mobile app exists.
- Docker deployment; official Node runtime bundled with Tauri; local ad-hoc macOS build; optional launchd/systemd definition generator; Vite development reload.

### Stabilization implemented

- Worker-thread scanning with a persistent metadata/hash cache, batched cache updates and periodic verification. Filesystem events request debounced scans; periodic scans remain the correctness fallback when watching is unavailable or misses events.
- Per-folder completion/error state and active transfer byte progress. A failed folder does not prevent another folder from synchronizing. Backup acknowledgements include the highest received history revision and timestamp.
- Immutable paginated transfer snapshots, owned by the requesting device and expiring after ten minutes. Incremental paginated backup history. Web file/history lists use bounded pages. Remote snapshots are applied one page at a time; local scan maps still scale with the selected folder.
- Explicit history retention preview/apply by age and/or version count. Current revisions, pending writes and history not acknowledged by enabled backups are protected. Conservative GC protects active snapshots and only removes unreferenced objects older than 24 hours. No scheduled deletion is enabled.
- Single-use machine pairing codes expire after ten minutes. Existing credentials remain supported. No QR pairing yet.
- Local folder relocation copies and verifies contents before changing its mapping; the original is retained. Destination must be new. Stop external writers during relocation.
- A replica with every last-known catalog folder synchronized can become a replacement hub, after explicit confirmation that the previous hub is stopped. Current files become a new revision history under the replica's identity. Existing replicas can explicitly reconnect, retaining files and submitting divergent contents as conflicts. This is manual recovery, not automatic election or a guarantee of the latest unseen hub changes.
- Optional launchd/systemd installer supports explicit activation with `--start`. Docker uses its restart policy. Installation remains an auxiliary CLI operation, as agreed; no terminal UI is planned.

### Recent stabilization and shared ignore rules

A share may have one root `.arcaignore`. New hub directories offer an unchecked opt-in template; existing directories and replica selection do not create one. Conflicting custom rules stop ordinary transfers until resolved. See [Exclusion policy](#exclusion-policy) for the full current contract.

Machine-wide pause/resume is visible in Folders; ongoing sync/unlink interruption is cooperative between operations. Progress counts files by upload/verification phase, including empty files. Large application-state folders still need workload-specific qualification; a bounded file-count test is not evidence that every application directory is suitable for synchronization.

### Design integration and distribution limits

- The shared desktop/web frontend implements the approved handoff. The functional corrections to the export are recorded in [design and interaction contract](#design-system-and-interactions). Final visual qualification across platforms remains separate.
- Direct macOS downloads can be published ad-hoc signed; Developer ID signing/notarization is optional for smoother installation under Gatekeeper. This environment has no Developer ID signing identity. The locally tested bundle is ad-hoc signed. Linux/Windows desktop packages are not validated; the current desktop target is macOS, with Ubuntu/Docker server support.
- Real physical power-loss and prolonged soak testing remain release qualification work. ENOSPC/process-kill tests and the 10,000-file run are bounded tests, not exhaustive hardware assurance.
- Local scan maps scale with folder size; some materialization/relocation I/O is synchronous. Seven-day abandoned partial cleanup and a 16 MiB free-space margin are implemented, but no storage quota or reservation against concurrent external writers exists.
- QR pairing and scheduled retention are unavailable. v0.1 uses text codes and explicit retention preview/apply; do not design these optional extensions as current functionality.

### Phase 1 acceptance

A real hub and replica must demonstrate creation, initial full sync, independent destinations, offline edits, reconnection, conflict preservation, deletion, restoration, revocation and restart recovery. Backup restore must be checked independently. Web authentication and unauthorized access must be verified. Users must be able to identify the machine being managed and recover from errors without guessing.

Verification on 2026-09-06: 44 automated tests pass on macOS, covering sync, backup/recovery, desktop DOM, Tailscale, numeric-code expiry/single use/failure budgets across restart, read-only machine reports, CSRF and HTTPS proxy origin checks. All 41 backend tests pass in an Ubuntu 24.04 container as UID 1000 with external networking disabled. The rebuilt macOS bundle passes its smoke test and the updated real Casa–Mac pilot passes; the pilot covers both transfer directions, edits, history, restore, deletion and recovery. It has no separate real backup; backup restore is covered by isolated tests.

Browser interaction checks on isolated data cover grouped six-digit login, Machines navigation, pagination of 105 files and folder relocation. Live Casa numeric login, discovery metadata, its authenticated roster and the Mac replica roster proxy also pass. This is not a full final-design/native visual QA pass. An isolated 10,000-file run verified every file: initial hub scan 124.3 s, initial replica sync 200.7 s, unchanged cycle 5.6 s. These local measurements are not throughput guarantees or a prolonged soak test. CI configuration is prepared for macOS/Ubuntu/Windows but has not run on GitHub: no commit or push has been made.

## 4. Phase 2 — Expo iOS and Android

**Status: Expo replica implemented locally; cross-platform qualification remains open.**

User decision (2026-09-09): mobile (phone and Fold) is exclusively a replica. It cannot be a hub or a full-backup node. No hub creation/administration, pairing-code issuance, promotion/replacement, archive download, backup acknowledgement or backup export. Keep explicit pairing/disconnect/reconnect, selected whole-folder bidirectional synchronization, conflict preservation, pause/resume, local browsing/share/import and hub history/restore for selected folders. Full-backup UI, runtime, SQLite archive schema and portable writer were removed from mobile; no legacy fallback or migration is required for this pre-production app. Desktop/server backup support remains separate.

Alf reference review: `/Users/javi/git/alf/mobile` uses Expo/React Native JavaScript with Expo Router, SecureStore, reusable native controls and theme tokens imported from `common/`. Metro explicitly watches that shared directory. Mobile builds use EAS profiles; client tests use GitHub Actions. Desktop uses Tauri/Vite; Docker is released by a separate workflow in Alf. Arca retains its approved single pipeline and its own HTTP synchronization protocol; do not copy Alf RPC, connection model, app identifiers or credentials. Shared logic/tokens may be extracted when needed; desktop DOM components cannot be imported directly into React Native.

- JavaScript/React Native client; transport without Node dependencies; hub identity pinning; secure credential storage; local index and persistent transfer state.
- Pairing, available folders, full-folder selection, download/resume/integrity verification and storage requirements.
- Files in persistent app documents storage, not purgeable caches. Platform permissions determine external Files/provider integrations; do not promise arbitrary desktop-style paths on iOS.
- Local browsing, opening/sharing and explicit import/upload; history and remote restoration. The hub still creates shares.
- Optional photo import into an existing share, with explicit permissions and a separately defined automatic-import policy. Do not imply that subscribing to `iPhone Images` imports the photo library automatically.
- Sync on launch/resume and opportunistic background work. No promise of a continuously running iOS daemon. Persist work across suspension, cancellation and network changes.
- Validate real iOS/Android devices, low storage, interrupted downloads, revoked credentials and offline access before distribution.

Acceptance: selected folders become complete persistent local copies; the app reports incomplete work honestly; imports reach the hub; transfers resume without corruption; suspension is handled without losing user data.

## 5. Phase 3 — internationalization

Extract product strings, starting from English, into translation catalogs for Tauri and Expo, including the shared web frontend. Add language selection and localized date/number/size formatting. Cover dialogs, errors, tray menus and notifications, with no translation of user-created names or contents.

## 6. Explicit exclusions and current limits

No multiuser collaboration, public sharing links, automatic hub election/migration, virtual filesystem, binary delta protocol or E2EE against the trusted hub. Unix sockets are local process endpoints: scans skip them without reading, copying or deleting them. Regular files ending in `.sock` still synchronize. If a previously indexed file becomes a socket, synchronization stops to avoid publishing a false deletion; incoming content never replaces a socket. Other unsupported file types still require attention. No synchronization of symlinks, ACLs, permissions, xattrs/resource forks in the alpha. Renames are delete/create operations. Open application databases are not transactionally synchronized. Hub admins can delete a share and its catalog/history with exact-name confirmation. Physical files and existing backups are retained; replicas detach after refreshing the authenticated catalog. Content objects are reclaimed through normal garbage collection, not immediate secure erasure. Hub administrators can rename shares without changing IDs or any physical path. Replicas and backups receive the name on their next catalog sync. Folder relocation is explicit and retains the original.

## Directory synchronization — September 9 checkout

Implemented and deployed to Casa/Mac; updated mobile binary pending: scans retain explicit directory entries, including nested empty directories and directories containing only excluded Finder metadata. The current SQLite schema stores file rows with `directory=0`; directories use `directory=1`, `hash=null`, `size=0`. Live directories and tombstones remain distinct. Snapshots, incremental changes, mobile's durable queue, full backup, portable recovery and promotion carry the type. No placeholder files are created.

File counts/bytes and file activity exclude directory entries; explorers show directories with zero files, and mobile's incoming-share destination picker includes them. Existing file-detail/history presentation is unchanged. Root shares still require hub creation; this does not grant replicas share administration.

Directory deletion applies children before parents. Removal is non-recursive and refuses remaining local/excluded content; such contents are preserved and synchronization reports an error. A stale deletion cannot remove a newly recreated directory. Concurrent file/directory type changes require explicit reconciliation rather than overwriting either type. Exclusion rules apply to directories as well as files.

Upgrade together: hub catalog advertises `directories:true`; updated clients require this capability before syncing. Updated clients send `X-Arca-Directories: 1`; the hub always rejects linked sync clients without the current directory capability header with HTTP 412, even for file-only folders. This deliberate compatibility stop prevents null-hash directories being interpreted as deleted files. Update Casa and the Mac daemon and install a new mobile binary before qualifying the pilot. Mobile requires its current native module and uses non-recursive deletion (`Files.delete` on Android, `rmdir` on iOS). There is no optional-module mode or alternate recursive deletion path. Metro reload alone cannot install this method. Use updated recovery tools for new backups. Existing snapshots can finish with their old file-only contents; a later reconciliation discovers directories. No live state reset is required. Docker/server changes now include Casa deployment and verification in the same task, under the user's standing authorization; never resume a user pause as part of deployment.

Validation: isolated hub/desktop/mobile tests cover empty directories, `.DS_Store` exclusion, nested bidirectional creation/deletion, browsing/counts, restoration and portable backup recovery, stale deletion and preservation of local contents. The final Node suite passes 149 tests with one platform skip; Android/iOS JavaScript exports pass. The Android native module compiles; the Swift source passes syntax parsing, but an iOS native build and native deletion workflows on devices remain unverified. Live Casa/Mac creation is verified below; mobile/native deletion and physical-device qualification remain open; `doc/Coros` is verified in the live Casa catalog (`directory=1`, zero files/bytes) and as an empty physical directory in the selected Mac copy.

## 7. Technical contract reference

The implementation is authoritative for exact current request validation, not for pending approved product changes. The deployed build and local work in progress can differ as recorded above: `packages/daemon/server.js`, `storage.js`, `engine.js`, `network.js`, `tailscale.js` and `web.js`.

| API group          | Operations and authorization                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status             | Admin `GET /v1/status`, `/v1/files`, `/v1/remote`; `/v1/remote` returns the shared catalog                                                                                        |
| Catalog/content    | Hub device/admin `GET /v1/catalog`, `/v1/snapshot?volume=ID`, `/v1/blobs/HASH`                                                                                                    |
| Transfer           | Upload offset query/start and binary `PUT /v1/uploads/HASH?offset=N&size=N`; chunks up to 1 MiB, object limit 100 GiB                                                             |
| Revisions          | `POST /v1/propose {volume,path,base,hash,size}`; `hash:null` proposes deletion; backups cannot write                                                                              |
| History            | `GET /v1/history?volume=ID&path=PATH`; `POST /v1/restore {volume,path,rev}`; backups cannot restore upstream                                                                      |
| Backup             | Linked replica/admin `GET /v1/archive` includes historical revisions                                                                                                              |
| Folder management  | Hub admin `POST /v1/volumes {name,path?,createIgnore?}`, `/v1/delete-share {id,confirmedName}`; local admin `/v1/select {id,path?}`, `/v1/unselect {id}`; backups cannot unselect |
| Machine management | Hub admin `/v1/devices {name}`, `/v1/revoke {id}`; replica admin `/v1/connect {url,token,privateNetwork?}`                                                                        |
| Controls           | Admin `POST /v1/sync {}`, `/v1/pause {paused}`                                                                                                                                    |
| Network            | Admin `GET /v1/network`, `/v1/discovery`; `POST /v1/network {mode}`, `/v1/client {kind}`                                                                                          |

The hub orders revisions. Proposals compare the caller's base revision to current state, deduplicate retries and preserve concurrent content as conflict files. Replica cycles capture local changes before applying the remote snapshot. Content objects are immutable; visible files are independent materialized copies. Paths must be portable NFC names, without traversal, reserved names or case collisions. History is retained indefinitely by default; explicit retention can remove superseded revisions. Current tombstones remain protected.

Tailscale discovery caches status and scans for 15 seconds, checks at most 128 peers with four concurrent probes, and sends no credential to the discovery endpoint. Docker consumes a sanitized read-only host status file, not the Tailscale control socket. Snapshots older than 90 seconds are unavailable, subject to the status cache delay. An app heartbeat expires after 30 seconds.

Backup controls: local admin `POST /v1/backup {enabled,path?}`. The CLI supports `backup enable NEW_PATH` and `backup disable`. Files live at `NEW_PATH/files`, history and identity at `NEW_PATH/state`. Backup directories cannot overlap synchronized folders or main daemon state. Archive access uses the replica’s existing revocable credential; the application is single-user and already permits linked devices to read per-file history. Backup failures are reported separately from successful working-folder sync. Pausing the device pauses both.

Manual replacement uses `GET /v1/promotion-plan` and admin `POST /v1/promote {confirmed:true}`. Reconnect via `/v1/connect` with `reconcile:true`. A SQLite checkpoint is retained before either transition. A durable journal reconciles configuration with the committed database transition after a restart. Backup recovery also creates a new identity and requires explicit reconnection. No automatic election exists.

Machine reporting contract: `GET /v1/machines` is read-only and authenticated; `POST /v1/machine-report` accepts sanitized counters only from a linked credential. `/.well-known/arca` additionally returns `access.codeDigits`, `codeExpiresInSeconds`, `networkMode` and `daemonTransport`; these expose no secret or filesystem path.

### Approved frontend integration (2026-09-06)

The `design_handoff_arca_v0.1` visual reference is implemented without its prototype controls, sample data or CDN dependencies. Light/dark/system appearance, numeric code input, folder detail, Machines, paginated/filtered history, confirmation dialogs, settings, native onboarding and tray are wired to actual actions. Exact functional adaptations are in [design and interaction contract](#design-system-and-interactions).

New local hub-admin contracts: `POST /v1/rename-share {id,name}` validates portable, case-unique names and changes metadata only. `GET /v1/ignore-policy?id=ID` reads an active hub working copy; `POST /v1/ignore-policy {id,text,version}` saves at most 64 KiB as a normal revision and rejects stale editor versions. It refuses unavailable copies and unsafe rule files. Saving is explicit; absent files are created only on save, and empty text means no user exclusions. Replica policy-conflict safeguards remain in effect. These endpoints do not grant linked credentials hub administration.

New authenticated contracts: `/v1/activity` supports bounded cursor history and folder/conflict/deleted filters; admin `/v1/settings {name}` updates the managed machine's name; admin `/v1/web-sessions/revoke` revokes browser sessions; `/v1/conflict-choice` restores a selected conflict version only when both reviewed revision IDs still match; `/v1/pause` accepts optional bounded `seconds`. Native launch-at-login, folder picker, clipboard and notification opt-in never expose credentials to frontend JavaScript.

## Exclusion policy

One optional root `.arcaignore` controls user exclusions. **Only creation of a new hub directory offers “Create a default .arcaignore”, unchecked by default.** Existing folders cannot request template creation; replicas do not seed a template. With opt-out, later scans leave it absent. The template is written only at creation; subsequent scans never recreate a deleted rule file. Missing or empty rules disable user exclusions; built-in metadata exclusions remain.

The hub folder detail also offers a plain-text `.arcaignore` editor for active local copies. It reads the actual policy, requires Save rules, and does not insert a template automatically.

The editable starter is [default.arcaignore](packages/daemon/default.arcaignore): system metadata/trash, caches, `node_modules/`, `.venv/` and `.git`. There is no additional hidden configurable cache/dependency list. Missing rules on an opted-out share mean no user exclusions; fixed internal-path and unsupported-file handling remains. The core fixed policy in `packages/core/builtin-exclusions.js` excludes `.DS_Store`, `Thumbs.db` and `desktop.ini` (case-insensitive basename at any depth). Both daemon and mobile engines consume this same policy, including with empty rules or negation. This does not delete existing local metadata or retained history. Other names still follow the explicit user policy. This rule is implemented locally; running daemons require deployment.

## Patterns

```gitignore
# Ignore temporary files anywhere
*.tmp

# Root-relative folder
/build/

# Logs at any depth
**/logs/

# Keep one file inside a partially excluded directory
cache/*
!cache/keep.json

# Local project-specific exclusions
alp/secrets/subscriptions.removed.d/
```

Rules use [node-ignore's gitignore semantics](https://github.com/kaelzhang/node-ignore), with **case-insensitive matching** for consistent behavior across Arca's portable paths. Supported syntax includes `*`, `**`, `?`, character classes, `#` comments, escaped leading `#`/`!`, leading `/`, directory-only trailing `/`, and `!` exceptions. Later matching rules take precedence, subject to excluded parent directories: `!cache/file` cannot restore a file while `cache/` itself is excluded. Use `cache/*` for selective exceptions.

Only the root file controls the share. Nested `.arcaignore` files are ordinary synchronized content; `.gitignore` is not read. This avoids implicit dependencies on repository configuration.

## Distribution and preservation

- The root `.arcaignore` synchronizes and is versioned, even if a broad pattern such as `*` would match it.
- A replica fetches accepted hub rules before scanning. Different custom rules on initial link or concurrent edits stop ordinary transfers. Stale policy proposals are rejected without generating a conflict copy. Align both sides before retrying; ordinary file conflicts retain their normal behavior.
- Local rule edits are proposed before ordinary changed files. Rules are checked on scanning, upload proposals, incoming materialization and missing-file deletion checks.
- Directories are excluded before traversal, including caches containing unsupported symlinks.
- Ignoring a file does **not** delete it on any machine, remove accepted history or propose a tombstone for it. Existing hub objects remain available to full backup/history retention.
- Folder file/byte totals and the Files explorer filter retained index rows through the current exclusion rules, before grouping/search/pagination. History and backup retain excluded revisions. Selected copies use their root policy; catalog-only shares use the accepted policy blob. September 9 local fix: Casa Mirai still reported 13,606 indexed files after excluding 9,822; 3,784 remained included. Read-only verification found no included files under `repos/`. Casa needs a user-run deployment for this presentation fix.
- A newly included file can participate in bidirectional sync on the next cycle; existing contents are not automatically overwritten merely by editing the rules.
- The file must be a regular file, at most 64 KiB. Unreadable, oversized or symlinked rule files stop the affected operation rather than silently treating the share as unrestricted.

Arca's internal `.arca-` bookkeeping paths and unsupported file types are protocol/safety constraints, not configurable exclusions. Sockets remain local; ignoring rules cannot enable socket/symlink synchronization. A regular file named `something.sock` is only excluded if a rule matches it.

Legacy `syncIncludes` values are used only while seeding a missing file, by omitting their corresponding template rule. Once `.arcaignore` exists, edit it instead; the old configuration does not override it. Rule changes do not require a daemon restart.

### Mirai repository policies on Casa

On 2026-09-07, the user requested aligning `alpi-mirai` exclusions with its repositories' `.gitignore` files. The working root `/home/atlas/alpi/data/mirai/workspace` has no root or ancestor `.gitignore`; its 11 nested policies were explicitly copied into the root `.arcaignore`, scoped to each source directory with their negations preserved. Existing generic exclusions remain. This includes each repository's own environment-file exclusions; the separate `~/.alpi` exception below does not apply here. Future `.gitignore` edits are not imported automatically.

Saved through Casa's version-checked hub policy API and verified by API and disk readback. Matching the flattened rules against the nested policy hierarchy produced zero differences across 13,625 examined file paths (dependency/cache/Git directories pruned). Only four existing additional files, totaling 1,657 bytes, became excluded; most newly specified artifacts were already absent. No files or history were deleted, and no restart was required. This is a hub policy verification, not an end-to-end replica synchronization check.

### Alpi policy: user-specific decision

The approved `~/.alpi/.arcaignore` follows that folder's `.gitignore` **except `.env` and secrets are intentionally included**. `.gitignore` is not automatically consumed by Arca; the policy was copied and adapted explicitly. Broad exclusions require re-including parent directories before child exceptions. Do not restore the older credential-exclusion policy from historical notes.

The last bounded check counted 80 eligible files, 137,420 bytes; counts are observations, not assertions for future runs. Never put secret contents in logs, docs, screenshots or fixtures. This policy is not a transactional backup of running application databases. The active file is user content and may change; inspect it before editing. Matching rules on hub and replica are required before first synchronization.

### Local metadata and previews

`.arca-volume` identifies the local working-copy registration; it is not user content. Replica unlink removes a matching marker. Existing conflict files are preserved rather than silently deleted. A preview counts eligible file metadata, does not hash/read contents, follow symlinks or create files, and is bounded to 100,000 visited entries or five seconds. Incomplete counts are unavailable, not totals or predicted transfer bytes.

## Operations

Commands below run from the repository root unless stated otherwise.

## Run desktop development

Requirements: Node.js 24+, Rust and the platform's Tauri prerequisites.

```sh
npm ci
npm run dev
```

Keep the terminal running. Vite serves the frontend on loopback port 1425: CSS updates live and HTML/JS reload the window; Rust changes rebuild/restart Tauri. This development port is not another Arca service port. The normal daemon uses `~/.arca`; editing daemon code requires a separate service update/restart.

```sh
npm test
npm run desktop:build
npm run verify:bundle
```

macOS output: `apps/desktop/src-tauri/target/release/bundle/macos/Arca.app`. The build downloads official Node 24.14.0, verifies its checksum and bundles it; first build requires network. Cache: `.cache/runtime`. The local macOS app is ad-hoc signed, not notarized. Close the compiled app through its tray menu to avoid confusing it with the development window. Closing a window hides it; quitting the app leaves normal daemon synchronization running.

## Update Casa Docker from this checkout

The private, Git-ignored `scripts/local/update-docker.js` is exposed by a root npm shortcut. It is intentionally unavailable in a fresh clone until the private helper is copied there; the command does not distribute credentials. It uses the existing SSH alias `casa`, installation `/home/atlas/arca-pilot`, Compose `deploy/casa.compose.yaml` and service/container `arca`.

```sh
npm run update-docker -- --check
npm run update-docker
```

`--check` reads SSH/Compose/status only. Normal invocation runs the Node test suite, snapshots only `packages`, `apps/desktop/src`, `package.json` and `deploy/Dockerfile`, uploads to a temporary remote build context, builds the image and force-recreates only Arca with a 120-second graceful stop allowance, checking that its container ID changed. Uncommitted source is included. It neither pulls a published image nor commits/pushes. A remote lock excludes simultaneous runs of this helper.

Casa's existing Compose, `.env`, bindings, mounts, state and user files stay in place. Mac, Tauri, Metro and mobile are outside this command. It refuses a paused hub and rechecks identity/folder selections/backup configuration immediately before restart; do not change these settings during deployment. Pause is not durable across this daemon restart. Postflight compares identity, selected paths and backup setting, then checks SHA-256 of all shipped runtime/frontend files inside the container. This is source/configuration verification, not a full sync workflow test. Reload the web panel after deployment and generate a new web code if needed.

Build contexts are temporary and removed on exit; the old root source copy on Casa is not refreshed. **Do not rebuild from that stale remote source tree.** Use this command from the current Mac checkout. A failed test/build does not recreate the running container. An interrupted restart or postflight failure is reported; inspect before retrying and never reset state as a repair step. SIGKILL/network loss can leave `.update-docker.lock` or a temporary context: remove only after confirming no deployment is running.

The previously running image is retained as `arca-pilot:previous` when it still exists in Docker storage. A running container can outlive its deleted image: in that case the helper explicitly reports that no rollback image was captured and continues with the build/recreation. An existing previous tag must not be mistaken for this deployment’s prior image. Image rollback is not database rollback; inspect compatibility first. If appropriate, run:

```sh
ssh casa 'docker tag arca-pilot:previous arca-arca'
ssh casa 'cd /home/atlas/arca-pilot && docker compose --env-file .env -f deploy/casa.compose.yaml up -d --no-deps --no-build --force-recreate --timeout 120 arca'
```

The older ignored `scripts/local/deploy-pilot.js` remains a separate Casa-and-Mac operation and is not called by update-docker. It rebuilds the native Mac runtime and restarts its LaunchAgent as well as Casa; use only when both deployments are requested. The read-only `node scripts/local/verify-deployment.js` compares staged/bundled Mac and Casa sources. A successful Docker update alone does not make them identical.

## Sign in to casa

With Tailscale connected, open **http://casa:47831**. In a terminal on your Mac, run:

```sh
ssh casa 'docker exec arca node packages/cli/arca.js web-code'
```

Copy only the JSON `code` value, without quotes, into **Web access code**, then click **Open Arca**. The code is single-use and expires after 10 minutes. The session lasts up to 24 hours or daemon restart. Generate another code if needed. Never put credentials in documentation or source control.

The same port serves web `/`, API `/v1/*` and discovery `/.well-known/arca`. The former 47830 listener is removed. Tailscale restricts network access; Arca still authenticates administration and synchronization.

The web manages **casa's filesystem**. For example, create `alpi-workspace` at `/home/atlas/arca/shares/alpi-workspace` in the container, then select it in Mac Tauri with destination `~/Documents/arca-alpi`. The web cannot choose a folder on the browser's Mac.

## Pilot operation

|             | Casa hub                                                      | Mac replica                               |
| ----------- | ------------------------------------------------------------- | ----------------------------------------- |
| State       | `/home/atlas/arca-pilot/state`                                | `~/.arca`                                 |
| Test folder | `/home/atlas/arca-pilot/files/Prueba-Arca`                    | `~/Arca/Prueba-Arca`                      |
| Runtime     | Docker container `arca`, non-root, unless-stopped             | Bundled Node daemon, independent of Tauri |
| Endpoint    | `100.99.29.84:47831` (Tailscale), `192.168.1.190:47831` (LAN) | Loopback and Tailscale, same port 47831   |

Casa installation: `/home/atlas/arca-pilot`, SSH user `atlas`, Compose `deploy/casa.compose.yaml` with `.env` selecting the bind IP. Existing Syncthing services/data were not migrated. The pilot has no separate real backup. Mac login startup is managed by the installed `com.soyjavi.arca.daemon` LaunchAgent.

```sh
ssh casa 'docker logs --tail 50 arca'
ssh casa 'docker exec arca node packages/cli/arca.js status'
ssh casa 'cd ~/arca-pilot && docker compose --env-file .env -f deploy/casa.compose.yaml up -d'
```

Docker reads sanitized Tailscale status through a read-only `tailscale-status/` mount. `scripts/export-tailscale.py` and `deploy/local/install-tailscale-export.sh` maintain it; casa uses a user cron entry once per minute. Do not mount the Tailscale control socket. Generic Compose does not install this exporter automatically.

## Fresh Docker hub

```sh
docker compose build
docker compose run --rm arca init --role hub --name MyHub --root /data/files
docker compose up -d
docker compose exec arca node packages/cli/arca.js add-folder Documents
docker compose exec arca node packages/cli/arca.js web-code
```

Generic Compose persists state/files in volumes and publishes loopback by default. Existing folders require explicit mounts and permissions for UID 1000. Remote access requires a protected deployment: a Tailscale-only bind or suitable TLS/private-network setup. State must stay outside synchronized folders. Changing the host bind alone does not configure the Tailscale exporter or Arca network mode.

## Auxiliary CLI and recovery

```sh
node packages/cli/arca.js help
node packages/cli/arca.js status
node packages/cli/arca.js network
node packages/cli/arca.js discover
```

Commands accept `--home PATH` (default `~/.arca`). Initialize nodes with `init --role hub|replica|backup`; create machine credentials on the hub with `invite NAME --role replica|backup`. Store the returned invitation JSON privately and use `connect URL --token-file PATH` on the other node. HTTP to a verified Tailscale peer is accepted automatically. The auxiliary CLI retains `--private-network` for an explicitly trusted encrypted network other than verified Tailscale. Use `catalog` then `select FOLDER_ID LOCAL_PATH` on replicas. `unselect` retains local files. Backups automatically follow every folder and history.

`ARCA_HOME=/path/to/state node scripts/install-service.js` generates an optional launchd/systemd definition and prints activation instructions; it does not install a second daemon automatically. Stop the existing daemon before activating a replacement service.

To recover from a backup: stop its daemon, preserve its full state directory, and run:

```sh
node packages/cli/arca.js recover-backup /path/to/new-hub --home /path/to/stopped-backup
```

The target must not exist. Recovery verifies stored objects and reconstructs received files/history with a **new hub identity**. Start it and link fresh replica states; do not overwrite old local copies. Recovery can only restore revisions the backup actually received.

The casa pilot also bind-mounts `/home/atlas/arca` at the same path inside Docker. The existing `alpi-profiles` share uses `/home/atlas/arca/alpi-profiles`; paths outside configured mounts are not host filesystem access.

## Optional backup on a replica

In Tauri on the Mac, use **Settings → Hub backup → Enable backup** and choose a new dedicated directory (for example `~/ArcaBackup`). It must be outside synchronized folders. Normal selected-folder sync continues. Full backup copies live under `files/`, historical state under `state/`. Disable retains both.

CLI equivalent: `node packages/cli/arca.js backup enable ~/ArcaBackup`; stop with `backup disable`. To recover, first stop the main daemon, then use `recover-backup /new/hub --home ~/ArcaBackup/state`. Backup is optional and has not been automatically enabled on the pilot Mac.

## Maintenance and replacement hub

- **Machines → Pair a machine** issues a single-use pairing code valid for ten minutes. On the replica, enter the hub address and code. CLI: `pair NAME`, then `connect URL --token-file PRIVATE_INVITATION_FILE`.
- **Folder detail → Change location…** copies into a new destination, verifies contents and preserves the old directory. Avoid editing the source while moving. CLI: `move-folder FOLDER_ID NEW_PATH`.
- **Settings → History retention** previews before applying age/version limits. No automatic deletion is scheduled. CLI: `retention --days 90 --versions 20`; pass its returned digest as `--confirmation DIGEST` to apply the same values.
- **Settings → Hub recovery** can promote a replica containing every last-known share. Stop the old hub permanently first. Promotion preserves current files but starts fresh history. For complete historical recovery, use the separate backup recovery command instead.
- Other replicas use **Reconnect to replacement hub** with a fresh credential. Their folder IDs must exist on the new hub; backup must be disabled. Local files remain and differences become conflicts. CLI `connect` accepts `--reconcile`.
- Service activation: after stopping a manual daemon, run `node scripts/install-service.js --start`. Set `ARCA_HOME` for a nondefault state and `ARCA_RUNTIME` to a staged runtime directory if desired. Keep the referenced runtime at that path. macOS uses a login LaunchAgent; Linux uses a user service (system policy controls operation after logout).

Release limitations and remaining phase-1 gates are recorded in [phase acceptance](#phase-1-acceptance). The designer should use [design and interaction contract](#design-system-and-interactions) for available data/actions, pending implementation and state semantics.

## Internal verification

`npm test` exercises sync, authentication, recovery, filesystem events, pagination, cleanup and low-space handling. `node scripts/local/verify-scale.js` creates an isolated hub/replica, checks 1,000 full files and reports timings; `ARCA_TEST_FILES` accepts 1–10,000. It does not use the pilot configuration. Neither check substitutes for prolonged workload or real hardware validation.

For an HTTPS reverse proxy, set `ARCA_WEB_ORIGIN=https://arca.example` to the exact public origin, preserve the Host header and restrict the backend to the proxy. This enables matching-origin validation and Secure session cookies, not automatic TLS certificate setup. The Casa pilot continues to use HTTP over Tailscale.

Authenticated `GET /v1/machines` supplies a read-only hub roster, backup acknowledgements and optional machine reports to linked machines. Reports are self-reported snapshots, not live monitoring; missing/stale information must stay unknown. See the designer reference for field semantics.

## Approved design

The shared frontend implements `design_handoff_arca_v0.1`: local fonts/icons, Light/Dark/System appearance, folder details, history filters, Machines, access codes and confirmation dialogs. Native Tauri also has four-step onboarding, folder selection, a menu-bar popover, notification opt-in and a launch-at-login setting. Quit leaves the daemon running. See [design and interaction contract](#design-system-and-interactions) for corrections to unsupported statements in the export.

Reopen the rebuilt Arca app to load native changes; `npm run dev` still enables frontend hot reload. Reload the Casa web page after deployment. Changes to the daemon require restarting its service, which invalidates browser sessions. No commit or push is performed by the build or deployment.

Casa deployment uses container `arca` (Compose project `arca`). The existing installation/state directory remains `/home/atlas/arca-pilot` to preserve persistent paths. On Casa, the native user service is disabled; Docker owns the daemon. The Mac LaunchAgent is separate. `/home/atlas/alpi/data` is mounted read/write at the identical container path, so all descendants are available without individual mounts. Mounting does not automatically publish or synchronize them. Existing shares retain their IDs; a parent share cannot overlap an already published child. Use absolute mounted paths in Docker; `~` is rejected because it refers to the container user.

Casa's default location for new shares is `/home/atlas/arca/shares/{share-name}`. The `/home/atlas/arca` mount exposes that same path inside the container. Changing this default does not relocate existing shares; their paths and IDs are retained. `/home/atlas/arca-pilot` remains the installation and state directory, not the suggested location for new shared folders.

### v0.2 network and presentation clarification

Standalone retains the configured main listener; it does not enable LAN binding, add TLS, or disable an already configured main network listener. Tailscale mode adds an address-specific listener while Tailscale is connected. Outgoing connections follow the configured hub URL independently of this mode. Non-loopback binding requires the explicit encrypted-network/TLS-proxy deployment flag. Plain LAN HTTP requires the hub’s explicit opt-in described below; HTTPS and verified Tailscale remain supported. Do not expose the plain HTTP API port directly to the Internet. Version is 0.2.0 across the package, native bundle, discovery and diagnostics; protocol remains v1 and phase remains alpha.

### Repeatable isolated resilience qualification

Run `node scripts/local/verify-resilience.js` from the checkout. It creates temporary hub/replica/backup child processes, compares independent SHA-256 manifests, exercises concurrent edits and rename/deletion, injects SIGKILL during a partial upload, restarts both sides, restores an actually synchronized backup into a fresh hub and observes the real scheduler for six minutes without writes. Its logs contain counts/timings, not credentials or user content. Only temporary state is removed. `ARCA_TEST_FILES=3000 node scripts/local/verify-scale.js` separately validates a larger initial copy. The resilience script deliberately runs outside the fast unit suite because it includes a six-minute observation period.

These checks do not simulate filesystem power-loss semantics, physically suspend the Mac, measure battery energy or establish multi-day leak freedom. Native DOM and bundle smoke checks do not replace interaction with the actual native tray/window.

Backup content size is cached in replica config as `backup.contentBytes` after successful backup cycles, summing unique non-null content hashes in the child’s retained `backup_history`. It includes historical content and avoids counting repeated versions with identical content twice. Status reads do not traverse disk. Settings shows this content size beside the last completed backup date in one row; the measure is not total allocated disk space. Machines now refreshes on acknowledgement/state changes; Settings patches backup status/size only, preserving active form fields.

### Replacement-hub audit — 2026-09-07

Read-only live review plus isolated reproduction; no real promotion or reconnection performed. The Mac is a desktop replica with four selected working copies; promotion-plan returns ready=false because Prueba-Arca is missing. The separate full backup does not satisfy this working-copy check automatically. A promoted desktop keeps installation=desktop (native administration and API, no server web panel). It retains its machine ID, which differs from the former hub ID, and keeps folder IDs/paths while rebuilding history from current disk content. Other replicas need explicit reconciliation and fresh pairing; the old hub has no automatic demotion/redirect.

Promotion guards are now implemented in Engine.promotionPlan/promote: pending transfers, unsynced/error folder state, missing paths and enabled optional backup block promotion. This supersedes the earlier two-gap finding. The reachability probe is only a guard, not proof the old hub has stopped; a network partition can hide it. Recovery keeps current local files, not unseen remote revisions or old hub history. Independent backup recovery and real-device qualification remain separate.

### Shared UI component audit — 2026-09-07

Reviewed source composition across Folders/detail, Machines, History, Settings, onboarding, browser access, action dialogs and tray. Select actions share one secondary button; theme/network/history filters share segmented markup and accessible pressed state; settings toggles share one component; embedded path pickers share the icon-button/field wrapper. Removed the duplicate selection-field CSS, inconsistent text-button actions for pairing and double standard-button focus styling; associated labels with dialog fields. Main dropdown remains custom/shared rather than OS-native. Tray disconnected machine/folder indicators now use static unlink warnings. Background Machines refresh does not replace an open actions menu.

Isolated browser review inspected Settings, recovery Select focus, dark folder selection with a long path, and hub pairing actions. These are browser previews of native-style UI, not proof of native window/tray pixel parity. Native DOM tests exercise existing roles/surfaces/forms and the shared Theme pressed state; a new tray DOM test covers disconnected state and a Machines test covers keeping open menus during background updates. No live pairing, backup enablement or file changes were used for visual checks.

### Local network HTTP opt-in — 2026-09-08

Implemented and deployed to Casa for the authorized Android connection test: hub Settings → Network → **Allow HTTP on local network**, off when absent. Admin-only `POST /v1/network/lan { enabled: boolean }` persists `network.allowLanHttp`; changing standalone/Tailscale mode preserves it. Replicas cannot change this setting. Discovery advertises the boolean without authentication. A private IPv4 socket peer (RFC1918: 10/8, 172.16/12, 192.168/16) needs this opt-in for HTTP pairing and device-authenticated requests, including in Tailscale mode. Disabling refuses subsequent requests with 412, preserving the credential and local files; an already accepted request may finish. Loopback administration and existing browser administration are separate from replica permission. The policy uses the actual socket peer, never caller-supplied forwarded headers. A TLS reverse proxy arriving from an RFC1918 peer also needs permission on its internal HTTP hop; loopback proxy connections are unaffected. This switch is not a firewall and cannot identify an Internet client hidden behind a LAN proxy/NAT.

Mobile accepts literal private IPv4 HTTP addresses only after a credential-free discovery check confirms hub permission. Native Android binds LAN requests to Wi-Fi/Ethernet rather than cellular/VPN; iOS checks the selected route against an active local `en` interface and disables cellular HTTP. Tailscale verification remains separate. Desktop pairing also checks the hub opt-in before sending a code over a literal LAN address. HTTP offers no encryption or peer authenticity: files, pairing codes and credentials can be observed by others on that network. No DNS discovery or automatic selection of LAN hosts was added.

The toggle does not bind another interface, publish a Docker port, configure router forwarding, or enable itself. To use Casa’s LAN address, deploy the changed hub/backend and web assets, configure the host listener/Docker port for the intended LAN interface, then explicitly enable the toggle. Do not forward the HTTP port to the Internet. The Casa pilot bindings and LAN-capable Android development APK were subsequently updated as recorded below. A client binary without resolveLanHost needs rebuilding; Metro cannot add the native capability.

Validation: full JavaScript suite 124 passed / 1 skipped; subsequent focused desktop/LAN suite 19 passed, including shared hub-only toggle persistence, admin restrictions, refusal without opt-in, reuse of the existing pairing after disable/re-enable, RFC1918 boundaries and mobile credential-free checks. Swift source parses. Native LAN compilation and end-to-end Android/iOS LAN pairing/sync remain unverified; no native build or extra emulator was started.

September 8 LAN pilot preparation: user authorized preparing the running Android emulator’s connection to Casa. Deployed only daemon `server.js`/`network.js` and shared web `app.js`/`style.css`, rebuilt Casa’s Docker image, verified phase was not paused and gracefully recreated the container. Added the specific host binding `192.168.1.190:47831` alongside the existing Tailscale binding; the local pilot compose file matches. Enabled LAN HTTP through the authenticated admin endpoint. Verified discovery on the LAN address, emulator IP reachability, and preservation of hub identity, every share ID/path/selection and backup-enabled state. The Mac daemon was not restarted. Expo development build `d903510f-a17c-4bb6-b9b5-ecec7bd2e6ae` completed successfully and was installed over the existing development APK without clearing app data. No additional emulator or local native build was started, and no commit/push was made.

September 8 Android LAN connection verified: existing emulator `emulator-5554` was using cellular emulation with Wi-Fi disconnected; native LAN verification correctly refused that route. Connected the detected `AndroidWifi` network, then completed the real onboarding with `http://192.168.1.190:47831` and a fresh six-digit hub code. Hub now records `Android emulator`, device ID `3dab5b04-7df5-4c7a-82b6-2680ab6adb6e`, not revoked, last address `192.168.1.171` (emulator host/NAT). Visually inspected Folders with hub Casa and all five unselected shares. This verifies Android native LAN routing, pairing and authenticated catalog retrieval, not a full download/upload/backup workflow. No share selection, user-file mutation or backup enablement was performed. Existing pairings and hub shares remain intact.

Reorganized the hub’s network settings into Tailscale / Local network / Machine discovery using existing components and shorter copy. The 16 desktop DOM/API tests pass. Copied the updated web script to both the Casa installation and running container and rebuilt its image for future recreation; this UI-only step did not restart the daemon. No Mac restart, additional emulator, commit or push.

September 8 fixed mobile shell: sidebar background now extends through the full screen height with separate safe-area handling for controls. Shared view headers are outside the scroll container; body scroll resets per view/folder but survives fold transitions. Existing emulator Settings scroll checks confirm stable header coordinates in phone and Fold. Android/iOS JS export passed; no APK rebuild, commit or push.

## Incoming mobile file sharing — 2026-09-08

Implemented locally, uncommitted: Expo Sharing receiving plugin configuration for Android SEND/SEND_MULTIPLE and iOS Share Extension; transient incoming-file session; explicit destination restricted to shares already selected on this device and their subfolders; selection rechecked before import; local import with offline/pause queue behavior and existing conflict preservation. Incoming copies live only in a private cache while choosing a destination. X, Cancel and Android Back discard them without confirmation; app restarts do not restore an inbox. Startup removes abandoned cache files. Invalid paths, non-file payloads, missing/incomplete sources and ambiguous duplicate resolved URIs are rejected. Partial staging failure rolls back only that batch. The destination sheet stays mounted across view navigation.

Validation: 13 replica/layout tests passed, including exact-byte workout import into workouts/2026, no hub write while paused, successful transfer after resume, unsafe filename rejection and staging rollback preserving existing pending data. Android/iOS JavaScript exports passed. Expo config introspection includes both Android share intent filters. On the existing Android emulator, an explicit SEND intent carrying a synthetic .fit opened Save to casa and its folder/subfolder selector. The test file was not uploaded to the live hub.

Remaining: install a new native development build to register Arca in the Android chooser, then test actual COROS exports and cold/foreground/multiple-file cases. No new native build was launched for this change. iOS Share Extension is configured but unverified; Expo 55 documents this integration as experimental. Its resolver also does not support every source MIME representation (notably text/plain file streams); links/text are not imported. Duplicate temporary filenames must be shared separately. Treat earlier native sharing qualification notes as still open, not completed by JavaScript export or direct intent testing.

Replica copy refinement (September 8): routine desktop/web/mobile status, folder and history summaries and backup copy use Hub/the hub without the configured name. Machine identity and revision attribution keep actual names. Incoming sharing uses Save file/Save files because it saves locally into selected working folders before synchronization. Implemented locally; Casa web deployment has not been performed for this copy change.

Mobile folder detail refinement (September 8, local): Files/Recent with local modification-time sorting and nested-path search, revealable search from the header as in Alf, fixed view controls, secondary actions in a folder action sheet, and sync/paused state in the subtitle rather than a detail-page banner. Recent means local file changes, not accepted hub revision dates. No native build or hub deployment required for these JavaScript UI changes. Existing Android emulator used for read-only view validation; live folder contents and selections were preserved.

UI copy cleanup (September 8, local): removed redundant top-level desktop/web/mobile header summaries and repeated available-folder location copy. Counts remain on folder rows/details; identity remains in navigation/machine cards. Disconnect and operation-consequence messages are preserved. Casa deployment is still pending.

Mobile Machines/file-history refinement (September 8, local): matched desktop replica section order and metadata/state hierarchy, added backup-settings navigation, replaced modal revision cards with a complete file-history view and responsive summary/revisions/location layout. Local-copy access is checked before sharing; remote restore still requires confirmation. No hub deployment, native build, commit or backup enablement accompanies this UI change.

Screen-by-screen parity pass (September 8, local): mobile History now uses the existing server volume/filter queries (All/Conflicts/Deleted) with stale-response protection; folder actions link to scoped All history; file detail is a complete screen and history retains its file origin; Android Back follows these routes. Machines and Settings reuse the same Hub connection component. Settings sections/theme order and Select/Sync now/Unlink/Cancel labels align with desktop. Sync errors float above the layout with persistent dismiss/retry behavior. The design section owns the screen comparison matrix and intentional platform differences. No live data mutations, backup changes or native builds are part of this pass.

September 8 Machines composition (local): desktop/web and mobile now use a single registered Machines list, with Hub connection kept separate. Rows use two content lines: identity/role/current-machine tags, then OS and available network/IP. Removed loopback and last-contact rows. Tailscale labels require discovery evidence, not address-range inference; mobile currently receives the observed IP without confirmed transport metadata. Android phone visually inspected through Metro; server web not deployed in this pass.

September 8 visual follow-up (local/Metro): Machines phone connection and backup summaries compacted; Fold restores desktop density, horizontal actions and machine totals. Shared settings radius corrected to 8 dp, machine/backup to 10 dp. Phone and unfolded Machines screenshots inspected on the existing emulator. No new emulator, native installer, deployment or commit.

Repository hygiene: the user requested keeping pilot/development artifacts out of commits. `.gitignore` now excludes the Casa deployment/test helpers, demo scripts, historical design export, unused generated Tauri icons and empty root Expo placeholder. They remain on disk. The private update-docker shortcut is the explicit exception: copy its ignored helper separately when setting up another checkout. Product mobile code/configuration, tests, `.easignore`, AGENTS.md, this spec remain eligible for tracking. Tauri icons referenced by tauri.conf.json remain tracked.

Mobile asynchronous UX follow-up (local): folder actions changed to compact contextual rows. Confirmed removal dismisses the sheet and displays explicit progress, success or blocking error. Shared foreground action runner exposes progress across other actions and retries the actual failed operation; background app-resume sync no longer takes its foreground action lock. Existing data-protection checks remain unchanged.

### Conflict resolution state — September 8 follow-up

Implemented and deployed to Casa Docker and the Mac daemon: `/v1/conflict-choice` atomically stores a `conflict_resolutions` record with the newly accepted original revision. Both files and histories remain. Catalog conflict counts and history/filter responses distinguish resolved copies from pending conflicts; a later edit to the conflict copy reopens it. Replica resolution requires that folder to be selected locally and included in its hub machine report. Revision guards reject stale choices without changes. Mobile refreshes sync/report before submitting; unselected folders cannot resolve. Keep both/Cancel dismiss without recording a choice.

Verified: full suite 140 passed, one skipped; Android/iOS exports passed. The existing photos conflict had already copied the user's chosen content to desktop. Reconfirming that same content through the desktop API created revision 15576, kept both copies, returned zero pending conflicts and showed “Resolved · copy kept” in the running Android history; Android's Conflicts filter is empty. Casa/Mac restart preserved identities, selections and backup settings. No Metro restart, native rebuild, commit or push. Desktop DOM/API tests cover the review flow; no claim of a fresh native desktop visual run.

Desktop/web file explorer breadcrumbs now sit inside the file panel as its compact top navigation row, with the current location distinguished from clickable ancestors. Files/Recent remains above the panel; navigating to file history preserves the directory on return.

September 8 mobile reset/legacy cleanup: at the user's explicit request, cleared all Android application data for com.satoshilimited.arca on the existing emulator (pm clear succeeded), including credentials, SQLite state and app-owned files. The hub and desktop were not reset. Removed the obsolete store unselect operation that retained local directories while dropping their index, and the Local copy badge / reselect-in-detail UI. Missing catalog shares preserve index and show an issue. Failed explicit cleanup keeps the selection record with an issue and durable removal marker until successful retry; it cannot resume transfers while marked. Existing guards for unaccepted edits remain.

September 8 LAN re-pair validation after mobile reset: the emulator successfully paired to Casa at http://192.168.1.190:47831 using the user's displayed code and loaded all six shares, with none selected. The casa hostname and 100.99.29.84 endpoint take the native Tailscale verification path and require Tailscale on Android; the LAN IP works with the hub's existing allowLanHttp setting. Native resolver failures now show an actionable address/Tailscale message instead of the Java exception. Hub connection rows now reuse the machine row styling in desktop/web and mobile.

## Release setup and publication

These are manual setup instructions, not authorization to publish. Version 0.2.3 already has successful hosted artifacts; current checkout changes require a new version before publication.

### Optional macOS signing

Only if Developer ID signing/notarization is wanted later, in **Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret                       | Value                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of the Developer ID Application `.p12` certificate **with its private key**. |
| `APPLE_CERTIFICATE_PASSWORD` | Password used to export that `.p12`.                                                |
| `APPLE_SIGNING_IDENTITY`     | Full certificate identity, e.g. `Developer ID Application: Your Name (TEAMID)`.     |
| `APPLE_ID`                   | Apple account used for notarization.                                                |
| `APPLE_PASSWORD`             | An Apple **app-specific password**, not your normal account password.               |
| `APPLE_TEAM_ID`              | The Apple Developer team ID.                                                        |

If Alf uses organization secrets, grant this repository access to them. If they are repository secrets, configure the same values from the original certificate/credential source: GitHub does not reveal saved secret values. The Developer ID identity can be shared by apps belonging to the same developer/team. Export the certificate plus private key through Keychain Access; encode it locally with `base64 -i /path/to/certificate.p12 | pbcopy`, then paste into the GitHub secret. Never put the certificate or passwords in source control or chat.

Run **Arca** again with **sign_macos** checked and **publish** unchecked. This verifies signing, notarization and the packages before public distribution. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) for certificate and notarization setup.

### Configure Docker Hub (same as Alf)

Create `satoshiltd/arca` in Docker Hub, with the intended visibility. Add `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` to this repository's Actions secrets, matching Alf's names. The token must belong to an account authorized to push to `satoshiltd/arca`; grant read/write access, not delete access. Existing organization secrets can be shared with Arca if their account/token has that repository permission. Do not put the token in source or chat. These secrets are only needed when publication is selected.

### Publishing a new version

1. Ensure `package.json`, `package-lock.json`, Tauri configuration, `Cargo.toml` and `Cargo.lock` agree on an unused version (`node scripts/check-release.js`). The checkout is prepared as `0.3.0` with its changelog entry; commit and push still require authorization. Existing release tags cannot be overwritten.
2. Push the new version to `main`. Publication runs automatically after all build/test jobs succeed. Manual publication remains available via **Run workflow → publish**, with **sign_macos** unchecked.
3. The final job publishes `satoshiltd/arca:X.Y.Z` on Docker Hub and `ghcr.io/satoshi-ltd/arca:X.Y.Z` and the GitHub prerelease `vX.Y.Z` for the selected version, with installers and `SHA256SUMS`. Both registries also receive `latest`, matching Alf. During this phase, `latest` is an alpha, not a stable-release guarantee. GHCR authentication uses the built-in `GITHUB_TOKEN` with `packages: write`.
4. If anonymous Docker pulls are wanted, open the organization's **Packages → arca → Package settings** and set the package visibility to public when organization policy permits. Otherwise consumers need registry authentication.

The two registry uploads, latest aliases and GitHub release creation are separate operations: if the last step fails after the image upload, that versioned image can already exist. Inspect the failed run before retrying; do not change source and reuse that version. No installed daemon is restarted by publishing.

Local packaging: `npm run desktop:release` creates platform installers, while `npm run desktop:build` retains the existing local macOS app workflow. The release script signs embedded Node on macOS before signing the app. Windows signing and automatic updating remain separate, unimplemented work.

## Documentation and private deployment maintenance — September 8

README owns concise entry commands; this specification owns release setup and the design system. Removed obsolete handoff README, UX-BRIEF and copied arca-spec, retaining original visual assets and all vendor documentation/licenses. Consolidated old validation/staging diaries and contradictory mobile UX alternatives. README, AGENTS and SPEC are the three maintained project documents; changelog records releases separately. No extra handoff/status document was created.

The private ignored update-docker helper is prepared. Its --check mode passed against the real Casa hub (six shares, idle); no deployment, daemon restart, source upload, state change or commit was performed during documentation maintenance. Six isolated command-double scenarios passed: read-only check, paused hub, failed tests, failed image build, successful deployment/postflight and failed source-hash verification. They exercise command ordering and failures, not actual Docker execution. End-to-end deployment remains unexecuted in this maintenance task.

## v0.3.0 staging — September 8

User requested staging the current product changes and a coordinated 0.3.0 version bump. Root/Docker runtime, desktop/Tauri, mobile Expo and native networking module versions agree; mobile iOS buildNumber and Android versionCode advance to 2. Docker publication tags derive from the root version. Pre-commit verification of the final staged source: 144 Node tests passed, one platform skip; Android/iOS JavaScript exports passed; release versions, relative imports, excluded private files and staged whitespace checks passed. Native installer/device acceptance remains open. No image publication, deployment, native rebuild, commit or push is part of staging. Private deployment helpers remain Git-ignored.

## Unused-file cleanup — September 8

Removed the empty root Expo app.json and unused generated Tauri icon variants: 64px, Microsoft Store logos, generic PNG and Tauri Android/iOS sets. Desktop keeps every configured bundle icon and all native tray assets; Expo keeps its separately configured mobile assets and generator. Removed the obsolete Prettier exclusion for the absent legacy Syncthing spec. These removed assets were already Git-ignored; no product module was removed without a confirmed unused reference. Private operational/test helpers, dependency licenses, visual references and running/generated native runtimes remain intact.

## Ignored-file audit — September 8

Removed unused demo.js/try.js launchers, the old live-mutating verify-casa.js smoke helper and the obsolete Ubuntu subset Dockerfile. Isolated tests and the release workflow are the maintained validation path. Removed their ignore rules and the rules for already-deleted placeholder/icon variants. Existing .demo data was not deleted as source cleanup.

Retained ignored tools have specific purposes: update-docker updates only Casa; deploy-pilot rebuilds/restarts both Casa and the Mac runtime when explicitly requested; verify-deployment checks deployed source parity read-only; verify-scale and verify-resilience cover isolated long-running release qualification; tray-badges.swift regenerates native tray assets. Casa Compose and the Tailscale-export installer are private installation configuration. Original visual references remain used for design review. Dependencies, runtime/build output, Expo native generation and local state stay excluded and are not incidental cleanup targets.

## Design system and interactions

Desktop/web primitives live in `apps/desktop/src`; native primitives and mirrored tokens live in `apps/mobile/src`. This section is the current design contract for all three surfaces.

### Foundations

The implementation sources are `apps/desktop/src/tokens.css`, `style.css`, `app.js` and `tray.js`. Bundle Instrument Sans, Fragment Mono, Lucide and the Arca mark locally. Product copy is English; user names, paths and content are preserved.

| Foundation | Contract                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color      | Semantic paper, surface, sidebar, text, border, brand and state tokens; light, dark and system modes. No component-specific palette.                                                           |
| Type       | Caption 11px, body 12px, controls 13px, row title 14px, page title 20px. Instrument Sans for UI; Fragment Mono for paths, IDs and revisions.                                                   |
| Rhythm     | 4, 8, 12, 16, 20 and 24px spacing tokens. Dense rows use compact spacing; sections get more separation than fields.                                                                            |
| Shape      | Tags 6px, controls 8px, cards 12px, dialogs 14px, pills fully rounded. Compact inner rows may use control radius.                                                                              |
| Controls   | Standard buttons have a 32px minimum height. Primary for the main next step, secondary for supporting actions, text buttons for contextual navigation.                                         |
| Elevation  | Menu and dialog shadows use tokens. Ordinary cards use borders, not shadows. Dialogs use the native top layer.                                                                                 |
| Layout     | 200px desktop sidebar; fixed heading and independently scrolling content. Default dialog width 480px, with narrower restore and wider conflict variants.                                       |
| Responsive | At 760px, headers stack, details become one column and rows wrap. At 480px the navigation is compact and dialog actions wrap. Long names and paths must not push actions outside the viewport. |

Small secondary text uses `--mute`: light `#627168`, dark `#8B9A90`. Status is always conveyed by text and an icon as well as color. Focus uses a visible green outline; toggles and composite fields retain their own focus treatment. Preserve native keyboard activation and dialog focus containment.

### Navigation and hierarchy

Web and desktop use hash routes: `#/folders`, `#/folders/SHARE_ID`, `#/machines`, `#/history` and `#/settings`. History preserves `volume`, `path` and `filter` query parameters inside the fragment. Direct links, reload and browser Back/Forward restore the selected view; login preserves the requested route. Unknown routes or missing local shares return to Folders.

Folders, History and Settings are shared across desktop and web. The machine view is always labelled “Machines” on hubs and replicas, in web and desktop, using `#/machines`. Mark the current page with `aria-current`. Retain the same component geometry and state vocabulary across roles; vary data and actions according to real permissions.

- **Folders:** selected working copies first, available shares second. Header exposes Pause sync / Resume sync. Sync now is available when not paused or already syncing. Choose folders is the replica's primary action; the hub owns share creation.
- **Folder detail:** name and local path, machine-wide pause explicitly labelled Pause all sync, local Finder action where supported, four summary cells, a Files/Recent browser and local-copy controls. Files opens subdirectories with breadcrumbs and bounded pagination; selecting a file opens its detail with a return to Folder. Recent retains accepted revisions and an All history link. Unlink stops materialization here and preserves files and history.
- **Machines:** common hub/machine/discovery row structure. Pairing and revocation belong to the hub. Discovery is not linking, network presence is not verified sync, and remote reports carry their real freshness.
- **History:** day groups and bounded pagination. A shared-folder dropdown defaults to “All”; Conflicts and Deleted remain separate, mutually exclusive toggle buttons. Clicking the active type filter clears it. Folder selection and type filtering combine, and changing either preserves the other. Restore creates a new revision. Never predict its revision number or invent event metadata.
- **Settings:** group identity, service, access, appearance and maintenance. Advanced explanations belong with their control or in a dialog; avoid repeating counts and status already shown in the same row.
- **Tray:** content-sized 320px popover, status summary, boxed folder rows and compact actions. Pause for 1 hour is machine-wide. Quit closes the app and leaves the daemon running.

The shared dropdown uses a 32px minimum control height, 13px Instrument Sans, control-radius borders, semantic surface/text colors and a Lucide chevron. Its menu uses the shared menu shadow, compact rows, a check beside the selected option, and tokenized hover/focus states in light and dark themes. Long labels truncate and long menus scroll. Arrow keys, Home/End and typing navigate options; Enter/Space select; Escape, Tab and outside clicks dismiss. Focus returns to the trigger after selection or Escape. The History folder selector uses this component rather than the OS-native select menu. Isolated browser review checked the open menu in light/dark themes, long-label truncation and keyboard selection; the eight desktop DOM/API tests pass. Deployed to Casa and the Mac runtime; the real Casa History page shows the dropdown. The desktop is running in Vite development; native-wide visual qualification remains separate.

### Managed role and access surface

The frontend components are shared, but the installed desktop daemon does not publish a web panel or browser authentication. Server installations provide the browser UI; desktop uses the native bridge and tray. Vite remains a development-only UI server. Role determines machine authority; web/native determines browser session and OS capabilities. Never infer remote administration from pairing.

| View          | Hub                                                                       | Replica                                                                                                      |
| ------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Folders       | Create shared folders, inspect catalog and hub working copies             | Select folders and choose independent local destinations                                                     |
| Folder detail | Rename, edit policy, disable hub working copy, delete catalog/history     | Open/move native local copy and unlink locally; shared history remains accessible                            |
| Machines      | Issue pairing codes, remove authorized machines, inspect reported backups | Connected hub and explicit disconnect/reconnect, local machine status; discover hubs only while disconnected |
| History       | Shared history and restore                                                | Shared hub history and bidirectional restore while connected; disconnected view requests reconnect           |
| Settings      | Hub synchronization, machine authorization, reported backups, retention   | Hub connection first, local synchronization and optional full backup; replacement-hub recovery is advanced   |

Web alone shows current-browser Sign out and Sign out all browsers. Desktop alone shows launch at login and native notifications. Settings sections are always expanded, including Network, Service and Recovery; do not use disclosure toggles or accordions for these sections. Backup workers are internal to desktop/server replicas; they have no independent UI or public daemon.

Disconnected replicas retain visible local folders and paths; folder details explain that history and synchronization require reconnection. No automatic pairing happens on launch or discovery. Disconnect removes the hub registration and the active local credential, including the optional backup runtime’s saved token. The same Disconnect action appears on both sides. A desktop request requires a reachable hub and remains retryable on failure; a hub request is reflected on the replica at its next authenticated contact, including after being offline or paused. Reconnecting to the original hub keeps selections and reconciles offline edits. Backup remains off until explicitly enabled. This interaction is covered by isolated real API and native-bridge DOM tests and is deployed to Casa and the Mac runtime with matching code hashes. Browser previews are not full native qualification.

### State and progress

Use Up to date, Syncing, Scanning, Paused, Pending, Conflict and Needs attention consistently. Unknown values are unknown, never zero or success. Use “No completed sync yet” instead of “Last completed Not yet”. A selected folder is only up to date after verification.

View fetches retain the current content and display the indeterminate top line. The line is activity feedback, not a transfer percentage. Do not replace an entire populated view with a loading message during refresh.

Transfer progress uses actual counters for each phase: files sent during upload and files checked during receipt/verification. Show bytes only when the current file has a nonzero known total. Empty files still advance the file counter. An unknown total is indeterminate; never simulate a percentage. Paused folders stop displaying active transfer progress. The count can restart when the phase changes; copy identifies the phase.

Pause acts on the machine, not an individual folder. Unlink acts on one working copy. Cooperative interruption occurs between operations/chunks; an in-flight network call can still take time. Do not describe pause as deleting data or stopping the daemon.

### Feedback and dialogs

Global feedback floats bottom-right outside layout flow with a 20px inset. Width fits the content, capped at 380px and the available viewport; height is capped at 240px or 40% of the viewport, with overflow scrolling. Success feedback follows the handoff toast: ink background, light 13px text, 16px accent icon, 10px radius and a compact borderless dismiss control. Error feedback uses a neutral surface and border, readable ink text, a small semantic error icon and neutral recovery/dismiss controls; never combine a red panel with green actions. Mobile follows the same treatment, with 44-dp touch targets and compact readable text. Native file-picker cancellation is a normal exit: no error, retry prompt or success notification. It must not displace the heading. Long details scroll within the notification. A modal appears above global feedback.

Present one actionable explanation per incident. Synchronization errors use the shared floating notification, including folder errors reported before the global status catches up. Folder-detail pages do not render a separate error banner. Compact folder/sidebar status may remain visible. Errors have a concise explanation, an appropriate recovery action and optional technical details. Actionable errors do not disappear on a timer. Dismissal suppresses the identical status error until it clears or changes; polling preserves expanded details and does not replay the animation.

Dialogs use a title, short consequence statement, necessary fields or preview, then Cancel and a verb-labelled action. Keep preservation consequences for unlink, restore and cleanup; trim implementation narration. Destructive actions retain their semantic color and explicit confirmation.

Submitting a dialog shows a busy indicator on its existing action and exposes `aria-busy`. Keep the action label stable. Disable duplicate submission and Cancel while that operation is pending; Escape/backdrop dismissal is also blocked so it cannot imply cancellation of accepted work. On failure the dialog stays open, shows the error and re-enables controls. On success it closes or advances to the next explicit step. Busy feedback does not promise a percentage or a backend timeout.

### Motion

| Token                   | Value / use                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `--motion-fast`         | 120ms — hover, focus-adjacent color changes, toggles, determinate progress |
| `--motion-enter`        | 200ms — notices, menus and dialog entry                                    |
| `--motion-exit`         | 140ms — dialog and notice exit                                             |
| `--motion-ease`         | cubic-bezier(.2,.8,.2,1)                                                   |
| `--motion-distance`     | 8px — restrained entry/exit translation                                    |
| `--motion-dialog-scale` | .985 — subtle dialog entry scale                                           |
| `--motion-loop`         | 1200ms — indeterminate top line and pending action indicator               |

Animate opacity and transforms for overlays; avoid animating layout dimensions. Native dialog display/overlay transitions are progressive enhancement: unsupported engines close immediately. Reduced motion sets transition durations and movement to zero and uses static activity indicators. Existing sync-dot animation also respects reduced motion. No decorative animation on every poll or row update.

### Copy rules

The sidebar shows the `arca` wordmark and one machine identity row (name and Hub/Replica/Backup role). Do not repeat the name beneath the wordmark or add “Managing” before the same name. Sidebar backup uses compact “Hub backup”, “Backup on” or “Backup off” labels in body-sized secondary text; the hub label opens its records and does not assert that a backup exists.

Use “shared folder” for a hub-published folder and “local copy” for its working directory on a machine. “Folders” is the navigation section. Contextual renaming uses “Rename”; creation/deletion use “Create shared folder” and “Delete shared folder” to retain scope. Technical/API identifiers may continue to use share/volume. Desktop has no browser session. Settings exposes “Disconnect…” from the hub for replicas, with confirmation that synchronization and optional full backup stop while files and destinations remain. “Reconnect…” requests a fresh six-digit pairing code. Quit leaves the daemon running. Browser-session actions appear only in web and explicitly affect browsers managing the named machine.

Browser transport failures use an actionable connection message. Retry an interrupted GET once; never automatically replay a mutation or a single-use login. After successful login, a loading failure offers Retry using the established session. Connection notices clear when status recovers; mutation failures with unknown results remain explicit. A transport error alone does not identify whether the cause was the network, a daemon restart or server load.

Use short sentences and concrete verbs: Start syncing, Create share, Restore as new revision, Unlink folder. Prefer one piece of information per location. Move paths, IDs and protocol detail below the main label. Avoid repeating folder counts on both sides of a machine row. Never translate user-owned names. Keep operational constraints where they affect a decision, not as permanent explanatory paragraphs on every screen.

### Boundaries and qualification

The frontend must not invent remote completion, TLS, available disk space, hardware details or category icons. No per-folder pause, automatic linking, automatic promotion or remote installation is implied. Mobile is an implemented replica with separate device-qualification limits. OS notifications remain native and opt-in; custom notification buttons from the prototype are not implemented.

The September 6 refinement includes shared size/radius/layer tokens, improved secondary-text contrast, focus and overflow handling, animated switches and pending dialog actions, and shorter detail copy. DOM/API regression covers an in-flight restore: busy state, prevention of misleading cancellation and restoration of controls after completion. Visual qualification is recorded separately; this document does not certify every possible data state or pixel equality with the prototype.

#### Validation boundary

DOM/API tests cover notification uniqueness and dismissal, inline path validation, immediate local folder rendering while the hub is pending, and dialog submission. Rust tests cover tray state selection and asset dimensions. Native assets were previewed on light/dark backgrounds at 18pt and enlarged. The macOS bundle builds with an ad-hoc signature. Full interactive native visual/accessibility qualification remains open; do not claim pixel-perfect certification from a generated preview alone.

#### Starting folder sync

Use “Start syncing” with the sync icon when connecting a local destination. Explain that sync is bidirectional and existing local files upload too. Keep the destination hint short; state that `.arcaignore` exclusions stay local and other changes, including deletions, propagate. Do not describe this action as download-only.

#### Share settings and copies

Hub folder details group “Rename” and, for an active hub working copy, “Edit .arcaignore…” in the top action bar immediately after “Pause all sync”. They use the existing secondary buttons and responsive wrapping. There is no separate Share settings card in the sidebar. Rename changes the shared display name; IDs and all physical destinations stay unchanged. Replicas receive names through catalog synchronization. The rules editor uses a monospaced textarea with existing file contents, explicit Save rules, the 64 KiB limit and stale-edit rejection. Missing policies stay absent until saved; empty rules include all supported files. Saving versions and synchronizes the policy without changing the existing conflict safeguards.

“Copies” replaces “Copies known here”. Both interfaces consult the hub's authenticated per-share reports, with current local selection taking precedence. Show reported machine names and role/current-machine tags; remove “Local copy selected”. Reports older than two minutes or retained while the hub is unreachable are last known, not proof of completion. Old clients without folder IDs remain unknown. Selection and unlink attempt immediate reports even while paused; regular reports and five-second view refreshes provide eventual consistency, not real-time delivery. Backups retain their separate summary; this list is not a full recovery audit.

On the hub, “Hub working copy” → “Disable local sync…” stops updating its physical working directory while keeping the share, content and history available to replicas. Files stay on disk. “Delete share…” is a separate action affecting the shared catalog and history across the network. Replica unlink keeps its existing semantics. Neither action is a per-folder pause.

These changes are implemented and covered by isolated API/DOM tests and a browser review of the copy list and rules editor. Casa and the Mac LaunchAgent runtime are deployed with matching source hashes. The rebuilt macOS bundle passes its smoke test; live Casa History confirms the custom dropdown. Full native visual qualification remains separate.

#### Deleting a share

Hub folder details expose “Delete share…” separately from local-copy “Unlink”. The destructive dialog requires the exact share name and states that catalog/history are deleted while physical files and existing backups remain. The action returns to Folders. Replicas detach after refreshing the authenticated catalog and preserve their local files.

#### Desktop / web replica unlink

Unlink opens a confirmation naming the selected folder before sending any mutation. Cancel retains its registration. Background status polling never owns the foreground action lock: a slow refresh must not swallow Unlink or other clicks. Polls do not overlap; responses superseded by a user action/newer read are discarded, and a background render cannot replace a newer view or open dialog. Isolated native-bridge/real-API coverage verifies confirmation, cancellation, completed unlink and file preservation while a stale status request is deliberately held open.

Unlink removes the local share mapping, local index and matching `.arca-volume` marker. It preserves ordinary files, `.arcaignore` and conflict copies; the hub catalog/history remain. Relinking is a fresh explicit selection, with existing files compared as local content. Pause retains the link. Hub local-copy unselection is separate from Delete share.

#### Local file preview

After validating an existing sync destination, show “Counting local files…” followed by a single caption with count, size and available space. Count file metadata after `.arcaignore` filtering; never describe this as exact transfer size. Preview does not create files or hash contents, does not follow symbolic links, and reports incomplete counts instead of displaying a partial result as a total. Counting does not block starting sync. Omit the redundant “Choose a new or existing folder” hint.

Folder destination feedback uses one caption line: existing folders show local file count, size and available disk space; new folders show only “New folder · available space” and skip counting. Inline validation errors use an alert icon, error text and an invalid field border, without a full-width colored pill. Feedback is associated with the input using aria-describedby and aria-invalid.

#### Brand casing and default paths

The handoff’s wordmark is lowercase `arca`; prose continues to use `Arca`. New desktop onboarding roots and suggested destinations use `~/arca`. Existing linked paths and user content are preserved. Duplicate destinations use the short field error: `Already linked to "name". Choose another folder.`

Folder lists render local status immediately. Remote catalog refreshes run in the background and preserve the last known catalog on failure; an unavailable hub must not leave the desktop on its startup placeholder. The floating notification retains its flex layout, padding and action alignment in the authenticated application, not only in access mode.

The macOS menu-bar icon preserves the original arca mark. A small upper-right check badge indicates a completed sync with no pending selected folders, errors or conflicts. Pause has a separate full-contrast pause badge, with the arca mark at 45% opacity, and takes precedence over completion. Active sync uses a circular-arrow badge with the same dimensions as synced, paused and alert; unverified/stopped/error states never show the completion badge. Icons remain monochrome macOS templates so the system adapts them to light and dark menu bars. Generate badge assets with `swift scripts/local/tray-badges.swift` on macOS.

The tray has four status badges: syncing, synced, paused and alert. The unbadged logo is reserved for startup or an unverified state. Alert uses an exclamation badge for sync errors, backup errors or conflicts; explicit pause retains the pause variant. All assets use a fixed 48×36px Retina canvas, rendered at 24×18pt by the tray library. Badges share a 20px diameter (10pt) and center; the arca mark is drawn from its original arch proportions rather than upscaling a small bitmap. Native status reads and pause responses update the icon from the same status used by the tray menu; applying the image and its macOS template flag is one operation.

### Permissions and factual presentation

Web manages the server serving the page; native desktop manages its local daemon. “Managing” is not a remote-machine switcher. Hub admins alone create/delete shares, issue pairing codes and remove machines. Replicas choose local destinations and edit bidirectionally. Discovery is not authorization; unknown metrics are not zero. Machine reports are authenticated, timestamped snapshots, not live completion guarantees. No TLS label for HTTP over Tailscale.

Code inputs preserve leading zeroes, accept grouped paste, and clear on sign-out/expiry. Six numeric digits, single use and ten-minute expiry are backend facts, not illustrative placeholders. A new code replaces the previous one; do not invent remaining attempts or a countdown without source data.

The original handoff may show unsupported actions: per-folder pause, automatic linking/promotion, predicted restore revision, custom OS-notification actions or fictional machine metrics. Current spec and user decisions take precedence. Hub Delete share is now implemented separately from local-copy unselection, despite older handoff text.

### Continuing design work

Use existing tokens and shared components. Keep controls stable during loading; preserve local information during remote failures. Inspect the actual running build after native changes. When changing an icon, validate all states on one fixed canvas; when changing feedback, verify both inline validation and floating alerts. Avoid broad CSS consolidation during a small behavioral fix. Update this document for a changed decision, not with an append-only transcript of experiments.

Automatic working sync uses debounced local events and incremental remote checks. Sync now explicitly requests a full reconciliation and can retry immediately after an automatic retry delay. A synchronization interval is not a completion-time guarantee; pending/error states remain visible until work completes. Mobile background execution is not implemented by the desktop scheduler.

The hub pairing dialog shows at most two copyable reachable addresses separately from the pairing code. Keep the primary browser hostname/address and the detected IP first. Copy address shows “Copied” only after successful copying. Prefer the current non-loopback browser origin; offer detected Tailscale IP/DNS addresses within that two-address limit, never the machine display name as an invented hostname. Native hubs use detected addresses. Explain Machines → Connect to hub, the full URL/port and automatic verification of Tailscale. No private-network checkbox appears in pairing or onboarding. Generating a new code invalidates the previous one. Replacement-hub recovery states its file-preservation consequences and uses “Replace hub and reconnect” as the explicit action, without a redundant checkbox. Disconnected machine rows use a static unlink icon and warning tone, never the busy animation.

“Remove machine” confirms loss of access and deletion of its saved registration and connection reports. No revoked-machine list is retained. Files and revision history remain; reconnecting requires a fresh pairing code.

Clipboard fallback on HTTP creates its temporary text field inside the open dialog, because the rest of the document is inert. It restores focus and removes the temporary field afterwards. Desktop uses its native clipboard bridge; web tries the browser clipboard and falls back if unavailable or denied.

#### v0.2 interaction refinements

Every Copy action (path, address, pairing code and diagnostics) uses the same button feedback: check icon + “Copied” for two seconds, then restores its label. Successful copying never creates a toast; failures use the existing error handling. Desktop Preferences contains actionable preferences only; the informational Closing Arca row is removed, while quitting still leaves the daemon running. Native interface labels are not text-selectable; inputs, text areas, paths, monospace diagnostics, code and errors remain selectable. Web text selection stays unchanged.

Backup visibility: Machines refreshes when local backup state or hub device acknowledgements change, and the replica row shows “Backs up hub” when enabled. Settings updates completed-backup status and size without replacing editable controls. The size shown beside the date in “Last completed backup” means indexed content bytes across retained versions, counting identical hashes once; it excludes database/filesystem overhead and is not a disk-allocation measurement. Omit size until a successful backup records it. Settings uses one compact line with date and size; there is no separate size row or explanatory paragraph.

Folders and the recovery dialog use the same selectFolderButton component: “Select”, download icon, secondary small-button styling. Do not substitute a zero-horizontal-padding text button.

#### Shared component audit — v0.2

Folder Files/Recent, History filters, Theme and Network mode use the same segmented component with named groups and aria-pressed state. Notifications, backup and launch-at-login use one toggle component. Folder selection uses the same secondary small Select button in Folders and Recovery. Embedded directory pickers use a named icon-button with a 32px target in the shared field-with-icon wrapper; do not use text buttons as icon controls. Pairing Copy code/New code use secondary small action buttons; text buttons remain for contextual navigation/history links. Use the control radius token for compact buttons. Standard button focus has one outline; composite fields retain their containing field focus and an inset picker outline. Textarea, confirmation and retention inputs have associated labels. Tray disconnection uses a static unlink warning for both the heading and saved folders, matching the main app instead of a success check.

### Closeout copy review — 2026-09-07

Implemented closeout copy: System notifications names OS alerts explicitly. Local completed backups say Completed; hub reports say Backup reported and retain revision/date information without promising freshness. Launch at login appears only on macOS; other platforms use machine/folder wording. Recovery shows Available with the last local sync date, not Ready / Local copy synchronized. Known errors, pending transfers, missing directories and active backup block promotion in the backend. Core Folders/Machines naming and destructive-action file/history consequences are consistent in the reviewed source. This source review does not replace an interactive pass in the final Windows/Linux/macOS installers.

Progress bars use the green accent in both themes, matching the view-loading line. Blue remains the activity/information state color (Scanning, Syncing, discovery). Native main-window zoom follows Alpi: Command +/-/0 on macOS, Control +/-/0 on Windows/Linux; 70–150% in 10% steps, reset to 100%, persisted locally. Zoom scales the whole UI; tray sizing and browser-native zoom are unchanged.

Web access uses the fixed lowercase brand heading “arca”; the server role, machine name and browser host/port appear beneath it. Discovery never replaces the brand title.

Further v0.2 polish: hub backup summaries distinguish Reported (with actual report date/revision) from Pending (no report yet). Do not show a backup size without a completed backup timestamp. Recovery calls the setting Full hub backup, uses plan data consistently for disabled actions, and explicitly explains an empty recovery catalog. Long settings labels, descriptions and login addresses wrap instead of pushing controls out of their containers. Verified the isolated web login visually with fixed arca heading and hub/name/address beneath it.

Recovery copy uses “Replace hub [name]” and “Make this machine the hub”; the shorter introduction avoids repeating the existing file/history warning and explicit old-hub confirmation. The targeted desktop/zoom suite passes all 18 tests.

The tray header omits the local machine name: it shows the synchronization state and Last completed HH:mm (24-hour time), or Not yet verified. The role badge and folder names remain.

### Mobile reference review — 2026-09-07

Implemented locally, with device qualification still open. User-provided eight phone mockups guide the mobile adaptation of Arca: warm neutral surfaces, green accent, Instrument Sans/Fragment Mono, outlined cards, consistent buttons, bottom sheets and bottom navigation. Apply the current desktop decisions over older mockup details: accent-colored progress, concise copy, no disabled proposed-feature controls and no technical promises unsupported by implementation.

Mobile must match desktop replica functionality and can never be a hub. Keep Machines accessible for connection and replica identity/actions; bottom tabs are Folders, Machines, History and Settings. No hub admin, share creation, pairing-code generation or promotion UI. Optional full backup remains a replica capability in scope.

Reference text is not a platform contract: SecureStore uses iOS Keychain/Android Keystore-backed storage; do not claim token storage in the Secure Enclave. Discovery, identity verification, Files integration, available-space reserves and background progress must reflect actual implementation. Show only applicable states, not the mockup's simultaneous sample offline/revoked/low-space banners. Offline, paused, incomplete, revoked and waiting-for-space remain distinct; completed local content remains readable when connectivity or authorization is lost.

Current mobile implementation: shared native Button, Field, Card, Badge, Icon, Toggle, CopyButton, Progress and Sheet controls use light/dark palettes matching desktop. Four bottom tabs are Folders, Machines, History and Settings. Native system font scaling and accessibility roles are retained. Pairing uses one six-digit field with paste/autofill. Completed local files and catalog-only folders have distinct states; disconnected state is static. Progress uses the green accent.

Folder selection explains space and full-copy behavior. Browse uses directory navigation, search and paginated rows; file actions include open/share, editing, import, history, restore, deletion and conflict review. Photo imports require explicit native selection. Settings groups pause/background work/system notifications, full backup, storage and theme. Last completed backup shows date and size together. Export is explicit. Copy actions use Copied feedback for two seconds without a success toast.

Only applicable states are shown. Background copy explains OS scheduling without promising continuous sync. Credentials are described as secure storage, not Secure Enclave. Mobile has no hub controls. Installed iOS core flows were inspected; native picker/export, Android interaction and physical-device qualification remain open. Existing Android emulator checks are recorded in the spec; physical-device qualification remains separate.

The open mobile folder refreshes after automatic synchronization finishes. Async file listings cannot overwrite a newer navigation request. Last completed sync belongs to the current hub, so connecting to another hub cannot inherit the previous hub's completion date. System notification delivery failure does not stop file synchronization; the underlying sync error remains visible in the app.

### File history detail — September 8

Opening a file from Files, Recent or History uses a dedicated detail header, matching folder detail: back to its originating folder or History, file icon/name and shared-folder name. The header gives the file name the full width. Below the summary, reuse the folder detail grid: revisions on the left and a File location panel on the right, with the shared-folder name and wrapping relative path. View folder belongs in the File location panel. Open in Finder / Open file remain in the header, aligned at the top right beside the title. The title uses the remaining width and wraps long names; actions wrap on narrow screens. The grid becomes one column on narrow screens. Global folder/conflict/deleted filters belong only to the history list; returning preserves the selected folder/filter. A separate summary shows hub availability, accepted size, latest revision/author and last-change date. The revisions section has clear spacing and labels the latest revision Current; Restore appears only for older content revisions. Desktop header actions appear in this order: Open in Finder (macOS only), Open file; View folder is in File location. Open in Finder reveals the local working file selected in Finder; Open file opens it with the default application. Both file actions require a local folder and a non-deleted current revision; web hub Download file retrieves the latest accepted content. Deleted files have no current-file access action. View folder navigates to the owning folder.

General History and folder recent revisions open file history from the whole row, with a file-specific accessible name and Enter/Space keyboard activation. Use the same bare, muted chevron-right as Folders, without a separate arrow button. Navigable history rows show a hover background and an inset keyboard focus outline. Remove the ambiguous Show label. Conflict rows use the existing icon and chevron without a duplicate Review label. File details expose Resolve conflict explicitly. Restore remains an explicit action. Shared buttons, tiles, stats, section headings and history rows are reused, with wrapping and compact layouts at narrow widths.

### Mobile first launch — September 8

A device with no saved connection or cached hub catalog opens directly on Pair with your hub. Hide the application header and bottom tabs until paired; do not show misleading Disconnected or empty-folders panels during first setup. Reuse the Machines pairing form: brand mark, short full-copy explanation, device name, hub address, six-digit code and Pair this device. No hub-role selector or root-directory picker exists on mobile. Credential copy says secure storage, not Secure Enclave. Devices with a retained catalog still enter the normal offline/reconnection interface. Loading secure storage precedes setup rendering. Android status-bar text follows the active light/dark palette.

Verified visually in the user's existing Android development emulator over Metro, without starting another emulator or rebuilding. Pairing is now being prepared over the explicitly enabled Casa LAN connection instead of requiring Tailscale.

#### Hub local network access

Settings → Network uses the shared toggle for **Allow HTTP on local network**, hub-only and off by default. Its English description explicitly covers pairing/sync without Tailscale, unencrypted files and credentials, and the need for a reachable LAN port. It does not pretend to configure Docker or the router. Save failures restore the previous visual value. Standalone/Tailscale selection remains independent. Mobile pairing explains HTTPS, Tailscale and explicit private IPv4 LAN access; older native builds report that an updated development build is needed. Disabling access preserves saved pairings and files rather than displaying a revocation.

September 8 Settings refinement, deployed to Casa: network controls are grouped into Tailscale (connection mode and explicitly labelled Tailscale addresses), Local network (shared HTTP permission toggle and concise encryption text) and Machine discovery (refresh and a statement that detection does not pair). Local-network help explicitly allows coexistence with Tailscale. Retained existing sections/cards/rows/segmented controls/toggles; no accordion or new styling system. Removed cache timings from product copy. The 16 desktop DOM/API tests pass. Reload Casa to see the updated web asset.

Android onboarding is now verified through real LAN pairing: installed the updated EAS development APK on the existing emulator, connected its AndroidWifi network, paired as Android emulator and inspected Folders showing Casa’s five shares. No shares were selected or downloaded during this connection check.

#### Mobile desktop parity and Fold — September 8

Mobile uses the desktop typefaces, palette, Lucide icon geometry, grouped surfaces, accent-colored switches and progress, secondary buttons and whole-row chevron navigation. Touch targets remain at least 44 dp. Phone uses four bottom tabs; a usable window at least 700 dp wide and 500 dp high uses a sidebar (64 dp below 1100 dp wide; 200 dp above) (676-dp exit threshold avoids fold transition flicker). The same content tree keeps navigation/dialog state through the transition. First pairing remains a centered narrow flow without app navigation.

Folder back navigation sits above its title. Selected folders show actual completion state/date; available shares use dashed rows and Select… actions. File lists and activity use grouped rows with chevrons. Per-file history is separate from the activity list so opening it cannot replace the main list. Initial history retrieval shows loading. Settings groups related rows; backup completion keeps date and size together. Phone dialogs sit at the bottom, while wide dialogs center with a bounded width and scrollable content. Long file names wrap.

Connected replicas list other machines read-only; platform labels use macOS/Android/iOS/Windows/Linux. Hub metadata can use the last observed address when discovery data is absent; it does not infer reachability from that address. Mobile still cannot administer or become a hub.

Visual evidence: the existing Android Fold emulator was inspected closed and unfolded, light/dark, across Folders, Machines, History, Settings and a file-history dialog across folding. Prueba-Arca and alpi-workspace completed actual downloads. This is scoped Android pilot evidence, not universal pixel equality or iOS/physical-device qualification. No extra emulator was opened.

#### Desktop token correction — September 8, midday

The side-by-side comparison exposed oversized mobile rows, transparent secondary buttons, muted metadata and a different success foreground. Mobile now uses the desktop’s exact light/dark surface and text colors (including okFg, hover and dark sidebar), checked against tokens.css by a regression test. Instrument Sans 600/400 remains the UI font, with the separate phone/wide type scales specified below; useful secondary metadata uses soft rather than mute. Folder rows use 8-dp corners, 32-dp tiles, 6-dp list gaps and horizontal status/chevron alignment. Buttons retain 44-dp touch targets and white/surface fill. Local file counts and sizes come from the local index, excluding tombstones; they are not hub totals. Top-level headers omit redundant summaries; folder detail retains local count/size.

Fold widths below 1100 dp use a compact 64-dp icon sidebar with accessible tab names; wider tablets retain the full sidebar. Phone keeps bottom tabs. This supersedes the earlier always-200-dp wide sidebar. Checked visually on the same emulator in phone/Fold; rendering differences between Android and macOS still exist, so this is token and composition alignment rather than a claim of identical OS font rasterization.

#### Fixed view headers and edge-to-edge sidebar

The wide navigation surface spans the full screen height, including behind the system status/navigation areas. Safe-area padding applies inside the sidebar to its controls, independently from the content column. View titles, descriptions, header actions and folder back navigation sit outside the scrolling body on both phone and Fold. Only view content scrolls; phone bottom tabs stay fixed. Changing view/folder starts its body at the top, while folding does not remount the current body. Verified on the existing Android emulator by comparing header bounds before/after Settings scroll in phone and Fold; Android/iOS JavaScript export passed. No new native build.

### Receive files from other apps — September 9

The system Share destination is Arca; the destination sheet is titled Save file (one item) or Save files (several). Saving chooses a local synchronized destination; it is not presented as a direct save to the hub. Copy incoming files to a private temporary cache to retain access while the destination sheet is open. X, Cancel and Android Back cancel the entire unsaved batch immediately, without a second confirmation. Source files and already saved destinations stay untouched. Do not persist session metadata or show a waiting-files banner. Startup cleans abandoned temporary copies; it never restores a pending destination sheet. A new share replaces the old unsaved batch instead of accumulating files. Cancellation during native resolution or copying invalidates late results so they cannot reopen the sheet. Pair first if disconnected from any hub. Never upload before Save. List only shares already selected for sync on this device. Browse their locally known subdirectories or enter a relative subfolder such as workouts/2026. Incoming sharing never selects or downloads another share. With no selected folders or no hub connection, explain the prerequisite and ask the user to share again after setup. Recheck selection at Save. Existing selected folders accept local saves while offline or paused; normal sync uploads later. Existing differing content is preserved by the normal import conflict behavior. Discard never removes source files or synchronized files.

Use the shared Sheet, FolderRow (icon, left-aligned name, metadata and chevron), Button, Field and Card primitives. Show incoming files in a grouped summary and the chosen path in a folder card. Save here is the single primary action. The header X and footer Cancel use the same cancellation operation; no separate discard action or confirmation. Use 12-dp section spacing, one compact file-summary row and contiguous folder rows instead of individual spaced cards. Reject links/text, unsafe paths, incomplete files and duplicate resolved temporary filenames with a recoverable message. Native receipt supports up to 20 files in one transient batch; there is no accumulated inbox. Do not claim every source app or iOS is qualified: Expo 55 incoming sharing is experimental, particularly its iOS extension. A native build is required to register the system target.

#### Hub naming in replica copy

Use Hub / the hub in ordinary replica status, folder summaries, history, backup descriptions and connection copy across desktop, web and mobile. Do not repeat the configured machine name in those sentences. Actual machine identity remains visible where users distinguish machines (roster, copy locations and revision authors); user-assigned names are preserved there. Incoming sharing uses Save file / Save files, never Save to followed by a hub name.

Incoming-share Selected folders rows show the local indexed file count and formatted size (e.g. 15 files · 1.0 KB local), using the same formatter and secondary typography as Folders. Keep the grouped compact rows and chevrons.

### Mobile folder browsing

Folder detail keeps its back navigation, title/local counts and search/sync/menu controls in the fixed header. Files/Recent and the trailing All history action belong together above the explorer content. Search opens from the magnifier, focuses and clears on closing; it covers descendants of the current breadcrumb. Files groups locally indexed directories with recursive counts/bytes and paginates entries. Recent fetches the four latest accepted hub revisions, including deletion/conflict states; it never substitutes local modification times. Loading, error/retry, offline and empty search states are explicit.

A sync cycle updates existing status indicators and the control spinner without inserting a banner or shifting content. Upload, photo import, Save a copy and stop-sync actions use the shared action sheet. New text file is absent. Imports target the displayed subdirectory. Existing-file editing remains in file actions.

#### Concise view headers — September 8

Top-level Folders, Machines, History and Settings do not need explanatory subtitles repeating counts, machine identity or role already shown in their content/navigation. Desktop Folders retains a Disconnected subtitle when applicable; mobile retains its actionable disconnected state. Folder detail keeps its useful local file count/size and exceptional sync state. Available desktop folder rows show only count and size; the section heading already establishes that they are on the hub and not selected. Restore consequences remain in the confirmation dialog, not a permanent History subtitle. Preserve actionable error, empty-state and destructive-operation explanations.

### Mobile Machines and file history parity — September 8

Machines follows desktop replica section order: Hub connection, Machines, Hub backup. The hub row uses the same identity structure as machine rows: server icon, name, HUB tag and known platform/address. It offers Disconnect without a repeated sync explanation. Registered rows omit last-contact text; wide layouts can show reported local totals and state. Linked is neutral and is not a synchronization-complete claim. Backup settings is navigation only and never enables backup implicitly.

Opening file history uses a full detail view, with back navigation to the originating History/folder screen, a filename header, a four-field summary and a single grouped revision list. Current is neutral; Restore remains a small action on older content revisions. File location shows the share name and relative path; View folder and Open/share operate on the local working copy when available. A missing local file gives an explicit message. Phone stacks sections; Fold uses revisions and location columns. No revision-per-card bottom sheet remains. Preserve confirmation and revision-history semantics.

### Desktop / mobile parity audit — September 8

Use desktop replica as the reference for task names, section order, state meaning and destructive consequences. Phone uses bottom navigation and stacked content; Fold uses a compact sidebar and horizontal detail layout. The same view titles remain visible in both. This audit does not make mobile a hub or expose remote administrator controls.

| Screen               | Shared interaction contract                                                                        | Mobile adaptation                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Folders              | Selected and not-selected groups, count/size, Select, sync state, chevron navigation               | Application-owned storage; no desktop filesystem root chooser. Sync now label matches desktop.                                                                            |
| Folder               | Back to Folders, file/count context, All history, explicit Unlink confirmation                     | Files/Recent browsing and explicit import; secondary folder actions in a menu. No watcher claim for files edited in other apps.                                           |
| File                 | Full detail navigation, location, file access, History and explicit edit/delete actions            | Open/share uses the OS sheet. No Finder label.                                                                                                                            |
| History              | Shared-folder filter, All/Conflicts/Deleted, paginated revisions, detail navigation                | Folder selector opens a compact selection sheet. Filters persist when returning from detail; stale filter requests cannot replace newer results.                          |
| File history         | Filename/share header, status/size/revision/date summary, Current versus Restore, File location    | Stacked phone / two-column Fold layout. Returning to an originating file preserves that file view.                                                                        |
| Machines             | Hub connection, Machines, Hub backup; role and state are distinct                                  | Phone wraps metadata; Fold aligns state beside the row. Linked is neutral, not Up to date.                                                                                |
| Settings             | Hub connection, This machine, Local synchronization, platform preferences, full backup, Appearance | Background scheduling and system notifications replace desktop login/service controls; no hub promotion/network administration. Theme order is Light/Dark/System on both. |
| Dialogs and feedback | Cancel for forms, consequence + verb action, errors do not move the view                           | Bottom sheets on phone, bounded dialogs on Fold, floating error notice with Retry/Dismiss. Android Back closes detail/dialog first.                                       |

Keep platform differences explicit and functional. Do not add unavailable desktop controls just to copy a screenshot. System Share reception remains subject to its separately documented native build qualification.

Mobile state badges now follow semantic desktop colors: Up to date is success; Paused/Incomplete/Not yet synced are warnings; Needs attention/Revoked are errors; Linked/Current/Syncing are neutral, with activity shown separately. Late history responses are discarded after tab navigation as well as after filter changes.

#### Mobile text readability

Mobile uses 26/32-dp page titles, 16/22-dp row and section headings, 15/22-dp body text, 14/20-dp secondary metadata, 15/20-dp controls and 16/24-dp inputs. Monospaced metadata and status badges use 12/18 dp; machine role tags use 11/16 dp. Phone and Fold retain the same readable scale, Instrument Sans/Fragment Mono and desktop semantic colors. This supersedes the earlier 12-dp body and 13-dp controls: desktop parity means consistent hierarchy, not shrinking touch interfaces to desktop density. Existing minimum touch targets and native font scaling remain; text containers can grow and wrap. Implemented locally via Metro; native device text-scaling qualification remains open.

#### Mobile stop syncing and remove local files

Mobile's app-owned storage differs from desktop's user-owned destinations. Stop syncing… confirms “Stop syncing and remove local files?” with a “Remove local files” action. It removes only the working directory on this device and its local registration/index, returning the share to On hub · Not selected. Hub files, history and other devices remain. Unreferenced transfer objects are reclaimed; objects referenced by other folders, pending operations or recovery journals remain. Pause and hub disconnect continue to preserve local files.

Before mobile removal, confirm that unsynced changes will be permanently lost and point to Save a copy if needed. Stop the active sync, persist the removal intent, delete only the app-owned working directory and forget its index/queued changes. A missing hub share, offline state or pending local changes must not block this explicitly confirmed local action. Interrupted deletion keeps its durable cleanup marker for retry. Other local folders and remote content remain untouched.

#### Compact machine roster

Desktop, server web and mobile keep Hub connection separate, then one Machines list containing the current machine and other registered machines (including the hub when administering it). Do not split This machine and Other machines into sections. Each item has two content lines: name, Hub/Replica role and This machine tag; then OS and the known network/address. Omit loopback, local daemon ports, app version and Last contact text from registered rows. Tailscale is shown when discovery confirms the peer; an observed IP alone does not prove its transport. Discovered, unpaired machines remain separate and retain compatibility/version information. Desktop/Fold may show a trailing status badge; phone uses the two-line identity/address row with the status retained in its accessibility label. Desktop backup information stays in its own section; mobile has no backup controls. Implemented locally; Casa web requires a deployment to receive this UI.

#### Phone simplification and Fold desktop composition

The September 8 visual review supersedes the same-size phone/Fold typography note: phone retains the readable 26-dp title, 16-dp rows and 14-dp metadata. Fold uses desktop typography (20-dp title, 14-dp rows, 12-dp body, 11-dp metadata and 13-dp controls), while keeping 44-dp touch targets and native text scaling. Match radii by component: connection/settings groups 8 dp, machine/backup rows 10 dp, generic cards 12 dp, dialogs 14 dp. Fold machine tiles are 40 dp, matching desktop, and use monitor/phone icons rather than the navigation icon.

Phone Hub connection is title/address plus a labelled disconnect icon with confirmation, omitting the repeated sync explanation. Mobile has no Hub backup section. Fold keeps labelled right-hand buttons, machine status/totals on the right, monospaced network details, and horizontal machine summaries. Both retain the same information hierarchy and semantic colors. Visually reviewed Machines in phone and Fold on the existing Android emulator; this does not claim every screen or OS rasterization is pixel-identical.

Folder actions now use a compact menu sheet: a modest folder-name header and accessible close icon, neutral 52-dp action rows with icons on the sheet background, and a separated destructive row. Only the destructive action uses red. Show upload/photo import only for selected folders; selection belongs in Folders, never duplicated in the actions menu. The selected folder header offers Sync now. Previous action errors stay outside this menu; they must not reappear as a red introduction when reopening it. Hide remote history while disconnected. Remove the permanent upload explanation and oversized outlined buttons. View history navigates out; export dismisses the menu before the native picker. Removal keeps its existing confirmation and unsynced-data guards.

Explicit mobile actions use a foreground action lifecycle: show a progress label in the open sheet or a floating notice, prevent duplicate execution, refresh the view, and expose errors with a retry of that exact action. Initialization and background synchronization do not use foreground progress notices or swallow user actions. Remove local files closes its menu before work, reports a blocked removal in an explicit alert, and returns to Folders with a success notice only after deletion succeeds. It does not treat the unchanged screen as feedback. Local action errors must never route Retry to an unrelated sync request.

History activity rows expose one chevron navigation target. Conflict rows use the existing conflict icon and open conflict review through the row; they do not repeat a Review button. History filter counts are structured numeric badges, never HTML embedded in a label.

Conflict review is reachable from both conflict activity rows and conflict file/history details. Desktop/web and mobile offer the same two selectable versions (Original file / Conflict copy), paths, timestamps and sizes, followed by one Restore selected as new revision action. Select the original by default unless it is deleted. Keep both and Cancel leave content unchanged; mobile returns to the originating file/history screen. Web can download each accepted version; desktop can open both when local files are available. A stale revision is rejected by the core and leaves the decision open. Restoration atomically records the resolution alongside the new revision, preserving both copies and all history. Resolved copies retain their individual file history but disappear from the pending-conflict filter and counters; conflict-copy revisions are excluded from the default activity list. Editing the conflict copy again reopens it. Replicas can resolve only folders selected for synchronization; the hub validates their reported selection and rejects stale revision choices. Keep both and Cancel only dismiss the review.

History uses the same Lucide glyphs across clients: trash-2 for deleted files (muted, with struck-through filename), git-branch for conflicts (amber), and git-commit-horizontal for accepted revisions. Numeric icon names must resolve correctly; chevron navigation remains unchanged.

Desktop/web file browsing uses the authenticated accepted index, not arbitrary host filesystem paths. Search opens from the magnifier, submits with Enter/Search, and searches nested paths under the current breadcrumb. Closing search clears it. Deleted files remain in History, not Files. The mobile segmented control matches desktop hover/surface colors, 3px track inset, 2px gap, 8px outer/6px inner radii and selected shadow while retaining touch sizing.

File explorer location belongs inside the bordered file panel, in a compact breadcrumb row above its entries. Root and intermediate ancestors are navigable; the current location is plain text. Do not repeat the root as a separate heading between the Files/Recent control and the panel.

Mobile bottom navigation uses the sidebar’s green tint and 8 px corner radius behind the whole selected tab, plus a semibold label. Selection must remain recognizable beyond a subtle icon/text color difference; inactive tabs retain their neutral background.

Mobile SVG icons use the exact Lucide 0.460.0 node geometry from the desktop vendor bundle, rendered through react-native-svg. Named aliases are listed in icons.js and every icon is checked against the desktop bundle in mobile-layout.test.js; no simplified redraws.

Explorer breadcrumbs use the minimum text token (`--text-caption`, 11 px), 12 px icons and a single left-aligned horizontal row with 6 px vertical padding. Long paths scroll horizontally instead of stacking. Sidebar navigation rules are scoped to `.sidebar nav`.

Files and Recent rows share CSS typography and vertical rhythm: title `--text-control` at weight 600, metadata `--text-body`, 2 px between text lines and the same compact row padding. File browser titles must not inherit the browser default bold weight or the body’s larger font size.

The Files/Recent toolbar uses the detail container’s existing 6 px gap to its content, matching File revisions. Do not add a toolbar bottom margin on top of that gap.

Mobile no longer offers a retained, unselected “Local copy” folder state. Explicit unsync verifies accepted bytes, deletes app-owned files and forgets the folder. Interrupted deletion retains its durable cleanup marker and shows Needs attention until removal is retried. A share missing from the hub catalog retains its local index and reports an actionable issue instead of silently discarding sync metadata. Disconnect/offline behavior still preserves selected local files.

Folder actions omit New text file. Save a copy… (formerly Export folder) copies the local folder into a user-chosen location outside Arca, without synchronization or history. Keep file/photo import, history access and explicit stop-sync; existing-file editing is unaffected.

Mobile hub-row action: Disconnect is an icon-only button at the trailing edge of the identity row, with its accessibility label retained. Fold/desktop keep the text label. Keep the action aligned with the identity row, not below it.

#### Shared component geometry

Desktop tokens.css is the canonical reference; mobile design-tokens.js mirrors its geometry and a test verifies every mapped value. Role tags use Fragment Mono 10/14, 6 px radius, 1 px border and 2×5 px padding. Role tags are separate from status pills (Instrument Sans semibold 12/16, fully rounded, 4 px vertical padding). Mobile Tag separates its container from Text and disables Android font padding to preserve the specified line box. Hub uses ink/paper; current-machine tags use tint/deep. Cards use r-card, controls r-control; mobile touch targets remain at least 44 px. All mobile Lucide geometry, including CircleCheck status, is compared with desktop vendor data. Chip/pill dimensions and surface radii now have automated parity checks; this is not a claim that every screen has completed visual acceptance.

All role chips have an explicit 20 px outer height and the same Fragment Mono 10/14 metrics. Hub/self/backup variants only change colors; widths follow label length. Typography uses explicit CSS properties to avoid shorthand inheritance ambiguity.

The desktop/web file breadcrumb bar has a fixed 37 px outer height (24 px control + 12 px padding + divider), including at the root where the current location is plain text. Navigating into subfolders must not shift the file list vertically.

Mobile launcher and launch screen: generate assets from the existing Arca SVG with `node apps/mobile/scripts/generate-brand-assets.mjs` (requires librsvg). The standard icon is opaque, full-bleed brand green; Android uses a separate transparent mark inside the adaptive safe zone over the same green background, leaving the system to apply its circle/squircle mask. The adaptive and themed marks share a 0.72 scale (previously 0.85), giving the centered letter more space after launcher masking. No nested rounded-square tile or white surround. A separate monochrome mark supports themed Android icons and a white/transparent 96 px mark is used for notifications. Splash uses the unboxed mark on the light/dark paper token, with a 160 dp image canvas and contained proportions. Like Alf, hold the native splash through font/local initialization, and release it on success or a renderable startup error. Native assets/configuration require a new binary; Metro does not update launcher/splash resources. Android/iOS launch appearance must be qualified in a standalone/preview build, since the Expo development client has its own launch UI.

App-owned mobile sheets share one header treatment: existing section-heading typography on each breakpoint (16/22 phone, 14/20 wide), a trailing neutral Lucide X with a 44 dp touch target and Close accessibility label, and no content-type-dependent title size or textual Close/Cancel header button. The header remains outside the scroll area; busy operations disable X and Android Back. Native permission/confirmation alerts retain system presentation. Incoming Share dismissal discards unsaved temporary copies without confirmation, following the September 9 transient-receiving decision. This supersedes prior compact-versus-full sheet header variants.

#### Adversarial parity corrections — September 8

Mobile Files searches only descendants of the displayed directory; imports target that directory. Breadcrumbs sit inside the file panel, with stable touch height and horizontally scrollable ancestors. Folder rows include recursive file count and bytes. Recent uses the last four normal accepted content revisions on all surfaces (the same default as History), with a guarded asynchronous request and an explicit offline/loading/error state; filesystem mtime is no longer an alternative Recent implementation. All history belongs at the right of the Files/Recent toolbar, never below the list. The toolbar belongs to the explorer column.

Mobile Settings → This machine uses the shared Machine name input directly in the settings card, matching desktop. Editing finishes on keyboard Done or focus loss and saves only changed values; there is no rename button or separate modal. Names are trimmed, limited to 1–100 characters and reject control characters. Save persists locally and reports through the existing authenticated machine-report endpoint; offline report failures keep the saved name for the next sync. Device identity and pairing remain unchanged. Implemented locally September 9; integration tests cover online rename, validation and offline/reconnect propagation. No Casa deployment is needed.

Mobile manual Sync now and sync-error Retry use the existing control busy indicator without a floating Working/Syncing notice. Folder subtitles retain file counts, bytes and paused state, without appending Syncing. Dedicated status summaries and actionable errors remain available.

Hub tiles and role chips use the shared accent background and on-accent foreground on web, desktop and mobile, including dark mode. They no longer use ink/paper as an inverted neutral pair. Implemented locally September 9; Casa deployment remains user-managed.

Desktop/web role chips use an inline grid with centered content and no flex shrinking; all variants retain the shared tag height, typography, padding and border tokens. This local September 9 alignment adjustment is not deployed to Casa; visual verification in the running Tauri window remains pending.

Explorer empty states stay inside the breadcrumb/list surface without a nested border or dashed drop-zone treatment. Use a muted folder icon and regular body text: “This folder is empty”, or “No matching files” for search. Mobile keeps “No local files yet” while its initial local copy is incomplete. Implemented September 9 and deployed to Casa (`3ed2749f3abe`), with source hashes and existing state verified. Validation: 158 tests passed, one platform skip; Android/iOS exports passed. Mobile runtime visual verification remains pending; no new mobile binary was installed.

On wide mobile windows, folder detail uses summary cells, a two-column explorer/local-copy-and-copies layout, compact segmented controls and desktop-density fields/rows. The sidebar adapts to available width; touch targets remain 44 dp. Phone keeps a single column and readable typography. Last completed is shown instead of inventing an unavailable per-folder revision. Copies derive from reported folder selections. Mobile removal copy explicitly says the app-owned local copy is removed; desktop unlink retains disk files. Do not equate structural parity with identical filesystem capabilities.

Sheets avoid the keyboard and allow landscape, with fade presentation on wide layouts and slide presentation on phone. Role tags centrally uppercase their text. Connection metadata must not infer Tailscale solely from a 100.x address: desktop requires a discovered peer match; mobile omits the unverified transport claim.

Files, Recent and History open the same mobile file-detail component: summary, retained revisions and file location. Wide windows use the desktop two-column structure; phone stacks the sections. Mobile has only Share in the file header. Phone and fold keep View folder and Delete file… together in File location, wrapping only when space is insufficient. Copy path and the separate deletion card are omitted from file details on every surface. The text editor and file-actions overflow sheet have been removed. Actions depend on the selected local copy, never navigation origin; history-only files keep unavailable actions disabled with an explanation. Navigation origin only determines the back destination; browsing retains its directory. Loading, offline and failed history requests must not imply an available hub revision.

Replica History is scoped to locally selected folders, including paused selections; the hub administrator retains all shared-folder history. Replica daemons reject unselected file-history requests and scope aggregate activity before pagination by querying selected volumes and merging their global revision cursors. Mobile uses the same scoped activity helper with its current local selections and rejects unselected file detail; selectors exclude unselected folders. No new Casa API/deployment is required for this filtering. Validation: 164 tests passed, one platform skip; Android/iOS exports passed. A focused unselection regression also passed. Updated Mac daemon staged and restarted; mobile visual verification remains pending. Folder discovery/selection and full-backup archive access remain distinct from History.

Mobile History follows desktop composition: fold places a compact shared-folder selector and toggleable Conflicts/Deleted filters beside the title. Selecting the active filter again returns to normal content revisions. The default excludes deletion events and conflict-copy revisions; Conflicts shows unresolved live conflicts, and Deleted shows deletion events. Filtering happens on the hub before pagination, identically for web/desktop/mobile. The folder selector is independent; individual file history remains complete. This filter-contract change requires an updated hub and clients. Activity is grouped by local calendar day on phone and fold; fold uses separate folder, revision and relative-date columns with the same state copy as desktop. Phone stacks metadata. No Refresh button: existing navigation/sync refresh and error retry remain. Android/iOS exports and icon/token parity checks passed; runtime visual verification remains pending.

All two-column folder/file detail layouts share a 320 px/dp side-column token (`--detail-side-width`, mirrored as `geometry.detailSideWidth` on mobile). The main column takes remaining width; phone layouts still stack. This replaces the desktop 280 px column and mobile proportional 2:1 split so paired actions fit consistently.

Web/desktop/fold simplify File location to folder name, path and a horizontal row of View folder and Delete file… actions. These wide layouts have no Copy path button or separate deletion card; confirmation still explains cross-copy deletion. Narrow mobile uses the same two actions inside File location. The new local-admin `/v1/delete-file` endpoint rejects backup credentials, unselected replica folders, directories and stale revisions. Hub deletion scans current content and records a restorable tombstone; replica deletion requires unchanged indexed content and propagates through normal sync. Mobile similarly rejects unsynced content before deletion to preserve recoverability. All surfaces confirm cross-copy deletion; pause/offline defer replica propagation. The Mac daemon runtime was staged and restarted for this endpoint; Casa remains user-deployed. Validation: full suite passed (160 tests, one platform skip), plus a subsequent mobile offline-delete/restore regression test; Android/iOS exports passed. Runtime UI verification on mobile remains pending.

## Script organization

Versioned scripts in scripts/ implement builds, runtime staging, installation and release verification. Private maintenance helpers live in Git-ignored scripts/local/, and private deployment files in deploy/local/; their root-relative paths and npm update-docker entry point follow that location. Do not ignore scripts/*, which would hide future product tooling.

The local Casa Compose copy is deploy/local/casa.compose.yaml. Its build context and relative mounts were adjusted for the extra directory. The existing remote installation still uses /home/atlas/arca-pilot/deploy/casa.compose.yaml; helpers deliberately keep that live path. This repository reorganization does not move remote configuration or restart services. If copying the nested Compose to a new installation, retain its deploy/local location; do not overwrite the old remote path with a file whose relative mounts assume the new depth. deploy/Dockerfile remains versioned.

## Casa update verification — September 8, v0.3.0

Fixed the private helper’s failure when Docker no longer retains the running container’s original image. It reports unavailable rollback and proceeds; force-recreate plus a changed-container-ID assertion verifies a real restart. Ran the full update successfully: 144 tests passed, one skip; Docker rebuilt and recreated Arca as container 29382ed6f854. Runtime/frontend SHA-256 and hub identity, folder paths/selections and backup setting matched postflight. No previous-image rollback was available for this run. Mac and Metro were not restarted.

### Mobile keyboard handling — September 9 checkout

Page forms and sheets share KeyboardPane and KeyboardScrollView. Measure the overlap between the actual pane and the keyboard's top edge, accounting for safe areas and Android's native window resize; reset it on dismissal. Focused Fields scroll into the remaining viewport when focused or resized. Sheets shrink with a fixed heading/X and scrollable form content. Phone bottom navigation hides while typing, and keyboard resize does not change Fold's wide layout. This follows Alf's explicit keyboard-space approach without assuming a fixed keyboard height or adding its padding twice after native resize.

Validated with geometry regression tests and Android/iOS JavaScript exports. The existing emulator runs a bundled app with no Metro server, so the new keyboard behavior still needs interactive phone/Fold and iOS validation after loading this checkout. No live form was submitted, no Metro was started, and no native build was installed for this change.

Incoming-sharing validation (September 9 checkout): six isolated lifecycle tests cover cancellation, cancellation during native resolution/copying, replacement by a new batch, partial-save cancellation and startup cleanup of legacy/private copies. The existing integration test still saves a received workout into a selected nested folder while paused and uploads it after resume. All 30 focused incoming/mobile-replica/layout/keyboard tests and Android/iOS JavaScript exports pass. The preparation state keeps Cancel available while files resolve or copy. Updated receipt UI has not been exercised in the installed native app; its bundled JavaScript predates the change and Metro is not running. No native install, source-file deletion or commit was performed.

### Pilot deployment — September 9

At the user's request, `npm run update-docker` deployed the current server sources, force-recreated Casa as `4c7380c14435` and verified source hashes, hub identity, paths, selections and backup settings. Previous image retained as `arca-pilot:previous`. Deployment tests: 157 passed, one platform skip. The Mac's existing LaunchAgent runtime was staged and restarted; source hashes and identity/settings were also verified. Startup reconciliation completed: Casa is idle with all six folders synced; the Mac is idle with all four selected folders synced, no errors, and `doc/Coros` exists there with zero entries. No mobile binary was installed; older mobile clients need an update for directory protocol compatibility. No commit/push.

During that deployment, initial directory reconciliation exposed an expensive full-index collision scan per new directory. Replaced it with an indexed lowercase path key, including migration of existing file rows. Unicode case collisions, literal `%` prefixes and file/ancestor/descendant boundaries remain guarded by regression tests. The updated source was redeployed to Casa (`916d4cc30b2b`) and the Mac. An isolated metadata benchmark inserted 1,000 directories beside 14,000 indexed files in 72 ms on this Mac; this is not a full sync throughput measurement. Deployment tests: 158 passed, one platform skip.

The old container needed forced termination after its shutdown timeout and left a numeric `daemon.lock`; the new container reused PID 7 and refused startup. Recovered only after stopping the container and verifying no other running container mounted its state, then removed that stale lock and restarted. The private update helper now verifies the expected state mount, stops Casa explicitly and performs that same guarded lock cleanup before recreation. The follow-up read-only check passes. No synchronized files, history, selections or backup configuration were reset.

Desktop/web form dialogs never dismiss on backdrop clicks; use explicit Cancel, Escape or successful submission. Scrolling is contained in the dialog. This prevents a scrollbar/trackpad gesture ending outside the dialog from discarding an editing draft. Regression checked in the .arcaignore editor workflow; Casa not deployed.

Machine/hub Disconnect actions and disconnected machine states use Lucide Unplug on desktop/web and mobile, with identical vendor geometry. Folder unlink keeps its separate icon and semantics.

Mobile replica-only cleanup (September 9): removed backup controls, status summaries, archive storage/access and portable export implementation. Sixteen mobile integration tests pass, including empty-directory sync, offline delete/restore, and a new no-selection test verifying no content/archive transfer and a replica machine role. Android/iOS exports pass; the full suite passes with 163 tests and one platform skip. No native-device workflow validation, Casa deployment, commit or push.

## Pre-production code cleanup — September 9

Current checkout supports only the current schema and protocol; no automatic old-schema migrations, old exclusion exceptions, old persisted share inbox or mobile portable-backup importer. Fresh databases create the full schema directly. Existing state must already have the current columns; older state is not reset or silently converted. No pilot state was modified or deployed during this cleanup.

Public daemons and invitation credentials are hub/replica only; standalone backup-node mode and its UI/CLI paths are removed. Desktop/server optional full backup still uses its internal backup worker and native backup-state recovery. Mobile remains replica-only. Snapshot responses always paginate, and resumed transfers reject a hub that ignores Range instead of silently restarting through a different protocol path. Removed the unused mobile text editor method, CopyButton/Progress components, imports and expo-clipboard dependency.

Current-platform behavior remains deliberate: HTTP browser clipboard handling, OS filesystem differences, optional notification permissions, interrupted-transfer recovery and periodic reconciliation are needed by supported workflows, not backward compatibility. Vendor/generated code is not maintained as product source.

Cleanup validation: full suite 161 passed, one platform skip; new regression checks standalone-backup daemon rejection, default paginated snapshots and no reseeding of deleted ignore rules. Mobile requires the current ArcaNetwork native module directly, with no optional-module/old-method path. Unused mobile filesystem helpers were also removed. No Casa or Mac daemon restart, native build/install, commit or push.

Mobile Settings ends with a centered, quiet version label using caption typography. The Machine name card contains only its labelled input, without repeating OS or replica role. No About card, repeated replica-role explanation or generic Open system settings action. OS-permission links belong to the relevant permission flow.

September 9 orphan-copy correction: read-only inspection confirmed mobile retained selected alpi-host (24d67a40-da7a-4edb-ad0f-a25e8fa2b8e0) after its removal from Casa's catalog. Aggregate History previously aborted on that volume's 404. Mobile and replica-daemon aggregate history now intersect selected IDs with the hub catalog; mobile does not show an empty result after a load error and offers Retry. Mobile local removal requires confirmation of permanent loss of unsynced changes but no hub availability or successful sync. No user folder was deleted during development. Casa deployment remains user-managed.

Orphan-copy validation: 162 tests passed, one platform skip; Android/iOS exports passed. Isolated tests cover offline removal with pending edits after share deletion, retry after incomplete filesystem cleanup, preservation of other folders and history filtering with a retained orphan. No live deletion, service restart or deployment.

September 9 incoming filename correction: a production screenshot showed Unsupported file path when sharing a .fit export from COROS; the exact sender filename and installed APK source revision are not available. Arca has no extension restriction. Previously the portable-path validator rejected incompatible sender names before staging, leaving a generic error. Incoming copies now use safe internal IDs independently of their display names; incompatible single-component names remain staged and show an editable File name field. Save validates the corrected name (including single-component/portable-path and 255-byte filename limits); no silent renaming and no source-file mutation. Sender-supplied paths remain rejected. Valid names retain the compact read-only filename row. Cancellation discards the temporary copy as before.

Validation: 24 focused tests pass, including staged rename/cancel, traversal rejection and byte-for-byte binary import/sync after correcting a synthetic timestamp filename. The user subsequently confirmed successful COROS-to-Arca import and the improved Android launcher icon on September 9. This is user-reported acceptance of that Android workflow, not general iOS/device qualification. No production deployment or native rebuild/install was performed during the review.

### Interactive file operations — September 9

Delete, restore, conflict resolution, move and ignore-policy edits yield the active daemon sync cycle before acquiring its serialized work queue. Scans stop cooperatively and outgoing sync requests are aborted; partial transfers and unacknowledged cursors remain retryable. Unlink and Delete share also interrupt active network work. Successful delete/restore/conflict actions schedule synchronization promptly; user pause remains unchanged. Replica file deletion still verifies the indexed revision and local bytes, and history stays recoverable. Isolated API regression covers delete and restore during a stalled hub request, subsequent propagation, restored bytes and unchanged pause/error state. This daemon change requires deployment/restart; Casa remains user-managed.

Release review for v0.3.1: reviewed staged and unstaged changes together; 165 tests passed with one platform skip, subsequent focused operation/conflict checks passed, Android/iOS exports and desktop frontend build passed, and release manifests agree. Mobile build numbers are 3. These checks do not install or restart the running desktop daemon, deploy Casa, or qualify other native devices.

Folder summaries omit the redundant Not yet verified suffix; their status still distinguishes incomplete, paused and failed synchronization. Desktop connection subtitles likewise omit that suffix before the first completion. Mobile local-copy guidance shows an error-oriented message when the folder has an issue, rather than suggesting that merely keeping the app open will fix it. An Android binary without ArcaNetwork.removeEmptyDirectory must be rebuilt and installed; Metro cannot add native methods.

## Website publication — September 9

Implemented locally: one responsive English landing page in `site/`, using the Arca mark and locally served Instrument Sans/Fragment Mono. No navigation menu or additional pages. It explains hub/replica setup, complete local copies, offline use, revision restore, conflicts and backup distinctions. macOS Apple Silicon is the primary download; Windows/Linux are secondary. Mobile exposes App Store/Google Play destinations when configured, plus the published standalone Android APK. The user confirms the apps are available across platforms; missing configuration must never be presented as Coming soon. Local preview labels unconnected downloads separately. The product illustration uses fictional filenames rather than live user data. Release notes are escaped text from the published release.

The implementation follows `~/git/alf`'s static build and Cloudflare Pages direct upload. GitHub Actions reads the highest published versioned release (including alpha prereleases) and the builder uses the actual browser_download_url of each matched asset. Desktop has three builds: macOS, Windows and Linux. The Linux build produces AppImage and deb; the landing exposes one Linux CTA (AppImage), with deb remaining available in the GitHub release. No R2 bucket or download mirror is used. A missing release/desktop artifact, mismatched asset URL or missing deployment configuration stops publication. GitHub visibility still determines who can download; anonymous access was not verified (lookup returned 404), so public accessibility must be checked before launch rather than inferred. This updates the website, not installed apps or Casa.

Required GitHub secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Pages Edit). Required variable: `CLOUDFLARE_PAGES_PROJECT_NAME`. The canonical origin is https://arca.satoshi-ltd.com. Optional variables: `APP_STORE_URL`, `PLAY_STORE_URL`. Create a separate Arca Pages project and attach the confirmed site domain. Disable Cloudflare Git auto-deploys so Pages cannot race the release workflow. Do not replace Alpi's Pages project or DNS: the confirmed Arca domain is arca.satoshi-ltd.com.

The Arca release workflow builds desktop installers and Docker only. Android remains a manual EAS build through the mobile package commands; Expo credentials and APK generation are not prerequisites for desktop/server publication. The automatic Android job introduced in v0.3.2 was removed following the user's September 9 correction. Native build numbers remain explicit in app.json and must increase with release preparation. Store submission and physical-device qualification remain separate. A standalone APK link on the site is enabled only when the selected release actually contains that asset.

The website builder requires Node 24 and no build dependencies; release metadata comes from the GitHub REST API via `fetch` with `GH_TOKEN`/`GITHUB_TOKEN` or the GitHub CLI token, so the CLI is optional. CI installs Wrangler 4 for uploads. Publication runs after the successful Arca workflow or manual dispatch, using published release metadata, never an unreleased package version: CI sets `RELEASE_JSON` explicitly and the build stops if that file is missing. Local `npm run site:build` without metadata derives the version from `package.json` with the expected desktop installer URLs and no APK link, mirroring alf's repo-derived build so the same command runs locally and in the pipeline. Cloudflare resources and live deployment have not yet been verified.

Website validation: 169 Node tests passed, one platform skip (170 total), including published/missing installer selection, unsafe URL/version rejection and mobile store links. Static preview build and version agreement passed. Browser inspection at 1365 px desktop and 390/320 px mobile showed no horizontal overflow. EAS cloud builds and Cloudflare deployment have not run in this session.

Landing editorial direction (September 9): explain one person's laptop/tablet/phone use before the technical topology. Arca connects selected whole folders across owned devices through an owned hub; it is not a hosted storage service. Present independence concretely (own disks, ordinary files, no external storage account) together with the user's responsibility to run/reach the hub and maintain backups. Offline availability applies after copies finish syncing; history is retained, not infinite. Keep Arca's established identity and original layout; the Claude Design landing is a visual reference, not product authority or replacement source. Avoid fear-based provider claims, open-source promises, blanket encryption claims and implying store availability before publication.

The user prefers the original Arca landing graphics over the Claude Design proposal. Preserve that visual identity and adopt only useful ideas independently. Availability is user-confirmed across platforms; exact store destinations are pending, not product availability.

Store links: user explicitly requested defaults for now. App Store points to https://apps.apple.com and Google Play to https://play.google.com/store/apps until real listing URLs are configured. These are store home destinations, not Arca listing links.

Landing platform recognition: local monochrome SVG symbols identify Apple (macOS/iOS), Android, Windows, Linux and Docker beside download/store/setup labels. Icons inherit the control color, use a shared size and are decorative to assistive technology; text remains the accessible name. No icon CDN or browser JavaScript is needed.

Landing download organization: Desktop keeps the primary macOS CTA followed by Windows and a single Linux AppImage CTA. Docker has its own full-width hub section below Desktop/Mobile; it is a Linux-container deployment available through a compatible engine on Linux or Docker Desktop on macOS/Windows, distinct from Linux desktop installers. Preview controls use the same inline-flex centering and 12px icon gap as live links. Hero and setup illustrations float continuously with slow, offset 7–9 second CSS rhythms; all illustration animation is absent under prefers-reduced-motion.

The setup illustration places the hub at the center, with laptop/tablet/phone around it and two faint concentric rings. Use a locally rendered responsive SVG with an accessible title/description, consistent device outlines and a restrained Arca accent; avoid the previous top-down organizational tree. The caption explains hub-mediated synchronization. The central label is Hub.

Illustration motion is CSS-only: continuous gentle floating, with no cursor response or browser JavaScript. Reduced-motion preferences disable it.

Setup diagram geometry: equal-size replica cards lie at -90°, 30° and 150°, on a shared radius around the hub. Laptop is above; tablet and phone sit symmetrically below. Two softly breathing concentric rings echo the hero; there are no arrows or spokes. Replica cards float by 7 SVG units peak to peak, while the hub follows a slower rhythm.

The standalone Android APK uses the same secondary icon/link treatment as Windows and Linux, beneath the mobile store links. Its copy explains direct installation without Google Play or a store account; it does not claim different app privacy behavior.

Download-card notes use the full card content width, wrapping naturally on narrow screens without a separate text-width cap.

September 9 CI correction: the v0.3.1 macOS log failed the conflict-restore DOM test with an unhandled rejection after JSDOM teardown. The test observed dialog closure and restored bytes before the subsequent refresh/action finalization completed. It now also waits for body aria-busy=false before teardown. The full local CI test command passes (169 passed, one platform skip); GitHub runner verification remains pending. No production error guard or timing sleep was added.

Release v0.3.2: user approved the single commit and push, including the first landing release, and confirmed arca.satoshi-ltd.com as its domain. Mobile build numbers advance to 4. At that release, publication required Cloudflare account/token/project configuration and EXPO_TOKEN in GitHub; the automatic Android requirement was subsequently removed as described below.

### Windows CI incoming-share fixtures — September 9

The v0.3.2 Windows test job in run 34323012768 failed the two incoming-share integration tests in `tests/mobile-replica.test.js`. Their Node filesystem adapters stripped `file://` from normalized URLs, leaving `/D:/...` on Windows; constructing URLs by concatenating native paths also failed to encode filenames correctly. The fixtures now use `pathToFileURL` and `fileURLToPath`, preserving native paths for other adapter calls. Both source filenames include spaces, `#` and `%` so the URL-decoding regression is exercised on Unix runners too. The single-slash file URI case remains covered. Production mobile code is unchanged.

Validation: both focused tests reproduced the same missing-file failure locally with encoded filenames before the adapter fix and passed afterward. The full local CI test command passes (169 passed, one platform skip), release manifests agree at v0.3.2, and explicit Windows-mode URL conversion checks pass. Windows runner verification remains pending; this fix is included in the v0.3.3 release preparation below.

### Static-site release metadata path — September 9

The production site builder now defaults to repository-root `site/release.json`, matching `site/scripts/read-release.mjs`, instead of looking for `release.json` in the working directory. `RELEASE_JSON` remains an explicit override. Missing metadata produces setup instructions and the local preview command; production does not silently fall back to preview or invent installer destinations. The existing publication workflow already sets `RELEASE_JSON: site/release.json`.

Validation: four site tests pass, including an isolated CLI build from another working directory, missing metadata, explicit overrides, and preview without release metadata. These checks do not verify GitHub or Cloudflare deployment.

### Release v0.3.3 — September 9

The user authorized release preparation, commit and push to main. This release includes the Windows incoming-share test fixture corrections and the static-site release metadata path fix described above. Desktop, mobile, native modules, runtime reporting and package/lockfile versions are aligned at 0.3.3; Android versionCode, iOS buildNumber and the Android native module versionCode advance to 5. The existing workflow owns artifact builds and publication after the push; Casa and installed clients are not updated by this operation.

Release validation: the full local CI test command passes (170 passed, one platform skip); Android/iOS JavaScript exports, desktop frontend build, static-site preview and version agreement pass. Hosted cross-platform tests, native artifact builds and publication remain pending the release workflow.

### Release pipeline scope correction — September 9

Run 34324732885 failed its Android job at Verify Expo credentials with Missing EXPO_TOKEN for Android release, before dependency installation or compilation. The user clarified that Android must not be a job in this pipeline. Removed the Android/EAS job, its publish dependency, the APK artifact download, the release-note APK claim and the unused APK collector. Desktop macOS/Windows/Linux and Docker builds remain required for publication. Manual mobile EAS commands and optional actual-release APK links remain available. This correction is included in v0.3.4; rerunning the previous commit would still use its old workflow.

The user confirmed Expo builds are manual for now. Local validation passes: workflow YAML parses, publication requires prepare/desktop/docker, all three desktop platform entries remain present, version agreement passes, and all four site tests pass. Hosted execution of this correction remains pending.

### Release v0.3.4 — September 9

Version 0.3.4 removes automatic Expo/Android builds from the release pipeline and restores desktop/Docker-only publication. All package and lockfile versions, Tauri manifests, native mobile module versions, runtime reports and displayed versions are aligned at 0.3.4. Mobile Android versionCode and iOS buildNumber advance to 6, including the Android module versionCode. EAS builds remain user-managed. The user authorized this version bump and commit; hosted publication and installed-client deployment are separate.

Validation for v0.3.4: full local CI test command passes (170 passed, one platform skip); version/build-number agreement, workflow YAML and desktop/Docker dependency checks, desktop frontend build and site preview pass. No Expo native build, pilot deployment or hosted publication was performed during this preparation.
