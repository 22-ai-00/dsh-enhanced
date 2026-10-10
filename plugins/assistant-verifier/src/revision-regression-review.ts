import { createHash, sign } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalGrowthJson, growthObjectDigest, pluginRevisionRegressionSigningPayload,
  sourceGrowthEvidenceDigest, sourceGrowthRunDigest, validatePluginCreationVerificationCertificate,
  validatePluginRevisionParentBinding, validatePluginRevisionRegressionRequest,
  validatePluginRevisionVerificationCertificate, validateRevisionRegressionAcceptanceAuthorityRef,
  validateSourceGrowthRunBinding, verifyPluginRevisionRegressionCertificate,
  type PluginCreationVerificationCertificate, type PluginRevisionRegressionCertificate,
  type PluginRevisionRegressionRequest, type PluginRevisionRegressionResult,
  type PluginRevisionParentBinding, type PluginRevisionVerificationCertificate,
  type RevisionRegressionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import { CreationReviewStore } from './creation-review-store.js'
import { COMPARISON_RULES, SCHEMA_RULES, RULES_VERSION, compareCase, compileCreationReviewConfig,
  parseCases, projectCreationSchemas, type Case, type CreationReviewConfig } from './creation-review.js'

type PluginBehaviorRunner = import('./plugin-behavior-runner.js').PluginBehaviorRunner
type Observation = import('./plugin-behavior-runner.js').PluginBehaviorObservation
const PURPOSE = 'assistant-growth/revision-regression-review/v1'
const RULES = 'retained-creation-cases-v1:private-certificate-and-case-proof;fresh-parent-and-candidate-isolated-observations;both-compare-expected;exact-sanitized-schema-and-environment;no-model'
const SHA = /^[a-f0-9]{64}$/u

export type RevisionRegressionReviewConfig = Omit<CreationReviewConfig, 'policy' | 'maxInputBytes' | 'maxOutputTokens'>
export interface RevisionRegressionReviewAuthorityInspection {
  authority: RevisionRegressionAcceptanceAuthorityRef
  publicKey: string
  remainingVerifications: number
  available: boolean
}

function legacyConfig(input: RevisionRegressionReviewConfig): CreationReviewConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).some(key => typeof key !== 'string')
    || Object.keys(input).sort().join(',') !== ['authorityId', 'owner', 'namePrefix', 'keyId', 'keyPath',
      'expiresAt', 'maxVerifications', 'runner', 'maxDurationMs', 'maxCases', 'receiptTtlMs'].sort().join(',')
    || Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !field.enumerable || !('value' in field))) {
    throw new Error('revision regression review invalid config')
  }
  return { ...input, policy: RULES, maxInputBytes: 4096, maxOutputTokens: 2 }
}

export function validateRevisionRegressionReviewConfig(input: RevisionRegressionReviewConfig): RevisionRegressionReviewConfig {
  const checked = compileCreationReviewConfig(legacyConfig(input)).config
  if (checked.runner.maxRuns < checked.maxVerifications * (2 + 2 * checked.maxCases)) {
    throw new Error('revision regression runner cannot cover paired observations')
  }
  const { policy: _policy, maxInputBytes: _maxInputBytes, maxOutputTokens: _maxOutputTokens, ...config } = checked
  return config
}

export function compileRevisionRegressionReviewConfig(input: RevisionRegressionReviewConfig): {
  config: RevisionRegressionReviewConfig; authority: RevisionRegressionAcceptanceAuthorityRef;
  publicKey: string; privateKey: ReturnType<typeof import('node:crypto').createPrivateKey>
} {
  const config = validateRevisionRegressionReviewConfig(input)
  const checked = compileCreationReviewConfig(legacyConfig(config))
  const authority: RevisionRegressionAcceptanceAuthorityRef = {
    protocol: 'assistant-growth/revision-regression-acceptance-authority/v1', authorityId: config.authorityId,
    keyId: config.keyId, namePrefix: config.namePrefix, expiresAt: config.expiresAt,
    authorityDigest: growthObjectDigest({ purpose: PURPOSE, rules: RULES, baseRules: RULES_VERSION,
      comparisonRules: COMPARISON_RULES, schemaRules: SCHEMA_RULES,
      configurationDigest: checked.authority.authorityDigest }),
  }
  validateRevisionRegressionAcceptanceAuthorityRef(authority)
  return { config, authority: Object.freeze(authority), publicKey: checked.publicKey, privateKey: checked.privateKey }
}

