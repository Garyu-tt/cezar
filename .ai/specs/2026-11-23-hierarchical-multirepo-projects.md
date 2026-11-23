# Hierarchical multi-repository projects

> Status: proposed / implementation not started
> Date: 2026-11-23
> Repository: Garyu-tt/cezar (fork)
> Tracking: `.ai/plans/2026-11-23-hierarchical-multirepo-projects.md`
> Scope: generic Cezar platform capability; Adamantium is an example, not a hard-coded integration.

## Problem

Cezar already supports a multi-project workspace: project registry in `packages/cezar/src/workspace/config.ts`, per-repo execution contexts, project-scoped routes, a project switcher/folders and tags, and a global task index. These are **independent repositories**, not an architectural project hierarchy. A user coordinating a product composed of several repos cannot currently declare ownership, dependencies, feature providers and an active main/focus product, or route a single feature coherently into multiple independent repo-specific tasks.

**Do not build another dashboard or create a separate Cezar process per repository.** Extend the current workspace, settings, project switcher, global Tasks and task orchestration.

## Desired UX

1. Pick one repository as the **primary/focus project**.
2. Multi-select supporting repositories and assign links: *subproject*, *dependency*, or *feature provider*. Repositories remain independent Git repos; selection never moves directories.
3. Optionally build a deep product tree and cross-links between unrelated branches.
4. Show the selected product, all descendants, ancestors needed for orientation, and linked dependencies as one navigable scope; filter aggregated tasks/progress to that scope.
5. Create a feature under the focus product; explicitly choose or be offered the execution repository for each subtask. Follow its independent PR/CI/review chain.
6. Switch focus while preserving the global product topology.

The **focus** (currently selected work context) and **architectural parent** (long-lived containment) MUST be different concepts. A focus product can be a leaf.

### Example

```text
adamantium-node                         [platform/foundation]
└── AdamantiumToolBox                   [framework built on the platform]
    └── mojum                           [active focus / primary product]
```

The actual repositories are `Garyu-tt/adamantium-node`, `Garyu-tt/AdamantiumToolBox`, and `Garyu-tt/mojum`. For a Mojum feature, changes might occur in any one of the three. Other repositories, such as GenesisPE or Noosphere components, can be linked as reusable providers to several products without being duplicated as tree children.

This example is an initial user-configurable fixture, **not** a forced default for unrelated Cezar installations.

## Data contract

Propose an additive, versioned workspace model using the existing registry (`~/.cezar/config.json`), for example:

```json
{
  "projects": [
    { "id": "adamantium-node", "name": "adamantium-node" },
    { "id": "adamantiumtoolbox", "name": "AdamantiumToolBox", "parentProjectId": "adamantium-node" },
    { "id": "mojum", "name": "mojum", "parentProjectId": "adamantiumtoolbox" }
  ],
  "projectLinks": [
    { "fromProjectId": "mojum", "toProjectId": "genesispe", "type": "depends-on" }
  ]
}
```

The JSON above is *illustrative*; the implementation must preserve all existing required registry fields and choose either a separate link collection or additive per-project metadata after inspecting current schema/migrations.

- A project has **at most one containment parent** and zero or more child projects; unlimited logical nesting, finite runtime graph traversal with visited-set guards.
- Dependency/provider links are separately typed, many-to-many and directed. Define the meaning of each direction in the API, tests and UI labels.
- Prevent self-parenting and containment cycles; reject duplicates and missing endpoints on writes. A dependency used as an execution blocker must not form a dependency cycle.
- Stable project ids and normalized registry roots remain authoritative. Repo path is not inferred from an id and is not copied across task scopes.
- Removing/unregistering a repo removes or detaches its relationships without deleting its checkout, runs, branches or artifacts. Support missing/offline repos in read views.
- Prefer persisting current focus in workspace UI state (per user/instance) rather than changing architectural links each time selection changes. Unknown/deleted focus degrades safely to a registered project.
- Use the existing `.passthrough()`, salvage, merge-write, atomic persistence, backup/migration and safe-read conventions. Never overwrite unrelated config or older extension keys.
- Existing tags and user-defined folders are organizational overlays, not substitutes for structural parent/dependency links.

### Task model

