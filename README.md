# arca

A personal drive for your own devices: complete files on disk, bidirectional sync, version history and a hub you control. No external account, public relay or telemetry. Free for personal and non-commercial use under the [PolyForm Strict License](LICENSE).

**v0.8.14 · Functional, not release-qualified.**

## How it works

- The **hub** creates shared folders and owns their catalog and history. Every other device, a replica in the protocol, chooses its own local destinations and keeps complete copies of the folders it selects; edits synchronize in both directions and there are no placeholders. Phones are always replicas.
- **Web** administers the server it connects to, **Tauri** manages its local daemon and the **CLI** is auxiliary. Pairing never grants hub administration.
- Pause, Stop syncing, hub Stop syncing here and hub Delete share are different operations; conflicts preserve both versions; history retention is per folder; full backup is optional and only for desktop and server replicas.
- Phones add photo-library uploads to a complete two-way copy, and hub folders can be opened as a gallery or an audio library. Movies & TV folders are an exception: their originals stay on the hub, clients stream them, and desktop and phone apps offer separate offline downloads.
- Shared folders honor a synchronized `.arcaignore`; a fixed list of OS metadata, temporaries and caches is always excluded.

SPEC.md owns the contracts: [product decisions](SPEC.md#1-product-decisions), [synchronization](SPEC.md#3-synchronization), [desktop, server and web](SPEC.md#4-desktop-server-and-web) and [mobile](SPEC.md#5-mobile).

## Development

Requires Node.js 24+. Desktop also requires Rust and the platform's Tauri prerequisites.

```sh
npm ci
npm start --prefix apps/desktop
npm test
npm run build --prefix apps/desktop
npm run verify:bundle --prefix apps/desktop
```

Each environment owns its commands: the repository root keeps the daemon, tests, site and design kit, `apps/desktop` the desktop app and `apps/mobile` the phone app. Run them with `--prefix` or from inside the directory. `npm run start:clean --prefix apps/desktop` clears only Vite caches before the same startup. Development uses the real `~/.arca` unless `ARCA_HOME` is set; tests use isolated state. Vite serves the UI on port 1425 and the daemon uses 17831, where Docker and server installations also serve web. Closing the app leaves the daemon running, and building a bundle does not replace a running app. Details: [desktop development](SPEC.md#desktop-development).

Enable the hooks once per clone with `git config core.hooksPath .githooks`. Releases bump every manifest at once and validate a clean copy with the CI's Node version:

```sh
node scripts/bump-version.js            # next patch, or pass x.y.z
npx -y node@$(cat .node-version) scripts/validate-local.js
```

Hub load qualification (`node scripts/verify-hub-load.js . 100000`) is described in [isolated qualification](SPEC.md#isolated-qualification).

## Mobile

Expo/React Native JavaScript lives in `apps/mobile`. Expo Go cannot load its local native networking module.

```sh
npm ci --prefix apps/mobile
npm start --prefix apps/mobile
npm run check --prefix apps/mobile
```

`start` serves Metro for the installed development client; it does not build or launch an emulator. `check` exports Android and iOS JavaScript, not installers. Native modules and icon or splash changes need a new binary; Metro does not install them. Android build commands and their behavior are in [Android builds](SPEC.md#android-builds).

## Desktop updates

The packaged desktop app checks for a signed update at startup, every six hours and when the machine reconnects, and installs it with one action in the sidebar. The browser interface never updates itself. See [desktop updates](SPEC.md#desktop-updates).

## Connect over the local network

Enable the hub's **Settings → Local network → Allow HTTP connections**, then use its private IPv4 address; the listener and Docker binding must be reachable. This is unencrypted local traffic, not public hosting; Tailscale or HTTPS are the alternatives, and a Tailscale address needs Tailscale on the phone itself. Pairing and browser access use separate six-digit, single-use, ten-minute codes.

## Docker first run

```sh
docker compose up -d --build
docker compose exec arca node packages/cli/arca.js web-code
```

Open `http://localhost:17831` and follow the wizard: this machine, server access (paste the code), pairing for replicas, folder root. `ARCA_FILES` names the persistent files mount inside a custom container and `ARCA_PORT` the published port. Details: [fresh Docker server](SPEC.md#fresh-docker-server).

## Umbrel package

`deploy/umbrel/arca/` is the Umbrel App Store package; see [Umbrel packaging and submission](SPEC.md#umbrel-packaging-and-submission).

## Release

The **publish** workflow tests on macOS, Windows and Linux; a new version on `main` builds the desktop installers and Docker images and publishes a GitHub prerelease and Docker Hub tags. Registry, signing and pipeline details: [release pipelines](SPEC.md#release-pipelines). What remains before distribution is in [ROADMAP.md](ROADMAP.md).

## Public website

The single page in `site/` is static HTML and CSS with no framework, telemetry or runtime API.

```sh
npm run site:build
python3 -m http.server --directory site/dist 4178
```

`npm run site:release` writes `site/release.json` from published releases (it needs `GH_TOKEN`, `GITHUB_TOKEN` or an authenticated GitHub CLI). Configuration and publication are in [website publication](SPEC.md#website-publication).

## Documentation

- [README.md](README.md): what Arca is and how to install, run and develop it.
- [AGENTS.md](AGENTS.md): the rules for working here, including the autonomous task workflow.
- [ROADMAP.md](ROADMAP.md): what is left to do.
- [SPEC.md](SPEC.md): how Arca works today.
- [CHANGELOG.md](CHANGELOG.md): what each version shipped.

## License and contributions

Arca is free for personal and non-commercial use under the [PolyForm Strict License 1.0.0](LICENSE): you may use it, but not modify or redistribute it. That is deliberate: the project wants help, not forks.

To contribute, open an issue or a pull request on GitHub. Satoshi Ltd., the licensor, gives you permission to modify and copy the software only as far as needed to prepare and submit a contribution to this repository. By submitting one you confirm it is your own work and grant Satoshi Ltd. a perpetual, worldwide, royalty-free, irrevocable license to use, modify, sublicense and relicense it as part of Arca, with no obligation to accept it. Third-party dependencies keep their own licenses.
