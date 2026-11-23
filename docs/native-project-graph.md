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

## Public catalog versus native workspace

The GitHub-wide catalog can contain owned forks and repositories that are not
cloned on this machine. The native graph must NOT interpret catalog names as
local paths or silently register/clone them. Linking the public/private account
catalog to the native graph requires an explicit and verified mapping of
`owner/repo` to local `projectId` (e.g. via the safe parsed `repoUrl` field).
Until that binding is implemented, each graph is a separate planning layer.

A focus on Mojum must not prevent parallel work on unrelated registered
projects. The existing global semaphore, per-project limit and task/review
gates remain authoritative.

## Implementation status

- ✅ Native validated graph data, focus, relationship mutation and CLI planning.
- ✅ Atomic deregistration cleanup and regression tests.
- ✅ Same-origin HTTP API for reading focus/links and updating links/focus:\n  `GET /api/v1/workspace/project-graph`,\n  `PUT /api/v1/workspace/project-graph/focus`,\n  `POST/DELETE /api/v1/workspace/project-graph/links`.\n- ⏳ Existing project-switcher/settings/Tasks interface integration.
- ⏳ Remote catalog mapping, automatic capability ownership discovery.
- ⏳ Agent routing from logical product to explicit execution repository,
  cross-repo dependency gates and aggregated PR/review state.
