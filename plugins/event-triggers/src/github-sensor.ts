import { createHash } from 'node:crypto'
import { readHttpJsonValue, type Fetcher, type Lookup, type OperationTracker, type SensorObservation } from './sensors.js'

const API = 'https://api.github.com'
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u
const oid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,128}$/iu.test(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const fail = (): never => { throw new Error('event-triggers: GitHub repository observation is unavailable') }
const fingerprint = (value: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
const record = (value: unknown): Record<string, unknown> => plain(value) ? value : fail()
function text(value: unknown, maximum = 256): string { if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.trim() !== value || /\p{Cc}/u.test(value)) fail(); return value as string }
function pullRequest(value: unknown, repository: string, branch: string, baseBranch: string): { number: number; headOid: string } {
  const item = record(value), head = record(item.head), base = record(item.base), headRepository = record(head.repo), baseRepository = record(base.repo)
  if (!positive(item.number) || item.state !== 'open' || head.ref !== branch || base.ref !== baseBranch || !oid(head.sha) || headRepository.full_name !== repository || baseRepository.full_name !== repository) fail()
  return { number: item.number as number, headOid: head.sha as string }
}
function branchHead(value: unknown, branch: string): string {
  const item = record(value), commit = record(item.commit)
  if (item.name !== branch || !oid(commit.sha)) fail()
  return commit.sha as string
}
function list(value: unknown): unknown[] { if (!Array.isArray(value) || value.length >= 100) fail(); return value as unknown[] }
interface Check { id: number; name: string; appId: number; headOid: string; status: string; conclusion: string | null }
function checkRuns(value: unknown): { headOid: string | null; checks: readonly Check[] } {
  const body = record(value), raw = body.check_runs
  if (!Array.isArray(raw) || !Number.isSafeInteger(body.total_count)) fail()
  const total = body.total_count as number, items = raw as unknown[]
  if (total !== items.length || total > 100 || items.length >= 100) fail()
  const ids = new Set<number>()
  const checks: Check[] = items.map(item => {
    const check = record(item), app = record(check.app)
    if (!positive(check.id) || ids.has(check.id as number) || !positive(app.id) || !oid(check.head_sha)
      || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(String(check.status))
      || (check.conclusion !== null && (typeof check.conclusion !== 'string' || check.conclusion.length > 256 || check.conclusion.trim() !== check.conclusion || /[\p{Cc}]/u.test(check.conclusion)))) fail()
    ids.add(check.id as number)
    return { id: check.id as number, name: text(check.name), appId: app.id as number, headOid: check.head_sha as string, status: text(check.status), conclusion: check.conclusion as string | null }
  }).sort((a, b) => a.id - b.id)
  const heads = new Set(checks.map(check => check.headOid)); if (heads.size > 1) fail()
  return { headOid: checks[0]?.headOid ?? null, checks }
}
interface Review { id: number; userId: number; commitOid: string; state: string; currentHead: boolean }
function reviews(value: unknown, headOid: string): readonly Review[] {
  const ids = new Set<number>()
  return list(value).map(item => {
    const review = record(item), user = record(review.user)
    if (!positive(review.id) || ids.has(review.id as number) || !positive(user.id) || !oid(review.commit_id) || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(String(review.state))) fail()
    ids.add(review.id as number)
    return { id: review.id as number, userId: user.id as number, commitOid: review.commit_id as string, state: review.state as string, currentHead: review.commit_id === headOid }
  })
}

/** Reads only fixed, untrusted GitHub state for a repository-change nudge. */
export async function readGitHubRepositoryObservation(input: { repository: string; branch: string; baseBranch: string; deliveryMode?: 'commit' | 'pull-request'; token: string; maxBodyBytes: number; timeoutMs: number; signal: AbortSignal; lookup?: Lookup; fetcher?: Fetcher; allowIpv6?: boolean; trackOperation?: OperationTracker; beforeRequest?: () => void | Promise<void> }): Promise<SensorObservation> {
  const commitMode = input.deliveryMode === 'commit'
  if (!repositoryPattern.test(input.repository) || !text(input.branch) || !text(input.baseBranch) || input.branch === input.baseBranch || typeof input.token !== 'string' || input.token.length === 0 || input.token.length > 8192 || !Number.isSafeInteger(input.maxBodyBytes) || input.maxBodyBytes < 1 || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) fail()
  const owner = input.repository.split('/')[0]!, controller = new AbortController(), abort = () => controller.abort(input.signal.reason ?? new Error('event-triggers: GitHub sensor was aborted'))
  if (input.signal.aborted) abort(); else input.signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('event-triggers: GitHub sensor timeout')), input.timeoutMs); timer.unref?.()
  const options = { ...(input.lookup === undefined ? {} : { lookup: input.lookup }), ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }), ...(input.allowIpv6 === undefined ? {} : { allowIpv6: input.allowIpv6 }), ...(input.trackOperation === undefined ? {} : { trackOperation: input.trackOperation }) }
  const read = async (path: string): Promise<unknown> => { await input.beforeRequest?.(); const value = await readHttpJsonValue({ url: `${API}/repos/${input.repository.split('/').map(encodeURIComponent).join('/')}${path}`, maxBodyBytes: input.maxBodyBytes, timeoutMs: input.timeoutMs,
    allowedOrigins: new Set([API]), signal: controller.signal, rejectPagination: true, ...options, headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-enhanced-event-triggers', authorization: `Bearer ${input.token}` } }); await input.beforeRequest?.(); return value }
  try {
    if (commitMode) {
      const headOid = branchHead(await read(`/branches/${encodeURIComponent(input.branch)}`), input.branch)
      const checks = checkRuns(await read(`/commits/${encodeURIComponent(headOid)}/check-runs?per_page=100`))
      if (checks.headOid !== null && checks.headOid !== headOid) fail()
      return Object.freeze({ fingerprint: fingerprint({ repository: input.repository, branch: input.branch, deliveryMode: 'commit', headOid, checks: checks.checks }), truthy: true })
    }
    const checks = checkRuns(await read(`/commits/${encodeURIComponent(input.branch)}/check-runs?per_page=100`))
    const query = new URLSearchParams({ state: 'open', head: `${owner}:${input.branch}`, base: input.baseBranch, per_page: '100' })
    const candidates = list(await read(`/pulls?${query.toString()}`)).map(item => pullRequest(item, input.repository, input.branch, input.baseBranch))
    if (candidates.length > 1) fail()
    const pull = candidates[0], review = pull === undefined ? [] : reviews(await read(`/pulls/${pull.number}/reviews?per_page=100`), pull.headOid)
    if (pull !== undefined && checks.headOid !== null && checks.headOid !== pull.headOid) fail()
    return Object.freeze({ fingerprint: fingerprint({ repository: input.repository, branch: input.branch, baseBranch: input.baseBranch, checks, pullRequest: pull ?? null, reviews: review }), truthy: true })
  } catch { throw new Error('event-triggers: GitHub repository observation is unavailable')
  } finally { clearTimeout(timer); input.signal.removeEventListener('abort', abort) }
}
