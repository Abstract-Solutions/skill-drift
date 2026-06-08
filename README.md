# skill-drift

**Early — work in progress.** macOS menu-bar app that watches the Claude Code
Skills you've installed and flags when they've drifted **Behind** their upstream
GitHub repos.

The tray badges when any Skill is Behind; click for the list. Fully local — one
process reads the install Manifest (`~/.agents/.skill-lock.json`), polls GitHub,
computes Behind, and renders. No server, no account.

## Architecture

Logic in TypeScript, a thin Rust shell for the native slice:

- **TS engine** (`src/engine/`) — Manifest → Watched Repos → per-Skill freshness.
  Pure and dependency-injected; the real Source Repo reads (the `SourceRepoReader`
  port) and baseline cache are injected edges.
- **Webview view** (`src/App.tsx`, `src/platform.ts`) — runs the Poll Cycle in a
  hidden webview (ADR-0009), composes the tray menu + badge from each
  `PollOutcome`, and is the one module that touches the native edge
  (`invoke`/`listen`). Composition only — no logic the engine doesn't own.
- **Rust shell** (`src-tauri/`) — tray icon + Behind badge, the background
  poll-clock, the Manifest read, and Keychain access for the GitHub token. Never
  gates correctness.

See `CONTEXT.md` for the domain language and `docs/adr/` for the decisions behind
the shape.

New here? Read `CONTEXT.md` first, then ADR-0001 (why local Tauri) and ADR-0002
(the engine/shell seam) for the overall shape; the rest of `docs/adr/` covers
specific decisions.

## Stack

Tauri v2 · React 19 + TypeScript · Deno toolchain (chosen so the engine's
`Deno.test` suite runs as-is).

## Develop

Prereqs: Deno, Rust, Xcode Command Line Tools.

```sh
deno install            # frontend deps (nodeModulesDir: auto)
deno task test          # engine test suite
deno task tauri dev     # run the app (menu-bar tray + hidden webview)
deno task tauri build   # build the macOS bundle
deno task check         # fmt + lint + typecheck the engine
deno task typecheck     # typecheck the view layer (App.tsx, platform.ts)

cargo test   --manifest-path src-tauri/Cargo.toml   # Rust shell tests
cargo clippy --manifest-path src-tauri/Cargo.toml   # Rust shell lint
```
