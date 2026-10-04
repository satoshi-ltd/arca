# Arca — agent instructions

Arca is a personal drive for the maintainer's own machines: a hub owns shared folders and their history, desktop/server replicas and phones keep complete local copies, and everything synchronizes both ways. These are the rules for working on it.

## Documents

Five documents, each answering one question. Put information in the one that owns it and nowhere else.

| File | Question | Never contains |
| --- | --- | --- |
| `README.md` | What is Arca, and how do I install, run and develop it? (for humans) | Status beyond its one-line version banner, history, pilot operations |
| `AGENTS.md` | Which rules apply when working here? | Status, tasks, history |
| `ROADMAP.md` | What is left to do? (its header defines fields and lanes) | Shipped work |
| `SPEC.md` | How does Arca work today? The contracts code must keep: product decisions, protocol, data and state, operations, design system | Dates, statuses beyond its one-line version banner, test counts, investigation logs |
| `CHANGELOG.md` | What did each version ship? | Implementation detail, test counts, review narrative |

- Start from README, SPEC's current-state summary and ROADMAP; then read the SPEC section the task touches.
- **SPEC** is present tense and edited in place: when behavior changes, rewrite the section that owns it. History lives in git and the changelog.
- **CHANGELOG** entries have one shape:

  ```
  ## x.y.z — YYYY-MM-DD

  - What changed for someone using or running Arca, then why when it is not obvious. One or two sentences.
  - At most five bullets; merge related changes, drop internal-only details.

  Needs: native build · desktop build · Casa redeploy   (only when true)
  ```

  Name files or functions only when the maintainer must act on them.
- Update the owning document in the same change as the code. Decisions go to SPEC and remaining work to ROADMAP, never to chat history or extra status files. Original visual references and third-party licences keep their own purpose. Current maintainer instructions override older material.

## Workflow

The maintainer runs the project as an autonomous loop with the user-level `next-task` skill (usually `/loop /next-task`) and `adversarial-reviewer` agent in `~/.claude/`. Each iteration takes one approved task, implements and tests it, bumps the version and changelog, has the reviewer try to break it, applies the findings, validates, commits, pushes and watches CI.

Project wiring for those tools:

- **Task pool:** `ROADMAP.md`. Only `owner: agent` tasks in Queue are worked on; only the maintainer approves a task into Queue.
- **Version:** `node scripts/bump-version.js` (patch by default), then the CHANGELOG entry. Every commit bumps the version; manifests, lockfiles, displayed versions and the changelog always agree (`scripts/check-release.js`). A commit that changes only `ROADMAP.md` or `design/` bumps nothing and adds no changelog entry.
- **Validation:** keep the machine cool. While building, run only the test files of the area you touch (`taskpolicy -b nice -n 19 node --test <files>` on macOS), and check once per task that each new test fails without the change. Before a push the `pre-push` hook runs the CI suite once (it skips it when a `validate-local` stamp matches the same files), so run `taskpolicy -b nice -n 19 git push`. Run the full `npx -y node@<CI version> scripts/validate-local.js` (it prints the exact command: a clean copy, root-only `npm ci`, the version check, the CI suite, off Linux the mobile source suite and the mobile build-tooling tests) only when dependencies, lockfiles, release or build scripts change, and to close a long batch of tasks. Report it separately from the real GitHub pipeline results.
- **CI:** `gh run list` for the commit's full SHA: `publish`, then `publish-docker` and `publish-site`. `prune-actions.yml` deletes runs beyond the newest 10 per workflow once they are a week old, so do not rely on older run logs. A red pipeline on `main` is the next task.
- **Review checklist**, on top of the generic one: Windows paths (`path.join`/`path.sep`), temp directories and line endings; hub, desktop replica and mobile role differences; `.arcaignore` and the fixed exclusion list; conflict preservation and deletion safety; native Kotlin/Swift against `apps/mobile/node_modules`.

Rules of the loop:

- Invoking `/next-task` or `/loop /next-task` is the maintainer's explicit request to commit and push each finished task once review and validation pass. Outside the loop, commit only when asked. When the maintainer says not to commit, prepare and validate but leave changes uncommitted until told otherwise.
- Adversarial review before every commit; a second pass on the deltas when fixes were substantive. The reviewer reads and reasons: it does not rerun the suites the author ran, only the single test file it needs to reproduce a claim.
- Interruptions: triage before continuing, and say where each item went. A bug the maintainer reports goes to the top of Queue; a requested feature goes to Queue; ideas, including your own, go to Proposed; questions get answered.
- Anything needing a native build, an installer, Casa, credentials, a physical device or a product choice becomes a `Needs maintainer` task.
- Stop and report when Queue is empty or everything is blocked on the maintainer.

## Engineering rules

