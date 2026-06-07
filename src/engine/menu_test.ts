import { assertEquals } from "@std/assert";
import {
  bootMenu,
  buildMenuModel,
  type MenuModel,
  type MenuRow,
  relativeTime,
  STATE_GLYPH,
} from "./menu.ts";
import type { PollOutcome } from "./cycle.ts";
import type { SkillStatus } from "./poll.ts";
import type { Commit } from "./github.ts";

const NOW = new Date("2026-06-05T12:00:00.000Z");

const status = (name: string, state: SkillStatus["state"]): SkillStatus => ({
  name,
  source: "owner/repo",
  branch: "main",
  state,
});

const commit = (
  sha: string,
  message = "",
  date = NOW.toISOString(),
): Commit => ({
  sha,
  message,
  author: "Ada",
  date,
});

const ok = (
  statuses: SkillStatus[],
  polledAt = NOW.toISOString(),
): PollOutcome => ({
  kind: "ok",
  behind: statuses.filter((s) => s.state.kind === "behind").length,
  statuses,
  polledAt,
});

const header = (model: MenuModel): string => {
  const row = model.rows.find((r) => r.kind === "header");
  if (row?.kind !== "header") throw new Error("menu has no header row");
  return row.label;
};

const endsInQuit = (model: MenuModel): boolean =>
  model.rows.at(-1)?.kind === "quit";

// The skill/summary rows between the header+separator and the trailing separator.
const contentLabels = (model: MenuModel): string[] =>
  model.rows.flatMap((r) =>
    r.kind === "item" || r.kind === "submenu" ? [r.label] : []
  );

const subRows = (row: MenuRow): readonly MenuRow[] => {
  if (row.kind !== "submenu") throw new Error("expected a submenu row");
  return row.rows;
};

Deno.test("buildMenuModel orders Skills actionable-first", () => {
  const statuses = [
    status("cur1", { kind: "current" }),
    status("rem1", { kind: "removed" }),
    status("beh1", {
      kind: "behind",
      behindBy: 2,
      baseline: "c1",
      commits: [commit("c2"), commit("c3")],
    }),
    status("div1", { kind: "diverged" }),
    status("err1", { kind: "error", error: "boom" }),
  ];
  assertEquals(contentLabels(buildMenuModel(ok(statuses), { now: NOW })), [
    `${STATE_GLYPH.behind} beh1 · 2 behind`,
    `${STATE_GLYPH.diverged} div1 · diverged`,
    `${STATE_GLYPH.removed} rem1 · removed`,
    `${STATE_GLYPH.error} err1 · error`,
    `${STATE_GLYPH.current} 1 up to date`,
  ]);
});

Deno.test("buildMenuModel: a Behind Skill folds in the count and lists its commits", () => {
  const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
  const commits = [
    commit("a1b2c3d4e5", "fix the bug", twoHoursAgo),
    commit("f6e5d4c3b2", "add the feature", twoHoursAgo),
  ];
  const model = buildMenuModel(
    ok([status("git-helper", {
      kind: "behind",
      behindBy: 2,
      baseline: "base",
      commits,
    })]),
    { now: NOW },
  );
  const behind = model.rows.find((r) => r.kind === "submenu");
  if (behind?.kind !== "submenu") throw new Error("expected a behind submenu");
  assertEquals(behind.label, `${STATE_GLYPH.behind} git-helper · 2 behind`);
  assertEquals(subRows(behind).map((r) => r.kind === "item" ? r.label : ""), [
    "fix the bug · 2h ago",
    "add the feature · 2h ago",
  ]);
});

Deno.test("buildMenuModel: a commit with no message falls back to its short SHA", () => {
  const model = buildMenuModel(
    ok([status("s", {
      kind: "behind",
      behindBy: 1,
      baseline: "base",
      commits: [commit("0123456789abcdef")],
    })]),
    { now: NOW },
  );
  const behind = model.rows.find((r) => r.kind === "submenu");
  if (behind?.kind !== "submenu") throw new Error("expected a behind submenu");
  const first = subRows(behind)[0];
  assertEquals(first.kind === "item" && first.label, "0123456 · just now");
});

