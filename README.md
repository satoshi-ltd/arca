# arca

A personal drive for your own machines: complete files on disk, bidirectional sync, revision history and a hub you control. No external account, public relay or telemetry.

**v0.6.0 · Functional alpha, not release-qualified.** Includes mobile photo uploads, desktop/web gallery browsing and per-folder history retention. Updating source does not update running daemon or app binaries.

## How it works

- The **hub** creates shared folders and owns their catalog and history. Each **replica** selects whole folders independently. Desktop copies use chosen local paths; mobile copies live in persistent app-owned storage. Existing edits synchronize in both directions; there are no placeholders.
- **Destroy hub** in Settings → Danger zone permanently deletes this hub’s Arca folders, history and configuration, then returns to setup to choose hub or replica. Replicas keep their local files and lose their connection to the old hub. Confirmation is required.
- **Web** administers the server it connects to. **Tauri** manages its local daemon, which does not serve a web panel. **Mobile** is always a replica. Pairing never grants remote hub administration.
- **Pause** keeps copies linked. Desktop **Unlink** keeps files on disk. Mobile **Stop syncing** removes the app-owned copy after confirmation including unsynced changes; it works offline even if the hub share is gone. Hub **Delete share** removes catalog/history while retaining physical files. These operations are distinct.
- **Disconnect** preserves local files and selections for fresh-code pairing. **Destroy replica**, in Settings → Danger zone, requires confirmation and permanently deletes that replica's local folders (including unsynced files), configured full backup and synchronization state, attempts to remove its hub registration and returns to first-run setup. Destruction works offline; an unreachable hub may retain a machine entry that you can remove separately. Hub files/history and other machines remain.
- **Rename…** in the file-detail **⋯** menu on web, desktop and mobile changes a filename within its folder and syncs the change. Occupied names and unsynced local edits are rejected; retained history remains under the previous name. Mobile can rename a synced local file offline. Gallery-source originals stay managed in Photos.
- Conflicts preserve both files and their histories. Choosing a version records the resolution; editing the conflict copy again reopens it. Replicas resolve only selected folders. Restore creates a new revision.
- Mobile (phone and Fold) is exclusively a replica: it cannot act as a hub or keep a full hub backup. Optional desktop/server **full backup** is independent of working copies and requires explicit enablement. Quit leaves the desktop daemon running.

Desktop/server sync uses incremental remote changes, changed local paths and periodic reconciliation: 15-second active checks, 60-second idle checks. Mobile resumes durable work on launch/resume and through OS-scheduled background tasks; it is not a continuously running daemon.

The current checkout adds hub change notifications with polling fallback, persistent mobile hash verification, bounded turns between mobile folders, and native file-block transfers with cancellation. These changes require an updated hub/desktop daemon and rebuilt mobile apps; a Metro reload alone cannot install the native transport.

Files and directories, including empty nested directories, are synchronized in the current checkout. Safe file/directory replacements and case-only renames require updated hub and replica clients advertising `pathTransitions`; older clients receive an upgrade error. File counts exclude directories.

The September 10 checkout includes synchronization-integrity fixes: pause/deadline persist across daemon restarts; failed folders do not block healthy ones; recovery preserves the archive's exclusion policy; stale proposal retries cannot silently delete recreated files. These changes are verified locally, not deployed by changing source. Full audit closure and remaining qualification are in SPEC.

`.arcaignore` is synchronized and editable. Creating a hub folder can optionally seed it; selection does not. `.DS_Store`, `.localized`, `Thumbs.db`, `desktop.ini` and `.obsidian` directories are always excluded by the shared core. Obsidian notes and attachments remain synchronized.

First-run desktop and server setup walks through welcome, machine name, role, pairing and an empty/new folder root; hubs skip pairing. Mobile pairs and then offers whole-folder selection or Skip for now, using app-owned storage. An interrupted first catalog load retains the accepted pairing; no folders download until setup permits it.

In-app feedback shares one notice contract across web, desktop and mobile: info, warning and error, with grouped incidents and optional collapsible diagnostics. Mobile confirmations use the shared in-app dialog. System alerts retain OS styling and are reserved for unresolved conditions while Arca is in the background.

Hub Settings → Images shows gallery counts and sizes and rebuilds disposable previews. Originals are never converted or recompressed.

## Development

Requires Node.js 24+. Desktop also requires Rust and the platform's Tauri prerequisites.

```sh
npm ci
npm start --prefix apps/desktop
```

