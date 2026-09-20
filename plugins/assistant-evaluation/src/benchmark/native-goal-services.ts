import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { NativeModelConfig } from './native.js'
import type { BenchmarkBudget } from './types.js'
import type { BenchmarkStrategyOwnerRuntime } from './strategy-owner.js'

export interface NativeGoalTask {
  objective: string
  publicPrompt: string
  artifactPath: string
  verification: { command: string; cases: readonly { stdin: string; expectedStdout: string; expectedExitCode: number }[]; maxDurationMs: number; maxOutputBytes: number }
}
export interface NativeGoalsHost {
  list(agent: Agent): readonly { id: string; native: { sessionId: string; objective: string } }[]
  registerBudgetMeter(input: unknown): () => void
  whenIdle(): Promise<void>
  inspectOwnerGoalExecution(input: { ownerRouteId: string; principalId: string; workspace: string; preset: string; sessionId: string; goalId: string }): Readonly<Record<string, unknown>>
}
type PluginConstructor = new (ctx: Context, config: never) => unknown
const plugin = (ctx: Context, value: unknown, config: unknown = {}) => ctx.plugin(value as PluginConstructor, config as never)

export async function installNativeGoalServices(input: {
  ctx: Context; owner: BenchmarkStrategyOwnerRuntime; model: NativeModelConfig; budget: BenchmarkBudget
  limits: { modelCalls: number; maxOutputTokensPerCall: number; maxGoalRounds: number; observationMode: NativeModelConfig['observationMode'] }
  task: NativeGoalTask; image: string; dockerPath: string; stepMaxDurationMs: number; enabledStrategy: boolean; assertLive: () => void; acceptanceValidityMs?: number
}): Promise<{ goals: NativeGoalsHost; ownerRouteId: string; principalId: string; lineage: ReturnType<BenchmarkStrategyOwnerRuntime['pairOwner']> }> {
  const { ctx, owner, model, budget, limits, task, image, dockerPath, stepMaxDurationMs, enabledStrategy, assertLive } = input
  const validityMs = input.acceptanceValidityMs ?? budget.durationMs
  if (!Number.isSafeInteger(validityMs) || validityMs < 1 || validityMs > 86400000) throw new Error('invalid native acceptance validity')
  const callCounting = limits.observationMode === 'observed-call-count'
  const names = ['@deepseek-ai/dsh-goal', '@deepseek-ai/dsh-tool-goal', '@deepseek-ai/dsh-goal-round-driver', '@deepseek-ai/dsh-subagent',
    '@dsh-enhanced/assistant-goals', '@dsh-enhanced/assistant-isolation', '@dsh-enhanced/assistant-verifier']
  const [native, tools, driver, subagents, goalsModule, isolationModule, verifierModule] = await Promise.all(names.map(name => import(name)))
  assertLive(); await plugin(ctx, native.default); assertLive(); await plugin(ctx, { inject: tools.inject, apply: tools.apply }); assertLive()
  await plugin(ctx, { inject: driver.inject, apply: driver.apply }); assertLive(); await plugin(ctx, subagents.SubagentRuntime); assertLive()
  await plugin(ctx, goalsModule.default, { databasePath: `${owner.runtimeRoot}/goals.sqlite`, verifyNativeRounds: true, verifyGoalOutcome: true,
    preauthorizedCreateMaxRounds: limits.maxGoalRounds, stepMaxDurationMs,
    ...(enabledStrategy ? { strategy: { maxDurationMs: Math.min(stepMaxDurationMs, 30000) } } : {}),
    executionBudget: callCounting
      ? { mode: 'calls' as const, modelCalls: limits.modelCalls, toolCalls: budget.toolCalls, durationMs: budget.durationMs, maxOutputTokensPerCall: limits.maxOutputTokensPerCall, routes: [{ provider: model.provider, model: model.model }] }
      : { ...budget, costUsdMicros: budget.costUsdMicros ?? undefined, modelCalls: limits.modelCalls, maxOutputTokensPerCall: limits.maxOutputTokensPerCall } })
  assertLive()
  const goals = ctx.get('assistantGoals' as never) as unknown as NativeGoalsHost
  if (typeof goals?.inspectOwnerGoalExecution !== 'function') throw new Error('upgrade Goals: owner execution snapshot API required')
  const lineage = owner.pairOwner(), principalId = owner.principalId, ownerRouteId = owner.ownerRouteId, expiresAt = Date.now() + budget.durationMs
  await plugin(ctx, isolationModule.default, { stateRoot: `${owner.runtimeRoot}/isolation`, image, dockerPath, limits: { maxDurationMs: Math.min(stepMaxDurationMs, 300000) }, grants: [{ id: 'benchmark-work', revision: 1,
    principalDigest: isolationModule.isolationPrincipalDigest(principalId), ...lineage, workspace: owner.workspace, agentPreset: 'benchmark', expiresAt, maxRuns: Math.max(1, budget.toolCalls), maxTotalDurationMs: budget.durationMs }] })
  assertLive()
  const authority = { kind: 'isolated-runner', id: 'benchmark-verification', stateRoot: `${owner.runtimeRoot}/verification-jobs`, image, dockerPath, command: task.verification.command, expiresAt,
    maxRuns: Math.min(10000, (limits.maxGoalRounds * 2 + 2) * task.verification.cases.length), maxTotalDurationMs: budget.durationMs, maxDurationMs: task.verification.maxDurationMs, maxOutputBytes: task.verification.maxOutputBytes, testSets: [{ id: 'cases', cases: task.verification.cases }] }
  const compiled = verifierModule.createVerifierAuthorities({ authorities: [authority] })[0]
  await plugin(ctx, verifierModule.AssistantVerifierService, { databasePath: `${owner.runtimeRoot}/verifier.sqlite`, tickIntervalMs: 0, requireAcceptance: false, authorities: [authority], profiles: ['goal-step', 'goal-outcome'].map(taskKind => ({ id: `benchmark-${taskKind}`, version: 1, taskKind,
    objective: task.objective, scope: { workspace: owner.workspace, preset: 'benchmark' }, owner: lineage, validityMs,
    bounds: { maxDurationMs: stepMaxDurationMs, maxEvidenceBytes: 8192 }, criteria: [{ id: 'artifact-behavior', kind: 'isolated-process-behavior', authority: { id: compiled.id, digest: compiled.digest }, artifactPath: task.artifactPath, testSetId: 'cases' }] })) })
  assertLive()
  return { goals, ownerRouteId, principalId, lineage }
}
