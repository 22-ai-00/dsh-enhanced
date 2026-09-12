import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import {
  HoldoutEvidenceStore, type HoldoutEvidenceVerifier, type HoldoutPlanCompletion, type HoldoutRunEvidence,
} from './holdout-evidence.js'
import type { HoldoutProviderTransport } from './holdout-provider.js'
import {
  holdoutAuthorityKeyId, holdoutEnvelopeDigest, holdoutInputBytes,
  parseSignedHoldoutFinish, parseSignedHoldoutInput, parseSignedHoldoutManifest, parseSignedHoldoutVerdict,
  type SignedHoldoutManifest,
} from './holdout-protocol.js'
import { runBenchmark, type BenchmarkExecutionRequest, type BenchmarkExecutor } from './runner.js'
import {
  BenchmarkError, benchmarkAssert, benchmarkHash, benchmarkObject, benchmarkPlanDigest, benchmarkSchedule,
  benchmarkSnapshot, benchmarkVersionKeys, parseBenchmarkMetrics, parseBenchmarkPlan,
} from './schema.js'
import { BenchmarkStore } from './store.js'
import type {
  BenchmarkBudget, BenchmarkCase, BenchmarkCell, BenchmarkMetrics, BenchmarkObservation, BenchmarkPlan, BenchmarkResult,
  BenchmarkVariant, BenchmarkVersions,
} from './types.js'

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_DELEGATE_CLOSE_TIMEOUT_MS = 10_000
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_CLOSE_TIMEOUT_MS = 300_000
const CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+/-]{0,126}(?:; charset=utf-8)?$/u

export interface HoldoutDatasetPin {
  readonly id: string
  readonly version: string
  readonly digest: string
}

export interface HoldoutDelegateRequest {
  readonly planId: string
  readonly dataset: BenchmarkPlan['dataset']
  readonly cell: BenchmarkCell
  readonly task: BenchmarkCase
  readonly variant: BenchmarkVariant
  readonly budget: BenchmarkBudget
  /** The private bytes are valid only for this call and are zeroed when it settles. */
  readonly input: { readonly contentType: string; readonly bytes: Uint8Array }
  readonly signal: AbortSignal
}

export interface HoldoutDelegateResult {
  readonly output: { readonly contentType: string; readonly bytes: Uint8Array }
  readonly versions: BenchmarkVersions
  /** Host measurements only. The runner owns elapsed latency. */
  readonly metrics: BenchmarkMetrics
  readonly executionEvidenceDigest: string
  readonly quiescent: boolean
}

export interface HoldoutDelegateBinding {
  execute(request: HoldoutDelegateRequest): Promise<HoldoutDelegateResult>
  close(): void | Promise<void>
}

export interface IndependentHoldoutOptions {
  readonly store: BenchmarkStore
  readonly evidence: HoldoutEvidenceStore
  readonly plan: BenchmarkPlan
  readonly expectedDataset: HoldoutDatasetPin
  readonly pinnedPublicKey: string
  readonly openProvider: (signal?: AbortSignal) => Promise<HoldoutProviderTransport>
  readonly openDelegate: (signal?: AbortSignal) => HoldoutDelegateBinding | Promise<HoldoutDelegateBinding>
  readonly maxOutputBytes?: number
  readonly delegateCloseTimeoutMs?: number
  /** Bounds arbitrary provider startup, requests, and close when no transport-level bound exists. */
  readonly providerTimeoutMs?: number
  readonly signal?: AbortSignal
}

export interface IndependentHoldoutResult {
  readonly results: readonly BenchmarkResult[]
  readonly completion?: Readonly<HoldoutPlanCompletion>
}

export type IndependentHoldoutContextOptions = Omit<IndependentHoldoutOptions, 'store' | 'evidence' | 'signal'> & {
  readonly databasePath: string
  readonly evidenceRoot: string
  readonly signal?: AbortSignal
}

