// The Poll Cycle as a deep module (ADR-0010): one pass that reads the Manifest,
// derives the Watched Repos, polls, classifies every Skill, writes the snapshot,
// builds the menu, and returns one PollOutcome the view renders. This slice (#4)
// lands Phase C — the Manifest read and its app-level outcomes; the GitHub poll,
// per-Skill classification, snapshot write, and the no-token arm follow (#5/#6).

import {
  deriveWatchedRepos,
  parseManifest,
  type WatchedRepo,
} from "./manifest.ts";
import {
  installedMenu,
  malformedMenu,
  type MenuModel,
  nothingInstalledMenu,
} from "./menu.ts";

// Per-poll outcome (ADR-0010), each carrying a built MenuModel. `ok` also carries
// the derived Watched Repos and the Behind count; the per-Skill statuses join it
// with classification (#6). `no-token` arrives with the poll (#5).
export type PollOutcome =
  | { kind: "ok"; behind: number; repos: WatchedRepo[]; menu: MenuModel }
  | { kind: "no-manifest"; menu: MenuModel }
  | { kind: "malformed"; menu: MenuModel };

// The cycle's native ports (ADR-0010): edges the engine names and platform.ts
// satisfies with the Rust commands, while tests inject fakes. readManifest yields
// the raw Manifest contents, or null when it is absent (ADR-0007).
export interface CycleDeps {
  readManifest(): Promise<string | null>;
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
  // Behind stays 0 until the GitHub poll lands (#5/#6); this slice proves the
  // Manifest read end to end and hands the derived Watched Repos to the view.
  return { kind: "ok", behind: 0, repos, menu: installedMenu(repos) };
}
