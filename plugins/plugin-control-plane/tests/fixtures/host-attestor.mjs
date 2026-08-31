#!/usr/bin/env node
// Integration-only implementation of the deployment-owned Host attestor
// contract. It deliberately lives outside src/ and is not packed.
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex')

if (process.argv[2] === '--version') {
  process.stdout.write('fixture-host-attestor-1\n')
  process.exit(0)
}
if (process.argv[2] !== 'attest') process.exit(64)

const root = process.env.HOST_ATTESTOR_FIXTURE_DIR
if (typeof root !== 'string' || root === '') process.exit(65)
mkdirSync(root, { recursive: true, mode: 0o700 })
const request = JSON.parse(readFileSync(0, 'utf8'))
if (!/^host-operation-[A-Za-z0-9-]+$/u.test(request.operationId)) process.exit(66)
const requestDigest = digest(request)
const cachePath = join(root, `${request.operationId}.json`)
const requestPath = join(root, `${request.operationId}.request`)
if (existsSync(requestPath)) {
  if (readFileSync(requestPath, 'utf8') !== requestDigest) process.exit(67)
} else writeFileSync(requestPath, requestDigest, { mode: 0o600, flag: 'wx' })
if (existsSync(cachePath)) {
  const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
  if (cached.requestDigest !== requestDigest) process.exit(68)
  process.stdout.write(`${JSON.stringify(cached.receipt)}\n`)
  process.exit(0)
}

const observations = JSON.parse(readFileSync(join(root, 'observations.json'), 'utf8'))
const mode = process.env.HOST_ATTESTOR_MODE ?? 'passed'
const generationPath = join(root, 'host-generation')
const priorGeneration = existsSync(generationPath) ? Number(readFileSync(generationPath, 'utf8')) : request.requirements.previousHostGeneration ?? 0
const operationGenerationPath = join(root, `${request.operationId}.generation`)
const hostGeneration = request.phase === 'reload'
  ? existsSync(operationGenerationPath) ? Number(readFileSync(operationGenerationPath, 'utf8')) : priorGeneration + 1
  : priorGeneration
if (request.phase === 'reload') {
  if (!existsSync(operationGenerationPath)) writeFileSync(operationGenerationPath, String(hostGeneration), { mode: 0o600, flag: 'wx' })
  writeFileSync(generationPath, String(Math.max(priorGeneration, hostGeneration)), { mode: 0o600 })
}
let evidence
if (request.phase === 'reload') evidence = { kind: 'reload', reloaded: true,
  previousHostGeneration: request.requirements.previousHostGeneration, currentHostGeneration: hostGeneration,
  probeDigest: digest(observations.reload) }
else if (request.phase === 'readiness') evidence = { kind: 'readiness', ...observations.readiness, probeDigest: digest(observations.readiness) }
else if (request.phase === 'effect-blocked-replay') evidence = { kind: 'effect-blocked-replay', ...observations.effectBlockedReplay,
  replayDigest: digest(observations.effectBlockedReplay) }
else if (request.phase === 'shadow') evidence = { kind: 'shadow', ...observations.shadow, traceDigest: digest(observations.shadow) }
else if (request.phase === 'canary') {
  const exposure = join(root, `canary-${request.operationId}.exposure`)
  if (!existsSync(exposure)) writeFileSync(exposure, requestDigest, { mode: 0o600, flag: 'wx' })
  const exposures = readdirSync(root).filter(name => name.endsWith('.exposure')).length
  writeFileSync(join(root, 'canary-exposures'), String(exposures), { mode: 0o600 })
  evidence = { kind: 'canary', exposureId: `exposure:${request.operationId}`, exposures: 1,
    ...observations.canary, traceDigest: digest(observations.canary) }
} else if (request.phase === 'soak') {
  const soak = { ...observations.soak, windowStartedAt: request.requestedAt,
    windowEndedAt: request.requestedAt + request.requirements.minimumWindowMs }
  evidence = { kind: 'soak', ...soak, traceDigest: digest(soak) }
}
else evidence = { kind: 'health', ...observations.health, probeDigest: digest(observations.health) }

if (mode === 'bad-evidence') {
  if (evidence.kind === 'effect-blocked-replay') evidence.externalEffects = 1
  else if ('failures' in evidence) evidence.failures = Math.max(1, evidence.failures)
  else if (evidence.kind === 'reload') evidence.reloaded = false
  else if (evidence.kind === 'shadow') evidence.externalEffects = 1
}
const now = Date.now()
const unsigned = {
  schemaVersion: 2,
  receiptId: `receipt:${request.operationId}`,
  authority: 'host-runtime',
  keyId: mode === 'wrong-key' ? 'wrong-host-key' : 'host-key-1',
  installationId: request.installationId,
  planId: request.plan.id,
  planDigest: request.plan.digest,
  activationId: request.activation.id,
  fence: request.activation.fence,
  operationId: request.operationId,
  requestDigest: mode === 'wrong-request-digest' ? '0'.repeat(64) : requestDigest,
  phase: mode === 'wrong-phase' ? (request.phase === 'health' ? 'reload' : 'health') : request.phase,
  outcome: mode === 'failed' && process.env.HOST_ATTESTOR_FAIL_PHASE === request.phase ? 'failed' : 'passed',
  hostGeneration,
  evidence,
  evidenceDigest: digest(evidence),
  observedAt: now,
  expiresAt: now + request.receiptTtlMs,
}
const privateKey = createPrivateKey(readFileSync(join(root, 'private.pem'), 'utf8'))
let signature = sign(null, Buffer.from(canonical(unsigned)), privateKey).toString('base64')
if (mode === 'bad-signature') signature = `${signature.slice(0, -4)}AAAA`
const receipt = { ...unsigned, signature }
const temporary = `${cachePath}.tmp-${process.pid}`
writeFileSync(temporary, JSON.stringify({ requestDigest, receipt }), { mode: 0o600 })
renameSync(temporary, cachePath)
process.stdout.write(`${JSON.stringify(receipt)}\n`)
