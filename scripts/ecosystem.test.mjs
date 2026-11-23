import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultManifestPath, dependencies, executionWaves, focusScope, impact,
  mergeGitHubRepositories, privateManifestPath, resolveRepository, runCli,
  validateEcosystem, withRelation, withoutRelation,
} from './ecosystem.mjs'

const repo = (fullName) => ({ fullName, defaultBranch: 'main' })
const sample = () => ({
  schemaVersion: 1, githubOwner: 'Garyu-tt', focus: 'Garyu-tt/mojum',
  repositories: [repo('Garyu-tt/adamantium-node'), repo('Garyu-tt/AdamantiumToolBox'),
    repo('Garyu-tt/mojum'), repo('Garyu-tt/GenesisPE')],
  relations: [
    { from: 'Garyu-tt/mojum', to: 'Garyu-tt/AdamantiumToolBox', type: 'part-of' },
    { from: 'Garyu-tt/AdamantiumToolBox', to: 'Garyu-tt/adamantium-node', type: 'built-on' },
  ],
})

describe('ecosystem graph', () => {
  it('validates the checked-in catalog and preserves the selected focus', async () => {
    const catalog = JSON.parse(await readFile(defaultManifestPath, 'utf8'))
    assert.deepEqual(validateEcosystem(catalog), [])
    assert.equal(catalog.focus, 'Garyu-tt/mojum')
    assert.ok(catalog.repositories.length >= 28)
    assert.equal(catalog.repositories.every((r) => r.isPrivate !== true), true)
  })

  it('resolves short names case-insensitively and rejects unregistered repos', () => {
    assert.equal(resolveRepository(sample(), 'toolbox'.replace('toolbox', 'adamantiumtoolbox')), 'Garyu-tt/AdamantiumToolBox')
    assert.throws(() => resolveRepository(sample(), 'missing'), /unknown repository/)
  })

  it('computes prerequisites and reverse impact transitively', () => {
    assert.deepEqual(dependencies(sample(), 'mojum'), ['Garyu-tt/AdamantiumToolBox', 'Garyu-tt/adamantium-node'])
    assert.deepEqual(impact(sample(), 'adamantium-node'), ['Garyu-tt/AdamantiumToolBox', 'Garyu-tt/mojum'])
    assert.deepEqual(focusScope(sample()), ['Garyu-tt/mojum', 'Garyu-tt/AdamantiumToolBox', 'Garyu-tt/adamantium-node'])
  })

  it('produces parallel waves while respecting dependencies', () => {
    const waves = executionWaves(sample())
    assert.deepEqual(waves, [
      ['Garyu-tt/adamantium-node', 'Garyu-tt/GenesisPE'],
      ['Garyu-tt/AdamantiumToolBox'],
      ['Garyu-tt/mojum'],
    ])
  })

  it('prevents multiple parents, self-links, duplicated links and containment cycles', () => {
    assert.throws(() => withRelation(sample(), 'mojum', 'GenesisPE', 'part-of'), /multiple parents/)
    assert.throws(() => withRelation(sample(), 'mojum', 'mojum', 'depends-on'), /self-link/)
    assert.throws(() => withRelation(sample(), 'mojum', 'AdamantiumToolBox', 'part-of'), /duplicate relation/)
    assert.throws(() => withRelation(sample(), 'AdamantiumToolBox', 'mojum', 'part-of'), /containment cycle/)
  })

  it('handles dependencies shared by several consumers without copying repos', () => {
    const first = withRelation(sample(), 'mojum', 'GenesisPE', 'depends-on')
    const second = withRelation(first, 'AdamantiumToolBox', 'GenesisPE', 'depends-on')
    assert.equal(second.repositories.length, sample().repositories.length)
    assert.deepEqual(impact(second, 'GenesisPE'), ['Garyu-tt/mojum', 'Garyu-tt/AdamantiumToolBox'])
    assert.equal(withoutRelation(second, 'mojum', 'GenesisPE', 'depends-on').relations.length, 3)
  })

  it('allows cyclic dependency metadata but never schedules it as ordered waves', () => {
    const cycle = withRelation(sample(), 'adamantium-node', 'mojum', 'depends-on')
    assert.deepEqual(validateEcosystem(cycle), [])
    assert.throws(() => executionWaves(cycle), /cyclic dependency graph/)
  })

  it('merges GitHub public discovery without removing missing repos or curated links', () => {
    const discovered = mergeGitHubRepositories(sample(), [
      { nameWithOwner: 'Garyu-tt/GenesisPE', isPrivate: false, defaultBranchRef: { name: 'develop' } },
      { nameWithOwner: 'Garyu-tt/new-component', isPrivate: false },
      { nameWithOwner: 'Garyu-tt/secret', isPrivate: true },
      { nameWithOwner: 'Other/ignored', isPrivate: false },
    ])
    assert.equal(discovered.relations.length, 2)
    assert.equal(discovered.repositories.length, 5)
    assert.equal(discovered.repositories.find((r) => r.fullName.endsWith('/GenesisPE')).defaultBranch, 'develop')
    assert.deepEqual(validateEcosystem(discovered), [])
    const withPrivate = mergeGitHubRepositories(sample(), [
      { nameWithOwner: 'Garyu-tt/secret', isPrivate: true },
    ], { includePrivate: true })
    assert.equal(withPrivate.repositories.find((r) => r.fullName.endsWith('/secret')).isPrivate, true)
  })
})

describe('local-only private overlay', () => {
  const original = process.env.CEZ_HOME
  let home
  afterEach(async () => {
    if (original === undefined) delete process.env.CEZ_HOME
    else process.env.CEZ_HOME = original
    if (home) await rm(home, { recursive: true, force: true })
  })
  it('keeps private focus and cross-repo links outside the tracked catalog', async () => {
    home = await mkdtemp(join(tmpdir(), 'cez-ecosystem-'))
    process.env.CEZ_HOME = home
    const publicFile = join(home, 'public.json')
    await writeFile(publicFile, JSON.stringify(sample()), 'utf8')
    const secret = { fullName: 'Garyu-tt/secret', isPrivate: true }
    const privateFile = privateManifestPath()
    await mkdir(home, { recursive: true })
    await writeFile(privateFile, JSON.stringify({ schemaVersion: 1, focus: null, repositories: [secret],
      relations: [{ from: secret.fullName, to: 'Garyu-tt/mojum', type: 'depends-on' }] }))
    await runCli(['focus', 'secret'], publicFile)
    const shared = JSON.parse(await readFile(publicFile, 'utf8'))
    const overlay = JSON.parse(await readFile(privateFile, 'utf8'))
    assert.equal(shared.focus, 'Garyu-tt/mojum')
    assert.equal(overlay.focus, 'Garyu-tt/secret')
    assert.equal(JSON.stringify(shared).includes('/secret'), false)
    assert.equal(overlay.relations.length, 1)
  })
})