Deno.test("buildMenuModel collapses Current Skills into one summary submenu", () => {
  const statuses = ["a", "b", "c"].map((n) => status(n, { kind: "current" }));
  const model = buildMenuModel(ok(statuses), { now: NOW });
  const summaries = model.rows.filter((r) => r.kind === "submenu");
  assertEquals(summaries.length, 1);
  const summary = summaries[0];
  assertEquals(
    summary.kind === "submenu" && summary.label,
    `${STATE_GLYPH.current} 3 up to date`,
  );
  assertEquals(
    subRows(summary).map((r) => r.kind === "item" ? r.label : ""),
    ["a", "b", "c"],
  );
});

Deno.test("buildMenuModel omits the up-to-date summary when none are Current", () => {
  const model = buildMenuModel(ok([status("x", { kind: "removed" })]), {
    now: NOW,
  });
  assertEquals(model.rows.some((r) => r.kind === "submenu"), false);
  assertEquals(contentLabels(model), [`${STATE_GLYPH.removed} x · removed`]);
});

Deno.test("buildMenuModel headers the relative poll time", () => {
  const tenMinAgo = new Date(NOW.getTime() - 10 * 60_000).toISOString();
  assertEquals(
    header(buildMenuModel(ok([status("a", { kind: "current" })], tenMinAgo), {
      now: NOW,
    })),
    "skill-drift — updated 10m ago",
  );
});

Deno.test("buildMenuModel header reads 'just now' right after a poll", () => {
  assertEquals(
    header(
      buildMenuModel(ok([status("a", { kind: "current" })]), { now: NOW }),
    ),
    "skill-drift — updated just now",
  );
});

Deno.test("buildMenuModel frames each non-ok outcome with its headline", () => {
  const frame = (kind: Exclude<PollOutcome["kind"], "ok">) =>
    header(buildMenuModel({ kind }, { now: NOW }));
  assertEquals(frame("no-manifest"), "skill-drift — no skills installed");
  assertEquals(frame("no-token"), "skill-drift — add a GitHub token");
  assertEquals(frame("malformed"), "skill-drift — manifest unreadable");
  // no-access is distinct from no-token — a token-read failure, not an absent one.
  assertEquals(frame("no-access"), "skill-drift — can't read GitHub token");
});

Deno.test("every menu frame ends in Quit", () => {
  assertEquals(endsInQuit(bootMenu()), true);
  for (
    const kind of [
      "no-manifest",
      "no-token",
      "no-access",
      "malformed",
    ] as const
  ) {
    assertEquals(endsInQuit(buildMenuModel({ kind }, { now: NOW })), true);
  }
  assertEquals(
    endsInQuit(buildMenuModel(ok([status("a", { kind: "current" })]), {
      now: NOW,
    })),
    true,
  );
});

Deno.test("bootMenu headlines the starting state", () => {
  assertEquals(header(bootMenu()), "skill-drift — starting…");
});

Deno.test("each Freshness state has a distinct glyph", () => {
  assertEquals(new Set(Object.values(STATE_GLYPH)).size, 5);
});

Deno.test("relativeTime buckets ages and floors sub-minute to 'just now'", () => {
  const base = new Date("2026-06-05T12:00:00.000Z");
  const ago = (ms: number) =>
    relativeTime(new Date(base.getTime() - ms).toISOString(), base);
  assertEquals(ago(0), "just now");
  assertEquals(ago(30 * 1000), "just now");
  assertEquals(ago(90 * 1000), "1m ago");
  assertEquals(ago(2 * 60 * 60_000), "2h ago");
  assertEquals(ago(3 * 24 * 60 * 60_000), "3d ago");
  assertEquals(ago(45 * 24 * 60 * 60_000), "1mo ago");
  // Days 360–364: month 12 must read "12mo ago", never a floored "0y ago".
  assertEquals(ago(360 * 24 * 60 * 60_000), "12mo ago");
  assertEquals(ago(400 * 24 * 60 * 60_000), "1y ago");
});

Deno.test("relativeTime is empty for missing or unparseable input", () => {
  assertEquals(relativeTime("", NOW), "");
  assertEquals(relativeTime("not-a-date", NOW), "");
});