An orchestration task/group must distinguish:

- `logicalProjectId` = the goal/product owning the feature (e.g. mojum).
- `executionProjectId` = repo whose worktree, checks, Git branch and PR are used (e.g. AdamantiumToolBox).
- `parentTaskId` / cross-repo predecessor links = prerequisites and result aggregation.
- provenance of the focus context and explicit choice/approval of repo routing.

The implementation may use different field names, but **the ownership-vs-execution distinction is mandatory**. Never run tools in a parent repo because a link was interpreted as a filesystem path. The receiving project always owns its worktree and permissions. Use per-repo status+PR and aggregate at logical feature level, not by inventing a shared PR.

## API / CLI expectations

Keep existing `/api/projects`, per-project routes, project IDs, legacy routes and `cezar projects` commands working. Extend with versioned and validated endpoints/CLI commands for:

- bulk link of selected supporting repos to a primary project;
- set/unset/reparent a project; query ancestors, descendants and typed links;
- set/get focus project;
- create/list/delete typed dependency links;
- read an aggregate scope and its task status;
- run a task against an explicit executionProjectId with a logical owner.

Enforce single-project capability boundaries (`CEZ_SINGLE_PROJECT=1`) at the server before side effects; apply existing authorization, root containment and project visibility rules. A repo disappearing mid-run must not send its work to another repo as fallback.

## UI integration

- **Existing** `packages/web/src/components/project-switcher.tsx`: show focus selector, hierarchy indentation/breadcrumbs, searchable subtrees and short typed-link markers; multi-select support repos in an existing dialog/surface. Keep the current responsive picker and folder arrangement.
- **Existing** Projects settings: edit parent, inspect/relink dependencies, remove relations safely, import/clone a repo into the registry as before.
- **Existing** global Tasks/dashboard: filter by focused logical project and eligible linked repos; aggregate progress, needs-you, blocked-by and review status. Clicking a task always opens its owning execution repo.
- **New-task flow**: default logical owner to focus, select/suggest execution repo, warn on cross-repo dispatch. Display both names when they differ.
- Keyboard access, aria labels, no duplicate competing navigation panels, mobile-width acceptance.

## Agents and scheduling

Do not bind project count to agent count. The dynamic pool may have 5, 17, 500 or another number of agents, constrained by configured compute and provider quotas. Use the **existing** scheduler, shared workspace concurrency/memory guards and independent worktrees. Features that touch multiple repos get individual repo tasks with explicit dependency gates; no auto-merge, unsafe push or permission escalation. Preserve review/CI gates and do not deadlock waiting/reviewing runs.

## Acceptance tests

1. Existing flat workspace boots without migrations that lose projects or task data. Old routes, folders/tags, per-repo caps and `CEZ_SINGLE_PROJECT` continue to work.
2. Register the three Adamantium example repos; save the tree; focus `mojum`; refresh, restart and switch focus. Tree and focus survive correctly and independently.
3. From a Mojum feature create a ToolBox execution task and a dependent adamantium-node task. Logical owner stays Mojum, but the repo-specific worktrees, branches, check commands and PR links resolve to their actual repos.
4. Link a shared provider to two independent products; display both links with no duplicated registration or files.
5. Reject containment cycles, missing target ids, duplicate links and invalid cross-scope writes. Unregister a parent safely, leaving child checkouts intact.
6. Show blockers, aggregate progress, task-status updates and review-needed indicators in the existing cockpit, including mobile and keyboard use.
7. No fixed agent count and no resource-cap bypass. Regression tests cover cross-project data leakage, task isolation and project deletion while a task is queued.
8. Run configured unit tests, typecheck, builds, integration tests with real Git, and UI/E2E coverage before merging.

## Non-goals

- Git submodules/subtrees, physical nesting of repositories or automatic code moves.
- Replacing existing GitHub authorization, repo isolation, PR review/merge policies or host-wide resource guards.
- An Adamantium-only implementation, a second dashboard, another Cezar process per project, or a fixed set of agents.

## Implementation phases

See `.ai/plans/2026-11-23-hierarchical-multirepo-projects.md`. Implement in incremental, independently testable changes; each PR must describe migrations, compatibility risks and rollback.
