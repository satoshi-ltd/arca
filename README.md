# arca

A personal drive for your own machines: complete files on disk, bidirectional sync, revision history and a hub you control. No external account, public relay or telemetry.

**v0.3.1 · Functional alpha, not release-qualified.** Includes empty-directory synchronization and the mobile/file-operation refinements described below. Updating source does not update running daemon or app binaries.

## How it works

- The **hub** creates shared folders and owns their catalog and history. Each **replica** selects whole folders independently. Desktop copies use chosen local paths; mobile copies live in persistent app-owned storage. Existing edits synchronize in both directions; there are no placeholders.
- **Web** administers the server it connects to. **Tauri** manages its local daemon, which does not serve a web panel. **Mobile** is always a replica. Pairing never grants remote hub administration.
- **Pause** keeps copies linked. Desktop **Unlink** keeps files on disk. Mobile **Stop syncing** removes the app-owned copy after confirmation including unsynced changes; it works offline even if the hub share is gone. Hub **Delete share** removes catalog/history while retaining physical files. These operations are distinct.
- Conflicts preserve both files and their histories. Choosing a version records the resolution; editing the conflict copy again reopens it. Replicas resolve only selected folders. Restore creates a new revision.
- Mobile (phone and Fold) is exclusively a replica: it cannot act as a hub or keep a full hub backup. Optional desktop/server **full backup** is independent of working copies and requires explicit enablement. Quit leaves the desktop daemon running.

Desktop/server sync uses incremental remote changes, changed local paths and periodic reconciliation: 15-second active checks, 60-second idle checks. Mobile resumes durable work on launch/resume and through OS-scheduled background tasks; it is not a continuously running daemon.

Files and directories, including empty nested directories, are synchronized in the current checkout. Directory support requires updated hub and replica clients, including a new mobile binary for safe directory removal; older clients stop with an upgrade message instead of interpreting directories as deleted files. File counts exclude directories.

`.arcaignore` is synchronized and editable. Creating a hub folder can optionally seed it; selection does not. `.DS_Store`, `Thumbs.db` and `desktop.ini` are always excluded by the shared core.

## Development

Requires Node.js 24+. Desktop also requires Rust and the platform's Tauri prerequisites.

```sh
npm ci
npm run desktop
```

`npm run dev` is an alias. Development normally uses the real `~/.arca`; automated tests use isolated state. Vite serves development UI on port 1425. The daemon uses 47831; Docker/server installations also serve web there.

```sh
npm test
npm run desktop:build
npm run verify:bundle
```

Web/Tauri share `apps/desktop/src`. Vite reloads frontend changes; daemon changes require deployment/restart. Building a bundle does not replace an already running app. macOS local bundles are ad-hoc signed, not notarized.

## Mobile

Expo/React Native JavaScript lives in `apps/mobile`. Expo Go cannot load its local native networking module.

```sh
npm ci --prefix apps/mobile
npm run mobile
npm run check --prefix apps/mobile
```

`mobile` starts Metro for the installed development client over LAN with the `arca` scheme; it does not build or launch an emulator. `check` exports Android/iOS JavaScript, not native installers. Do not restart a user-managed Metro session just to refresh JavaScript.

Implemented locally: secure pairing, persistent whole-folder sync with verified resumable transfers, offline files, imports, history/restore/conflicts, themes and OS background/notification integration. Files, Recent and History lead to one file-detail view. Phone uses bottom navigation and stacked content; wide/Fold uses a sidebar and desktop-style composition with touch-sized controls.

**Receiving files:** Share → Arca → selected folder → subfolder → Save. Receiving is transient: X, Cancel or Android Back discards the unsaved temporary copies without touching the originals. Nothing waits in an inbox or reopens after cancellation/restart. **Save a copy** exports local folder files outside Arca; it does not export synchronized history or create another syncing copy. Native picker/export and background behavior still require real-device qualification. Android incoming intent reception has been exercised; the iOS share extension is experimental.

Native modules, incoming-share registration and icon/splash changes require a new binary. Metro does not install them. The hub needs the bounded-download `blobRanges` capability; Casa has received it, but the published v0.2.3 image predates these mobile-support changes.

