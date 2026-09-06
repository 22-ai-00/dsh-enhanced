import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { parseHostAttestationReceipt } from './attestation.js'
import { ControlPlaneStore, ControlPlaneStoreError } from './store.js'
import { inheritedHostAttestorEnvironment, openTrustedExecutable, verifyOpenTrustedExecutable,
  type OpenTrustedExecutable, type PluginControlTrustConfig } from './trust.js'
import type {
  HostAttestationOperation,
  HostAttestationPhase,
  HostAttestationPolicy,
  HostAttestationReceipt,
  HostAttestationRequest,
  HostAttestationRequirements,
  PluginActivationPlan,
} from './types.js'

export type HostAttestorErrorCode = 'NOT_CONFIGURED' | 'EXECUTABLE_CHANGED' | 'FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT' | 'VERSION_MISMATCH'

export class HostAttestorError extends Error {
  constructor(readonly code: HostAttestorErrorCode, message: string) {
    super(`plugin-control-plane host-attestor[${code}]: ${message}`)
    this.name = 'HostAttestorError'
  }
}

export function hostRequirements(policy: HostAttestationPolicy, phase: HostAttestationPhase,
  previousHostGeneration: number): HostAttestationRequirements {
  if (phase === 'reload') return { kind: phase, previousHostGeneration }
  if (phase === 'readiness') return { kind: phase, minimumChecks: policy.readinessMinimumChecks }
  if (phase === 'effect-blocked-replay') return { kind: phase,
    minimumDeliveryAttempts: policy.effectBlockedMinimumDeliveryAttempts,
    minimumToolExecutionAttempts: policy.effectBlockedMinimumToolExecutionAttempts, maximumExternalEffects: 0 }
  if (phase === 'shadow') return { kind: phase, minimumSamples: policy.shadowMinimumSamples,
    maximumMismatches: policy.shadowMaximumMismatches, maximumExternalEffects: 0 }
  if (phase === 'canary') return { kind: phase, maximumExposures: 1,
    minimumSamples: policy.canaryMinimumSamples, maximumFailures: policy.canaryMaximumFailures }
  if (phase === 'soak') return { kind: phase, minimumWindowMs: policy.soakMinimumWindowMs,
    minimumSamples: policy.soakMinimumSamples, maximumFailureRate: policy.soakMaximumFailureRate }
  return { kind: phase, minimumChecks: policy.healthMinimumChecks, maximumFailures: policy.healthMaximumFailures }
}

function expectedPhase(plan: PluginActivationPlan): HostAttestationPhase {
  const status = plan.status.startsWith('awaiting-') ? plan.status.slice('awaiting-'.length) : ''
  if (!['reload', 'readiness', 'effect-blocked-replay', 'shadow', 'canary', 'soak', 'health'].includes(status)) {
    throw new HostAttestorError('FAILED', 'plan is not awaiting a Host phase')
  }
  return status as HostAttestationPhase
}

function prepare(store: ControlPlaneStore, plan: PluginActivationPlan, trust: PluginControlTrustConfig,
  issuer: HostAttestationRequest['issuer']): HostAttestationOperation {
  const phase = expectedPhase(plan)
  return store.prepareHostAttestationOperation({ planId: plan.id, expectedRevision: plan.revision,
    expectedFence: plan.activation!.fence, issuer,
    requirements: hostRequirements(trust.hostPolicy, phase, store.latestHostGeneration(plan.installationId)),
    receiptTtlMs: trust.hostPolicy.receiptTtlMs })
}

export function prepareManualHostAttestation(store: ControlPlaneStore, plan: PluginActivationPlan,
  trust: PluginControlTrustConfig): HostAttestationOperation {
  return prepare(store, plan, trust, { mode: 'owner-manual' })
}

export function prepareConfiguredHostAttestation(store: ControlPlaneStore, plan: PluginActivationPlan,
  trust: PluginControlTrustConfig): HostAttestationOperation {
  const attestor = trust.hostAttestor
  if (attestor === undefined) throw new HostAttestorError('NOT_CONFIGURED', 'no owner-configured Host attestor is registered')
  return prepare(store, plan, trust, { mode: 'configured-executable', id: attestor.id, version: attestor.version,
    path: attestor.path, sha256: attestor.sha256, interpreter: attestor.interpreter,
    authority: attestor.authority, keyId: attestor.keyId })
}

