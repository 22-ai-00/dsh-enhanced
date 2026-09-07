import { createServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, RequestOptions, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { commitOnGitHub } from '../src/github.ts'
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
