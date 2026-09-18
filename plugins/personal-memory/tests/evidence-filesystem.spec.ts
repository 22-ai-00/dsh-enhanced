import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { revalidateFileEvidence } from '../src/evidence-filesystem.ts'
import type { EvidenceAnchor } from '../src/evidence-ledger.ts'
import type { OriginalToolEvidence } from '../src/evidence-runtime.ts'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'

const PATH = '/file'
const TARGET_KEY = 'target-key:/file'

function digest(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex')
}

interface ExecuteCall {
  name: string
  arguments: Record<string, unknown>
  parent: unknown
}

interface Harness {
  ctx: Context
  policy: { calls: Array<{ action: string; resource: unknown }>; effect: 'allow' | 'deny'; flipAfterExecute: boolean }
  exec: ToolExecution
  source: (overrides?: Partial<OriginalToolEvidence>) => OriginalToolEvidence
  anchor: (overrides?: Partial<EvidenceAnchor>) => EvidenceAnchor
  executeCalls: ExecuteCall[]
  setToolRegistered: (names: string[]) => void
  setExecuteError: (isError: boolean) => void
  setVersionSequence: (versions: number[]) => void
  setRetargetOnReplay: (retarget: boolean) => void
  setSwapDefinition: (swap: boolean) => void
  abort: () => void
}

class FsService extends Service {
  versionSequence = [7, 7]
  retargetOnReplay = false
  private resolveCount = 0
  constructor(ctx: Context) { super(ctx, 'fs') }
  reset() { this.versionSequence = [7, 7]; this.retargetOnReplay = false; this.resolveCount = 0 }
  async resolve(): Promise<FsTarget> {
    // A stable key normally; a swapped symlink presents a different key on re-resolve.
    const key = this.retargetOnReplay && this.resolveCount > 0 ? 'target-key:/other' : TARGET_KEY
    this.resolveCount++
    return { targetKey: key } as FsTarget
  }
  processPath(target: FsTarget): string {
    return String(target.targetKey) === 'target-key:/other' ? '/other' : PATH
  }
  async stat(target: FsTarget): Promise<FsInfo> {
    void target
    const index = Math.min(this.resolveCount - 1, this.versionSequence.length - 1)
    return { type: 'file', version: this.versionSequence[index] ?? this.versionSequence.at(-1) } as unknown as FsInfo
  }
}

class ToolsService extends Service {
  registered = new Set<string>(['read', 'read_image'])
  swapDefinition = false
  executeError = false
  executeCalls: ExecuteCall[] = []
  private getCount = new Map<string, number>()
  private definitions = new Map<string, object>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  reset() { this.registered = new Set(['read', 'read_image']); this.swapDefinition = false; this.executeError = false; this.executeCalls = []; this.getCount.clear(); this.definitions.clear() }
  get(name: string): object | undefined {
    if (!this.registered.has(name)) return undefined
    if (this.swapDefinition) return { name, generation: this.getCount.get(name) ?? 0 }
    // The production registry returns a stable definition reference across lookups;
    // cache one per tool so the revalidation identity check sees no spurious swap.
    let definition = this.definitions.get(name)
    if (definition === undefined) { definition = { name, generation: 0 }; this.definitions.set(name, definition) }
    this.getCount.set(name, (this.getCount.get(name) ?? 0) + 1)
    return definition
  }
  async execute(input: { name: string; arguments: Record<string, unknown>; parent: unknown }): Promise<{ isError: boolean; content: unknown }> {
    this.executeCalls.push({ name: input.name, arguments: input.arguments, parent: input.parent })
    return { isError: this.executeError, content: [{ type: 'text', text: 'ok' }] }
  }
}

class AgentsService extends Service {
  constructor(ctx: Context, private readonly agent: Agent) { super(ctx, 'agents') }
  get(): Agent { return this.agent }
}
class SessionsService extends Service {
  constructor(ctx: Context, private readonly session: unknown) { super(ctx, 'sessions') }
  get(): unknown { return this.session }
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  const session = { id: 'sess-1', header: { cwd: '/work' } }
  const agent = { id: 'agent-1', status: 'running', session } as unknown as Agent
  ctx.plugin(class extends AgentsService { constructor(c: Context) { super(c, agent) } })
  ctx.plugin(class extends SessionsService { constructor(c: Context) { super(c, session) } })
  const fs = new FsService(ctx)
  const tools = new ToolsService(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))

  const policy = {
    calls: [] as Array<{ action: string; resource: unknown }>,
    effect: 'allow' as 'allow' | 'deny',
    flipAfterExecute: false,
    authorizeAgent(_agent: unknown, action: string, resource: unknown) {
      this.calls.push({ action, resource })
      let effect = this.effect
      if (this.flipAfterExecute && this.calls.length > 1) effect = 'deny'
      return { effect }
    },
  }

  const abortController = new AbortController()
  const exec = {
    name: 'memory_read_evidence',
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    token: Symbol() as ToolExecutionToken,
    agent,
    signal: abortController.signal,
  } as unknown as ToolExecution

  const baseSource = (overrides: Partial<OriginalToolEvidence> = {}): OriginalToolEvidence => ({
    eventSeq: 11,
    toolName: 'read',
    callId: 'orig-call',
    callArguments: JSON.stringify({ file_path: PATH }),
    contentDigest: digest('content'),
    observedAt: 1_700_000_000_000,
    text: '{"content":[{"type":"text","text":"ok"}],"isError":false}',
    failed: false,
    ...overrides,
  })
  const baseAnchor = (overrides: Partial<EvidenceAnchor> = {}): EvidenceAnchor => ({
    reference: 'dsh-evidence:v1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    eventSeq: 11,
    toolName: 'read',
    callId: 'orig-call',
    contentDigest: digest('content'),
    sourcePath: PATH,
    sourceTargetDigest: digest(TARGET_KEY),
    observedAt: 1_700_000_000_000,
    ...overrides,
  })

  return {
    ctx,
    policy: policy as unknown as Harness['policy'],
    exec,
    source: baseSource,
    anchor: baseAnchor,
    executeCalls: tools.executeCalls,
    setToolRegistered: names => { tools.registered = new Set(names) },
    setExecuteError: isError => { tools.executeError = isError },
    setVersionSequence: versions => { fs.versionSequence = versions },
    setRetargetOnReplay: retarget => { fs.retargetOnReplay = retarget },
    setSwapDefinition: swap => { tools.swapDefinition = swap },
    abort: () => abortController.abort(),
  }
}

