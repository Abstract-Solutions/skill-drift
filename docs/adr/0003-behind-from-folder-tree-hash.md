# Behind is derived from the folder-tree hash, not a commit SHA

The Manifest's `skillFolderHash` is a git **tree** hash of a Skill's folder, not
the commit it was installed from — verified against the GitHub API:
`/git/trees/{hash}` resolves, `/commits/{hash}` 404s. So Behind can't be a
commit-to-commit compare: there is no installed commit to anchor on, and a
whole-repo compare would count commits that never touched the Skill.

Instead the engine compares folder contents. A Skill is Current when its
`skillFolderHash` equals the folder's tree hash at branch HEAD; Behind is the
count of Watched Commits (commits touching the Skill's folder) between the
installed folder state and HEAD, located by resolving `skillFolderHash` to the
baseline commit that produced it (ADR-0004). A folder absent at HEAD is Removed;
a hash found nowhere in the branch's history is Diverged. This makes the
path-filtered Watched Commit model in CONTEXT.md the implementation, not a
deferred goal.

Status: accepted. Carried from skill-pulse ADR-0004; the engine ports verbatim.

Rejected: counting all commits between an installed SHA and HEAD via the compare
API. It assumes `skillFolderHash` is a commit SHA; it isn't, so the compare
endpoint 404s on every Skill. Recorded so the compare approach isn't
re-attempted.
