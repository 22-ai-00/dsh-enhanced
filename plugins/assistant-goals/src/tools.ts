import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AssistantGoalsService } from './service.js'

const output = {
  schema: { type: 'object' as const, additionalProperties: false, properties: { context: { type: 'string' as const, required: true } } },
  render: (_args: unknown, value: { context: string }) => [{ type: 'text' as const, text: value.context }],
} as const
export function registerGoalTools(ctx: Context, service: AssistantGoalsService): void {
  ctx.tools.register(defineTool({
    name: 'goal_create',
    description: 'Create a native DSH goal from the current authenticated owner request and persist its business context. Requires a live owner human turn and explicit Policy permission. The native goal driver, if enabled by the Host, controls continuation.',
    parameters: { objective: { type: 'string', required: true }, max_goal_rounds: { type: 'integer' } }, output,
    async execute(args, exec) {
      return { context: service.describe(service.create(exec.agent, args.objective, args.max_goal_rounds)) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'goal_context',
    description: 'Inspect owner-scoped business goal history and next steps. Optional focus supplies context in this session without starting or transferring a native goal. Native completion and cited evidence are not verified success.',
    parameters: { goal_id: { type: 'string' }, focus: { type: 'boolean' } }, output,
    async execute(args, exec) {
      if (args.goal_id === undefined) {
        if (args.focus === true) throw new Error('goal_context focus requires goal_id')
        return { context: service.catalog(exec.agent) }
      }
      return { context: service.describeForAgent(exec.agent, (args.focus === true ? service.focus(exec.agent, args.goal_id) : service.inspect(exec.agent, args.goal_id)).id) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'goal_checkpoint',
    description: 'Save next step, blockers, expiring assumptions, evidence references and goal dependencies using version CAS. These are unverified planning notes; this cannot change the original objective, grant authority or mark success.',
    parameters: {
      goal_id: { type: 'string', required: true }, expected_version: { type: 'integer', required: true },
      next_step: { type: 'string', required: true },
      blockers: { type: 'array', items: { type: 'string' }, required: true },
      assumptions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        statement: { type: 'string', required: true }, expires_at: { type: 'integer', required: true },
      } } },
      evidence_refs: { type: 'array', required: true, items: { type: 'string' } },
      dependencies: { type: 'array', required: true, items: { type: 'string' } },
    }, output,
    async execute(args, exec) {
      return { context: service.describe(service.checkpoint(exec.agent, args.goal_id, args.expected_version, {
        nextStep: args.next_step, blockers: args.blockers, assumptions: args.assumptions.map(item => ({ statement: item.statement, expiresAt: item.expires_at })), evidenceRefs: args.evidence_refs, dependencies: args.dependencies,
      })) }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'goal_control',
    description: 'Edit, pause, resume, or clear the current session native goal that is bound to this business goal. Requires a live authenticated owner turn and Policy permission for the requested operation. expected_revision is the native goal revision; clearing retains the business goal tombstone and history.',
    parameters: {
      goal_id: { type: 'string', required: true }, expected_revision: { type: 'integer', required: true },
      operation: { type: 'string', required: true, enum: ['edit', 'pause', 'resume', 'clear'] },
      objective: { type: 'string' }, max_goal_rounds: { type: 'integer' },
    }, output,
    async execute(args, exec) {
      return { context: service.describe(service.control(exec.agent, {
        goalId: args.goal_id, expectedRevision: args.expected_revision, operation: args.operation as 'edit' | 'pause' | 'resume' | 'clear',
        ...(args.objective === undefined ? {} : { objective: args.objective }),
        ...(args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds }),
      })) }
    },
  }))
}
