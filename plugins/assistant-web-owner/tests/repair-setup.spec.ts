import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { configureRepairAdmission, parseRepairAdmissionTask, prepareRepairAdmission } from '../src/repair-setup.js'
import { configureWebOwner, prepareWebOwnerProfile, type WebOwnerSetupInput } from '../src/setup.js'
import { ensurePrincipalLocally } from '@dsh-enhanced/assistant-delivery'
import { parseDocument } from 'yaml'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const task = {
  ownerRouteId: 'owner-route', externalHoldouts: [], repairProfiles: [{
    id: 'repair-one', scope: { principalId: 'web/web/local/operator', principalRecordId: 'owner', principalVersion: 1, workspace: '/work', preset: 'standard' },
    skillName: 'saved-write', taskFamilyId: 'repair-family', description: 'Repair a saved workflow', externalHoldoutProfileId: 'holdout', provider: 'fixture', model: 'fixture', allowedTools: ['write'],
    maxGoalRounds: 2, maxModelCalls: 4, maxToolCalls: 4, maxOutputTokens: 128, maxDurationMs: 30_000, canaryRuns: 1, maxCanaryRuns: 2, maxIterations: 1,
  }],
}

describe('repair admission input', () => {
  test('accepts only a finite configured profile without authority-expanding tools', () => {
    expect(parseRepairAdmissionTask(JSON.stringify(task))).toEqual(task)
    expect(() => parseRepairAdmissionTask(JSON.stringify({ ...task, extra: true }))).toThrow('fields')
    expect(() => parseRepairAdmissionTask(JSON.stringify({ ...task, repairProfiles: [{ ...task.repairProfiles[0], unbounded: true }] }))).toThrow('invalid')
    expect(() => parseRepairAdmissionTask(JSON.stringify({ ...task, repairProfiles: [{ ...task.repairProfiles[0], allowedTools: ['skill_repair_arm'] }] }))).toThrow('authority')
  })
})

test('rejects a non-private admission before modifying the profile patch', async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'repair-admission-'))); roots.push(home)
  const workspace = join(home, 'workspace'), profile = join(home, 'profiles', 'web'), path = join(profile, 'cordis.patch.yml'), admission = join(home, 'repair.json')
  await mkdir(workspace); await mkdir(profile, { recursive: true }); await writeFile(path, '# unchanged\n[]\n'); await writeFile(admission, JSON.stringify(task), { mode: 0o644 }); await chmod(admission, 0o644)
  await expect(configureRepairAdmission({ dshHome: home, profile: 'web', workspace, preset: 'standard' }, '[]', admission)).rejects.toThrow('private')
  expect(await readFile(path, 'utf8')).toBe('# unchanged\n[]\n')
})

