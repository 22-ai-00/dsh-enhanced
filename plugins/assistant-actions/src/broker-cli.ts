#!/usr/bin/env node
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'
import { requestGitHubBrokerAdmin } from './broker-client.js'
import { createExternalBrokerCore, normalizeExternalBrokerCoreConfig, type BrokerProtectedFileCredential } from './broker-core.js'
import type { ExternalGitHubGrant } from './broker-ledger.js'
import { inspectLinuxPeerCredentials, linuxPeerCredentialsAvailable } from './broker-peer-linux.js'
import type { BrokerAdminIntent, BrokerAdminResponse } from './broker-protocol.js'
import { startGitHubBrokerServer, type BrokerPeerCredentialInspector, type GitHubBrokerCorePort, type GitHubBrokerServerOptions } from './broker-server.js'

const DIGEST = /^[0-9a-f]{64}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const STOP_REASONS = new Set(['operator-request', 'security-response', 'maintenance'])
const REVOKE_REASONS = new Set(['operator-request', 'security-response', 'grant-replaced', 'grant-expired'])
const FAILURE = 'assistant-actions broker: command failed or invalid arguments\n'

export interface BrokerCliConfig {
  adminSocketPath: string
  brokerId: string
  minimumBrokerGeneration: number
  brokerPublicKeyPath: string
  adminKeyId: string
  adminPrivateKeyPath: string
  adminInstanceId: string
  adminGeneration: number
  expectedAdminSocketUid: number
  expectedAdminSocketGid: number
  expectedAdminSocketMode: number
  expectedAdminParentUid: number
  expectedAdminParentGid: number
  expectedAdminParentMode: number
  expectedBrokerPeerUid: number
  expectedBrokerPeerGid: number
  requestTimeoutMs: number
  helloTtlMs: number
}

export interface BrokerServeConfig {
  actionSocketPath: string
  adminSocketPath: string
  brokerId: string
  minimumBrokerGeneration: number
  serverPrivateKeyPath: string
  clientKeyId: string
  clientPublicKeyPath: string
  adminKeyId: string
  adminPublicKeyPath: string
  statePath: string
  expectedClientPeerUid: number
  expectedClientPeerGid: number
  expectedAdminPeerUid: number
  expectedAdminPeerGid: number
  expectedActionSocketUid: number
  expectedActionSocketGid: number
  expectedActionParentMode: number
  expectedActionSocketMode: number
  expectedAdminSocketUid: number
  expectedAdminSocketGid: number
  expectedAdminParentMode: number
  expectedAdminSocketMode: number
  maxActionConnections: number
  maxAdminConnections: number
  maxConcurrentRequests: number
  requestTimeoutMs: number
  helloTtlMs: number
  drainTimeoutMs: number
  credentials: readonly BrokerProtectedFileCredential[]
  grants: readonly ExternalGitHubGrant[]
  policyEpoch: number
  controllerTtlMs?: number
  credentialMaxBytes?: number
}

export interface BrokerCliDependencies {
  createCore?(config: BrokerServeConfig): Promise<GitHubBrokerCorePort> | GitHubBrokerCorePort
  peerInspector?: BrokerPeerCredentialInspector
  peerCredentialsAvailable?: () => boolean
  onServerReady?(options: GitHubBrokerServerOptions): void
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  stderr?: Pick<NodeJS.WriteStream, 'write'>
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
function canonicalPath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value !== '/' && !value.includes('\0')
}
function exact(input: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  if (Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(input, key))) throw new Error('invalid config')
}

async function privateFile(path: string, mode = 0o600, maximumBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const currentUid = BigInt(process.getuid?.() ?? -1), currentGid = BigInt(process.getgid?.() ?? -1), parentPath = resolve(path, '..')
  await safeAncestorChain(parentPath, Number(currentUid), Number(currentGid), true)
  const [canonicalParent, parent] = await Promise.all([realpath(parentPath), lstat(parentPath, { bigint: true })])
  if (canonicalParent !== parentPath || parent.isSymbolicLink() || !parent.isDirectory() || parent.uid !== currentUid || parent.gid !== currentGid || Number(parent.mode & 0o077n) !== 0) throw new Error('unsafe private file parent')
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await descriptor.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes) || Number(before.mode & 0o7777n) !== mode || before.uid !== currentUid || before.gid !== currentGid) throw new Error('unsafe private file')
    const value = await descriptor.readFile()
    const [after, linked] = await Promise.all([descriptor.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || after.dev !== linked.dev || after.ino !== linked.ino || linked.isSymbolicLink()) throw new Error('private file changed')
    return value
  } finally { await descriptor.close() }
}

