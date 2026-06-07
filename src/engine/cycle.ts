// The Poll Cycle as a deep module (ADR-0010, ADR-0011): one pass that reads the
// Manifest, derives the Watched Repos, polls GitHub, classifies every Skill, writes
// the snapshot, and returns one PollOutcome — pure classification, no rendering. The
// view composes the menu from it (buildMenuModel) and the badge; the cycle never
// imports the menu. #5 landed the live poll; #6 the freshness states + no-access.

import {
  assembleSkillStatuses,
  type BaselineCache,
  type Fetchers,
  type SkillStatus,
} from "./poll.ts";
import { deriveWatchedRepos, parseManifest } from "./manifest.ts";

// One pass's Poll Outcome (CONTEXT.md) — pure classification, the discriminated
// union the view renders. `ok` carries the Behind count (the badge), the per-Skill
// statuses (the menu rows), and the poll time (the menu's updated-header). The token
// edge owns three outcomes: no-token (absent), no-access (unreadable), then a poll.
// The view builds the menu from this; the cycle attaches none (ADR-0011).
export type PollOutcome =
  | { kind: "ok"; behind: number; statuses: SkillStatus[]; polledAt: string }
  | { kind: "no-manifest" }
  | { kind: "no-token" }
  | { kind: "no-access" }
  | { kind: "malformed" };

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
  const raw = await deps.readManifest();
  // Absent or empty file → Nothing installed (CONTEXT.md), never malformed.
  if (raw === null || raw.trim() === "") return { kind: "no-manifest" };

  const manifest = parseManifest(raw);
  if (manifest === null) return { kind: "malformed" };

  const repos = deriveWatchedRepos(manifest);
  // Parsed but no GitHub Skills → still Nothing installed (CONTEXT.md).
  if (repos.length === 0) return { kind: "no-manifest" };

  // The token is the one edge whose every result the cycle owns (ADR-0010): a
  // rejection → no-access (Keychain locked / access denied — user-actionable), null →
  // no-token (prompt to add one), a value → poll. Empty string is no token too — a
  // blank Keychain item shouldn't poll unauthenticated. (ADR-0010 revises ADR-0006's
  // unauth degrade to a non-polling prompt; that degrade stays deferred.)
  let token: string | null;
  try {
    token = await deps.getToken();
  } catch {
    return { kind: "no-access" };
  }
  if (!token) return { kind: "no-token" };

  const statuses = await assembleSkillStatuses(repos, {
    ...deps.makeFetchers(token),
    cache: deps.cache,
  });
  // Badge = how many Skills are Behind (CONTEXT.md), one per Skill needing
  // attention — not the sum of each Skill's Behind-by distance.
  const behind = statuses.filter((s) => s.state.kind === "behind").length;

  // The cycle owns the snapshot write (ADR-0010), symmetric with the BaselineCache
  // write assembleSkillStatuses already makes — persistence in one place.
  const polledAt = deps.now().toISOString();
  await deps.saveSnapshot({ polledAt, statuses });

  return { kind: "ok", behind, statuses, polledAt };
}
