import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { execFile } from 'node:child_process'

const GIT_ENV = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Sandbox Bot',
  GIT_AUTHOR_EMAIL: 'sandbox@example.invalid',
  GIT_COMMITTER_NAME: 'Sandbox Bot',
  GIT_COMMITTER_EMAIL: 'sandbox@example.invalid',
}

async function runGit(repoPath, args, stdinText) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      'git',
      ['--git-dir', repoPath, ...args],
      { env: GIT_ENV, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`))
          return
        }
        resolvePromise(stdout)
      },
    )
    if (stdinText !== undefined) {
      child.stdin?.end(stdinText)
    } else {
      child.stdin?.end()
    }
  })
}

async function readTreeEntries(repoPath, commitOid) {
  const output = await runGit(repoPath, ['ls-tree', '-r', '-z', commitOid])
  const entries = new Map()
  for (const record of output.split('\0')) {
    if (!record) continue
    const tabIndex = record.indexOf('\t')
    if (tabIndex < 0) continue
    const meta = record.slice(0, tabIndex).split(' ')
    const entryPath = record.slice(tabIndex + 1)
    if (meta.length >= 3) {
      entries.set(entryPath, { mode: meta[0], type: meta[1], sha: meta[2], path: entryPath })
    }
  }
  return entries
}

async function buildTreeFromFlatEntries(repoPath, entriesMap) {
  // Group top-level entries; recursively build subtrees for nested paths.
  const direct = []
  const subdirs = new Map()
  for (const entry of entriesMap.values()) {
    const slash = entry.path.indexOf('/')
    if (slash < 0) {
      direct.push(entry)
    } else {
      const dir = entry.path.slice(0, slash)
      const rest = entry.path.slice(slash + 1)
      let childMap = subdirs.get(dir)
      if (!childMap) {
        childMap = new Map()
        subdirs.set(dir, childMap)
      }
      childMap.set(rest, { ...entry, path: rest })
    }
  }
  const lines = direct.map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`)
  for (const [dir, childMap] of subdirs.entries()) {
    const subTreeSha = await buildTreeFromFlatEntries(repoPath, childMap)
    lines.push(`040000 tree ${subTreeSha}\t${dir}`)
  }
  const treeInput = lines.length > 0 ? `${lines.join('\n')}\n` : ''
  return (await runGit(repoPath, ['mktree'], treeInput)).trim()
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

class HttpRequestError extends Error {
  constructor(statusCode, message) {
    super(message)
    this.statusCode = statusCode
  }
}

function decodeStrictBase64(value) {
  if (typeof value !== 'string') return undefined
  if (!BASE64_RE.test(value)) return undefined
  const buf = Buffer.from(value, 'base64')
  if (buf.toString('base64') !== value) return undefined
  return buf
}

function validScopedPath(filePath) {
  return typeof filePath === 'string'
    && filePath.length > 0
    && filePath.length <= 1024
    && !/[\\\p{Cc}]/u.test(filePath)
    && filePath.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}

async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > limitBytes) {
      throw new HttpRequestError(413, 'request body exceeded limit')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpRequestError(400, 'Invalid JSON request body')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpRequestError(400, 'Request body must be a JSON object')
  }
  return parsed
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/**
 * Rewrites `https://api.github.com/...` calls from `github.ts` to the local
 * HTTP sandbox server while preserving method, headers, body, and AbortSignal.
 */
export function createSandboxGitHubHttpTransport(baseUrl) {
  const target = new URL(baseUrl)
  return (url, options, callback) => {
    const parsed = url instanceof URL ? url : new URL(String(url))
    if (parsed.origin !== 'https://api.github.com') {
      throw new Error(`sandbox github transport refused non-GitHub origin: ${parsed.origin}`)
    }
    const rewritten = new URL(`${parsed.pathname}${parsed.search}`, target)
    return httpRequest(rewritten, options, callback)
  }
}

/**
 * Starts a local GitHub REST + GraphQL HTTP server backed by a real bare Git
 * repository (`git init --bare`), real Git blob/tree/commit objects, and atomic
 * CAS ref updates (`git update-ref <ref> <newOid> <expectedHeadOid>`).
 */
