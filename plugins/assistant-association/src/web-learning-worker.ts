import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertReadOnlyWebToolSurface,
  extractPlainTextFromHtml,
  fetchWebPageReadOnly,
  validateWhitelistedWebUrl,
  WebFetchError,
  type WebFetchDeps,
  type WebFetchRejectionCode,
} from './web-fetch.ts'

const MAX_WORKER_STDIN_BYTES = 512 * 1024
const DEFAULT_MAX_DISCOVERED_LINKS = 2

export interface WebLearningPlanTarget {
  readonly url: string
  readonly interestKey: string
  readonly originNodeIds?: readonly string[]
  readonly discoverLinks?: boolean
  readonly maxDiscoveredLinks?: number
}

export interface WebLearningWorkerBudget {
  readonly maxRequests: number
  readonly maxPages: number
  readonly maxBytesPerRequest: number
  readonly maxTotalBytes: number
  readonly maxDurationMs: number
  readonly requestTimeoutMs: number
  readonly maxRedirects?: number
}

export interface WebLearningWorkerInput {
  readonly runId: string
  readonly allowedDomains: readonly string[]
  readonly allowSubdomains?: boolean
  readonly allowIpv6?: boolean
  readonly targets: readonly WebLearningPlanTarget[]
  readonly budget: WebLearningWorkerBudget
  readonly toolSurface?: readonly string[]
}

export interface WebLearningFetchedPage {
  readonly sourceUrl: string
  readonly finalUrl: string
  readonly fetchedAt: number
  readonly title: string
  readonly text: string
  readonly contentType: string
  readonly contentDigest: string
  readonly bytesFetched: number
  readonly interestKey: string
  readonly originNodeIds: readonly string[]
  readonly links: readonly string[]
}

export interface WebLearningFetchAttempt {
  readonly url: string
  readonly finalUrl?: string
  readonly interestKey: string
  readonly ok: boolean
  readonly status?: number
  readonly rejectionCode?: WebFetchRejectionCode | 'budget-exhausted' | 'error'
  readonly error?: string
  readonly bytesFetched: number
  readonly requestsUsed: number
  readonly fetchedAt: number
}

export type WebLearningWorkerStatus =
  | 'completed'
  | 'budget-exhausted'
  | 'rejected'
  | 'aborted'

export interface WebLearningEnvironmentProof {
  readonly pid: number
  readonly cwd: string
  readonly envKeys: readonly string[]
}

export interface WebLearningWorkerOutput {
  readonly runId: string
  readonly status: WebLearningWorkerStatus
  readonly reason: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly requestsUsed: number
  readonly pagesFetched: number
  readonly bytesFetched: number
  readonly pages: readonly WebLearningFetchedPage[]
  readonly attempts: readonly WebLearningFetchAttempt[]
  readonly environmentProof: WebLearningEnvironmentProof
}

export interface WebLearningWorkerDeps extends WebFetchDeps {
  readonly signal?: AbortSignal
}

class BudgetExhaustedError extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(`web-learning: budget exhausted (${reason})`)
    this.name = 'BudgetExhaustedError'
    this.reason = reason
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function captureEnvironmentProof(): WebLearningEnvironmentProof {
  return {
    pid: process.pid,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
  }
}