### EAS builds

Project: [satoshi-ltd/arca](https://expo.dev/accounts/satoshi-ltd/projects/arca).

```sh
cd apps/mobile
npm run build:dev      # Android development client; uses Metro
npm run build:preview  # Internal standalone Android APK
npm run build:prod     # Production-profile Android APK; no store submission
```

EAS manages Android signing. Root aliases `mobile:build` and `mobile:build:preview` invoke development and preview builds. Build profiles currently use Node 24.14.1 and APK output. Increasing native build numbers and store distribution remain release work. The installed pilot APK predates the latest icon/splash and other native refinements; do not infer native acceptance from a successful export.

## Connect over the local network

Enable the hub's **Settings → Local network → Allow HTTP connections**, then use its private IPv4 address. The listener and Docker binding must also be reachable. This is unencrypted local traffic, not public Internet hosting. Tailscale/HTTPS remain alternatives. A Tailscale hostname/address requires Tailscale connectivity on the mobile device itself.

Casa's pilot LAN endpoint is `http://192.168.1.190:47831`; Tailscale is `http://casa:47831`. Android LAN pairing and sync have been exercised on the existing emulator. Pairing and browser access use separate six-digit, single-use, ten-minute codes.

## Update the Casa pilot

From this Mac checkout:

```sh
npm run update-docker -- --check  # Read-only SSH, Compose and hub checks
npm run update-docker            # Tests, build current source, recreate Casa only
```

This command uses the **private, Git-ignored** `scripts/local/update-docker.js` and the existing SSH alias `casa`. Copy the helper separately for another checkout. It includes uncommitted source and preserves Casa's Compose, `.env`, state and mounted files. It refuses a paused hub, retains the previous image when Docker still has it, stops Casa and clears its process lock only after verifying the state is not in use by another container, and verifies the recreated container, deployed source hashes and configuration. It does not update Mac/mobile, publish images or restart Metro. Full procedure and failure/rollback commands: [spec operations](SPEC.md#update-casa-docker-from-this-checkout).

```sh
ssh casa 'docker exec arca node packages/cli/arca.js status'
ssh casa 'docker exec arca node packages/cli/arca.js web-code'
ssh casa 'docker logs --tail 50 arca'
```

A deployment invalidates web sessions; reload and sign in again if requested. Preparing/checking this helper does not deploy changes.

## Release and remaining work

The single **Arca** workflow runs tests/version checks on macOS, Windows and Linux. Pull requests stop there. A new version on `main` builds and verifies macOS arm64 DMG, Windows x64 NSIS, Linux x64 AppImage/deb and Docker amd64/arm64, then publishes a GitHub prerelease and Docker Hub/GHCR versioned images plus `latest`. Existing version tags skip republishing. Manual artifact-only runs are available. `latest` is alpha, not a stable-release guarantee.

macOS is ad-hoc signed and Windows unsigned by default; Developer ID signing/notarization is optional. No automatic updater, store submission or pilot deployment is part of publication. Detailed registry/signing setup belongs in [release operations](SPEC.md#release-setup-and-publication).

Before distribution: complete cross-client/offline/conflict workflows; real iOS/Android networking, background, import/export/share and launch acceptance; actual desktop installer/upgrade testing; accessibility and long-content visual review; sustained load and independent backup/recovery; mobile CI and native build-number policy. See [remaining tasks](SPEC.md#remaining-work-and-task-candidates) for scope and evidence. Passing tests or producing packages does not close those gates.

## Documentation and change policy

- [README.md](README.md): orientation and entry commands.
- [AGENTS.md](AGENTS.md): contributor instructions and operational boundaries.
- [SPEC.md](SPEC.md): current state, remaining work, contracts, operations and shared design system.

`AGENTS.md` contains contributor instructions; `changelog.md` records versions. The original visual assets are references, not another specification. Third-party documentation/licenses remain with their dependencies.

Every commit requires a version bump and matching changelog entry, with package/lockfiles and Tauri manifests aligned. **No commit or push without explicit authorization.**