Each environment owns its commands: the repository root keeps the daemon, tests and site, `apps/desktop` the desktop app and `apps/mobile` the phone app. Run them with `--prefix` or from inside the directory. `npm run start:clean --prefix apps/desktop` clears only Vite caches before the same desktop startup. It preserves state, pairing, files and pause. Startup checks port 1425 first and stops with a clear error if another session owns it; it never kills an unknown port owner. When the same checkout/state is managed by the macOS login service, the launcher unloads and reloads that service around runtime preparation, preserving its login setting and avoiding automatic-restart races. Each start stops the existing local daemon, stages the current runtime, starts it and waits for readiness before opening Tauri. It uses `ARCA_HOME` when set, otherwise the real `~/.arca`, preserving pairing, folders and pause. First-run setup still initializes a new state directory. Closing the app leaves the daemon running; the next development launch replaces it. Automated tests use isolated state. Vite serves development UI on port 1425. The daemon uses 17831; Docker/server installations also serve web there.

```sh
npm test
npm run build --prefix apps/desktop
npm run verify:bundle --prefix apps/desktop
```

For isolated hub metadata/API load qualification, run `node scripts/verify-hub-load.js . 100000`. It creates temporary state and a child daemon, tests three concurrent snapshots alongside a verified 1 MiB upload/download, checks HTTP responsiveness and pause/resume, then removes only its fixtures. It never uses the live `~/.arca`. Docker execution and measured limits are in [hub load qualification](SPEC.md#05-docker-hub-load-qualification--september-22).

Web/Tauri share `apps/desktop/src`. Vite reloads frontend changes; daemon changes require deployment/restart. Building a bundle does not replace an already running app. macOS local bundles are ad-hoc signed, not notarized.

## Mobile

Expo/React Native JavaScript lives in `apps/mobile`. Expo Go cannot load its local native networking module.

```sh
npm ci --prefix apps/mobile
npm start --prefix apps/mobile
npm run check --prefix apps/mobile
```

`start` starts Metro for the installed development client with the `arca` scheme; it does not build or launch an emulator. `check` exports Android/iOS JavaScript, not native installers. Do not restart a user-managed Metro session just to refresh JavaScript.

Implemented locally: secure pairing, persistent whole-folder sync with verified resumable transfers, offline files, imports, history/restore/conflicts, themes and OS background/notification integration. Files, Recent and History lead to one file-detail view. Phone uses bottom navigation and stacked content; wide/Fold uses a sidebar and desktop-style composition with touch-sized controls.

**Photo uploads:** selecting a hub folder creates an ordinary synchronized local copy. To use it for gallery uploads, open the folder’s ⋯ menu → “Link album…” after a successful sync; Arca verifies their content before removing them. The source keeps tracking data and temporary transfer files. “Add photos…” is a separate one-time action available in ordinary folders. The gallery stays unchanged; deleting photos there keeps uploaded hub files, and hub changes are not downloaded to this source phone. Other normal replicas retain full copies. Exports include Live Photo pairs. Detected gallery edits create new hub revisions at the existing path; iOS requires the updated native exporter to send rendered edits. This is implemented and built locally; installing the updated native mobile client and physical-device qualification remain required. Background uploads remain OS-scheduled; keep Arca open for the first large upload.

**Desktop/web gallery:** album-linked folders use the Images icon and keep Files as the default tab, followed by Recent and Gallery. Gallery provides a dated thumbnail grid and a month/year navigation rail. Accepted photo uploads prepare reusable thumbnails in the hub’s background queue. Existing gallery folders are prepared in the background on activation and hub startup; metadata and thumbnails survive restart. Navigation reuses gallery pages and separate thumbnail/large-preview caches. Clicking an image opens a larger preview; videos open an authenticated streaming player with seek controls. This requires the updated hub daemon and desktop runtime, including production dependencies. It is implemented and tested locally, not deployed to Casa. Unsupported browser/OS video codecs and image formats retain original download.

**Receiving files:** Share → Arca → selected folder → subfolder → Save. Receiving is transient: X, Cancel or Android Back discards the unsaved temporary copies without touching the originals. Nothing waits in an inbox or reopens after cancellation/restart. **Save a copy** exports local folder files outside Arca; it does not export synchronized history or create another syncing copy. Native picker/export and background behavior still require real-device qualification. Android incoming intent reception has been exercised; the iOS share extension is experimental.

Native modules, incoming-share registration and icon/splash changes require a new binary. Metro does not install them. The hub needs the bounded-download `blobRanges` capability; Casa has received it, but the published v0.2.3 image predates these mobile-support changes.

### Android builds

From `apps/mobile` (Android Studio/SDK, mobile dependencies and an Expo login):

```sh
npm run build:local:dev    # Compile on this machine and install on the device
npm run build:local:prod   # Signed standalone APK in apps/mobile/release-assets/
npm run build:dev          # Same development build on EAS cloud, downloaded and installed
npm run build:prod         # Same signed APK built on EAS cloud and downloaded
npm run build:local:dev -- --install-only  # Reinstall the existing dev APK
```

Development builds install on the first USB device, otherwise on a running emulator, otherwise they boot `Pixel_9_Pro_Fold`; set `ANDROID_AVD` for another emulator or `ANDROID_SERIAL` to pin a device. Installation uses `adb install -r`, preserves app data and stops on a signature mismatch; it never uninstalls the app. Start Metro yourself with `npm start`.

Development builds compile only `arm64-v8a`, the ABI of every supported phone and of the Apple Silicon emulator, so the debug APK stays small enough for a crowded emulator; production keeps all ABIs. Local builds use `eas build --local`: compilation runs on this Mac, consumes no cloud build quota and retrieves the existing EAS signing credentials; native toolchain versions come from the machine. Cloud builds run in the [satoshi-ltd/arca](https://expo.dev/accounts/satoshi-ltd/projects/arca) EAS project, consume quota and download the finished APK. Every build runs `check:release` first and rerunning replaces its APK. Do not replace the signing key when updating an installed app. The repository root has no mobile scripts, and CI never builds or tests mobile installers: `npm test` inside `apps/mobile` checks the build script wiring.

Build profiles currently use Node 24.14.1 and APK output. Increasing native build numbers and store distribution remain release work. The installed pilot APK predates the latest icon/splash and other native refinements; do not infer native acceptance from a successful export.

## Desktop updates

The packaged desktop application checks for a signed update at startup, every six hours and when the machine reconnects. When one exists, a card appears at the bottom of the sidebar with the current and offered versions and a single action that downloads it, installs it and restarts the app. The daemon runs from inside the installation, so it stops just before the install and starts again from the new files; synchronization resumes as soon as it answers. Updates are verified against the public key built into the application; the browser interface never updates itself.

## Connect over the local network

Enable the hub's **Settings → Local network → Allow HTTP connections**, then use its private IPv4 address. The listener and Docker binding must also be reachable. This is unencrypted local traffic, not public Internet hosting. Tailscale/HTTPS remain alternatives. A Tailscale hostname/address requires Tailscale connectivity on the mobile device itself.

Casa's pilot LAN endpoint is `http://192.168.1.190:17831`; Tailscale is `http://casa:17831`. Android LAN pairing and sync have been exercised on the existing emulator. Pairing and browser access use separate six-digit, single-use, ten-minute codes.

## Docker first run

Build/start with `docker compose up -d --build`, then open `http://localhost:17831`. Complete welcome → machine name → hub or replica → confirm server access → pairing (replicas only) → folder root → Finish. For access confirmation, run `docker compose exec arca node packages/cli/arca.js web-code` and paste its single-use code into the wizard. A replica selects folders after setup; no working files download during onboarding.

The default container command uses `daemon --setup`: it prepares empty state for authenticated setup and leaves existing configurations unchanged. Explicit CLI `init --role hub|replica` remains available. State and files retain their separate persistent Docker volumes. Setup destinations must be empty/new and inside `/data/files`; for a custom deployment, set `ARCA_FILES` to the persistent files mount visible inside that container. This is a server path, not a folder on the browser computer. These Docker source changes require rebuilding the image; they do not update existing containers or published images.

## Umbrel package

`deploy/umbrel/arca/` is a separate App Store package under preparation, pinned to the published **0.4.1** multiarch Docker image. It does not replace `compose.yaml`, `deploy/Dockerfile`, the Docker release pipeline or the Casa installation. The current 0.4.2 WIP is not included in that image.

The package opens the shared first-run wizard to choose a hub or replica, with app-owned persistent storage and adds a browser page that exchanges Umbrel's per-install Arca app password for Arca's existing single-use sign-in code. Companion clients retain Arca pairing and credentials. Local checks and a real amd64 Umbrel installation, web sign-in, bidirectional sync and restart persistence have passed. The pilot opens at `http://umbrel.local:17831/umbrel`; App Store submission remains pending. See [Umbrel packaging and submission](SPEC.md#umbrel-packaging-and-submission--september-12) for package layout, test commands and remaining requirements.

## Update the private Umbrel pilot

```sh
npm run update-umbrel -- --check  # Read-only connection, configuration and API checks
npm run update-umbrel            # Tests, stage current source, build and restart Arca on Umbrel
```

This private, Git-ignored helper is `scripts/local/update-umbrel.py` (Python 3.11+). It uses SSH `umbrel@umbrel.local`, Python/PyYAML on Umbrel and the existing `umbrel` MCP entry in `~/.codex/config.toml`; credentials are read privately. Copy the helper separately when using another checkout. It includes uncommitted server/web source and builds the image locally through Umbrel’s normal app start. Arca is unavailable during that build, which can take several minutes. Existing persistent volumes, configuration, app-password reference and icon are retained; the previous pilot source overrides are replaced by the complete build. Source snapshots and previous app files stay under the app’s `updates/` directory for inspection. No image is published, and Casa, desktop, mobile and Metro are not updated. Reload Arca and sign in again after restart. The read-only check and preparation tests pass; the first actual update through this helper remains to be verified.

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

The **publish** workflow runs tests/version checks on macOS, Windows and Linux. Pull requests stop there. A new version on `main` builds and verifies macOS arm64 DMG, Windows x64 NSIS, Linux x64 AppImage/deb and Docker amd64/arm64, then publishes a GitHub prerelease and Docker Hub/GHCR versioned images plus `latest`. Android builds remain manual through the EAS commands above and do not block this workflow. Existing version tags skip republishing. Manual artifact-only runs are available. `latest` is alpha, not a stable-release guarantee.

macOS is ad-hoc signed and Windows unsigned by default; Developer ID signing/notarization is optional. No automatic updater, store submission or pilot deployment is part of publication. Detailed registry/signing setup belongs in [release operations](SPEC.md#release-setup-and-publication).

Before distribution: complete cross-client/offline/conflict workflows; real iOS/Android networking, background, import/export/share and launch acceptance; actual desktop installer/upgrade testing; accessibility and long-content visual review; sustained load and independent backup/recovery; native mobile CI qualification. See [remaining tasks](SPEC.md#remaining-work-and-task-candidates) for scope and evidence. Passing tests or producing packages does not close those gates.

## Documentation and change policy

- [README.md](README.md): orientation and entry commands.
- [AGENTS.md](AGENTS.md): contributor instructions and operational boundaries.
- [SPEC.md](SPEC.md): current state, remaining work, contracts, operations and shared design system.

`AGENTS.md` contains contributor instructions; `changelog.md` records versions. The original visual assets are references, not another specification. Third-party documentation/licenses remain with their dependencies.

Every commit requires a version bump and matching changelog entry, with package/lockfiles and Tauri manifests aligned. **No commit or push without explicit authorization.**

## Public website

The single page in `site/` is static HTML/CSS with local brand fonts and no navigation menu, client-side framework, telemetry or runtime API. A small local script adds pointer-responsive illustration motion, respecting reduced-motion preferences. It follows `../alf`'s Node-build → GitHub Actions → Cloudflare Pages direct-upload approach.

```sh
npm run build:site
python3 -m http.server --directory site/dist 4178
```

`npm run site:build` (alias `npm run build:site`) works locally without GitHub access: it reads `site/release.json`, or the file specified by `RELEASE_JSON`, and otherwise derives the version from `package.json` with the expected desktop installer URLs for tag `v<version>` and no APK link. With published metadata, version and buttons come from actual release assets, including alpha prereleases. Platform availability is independent of missing deployment configuration; missing destinations are non-interactive, never labeled Coming soon. `SITE_URL`, `APP_STORE_URL` and `PLAY_STORE_URL` configure the canonical domain and real store listings. At the user’s request, unconfigured stores link to their generic home pages for now; these are not Arca listing links.

To build from published metadata locally, provide `GH_TOKEN` or `GITHUB_TOKEN` (or an authenticated GitHub CLI; the repository is private) and run:

```sh
npm run site:release
npm run site:build
```

The lookup calls the GitHub REST API and writes `site/release.json`. CI always sets `RELEASE_JSON`, and an explicitly configured file that is missing stops the build, so production never deploys the package.json fallback.

`.github/workflows/publish-site.yml` runs after a successful `publish` workflow on `main` (push or manual run), or manually from `main`. Automatic runs check out the exact successful commit; failed/cancelled runs and pull requests do not deploy. It reads published release metadata through the GitHub REST API with the workflow token, uses each installer’s actual `browser_download_url`, then deploys the static page to Pages. Downloads stay in GitHub Releases, as in alf; no R2 mirror is used. This is prepared locally, not deployed. Cloudflare/DNS configuration and the first end-to-end release remain to be verified. See SPEC's website publication section for required configuration.

**Version history:** hub folder headers offer Off, 1 day, 1 week, 1 month (30 days), or Forever. 30 days is the default; explicit choices are preserved. Shortening retention previews existing revisions to remove; automatic cleanup runs hourly while the hub is active. Current files and protected work remain, and unreferenced content has a 24-hour grace period before disk reclamation. Requires the updated hub daemon.

**Web sign-in approval:** an authenticated hub administrator can enable “Allow web approval” in a machine’s actions. The login page can then request access from those machines. Open foreground clients show the shared confirmation with a matching reference, requester IP and reported browser details. Requests expire after five minutes. Shell sign-in codes remain available for initial access and recovery. Updated hub and client code is required; mobile background push delivery is not included.

Docker upgrades: the image listens on container port 17831 explicitly, including with existing state. Compose accepts `ARCA_PORT` for the published port. For an installation whose clients already use 47831, run Compose with `ARCA_PORT=47831` to retain that external address. Do not change configured client addresses merely to upgrade.
