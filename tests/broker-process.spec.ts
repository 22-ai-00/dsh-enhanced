import { spawn, type ChildProcess } from 'node:child_process'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { requestGitHubBroker } from '../plugins/assistant-actions/src/broker-client.ts'
import { brokerPayloadBytes, withBrokerGrantDigest, type ExternalGitHubGrantUnsigned } from '../plugins/assistant-actions/src/broker-ledger.ts'
import type { BrokerRequestIntent } from '../plugins/assistant-actions/src/broker-protocol.ts'

const uid = process.getuid?.() ?? 0
const gid = process.getgid?.() ?? 0
const brokerCli = fileURLToPath(new URL('../plugins/assistant-actions/lib/broker-cli.js', import.meta.url))
const brokerFixture = fileURLToPath(new URL('./fixtures/broker-process-fixture.mjs', import.meta.url))
const roots: string[] = []
const children = new Set<ChildProcess>()
const childEnv = { ...process.env, NODE_NO_WARNINGS: '1' }

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await waitForExit(child, 2_000).catch(() => child.kill('SIGKILL'))
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function pem(key: KeyObject): string | Buffer {
  return key.type === 'private' ? key.export({ format: 'pem', type: 'pkcs8' }) : key.export({ format: 'pem', type: 'spki' })
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'abp-e2e-'))
  roots.push(root)
  await chmod(root, 0o700)
  return root
}

async function writePrivate(path: string, value: string | Buffer): Promise<void> {
  await writeFile(path, value, { mode: 0o600 })
  await chmod(path, 0o600)
}

async function waitForSocket(path: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`broker daemon exited before socket ${path} was ready: ${stderr()}`)
    if (await lstat(path).then(stat => stat.isSocket(), error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    })) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for broker socket ${path}: ${stderr()}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error('process did not exit'))
    }, timeoutMs)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      resolve({ code, signal })
    }
    child.once('exit', onExit)
  })
}

async function runCli(args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [brokerCli, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', chunk => { stdout += String(chunk) })
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  const { code } = await waitForExit(child, 5_000)
  return { code, stdout, stderr }
}

async function privateLayout(): Promise<{ root: string; actionRuntime: string; adminRuntime: string; credentials: string; workspace: string }> {
  const root = await privateRoot()
  const actionRuntime = join(root, 'action')
  const adminRuntime = join(root, 'admin')
  const credentials = join(root, 'credentials')
  const workspace = join(root, 'workspace')
  await Promise.all([mkdir(actionRuntime, { mode: 0o700 }), mkdir(adminRuntime, { mode: 0o700 }), mkdir(credentials, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 })])
  await Promise.all([chmod(actionRuntime, 0o700), chmod(adminRuntime, 0o700), chmod(credentials, 0o700), chmod(workspace, 0o700)])
  return { root, actionRuntime, adminRuntime, credentials, workspace }
}

function grant(now: number, workspace: string) {
  return withBrokerGrantDigest({
    protocol: 'assistant-actions/external-github-grant/v1',
    id: 'grant-process',
    revision: 1,
    clientKeyId: 'client-process',
    owner: { principalDigest: 'a'.repeat(64), principalRecordId: 'principal-process', principalVersion: 1, workspace, preset: 'primary', bindingId: 'binding-process', bindingVersion: 1, bindingGeneration: 1 },
    sessionId: 'session-process',
    destination: { classification: 'github-repository', repository: 'owner/repository', branch: 'main', paths: ['safe.txt'] },
    credentialId: 'github-process',
    expiresAt: now + 60_000,
    maxActions: 4,
    maxTotalBytes: 1_000_000,
    maxCostUnits: 4,
    allowedOperations: ['commit', 'inspect'],
    allowedInspectKinds: ['repository', 'branch', 'file'],
    client: { kind: 'assistant-actions-host', instanceId: 'host-process', generation: 1 },
    source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) },
    policyEpoch: 7,
    emergencyEpoch: 0,
  } satisfies ExternalGitHubGrantUnsigned)
}

