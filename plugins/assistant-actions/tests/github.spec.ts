import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { commitOnGitHub, createCompensatingCommitOnGitHub, inspectGitHubBranchHead, readGitHubPreimage } from '../src/github.ts'
import type { ActionGrant, CommitRequest } from '../src/types.ts'

const actionId = 'action-123'
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

function successfulResponse(): object {
  return { data: { createCommitOnBranch: {
    clientMutationId: `dsh-action:${actionId}`,
    commit: { oid: commitOid, parents: { nodes: [{ oid: expectedHeadOid }] }, repository: { nameWithOwner: grant.repository } },
    ref: { name: 'main', target: { oid: commitOid } },
  } } }
}

function fakeTransport(reply: object | string, statusCode = 200): { transport: typeof import('node:https').request; captured: { url?: URL; options?: object; body?: string } } {
  const captured: { url?: URL; options?: object; body?: string } = {}
  const transport = ((url: URL, options: object, callback: (response: IncomingMessage) => void) => {
    captured.url = url; captured.options = options
    const request = new EventEmitter() as ClientRequest
    let body = ''
    request.end = ((data?: string) => {
      body += data ?? ''; captured.body = body
      const stream = new PassThrough()
      const response = stream as unknown as IncomingMessage
      response.statusCode = statusCode
      callback(response)
      stream.end(typeof reply === 'string' ? reply : JSON.stringify(reply))
      return request
    }) as ClientRequest['end']
    request.destroy = (() => request) as ClientRequest['destroy']
    return request
  }) as unknown as typeof import('node:https').request
  return { transport, captured }
}

function routedTransport(route: (url: URL, body: string) => { reply: object | string; status?: number }): {
  transport: typeof import('node:https').request
  calls: Array<{ url: URL; body: string }>
} {
  const calls: Array<{ url: URL; body: string }> = []
  const transport = ((url: URL, _options: object, callback: (response: IncomingMessage) => void) => {
    const request = new EventEmitter() as ClientRequest
    request.end = ((data?: string) => {
      const body = data ?? ''; calls.push({ url, body })
      const answer = route(url, body)
      const stream = new PassThrough(); const response = stream as unknown as IncomingMessage
      response.statusCode = answer.status ?? 200; response.headers = {}
      callback(response); stream.end(typeof answer.reply === 'string' ? answer.reply : JSON.stringify(answer.reply))
      return request
    }) as ClientRequest['end']
    request.destroy = (() => request) as ClientRequest['destroy']
    return request
  }) as unknown as typeof import('node:https').request
  return { transport, calls }
}