async function configured() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'repair-admission-valid-'))); roots.push(home)
  const input: WebOwnerSetupInput = { dshHome: home, profile: 'web', workspace: join(home, 'workspace'), preset: 'standard' }
  await mkdir(input.workspace); await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  const effectiveDoc = parseDocument('[]')
  for (const slug of ['personal-assistant', 'assistant-delivery']) { const doc = parseDocument(await readFile(new URL(`../../${slug}/cordis.patch.yml`, import.meta.url), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }); const insert = (doc.contents as any).items.find((value: any) => value.get('insert', true))?.get('insert', true); effectiveDoc.add(insert.items[0]) }
  for (const value of [{ id: 'dsh-enhanced-assistant-goals', config: { budgets: [{ id: 'repair-budget', limit: 2 }] } }, { id: 'dsh-enhanced-assistant-web-owner' }, { id: 'dsh-enhanced-assistant-skills', config: { databasePath: `${home}/skills.sqlite`, allowedTools: ['write'] } }, { id: 'dsh-enhanced-assistant-verifier', config: { profiles: [{ id: 'repair-outcome' }] } }, { id: 'dsh-enhanced-assistant-deepseek-budget', config: { id: 'repair-budget' } }]) effectiveDoc.add(value)
  const effective = effectiveDoc.toString()
  const initial = prepareWebOwnerProfile(input, '[]', effective); await configureWebOwner(input, effective)
  const path = join(home, 'profiles', 'web', 'cordis.patch.yml'); const source = await readFile(path, 'utf8'); const owner = ensurePrincipalLocally({ databasePath: initial.databasePath, principal: { channel: 'web', account: 'web', tenant: 'local', user: 'operator' } })
  const doc = parseDocument(source); const rows = doc.toJS() as any[]; const deliveryRow = rows.find(row => row.id === 'dsh-enhanced-assistant-delivery'); deliveryRow.config.databasePath = initial.databasePath; deliveryRow.config.spoolPath = join(home, 'assistant-delivery', 'spool'); deliveryRow.config.ownerRoutes = [{ id: 'owner-route', conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'x' }, principal: { channel: 'web', account: 'web', tenant: 'local', user: 'operator' }, workspace: input.workspace, agentPreset: input.preset, policyRef: 'owner-dm', minimumGeneration: 1 }]
  const personalRow = rows.find(row => row.id === 'dsh-enhanced-personal-assistant'); personalRow.config.assistantPolicy.databasePath = join(home, 'personal-assistant', 'policy.sqlite'); personalRow.config.assistantPolicy.budgets = [{ id: 'repair-budget', metric: 'automation-runs', limit: 2, periodMs: 60_000, scope: 'workspace' }]
  rows.push({ id: 'dsh-enhanced-assistant-skills', config: { databasePath: `${home}/skills.sqlite`, allowedTools: ['write'], preserved: 'keep' } })
  const goals = rows.find(row => row.id === 'dsh-enhanced-assistant-goals'); goals.config = { executionBudget: { mode: 'calls', modelCalls: 4, toolCalls: 4, durationMs: 60_000, maxOutputTokensPerCall: 64, routes: [{ provider: 'fixture', model: 'fixture' }] } }
  rows.push({ id: 'dsh-enhanced-assistant-verifier', config: { profiles: [{ id: 'repair-outcome' }] } }, { id: 'dsh-enhanced-assistant-deepseek-budget', config: { id: 'repair-budget' } })
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const scope = { principalId: 'web/web/local/operator', principalRecordId: owner.id, principalVersion: owner.version, workspace: input.workspace, preset: input.preset }
  const holdout = { id: 'holdout', version: 1, scope, execution: { image: `sha256:${'d'.repeat(64)}`, dockerPath: process.execPath, stateRoot: join(home, 'holdout-state'), command: 'true', artifactPath: 'result', expiresAt: Date.now() + 60_000, repeats: 2, maxToolCalls: 1, maxBytes: 1024, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1 }, authority: { executable: process.execPath, args: [], publicKey, generatorDigest: 'e'.repeat(64) }, canaryAdmissionTemplate: { protocol: 'assistant-skills/canary-admission-template/v1', skillName: 'saved-write', taskFamily: { goalDefinitionDigest: 'a'.repeat(64), outcomeProfile: { id: 'repair-outcome', version: 1, digest: 'f'.repeat(64) } } }, maxComparisons: 1 }
  const profile = (id: string, followupProfileIds: string[] = []) => ({ id, scope, skillName: 'saved-write', taskFamilyId: 'family', description: 'repair', externalHoldoutProfileId: 'holdout', provider: 'fixture', model: 'fixture', allowedTools: ['write'], maxGoalRounds: 1, maxModelCalls: 1, maxToolCalls: 1, maxOutputTokens: 32, maxDurationMs: 30_000, canaryRuns: 1, maxCanaryRuns: 1, maxIterations: followupProfileIds.length + 1, ...(followupProfileIds.length ? { followupProfileIds } : {}) })
  return { input, effective, source: JSON.stringify(rows), holdout, profile }
}

test('real validators preserve config and accept an ordered two-profile chain', async () => {
  const f = await configured(); const admission = { ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('primary', ['followup']), f.profile('followup')] }
  const result = prepareRepairAdmission(f.input, f.source, f.effective, JSON.stringify(admission))
  const skills = (parseDocument(result.patch).toJS() as any[]).find(row => row.id === 'dsh-enhanced-assistant-skills').config
  expect(skills.preserved).toBe('keep'); expect(skills.repairProfiles.map((item: any) => item.id)).toEqual(['primary', 'followup'])
  expect(prepareRepairAdmission(f.input, result.patch, f.effective, JSON.stringify(admission)).patch).toBe(result.patch)
})

test('rejects a foreign profile scope before producing a patch', async () => {
  const f = await configured(); const foreign = { ...f.profile('primary'), scope: { ...f.profile('primary').scope, workspace: '/foreign' } }
  expect(() => prepareRepairAdmission(f.input, f.source, f.effective, JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [foreign] }))).toThrow('scope')
})

test.each([{ inject: ['assistantVerifier'] }, { inject: { assistantVerifier: {} } }])('waits for configured Isolation and preserves existing injection %j', async ({ inject }) => {
  const f = await configured(), effective = parseDocument(f.effective).toJS() as any[]
  effective.push({ id: 'dsh-enhanced-assistant-isolation', name: '@dsh-enhanced/assistant-isolation' })
  effective.find(row => row.id === 'dsh-enhanced-assistant-skills').inject = inject
  const admission = JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('primary')] })
  const planned = prepareRepairAdmission(f.input, f.source, JSON.stringify(effective), admission)
  const skills = (parseDocument(planned.patch).toJS() as any[]).find(row => row.id === 'dsh-enhanced-assistant-skills')
  expect(skills.inject).toEqual(Array.isArray(inject) ? ['assistantVerifier', 'assistantIsolation'] : { assistantVerifier: {}, assistantIsolation: {} })
  expect(prepareRepairAdmission(f.input, planned.patch, JSON.stringify(effective), admission).patch).toBe(planned.patch)
})

