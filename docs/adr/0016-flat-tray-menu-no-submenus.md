# The tray menu stays flat — macOS dismisses NSStatusItem submenus on first hover

The tray menu had two native submenu drill-downs (ADR-0009): a Behind Skill's
Watched Commits, and the Current Skills' name list. On macOS an `NSStatusItem`
submenu glitches on its first tracking session and tears the whole menu down — the
menu dismissed on the first hover of the first row, then behaved on the second open.
The menu model is now deliberately **flat**: a Behind Skill's commits render as inline
indented rows (`COMMIT_INDENT`) beneath its header, and Current collapses to a bare
count. The `submenu` `MenuRow` variant and the edge's `toNativeSubmenu` walker are
removed, so nesting is *unrepresentable* — the constraint is structural, not a
convention a later change can quietly break.

Diagnosed by elimination, then confirmed by the fix: it is **not** our render path
(timestamped instrumentation showed a single `setMenu` at launch, then silence while
the menu still dropped — nothing of ours closed it) and **not** the all-disabled
children (enabling the submenu's rows didn't help). Flattening — removing every
submenu — fixed it; the result was decisive. muda 0.19.2 / tray-icon 0.23.1 carry no
released fix, so flattening is the workaround. (Separately, muda #328 / PR #361 is a
latent use-after-free when `setMenu` runs while the menu is open; re-applying the menu
only when it changed avoids re-pushing an unchanged menu and mitigates that.)

Status: accepted. Revises ADR-0009's consequence that "a Skill's commits are a
submenu" and its Current-collapse-as-submenu. Builds on ADR-0010 (menu policy as
data — the flatness is asserted in the Deno tests) and stands with ADR-0013. A future
action layer (issue #25) reintroduces per-Skill rows as *clickable items*, not
submenus, so the dropped name list returns without nesting.

## Considered options

- **Keep submenus, suppress the first-hover glitch** (pre-warm the tracking session,
  toggle the children `enabled`). Rejected: enabling the children was tested and
  didn't help, and there's no API hook for AppKit's first-tracking-session tear-down.
- **Wait for / patch muda + tray-icon.** Rejected for now: the latest releases have no
  fix, and patching the native menu lib is out of scope; flattening is a pure-data
  workaround entirely inside our layer (ADR-0010).
- **Keep the `submenu` variant dormant** (flat output, but the type still permits
  nesting). Rejected: dead code that re-admits the bug. Removing the variant makes the
  illegal state unrepresentable and deletes `toNativeSubmenu` with it.

## Consequences

- `MenuRow` loses its `submenu` variant; `platform.ts` loses `toNativeSubmenu` and the
  `Submenu` import. The edge can no longer render a submenu by construction.
- A Behind Skill's commits are inline indented rows; the Current summary is a bare
  count — the Skill-name drill-down is dropped until #25's action layer lands.
- Menu flatness is pinned as data in `menu_test.ts` (ADR-0010): the inline commit rows
  and the single count row are asserted, and no test can construct a submenu.
- Deeper hierarchies are off the table for the macOS tray menu; any future grouping
  must be inline (indent / separators) or move to the webview popover ADR-0009
  deferred.
