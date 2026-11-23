import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ProjectListEntry, NativeProjectGraph } from '@open-mercato/cezar-api-client'
import { ProjectLinksEditor } from './project-links-editor'

const project = (id: string): ProjectListEntry => ({
  id, name: id, root: `/tmp/${id}`, source: 'local', status: 'ok',
  addedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z',
})
const projects = [project('mojum'), project('adamantiumtoolbox'), project('adamantium-node')]
let graph: NativeProjectGraph
let requests: Array<{ method: string; url: string; body?: unknown }>

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() // Radix Select in jsdom
  graph = { focusProjectId: 'adamantium-node', explicitFocusProjectId: null,
    projectIds: projects.map((p) => p.id), links: [], unresolvedLinks: [] }
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined
    requests.push({ method, url: path, body })
    const result = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
    if (path === '/api/v1/workspace/project-graph' && method === 'GET') return result(graph)
    if (path === '/api/v1/workspace/project-graph/plan' && method === 'GET') {
      const dependencies = graph.links.some((link) => link.from === 'mojum' && link.to === 'adamantiumtoolbox')
      return result({
        focusProjectId: graph.focusProjectId,
        focusScope: ['mojum'],
        waves: dependencies
          ? [['adamantium-node', 'adamantiumtoolbox'], ['mojum']]
          : [['adamantium-node', 'adamantiumtoolbox', 'mojum']],
        blocked: [],
        unresolvedLinks: [],
        previewOnly: true,
      })
    }
    if (path === '/api/v1/workspace/project-graph/routing-preview' && method === 'POST') {
      const executionProjectId = String(body?.executionProjectId ?? '')
      const eligible = executionProjectId === 'adamantium-node'
      return result({
        logicalProjectId: body?.logicalProjectId,
        executionProjectId,
        eligible,
        reason: eligible ? 'ready' : 'outside-logical-scope',
        nativePoolEndpoint: eligible ? '/api/v1/p/adamantium-node/agent-pool/jobs' : null,
        blockedReason: null,
        blockedBy: [],
        logicalScope: ['mojum', 'adamantium-node'],
        previewOnly: true,
      })
    }
    if (path === '/api/v1/workspace/project-graph/focus' && method === 'PUT') {
      graph = { ...graph, focusProjectId: body?.projectId as string, explicitFocusProjectId: body?.projectId as string }
      return result(graph)
    }
    if (path === '/api/v1/workspace/project-graph/links' && method === 'POST') {
      const link = body as NativeProjectGraph['links'][number]
      if (graph.links.some((item) => item.from === link.from && item.to === link.to && item.type === link.type))
        return result({ error: 'project relationship already exists' }, 400)
      graph = { ...graph, links: [...graph.links, link] }
      return result(graph)
    }
    if (path === '/api/v1/workspace/project-graph/links' && method === 'DELETE') {
      const link = body as NativeProjectGraph['links'][number]
      graph = { ...graph, links: graph.links.filter((item) =>
        !(item.from === link.from && item.to === link.to && item.type === link.type)) }
      return result(graph)
    }
    return result({ error: 'unexpected request' }, 404)
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function showEditor() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectLinksEditor project={projects[0]!} projects={projects} />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Relationships for mojum' }))
}

describe('existing row project graph popover', () => {
  it('uses workspace API to persist focus while keeping navigation independent', async () => {
    showEditor()
    const focus = await screen.findByRole('button', { name: 'Focus' })
    await waitFor(() => expect(focus.hasAttribute('disabled')).toBe(false))
    fireEvent.click(focus)
    await waitFor(() => expect(requests).toContainEqual({
      url: '/api/v1/workspace/project-graph/focus',
      method: 'PUT', body: { projectId: 'mojum' },
    }))
  })

  it('creates typed links to registered projects and renders the same graph cache', async () => {
    showEditor()
    const target = await screen.findByRole('combobox', { name: 'Target project' })
    fireEvent.keyDown(target, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: /adamantiumtoolbox/ }))
    const relation = screen.getByRole('combobox', { name: 'Relationship' })
    fireEvent.keyDown(relation, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Part of (child → parent)' }))
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }))
    await waitFor(() => expect(requests.some((item) =>
      item.method === 'POST' && item.url === '/api/v1/workspace/project-graph/links' &&
      JSON.stringify(item.body) === JSON.stringify({
        from: 'mojum', to: 'adamantiumtoolbox', type: 'part-of',
      }))).toBe(true))
    await waitFor(() => expect(document.querySelector('[data-slot="project-links-editor"] li')?.textContent)
      .toContain('part-of'))
  })

  it('shows advisory parallel waves without starting a task or a checkout', async () => {
    showEditor()
    expect(await screen.findByText(/3 ready in 1 wave/)).not.toBeNull()
    expect(screen.getByText(/Wave 1:/)).not.toBeNull()
    expect(requests.filter((item) => item.url.includes('/runs') || item.url.includes('/checkout'))).toEqual([])
  })

  it('checks explicit execution targets without dispatching jobs and hides stale answers', async () => {
    showEditor()
    const target = await screen.findByRole('combobox', { name: 'Target project' })
    const check = screen.getByRole('button', { name: 'Check' })
    expect((check as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(target, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'adamantium-node (adamantium-node)' }))
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(check)
    await waitFor(() => expect(requests).toContainEqual({
      method: 'POST',
      url: '/api/v1/workspace/project-graph/routing-preview',
      body: { logicalProjectId: 'mojum', executionProjectId: 'adamantium-node' },
    }))
    expect(await screen.findByText(/Target is eligible for planning/)).not.toBeNull()
    expect(requests.some((item) => item.url.includes('/agent-pool/jobs'))).toBe(false)

    fireEvent.keyDown(target, { key: 'ArrowDown', code: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'adamantiumtoolbox (adamantiumtoolbox)' }))
    expect(screen.queryByText(/Target is eligible for planning/)).toBeNull()
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(check)
    expect(await screen.findByText(/Target unavailable: outside-logical-scope/)).not.toBeNull()
    expect(requests.some((item) => item.url.includes('/agent-pool/jobs'))).toBe(false)
  })

  it('refuses to invent a local execution project for remote/unregistered targets', async () => {
    showEditor()
    const target = await screen.findByRole('combobox', { name: 'Target project' })
    fireEvent.keyDown(target, { key: 'ArrowDown', code: 'ArrowDown' })
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'adamantiumtoolbox (adamantiumtoolbox)',
      'adamantium-node (adamantium-node)',
    ])
    expect(requests.filter((item) => item.method !== 'GET')).toEqual([])
  })
})
