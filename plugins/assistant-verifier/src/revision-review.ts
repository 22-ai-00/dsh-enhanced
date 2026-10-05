import { createHash, sign, type KeyObject } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalGrowthJson, growthObjectDigest, pluginRevisionVerificationSigningPayload,
  sourceGrowthEvidenceDigest, sourceGrowthRunDigest, validatePluginRevisionParentBinding,
  validateRevisionAcceptanceAuthorityRef, validateSourceGrowthRunBinding,
  verifyPluginRevisionVerificationCertificate, type PluginRevisionParentBinding,
  type PluginRevisionVerificationCertificate, type PluginRevisionVerificationRequest,
  type PluginRevisionVerificationResult, type RevisionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import { CreationReviewStore } from './creation-review-store.js'
import { CASE_RULES, COMPARISON_RULES, REVIEW_RULES, RULES_VERSION, SCHEMA_RULES,
  compareCase, compileCreationReviewConfig, parseCases, parseReview, projectCreationSchemas,
  type CreationReviewConfig } from './creation-review.js'
import { runNativeCreationTurn, type CreationModel } from './creation-review-native.js'

type PluginBehaviorRunner = import('./plugin-behavior-runner.js').PluginBehaviorRunner

const SHA = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u
const REVISION_RULES = [
  'Review this as a revision of the exact adopted parent identified by the Host binding.',
  'Check the new authenticated task, feedback, exact candidate patch, scope and lifecycle ownership.',
  'Parent identity is a Host-checked digest binding; do not infer prior behavior from its digest.',
  'This review does not cover every prior behavior. Reject unsupported claims of complete regression safety.',
] as const
const REVISION_PURPOSE = 'assistant-growth/revision-review/v1'

/** Same bounded configuration shape as creation, with a separate policy digest and ledger. */
export type RevisionReviewConfig = CreationReviewConfig

export interface RevisionReviewAuthorityInspection {
  authority: RevisionAcceptanceAuthorityRef
  publicKey: string
  remainingVerifications: number
  available: boolean
}

export function validateRevisionReviewConfig(input: RevisionReviewConfig): RevisionReviewConfig {
  return compileCreationReviewConfig(input).config
}

export function compileRevisionReviewConfig(input: RevisionReviewConfig): {
  config: RevisionReviewConfig; authority: RevisionAcceptanceAuthorityRef; publicKey: string; privateKey: KeyObject
} {
  const checked = compileCreationReviewConfig(input)
  const authorityDigest = growthObjectDigest({ purpose: REVISION_PURPOSE,
    baseRules: RULES_VERSION, caseRules: CASE_RULES, comparisonRules: COMPARISON_RULES,
    schemaRules: SCHEMA_RULES, reviewRules: REVIEW_RULES, revisionRules: REVISION_RULES,
    configurationDigest: checked.authority.authorityDigest })
  const authority: RevisionAcceptanceAuthorityRef = {
    protocol: 'assistant-growth/revision-acceptance-authority/v1', authorityId: checked.config.authorityId,
    keyId: checked.config.keyId, authorityDigest, namePrefix: checked.config.namePrefix, expiresAt: checked.config.expiresAt,
  }
  validateRevisionAcceptanceAuthorityRef(authority)
  return { config: checked.config, authority: Object.freeze(authority), publicKey: checked.publicKey, privateKey: checked.privateKey }
}

export interface PreparedRevisionPort {
  inspectPreparedRevision(planId: string): {
    protocol: 'dsh-prepared-revision/v1'
    plan: { id: string; digest: string; name: string; mode: string; status: string; expiresAt: number;
      generatorDigest: string; sourceCheck?: { treeDigest: string; patchDigest: string };
      preparedEvidence?: { pack: { sha256: string; sizeBytes: number } };
      sourceRevision?: { grant: { namePrefix: string; expiresAt: number }; growthRun: unknown; parent: PluginRevisionParentBinding } }
    job: { intent: { revision?: unknown } }
    reference: { owner: Record<string, unknown>; sourceDigest: string; outcomeId: string }
    source: { owner: Record<string, unknown>; judgement: string;
      source: { objective: string; truncated: boolean; quiescent: boolean };
      feedback?: { text: string; truncated: boolean } }
    artifact: Buffer
  }
  withPreparedRevisionFence<T>(input: { planId: string; planDigest: string; artifactSha256: string;
    growthRunDigest: string; referenceDigest: string; parentDigest: string }, callback: () => T): T
  inspectPreparedRevisionReviewContext(planId: string, signal: AbortSignal): Promise<{ patch: string; changedPaths: string[] }>
}

