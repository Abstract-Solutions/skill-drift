// The Poll Cycle as a deep module (ADR-0010): one pass that reads the Manifest,
// derives the Watched Repos, polls GitHub for real, classifies every Skill, writes
// the snapshot, builds the menu, and returns one PollOutcome the view renders.
// #5 landed the live poll + snapshot; #6 renders the per-Skill freshness menu
// (buildMenuModel) and folds a token-read failure into the no-access outcome.

import {
  assembleSkillStatuses,
  type BaselineCache,
  type Fetchers,
  type SkillStatus,
} from "./poll.ts";
import { deriveWatchedRepos, parseManifest } from "./manifest.ts";
import { buildMenuModel, type MenuModel } from "./menu.ts";

// The classified result of one cycle — the data a Poll Outcome carries before its
// menu is built (ADR-0010). `ok` carries the Behind count (the badge), the per-Skill
// statuses (the menu rows), and the poll time (the menu's updated-header). The token
// edge owns three outcomes: no-token (absent), no-access (unreadable), then a poll.
export type PollResult =
  | { kind: "ok"; behind: number; statuses: SkillStatus[]; polledAt: string }
  | { kind: "no-manifest" }
  | { kind: "no-token" }
  | { kind: "no-access" }
  | { kind: "malformed" };

// What runPollCycle returns: each result with its rendered menu attached — the
// discriminated union the view renders (renderMenu(out.menu) + setBadge).
export type PollOutcome = PollResult & { menu: MenuModel };

// The last-poll snapshot the cycle persists (ADR-0008): polledAt plus the whole
// SkillStatus[] (each Behind Skill's commits included) so a later popover paints
// instantly. The cycle owns the write; the store-backed sink is deferred.
export interface Snapshot {
  polledAt: string;
  statuses: SkillStatus[];
}

// The cycle's native ports (ADR-0010): edges the engine names and platform.ts
// satisfies with the Rust commands + app-private state, while tests inject fakes.
// getToken yields the Keychain PAT or null (ADR-0006); makeFetchers builds the
// GitHub fetchers from that token; now stamps the snapshot.
export interface CycleDeps {
  readManifest(): Promise<string | null>;
  getToken(): Promise<string | null>;
  makeFetchers(token: string): Fetchers;
  cache: BaselineCache;
  saveSnapshot(snapshot: Snapshot): Promise<void>;
  now(): Date;
}

export async function runPollCycle(deps: CycleDeps): Promise<PollOutcome> {
  // One clock per cycle: it stamps the snapshot and the menu's updated-header, and
  // every outcome renders its menu from the same instant.
  const now = deps.now();
  const outcome = (result: PollResult): PollOutcome => ({
    ...result,
    menu: buildMenuModel(result, { now }),
  });

  const raw = await deps.readManifest();
  // Absent or empty file → Nothing installed (CONTEXT.md), never malformed.
  if (raw === null || raw.trim() === "") {
    return outcome({ kind: "no-manifest" });
  }

  const manifest = parseManifest(raw);
  if (manifest === null) return outcome({ kind: "malformed" });

  const repos = deriveWatchedRepos(manifest);
  // Parsed but no GitHub Skills → still Nothing installed (CONTEXT.md).
  if (repos.length === 0) return outcome({ kind: "no-manifest" });

  // The token is the one edge whose every result the cycle owns (ADR-0010): a
  // rejection → no-access (Keychain locked / access denied — user-actionable, a
  // deliberate exception to "edge fault keeps the last menu"), null → no-token
  // (prompt to add one), a value → poll. Empty string is no token too — a blank
  // Keychain item shouldn't poll unauthenticated. (ADR-0010 revises ADR-0006's
  // unauth degrade to a non-polling prompt; that degrade stays deferred.)
  let token: string | null;
  try {
    token = await deps.getToken();
  } catch {
    return outcome({ kind: "no-access" });
  }
  if (!token) return outcome({ kind: "no-token" });

  const statuses = await assembleSkillStatuses(repos, {
    ...deps.makeFetchers(token),
    cache: deps.cache,
  });
  // Badge = how many Skills are Behind (CONTEXT.md), one per Skill needing
  // attention — not the sum of each Skill's Behind-by distance.
  const behind = statuses.filter((s) => s.state.kind === "behind").length;

  // The cycle owns the snapshot write (ADR-0010), symmetric with the BaselineCache
  // write assembleSkillStatuses already makes — persistence in one place. The same
  // poll time stamps the snapshot and the menu's updated-header.
  const polledAt = now.toISOString();
  await deps.saveSnapshot({ polledAt, statuses });

  return outcome({ kind: "ok", behind, statuses, polledAt });
}
