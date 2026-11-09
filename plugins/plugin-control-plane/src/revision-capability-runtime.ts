import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { canonicalGrowthJson, isPluginRevisionTaskSource } from '@dsh-enhanced/assistant-growth-contract'
import type { CreationCapabilityObservation, CreationCapabilityTool } from './creation-capability-types.js'
import type { RevisionCapabilityAdoptionReceipt, RevisionCapabilityAdoptionRecord, RevisionCapabilityCallEvidence,
  RevisionCapabilityConfig, RevisionCapabilityInspection, RevisionCapabilityJournalPort,
  RevisionCapabilityParentAdoption, RevisionCapabilityPorts, RevisionCapabilityReadiness,
  RevisionCapabilityRollbackRecord, RevisionCapabilityVersion } from './revision-capability-types.js'

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): string => sha(canonicalGrowthJson(value))
const safeName = /^[a-z][a-z0-9_-]{0,95}$/u
const maxOutputBytes = 65_536
const outputSchema: JsonSchemaNode = { type: 'object', additionalProperties: false, required: ['value', 'content'], properties: {
  value: {}, content: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['type', 'text'], properties: { type: { type: 'string', const: 'text' }, text: { type: 'string' } } } },
} }
const ENTRY_PROTOCOL = 'dsh-created-capability-revision-entry/v1'

function fail(reason: string): never { throw new Error('revision capability: ' + reason) }
function json(value: unknown, limit = 65_536): string {
  const encoded = canonicalGrowthJson(value)
  if (Buffer.byteLength(encoded) > limit) fail('JSON byte limit exceeded')
  return encoded
}
function sameEnvironment(a: unknown, b: unknown): boolean {
  return canonicalGrowthJson(a) === canonicalGrowthJson(b)
}

export class RevisionCapabilityRejected extends Error {
  readonly reason: string
  constructor(reason: string) { super('revision capability rejected: ' + reason); this.reason = reason }
}

type Mounted = { fiber: { dispose(): Promise<void>; state: number }; aliases: readonly string[] }

/**
 * Owns the stable tool entry of one already adopted creation lineage. Adoption reserves capacity in
 * the append-only revision journal before any external action; the parent CAS decides whether this
 * entry may switch at all; entry calls read the current version at claim time so a switch can never
 * change an already running call.
 */
