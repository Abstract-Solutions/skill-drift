# Context

Glossary for skill-drift — a local macOS menu-bar app that watches the Claude
Code Skills you've installed and flags when they've fallen **Behind** their
upstream GitHub repos. Domain terms only; no implementation detail.

## Language

### Core nouns

**Skill**:
An installed unit of agent-skill capability — one folder, recorded in the
Manifest by name. Many Skills can share one Source Repo.
_Avoid_: plugin, extension, package.

**Source Repo**:
The GitHub repo a Skill was installed from (e.g. `mattpocock/skills`,
`vercel-labs/agent-skills`). One Source Repo is the origin of many Skills.
_Avoid_: upstream, origin (collides with git's `origin`).

**Manifest**:
`~/.agents/.skill-lock.json` — the local install record. Maps each installed
Skill's name to its Source Repo, `skillPath` (the Skill's folder inside the
repo), and Skill Folder Hash. The app re-reads it on every poll; it is the only
source of "what's installed".
_Avoid_: lockfile, subscription list, database.

**Skill Folder Hash**:
The git **tree** hash of a Skill's folder at install time (the Manifest's
`skillFolderHash`) — a content fingerprint, _not_ a commit SHA. The baseline a
Skill's Behind count is measured from.
_Avoid_: install SHA, commit hash, version.

**Watched Repo**:
One Source Repo plus the installed Skills tracked against it — the unit the poll
iterates. Rebuilt fresh from the Manifest each cycle, carrying the polled branch
(default `main`). It is a derived input, not a saved record.
_Avoid_: Subscription, Installed Repo (both were server-side records in v1; there
is no server now), watchlist.

**Watched Commit**:
A commit on a Source Repo's default branch that touches at least one watched
Skill's folder. Commits touching only unrelated files in the same repo don't
count.
_Avoid_: repo commit, upstream commit.

**Poll Cycle**:
One pass of the background loop: a `poll-tick` triggers a Manifest read, a
rebuild of the Watched Repos, the GitHub poll, per-Skill classification, and a
tray re-render. Holds nothing between cycles but the app-private cache and
snapshot; resolves to exactly one **Poll Outcome**.
_Avoid_: scan, refresh, sync.

### Freshness states

The poll classifies each Skill against its Source Repo's branch HEAD into exactly
one state.

**Behind**:
A Skill whose installed folder lags the latest Watched Commit for its Source
Repo. Measured in Watched Commits (commits touching the Skill's folder), never in
raw repo commits. The headline state — the tray badges when any Skill is Behind.
_Avoid_: stale, outdated, out-of-date.

**Current**:
The Skill's Skill Folder Hash equals the folder's tree hash at branch HEAD —
nothing to do.

**Removed**:
The Skill's folder is gone at HEAD (renamed or deleted upstream).

**Diverged**:
The Skill's installed hash appears nowhere in the branch's folder history —
typically local edits, or installed from somewhere other than this branch.

**Error**:
The Source Repo or folder couldn't be polled (rate limit, network, 5xx). A
transient unknown, distinct from the definitive Removed/Diverged.

### Poll outcome (app-level)

What a whole **Poll Cycle** resolves to — distinct from the **Freshness states**,
which classify individual Skills *within* a successful poll. A total GitHub
outage is not an outcome here: it surfaces as every Skill carrying the per-Skill
**Error** state inside an otherwise-**Installed** poll.

**Installed**:
The Manifest yielded watched Skills and the poll produced their statuses; the
tray shows the Skill list (each Skill carrying one Freshness state).

**Nothing installed**:
No watched Skills — the Manifest is absent, empty, or names no github Skills. A
clean empty state, never an error.

**No token**:
No GitHub token is available, so the cycle prompts to add one instead of polling.
(A later degrade may poll unauthenticated instead — ADR-0006.)
_Avoid_: unauthenticated, logged-out.

**Malformed**:
The Manifest is present but unparseable or wrong-shaped — surfaced as its own
state, not a crash.

## Retired terms (skill-pulse v1 → skill-drift)

v1 split into a local **Scanner** and a cloud **Dashboard** that exchanged
**Subscription** / **Installed Repo** records over a wire contract. The local
rewrite collapses all of that into "the app reads the Manifest and polls". If you
meet these terms in old commits or the v1 archive, the mapping is:

- **Scanner** + **Dashboard** → the single local app.
- **Installed Repo** / **Subscription** → Watched Repo (now a per-poll derived
  input, not a persisted record).

## Example dialogue

A new contributor (D) and someone who knows the domain (E):

> **D:** The popover says `git-helper` is Behind by 3. Three what?
>
> **E:** Three Watched Commits — commits that actually touched the `git-helper`
> folder in its Source Repo. Not three commits to the whole repo; edits to
> unrelated Skills there don't move the count.
>
> **D:** How do we know where to start counting?
>
> **E:** The Manifest stored the Skill Folder Hash — the tree hash of the folder
> when you installed it. We find the commit that produced that hash and count the
> Watched Commits since.
>
> **D:** What if the folder isn't there anymore upstream?
>
> **E:** Then it's Removed, not Behind. And if the hash turns up nowhere in the
> branch's history — say you hand-edited the Skill — it's Diverged.
>
> **D:** And a Watched Repo is…?
>
> **E:** Just how we group the poll: one Source Repo and every Skill you have
> from it. We rebuild that list from the Manifest each poll — there's no saved
> subscription anymore, the way v1 did it.