function actionIntent(value: ReturnType<typeof grant>, now: number, options: { actionId?: string; content?: string; reservationId?: string } = {}): BrokerRequestIntent {
  const actionId = options.actionId ?? 'action-process'
  const payload = { expectedHeadOid: 'c'.repeat(40), headline: 'broker process action', files: [{ path: 'safe.txt', content: options.content ?? 'Authorization: Bearer should-not-dispatch' }] }
  const intent: BrokerRequestIntent = {
    actionId,
    grantId: value.id,
    grantRevision: value.revision,
    grantDigest: value.digest,
    owner: value.owner,
    sessionId: value.sessionId,
    agentId: 'agent-process',
    rootCallId: 'root-process',
    callId: `call-${actionId}`,
    operation: 'commit',
    source: value.source,
    destination: { classification: 'github-repository', repository: value.destination.repository, branch: value.destination.branch },
    payload,
    deadline: now + 30_000,
    budget: { reservationId: options.reservationId ?? `reservation-${actionId}`, actions: 1, bytes: 0, costMetric: 'github-api-units', maxCostUnits: 1 },
  }
  return { ...intent, budget: { ...intent.budget, bytes: brokerPayloadBytes(intent as never) } }
}

function actionClientOptions(paths: { actionSocket: string }, serverPublicKey: KeyObject, clientPrivateKey: KeyObject) {
  return {
    socketPath: paths.actionSocket,
    serverPublicKey,
    timeoutMs: 3_000,
    maxHelloTtlMs: 30_000,
    expectedSocketUid: uid,
    expectedSocketGid: gid,
    expectedSocketMode: 0o600,
    expectedSocketParentUid: uid,
    expectedSocketParentGid: gid,
    expectedSocketParentMode: 0o700,
    expectedBrokerPeerUid: uid,
    expectedBrokerPeerGid: gid,
    expectedServerInstanceId: 'broker-process',
    minimumServerGeneration: 1,
    clientPrivateKey,
    clientKeyId: 'client-process',
    source: { kind: 'assistant-actions-host' as const, instanceId: 'host-process', generation: 1 },
  }
}

async function waitForIpc(child: ChildProcess, event: string, timeoutMs: number, stderr: () => string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage)
      reject(new Error(`timed out waiting for fixture ${event}: ${stderr()}`))
    }, timeoutMs)
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== 'object' || (message as { event?: unknown }).event !== event) return
      clearTimeout(timer)
      child.off('message', onMessage)
      resolve(message as Record<string, unknown>)
    }
    child.on('message', onMessage)
  })
}

function requestRows(path: string): Array<{ action_id: string; status: string; dispatched_at: number | null; result_json: string | null }> {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return database.prepare('SELECT action_id,status,dispatched_at,result_json FROM requests ORDER BY action_id').all() as Array<{ action_id: string; status: string; dispatched_at: number | null; result_json: string | null }> }
  finally { database.close() }
}