async function safeAncestorChain(path: string, expectedLeafUid: number, expectedLeafGid: number, privateLeaf: boolean): Promise<void> {
  let cursor = path, leaf = true
  for (;;) {
    const [canonical, stat] = await Promise.all([realpath(cursor), lstat(cursor, { bigint: true })])
    const mode = Number(stat.mode & 0o7777n), uid = Number(stat.uid), gid = Number(stat.gid)
    const stickyRoot = uid === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
    if (canonical !== cursor || stat.isSymbolicLink() || !stat.isDirectory() || !stickyRoot && (mode & 0o022) !== 0
      || leaf && privateLeaf && (uid !== expectedLeafUid || gid !== expectedLeafGid || (mode & 0o077) !== 0)) throw new Error('unsafe path ancestry')
    const parent = dirname(cursor)
    if (parent === cursor) return
    cursor = parent; leaf = false
  }
}

function normalizedConfig(value: unknown, serve: boolean): BrokerCliConfig | BrokerServeConfig {
  if (!plain(value)) throw new Error('invalid config')
  const operator = ['adminSocketPath', 'brokerId', 'minimumBrokerGeneration', 'brokerPublicKeyPath', 'adminKeyId', 'adminPrivateKeyPath', 'adminInstanceId', 'adminGeneration', 'expectedAdminSocketUid', 'expectedAdminSocketGid', 'expectedAdminSocketMode', 'expectedAdminParentUid', 'expectedAdminParentGid', 'expectedAdminParentMode', 'expectedBrokerPeerUid', 'expectedBrokerPeerGid', 'requestTimeoutMs', 'helloTtlMs'] as const
  const daemon = ['actionSocketPath', 'adminSocketPath', 'brokerId', 'minimumBrokerGeneration', 'serverPrivateKeyPath', 'clientKeyId', 'clientPublicKeyPath', 'adminKeyId', 'adminPublicKeyPath', 'statePath', 'expectedClientPeerUid', 'expectedClientPeerGid', 'expectedAdminPeerUid', 'expectedAdminPeerGid', 'expectedActionSocketUid', 'expectedActionSocketGid', 'expectedActionParentMode', 'expectedActionSocketMode', 'expectedAdminSocketUid', 'expectedAdminSocketGid', 'expectedAdminParentMode', 'expectedAdminSocketMode', 'maxActionConnections', 'maxAdminConnections', 'maxConcurrentRequests', 'requestTimeoutMs', 'helloTtlMs', 'drainTimeoutMs', 'credentials', 'grants', 'policyEpoch', 'controllerTtlMs', 'credentialMaxBytes'] as const
  exact(value, serve ? daemon : operator, serve ? daemon.filter(key => key !== 'controllerTtlMs' && key !== 'credentialMaxBytes') : operator)
  if (!IDENTIFIER.test(String(value.brokerId)) || !integer(value.minimumBrokerGeneration, 1) || !integer(value.requestTimeoutMs, 1, 300_000) || !integer(value.helloTtlMs, 1, 300_000)) throw new Error('invalid config')
  if (!serve && (!canonicalPath(value.adminSocketPath) || Buffer.byteLength(value.adminSocketPath) > 100 || !canonicalPath(value.brokerPublicKeyPath)
    || !IDENTIFIER.test(String(value.adminKeyId)) || !canonicalPath(value.adminPrivateKeyPath) || !IDENTIFIER.test(String(value.adminInstanceId)) || !integer(value.adminGeneration, 1)
    || !integer(value.expectedAdminSocketUid, 0, 0x7fffffff) || !integer(value.expectedAdminSocketGid, 0, 0x7fffffff) || !integer(value.expectedAdminSocketMode, 0, 0o777)
    || !integer(value.expectedAdminParentUid, 0, 0x7fffffff) || !integer(value.expectedAdminParentGid, 0, 0x7fffffff) || !integer(value.expectedAdminParentMode, 0, 0o777)
    || !integer(value.expectedBrokerPeerUid, 0, 0x7fffffff) || !integer(value.expectedBrokerPeerGid, 0, 0x7fffffff))) throw new Error('invalid operator config')
  if (serve && (!canonicalPath(value.serverPrivateKeyPath) || !IDENTIFIER.test(String(value.clientKeyId)) || !canonicalPath(value.clientPublicKeyPath) || !canonicalPath(value.adminPublicKeyPath)
    || !IDENTIFIER.test(String(value.adminKeyId)) || value.clientKeyId === value.adminKeyId || value.clientPublicKeyPath === value.adminPublicKeyPath
    || value.serverPrivateKeyPath === value.clientPublicKeyPath || value.serverPrivateKeyPath === value.adminPublicKeyPath
    || !canonicalPath(value.actionSocketPath) || !canonicalPath(value.adminSocketPath) || value.actionSocketPath === value.adminSocketPath || Buffer.byteLength(value.actionSocketPath) > 100 || Buffer.byteLength(value.adminSocketPath) > 100
    || !canonicalPath(value.statePath) || !integer(value.expectedClientPeerUid, 0, 0x7fffffff) || !integer(value.expectedClientPeerGid, 0, 0x7fffffff)
    || !integer(value.expectedAdminPeerUid, 0, 0x7fffffff) || !integer(value.expectedAdminPeerGid, 0, 0x7fffffff)
    || !integer(value.expectedActionSocketUid, 0, 0x7fffffff) || !integer(value.expectedActionSocketGid, 0, 0x7fffffff) || !integer(value.expectedActionParentMode, 0, 0o777) || !integer(value.expectedActionSocketMode, 0, 0o777)
    || !integer(value.expectedAdminSocketUid, 0, 0x7fffffff) || !integer(value.expectedAdminSocketGid, 0, 0x7fffffff) || !integer(value.expectedAdminParentMode, 0, 0o777) || !integer(value.expectedAdminSocketMode, 0, 0o777)
    || !integer(value.maxActionConnections, 1, 1_024) || !integer(value.maxAdminConnections, 1, 64) || !integer(value.maxConcurrentRequests, 1, value.maxActionConnections as number)
    || !integer(value.drainTimeoutMs, 1, 300_000) || !Array.isArray(value.credentials) || !Array.isArray(value.grants) || !integer(value.policyEpoch, 0)
    || value.controllerTtlMs !== undefined && !integer(value.controllerTtlMs, 1_000, 300_000)
    || value.credentialMaxBytes !== undefined && !integer(value.credentialMaxBytes, 1, 65_536))) throw new Error('invalid serve config')
  return Object.freeze({ ...value }) as unknown as BrokerCliConfig | BrokerServeConfig
}

