# Greenfield local Tauri app, not a split local+cloud Deno deliverable

skill-drift is a fresh rewrite of skill-pulse as a single, fully-local macOS
menu-bar app: one process reads the Manifest, polls GitHub, computes Behind, and
renders — no hosted dashboard, no local/cloud split, no shared token, no Deno
Deploy. v1 split into a local Scanner and a cloud Dashboard (skill-pulse
ADR-0001) only because a cloud dashboard can't read `~/.agents/`; a local app
reads it directly, so that constraint — and with it the Scanner↔Dashboard wire
contract (skill-pulse ADR-0002) and the cron-polled snapshot that existed only to
spare each page load a live fan-out (skill-pulse ADR-0006) — all disappear. We
keep the concept and the pure engine; the Fresh / Deno-KV / Deno-Deploy
scaffolding is discarded.

The stack is Tauri v2 + React-TS with **Deno as the frontend toolchain**. Deno
was chosen over Node/Bun specifically so the engine's existing `Deno.test` +
`@std/assert` suite ports verbatim — the safety net for a native stack the user
reviews less fluently than TS (see ADR-0002).

Status: accepted. Supersedes skill-pulse ADR-0001 and ADR-0002; guts ADR-0006.

## Considered options

- **Port v1 as-is** (keep the split + Deno Deploy). Rejected: the split's only
  reason was remote access to local data; once the app is local the Scanner, the
  wire contract, the snapshot cache, and the hosting are all dead weight.
- **All-cloud.** Rejected: a cloud process can't auto-discover locally-installed
  Skills, which is the whole point of the tool.

## Consequences

- No multi-device access — a local app, by design.
- The GitHub token moves from a server env var to the user's Keychain (ADR-0002).
- Mac-first but not Mac-locked: build/test macOS only, but use cross-platform
  abstractions (the `keyring` crate, Tauri's tray API) so a later Linux/Windows
  port stays cheap.
