# arca

A personal drive for your own machines: full files on disk, bidirectional sync, revision history and a hub you control. No external account, public relay or telemetry.

**v0.2.1 · Phase 1 functional alpha. Stabilization and release qualification are still in progress.** macOS desktop and Docker/server web administration work; mobile is planned for phase 2, localization for phase 3.

## Model

The hub creates shares and keeps their catalog, content and history. Each replica selects whole shares and chooses its own local paths. Existing local files join the sync. An optional replica backup keeps all received folders/history separately from working copies.

Automatic sync reviews local changed paths and fetches remote changes incrementally (15 seconds while active, 60 seconds when idle), with periodic full reconciliation.

Web and desktop share UI components. Desktop installs the native app, tray and an API-only daemon; only server installations serve the web panel. Installation type is independent of hub/replica role. A hub manages shared folders and authorized machines; a replica manages its hub connection and local copies. Browser Sign out ends web access only. Desktop replicas use Machines → Disconnect / Reconnect, preserving local files and destinations. Disconnect removes the pairing on both sides (an offline replica updates on next contact); reconnect requires a new pairing code.

Pause keeps a folder linked. Replica unlink removes the local mapping and retains files. Hub Delete share removes catalog/history and retains physical files. `.arcaignore` is an editable, synchronized policy; its starter is optional when creating a new hub directory.

## Development

Requires Node.js 24+, Rust and the platform's Tauri prerequisites.

```sh
npm ci
npm run dev
```

Development uses the real local `~/.arca` daemon by default. Tests use isolated temporary state.

```sh
npm test
npm run desktop:build
npm run verify:bundle
```

Desktop and web share `apps/desktop/src`. Vite hot reload is for development; distributing a change requires rebuilding the desktop bundle or Docker image.

The macOS bundle is locally ad-hoc signed, not notarized. Closing or quitting the app leaves the daemon running. The daemon API uses port 47831; server installations also serve web on that port. Vite development uses 1425 and is not part of the installed desktop service.

## Build and publish an alpha

The **Arca** workflow runs automatically on pushes to `main` and builds macOS Apple Silicon (arm64) DMGs, Windows x64 NSIS, Linux x64 AppImage/deb and an amd64/arm64 Docker image. All jobs use the same checkout and version. The single workflow first runs version checks and the JavaScript suite on macOS, Windows and Linux. Pull requests stop there. Only after every test job passes do desktop packaging and Docker builds start in parallel. Each build verifies its packages: installer runtimes and Docker startup, web/API access and persistence on both architectures (ARM via emulation). Publication waits for every build and package check to pass.

Unsigned builds need no custom secrets. Direct-download publication does not require an Apple account or App Store submission. macOS uses an ad-hoc signature by default and is not notarized; Windows is currently unsigned. macOS may block downloaded apps without Developer ID signing/notarization. Artifact generation is not full interactive installation, tray or sync qualification on every OS. Launch-at-login currently supports macOS only. There is no automatic updater or pilot deployment in this workflow.

### Automatic release on push

1. Configure the Docker Hub secrets described below before pushing to `main`.
2. After all three test jobs pass, a push to `main` checks whether the version needs publishing. If `vX.Y.Z` already exists remotely, the release workflow skips builds and publication successfully. Remote lookup errors stop the run.
3. For a new version, tests and package checks must pass before publishing installers to GitHub Releases and images to Docker Hub/GHCR. macOS uses an ad-hoc signature; no Apple secrets are required for automatic releases.
4. Follow **Actions → Arca** for results. A commit alone does not run CI: it must be pushed. With the current manifests, the next release target is `v0.2.1`.
5. To build without publishing, use **Run workflow** with **publish** and **sign_macos** unchecked. Before the first release, this can be run from a development branch once the workflow is available on the default branch. A push to `main` itself always uses automatic publication for a new version.

The `desktop-*` and `docker-image` artifacts expire after 14 days. The Docker tar is an OCI archive, not a `docker load` archive. Installer filenames include version and architecture. Default macOS artifacts are ad-hoc signed, not notarized; package tests do not replace interactive qualification.

### Optional macOS signing (skip for the current release)

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

### Publish

1. Ensure `package.json`, `package-lock.json`, Tauri configuration, `Cargo.toml` and `Cargo.lock` agree on an unused version (`node scripts/check-release.js`). The current version is `0.2.1`; existing release tags cannot be overwritten.
2. Push the new version to `main`. Publication runs automatically after all build/test jobs succeed. Manual publication remains available via **Run workflow → publish**, with **sign_macos** unchecked.
3. The final job publishes `satoshiltd/arca:0.2.1` on Docker Hub and `ghcr.io/satoshi-ltd/arca:0.2.1` and the GitHub prerelease `v0.2.1`, with installers and `SHA256SUMS`. Both registries also receive `latest`, matching Alf. During this phase, `latest` is an alpha, not a stable-release guarantee. GHCR authentication uses the built-in `GITHUB_TOKEN` with `packages: write`.
4. If anonymous Docker pulls are wanted, open the organization's **Packages → arca → Package settings** and set the package visibility to public when organization policy permits. Otherwise consumers need registry authentication.

The two registry uploads, latest aliases and GitHub release creation are separate operations: if the last step fails after the image upload, that versioned image can already exist. Inspect the failed run before retrying; do not change source and reuse that version. No installed daemon is restarted by publishing.

Local packaging: `npm run desktop:release` creates platform installers, while `npm run desktop:build` retains the existing local macOS app workflow. The release script signs embedded Node on macOS before signing the app. Windows signing and automatic updating remain separate, unimplemented work.

## Change policy

Every commit must bump the project version and add its changes to [changelog.md](changelog.md). Keep package/lockfiles, Tauri manifests and displayed/reported versions aligned. Use a patch bump unless another version is explicitly selected. Commits and pushes require explicit authorization.

Repository: [satoshi-ltd/arca](https://github.com/satoshi-ltd/arca).
