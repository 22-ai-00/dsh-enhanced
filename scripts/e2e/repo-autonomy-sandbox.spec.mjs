import { describe, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { startSandboxGitHubServer, createSandboxGitHubHttpTransport } from './repo-sandbox-github-server.mjs'
import { startSandboxLlmServer } from './repo-sandbox-llm-server.mjs'
import { runIsolatedSubprocess } from '../../plugins/assistant-isolation/lib/index.js'
import { requestGitHubBroker } from '../../plugins/assistant-actions/lib/broker-client.js'
import { withBrokerGrantDigest } from '../../plugins/assistant-actions/lib/broker-ledger.js'
import { canonicalBrokerJson } from '../../plugins/assistant-actions/lib/broker-protocol.js'
import { inspectLinuxPeerCredentials } from '../../plugins/assistant-actions/lib/broker-peer-linux.js'
import { commitOnGitHub, createPullRequestOnGitHub, inspectGitHub } from '../../plugins/assistant-actions/lib/github.js'
import { EventTriggersService } from '../../plugins/event-triggers/lib/index.js'
import { readGitHubRepositoryObservation } from '../../plugins/event-triggers/lib/github-sensor.js'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
const daemonScript = resolve(root, 'scripts/e2e/repo-sandbox-broker-daemon.mjs')
const actionsLibDir = resolve(root, 'plugins/assistant-actions/lib')

const BUGGY_SUMMARIZE = "process.stdin.on('data', value => console.log(JSON.stringify(JSON.parse(value))))\n"
const FIXED_SUMMARIZE = [
  "import { readFileSync } from 'node:fs'",
  "const orders = JSON.parse(readFileSync(0, 'utf8').trim() || '[]')",
  'const totals = {}',
  'for (const order of orders) {',
  "  if (order.status === 'cancelled') continue",
  '  totals[order.currency] = (totals[order.currency] ?? 0) + order.amountCents',
  '}',
  'const sorted = Object.fromEntries(Object.keys(totals).sort().map(k => [k, totals[k]]))',
  'process.stdout.write(`${JSON.stringify(sorted)}\\n`)',
].join('\n') + '\n'

async function git(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['--git-dir', repoPath, ...args], { encoding: 'utf8' })
  return stdout.trim()
}

async function gitCountObjects(repoPath) {
  const out = await git(repoPath, ['count-objects', '-v'])
  const counts = {}
  for (const line of out.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) counts[line.slice(0, idx).trim()] = Number(line.slice(idx + 1).trim())
  }
  return (counts.count ?? 0) + (counts['in-pack'] ?? 0)
}

