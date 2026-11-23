/**
 * Optional, repository-local ecosystem catalog for cross-repository Cezar planning.
 * This is a planning layer, NOT a replacement for Cezar's per-repo worktrees,
 * credentials, queues, PR review gates or ~/.cezar project registry.
 *
 * Usage:
 *   node scripts/ecosystem.mjs summary
 *   node scripts/ecosystem.mjs scope mojum
 *   node scripts/ecosystem.mjs impact AdamantiumToolBox
 *   node scripts/ecosystem.mjs waves
 *   node scripts/ecosystem.mjs link mojum GenesisPE depends-on
 *   node scripts/ecosystem.mjs unlink mojum GenesisPE depends-on
 *   node scripts/ecosystem.mjs focus mojum
 *   node scripts/ecosystem.mjs sync          # explicit network/gh operation
 */
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const RELATION_TYPES = Object.freeze(['part-of', 'built-on', 'depends-on', 'provides-feature'])
const RELATIONS = new Set(RELATION_TYPES)
const GITHUB_REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/
const norm = (value) => value.toLowerCase()
const dependencyTypes = new Set(['part-of', 'built-on', 'depends-on'])

export const defaultManifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.ai/ecosystem.json')
/** Private repo names and private links never enter the tracked public manifest. */
export const privateManifestPath = () =>
  resolve(process.env.CEZ_HOME || join(homedir(), '.cezar'), 'ecosystem-private.json')

/** Validate before any mutation, including a parent-cycle and ambiguous IDs. */
export function validateEcosystem(graph) {
  const errors = []
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return ['manifest must be a JSON object']
  if (graph.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (typeof graph.githubOwner !== 'string' || !/^[\w.-]+$/.test(graph.githubOwner)) errors.push('githubOwner is invalid')
  if (!Array.isArray(graph.repositories)) errors.push('repositories must be an array')
  if (!Array.isArray(graph.relations)) errors.push('relations must be an array')
  if (errors.length) return errors
  const ids = new Set()
  for (const repo of graph.repositories) {
    if (!repo || typeof repo.fullName !== 'string' || !GITHUB_REPO.test(repo.fullName)) {
      errors.push('repository fullName must be owner/name')
      continue
    }
    const id = norm(repo.fullName)
    if (ids.has(id)) errors.push('duplicate repository: ' + repo.fullName)
    ids.add(id)
    if (repo.defaultBranch !== undefined && (typeof repo.defaultBranch !== 'string' || repo.defaultBranch.length > 200)) {
      errors.push('invalid defaultBranch: ' + repo.fullName)
    }
  }
  if (typeof graph.focus !== 'string' || !ids.has(norm(graph.focus))) errors.push('focus must identify a registered repository')
  const links = new Set()
  const parents = new Map()
  for (const link of graph.relations) {
    if (!link || typeof link.from !== 'string' || typeof link.to !== 'string' || !RELATIONS.has(link.type)) {
      errors.push('invalid relation: expected from/to/type')
      continue
    }
    const a = norm(link.from), b = norm(link.to)
    if (!ids.has(a) || !ids.has(b)) errors.push('relation references unknown repository: ' + link.from + ' -> ' + link.to)
    if (a === b) errors.push('self-link: ' + link.from)
    const key = a + '|' + b + '|' + link.type
    if (links.has(key)) errors.push('duplicate relation: ' + key)
    links.add(key)
    if (link.type === 'part-of') {
      if (parents.has(a) && parents.get(a) !== b) errors.push('multiple parents for ' + link.from)
      parents.set(a, b)
    }
  }
  for (const child of parents.keys()) {
    const visited = new Set()
    let node = child
    while (parents.has(node)) {
      if (visited.has(node)) {
        errors.push('containment cycle includes ' + child)
        break
      }
      visited.add(node)
      node = parents.get(node)
    }
  }
  return [...new Set(errors)]
}

export function resolveRepository(graph, query) {
  if (typeof query !== 'string' || query.trim() === '') throw new Error('repository name required')
  const exact = graph.repositories.filter((repo) => norm(repo.fullName) === norm(query))
  if (exact.length === 1) return exact[0].fullName
  const matching = graph.repositories.filter((repo) => norm(repo.fullName.split('/')[1]) === norm(query))
  if (matching.length === 1) return matching[0].fullName
  if (matching.length > 1) throw new Error('ambiguous repository name: ' + query + '; use owner/name')
  throw new Error('unknown repository: ' + query)
}

const adjacent = (graph, direction, types) => {
  const mapping = new Map(graph.repositories.map((r) => [norm(r.fullName), []]))
  for (const link of graph.relations) {
    if (!types.has(link.type)) continue
    const from = direction === 'forward' ? link.from : link.to
    const to = direction === 'forward' ? link.to : link.from
    mapping.get(norm(from)).push(to)
  }
  return mapping
}

function closure(graph, start, direction, types) {
  const root = resolveRepository(graph, start)
  const edges = adjacent(graph, direction, types)
  const visited = new Set([norm(root)])
  const pending = [root]
  const result = []
  while (pending.length) {
    const current = pending.shift()
    for (const next of edges.get(norm(current))) {
      if (visited.has(norm(next))) continue
      visited.add(norm(next))
      pending.push(next)
      result.push(next)
    }
  }
  return result
}

/** Outgoing prerequisites, not physical nested checkouts. */
export function dependencies(graph, query) {
  return closure(graph, query, 'forward', dependencyTypes)
}

/** All products possibly affected by changes to a provider. */
export function impact(graph, query) {
  return closure(graph, query, 'reverse', dependencyTypes)
}

/** Focus includes its contained children and providers reachable from them. */
export function focusScope(graph, query = graph.focus) {
  const root = resolveRepository(graph, query)
  const descendants = closure(graph, root, 'reverse', new Set(['part-of']))
  const scope = new Set([root, ...descendants])
  for (const member of [...scope]) for (const prerequisite of dependencies(graph, member)) scope.add(prerequisite)
  return [...scope]
}

/** Parallel-capable batches: a dependency must be in an earlier wave. */
export function executionWaves(graph) {
  const errors = validateEcosystem(graph)
  if (errors.length) throw new Error(errors.join('; '))
  const ids = new Map(graph.repositories.map((repo) => [norm(repo.fullName), repo.fullName]))
  const prerequisites = new Map([...ids.keys()].map((id) => [id, new Set()]))
  const consumers = new Map([...ids.keys()].map((id) => [id, new Set()]))
  for (const link of graph.relations) {
    if (!dependencyTypes.has(link.type)) continue
    const from = norm(link.from), to = norm(link.to)
    prerequisites.get(from).add(to)
    consumers.get(to).add(from)
  }
  const waves = []
  let remaining = new Set(ids.keys())
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => prerequisites.get(id).size === 0).sort()
    if (ready.length === 0) {
      throw new Error('cyclic dependency graph: cannot plan parallel waves; resolve or explicitly break the cross-repo blockers')
    }
    waves.push(ready.map((id) => ids.get(id)))
    for (const id of ready) {
      remaining.delete(id)
      for (const consumer of consumers.get(id)) prerequisites.get(consumer).delete(id)
    }
  }
  return waves
}