describe('commitOnGitHub', () => {
  it('posts the fixed GitHub mutation and accepts only the matching atomic commit', async () => {
    const { transport, captured } = fakeTransport(successfulResponse())
    const result = await commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret-token', signal: new AbortController().signal }, transport)

    expect(result).toEqual({ actionId, status: 'succeeded', commitOid })
    expect(captured.url?.href).toBe('https://api.github.com/graphql')
    expect(captured.options).toMatchObject({ agent: false })
    const headers = (captured.options as { headers: Record<string, string> }).headers
    expect(headers.authorization).toBe('Bearer secret-token')
    const payload = JSON.parse(captured.body ?? '')
    expect(payload.variables.input).toMatchObject({
      branch: { repositoryNameWithOwner: grant.repository, branchName: grant.branch }, expectedHeadOid,
      message: { headline: commitRequest.headline, body: `dsh-action:${actionId}` }, clientMutationId: `dsh-action:${actionId}`,
      fileChanges: { additions: [{ path: 'src/file.txt', contents: 'aGVsbG8=' }] },
    })
    expect(payload.query).toContain('createCommitOnBranch')
  })

  it('does not send an aborted or control-character token request', async () => {
    let calls = 0
    const transport = (() => { calls++; throw new Error('must not send') }) as unknown as typeof import('node:https').request
    const aborted = new AbortController(); aborted.abort()
    await expect(commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret', signal: aborted.signal }, transport))
      .resolves.toEqual({ actionId, status: 'failed', reason: 'dispatch-aborted' })
    await expect(commitOnGitHub({ actionId, grant, request: commitRequest, token: 'bad\nsecret', signal: new AbortController().signal }, transport))
      .resolves.toEqual({ actionId, status: 'unknown', reason: 'github-commit-unknown' })
    expect(calls).toBe(0)
  })

  it.each([
    ['redirect', successfulResponse(), 302],
    ['malformed', '{not-json', 200],
    ['oversized', 'x'.repeat(16_385), 200],
    ['wrong parent', { data: { createCommitOnBranch: {
      clientMutationId: `dsh-action:${actionId}`,
      commit: { oid: commitOid, parents: { nodes: [{ oid: 'c'.repeat(40) }] }, repository: { nameWithOwner: grant.repository } },
      ref: { name: 'main', target: { oid: commitOid } },
    } } }, 200],
  ])('returns an opaque unknown result for %s responses', async (_name, response, status) => {
    const { transport } = fakeTransport(response, status)
    await expect(commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret', signal: new AbortController().signal }, transport))
      .resolves.toEqual({ actionId, status: 'unknown', reason: 'github-commit-unknown' })
  })

  it('does not return a hex-shaped token echoed as an otherwise valid commit OID', async () => {
    const { transport } = fakeTransport(successfulResponse())
    const result = await commitOnGitHub({ actionId, grant, request: commitRequest, token: commitOid, signal: new AbortController().signal }, transport)
    expect(result).toEqual({ actionId, status: 'unknown', reason: 'github-commit-unknown' })
    expect(JSON.stringify(result)).not.toContain(commitOid)
  })

  it('does not expose a server response that contains the token', async () => {
    const { transport } = fakeTransport({ errors: [{ message: 'secret-token' }] })
    const result = await commitOnGitHub({ actionId, grant, request: commitRequest, token: 'secret-token', signal: new AbortController().signal }, transport)
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})

describe('GitHub compensation primitives', () => {
  const oldOid = 'c'.repeat(40)
  const forwardOid = 'd'.repeat(40)
  const compensationOid = 'e'.repeat(40)
  const treeSha = '0'.repeat(40)

  // Serve the immutable parent commit and its recursive tree before delegating
  // to the per-path contents route. Only paths listed in blobPaths exist as
  // blobs in the parent tree, which is what justifies a contents 404 -> absent.
  const preimageTransport = (blobPaths: string[], route: (url: URL) => { reply: object | string; status?: number }) =>
    routedTransport(url => {
      if (url.pathname.endsWith(`/git/commits/${expectedHeadOid}`)) return { reply: { sha: expectedHeadOid, tree: { sha: treeSha } } }
      if (url.pathname.includes('/git/trees/')) return { reply: { sha: treeSha, truncated: false, tree: blobPaths.map(path => ({ path, type: 'blob', sha: oldOid, mode: '100644' })) } }
      return route(url)
    })

  it('captures exact-commit UTF-8 preimages, treating only a tree-confirmed exact 404 as absent', async () => {
    const contents = (url: URL) => url.pathname.endsWith('/src/new.txt')
      ? { status: 404, reply: { message: 'Not Found' } }
      : { reply: { path: 'src/file.txt', type: 'file', sha: oldOid, size: 5, encoding: 'base64', content: 'aGVsbG8=' } }
    const scoped = { ...grant, paths: ['src/file.txt', 'src/new.txt'] }
    const { transport, calls } = preimageTransport(['src/file.txt'], contents)
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths: scoped.paths, token: 'secret', signal: new AbortController().signal }, transport))
      .resolves.toEqual({ repository: grant.repository, branch: grant.branch, commitOid: expectedHeadOid, files: [
        { path: 'src/file.txt', state: 'present', blobOid: oldOid, content: 'hello', size: 5 },
        { path: 'src/new.txt', state: 'absent' },
      ] })
    // The tree index is read once at the immutable commit; each contents read is pinned to that OID.
    expect(calls.filter(call => call.url.pathname.includes('/contents/')).map(call => call.url.searchParams.get('ref'))).toEqual([expectedHeadOid, expectedHeadOid])
    const wrongPath = preimageTransport(['src/file.txt'], () => ({ reply: { path: 'src/other.txt', type: 'file', sha: oldOid, size: 5, encoding: 'base64', content: 'aGVsbG8=' } }))
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths: ['src/file.txt'], token: 'secret', signal: new AbortController().signal }, wrongPath.transport)).resolves.toBeUndefined()
  })

  it('refuses to treat a 404 as absent when the immutable parent tree proves a blob exists there', async () => {
    // The blob is in the parent tree (e.g. an oversized file or a path hidden
    // from this credential) but the contents endpoint answers 404: deleting it
    // would be destructive, so the capture must abort.
    const hidden = preimageTransport(['src/file.txt'], () => ({ status: 404, reply: { message: 'Not Found' } }))
    const scoped = { ...grant, paths: ['src/file.txt'] }
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths: scoped.paths, token: 'secret', signal: new AbortController().signal }, hidden.transport)).resolves.toBeUndefined()
  })

  it('rejects a contents blob whose OID disagrees with the immutable parent tree', async () => {
    const mismatched = preimageTransport(['src/file.txt'], () => ({ reply: { path: 'src/file.txt', type: 'file', sha: 'f'.repeat(40), size: 5, encoding: 'base64', content: 'aGVsbG8=' } }))
    const scoped = { ...grant, paths: ['src/file.txt'] }
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths: scoped.paths, token: 'secret', signal: new AbortController().signal }, mismatched.transport)).resolves.toBeUndefined()
  })

  it.each([
    ['commit lookup 404', (url: URL) => url.pathname.includes('/git/commits/') ? { status: 404, reply: { message: 'Not Found' } } : { reply: {} }],
    ['tree lookup 403', (url: URL) => url.pathname.includes('/git/trees/') ? { status: 403, reply: { message: 'Forbidden' } } : { reply: {} }],
    ['truncated tree', (url: URL) => url.pathname.includes('/git/commits/')
      ? { reply: { sha: expectedHeadOid, tree: { sha: treeSha } } }
      : url.pathname.includes('/git/trees/')
        ? { reply: { sha: treeSha, truncated: true, tree: [] } }
        : { reply: {} }],
    ['commit OID mismatch', (url: URL) => url.pathname.includes('/git/commits/') ? { reply: { sha: '9'.repeat(40), tree: { sha: treeSha } } } : { reply: {} }],
  ])('aborts the capture when the tree index cannot be established (%s)', async (_name, route) => {
    const scoped = { ...grant, paths: ['src/file.txt'] }
    const { transport } = routedTransport(route)
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths: scoped.paths, token: 'secret', signal: new AbortController().signal }, transport)).resolves.toBeUndefined()
  })

  it.each([
    ['non-404 absence', { status: 403, reply: { message: 'forbidden' } }],
    ['redirect', { status: 302, reply: { message: 'moved' } }],
    ['non-canonical base64', { reply: { path: 'src/file.txt', type: 'file', sha: oldOid, size: 1, encoding: 'base64', content: 'YQ' } }],
    ['non-UTF-8', { reply: { path: 'src/file.txt', type: 'file', sha: oldOid, size: 1, encoding: 'base64', content: '/w==' } }],
    ['truncated', { reply: { path: 'src/file.txt', type: 'file', sha: oldOid, size: 5, encoding: 'base64', content: 'aGVsbG8=', truncated: true } }],
    ['wrong type', { reply: { path: 'src/file.txt', type: 'dir', sha: oldOid, size: 5, encoding: 'base64', content: 'aGVsbG8=' } }],
    ['wrong size', { reply: { path: 'src/file.txt', type: 'file', sha: oldOid, size: 4, encoding: 'base64', content: 'aGVsbG8=' } }],
    ['wrong blob oid', { reply: { path: 'src/file.txt', type: 'file', sha: 'not-an-oid', size: 5, encoding: 'base64', content: 'aGVsbG8=' } }],
  ])('rejects %s while capturing a preimage', async (_name, answer) => {
    const scoped = { ...grant, paths: ['src/file.txt'] }
    const { transport } = preimageTransport(['src/file.txt'], () => answer)
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths: scoped.paths, token: 'secret', signal: new AbortController().signal }, transport)).resolves.toBeUndefined()
  })

  it('rejects more than 32 paths and an aggregate preimage over 1 MiB before returning partial authority', async () => {
    const paths = Array.from({ length: 33 }, (_, index) => `src/${index}.txt`)
    const scoped = { ...grant, paths }
    const noSend = routedTransport(() => { throw new Error('must not send') })
    await expect(readGitHubPreimage({ grant: scoped, commitOid: expectedHeadOid, paths, token: 'secret', signal: new AbortController().signal }, noSend.transport)).resolves.toBeUndefined()
    expect(noSend.calls).toHaveLength(0)

    const content = 'x'.repeat(524_288)
    const bounded = { ...grant, paths: ['src/a.txt', 'src/b.txt'] }
    const tooLarge = preimageTransport(['src/a.txt', 'src/b.txt'], url => ({ reply: { path: url.pathname.endsWith('/a.txt') ? 'src/a.txt' : 'src/b.txt', type: 'file', sha: oldOid, size: content.length, encoding: 'base64', content: Buffer.from(content).toString('base64') } }))
    await expect(readGitHubPreimage({ grant: bounded, commitOid: expectedHeadOid, paths: bounded.paths, token: 'secret', signal: new AbortController().signal }, tooLarge.transport)).resolves.toBeUndefined()
  })

  it('restores present files and deletes originally absent files with an exact-head GraphQL commit', async () => {
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: expectedHeadOid, files: [
      { path: 'src/file.txt', state: 'present' as const, blobOid: oldOid, content: 'old', size: 3 },
      { path: 'src/new.txt', state: 'absent' as const },
    ] }
    const scoped = { ...grant, paths: ['src/file.txt', 'src/new.txt'] }
    const rest = routedTransport(() => ({ reply: { name: grant.branch, commit: { sha: forwardOid } } }))
    const graphql = routedTransport((_url, body) => {
      const payload = JSON.parse(body)
      expect(payload.variables.input).toEqual({
        branch: { repositoryNameWithOwner: grant.repository, branchName: grant.branch },
        expectedHeadOid: forwardOid, message: { headline: `Compensate ${actionId}`, body: `dsh-compensation:${actionId}` },
        fileChanges: { additions: [{ path: 'src/file.txt', contents: 'b2xk' }], deletions: [{ path: 'src/new.txt' }] },
        clientMutationId: `dsh-compensation:${actionId}`,
      })
      return { reply: { data: { createCommitOnBranch: { clientMutationId: `dsh-compensation:${actionId}`, commit: { oid: compensationOid, parents: { nodes: [{ oid: forwardOid }] }, repository: { nameWithOwner: grant.repository } }, ref: { name: grant.branch, target: { oid: compensationOid } } } } } }
    })
    await expect(createCompensatingCommitOnGitHub({ actionId, grant: scoped, forwardCommitOid: forwardOid, preimage, token: 'secret', signal: new AbortController().signal }, { rest: rest.transport, graphql: graphql.transport })).resolves.toEqual({
      actionId, status: 'succeeded', repository: grant.repository, branch: grant.branch, parentOid: forwardOid, resultOid: compensationOid, actionMarker: `dsh-compensation:${actionId}`,
    })
  })

  it('fails closed on head conflicts and leaves malformed acknowledgements unknown without replaying', async () => {
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: expectedHeadOid, files: [{ path: 'src/file.txt', state: 'present' as const, blobOid: oldOid, content: 'old', size: 3 }] }
    const scoped = { ...grant, paths: ['src/file.txt'] }
    const conflict = routedTransport(() => ({ reply: { name: grant.branch, commit: { sha: oldOid } } }))
    await expect(createCompensatingCommitOnGitHub({ actionId, grant: scoped, forwardCommitOid: forwardOid, preimage, token: 'secret', signal: new AbortController().signal }, { rest: conflict.transport, graphql: conflict.transport })).resolves.toMatchObject({ status: 'failed', reason: 'github-compensation-head-conflict', parentOid: forwardOid })
    expect(conflict.calls).toHaveLength(1)

    let graphqlCalls = 0
    const head = routedTransport(() => ({ reply: { name: grant.branch, commit: { sha: forwardOid } } }))
    const malformed = routedTransport(() => { graphqlCalls++; return { reply: { data: { createCommitOnBranch: { clientMutationId: 'wrong' } } } } })
    const input = { actionId, grant: scoped, forwardCommitOid: forwardOid, preimage, token: 'secret', signal: new AbortController().signal }
    await expect(createCompensatingCommitOnGitHub(input, { rest: head.transport, graphql: malformed.transport })).resolves.toMatchObject({ status: 'unknown', reason: 'github-compensation-unknown' })
    expect(graphqlCalls).toBe(1)
    expect(await inspectGitHubBranchHead({ grant: scoped, token: 'secret', signal: input.signal }, head.transport)).toEqual({ repository: grant.repository, branch: grant.branch, headOid: forwardOid })
  })

  it('settles a GraphQL errors acknowledgement as failed/rejected and never retries', async () => {
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: expectedHeadOid, files: [{ path: 'src/file.txt', state: 'present' as const, blobOid: oldOid, content: 'old', size: 3 }] }
    const scoped = { ...grant, paths: ['src/file.txt'] }
    const head = routedTransport(() => ({ reply: { name: grant.branch, commit: { sha: forwardOid } } }))
    const rejected = routedTransport(() => ({ reply: { errors: [{ type: 'INVALID_ARGUMENT', message: 'expected head OID does not match' }] } }))
    const result = await createCompensatingCommitOnGitHub({ actionId, grant: scoped, forwardCommitOid: forwardOid, preimage, token: 'secret', signal: new AbortController().signal }, { rest: head.transport, graphql: rejected.transport })
    expect(result).toMatchObject({ status: 'failed', reason: 'github-compensation-rejected' })
    // The mutation was sent exactly once; a rejection is terminal, not replayed.
    expect(rejected.calls).toHaveLength(1)
  })

  type ReceiptChange = Partial<{ marker: string; repository: string; branch: string; parent: string; refResult: string; parents: string[] }>
  const receiptChanges: Array<[string, ReceiptChange]> = [
    ['marker', { marker: 'wrong' }],
    ['repository', { repository: 'other/repository' }],
    ['branch', { branch: 'other' }],
    ['parent', { parent: oldOid }],
    ['ref result', { refResult: oldOid }],
    ['multiple parents', { parents: [forwardOid, oldOid] }],
  ]
  it.each(receiptChanges)('rejects a compensation receipt with the wrong %s binding', async (_name, change) => {
    const scoped = { ...grant, paths: ['src/file.txt'] }
    const preimage = { repository: grant.repository, branch: grant.branch, commitOid: expectedHeadOid, files: [{ path: 'src/file.txt', state: 'present' as const, blobOid: oldOid, content: 'old', size: 3 }] }
    const head = routedTransport(() => ({ reply: { name: grant.branch, commit: { sha: forwardOid } } }))
    const graphql = routedTransport(() => ({ reply: { data: { createCommitOnBranch: {
      clientMutationId: change.marker ?? `dsh-compensation:${actionId}`,
      commit: { oid: compensationOid, parents: { nodes: (change.parents ?? [change.parent ?? forwardOid]).map((parent: string) => ({ oid: parent })) }, repository: { nameWithOwner: change.repository ?? grant.repository } },
      ref: { name: change.branch ?? grant.branch, target: { oid: change.refResult ?? compensationOid } },
    } } } }))
    await expect(createCompensatingCommitOnGitHub({ actionId, grant: scoped, forwardCommitOid: forwardOid, preimage, token: 'secret', signal: new AbortController().signal }, { rest: head.transport, graphql: graphql.transport })).resolves.toMatchObject({ status: 'unknown', reason: 'github-compensation-unknown' })
    expect(graphql.calls).toHaveLength(1)
  })
})
