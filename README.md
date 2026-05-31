# skill-drift

macOS menu-bar app that watches the Claude Code Skills you've installed and flags
when they've drifted **Behind** their upstream GitHub repos.

The tray badges when any Skill is Behind; click for the list. Fully local — one
process reads the install Manifest (`~/.agents/.skill-lock.json`), polls GitHub,
computes Behind, and renders. No server, no account.

## Status

Early. The pure engine (Manifest read, GitHub poll, Behind compute) is ported
from skill-pulse (v1) and tested; the native menu-bar shell is in progress.

## Architecture

C3 seam — logic in TypeScript, a thin Rust shell for the native slice:

- **TS engine** (`src/engine/`) — Manifest → Watched Repos → per-Skill freshness.
  Pure and dependency-injected; the real GitHub fetch and filesystem reads are
  injected edges.
- **Rust shell** (`src-tauri/`) — tray icon + Behind badge, the background
  poll-clock, and Keychain access for the GitHub token. Never gates correctness.

See `CONTEXT.md` for the domain language and `docs/adr/` for the decisions behind
the shape.

## Stack

Tauri v2 · React 19 + TypeScript · Deno toolchain (chosen so the engine's
`Deno.test` suite runs as-is).

## Develop

Prereqs: Deno, Rust, Xcode Command Line Tools.

```sh
deno install            # frontend deps (nodeModulesDir: auto)
deno task test          # engine test suite
deno task tauri dev     # run the app (native window + webview)
deno task tauri build   # build the macOS bundle
deno task check         # fmt + lint + typecheck the engine
```
