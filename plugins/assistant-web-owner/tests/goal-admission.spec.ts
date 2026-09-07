import { mkdtemp, readFile, rm, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { parseDocument, isSeq, isMap } from 'yaml'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { IsolationLedger } from '../../assistant-isolation/lib/ledger.js'
import { compilePolicy, evaluatePolicy } from '../../assistant-policy/lib/evaluator.js'
import type { PolicyRule } from '../../assistant-policy/lib/types.js'
import { configureGoalAdmission } from '../src/goal-setup.ts'
import { prepareAutonomyProfile } from '../src/autonomy.ts'
import { inspectAutonomyProfile } from '../src/doctor.ts'
import { parseGoalAdmissionTask, prepareGoalAdmission } from '../src/goal-admission.ts'
import { prepareWebOwnerProfile, type WebOwnerSetupInput } from '../src/setup.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const dshHome = await mkdtemp(join(tmpdir(), 'web-owner-goal-admission-')); roots.push(dshHome)
  const input: WebOwnerSetupInput = { dshHome, profile: 'web', workspace: join(dshHome, 'workspace'), preset: 'standard' }
  const slugs = ['personal-assistant', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner', 'assistant-isolation', 'assistant-actions', 'credentials-keychain', 'assistant-verifier', 'assistant-deepseek-budget']
  const effectiveDocument = parseDocument('[]')
  for (const slug of slugs) {
    const document = parseDocument(await readFile(new URL(`../../${slug}/cordis.patch.yml`, import.meta.url), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const holder = isSeq(document.contents) ? document.contents.items.find(row => isMap(row) && row.has('insert')) : undefined
    const inserts = isMap(holder) ? holder.get('insert', true) : undefined
    if (!isSeq(inserts)) throw new Error('fixture expected published inserts')
    for (const row of inserts.items) effectiveDocument.add(row)
  }
  const effective = effectiveDocument.toString()
  const initial = prepareWebOwnerProfile(input, '[]', effective)
  await mkdir(input.workspace)
  await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
  const delivery = new DeliveryStore({ path: initial.databasePath })
  const realOwner = delivery.ensureOwner(initial.principal)
  const realBinding = delivery.createBinding({ conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'session-a' }, principal: initial.principal, workspace: input.workspace, agentPreset: input.preset, sessionId: 'session-a', policyRef: 'owner-dm' })
  delivery.close()
  const prepared = { ...initial, patch: prepareAutonomyProfile({ ...input, isolation: { image: `sha256:${'a'.repeat(64)}`, maxRuns: 20, leaseMs: 3600000, maxTotalDurationMs: 600000 } }, initial.patch, effective, realOwner) }
  const profile = inspectAutonomyProfile(prepared.patch, input.profile, input.dshHome)
  const snapshot = { binding: realBinding, owner: realOwner }
  await mkdir(profile.stateRoot, { recursive: true, mode: 0o700 })
  const isolation = new IsolationLedger(join(profile.stateRoot, 'ledger.sqlite'))
  isolation.syncGrants([profile.grant]); isolation.close()
  const patchPath = join(dshHome, 'profiles/web/cordis.patch.yml')
  await writeFile(patchPath, prepared.patch, { mode: 0o600 })

  return { input, effective, prepared, profile, snapshot, patchPath }
}

function task(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, objective: 'Verify the generated artifact', model: 'deepseek-v4-flash', maxGoalRounds: 2, stepMaxDurationMs: 60_000,
    executionBudget: { modelCalls: 3, toolCalls: 3, inputTokens: 2_097_152, outputTokens: 8192, durationMs: 120_000, maxOutputTokensPerCall: 8192 },
    verification: { artifactPath: 'result.txt', command: 'node verify.mjs', maxRuns: 4, maxTotalDurationMs: 100_000, maxDurationMs: 20_000, maxOutputBytes: 4096, cases: [{ stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 }] },
    wake: { maxDelayMs: 60_000, runTimeoutMs: 30_000, maxRuns: 5 }, ...overrides })
}
function config(source: string, id: string): Record<string, any> {
  return (parseDocument(source).toJS() as Array<{ id: string; config: Record<string, any> }>).find(row => row.id === id)!.config
}