describe('revalidateFileEvidence', () => {
  test('read happy path replays read with persisted paging arguments', async () => {
    const h = await harness()
    const source = h.source({ callArguments: JSON.stringify({ file_path: PATH, offset: 10, limit: 20 }) })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, source, h.anchor())
    expect(ok).toBe(true)
    expect(h.executeCalls).toHaveLength(1)
    expect(h.executeCalls[0]!.name).toBe('read')
    expect(h.executeCalls[0]!.arguments).toEqual({ file_path: PATH, offset: 10, limit: 20 })
    // Nested replay is never a top-level observation (parent set), so it cannot self-anchor.
    expect(h.executeCalls[0]!.parent).toBe(h.exec.token)
  })

  test('read_image happy path replays read_image with only file_path and the shared read path gate', async () => {
    const h = await harness()
    const source = h.source({ toolName: 'read_image', callArguments: JSON.stringify({ file_path: PATH }) })
    const anchor = h.anchor({ toolName: 'read_image' })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, source, anchor)
    expect(ok).toBe(true)
    expect(h.executeCalls).toHaveLength(1)
    expect(h.executeCalls[0]!.name).toBe('read_image')
    // The production read_image schema accepts only file_path; nothing else may be forwarded.
    expect(Object.keys(h.executeCalls[0]!.arguments).sort()).toEqual(['file_path'])
    expect(h.executeCalls[0]!.arguments.file_path).toBe(PATH)
    // Security pin: read_image must be path-gated with the SAME filesystem read action as read,
    // never a newly invented action that no host policy rule could grant.
    expect(h.policy.calls.every(call => call.action === 'read')).toBe(true)
    expect(h.policy.calls[0]!.resource).toEqual({ kind: 'filesystem', id: PATH })
  })

  test('fails closed when the source tool result was already a failure', async () => {
    const h = await harness()
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source({ failed: true }), h.anchor())
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test.each(['write', 'read_image_evidence', 'glob', ''])('fails closed for a non-revalidatable tool name (%s)', async toolName => {
    const h = await harness()
    const ok = await revalidateFileEvidence(
      h.ctx, h.policy as unknown as AssistantPolicyService, h.exec,
      h.source({ toolName }), h.anchor({ toolName }),
    )
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('anchor/tool mismatch fails closed', async () => {
    const h = await harness()
    const imageSource = h.source({ toolName: 'read_image', callArguments: JSON.stringify({ file_path: PATH }) })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, imageSource, h.anchor({ toolName: 'read' }))
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('read_image without a registered tool (attachment store absent) fails closed', async () => {
    const h = await harness()
    h.setToolRegistered(['read'])
    const source = h.source({ toolName: 'read_image', callArguments: JSON.stringify({ file_path: PATH }) })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, source, h.anchor({ toolName: 'read_image' }))
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('rejects read_image arguments carrying anything beyond file_path', async () => {
    const h = await harness()
    const source = h.source({ toolName: 'read_image', callArguments: JSON.stringify({ file_path: PATH, detail: 'high' }) })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, source, h.anchor({ toolName: 'read_image' }))
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('rejects malformed read paging arguments', async () => {
    const h = await harness()
    const source = h.source({ callArguments: JSON.stringify({ file_path: PATH, offset: 0 }) })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, source, h.anchor())
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('pre-execution path policy denial fails closed', async () => {
    const h = await harness()
    h.policy.effect = 'deny'
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor())
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('post-execution path policy revocation fails closed', async () => {
    const h = await harness()
    h.policy.flipAfterExecute = true
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor())
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(1)
  })

  test('a replay error (e.g. non-vision route refuses read_image) fails closed', async () => {
    const h = await harness()
    h.setExecuteError(true)
    const source = h.source({ toolName: 'read_image', callArguments: JSON.stringify({ file_path: PATH }) })
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, source, h.anchor({ toolName: 'read_image' }))
    expect(ok).toBe(false)
  })

  test('file version changed during replay fails closed', async () => {
    const h = await harness()
    h.setVersionSequence([7, 8])
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor())
    expect(ok).toBe(false)
  })

  test('symlink/alias retarget during replay fails closed', async () => {
    const h = await harness()
    h.setRetargetOnReplay(true)
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor())
    expect(ok).toBe(false)
  })

  test('a stored anchor digest that no longer matches the target fails closed', async () => {
    const h = await harness()
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor({ sourceTargetDigest: digest('stale') }))
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })

  test('tool definition replaced during replay fails closed', async () => {
    const h = await harness()
    h.setSwapDefinition(true)
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor())
    expect(ok).toBe(false)
  })

  test('an already-aborted caller fails closed', async () => {
    const h = await harness()
    h.abort()
    const ok = await revalidateFileEvidence(h.ctx, h.policy as unknown as AssistantPolicyService, h.exec, h.source(), h.anchor())
    expect(ok).toBe(false)
    expect(h.executeCalls).toHaveLength(0)
  })
})
