# Native registered-project graph (R01)

This implements the first native Cezar workspace graph for **already registered/local**
projects. Unlike the account-wide public GitHub catalog in `docs/ecosystem-graph.md`,
these are actual project IDs that can own Cezar worktrees. The graph itself does not
move any checkout, launch agents, change permissions or merge pull requests.

The graph is an optional `projectGraph` section of the existing local
`~/.cezar/config.json` registry, so its metadata stays private to the Cezar host.
It has zero mandatory configuration and keeps current flat projects working unchanged.

## Commands

```sh
cezar projects list
cezar projects link mojum adamantiumtoolbox part-of
cezar projects link adamantiumtoolbox adamantium-node built-on
cezar projects focus mojum
cezar projects graph
cezar projects impact adamantium-node
cezar projects waves
cezar projects unlink mojum adamantiumtoolbox part-of
cezar projects focus           # revert to automatic first-registered focus
```

The actual project IDs are allocated from local checkout names, so first run
`cezar projects list` rather than assuming a GitHub repo name is the ID.

Relationships use the following directions:

- `child --part-of--> parent`, at most one parent per child (no containment cycles).
- `consumer --built-on--> platform`.
- `consumer --depends-on--> prerequisite`.
- `provider --provides-feature--> consumer`. The planner reverses this for prerequisites.

`graph` prints the selected focus, all registered links and the focus's
descendants/prerequisite scope. `impact` walks reverse dependencies.
`waves` prints independent registered-repo batches in topological order.
These are **planning batches**, not agent execution commands. Scheduling a
cross-repo task still requires explicit execution target, permissions, review,
CI checks and global resource limits.

Graph writes use the same serialized, atomic `~/.cezar/config.json` update
mechanism as `cezar projects add/remove`; link endpoints must be registered,
and duplicate links, self-links, second parents and containment cycles are refused.
Arbitrary dependency cycles may be recorded as metadata but `waves` fails
closed rather than producing an invalid execution order. Removing a registered
project detaches its graph edges and clears focus in the same config update,
without deleting any files in that repository. Missing references left by
external manual edits show up as **orphan** entries for repair.

`CEZ_SINGLE_PROJECT=1` disables *all* new graph commands, including inspection,
because listing graph edges would disclose other registered projects.

## Portfolio parallel-readiness preview (R03)

The read-only `GET /api/v1/workspace/project-graph/plan` API computes
*portfolio-wide* dependency-first execution waves from **registered checkout IDs**
and status probes. It does NOT start tasks, allocate model accounts, merge PRs,
mark tasks complete or bypass Cezar's existing concurrency/semaphore/approval gates.

The existing Settings → Projects → Links popover shows how many registered
repositories are in each parallel-ready wave, and specifically why a selected
project is blocked. One broken dependency chain does not prevent an unrelated
repository from being planned.

Safety properties:

- A missing or unprobed checkout is blocked rather than inferred available.
- A `not-git` root is blocked for Git-based cross-repository execution (though
  Cezar may still offer its legacy degraded non-Git queue separately).
- If a manually edited config leaves a link to an unregistered prerequisite,
  that consumer is blocked, and its dependents inherit the block.
- A dependency cycle blocks the cyclic component and its dependents; independent
  acyclic components remain in valid waves.
- A `provides-feature` edge is provider → consumer and must be reversed for
  prerequisite ordering. All other edge types use consumer → prerequisite.
- `CEZ_SINGLE_PROJECT=1` refuses this preview, including reads.
- The endpoint returns project IDs and dependency reasons, not local filesystem
  roots, private remote names, environment secrets or worktree identifiers.

`cezar projects waves` remains the strict older global planner which refuses
any cyclic dependency. The API preview is the safe, **partial** plan for
supervising a heterogeneous ecosystem; it must never be construed as a dispatch
authorization or as a guarantee that independent jobs will run concurrently
within host/provider limits.

## Public catalog versus native workspace

The GitHub-wide catalog can contain owned forks and repositories that are not
cloned on this machine. The native graph must NOT interpret catalog names as
local paths or silently register/clone them. Linking the public/private account
catalog to the native graph requires an explicit and verified mapping of
`owner/repo` to local `projectId` (e.g. via the safe parsed `repoUrl` field).
The read-only `POST /api/v1/workspace/project-graph/catalog-bindings` endpoint
verifies the catalog against registered checkouts using sanitized origin remotes.
It reports exact bindings, remote-only repositories and ambiguous local clones,
but never automatically clones a repo or persists a guessed link.

## Explicit task routing preview (R04)

`POST /api/v1/workspace/project-graph/routing-preview` accepts:

```json
{"logicalProjectId":"mojum","executionProjectId":"adamantium-node"}
```

It returns an **advisory** result: whether the requested registered execution
checkout is within the logical product's graph scope and has no current planner
blocker. The result gives the native project-scoped pool endpoint only when
eligible. If a healthy but unrelated repository is selected, routing is refused.
An unrelated project can still own its own tasks by using its own logical ID.

The API never executes a task or reserves a model slot. A future native pool
integration must re-check eligibility **at queue admission or launch time**,
because a preview alone is not an authorization and the graph or checkout may
change between preview and execution. The product workstream and physical
execution checkout remain separate identifiers in all cases.

The response returns no filesystem roots, tokens or other host-local secrets.
`CEZ_SINGLE_PROJECT=1` blocks these cross-project routes at the server.

A focus on Mojum must not prevent parallel work on unrelated registered
projects. The existing global semaphore, per-project limit and task/review
gates remain authoritative.

## Implementation status

- ✅ Workspace-local graph persistence, focus, links, CLI validation and impact.
- ✅ Same-origin typed graph API and Settings → Projects relational editor.
- ✅ Read-only verified mapping from remote GitHub names to registered checkouts.
- ✅ Read-only waves with explicit blocked reasons, and route preflight (R04).
- ⏳ The native agent pool does **not yet** re-check graph eligibility before
  accepting or launching jobs; route preview must not be treated as approval.
- ⏳ Unified, per-product task/PR rollups and cross-repo admission in the
  existing Cezar task scheduler (without introducing a second task database).
