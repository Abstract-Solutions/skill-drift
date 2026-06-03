# The GitHub token is read by Rust from the Keychain, with a live `gh` fallback

The TS engine needs a GitHub token but never reads one: Rust owns the secret and
passes it across the seam. `get_token` resolves it in order — a user-pasted PAT
in the macOS login Keychain, else `gh auth token`, else none — and TS injects the
result into `makeGitHubFetcher` (`set_token`/`delete_token` manage the stored
PAT). Reading in Rust keeps the secret in the OS-native store while its *use*
stays in TS, so ADR-0002 holds: Rust hands over bytes, never classifies. No token
degrades to unauthenticated polling (60 req/hr) behind a clear "add a token"
state, not an error.

**Revised by ADR-0010:** the cycle treats no-token as a distinct non-polling
`PollOutcome` that prompts to add a token (no unauth poll); the degrade described
here is deferred (issue #5) and would later flip `no-token` from a short-circuit
back to poll-anyway.

The Keychain is reached via `keyring-core` + `apple-native-keyring-store` (the old
`keyring` crate demoted itself in v4 — "do not depend on this crate"), preserving
the cross-platform abstraction ADR-0001 wanted: identical call sites, one `#[cfg]`
arm per future OS. The `gh` token is never copied into our own item — it is
queried live, because `gh` keeps it in the Keychain under its own item and
refreshes it.

Status: accepted. Corrects ADR-0001's `keyring` reference to `keyring-core` +
`apple-native-keyring-store`.

## Considered options

- **TS reads the Keychain via a JS plugin.** Rejected: the native keychain
  belongs in the native shell, and the community Tauri keyring plugins are
  low-adoption or stale — three hand-rolled commands keep the dep surface small.
- **Persist the `gh` token into our own item.** Rejected: a stale copy that fights
  gh's own refresh; reading it live keeps gh users zero-config.
- **`tauri-plugin-stronghold` (encrypted file vault).** Rejected: a
  master-password vault is the wrong model for a single OS-managed PAT.

## Consequences

- **GUI-launch PATH gotcha**: a Finder-launched app inherits a minimal `PATH`, so
  a bare `gh` spawn fails. Resolved by honoring `GH_TOKEN`/`GITHUB_TOKEN`, probing
  known install paths, then a login-shell fallback (`fix-path-env-rs`).
- **Ad-hoc Keychain re-prompts per rebuild** (the changing signature reads as a
  new app) — a dev-only click-through, gone in a stable build; a reused
  self-signed `APPLE_SIGNING_IDENTITY` makes "Always Allow" stick.
- **Update the PAT in place (upsert); never delete-then-recreate** — deleting
  wipes the item's ACL and re-triggers the prompt even when signed.