async function execute(executable: OpenTrustedExecutable, interpreter: OpenTrustedExecutable | undefined,
  args: readonly string[], environment: NodeJS.ProcessEnv,
  timeoutMs: number, input: string | undefined, maximumOutput: number): Promise<string> {
  if (process.platform !== 'linux') throw new HostAttestorError('FAILED', 'descriptor-pinned Host attestors require Linux')
  try { await realpath('/proc/self/fd') } catch {
    throw new HostAttestorError('FAILED', 'descriptor-pinned Host attestors require /proc/self/fd')
  }
  return new Promise((resolve, reject) => {
    const command = interpreter === undefined ? '/proc/self/fd/3' : '/proc/self/fd/4'
    const commandArguments = interpreter === undefined ? [...args] : ['/proc/self/fd/3', ...args]
    const stdio: Array<'pipe' | 'ignore' | number> = ['pipe', 'pipe', 'ignore', executable.handle.fd]
    if (interpreter !== undefined) stdio.push(interpreter.handle.fd)
    const child = spawn(command, commandArguments, { env: environment, shell: false, stdio })
    const chunks: Buffer[] = []; let bytes = 0; let timedOut = false; let outputLimit = false; let settled = false
    const fail = (error: Error): void => { if (!settled) { settled = true; reject(error) } }
    child.stdout!.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > maximumOutput) { outputLimit = true; child.kill('SIGKILL') } else chunks.push(chunk)
    })
    child.once('error', () => fail(new HostAttestorError('FAILED', 'registered Host attestor could not start')))
    child.once('close', code => {
      if (settled) return
      settled = true
      if (timedOut) reject(new HostAttestorError('TIMEOUT', 'registered Host attestor exceeded its deadline'))
      else if (outputLimit) reject(new HostAttestorError('OUTPUT_LIMIT', 'registered Host attestor exceeded its output bound'))
      else if (code !== 0) reject(new HostAttestorError('FAILED', 'registered Host attestor returned a non-zero status'))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.once('close', () => clearTimeout(timer))
    child.stdin!.on('error', () => { /* early exit is classified by error/close */ })
    if (input === undefined) child.stdin!.end()
    else child.stdin!.end(input, 'utf8')
  })
}

export async function invokeConfiguredHostAttestor(trust: PluginControlTrustConfig,
  request: HostAttestationRequest): Promise<HostAttestationReceipt> {
  const attestor = trust.hostAttestor
  if (attestor === undefined) throw new HostAttestorError('NOT_CONFIGURED', 'no owner-configured Host attestor is registered')
  if (request.issuer.mode !== 'configured-executable' || request.issuer.id !== attestor.id
    || request.issuer.version !== attestor.version || request.issuer.path !== attestor.path
    || request.issuer.sha256 !== attestor.sha256 || request.issuer.authority !== attestor.authority
    || JSON.stringify(request.issuer.interpreter) !== JSON.stringify(attestor.interpreter)
    || request.issuer.keyId !== attestor.keyId) throw new HostAttestorError('FAILED', 'durable request is not bound to the configured Host attestor')
  let executable: OpenTrustedExecutable | undefined
  let interpreter: OpenTrustedExecutable | undefined
  try {
    executable = await openTrustedExecutable(attestor.path, attestor.sha256)
    interpreter = attestor.interpreter === null ? undefined
      : await openTrustedExecutable(attestor.interpreter.path, attestor.interpreter.sha256)
    const environment = inheritedHostAttestorEnvironment(trust)
    const version = (await execute(executable, interpreter, ['--version'], environment, attestor.timeoutMs, undefined, 1_024)).trim()
    if (version !== attestor.version) throw new HostAttestorError('VERSION_MISMATCH', 'registered Host attestor reported a different version')
    const receiptSource = await execute(executable, interpreter, ['attest'], environment, attestor.timeoutMs, `${JSON.stringify(request)}\n`, 65_536)
    await verifyOpenTrustedExecutable(executable)
    if (interpreter !== undefined) await verifyOpenTrustedExecutable(interpreter)
    let parsed: unknown
    try { parsed = JSON.parse(receiptSource) as unknown } catch { throw new HostAttestorError('FAILED', 'registered Host attestor did not return one JSON receipt') }
    return parseHostAttestationReceipt(parsed)
  } catch (error) {
    if (error instanceof HostAttestorError || error instanceof ControlPlaneStoreError) throw error
    throw new HostAttestorError('EXECUTABLE_CHANGED', 'registered Host attestor descriptor identity could not be retained')
  } finally {
    try { await interpreter?.handle.close() }
    finally { await executable?.handle.close() }
  }
}
