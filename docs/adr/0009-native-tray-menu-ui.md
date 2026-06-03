# The popover is a native tray menu, not a webview

The Skill list and actions render as a native macOS tray menu (`NSMenu`), rebuilt
from TS after each poll via the JS menu API (`@tauri-apps/api/menu`) and
`TrayIcon.setMenu()`. It is not a webview popover. This is the most-native
presentation (the OS draws it), the simplest — no window positioning, no
focus/blur-to-dismiss, no `positioner`/`nspanel` dependency — and it keeps logic
and view in TS (ADR-0002): the hidden webview builds the menu from the engine's
`SkillStatus[]`.

The webview is therefore always hidden (an engine-only worker); ADR-0005's
`backgroundThrottling: "disabled"` and the spike that gates it still apply — the
menu is only where the result renders.

Status: accepted.

## Considered options

- **Webview popover** (`tauri-plugin-positioner` + window, or `tauri-nspanel`)
  with native vibrancy. Rejected for v1: it buys unlimited UI richness (designed
  badges, columns, layouts) at the cost of implementing positioning +
  focus-loss-dismiss and taking a popover dependency (positioner's focus/blur
  jank, or nspanel's git-dep + AppKit review burden). The Skill list doesn't need
  that richness yet. The menu-building step is isolated, so adopting a popover
  later is a localized swap — the engine and seam are unchanged.

## Consequences

- A native menu can't show right-aligned free text, colored text, or an icon on a
  submenu row. So: the Behind count folds into the label (`git-helper · 3
  behind`), state is a leading emoji/glyph (which also sidesteps the icon-plus-
  submenu exclusion, tauri#11796), and a Skill's commits are a submenu.
- Rebuilding the whole menu on each poll (`setMenu`) is the supported pattern;
  there is no incremental-update API yet (tauri#9280) — fine while the menu is
  closed.
- Rendering a dynamic data list as a native tray menu is API-supported but not
  widely battle-tested in Tauri (proven in native AppKit apps) — a low risk to
  watch during the spike.
