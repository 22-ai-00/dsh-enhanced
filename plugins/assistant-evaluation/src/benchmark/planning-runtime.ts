import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

type ToolJsonValue = null | boolean | number | string | ToolJsonValue[] | { [key: string]: ToolJsonValue }

export const planningRuntimeConfig = Object.freeze({
  protocol: 'native-planning-v1',
  store: 'sqlite',
  contextName: 'native-benchmark-plan',
  zeroToolMode: 'two-turn-plan-execute',
})

export const planningToolsConfig = Object.freeze({
  tools: ['plan_write', 'plan_read'],
  dagValidation: true,
})

export const planningPolicyConfig = Object.freeze({
  resource: { kind: 'planning', id: 'benchmark-plan' },
  enabledActions: ['read', 'write'],
  disabledActions: [],
})

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface BenchmarkPlanStep {
  readonly id: string
  readonly title: string
  readonly status: PlanStepStatus
  readonly dependsOn: readonly string[]
  readonly verification?: string
}

export interface BenchmarkPlanRecord {
  readonly revision: number
  readonly goal: string
  readonly steps: readonly BenchmarkPlanStep[]
  readonly assumptions: readonly string[]
  readonly draftText: string | null
  readonly updatedAtIso: string
}

export interface PlanningSnapshot {
  readonly enabled: boolean
  readonly revision: number
  readonly stepCount: number
  readonly pendingCount: number
  readonly completedCount: number
  readonly blockedCount: number
  readonly hasDraft: boolean
}

const VALID_STATUSES = new Set<PlanStepStatus>(['pending', 'in_progress', 'completed', 'blocked'])

export function validatePlanSteps(steps: readonly BenchmarkPlanStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 64) {
    throw new Error('plan must contain 1..64 steps')
  }
  const byId = new Map<string, BenchmarkPlanStep>()
  for (const step of steps) {
    if (typeof step.id !== 'string' || step.id.trim() === '' || typeof step.title !== 'string' || step.title.trim() === '') {
      throw new Error('plan step requires non-empty id and title')
    }
    if (!VALID_STATUSES.has(step.status)) {
      throw new Error(`invalid plan step status: ${String(step.status)}`)
    }
    if (byId.has(step.id)) {
      throw new Error(`duplicate plan step id: ${step.id}`)
    }
    if (!Array.isArray(step.dependsOn)) {
      throw new Error(`plan step dependsOn must be an array: ${step.id}`)
    }
    byId.set(step.id, step)
  }

  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id) {
        throw new Error(`plan step cannot depend on itself: ${step.id}`)
      }
      if (!byId.has(dep)) {
        throw new Error(`plan step ${step.id} depends on missing step: ${dep}`)
      }
    }
  }

  // Acyclic DAG check using 3-color DFS (0 = unvisited, 1 = visiting, 2 = visited)
  const color = new Map<string, 0 | 1 | 2>()
  for (const id of byId.keys()) color.set(id, 0)

  const visit = (id: string): void => {
    const state = color.get(id)
    if (state === 1) throw new Error(`cyclic plan dependency detected at step: ${id}`)
    if (state === 2) return
    color.set(id, 1)
    for (const dep of byId.get(id)!.dependsOn) {
      visit(dep)
    }
    color.set(id, 2)
  }

  for (const id of byId.keys()) {
    if (color.get(id) === 0) visit(id)
  }
}