interface PreparedRegressionPort {
  inspectPreparedRevisionRegression(planId: string): {
    protocol: 'dsh-prepared-revision-regression/v1'
    plan: { id: string; digest: string; name: string; mode: string; status: string; expiresAt: number;
      sourceRevision?: { grant: { expiresAt: number }; growthRun: unknown; parent: PluginRevisionParentBinding } }
    job: { intent: { revision?: { growthRun?: unknown; parent?: unknown } } }
    reference: { owner: Record<string, unknown> }
    candidate: { certificate: PluginRevisionVerificationCertificate; artifact: Buffer; sourceDigest: string }
    parent: { binding: PluginRevisionParentBinding; certificate: PluginCreationVerificationCertificate; artifact: Buffer }
  }
  withPreparedRevisionRegressionFence<T>(input: { planId: string; planDigest: string; artifactSha256: string;
    growthRunDigest: string; referenceDigest: string; parentDigest: string; candidateVerificationDigest: string;
    sourceDigest: string; regressionAuthorityDigest: string }, callback: () => T): T
  inspectPreparedRevisionReviewContext(planId: string, signal: AbortSignal): Promise<{ patch: string; changedPaths: string[] }>
}

type RetainedCases = Readonly<{ certificate: PluginCreationVerificationCertificate; discovery: unknown;
  contract: unknown; cases: Record<string, unknown> }>
type ReadParentCases = (certificate: PluginCreationVerificationCertificate) => RetainedCases | undefined

function retainedCases(value: RetainedCases | undefined, parent: PluginCreationVerificationCertificate,
  maxCases: number): { cases: Case[]; schemas: readonly { name: string; parameters: unknown }[] } {
  if (!value || canonicalGrowthJson(value.certificate) !== canonicalGrowthJson(parent)) throw new Error('retained parent cases unavailable')
  const contract = value.contract as { cases?: unknown; outputDigest?: unknown; sessionId?: unknown }
  const discovery = value.discovery as { schemas?: unknown; schemaDigest?: unknown; environment?: unknown; jobId?: unknown }
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)
    || Object.keys(contract).sort().join(',') !== 'cases,outputDigest,sessionId'
    || contract.sessionId !== parent.sessions.contract || typeof contract.outputDigest !== 'string' || !SHA.test(contract.outputDigest)
    || !discovery || typeof discovery !== 'object' || Array.isArray(discovery)
    || Object.keys(discovery).sort().join(',') !== 'environment,jobId,schemaDigest,schemas'
    || discovery.schemaDigest !== parent.schemaDigest
    || canonicalGrowthJson(discovery.environment) !== canonicalGrowthJson(parent.environment)
    || typeof discovery.jobId !== 'string' || !Array.isArray(discovery.schemas)) throw new Error('retained parent contract changed')
  const schemas = projectCreationSchemas(discovery.schemas)
  const parsed = parseCases({ status: 'cases', cases: contract.cases }, maxCases, schemas)
  if (parsed.status !== 'cases' || growthObjectDigest(parsed.cases) !== parent.contractDigest
    || Object.keys(value.cases).length !== parsed.cases.length || parsed.cases.length !== parent.observations.length) {
    throw new Error('retained parent contract digest changed')
  }
  for (const item of parsed.cases) {
    const old = parent.observations.find(entry => entry.caseId === item.id)
    const saved = value.cases[item.id] as { jobId?: unknown; operationDigest?: unknown; observationDigest?: unknown } | undefined
    const operation = { kind: 'invoke', schemaDigest: parent.schemaDigest,
      calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] }
    if (!old || !saved || canonicalGrowthJson(saved) !== canonicalGrowthJson(old)
      || old.operationDigest !== growthObjectDigest(operation)) throw new Error('retained parent observation changed')
  }
  return { cases: parsed.cases, schemas }
}

