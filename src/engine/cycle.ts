// The Poll Cycle as a deep module (ADR-0010): one pass that reads the Manifest,
// derives the Watched Repos, polls, classifies every Skill, writes the snapshot,
// builds the menu, and returns one PollOutcome the view renders. This slice (#3)
// ships the seam only — a stub returning a trivial `ok` so the scheduler→badge
// wire can be exercised end to end. The real body and the
// no-manifest / no-token / malformed arms land in later slices (#4–#6).

// Per-poll outcome (ADR-0010). Only the `ok` arm exists yet; the other arms and
// `ok`'s menu/statuses fields arrive with the real cycle.
export type PollOutcome = { kind: "ok"; behind: number };

export function runPollCycle(): Promise<PollOutcome> {
  return Promise.resolve({ kind: "ok", behind: 0 });
}
