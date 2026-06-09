// The tray menu as data: platform.ts walks a MenuModel into native
// @tauri-apps/api/menu items, keeping menu policy off the native edge (ADR-0009).
// buildMenuModel is the pure transform from a PollOutcome to that data (ADR-0010,
// ADR-0011 — the view composes it; the cycle no longer attaches a menu):
// the actionable-first ordering, the state glyphs, the Behind-count label, the
// inline Watched Commit rows, the Current summary, and the non-ok frames are all
// decided here and asserted as data, never at the edge.

import type { Commit } from "./github.ts";
import type { SkillState, SkillStatus } from "./poll.ts";
import type { PollOutcome } from "./cycle.ts";

export type MenuModel = { readonly rows: readonly MenuRow[] };

// No `submenu` variant by design: macOS tears an NSStatusItem menu down on the first
// hover of a submenu row (ADR-0016), so the model is deliberately flat. Drill-downs
// render as inline indented rows (a Behind Skill's commits) instead of nesting.
export type MenuRow =
  | { kind: "header"; label: string }
  | { kind: "separator" }
  | { kind: "item"; label: string; enabled: boolean }
  | { kind: "quit"; label: string };

// Leading glyph per Freshness state. Saturated dots read on both light and dark menu
// bars and map the freshness gradient most→least actionable (Behind, Diverged,
// Current); the two non-gradient states get a distinct shape — Removed is gone, Error
// a transient fault. Pure presentation, kept here as data so tests pin label structure
// via this map, not raw codepoints (ADR-0010: menu policy as data).
export const STATE_GLYPH: Record<SkillState["kind"], string> = {
  behind: "🔴",
  diverged: "🟠",
  removed: "❌",
  error: "⚠️",
  current: "🟢",
};

// Headline per non-ok Poll Outcome (CONTEXT.md). no-access is distinct from
// no-token: the token couldn't be read (Keychain locked / access denied), not just
// absent — a user-actionable fault, never a silent freeze at the last menu (#6).
const FRAME_HEADER: Record<Exclude<PollOutcome["kind"], "ok">, string> = {
  "no-manifest": "skill-drift — no skills installed",
  "no-token": "skill-drift — add a GitHub token",
  "malformed": "skill-drift — manifest unreadable",
  "no-access": "skill-drift — can't read GitHub token",
};

// The middle Freshness states, in actionable order. Behind leads (its commits inline
// beneath it) and Current trails as a one-line summary, so only these three list as
// single leaf rows.
const LEAF_ORDER = ["diverged", "removed", "error"] as const;

// One menu per Poll Outcome (ADR-0010): an ok poll renders the per-Skill freshness
// rows; every other outcome is a framed headline. now stamps the ok updated-header
// and the Watched Commit ages.
export function buildMenuModel(
  outcome: PollOutcome,
  { now }: { now: Date },
): MenuModel {
  if (outcome.kind !== "ok") return framedMenu(FRAME_HEADER[outcome.kind]);

  const byKind = groupByKind(outcome.statuses);
  const updated = `skill-drift — updated ${
    relativeTime(outcome.polledAt, now)
  }`;
  const rows: MenuRow[] = [
    { kind: "header", label: updated },
    { kind: "separator" },
  ];
  for (const s of byKind.behind ?? []) rows.push(...behindRows(s, now));
  for (const kind of LEAF_ORDER) {
    for (const s of byKind[kind] ?? []) rows.push(leafRow(s));
  }
  const current = byKind.current ?? [];
  if (current.length > 0) rows.push(currentSummaryRow(current));
  rows.push({ kind: "separator" }, { kind: "quit", label: "Quit skill-drift" });
  return { rows };
}

// Boot frame rendered before the first cycle so the menu-bar-only app is always
// quittable — even if that cycle's edge faults before it can render (ADR-0010).
export function bootMenu(): MenuModel {
  return framedMenu("skill-drift — starting…");
}

// A disabled title, a separator, Quit — the shared shape behind every non-ok
// outcome and the boot frame, differing only in the headline.
function framedMenu(header: string): MenuModel {
  return {
    rows: [
      { kind: "header", label: header },
      { kind: "separator" },
      { kind: "quit", label: "Quit skill-drift" },
    ],
  };
}

