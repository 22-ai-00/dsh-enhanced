import { execFile as execFileCallback } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { createDefinition } from '../src/definition.ts'
import { openHoldoutProcess, validateExternalHoldoutProfiles, type ExternalHoldoutProfile } from '../src/external-holdout.ts'
import { inspectProspectiveQualification, qualifyHoldout } from '../src/holdout-qualification.ts'

const execFile = promisify(execFileCallback)
const roots: string[] = []
const cli = fileURLToPath(new URL('../lib/holdout-cli.js', import.meta.url))
// This pinned Node image is the ordinary verifier transport, never a fixture transport.
const image = process.env.DSH_HOLDOUT_TEST_IMAGE ?? ''
const digest = (letter: string) => letter.repeat(64)

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function definition(scope: { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }, content: string) {
  return createDefinition({ protocol: 'assistant-goals/verified-workflow-source/v1', scope, goal: { id: 'goal', definition: { version: 1, digest: digest('a'), objective: 'engineering fixture' }, sessionId: 'session', nativeGoalId: 'native' }, runId: 'run', turn: 1,
    acceptance: { contractId: 'contract', contractDigest: digest('b'), receiptDigest: digest('c'), verifiedAt: 1, validUntil: 2 }, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'result.sh', content } }] },
  { name: 'result', description: 'Write result.' }, ['write'])
}

test.skipIf(!existsSync('/usr/bin/docker') || !/^sha256:[a-f0-9]{64}$/u.test(image))('prospective CLI freezes before generation, qualifies both arms in Docker, and reinspects the signed receipt after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prospective-holdout-cli-'))
  const stateRoot = await mkdtemp(join(tmpdir(), 'prospective-holdout-state-'))
  roots.push(root, stateRoot); await chmod(root, 0o700); await chmod(stateRoot, 0o700)
  const privateKey = join(root, 'key.pem'), configPath = join(root, 'authority.json')
  const { privateKey: key, publicKey } = await import('node:crypto').then(({ generateKeyPairSync }) => generateKeyPairSync('ed25519'))
  await writeFile(privateKey, key.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(configPath, JSON.stringify({ prospective: { generator: 'order-summary/v1' }, privateKeyPath: privateKey, statePath: join(root, 'authority.sqlite'), limits: { maxToolCalls: 2, maxOutputBytes: 4096 } }), { mode: 0o600 })
  const inspectedConfig = JSON.parse((await execFile(process.execPath, [cli, '--inspect-config', configPath])).stdout)
  expect(inspectedConfig).toEqual({ publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), limits: { maxToolCalls: 2, maxOutputBytes: 4096 } })
  await expect(stat(join(root, 'authority.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })

  const workspace = join(root, 'workspace'); await mkdir(workspace, { mode: 0o700 })
  const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace, preset: 'primary' }
  const baseline = definition(scope, "printf '{}\\n'")
  const candidate = definition(scope, "node -e 'let s=\"\";process.stdin.on(\"data\",c=>s+=c).on(\"end\",()=>{const t={};for(const o of JSON.parse(s))if(o.status!==\"cancelled\")t[o.currency]=(t[o.currency]||0)+o.cents;const r={};for(const k of Object.keys(t).sort())r[k]=t[k];process.stdout.write(JSON.stringify(r)+\"\\n\")})'")
  const execution = { image, dockerPath: '/usr/bin/docker', stateRoot, command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 120000, repeats: 2, maxToolCalls: 2, maxBytes: 8192, maxOutputBytes: 4096, cellDurationMs: 15000, verificationDurationMs: 10000 }
  const [profile] = validateExternalHoldoutProfiles([{ id: 'prospective', version: 1, scope, execution, authority: { executable: process.execPath, args: [cli, '--config', configPath], publicKey: inspectedConfig.publicKey, generatorDigest: inspectedConfig.generatorDigest }, maxComparisons: 1 } satisfies ExternalHoldoutProfile])
  const controller = new AbortController(), client = await openHoldoutProcess(profile!.authority, controller.signal)
  let result: Awaited<ReturnType<typeof qualifyHoldout>>
  try {
    result = await qualifyHoldout({ baseline, candidate, scope, execution, pinnedPublicKey: profile!.authority.publicKey, expectedGeneratorDigest: profile!.authority.generatorDigest!, transport: client.transport, signal: controller.signal, authorize() {} })
  } finally { await client.close() }
  expect(result).toMatchObject({ prospectiveHoldout: 'authority-attested-after-freeze', modelCalls: 0, promotionAuthorized: false, quality: { candidateChecksPassed: true, evaluationGain: 1, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'unproven' } })
  const context = { scope, baseline, candidate, execution, pinnedPublicKey: profile!.authority.publicKey, expectedGeneratorDigest: profile!.authority.generatorDigest! }
  expect(inspectProspectiveQualification(result, context)).toMatchObject({ prospectiveHoldout: 'authority-attested-after-freeze', quality: { heldoutIndependence: 'unproven', evaluationGain: 1 } })

  const restarted = await openHoldoutProcess(profile!.authority, new AbortController().signal)
  try { expect(await restarted.transport.request('finish')).toEqual(result.receipt) } finally { await restarted.close() }

  const claimed = structuredClone(result) as unknown as { quality: unknown }
  claimed.quality = { candidateChecksPassed: true, evaluationGain: 100, evaluationGainObserved: true, criticalRegressionsPassed: true, heldoutIndependence: 'proven' }
  expect(inspectProspectiveQualification(claimed, context)?.quality.heldoutIndependence).toBe('unproven')
  expect(inspectProspectiveQualification(result, { ...context, candidate: definition(scope, 'printf other') })).toBeUndefined()
  expect(inspectProspectiveQualification(result, { ...context, execution: { ...execution, maxBytes: execution.maxBytes + 1 } })).toBeUndefined()
  expect(inspectProspectiveQualification(result, { ...context, pinnedPublicKey: 'wrong' })).toBeUndefined()
  const receiptTampered = structuredClone(result) as unknown as { receipt: { signature: string } }; receiptTampered.receipt.signature = 'tampered'
  expect(inspectProspectiveQualification(receiptTampered, context)).toBeUndefined()
  const certificateTampered = structuredClone(result) as unknown as { receipt: { prospective?: { freezeId: string } } }; certificateTampered.receipt.prospective!.freezeId = '123e4567-e89b-42d3-a456-826614174001'
  expect(inspectProspectiveQualification(certificateTampered, context)).toBeUndefined()
}, 180000)
