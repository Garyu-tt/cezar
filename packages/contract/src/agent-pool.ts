import { z } from 'zod';

/** Native Cezar pool. Logical target is independent of physical provider capacity. */
export const agentPoolSetInputSchema = z.object({
  desired: z.number().int().min(0).max(500),
}).strict();
export type AgentPoolSetInput = z.infer<typeof agentPoolSetInputSchema>;

export const agentPoolJobInputSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/),
  task: z.string().trim().min(20).max(20_000),
  role: z.enum(['build', 'test', 'review', 'integration']).default('build'),
  readOnly: z.boolean().default(false),
}).strict();
export type AgentPoolJobInput = z.infer<typeof agentPoolJobInputSchema>;

export const agentPoolEnqueueInputSchema = z.object({
  jobs: z.array(agentPoolJobInputSchema).min(1).max(100),
}).strict();
export type AgentPoolEnqueueInput = z.infer<typeof agentPoolEnqueueInputSchema>;

export const agentPoolJobStatusSchema = z.object({
  id: z.string(),
  role: z.enum(['build', 'test', 'review', 'integration']),
  state: z.enum(['pending', 'launching', 'launched', 'uncertain', 'blocked']),
  runId: z.string().optional(),
  nativeStatus: z.string().optional(),
  slot: z.number().int().optional(),
  title: z.string(),
});
export const agentPoolStatusSchema = z.object({
  desired: z.number().int(),
  resourceCap: z.number().int(),
  nativeActive: z.number().int(),
  waiting: z.number().int(),
  completed: z.number().int(),
  blocked: z.number().int(),
  jobs: z.array(agentPoolJobStatusSchema),
});
export type AgentPoolStatus = z.infer<typeof agentPoolStatusSchema>;
