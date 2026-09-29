# Arca roadmap

Updated 2026-09-29 · Phase 1 functional alpha, not release-qualified.

This document owns everything still to do: task candidates, open decisions, pending deployments, qualification gates and documentation debt. [SPEC.md](SPEC.md) owns current state, contracts, operations and the design system; [changelog.md](changelog.md) records what each version shipped. When an item ships, remove it here and record it in the changelog and in the SPEC section it changes. When an item is decided, move the decision into SPEC.

Status words: **proposed** (needs maintainer validation), **decided** (validated, not started), **in progress**, **implemented** (in source, not deployed or verified), **needs deployment**, **needs qualification** (real-environment evidence missing), **known gap**, **planned**. Keep implemented, deployed and verified separate: a build, an API response or a passing test is not workflow acceptance.

For a new task, cite its ID and the SPEC contract it touches, define a bounded outcome, the affected code, validation and deployment target. Do not turn a proposal into active work, or create a Codex task, unless the maintainer asks.

## Next up

- **P1-RELINK** · decided 2026-09-29, in progress. Relinking a replica treats the hub as the source of truth: local files that the hub deleted, or that differ from its current version, go to the system Trash (Finder/Explorer-recoverable, not synced, not left in the folder) instead of being proposed back as content or conflict copies (the `photos-yuri` resurrection). Files the hub never had still upload. Acceptance: a relink after hub-side deletions and edits restores nothing on the hub, creates no conflict copies and leaves the stale local versions in the Trash.
- **P1-DEVICE-CHECK** · needs qualification. On the Fold after a native build with v0.6.13: storage drops to about the photos size after the first sync; grid thumbnails and video posters fill in quickly while folders sync; HEIC photos open fast. Also, with Metro reloaded: v0.6.7 infinite scroll and fast-scroll thumb (drag follows the finger, sparse year chips), pinch density levels (also on iOS); v0.6.9 offline gallery with every downloaded photo from local disk and placeholders for the rest; v0.6.10 local video posters and autoplay; v0.6.11 Info pausing/resuming a video.
- **P1-DESKTOP-BUILD** · needs deployment. The running desktop daemon needs a build from v0.6.11 or later for unlink-deletes-by-default, local-only previews and the photo/video header counts.
- **P1-CASA-DEPLOY** · needs deployment. Record Casa's running version first. Hub-side changes waiting on a redeploy: v0.6.11 per-month video counts (web header); v0.6.7 per-month newest revision (mobile detects edits that keep a month's count); v0.6.6 snapshot lease renewal on page reads (older hubs restart a resumed first download after 10 minutes); removal of obsolete gallery endpoints; the v0.6.0 hub audit changes (503/412 gating, error codes, lease replacement, stored-part upload verification, lost-reply fast-forward). Order: Casa first, then desktop. From 0.6.2 on, replicas and phones go before or together with the hub.

## Maintainer decisions

- **P1-DECISIONS-SYNC** · proposed. Open choices from the offline audit: LAN permission caching; serving the first snapshot page without a hub scan; trusting recorded blob signatures (completed-blob checks still re-hash); merging on-disk entries into desktop browsing; offline deletion of unsynced files; renaming modified synced files; offline Disconnect; removing the unreachable picker-only gallery path.
- **P1-EMULATOR-STORAGE** · proposed. The development emulator has about 171 MB free: create a new 64 GB AVD or reinitialize the existing one.
- **P1-INFO-NOTICE** · proposed. Default colour of info notices: inverted paper or green.
- **P1-CASA-POLICIES** · decided, waiting. Once every device runs 0.6.2 or later, remove the redundant `.DS_Store`/`Thumbs.db`/`desktop.ini`/`.git`/cache lines from Casa's `alpi-workspace`, `alpi-mirai-workspace` and `alpi-host` policies.

## Leaving alpha: phase 1 qualification

Phase 1 acceptance: a real hub and replica demonstrate creation, initial full sync, independent destinations, offline edits, reconnection, conflict preservation, deletion, restoration, revocation and restart recovery; backup restore is checked independently; web authentication and unauthorized access are verified; users can identify the managed machine and recover from errors without guessing.

