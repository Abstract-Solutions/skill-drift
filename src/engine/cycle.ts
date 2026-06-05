// The Poll Cycle as a deep module (ADR-0010): one pass that reads the Manifest,
// derives the Watched Repos, polls GitHub for real, classifies every Skill, writes
// the snapshot, builds the menu, and returns one PollOutcome the view renders.
// This slice (#5) lands Phase D — the Keychain token, the live poll, the Behind
// count, and the snapshot write; the per-Skill menu rows follow (#6).

import {
  assembleSkillStatuses,
  type BaselineCache,
  type Fetchers,
  type SkillStatus,
} from "./poll.ts";
import { deriveWatchedRepos, parseManifest } from "./manifest.ts";
import {
  installedMenu,
  malformedMenu,
  type MenuModel,
  nothingInstalledMenu,
  noTokenMenu,
} from "./menu.ts";

// Per-poll outcome (ADR-0010), each carrying a built MenuModel. `ok` also carries
// the Behind count (the badge) and the per-Skill statuses (#6 renders them as menu
// rows; this slice logs them). `no-token` short-circuits before the poll.
export type PollOutcome =
  | { kind: "ok"; behind: number; statuses: SkillStatus[]; menu: MenuModel }
  | { kind: "no-manifest"; menu: MenuModel }
  | { kind: "no-token"; menu: MenuModel }
  | { kind: "malformed"; menu: MenuModel };

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
  if (raw === null || raw.trim() === "") {
    return { kind: "no-manifest", menu: nothingInstalledMenu() };
  }
  const manifest = parseManifest(raw);
  if (manifest === null) {
    return { kind: "malformed", menu: malformedMenu() };
  }
  const repos = deriveWatchedRepos(manifest);
  // Parsed but no GitHub Skills → still Nothing installed (CONTEXT.md).
  if (repos.length === 0) {
    return { kind: "no-manifest", menu: nothingInstalledMenu() };
  }

  // No token → short-circuit to "add a token" with no poll (ADR-0010 revises
  // ADR-0006's unauth degrade to a non-polling prompt; the degrade is deferred).
  // Empty string is no token too — a blank Keychain item shouldn't poll unauth.
  const token = await deps.getToken();
  if (!token) {
    return { kind: "no-token", menu: noTokenMenu() };
  }

  const statuses = await assembleSkillStatuses(repos, {
    ...deps.makeFetchers(token),
    cache: deps.cache,
  });
  // Badge = how many Skills are Behind (CONTEXT.md), one per Skill needing
  // attention — not the sum of each Skill's Behind-by distance.
  const behind = statuses.filter((s) => s.state.kind === "behind").length;

  // The cycle owns the snapshot write (ADR-0010), symmetric with the BaselineCache
  // write assembleSkillStatuses already makes — persistence in one place.
  await deps.saveSnapshot({ polledAt: deps.now().toISOString(), statuses });

  // Menu stays the watched-count frame this slice (installedMenu); #6 swaps in the
  // per-Skill freshness rows built from these statuses.
  return { kind: "ok", behind, statuses, menu: installedMenu(repos) };
}