export function withRelation(graph, fromQuery, toQuery, type) {
  if (!RELATIONS.has(type)) throw new Error('invalid relation type: ' + type)
  const from = resolveRepository(graph, fromQuery), to = resolveRepository(graph, toQuery)
  const next = { ...graph, relations: [...graph.relations, { from, to, type }] }
  const errors = validateEcosystem(next)
  if (errors.length) throw new Error(errors.join('; '))
  return next
}

export function withoutRelation(graph, fromQuery, toQuery, type) {
  const from = resolveRepository(graph, fromQuery), to = resolveRepository(graph, toQuery)
  const next = {
    ...graph,
    relations: graph.relations.filter((link) =>
      !(norm(link.from) === norm(from) && norm(link.to) === norm(to) && link.type === type)),
  }
  if (next.relations.length === graph.relations.length) throw new Error('relation does not exist')
  return next
}

/** Non-destructive discovery: add public repositories, retain curated links and missing entries. */
export function mergeGitHubRepositories(graph, remote, { includePrivate = false } = {}) {
  if (!Array.isArray(remote)) throw new Error('GitHub response must be an array')
  const repositories = graph.repositories.map((repo) => ({ ...repo }))
  const byName = new Map(repositories.map((repo) => [norm(repo.fullName), repo]))
  for (const item of remote) {
    if (!item || typeof item.nameWithOwner !== 'string' || !GITHUB_REPO.test(item.nameWithOwner)) continue
    if (norm(item.nameWithOwner.split('/')[0]) !== norm(graph.githubOwner)) continue
    if (item.isPrivate && !includePrivate) continue // never publish private names by default
    const key = norm(item.nameWithOwner)
    const defaultBranch = item.defaultBranchRef?.name
    const known = byName.get(key)
    if (known) {
      if (typeof defaultBranch === 'string') known.defaultBranch = defaultBranch
      known.isPrivate = item.isPrivate === true
      continue
    }
    const added = { fullName: item.nameWithOwner, isPrivate: item.isPrivate === true }
    if (typeof defaultBranch === 'string') added.defaultBranch = defaultBranch
    repositories.push(added)
    byName.set(key, added)
  }
  repositories.sort((a, b) => norm(a.fullName).localeCompare(norm(b.fullName)))
  const next = { ...graph, repositories }
  const errors = validateEcosystem(next)
  if (errors.length) throw new Error(errors.join('; '))
  return next
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error // a malformed private overlay must not be silently overwritten
  }
}

