import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { canonicalGrowthJson, SourceGrowthRunUnavailableError } from '@dsh-enhanced/assistant-growth-contract'
import type { CreationCapabilityCallEvidence, CreationCapabilityConfig, CreationCapabilityJournalPort, CreationCapabilityObservation,
  CreationCapabilityPorts, CreationCapabilityRecord, CreationCapabilityRunner, CreationCapabilityTool } from './creation-capability-types.js'

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const safeName = /^[a-z][a-z0-9_-]{0,95}$/u
const safeProperty = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u
const maxSchemaBytes = 16 * 1024
const outputSchema: JsonSchemaNode = { type: 'object', additionalProperties: false, required: ['value', 'content'], properties: {
  value: {}, content: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['type', 'text'], properties: { type: { type: 'string', const: 'text' }, text: { type: 'string' } } } },
} }

function fail(reason: string): never { throw new Error(`created capability: ${reason}`) }
function json(value: unknown, limit: number): string {
  const seen = new Set<object>()
  const walk = (item: unknown, depth: number): void => {
    if (depth > 16) fail('JSON depth exceeded')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item)) fail('non-JSON value')
    seen.add(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype || Reflect.ownKeys(item).length !== item.length + 1) fail('non-JSON array')
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) fail('sparse JSON array')
        walk(item[index], depth + 1)
      }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype || Object.getOwnPropertySymbols(item).length) fail('non-JSON object')
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || key === '__proto__' || key === 'constructor' || key === 'prototype') fail('unsafe JSON property')
        walk(descriptor.value, depth + 1)
      }
    }
    seen.delete(item)
  }
  walk(value, 0)
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > limit) fail('JSON byte limit exceeded')
  return encoded
}

// Candidate annotations are never copied to the Host model surface. Keep only
// the validating subset, including requiredness and scalar constraints.
function parameters(value: unknown, validate: (schema: unknown) => void): Record<string, unknown> {
  if (Buffer.byteLength(json(value, maxSchemaBytes)) > maxSchemaBytes) fail('schema too large')
  validate(value)
  const clean = (node: Record<string, unknown>, depth: number): Record<string, unknown> => {
    if (depth > 8) fail('schema nesting exceeded')
    const result: Record<string, unknown> = {}
    for (const key of ['type', 'additionalProperties', 'const'] as const) if (node[key] !== undefined) result[key] = node[key]
    if (node.enum !== undefined) result.enum = [...node.enum as unknown[]]
    if (node.required !== undefined) result.required = [...node.required as unknown[]]
    if (node.items !== undefined) result.items = clean(node.items as Record<string, unknown>, depth + 1)
    if (node.oneOf !== undefined) result.oneOf = (node.oneOf as Record<string, unknown>[]).map(item => clean(item, depth + 1))
    if (node.properties !== undefined) {
      const properties: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(node.properties as Record<string, Record<string, unknown>>)) {
        if (!safeProperty.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) fail('unsafe parameter property')
        properties[name] = clean(child, depth + 1)
      }
      result.properties = properties
    }
    return result
  }
  return clean(value as unknown as Record<string, unknown>, 0)
}

function sameEnvironment(a: unknown, b: unknown): boolean {
  json(a, 1024); json(b, 1024)
  return canonicalGrowthJson(a) === canonicalGrowthJson(b)
}
function sameCertificate(a: unknown, b: unknown): boolean {
  json(a, 65_536); json(b, 65_536)
  return canonicalGrowthJson(a) === canonicalGrowthJson(b)
}
function observed(record: CreationCapabilityRecord, result: CreationCapabilityObservation): boolean {
  return result.status === 'observed' && result.quiescent === true
    && result.artifactSha256 === record.certificate.plan.artifactSha256
    && result.schemaDigest === record.certificate.schemaDigest
    && sameEnvironment(result.environment, record.certificate.environment)
}

type Mounted = { fiber: { dispose(): Promise<void>; state: number }; aliases: readonly string[] }