- Implement only the approved scope. You may propose product or UX changes, but never implement proposals, additional controls or new flows without the maintainer's explicit validation. Within approved work, use the shared tokens and components and update SPEC's design section.
- Every functional change ships with tests that fail without it. CI runs on Ubuntu, macOS and Windows; `tests/mobile-*.test.js` runs on Ubuntu only because that code ships to phones. Build filesystem expectations with `path.join`/`path.sep`, never a hardcoded `/`, and never assume one platform's temp directory or line endings.
- Mobile build-tooling tests live in `apps/mobile` (`npm test` there), not in the root suite; CI never builds mobile installers.
- Each environment owns its commands: the root keeps the daemon, tests, site and the design kit (`npm run design`); `apps/desktop` has `start`, `start:clean`, `ui`, `build`, `release` and `verify:bundle`; `apps/mobile` has its build scripts. Run them with `--prefix`; add no aliases at the root.
- No TypeScript, no inline styles, no overengineering.
- **Design kit.** After a visible change, update the hand-authored pages in `design/` and run `npm run design`; the design-kit contract, board format and lifecycle live in `design/AGENTS.md`.
- **Views in sync.** The views (System and every interface tab) show what ships; Proposals shows what is proposed.
  Shipping a proposal is one change: the code, the views regenerated so they show the new design, the board deleted,
  its `ui` line deleted, and the changelog and the spec updated. A board left standing after its change shipped, or a
  view that still draws the old look, fails the adversarial review before the commit.
- App-owned text is English until the i18n phase; preserve user names, paths and content. Conversation with the maintainer is Spanish.
- The desktop updater signs payloads with `TAURI_SIGNING_PRIVATE_KEY` (public half in `tauri.conf.json`). Never commit the private key; `apps/desktop/src/app.js` reports its version only through `APP_VERSION`.
- Enable the hooks once per clone: `git config core.hooksPath .githooks` (`pre-push` repeats the version check and the CI suite, skipping the suite when `validate-local` already passed on the identical files). Remote: `git@github.com:satoshi-ltd/arca.git`.
- A build or an API response is not workflow validation; keep implemented, deployed and verified apart in ROADMAP and in reports.
- Create a separate Codex task only when asked, using ROADMAP IDs and acceptance evidence.

## Product decisions (non-negotiable)

- The hub alone creates shares, identified by ID. Every device chooses its own local destinations. Device selections edit both ways with complete local files, never placeholders.
- Mobile linked albums add photo-library uploads to a complete two-way Arca working copy: every selected participant downloads the whole shared folder, including other devices' media, into app-owned storage. Never import hub files into Photos, never propagate deletions made in Photos, never remove originals from the system library. Participants may explicitly delete from a shared gallery; that affects synchronized Arca copies only. Linking an album preserves the existing working copy. Any future object-only gallery conversion verifies retained content and asks before removing working files.
- Pause, Stop syncing, hub Stop syncing here and hub Delete share are different operations with the file and history consequences SPEC documents.
- Full backup is optional and only for desktop/server replicas. Phones are replicas only: no hub, no backup. Quit leaves the daemon running.
- No backward-compatibility branches, legacy modes or unused code before release; keep current error recovery and platform support.
- Discovery never links devices. Web access and pairing use separate six-digit, single-use, ten-minute codes with persistent failure budgets; credentials stay long-lived and revocable.
- Web is the primary server administration; Tauri manages its local daemon; the CLI is auxiliary, without interactive menus. A replica credential never implies hub administration.
- New hub folders get a rule-free `.arcaignore`; replicas never seed one and a missing one is fine. A fixed list of OS metadata, temporaries, caches, `.git` and `.obsidian` always applies and cannot be re-included; names that may be content (`cache/`, `build/`, `logs/`, `*.lock`, `.env`) never join it.
- The maintainer's `~/.alpi` policy follows `.gitignore` except that `.env` and secrets are intentionally included. Never log secret contents; read the actual policy before editing it, since older exclusion notes are superseded.

## Live environment boundaries

- Metro is the maintainer's: never start or restart it; ask when configuration changes need a restart.
- Native builds and installs are the maintainer's unless explicitly requested in the turn. Source changes and reviews do not authorize them.
- Casa (SSH `casa`, Docker container `arca`, state under `/home/atlas/arca-pilot`) is the maintainer's: never update or restart its container unless explicitly requested in the turn. Prepare and validate locally, then report deployment and client-compatibility requirements; operational details live in SPEC.
- Development uses the real `~/.arca` in `/Users/javi/git/arca`; tests use isolated state.
- Never reset live state, delete user files, enable backup or resume a user pause as incidental cleanup. Nothing relocates or deletes existing copies automatically, including code you write.
- Native changes need the running binary rebuilt and daemon changes need the service restarted; a built bundle is not the running process.
