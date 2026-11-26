import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime, { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { AssistantCompensationService } from '@dsh-ray/assistant-recovery'
import { acceptanceDigest } from '@dsh-ray/task-acceptance-contract'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compensateFailedSkillRun,
  type RecoveryCompensationExecutionRequest,
  type RecoveryCompensationExecutionResult,
} from '../src/compensation.js'
import {
  compensationDirective,
  createDefinition,
  type CreateDefinitionOptions,
  type VerifiedWorkflowSource,
} from '../src/definition.js'
import { AssistantSkillsService } from '../src/service.js'
import type { SkillDelegatedArmBinding } from '../src/store.js'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function makeAgent(ctx: Context, workspace: string, id = 'owner-session'): Agent {
  const sid = SessionId(id)
  const session = Session.create(sid, [], {
    version: SESSION_FORMAT_VERSION,
    id: sid,
    createdAt: 1,
    isSeeded: false,
    cwd: workspace,
    agentPreset: 'primary',
  })
  const value: Agent = {
    id: SessionId(id),
    options: { provider: 'fixture', model: 'fixture' },
    model: { current: () => ({ provider: 'fixture', model: 'fixture' }), select: () => {} },
    session,
    inbox: createInboxStub(),
    ctx: undefined as unknown as Context,
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx
  session.append('turn/start', { turn: 1 })
  return value
}

async function createCompensationFixture(options: {
  allowedTools?: string[]
  steps?: VerifiedWorkflowSource['steps']
  mountRealCompensation?: boolean
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-comp-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.restart())

  const owner = makeAgent(ctx, root)
  const ownerSession = String(owner.session.id)
  const scope = {
    principalId: 'owner',
    principalRecordId: 'owner-record',
    principalVersion: 1,
    workspace: root,
    preset: 'primary',
  }

  let abortOnEdit = false
  let denyCompensatingTool = false
  let toolExecuteHook: ((exec: ToolExecution) => Promise<void> | void) | undefined
  const toolLineage: { name: string; rootCallId: string; hasParent: boolean; args: unknown }[] = []

  const principal = (agent: Agent) => ({
    principalId: agent === owner ? 'owner' : 'foreign',
    principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 },
    scope: { workspace: root, preset: 'primary' },
  })

  ctx.provide('agents' as never, {
    get: (id: string) => (id === owner.id ? owner : undefined),
    list: () => [owner],
  } as never)
  ctx.provide('assistantDelivery' as never, {
    preferencePrincipalForAgent: principal,
    currentPreferenceTurn: principal,
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) => ({
      authorityId: input.authorityId,
      principalId: 'owner',
      principalRecordId: 'owner-record',
      principalVersion: 1,
      workspace: root,
      agentPreset: 'primary',
      bindingVersion: 1,
      generation: 1,
    }),
  } as never)
  ctx.provide('assistantVerifier' as never, {} as never)
  ctx.provide('assistantPolicy' as never, {
    evaluate: () => ({ effect: 'allow' }),
    authorize: () => ({ effect: 'allow' }),
    evaluateAgent: () => ({ effect: 'allow' }),
    authorizeAgent: () => ({ effect: 'allow' }),
    delegatedSkillToolPreauthorizationVersion: () => 1 as const,
    registerPreauthorizedTool: () => () => {},
  } as never)

  const defaultSteps: VerifiedWorkflowSource['steps'] = options.steps ?? [
    { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'after-step-1' } },
    { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
  ]

  const source: VerifiedWorkflowSource = {
    protocol: 'assistant-goals/verified-workflow-source/v1',
    scope,
    goal: {
      id: 'source-goal',
      definition: { version: 1, digest: 'a'.repeat(64), objective: 'Execute compensated workflow' },
      sessionId: ownerSession,
      nativeGoalId: 'native-source-goal',
    },
    runId: 'verified-run',
    turn: 1,
    acceptance: {
      contractId: 'contract',
      contractDigest: 'b'.repeat(64),
      receiptDigest: 'c'.repeat(64),
      verifiedAt: Date.now(),
      validUntil: Date.now() + 60_000,
    },
    steps: defaultSteps,
    failedObservations: [],
  }

  ctx.provide('assistantGoals' as never, {
    ctx,
    [Service.tracker]: { associate: 'assistantGoals', property: 'ctx' },
    inspectVerifiedWorkflowSource: () => source,
    inspectOwnerVerifiedWorkflowSource: async () => source,
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({
      scope,
      goalId,
      sessionId: ownerSession,
      goalExecutionRunId: `goal-execution-${goalId}`,
      nativeGoalId: `native-${goalId}`,
      definition: { version: 1, digest: 'd'.repeat(64) },
    }),
  } as never)

  await new Promise<void>(resolve => setImmediate(resolve))
  new SessionProjectionRegistry(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root })
  await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
  await ctx.plugin(FileTools)

  ctx.tools.register(defineTool({
    name: 'undo_notify',
    description: 'Compensating action tool',
    parameters: {
      action: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => `undone:${args.action}`,
  }))
  ctx.tools.register(defineTool({
    name: 'custom_mutator',
    description: 'Custom mutating tool without file preimage',
    parameters: {
      key: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => `mutated:${args.key}`,
  }))
  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: 'Read-only goal observation tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'goal-ok' }] },
    execute: async () => 'goal-ok',
  }))
  ctx.tools.register(defineTool({
    name: 'glob',
    description: 'Read-only glob observation tool',
    parameters: {
      path: { type: 'string' },
      pattern: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'glob-ok' }] },
    execute: async () => 'glob-ok',
  }))
  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Read-only grep observation tool',
    parameters: {
      path: { type: 'string' },
      pattern: { type: 'string', required: true },
    },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'grep-ok' }] },
    execute: async () => 'grep-ok',
  }))

  let activeRunAbort: AbortController | undefined
  ctx.on('tools/execute', async (exec: ToolExecution, next) => {
    toolLineage.push({
      name: exec.name,
      rootCallId: exec.rootCallId,
      hasParent: exec.parent !== undefined,
      args: exec.arguments,
    })
    if (toolExecuteHook !== undefined) {
      await toolExecuteHook(exec)
    }
    if (abortOnEdit && exec.name === 'edit') {
      activeRunAbort?.abort(new Error('aborted in flight'))
      throw new Error('aborted in flight')
    }
    return next()
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (denyCompensatingTool && exec.name === 'undo_notify') {
      return { kind: 'deny', reason: 'policy denied compensating tool' }
    }
    return next()
  })

  if (options.mountRealCompensation) {
    await ctx.plugin(AssistantCompensationService, {
      databasePath: join(root, 'recovery.sqlite'),
    })
  }

  await ctx.plugin(AssistantSkillsService, {
    databasePath: join(root, 'skills.sqlite'),
    allowedTools: options.allowedTools ?? ['read', 'glob', 'grep', 'get_goal', 'write', 'edit', 'undo_notify', 'custom_mutator'],
  })
  await expect.poll(() => ctx.tools.get('skill_run')).toBeDefined()

  const execute = async (toolName: string, args: Record<string, unknown>, controller = new AbortController()) => {
    activeRunAbort = controller
    try {
      const batch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId(`call-${Math.random().toString(36).slice(2)}`),
          name: toolName,
          arguments: JSON.stringify(args),
        }],
        agent: owner,
        signal: controller.signal,
      })
      return batch.results[0]!.result
    } finally {
      activeRunAbort = undefined
    }
  }

  const saveSkill = (saveOptions: CreateDefinitionOptions, expectedVersion = 0) =>
    ctx.assistantSkills.save(owner, 'source-goal', saveOptions, expectedVersion)

  return {
    root,
    ctx,
    owner,
    scope,
    source,
    toolLineage,
    setAbortEdit: (value: boolean) => { abortOnEdit = value },
    setDenyCompensatingTool: (value: boolean) => { denyCompensatingTool = value },
    setToolExecuteHook: (hook: ((exec: ToolExecution) => Promise<void> | void) | undefined) => { toolExecuteHook = hook },
    saveSkill,
    execute,
  }
}

