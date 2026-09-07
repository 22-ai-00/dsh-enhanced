import { request as httpsRequest } from 'node:https'
import type { ActionGrant, ActionResult, CommitRequest } from './types.js'

const GITHUB_GRAPHQL_URL = new URL('https://api.github.com/graphql')
const RESPONSE_LIMIT = 16_384
const REQUEST_TIMEOUT_MS = 30_000
const UNKNOWN_REASON = 'github-commit-unknown'

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
