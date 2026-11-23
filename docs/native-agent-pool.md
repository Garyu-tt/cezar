# Native dynamic agent pool for Cezar (fork)

This is a **Cezar feature**, not a Mojum worker product or an overlay UI.
Its agents are normal Cezar `RunManager.startRun` runs. Each appears in the
standard **Tasks** page, with its own branch/worktree where applicable, native
status, run history and agent transcript.

The name “300 Spartans” is historical only. No agent-count constant is baked
into the pool. An operator chooses a desired number from **0 to 500** for each
project, and can change it while work is underway.

## Contract

All endpoints are project-scoped, with the usual boot-project aliases:

- `GET /api/v1/agent-pool` gives target, native resource ceiling, confirmed
  native running count and links (run IDs) for each submitted job.
- `PUT /api/v1/agent-pool` with `{"desired":17}` scales the pool. `0`
  drains the pool by stopping new launches. It **does not cancel** existing runs.
- `POST /api/v1/agent-pool/jobs` with
  `{"jobs":[{"id":"issue-123-build","task":"Implement and test the bounded change specified in issue #123","role":"build","readOnly":false}]}`
  enqueues real work, up to 100 distinct jobs per request.
- Use `/api/v1/p/:projectId/agent-pool` for a specific project.

Duplicate IDs with the same task/role/access are idempotent. Reusing a job ID
with different content is rejected. The total private backlog is limited to
5,000 jobs, to prevent runaway automation. A task may be built or reviewed by
an existing Cezar workflow or its Automation engine; there is no second model
gateway, HTTP server, browser widget or persistent agent process.

The queue lives in the normal project data directory as private
`agent-pool-v1.json`. Native Cezar run records remain the *authoritative*
source for whether a run is queued, running, waiting, accepted or failed.
Every launched task has a `[CEZ-POOL:<job-id>]` marker so a restart can
recover an interrupted dispatch without silently creating a duplicate.
Unconfirmed partial launches remain `uncertain` for operator inspection.

## Logical identities versus actual model use

`desired=17` requests 17 **native agent tasks** in flight, not 17
independent model processes or 17 guaranteed simultaneous token streams.
The actual admission limit is
`min(desired, workspace.resources.maxParallel, project.maxParallel?)`,
and Cezar still enforces provider/auth/worktree policies. Native tasks may
remain `queued` if a separate provider is saturated.

This fork lifts the *configurable* Cezar parallel ceiling from 16 to 500
without changing the safe default of **2**. Increasing the resource ceiling
is an explicit owner action. Only do so after checking RAM, provider model
slots, inference throughput and recovery behavior. A pool of 500 logical
agents on a one-slot LLM stays bounded by that LLM's available capacity.

The `nativeActive` metric counts Cezar runs whose status is actually
`running`, not process threads, provider requests or free `/slots`.
A job's `runId` opens its native Cezar task in the existing interface. Do not
infer active work from the mere number of registered logical IDs.

## Safety and lifecycle

- Nothing launches until the operator explicitly sets a positive target and
  adds work.
- Work is started through the existing `RunManager` and is gated by the same
  provider/account availability checks as `POST /runs`.
- Provider denial *before* a run is created keeps the job pending; unexpected
  errors after potential creation mark it uncertain and never blindly retry.
- The native semaphore is authoritative for admission; increasing the desired
  pool cannot bypass CPU, memory, workspace or provider limits.
- Resizing down drains, rather than killing a run in the middle of file edits.
- There is no automatic GitHub merge, fake approval or CI bypass.
- Per-project manifests reload at startup, and a native tick reconciles
  completed runs and fills released slots about every four seconds.
- No extra UI panel is injected into the Cezar page. Native Tasks and
  Automations already provide visibility into each run.

To populate the pool automatically, connect an existing Cezar automation or
an authorized project workflow to `POST /agent-pool/jobs`. The pool handles
bounded concurrency and native lifecycle; fetching issues/PRs, choosing work,
tests and independent release policy remain separate existing Cezar features.