async function transportCount(path: string): Promise<number> {
  if (!existsSync(path)) return 0
  const content = await readFile(path, 'utf8')
  return content.trim() ? content.trim().split('\n').length : 0
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

// These process tests require the Linux SO_PEERCRED broker backend.
describe.skipIf(process.platform !== 'linux')('assistant-actions broker process E2E', () => {
  it('serves built artifacts through real UDS, ledger, keys, protected token, status, action rejection, and stop', async () => {
    expect(process.platform).toBe('linux')
    expect(existsSync(brokerCli)).toBe(true)

    const now = Date.now()
    const { root, actionRuntime, adminRuntime, credentials, workspace } = await privateLayout()

    const serverKeys = generateKeyPairSync('ed25519')
    const clientKeys = generateKeyPairSync('ed25519')
    const adminKeys = generateKeyPairSync('ed25519')
    const paths = {
      actionSocket: join(actionRuntime, 'broker.sock'),
      adminSocket: join(adminRuntime, 'broker.sock'),
      state: join(root, 'broker.sqlite'),
      token: join(credentials, 'github.token'),
      serverPrivate: join(root, 'server-private.pem'),
      serverPublic: join(root, 'server-public.pem'),
      clientPrivate: join(root, 'client-private.pem'),
      clientPublic: join(root, 'client-public.pem'),
      adminPrivate: join(root, 'admin-private.pem'),
      adminPublic: join(root, 'admin-public.pem'),
      serveConfig: join(root, 'serve.json'),
      adminConfig: join(root, 'admin.json'),
    }
    const protectedToken = 'github_pat_process_e2e_secret_123'
    await Promise.all([
      writePrivate(paths.token, protectedToken),
      writePrivate(paths.serverPrivate, pem(serverKeys.privateKey)),
      writePrivate(paths.serverPublic, pem(serverKeys.publicKey)),
      writePrivate(paths.clientPrivate, pem(clientKeys.privateKey)),
      writePrivate(paths.clientPublic, pem(clientKeys.publicKey)),
      writePrivate(paths.adminPrivate, pem(adminKeys.privateKey)),
      writePrivate(paths.adminPublic, pem(adminKeys.publicKey)),
    ])

    const issuedGrant = grant(now, workspace)
    await writePrivate(paths.serveConfig, JSON.stringify({
      actionSocketPath: paths.actionSocket,
      adminSocketPath: paths.adminSocket,
      brokerId: 'broker-process',
      minimumBrokerGeneration: 1,
      serverPrivateKeyPath: paths.serverPrivate,
      clientKeyId: 'client-process',
      clientPublicKeyPath: paths.clientPublic,
      adminKeyId: 'admin-process',
      adminPublicKeyPath: paths.adminPublic,
      statePath: paths.state,
      expectedClientPeerUid: uid,
      expectedClientPeerGid: gid,
      expectedAdminPeerUid: uid,
      expectedAdminPeerGid: gid,
      expectedActionSocketUid: uid,
      expectedActionSocketGid: gid,
      expectedActionParentMode: 0o700,
      expectedActionSocketMode: 0o600,
      expectedAdminSocketUid: uid,
      expectedAdminSocketGid: gid,
      expectedAdminParentMode: 0o700,
      expectedAdminSocketMode: 0o600,
      maxActionConnections: 8,
      maxAdminConnections: 2,
      maxConcurrentRequests: 2,
      requestTimeoutMs: 3_000,
      helloTtlMs: 30_000,
      drainTimeoutMs: 1_000,
      credentials: [{ id: 'github-process', provider: 'linux-protected-file', path: paths.token, maxLeaseMs: 30_000 }],
      grants: [issuedGrant],
      policyEpoch: 7,
      controllerTtlMs: 5_000,
    }))
    await writePrivate(paths.adminConfig, JSON.stringify({
      adminSocketPath: paths.adminSocket,
      brokerId: 'broker-process',
      minimumBrokerGeneration: 1,
      brokerPublicKeyPath: paths.serverPublic,
      adminKeyId: 'admin-process',
      adminPrivateKeyPath: paths.adminPrivate,
      adminInstanceId: 'operator-process',
      adminGeneration: 1,
      expectedAdminSocketUid: uid,
      expectedAdminSocketGid: gid,
      expectedAdminSocketMode: 0o600,
      expectedAdminParentUid: uid,
      expectedAdminParentGid: gid,
      expectedAdminParentMode: 0o700,
      expectedBrokerPeerUid: uid,
      expectedBrokerPeerGid: gid,
      requestTimeoutMs: 3_000,
      helloTtlMs: 30_000,
    }))

    const daemon = spawn(process.execPath, [brokerCli, 'serve', paths.serveConfig], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(daemon)
    let daemonStdout = '', daemonStderr = ''
    daemon.stdout?.setEncoding('utf8')
    daemon.stderr?.setEncoding('utf8')
    daemon.stdout?.on('data', chunk => { daemonStdout += String(chunk) })
    daemon.stderr?.on('data', chunk => { daemonStderr += String(chunk) })
    await Promise.all([waitForSocket(paths.actionSocket, daemon, () => daemonStderr), waitForSocket(paths.adminSocket, daemon, () => daemonStderr)])
    expect((await lstat(paths.actionSocket)).mode & 0o7777).toBe(0o600)
    expect((await lstat(paths.adminSocket)).mode & 0o7777).toBe(0o600)

    const status = await runCli(['status', paths.adminConfig])
    expect(status).toMatchObject({ code: 0, stderr: '' })
    expect(status.stdout).not.toContain(protectedToken)
    const statusBody = JSON.parse(status.stdout) as { status: string; state: { admission: string; generation: number; controlVersion: number } }
    expect(statusBody).toMatchObject({ status: 'succeeded', state: { admission: 'accepting', generation: 1 } })

    // Same-UID SO_PEERCRED proves the kernel-bound local peer path for this test
    // process; it does not prove separation between independent Unix users.
    const action = await requestGitHubBroker(actionClientOptions(paths, serverKeys.publicKey, clientKeys.privateKey), actionIntent(issuedGrant, now))
    expect(action).toMatchObject({ status: 'failed', dispatched: false, error: { code: 'request-invalid' } })

    const database = new DatabaseSync(paths.state, { readOnly: true })
    try {
      expect(database.prepare('SELECT COUNT(*) AS count FROM requests').get()).toEqual({ count: 1 })
      expect(database.prepare('SELECT status, result_json FROM requests WHERE action_id = ?').get('action-process')).toMatchObject({ status: 'failed' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM credential_leases').get()).toEqual({ count: 0 })
    } finally { database.close() }

    const stop = await runCli(['stop', paths.adminConfig, String(statusBody.state.controlVersion), 'maintenance'])
    expect(stop).toMatchObject({ code: 0, stderr: '' })
    expect(stop.stdout).not.toContain(protectedToken)
    const stopped = JSON.parse(stop.stdout) as { status: string; state: { admission: string } }
    expect(stopped).toMatchObject({ status: 'succeeded', state: { admission: 'stopped' } })
    daemon.kill('SIGTERM')
    await expect(waitForExit(daemon, 3_000)).resolves.toMatchObject({ code: 0 })
    children.delete(daemon)

    await expect(lstat(paths.actionSocket)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(paths.adminSocket)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(daemonStdout + daemonStderr + status.stdout + status.stderr + stop.stdout + stop.stderr).not.toContain(protectedToken)
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(paths.state + suffix)) expect(await readFile(paths.state + suffix, 'utf8')).not.toContain(protectedToken)
    }
  }, 15_000)

  it('recovers a killed post-dispatch child as unknown without replaying transport', async () => {
    expect(process.platform).toBe('linux')
    expect(existsSync(brokerFixture)).toBe(true)

    const now = Date.now()
    const { root, actionRuntime, adminRuntime, credentials, workspace } = await privateLayout()
    const serverKeys = generateKeyPairSync('ed25519')
    const clientKeys = generateKeyPairSync('ed25519')
    const adminKeys = generateKeyPairSync('ed25519')
    const paths = {
      actionSocket: join(actionRuntime, 'broker.sock'),
      adminSocket: join(adminRuntime, 'broker.sock'),
      state: join(root, 'broker.sqlite'),
      transportLog: join(root, 'transport.jsonl'),
      token: join(credentials, 'github.token'),
      serverPrivate: join(root, 'server-private.pem'),
      serverPublic: join(root, 'server-public.pem'),
      clientPrivate: join(root, 'client-private.pem'),
      clientPublic: join(root, 'client-public.pem'),
      adminPrivate: join(root, 'admin-private.pem'),
      adminPublic: join(root, 'admin-public.pem'),
      fixtureConfig: join(root, 'fixture.json'),
      adminConfig: join(root, 'admin.json'),
    }
    const protectedToken = 'github_pat_process_crash_secret_123'
    await Promise.all([
      writePrivate(paths.token, protectedToken),
      writePrivate(paths.serverPrivate, pem(serverKeys.privateKey)),
      writePrivate(paths.serverPublic, pem(serverKeys.publicKey)),
      writePrivate(paths.clientPrivate, pem(clientKeys.privateKey)),
      writePrivate(paths.clientPublic, pem(clientKeys.publicKey)),
      writePrivate(paths.adminPrivate, pem(adminKeys.privateKey)),
      writePrivate(paths.adminPublic, pem(adminKeys.publicKey)),
      writePrivate(paths.transportLog, ''),
    ])

    const issuedGrant = grant(now, workspace)
    const serveConfig = {
      actionSocketPath: paths.actionSocket,
      adminSocketPath: paths.adminSocket,
      brokerId: 'broker-process',
      minimumBrokerGeneration: 1,
      serverPrivateKeyPath: paths.serverPrivate,
      clientKeyId: 'client-process',
      clientPublicKeyPath: paths.clientPublic,
      adminKeyId: 'admin-process',
      adminPublicKeyPath: paths.adminPublic,
      statePath: paths.state,
      transportLogPath: paths.transportLog,
      expectedClientPeerUid: uid,
      expectedClientPeerGid: gid,
      expectedAdminPeerUid: uid,
      expectedAdminPeerGid: gid,
      expectedActionSocketUid: uid,
      expectedActionSocketGid: gid,
      expectedActionParentMode: 0o700,
      expectedActionSocketMode: 0o600,
      expectedAdminSocketUid: uid,
      expectedAdminSocketGid: gid,
      expectedAdminParentMode: 0o700,
      expectedAdminSocketMode: 0o600,
      maxActionConnections: 8,
      maxAdminConnections: 2,
      maxConcurrentRequests: 2,
      requestTimeoutMs: 3_000,
      helloTtlMs: 30_000,
      drainTimeoutMs: 1_000,
      credentials: [{ id: 'github-process', provider: 'linux-protected-file', path: paths.token, maxLeaseMs: 30_000 }],
      grants: [issuedGrant],
      policyEpoch: 7,
      controllerTtlMs: 1_000,
    }
    await writePrivate(paths.fixtureConfig, JSON.stringify(serveConfig))
    await writePrivate(paths.adminConfig, JSON.stringify({
      adminSocketPath: paths.adminSocket,
      brokerId: 'broker-process',
      minimumBrokerGeneration: 1,
      brokerPublicKeyPath: paths.serverPublic,
      adminKeyId: 'admin-process',
      adminPrivateKeyPath: paths.adminPrivate,
      adminInstanceId: 'operator-process',
      adminGeneration: 1,
      expectedAdminSocketUid: uid,
      expectedAdminSocketGid: gid,
      expectedAdminSocketMode: 0o600,
      expectedAdminParentUid: uid,
      expectedAdminParentGid: gid,
      expectedAdminParentMode: 0o700,
      expectedBrokerPeerUid: uid,
      expectedBrokerPeerGid: gid,
      requestTimeoutMs: 3_000,
      helloTtlMs: 30_000,
    }))

    const startFixture = async (): Promise<{ child: ChildProcess; output: () => string }> => {
      const child = spawn(process.execPath, [brokerFixture, paths.fixtureConfig], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      children.add(child)
      let stdout = '', stderr = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      await waitForIpc(child, 'ready', 5_000, () => stderr)
      await Promise.all([waitForSocket(paths.actionSocket, child, () => stderr), waitForSocket(paths.adminSocket, child, () => stderr)])
      return { child, output: () => stdout + stderr }
    }

    const first = await startFixture()
    const firstRequest = requestGitHubBroker(actionClientOptions(paths, serverKeys.publicKey, clientKeys.privateKey), actionIntent(issuedGrant, now, { actionId: 'crash-action', content: 'safe commit content', reservationId: 'crash-reservation' })).catch((error: unknown) => error)
    await waitForIpc(first.child, 'dispatch', 5_000, first.output)
    expect(await transportCount(paths.transportLog)).toBe(1)
    expect(requestRows(paths.state)).toEqual([expect.objectContaining({ action_id: 'crash-action', status: 'dispatched' })])
    first.child.kill('SIGKILL')
    await expect(waitForExit(first.child, 3_000)).resolves.toMatchObject({ signal: 'SIGKILL' })
    children.delete(first.child)
    await expect(firstRequest).resolves.toMatchObject({ dispatchState: 'post-dispatch-unknown' })
    expect(first.output()).not.toContain(protectedToken)
    await delay(1_100)

    const second = await startFixture()
    const replay = await requestGitHubBroker(actionClientOptions(paths, serverKeys.publicKey, clientKeys.privateKey), actionIntent(issuedGrant, now, { actionId: 'crash-action', content: 'safe commit content', reservationId: 'crash-reservation' }))
    expect(replay).toMatchObject({ status: 'unknown', dispatched: true, error: { code: 'restart-after-dispatch' } })
    expect(await transportCount(paths.transportLog)).toBe(1)
    const status = await runCli(['status', paths.adminConfig])
    expect(status).toMatchObject({ code: 0, stderr: '' })
    const statusBody = JSON.parse(status.stdout) as { state: { controlVersion: number } }
    const stop = await runCli(['stop', paths.adminConfig, String(statusBody.state.controlVersion), 'maintenance'])
    expect(stop).toMatchObject({ code: 0, stderr: '' })
    await expect(waitForExit(second.child, 3_000)).resolves.toMatchObject({ code: 0 })
    children.delete(second.child)

    await expect(lstat(paths.actionSocket)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(paths.adminSocket)).rejects.toMatchObject({ code: 'ENOENT' })
    const logs = first.output() + second.output() + status.stdout + status.stderr + stop.stdout + stop.stderr
    expect(logs).not.toContain(protectedToken)
    for (const row of requestRows(paths.state)) expect(row.result_json ?? '').not.toContain(protectedToken)
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(paths.state + suffix)) expect(await readFile(paths.state + suffix, 'utf8')).not.toContain(protectedToken)
    }
  }, 15_000)
})
