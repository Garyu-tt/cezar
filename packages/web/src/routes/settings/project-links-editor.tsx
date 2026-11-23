import { useState } from 'react'
import { Link2Icon, StarIcon, XIcon } from 'lucide-react'
import type { ProjectListEntry, NativeProjectLink } from '@open-mercato/cezar-api-client'

import {
  useNativeProjectGraph,
  useNativeProjectPlan,
  useNativeProjectRoutingPreview,
  useNativeProjectLinkMutation,
  useSetNativeProjectFocus,
} from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'

const RELATIONS = [
  { type: 'part-of', label: 'Part of (child → parent)' },
  { type: 'built-on', label: 'Built on (consumer → foundation)' },
  { type: 'depends-on', label: 'Depends on (consumer → dependency)' },
  { type: 'provides-feature', label: 'Provides feature (provider → consumer)' },
] as const

type RelationType = (typeof RELATIONS)[number]['type']

/**
 * Contextual editor on the EXISTING Settings → Projects row.
 * A popover, not a second projects panel or a second navigation system.
 *
 * The remote GitHub catalog is intentionally NOT displayed here: until a catalog
 * entry is mapped to a registered checkout by verified origin URL, that remote
 * repo cannot own an agent worktree or be chosen as a local execution target.
 */
export function ProjectLinksEditor({
  project,
  projects,
}: {
  project: ProjectListEntry
  projects: ProjectListEntry[]
}) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [checkedExecutionId, setCheckedExecutionId] = useState<string | null>(null)
  const [type, setType] = useState<RelationType>('depends-on')
  const graph = useNativeProjectGraph(open)
  const plan = useNativeProjectPlan(open)
  const routing = useNativeProjectRoutingPreview()
  const focus = useSetNativeProjectFocus()
  const links = useNativeProjectLinkMutation()
  const peers = projects.filter((entry) => entry.id !== project.id && !entry.unregistered)
  const related = graph.data?.links.filter((link) => link.from === project.id || link.to === project.id) ?? []
  const isFocus = graph.data?.focusProjectId === project.id
  const isExplicitFocus = graph.data?.explicitFocusProjectId === project.id
  const busy = links.isPending || focus.isPending
  const unavailable = project.unregistered || peers.length === 0

  const addLink = () => {
    if (!target || busy) return
    links.mutate({ operation: 'add', link: { from: project.id, to: target, type } }, {
      onSuccess: () => { setTarget(''); setCheckedExecutionId(null); toast('Project relationship saved') },
      onError: (error: Error) => toast(error.message),
    })
  }

  const removeLink = (link: NativeProjectLink) => {
    if (busy) return
    setCheckedExecutionId(null)
    links.mutate({ operation: 'remove', link }, {
      onSuccess: () => toast('Project relationship removed'),
      onError: (error: Error) => toast(error.message),
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={project.unregistered}
          data-action="project-links"
          aria-label={`Relationships for ${project.name}`}
        >
          <Link2Icon className="size-3.5" aria-hidden="true" />
          Links
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="max-h-[min(38rem,80vh)] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto p-3"
        data-slot="project-links-editor"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-ui font-semibold">{project.name}</p>
            <p className="text-meta text-soft-foreground">Workspace relationships, not Git submodules</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={isExplicitFocus ? 'contrast' : 'outline'}
            disabled={busy || graph.isPending || graph.isError}
            data-action="project-focus"
            onClick={() => focus.mutate(isExplicitFocus ? null : project.id, {
              onSuccess: () => toast(isExplicitFocus ? 'Automatic focus restored' : `${project.name} is the focus product`),
              onError: (error: Error) => toast(error.message),
            })}
          >
            <StarIcon className="size-3.5" aria-hidden="true" />
            {isExplicitFocus ? 'Focused' : isFocus ? 'Set focus' : 'Focus'}
          </Button>
        </div>
        {graph.isPending ? <p className="mt-3 text-label text-soft-foreground">Loading relationships…</p> : null}
        {graph.isError ? (
          <div role="alert" className="mt-3 text-label text-danger">
            Cannot load project graph: {graph.error.message}
            <Button type="button" size="sm" variant="ghost" onClick={() => void graph.refetch()}>Retry</Button>
          </div>
        ) : null}
        {graph.data ? (
          <div className="mt-3 space-y-3">
            <div className="border-t border-border pt-3">
              <label htmlFor={`graph-relation-${project.id}`} className="text-label font-medium">Relationship</label>
              <Select value={type} onValueChange={(value) => setType(value as RelationType)} disabled={busy || unavailable}>
                <SelectTrigger id={`graph-relation-${project.id}`}
                  aria-label="Relationship" data-slot="graph-relation-type"
                  className="mt-1 w-full" size="sm"><SelectValue /></SelectTrigger>
                <SelectContent position="popper">
                  {RELATIONS.map((relation) => (
                    <SelectItem key={relation.type} value={relation.type}>{relation.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label htmlFor={`graph-target-${project.id}`} className="mt-2 block text-label font-medium">Target project</label>
              <div className="mt-1 flex gap-2">
                <Select value={target} onValueChange={(value) => { setTarget(value); setCheckedExecutionId(null); routing.reset() }} disabled={busy || unavailable}>
                  <SelectTrigger id={`graph-target-${project.id}`}
                    aria-label="Target project" data-slot="graph-target-project"
                    className="min-w-0 flex-1" size="sm">
                    <SelectValue placeholder="Choose a registered project…" />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {peers.map((peer) => (
                      <SelectItem key={peer.id} value={peer.id}>{peer.name} ({peer.id})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm" type="button" data-action="graph-add-link"
                  disabled={!target || busy || unavailable}
                  onClick={addLink}
                >
                  Link
                </Button>
              </div>
              <p className="mt-1 text-meta text-soft-foreground">
                Each relation goes from {project.name} to the selected target.
                A feature-provider relation uses provider → consumer direction.
              </p>
            </div>
            <div className="border-t border-border pt-2">
              <p className="text-label font-medium">Existing relationships</p>
              {related.length === 0 ? (
                <p className="mt-1 text-label text-soft-foreground">No relationships yet.</p>
              ) : (
                <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto">
                  {related.map((link) => (
                    <li key={`${link.from}:${link.to}:${link.type}`} className="flex items-center justify-between gap-2 text-label">
                      <span className="min-w-0 break-words">
                        {link.from} <span className="text-soft-foreground">→ {link.type} →</span> {link.to}
                      </span>
                      <Button
                        type="button" size="icon" variant="ghost" disabled={busy}
                        data-action="graph-remove-link"
                        aria-label={`Remove ${link.type} link from ${link.from} to ${link.to}`}
                        onClick={() => removeLink(link)}
                      >
                        <XIcon className="size-3.5" aria-hidden="true" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="border-t border-border pt-2" data-slot="project-plan-preview">
              <p className="text-label font-medium">Parallel readiness (preview only)</p>
              <p className="text-meta text-soft-foreground">
                Independent repositories remain eligible for planning even when another dependency chain is blocked.
                No agents are started here.
              </p>
              {plan.isPending ? <p className="mt-1 text-label text-soft-foreground">Checking dependencies…</p> : null}
              {plan.isError ? (
                <p className="mt-1 text-label text-danger" role="status">Plan unavailable: {plan.error.message}</p>
              ) : null}
              {plan.data ? (
                <>
                  <p className="mt-1 text-label" data-slot="project-plan-counts">
                    {plan.data.waves.flat().length} ready in {plan.data.waves.length} wave(s);
                    {' '}{plan.data.blocked.length} blocked
                  </p>
                  <ul className="mt-1 max-h-32 space-y-1 overflow-y-auto text-label" data-slot="project-plan-waves">
                    {plan.data.waves.map((wave, index) => (
                      <li key={index}>
                        <span className="font-medium">Wave {index + 1}:</span> {wave.join(', ')}
                      </li>
                    ))}
                  </ul>
                  {plan.data.blocked.filter((item) => item.id === project.id).map((item) => (
                    <p key={item.id} className="mt-2 text-label text-danger" data-slot="project-plan-blocked">
                      This project is blocked: {item.reason}
                      {item.blockedBy.length > 0 ? ` (by ${item.blockedBy.join(', ')})` : ''}
                    </p>
                  ))}
                </>
              ) : null}
            </div>
            <div className="border-t border-border pt-2" data-slot="project-routing-preview">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-label font-medium">Execution target check</p>
                  <p className="text-meta text-soft-foreground">
                    Verify whether this product can use the target selected above for a future native agent job.
                    This check never queues work.
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-action="graph-preview-route"
                  disabled={!target || busy || routing.isPending}
                  onClick={() => {
                    setCheckedExecutionId(target)
                    routing.mutate({ logicalProjectId: project.id, executionProjectId: target })
                  }}
                >
                  Check
                </Button>
              </div>
              {routing.isPending && checkedExecutionId === target ? (
                <p className="mt-1 text-label text-soft-foreground">Validating execution checkout…</p>
              ) : null}
              {routing.isError && checkedExecutionId === target ? (
                <p role="alert" className="mt-1 text-label text-danger">
                  Route check failed: {routing.error.message}
                </p>
              ) : null}
              {routing.data && checkedExecutionId === target ? (
                <p
                  role="status"
                  className={routing.data.eligible ? 'mt-1 text-label text-foreground' : 'mt-1 text-label text-danger'}
                  data-slot="project-routing-result"
                >
                  {routing.data.eligible
                    ? `Target is eligible for planning: ${routing.data.executionProjectId}. Actual admission still uses Cezar's native pool controls.`
                    : `Target unavailable: ${routing.data.reason}${routing.data.blockedReason ? ` (${routing.data.blockedReason})` : ''}`}
                </p>
              ) : null}
            </div>
            {graph.data.unresolvedLinks.length > 0 ? (
              <p className="text-meta text-soft-foreground">
                {graph.data.unresolvedLinks.length} unresolved relationship(s) in the workspace.
                Use CLI graph inspection to repair them.
              </p>
            ) : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