/** The journal belongs to this controller and is closed after all Fiber effects. */
export class CreationCapabilityRuntime {
  private readonly ctx: Context
  private readonly config: CreationCapabilityConfig
  private readonly journal: CreationCapabilityJournalPort
  private readonly ports: CreationCapabilityPorts
  private readonly createRunner: () => Promise<CreationCapabilityRunner>
  private runner?: CreationCapabilityRunner
  private validateSchema?: (schema: unknown) => void
  private readonly mounted = new Map<string, Mounted>()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly invocationPlans = new Map<Promise<unknown>, string>()
  private readonly cancellations = new Map<AbortController, string>()
  private readonly operations = new Set<AbortController>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private admission = false
  private closed = false
  private started = false
  private serial: Promise<unknown> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  constructor(input: { ctx: Context; config: CreationCapabilityConfig; journal: CreationCapabilityJournalPort;
    ports: CreationCapabilityPorts; createRunner?: () => Promise<CreationCapabilityRunner> }) {
    this.ctx = input.ctx; this.config = input.config; this.journal = input.journal; this.ports = input.ports
    this.createRunner = input.createRunner ?? (async () => {
      const { PluginBehaviorRunner } = await import('@dsh-enhanced/assistant-verifier/plugin-behavior-runner')
      return new PluginBehaviorRunner({ ...this.config.runner, authorityDigest: this.journal.authorityDigest })
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work)
    this.serial = result.catch(() => {})
    return result
  }

  private live(record: CreationCapabilityRecord): void {
    if (this.closed || Date.now() >= this.config.expiresAt || Date.now() >= this.config.runner.expiresAt
      || ((record.status !== 'active' || record.receipt?.protocol !== 'dsh-created-capability-adoption/v2')
        && Date.now() >= record.certificate.expiresAt)
      || Date.now() >= (record.receipt?.expiresAt ?? 0)) fail('authority or receipt expired')
    if (!['authorized', 'active'].includes(record.status)) fail('adoption is not authorized')
  }

  private async checked(record: CreationCapabilityRecord, signal: AbortSignal, firstAdoption = false): Promise<void> {
    this.live(record)
    const retained = !firstAdoption && record.status === 'active'
      && record.receipt?.protocol === 'dsh-created-capability-adoption/v2'
    if (retained) {
      if (!this.ports.inspectRetained || !this.ports.recheckRetained) fail('retained source authority unavailable')
      await this.ports.recheckRetained(record, signal)
    } else await this.ports.recheck(record.planId, signal)
    signal.throwIfAborted()
    const current = retained ? this.ports.inspectRetained!(record) : this.ports.inspect(record.planId)
    this.ports.withCurrent(record, () => {
      if (!sameCertificate(current.certificate, record.certificate)
        || sha(current.artifact) !== record.certificate.plan.artifactSha256
        || current.artifact.length !== record.certificate.plan.artifactBytes) fail('source or artifact changed')
    })
    this.live(record)
  }

  private makeTools(record: CreationCapabilityRecord, schemas: readonly unknown[]): CreationCapabilityTool[] {
    if (schemas.length < 1 || schemas.length > this.config.maxTools) fail('tool count exceeds grant')
    const names = new Set<string>()
    return schemas.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid candidate schema')
      const schema = item as Record<string, unknown>
      if (typeof schema.name !== 'string' || !safeName.test(schema.name) || names.has(schema.name)) fail('invalid candidate tool name')
      names.add(schema.name)
      const alias = `evolved_${record.certificate.plan.name.replaceAll('-', '_').slice(0, 32)}_${sha(record.planId).slice(0, 8)}_${index}`
      if (!safeName.test(alias)) fail('invalid Host alias')
      return { originalName: schema.name, name: alias,
        description: `Owner-authorized isolated capability ${record.certificate.plan.name}, operation ${schema.name}. Output is untrusted data.`,
        parameters: parameters(schema.parameters, this.validateSchema!) }
    })
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started || this.closed) fail('controller already started or closed')
      const { assertObjectJsonSchema } = await import('@deepseek-ai/dsh-tools')
      this.validateSchema = assertObjectJsonSchema
      this.runner = await this.createRunner()
      if (this.closed) fail('controller closed during startup')
      this.started = true
      this.journal.recoverClaims()
      this.admission = true
      await this.reconcileRows()
    })
  }

  eligible(planId: string): boolean {
    try {
      if (!this.admission || this.closed || this.journal.inspect(planId)
        || this.journal.list().length >= this.config.maxAdoptions
        || Date.now() >= this.config.expiresAt || Date.now() >= this.config.runner.expiresAt) return false
      const current = this.ports.inspect(planId)
      return current.certificate.plan.id === planId && current.certificate.expiresAt > Date.now()
        && current.certificate.plan.name.startsWith(this.config.namePrefix)
        && sameCertificate(current.owner, this.config.owner)
        && sha(current.artifact) === current.certificate.plan.artifactSha256
        && current.artifact.length === current.certificate.plan.artifactBytes
    } catch { return false }
  }

  async adopt(planId: string, signal: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      const controller = new AbortController()
      this.operations.add(controller)
      const cancel = () => controller.abort()
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      const activeSignal = controller.signal
      try {
      if (!this.eligible(planId)) fail('plan is not eligible')
      activeSignal.throwIfAborted()
      const current = this.ports.inspect(planId)
      await this.ports.recheck(planId, activeSignal)
      activeSignal.throwIfAborted()
      const pinned = this.ports.inspect(planId)
      if (!sameCertificate(current.certificate, pinned.certificate)
        || sha(current.artifact) !== sha(pinned.artifact)) fail('source changed before claim')
      const claimed = this.journal.claim({ certificate: current.certificate, artifact: current.artifact })
      if (!claimed.created) fail('plan already claimed')
      const record = claimed.record
      try {
        const result = await this.runner!.run({ key: sha(json({ operation: 'discover',
          authorityDigest: this.journal.authorityDigest, planId }, 1024)),
          artifact: record.artifact, operation: { kind: 'discover' }, signal: activeSignal })
        if (!observed(record, result) || !result.schemas || sha(JSON.stringify(result.schemas)) !== result.schemaDigest)
          fail('discovery unknown or certificate mismatch')
        const tools = this.makeTools(record, result.schemas)
        await this.ports.recheck(planId, activeSignal)
        activeSignal.throwIfAborted()
        const latest = this.ports.inspect(planId)
        this.ports.withCurrent(record, () => {
          if (!sameCertificate(latest.certificate, record.certificate)
            || sha(latest.artifact) !== record.certificate.plan.artifactSha256) fail('source changed before authorization')
          this.journal.authorize(planId, tools)
        })
        const authorized = this.journal.inspect(planId)!
        await this.checked(authorized, activeSignal, true)
        await this.mount(authorized, activeSignal)
        await this.checked(authorized, activeSignal, true)
        this.ports.withCurrent(authorized, () => this.journal.activate(planId))
      } catch (error) {
        try { await this.unmount(planId) }
        finally { this.journal.settle(planId, 'unknown', 'adoption-unsettled') }
        throw error
      }
      } finally {
        signal.removeEventListener('abort', cancel)
        this.operations.delete(controller)
      }
    })
  }

  private async mount(record: CreationCapabilityRecord, signal?: AbortSignal): Promise<void> {
    if (!record.tools?.length || this.mounted.has(record.planId)) fail('missing tools or duplicate mount')
    for (const tool of record.tools) if (this.ctx.tools.get(tool.name)) fail('Host alias conflicts with existing tool')
    const definitions: ToolDefinition[] = record.tools.map(tool => ({ name: tool.name, description: tool.description,
      parameters: parameters(tool.parameters, this.validateSchema!), output: { schema: outputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => this.invoke(record.planId, tool, args, exec),
    }))
    const plugin = { name: `created-capability-${sha(record.planId).slice(0, 16)}`, inject: ['tools'],
      apply: (ctx: Context) => { for (const definition of definitions) ctx.tools.register(definition) } }
    const fiber = this.ctx.plugin(plugin)
    this.mounted.set(record.planId, { fiber, aliases: definitions.map(definition => definition.name) })
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 5_000)
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([fiber, new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('created capability: Host activation interrupted'))
        onAbort = abort
        signal?.addEventListener('abort', abort, { once: true })
        timeout.signal.addEventListener('abort', abort, { once: true })
        if (signal?.aborted || timeout.signal.aborted) abort()
      })])
      if (fiber.state !== 2 || definitions.some(definition => this.ctx.tools.get(definition.name) !== definition))
        fail('Host tool registration did not activate')
      this.armExpiry(record)
    } catch (error) {
      try { await this.unmount(record.planId) }
      catch (disposeError) { throw new AggregateError([error, disposeError], 'created capability activation cleanup unconfirmed') }
      throw error
    }
    finally {
      clearTimeout(timer)
      if (onAbort) { signal?.removeEventListener('abort', onAbort); timeout.signal.removeEventListener('abort', onAbort) }
    }
  }

  private armExpiry(record: CreationCapabilityRecord): void {
    const deadline = record.receipt!.protocol === 'dsh-created-capability-adoption/v2'
      ? Math.min(this.config.expiresAt, this.config.runner.expiresAt, record.receipt!.expiresAt)
      : Math.min(this.config.expiresAt, record.certificate.expiresAt, record.receipt!.expiresAt)
    const remaining = deadline - Date.now()
    const timer = setTimeout(() => {
      this.timers.delete(record.planId)
      if (this.closed || !this.mounted.has(record.planId)) return
      if (Date.now() < deadline) this.armExpiry(record)
      else void this.reconcile().catch(() => {})
    }, Math.max(1, Math.min(remaining, 2_147_483_647)))
    this.timers.set(record.planId, timer)
  }

  private async unmount(planId: string): Promise<void> {
    const timer = this.timers.get(planId); if (timer) clearTimeout(timer)
    this.timers.delete(planId)
    const mounted = this.mounted.get(planId); if (!mounted) return
    await mounted.fiber.dispose()
    if (mounted.aliases.some(name => this.ctx.tools.get(name))) fail('Host tool remains after disposal')
    this.mounted.delete(planId)
  }

  private async invoke(planId: string, tool: CreationCapabilityTool, args: unknown, exec: ToolRunContext): Promise<unknown> {
    const flight = this.invokeFlight(planId, tool, args, exec)
    this.flights.add(flight)
    this.invocationPlans.set(flight, planId)
    try { return await flight } finally { this.flights.delete(flight); this.invocationPlans.delete(flight) }
  }

  private async invokeFlight(planId: string, tool: CreationCapabilityTool, args: unknown, exec: ToolRunContext): Promise<unknown> {
    const record = this.journal.inspect(planId)
    if (!record || record.status !== 'active' || !this.admission || !exec.agent) fail('capability unavailable')
    this.ports.assertCaller(record, exec)
    const encoded = json(args, this.config.maxInputBytes)
    const argumentsDigest = sha(encoded)
    const key = sha(json({ planId, sessionId: String(exec.agent.session.id), callId: String(exec.callId),
      toolName: tool.name }, 4096))
    const controller = new AbortController()
    this.cancellations.set(controller, planId)
    const cancel = () => controller.abort()
    exec.signal.addEventListener('abort', cancel, { once: true })
    if (exec.signal.aborted) cancel()
    try {
      await this.checked(record, controller.signal)
      const call = this.ports.withCurrent(record, () => {
        this.ports.assertCaller(record, exec)
        controller.signal.throwIfAborted()
        const foreground = this.ports.inspectCall?.(record, exec, tool.name, encoded)
        if (foreground !== undefined && (foreground.task.sessionId !== String(exec.agent!.session.id)
          || foreground.call.id !== String(exec.callId))) fail('foreground call differs from current execution')
        return this.journal.claimCall({ planId, key, argumentsDigest, toolAlias: tool.name,
          ...(foreground === undefined ? {} : { foreground }) })
      })
      if (!call.created) {
        if (call.call.status === 'completed') return call.call.result
        fail('call already claimed or unknown')
      }
      try {
        this.ports.withCurrent(record, () => {
          this.ports.assertCaller(record, exec)
          controller.signal.throwIfAborted()
        })
        const result = await this.runner!.run({ key: sha(json({ operation: 'invoke',
          authorityDigest: this.journal.authorityDigest, key }, 1024)),
          artifact: record.artifact, operation: { kind: 'invoke', schemaDigest: record.certificate.schemaDigest,
            calls: [{ id: key, toolName: tool.originalName, arguments: JSON.parse(encoded) }] }, signal: controller.signal })
        if (!observed(record, result) || result.calls?.length !== 1 || result.calls[0]?.id !== key
          || result.calls[0]?.toolName !== tool.originalName) fail('invocation unknown or changed')
        const raw = result.calls[0].result as Record<string, unknown>
        if (!raw || typeof raw !== 'object' || raw.isError !== false || !Array.isArray(raw.content)) fail('candidate tool failed')
        const content = raw.content.map(item => {
          if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text'
            || typeof (item as { text?: unknown }).text !== 'string') fail('non-text candidate content')
          return { type: 'text' as const, text: (item as { text: string }).text }
        })
        const value = { value: JSON.parse(json(raw.value, this.config.runner.maxOutputBytes)), content }
        json(value, this.config.runner.maxOutputBytes)
        await this.checked(record, controller.signal)
        this.ports.withCurrent(record, () => {
          this.ports.assertCaller(record, exec)
          controller.signal.throwIfAborted()
          this.journal.settleCall({ planId, key, status: 'completed', result: value,
            ...(result.jobId === undefined ? {} : { jobId: result.jobId }) })
        })
        return value
      } catch (error) {
        this.journal.settleCall({ planId, key, status: 'unknown' })
        throw error
      }
    } finally { exec.signal.removeEventListener('abort', cancel); this.cancellations.delete(controller) }
  }

  async reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileRows())
  }

  private async reconcileRows(): Promise<void> {
    if (this.closed || !this.started) return
    for (const record of this.journal.list()) {
      if (record.status !== 'authorized' && record.status !== 'active') continue
      try {
        await this.checked(record, new AbortController().signal)
        if (!this.mounted.has(record.planId)) {
          await this.mount(record)
          await this.checked(record, new AbortController().signal)
          if (record.status === 'authorized') this.ports.withCurrent(record, () => this.journal.activate(record.planId))
        }
      } catch (error) {
        for (const [cancellation, planId] of this.cancellations) if (planId === record.planId) cancellation.abort()
        await Promise.allSettled([...this.invocationPlans].filter(([, planId]) => planId === record.planId).map(([flight]) => flight))
        try { await this.unmount(record.planId) }
        catch {
          this.journal.settle(record.planId, 'unknown', 'host-disposal-unconfirmed')
          continue
        }
        if (this.closed) continue
        if (!(error instanceof SourceGrowthRunUnavailableError))
          this.journal.settle(record.planId, 'closed', 'authority-source-or-mount-invalid')
      }
    }
  }

  /** Owner-only bounded status; no certificate, source or artifact bytes escape. */
  inspectStatus(planId: string): { status: CreationCapabilityRecord['status']; aliases: readonly string[] } | undefined {
    const record = this.journal.inspect(planId)
    return record && { status: record.status, aliases: record.tools?.map(tool => tool.name) ?? [] }
  }

  /** Host-only evidence lookup remains available for terminal adoptions. */
  inspectCallEvidence(planId: string): readonly CreationCapabilityCallEvidence[] {
    return this.journal.listCallEvidence?.(planId) ?? []
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.admission = false; this.closed = true
    for (const cancellation of this.cancellations.keys()) cancellation.abort()
    for (const operation of this.operations) operation.abort()
    const attempt = this.enqueue(async () => {
      await Promise.allSettled(this.flights)
      const errors: unknown[] = []
      try {
        for (const planId of this.mounted.keys()) {
          try { await this.unmount(planId) }
          catch (error) {
            errors.push(error)
            try {
              const record = this.journal.inspect(planId)
              if (record && ['claimed', 'authorized', 'active'].includes(record.status))
                this.journal.settle(planId, 'unknown', 'host-disposal-unconfirmed')
            } catch (settleError) { errors.push(settleError) }
          }
        }
      } finally {
        for (const timer of this.timers.values()) clearTimeout(timer)
        this.timers.clear()
        try { await this.runner?.close() } catch (error) { errors.push(error) }
      }
      if (!errors.length && this.mounted.size === 0) {
        try { this.journal.close() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'created capability close could not prove release')
    })
    this.closeTask = attempt.catch(error => { this.closeTask = undefined; throw error })
    return this.closeTask
  }
}