/** Merge the private local overlay into the session, without publishing it. */
async function load(path) {
  const shared = JSON.parse(await readFile(path, 'utf8'))
  const privateData = await optionalJson(privateManifestPath())
  const graph = privateData
    ? { ...shared,
        focus: privateData.focus || shared.focus,
        repositories: [...shared.repositories, ...(privateData.repositories || [])],
        relations: [...shared.relations, ...(privateData.relations || [])] }
    : shared
  const errors = validateEcosystem(graph)
  if (errors.length) throw new Error(errors.join('; '))
  return graph
}

async function atomicSave(path, value) {
  const temp = join(dirname(path), '.ecosystem-' + randomUUID() + '.tmp')
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

/** Split private repositories and every relationship touching them into a local-only overlay. */
async function save(path, graph) {
  const errors = validateEcosystem(graph)
  if (errors.length) throw new Error(errors.join('; '))
  const privateRepos = graph.repositories.filter((r) => r.isPrivate === true)
  const privateNames = new Set(privateRepos.map((r) => norm(r.fullName)))
  const isPrivate = (id) => privateNames.has(norm(id))
  const oldShared = JSON.parse(await readFile(path, 'utf8'))
  const shared = { ...graph,
    focus: isPrivate(graph.focus) ? oldShared.focus : graph.focus,
    repositories: graph.repositories.filter((r) => !r.isPrivate),
    relations: graph.relations.filter((r) => !isPrivate(r.from) && !isPrivate(r.to)) }
  const overlay = {
    schemaVersion: 1,
    focus: isPrivate(graph.focus) ? graph.focus : null,
    repositories: privateRepos,
    relations: graph.relations.filter((r) => isPrivate(r.from) || isPrivate(r.to)),
  }
  const sharedErrors = validateEcosystem(shared)
  if (sharedErrors.length) throw new Error('public manifest invalid after splitting private entries: ' + sharedErrors.join('; '))
  if (privateRepos.length || (await optionalJson(privateManifestPath())) !== null) {
    await mkdir(dirname(privateManifestPath()), { recursive: true, mode: 0o700 })
    await atomicSave(privateManifestPath(), overlay)
  }
  await atomicSave(path, shared)
}

export async function runCli(args = process.argv.slice(2), path = defaultManifestPath) {
  const [command = 'summary', ...rest] = args
  const graph = await load(path)
  const print = (data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  if (command === 'validate') { print({ valid: true, repositories: graph.repositories.length, relations: graph.relations.length }); return }
  if (command === 'summary') {
    print({ owner: graph.githubOwner, focus: graph.focus, repositories: graph.repositories.length,
      relations: graph.relations.length, focusScope: focusScope(graph) })
    return
  }
  if (command === 'impact') { print(impact(graph, rest[0])); return }
  if (command === 'dependencies') { print(dependencies(graph, rest[0])); return }
  if (command === 'scope') { print(focusScope(graph, rest[0] || graph.focus)); return }
  if (command === 'waves') { print(executionWaves(graph)); return }
  if (command === 'focus') {
    if (!rest[0]) throw new Error('usage: focus owner/name')
    const next = { ...graph, focus: resolveRepository(graph, rest[0]) }
    await save(path, next)
    print({ focus: next.focus })
    return
  }
  if (command === 'link' || command === 'unlink') {
    if (rest.length !== 3) throw new Error('usage: ' + command + ' from to type')
    const next = command === 'link'
      ? withRelation(graph, rest[0], rest[1], rest[2])
      : withoutRelation(graph, rest[0], rest[1], rest[2])
    await save(path, next)
    print({ relations: next.relations.length })
    return
  }
  if (command === 'sync') {
    const includePrivate = rest.includes('--include-private')
    // `gh` reads its existing account; no token is logged or copied to the manifest.
    const stdout = execFileSync('gh', ['repo', 'list', graph.githubOwner, '--limit', '1000',
      '--json', 'nameWithOwner,isPrivate,defaultBranchRef'], {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60_000,
    })
    const next = mergeGitHubRepositories(graph, JSON.parse(stdout), { includePrivate })
    await save(path, next)
    print({ repositories: next.repositories.length, retainedRelations: next.relations.length,
      includePrivate, note: 'Private entries, if enabled, stay in the local CEZ_HOME overlay. No repository was cloned or modified' })
    return
  }
  throw new Error('unknown command: ' + command + '\ncommands: summary, validate, scope, dependencies, impact, waves, focus, link, unlink, sync')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error('[ecosystem] ' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
