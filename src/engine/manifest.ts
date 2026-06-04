// The Manifest's shape and how the engine reads it into its input.
// deriveWatchedRepos groups the github-installed Skills by Source Repo;
// parseSource splits "owner/repo". Pure — the actual file read is an injected
// edge (the app's fs adapter).

// One entry in the Manifest (~/.agents/.skill-lock.json), keyed by Skill name.
export interface SkillEntry {
  source: string;
  sourceType: string;
  skillPath: string;
  skillFolderHash: string;
}

export interface Manifest {
  version: number;
  skills: Record<string, SkillEntry>;
}

// One github Source Repo and the installed Skills watched against it — the
// poll's input. skillFolderHash is the Skill folder's git tree hash, the Behind
// diff baseline.
export interface WatchedRepo {
  /** "owner/repo" */
  source: string;
  /** Default branch polled for Watched Commits. */
  branch: string;
  skills: { name: string; skillPath: string; skillFolderHash: string }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses the Manifest's raw JSON behind a minimal shape guard (ADR-0010): the
// value parses and its `skills` is an object → a Manifest, else null. The cycle
// maps null to its malformed outcome (CONTEXT.md). Per-entry validation is
// deliberately skipped — deriveWatchedRepos already drops anything it can't use.
export function parseManifest(raw: string): Manifest | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isRecord(value.skills)) return null;
  // The guard checks shape, not every field; the minimal contract (ADR-0010).
  return value as unknown as Manifest;
}

/** Split an "owner/repo" source into its parts. */
export function parseSource(source: string): { owner: string; repo: string } {
  const [owner, repo] = source.split("/");
  return { owner, repo };
}

// Groups the Manifest's github Skills by Source Repo, sorted by source. The
// Manifest records no branch, so the default-branch poll is "main".
export function deriveWatchedRepos(manifest: Manifest): WatchedRepo[] {
  const bySource = new Map<string, WatchedRepo>();
  for (const [name, entry] of Object.entries(manifest.skills)) {
    if (entry.sourceType !== "github") continue;
    let repo = bySource.get(entry.source);
    if (!repo) {
      repo = { source: entry.source, branch: "main", skills: [] };
      bySource.set(entry.source, repo);
    }
    repo.skills.push({
      name,
      skillPath: entry.skillPath,
      skillFolderHash: entry.skillFolderHash,
    });
  }
  return [...bySource.values()].sort((a, b) =>
    a.source < b.source ? -1 : a.source > b.source ? 1 : 0
  );
}
