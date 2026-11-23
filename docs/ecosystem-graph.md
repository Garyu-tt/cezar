# One ecosystem across repositories (bootstrap)

Cezar already runs separate repositories in one cockpit. This feature branch adds the **first,
non-destructive planning layer** for an entire GitHub account. It does **not** yet dispatch cross-repo
tasks or change the cockpit. See [companion specification PR #1](https://github.com/Garyu-tt/cezar/pull/1)
for the complete proposed implementation (the specification is not yet merged into `main`).

## What is managed

- `.ai/ecosystem.json` is the Git-tracked, reviewable **public** catalog of independent repositories,
  with a user-chosen focus project and directed, typed relationships.
- All registered GitHub repos share one logical ecosystem; no need to force them under a fake
  physical parent directory or into one Git history.
- `part-of` = a product/component logically belongs to another project. Exactly one parent per child;
  containment cycles are invalid.
- `built-on` = the source consumes the target platform/framework.
- `depends-on` = the source needs the target as a prerequisite.
- `provides-feature` = informational provider link (NOT a scheduling dependency).
- Relationship directions always read as `from -> to`, e.g.
  `mojum --part-of--> AdamantiumToolBox --built-on--> adamantium-node`.

A topological plan treats `part-of`, `built-on` and `depends-on` as conservative prerequisites.
A `provides-feature` link only adds discoverability. This is intentionally a **planning heuristic**:
it does not automatically launch agents, merge PRs or imply that all contained components need
rebuilding after every unrelated change. Dependencies can form cycles in metadata, but `waves`
refuses to produce an incorrect execution order until the blocking cycle is resolved.

## Commands

From the Cezar fork:

```sh
npm run ecosystem -- summary              # counts, focus, current scope
npm run ecosystem -- scope mojum          # repositories relevant to the focus
npm run ecosystem -- dependencies mojum   # transitive prerequisites
npm run ecosystem -- impact adamantium-node
npm run ecosystem -- waves                # independent repos in parallel-ready batches
npm run ecosystem -- link mojum GenesisPE depends-on
npm run ecosystem -- unlink mojum GenesisPE depends-on
npm run ecosystem -- focus mojum
npm run ecosystem -- validate
npm run ecosystem -- sync                 # requires an authenticated 'gh' CLI
npm run test:ecosystem
```

`sync` is an explicit, read-only discovery query to GitHub; it writes only **local catalog metadata**,
not any repository's code. It never clones, deletes or unregisters a repository, and never alters
curated relationships. It imports **public** repositories by default, ignoring private repositories
even if GitHub lists them. A repository absent from a partial GitHub result remains registered.

`sync --include-private` adds eligible private repositories to a separate **local-only** overlay:
`$CEZ_HOME/ecosystem-private.json` (or `~/.cezar/ecosystem-private.json`).
The overlay also stores relationships touching a private repository, plus private focus selection.
It never enters the tracked `.ai/ecosystem.json`. Keep `CEZ_HOME` outside the repository, and
do not commit, log or upload the local overlay; secure its directory like any other agent config.
Review the names in the resulting catalogs before publishing changes.

The public catalog in this fork contains an initial snapshot of its public repositories and only
two user-confirmed architectural relationships. Unlinked repositories are **not** assumed to be
unrelated: dependencies must be inspected and added intentionally. Three private repositories are
excluded from the tracked snapshot.

## Next implementation steps

1. Connect the optional catalog to Cezar's runtime project registry and project-scoped authorization.
2. Add hierarchy/focus editing to the *existing* switcher, project settings and aggregated Tasks.
3. Route logical feature tasks to an explicitly chosen execution repository with its own worktree/PR.
4. Resolve cross-repository blockers, assign dynamic agent capacity using existing host-wide
   concurrency and budget limits, and report aggregated progress.
5. Discover integration/dependency metadata incrementally from Git, build systems and plugin manifests;
   user-confirmed links must take precedence over speculative detection.

This bootstrap is deliberately separate from all repository clones, production Git execution,
automatic pushes and agent spending. Every future dispatch must remain reviewable and permissioned.
