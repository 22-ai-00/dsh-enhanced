import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SessionStore,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecution, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantPolicyService, createPolicyToolGuard } from '../src/service.ts'
import { approvalReviewerOf, setApprovalReviewer } from '../src/approval-reviewer.ts'

const temporaryRoots: string[] = []

async function service(rules: NonNullable<ConstructorParameters<typeof AssistantPolicyService>[1]['rules']>) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-guard-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  return {
    ctx,
    service: new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules }),
  }
}

async function serviceWithConfig(
  config: Omit<ConstructorParameters<typeof AssistantPolicyService>[1], 'databasePath'>,
) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-guard-config-'))
  temporaryRoots.push(root)
  const ctx = new Context()
  return {
    ctx,
    service: new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), ...config }),
  }
}

function agent(options: { cwd?: string; preset?: string } = {}): Agent {
  const id = SessionId('session-primary')
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.preset === undefined ? {} : { agentPreset: options.preset }),
  })
  const inbox = new Inbox(session, {
    inserted() {},
    discarded() {},
    claimed() {},
  })
  const ctx = new Context()
  return {
    id,
    options: { provider: 'test-provider', model: 'test-model' },
    session,
    inbox,
    status: 'idle',
    ctx,
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
}

function execution(owner?: Agent): ToolExecution {
  return {
    callId: 'call-1' as ToolExecution['callId'],
    rootCallId: 'call-1' as ToolExecution['rootCallId'],
    name: 'bash',
    arguments: { command: 'pwd' },
    ...(owner === undefined ? {} : { agent: owner }),
    signal: new AbortController().signal,
    token: Symbol('tool-execution') as ToolExecutionToken,
  }
}

function appendSandboxMode(owner: Agent, mode: 'workspace-write' | 'danger-full-access'): void {
  const append = owner.session.append as unknown as (type: string, data: unknown) => unknown
  append.call(owner.session, 'sandbox/mode', { mode })
}

