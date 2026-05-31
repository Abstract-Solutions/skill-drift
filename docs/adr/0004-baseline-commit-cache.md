# Resolved install baselines are cached, keyed by the immutable folder hash

Resolving a Skill's `skillFolderHash` to its baseline commit (ADR-0003) walks the
folder's **full** commit history — the path-filtered commits are paginated to
exhaustion (GitHub Link `rel="next"`) — reading the folder's tree hash at each
commit until one matches. That's several GitHub calls per Behind Skill. The
mapping is immutable: a given folder content was produced by a fixed commit. So
the app caches it, keyed by `(source, folder, hash)`, as a resolved commit SHA —
or `null` for "not in history". An entry never goes stale because the key is
content-addressed; the `null` is sound only because the walk is exhaustive — a
single truncated page could miss a baseline more than 100 commits back and cache
a wrong Diverged verdict permanently.

The cache is read before the commit fetch, so a cached `null` (Diverged)
short-circuits with no fetch and no walk. A cached SHA still re-fetches the
commits to recount Behind against the advancing HEAD — the baseline is stable,
its distance from HEAD is not.

Status: accepted. Carried from skill-pulse ADR-0005, re-homed from Deno KV to the
Tauri store plugin (ADR-0001 removed the server). The `BaselineCache` interface
lives in the engine (`poll.ts`); the store-backed implementation is app wiring.

## Rejected

- **Resolving on every render** (no cache) — repeats the history walk for every
  Behind Skill on each open.
- **Caching `null` after a single 100-commit page** — a Skill behind by more than
  100 Watched Commits would be mis-cached as Diverged forever.