export async function executeWebLearningPlan(
  input: WebLearningWorkerInput,
  deps?: WebLearningWorkerDeps,
): Promise<WebLearningWorkerOutput> {
  const now = deps?.now ?? Date.now
  const startedAt = now()

  assertReadOnlyWebToolSurface(input.toolSurface ?? [])

  if (input.allowedDomains.length === 0) {
    return {
      runId: input.runId,
      status: 'rejected',
      reason: 'rejected-empty-whitelist',
      startedAt,
      finishedAt: now(),
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      pages: [],
      attempts: [],
      environmentProof: captureEnvironmentProof(),
    }
  }

  const { budget } = input
  if (
    budget.maxRequests <= 0
    || budget.maxPages <= 0
    || budget.maxBytesPerRequest <= 0
    || budget.maxTotalBytes <= 0
    || budget.maxDurationMs <= 0
    || budget.requestTimeoutMs <= 0
  ) {
    return {
      runId: input.runId,
      status: 'budget-exhausted',
      reason: 'budget-exhausted-at-start',
      startedAt,
      finishedAt: now(),
      requestsUsed: 0,
      pagesFetched: 0,
      bytesFetched: 0,
      pages: [],
      attempts: [],
      environmentProof: captureEnvironmentProof(),
    }
  }

  let requestsUsed = 0
  let pagesFetched = 0
  let bytesFetched = 0
  let status: WebLearningWorkerStatus = 'completed'
  let reason = 'completed'

  const pages: WebLearningFetchedPage[] = []
  const attempts: WebLearningFetchAttempt[] = []
  const seenUrls = new Set<string>()
  const queue: WebLearningPlanTarget[] = [...input.targets]

  for (let index = 0; index < queue.length; index += 1) {
    const target = queue[index]!

    if (deps?.signal?.aborted) {
      status = 'aborted'
      reason = 'aborted'
      break
    }
    if (requestsUsed >= budget.maxRequests) {
      status = 'budget-exhausted'
      reason = 'max-requests-exhausted'
      break
    }
    if (pagesFetched >= budget.maxPages) {
      status = 'budget-exhausted'
      reason = 'max-pages-exhausted'
      break
    }
    if (bytesFetched >= budget.maxTotalBytes) {
      status = 'budget-exhausted'
      reason = 'max-bytes-exhausted'
      break
    }
    const elapsedMs = now() - startedAt
    if (elapsedMs >= budget.maxDurationMs) {
      status = 'budget-exhausted'
      reason = 'max-duration-exhausted'
      break
    }

    let candidateCanonical: string | undefined
    try {
      candidateCanonical = validateWhitelistedWebUrl(target.url, {
        allowedDomains: input.allowedDomains,
        ...(input.allowSubdomains === undefined ? {} : { allowSubdomains: input.allowSubdomains }),
      }).canonicalUrl
    } catch {
      // Let fetchWebPageReadOnly produce the structured rejection attempt.
    }

    if (candidateCanonical !== undefined && seenUrls.has(candidateCanonical)) {
      continue
    }

    const remainingTotalBytes = budget.maxTotalBytes - bytesFetched
    const effectiveMaxBytes = Math.min(budget.maxBytesPerRequest, remainingTotalBytes)
    if (effectiveMaxBytes <= 0) {
      status = 'budget-exhausted'
      reason = 'max-bytes-exhausted'
      break
    }

    const remainingDurationMs = Math.max(1, budget.maxDurationMs - elapsedMs)
    const effectiveTimeoutMs = Math.min(budget.requestTimeoutMs, remainingDurationMs)
    const requestsBefore = requestsUsed

    try {
      const result = await fetchWebPageReadOnly(
        {
          url: target.url,
          allowedDomains: input.allowedDomains,
          ...(input.allowSubdomains === undefined ? {} : { allowSubdomains: input.allowSubdomains }),
          ...(input.allowIpv6 === undefined ? {} : { allowIpv6: input.allowIpv6 }),
          maxBytes: effectiveMaxBytes,
          requestTimeoutMs: effectiveTimeoutMs,
          ...(budget.maxRedirects === undefined ? {} : { maxRedirects: budget.maxRedirects }),
          ...(deps?.signal === undefined ? {} : { signal: deps.signal }),
          onBeforeRequest: () => {
            if (requestsUsed >= budget.maxRequests) {
              throw new BudgetExhaustedError('max-requests-exhausted')
            }
            if (now() - startedAt >= budget.maxDurationMs) {
              throw new BudgetExhaustedError('max-duration-exhausted')
            }
            requestsUsed += 1
          },
        },
        deps,
      )

      seenUrls.add(result.sourceUrl)
      seenUrls.add(result.finalUrl)
      bytesFetched += result.bytesFetched
      pagesFetched += 1

      const extracted = extractPlainTextFromHtml(result.bodyText, {
        contentType: result.contentType,
        baseUrl: result.finalUrl,
        allowedDomains: input.allowedDomains,
        ...(input.allowSubdomains === undefined ? {} : { allowSubdomains: input.allowSubdomains }),
      })

      const page: WebLearningFetchedPage = {
        sourceUrl: result.finalUrl,
        finalUrl: result.finalUrl,
        fetchedAt: result.fetchedAt,
        title: extracted.title,
        text: extracted.text,
        contentType: result.contentType,
        contentDigest: sha256Hex(extracted.text),
        bytesFetched: result.bytesFetched,
        interestKey: target.interestKey,
        originNodeIds: [...(target.originNodeIds ?? [])],
        links: extracted.links,
      }
      pages.push(page)
      attempts.push({
        url: target.url,
        finalUrl: result.finalUrl,
        interestKey: target.interestKey,
        ok: true,
        status: result.status,
        bytesFetched: result.bytesFetched,
        requestsUsed: requestsUsed - requestsBefore,
        fetchedAt: result.fetchedAt,
      })

      if (
        target.discoverLinks
        && pagesFetched < budget.maxPages
        && requestsUsed < budget.maxRequests
        && bytesFetched < budget.maxTotalBytes
      ) {
        const linkLimit = Math.max(0, target.maxDiscoveredLinks ?? DEFAULT_MAX_DISCOVERED_LINKS)
        let added = 0
        for (const link of extracted.links) {
          if (added >= linkLimit) break
          if (seenUrls.has(link)) continue
          queue.push({
            url: link,
            interestKey: target.interestKey,
            ...(target.originNodeIds === undefined ? {} : { originNodeIds: target.originNodeIds }),
            discoverLinks: false,
          })
          added += 1
        }
      }
    } catch (error) {
      const attemptRequests = requestsUsed - requestsBefore
      if (error instanceof BudgetExhaustedError) {
        attempts.push({
          url: target.url,
          interestKey: target.interestKey,
          ok: false,
          rejectionCode: 'budget-exhausted',
          error: error.message,
          bytesFetched: 0,
          requestsUsed: attemptRequests,
          fetchedAt: now(),
        })
        status = 'budget-exhausted'
        reason = error.reason
        break
      }

      if (error instanceof WebFetchError) {
        if (error.code === 'rejected-empty-whitelist') {
          attempts.push({
            url: target.url,
            interestKey: target.interestKey,
            ok: false,
            rejectionCode: 'rejected-empty-whitelist',
            error: error.message,
            bytesFetched: 0,
            requestsUsed: attemptRequests,
            fetchedAt: now(),
          })
          status = 'rejected'
          reason = 'rejected-empty-whitelist'
          break
        }
        if (error.code === 'rejected-aborted' && deps?.signal?.aborted) {
          attempts.push({
            url: target.url,
            interestKey: target.interestKey,
            ok: false,
            rejectionCode: 'rejected-aborted',
            error: error.message,
            bytesFetched: 0,
            requestsUsed: attemptRequests,
            fetchedAt: now(),
          })
          status = 'aborted'
          reason = 'aborted'
          break
        }
        if (error.code === 'rejected-timeout' && now() - startedAt >= budget.maxDurationMs) {
          attempts.push({
            url: target.url,
            interestKey: target.interestKey,
            ok: false,
            rejectionCode: 'rejected-timeout',
            error: error.message,
            bytesFetched: 0,
            requestsUsed: attemptRequests,
            fetchedAt: now(),
          })
          status = 'budget-exhausted'
          reason = 'max-duration-exhausted'
          break
        }
        if (
          error.code === 'rejected-size'
          && (remainingTotalBytes <= 0 || remainingTotalBytes < budget.maxBytesPerRequest)
        ) {
          attempts.push({
            url: target.url,
            interestKey: target.interestKey,
            ok: false,
            rejectionCode: 'budget-exhausted',
            error: error.message,
            bytesFetched: 0,
            requestsUsed: attemptRequests,
            fetchedAt: now(),
          })
          status = 'budget-exhausted'
          reason = 'max-bytes-exhausted'
          break
        }
        attempts.push({
          url: target.url,
          interestKey: target.interestKey,
          ok: false,
          rejectionCode: error.code,
          error: error.message,
          bytesFetched: 0,
          requestsUsed: attemptRequests,
          fetchedAt: now(),
        })
        continue
      }

      attempts.push({
        url: target.url,
        interestKey: target.interestKey,
        ok: false,
        rejectionCode: 'error',
        error: error instanceof Error ? error.message : String(error),
        bytesFetched: 0,
        requestsUsed: attemptRequests,
        fetchedAt: now(),
      })
    }
  }

  return {
    runId: input.runId,
    status,
    reason,
    startedAt,
    finishedAt: now(),
    requestsUsed,
    pagesFetched,
    bytesFetched,
    pages,
    attempts,
    environmentProof: captureEnvironmentProof(),
  }
}

async function readBoundedStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const rawChunk of process.stdin) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    total += chunk.byteLength
    if (total > maxBytes) {
      throw new Error(`web-learning-worker: stdin exceeded ${maxBytes} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

function isDirectMainEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  const selfPath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(selfPath) === realpathSync(resolve(entry))
  } catch {
    return selfPath === resolve(entry)
  }
}

async function runCliMain(): Promise<void> {
  const controller = new AbortController()
  const onTerminate = () => controller.abort(new Error('web-learning-worker: terminated'))
  process.once('SIGTERM', onTerminate)
  process.once('SIGINT', onTerminate)
  try {
    const raw = await readBoundedStdin(MAX_WORKER_STDIN_BYTES)
    const parsed = JSON.parse(raw) as WebLearningWorkerInput
    const output = await executeWebLearningPlan(parsed, { signal: controller.signal })
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ error: message })}\n`)
    process.exitCode = 1
  } finally {
    process.off('SIGTERM', onTerminate)
    process.off('SIGINT', onTerminate)
  }
}

if (isDirectMainEntry()) {
  void runCliMain()
}