test('does not add an unavailable dependency for disabled Isolation', async () => {
  const f = await configured(), effective = parseDocument(f.effective).toJS() as any[]
  effective.push({ id: 'dsh-enhanced-assistant-isolation', disabled: true })
  const admission = JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('primary')] })
  const result = prepareRepairAdmission(f.input, f.source, JSON.stringify(effective), admission)
  expect((parseDocument(result.patch).toJS() as any[]).find(row => row.id === 'dsh-enhanced-assistant-skills').inject).toBeUndefined()
})

test('rejects a missing exact profile owner without changing the database or patch', async () => {
  const f = await configured(); const path = join(f.input.dshHome, 'profiles', f.input.profile, 'cordis.patch.yml'); const admission = join(f.input.dshHome, 'repair.json')
  await writeFile(path, f.source); await writeFile(admission, JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('primary')] }), { mode: 0o600 }); await chmod(admission, 0o600)
  const database = new DatabaseSync((prepareWebOwnerProfile(f.input, f.source, f.effective)).databasePath)
  try { database.prepare("UPDATE delivery_principals SET principal_json = ? WHERE role = 'owner' AND status = 'active'").run(JSON.stringify({ channel: 'web', account: 'another-profile', tenant: 'local', user: 'operator' })) } finally { database.close() }
  const beforePatch = await readFile(path, 'utf8'); const databasePath = prepareWebOwnerProfile(f.input, f.source, f.effective).databasePath; const beforeDatabase = await readFile(databasePath)
  await expect(configureRepairAdmission(f.input, f.effective, admission)).rejects.toThrow('current Web owner is unavailable')
  expect(await readFile(path, 'utf8')).toBe(beforePatch); expect(await readFile(databasePath)).toEqual(beforeDatabase)
})

test('rejects an unavailable model route and profile budgets exceeding calls limits', async () => {
  const f = await configured(); const admission = (profile: Record<string, unknown>) => JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [profile] })
  expect(() => prepareRepairAdmission(f.input, f.source, f.effective, admission({ ...f.profile('wrong-model'), model: 'unconfigured' }))).toThrow('exact model route')
  expect(() => prepareRepairAdmission(f.input, f.source, f.effective, admission({ ...f.profile('too-many-calls'), maxModelCalls: 5 }))).toThrow('finite Goals execution budget')
  expect(() => prepareRepairAdmission(f.input, f.source, f.effective, admission({ ...f.profile('too-many-tools'), maxToolCalls: 5 }))).toThrow('finite Goals execution budget')
  expect(() => prepareRepairAdmission(f.input, f.source, f.effective, admission({ ...f.profile('too-many-output'), maxOutputTokens: 65 }))).toThrow('finite Goals execution budget')
})

test('accepts a TraeX calls budget without a DeepSeek budget bundle', async () => {
  const f = await configured(); const effective = parseDocument(f.effective).toJS() as any[]
  const withoutDeepSeek = JSON.stringify(effective.filter(row => row.id !== 'dsh-enhanced-assistant-deepseek-budget'))
  expect(() => prepareRepairAdmission(f.input, f.source, withoutDeepSeek, JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('traex-calls')] }))).not.toThrow()
})

test('reapplying an identical private admission keeps the patch byte-identical', async () => {
  const f = await configured(); const path = join(f.input.dshHome, 'profiles', f.input.profile, 'cordis.patch.yml'); const admission = join(f.input.dshHome, 'repair.json')
  await writeFile(path, f.source); await writeFile(admission, JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('primary')] }), { mode: 0o600 }); await chmod(admission, 0o600)
  await configureRepairAdmission(f.input, f.effective, admission); const first = await readFile(path, 'utf8')
  await configureRepairAdmission(f.input, f.effective, admission)
  expect(await readFile(path, 'utf8')).toBe(first)
})

test('rejects owner lineage changed after planning and keeps the patch unchanged', async () => {
  const f = await configured(); const path = join(f.input.dshHome, 'profiles', f.input.profile, 'cordis.patch.yml'); const admission = join(f.input.dshHome, 'repair.json')
  await writeFile(path, f.source); await writeFile(admission, JSON.stringify({ ownerRouteId: 'owner-route', externalHoldouts: [f.holdout], repairProfiles: [f.profile('primary')] }), { mode: 0o600 }); await chmod(admission, 0o600)
  const before = await readFile(path, 'utf8'); const databasePath = prepareWebOwnerProfile(f.input, f.source, f.effective).databasePath; let reads = 0
  await expect(configureRepairAdmission(f.input, f.effective, admission, async () => {
    reads += 1
    if (reads === 2) { const database = new DatabaseSync(databasePath); try { database.prepare("UPDATE delivery_principals SET version = version + 1 WHERE role = 'owner' AND status = 'active'").run() } finally { database.close() } }
    return f.effective
  })).rejects.toThrow('owner')
  expect(reads).toBe(2); expect(await readFile(path, 'utf8')).toBe(before)
})
