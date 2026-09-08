import { request as httpsRequest } from 'node:https'
import type { ActionGrant, ActionResult, CommitRequest } from './types.js'

const GITHUB_GRAPHQL_URL = new URL('https://api.github.com/graphql')
const RESPONSE_LIMIT = 16_384
const REQUEST_TIMEOUT_MS = 30_000
const UNKNOWN_REASON = 'github-commit-unknown'
const API = 'https://api.github.com/repos/'

export interface GitHubCommitInput {
  actionId: string
  grant: ActionGrant
  request: CommitRequest
  token: string
  signal: AbortSignal
}

type GitHubTransport = typeof httpsRequest

interface GitHubResponse {
  data?: {
    createCommitOnBranch?: {
      clientMutationId?: unknown
      commit?: {
        oid?: unknown
        parents?: { nodes?: Array<{ oid?: unknown }> }
        repository?: { nameWithOwner?: unknown }
      }
      ref?: { name?: unknown; target?: { oid?: unknown } }
    }
  }
  errors?: unknown
}

function unknown(actionId: string): ActionResult {
  return { actionId, status: 'unknown', reason: UNKNOWN_REASON }
}

function validHeaderToken(token: string): boolean {
  return token.length > 0 && token.length <= 8192 && /^[\x21-\x7e]+$/.test(token)
}

function validInput(input: GitHubCommitInput): boolean {
  const { actionId, grant, request } = input
  return actionId.length > 0
    && actionId.length <= 256
    && !/\p{Cc}/u.test(actionId)
    && /^[\w.-]+\/[\w.-]+$/.test(grant.repository)
    && grant.branch.length > 0
    && grant.branch.length <= 255
    && !grant.branch.startsWith('refs/')
    && !/\p{Cc}/u.test(grant.branch)
    && /^[0-9a-f]{40,128}$/i.test(request.expectedHeadOid)
    && request.files.length > 0
    && request.files.every((file) => file.path.length > 0 && !/\p{Cc}/u.test(file.path))
}

function makePayload(input: GitHubCommitInput): string {
  const clientMutationId = `dsh-action:${input.actionId}`
  return JSON.stringify({
    query: `mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    clientMutationId
    commit { oid parents(first: 2) { nodes { oid } } repository { nameWithOwner } }
    ref { name target { oid } }
  }
}`,
    variables: {
      input: {
        branch: {
          repositoryNameWithOwner: input.grant.repository,
          branchName: input.grant.branch,
        },
        expectedHeadOid: input.request.expectedHeadOid,
        message: { headline: input.request.headline, body: `dsh-action:${input.actionId}` },
        fileChanges: {
          additions: input.request.files.map((file) => ({
            path: file.path,
            contents: Buffer.from(file.content, 'utf8').toString('base64'),
          })),
        },
        clientMutationId,
      },
    },
  })
}

function responseMatches(response: GitHubResponse, input: GitHubCommitInput): string | undefined {
  if (response.errors !== undefined || response.data === undefined) return undefined
  const result = response.data.createCommitOnBranch
  const commit = result?.commit
  const parents = commit?.parents?.nodes
  const oid = commit?.oid
  const refOid = result?.ref?.target?.oid
  if (result?.clientMutationId !== `dsh-action:${input.actionId}`
    || commit?.repository?.nameWithOwner !== input.grant.repository
    || result?.ref?.name !== input.grant.branch
    || !Array.isArray(parents)
    || parents.length !== 1
    || parents[0]?.oid !== input.request.expectedHeadOid
    || typeof oid !== 'string'
    || !/^[0-9a-f]{40,128}$/i.test(oid)
    || refOid !== oid) return undefined
  return oid
}

/** Commit exactly the approved files through GitHub's atomic expected-head mutation. */
export async function commitOnGitHub(
  input: GitHubCommitInput,
  transport: GitHubTransport = httpsRequest,
): Promise<ActionResult> {
  if (input.signal.aborted) return { actionId: input.actionId, status: 'failed', reason: 'dispatch-aborted' }
  if (!validHeaderToken(input.token) || !validInput(input)) return unknown(input.actionId)

  const payload = makePayload(input)
  return new Promise<ActionResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: ReturnType<GitHubTransport> | undefined
    const finish = (result: ActionResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      input.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => {
      request?.destroy()
      finish(unknown(input.actionId))
    }
    try {
      request = transport(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        agent: false,
        signal: input.signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${input.token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'user-agent': 'dsh-enhanced-assistant-actions',
        },
      }, (response) => {
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += buffer.length
          if (size > RESPONSE_LIMIT) {
            response.destroy()
            finish(unknown(input.actionId))
            return
          }
          chunks.push(buffer)
        })
        response.once('error', () => finish(unknown(input.actionId)))
        response.once('aborted', () => finish(unknown(input.actionId)))
        response.once('end', () => {
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
            finish(unknown(input.actionId))
            return
          }
          try {
            const oid = responseMatches(JSON.parse(Buffer.concat(chunks).toString('utf8')) as GitHubResponse, input)
            finish(oid === undefined || oid.includes(input.token) ? unknown(input.actionId) : { actionId: input.actionId, status: 'succeeded', commitOid: oid })
          } catch {
            finish(unknown(input.actionId))
          }
        })
      })
      request.once('error', () => finish(unknown(input.actionId)))
      input.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        request?.destroy()
        finish(unknown(input.actionId))
      }, REQUEST_TIMEOUT_MS)
      request.end(payload)
    } catch {
      request?.destroy()
      finish(unknown(input.actionId))
    }
  })
}

