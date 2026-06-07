# The poll cycle is a deep TS module (`runPollCycle` → `PollOutcome`)

The Poll Cycle (CONTEXT.md) gets its own deep module, `src/engine/cycle.ts`, not
an imperative tangle in the App view. `runPollCycle(deps)` reads the Manifest,
derives the Watched Repos, polls, classifies every Skill, writes the snapshot,
builds the menu, and returns one `PollOutcome` — a discriminated union the view
renders. The engine already owns classification (ADR-0002); this extends the same
discipline to the orchestration that composes it, so the cycle and its error
modes sit in tested TS (`src/engine/` — the test line) instead of an untested
React effect (`src/`).

The cycle returns data; it never reaches the OS. Every native edge sits behind
one typed adapter, `src/platform.ts` — the only module importing
`@tauri-apps/api`. The cycle's deps are ports defined in the engine (as
`BaselineCache` already is, ADR-0004); `platform.ts` is their adapter, satisfying
them with the Rust commands (ADR-0007), the store (ADR-0008), and the menu API
(ADR-0009). Tests inject fakes for the same ports — two adapters, one real seam.

Status: accepted. Extends ADR-0002 (logic in TS) to the orchestration; the TS
counterpart to ADR-0007's Rust commands; revises ADR-0006's no-token degrade to a
non-polling short-circuit (the unauthenticated degrade is deferred — issue #5).
Partially superseded by ADR-0011: the Shape and Consequences below are the original
design — `PollOutcome` carried a built `MenuModel` and the view was
`renderMenu(out.menu)`. ADR-0011 inverts that (a render-free `PollOutcome`; the view
composes the menu); the deep-module decision otherwise stands.

## Shape

- `PollOutcome = ok{ menu, behind, statuses } | no-manifest | no-token |
  malformed` — each carrying a built `MenuModel`. These are the per-poll **Poll
  outcome** states (CONTEXT.md: Installed / Nothing installed / No token /
  Malformed, respectively), distinct from the per-Skill **Freshness states**.
- **No cycle-level `error` kind.** A GitHub outage surfaces as every Skill in
  per-Skill **Error** inside an `ok` poll; a thrown edge fault propagates to the
  scheduler, which keeps the last menu.
- **The cycle owns the snapshot write** (an injected `saveSnapshot`), symmetric
  with the `BaselineCache` write it already makes (ADR-0004/0008) — persistence in
  one place, the view stays purely `renderMenu` + `setBadge`.
- `buildMenuModel(outcome, { now }) → MenuModel` is a pure transform in
  `src/engine/menu.ts` returning presentation-independent data; `renderMenu` walks
  it into native items. This is what makes ADR-0009's "menu → popover is a
  localized swap" real. `relativeTime` moves here from `github.ts`.
- `makeFetchers(token)` returns the three fetchers shaped for `AssembleDeps` — one
  constructor at the call site, not three.

## Overlapping polls coalesce (leading + one trailing)

ADR-0005 fires the cycle from two triggers — a poll on webview mount and the Rust
`poll-tick` — and the interval can tick mid-cycle. `src/engine/schedule.ts`'s
`makePollScheduler(run)` keeps at most one cycle in flight and coalesces at most
one trailing run, so a Manifest/HEAD change during a long poll is still caught.
This bounds the launch race (mount-poll + launch tick) to one redundant
*sequential* poll (cache-warm, idempotent), never concurrent — which also removes
any out-of-order snapshot/menu write. The coalescer is a tested engine module,
not booleans in the view.

## Considered options

- **Orchestrate inline in the App view.** Rejected: the cycle and its error modes
  (absent/malformed Manifest, no token) land above the test line in an untested
  React effect — the bugs hide in how the tested engine functions are called.
- **Cycle calls injected output adapters (`renderMenu`/`setBadge`) itself.**
  Rejected: the view shrinks to one line, but the cycle's contract turns effectful
  and tests must capture via output fakes; return-data keeps the assertion surface
  the engine already uses.
- **Re-entrancy guard inside `runPollCycle`.** Rejected: hidden cross-call state
  muddies the pure `(deps) → PollOutcome` contract; a deduped call has no fresh
  data to return.
- **Drop the mount-poll, trust the launch tick.** Rejected: reopens the startup
  race ADR-0005 closed (a tick can precede the webview's `listen`).

## Consequences

- The view is a thin adapter: `onPollTick(scheduler.trigger)` plus
  `renderMenu(out.menu)` / `setBadge(out.behind)`.
- `src/platform.ts` is unit-test-exempt wiring; everything decision-shaped is
  Deno-tested in `src/engine/`.
- New engine modules — `cycle.ts`, `menu.ts`, `schedule.ts` (plus `makeFetchers`
  in `github.ts`) — are picked up by `deno task test` automatically.