export async function startSandboxGitHubServer(options) {
  const {
    repoPath,
    repository = 'fixture/orders',
    baseBranch = 'main',
    branch = 'automation/fix',
    initialFiles = [],
    expectedToken,
    deliveryLogPath,
    eventStatePath,
    eventSourceLogPath,
    pullRequestNumber = 17,
    checkName = 'tests',
    checkAppId = 7,
    reviewerId = 42,
  } = options

  if (typeof repoPath !== 'string' || repoPath.length === 0) throw new Error('sandbox github server requires repoPath')
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) throw new Error('sandbox github server requires expectedToken')
  if (!Array.isArray(initialFiles) || initialFiles.length === 0) throw new Error('sandbox github server requires initialFiles')

  await mkdir(repoPath, { recursive: true, mode: 0o700 })
  await runGit(repoPath, ['init', '--bare', `--initial-branch=${baseBranch}`])

  const initialEntries = new Map()
  for (const file of initialFiles) {
    if (!validScopedPath(file.path)) throw new Error(`invalid initial file path: ${file.path}`)
    const blobSha = (await runGit(repoPath, ['hash-object', '-w', '--stdin'], Buffer.from(file.content, 'utf8'))).trim()
    initialEntries.set(file.path, { mode: '100644', type: 'blob', sha: blobSha, path: file.path })
  }
  const initialTreeSha = await buildTreeFromFlatEntries(repoPath, initialEntries)
  const initialOid = (await runGit(repoPath, ['commit-tree', initialTreeSha], 'Initial sandbox repository state\n')).trim()
  await runGit(repoPath, ['update-ref', `refs/heads/${baseBranch}`, initialOid])
  await runGit(repoPath, ['update-ref', `refs/heads/${branch}`, initialOid])

  let pullRequestState = null

  const getBranchHead = async (targetBranch = branch) => {
    try {
      return (await runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${targetBranch}`])).trim()
    } catch {
      return undefined
    }
  }

  const readEventReady = () => {
    if (!eventStatePath || !existsSync(eventStatePath)) return false
    try {
      return JSON.parse(readFileSync(eventStatePath, 'utf8')).ready === true
    } catch {
      return false
    }
  }

  const appendDeliveryLog = entry => {
    if (!deliveryLogPath) return
    appendFileSync(deliveryLogPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
  }

  const appendObservationLog = entry => {
    if (eventSourceLogPath) {
      appendFileSync(eventSourceLogPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    }
    if (deliveryLogPath && eventStatePath) {
      appendFileSync(`${deliveryLogPath}.readbacks`, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    }
  }

  const [expectedOwner, expectedRepo] = repository.split('/')

  const server = createServer(async (req, res) => {
    try {
      const auth = req.headers.authorization
      if (auth !== `Bearer ${expectedToken}`) {
        sendJson(res, 401, { message: 'Requires authentication' })
        return
      }
      let reqUrl
      try {
        reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        throw new HttpRequestError(400, 'Malformed request URL')
      }
      const pathname = reqUrl.pathname

      if (req.method === 'POST' && pathname === '/graphql') {
        const body = await readJsonBody(req)
        const queryText = typeof body?.query === 'string' ? body.query : ''
        const input = body?.variables?.input
        if (!queryText.includes('createCommitOnBranch') || !input || typeof input !== 'object') {
          sendJson(res, 200, { errors: [{ message: 'Unsupported GraphQL operation' }] })
          return
        }
        const targetRepo = input.branch?.repositoryNameWithOwner
        const targetBranch = input.branch?.branchName
        const expectedHeadOid = input.expectedHeadOid
        const clientMutationId = input.clientMutationId
        const headline = input.message?.headline ?? 'Commit'
        const msgBody = input.message?.body ?? ''
        const rawAdditions = input.fileChanges?.additions
        const rawDeletions = input.fileChanges?.deletions
        if ((rawAdditions !== undefined && !Array.isArray(rawAdditions))
          || (rawDeletions !== undefined && !Array.isArray(rawDeletions))) {
          sendJson(res, 400, { errors: [{ message: 'Invalid fileChanges' }] })
          return
        }
        const additions = rawAdditions ?? []
        const deletions = rawDeletions ?? []

        if (targetRepo !== repository || targetBranch !== branch || typeof expectedHeadOid !== 'string' || !/^[0-9a-f]{40}$/i.test(expectedHeadOid)) {
          sendJson(res, 200, { errors: [{ message: 'Target repository or branch is not authorized' }] })
          return
        }
        const currentHead = await getBranchHead(targetBranch)
        if (!currentHead || currentHead !== expectedHeadOid) {
          sendJson(res, 200, { errors: [{ message: `Expected head ${expectedHeadOid} does not match current head ${currentHead ?? 'missing'}` }] })
          return
        }

        // Pre-validate all additions and deletions before writing any Git objects.
        const validatedAdditions = []
        for (const addition of additions) {
          if (!addition || typeof addition !== 'object' || !validScopedPath(addition.path)) {
            sendJson(res, 200, { errors: [{ message: 'Invalid file addition' }] })
            return
          }
          const contentBuf = decodeStrictBase64(addition.contents)
          if (contentBuf === undefined) {
            sendJson(res, 400, { errors: [{ message: 'Invalid base64 contents' }] })
            return
          }
          const text = contentBuf.toString('utf8')
          if (text.includes(expectedToken)) {
            sendJson(res, 400, { message: 'Credential leak detected' })
            return
          }
          validatedAdditions.push({ path: addition.path, contentBuf, text })
        }
        for (const deletion of deletions) {
          if (!deletion || typeof deletion !== 'object' || !validScopedPath(deletion.path)) {
            sendJson(res, 200, { errors: [{ message: 'Invalid file deletion' }] })
            return
          }
        }

        const entries = await readTreeEntries(repoPath, expectedHeadOid)
        const recordedFiles = []
        for (const addition of validatedAdditions) {
          const blobSha = (await runGit(repoPath, ['hash-object', '-w', '--stdin'], addition.contentBuf)).trim()
          entries.set(addition.path, { mode: '100644', type: 'blob', sha: blobSha, path: addition.path })
          recordedFiles.push({ path: addition.path, content: addition.text })
        }
        for (const deletion of deletions) {
          entries.delete(deletion.path)
        }

        const newTreeSha = await buildTreeFromFlatEntries(repoPath, entries)
        const commitMsg = msgBody ? `${headline}\n\n${msgBody}\n` : `${headline}\n`
        const newCommitOid = (await runGit(repoPath, ['commit-tree', newTreeSha, '-p', expectedHeadOid], commitMsg)).trim()
        await runGit(repoPath, ['update-ref', `refs/heads/${targetBranch}`, newCommitOid, expectedHeadOid])

        const actionId = typeof clientMutationId === 'string' && clientMutationId.startsWith('dsh-action:')
          ? clientMutationId.slice('dsh-action:'.length)
          : clientMutationId
        appendDeliveryLog({
          kind: 'commit',
          at: Date.now(),
          actionId,
          commitOid: newCommitOid,
          parentOid: expectedHeadOid,
          files: recordedFiles,
        })

        sendJson(res, 200, {
          data: {
            createCommitOnBranch: {
              clientMutationId,
              commit: {
                oid: newCommitOid,
                parents: { nodes: [{ oid: expectedHeadOid }] },
                repository: { nameWithOwner: repository },
              },
              ref: {
                name: targetBranch,
                target: { oid: newCommitOid },
              },
            },
          },
        })
        return
      }

      let segments
      try {
        segments = pathname.split('/').filter(Boolean).map(decodeURIComponent)
      } catch (err) {
        if (err instanceof URIError) {
          throw new HttpRequestError(400, 'Malformed URL encoding')
        }
        throw err
      }
      if (segments[0] !== 'repos' || segments[1] !== expectedOwner || segments[2] !== expectedRepo) {
        sendJson(res, 404, { message: 'Not Found' })
        return
      }
      const rest = segments.slice(3)

      // GET /repos/:owner/:repo
      if (req.method === 'GET' && rest.length === 0) {
        sendJson(res, 200, { full_name: repository, default_branch: baseBranch })
        return
      }

      // GET /repos/:owner/:repo/branches/:branch
      if (req.method === 'GET' && rest.length === 2 && rest[0] === 'branches') {
        const targetBranch = rest[1]
        const sha = await getBranchHead(targetBranch)
        if (!sha) {
          sendJson(res, 404, { message: 'Branch not found' })
          return
        }
        const ready = readEventReady() && sha !== initialOid
        appendObservationLog({
          kind: 'branch',
          path: pathname,
          ready,
          headOid: sha,
          pullRequest: pullRequestState?.number ?? null,
          at: Date.now(),
        })
        sendJson(res, 200, { name: targetBranch, commit: { sha } })
        return
      }

      // GET /repos/:owner/:repo/contents/*?ref=...
      if (req.method === 'GET' && rest.length >= 2 && rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/')
        const ref = reqUrl.searchParams.get('ref') || branch
        const refOid = /^[0-9a-f]{40}$/i.test(ref) ? ref : await getBranchHead(ref)
        if (!refOid || !validScopedPath(filePath)) {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        const entries = await readTreeEntries(repoPath, refOid)
        const entry = entries.get(filePath)
        if (!entry || entry.type !== 'blob') {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        const rawContent = await runGit(repoPath, ['cat-file', 'blob', entry.sha])
        const buf = Buffer.from(rawContent, 'utf8')
        sendJson(res, 200, {
          path: filePath,
          type: 'file',
          encoding: 'base64',
          content: buf.toString('base64'),
          sha: entry.sha,
          size: buf.length,
        })
        return
      }

      // GET /repos/:owner/:repo/git/commits/:sha
      if (req.method === 'GET' && rest.length === 3 && rest[0] === 'git' && rest[1] === 'commits') {
        const commitSha = rest[2]
        if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        try {
          const commitObj = await runGit(repoPath, ['cat-file', 'commit', commitSha])
          const treeLine = commitObj.split('\n').find(line => line.startsWith('tree '))
          const treeSha = treeLine?.slice('tree '.length).trim()
          if (!treeSha) {
            sendJson(res, 404, { message: 'Not Found' })
            return
          }
          sendJson(res, 200, { sha: commitSha, tree: { sha: treeSha } })
        } catch {
          sendJson(res, 404, { message: 'Not Found' })
        }
        return
      }

      // GET /repos/:owner/:repo/git/trees/:sha?recursive=1
      if (req.method === 'GET' && rest.length === 3 && rest[0] === 'git' && rest[1] === 'trees') {
        const treeSha = rest[2]
        if (!/^[0-9a-f]{40}$/i.test(treeSha)) {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        try {
          const recursive = reqUrl.searchParams.get('recursive') === '1'
          const output = await runGit(repoPath, ['ls-tree', ...(recursive ? ['-r'] : []), '-z', treeSha])
          const tree = []
          for (const rec of output.split('\0')) {
            if (!rec) continue
            const tab = rec.indexOf('\t')
            if (tab < 0) continue
            const [mode, type, sha] = rec.slice(0, tab).split(' ')
            const entryPath = rec.slice(tab + 1)
            tree.push({ path: entryPath, mode, type, sha })
          }
          sendJson(res, 200, { sha: treeSha, truncated: false, tree })
        } catch {
          sendJson(res, 404, { message: 'Not Found' })
        }
        return
      }

      // POST /repos/:owner/:repo/pulls
      if (req.method === 'POST' && rest.length === 1 && rest[0] === 'pulls') {
        const body = await readJsonBody(req)
        if (body?.head !== branch || body?.base !== baseBranch) {
          sendJson(res, 422, { message: 'Invalid pull request head or base branch' })
          return
        }
        if (pullRequestState) {
          sendJson(res, 422, { message: 'Pull request already exists' })
          return
        }
        const headSha = await getBranchHead(branch)
        if (!headSha) {
          sendJson(res, 422, { message: 'Branch does not exist' })
          return
        }
        pullRequestState = {
          number: pullRequestNumber,
          state: 'open',
          merged: false,
          title: typeof body.title === 'string' ? body.title : 'Sandbox PR',
          body: typeof body.body === 'string' ? body.body : '',
          head: { ref: branch, sha: headSha, repo: { full_name: repository } },
          base: { ref: baseBranch, repo: { full_name: repository } },
        }
        appendDeliveryLog({
          kind: 'pr',
          at: Date.now(),
          headOid: headSha,
          number: pullRequestNumber,
        })
        sendJson(res, 201, pullRequestState)
        return
      }

      // GET /repos/:owner/:repo/pulls
      if (req.method === 'GET' && rest.length === 1 && rest[0] === 'pulls') {
        if (!pullRequestState) {
          sendJson(res, 200, [])
          return
        }
        const currentSha = await getBranchHead(branch)
        if (currentSha) pullRequestState.head.sha = currentSha
        sendJson(res, 200, [pullRequestState])
        return
      }

      // GET /repos/:owner/:repo/pulls/:number
      if (req.method === 'GET' && rest.length === 2 && rest[0] === 'pulls') {
        const num = Number(rest[1])
        if (!pullRequestState || num !== pullRequestNumber) {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        const currentSha = await getBranchHead(branch)
        if (currentSha) pullRequestState.head.sha = currentSha
        const ready = readEventReady() && pullRequestState.head.sha !== initialOid
        appendObservationLog({
          kind: 'pull-request',
          path: pathname,
          ready,
          headOid: pullRequestState.head.sha,
          pullRequest: pullRequestState.number,
          at: Date.now(),
        })
        sendJson(res, 200, pullRequestState)
        return
      }

      // GET /repos/:owner/:repo/pulls/:number/reviews
      if (req.method === 'GET' && rest.length === 3 && rest[0] === 'pulls' && rest[2] === 'reviews') {
        const num = Number(rest[1])
        if (!pullRequestState || num !== pullRequestNumber) {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        const currentSha = (await getBranchHead(branch)) ?? pullRequestState.head.sha
        pullRequestState.head.sha = currentSha
        const ready = readEventReady() && currentSha !== initialOid
        const reviews = ready
          ? [{ id: 1, user: { id: reviewerId }, commit_id: currentSha, state: 'APPROVED' }]
          : []
        appendObservationLog({
          kind: 'reviews',
          path: pathname,
          ready,
          headOid: currentSha,
          pullRequest: pullRequestState.number,
          at: Date.now(),
        })
        sendJson(res, 200, reviews)
        return
      }

      // GET /repos/:owner/:repo/commits/:ref/check-runs
      if (req.method === 'GET' && rest.length === 3 && rest[0] === 'commits' && rest[2] === 'check-runs') {
        const refParam = rest[1]
        const currentHead = await getBranchHead(branch)
        const sha = /^[0-9a-f]{40}$/i.test(refParam) ? refParam.toLowerCase() : refParam === branch ? currentHead : undefined
        if (!sha) {
          sendJson(res, 404, { message: 'Not Found' })
          return
        }
        const normalizedHead = currentHead?.toLowerCase()
        const exactCommittedSha = normalizedHead !== undefined && sha === normalizedHead && sha !== initialOid.toLowerCase()
        const ready = readEventReady() && exactCommittedSha
        const checkRuns = [{
          id: 1,
          name: checkName,
          app: { id: checkAppId },
          head_sha: sha,
          status: ready ? 'completed' : 'in_progress',
          conclusion: ready ? 'success' : null,
        }]
        appendObservationLog({
          kind: 'checks',
          path: pathname,
          ready,
          headOid: sha,
          pullRequest: pullRequestState?.number ?? null,
          at: Date.now(),
        })
        sendJson(res, 200, { total_count: checkRuns.length, check_runs: checkRuns })
        return
      }

      sendJson(res, 404, { message: 'Not Found' })
    } catch (error) {
      const statusCode = error instanceof HttpRequestError ? error.statusCode : 500
      sendJson(res, statusCode, { message: error instanceof Error ? error.message : 'Internal error' })
    }
  })

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('sandbox github server failed to bind TCP port')
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    port: address.port,
    repoPath,
    repository,
    baseBranch,
    branch,
    initialOid,
    getBranchHead,
    readFileAt: async (ref, filePath) => await runGit(repoPath, ['show', `${ref}:${filePath}`]),
    getCommitObject: async oid => await runGit(repoPath, ['cat-file', '-p', oid]),
    getPullRequest: () => pullRequestState ? structuredClone(pullRequestState) : null,
    close: async () => {
      await new Promise(resolveClose => server.close(() => resolveClose()))
    },
  }
}
