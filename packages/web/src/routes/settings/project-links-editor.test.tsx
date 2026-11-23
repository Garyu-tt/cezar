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
    fireEvent.click(focus)
    await waitFor(() => expect(requests).toContainEqual({
      url: '/api/v1/workspace/project-graph/focus',
      method: 'PUT', body: { projectId: 'mojum' },
    }))
  })

  it('creates typed links to registered projects and renders the same graph cache', async () => {
    showEditor()
    const target = await screen.findByLabelText('Target project')
    fireEvent.change(target, { target: { value: 'adamantiumtoolbox' } })
    const relation = screen.getByLabelText('Relationship')
    fireEvent.change(relation, { target: { value: 'part-of' } })
    fireEvent.click(screen.getByRole('button', { name: /^Link$/ }))
    await waitFor(() => expect(requests.some((item) =>
      item.method === 'POST' && item.url === '/api/v1/workspace/project-graph/links' &&
      JSON.stringify(item.body) === JSON.stringify({
        from: 'mojum', to: 'adamantiumtoolbox', type: 'part-of',
      }))).toBe(true))
    await waitFor(() => expect(document.querySelector('[data-slot="project-links-editor"] li')?.textContent)
      .toContain('part-of'))
  })

  it('refuses to invent a local execution project for remote/unregistered targets', async () => {
    showEditor()
    const target = await screen.findByLabelText('Target project') as HTMLSelectElement
    expect([...target.options].map((option) => option.value)).toEqual([
      '', 'adamantiumtoolbox', 'adamantium-node',
    ])
    expect(requests.filter((item) => item.method !== 'GET')).toEqual([])
  })
})