export async function loadBrokerCliConfig(path: string, serve = false): Promise<BrokerCliConfig | BrokerServeConfig> {
  if (!canonicalPath(path)) throw new Error('invalid config path')
  const bytes = await privateFile(path)
  const source = bytes.toString('utf8')
  if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('invalid config UTF-8')
  let parsed: unknown
  try { parsed = JSON.parse(source) as unknown } catch { throw new Error('invalid config JSON') }
  return normalizedConfig(parsed, serve)
}

function positive(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) throw new Error('positive integer required')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('positive integer required')
  return result
}
function epoch(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error('non-negative integer required')
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('non-negative integer required')
  return result
}

function adminIntent(command: string, args: readonly string[], now: number, timeoutMs: number): BrokerAdminIntent {
  const deadline = now + timeoutMs
  if (!Number.isSafeInteger(deadline)) throw new Error('deadline overflow')
  if (command === 'status' && args.length === 0) return { operation: 'status', body: {}, deadline }
  if (command === 'stop' && (args.length === 1 || args.length === 2)) {
    const reason = args[1] ?? 'operator-request'
    if (!STOP_REASONS.has(reason)) throw new Error('invalid stop reason')
    return { operation: 'stop', body: { expectedControlVersion: epoch(args[0]), drainDeadline: deadline, reason: reason as 'operator-request' | 'security-response' | 'maintenance' }, deadline }
  }
  if (command === 'resume' && args.length === 2) return { operation: 'resume', body: { expectedControlVersion: epoch(args[0]), expectedGeneration: positive(args[1]) }, deadline }
  if (command === 'revoke' && (args.length === 6 || args.length === 7)) {
    const reason = args[6] ?? 'operator-request'
    if (!IDENTIFIER.test(args[1] ?? '') || !DIGEST.test(args[3] ?? '') || !REVOKE_REASONS.has(reason)) throw new Error('invalid revoke arguments')
    return { operation: 'revoke', body: { expectedControlVersion: epoch(args[0]), grantId: args[1]!, grantRevision: positive(args[2]), grantDigest: args[3]!, policyEpoch: epoch(args[4]), emergencyEpoch: epoch(args[5]), reason: reason as 'operator-request' | 'security-response' | 'grant-replaced' | 'grant-expired' }, deadline }
  }
  throw new Error('invalid command')
}

