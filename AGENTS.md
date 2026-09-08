# arca — agent instructions and project memory

## Resume context

The project has three maintained documents:

- `AGENTS.md` — contributor instructions and live-environment boundaries.
- `README.md` — human introduction and entry commands.
- `SPEC.md` — current state, remaining work, product/technical contracts, operations and design system.

Read README, then SPEC's “Resume work here” and “Remaining work and task candidates”; consult its relevant contract, operations or design section for the task. Keep persistent decisions and task candidates in SPEC, not chat history or extra status/handoff/roadmap documents. `changelog.md` is the version ledger, not a competing specification. Original visual references and third-party documentation/licenses retain their separate purpose. Current user instructions override historical material.

## Working rules

- No commits or pushes unless explicitly requested. Remote: `git@github.com:satoshi-ltd/arca.git`.
- Every commit must increment the project version and include a matching entry in `changelog.md`. Keep package/lockfiles, Tauri manifests, displayed/reported versions and the changelog aligned. Default to a patch bump unless the user specifies another version. This does not authorize commits or pushes.
- No TypeScript; avoid inline styles and overengineering.
- All app-owned text is English through phases 1 and 2. Preserve user names, paths and content. i18n is phase 3; conversation may be Spanish.
- The user authorized implementing the handoff and refining UI/UX beyond it. Use shared tokens/components and update the design section of `SPEC.md` for decisions. Do not treat the old designer-only restriction as current.
- Update the owning document in the same change. Distinguish implemented, deployed, verified, proposed and planned. A build or API response is not full workflow validation.
- Create a separate Codex task only when explicitly requested. Use the spec's task IDs, define outcome/acceptance evidence, and do not silently implement proposed features.

## Non-negotiable product decisions

- Hub alone creates shares; IDs identify them. Every machine chooses independent local destinations. Replicas edit bidirectionally. Complete local files, no placeholders.
- Pause, replica unlink, hub local-copy unselection and hub Delete share are different operations. Preserve the documented file/history consequences.
- Optional full backup is additional to replica working sync. Legacy backup nodes stay compatible. Quit leaves the daemon running.
- Discovery never links machines. Web access and pairing use separate six-digit, single-use, ten-minute codes with persistent failure budgets; credentials remain long/revocable.
- Web is primary server administration; Tauri manages its local daemon. CLI is auxiliary, without interactive terminal menus. Do not imply remote hub admin authority from a replica credential.
- New hub folders optionally create `.arcaignore` via an unchecked checkbox; existing directories and replica selection do not seed it. No hidden configurable cache list.
- The user's `~/.alpi` policy follows `.gitignore` except `.env` and secrets are intentionally included. Never log secret contents. Read the actual policy before editing; older exclusion notes are superseded.

## Live environment boundaries

- Metro is user-managed: do not start or restart it. Ask the user to restart Metro when configuration changes require it.

- Workspace: `/Users/javi/git/arca`. Development normally uses the real `~/.arca`; tests should use isolated state.
- Casa: SSH `casa`, Docker container `arca`, installation/state under `/home/atlas/arca-pilot`. Operational details and restart/deployment boundaries live in the spec.
- Do not reset live state, delete user files, enable backup or resume a user pause as incidental cleanup. No automatic relocation/deletion of existing copies.
- Native changes require the running binary to reload/rebuild; daemon changes require service deployment/restart. Do not confuse a built bundle with the currently running dev process.
- As of 2026-09-08: phase 1 alpha, not release-qualified. Event-driven remote sync/long polling is proposed, not implemented. Consult the spec for current open work instead of inferring completion from old messages.
