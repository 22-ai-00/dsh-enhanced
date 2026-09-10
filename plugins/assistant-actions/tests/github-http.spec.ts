import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, RequestOptions, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { commitOnGitHub, createBranchOnGitHub, createCompensatingCommitOnGitHub, createPullRequestOnGitHub, inspectGitHub, inspectGitHubBranchHead, readGitHubPreimage } from '../src/github.ts'
import type { ActionGrant, CommitRequest } from '../src/types.ts'

const actionId = 'action-http-123'
const expectedHeadOid = 'a'.repeat(40)
const commitOid = 'b'.repeat(40)
const grant: ActionGrant = {
  id: 'grant', revision: 1, repository: 'owner/repository', branch: 'main', paths: ['src/'],
  credentialHandle: 'credential', expiresAt: 1, maxActions: 1, maxTotalBytes: 1,
  principalDigest: 'principal', principalRecordId: 'record', principalVersion: 1, workspace: 'workspace', agentPreset: 'preset',
}
const commitRequest: CommitRequest = {
  grantId: grant.id, idempotencyKey: 'idempotency', expectedHeadOid, headline: 'Update file',
  files: [{ path: 'src/file.txt', content: 'hello' }],
}

function responsePayload(): object {
  return { data: { createCommitOnBranch: {
    clientMutationId: `dsh-action:${actionId}`,
    commit: { oid: commitOid, parents: { nodes: [{ oid: expectedHeadOid }] }, repository: { nameWithOwner: grant.repository } },
    ref: { name: grant.branch, target: { oid: commitOid } },
  } } }
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ server: Server; url: URL }> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return { server, url: new URL(`http://127.0.0.1:${address.port}/graphql`) }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)))
}

function localhostTransport(localUrl: URL): typeof import('node:https').request {
  return ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    expect(url.href).toBe('https://api.github.com/graphql')
    return httpRequest(localUrl, options, callback)
  }) as unknown as typeof import('node:https').request
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