describe('goal admission planning', () => {
  test('compiles two exact acceptance profiles and the fixed wake route while preserving custom denies', async () => {
    const f = await fixture()
    const document = parseDocument(f.prepared.patch)
    if (!isSeq(document.contents)) throw new Error('missing fixture rows')
    const personalIndex = document.contents.items.findIndex(value => isMap(value) && String(value.get('id')) === 'dsh-enhanced-personal-assistant')
    document.addIn([personalIndex, 'config', 'assistantPolicy', 'rules'], { id: 'custom-deny', effect: 'deny', subject: { kind: 'agent', id: 'standard' }, actions: ['execute'], resource: { kind: 'tool', id: 'forbidden' } })
    const source = document.toString()
    const plan = prepareGoalAdmission(f.input, source, f.effective, task(), f.snapshot, Date.now())
    const goals = config(plan.patch, 'dsh-enhanced-assistant-goals')
    const verifier = config(plan.patch, 'dsh-enhanced-assistant-verifier')
    const personal = config(plan.patch, 'dsh-enhanced-personal-assistant')
    expect(verifier.profiles.filter((profile: { id: string }) => profile.id.startsWith(plan.admissionId))).toHaveLength(2)
    expect(goals.executionBudget).toMatchObject({ inputTokens: 2_097_152, maxOutputTokensPerCall: 8192 })
    expect(goals.backgroundWake).toMatchObject({ ownerRouteId: plan.admissionId, budgetId: `${plan.admissionId}-runs` })
    expect(personal.assistantPolicy.rules.some((rule: { id: string }) => rule.id === `${plan.admissionId}-resume`)).toBe(true)
    expect(personal.assistantPolicy.rules).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'custom-deny', effect: 'deny' })]))
  })

  test('is byte-idempotent and never extends the managed isolation grant', async () => {
    const f = await fixture(); const first = prepareGoalAdmission(f.input, f.prepared.patch, f.effective, task(), f.snapshot, Date.now())
    const second = prepareGoalAdmission(f.input, first.patch, first.patch, task(), f.snapshot, Date.now())
    expect(second.patch).toBe(first.patch)
    expect(inspectAutonomyProfile(second.patch, f.input.profile, f.input.dshHome).grant).toEqual(f.profile.grant)
  })

  test('rejects unsafe task shapes and leaves the caller source untouched', async () => {
    const f = await fixture(); const source = f.prepared.patch
    for (const bad of [
      task({ unknown: true }), task({ executionBudget: { modelCalls: 1, toolCalls: 1, inputTokens: 1, outputTokens: 1, durationMs: 120_000, maxOutputTokensPerCall: 1, costUsdMicros: 1 } }),
      task({ wake: { maxDelayMs: 120_000, runTimeoutMs: 30_000, maxRuns: 1 } }),
    ]) expect(() => prepareGoalAdmission(f.input, source, f.effective, bad, f.snapshot, Date.now())).toThrow()
    expect(source).toBe(f.prepared.patch)
  })

  test('rejects changed managed budget, route, owner, and expired grant without producing a replacement patch', async () => {
    const f = await fixture(); const first = prepareGoalAdmission(f.input, f.prepared.patch, f.effective, task(), f.snapshot, Date.now())
    const budgetChanged = first.patch.replace('modelCalls: 3', 'modelCalls: 4')
    expect(() => prepareGoalAdmission(f.input, budgetChanged, budgetChanged, task(), f.snapshot, Date.now())).toThrow(/differs/)
    expect(() => prepareGoalAdmission(f.input, first.patch, first.patch, task(), { ...f.snapshot, owner: { ...f.snapshot.owner, version: f.snapshot.owner.version + 1 } }, Date.now())).toThrow(/owner/)
    expect(() => prepareGoalAdmission(f.input, f.prepared.patch, f.effective, task(), f.snapshot, f.profile.grant.expiresAt)).toThrow(/deadline|expired/)
  })


  test('generated background policy permits task execution but refuses unrelated tools and goal control', async () => {
    const f = await fixture(); const plan = prepareGoalAdmission(f.input, f.prepared.patch, f.effective, task(), f.snapshot)
    const policy = compilePolicy(config(plan.patch, 'dsh-enhanced-personal-assistant').assistantPolicy.rules as PolicyRule[])
    const request = { subject: { kind: 'agent', id: 'standard', workspace: f.input.workspace, principal: 'web/web/local/operator' }, action: 'execute', context: { initiator: 'background' } } as const
    for (const id of ['isolation_run', 'goal_context', `isolation:${f.profile.grant.id}`]) expect(evaluatePolicy(policy, { ...request, resource: { kind: 'tool', id } }).effect).toBe('allow')
    for (const id of ['action_github_commit', 'goal_control', 'goal_schedule', 'bash', 'unrelated', 'isolation:another-grant']) expect(evaluatePolicy(policy, { ...request, resource: { kind: 'tool', id } }).effect).toBe('deny')
  })

  test('offline configuration preserves state and rejects revoked owners or non-private task inputs without changing the patch', async () => {
    const f = await fixture(); const path = join(f.input.dshHome, 'task.json')
    await writeFile(path, task(), { mode: 0o600 })
    const database = await readFile(f.prepared.databasePath); const isolation = await readFile(join(f.profile.stateRoot, 'ledger.sqlite'))
    await configureGoalAdmission(f.input, f.effective, path, 'session-a')
    const configured = await readFile(f.patchPath, 'utf8')
    await configureGoalAdmission(f.input, configured, path, 'session-a')
    expect(await readFile(f.patchPath, 'utf8')).toBe(configured)
    expect(await readFile(f.prepared.databasePath)).toEqual(database)
    expect(await readFile(join(f.profile.stateRoot, 'ledger.sqlite'))).toEqual(isolation)
    await chmod(path, 0o644)
    await expect(configureGoalAdmission(f.input, configured, path, 'session-a')).rejects.toThrow(/private/)
    await chmod(path, 0o600)
    const hidden = join(f.input.workspace, '..private.json'); await writeFile(hidden, task(), { mode: 0o600 })
    await expect(configureGoalAdmission(f.input, configured, hidden, 'session-a')).rejects.toThrow(/outside/)
    const store = new DeliveryStore({ path: f.prepared.databasePath })
    store.revokePrincipal(f.snapshot.owner.id, f.snapshot.owner.version); store.close()
    await expect(configureGoalAdmission(f.input, configured, path, 'session-a')).rejects.toThrow(/snapshot mismatch/)
    expect(await readFile(f.patchPath, 'utf8')).toBe(configured)
  })

  test('parses only complete bounded JSON task data', () => {
    expect(parseGoalAdmissionTask(task()).model).toBe('deepseek-v4-flash')
    expect(() => parseGoalAdmissionTask('{"version":1}')).toThrow(/fields/)
    expect(() => parseGoalAdmissionTask(`${task()} trailing`)).toThrow(/JSON/)
  })
})