function requestValid(value: unknown): value is PluginRevisionVerificationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.getOwnPropertyNames(value).sort().join(',') !== 'planId,protocol'
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable || !('value' in field))) return false
  const request = value as Record<string, unknown>
  return request.protocol === 'assistant-growth/revision-verification-request/v1'
    && typeof request.planId === 'string' && ID.test(request.planId) && request.planId.normalize('NFC') === request.planId
}

/** Independent Host review of a new task's candidate revision. It does not grant execution or replacement. */
export class RevisionReviewRuntime {
  readonly #compiled: ReturnType<typeof compileRevisionReviewConfig>
  readonly #store: CreationReviewStore<PluginRevisionVerificationCertificate>
  #runner: PluginBehaviorRunner | undefined
  #runnerLoading: Promise<PluginBehaviorRunner> | undefined
  readonly #abort = new AbortController()
  readonly #flights = new Map<string, Promise<PluginRevisionVerificationResult>>()
  #closing: Promise<void> | undefined

  constructor(private readonly ctx: Context, input: RevisionReviewConfig, databasePath: string) {
    this.#compiled = compileRevisionReviewConfig(input)
    this.#store = new CreationReviewStore<PluginRevisionVerificationCertificate>(databasePath + '.revision-reviews')
  }

  #loadRunner(): Promise<PluginBehaviorRunner> {
    if (this.#runner) return Promise.resolve(this.#runner)
    return this.#runnerLoading ??= import('./plugin-behavior-runner.js').then(({ PluginBehaviorRunner }) => {
      this.#abort.signal.throwIfAborted()
      const { config, authority } = this.#compiled
      if (Date.now() >= Math.min(config.expiresAt, config.runner.expiresAt)) throw new Error('revision observer authority expired')
      const runner = new PluginBehaviorRunner({ ...config.runner, authorityDigest: authority.authorityDigest })
      this.#runner = runner
      return runner
    })
  }

  inspect(input: { owner: RevisionReviewConfig['owner'] }): RevisionReviewAuthorityInspection | undefined {
    const { config, authority, publicKey } = this.#compiled
    if (this.#abort.signal.aborted || Date.now() >= config.expiresAt
      || canonicalGrowthJson(input.owner) !== canonicalGrowthJson(config.owner)) return undefined
    const remainingVerifications = this.#store.remaining(config.authorityId, authority.authorityDigest, config.maxVerifications)
    return Object.freeze({ authority, publicKey, remainingVerifications, available: remainingVerifications > 0 })
  }

  run(request: PluginRevisionVerificationRequest, external?: AbortSignal): Promise<PluginRevisionVerificationResult> {
    if (!requestValid(request)) return Promise.resolve({ status: 'rejected', reason: 'request-invalid' })
    if (this.#abort.signal.aborted) return Promise.resolve({ status: 'unknown', reason: 'interrupted' })
    const existing = this.#flights.get(request.planId)
    if (existing) return existing
    const flight = this.#run(request, external)
    this.#flights.set(request.planId, flight)
    void flight.finally(() => this.#flights.delete(request.planId)).catch(() => {})
    return flight
  }

  async #run(request: PluginRevisionVerificationRequest, external?: AbortSignal): Promise<PluginRevisionVerificationResult> {
    const { config, authority, privateKey, publicKey } = this.#compiled
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(config.maxDurationMs), ...(external ? [external] : [])])
    let admitted: { planId: string; binding: string } | undefined
    try {
      signal.throwIfAborted()
      const port = this.ctx.get('pluginControlPlane' as never) as PreparedRevisionPort | undefined
      if (!port || typeof port.inspectPreparedRevision !== 'function' || typeof port.withPreparedRevisionFence !== 'function'
        || typeof port.inspectPreparedRevisionReviewContext !== 'function') throw new Error('revision source port unavailable')
      const snapshot = port.inspectPreparedRevision(request.planId)
      if (snapshot.protocol !== 'dsh-prepared-revision/v1') throw new Error('revision source protocol changed')
      const { plan, source, reference, artifact } = snapshot
      const revision = plan.sourceRevision
      const intentRevision = snapshot.job.intent.revision as { growthRun?: unknown; parent?: unknown } | undefined
      const run = revision?.growthRun
      validateSourceGrowthRunBinding(run)
      const frozen = run
      validateRevisionAcceptanceAuthorityRef(frozen.revisionAcceptance)
      const parent = revision?.parent
      validatePluginRevisionParentBinding(parent)
      validatePluginRevisionParentBinding(intentRevision?.parent)
      validateSourceGrowthRunBinding(intentRevision?.growthRun)
      if (canonicalGrowthJson(frozen.revisionAcceptance) !== canonicalGrowthJson(authority)
        || canonicalGrowthJson(frozen) !== canonicalGrowthJson(intentRevision.growthRun)
        || canonicalGrowthJson(parent) !== canonicalGrowthJson(intentRevision.parent)
        || plan.mode !== 'prepared-revise' || plan.status !== 'pending-approval'
        || !plan.name.startsWith(config.namePrefix) || revision?.grant.namePrefix !== config.namePrefix
        || Date.now() >= Math.min(config.expiresAt, plan.expiresAt, revision.grant.expiresAt, frozen.expiresAt)
        || source.source.truncated || !source.source.quiescent || source.feedback?.truncated
        || source.judgement === 'unresolved' || !source.source.objective.trim()
        || Buffer.byteLength(source.source.objective) > 16_384 || !Buffer.isBuffer(artifact)
        || artifact.length !== plan.preparedEvidence?.pack.sizeBytes || artifact.length > 512 * 1024
        || createHash('sha256').update(artifact).digest('hex') !== plan.preparedEvidence?.pack.sha256
        || !plan.sourceCheck || !SHA.test(plan.sourceCheck.treeDigest) || !SHA.test(plan.sourceCheck.patchDigest)
        || sourceGrowthEvidenceDigest(reference.owner) !== frozen.ownerDigest) {
        throw new Error('prepared revision authority or task evidence invalid')
      }
      for (const key of ['authorityId', 'authorityHash', 'principalId', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset']) {
        if (reference.owner[key] !== config.owner[key as keyof typeof config.owner]
          || source.owner[key] !== config.owner[key as keyof typeof config.owner]) throw new Error('revision owner changed')
      }
      const sourceBinding = { referenceDigest: sourceGrowthEvidenceDigest(reference), ownerDigest: sourceGrowthEvidenceDigest(reference.owner),
        growthRunDigest: sourceGrowthRunDigest(frozen) }
      const parentDigest = sourceGrowthEvidenceDigest(parent)
      const fenceInput = { planId: plan.id, planDigest: plan.digest, artifactSha256: plan.preparedEvidence.pack.sha256,
        growthRunDigest: sourceBinding.growthRunDigest, referenceDigest: sourceBinding.referenceDigest, parentDigest }
      const fence = <T>(callback: () => T): T => port.withPreparedRevisionFence(fenceInput, callback)
      fence(() => {})
      const model: CreationModel = frozen.model
      const binding = growthObjectDigest({ purpose: REVISION_PURPOSE, request, authority, parent, parentDigest,
        plan: { id: plan.id, digest: plan.digest, tree: plan.sourceCheck.treeDigest, patch: plan.sourceCheck.patchDigest,
          artifact: plan.preparedEvidence.pack }, source: sourceBinding, model,
        budget: { maxOutputTokens: config.maxOutputTokens, maxDurationMs: config.maxDurationMs, maxCases: config.maxCases } })
      const claim = fence(() => this.#store.claim(plan.id, binding, config.authorityId, authority.authorityDigest, config.maxVerifications))
      if (claim.state === 'certificate') return claim.certificate && claim.certificate.expiresAt > Date.now()
        && canonicalGrowthJson(claim.certificate.parent) === canonicalGrowthJson(parent)
        && verifyPluginRevisionVerificationCertificate(claim.certificate, authority, publicKey)
        ? { status: 'verified', certificate: claim.certificate } : { status: 'unknown', reason: 'stale-source' }
      if (claim.state === 'rejected') return { status: 'rejected', reason: claim.reason! }
      if (claim.state !== 'new') return { status: 'unknown', reason: claim.reason ?? 'previous-unknown' }
      admitted = { planId: plan.id, binding }

      const observer = await this.#loadRunner()
      signal.throwIfAborted(); fence(() => {})
      const discovery = await observer.run({ key: growthObjectDigest([binding, 'discover']), artifact, operation: { kind: 'discover' }, signal })
      if (discovery.status !== 'observed' || !discovery.quiescent || !discovery.schemaDigest || !discovery.schemas
        || !discovery.environment || !discovery.jobId || discovery.artifactSha256 !== plan.preparedEvidence.pack.sha256) {
        this.#store.unknown(plan.id, binding, 'schema-observation-unknown')
        return { status: 'unknown', reason: 'schema-observation-unknown' }
      }
      const projectedSchemas = projectCreationSchemas(discovery.schemas)
      fence(() => this.#store.discovered(plan.id, binding, { jobId: discovery.jobId!, schemaDigest: discovery.schemaDigest!,
        schemas: projectedSchemas, environment: discovery.environment! }))
      const task = { objective: source.source.objective, feedback: source.feedback?.text ?? null,
        judgement: source.judgement, name: plan.name }
      const contract = await runNativeCreationTurn(this.ctx, { sessionId: `revision-contract-${binding.slice(0, 40)}`,
        owner: config.owner, model, maxInputBytes: config.maxInputBytes, maxOutputTokens: config.maxOutputTokens - 1,
        prompt: [...CASE_RULES, `Case limit: ${config.maxCases}.`, `Fixed owner acceptance policy: ${config.policy}`].join('\n'),
        data: { task, schemas: projectedSchemas }, signal, assertCurrent: () => fence(() => {}) })
      const cases = parseCases(contract.value, config.maxCases, projectedSchemas)
      if (cases.status === 'insufficient') {
        fence(() => this.#store.unknown(plan.id, binding, 'contract-insufficient'))
        return { status: 'unknown', reason: 'contract-insufficient' }
      }
      fence(() => this.#store.contract(plan.id, binding, { cases: cases.cases, outputDigest: contract.outputDigest,
        sessionId: contract.sessionId }))
      const observations: { caseId: string; jobId: string; operationDigest: string; observationDigest: string }[] = []
      const jobs = new Set([discovery.jobId])
      for (const item of cases.cases) {
        signal.throwIfAborted(); fence(() => {})
        const operation = { kind: 'invoke' as const, schemaDigest: discovery.schemaDigest,
          calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] }
        const operationDigest = growthObjectDigest(operation)
        fence(() => this.#store.claimCase(plan.id, binding, item.id, operationDigest))
        const observed = await observer.run({ key: growthObjectDigest([binding, 'invoke', operationDigest]), artifact, operation, signal })
        if (observed.status !== 'observed' || !observed.quiescent || !observed.jobId
          || observed.schemaDigest !== discovery.schemaDigest || observed.artifactSha256 !== plan.preparedEvidence.pack.sha256
          || canonicalGrowthJson(observed.environment) !== canonicalGrowthJson(discovery.environment)
          || observed.calls?.length !== 1 || observed.calls[0]?.id !== item.id || jobs.has(observed.jobId)) {
          this.#store.unknown(plan.id, binding, 'case-observation-unknown')
          return { status: 'unknown', reason: 'case-observation-unknown' }
        }
        const raw = observed.calls[0]!.result
        jobs.add(observed.jobId)
        const observationDigest = growthObjectDigest(raw)
        fence(() => this.#store.observation(plan.id, binding, item.id, { jobId: observed.jobId!, operationDigest, observationDigest }))
        observations.push({ caseId: item.id, jobId: observed.jobId, operationDigest, observationDigest })
        if (!compareCase(item.expected, raw)) {
          fence(() => this.#store.reject(plan.id, binding, 'case-mismatch'))
          return { status: 'rejected', reason: 'case-mismatch' }
        }
      }
      const context = await port.inspectPreparedRevisionReviewContext(plan.id, signal)
      fence(() => {})
      if (Buffer.byteLength(context.patch) > config.maxInputBytes / 2 || context.changedPaths.length < 1
        || context.changedPaths.length > 32) throw new Error('revision source review context exceeds bound')
      fence(() => this.#store.claimReview(plan.id, binding))
      const review = await runNativeCreationTurn(this.ctx, { sessionId: `revision-source-${binding.slice(0, 40)}`,
        owner: config.owner, model, maxInputBytes: config.maxInputBytes,
        maxOutputTokens: config.maxOutputTokens - contract.outputTokens,
        prompt: [...REVIEW_RULES, ...REVISION_RULES, `Fixed owner acceptance policy: ${config.policy}`].join('\n'),
        data: { task, parent, cases: cases.cases, changedPaths: context.changedPaths, patch: context.patch },
        signal, assertCurrent: () => fence(() => {}) })
      const verdict = parseReview(review.value)
      if (contract.outputTokens + review.outputTokens > config.maxOutputTokens) throw new Error('revision model budget exceeded')
      if (verdict.decision !== 'approved') {
        fence(() => this.#store.reject(plan.id, binding, 'source-review-rejected'))
        return { status: 'rejected', reason: 'source-review-rejected' }
      }
      const verifiedAt = Date.now()
      const expiresAt = Math.min(verifiedAt + config.receiptTtlMs, config.expiresAt, config.runner.expiresAt,
        plan.expiresAt, revision.grant.expiresAt, frozen.expiresAt)
      if (expiresAt <= verifiedAt) throw new Error('revision verification windows closed')
      const body: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
        protocol: 'assistant-growth/revision-verification/v1', verificationId: `revision-${binding.slice(0, 40)}`,
        authority, plan: { id: plan.id, digest: plan.digest, name: plan.name,
          sourceTreeDigest: plan.sourceCheck.treeDigest, sourcePatchDigest: plan.sourceCheck.patchDigest,
          artifactSha256: plan.preparedEvidence.pack.sha256, artifactBytes: artifact.length,
          generatorDigest: plan.generatorDigest }, parent, source: sourceBinding,
        contractDigest: growthObjectDigest(cases.cases), schemaDigest: discovery.schemaDigest,
        environment: discovery.environment, model,
        budget: { modelCalls: 2, maxOutputTokens: config.maxOutputTokens, maxDurationMs: config.maxDurationMs,
          maxCases: config.maxCases }, sessions: { contract: contract.sessionId, sourceReview: review.sessionId },
        observations, reviewDigest: review.outputDigest, verifiedAt, expiresAt,
      }
      const signature = sign(null, Buffer.from(pluginRevisionVerificationSigningPayload(body)), privateKey).toString('base64url')
      const certificate = { ...body, signature }
      fence(() => this.#store.certificate(plan.id, binding, certificate))
      admitted = undefined
      return { status: 'verified', certificate }
    } catch {
      const reason = signal.aborted ? 'interrupted' : admitted ? 'verification-unknown' : 'stale-source'
      if (admitted) {
        try { this.#store.unknown(admitted.planId, admitted.binding, reason) } catch { /* completed or closed ledger remains authoritative */ }
      }
      return { status: 'unknown', reason }
    }
  }

  close(): Promise<void> {
    return this.#closing ??= (async () => {
      this.#abort.abort(new Error('revision review disposed'))
      try {
        await Promise.allSettled(this.#flights.values())
        await this.#runnerLoading?.catch(() => undefined)
        await this.#runner?.close()
      } finally { this.#store.close() }
    })()
  }
}