describe('commitOnGitHub HTTP transport boundary', () => {
  it('keeps the production URL fixed while a local server receives the credential and exact GraphQL body', async () => {
    let authorization: string | undefined
    let body = ''
    const { server, url } = await listen((request, response) => {
      authorization = request.headers.authorization
      void readBody(request).then((value) => {
        body = value
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(responsePayload()))
      })
    })
    try {
      const result = await commitOnGitHub({ actionId, grant, request: commitRequest, token: 'only-at-server', signal: new AbortController().signal }, localhostTransport(url))
      expect(result).toEqual({ actionId, status: 'succeeded', commitOid })
      expect(authorization).toBe('Bearer only-at-server')
      expect(body).not.toContain('only-at-server')
      expect(JSON.parse(body).variables.input).toMatchObject({
        branch: { repositoryNameWithOwner: grant.repository, branchName: grant.branch },
        expectedHeadOid,
        fileChanges: { additions: [{ path: 'src/file.txt', contents: 'aGVsbG8=' }] },
      })
    } finally {
      await close(server)
    }
  })

  it('does not follow a redirect to a second local server', async () => {
    let redirectedRequests = 0
    const target = await listen((_request, response) => {
      redirectedRequests++
      response.end(JSON.stringify(responsePayload()))
    })
    const redirector = await listen((_request, response) => {
      response.writeHead(302, { location: target.url.href })
      response.end()
    })
    try {
      await expect(commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret', signal: new AbortController().signal }, localhostTransport(redirector.url)))
        .resolves.toEqual({ actionId, status: 'unknown', reason: 'github-commit-unknown' })
      expect(redirectedRequests).toBe(0)
    } finally {
      await close(redirector.server)
      await close(target.server)
    }
  })

  it('returns unknown after a received request loses its acknowledgement and sends only once', async () => {
    let receivedRequests = 0
    const { server, url } = await listen((request) => {
      void readBody(request).then(() => {
        receivedRequests++
        request.socket.destroy()
      })
    })
    try {
      await expect(commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret', signal: new AbortController().signal }, localhostTransport(url)))
        .resolves.toEqual({ actionId, status: 'unknown', reason: 'github-commit-unknown' })
      expect(receivedRequests).toBe(1)
    } finally {
      await close(server)
    }
  })

  it('returns unknown when the caller aborts a hung local response', async () => {
    let receivedRequests = 0
    let received: (() => void) | undefined
    const requestReceived = new Promise<void>((resolve) => { received = resolve })
    const { server, url } = await listen((request) => {
      void readBody(request).then(() => {
        receivedRequests++
        received?.()
      })
    })
    const controller = new AbortController()
    try {
      const result = commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret', signal: controller.signal }, localhostTransport(url))
      await requestReceived
      controller.abort()
      await expect(result).resolves.toEqual({ actionId, status: 'unknown', reason: 'github-commit-unknown' })
      expect(receivedRequests).toBe(1)
    } finally {
      await close(server)
    }
  })
})

describe('workflow REST socket boundary', () => {
  const workflowGrant: ActionGrant = { ...grant, branch: 'automation/fix', repoWorkflow: { baseBranch: 'main', allowBranchCreate: true, allowPullRequest: true } }
  it('uses fixed repository endpoints and rejects mismatched branch, PR and inspected PR scopes', async () => {
    let calls = 0
    const { server, url } = await listen(async (request, response) => {
      calls++; const body = await readBody(request)
      expect(request.headers.authorization).toBe('Bearer token')
      if (request.url === '/repos/owner/repository/branches/main') { response.statusCode = 200; response.end(JSON.stringify({ name: 'main', commit: { sha: expectedHeadOid } })); return }
      if (request.url === '/repos/owner/repository/git/refs') { expect(JSON.parse(body)).toEqual({ ref: 'refs/heads/automation/fix', sha: expectedHeadOid }); response.statusCode = 201; response.end(JSON.stringify({ ref: 'refs/heads/automation/fix', object: { sha: expectedHeadOid } })); return }
      if (request.url === '/repos/owner/repository/pulls') { expect(JSON.parse(body)).toMatchObject({ head: 'automation/fix', base: 'main' }); response.statusCode = 201; response.end(JSON.stringify({ number: 7, head: { ref: 'automation/fix', sha: expectedHeadOid, repo: { full_name: 'owner/repository' } }, base: { ref: 'main', repo: { full_name: 'owner/repository' } } })); return }
      response.statusCode = 200; response.end(JSON.stringify({ number: 7, head: { ref: 'other', sha: expectedHeadOid }, base: { ref: 'main', repo: { full_name: 'owner/repository' } } }))
    })
    const transport = ((target: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => { expect(target.href).toMatch(/^https:\/\/api\.github\.com\/repos\/owner\/repository\//); return httpRequest(new URL(target.pathname + target.search, url), options, callback) }) as unknown as typeof import('node:https').request
    try {
      await expect(createBranchOnGitHub({ actionId, grant: workflowGrant, baseHeadOid: expectedHeadOid, token: 'token', signal: new AbortController().signal }, transport)).resolves.toEqual({ actionId, status: 'succeeded', branch: 'automation/fix' })
      await expect(createPullRequestOnGitHub({ actionId, grant: workflowGrant, expectedHeadOid, title: 'title', body: 'body', token: 'token', signal: new AbortController().signal }, transport)).resolves.toEqual({ actionId, status: 'succeeded', pullRequestNumber: 7 })
      await expect(inspectGitHub({ grant: workflowGrant, kind: 'pull-request', pullRequestNumber: 7, token: 'token', signal: new AbortController().signal }, transport)).resolves.toBeUndefined()
      expect(calls).toBe(4)
    } finally { await close(server) }
  })
})

const scopedGrant: ActionGrant = { ...grant, branch: 'automation/fix', paths: ['a.txt'], repoWorkflow: { baseBranch: 'main', allowBranchCreate: true, allowPullRequest: true } }
const scopedPr = () => ({ number: 7, head: { ref: scopedGrant.branch, sha: expectedHeadOid, repo: { full_name: scopedGrant.repository } }, base: { ref: 'main', repo: { full_name: scopedGrant.repository } } })
function restTransport(url: URL): typeof import('node:https').request {
  return ((target: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    expect(target.origin).toBe('https://api.github.com')
    expect(target.pathname).toMatch(/^\/repos\/owner\/repository(?:\/|$)/)
    return httpRequest(new URL(target.pathname + target.search, url), options, callback)
  }) as unknown as typeof import('node:https').request
}

it('reads real review arrays and validated checks, reporting incomplete pages without following remote links', async () => {
  let paginated = false, malformed = false, calls = 0
  const { server, url } = await listen((request, response) => {
    calls++; response.setHeader('content-type', 'application/json')
    if (request.url?.endsWith('/pulls/7')) { response.end(JSON.stringify(scopedPr())); return }
    if (paginated) response.setHeader('link', '<https://elsewhere.invalid/secret>; rel="next"')
    if (request.url?.endsWith('/reviews?per_page=30')) { response.end(JSON.stringify(malformed ? {} : [{ id: 1, state: 'APPROVED', commit_id: expectedHeadOid }])); return }
    expect(request.url).toBe(`/repos/owner/repository/commits/${expectedHeadOid}/check-runs?per_page=20`)
    response.end(JSON.stringify({ total_count: paginated ? 25 : 1, check_runs: [{ id: 2, name: 'CI', status: 'completed', conclusion: 'success', head_sha: malformed ? commitOid : expectedHeadOid }] }))
  })
  const run = async (kind: 'checks' | 'reviews') => await inspectGitHub({ grant: scopedGrant, kind, pullRequestNumber: 7, token: 'only-at-server', signal: new AbortController().signal }, restTransport(url))
  try {
    expect((await run('reviews'))?.observed).toMatchObject({ truncated: false, untrusted: true, items: [{ state: 'APPROVED' }] })
    expect((await run('checks'))?.observed).toMatchObject({ truncated: false, items: [{ conclusion: 'success' }] })
    paginated = true
    expect((await run('reviews'))?.observed.truncated).toBe(true)
    expect((await run('checks'))?.observed.truncated).toBe(true)
    malformed = true
    expect(await run('reviews')).toBeUndefined(); expect(await run('checks')).toBeUndefined()
    expect(calls).toBe(12)
  } finally { await close(server) }
})

it('rejects forked PRs, untrusted SHA paths, wrong base snapshots and echoed credentials before releasing data', async () => {
  let mode: 'fork' | 'bad-sha' | 'token' | 'base' = 'fork', calls = 0
  const token = 'only-at-server'
  const { server, url } = await listen((request, response) => {
    calls++
    if (request.url?.includes('/branches/')) { response.end(JSON.stringify({ name: 'wrong-base', commit: { sha: expectedHeadOid } })); return }
    const payload = scopedPr()
    if (mode === 'fork') payload.head.repo.full_name = 'attacker/repository'
    if (mode === 'bad-sha') payload.head.sha = '../../private?token=other'
    response.statusCode = request.method === 'POST' ? 201 : 200
    response.end(JSON.stringify(mode === 'token' ? { ...payload, body: token } : payload))
  })
  try {
    const mutation = { actionId, grant: scopedGrant, expectedHeadOid, title: 'title', body: '', token, signal: new AbortController().signal }
    expect((await createPullRequestOnGitHub(mutation, restTransport(url))).status).toBe('unknown')
    expect(await inspectGitHub({ grant: scopedGrant, kind: 'pull-request', pullRequestNumber: 7, token, signal: mutation.signal }, restTransport(url))).toBeUndefined()
    mode = 'bad-sha'
    expect(await inspectGitHub({ grant: scopedGrant, kind: 'checks', pullRequestNumber: 7, token, signal: mutation.signal }, restTransport(url))).toBeUndefined()
    mode = 'token'
    expect((await createPullRequestOnGitHub(mutation, restTransport(url))).status).toBe('unknown')
    mode = 'base'
    expect((await createBranchOnGitHub({ actionId, grant: scopedGrant, baseHeadOid: expectedHeadOid, token, signal: mutation.signal }, restTransport(url))).status).toBe('failed')
    expect(calls).toBe(5)
  } finally { await close(server) }
})

it('only releases a bounded, exact-path UTF-8 file and rejects invalid encoding or a decoded secret', async () => {
  let mode: 'good' | 'path' | 'encoding' | 'token' = 'good'
  const token = 'only-at-server'
  const { server, url } = await listen((_request, response) => {
    const content = mode === 'token' ? token : 'hello\n'
    response.end(JSON.stringify({ path: mode === 'path' ? 'other.txt' : 'a.txt', type: 'file', sha: expectedHeadOid, size: Buffer.byteLength(content), encoding: 'base64', content: mode === 'encoding' ? '%%%invalid%%%' : Buffer.from(content).toString('base64') }))
  })
  try {
    const read = async () => await inspectGitHub({ grant: scopedGrant, kind: 'file', path: 'a.txt', token, signal: new AbortController().signal }, restTransport(url))
    expect((await read())?.observed).toMatchObject({ path: 'a.txt', content: 'hello\n', untrusted: true })
    for (const rejected of ['path', 'encoding', 'token'] as const) { mode = rejected; expect(await read()).toBeUndefined() }
  } finally { await close(server) }
})

it('cancels a hung REST response and removes its abort listener', async () => {
  const received = Promise.withResolvers<void>()
  const { server, url } = await listen(() => received.resolve())
  const signal = new AbortController()
  const add = vi.spyOn(signal.signal, 'addEventListener'), remove = vi.spyOn(signal.signal, 'removeEventListener')
  try {
    const result = inspectGitHub({ grant: scopedGrant, kind: 'repository', token: 'only-at-server', signal: signal.signal }, restTransport(url))
    await received.promise; signal.abort()
    expect(await result).toBeUndefined()
    const installed = add.mock.calls.find(call => call[0] === 'abort')
    expect(installed).toBeDefined()
    expect(remove).toHaveBeenCalledWith('abort', installed![1])
  } finally { await close(server) }
})

describe('compensation HTTP socket boundary', () => {
  const parentOid = 'c'.repeat(40), forwardOid = 'd'.repeat(40), resultOid = 'e'.repeat(40)
  const compensationGrant: ActionGrant = { ...grant, paths: ['src/old.txt', 'src/new.txt'] }

  it('uses fixed hosts, exact encoded path/ref and never follows a preimage redirect', async () => {
    let redirected = 0, seenUrl: string | undefined, authorization: string | undefined
    const target = await listen((_request, response) => { redirected++; response.end('{}') })
    const redirector = await listen((request, response) => {
      seenUrl = request.url; authorization = request.headers.authorization
      response.writeHead(302, { location: target.url.href }); response.end()
    })
    const index = await listen((_request, response) => {
      response.setHeader('content-type', 'application/json')
      if ((_request.url ?? '').includes('/git/commits/')) { response.end(JSON.stringify({ sha: parentOid, tree: { sha: expectedHeadOid } })); return }
      response.end(JSON.stringify({ sha: expectedHeadOid, truncated: false, tree: [] }))
    })
    const transport = ((targetUrl: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      expect(targetUrl.origin).toBe('https://api.github.com')
      if (targetUrl.pathname.includes('/git/commits/') || targetUrl.pathname.includes('/git/trees/')) {
        return httpRequest(new URL(targetUrl.pathname + targetUrl.search, index.url), options, callback)
      }
      expect(targetUrl.pathname).toBe('/repos/owner/repository/contents/src/old.txt')
      expect(targetUrl.searchParams.get('ref')).toBe(parentOid)
      return httpRequest(new URL(targetUrl.pathname + targetUrl.search, redirector.url), options, callback)
    }) as unknown as typeof import('node:https').request
    try {
      await expect(readGitHubPreimage({ grant: compensationGrant, commitOid: parentOid, paths: ['src/old.txt'], token: 'only-at-server', signal: new AbortController().signal }, transport)).resolves.toBeUndefined()
      expect(seenUrl).toBe(`/repos/owner/repository/contents/src/old.txt?ref=${parentOid}`)
      expect(authorization).toBe('Bearer only-at-server')
      expect(redirected).toBe(0)
    } finally { await close(index.server); await close(redirector.server); await close(target.server) }
  })

  it('inspects the exact branch then sends one ordinary expected-head compensation commit', async () => {
    let branchCalls = 0, graphCalls = 0, payload: Record<string, any> | undefined
    const { server, url } = await listen(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/repos/owner/repository/branches/main') {
        branchCalls++; response.end(JSON.stringify({ name: 'main', commit: { sha: forwardOid } })); return
      }
      expect(request.url).toBe('/graphql'); graphCalls++; payload = JSON.parse(await readBody(request))
      response.end(JSON.stringify({ data: { createCommitOnBranch: {
        clientMutationId: `dsh-compensation:${actionId}`,
        commit: { oid: resultOid, parents: { nodes: [{ oid: forwardOid }] }, repository: { nameWithOwner: grant.repository } },
        ref: { name: grant.branch, target: { oid: resultOid } },
      } } }))
    })
    const rest = ((targetUrl: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      expect(targetUrl.href).toBe('https://api.github.com/repos/owner/repository/branches/main')
      expect(options).toMatchObject({ method: 'GET', agent: false })
      return httpRequest(new URL(targetUrl.pathname, url), options, callback)
    }) as unknown as typeof import('node:https').request
    const graph = ((targetUrl: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      expect(targetUrl.href).toBe('https://api.github.com/graphql')
      expect(options).toMatchObject({ method: 'POST', agent: false })
      return httpRequest(url, options, callback)
    }) as unknown as typeof import('node:https').request
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: parentOid, files: [
      { path: 'src/old.txt', state: 'present' as const, blobOid: parentOid, content: 'before', size: 6 },
      { path: 'src/new.txt', state: 'absent' as const },
    ] }
    try {
      expect(await inspectGitHubBranchHead({ grant: compensationGrant, token: 'only-at-server', signal: new AbortController().signal }, rest)).toEqual({ repository: grant.repository, branch: grant.branch, headOid: forwardOid })
      await expect(createCompensatingCommitOnGitHub({ actionId, grant: compensationGrant, forwardCommitOid: forwardOid, preimage, token: 'only-at-server', signal: new AbortController().signal }, { rest, graphql: graph })).resolves.toEqual({
        actionId, status: 'succeeded', repository: grant.repository, branch: grant.branch, parentOid: forwardOid, actionMarker: `dsh-compensation:${actionId}`, resultOid,
      })
      expect(payload?.variables.input).toEqual({
        branch: { repositoryNameWithOwner: grant.repository, branchName: grant.branch }, expectedHeadOid: forwardOid,
        message: { headline: `Compensate ${actionId}`, body: `dsh-compensation:${actionId}` },
        fileChanges: { additions: [{ path: 'src/old.txt', contents: 'YmVmb3Jl' }], deletions: [{ path: 'src/new.txt' }] },
        clientMutationId: `dsh-compensation:${actionId}`,
      })
      expect(payload?.query).not.toMatch(/force|updateRef/i)
      expect(branchCalls).toBe(2); expect(graphCalls).toBe(1)
    } finally { await close(server) }
  })

  it('does not follow a GraphQL redirect and sends the compensation mutation only once', async () => {
    let redirected = 0, dispatched = 0
    const target = await listen((_request, response) => { redirected++; response.end('{}') })
    const redirector = await listen(async (request, response) => { dispatched++; await readBody(request); response.writeHead(302, { location: target.url.href }); response.end() })
    const head = await listen((_request, response) => response.end(JSON.stringify({ name: grant.branch, commit: { sha: forwardOid } })))
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: parentOid, files: [{ path: 'src/old.txt', state: 'present' as const, blobOid: parentOid, content: 'before', size: 6 }] }
    try {
      await expect(createCompensatingCommitOnGitHub({ actionId, grant: compensationGrant, forwardCommitOid: forwardOid, preimage, token: 'only-at-server', signal: new AbortController().signal }, { rest: restTransport(head.url), graphql: localhostTransport(redirector.url) })).resolves.toMatchObject({ status: 'unknown', reason: 'github-compensation-unknown' })
      expect(dispatched).toBe(1); expect(redirected).toBe(0)
    } finally { await close(head.server); await close(redirector.server); await close(target.server) }
  })

  it('returns unknown after a dispatched compensation loses acknowledgement and never replays it', async () => {
    let dispatched = 0
    const mutation = await listen((request) => {
      void readBody(request).then(() => { dispatched++; request.socket.destroy() })
    })
    const head = await listen((_request, response) => response.end(JSON.stringify({ name: grant.branch, commit: { sha: forwardOid } })))
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: parentOid, files: [{ path: 'src/old.txt', state: 'present' as const, blobOid: parentOid, content: 'before', size: 6 }] }
    try {
      await expect(createCompensatingCommitOnGitHub({ actionId, grant: compensationGrant, forwardCommitOid: forwardOid, preimage, token: 'only-at-server', signal: new AbortController().signal }, { rest: restTransport(head.url), graphql: localhostTransport(mutation.url) })).resolves.toMatchObject({
        status: 'unknown', reason: 'github-compensation-unknown', repository: grant.repository, branch: grant.branch, parentOid: forwardOid, actionMarker: `dsh-compensation:${actionId}`,
      })
      expect(dispatched).toBe(1)
    } finally { await close(head.server); await close(mutation.server) }
  })
})
