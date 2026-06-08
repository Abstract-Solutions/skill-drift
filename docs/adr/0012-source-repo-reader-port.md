# The three Source Repo fetchers collapse into one `SourceRepoReader` port

The three GitHub reads a Skill's classification needs — latest commit, folder tree
at a ref, path-filtered commits — become one named port, `SourceRepoReader`, with
two adapters: `makeHttpReader` (the live GitHub client, `github.ts`) in prod and
`makeMemoryReader` (a git-shaped in-memory Source Repo, `poll.ts`) in tests.
`AssembleDeps` carries `{ reader, cache }`; the cycle injects
`{ reader: makeReader(token), cache }`. This makes the reader seam real — two
adapters, not one — the shape the cache seam already has (`BaselineCache` +
`makeMemoryCache`, ADR-0004).

ADR-0010 shaped `AssembleDeps` as three flat fetchers plus the cache, built by
`makeFetchers(token)` and spread into the assemble call. The three never varied
independently — `makeFetchers` built all three, the cycle spread all three, and
`Fetchers` already named the group — so they were one port wearing three hats.
Worse, the seam shipped only the HTTP adapter: every engine test hand-rolled its own
fetcher trio and kept three fakes mutually consistent by hand, so `poll_test` and
`cycle_test` built the identical Source Repo history independently. The single port
fixes both — callers name one `reader`, and `makeMemoryReader` derives all three
reads from one described history (HEAD is the newest commit, a Skill's Watched
Commits are the commits that changed its folder, a folder tree at a ref is the
carry-forward state), so a test can't construct a HEAD/commits/tree triple that
disagrees.

The classification logic is untouched; this regroups the port the deep
poll-and-assemble module (ADR-0010) already depended on, and renames `makeFetchers`
→ `makeHttpReader` and `CycleDeps.makeFetchers` → `makeReader` for adapter symmetry.
`SourceRepoReader` stays out of CONTEXT.md — it is an architecture seam, grounded by
the existing **Source Repo** noun, not a new domain term.

Status: accepted. Revises ADR-0010's three-fetcher `AssembleDeps` / `makeFetchers`
shape (the `SourceRepoReader` port replaces the flat trio and the `Omit`-derived
`Fetchers`); ADR-0010 otherwise stands — the cycle is still a deep module returning a
`PollOutcome`, and the view still injects the HTTP adapter as `makeReader`. Mirrors
the cache seam's two-adapter shape (ADR-0004/0008).

## Considered options

- **Keep the three flat fetchers; add only an in-memory helper.** Rejected: leaves
  three ports to keep consistent at every call site and in every fake, so the
  duplicated-history smell persists — there is no single thing to inject.
- **Model HTTP faults in the `MemoryWorld` (a fault channel).** Rejected: leaks
  transport concerns into a git-history model. Collapsing to one port makes
  spread-and-override return a fault in one line, so the happy-path world stays
  purely history.
- **A multi-repo world per reader.** Rejected (deferred): no Poll Cycle test polls
  more than one Source Repo per world, and a single-repo reader that 404s other repos
  also validates call routing — which the old trio, ignoring owner/repo, never did.

## Consequences

- The reader seam is real: `makeHttpReader` (HTTP) and `makeMemoryReader`
  (in-memory), symmetric with `BaselineCache`'s pair — two adapters, one place to
  test each.
- `AssembleDeps` and `CycleDeps` shrink to one reader field; `makeMemoryReader` is
  itself a tested engine module (picked up by `deno task test`) and records its reads
  so the "no per-commit walk" / "no fetch for an up-to-date Skill" assertions survive.
- Engine tests describe one `MemoryWorld` instead of three aligned fakes; the
  cross-fetcher consistency burden — and the identical history `poll_test` and
  `cycle_test` each built — is gone.
