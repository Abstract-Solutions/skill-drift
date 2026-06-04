// The tray menu as data: platform.ts walks a MenuModel into native
// @tauri-apps/api/menu items, keeping menu policy off the native edge (ADR-0009).

import type { WatchedRepo } from "./manifest.ts";

export type MenuModel = { readonly rows: readonly MenuRow[] };

export type MenuRow =
  | { kind: "header"; label: string }
  | { kind: "separator" }
  | { kind: "quit"; label: string };

// One menu per Poll Outcome (ADR-0010). Until per-Skill freshness rows land
// (#5/#6) every outcome is the same frame — a disabled title, a separator, Quit —
// so these builders differ only in the headline; a single buildMenuModel(outcome,
// { now }) consolidates them once the rows carry real statuses.
function framedMenu(header: string): MenuModel {
  return {
    rows: [
      { kind: "header", label: header },
      { kind: "separator" },
      { kind: "quit", label: "Quit skill-drift" },
    ],
  };
}

/** Installed outcome: headline the watched-Skill count (CONTEXT.md). */
export function installedMenu(repos: readonly WatchedRepo[]): MenuModel {
  const n = repos.reduce((sum, repo) => sum + repo.skills.length, 0);
  return framedMenu(`skill-drift — watching ${n} skill${n === 1 ? "" : "s"}`);
}

/** Nothing-installed outcome: Manifest absent, empty, or no GitHub Skills. */
export function nothingInstalledMenu(): MenuModel {
  return framedMenu("skill-drift — no skills installed");
}

/** Malformed outcome: Manifest present but unparseable or wrong-shaped. */
export function malformedMenu(): MenuModel {
  return framedMenu("skill-drift — manifest unreadable");
}