export class BenchmarkPlanningStore {
  readonly dbPath: string
  readonly db: DatabaseSync

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.dbPath = join(stateDir, 'planning.sqlite')
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS plans (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        draft_text TEXT,
        updated_at_iso TEXT NOT NULL
      ) STRICT;
    `)
  }

  readPlan(): BenchmarkPlanRecord | null {
    const row = this.db.prepare(
      'SELECT revision, goal, steps_json AS stepsJson, assumptions_json AS assumptionsJson, draft_text AS draftText, updated_at_iso AS updatedAtIso FROM plans ORDER BY revision DESC LIMIT 1',
    ).get() as { revision: number; goal: string; stepsJson: string; assumptionsJson: string; draftText: string | null; updatedAtIso: string } | undefined
    if (row === undefined) return null
    return Object.freeze({
      revision: row.revision,
      goal: row.goal,
      steps: Object.freeze(JSON.parse(row.stepsJson) as BenchmarkPlanStep[]),
      assumptions: Object.freeze(JSON.parse(row.assumptionsJson) as string[]),
      draftText: row.draftText,
      updatedAtIso: row.updatedAtIso,
    })
  }

  writePlan(input: {
    readonly goal: string
    readonly steps: readonly BenchmarkPlanStep[]
    readonly assumptions?: readonly string[]
  }): BenchmarkPlanRecord {
    if (typeof input.goal !== 'string' || input.goal.trim() === '') {
      throw new Error('plan goal must be a non-empty string')
    }
    validatePlanSteps(input.steps)
    const assumptions = (input.assumptions ?? []).map(item => String(item))
    const normalizedSteps = input.steps.map(step => ({
      id: step.id,
      title: step.title,
      status: step.status,
      dependsOn: [...step.dependsOn],
      ...(step.verification === undefined ? {} : { verification: step.verification }),
    }))
    const updatedAtIso = new Date().toISOString()
    const current = this.readPlan()
    const result = this.db.prepare(
      'INSERT INTO plans (goal, steps_json, assumptions_json, draft_text, updated_at_iso) VALUES (?, ?, ?, ?, ?)',
    ).run(input.goal, JSON.stringify(normalizedSteps), JSON.stringify(assumptions), current?.draftText ?? null, updatedAtIso)
    const revision = Number(result.lastInsertRowid)
    return Object.freeze({
      revision,
      goal: input.goal,
      steps: Object.freeze(normalizedSteps),
      assumptions: Object.freeze(assumptions),
      draftText: current?.draftText ?? null,
      updatedAtIso,
    })
  }

  recordDraftPlan(draftText: string): BenchmarkPlanRecord {
    const trimmed = draftText.trim()
    if (trimmed.length === 0) throw new Error('draft plan cannot be empty')
    const current = this.readPlan()
    const updatedAtIso = new Date().toISOString()
    const result = this.db.prepare(
      'INSERT INTO plans (goal, steps_json, assumptions_json, draft_text, updated_at_iso) VALUES (?, ?, ?, ?, ?)',
    ).run(
      current?.goal ?? 'structured-execution-plan',
      JSON.stringify(current?.steps ?? []),
      JSON.stringify(current?.assumptions ?? []),
      trimmed,
      updatedAtIso,
    )
    const revision = Number(result.lastInsertRowid)
    return Object.freeze({
      revision,
      goal: current?.goal ?? 'structured-execution-plan',
      steps: current?.steps ?? Object.freeze([]),
      assumptions: current?.assumptions ?? Object.freeze([]),
      draftText: trimmed,
      updatedAtIso,
    })
  }

  close(): void {
    this.db.close()
  }
}

export function nativePlanningTurnPrompt(taskPrompt: string): string {
  return [
    '【规划阶段（第 1 步 / 共 2 步）】在给出最终答案前，先进行结构化任务分解：',
    '1. 列出关键子目标与约束条件（如时间先后、撤回生效、目标覆盖、单位换算、防注入过滤规则）；',
    '2. 列出需要核对的资料或状态 ID 及验证检查项；',
    '3. 本轮只输出结构化执行计划，不要输出最终 JSON 答案。',
    '',
    taskPrompt,
  ].join('\n')
}

export function nativePlanningExecutePrompt(): string {
  return '【执行阶段（第 2 步 / 共 2 步）】请严格按照上述规划与 <plan_state> 上下文执行核验，并只输出最终所要求的严格 JSON 对象（{"answer":...,"citations":[...]}），不要输出 Markdown 或额外解释。'
}

export interface BenchmarkPlanningHandle {
  readonly enabled: boolean
  readonly store: BenchmarkPlanningStore
  readonly allowedTools: readonly string[]
  evaluatePolicy(action: 'read' | 'write'): { readonly allowed: boolean; readonly reason: string }
  recordDraftPlan(draftText: string): BenchmarkPlanRecord
  snapshot(): PlanningSnapshot
  dispose(): void
}

export async function installBenchmarkPlanning(input: {
  readonly ctx: Context
  readonly stateDir: string
  readonly enabled: boolean
  readonly registerTools: boolean
}): Promise<BenchmarkPlanningHandle> {
  const store = new BenchmarkPlanningStore(input.stateDir)
  const disposers: Array<() => void> = []

  const evaluatePolicy = (action: 'read' | 'write'): { readonly allowed: boolean; readonly reason: string } => {
    if (!input.enabled) {
      return { allowed: false, reason: `planning policy denied ${action}: planning feature is disabled` }
    }
    return { allowed: true, reason: `planning policy allowed ${action}` }
  }

  const renderPlanContext = (): string => {
    if (!input.enabled) return ''
    const current = store.readPlan()
    if (current === null) {
      return '<plan_state revision="0" status="empty" pending="0" completed="0" blocked="0">Decompose sub-goals, constraints, dependencies, and verification checks before final output.</plan_state>'
    }
    const pendingCount = current.steps.filter(s => s.status === 'pending' || s.status === 'in_progress').length
    const completedCount = current.steps.filter(s => s.status === 'completed').length
    const blockedCount = current.steps.filter(s => s.status === 'blocked').length
    const lines: string[] = [
      `<plan_state revision="${current.revision}" pending="${pendingCount}" completed="${completedCount}" blocked="${blockedCount}">`,
      `Goal: ${current.goal}`,
    ]
    for (const step of current.steps) {
      const deps = step.dependsOn.length > 0 ? ` dependsOn=[${step.dependsOn.join(',')}]` : ''
      const verify = step.verification ? ` verify="${step.verification}"` : ''
      lines.push(`- [${step.status}] ${step.id}: ${step.title}${deps}${verify}`)
    }
    if (current.assumptions.length > 0) {
      lines.push(`Assumptions: ${current.assumptions.join('; ')}`)
    }
    if (current.draftText !== null) {
      lines.push('<draft_plan>')
      lines.push(current.draftText)
      lines.push('</draft_plan>')
    }
    lines.push('</plan_state>')
    return lines.join('\n')
  }

  disposers.push(
    input.ctx.systemPrompt.context({
      name: planningRuntimeConfig.contextName,
      order: 10,
      required: false,
      interpolate: false,
      text: () => renderPlanContext(),
    }),
  )

  if (input.registerTools) {
    const jsonOutput = {
      schema: { type: 'json' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    }

    disposers.push(
      input.ctx.tools.register(
        defineTool({
          name: 'plan_write',
          description: 'Create or update the structured execution plan DAG (validates unique step IDs and acyclic dependencies).',
          parameters: {
            goal: { type: 'string', required: true, description: 'Overall task execution goal.' },
            steps: {
              type: 'array',
              required: true,
              description: 'Ordered DAG steps.',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'], required: true },
                  dependsOn: { type: 'array', items: { type: 'string' } },
                  verification: { type: 'string' },
                },
              },
            },
            assumptions: { type: 'array', items: { type: 'string' }, description: 'Explicit assumptions.' },
          },
          output: jsonOutput,
          execute: async args => {
            const decision = evaluatePolicy('write')
            if (!decision.allowed) throw new Error(decision.reason)
            const steps = (args.steps as Array<{ id: string; title: string; status: PlanStepStatus; dependsOn?: string[]; verification?: string }>).map(s => ({
              id: s.id,
              title: s.title,
              status: s.status,
              dependsOn: s.dependsOn ?? [],
              ...(s.verification === undefined ? {} : { verification: s.verification }),
            }))
            const saved = store.writePlan({
              goal: args.goal as string,
              steps,
              ...(args.assumptions === undefined ? {} : { assumptions: args.assumptions as string[] }),
            })
            return {
              revision: saved.revision,
              stepCount: saved.steps.length,
              pending: saved.steps.filter(s => s.status === 'pending' || s.status === 'in_progress').length,
              completed: saved.steps.filter(s => s.status === 'completed').length,
              blocked: saved.steps.filter(s => s.status === 'blocked').length,
            }
          },
        }),
      ),
    )

    disposers.push(
      input.ctx.tools.register(
        defineTool({
          name: 'plan_read',
          description: 'Read the latest persisted structured execution plan.',
          parameters: {},
          output: jsonOutput,
          execute: async () => {
            const decision = evaluatePolicy('read')
            if (!decision.allowed) throw new Error(decision.reason)
            const current = store.readPlan()
            return (current === null
              ? { revision: 0, goal: null, steps: [], assumptions: [], draftText: null }
              : { revision: current.revision, goal: current.goal, steps: [...current.steps], assumptions: [...current.assumptions], draftText: current.draftText }) as unknown as ToolJsonValue
          },
        }),
      ),
    )
  }

  return Object.freeze({
    enabled: input.enabled,
    store,
    allowedTools: input.enabled && input.registerTools ? Object.freeze(['plan_write', 'plan_read']) : Object.freeze([]),
    evaluatePolicy,
    recordDraftPlan(draftText: string): BenchmarkPlanRecord {
      if (!input.enabled) throw new Error('cannot record draft plan when planning is disabled')
      return store.recordDraftPlan(draftText)
    },
    snapshot(): PlanningSnapshot {
      const current = store.readPlan()
      return Object.freeze({
        enabled: input.enabled,
        revision: current?.revision ?? 0,
        stepCount: current?.steps.length ?? 0,
        pendingCount: current?.steps.filter(s => s.status === 'pending' || s.status === 'in_progress').length ?? 0,
        completedCount: current?.steps.filter(s => s.status === 'completed').length ?? 0,
        blockedCount: current?.steps.filter(s => s.status === 'blocked').length ?? 0,
        hasDraft: current !== null && current.draftText !== null,
      })
    },
    dispose(): void {
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch {}
      }
      store.close()
    },
  })
}
