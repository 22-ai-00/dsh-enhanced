import { request as httpsRequest } from 'node:https'
import type { ActionGrant, ActionResult, CommitRequest, CompensationPreimage, CompensationPreimageFile, CompensationResult } from './types.js'

const GITHUB_GRAPHQL_URL = new URL('https://api.github.com/graphql')
const RESPONSE_LIMIT = 16_384
const REQUEST_TIMEOUT_MS = 30_000
const UNKNOWN_REASON = 'github-commit-unknown'
const COMPENSATION_UNKNOWN_REASON = 'github-compensation-unknown'
const PREIMAGE_FILE_LIMIT = 1_048_576
const PREIMAGE_FILE_COUNT_LIMIT = 32
const PREIMAGE_TOTAL_LIMIT = 1_048_576
const REST_RESPONSE_LIMIT = 262_144
const CONTENT_RESPONSE_LIMIT = 1_500_000
const TREE_RESPONSE_LIMIT = 1_500_000
const API = 'https://api.github.com/repos/'

export interface GitHubCommitInput {
  actionId: string
  grant: ActionGrant
  request: CommitRequest
  token: string
  signal: AbortSignal
}

export type GitHubFilePreimage = CompensationPreimageFile
export type GitHubPreimageSnapshot = CompensationPreimage

export interface GitHubPreimageInput {
  grant: ActionGrant
  commitOid: string
  paths: readonly string[]
  token: string
  signal: AbortSignal
}

export interface GitHubBranchHead {
  repository: string
  branch: string
  headOid: string
}

export interface GitHubCompensationInput {
  actionId: string
  grant: ActionGrant
  forwardCommitOid: string
  preimage: GitHubPreimageSnapshot
  token: string
  signal: AbortSignal
}

export type GitHubCompensationResult = CompensationResult

export interface GitHubCompensationTransports {
  graphql?: typeof httpsRequest
  rest?: typeof httpsRequest
}

export type { CompensationPreimage, CompensationPreimageFile, CompensationResult } from './types.js'

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

function validActionId(actionId: string): boolean {
  return actionId.length > 0 && actionId.length <= 256 && !/\p{Cc}/u.test(actionId)
}

function validRepository(repository: string): boolean {
  return repository.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)
}

function validBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 255 && !branch.startsWith('refs/') && !/\p{Cc}/u.test(branch)
}

function validScopedPath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\\p{Cc}]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

function validInput(input: GitHubCommitInput): boolean {
  const { actionId, grant, request } = input
  return validActionId(actionId)
    && validRepository(grant.repository)
    && validBranch(grant.branch)
    && /^[0-9a-f]{40,128}$/i.test(request.expectedHeadOid)
    && request.files.length > 0
    && request.files.every((file) => validScopedPath(file.path))
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

function matchingCommitOid(response: GitHubResponse, expected: { clientMutationId: string; repository: string; branch: string; parentOid: string }): string | undefined {
  if (response.errors !== undefined || response.data === undefined) return undefined
  const result = response.data.createCommitOnBranch
  const commit = result?.commit
  const parents = commit?.parents?.nodes
  const oid = commit?.oid
  const refOid = result?.ref?.target?.oid
  if (result?.clientMutationId !== expected.clientMutationId
    || commit?.repository?.nameWithOwner !== expected.repository
    || result?.ref?.name !== expected.branch
    || !Array.isArray(parents)
    || parents.length !== 1
    || parents[0]?.oid !== expected.parentOid
    || typeof oid !== 'string'
    || !/^[0-9a-f]{40,128}$/i.test(oid)
    || refOid !== oid) return undefined
  return oid
}

function responseMatches(response: GitHubResponse, input: GitHubCommitInput): string | undefined {
  return matchingCommitOid(response, {
    clientMutationId: `dsh-action:${input.actionId}`,
    repository: input.grant.repository,
    branch: input.grant.branch,
    parentOid: input.request.expectedHeadOid,
  })
}

async function graphql(payload: string, token: string, signal: AbortSignal, transport: GitHubTransport): Promise<GitHubResponse | undefined> {
  if (!validHeaderToken(token) || signal.aborted) return undefined
  return await new Promise<GitHubResponse | undefined>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: ReturnType<GitHubTransport> | undefined
    const finish = (result: GitHubResponse | undefined): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => { request?.destroy(); finish(undefined) }
    try {
      request = transport(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        agent: false,
        signal,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
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
          if (size > RESPONSE_LIMIT) { response.destroy(); request?.destroy(); finish(undefined) } else chunks.push(buffer)
        })
        response.once('error', () => finish(undefined))
        response.once('aborted', () => finish(undefined))
        response.once('end', () => {
          if (settled || signal.aborted || response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) { finish(undefined); return }
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            const parsed = JSON.parse(raw) as GitHubResponse
            finish(raw.includes(token) || JSON.stringify(parsed).includes(token) ? undefined : parsed)
          } catch { finish(undefined) }
        })
      })
      request.once('error', () => finish(undefined))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      timer = setTimeout(onAbort, REQUEST_TIMEOUT_MS)
      timer.unref()
      request.end(payload)
    } catch { request?.destroy(); finish(undefined) }
  })
}

