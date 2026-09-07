import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { commitOnGitHub } from '../src/github.ts'
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