type RestTransport = typeof httpsRequest
type RestReply = { status: number; body: unknown; hasNextPage: boolean }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const oid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

async function rest(path: string, method: 'GET' | 'POST', token: string, body: object | undefined, signal: AbortSignal, transport: RestTransport = httpsRequest): Promise<RestReply | undefined> {
  if (!validHeaderToken(token) || signal.aborted || !path.startsWith('/')) return undefined
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return await new Promise(resolve => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: ReturnType<RestTransport> | undefined
    const finish = (value: RestReply | undefined): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => { request?.destroy(); finish(undefined) }
    try {
      request = transport(new URL(`${API}${path.slice(1)}`), { method, agent: false, headers: {
        accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json',
        ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
        'user-agent': 'dsh-enhanced-assistant-actions', 'x-github-api-version': '2022-11-28',
      } }, response => {
        let bytes = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += value.length
          if (bytes > 262_144) { response.destroy(); request?.destroy(); finish(undefined) } else chunks.push(value)
        })
        response.once('error', () => finish(undefined))
        response.once('aborted', () => finish(undefined))
        response.once('end', () => {
          if (done || signal.aborted || !response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { finish(undefined); return }
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const parsed: unknown = JSON.parse(raw)
            // Never release a credential echoed anywhere in a remote response.
            if (raw.includes(token) || JSON.stringify(parsed).includes(token)) { finish(undefined); return }
            finish({ status: response.statusCode, body: parsed, hasNextPage: /\brel="?next\b/i.test(String(response.headers.link ?? '')) })
          } catch { finish(undefined) }
        })
      })
      request.once('error', () => finish(undefined))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      timer = setTimeout(onAbort, REQUEST_TIMEOUT_MS); timer.unref()
      request.end(payload)
    } catch { request?.destroy(); finish(undefined) }
  })
}

const repoPath = (grant: ActionGrant): string => `${encodeURIComponent(grant.repository.split('/')[0]!)}/${encodeURIComponent(grant.repository.split('/')[1]!)}`
function scopedPr(value: unknown, grant: ActionGrant, number?: number, headOid?: string): Record<string, unknown> | undefined {
  const body = record(value), head = record(body?.head), base = record(body?.base)
  if (!body || !grant.repoWorkflow || !positiveInteger(body.number) || (number !== undefined && body.number !== number)
    || head?.ref !== grant.branch || !oid(head.sha) || (headOid !== undefined && head.sha !== headOid)
    || base?.ref !== grant.repoWorkflow.baseBranch || record(head.repo)?.full_name !== grant.repository || record(base.repo)?.full_name !== grant.repository) return undefined
  return body
}

export async function createBranchOnGitHub(input: { actionId: string; grant: ActionGrant; baseHeadOid: string; token: string; signal: AbortSignal }, transport?: RestTransport): Promise<ActionResult> {
  const workflow = input.grant.repoWorkflow
  if (!workflow?.allowBranchCreate || !oid(input.baseHeadOid)) return unknown(input.actionId)
  const base = await rest(`/${repoPath(input.grant)}/branches/${encodeURIComponent(workflow.baseBranch)}`, 'GET', input.token, undefined, input.signal, transport)
  const baseBody = record(base?.body)
  if (base?.status !== 200 || baseBody?.name !== workflow.baseBranch || record(baseBody.commit)?.sha !== input.baseHeadOid) return { actionId: input.actionId, status: 'failed', reason: 'github-base-head-unconfirmed' }
  const reply = await rest(`/${repoPath(input.grant)}/git/refs`, 'POST', input.token, { ref: `refs/heads/${input.grant.branch}`, sha: input.baseHeadOid }, input.signal, transport)
  const body = record(reply?.body)
  return reply?.status === 201 && body?.ref === `refs/heads/${input.grant.branch}` && record(body.object)?.sha === input.baseHeadOid
    ? { actionId: input.actionId, status: 'succeeded', branch: input.grant.branch } : unknown(input.actionId)
}