function provideCompatibleSessionPersistence(ctx: Context): void {
  ctx.provide('sessionPersistence' as never, {
    coordinator: {
      assertEventsSupported(_meta: unknown, events: readonly SessionEvent[]): void {
        for (const event of events) {
          if (KNOWN_SESSION_EVENT_TYPES.has(String(event.type)) || event.ignorable === true) continue
          throw new Error(`unknown required session event type "${String(event.type)}"`)
        }
      },
    },
  } as never)
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('DSH rc.8 tool guard', () => {
  test('fails closed before appending a native-full reviewer when no persistence reader is proven', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-native-full-registration-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const flush = vi.fn(async () => true)
    ctx.provide('sessions' as never, { flush, list: () => [] } as never)
    ctx.provide('permissionPresets' as never, {
      resolve: () => ({ sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }),
      current: () => 'legacy-full',
    } as never)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'future_external_tool',
      description: 'unproven reviewer registration fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    owner.session.append('permission/preset', { preset: 'legacy-full' })
    appendSandboxMode(owner, 'danger-full-access')
    owner.session.append('approval/policy', { policy: 'never' })
    owner.session.append('turn/start', { turn: 1 })

    const result = await ctx.tools.execute({
      callId: CallId('native-full-registration-unproven'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('migration could not be persisted')
    expect(executions).toBe(0)
    expect(flush).not.toHaveBeenCalled()
    expect(owner.session.events.some(event => event.type === 'assistant-policy/approval-reviewer')).toBe(false)
    await ctx.fiber.restart()
  })

  test('durably adopts an exact native full-access session before a risky tool executes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-native-full-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    let startFlush!: () => void
    const flushStarted = new Promise<void>(resolve => { startFlush = resolve })
    let releaseFlush!: () => void
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve })
    let flushed = false
    const flush = vi.fn(async () => {
      startFlush()
      await flushGate
      flushed = true
      return true
    })
    ctx.provide('sessions' as never, { flush, list: () => [] } as never)
    ctx.provide('permissionPresets' as never, {
      resolve: (name: string) => {
        if (name !== 'legacy-full') throw new Error(`unknown test preset: ${name}`)
        return { sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }
      },
      current: () => 'legacy-full',
    } as never)
    provideCompatibleSessionPersistence(ctx)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'future_external_tool',
      description: 'native full compatibility fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      async execute() {
        expect(flushed).toBe(true)
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    owner.session.append('permission/preset', { preset: 'legacy-full' })
    appendSandboxMode(owner, 'danger-full-access')
    owner.session.append('approval/policy', { policy: 'never' })
    owner.session.append('turn/start', { turn: 1 })

    const first = ctx.tools.execute({
      callId: CallId('native-full-adoption'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    await flushStarted
    let reconciliationSettled = false
    const reconciliation = ctx.assistantPolicy.reconcileNativeFullReviewer(owner.session)
      .then((result) => {
        reconciliationSettled = true
        return result
      })
    const second = ctx.tools.execute({
      callId: CallId('native-full-adoption-concurrent'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    await Promise.resolve()
    expect(executions).toBe(0)
    expect(reconciliationSettled).toBe(false)
    expect(flush).toHaveBeenCalledOnce()
    releaseFlush()
    const [results, reconciliationResult] = await Promise.all([
      Promise.all([first, second]),
      reconciliation,
    ])

    expect(results.every(result => result.isError === false)).toBe(true)
    expect(reconciliationResult).toBe('ready')
    expect(executions).toBe(2)
    expect(flush).toHaveBeenCalledOnce()
    expect(approvalReviewerOf(owner.session.events)).toBe('none')
    await ctx.fiber.restart()
  })

  test('shares the native-full durability barrier across Policy replacement instances', async () => {
    const roots = await Promise.all([
      mkdtemp(join(tmpdir(), 'assistant-policy-native-full-old-')),
      mkdtemp(join(tmpdir(), 'assistant-policy-native-full-new-')),
    ])
    temporaryRoots.push(...roots)
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    owner.session.append('permission/preset', { preset: 'legacy-full' })
    appendSandboxMode(owner, 'danger-full-access')
    owner.session.append('approval/policy', { policy: 'never' })
    owner.session.append('turn/start', { turn: 1 })
    let releaseFlush!: () => void
    let flushStartedResolve!: () => void
    const flushStarted = new Promise<void>(resolve => { flushStartedResolve = resolve })
    const flushGate = new Promise<boolean>(resolve => { releaseFlush = () => resolve(true) })
    let executions = 0

    const createPolicyContext = async (root: string, flush: (session: Session) => Promise<boolean>) => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      ctx.provide('sessions' as never, { flush, list: () => [] } as never)
      ctx.provide('permissionPresets' as never, {
        resolve: () => ({ sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }),
        current: () => 'legacy-full',
      } as never)
      provideCompatibleSessionPersistence(ctx)
      ctx.tools.register(defineTool({
        name: 'future_external_tool',
        description: 'cross-instance native full fixture',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
        async execute() {
          executions += 1
          return 'executed'
        },
      }))
      await ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        toolDefaultEffect: 'allow',
        rules: [],
      })
      return ctx
    }

    const oldCtx = await createPolicyContext(roots[0]!, () => {
      flushStartedResolve()
      return flushGate
    })
    const oldExecution = oldCtx.tools.execute({
      callId: CallId('native-full-old-instance'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    await flushStarted

    // Simulate HMR mounting a fresh AssistantPolicy while the old instance has
    // already appended reviewer=none but has not crossed its durability bar.
    const newCtx = await createPolicyContext(roots[1]!, async () => {
      throw new Error('replacement must share the old migration flight')
    })
    const newExecution = newCtx.tools.execute({
      callId: CallId('native-full-new-instance'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    await Promise.resolve()
    expect(executions).toBe(0)

    releaseFlush()
    const results = await Promise.all([oldExecution, newExecution])
    expect(results.every(result => result.isError === false)).toBe(true)
    expect(executions).toBe(2)
    await Promise.all([oldCtx.fiber.restart(), newCtx.fiber.restart()])
  })

  test('persists a conservative reviewer after an ambiguous native-full migration flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-native-full-compensation-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const persisted: Session['events'][] = []
    const flush = vi.fn(async (session: Session) => {
      persisted.push(structuredClone(session.events))
      if (persisted.length === 1) throw new Error('persisted before acknowledgement')
      return true
    })
    ctx.provide('sessions' as never, { flush, list: () => [] } as never)
    ctx.provide('permissionPresets' as never, {
      resolve: () => ({ sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }),
      current: () => 'legacy-full',
    } as never)
    provideCompatibleSessionPersistence(ctx)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'future_external_tool',
      description: 'native full compensation fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    owner.session.append('permission/preset', { preset: 'legacy-full' })
    appendSandboxMode(owner, 'danger-full-access')
    owner.session.append('approval/policy', { policy: 'never' })
    owner.session.append('turn/start', { turn: 1 })

    const result = await ctx.tools.execute({
      callId: CallId('native-full-compensation'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('migration could not be persisted')
    expect(executions).toBe(0)
    expect(flush).toHaveBeenCalledTimes(2)
    expect(approvalReviewerOf(persisted[0]!)).toBe('none')
    expect(approvalReviewerOf(persisted[1]!)).toBe('user')
    expect(approvalReviewerOf(owner.session.events)).toBe('user')
    await ctx.fiber.restart()
  })

  test('keeps an unproven ambiguous native-full append fail-closed until conservative recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-native-full-reader-loss-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    new SessionStore(ctx)
    ctx.provide('permissionPresets' as never, {
      resolve: () => ({ sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }),
      current: () => 'legacy-full',
    } as never)
    provideCompatibleSessionPersistence(ctx)
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [],
    })
    const session = ctx.sessions.create(SessionId('native-full-reader-loss'), {
      meta: { cwd: '/work/alpha', agentPreset: 'primary', delegationDepth: 0 },
    })
    session.append('permission/preset', { preset: 'legacy-full' })
    const append = session.append as unknown as (type: string, data: unknown) => unknown
    append.call(session, 'sandbox/mode', { mode: 'danger-full-access' })
    session.append('approval/policy', { policy: 'never' })
    const persistence = ctx.get('sessionPersistence') as unknown as {
      coordinator: { assertEventsSupported(meta: unknown, events: readonly SessionEvent[]): void }
    }
    const provenCoordinator = persistence.coordinator
    const flush = vi.spyOn(ctx.sessions, 'flush')
      .mockImplementationOnce(async () => {
        persistence.coordinator = {
          assertEventsSupported: provenCoordinator.assertEventsSupported.bind(provenCoordinator),
        }
        throw new Error('reader disappeared after an ambiguous commit')
      })
      .mockImplementation(async () => true)
    try {
      expect(await ctx.assistantPolicy.reconcileNativeFullReviewer(session)).toBe('unavailable')
      expect(approvalReviewerOf(session.events)).toBe('none')
      expect(await ctx.assistantPolicy.reconcileNativeFullReviewer(session)).toBe('unavailable')
      expect(flush).toHaveBeenCalledOnce()

      persistence.coordinator = provenCoordinator
      expect(await ctx.assistantPolicy.reconcileNativeFullReviewer(session)).toBe('unavailable')
      expect(approvalReviewerOf(session.events)).toBe('user')
      expect(flush).toHaveBeenCalledTimes(2)
      expect(await ctx.assistantPolicy.reconcileNativeFullReviewer(session)).toBe('not-applicable')
    } finally {
      persistence.coordinator = provenCoordinator
      await ctx.fiber.restart()
    }
  })

  test('does not overwrite a newer reviewer choice when an old migration flush fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-native-full-stale-compensation-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    const flush = vi.fn(async () => {
      owner.session.append('permission/preset', { preset: 'guarded' })
      appendSandboxMode(owner, 'workspace-write')
      owner.session.append('approval/policy', { policy: 'ask' })
      setApprovalReviewer(owner.session, 'auto-review')
      throw new Error('old flush failed after a newer choice won')
    })
    ctx.provide('sessions' as never, { flush, list: () => [] } as never)
    ctx.provide('permissionPresets' as never, {
      resolve: (name: string) => name === 'legacy-full'
        ? { sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }
        : { sandbox: 'workspace-write', approval: 'ask', name: 'Guarded' },
      current: (events: Session['events']) => events.findLast(event => event.type === 'permission/preset')?.data.preset,
    } as never)
    provideCompatibleSessionPersistence(ctx)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'future_external_tool',
      description: 'stale compensation fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    owner.session.append('permission/preset', { preset: 'legacy-full' })
    appendSandboxMode(owner, 'danger-full-access')
    owner.session.append('approval/policy', { policy: 'never' })
    owner.session.append('turn/start', { turn: 1 })

    const result = await ctx.tools.execute({
      callId: CallId('native-full-stale-compensation'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })

    expect(result.isError).toBe(true)
    expect(executions).toBe(0)
    expect(flush).toHaveBeenCalledOnce()
    expect(approvalReviewerOf(owner.session.events)).toBe('auto-review')
    await ctx.fiber.restart()
  })

  test('does not authorize a risky tool when permissions are downgraded during the migration flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-native-full-downgrade-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    let startFlush!: () => void
    const flushStarted = new Promise<void>(resolve => { startFlush = resolve })
    let releaseFlush!: () => void
    let afterFlushResolved = (): void => {}
    const flushGate = new Promise<boolean>((resolve) => {
      releaseFlush = () => {
        resolve(true)
        // This runs after ensureNativeFullReviewer has resumed, rechecked its
        // fingerprint and resolved `ready`, but before tools/pre-execute's
        // awaiting continuation. The caller must fold live permission again.
        queueMicrotask(afterFlushResolved)
      }
    })
    const flush = vi.fn(() => {
      startFlush()
      return flushGate
    })
    ctx.provide('sessions' as never, { flush, list: () => [] } as never)
    ctx.provide('permissionPresets' as never, {
      resolve: (name: string) => name === 'legacy-full'
        ? { sandbox: 'danger-full-access', approval: 'never', name: 'Full access' }
        : { sandbox: 'workspace-write', approval: 'ask', name: 'Guarded' },
      current: (events: Session['events']) => events.findLast(event => event.type === 'permission/preset')?.data.preset,
    } as never)
    provideCompatibleSessionPersistence(ctx)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'future_external_tool',
      description: 'native full downgrade fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    owner.session.append('permission/preset', { preset: 'legacy-full' })
    appendSandboxMode(owner, 'danger-full-access')
    owner.session.append('approval/policy', { policy: 'never' })
    owner.session.append('turn/start', { turn: 1 })

    const execution = ctx.tools.execute({
      callId: CallId('native-full-downgrade'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    await flushStarted
    afterFlushResolved = () => {
      owner.session.append('permission/preset', { preset: 'guarded' })
      appendSandboxMode(owner, 'workspace-write')
      owner.session.append('approval/policy', { policy: 'ask' })
      setApprovalReviewer(owner.session, 'user')
    }
    releaseFlush()
    const result = await execution

    expect(result.isError).toBe(true)
    expect(executions).toBe(0)
    expect(approvalReviewerOf(owner.session.events)).toBe('user')
    expect(owner.session.events.findLast(event => event.type === 'approval/decided')?.data.outcome)
      .toBe('unavailable')
    await ctx.fiber.restart()
  })

  test('does not blame the user when approval policy rejects before any prompt is shown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-never-attribution-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'never' })
    let executions = 0
    ctx.tools.register(defineTool({
      // run_code is a reserved Code Mode presentation transport in rc.8 and
      // cannot be registered by a fixture; an unknown executable tool reaches
      // the same pre-execute/approval path that caused the screenshot.
      name: 'future_external_tool',
      description: 'approval attribution fixture',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    owner.session.append('turn/start', { turn: 1 })

    const result = await ctx.tools.execute({
      callId: CallId('approval-never-attribution'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })

    expect(executions).toBe(0)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('approval is disabled by session policy; no user approval was requested'),
      }),
    ])
    expect(JSON.stringify(result.content)).not.toContain('the user rejected')
    expect(owner.session.events.some(event => event.type === 'approval/asked')).toBe(false)
    expect(owner.session.events.some(event => event.type === 'approval/decided')).toBe(false)
    await ctx.fiber.restart()
  })

  test('registers the risk gate before the monotonic guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-risk-gate-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const executions: string[] = []
    for (const name of ['read', 'future_external_tool']) {
      ctx.tools.register(defineTool({
        name,
        description: `${name} risk fixture`,
        parameters: {},
        output: { schema: { type: 'string' }, render: (_arguments, value) => [{ type: 'text', text: value }] },
        async execute() {
          executions.push(name)
          return name
        },
      }))
    }
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      toolDefaultEffect: 'allow',
      rules: [],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    const read = await ctx.tools.execute({
      callId: CallId('risk-read'),
      name: 'read',
      arguments: { file_path: 'README.md' },
      signal: new AbortController().signal,
      agent: owner,
    })
    const unknown = await ctx.tools.execute({
      callId: CallId('risk-unknown'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })

    expect(read.isError).toBe(false)
    expect(unknown.isError).toBe(true)
    expect(executions).toEqual(['read'])

    owner.session.append('approval/policy', { policy: 'never' })
    setApprovalReviewer(owner.session, 'none')
    const incoherentNever = await ctx.tools.execute({
      callId: CallId('risk-incoherent-never'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    expect(incoherentNever.isError).toBe(true)
    expect(executions).toEqual(['read'])

    appendSandboxMode(owner, 'danger-full-access')
    const fullAccess = await ctx.tools.execute({
      callId: CallId('risk-full-access'),
      name: 'future_external_tool',
      arguments: {},
      signal: new AbortController().signal,
      agent: owner,
    })
    expect(fullAccess.isError).toBe(false)
    expect(executions).toEqual(['read', 'future_external_tool'])
    await ctx.fiber.restart()
  })

  test('can allow only unmatched tool executions without weakening other policy decisions', async () => {
    const fixture = await serviceWithConfig({
      toolDefaultEffect: 'allow',
      rules: [{
        id: 'deny-dangerous-tool',
        effect: 'deny',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'dangerous' },
      }],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({
      effect: 'allow',
      reasonCode: 'tool-default-allow',
    })
    expect(fixture.service.authorizeToolExecution({ ...execution(owner), name: 'dangerous' })).toMatchObject({
      effect: 'deny',
      reasonCode: 'rule-deny',
    })
    expect(fixture.service.authorizeAgent(
      owner,
      'read',
      { kind: 'filesystem', id: '/work/alpha/README.md' },
    )).toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
    expect(fixture.service.authorizeToolExecution(execution())).toMatchObject({
      effect: 'deny',
      reasonCode: 'missing-agent',
    })

    fixture.service.setEmergencyStop({ enabled: true, actor: 'owner', reason: 'incident' })
    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({
      effect: 'deny',
      reasonCode: 'emergency-stop',
    })
    await fixture.ctx.fiber.restart()
  })

  test('never bypasses an exhausted explicit tool budget in allow-default mode', async () => {
    const fixture = await serviceWithConfig({
      toolDefaultEffect: 'allow',
      rules: [{
        id: 'budget-bash',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'bash' },
        budget: { id: 'bash-calls', amount: 1 },
      }],
      budgets: [{ id: 'bash-calls', metric: 'calls', limit: 1, periodMs: 60_000, scope: 'subject' }],
    })
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({ effect: 'allow' })
    expect(fixture.service.authorizeToolExecution({
      ...execution(owner),
      callId: 'call-2' as ToolExecution['callId'],
    })).toMatchObject({ effect: 'deny', reasonCode: 'budget-exhausted' })
    await fixture.ctx.fiber.restart()
  })

  test('installs into the real rc.8 ToolRuntime and blocks before the tool body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-policy-real-tools-'))
    temporaryRoots.push(root)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let executions = 0
    ctx.tools.register(defineTool({
      name: 'probe',
      description: 'policy integration probe',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_arguments, value) => [{ type: 'text', text: value }],
      },
      async execute() {
        executions += 1
        return 'executed'
      },
    }))
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [{
        id: 'allow-probe',
        effect: 'allow',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'probe' },
      }],
    })

    const result = await ctx.tools.execute({
      callId: CallId('probe-call'),
      name: 'probe',
      arguments: {},
      signal: new AbortController().signal,
    })

    expect(executions).toBe(0)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('missing-agent') }),
    ])
    await ctx.fiber.restart()
  })

  test('fails closed without an agent, workspace, or preset identity', async () => {
    const fixture = await service([{
      id: 'allow-bash',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
    }])
    const guard = createPolicyToolGuard(fixture.service)

    expect(guard(execution())).toContain('missing-agent')
    expect(guard(execution(agent({ preset: 'primary' })))).toContain('missing-workspace')
    const relative = { session: { header: { cwd: 'relative/workspace', agentPreset: 'primary' } } } as unknown as Agent
    expect(guard(execution(relative))).toContain('missing-workspace')
    expect(guard(execution(agent({ cwd: '/work/alpha' })))).toContain('missing-agent-preset')
    await fixture.ctx.fiber.restart()
  })

  test('derives trusted identity from the rc.8 agent session header', async () => {
    const fixture = await service([{
      id: 'allow-primary-bash',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['foreground'] },
    }])
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    const guard = createPolicyToolGuard(fixture.service)

    expect(guard(execution(owner))).toBeUndefined()
    expect(fixture.service.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        actor: 'agent:primary',
        action: 'execute',
        outcome: 'allowed',
        reasonCode: 'rule-allow',
        details: {
          callId: 'call-1',
          rootCallId: 'call-1',
          arguments: { command: '[REDACTED]' },
        },
      }),
    ])
    await fixture.ctx.fiber.restart()
  })

  test('lets a trusted scheduler bind a background initiator for the agent lifetime', async () => {
    const fixture = await service([{
      id: 'allow-foreground-bash',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['foreground'] },
    }])
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })
    const guard = createPolicyToolGuard(fixture.service)
    const unbind = fixture.service.bindInitiator(owner, 'background')

    expect(guard(execution(owner))).toContain('default-deny')
    unbind()
    expect(guard(execution(owner))).toBeUndefined()
    await fixture.ctx.fiber.restart()
  })

  test('limits an external shell grant to the exact preset, workspace, and tool', async () => {
    const fixture = await service([{
      id: 'allow-external-standard-bash',
      effect: 'allow',
      subject: { kind: 'agent', id: 'standard', workspace: '/work/assistant' },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      context: { initiators: ['external'] },
    }])
    const owner = agent({ cwd: '/work/assistant', preset: 'standard' })
    const external = fixture.service.bindInitiator(owner, 'external')
    const guard = createPolicyToolGuard(fixture.service)

    expect(guard(execution(owner))).toBeUndefined()
    expect(guard({ ...execution(owner), name: 'future_sensitive_tool' })).toContain('default-deny')
    expect(guard(execution(agent({ cwd: '/work/other', preset: 'standard' })))).toContain('default-deny')
    expect(guard(execution(agent({ cwd: '/work/assistant', preset: 'primary' })))).toContain('default-deny')
    external()
    expect(guard(execution(owner))).toContain('default-deny')
    await fixture.ctx.fiber.restart()
  })

  test('binds external Agent authorization to the exact connector principal', async () => {
    const ownerPrincipal = 'lark/bot-1/tenant-a/ou_owner'
    const fixture = await service([{
      id: 'allow-lark-owner-agent',
      effect: 'allow',
      subject: {
        kind: 'agent',
        id: 'standard',
        workspace: '/work/assistant',
        principal: ownerPrincipal,
      },
      actions: ['execute', 'reply'],
      resource: { kind: '*', id: '*' },
      context: { initiators: ['external'] },
    }])
    const owner = agent({ cwd: '/work/assistant', preset: 'standard' })

    const unbindOwner = fixture.service.bindInitiator(owner, 'external', ownerPrincipal)
    expect(fixture.service.authorizeToolExecution(execution(owner))).toMatchObject({ effect: 'allow' })
    expect(fixture.service.authorizeAgent(owner, 'reply', { kind: 'message', id: 'binding-1' }))
      .toMatchObject({ effect: 'allow' })
    unbindOwner()

    for (const principal of [
      'lark/bot-2/tenant-a/ou_owner',
      'slack/bot-1/tenant-a/ou_owner',
    ]) {
      const unbindOther = fixture.service.bindInitiator(owner, 'external', principal)
      expect(fixture.service.authorizeToolExecution(execution(owner)))
        .toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
      expect(fixture.service.authorizeAgent(owner, 'reply', { kind: 'message', id: 'binding-1' }))
        .toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
      unbindOther()
    }
    await fixture.ctx.fiber.restart()
  })

  test('authorizes service operations from the same trusted agent identity and initiator binding', async () => {
    const fixture = await service([{
      id: 'allow-foreground-memory-search',
      effect: 'allow',
      subject: { kind: 'agent', id: 'primary', workspace: '/work/alpha' },
      actions: ['search'],
      resource: { kind: 'memory', id: 'visible' },
      context: { initiators: ['foreground'] },
    }])
    const owner = agent({ cwd: '/work/alpha', preset: 'primary' })

    expect(fixture.service.authorizeAgent(owner, 'search', { kind: 'memory', id: 'visible' }).effect)
      .toBe('allow')
    const unbind = fixture.service.bindInitiator(owner, 'background')
    expect(fixture.service.authorizeAgent(owner, 'search', { kind: 'memory', id: 'visible' }))
      .toMatchObject({ effect: 'deny', reasonCode: 'default-deny' })
    unbind()
    await fixture.ctx.fiber.restart()
  })
})