/** Independent paired Docker regression; this runtime has no LLM service and cannot switch a tool. */
export class RevisionRegressionReviewRuntime {
  readonly #compiled: ReturnType<typeof compileRevisionRegressionReviewConfig>
  readonly #store: CreationReviewStore<PluginRevisionRegressionCertificate>
  #runner: PluginBehaviorRunner | undefined
  #runnerLoading: Promise<PluginBehaviorRunner> | undefined
  readonly #abort = new AbortController()
  readonly #flights = new Map<string, Promise<PluginRevisionRegressionResult>>()
  #closing: Promise<void> | undefined

  constructor(private readonly ctx: Context, input: RevisionRegressionReviewConfig, databasePath: string,
    private readonly readParentCases: ReadParentCases) {
    this.#compiled = compileRevisionRegressionReviewConfig(input)
    this.#store = new CreationReviewStore<PluginRevisionRegressionCertificate>(databasePath + '.revision-regressions')
  }

  #loadRunner(): Promise<PluginBehaviorRunner> {
    if (this.#runner) return Promise.resolve(this.#runner)
    return this.#runnerLoading ??= import('./plugin-behavior-runner.js').then(({ PluginBehaviorRunner }) => {
      this.#abort.signal.throwIfAborted()
      const { config, authority } = this.#compiled
      if (Date.now() >= Math.min(config.expiresAt, config.runner.expiresAt)) throw new Error('regression runner authority expired')
      return this.#runner = new PluginBehaviorRunner({ ...config.runner, authorityDigest: authority.authorityDigest })
    })
  }

  inspect(input: { owner: RevisionRegressionReviewConfig['owner'] }): RevisionRegressionReviewAuthorityInspection | undefined {
    const { config, authority, publicKey } = this.#compiled
    if (this.#abort.signal.aborted || Date.now() >= config.expiresAt
      || canonicalGrowthJson(input.owner) !== canonicalGrowthJson(config.owner)) return undefined
    const remainingVerifications = this.#store.remaining(config.authorityId, authority.authorityDigest, config.maxVerifications)
    return Object.freeze({ authority, publicKey, remainingVerifications, available: remainingVerifications > 0 })
  }

  run(request: PluginRevisionRegressionRequest, external?: AbortSignal): Promise<PluginRevisionRegressionResult> {
    try { validatePluginRevisionRegressionRequest(request) }
    catch { return Promise.resolve({ status: 'rejected', reason: 'request-invalid' }) }
    if (this.#abort.signal.aborted) return Promise.resolve({ status: 'unknown', reason: 'interrupted' })
    const existing = this.#flights.get(request.planId)
    if (existing) return existing
    const flight = this.#run(request, external)
    this.#flights.set(request.planId, flight)
    void flight.finally(() => this.#flights.delete(request.planId)).catch(() => {})
    return flight
  }

  async #run(request: PluginRevisionRegressionRequest, external?: AbortSignal): Promise<PluginRevisionRegressionResult> {
    const { config, authority, privateKey, publicKey } = this.#compiled
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(config.maxDurationMs), ...(external ? [external] : [])])
    let admitted: { planId: string; binding: string } | undefined
    try {
      signal.throwIfAborted()
      const port = this.ctx.get('pluginControlPlane' as never) as PreparedRegressionPort | undefined
      if (!port || typeof port.inspectPreparedRevisionRegression !== 'function'
        || typeof port.withPreparedRevisionRegressionFence !== 'function'
        || typeof port.inspectPreparedRevisionReviewContext !== 'function') throw new Error('regression Host port unavailable')
      const snapshot = port.inspectPreparedRevisionRegression(request.planId)
      if (snapshot.protocol !== 'dsh-prepared-revision-regression/v1') throw new Error('regression Host protocol changed')
      const { plan, job, reference, candidate, parent } = snapshot
      validateSourceGrowthRunBinding(plan.sourceRevision?.growthRun)
      const frozen = plan.sourceRevision.growthRun
      validateRevisionRegressionAcceptanceAuthorityRef(frozen.revisionRegressionAcceptance)
      validatePluginRevisionVerificationCertificate(candidate.certificate)
      validatePluginCreationVerificationCertificate(parent.certificate)
      validatePluginRevisionParentBinding(parent.binding)
      const now = Date.now()
      const sourceBinding = { referenceDigest: sourceGrowthEvidenceDigest(reference),
        ownerDigest: sourceGrowthEvidenceDigest(reference.owner), growthRunDigest: sourceGrowthRunDigest(frozen) }
      const parentDigest = sourceGrowthEvidenceDigest(parent.binding)
      const candidateVerificationDigest = sourceGrowthEvidenceDigest(candidate.certificate)
      const authorityDigest = sourceGrowthEvidenceDigest(authority)
      if (plan.mode !== 'prepared-revise' || plan.status !== 'pending-approval' || plan.id !== request.planId
        || canonicalGrowthJson(frozen.revisionRegressionAcceptance) !== canonicalGrowthJson(authority)
        || canonicalGrowthJson(frozen) !== canonicalGrowthJson(job.intent.revision?.growthRun)
        || canonicalGrowthJson(parent.binding) !== canonicalGrowthJson(job.intent.revision?.parent)
        || canonicalGrowthJson(parent.binding) !== canonicalGrowthJson(plan.sourceRevision.parent)
        || canonicalGrowthJson(parent.binding) !== canonicalGrowthJson(candidate.certificate.parent)
        || parent.binding.planId !== parent.certificate.plan.id
        || parent.binding.certificateDigest !== sourceGrowthEvidenceDigest(parent.certificate)
        || parent.binding.artifactSha256 !== parent.certificate.plan.artifactSha256
        || candidate.certificate.plan.id !== plan.id || candidate.certificate.plan.digest !== plan.digest
        || candidate.certificate.plan.name !== plan.name || candidate.certificate.source.referenceDigest !== sourceBinding.referenceDigest
        || candidate.certificate.source.ownerDigest !== sourceBinding.ownerDigest
        || candidate.certificate.source.growthRunDigest !== sourceBinding.growthRunDigest
        || canonicalGrowthJson(candidate.certificate.model) !== canonicalGrowthJson(frozen.model)
        || candidate.certificate.plan.artifactSha256 !== createHash('sha256').update(candidate.artifact).digest('hex')
        || candidate.certificate.plan.artifactBytes !== candidate.artifact.length
        || parent.certificate.plan.artifactSha256 !== createHash('sha256').update(parent.artifact).digest('hex')
        || parent.certificate.plan.artifactBytes !== parent.artifact.length
        || typeof candidate.sourceDigest !== 'string' || !SHA.test(candidate.sourceDigest)
        || now >= Math.min(config.expiresAt, config.runner.expiresAt, plan.expiresAt,
          plan.sourceRevision.grant.expiresAt, frozen.expiresAt, authority.expiresAt, candidate.certificate.expiresAt)) {
        throw new Error('regression source or authority changed')
      }
      for (const key of ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset']) {
        if (reference.owner[key] !== config.owner[key as keyof typeof config.owner]) throw new Error('regression owner changed')
      }
      const fenceInput = { planId: plan.id, planDigest: plan.digest, artifactSha256: candidate.certificate.plan.artifactSha256,
        growthRunDigest: sourceBinding.growthRunDigest, referenceDigest: sourceBinding.referenceDigest,
        parentDigest, candidateVerificationDigest, sourceDigest: candidate.sourceDigest,
        regressionAuthorityDigest: authorityDigest }
      const fence = <T>(callback: () => T): T => port.withPreparedRevisionRegressionFence(fenceInput, callback)
      fence(() => {})
      const binding = growthObjectDigest({ purpose: PURPOSE, request, authority, fenceInput,
        parentCertificateDigest: parent.binding.certificateDigest, candidateVerificationDigest,
        budget: { maxCases: config.maxCases, maxDurationMs: config.maxDurationMs, maxRuns: 2 + 2 * config.maxCases } })
      const claim = fence(() => this.#store.claim(plan.id, binding, config.authorityId, authority.authorityDigest, config.maxVerifications))
      if (claim.state === 'certificate') return claim.certificate
        && verifyPluginRevisionRegressionCertificate(claim.certificate, authority, publicKey)
        ? { status: 'verified', certificate: claim.certificate } : { status: 'unknown', reason: 'stale-source' }
      if (claim.state === 'rejected') return { status: 'rejected', reason: claim.reason! }
      if (claim.state !== 'new') return { status: 'unknown', reason: claim.reason ?? 'previous-unknown' }
      admitted = { planId: plan.id, binding }

      const retained = retainedCases(this.readParentCases(parent.certificate), parent.certificate, config.maxCases)
      fence(() => {})
      const observer = await this.#loadRunner()
      const jobs = new Set<string>()
      const discover = async (side: 'parent' | 'candidate', artifact: Buffer, expectedSha: string): Promise<Observation> => {
        signal.throwIfAborted(); fence(() => {})
        const result = await observer.run({ key: growthObjectDigest([binding, side, 'discover']),
          artifact, operation: { kind: 'discover' }, signal })
        if (result.status !== 'observed' || !result.quiescent || !result.jobId || jobs.has(result.jobId)
          || result.artifactSha256 !== expectedSha || !result.schemaDigest || !result.schemas || !result.environment) {
          throw new Error(`${side} schema observation unknown`)
        }
        jobs.add(result.jobId); fence(() => {})
        return result
      }
      const parentDiscovery = await discover('parent', parent.artifact, parent.binding.artifactSha256)
      const candidateDiscovery = await discover('candidate', candidate.artifact, candidate.certificate.plan.artifactSha256)
      const parentSchemas = projectCreationSchemas(parentDiscovery.schemas!)
      const candidateSchemas = projectCreationSchemas(candidateDiscovery.schemas!)
      if (parentDiscovery.schemaDigest !== parent.certificate.schemaDigest
        || candidateDiscovery.schemaDigest !== candidate.certificate.schemaDigest
        || canonicalGrowthJson(parentSchemas) !== canonicalGrowthJson(retained.schemas)
        || canonicalGrowthJson(parentSchemas) !== canonicalGrowthJson(candidateSchemas)
        || canonicalGrowthJson(parentDiscovery.environment) !== canonicalGrowthJson(parent.certificate.environment)
        || canonicalGrowthJson(candidateDiscovery.environment) !== canonicalGrowthJson(candidate.certificate.environment)
        || canonicalGrowthJson(parentDiscovery.environment) !== canonicalGrowthJson(candidateDiscovery.environment)) {
        fence(() => this.#store.reject(plan.id, binding, 'schema-or-environment-mismatch'))
        admitted = undefined
        return { status: 'rejected', reason: 'schema-or-environment-mismatch' }
      }
      fence(() => this.#store.discovered(plan.id, binding, { parent: parentDiscovery.jobId, candidate: candidateDiscovery.jobId }))
      fence(() => this.#store.contract(plan.id, binding, { cases: retained.cases }))
      const observations: PluginRevisionRegressionCertificate['observations'][number][] = []
      for (const item of retained.cases) {
        signal.throwIfAborted(); fence(() => {})
        const operations = {
          parent: { kind: 'invoke' as const, schemaDigest: parentDiscovery.schemaDigest!,
            calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] },
          candidate: { kind: 'invoke' as const, schemaDigest: candidateDiscovery.schemaDigest!,
            calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] },
        }
        fence(() => this.#store.claimCase(plan.id, binding, item.id, growthObjectDigest(operations)))
        const pair: { parent?: PluginRevisionRegressionCertificate['observations'][number]['parent'];
          candidate?: PluginRevisionRegressionCertificate['observations'][number]['candidate'] } = {}
        for (const side of ['parent', 'candidate'] as const) {
          const operation = operations[side]
          const observed = await observer.run({ key: growthObjectDigest([binding, side, item.id, growthObjectDigest(operation)]),
            artifact: side === 'parent' ? parent.artifact : candidate.artifact, operation, signal })
          if (observed.status !== 'observed' || !observed.quiescent || !observed.jobId || jobs.has(observed.jobId)
            || observed.artifactSha256 !== (side === 'parent' ? parent.binding.artifactSha256 : candidate.certificate.plan.artifactSha256)
            || observed.schemaDigest !== operation.schemaDigest
            || canonicalGrowthJson(observed.environment) !== canonicalGrowthJson(parentDiscovery.environment)
            || observed.calls?.length !== 1 || observed.calls[0]?.id !== item.id
            || observed.calls[0]?.toolName !== item.toolName) throw new Error(`${side} case observation unknown`)
          jobs.add(observed.jobId)
          const raw = observed.calls[0].result
          if (!compareCase(item.expected, raw)) {
            const reason = side === 'parent' ? 'parent-baseline-mismatch' : 'candidate-regression'
            fence(() => this.#store.reject(plan.id, binding, reason))
            admitted = undefined
            return { status: 'rejected', reason }
          }
          pair[side] = { jobId: observed.jobId, operationDigest: growthObjectDigest(operation),
            observationDigest: growthObjectDigest(raw) }
          fence(() => {})
        }
        const complete = { caseId: item.id, parent: pair.parent!, candidate: pair.candidate! }
        fence(() => this.#store.observation(plan.id, binding, item.id, complete))
        observations.push(complete)
      }
      await port.inspectPreparedRevisionReviewContext(plan.id, signal)
      fence(() => this.#store.claimReview(plan.id, binding))
      const verifiedAt = Date.now()
      const expiresAt = Math.min(verifiedAt + config.receiptTtlMs, config.expiresAt, config.runner.expiresAt,
        plan.expiresAt, plan.sourceRevision.grant.expiresAt, frozen.expiresAt, candidate.certificate.expiresAt)
      if (expiresAt <= verifiedAt) throw new Error('regression verification windows closed')
      const body: Omit<PluginRevisionRegressionCertificate, 'signature'> = {
        protocol: 'assistant-growth/revision-regression/v1', verificationId: `regression-${binding.slice(0, 40)}`,
        authority, plan: candidate.certificate.plan, parent: parent.binding, source: sourceBinding,
        contractDigest: parent.certificate.contractDigest, schemaDigest: candidateDiscovery.schemaDigest!,
        environment: candidateDiscovery.environment!, model: frozen.model,
        candidateVerificationDigest, sourceDigest: candidate.sourceDigest,
        schemaCompatibilityDigest: growthObjectDigest(parentSchemas),
        budget: { maxCases: config.maxCases, maxDurationMs: config.maxDurationMs, maxRuns: 2 + 2 * config.maxCases },
        observations, verifiedAt, expiresAt,
      }
      const certificate = { ...body, signature: sign(null,
        Buffer.from(pluginRevisionRegressionSigningPayload(body)), privateKey).toString('base64url') }
      fence(() => this.#store.certificate(plan.id, binding, certificate))
      admitted = undefined
      return { status: 'verified', certificate }
    } catch {
      const reason = signal.aborted ? 'interrupted' : admitted ? 'regression-unknown' : 'stale-source'
      if (admitted) {
        try { this.#store.unknown(admitted.planId, admitted.binding, reason) } catch { /* retained claim remains no-replay */ }
      }
      return { status: 'unknown', reason }
    }
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#abort.abort(new Error('regression review disposed'))
      try {
        await Promise.allSettled(this.#flights.values())
        await this.#runnerLoading?.catch(() => undefined)
        await this.#runner?.close()
      } finally { this.#store.close() }
    })()
  }
}