describe('WP18 Standalone Sandbox Repo E2E (bare Git + HTTP GitHub + Separate-Process UDS Broker + Isolation)', () => {
  test('enforces bearer auth, CAS expectedHeadOid, and exact-SHA checks on local bare Git + HTTP server', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-sbx-gh-'))
    const eventStatePath = join(temp, 'event-state.json')
    const deliveryLogPath = join(temp, 'delivery.jsonl')
    const eventSourceLogPath = join(temp, 'observations.jsonl')
    await writeFile(eventStatePath, '{"ready":false}', { mode: 0o600 })

    const gh = await startSandboxGitHubServer({
      repoPath: join(temp, 'remote.git'),
      repository: 'fixture/orders',
      baseBranch: 'main',
      branch: 'automation/fix',
      initialFiles: [{ path: 'summarize.mjs', content: BUGGY_SUMMARIZE }],
      expectedToken: 'sbx-secret-token',
      deliveryLogPath,
      eventStatePath,
      eventSourceLogPath,
    })

    try {
      expect(gh.initialOid).toMatch(/^[0-9a-f]{40}$/)
      expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/main'])).toBe(gh.initialOid)
      expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix'])).toBe(gh.initialOid)

      // Unauthenticated request fails closed with 401
      const unauth = await fetch(`${gh.url}/repos/fixture/orders`)
      expect(unauth.status).toBe(401)

      const transport = createSandboxGitHubHttpTransport(gh.url)
      const grant = {
        id: 'g-cas',
        revision: 1,
        repository: 'fixture/orders',
        branch: 'automation/fix',
        paths: ['summarize.mjs'],
        repoWorkflow: { baseBranch: 'main', allowBranchCreate: false, allowPullRequest: true },
      }
      const ac = new AbortController()

      // Wrong expectedHeadOid must fail CAS without advancing branch
      const wrongHeadCommit = await commitOnGitHub({
        actionId: 'act-wrong-head',
        grant,
        request: {
          grantId: grant.id,
          idempotencyKey: 'k-wrong-head',
          expectedHeadOid: '0'.repeat(40),
          headline: 'Should fail CAS',
          files: [{ path: 'summarize.mjs', content: FIXED_SUMMARIZE }],
        },
        token: 'sbx-secret-token',
        signal: ac.signal,
      }, transport)
      expect(wrongHeadCommit.status).toBe('unknown')
      expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix'])).toBe(gh.initialOid)

      // Valid CAS commit advances branch head in real bare Git repo
      const okCommit = await commitOnGitHub({
        actionId: 'act-ok',
        grant,
        request: {
          grantId: grant.id,
          idempotencyKey: 'k-ok',
          expectedHeadOid: gh.initialOid,
          headline: 'Fix summarize.mjs',
          files: [{ path: 'summarize.mjs', content: FIXED_SUMMARIZE }],
        },
        token: 'sbx-secret-token',
        signal: ac.signal,
      }, transport)
      expect(okCommit.status).toBe('succeeded')
      expect(okCommit.commitOid).toBe(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix']))
      expect(await gh.readFileAt(okCommit.commitOid, 'summarize.mjs')).toBe(FIXED_SUMMARIZE)

      // Stale/wrong-SHA check-runs stay in_progress even when ready=true
      await writeFile(eventStatePath, '{"ready":true}', { mode: 0o600 })
      const staleChecks = await inspectGitHub({
        grant,
        kind: 'commit-checks',
        commitOid: gh.initialOid,
        token: 'sbx-secret-token',
        signal: ac.signal,
      }, transport)
      expect(staleChecks?.observed?.items?.[0]).toMatchObject({
        head_sha: gh.initialOid,
        status: 'in_progress',
        conclusion: null,
      })

      // Exact committed SHA check-runs report completed/success
      const freshChecks = await inspectGitHub({
        grant,
        kind: 'commit-checks',
        commitOid: okCommit.commitOid,
        token: 'sbx-secret-token',
        signal: ac.signal,
      }, transport)
      expect(freshChecks?.observed?.items?.[0]).toMatchObject({
        head_sha: okCommit.commitOid,
        status: 'completed',
        conclusion: 'success',
      })

      // PR bound to real commit OID
      const pr = await createPullRequestOnGitHub({
        actionId: 'act-pr',
        grant,
        expectedHeadOid: okCommit.commitOid,
        title: 'Fix summarize.mjs',
        body: 'Fixed sorting and cancelled filter',
        token: 'sbx-secret-token',
        signal: ac.signal,
      }, transport)
      expect(pr).toMatchObject({ status: 'succeeded', pullRequestNumber: 17 })
    } finally {
      await gh.close()
      await rm(temp, { recursive: true, force: true })
    }
  })

  test('executes full isolation + separate-process ExternalBrokerCore UDS + real git commit/PR + post-ready readback', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-sbx-e2e-'))
    const ws = join(temp, 'ws')
    const sockDir = join(temp, 'bk')
    const actionSocketPath = join(sockDir, 'a.sock')
    const adminSocketPath = join(sockDir, 'm.sock')
    await mkdir(ws, { recursive: true, mode: 0o700 })
    await mkdir(sockDir, { recursive: true, mode: 0o700 })

    // Verify sun_path limit explicitly (use short fallback if TMPDIR is deep)
    let effectiveSockDir = sockDir
    let ownedShortDir = false
    if (Buffer.byteLength(actionSocketPath) > 100 || Buffer.byteLength(adminSocketPath) > 100) {
      effectiveSockDir = await mkdtemp(join('/tmp', 'dshb-'))
      await mkdir(effectiveSockDir, { recursive: true, mode: 0o700 })
      ownedShortDir = true
    }
    const actSock = join(effectiveSockDir, 'a.sock')
    const admSock = join(effectiveSockDir, 'm.sock')
    expect(Buffer.byteLength(actSock)).toBeLessThanOrEqual(100)
    expect(Buffer.byteLength(admSock)).toBeLessThanOrEqual(100)

    const eventStatePath = join(temp, 'event-state.json')
    const deliveryLogPath = join(temp, 'github-fixture.jsonl')
    const eventSourceLogPath = join(temp, 'observations.jsonl')
    const tokenPath = join(temp, 'broker-token')
    const brokerToken = 'sbx-broker-only-token'
    await writeFile(eventStatePath, '{"ready":false}', { mode: 0o600 })
    await writeFile(tokenPath, brokerToken, { mode: 0o600 })

    // 1. Real linux-native isolation execution on summarize.mjs
    const scriptPath = join(ws, 'summarize.mjs')
    await writeFile(scriptPath, FIXED_SUMMARIZE, { mode: 0o600 })
    const isoPass = await runIsolatedSubprocess({
      command: process.execPath,
      args: [scriptPath],
      cwd: ws,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdin: '[{"currency":"USD","amountCents":100},{"currency":"USD","amountCents":50,"status":"cancelled"},{"currency":"EUR","amountCents":-25},{"currency":"EUR","amountCents":5}]\n',
      timeoutMs: 5_000,
      network: 'none',
    })
    expect(isoPass.sandboxed).toBe(true)
    expect(isoPass.status).toBe('succeeded')
    expect(isoPass.stdout).toBe('{"EUR":-20,"USD":100}\n')

    const isoFail = await runIsolatedSubprocess({
      command: process.execPath,
      args: ['-e', 'process.exit(19)'],
      cwd: ws,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdin: '',
      timeoutMs: 5_000,
      network: 'none',
    })
    expect(isoFail.sandboxed).toBe(true)
    expect(isoFail.status).toBe('failed')
    expect(isoFail.exitCode).toBe(19)

    // 2. Real bare Git + HTTP GitHub server
    const gh = await startSandboxGitHubServer({
      repoPath: join(temp, 'remote.git'),
      repository: 'fixture/orders',
      baseBranch: 'main',
      branch: 'automation/fix',
      initialFiles: [{ path: 'summarize.mjs', content: BUGGY_SUMMARIZE }],
      expectedToken: brokerToken,
      deliveryLogPath,
      eventStatePath,
      eventSourceLogPath,
    })

    // 3. Spawn separate-process ExternalBrokerCore UDS daemon
    const uid = process.getuid()
    const gid = process.getgid()
    const serverKeys = generateKeyPairSync('ed25519')
    const clientKeys = generateKeyPairSync('ed25519')
    const adminKeys = generateKeyPairSync('ed25519')

    const owner = {
      principalDigest: createHash('sha256').update('web/web/local/operator').digest('hex'),
      principalRecordId: 'owner-1',
      principalVersion: 1,
      workspace: ws,
      preset: 'standard',
      bindingId: 'bind-1',
      bindingVersion: 1,
      bindingGeneration: 1,
    }
    const grant = withBrokerGrantDigest({
      protocol: 'assistant-actions/external-github-grant/v1',
      id: 'sbx-grant-1',
      revision: 1,
      clientKeyId: 'host',
      client: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 },
      owner,
      sessionId: 'sess-sbx-1',
      destination: {
        classification: 'github-repository',
        repository: 'fixture/orders',
        branch: 'automation/fix',
        baseBranch: 'main',
        paths: ['summarize.mjs'],
      },
      credentialId: 'broker-token',
      expiresAt: Date.now() + 300_000,
      maxActions: 30,
      maxTotalBytes: 1_048_576,
      maxCostUnits: 60,
      allowedOperations: ['commit', 'inspect', 'pull-request'],
      allowedInspectKinds: ['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'],
      source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
      policyEpoch: 1,
      emergencyEpoch: 0,
    })

    const daemonConfigPath = join(temp, 'daemon-config.json')
    await writeFile(daemonConfigPath, JSON.stringify({
      assistantActionsLibDir: actionsLibDir,
      githubBaseUrl: gh.url,
      instanceId: 'broker',
      statePath: join(temp, 'broker-state.sqlite'),
      grants: [grant],
      policyEpoch: 1,
      credentials: [{ id: 'broker-token', provider: 'linux-protected-file', path: tokenPath, maxLeaseMs: 30_000 }],
      actionSocketPath: actSock,
      adminSocketPath: admSock,
      serverPrivateKeyPem: serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      clientPublicKeyPem: clientKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      clientKeyId: 'host',
      adminPublicKeyPem: adminKeys.publicKey.export({ type: 'spki', format: 'pem' }),
      adminKeyId: 'admin',
      uid,
      gid,
    }), { mode: 0o600 })

    const daemon = spawn(process.execPath, [daemonScript, daemonConfigPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let daemonOut = ''
    let daemonErr = ''
    daemon.stderr.on('data', chunk => { daemonErr += chunk })
    const daemonPid = await new Promise((resolvePid, rejectPid) => {
      const timer = setTimeout(() => rejectPid(new Error(`broker daemon timeout: ${daemonErr}`)), 15_000)
      daemon.stdout.on('data', chunk => {
        daemonOut += chunk
        const m = /^READY (\d+)\n/m.exec(daemonOut)
        if (m) {
          clearTimeout(timer)
          resolvePid(Number(m[1]))
        }
      })
      daemon.once('close', code => {
        clearTimeout(timer)
        rejectPid(new Error(`broker daemon exited (${code}): ${daemonErr}`))
      })
    })

    try {
      expect(daemonPid).not.toBe(process.pid)
      expect((await lstat(actSock)).isSocket()).toBe(true)

      const clientOpts = {
        socketPath: actSock,
        serverPublicKey: serverKeys.publicKey,
        clientPrivateKey: clientKeys.privateKey,
        clientKeyId: 'host',
        source: { kind: 'assistant-actions-host', instanceId: 'host', generation: 1 },
        expectedBrokerPeerUid: uid,
        expectedBrokerPeerGid: gid,
        expectedSocketUid: uid,
        expectedSocketGid: gid,
        expectedSocketMode: 0o600,
        expectedSocketParentUid: uid,
        expectedSocketParentGid: gid,
        expectedSocketParentMode: 0o700,
        inspectPeerCredentials: inspectLinuxPeerCredentials,
        timeoutMs: 10_000,
      }

      const sendBroker = async (actionId, operation, payload) => {
        const bytes = Buffer.byteLength(canonicalBrokerJson(payload))
        const maxCostUnits = operation === 'inspect' && ['checks', 'reviews'].includes(payload.kind) ? 2 : 1
        return await requestGitHubBroker(clientOpts, {
          actionId,
          grantId: grant.id,
          grantRevision: grant.revision,
          grantDigest: grant.digest,
          owner,
          sessionId: grant.sessionId,
          agentId: 'agent-sbx-1',
          rootCallId: `root-${actionId}`,
          callId: `call-${actionId}`,
          operation,
          source: grant.source,
          destination: {
            classification: 'github-repository',
            repository: 'fixture/orders',
            branch: 'automation/fix',
            baseBranch: 'main',
          },
          payload,
          deadline: Math.min(grant.expiresAt, Date.now() + 20_000),
          budget: { reservationId: actionId, actions: 1, bytes, costMetric: 'github-api-units', maxCostUnits },
        })
      }

      // Inspect branch & initial file over signed UDS
      const branchRes = await sendBroker('act-insp-branch', 'inspect', { kind: 'branch' })
      expect(branchRes.error).toBeNull()
      expect(branchRes.status).toBe('succeeded')
      expect(branchRes.result?.observed?.commit?.sha).toBe(gh.initialOid)

      const fileRes = await sendBroker('act-insp-file', 'inspect', { kind: 'file', path: 'summarize.mjs' })
      expect(fileRes.status).toBe('succeeded')
      expect(fileRes.result?.observed?.content).toBe(BUGGY_SUMMARIZE)

      // Commit via signed UDS -> ExternalBrokerCore -> real commitOnGitHub -> local HTTP -> bare Git
      const commitRes = await sendBroker('act-commit', 'commit', {
        expectedHeadOid: gh.initialOid,
        headline: 'Fix summarize.mjs order summation',
        files: [{ path: 'summarize.mjs', content: FIXED_SUMMARIZE }],
      })
      expect(commitRes.status).toBe('succeeded')
      const commitOid = commitRes.result?.commitOid
      expect(commitOid).toMatch(/^[0-9a-f]{40}$/)
      expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix'])).toBe(commitOid)
      expect(await gh.readFileAt(commitOid, 'summarize.mjs')).toBe(FIXED_SUMMARIZE)

      // Stale expectedHeadOid over signed UDS fails CAS without overwriting branch
      const staleCommitRes = await sendBroker('act-commit-stale-cas', 'commit', {
        expectedHeadOid: gh.initialOid,
        headline: 'Stale CAS attempt',
        files: [{ path: 'summarize.mjs', content: 'console.log("stale")\n' }],
      })
      expect(staleCommitRes.status).not.toBe('succeeded')
      expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix'])).toBe(commitOid)

      // Create PR via signed UDS
      const prRes = await sendBroker('act-pr', 'pull-request', {
        expectedHeadOid: commitOid,
        title: 'Fix summarize.mjs order summation',
        body: 'Verified in linux-native isolation.',
      })
      expect(prRes.status).toBe('succeeded')
      expect(prRes.result?.pullRequestNumber).toBe(17)

      // Pending checks/reviews before state transition
      const pendingChecks = await sendBroker('act-checks-pending', 'inspect', { kind: 'checks', pullRequestNumber: 17 })
      expect(pendingChecks.status).toBe('succeeded')
      expect(pendingChecks.result?.observed?.items?.[0]).toMatchObject({ status: 'in_progress', conclusion: null })

      const pendingReviews = await sendBroker('act-reviews-pending', 'inspect', { kind: 'reviews', pullRequestNumber: 17 })
      expect(pendingReviews.status).toBe('succeeded')
      expect(pendingReviews.result?.observed?.items).toEqual([])

      // EventTriggers observation before & after ready=true produces distinct fingerprints
      expect(typeof EventTriggersService).toBe('function')
      const localFetcher = (url, init) => {
        const parsed = new URL(url)
        const target = new URL(`${parsed.pathname}${parsed.search}`, gh.url)
        return fetch(target, init)
      }
      const obsPending = await readGitHubRepositoryObservation({
        repository: 'fixture/orders',
        branch: 'automation/fix',
        baseBranch: 'main',
        token: brokerToken,
        maxBodyBytes: 262_144,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        fetcher: localFetcher,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      })
      expect(obsPending.truthy).toBe(true)

      // Flip event state -> ready: true and re-read over UDS + EventTriggers
      await writeFile(eventStatePath, '{"ready":true}', { mode: 0o600 })
      const obsReady = await readGitHubRepositoryObservation({
        repository: 'fixture/orders',
        branch: 'automation/fix',
        baseBranch: 'main',
        token: brokerToken,
        maxBodyBytes: 262_144,
        timeoutMs: 5_000,
        signal: new AbortController().signal,
        fetcher: localFetcher,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      })
      expect(obsReady.truthy).toBe(true)
      expect(obsReady.fingerprint).not.toBe(obsPending.fingerprint)

      const readyChecks = await sendBroker('act-checks-ready', 'inspect', { kind: 'checks', pullRequestNumber: 17 })
      expect(readyChecks.status).toBe('succeeded')
      expect(readyChecks.result?.observed?.items?.[0]).toMatchObject({ head_sha: commitOid, status: 'completed', conclusion: 'success' })

      const readyReviews = await sendBroker('act-reviews-ready', 'inspect', { kind: 'reviews', pullRequestNumber: 17 })
      expect(readyReviews.status).toBe('succeeded')
      expect(readyReviews.result?.observed?.items?.[0]).toMatchObject({ commit_id: commitOid, state: 'APPROVED' })

      // Verify zero leaked secrets in git objects or logs
      const logContent = await readFile(deliveryLogPath, 'utf8')
      expect(logContent).not.toContain(brokerToken)
      const obsContent = await readFile(eventSourceLogPath, 'utf8')
      expect(obsContent).not.toContain(brokerToken)
      expect(obsContent).toContain('"ready":true')
    } finally {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill('SIGTERM')
        await Promise.race([once(daemon, 'close'), new Promise(resolveWait => setTimeout(resolveWait, 5_000))])
      }
      await gh.close()
      if (ownedShortDir) await rm(effectiveSockDir, { recursive: true, force: true })
      await rm(temp, { recursive: true, force: true })
    }
  })

  test('local OpenAI-compatible sandbox LLM server handles SSE tool_calls and text completions', async () => {
    const llm = await startSandboxLlmServer({ apiKey: 'sbx-llm-test-key' })
    try {
      const res = await fetch(`${llm.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sbx-llm-test-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: llm.model,
          stream: false,
          messages: [
            { role: 'system', content: 'Approved:\n<approved-goal-objective>\nFix summarize.mjs\n</approved-goal-objective>' },
            { role: 'user', content: 'Fix summarize.mjs' },
          ],
          tools: [{ type: 'function', function: { name: 'goal_create', parameters: {} } }],
        }),
      })
      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json.choices[0].finish_reason).toBe('tool_calls')
      expect(json.choices[0].message.tool_calls[0].function.name).toBe('goal_create')
      expect(JSON.parse(json.choices[0].message.tool_calls[0].function.arguments)).toMatchObject({
        objective: 'Fix summarize.mjs',
        start_native_rounds: true,
      })
    } finally {
      await llm.close()
    }
  })

  test('rejects malformed base64, invalid JSON/URL encoding, non-object bodies, writes zero dangling objects on partial failure, and normalizes uppercase SHAs', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-sbx-hardening-'))
    const eventStatePath = join(temp, 'event-state.json')
    await writeFile(eventStatePath, '{"ready":true}', { mode: 0o600 })

    const gh = await startSandboxGitHubServer({
      repoPath: join(temp, 'remote.git'),
      repository: 'fixture/orders',
      baseBranch: 'main',
      branch: 'automation/fix',
      initialFiles: [{ path: 'summarize.mjs', content: BUGGY_SUMMARIZE }],
      expectedToken: 'sbx-secret-token',
      eventStatePath,
    })

    const authHeaders = {
      authorization: 'Bearer sbx-secret-token',
      'content-type': 'application/json',
    }
    const postGraphql = async (additions, deletions, expectedHeadOid) => await fetch(`${gh.url}/graphql`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        query: 'mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { clientMutationId } }',
        variables: {
          input: {
            branch: { repositoryNameWithOwner: 'fixture/orders', branchName: 'automation/fix' },
            expectedHeadOid,
            message: { headline: 'Hardening check' },
            fileChanges: { additions, ...(deletions ? { deletions } : {}) },
            clientMutationId: 'dsh-action:hardening',
          },
        },
      }),
    })

    try {
      const initialObjects = await gitCountObjects(gh.repoPath)

      // 1. Malformed base64 payloads & non-string contents fail cleanly with 400 + GraphQL errors and zero git writes
      for (const badContents of ['!!!not-valid-base64!!!', 'SGVs bG8=', 'SGVsbG8', 'AB==', 123, null]) {
        const res = await postGraphql([{ path: 'summarize.mjs', contents: badContents }], undefined, gh.initialOid)
        expect(res.status).toBe(400)
        const payload = await res.json()
        expect(Array.isArray(payload.errors)).toBe(true)
        expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix'])).toBe(gh.initialOid)
        expect(await gitCountObjects(gh.repoPath)).toBe(initialObjects)
      }

      // 2. Valid base64 edge cases (empty string "" and standard padded base64) succeed
      const validRes = await postGraphql([
        { path: 'empty.txt', contents: '' },
        { path: 'hello.txt', contents: 'SGVsbG8=' },
      ], undefined, gh.initialOid)
      expect(validRes.status).toBe(200)
      const validJson = await validRes.json()
      expect(validJson.errors).toBeUndefined()
      const committedHead = validJson.data.createCommitOnBranch.commit.oid
      expect(committedHead).toMatch(/^[0-9a-f]{40}$/)
      expect(await gh.readFileAt(committedHead, 'empty.txt')).toBe('')
      expect(await gh.readFileAt(committedHead, 'hello.txt')).toBe('Hello')

      // 3. Multi-addition / deletion failures pre-validate before hash-object -w -> zero dangling objects
      const objectsBeforeFailures = await gitCountObjects(gh.repoPath)
      const validNewAddition = { path: 'valid-new.mjs', contents: Buffer.from('console.log("unique-valid-content")\n', 'utf8').toString('base64') }

      const partialTraversal = await postGraphql([validNewAddition, { path: '../evil.js', contents: Buffer.from('x').toString('base64') }], undefined, committedHead)
      expect((await partialTraversal.json()).errors?.length).toBeGreaterThan(0)
      expect(await gitCountObjects(gh.repoPath)).toBe(objectsBeforeFailures)

      const partialBadBase64 = await postGraphql([validNewAddition, { path: 'bad.mjs', contents: '!!!bad!!!' }], undefined, committedHead)
      expect(partialBadBase64.status).toBe(400)
      expect(await gitCountObjects(gh.repoPath)).toBe(objectsBeforeFailures)

      const partialSecretLeak = await postGraphql([validNewAddition, { path: 'leak.txt', contents: Buffer.from('leak sbx-secret-token here').toString('base64') }], undefined, committedHead)
      expect(partialSecretLeak.status).toBe(400)
      expect(await gitCountObjects(gh.repoPath)).toBe(objectsBeforeFailures)

      const partialBadDeletion = await postGraphql([validNewAddition], [{ path: '../evil.js' }], committedHead)
      expect((await partialBadDeletion.json()).errors?.length).toBeGreaterThan(0)
      expect(await gitCountObjects(gh.repoPath)).toBe(objectsBeforeFailures)
      expect(await git(gh.repoPath, ['rev-parse', 'refs/heads/automation/fix'])).toBe(committedHead)

      // 4. Malformed JSON, null/array/primitive bodies, and invalid %-encoding return HTTP 400
      for (const rawBody of ['{not-json', '', 'null', '[]', '123', '"str"']) {
        const gqlBad = await fetch(`${gh.url}/graphql`, { method: 'POST', headers: authHeaders, body: rawBody })
        expect(gqlBad.status).toBe(400)
        const prBad = await fetch(`${gh.url}/repos/fixture/orders/pulls`, { method: 'POST', headers: authHeaders, body: rawBody })
        expect(prBad.status).toBe(400)
      }
      const badPct = await fetch(`${gh.url}/repos/fixture/orders/branches/%E0%A4%A`, { headers: { authorization: 'Bearer sbx-secret-token' } })
      expect(badPct.status).toBe(400)

      // 5. Uppercase 40-hex SHA in /commits/:ref/check-runs normalizes to lowercase and matches currentHead
      const upperCurrent = await fetch(`${gh.url}/repos/fixture/orders/commits/${committedHead.toUpperCase()}/check-runs`, {
        headers: { authorization: 'Bearer sbx-secret-token' },
      })
      expect(upperCurrent.status).toBe(200)
      const upperCurrentJson = await upperCurrent.json()
      expect(upperCurrentJson.check_runs[0]).toMatchObject({
        head_sha: committedHead,
        status: 'completed',
        conclusion: 'success',
      })

      const upperStale = await fetch(`${gh.url}/repos/fixture/orders/commits/${gh.initialOid.toUpperCase()}/check-runs`, {
        headers: { authorization: 'Bearer sbx-secret-token' },
      })
      expect(upperStale.status).toBe(200)
      const upperStaleJson = await upperStale.json()
      expect(upperStaleJson.check_runs[0]).toMatchObject({
        head_sha: gh.initialOid,
        status: 'in_progress',
        conclusion: null,
      })
    } finally {
      await gh.close()
      await rm(temp, { recursive: true, force: true })
    }
  })

  test('sandbox LLM server returns HTTP 400 on malformed JSON, empty body, and null/non-object bodies', async () => {
    const llm = await startSandboxLlmServer({ apiKey: 'sbx-llm-test-key' })
    try {
      for (const rawBody of ['{not-json', '', 'null', '[]', '123', '"text"']) {
        const res = await fetch(`${llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer sbx-llm-test-key',
            'content-type': 'application/json',
          },
          body: rawBody,
        })
        expect(res.status).toBe(400)
        const json = await res.json()
        expect(typeof json?.error?.message).toBe('string')
      }
    } finally {
      await llm.close()
    }
  })
})
