# Rust is the native-I/O boundary; the webview gets purpose-built commands

The app's access to OS resources and the user's filesystem — the Keychain
(ADR-0006), the tray and poll-clock (ADR-0005), and the Manifest read — goes
through Rust, exposed to the webview as narrow, purpose-built commands rather than
a general OS-access plugin. The Manifest is read by a `read_manifest` command:
`Ok(None)` when `~/.agents/.skill-lock.json` is absent, `Ok(Some(contents))`
otherwise. TS owns all interpretation — `JSON.parse`, `deriveWatchedRepos`, and
the malformed/empty states. The C3 seam (ADR-0002) stays uniform: Rust is the I/O
edge, TS is pure logic and view.

The boundary covers OS and user-filesystem resources. App-private persistence is a
separate question (the store; see its own ADR).

Status: accepted.

## Considered options

- **Read the Manifest from the webview via `@tauri-apps/plugin-fs`** (a scoped
  capability). Rejected: it would be the one place the webview reaches the
  filesystem directly, granting a general file-read API (scoped to a path, but
  still general) rather than a single command with the path fixed in Rust. It also
  splits ownership — the v1 read in TS, the v2 fs-watch reward in Rust — whereas a
  Rust read makes the watch a same-module extension. The app reads exactly one
  file and otherwise talks to GitHub over the network, so the plugin's
  many-files benefit doesn't apply.

## Consequences

- The webview's filesystem reach is one command; the path resolves in Rust
  (`PathResolver::home_dir()`), so there is no capability-scope config or
  leading-dot glob to get right, and no `@tauri-apps/plugin-fs` dependency.
- A future fs-watch (v2 reward) extends the same Rust module — emit
  `manifest-changed`, TS re-reads via `read_manifest`.
