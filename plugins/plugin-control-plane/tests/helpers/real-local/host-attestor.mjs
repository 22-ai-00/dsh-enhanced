#!/usr/bin/env node
// TEST-ONLY Host attestor for D3a-0b. It never ships in a production profile.
// It starts/stops a real `dsh --profile` process and samples real Loader/Include
// fibers through the shipped runtime observer before signing a schema-2 receipt
// with a disposable test key.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const CONFIG_ENV = 'DSH_REAL_LOCAL_HOST_ATTESTOR_CONFIG'
const configPath = process.env[CONFIG_ENV]
if (!configPath) throw new Error('test host attestor: configuration is missing')
const config = JSON.parse(readFileSync(configPath, 'utf8'))
const sha = value => createHash('sha256').update(value).digest('hex')

async function modules() {
  const attestation = await import(pathToFileURL(config.attestationModule).href)
  const observer = await import(pathToFileURL(config.observerModule).href)
  return { attestation, observer }
}
function state() {
  try { return JSON.parse(readFileSync(config.statePath, 'utf8')) } catch { return { pid: 0, generation: 0 } }
}
function saveState(value) { mkdirSync(dirname(config.statePath), { recursive: true, mode: 0o700 }); writeFileSync(config.statePath, JSON.stringify(value), { mode: 0o600 }) }
async function stop() {
  const current = state()
  if (current.pid > 0) {
    try { process.kill(current.pid, 'SIGTERM') } catch {}
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try { process.kill(current.pid, 0) } catch { break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    try { process.kill(current.pid, 'SIGKILL') } catch {}
    saveState({ pid: 0, generation: current.generation })
  }
}
async function start() {
  const prior = state()
  await stop()
  const child = spawn(config.node, [config.dsh, '--profile', config.profile, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: config.home, detached: true, stdio: 'ignore',
    env: { ...process.env, DSH_HOME: config.home, HOME: config.home, DSH_TELEMETRY_DISABLED: '1' } })
  child.unref()
  saveState({ pid: child.pid ?? 0, generation: prior.generation + 1 })
  await waitObserver()
  return prior.generation + 1
}
async function waitObserver() {
  const { observer } = await modules()
  const deadline = Date.now() + 60_000
  let last
  while (Date.now() < deadline) {
    try { return await observer.queryRuntimeObserver({ socketPath: config.observer.socketPath, keyPath: config.observer.keyPath, signal: AbortSignal.timeout(2_000) }) }
    catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 200)) }
  }
  throw new Error('test host attestor: observer never became ready: ' + String(last))
}
function receipt(request, evidence, outcome, hostGeneration) {
  const unsigned = { schemaVersion: 2, receiptId: 'receipt:' + request.operationId, authority: config.authority, keyId: config.keyId,
    installationId: request.installationId, planId: request.plan.id, planDigest: request.plan.digest,
    activationId: request.activation.id, fence: request.activation.fence, operationId: request.operationId,
    requestDigest: null, phase: request.phase, outcome, hostGeneration, evidence, evidenceDigest: null,
    observedAt: Date.now(), expiresAt: Date.now() + request.receiptTtlMs }
  return unsigned
}
async function attest(request) {
  const key = createPrivateKey(readFileSync(config.hostKeyPath, 'utf8'))
  const current = state()
  if (request.phase === 'reload') {
    const generation = await start()
    const { attestation } = await modules()
    const evidence = { kind: 'reload', reloaded: true, previousHostGeneration: request.requirements.previousHostGeneration,
      currentHostGeneration: generation, probeDigest: sha('reload:' + generation) }
    const unsigned = receipt(request, evidence, 'passed', generation)
    unsigned.requestDigest = attestation.hostAttestationRequestDigest(request)
    unsigned.evidenceDigest = attestation.hostAttestationEvidenceDigest(evidence)
    return { ...unsigned, signature: sign(null, Buffer.from(attestation.hostAttestationSigningPayload(unsigned)), key).toString('base64') }
  }
  if (request.phase === 'readiness') {
    const sample = await waitObserver()
    let failures = 0
    for (const target of config.observer.targets) {
      const entry = sample.entries.find(item => item.entryId === target.entryId)
      if (!entry || entry.module !== target.module || entry.configDigest !== target.configDigest
        || JSON.stringify(entry.services.map(item => item.name).sort()) !== JSON.stringify([...target.services].sort())
        || (config.tamper === true && target.entryId === config.tamperEntryId)
        || entry.active !== true || [...entry.dependencies, ...entry.services].some(item => !item.instance)) failures += 1
    }
    const { attestation } = await modules()
    const evidence = { kind: 'readiness', checks: 1, failures, probeDigest: sha(JSON.stringify(sample)) }
    const unsigned = receipt(request, evidence, failures === 0 ? 'passed' : 'failed', current.generation)
    unsigned.requestDigest = attestation.hostAttestationRequestDigest(request)
    unsigned.evidenceDigest = attestation.hostAttestationEvidenceDigest(evidence)
    return { ...unsigned, signature: sign(null, Buffer.from(attestation.hostAttestationSigningPayload(unsigned)), key).toString('base64') }
  }
  if (request.phase === 'rollback') {
    await stop()
    const generation = current.generation + 1
    const { attestation } = await modules()
    const evidence = { kind: 'rollback', action: 'stop', previousHostGeneration: current.generation, currentHostGeneration: generation,
      checks: 1, failures: 0, profileRestored: true, probeDigest: sha(config.profile) }
    const unsigned = receipt(request, evidence, 'passed', generation)
    unsigned.requestDigest = attestation.hostAttestationRequestDigest(request)
    unsigned.evidenceDigest = attestation.hostAttestationEvidenceDigest(evidence)
    return { ...unsigned, signature: sign(null, Buffer.from(attestation.hostAttestationSigningPayload(unsigned)), key).toString('base64') }
  }
  throw new Error('test host attestor: unsupported phase ' + request.phase)
}

if (process.argv.includes('--version')) { process.stdout.write(config.version + '\n'); process.exit(0) }
if (process.argv.includes('attest')) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const request = JSON.parse(input)
  const output = await attest(request)
  process.stdout.write(JSON.stringify(output) + '\n')
  process.exit(0)
}
throw new Error('test host attestor: unsupported command')