function same(left: unknown, right: unknown): boolean {
  return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right)
}

function exactData(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  benchmarkAssert(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`)
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  benchmarkAssert(keys.length === fields.length
    && keys.every(key => typeof key === 'string' && fields.includes(key)), `${label} has unexpected fields`)
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key)!
    benchmarkAssert(descriptor.enumerable && Object.hasOwn(descriptor, 'value'), `${label} contains an unsafe property`)
  }
  return record
}

function boundedInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  const selected = value ?? fallback
  benchmarkAssert(typeof selected === 'number' && Number.isSafeInteger(selected)
    && selected >= 1 && selected <= maximum, `invalid ${label}`)
  return selected
}

function assertContentType(value: unknown, label: string): asserts value is string {
  benchmarkAssert(typeof value === 'string' && CONTENT_TYPE.test(value), `invalid ${label}`)
}

function validateDatasetPin(value: unknown, plan: Readonly<BenchmarkPlan>): Readonly<HoldoutDatasetPin> {
  const pin = exactData(value, ['id', 'version', 'digest'], 'holdout dataset pin')
  benchmarkHash(pin.digest)
  benchmarkAssert(typeof pin.id === 'string' && typeof pin.version === 'string'
    && same(pin, { id: plan.dataset.id, version: plan.dataset.version, digest: plan.dataset.digest }),
  'holdout plan differs from the operator-pinned dataset')
  return Object.freeze({ id: pin.id, version: pin.version, digest: pin.digest })
}

function validateManifest(value: unknown, plan: Readonly<BenchmarkPlan>, pinnedPublicKey: string): Readonly<SignedHoldoutManifest> {
  const manifest = parseSignedHoldoutManifest(value, pinnedPublicKey)
  benchmarkAssert(same(manifest.dataset, plan.dataset) && same(manifest.cases, plan.cases),
    'signed holdout manifest differs from the operator-pinned plan')
  return manifest
}

function validateBinding(value: unknown): HoldoutDelegateBinding {
  benchmarkAssert(value !== null && typeof value === 'object'
    && typeof (value as HoldoutDelegateBinding).execute === 'function'
    && typeof (value as HoldoutDelegateBinding).close === 'function', 'invalid holdout delegate binding')
  return value as HoldoutDelegateBinding
}

interface ValidatedDelegateResult {
  readonly outputContentType: string
  readonly outputBytes: Uint8Array
  readonly rawOutputBytes: Uint8Array
  readonly metrics: BenchmarkMetrics
  readonly executionEvidenceDigest: string
}

function validateDelegateResult(
  value: unknown, request: BenchmarkExecutionRequest, maxOutputBytes: number,
): ValidatedDelegateResult {
  const raw = exactData(value, ['output', 'versions', 'metrics', 'executionEvidenceDigest', 'quiescent'], 'holdout delegate result')
  const output = exactData(raw.output, ['contentType', 'bytes'], 'holdout delegate output')
  assertContentType(output.contentType, 'holdout output content type')
  benchmarkAssert(output.bytes instanceof Uint8Array && Object.getPrototypeOf(output.bytes) === Uint8Array.prototype,
    'holdout output bytes must be a Uint8Array')
  const rawOutputBytes = output.bytes
  benchmarkAssert(rawOutputBytes.byteLength <= maxOutputBytes, 'holdout output exceeds its byte limit')
  const outputBytes = Uint8Array.from(rawOutputBytes)
  const versions = benchmarkObject(benchmarkSnapshot(raw.versions), benchmarkVersionKeys)
  benchmarkAssert(same(versions, request.variant.versions), 'holdout delegate loaded different versions')
  const metrics = parseBenchmarkMetrics(raw.metrics)
  benchmarkAssert(metrics.latencyMs === null && metrics.inputTokens !== null && metrics.outputTokens !== null
    && metrics.toolCalls !== null && (request.budget.costUsdMicros === null || metrics.costUsdMicros !== null),
  'holdout delegate metrics are incomplete or contain adapter latency')
  benchmarkAssert(metrics.inputTokens <= request.budget.inputTokens && metrics.outputTokens <= request.budget.outputTokens
    && metrics.toolCalls <= request.budget.toolCalls
    && (request.budget.costUsdMicros === null || metrics.costUsdMicros! <= request.budget.costUsdMicros),
  'holdout delegate exceeded a Host budget')
  benchmarkHash(raw.executionEvidenceDigest)
  benchmarkAssert(raw.quiescent === true, 'holdout delegate did not prove quiescence')
  return Object.freeze({
    outputContentType: output.contentType, outputBytes, rawOutputBytes, metrics,
    executionEvidenceDigest: raw.executionEvidenceDigest,
  })
}

async function within<T>(promise: Promise<T>, milliseconds: number, message = 'holdout delegate cleanup was not confirmed'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new BenchmarkError(message)), milliseconds)
      timer.unref()
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function withinAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, milliseconds: number, message: string): Promise<T> {
  if (signal?.aborted) throw new BenchmarkError(message)
  let removeAbort: (() => void) | undefined
  try {
    const aborted = signal === undefined ? new Promise<never>(() => {}) : new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new BenchmarkError(message))
      signal.addEventListener('abort', abort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', abort)
    })
    return await within(Promise.race([promise, aborted]), milliseconds, message)
  } finally {
    removeAbort?.()
  }
}

/** Build the verifier used by a HoldoutEvidenceStore from the same operator-pinned key. */
export function createHoldoutEvidenceVerifier(pinnedPublicKey: string): HoldoutEvidenceVerifier {
  holdoutAuthorityKeyId(pinnedPublicKey)
  return Object.freeze({
    verifyManifest: (envelope: unknown) => parseSignedHoldoutManifest(envelope, pinnedPublicKey),
    verifyVerdict: (input: Parameters<HoldoutEvidenceVerifier['verifyVerdict']>[0]) => parseSignedHoldoutVerdict(
      input.envelope, input.manifest, input.planDigest, input.cell, input.outputDigest, pinnedPublicKey,
    ),
    verifyFinish: (input: Parameters<HoldoutEvidenceVerifier['verifyFinish']>[0]) => parseSignedHoldoutFinish(
      input.envelope, input.manifest, input.planDigest, input.cells, input.verdictEnvelopeDigests, pinnedPublicKey,
    ),
  })
}

function verifyPinnedRun(
  evidence: HoldoutEvidenceStore, plan: Readonly<BenchmarkPlan>, results: readonly BenchmarkResult[], pinnedPublicKey: string,
): Readonly<HoldoutRunEvidence> {
  const verified = evidence.verifyRun(plan, results)
  const manifest = validateManifest(verified.manifest.envelope, plan, pinnedPublicKey)
  const planDigest = benchmarkPlanDigest(plan)
  const cells = benchmarkSchedule(plan)
  benchmarkAssert(verified.verdicts.length === cells.length
    && verified.verdicts.every(item => item.manifestEvidenceDigest === verified.completion.manifestEvidenceDigest)
    && verified.finish.manifestEvidenceDigest === verified.completion.manifestEvidenceDigest,
  'holdout evidence combines different signed manifests')
  const verdictEnvelopeDigests = verified.verdicts.map((item, index) => {
    parseSignedHoldoutVerdict(item.envelope, manifest, planDigest, cells[index]!, item.host.outputDigest, pinnedPublicKey)
    return holdoutEnvelopeDigest(item.envelope)
  })
  parseSignedHoldoutFinish(
    verified.finish.envelope, manifest, planDigest, cells, verdictEnvelopeDigests, pinnedPublicKey,
  )
  return verified
}

/**
 * Run an authority-signed holdout without exposing private input to the journal or evidence store.
 * Recovery deliberately never replays a completed prefix: the authority transport owns its ordered
 * session state, and the v1 journal has no durable provider resume token.
 */
export async function runIndependentHoldout(options: IndependentHoldoutOptions): Promise<Readonly<IndependentHoldoutResult>> {
  benchmarkAssert(options !== null && typeof options === 'object'
    && options.store instanceof BenchmarkStore && options.evidence instanceof HoldoutEvidenceStore
    && typeof options.openProvider === 'function' && typeof options.openDelegate === 'function',
  'invalid independent holdout options')
  const plan = parseBenchmarkPlan(options.plan)
  benchmarkAssert(plan.dataset.split === 'holdout', 'independent holdout requires a holdout dataset')
  const expectedDataset = validateDatasetPin(options.expectedDataset, plan)
  benchmarkAssert(typeof options.pinnedPublicKey === 'string', 'invalid holdout public key')
  holdoutAuthorityKeyId(options.pinnedPublicKey)
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'holdout output byte limit')
  const delegateCloseTimeoutMs = boundedInteger(
    options.delegateCloseTimeoutMs, DEFAULT_DELEGATE_CLOSE_TIMEOUT_MS, MAX_CLOSE_TIMEOUT_MS, 'holdout delegate close timeout',
  )
  const providerTimeoutMs = boundedInteger(
    options.providerTimeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS, MAX_CLOSE_TIMEOUT_MS, 'holdout provider timeout',
  )
  const cells = benchmarkSchedule(plan)
  const planDigest = benchmarkPlanDigest(plan)

  options.store.create(plan)
  const status = options.store.status(plan.id)
  benchmarkAssert(status.runningCell === null, 'holdout journal has an unresolved running intent')
  const recorded = status.results
  if (recorded.some(result => result.status === 'unknown')) return Object.freeze({ results: recorded })
  const existingCompletion = options.evidence.readPlanCompletion(plan)
  if (recorded.length === cells.length) {
    benchmarkAssert(existingCompletion !== undefined, 'completed holdout journal has no signed finish marker')
    const verified = verifyPinnedRun(options.evidence, plan, recorded, options.pinnedPublicKey)
    return Object.freeze({ results: recorded, completion: verified.completion })
  }
  benchmarkAssert(recorded.length === 0 && existingCompletion === undefined,
    'partial holdout recovery requires a durable authority resume protocol')
  benchmarkAssert(!options.signal?.aborted, 'holdout run was aborted before provider startup')

  let provider: HoldoutProviderTransport | undefined
  let providerOpening: Promise<HoldoutProviderTransport> | undefined
  let providerClose: Promise<void> | undefined
  let delegate: HoldoutDelegateBinding | undefined
  let delegateOpening: Promise<HoldoutDelegateBinding> | undefined
  let delegateClose: Promise<void> | undefined
  let delegateExecution: Promise<unknown> | undefined
  let resourcesClosing = false
  let resourcesClose: Promise<void> | undefined
  const sensitiveInputs = new Set<Uint8Array>()

  const closeProvider = (opened: HoldoutProviderTransport): Promise<void> => providerClose ??= within(
    Promise.resolve().then(() => opened.close()), providerTimeoutMs, 'holdout provider cleanup was not confirmed',
  )

  const requestProvider = (operation: Parameters<HoldoutProviderTransport['request']>[0], value: unknown, signal?: AbortSignal): Promise<unknown> => {
    benchmarkAssert(provider !== undefined && !resourcesClosing && !signal?.aborted, 'holdout provider cannot request after cancellation')
    return withinAbort(Promise.resolve().then(() => provider!.request(operation, value, signal)), signal, providerTimeoutMs,
      `holdout provider ${operation} was not confirmed`)
  }

  const getDelegate = async (signal: AbortSignal): Promise<HoldoutDelegateBinding> => {
    benchmarkAssert(!resourcesClosing && !signal.aborted, 'holdout delegate cannot start after cancellation')
    delegateOpening ??= Promise.resolve(options.openDelegate(signal)).then(validateBinding)
    const opened = await delegateOpening
    delegate = opened
    if (resourcesClosing || signal.aborted) {
      delegateClose ??= within(Promise.resolve().then(() => opened.close()), delegateCloseTimeoutMs)
      await delegateClose
    }
    benchmarkAssert(!resourcesClosing && !signal.aborted, 'holdout delegate opened after cancellation')
    return opened
  }

  const closeResources = (awaitExecution = true): Promise<void> => resourcesClose ??= (async () => {
    resourcesClosing = true
    for (const bytes of sensitiveInputs) bytes.fill(0)
    const execution = delegateExecution
    const openingSettlement = (async () => {
      let opened = delegate
      if (opened === undefined && delegateOpening !== undefined) opened = await within(delegateOpening, delegateCloseTimeoutMs)
      return opened
    })()
    const delegateCloseSettlement = openingSettlement.then(opened => {
      if (opened === undefined) return
      delegateClose ??= within(Promise.resolve().then(() => opened.close()), delegateCloseTimeoutMs)
      return delegateClose
    })
    const executionSettlement = awaitExecution && execution !== undefined
      ? within(execution.then(() => undefined, () => undefined), delegateCloseTimeoutMs)
      : Promise.resolve()
    const providerSettlement = provider === undefined ? Promise.resolve() : closeProvider(provider)
    const settlements = await Promise.allSettled([delegateCloseSettlement, executionSettlement, providerSettlement])
    const failed = settlements.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  })()

  try {
    providerOpening = Promise.resolve().then(() => options.openProvider(options.signal))
    // A startup loser can resolve after the owning Fiber has finished. It must be closed without
    // touching the journal or evidence stores, and its cleanup rejection must remain observed.
    void providerOpening.then(opened => {
      if (resourcesClosing || options.signal?.aborted) void closeProvider(opened).catch(() => undefined)
    }, () => undefined)
    const openedProvider = await withinAbort(providerOpening, options.signal, providerTimeoutMs, 'holdout provider startup was not confirmed')
    benchmarkAssert(!resourcesClosing && !options.signal?.aborted, 'holdout provider opened after cancellation')
    provider = openedProvider
    benchmarkAssert(provider !== null && typeof provider === 'object'
      && typeof provider.request === 'function' && typeof provider.close === 'function', 'invalid holdout provider binding')
    const manifest = validateManifest(await requestProvider('manifest', { expectedDataset }, options.signal), plan, options.pinnedPublicKey)
    options.evidence.writeManifest({ plan, manifest })

    const verdictEvidenceDigests: string[] = []
    const verdictEnvelopeDigests: string[] = []
    const failureSnapshots = new Map<string, BenchmarkObservation>()
    let nextCell = 0

    const executor: BenchmarkExecutor = Object.freeze({
      async execute(request: BenchmarkExecutionRequest): Promise<BenchmarkObservation> {
        const expectedCell = cells[nextCell]
        benchmarkAssert(expectedCell !== undefined && same(request.cell, expectedCell) && request.planId === plan.id
          && same(request.dataset, plan.dataset) && same(request.budget, plan.budget), 'holdout runner request order or identity drifted')
        benchmarkAssert(!request.signal.aborted && !resourcesClosing, 'holdout cell was cancelled before input')
        const inputEnvelope = parseSignedHoldoutInput(
          await requestProvider('input', { plan, cell: request.cell }, request.signal),
          manifest, planDigest, request.cell, options.pinnedPublicKey,
        )
        const inputBytes = holdoutInputBytes(inputEnvelope)
        sensitiveInputs.add(inputBytes)
        let rawOutputBytes: Uint8Array | undefined
        let outputBytes: Uint8Array | undefined
        try {
          const binding = await getDelegate(request.signal)
          const execution = Promise.resolve().then(() => binding.execute(Object.freeze({
            planId: plan.id, dataset: plan.dataset, cell: request.cell, task: request.task, variant: request.variant, budget: request.budget,
            input: Object.freeze({ contentType: inputEnvelope.contentType, bytes: inputBytes }), signal: request.signal,
          })))
          delegateExecution = execution
          const delegateResult = await execution
          delegateExecution = undefined
          if (delegateResult !== null && typeof delegateResult === 'object') {
            const candidate = Object.getOwnPropertyDescriptor(delegateResult, 'output')?.value
            if (candidate !== null && typeof candidate === 'object') {
              const bytes = Object.getOwnPropertyDescriptor(candidate, 'bytes')?.value
              if (bytes instanceof Uint8Array) rawOutputBytes = bytes
            }
          }
          const validated = validateDelegateResult(delegateResult, request, maxOutputBytes)
          rawOutputBytes = validated.rawOutputBytes
          outputBytes = validated.outputBytes
          benchmarkAssert(!request.signal.aborted && !resourcesClosing, 'holdout cell was cancelled after delegate settlement')
          const outputDigest = createHash('sha256').update(outputBytes).digest('hex')
          const verdict = parseSignedHoldoutVerdict(await requestProvider('verdict', {
            planDigest, cell: request.cell, inputEnvelopeDigest: holdoutEnvelopeDigest(inputEnvelope),
            output: {
              contentType: validated.outputContentType,
              outputBase64url: Buffer.from(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength).toString('base64url'),
              outputDigest,
            },
          }, request.signal), manifest, planDigest, request.cell, outputDigest, options.pinnedPublicKey)
          benchmarkAssert(!request.signal.aborted && !resourcesClosing, 'holdout cell was cancelled after authority verdict')
          const saved = options.evidence.writeVerdict({
            plan, manifest, cell: request.cell, outputDigest,
            host: { versions: request.variant.versions, hostMetrics: validated.metrics, quiescent: true,
              executionEvidenceDigest: validated.executionEvidenceDigest, outputDigest },
            envelope: verdict,
          })
          const observation: BenchmarkObservation = Object.freeze({
            versions: request.variant.versions, inputDigest: inputEnvelope.inputDigest, acceptanceDigest: verdict.acceptanceDigest,
            verdict: verdict.verdict, metrics: validated.metrics, evidenceDigest: saved.digest, quiescent: true,
          })
          if (verdict.verdict === 'unknown') {
            failureSnapshots.set(request.cell.id, observation)
            throw new BenchmarkError('holdout authority returned an unknown verdict')
          }
          verdictEvidenceDigests.push(saved.digest)
          verdictEnvelopeDigests.push(holdoutEnvelopeDigest(verdict))
          nextCell++
          if (nextCell === cells.length) {
            const finish = parseSignedHoldoutFinish(await requestProvider('finish', {
              planDigest, cells, verdictEnvelopeDigests,
            }, request.signal), manifest, planDigest, cells, verdictEnvelopeDigests, options.pinnedPublicKey)
            benchmarkAssert(finish.complete && !request.signal.aborted, 'holdout authority did not finalize the complete plan')
            // This is the current execution promise; waiting for it here would await ourselves.
            await closeResources(false)
            benchmarkAssert(!request.signal.aborted, 'holdout cell was cancelled while resources were closing')
            options.evidence.writeFinish({ plan, manifest, verdictEvidenceDigests, envelope: finish })
            benchmarkAssert(!request.signal.aborted, 'holdout cell was cancelled while finish evidence was published')
          }
          return observation
        } finally {
          delegateExecution = undefined
          outputBytes?.fill(0)
          rawOutputBytes?.fill(0)
          inputBytes.fill(0)
          sensitiveInputs.delete(inputBytes)
        }
      },
      failure(request: BenchmarkExecutionRequest): BenchmarkObservation | undefined {
        return failureSnapshots.get(request.cell.id)
      },
    })

    const results = await runBenchmark(options.store, plan, executor, options.signal)
    if (results.length === cells.length && results.every(result => result.status === 'completed')) {
      const verified = verifyPinnedRun(options.evidence, plan, results, options.pinnedPublicKey)
      return Object.freeze({ results, completion: verified.completion })
    }
    return Object.freeze({ results })
  } finally {
    await closeResources()
  }
}

/**
 * Fiber-owned Host entrypoint. Store descriptors and the authority/delegate session belong to the
 * current Cordis Fiber; unloading aborts admission, awaits the run's bounded cleanup, then closes
 * both stores. Calling the plain SDK entrypoint remains explicit and never mounts a plugin.
 */
export function runIndependentHoldoutInContext(
  ctx: Context, options: IndependentHoldoutContextOptions,
): Promise<Readonly<IndependentHoldoutResult>> {
  benchmarkAssert(ctx !== null && typeof ctx === 'object' && typeof ctx.effect === 'function', 'invalid Cordis holdout context')
  let task: Promise<Readonly<IndependentHoldoutResult>> | undefined
  let closeOwned: (() => Promise<void>) | undefined
  const disposeEffect = ctx.effect(() => {
    const lifecycle = new AbortController()
    const store = new BenchmarkStore(options.databasePath)
    let evidence: HoldoutEvidenceStore
    try {
      evidence = new HoldoutEvidenceStore({ root: options.evidenceRoot, verifier: createHoldoutEvidenceVerifier(options.pinnedPublicKey) })
    } catch (error) {
      store.close()
      throw error
    }
    const signal = options.signal === undefined ? lifecycle.signal : AbortSignal.any([lifecycle.signal, options.signal])
    task = runIndependentHoldout({ ...options, store, evidence, signal })
    let closePromise: Promise<void> | undefined
    closeOwned = () => closePromise ??= (async () => {
      lifecycle.abort()
      try { await task } catch { /* The caller observes the original run error. */ }
      let firstError: unknown
      try { evidence.close() } catch (error) { firstError = error }
      try { store.close() } catch (error) { firstError ??= error }
      if (firstError !== undefined) throw firstError
    })()
    return closeOwned
  }, 'independent holdout run')
  benchmarkAssert(task !== undefined && closeOwned !== undefined, 'Cordis did not synchronously register the holdout effect')
  const running = task
  const close = closeOwned
  return running.finally(async () => {
    await close()
    await disposeEffect()
  })
}

export { HoldoutEvidenceError, HoldoutEvidenceStore } from './holdout-evidence.js'
export type {
  HoldoutEvidenceReference, HoldoutEvidenceStoreOptions, HoldoutEvidenceVerifier, HoldoutFinishEvidence,
  HoldoutFinishWrite, HoldoutHostEvidence, HoldoutManifestEvidence, HoldoutManifestWrite, HoldoutPlanCompletion,
  HoldoutRunEvidence, HoldoutVerdictEvidence, HoldoutVerdictWrite,
} from './holdout-evidence.js'
export { HoldoutProviderError, openHoldoutProvider } from './holdout-provider.js'
export type {
  HoldoutProviderConfig, HoldoutProviderErrorCode, HoldoutProviderOperation, HoldoutProviderTransport,
} from './holdout-provider.js'
export {
  HOLDOUT_PROTOCOL_V1, holdoutAuthorityKeyId, holdoutEnvelopeDigest, holdoutInputBytes, holdoutUnsignedCanonicalJson,
  holdoutVerdictsDigest, parseSignedHoldoutFinish, parseSignedHoldoutInput, parseSignedHoldoutManifest,
  parseSignedHoldoutVerdict, verifyHoldoutEnvelopeSignature,
} from './holdout-protocol.js'
export type { SignedHoldoutFinish, SignedHoldoutInput, SignedHoldoutManifest, SignedHoldoutVerdict } from './holdout-protocol.js'