export class RevisionCapabilityRuntime {
  private readonly ctx: Context
  private readonly config: RevisionCapabilityConfig
  private readonly journal: RevisionCapabilityJournalPort
  private readonly ports: RevisionCapabilityPorts
  private readonly regressionRequired: boolean
  private readonly abort = new AbortController()
  private readonly mounted = new Map<string, Mounted>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly operations = new Set<AbortController>()
  private readonly flights = new Set<Promise<unknown>>()
  private validateSchema?: (schema: unknown) => void
  private admission = false
  private started = false
  private closed = false
  private serial: Promise<unknown> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  constructor(input: { ctx: Context; config: RevisionCapabilityConfig; journal: RevisionCapabilityJournalPort
    ports: RevisionCapabilityPorts; regressionRequired: boolean }) {
    this.ctx = input.ctx; this.config = input.config; this.journal = input.journal
    this.ports = input.ports; this.regressionRequired = input.regressionRequired
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work)
    this.serial = result.catch(() => {})
    return result
  }

  /** Read-only Host readiness; undefined once the controller is not admitting. */
  inspectReadiness(): RevisionCapabilityReadiness | undefined {
    if (!this.started || this.closed || !this.admission) return undefined
    const usage = this.journal.usage()
    const remainingAdoptions = Math.max(0, this.config.maxAdoptions - usage.adoptions)
    const remainingRollbacks = Math.max(0, this.config.rollback.maxRollbacks - usage.rollbacks)
    return { protocol: 'dsh-created-capability-revision-adoption-readiness/v1',
      available: Date.now() < this.config.expiresAt && remainingAdoptions > 0,
      authority: { authorityId: this.config.authorityId, expiresAt: this.config.expiresAt },
      remainingAdoptions, remainingRollbacks, rollbackExpiresAt: this.config.rollback.expiresAt }
  }

  inspectEntry(entryId: string): { currentPlanId: string; parentPlanId: string; aliases: readonly string[];
    revision: number; expiresAt: number } | undefined {
    try {
      const record = this.journal.inspectEntry(entryId)
      if (!record) return undefined
      return { currentPlanId: record.entry.currentPlanId, parentPlanId: record.entry.parentPlanId,
        aliases: record.entry.aliases, revision: record.entry.revision, expiresAt: record.current.expiresAt }
    } catch { return undefined }
  }

  /** Host-only content-free projection of every stable entry identity. */
  listEntries(): readonly { entryId: string; name: string; currentPlanId: string; parentPlanId: string; revision: number }[] {
    try {
      return this.journal.listEntries().map(entry => Object.freeze({
        entryId: entry.entryId, name: entry.name, currentPlanId: entry.currentPlanId,
        parentPlanId: entry.parentPlanId, revision: entry.revision,
      }))
    } catch { return [] }
  }

  inspectCallEvidence(entryId: string): readonly RevisionCapabilityCallEvidence[] {
    try { return this.journal.listCallEvidence(entryId) } catch { return [] }
  }

  private assertCandidate(planId: string, inspection: RevisionCapabilityInspection): void {
    const certificate = inspection.certificate
    if (certificate.plan.id !== planId || inspection.plan.id !== planId
      || certificate.plan.name !== inspection.plan.name || certificate.plan.digest !== inspection.plan.digest
      || !certificate.plan.name.startsWith(this.config.namePrefix)
      || certificate.plan.artifactSha256 !== sha(inspection.artifact)
      || certificate.plan.artifactBytes !== inspection.artifact.length
      || Date.now() >= certificate.expiresAt || Date.now() >= this.config.expiresAt
      || canonicalGrowthJson(inspection.owner) !== canonicalGrowthJson(this.config.owner)
      || !this.ports.matchesExecution(certificate)) {
      throw new RevisionCapabilityRejected('candidate-ineligible')
    }
    if (this.regressionRequired) {
      const regression = inspection.regression
      if (!regression || regression.candidateVerificationDigest !== digest(certificate)
        || regression.plan.digest !== certificate.plan.digest
        || canonicalGrowthJson(regression.parent) !== canonicalGrowthJson(certificate.parent)
        || Date.now() >= regression.expiresAt) {
        throw new RevisionCapabilityRejected('regression-required')
      }
    } else if (inspection.regression !== undefined
      && inspection.regression.candidateVerificationDigest !== digest(certificate)) {
      throw new RevisionCapabilityRejected('regression-mismatch')
    }
  }

  private assertParent(certificate: RevisionCapabilityInspection['certificate'],
    parent: RevisionCapabilityParentAdoption): void {
    if (parent.planId !== certificate.parent.planId
      || digest(parent.certificate) !== certificate.parent.certificateDigest
      || sha(parent.artifact) !== certificate.parent.artifactSha256
      || parent.certificate.plan.artifactBytes !== parent.artifact.length
      || parent.certificate.plan.name !== certificate.plan.name
      || !parent.certificate.plan.name.startsWith(this.config.namePrefix)
      || canonicalGrowthJson(parent.owner) !== canonicalGrowthJson(this.config.owner)
      || parent.certificate.schemaDigest !== certificate.schemaDigest
      || json(parent.certificate.source) !== json(certificate.source)
      || parent.tools.length < 1 || parent.tools.length > 16) {
      throw new RevisionCapabilityRejected('parent-adoption-mismatch')
    }
    const aliases = new Set<string>()
    for (const tool of parent.tools) {
      if (!safeName.test(tool.name) || aliases.has(tool.name)) throw new RevisionCapabilityRejected('parent-adoption-mismatch')
      aliases.add(tool.name)
    }
  }

  private entryId(parentPlanId: string, aliases: readonly string[]): string {
    return 'entry-' + digest({ protocol: ENTRY_PROTOCOL, parentPlanId, aliases }).slice(0, 32)
  }

  eligible(planId: string): boolean {
    try {
      if (!this.started || this.closed || !this.admission || Date.now() >= this.config.expiresAt) return false
      if (this.journal.inspectAdoption(planId)) return false
      if (this.journal.usage().adoptions >= this.config.maxAdoptions) return false
      const inspection = this.ports.inspect(planId)
      this.assertCandidate(planId, inspection)
      const parent = this.ports.parent(inspection.certificate.parent.planId)
      this.assertParent(inspection.certificate, parent)
      const existing = this.journal.inspectEntry(this.entryId(inspection.certificate.parent.planId,
        parent.tools.map(tool => tool.name)))
      if (existing && existing.entry.currentPlanId !== inspection.certificate.parent.planId) return false
      return true
    } catch { return false }
  }

  async adopt(planId: string, signal: AbortSignal): Promise<RevisionCapabilityAdoptionRecord> {
    return this.enqueue(async () => {
      const controller = new AbortController()
      this.operations.add(controller)
      const cancel = (): void => controller.abort()
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      const activeSignal = controller.signal
      try {
        if (!this.eligible(planId)) throw new RevisionCapabilityRejected('candidate-ineligible')
        activeSignal.throwIfAborted()
        const inspection = this.ports.inspect(planId)
        const certificate = inspection.certificate
        const parent = this.ports.parent(certificate.parent.planId)
        this.assertCandidate(planId, inspection)
        this.assertParent(certificate, parent)
        const parentReceiptJson = json(JSON.parse(parent.receiptJson))
        if (sha(parentReceiptJson) !== parent.receiptDigest) throw new RevisionCapabilityRejected('parent-receipt-changed')
        const parentReceipt = JSON.parse(parentReceiptJson) as { adoptedAt: number; expiresAt: number }
        await this.ports.recheck(planId, activeSignal)
        await this.ports.recheckParent(certificate.parent.planId, activeSignal)
        activeSignal.throwIfAborted()
        const claim = this.journal.claim({ planId, parentPlanId: certificate.parent.planId,
          certificateDigest: digest(certificate) })
        if (!claim.created) throw new RevisionCapabilityRejected('candidate-already-claimed')
        const aliases = Object.freeze(parent.tools.map(tool => tool.name))
        const entryId = this.entryId(certificate.parent.planId, aliases)
        let entryMounted = false, parentSuspended = false, committed = false
        try {
          activeSignal.throwIfAborted()
          const pinned = this.ports.inspect(planId)
          if (digest(pinned.certificate) !== digest(certificate) || sha(pinned.artifact) !== sha(inspection.artifact)) {
            throw new RevisionCapabilityRejected('source-changed-before-claim')
          }
          await this.ports.recheckExecution(certificate, activeSignal)
          activeSignal.throwIfAborted()
          const discovery = await this.ports.runVersion({ certificate, artifact: inspection.artifact,
            schemaDigest: certificate.schemaDigest, operation: { kind: 'discover' },
            key: sha(json({ operation: 'discover', planId })), signal: activeSignal })
          if (!this.observed(certificate, inspection.artifact, discovery)
            || discovery.schemaDigest !== certificate.schemaDigest || !discovery.schemas) {
            throw new RevisionCapabilityRejected('discovery-mismatch')
          }
          const adoptedAt = Date.now()
          const expiresAt = this.config.retention === undefined
            ? Math.min(this.config.expiresAt, certificate.expiresAt)
            : Math.min(this.config.expiresAt, adoptedAt + this.config.retention.maximumLifetimeMs)
          if (expiresAt <= adoptedAt || adoptedAt >= certificate.expiresAt) {
            throw new RevisionCapabilityRejected('adoption-expired')
          }
          const inFlightParentCalls = this.ports.inFlightParentCalls(certificate.parent.planId)
          const body: Omit<RevisionCapabilityAdoptionReceipt, 'signature'> = { protocol: 'dsh-created-capability-revision-adoption/v1',
            authorityId: this.config.authorityId, authorityDigest: this.journal.authorityDigest,
            keyId: this.config.keyId, planId, planDigest: certificate.plan.digest,
            verificationDigest: digest(certificate), parentPlanId: certificate.parent.planId,
            parentCertificateDigest: certificate.parent.certificateDigest,
            parentReceiptDigest: parent.receiptDigest, parentArtifactSha256: certificate.parent.artifactSha256,
            entryId, aliasesDigest: digest([...aliases]), artifactSha256: sha(inspection.artifact),
            artifactBytes: inspection.artifact.length, schemaDigest: certificate.schemaDigest,
            source: isPluginRevisionTaskSource(certificate.source)
              ? { referenceDigest: certificate.source.referenceDigest, ownerDigest: certificate.source.ownerDigest,
                growthRunDigest: certificate.source.growthRunDigest }
              : { instructionDigest: certificate.source.instructionDigest, ownerDigest: certificate.source.ownerDigest },
            model: certificate.model,
            ...(inspection.regression === undefined ? {} : { regressionDigest: digest(inspection.regression) }),
            inFlightParentCalls, expiresAt, adoptedAt }
          const receipt = this.journal.signReceipt(body)
          const toolVersions = parent.tools.map(tool => ({ originalName: tool.originalName, name: tool.name,
            description: tool.description, parameters: structuredClone(tool.parameters) }))
          const parentVersion: RevisionCapabilityVersion = { planId: parent.planId, entryId, role: 'parent',
            name: parent.certificate.plan.name, certificate: parent.certificate,
            certificateDigest: digest(parent.certificate), receiptJson: parentReceiptJson,
            receiptDigest: parent.receiptDigest, tools: toolVersions, artifact: parent.artifact,
            artifactSha256: sha(parent.artifact), schemaDigest: parent.certificate.schemaDigest,
            source: parent.certificate.source, model: parent.certificate.model,
            adoptedAt: parentReceipt.adoptedAt, expiresAt: parentReceipt.expiresAt }
          const receiptJson = canonicalGrowthJson(receipt)
          const revisionVersion: RevisionCapabilityVersion = { planId, entryId, role: 'revision',
            name: certificate.plan.name, certificate, certificateDigest: digest(certificate),
            receiptJson, receiptDigest: sha(receiptJson), tools: toolVersions,
            artifact: Buffer.from(inspection.artifact), artifactSha256: sha(inspection.artifact),
            schemaDigest: certificate.schemaDigest, source: body.source, model: body.model,
            ...(inspection.regression === undefined ? {} : { regressionDigest: digest(inspection.regression) }),
            adoptedAt, expiresAt }
          // Alias handover happens before the durable CAS so a failed swap keeps the parent entry.
          await this.ports.suspendParent(parent.planId)
          parentSuspended = true
          await this.mountEntry({ entryId, name: parent.certificate.plan.name, tools: toolVersions })
          entryMounted = true
          activeSignal.throwIfAborted()
          let record: RevisionCapabilityAdoptionRecord
          try {
            record = this.journal.commit({ entry: { entryId, name: parent.certificate.plan.name, aliases },
              parent: parentVersion, revision: revisionVersion, receipt,
              expectedCurrentPlanId: parent.planId, inFlightParentCalls })
          } catch (commitError) {
            const current = (() => { try { return this.journal.inspectEntry(entryId) } catch { return undefined } })()
            if (current && current.entry.currentPlanId !== parent.planId) {
              throw new RevisionCapabilityRejected('parent-version-cas-conflict')
            }
            throw commitError
          }
          committed = true
          this.armExpiry(entryId)
          return record
        } catch (error) {
          if (committed) throw error
          let cleanupFailure: unknown
          try {
            if (entryMounted) await this.unmountEntry(entryId)
            if (parentSuspended) await this.ports.resumeParent(certificate.parent.planId)
          } catch (cleanupError) { cleanupFailure = cleanupError }
          const rejection = error instanceof RevisionCapabilityRejected ? error.reason : undefined
          try {
            this.journal.settle(planId, rejection === undefined ? 'unknown' : 'rejected',
              rejection === undefined ? 'adoption-unsettled' : rejection)
          } catch { /* the durable claim remains a no-replay fence */ }
          if (cleanupFailure !== undefined) {
            throw new AggregateError([error, cleanupFailure], 'revision adoption swap cleanup unconfirmed')
          }
          throw error
        }
      } finally {
        signal.removeEventListener('abort', cancel)
        this.operations.delete(controller)
      }
    })
  }

  private observed(certificate: RevisionCapabilityVersion['certificate'], artifact: Buffer,
    result: CreationCapabilityObservation): boolean {
    if (result.status !== 'observed' || result.quiescent !== true
      || result.artifactSha256 !== certificate.plan.artifactSha256
      || certificate.plan.artifactSha256 !== sha(artifact)
      || result.schemaDigest !== certificate.schemaDigest
      || !sameEnvironment(result.environment, certificate.environment)) return false
    const protocol = certificate.protocol
    if (protocol === 'assistant-growth/creation-verification/v1' || protocol === 'assistant-growth/revision-verification/v1') {
      return result.boundary === undefined || result.boundary === 'process-seccomp-v1'
    }
    const boundary = protocol === 'assistant-growth/creation-verification/v2'
      ? 'macos-seatbelt-single-process-v1' : 'linux-native-process-seccomp-v1'
    return result.boundary === boundary && result.runtimeDigest === certificate.execution?.runtimeDigest
  }

  private async mountEntry(input: { entryId: string; name: string; tools: readonly CreationCapabilityTool[] }): Promise<void> {
    if (this.mounted.has(input.entryId)) return
    for (const tool of input.tools) if (this.ctx.tools.get(tool.name)) fail('stable Host alias conflicts with an existing tool')
    const definitions: ToolDefinition[] = input.tools.map(tool => ({ name: tool.name, description: tool.description,
      parameters: tool.parameters, output: { schema: outputSchema,
        render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }] },
      execute: (args, exec) => this.invoke(input.entryId, tool.name, args, exec) }))
    for (const definition of definitions) this.validateSchema!(definition.parameters)
    const plugin = { name: 'revision-capability-' + input.entryId.slice(0, 16), inject: ['tools'],
      apply: (ctx: Context) => { for (const definition of definitions) ctx.tools.register(definition) } }
    const fiber = this.ctx.plugin(plugin)
    this.mounted.set(input.entryId, { fiber, aliases: definitions.map(definition => definition.name) })
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), 5_000)
    try {
      await Promise.race([fiber, new Promise<never>((_resolve, reject) => {
        timeout.signal.addEventListener('abort', () => reject(new Error('revision capability: Host activation interrupted')), { once: true })
      })])
      if (fiber.state !== 2 || definitions.some(definition => this.ctx.tools.get(definition.name) !== definition)) {
        fail('stable Host tool registration did not activate')
      }
    } catch (error) {
      try { await this.unmountEntry(input.entryId) }
      catch (disposeError) { throw new AggregateError([error, disposeError], 'revision capability activation cleanup unconfirmed') }
      throw error
    } finally { clearTimeout(timer) }
  }

  private armExpiry(entryId: string): void {
    const current = this.journal.inspectEntry(entryId)
    if (!current) return
    const deadline = Math.min(this.config.expiresAt, current.current.expiresAt)
    const remaining = deadline - Date.now()
    const previous = this.timers.get(entryId)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.timers.delete(entryId)
      if (this.closed || !this.mounted.has(entryId)) return
      if (Date.now() < deadline) this.armExpiry(entryId)
      else void this.reconcile().catch(() => {})
    }, Math.max(1, Math.min(remaining, 2_147_483_647)))
    this.timers.set(entryId, timer)
  }

  private async unmountEntry(entryId: string): Promise<void> {
    const timer = this.timers.get(entryId)
    if (timer) clearTimeout(timer)
    this.timers.delete(entryId)
    const mounted = this.mounted.get(entryId)
    if (!mounted) return
    await mounted.fiber.dispose()
    if (mounted.aliases.some(name => this.ctx.tools.get(name))) fail('stable Host tool remains after disposal')
    this.mounted.delete(entryId)
  }

  private async invoke(entryId: string, toolAlias: string, args: unknown, exec: ToolRunContext): Promise<unknown> {
    const flight = this.invokeFlight(entryId, toolAlias, args, exec)
    this.flights.add(flight)
    void flight.then(() => this.flights.delete(flight), () => this.flights.delete(flight))
    return flight
  }

  private async invokeFlight(entryId: string, toolAlias: string, args: unknown, exec: ToolRunContext): Promise<unknown> {
    if (!this.admission || this.closed) fail('capability unavailable')
    const record = this.journal.inspectEntry(entryId)
    if (!record || !record.entry.aliases.includes(toolAlias)) fail('capability unavailable')
    if (!exec.agent) fail('revision capability requires an authenticated owner Agent')
    this.ports.assertCaller(exec)
    const version = record.current
    if (Date.now() >= version.expiresAt || Date.now() >= this.config.expiresAt) fail('authority or receipt expired')
    const tool = version.tools.find(item => item.name === toolAlias)
    if (!tool) fail('capability unavailable')
    const encoded = json(args, this.config.maxInputBytes)
    const key = sha(json({ entryId, sessionId: String(exec.agent.session.id), callId: String(exec.callId),
      toolName: toolAlias }))
    const call = this.journal.claimCall({ entryId, key, argumentsDigest: sha(encoded), toolAlias,
      versionPlanId: version.planId })
    if (!call.created) {
      if (call.call.status === 'completed') return call.call.result
      fail('revision call already claimed or unknown')
    }
    try {
      this.ports.assertCaller(exec)
      const result = await this.ports.runVersion({ certificate: version.certificate, artifact: version.artifact,
        schemaDigest: version.schemaDigest, operation: { kind: 'invoke', calls: [{ id: key,
          toolName: tool.originalName, arguments: JSON.parse(encoded) }] },
        key: sha(json({ operation: 'invoke', key })), signal: exec.signal })
      if (!this.observed(version.certificate, version.artifact, result) || result.calls?.length !== 1
        || result.calls[0]?.id !== key || result.calls[0]?.toolName !== tool.originalName) {
        fail('revision invocation unknown or changed')
      }
      const raw = result.calls[0].result as Record<string, unknown>
      if (!raw || typeof raw !== 'object' || raw.isError !== false || !Array.isArray(raw.content)) fail('candidate tool failed')
      const content = raw.content.map(item => {
        if (!item || typeof item !== 'object' || (item as { type?: unknown }).type !== 'text'
          || typeof (item as { text?: unknown }).text !== 'string') fail('non-text candidate content')
        return { type: 'text' as const, text: (item as { text: string }).text }
      })
      const value = { value: JSON.parse(json(raw.value, maxOutputBytes)), content }
      json(value, maxOutputBytes)
      this.journal.settleCall({ entryId, key, status: 'completed', result: value })
      return value
    } catch (error) {
      this.journal.settleCall({ entryId, key, status: 'unknown' })
      throw error
    }
  }

  private async reconcileEntries(): Promise<void> {
    if (this.closed || !this.started) return
    for (const entry of this.journal.listEntries()) {
      if (this.closed) return
      const record = this.journal.inspectEntry(entry.entryId)
      if (!record) continue
      if (Date.now() >= record.current.expiresAt || Date.now() >= this.config.expiresAt) {
        await this.unmountEntry(entry.entryId).catch(() => {})
        continue
      }
      if (this.mounted.has(entry.entryId)) continue
      try {
        await this.ports.suspendParent(record.parent.planId)
        await this.mountEntry({ entryId: entry.entryId, name: record.entry.name, tools: record.parent.tools })
        this.armExpiry(entry.entryId)
      } catch {
        continue
      }
    }
  }

  async reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileEntries())
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started || this.closed) fail('controller already started or closed')
      const { assertObjectJsonSchema } = await import('@deepseek-ai/dsh-tools')
      this.validateSchema = assertObjectJsonSchema
      this.started = true
      this.journal.recoverClaims()
      this.admission = true
      await this.reconcileEntries()
    })
  }

  /**
   * Host-only exact parent rollback under its own finite grant. The durable CAS requires the entry
   * to be on the exact revision version and the retained parent receipt to be the one bound by that
   * revision adoption; a missing/recycled parent or a changed version chain fails closed.
   */
  async rollback(input: { entryId: string; expectedCurrentPlanId: string; signal?: AbortSignal }): Promise<RevisionCapabilityRollbackRecord> {
    return this.enqueue(async () => {
      if (!this.started || this.closed || !this.admission) fail('controller unavailable')
      const record = this.journal.inspectEntry(input.entryId)
      if (!record) fail('revision entry unavailable')
      if (record.entry.currentPlanId !== input.expectedCurrentPlanId) fail('revision entry version changed')
      if (Date.now() >= this.config.rollback.expiresAt) fail('rollback authority expired')
      const usage = this.journal.usage()
      if (usage.rollbacks >= this.config.rollback.maxRollbacks) fail('rollback quota exhausted')
      const signal = input.signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, input.signal])
      await this.ports.recheckParent(record.parent.planId, signal)
      signal.throwIfAborted()
      if (Date.now() >= record.parent.expiresAt) fail('parent adoption receipt expired')
      const result = this.journal.rollback({ entryId: input.entryId, expectedCurrentPlanId: input.expectedCurrentPlanId,
        authorityId: this.config.rollback.authorityId })
      this.armExpiry(input.entryId)
      return result.record
    })
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask
    this.admission = false; this.closed = true
    this.abort.abort(new Error('revision capability provider disposed'))
    for (const operation of this.operations) operation.abort()
    const attempt = this.enqueue(async () => {
      await Promise.allSettled(this.flights)
      const errors: unknown[] = []
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
      for (const entryId of this.mounted.keys()) {
        try { await this.unmountEntry(entryId) } catch (error) { errors.push(error) }
      }
      if (!errors.length) {
        try { this.journal.close() } catch (error) { errors.push(error) }
      }
      if (errors.length) throw new AggregateError(errors, 'revision capability close could not prove release')
    })
    this.closeTask = attempt.catch(error => { this.closeTask = undefined; throw error })
    return this.closeTask
  }
}