- **P1-LOAD** · needs qualification. A large hub folder while unrelated replicas upload and receive. The bounded Docker run (100,000 entries, three concurrent snapshots, a verified 1 MiB transfer) passed; sustained proposal/mutation queue latency, pause/unlink responsiveness and abandoned snapshot leases remain. Also qualify large application-state folders per workload. Do not claim concurrency solved from a status request.
- **P1-SCHEDULER** · implemented and deployed, needs qualification. Persistent dirty paths, incremental cursors, 15 s/60 s adaptive checks, six-hour reconciliation, long polling (`/v1/events`) and mobile OS background tasks. Measure idle wakeups, CPU, disk reads, traffic, battery and recovery correctness before changing timing defaults.
- **P1-UX** · needs qualification. The actual running native binary: tray transitions, light/dark menu bars, reduced motion, long paths, dialogs, offline startup and error recovery; real sleep/wake on macOS, Windows and Linux; OS notification delivery, activation and click routing on Windows/Linux; the native gallery Save dialog and Maps launch; the 320 px tray viewport, role chips in Tauri and WebKit/Windows motion.
- **P1-RECOVERY** · needs qualification. Prolonged soak, physical power loss and an independent real backup/restore drill. The pilot has no separate real backup yet.
- **P1-RELEASE** · pipelines implemented, needs qualification. Release bundle checks, supported desktop distribution validation and real installer/runtime acceptance. Hosted workflows passed for v0.6.7–v0.6.11; v0.6.4–v0.6.6 were not checked. Hosted direct publication (draft assets, Docker Hub push) and the macOS installer retry still need a hosted confirmation. Docker and GitHub publication are not atomic.
- **P1-UPDATER** · implemented, needs qualification. A real update between two published versions on macOS with and without Launch at login, Windows NSIS and Linux AppImage/deb, each ending with the daemon answering under the new version; hosted `.deb.sig` generation. Known gap: an NSIS failure after Arca exits leaves the daemon stopped until Arca reopens (candidate: a detached Windows watcher that restores it). The Rust unit tests in `apps/desktop/src-tauri` do not run in CI.
- **P1-SERVER-ONBOARDING** · implemented, user acceptance in progress. Full real-device replica pairing and selection from the new wizard, ARM, image upgrades. See [Server onboarding and first access](SPEC.md#server-onboarding-and-first-access--september-12-correction).
- **P1-CASA-CPU** · known gap. The Casa hub CPU stall (98–103% CPU with HTTP and discovery timeouts) has no identified cause. Capture or reproduce before attributing it; do not repeat live evaluator-based profiling.

## Mobile

- **P2-MOBILE** · implemented, needs qualification. Selected folders become complete persistent copies, incomplete work is reported honestly, imports reach the hub, transfers resume without corruption and suspension loses no data. Validate low storage, interrupted downloads, revoked credentials, offline access, keyboard handling (phone, Fold, iOS), text scaling, launcher/splash in a standalone build, rename, APK opening on Samsung, Fold sticky scroll, settings visuals, iOS LAN pairing, name propagation and Fold throughput after an updated build. Distribution configuration and store listings remain.
- **P2-GALLERY** · implemented, needs qualification. Album uploads alongside a complete working copy: native installation and physical-device acceptance, original cloud access and EXIF/RAW/HEIC/Live Photo fidelity (including limited access and editor workflows), and a physical Samsung run with a library over 10 GiB, screen-off/background continuity, battery restrictions, interruption and resumed completion. Verify the historical archive and real-phone uploads independently before removing Immich or claiming a migration.
- **P2-GALLERY-VIEW** · implemented, needs deployment and installer qualification. Desktop/web chronological gallery with authenticated persistent thumbnails prepared after photo acceptance, dated browsing and the image viewer. Isolated API/DOM tests and browser visual checks pass; it needs the updated hub and desktop production dependencies (Sharp, exifr) in shipped installers and on Casa.
- **P2-GALLERY-DELETE-DEVICE** · needs qualification. With disposable photos on Android and iOS: direct shared deletion, Live Photo groups, connection failure, partial selection failure and unchanged Photos originals; persistence of gallery deletions across remounts; non-recursive directory deletion (Android `Files.delete`, iOS `rmdir`).
- **P2-VIDEO** · needs qualification. Physical-device video/audio, seeking and rotation; local posters on iOS (the frame request retries until the player item attaches).
- **P2-NATIVE-AUDIT** · not implemented, needs a native rebuild. F03 iOS cancel/session race; F01, F10 (native half), F29, F35 Android picker/share copies off the UI and module threads with verified completion and generated cache names; F12/F32 native error codes, Android cancel-before-connect and a write watchdog; native iOS hashing; a per-item iCloud photo picker; share-extension failure feedback.
- **P2-MOBILE-ENGINE** · not implemented. Adaptive mobile download chunks (1 MiB sequential today, desktop honours 8 MiB) and moving the verified download into place instead of copying it (objects are collected after each cycle since v0.6.13, but materialization still needs space for two copies of the file being applied), pending measurement on the Fold; a hub-busy liveness probe; F73 credential identity check on 401 (deferred: a hub destroyed and set up again at the same address must still unpair replicas); a crash record from a global error handler; a tolerant `galleryConfig` that cannot publish deletions from a broken gallery record; a path-scoped lookup so gallery conflict recovery does not cancel a paused first-download lease.
- **P2-MEDIA-LIBRARY** · not implemented. Migrate the gallery from `expo-media-library/legacy` to the `Query`/`Asset`/`Album` model.
- **P2-SHARING** · known gap. The iOS Share Extension is configured but unverified; text/plain file streams, links and text are not imported; duplicate temporary filenames must be shared separately; cold-start, foreground and multiple-file cases are untested.
- **P2-NATIVE-BUILD** · needs deployment. A native build that includes the Android screen-off TransferSession fix and drops the obsolete exports and permission text of the removed deletion review.
- **P2-PERFORMANCE** · proposed. Measure native first paint, cold load and large-directory listing latency; consider native asynchronous inventory on mobile; narrow desktop DOM updates where measurements justify them.
- **P2-FOLD-SCALING** · known gap. The Samsung Fold scaling issue has no recorded fix; the September 16 text-size setting may cover it. Verify.

## Web and pairing

- **P2-WEB-TRUST** · not implemented. Console-free initial trust and a passkey flow; background push for web sign-in approval; QR pairing; pairing a discovered replica directly from another replica, remote hub-administration switching and one-click bidirectional pairing (none implemented; proposals only).
- **P1-CODE-BUDGET** · known limit. Anyone who reaches the hub can deliberately exhaust the short-code budget; keep access on trusted routes.

## Hub, Docker and Umbrel

- **P1-UMBREL** · installed on amd64 Umbrel, submission pending. ARM runtime, image-version upgrade path, public metadata and licence, submission. Before submitting: choose the release image (keep 0.4.1, or update all three image references and the manifest version together after a newer image is published; the pinned 0.4.1 image lacks the onboarding fixes); qualify upgrades, real client addressing and the real `app_proxy`; resolve public repository/support access and the distribution licence; attach checked screenshots and the source logo; open the real PR, record its URL in `submission` and rerun the full lint. Keep the pilot icon override until the official gallery is published. The Umbrel update helper does not qualify arbitrary future schema upgrades or restores. See [Umbrel packaging and submission](SPEC.md#umbrel-packaging-and-submission--september-12).

## Security and signing

- **P1-SIGNING** · known gap. Windows signing is not implemented; macOS Developer ID signing/notarization stays optional (a signed run with `sign_macos` checked and `publish` unchecked remains to try).
- F29 (expo-sharing writes to `cacheDir/<sender display name>`) is a security issue tracked in **P2-NATIVE-AUDIT**.

## Distribution and website

- **P1-SITE** · needs deployment. Cloudflare `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_PAGES_PROJECT_NAME` are missing (DevOps); create a separate Pages project, attach `arca.satoshi-ltd.com`, disable Git auto-deploys and run the GitHub-to-Cloudflare publication end to end.
- **P1-PUBLIC-ACCESS** · needs qualification. Anonymous GitHub access returned 404: confirm public downloadability before launch; replace store home-page links with real listing URLs once they exist; decide whether Docker Hub is public.

## Documentation debt

- **DOC-SPEC-STALE** · known gap. SPEC version lines still naming 0.6.5/build 28 and 0.6.4/build 27 as current; the desktop updater described as uncommitted although it shipped in 0.5.4; notes saying long polling and mobile OS scheduling are not implemented, which contradict the scheduler contract.
- **DOC-README-STALE** · known gap. README: the first real Umbrel helper update marked "to be verified" (done); publication to GHCR (dropped); "No automatic updater" (the desktop updater exists); Files as the gallery folders' default tab (they open in Gallery); pointer-driven site motion (CSS-only); five-minute approval expiry (SPEC says ten); the v0.2.3 image note.

## Verify and close

Items older notes still list as open, while later notes suggest they are resolved. Confirm, then delete them here and fix the older note:

- F44, resuming snapshots across turns: implemented in v0.6.6.
- The Umbrel helper's first real update and the `update-docker` end-to-end run: both recorded as done.
- Fold/emulator sync after the port 17831 migration: the Fold syncs with Casa since.
- iOS on SDK 57: a simulator `xcodebuild` passed at v0.6.1; a device build is still missing.
- Pending Windows/Ubuntu CI reruns from September: hosted runs have passed since.
- Old Casa deployment gaps: later deployments happened; Casa's current version is not recorded (see **P1-CASA-DEPLOY**).
- Cache-first navigation, marked proposed: partly implemented since.
- Web approval delivery and Android incoming sharing via COROS: confirmed by the maintainer (iOS and multi-file sharing stay in **P2-SHARING**).
- The cause of an earlier Fold pause: likely the album-first ordering fixed in v0.6.6.

## Later phases

- **P3-I18N** · planned. Extract strings into catalogs for Tauri, Expo and the shared web frontend; language selection; localized dates, numbers and sizes; dialogs, errors, tray menus and notifications; never translate user content. English-only through phases 1 and 2.
- **P3-AUTO-LINK** · paused, not in target. Automatic machine linking under a same-Tailscale-owner policy.
- Constraint for any future object-only gallery conversion: verify retained content and ask before removing working files.