// Indent for a Behind Skill's inline commit rows — the nesting a submenu would have
// shown, now that the menu must stay flat (ADR-0016). Leading spaces, not a dash or
// dot: a glyph would read as one more state marker in a menu already led by them.
const COMMIT_INDENT = "    ";

// A Behind Skill: the count folded into the label (issue #6's `git-helper · 3
// behind`), then its Watched Commits as inline rows indented beneath it. behindBy ≥ 1,
// so commits is never empty — there is always at least one commit row. Inline rather
// than a submenu because macOS dismisses an NSStatusItem submenu on first hover
// (ADR-0016); COMMIT_INDENT stands in for the drill-down's nesting.
function behindRows(s: SkillStatus, now: Date): MenuRow[] {
  const st = s.state;
  // Only Behind reaches here; the guard keeps the commit fields in scope for tsc.
  if (st.kind !== "behind") return [leafRow(s)];
  return [
    {
      kind: "item",
      enabled: false,
      label: `${STATE_GLYPH.behind} ${s.name} · ${st.behindBy} behind`,
    },
    ...st.commits.map((c): MenuRow => ({
      kind: "item",
      enabled: false,
      label: `${COMMIT_INDENT}${commitSummary(c)} · ${
        relativeTime(c.date, now)
      }`,
    })),
  ];
}

// Diverged / Removed / Error have no drill-down yet — one disabled line each, the
// state kind spelled after the name (the glyph already leads).
function leafRow(s: SkillStatus): MenuRow {
  return {
    kind: "item",
    enabled: false,
    label: `${STATE_GLYPH[s.state.kind]} ${s.name} · ${s.state.kind}`,
  };
}

// Current Skills are the boring majority; collapse them to one summary line so the
// menu stays short (issue #6) — just the count. Listing each name would be the natural
// drill-down, but a submenu dismisses on first hover on macOS (ADR-0016) and inlining
// every name re-clutters the bar; the names return as clickable rows with the action
// layer (#25).
function currentSummaryRow(current: readonly SkillStatus[]): MenuRow {
  return {
    kind: "item",
    enabled: false,
    label: `${STATE_GLYPH.current} ${current.length} up to date`,
  };
}

// git's conventional abbreviated SHA length — the fallback label for the rare
// commit with an empty message, so a Watched Commit row is never blank.
const SHORT_SHA_LEN = 7;

function commitSummary(c: Commit): string {
  const firstLine = c.message.split("\n")[0].trim();
  return firstLine || c.sha.slice(0, SHORT_SHA_LEN);
}

// Partition by Freshness state, preserving each Skill's incoming order within its
// group (statuses arrive grouped by Source Repo — manifest.ts).
function groupByKind(
  statuses: readonly SkillStatus[],
): Partial<Record<SkillState["kind"], SkillStatus[]>> {
  const by: Partial<Record<SkillState["kind"], SkillStatus[]>> = {};
  for (const s of statuses) (by[s.state.kind] ??= []).push(s);
  return by;
}

// Relative-age formatter for the updated-header and the Watched Commit rows. Moved
// here from github.ts with #6 (its only callers are menu rows). Sub-minute ages
// round to "just now": second-granularity is noise in a menu that only rebuilds on
// the multi-minute poll cadence, and it makes a freshly-built header read naturally.
const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_MONTH = 30; // coarse; the menu wants an approximate age, not a calendar
const DAYS_PER_YEAR = 365;

export function relativeTime(iso: string, now: Date = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const sec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (sec < SEC_PER_MIN) return "just now";
  const min = Math.floor(sec / SEC_PER_MIN);
  if (min < MIN_PER_HOUR) return `${min}m ago`;
  const hr = Math.floor(min / MIN_PER_HOUR);
  if (hr < HOURS_PER_DAY) return `${hr}h ago`;
  const day = Math.floor(hr / HOURS_PER_DAY);
  if (day < DAYS_PER_MONTH) return `${day}d ago`;
  const mo = Math.floor(day / DAYS_PER_MONTH);
  // Gate on days, not months: 365 ≠ 12×30, so month 12 (days 360–364) must still
  // read "12mo ago" instead of falling through to a floored "0y ago".
  if (day < DAYS_PER_YEAR) return `${mo}mo ago`;
  return `${Math.floor(day / DAYS_PER_YEAR)}y ago`;
}