/** Commit exactly the approved files through GitHub's atomic expected-head mutation. */
export async function commitOnGitHub(
  input: GitHubCommitInput,
  transport: GitHubTransport = httpsRequest,
): Promise<ActionResult> {
  if (input.signal.aborted) return { actionId: input.actionId, status: 'failed', reason: 'dispatch-aborted' }
  if (!validHeaderToken(input.token) || !validInput(input)) return unknown(input.actionId)
  const payload = makePayload(input)
  const response = await graphql(payload, input.token, input.signal, transport)
  const resultOid = response === undefined ? undefined : responseMatches(response, input)
  return resultOid === undefined ? unknown(input.actionId) : { actionId: input.actionId, status: 'succeeded', commitOid: resultOid }
}

type RestTransport = typeof httpsRequest
type RestReply = { status: number; body: unknown; hasNextPage: boolean }
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const oid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

async function rest(path: string, method: 'GET' | 'POST', token: string, body: object | undefined, signal: AbortSignal, transport: RestTransport = httpsRequest, acceptedStatuses?: readonly number[], responseLimit = REST_RESPONSE_LIMIT): Promise<RestReply | undefined> {
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
          if (bytes > responseLimit) { response.destroy(); request?.destroy(); finish(undefined) } else chunks.push(value)
        })
        response.once('error', () => finish(undefined))
        response.once('aborted', () => finish(undefined))
        response.once('end', () => {
          if (done || signal.aborted || !response.statusCode
            || (response.statusCode < 200 || response.statusCode >= 300) && !acceptedStatuses?.includes(response.statusCode)) { finish(undefined); return }
          try {
            const raw = Buffer.concat(chunks).toString('utf8')
            if (raw.includes(token)) { finish(undefined); return }
            if (acceptedStatuses?.includes(response.statusCode) && (response.statusCode < 200 || response.statusCode >= 300)) {
              finish({ status: response.statusCode, body: undefined, hasNextPage: false })
              return
            }
            const parsed: unknown = JSON.parse(raw)
            // Never release a credential echoed anywhere in a remote response.
            if (JSON.stringify(parsed).includes(token)) { finish(undefined); return }
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
const contentPath = (grant: ActionGrant, path: string, ref: string): string => `/${repoPath(grant)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`

function decodedFile(value: unknown, expectedPath: string, token: string): Extract<GitHubFilePreimage, { state: 'present' }> | undefined {
  const body = record(value)
  if (!body || body.path !== expectedPath || body.type !== 'file' || body.encoding !== 'base64'
    || typeof body.content !== 'string' || !oid(body.sha) || !Number.isSafeInteger(body.size)
    || (body.size as number) < 0 || (body.size as number) > PREIMAGE_FILE_LIMIT || body.truncated === true) return undefined
  const encoded = body.content.replace(/\n/g, '')
  const content = Buffer.from(encoded, 'base64')
  const text = content.toString('utf8')
  if (content.length !== body.size || content.toString('base64') !== encoded
    || Buffer.from(text, 'utf8').compare(content) !== 0 || text.includes(token)) return undefined
  return Object.freeze({ path: expectedPath, state: 'present', blobOid: body.sha, content: text, size: content.length })
}

/**
 * Immutable parent-commit tree entry. Every entry type is indexed, not only
 * blobs: a contents 404 at a path the tree lists as a directory (040000) or
 * submodule (160000) is equally a contradiction that must abort the capture,
 * never be misread as an absent file and turned into a deletion.
 */
interface GitHubTreeEntry { readonly type: 'blob' | 'tree' | 'commit'; readonly mode: string; readonly oid: string | undefined }
const BLOB_MODES = new Set(['100644', '100755', '120000'])
const TREE_MODE = '040000'
const COMMIT_MODE = '160000'

/**
 * Index every entry in the immutable parent commit's (possibly recursive) tree
 * via the Git Data API. Contents 404s are cross-checked against this index so
 * that an existing-but-unreadable path (an oversized blob, a directory or
 * submodule, or an endpoint that hides the path from this credential) can never
 * be misread as "absent" and turned into a destructive deletion. Returns
 * undefined whenever the index cannot be established completely; callers must
 * then abort the compensation.
 */
async function readGitHubTreeIndex(grant: ActionGrant, commitOid: string, token: string, signal: AbortSignal, transport: RestTransport): Promise<ReadonlyMap<string, GitHubTreeEntry> | undefined> {
  const commitReply = await rest(`/${repoPath(grant)}/git/commits/${encodeURIComponent(commitOid)}`, 'GET', token, undefined, signal, transport)
  if (commitReply?.status !== 200) return undefined
  const commitBody = record(commitReply.body)
  const tree = record(commitBody?.tree)
  const treeSha = typeof tree?.sha === 'string' ? tree.sha : undefined
  if (commitBody?.sha !== commitOid || !oid(treeSha)) return undefined
  const treeReply = await rest(`/${repoPath(grant)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, 'GET', token, undefined, signal, transport, undefined, TREE_RESPONSE_LIMIT)
  if (treeReply?.status !== 200) return undefined
  const treeBody = record(treeReply.body)
  const entries = treeBody?.tree
  if (treeBody?.sha !== treeSha || !Array.isArray(entries) || treeBody.truncated === true) return undefined
  const index = new Map<string, GitHubTreeEntry>()
  for (const value of entries) {
    const entry = record(value)
    if (entry === undefined || typeof entry.path !== 'string' || typeof entry.type !== 'string' || typeof entry.mode !== 'string') return undefined
    // GitHub tree type/mode pairs are fixed. A mismatch (or a type/mode we do
    // not recognize) means the response is not the tree shape compensations are
    // proven against: fail closed rather than silently ignoring the entry.
    let parsed: GitHubTreeEntry
    if (entry.type === 'blob') {
      if (!BLOB_MODES.has(entry.mode) || !oid(entry.sha)) return undefined
      parsed = Object.freeze({ type: 'blob', mode: entry.mode, oid: entry.sha })
    } else if (entry.type === 'tree') {
      if (entry.mode !== TREE_MODE) return undefined
      parsed = Object.freeze({ type: 'tree', mode: entry.mode, oid: oid(entry.sha) ? entry.sha : undefined })
    } else if (entry.type === 'commit') {
      if (entry.mode !== COMMIT_MODE) return undefined
      parsed = Object.freeze({ type: 'commit', mode: entry.mode, oid: oid(entry.sha) ? entry.sha : undefined })
    } else return undefined
    const prior = index.get(entry.path)
    if (prior !== undefined && (prior.type !== parsed.type || prior.mode !== parsed.mode || prior.oid !== parsed.oid)) return undefined
    index.set(entry.path, parsed)
  }
  return index
}

/** Read exact allowed file states at one immutable Git commit without following redirects. */
export async function readGitHubPreimage(input: GitHubPreimageInput, transport?: RestTransport): Promise<GitHubPreimageSnapshot | undefined> {
  if (!validRepository(input.grant.repository) || !validBranch(input.grant.branch) || !oid(input.commitOid)
    || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > PREIMAGE_FILE_COUNT_LIMIT
    || new Set(input.paths).size !== input.paths.length
    || input.paths.some(path => !validScopedPath(path) || !input.grant.paths.includes(path))) return undefined
  const resolvedTransport = transport ?? httpsRequest
  // Bind the capture to the immutable parent commit: its tree is the authority
  // on which grant paths exist. A contents 404 contradicted by this tree, or a
  // contents blob whose OID differs from the tree entry, aborts the capture.
  const index = await readGitHubTreeIndex(input.grant, input.commitOid, input.token, input.signal, resolvedTransport)
  if (!index) return undefined
  const files: GitHubFilePreimage[] = []
  let total = 0
  for (const path of input.paths) {
    total += Buffer.byteLength(path)
    if (total > PREIMAGE_TOTAL_LIMIT) return undefined
    const reply = await rest(contentPath(input.grant, path, input.commitOid), 'GET', input.token, undefined, input.signal, resolvedTransport, [404], CONTENT_RESPONSE_LIMIT)
    const indexed = index.get(path)
    if (reply?.status === 404) {
      // The parent tree lists any entry (blob, directory tree, or submodule)
      // at this path; a 404 then means an unreadable/hidden path, not absence.
      if (indexed !== undefined) return undefined
      files.push(Object.freeze({ path, state: 'absent' })); continue
    }
    if (reply?.status !== 200) return undefined
    const file = decodedFile(reply.body, path, input.token)
    // A 200 is a file only when the tree agrees it is a blob with the same OID;
    // a directory/submodule entry masquerading as contents must abort the capture.
    if (!file || indexed?.type !== 'blob' || indexed.oid !== file.blobOid) return undefined
    total += file.size
    if (total > PREIMAGE_TOTAL_LIMIT) return undefined
    files.push(file)
  }
  return Object.freeze({ repository: input.grant.repository, branch: input.grant.branch, commitOid: input.commitOid, files: Object.freeze(files) })
}

/** Inspect only the grant-fixed branch head and bind the observation to its scope. */
export async function inspectGitHubBranchHead(input: { grant: ActionGrant; token: string; signal: AbortSignal }, transport?: RestTransport): Promise<GitHubBranchHead | undefined> {
  if (!validRepository(input.grant.repository) || !validBranch(input.grant.branch)) return undefined
  const reply = await rest(`/${repoPath(input.grant)}/branches/${encodeURIComponent(input.grant.branch)}`, 'GET', input.token, undefined, input.signal, transport)
  const body = record(reply?.body)
  const headOid = record(body?.commit)?.sha
  return reply?.status === 200 && body?.name === input.grant.branch && oid(headOid)
    ? Object.freeze({ repository: input.grant.repository, branch: input.grant.branch, headOid }) : undefined
}

function validPreimage(input: GitHubCompensationInput): boolean {
  const { preimage, grant } = input
  if (!validActionId(input.actionId) || !validRepository(grant.repository) || !validBranch(grant.branch) || !oid(input.forwardCommitOid)
    || preimage.repository !== grant.repository || preimage.branch !== grant.branch || !oid(preimage.commitOid)
    || !Array.isArray(preimage.files) || preimage.files.length < 1 || preimage.files.length > PREIMAGE_FILE_COUNT_LIMIT
    || new Set(preimage.files.map(file => file.path)).size !== preimage.files.length) return false
  let total = 0
  for (const file of preimage.files) {
    if (!validScopedPath(file.path) || !grant.paths.includes(file.path)) return false
    total += Buffer.byteLength(file.path)
    if (file.state === 'present') {
      const bytes = Buffer.from(file.content, 'utf8')
      if (!oid(file.blobOid) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > PREIMAGE_FILE_LIMIT
        || bytes.length !== file.size || bytes.toString('utf8') !== file.content || file.content.includes(input.token)) return false
      total += bytes.length
    } else if (file.state !== 'absent') return false
  }
  return total <= PREIMAGE_TOTAL_LIMIT
}

function compensationPayload(input: GitHubCompensationInput, actionMarker: string): string {
  const additions = input.preimage.files.filter((file): file is Extract<GitHubFilePreimage, { state: 'present' }> => file.state === 'present')
    .map(file => ({ path: file.path, contents: Buffer.from(file.content, 'utf8').toString('base64') }))
  const deletions = input.preimage.files.filter(file => file.state === 'absent').map(file => ({ path: file.path }))
  return JSON.stringify({
    query: `mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    clientMutationId
    commit { oid parents(first: 2) { nodes { oid } } repository { nameWithOwner } }
    ref { name target { oid } }
  }
}`,
    variables: { input: {
      branch: { repositoryNameWithOwner: input.grant.repository, branchName: input.grant.branch },
      expectedHeadOid: input.forwardCommitOid,
      message: { headline: `Compensate ${input.actionId}`, body: actionMarker },
      fileChanges: { additions, deletions },
      clientMutationId: actionMarker,
    } },
  })
}

/** Restore a captured preimage through an expected-head commit; never force-pushes. */
export async function createCompensatingCommitOnGitHub(input: GitHubCompensationInput, transports: GitHubCompensationTransports = {}): Promise<GitHubCompensationResult> {
  const actionMarker = `dsh-compensation:${input.actionId}`
  const base = { actionId: input.actionId, repository: input.grant.repository, branch: input.grant.branch, parentOid: input.forwardCommitOid, actionMarker }
  if (input.signal.aborted) return { ...base, status: 'failed', reason: 'dispatch-aborted' }
  if (!validHeaderToken(input.token) || !validPreimage(input)) return { ...base, status: 'unknown', reason: COMPENSATION_UNKNOWN_REASON }
  const head = await inspectGitHubBranchHead(input, transports.rest)
  if (!head) return { ...base, status: 'unknown', reason: COMPENSATION_UNKNOWN_REASON }
  if (head.headOid !== input.forwardCommitOid) return { ...base, status: 'failed', reason: 'github-compensation-head-conflict' }
  const response = await graphql(compensationPayload(input, actionMarker), input.token, input.signal, transports.graphql ?? httpsRequest)
  // GraphQL may return both `errors` and a populated `data`. Any error entry is
  // treated as a hard rejection (fail closed) even when a commit OID is also
  // present; the commit is never reported as succeeded from a partial response.
  if (response?.errors !== undefined) return { ...base, status: 'failed', reason: 'github-compensation-rejected' }
  const resultOid = response === undefined ? undefined : matchingCommitOid(response, {
    clientMutationId: actionMarker, repository: input.grant.repository, branch: input.grant.branch, parentOid: input.forwardCommitOid,
  })
  return resultOid === undefined ? { ...base, status: 'unknown', reason: COMPENSATION_UNKNOWN_REASON } : { ...base, status: 'succeeded', resultOid }
}

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