async function key(path: string, kind: 'private' | 'public'): Promise<KeyObject> {
  const bytes = await privateFile(path)
  try {
    const result = kind === 'private' ? createPrivateKey(bytes) : createPublicKey(bytes)
    if (result.type !== kind || result.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required')
    return result
  } finally { bytes.fill(0) }
}

function safeOutput(response: BrokerAdminResponse): string {
  return JSON.stringify({ status: response.status, state: response.state, ...(response.error === null ? {} : { error: response.error }) }) + '\n'
}

async function admin(command: string, config: BrokerCliConfig, args: readonly string[]): Promise<BrokerAdminResponse> {
  if (!config.adminPrivateKeyPath || !config.adminKeyId || !config.adminInstanceId || !config.adminGeneration) throw new Error('operator credentials required')
  const [serverPublicKey, adminPrivateKey] = await Promise.all([key(config.brokerPublicKeyPath, 'public'), key(config.adminPrivateKeyPath, 'private')])
  const intent = adminIntent(command, args, Date.now(), config.requestTimeoutMs)
  return await requestGitHubBrokerAdmin({
    socketPath: config.adminSocketPath, serverPublicKey, timeoutMs: config.requestTimeoutMs, maxHelloTtlMs: config.helloTtlMs, expectedSocketUid: config.expectedAdminSocketUid, expectedSocketGid: config.expectedAdminSocketGid,
    expectedSocketMode: config.expectedAdminSocketMode, expectedSocketParentUid: config.expectedAdminParentUid, expectedSocketParentGid: config.expectedAdminParentGid, expectedSocketParentMode: config.expectedAdminParentMode,
    inspectPeerCredentials: inspectLinuxPeerCredentials, expectedBrokerPeerUid: config.expectedBrokerPeerUid, expectedBrokerPeerGid: config.expectedBrokerPeerGid,
    expectedServerInstanceId: config.brokerId, minimumServerGeneration: config.minimumBrokerGeneration,
  }, intent, { kind: 'assistant-actions-admin', instanceId: config.adminInstanceId, generation: config.adminGeneration }, config.adminKeyId, adminPrivateKey)
}

function productionCore(config: BrokerServeConfig): GitHubBrokerCorePort {
  return createExternalBrokerCore(normalizeExternalBrokerCoreConfig({ instanceId: config.brokerId, statePath: config.statePath, credentials: config.credentials, grants: config.grants, policyEpoch: config.policyEpoch,
    ...(config.controllerTtlMs === undefined ? {} : { controllerTtlMs: config.controllerTtlMs }),
    ...(config.credentialMaxBytes === undefined ? {} : { credentialMaxBytes: config.credentialMaxBytes }) }))
}

async function serve(config: BrokerServeConfig, dependencies: BrokerCliDependencies): Promise<void> {
  const createCore = dependencies.createCore ?? productionCore
  const available = dependencies.peerCredentialsAvailable?.() ?? (dependencies.peerInspector === undefined && linuxPeerCredentialsAvailable())
  if (!available && dependencies.peerInspector === undefined) throw new Error('Linux peer credentials unavailable')
  const peer = dependencies.peerInspector ?? inspectLinuxPeerCredentials
  const [serverPrivateKey, clientPublicKey, adminPublicKey] = await Promise.all([key(config.serverPrivateKeyPath, 'private'), key(config.clientPublicKeyPath, 'public'), key(config.adminPublicKeyPath, 'public')])
  const serverPublicKey = createPublicKey(serverPrivateKey)
  if (config.clientKeyId === config.adminKeyId || serverPublicKey.equals(clientPublicKey) || serverPublicKey.equals(adminPublicKey) || clientPublicKey.equals(adminPublicKey)) throw new Error('broker signing keys must be distinct')
  const core = await createCore(config)
  let server
  try {
    const generation = core.snapshot().generation
    if (!integer(generation, config.minimumBrokerGeneration, Number.MAX_SAFE_INTEGER)) throw new Error('broker generation regressed')
    const options: GitHubBrokerServerOptions = {
      actionSocketPath: config.actionSocketPath, adminSocketPath: config.adminSocketPath, instanceId: config.brokerId, generation, serverPrivateKey, clientPublicKey, clientKeyId: config.clientKeyId,
      adminPublicKey, adminKeyId: config.adminKeyId, core, inspectPeerCredentials: peer,
      expectedClientPeerUid: config.expectedClientPeerUid, expectedClientPeerGid: config.expectedClientPeerGid, expectedAdminPeerUid: config.expectedAdminPeerUid, expectedAdminPeerGid: config.expectedAdminPeerGid,
      expectedActionSocketUid: config.expectedActionSocketUid, expectedActionSocketGid: config.expectedActionSocketGid, expectedActionParentMode: config.expectedActionParentMode, expectedActionSocketMode: config.expectedActionSocketMode,
      expectedAdminSocketUid: config.expectedAdminSocketUid, expectedAdminSocketGid: config.expectedAdminSocketGid, expectedAdminParentMode: config.expectedAdminParentMode, expectedAdminSocketMode: config.expectedAdminSocketMode,
      maxActionConnections: config.maxActionConnections, maxAdminConnections: config.maxAdminConnections, maxConcurrentRequests: config.maxConcurrentRequests,
      firstByteTimeoutMs: Math.min(2_000, config.requestTimeoutMs), frameTimeoutMs: Math.min(10_000, config.requestTimeoutMs),
      totalTimeoutMs: config.requestTimeoutMs, helloTtlMs: config.helloTtlMs, drainTimeoutMs: config.drainTimeoutMs,
    }
    dependencies.onServerReady?.(options)
    server = await startGitHubBrokerServer(options)
  } catch (error) { await Promise.resolve(core.close()).catch(() => undefined); throw error }
  await new Promise<void>((resolveServe, rejectServe) => {
    let stopping = false
    const removeSignals = (): void => { process.off('SIGTERM', onTerm); process.off('SIGINT', onInterrupt) }
    const stop = (reason: 'sigterm' | 'sigint'): void => {
      if (stopping) return
      stopping = true
      removeSignals()
      void server.stop(reason).then(resolveServe, rejectServe)
    }
    const onTerm = (): void => stop('sigterm')
    const onInterrupt = (): void => stop('sigint')
    process.once('SIGTERM', onTerm)
    process.once('SIGINT', onInterrupt)
  })
}

export async function runBrokerCli(argv: readonly string[], dependencies: BrokerCliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout, stderr = dependencies.stderr ?? process.stderr
  try {
    const [command, configPath, ...args] = argv
    if (!command || !configPath || !['serve', 'status', 'stop', 'resume', 'revoke'].includes(command)) throw new Error('invalid command')
    const config = await loadBrokerCliConfig(configPath, command === 'serve')
    if (command === 'serve') { if (args.length !== 0) throw new Error('invalid arguments'); await serve(config as BrokerServeConfig, dependencies); return 0 }
    const response = await admin(command, config as BrokerCliConfig, args)
    stdout.write(safeOutput(response))
    return response.status === 'succeeded' ? 0 : 1
  } catch { stderr.write(FAILURE); return 1 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBrokerCli(process.argv.slice(2))
}