export async function createPullRequestOnGitHub(input: { actionId: string; grant: ActionGrant; expectedHeadOid: string; title: string; body: string; token: string; signal: AbortSignal }, transport?: RestTransport): Promise<ActionResult> {
  const workflow = input.grant.repoWorkflow
  if (!workflow?.allowPullRequest || !oid(input.expectedHeadOid)) return unknown(input.actionId)
  // GitHub's PR API offers no atomic expected-head CAS. A mismatched receipt
  // stays unknown; it must not be retried as if no PR had been created.
  const reply = await rest(`/${repoPath(input.grant)}/pulls`, 'POST', input.token, { title: input.title, body: input.body, head: input.grant.branch, base: workflow.baseBranch }, input.signal, transport)
  const body = scopedPr(reply?.body, input.grant, undefined, input.expectedHeadOid)
  return reply?.status === 201 && body ? { actionId: input.actionId, status: 'succeeded', pullRequestNumber: body.number as number } : unknown(input.actionId)
}

export async function inspectGitHub(input: { grant: ActionGrant; kind: 'repository' | 'branch' | 'file' | 'pull-request' | 'checks' | 'reviews'; path?: string; pullRequestNumber?: number; token: string; signal: AbortSignal }, transport?: RestTransport): Promise<{ observed: Record<string, unknown> } | undefined> {
  const isPr = ['pull-request', 'checks', 'reviews'].includes(input.kind)
  const suffix = input.kind === 'repository' ? '' : input.kind === 'branch' ? `/branches/${encodeURIComponent(input.grant.branch)}`
    : input.kind === 'file' && input.path && input.grant.paths.includes(input.path) ? `/contents/${input.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(input.grant.branch)}`
      : isPr && input.grant.repoWorkflow && positiveInteger(input.pullRequestNumber) ? `/pulls/${input.pullRequestNumber}` : undefined
  if (suffix === undefined) return undefined
  const reply = await rest(`/${repoPath(input.grant)}${suffix}`, 'GET', input.token, undefined, input.signal, transport)
  const body = record(reply?.body)
  if (reply?.status !== 200 || !body) return undefined
  if (input.kind === 'repository' && body.full_name !== input.grant.repository) return undefined
  if (input.kind === 'branch' && (body.name !== input.grant.branch || !oid(record(body.commit)?.sha))) return undefined
  if (isPr && !scopedPr(body, input.grant, input.pullRequestNumber)) return undefined
  if (input.kind === 'file') {
    if (body.path !== input.path || body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string' || !oid(body.sha) || typeof body.size !== 'number' || body.size < 0 || body.size > 65_536) return undefined
    const encoded = body.content.replace(/\n/g, '')
    const content = Buffer.from(encoded, 'base64')
    if (content.length !== body.size || content.toString('base64') !== encoded || Buffer.from(content.toString('utf8')).compare(content) !== 0 || content.toString('utf8').includes(input.token)) return undefined
    return { observed: { path: body.path, sha: body.sha, content: content.toString('utf8'), untrusted: true } }
  }
  if (input.kind === 'checks' || input.kind === 'reviews') {
    const sha = record(body.head)!.sha as string
    const maximum = input.kind === 'checks' ? 20 : 30
    const tail = input.kind === 'checks' ? `/commits/${sha}/check-runs?per_page=${maximum}` : `/pulls/${input.pullRequestNumber}/reviews?per_page=${maximum}`
    const list = await rest(`/${repoPath(input.grant)}${tail}`, 'GET', input.token, undefined, input.signal, transport)
    if (list?.status !== 200) return undefined
    const items = input.kind === 'checks' ? record(list.body)?.check_runs : list.body
    if (!Array.isArray(items) || items.length > maximum) return undefined
    const total = input.kind === 'checks' ? record(list.body)?.total_count : undefined
    if (input.kind === 'checks' && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < items.length)) return undefined
    for (const item of items) {
      const value = record(item)
      if (!value || !positiveInteger(value.id)) return undefined
      if (input.kind === 'checks' && (value.head_sha !== sha || !['queued', 'in_progress', 'completed', 'waiting', 'requested', 'pending'].includes(String(value.status)) || typeof value.name !== 'string' || (value.conclusion !== null && typeof value.conclusion !== 'string'))) return undefined
      if (input.kind === 'reviews' && (!oid(value.commit_id) || !['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'].includes(String(value.state)))) return undefined
    }
    return { observed: { pullRequest: body, headOid: sha, items, truncated: list.hasNextPage || (typeof total === 'number' && total > items.length) || items.length === maximum, untrusted: true } }
  }
  return { observed: { ...body, untrusted: true } }
}
