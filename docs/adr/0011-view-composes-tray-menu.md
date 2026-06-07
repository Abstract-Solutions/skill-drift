# The view composes the tray menu; the cycle returns pure classification

The Poll Cycle returns a `PollOutcome` that is **pure classification** — no rendered
menu attached. The view (`App.tsx`) composes the tray menu from it via
`buildMenuModel(outcome, { now })` and the badge from the Behind count, then renders.
This revises ADR-0010's consequence that the outcome *carries* a built `MenuModel`
and the view is `renderMenu(out.menu)`.

ADR-0010 had the cycle import `buildMenuModel` from `menu.ts` to attach the menu,
while `menu.ts` type-imported the outcome back — a circular import (type-only, so
benign at runtime) and, the real friction, the **model depending on the view**: the
cycle reached up into the tray-menu module. Inverting removes the dependency: the
cycle imports nothing from `menu.ts`; `menu.ts` depends one way on the cycle's
`PollOutcome` type (the renderer depends on the model, never the reverse).
`PollResult` and `PollOutcome` collapse into one `PollOutcome` — the CONTEXT.md term
— and the menu-less intermediate disappears.

`buildMenuModel` stays the pure, Deno-tested transform; moving its call site from the
cycle to the view loses no coverage — the cycle test's one menu assertion was already
duplicated in `menu_test`. Badge policy already lived in the view (`ok ? behind : 0`);
the menu now joins it, so the view composes both consistently.

Status: accepted. Revises ADR-0010's menu-attachment / thin-view consequence;
ADR-0010 otherwise stands (the cycle is still a deep module returning a `PollOutcome`
the view renders). Builds on ADR-0009 (`buildMenuModel` → native menu is the seam).

## Considered options

- **Keep the menu on the outcome; break only the import cycle with a shared contracts
  module.** Rejected: it severs the *type* cycle, but the cycle still imports the
  view's `buildMenuModel` — the model→view dependency remains — and it adds a module
  whose only content is the outcome union, split from its producer.
- **Move `PollResult` into `menu.ts`.** Rejected: one-directional, but splits the Poll
  Outcome contract across two modules and houses a classification type in the view.

## Consequences

- The cycle never imports `menu.ts`; render-free classification is independent of
  presentation, and the engine's import graph is acyclic.
- The view is two pure/edge calls — `renderMenu(buildMenuModel(out, { now }))` and
  `setBadge(out.kind === "ok" ? out.behind : 0)`. Still thin, still test-exempt wiring.
- One union, named for the domain (`PollOutcome`); `PollResult` is gone.
- The menu's `now` is read at render time in the view — a second clock read after the
  cycle's `polledAt`; both ≈ now, so the updated-header reads "just now".
