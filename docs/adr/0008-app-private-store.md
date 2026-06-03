# App-private state (cache + snapshot) lives in the store, read directly by TS

The baseline cache (ADR-0004) and the last poll snapshot are persisted with the
Tauri store plugin (JSON) in `app_data_dir`, accessed directly from TS — not
mediated by Rust. This is the deliberate edge of ADR-0007: Rust mediates *OS and
user-filesystem* resources (the Keychain, the Manifest) because least-authority
matters there; the store is app-private scratch the webview's own engine owns, the
plugin cannot reach user data, and routing it through Rust commands would add
surface for no security gain.

The store holds only *derivable* data — a resolved-baseline cache and a
last-render snapshot — and is never a source of truth. So there is no migration:
on a `schemaVersion` mismatch, corruption, or absence, it is dropped and rebuilt
by the next poll. Losing it costs one poll, not data — which is also why SQLite is
overkill for this app.

Status: accepted.

## Schema

- One file, top-level `schemaVersion`.
- **Baseline cache**: key `${source}|${folder}|${hash}` → `string | null` (resolved
  baseline SHA, or `null` = known-absent; a missing key = uncached) — exactly the
  `string | null | undefined` the `BaselineCache` interface returns.
- **Snapshot**: `{ polledAt, statuses: SkillStatus[] }`, stored whole (including
  each Behind Skill's `commits[]`), so the popover paints instantly on open.