describe('assistant-skills failure compensation (WP10)', () => {
  it('rollback-state restores pre-existing and newly-created files in reverse order and surfaces audit in skill_status', async () => {
    const f = await createCompensationFixture({
      steps: [
        { id: 'create-new', toolName: 'write', arguments: { file_path: 'created.txt', content: 'new-file-content' } },
        { id: 'modify-existing', toolName: 'write', arguments: { file_path: 'existing.txt', content: 'overwritten' } },
        { id: 'fail-edit', toolName: 'edit', arguments: { file_path: 'target.txt', old_string: 'missing', new_string: 'updated' } },
      ],
    })

    await writeFile(join(f.root, 'existing.txt'), 'original-before-run', 'utf8')
    await writeFile(join(f.root, 'target.txt'), 'present-without-match', 'utf8')

    f.saveSkill({
      name: 'rollback-workflow',
      description: 'Restores prior file state on failure.',
      compensation: 'rollback-state',
    })

    const runRes = await f.execute('skill_run', {
      goal_id: 'fresh-goal-1',
      name: 'rollback-workflow',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-rollback-1',
    })
    expect(runRes.isError).toBe(true)

    // Both step 1 (newly created) and step 2 (existing) must be rolled back!
    expect(existsSync(join(f.root, 'created.txt'))).toBe(false)
    expect(await readFile(join(f.root, 'existing.txt'), 'utf8')).toBe('original-before-run')

    // Extract run_id from error text and inspect via skill_status
    const errText = JSON.stringify(runRes)
    const runId = errText.match(/skill-run-[a-f0-9]{64}/u)![0]
    const statusRes = await f.execute('skill_status', { run_id: runId })
    expect(statusRes.isError).toBe(false)
    const status = JSON.parse((statusRes.value as { context: string }).context)
    expect(status.state).toBe('failed')
    expect(status.compensations).toHaveLength(2)
    // Reverse order: step 2 (modify-existing) before step 1 (create-new)
    expect(status.compensations.map((c: { stepId: string }) => c.stepId)).toEqual([
      'modify-existing',
      'create-new',
    ])
    expect(status.compensations.every((c: { status: string; preimageDigest?: string }) =>
      c.status === 'succeeded' && /^[a-f0-9]{64}$/u.test(c.preimageDigest ?? ''),
    )).toBe(true)

    // Failed run remains non-replayable and never re-compensates
    const retryRes = await f.execute('skill_run', {
      goal_id: 'fresh-goal-1',
      name: 'rollback-workflow',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-rollback-1',
    })
    expect(retryRes.isError).toBe(true)
  })

  it('compensating-action executes undo tool through ToolRuntime and fails closed when denied', async () => {
    const f = await createCompensationFixture({
      steps: [
        { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'v1' } },
        { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
      ],
    })
    await writeFile(join(f.root, 'b.txt'), 'does-not-match', 'utf8')

    f.saveSkill({
      name: 'action-comp-skill',
      description: 'Runs compensating tool step on failure.',
      compensation: 'compensating-action',
      compensationPlan: {
        kind: 'compensating-action',
        entries: [
          { stepId: 'step-1', toolName: 'undo_notify', arguments: { action: 'revert-a' } },
        ],
      },
    })

    const runRes = await f.execute('skill_run', {
      goal_id: 'fresh-goal-2',
      name: 'action-comp-skill',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-action-1',
    })
    expect(runRes.isError).toBe(true)
    const undoCall = f.toolLineage.find(entry => entry.name === 'undo_notify')
    expect(undoCall).toBeDefined()
    expect(undoCall?.hasParent).toBe(true)
    expect(undoCall?.args).toEqual({ action: 'revert-a' })

    const runId = JSON.stringify(runRes).match(/skill-run-[a-f0-9]{64}/u)![0]
    const statusRes = await f.execute('skill_status', { run_id: runId })
    const parsedStatus = JSON.parse((statusRes.value as { context: string }).context)
    expect(parsedStatus.compensations).toMatchObject([
      { stepId: 'step-1', compensationKind: 'compensating-action', toolName: 'undo_notify', status: 'succeeded' },
    ])

    // When Policy/pre-execute denies the compensating tool, audit records failed
    f.setDenyCompensatingTool(true)
    const deniedRun = await f.execute('skill_run', {
      goal_id: 'fresh-goal-3',
      name: 'action-comp-skill',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-action-2',
    })
    expect(deniedRun.isError).toBe(true)
    const deniedRunId = JSON.stringify(deniedRun).match(/skill-run-[a-f0-9]{64}/u)![0]
    const deniedStatus = JSON.parse(((await f.execute('skill_status', { run_id: deniedRunId })).value as { context: string }).context)
    expect(deniedStatus.compensations[0].status).toBe('failed')
  })

  it('compensate-via-registry invokes mocked assistantRecovery port and fails closed when standalone without registry', async () => {
    const f = await createCompensationFixture({
      steps: [
        { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'v1' } },
        { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
      ],
    })
    await writeFile(join(f.root, 'b.txt'), 'no-match', 'utf8')

    f.saveSkill({
      name: 'registry-comp-skill',
      description: 'Delegates compensation to recovery registry.',
      compensation: 'compensate-via-registry',
      compensationPlan: {
        kind: 'compensate-via-registry',
        entries: [{ stepId: 'step-1', compensatorKey: 'external.undo' }],
      },
    })

    // Standalone (no assistantRecovery / assistantCompensation mounted) -> fails closed
    const standaloneRes = await f.execute('skill_run', {
      goal_id: 'fresh-goal-standalone',
      name: 'registry-comp-skill',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-reg-none',
    })
    expect(standaloneRes.isError).toBe(true)
    const standaloneRunId = JSON.stringify(standaloneRes).match(/skill-run-[a-f0-9]{64}/u)![0]
    const standaloneStatus = JSON.parse(((await f.execute('skill_status', { run_id: standaloneRunId })).value as { context: string }).context)
    expect(standaloneStatus.compensations).toMatchObject([
      {
        stepId: 'step-1',
        compensationKind: 'compensate-via-registry',
        compensatorKey: 'external.undo',
        status: 'failed',
        detail: 'compensation-registry-unavailable',
      },
    ])

    // Provide mocked assistantRecovery port
    const executeSpy = vi.fn<
      (record: RecoveryCompensationExecutionRequest) => Promise<RecoveryCompensationExecutionResult>
    >(async () => ({
      status: 'succeeded',
      resultCode: 'mock-reverted',
      receiptDigest: 'e'.repeat(64),
    }))
    f.ctx.provide('assistantRecovery' as never, {
      executeCompensation: executeSpy,
      hasCompensator: (k: string) => k === 'external.undo',
    } as never)

    const mockedRes = await f.execute('skill_run', {
      goal_id: 'fresh-goal-mocked',
      name: 'registry-comp-skill',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-reg-mocked',
    })
    expect(mockedRes.isError).toBe(true)
    expect(executeSpy).toHaveBeenCalledTimes(1)
    expect(executeSpy.mock.calls[0]![0]).toMatchObject({
      kind: 'external.undo',
      sourcePlugin: 'dsh-ray-assistant-skills',
      stepId: 'step-1',
      scope: f.scope,
    })
    const mockedRunId = JSON.stringify(mockedRes).match(/skill-run-[a-f0-9]{64}/u)![0]
    const mockedStatus = JSON.parse(((await f.execute('skill_status', { run_id: mockedRunId })).value as { context: string }).context)
    expect(mockedStatus.compensations).toMatchObject([
      { stepId: 'step-1', status: 'succeeded', detail: 'mock-reverted' },
    ])
  })

  it('never auto-compensates unknown steps/runs and records skipped-unknown', async () => {
    const f = await createCompensationFixture({
      steps: [
        { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'after-1' } },
        { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
      ],
    })
    await writeFile(join(f.root, 'a.txt'), 'before-1', 'utf8')
    await writeFile(join(f.root, 'b.txt'), 'old', 'utf8')

    const executeSpy = vi.fn(async () => ({ status: 'succeeded' as const, resultCode: 'should-not-run' }))
    f.ctx.provide('assistantCompensation' as never, {
      executeCompensation: executeSpy,
      hasCompensator: () => true,
    } as never)

    f.saveSkill({
      name: 'unknown-fence-skill',
      description: 'Never compensates unknown execution.',
      compensation: 'rollback-state',
    })

    f.setAbortEdit(true)
    const abortedRes = await f.execute('skill_run', {
      goal_id: 'fresh-goal-unknown',
      name: 'unknown-fence-skill',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-unknown-1',
    })
    expect(abortedRes.isError).toBe(true)
    expect(executeSpy).not.toHaveBeenCalled()
    // File from step-1 stays at 'after-1' (NOT speculatively rolled back when step-2 is unknown)
    expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('after-1')

    const runId = JSON.stringify(abortedRes).match(/skill-run-[a-f0-9]{64}/u)![0]
    const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
    expect(status.state).toBe('unknown')
    expect(status.compensations).toMatchObject([
      { status: 'skipped-unknown', detail: 'unknown-execution-state-no-speculative-compensation' },
    ])
  })

  it('rejects symlinks and oversized files during preimage capture before executing mutating steps', async () => {
    const f = await createCompensationFixture({
      steps: [
        { id: 'sym-step', toolName: 'write', arguments: { file_path: 'link.txt', content: 'overwrite' } },
      ],
    })
    await writeFile(join(f.root, 'real.txt'), 'secret', 'utf8')
    await symlink(join(f.root, 'real.txt'), join(f.root, 'link.txt'))

    f.saveSkill({
      name: 'symlink-guard',
      description: 'Rejects symlinks in preimage capture.',
      compensation: 'rollback-state',
    })

    const symRes = await f.execute('skill_run', {
      goal_id: 'goal-sym',
      name: 'symlink-guard',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-sym-1',
    })
    expect(symRes.isError).toBe(true)
    // real.txt must remain untouched because preimage capture failed before dispatch
    expect(await readFile(join(f.root, 'real.txt'), 'utf8')).toBe('secret')

    // Oversized file > 256 KiB
    const big = await createCompensationFixture({
      steps: [
        { id: 'big-step', toolName: 'write', arguments: { file_path: 'big.txt', content: 'small' } },
      ],
    })
    await writeFile(join(big.root, 'big.txt'), 'x'.repeat(256 * 1024 + 1), 'utf8')
    big.saveSkill({
      name: 'size-guard',
      description: 'Rejects oversized preimages.',
      compensation: 'rollback-state',
    })
    const bigRes = await big.execute('skill_run', {
      goal_id: 'goal-big',
      name: 'size-guard',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-big-1',
    })
    expect(bigRes.isError).toBe(true)
    expect((await readFile(join(big.root, 'big.txt'), 'utf8')).length).toBe(256 * 1024 + 1)
  })

  it('integrates live AssistantCompensationService and AssistantSkillsService in the same Cordis Context', async () => {
    const f = await createCompensationFixture({
      mountRealCompensation: true,
      steps: [
        { id: 'step-1', toolName: 'write', arguments: { file_path: 'side-effect.txt', content: 'mutated' } },
        { id: 'step-2', toolName: 'edit', arguments: { file_path: 'missing.txt', old_string: 'a', new_string: 'b' } },
      ],
    })
    await writeFile(join(f.root, 'side-effect.txt'), 'initial-state', 'utf8')
    await writeFile(join(f.root, 'missing.txt'), 'zzzzz', 'utf8')

    const compService = f.ctx.get('assistantCompensation')!
    expect(compService).toBeDefined()

    const compensatedTargets: unknown[] = []
    let capturedPreimageInRecovery: unknown
    compService.registerCompensator?.({
      kind: 'fs.restore-via-recovery',
      category: 'rollback-state',
      compensate: async ({ record }) => {
        compensatedTargets.push(record.target)
        capturedPreimageInRecovery = record.preimage
        await writeFile(join(f.root, 'side-effect.txt'), 'restored-by-recovery', 'utf8')
        return {
          status: 'succeeded',
          resultCode: 'recovery-restored',
          receipt: { restoredFile: 'side-effect.txt' },
        }
      },
    })

    f.saveSkill({
      name: 'live-integrated-comp',
      description: 'End-to-end live recovery compensation.',
      compensation: 'compensate-via-registry',
      compensationPlan: {
        kind: 'compensate-via-registry',
        entries: [{ stepId: 'step-1', compensatorKey: 'fs.restore-via-recovery', capturePreimage: true }],
      },
    })

    const res = await f.execute('skill_run', {
      goal_id: 'goal-live-integration',
      name: 'live-integrated-comp',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-live-1',
    })
    expect(res.isError).toBe(true)
    expect(await readFile(join(f.root, 'side-effect.txt'), 'utf8')).toBe('restored-by-recovery')
    expect(compensatedTargets).toHaveLength(1)
    expect(capturedPreimageInRecovery).toMatchObject({
      existed: true,
      filePath: 'side-effect.txt',
      content: 'initial-state',
    })

    const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
    const statusRes = await f.execute('skill_status', { run_id: runId })
    const skillStatus = JSON.parse((statusRes.value as { context: string }).context)
    expect(skillStatus.state).toBe('failed')
    expect(skillStatus.compensations).toMatchObject([
      {
        runId,
        stepId: 'step-1',
        compensationKind: 'compensate-via-registry',
        compensatorKey: 'fs.restore-via-recovery',
        status: 'succeeded',
        detail: 'recovery-restored',
      },
    ])

    const recoveryRecords = compService.listCompensations?.({ runId }) ?? []
    expect(recoveryRecords).toHaveLength(1)
    expect(recoveryRecords[0]).toMatchObject({
      kind: 'fs.restore-via-recovery',
      sourcePlugin: 'dsh-ray-assistant-skills',
      runId,
      stepId: 'step-1',
      status: 'succeeded',
      resultCode: 'recovery-restored',
    })
    const audit = compService.listCompensationAudit?.(recoveryRecords[0]!.id) ?? []
    expect(audit.map(entry => entry.event)).toEqual(['capturing', 'prepared', 'dispatched', 'settled'])
  })

  it('rejects post-step leaf/parent-dir/dangling symlink and directory swaps in rollback-state without touching external victims', async () => {
    // 1. Leaf symlink swap (preimage.existed === true)
    {
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-victim-')))
      cleanups.push(() => rm(outside, { recursive: true, force: true }))
      const victimFile = join(outside, 'victim.txt')
      await writeFile(victimFile, 'DO-NOT-OVERWRITE', 'utf8')

      const f = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'new' } },
        ],
      })
      await writeFile(join(f.root, 'a.txt'), 'initial-a', 'utf8')
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      f.saveSkill({
        name: 'leaf-symlink-swap',
        description: 'Detects leaf symlink swap.',
        compensation: 'rollback-state',
      })
      f.setToolExecuteHook(async (exec) => {
        if (exec.name === 'edit') {
          await unlink(join(f.root, 'a.txt'))
          await symlink(victimFile, join(f.root, 'a.txt'))
        }
      })

      const res = await f.execute('skill_run', {
        goal_id: 'g-leaf-sym',
        name: 'leaf-symlink-swap',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-leaf-sym',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(victimFile, 'utf8')).toBe('DO-NOT-OVERWRITE')
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toMatchObject([
        { stepId: 'step-1', status: 'failed', detail: 'rollback-target-unsafe' },
      ])
    }

    // 2. Parent directory symlink swap (preimage.existed === true)
    {
      const outsideDir = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-victim-dir-')))
      cleanups.push(() => rm(outsideDir, { recursive: true, force: true }))
      const externalTarget = join(outsideDir, 'a.txt')
      await writeFile(externalTarget, 'DO-NOT-OVERWRITE', 'utf8')

      const f = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'sub/a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'new' } },
        ],
      })
      await mkdir(join(f.root, 'sub'), { recursive: true })
      await writeFile(join(f.root, 'sub', 'a.txt'), 'initial-a', 'utf8')
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      f.saveSkill({
        name: 'parent-symlink-swap',
        description: 'Detects parent directory symlink swap.',
        compensation: 'rollback-state',
      })
      f.setToolExecuteHook(async (exec) => {
        if (exec.name === 'edit') {
          await rm(join(f.root, 'sub'), { recursive: true, force: true })
          await symlink(outsideDir, join(f.root, 'sub'))
        }
      })

      const res = await f.execute('skill_run', {
        goal_id: 'g-parent-sym',
        name: 'parent-symlink-swap',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-parent-sym',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(externalTarget, 'utf8')).toBe('DO-NOT-OVERWRITE')
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toMatchObject([
        { stepId: 'step-1', status: 'failed', detail: 'rollback-target-unsafe' },
      ])
    }

    // 3. Directory replacement and dangling symlink replacement (preimage.existed === true)
    for (const mode of ['directory', 'dangling-symlink'] as const) {
      const f = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'new' } },
        ],
      })
      await writeFile(join(f.root, 'a.txt'), 'initial-a', 'utf8')
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      f.saveSkill({
        name: `swap-${mode}`,
        description: `Detects ${mode} swap.`,
        compensation: 'rollback-state',
      })
      f.setToolExecuteHook(async (exec) => {
        if (exec.name === 'edit') {
          await unlink(join(f.root, 'a.txt'))
          if (mode === 'directory') {
            await mkdir(join(f.root, 'a.txt'))
          } else {
            await symlink(join(f.root, 'nonexistent-target.txt'), join(f.root, 'a.txt'))
          }
        }
      })

      const res = await f.execute('skill_run', {
        goal_id: `g-${mode}`,
        name: `swap-${mode}`,
        version: 1,
        inputs_json: '{}',
        invocation_id: `inv-${mode}`,
      })
      expect(res.isError).toBe(true)
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toMatchObject([
        { stepId: 'step-1', status: 'failed', detail: 'rollback-target-unsafe' },
      ])
    }

    // 4. Post-step symlink swap when preimage.existed === false (must fail as rollback-target-unsafe, not unlink/unknown)
    {
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'assistant-skills-victim-new-')))
      cleanups.push(() => rm(outside, { recursive: true, force: true }))
      const victimFile = join(outside, 'victim.txt')
      await writeFile(victimFile, 'DO-NOT-DELETE', 'utf8')

      const f = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'created.txt', content: 'created-content' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'new' } },
        ],
      })
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      f.saveSkill({
        name: 'new-file-symlink-swap',
        description: 'Detects post-step symlink swap on created file.',
        compensation: 'rollback-state',
      })
      f.setToolExecuteHook(async (exec) => {
        if (exec.name === 'edit') {
          await unlink(join(f.root, 'created.txt'))
          await symlink(victimFile, join(f.root, 'created.txt'))
        }
      })

      const res = await f.execute('skill_run', {
        goal_id: 'g-new-sym',
        name: 'new-file-symlink-swap',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-new-sym',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(victimFile, 'utf8')).toBe('DO-NOT-DELETE')
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toMatchObject([
        { stepId: 'step-1', status: 'failed', detail: 'rollback-target-unsafe' },
      ])
    }
  })

  it('restores externally deleted pre-existing files and settles externally deleted created files cleanly', async () => {
    const f = await createCompensationFixture({
      steps: [
        { id: 'step-existing', toolName: 'write', arguments: { file_path: 'existing.txt', content: 'mutated' } },
        { id: 'step-created', toolName: 'write', arguments: { file_path: 'created.txt', content: 'created' } },
        { id: 'step-fail', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'new' } },
      ],
    })
    await writeFile(join(f.root, 'existing.txt'), 'original-content', 'utf8')
    await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
    f.saveSkill({
      name: 'external-delete-rollback',
      description: 'Handles externally deleted files cleanly.',
      compensation: 'rollback-state',
    })
    f.setToolExecuteHook(async (exec) => {
      if (exec.name === 'edit') {
        await unlink(join(f.root, 'existing.txt'))
        await unlink(join(f.root, 'created.txt'))
      }
    })

    const res = await f.execute('skill_run', {
      goal_id: 'g-ext-del',
      name: 'external-delete-rollback',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-ext-del',
    })
    expect(res.isError).toBe(true)
    expect(await readFile(join(f.root, 'existing.txt'), 'utf8')).toBe('original-content')
    expect(existsSync(join(f.root, 'created.txt'))).toBe(false)

    const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
    const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
    expect(status.compensations).toMatchObject([
      { stepId: 'step-created', status: 'succeeded', detail: 'rollback-already-absent' },
      { stepId: 'step-existing', status: 'succeeded', detail: 'rollback-restored' },
    ])
  })

  it('skips non-mutating and unmapped steps cleanly across rollback-state, compensating-action, and compensate-via-registry while failing closed on missing mutator/handler/preimage', async () => {
    // 1. Mixed [read, write, edit(fails)] under rollback-state
    {
      const f = await createCompensationFixture({
        steps: [
          { id: 'step-read', toolName: 'read', arguments: { file_path: 'info.txt' } },
          { id: 'step-write', toolName: 'write', arguments: { file_path: 'out.txt', content: 'mutated' } },
          { id: 'step-edit', toolName: 'edit', arguments: { file_path: 'target.txt', old_string: 'missing', new_string: 'next' } },
        ],
      })
      await writeFile(join(f.root, 'info.txt'), 'read-only', 'utf8')
      await writeFile(join(f.root, 'out.txt'), 'initial-out', 'utf8')
      await writeFile(join(f.root, 'target.txt'), 'target-content', 'utf8')
      f.saveSkill({
        name: 'mixed-rollback',
        description: 'Skips read in rollback-state.',
        compensation: 'rollback-state',
      })
      const res = await f.execute('skill_run', {
        goal_id: 'g-mix-rb',
        name: 'mixed-rollback',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-mix-rb',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(join(f.root, 'out.txt'), 'utf8')).toBe('initial-out')
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toHaveLength(1)
      expect(status.compensations[0]).toMatchObject({
        stepId: 'step-write',
        status: 'succeeded',
        detail: 'rollback-restored',
      })
    }

    // 2. Mixed [read, glob, grep, get_goal, write, edit(fails)] under compensating-action & compensate-via-registry
    for (const mode of ['compensating-action', 'compensate-via-registry-planned', 'compensate-via-registry-unplanned'] as const) {
      const f = await createCompensationFixture({
        steps: [
          { id: 's-read', toolName: 'read', arguments: { file_path: 'info.txt' } },
          { id: 's-glob', toolName: 'glob', arguments: { pattern: '*.txt' } },
          { id: 's-grep', toolName: 'grep', arguments: { pattern: 'x' } },
          { id: 's-goal', toolName: 'get_goal', arguments: {} },
          { id: 's-write', toolName: 'write', arguments: { file_path: 'out.txt', content: 'mutated' } },
          { id: 's-edit', toolName: 'edit', arguments: { file_path: 'target.txt', old_string: 'missing', new_string: 'next' } },
        ],
      })
      await writeFile(join(f.root, 'info.txt'), 'read-only', 'utf8')
      await writeFile(join(f.root, 'target.txt'), 'target-content', 'utf8')

      if (mode === 'compensating-action') {
        f.saveSkill({
          name: 'mixed-action',
          description: 'Partial plan covering s-write.',
          compensation: 'compensating-action',
          compensationPlan: {
            kind: 'compensating-action',
            entries: [{ stepId: 's-write', toolName: 'undo_notify', arguments: { action: 'undo-w' } }],
          },
        })
      } else if (mode === 'compensate-via-registry-planned') {
        f.ctx.assistantSkills.registerCompensator('custom.undo', async () => ({
          status: 'succeeded',
          resultCode: 'custom-undone',
        }))
        f.saveSkill({
          name: 'mixed-reg-planned',
          description: 'Partial registry plan covering s-write.',
          compensation: 'compensate-via-registry',
          compensationPlan: {
            kind: 'compensate-via-registry',
            entries: [{ stepId: 's-write', compensatorKey: 'custom.undo' }],
          },
        })
      } else {
        f.ctx.assistantSkills.registerCompensator('skill.mixed-reg-unplanned.s-write', async () => ({
          status: 'succeeded',
          resultCode: 'default-key-undone',
        }))
        f.saveSkill({
          name: 'mixed-reg-unplanned',
          description: 'Registry without explicit plan.',
          compensation: 'compensate-via-registry',
        })
      }

      const skillName = mode === 'compensating-action'
        ? 'mixed-action'
        : mode === 'compensate-via-registry-planned'
          ? 'mixed-reg-planned'
          : 'mixed-reg-unplanned'
      const res = await f.execute('skill_run', {
        goal_id: `g-${mode}`,
        name: skillName,
        version: 1,
        inputs_json: '{}',
        invocation_id: `inv-${mode}`,
      })
      expect(res.isError).toBe(true)
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toHaveLength(1)
      expect(status.compensations[0]).toMatchObject({ stepId: 's-write', status: 'succeeded' })
    }

    // 3. Fail-closed negative cases:
    // (a) compensating-action with plan entry toolName removed from allowedTools
    {
      const f = await createCompensationFixture({
        allowedTools: ['read', 'write', 'edit', 'undo_notify'],
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'v1' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'next' } },
        ],
      })
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      const saved = f.saveSkill({
        name: 'disallowed-action-tool',
        description: 'Compensating tool removed from allowedTools.',
        compensation: 'compensating-action',
        compensationPlan: {
          kind: 'compensating-action',
          entries: [{ stepId: 'step-1', toolName: 'undo_notify', arguments: { action: 'undo' } }],
        },
      })
      const store = {
        claimCompensation: () => ({
          claimed: true,
          record: {
            id: 'comp-disallowed-act',
            runId: 'run-disallowed-act',
            skillName: 'disallowed-action-tool',
            version: 1,
            stepId: 'step-1',
            compensationKind: 'compensating-action',
            idempotencyKey: 'idem-disallowed-act',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        }),
        finishCompensation: vi.fn(),
        listCompensations: () => [{
          id: 'comp-disallowed-act',
          runId: 'run-disallowed-act',
          skillName: 'disallowed-action-tool',
          version: 1,
          stepId: 'step-1',
          compensationKind: 'compensating-action',
          idempotencyKey: 'idem-disallowed-act',
          status: 'failed',
          detail: 'compensating-action-unavailable',
          createdAt: 1,
          updatedAt: 1,
        }],
      }
      const records = await compensateFailedSkillRun({
        ctx: f.ctx,
        store: store as never,
        scope: f.scope,
        runId: 'run-disallowed-act',
        definition: saved,
        directive: compensationDirective('compensating-action'),
        completed: [{ id: 'step-1', state: 'succeeded' }],
        preimages: new Map(),
        allowedTools: ['read', 'write', 'edit'],
        toolsCtx: f.ctx,
        exec: { callId: 'c1', rootCallId: 'r1', agent: f.owner, deferContext: () => {} } as never,
        signal: new AbortController().signal,
        localHandlers: new Map(),
      })
      expect(store.finishCompensation).toHaveBeenCalledWith(
        f.scope,
        'comp-disallowed-act',
        'failed',
        'compensating-action-unavailable',
      )
      expect(records).toMatchObject([
        { stepId: 'step-1', status: 'failed', detail: 'compensating-action-unavailable' },
      ])
    }

    // (b) compensate-via-registry with unregistered compensatorKey
    {
      const f = await createCompensationFixture({
        mountRealCompensation: true,
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'v1' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'next' } },
        ],
      })
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      f.saveSkill({
        name: 'missing-reg-handler',
        description: 'Unregistered compensatorKey fails closed.',
        compensation: 'compensate-via-registry',
        compensationPlan: {
          kind: 'compensate-via-registry',
          entries: [{ stepId: 'step-1', compensatorKey: 'missing.handler' }],
        },
      })
      const res = await f.execute('skill_run', {
        goal_id: 'g-neg-reg',
        name: 'missing-reg-handler',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-neg-reg',
      })
      expect(res.isError).toBe(true)
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toMatchObject([
        { stepId: 'step-1', status: 'failed', detail: 'handler-not-registered' },
      ])
    }

    // (c) rollback-state with non-observation custom mutator tool lacking a preimage
    {
      const f = await createCompensationFixture({
        steps: [
          { id: 'step-mut', toolName: 'custom_mutator', arguments: { key: 'k1' } },
          { id: 'step-fail', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'missing', new_string: 'next' } },
        ],
      })
      await writeFile(join(f.root, 'b.txt'), 'present-b', 'utf8')
      f.saveSkill({
        name: 'custom-mutator-rollback',
        description: 'Custom mutator fails closed without preimage.',
        compensation: 'rollback-state',
      })
      const res = await f.execute('skill_run', {
        goal_id: 'g-neg-mut',
        name: 'custom-mutator-rollback',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-neg-mut',
      })
      expect(res.isError).toBe(true)
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await f.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.compensations).toMatchObject([
        { stepId: 'step-mut', status: 'failed', detail: 'rollback-preimage-unavailable' },
      ])
    }

    // (d) compensate-via-registry with declared capturePreimage: true when preimage is missing
    {
      const f = await createCompensationFixture()
      const store = {
        claimCompensation: () => ({
          claimed: true,
          record: {
            id: 'comp-missing-pre',
            runId: 'run-missing-pre',
            skillName: 'reg-preimage-required',
            version: 1,
            stepId: 'step-1',
            compensationKind: 'compensate-via-registry',
            idempotencyKey: 'idem-missing-pre',
            status: 'pending',
            createdAt: 1,
            updatedAt: 1,
          },
        }),
        finishCompensation: vi.fn(),
        listCompensations: () => [{
          id: 'comp-missing-pre',
          runId: 'run-missing-pre',
          skillName: 'reg-preimage-required',
          version: 1,
          stepId: 'step-1',
          compensationKind: 'compensate-via-registry',
          idempotencyKey: 'idem-missing-pre',
          status: 'failed',
          detail: 'rollback-preimage-unavailable',
          createdAt: 1,
          updatedAt: 1,
        }],
      }
      const def = createDefinition(
        f.source,
        {
          name: 'reg-preimage-required',
          description: 'Requires preimage on step-1.',
          compensation: 'compensate-via-registry',
          compensationPlan: {
            kind: 'compensate-via-registry',
            entries: [{ stepId: 'step-1', compensatorKey: 'ext.undo', capturePreimage: true }],
          },
        },
        ['read', 'write', 'edit'],
      )
      const handlerSpy = vi.fn(() => ({ status: 'succeeded' as const, resultCode: 'should-not-run' }))
      const records = await compensateFailedSkillRun({
        ctx: f.ctx,
        store: store as never,
        scope: f.scope,
        runId: 'run-missing-pre',
        definition: { ...def, version: 1 },
        directive: compensationDirective('compensate-via-registry'),
        completed: [{ id: 'step-1', state: 'succeeded' }],
        preimages: new Map(),
        allowedTools: ['read', 'write', 'edit'],
        toolsCtx: f.ctx,
        exec: { callId: 'c1', rootCallId: 'r1', agent: f.owner, deferContext: () => {} } as never,
        signal: new AbortController().signal,
        localHandlers: new Map([['ext.undo', handlerSpy]]),
      })
      expect(handlerSpy).not.toHaveBeenCalled()
      expect(store.finishCompensation).toHaveBeenCalledWith(
        f.scope,
        'comp-missing-pre',
        'failed',
        'rollback-preimage-unavailable',
      )
      expect(records[0]).toMatchObject({ status: 'failed', detail: 'rollback-preimage-unavailable' })
    }
  })

  it('isolates delegated benchmark arm compensation to recipient, respects unknown fence, and bounds noncooperative compensators on mount dispose', async () => {
    const mountDelegated = async (
      source: Awaited<ReturnType<typeof createCompensationFixture>>,
      recipient: Awaited<ReturnType<typeof createCompensationFixture>>,
      skillName: string,
      cellId: string,
    ) => {
      const issuer = source.ctx.get('assistantSkills' as never) as unknown as AssistantSkillsService
      const target = recipient.ctx.get('assistantSkills' as never) as unknown as AssistantSkillsService
      const selection = { scope: source.scope, ownerRouteId: 'owner-route', skillName, version: 1 }
      const snapshot = await issuer.inspectOwnerBenchmarkArm(selection)
      const binding: SkillDelegatedArmBinding = {
        protocol: 'assistant-skills/delegated-arm/v1',
        planDigest: acceptanceDigest({ source: source.root, recipient: recipient.root }),
        cellId,
        variantId: 'native-tool-runtime',
        definitionDigest: snapshot.definitionDigest,
        sourceDigest: snapshot.sourceDigest,
        recipientScopeDigest: acceptanceDigest(recipient.scope),
        skillName: snapshot.definition.name,
        version: snapshot.version,
        expiresAt: snapshot.expiresAt,
      }
      const capability = await issuer.mintBenchmarkArm({
        selection,
        recipient: target,
        recipientScope: recipient.scope,
        recipientOwnerRouteId: 'owner-route',
        binding,
      })
      return { target, mounted: await target.mountBenchmarkArm(capability, binding) }
    }

    // 1. Delegated rollback-state on failed run restores recipient only, isolates source, and blocks replay
    {
      const source = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
        ],
      })
      const recipient = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
        ],
      })
      source.saveSkill({
        name: 'delegated-rb',
        description: 'Delegated rollback skill.',
        compensation: 'rollback-state',
      })
      await writeFile(join(source.root, 'a.txt'), 'source-untouched', 'utf8')
      await writeFile(join(recipient.root, 'a.txt'), 'recipient-initial', 'utf8')
      await writeFile(join(recipient.root, 'b.txt'), 'no-match', 'utf8')

      const { mounted } = await mountDelegated(source, recipient, 'delegated-rb', 'cell-rb-fail')
      const res = await recipient.execute('skill_run', {
        goal_id: 'g-del-fail',
        name: 'delegated-rb',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-del-fail',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(join(recipient.root, 'a.txt'), 'utf8')).toBe('recipient-initial')
      expect(await readFile(join(source.root, 'a.txt'), 'utf8')).toBe('source-untouched')

      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await recipient.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status).toMatchObject({
        state: 'failed',
        delegationDigest: mounted.bindingDigest,
        compensations: [{ stepId: 'step-1', status: 'succeeded', detail: 'rollback-restored' }],
      })
      // Replay of the failed delegated invocation must fail
      const replayRes = await recipient.execute('skill_run', {
        goal_id: 'g-del-fail',
        name: 'delegated-rb',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-del-fail',
      })
      expect(replayRes.isError).toBe(true)
      mounted.dispose()
    }

    // 2. mounted.dispose() aborting step 2 in flight settles unknown with skipped-unknown (no rollback)
    {
      const source = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
        ],
      })
      const recipient = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
        ],
      })
      source.saveSkill({
        name: 'delegated-rb-abort',
        description: 'Delegated rollback abort fence.',
        compensation: 'rollback-state',
      })
      await writeFile(join(recipient.root, 'a.txt'), 'recipient-initial', 'utf8')
      await writeFile(join(recipient.root, 'b.txt'), 'old', 'utf8')

      const { mounted } = await mountDelegated(source, recipient, 'delegated-rb-abort', 'cell-rb-abort')
      recipient.setToolExecuteHook(async (exec) => {
        if (exec.name === 'edit') {
          mounted.dispose()
        }
      })

      const res = await recipient.execute('skill_run', {
        goal_id: 'g-del-abort',
        name: 'delegated-rb-abort',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-del-abort',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(join(recipient.root, 'a.txt'), 'utf8')).toBe('mutated-a')
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await recipient.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.state).toBe('unknown')
      expect(status.compensations).toMatchObject([
        { status: 'skipped-unknown', detail: 'unknown-execution-state-no-speculative-compensation' },
      ])
    }

    // 3. Noncooperative local compensator in delegated run settles immediately on mounted.dispose() without hanging restart
    {
      const source = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
        ],
      })
      const recipient = await createCompensationFixture({
        steps: [
          { id: 'step-1', toolName: 'write', arguments: { file_path: 'a.txt', content: 'mutated-a' } },
          { id: 'step-2', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'old', new_string: 'new' } },
        ],
      })
      source.saveSkill({
        name: 'delegated-noncoop',
        description: 'Noncooperative compensator bound by benchmark signal.',
        compensation: 'compensate-via-registry',
        compensationPlan: {
          kind: 'compensate-via-registry',
          entries: [{ stepId: 'step-1', compensatorKey: 'noncoop.undo' }],
        },
      })
      await writeFile(join(recipient.root, 'a.txt'), 'recipient-initial', 'utf8')
      await writeFile(join(recipient.root, 'b.txt'), 'no-match', 'utf8')

      let compStarted!: () => void
      const compStartedGate = new Promise<void>((resolve) => { compStarted = resolve })
      const { target, mounted } = await mountDelegated(source, recipient, 'delegated-noncoop', 'cell-noncoop')
      target.registerCompensator('noncoop.undo', () => {
        compStarted()
        // Ignores signal completely!
        return new Promise(() => {})
      })

      const pendingRun = recipient.execute('skill_run', {
        goal_id: 'g-del-noncoop',
        name: 'delegated-noncoop',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-del-noncoop',
      })
      await compStartedGate
      mounted.dispose()

      const res = await pendingRun
      expect(res.isError).toBe(true)
      const runId = JSON.stringify(res).match(/skill-run-[a-f0-9]{64}/u)![0]
      const status = JSON.parse(((await recipient.execute('skill_status', { run_id: runId })).value as { context: string }).context)
      expect(status.state).toBe('failed')
      expect(status.compensations).toMatchObject([
        { stepId: 'step-1', status: 'unknown', detail: 'compensation-aborted-no-replay' },
      ])
      await recipient.ctx.fiber.restart()
    }
  })
})
