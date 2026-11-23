# Task plan — hierarchical multi-repository project orchestration

**Status:** READY FOR IMPLEMENTATION; all tasks pending
**Owner:** Cezar fork (`Garyu-tt/cezar`)
**Date:** 2026-11-23
**Spec:** `.ai/specs/2026-11-23-hierarchical-multirepo-projects.md`
**Implementation branch:** create a new branch per implementation phase; do **not** treat this specification PR as a finished implementation.
**Priority:** platform feature for coordinating large multi-repo products.
**Issue tracker:** Issues are disabled in this fork (GitHub returned HTTP 410), so this plan and the companion PR are the source of truth until Issues are enabled.

## Clarified scope: all owned GitHub repositories

Treat the user's GitHub account as one *virtual* ecosystem root. Discover and inventory all
accessible repositories (including un-cloned ones) without creating fake parent checkouts.
Introduce typed relationships as evidence is confirmed; unclassified repos remain independently
schedulable. The focus product is a UI/task-planning context, **not** an exclusive execution
scope: independent work across the rest of the graph may proceed in parallel.

**Privacy gate:** do not write private repo identities into a tracked public catalog. Maintain
a protected local overlay for private metadata and never auto-publish it.

**Bootstrap:** PR #2 provides the checked-in public catalog, local private overlay, typed graph,
impact/dependency queries, parallel-ready waves and tests. Next phases must integrate the graph
with existing Cezar runtime state and project-scoped authorization, then task execution.

## Objective

Add a focus-project workflow where the user chooses one main product and links as many other repositories as desired to it as subprojects, feature providers, or dependencies. Keep a real multi-level architectural hierarchy (e.g. `adamantium-node → AdamantiumToolBox → mojum`) even when the **focused** project is `mojum`. Route agent subtasks and PRs to their true execution repositories while preserving one project-wide progress view.

## Work breakdown

| Phase | Task | Status | Exit evidence |
| --- | --- | --- | --- |
| 0 | Audit existing registry, projects API, UI folders/tags, global Tasks, RunStore/RunManager and project capability gates; write detailed migration/compatibility risk notes. | todo | path-level code map + signed-off data-contract decisions |
| 1 | Add typed parent and dependency relationships to workspace data; migrate safely without disturbing old projects. | todo | graph validation and restart/persistence tests |
| 1 | Implement focus project state separate from parent relations. | todo | focus switching/restart/unknown fallback tests |
| 2 | Add backend API + CLI for link/reparent/unlink, bulk selected repos, focus, graph summary and scoped aggregation. | todo | API/CLI validation, permissions, single-project gate tests |
| 3 | Extend current project switcher and Projects settings with hierarchy editor, links, focus selector and breadcrumbs; reuse existing components, not new dashboard. | todo | accessible keyboard + mobile E2E |
| 3 | Extend existing global Tasks/dashboard and new-task flow to show logical owner vs target repo, linked scope and cross-repo blockers. | todo | UI regression tests + correct cross-repo deep links |
| 4 | Add explicit `logicalProjectId` and `executionProjectId` to feature/run metadata (or equivalent), with task routing and per-repo isolation. | todo | real-Git worktree, branch, checks and PR link tests |
| 4 | Add cross-repo child tasks and dependency gates with fair dynamic-agent scheduling through existing workspace limits. | todo | no fixed pool size, no unsafe implicit merge, no waiting deadlock |
| 5 | Document migration, example Adamantium hierarchy, failures, rollback and run all repository quality gates. | todo | unit/typecheck/build/integration/E2E results |

## Delivery rules

- Preserve the existing main project's code, worktrees and routes; do not attempt an all-at-once invasive rewrite.
- Do not silently reparent a project when choosing it as focus.
- A project relationship must never be translated into a filesystem path.
- A feature touching multiple repos needs a separate reviewable change in each repo; links between tasks capture the multi-repo goal.
- Missing/offline repos produce explicit blocked/needs-attention states, not surprise execution in another repository.
- All additional agents share the scheduler's host-level limits; no hard-coded 17-agent or 5-agent limit.
- Implement and test each phase; update this table to `in-progress`/`done` with PR/commit and acceptance proof. Keep unfinished steps as `todo`.

## Example acceptance fixture

```text
hierarchy:
  adamantium-node
    AdamantiumToolBox
      mojum (focus)
extra dependency examples:
  mojum -> GenesisPE (provider)
  mojum -> noosphere-lite-mcp (provider)

user action:
  "Implement a feature for Mojum that needs the Toolbox plugin and the platform graph API"

expected:
  1. Goal belongs to Mojum.
  2. Separate execution tasks are assigned to whichever repository owns each change.
  3. Cross-repo prerequisites and blocking results are visible in the existing cockpit.
  4. Each repository has its own isolated worktree and PR/review gate.
  5. Switching focus to AdamantiumToolBox does not alter containment or existing tasks.
```

## Definition of done

All exit evidence recorded, all spec acceptance tests green, no regressions to flat/single-project operation, no duplicate UI control center, and no loss or unintended editing of registered repositories.
