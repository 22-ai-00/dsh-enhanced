import { mkdtemp, readFile, realpath, rm, mkdir, writeFile, chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { parseDocument, isSeq, isMap, isScalar, type YAMLMap, type YAMLSeq } from 'yaml'
import * as eventSupport from '@dsh-enhanced/event-triggers'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { IsolationLedger } from '../../assistant-isolation/lib/ledger.js'
import { compilePolicy, evaluatePolicy } from '../../assistant-policy/lib/evaluator.js'
import type { PolicyRule } from '../../assistant-policy/lib/types.js'
import { configureGoalAdmission, listGoalAdmissionSessions } from '../src/goal-setup.ts'
import { prepareAutonomyProfile } from '../src/autonomy.ts'
import { inspectAutonomyProfile } from '../src/doctor.ts'
import { parseGoalAdmissionTask, parseSettingsDefaultModelRoute, prepareGoalAdmission } from '../src/goal-admission.ts'
import { prepareWebOwnerProfile, runWebOwnerSetup, type WebOwnerSetupInput } from '../src/setup.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(now = Date.now()) {
  const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'web-owner-goal-admission-'))); roots.push(dshHome)
  const input: WebOwnerSetupInput = { dshHome, profile: 'web', workspace: join(dshHome, 'workspace'), preset: 'standard' }
  const slugs = ['event-triggers', 'personal-assistant', 'assistant-delivery', 'assistant-goals', 'assistant-web-owner', 'assistant-isolation', 'assistant-actions', 'credentials-keychain', 'assistant-verifier', 'assistant-deepseek-budget']
  const effectiveDocument = parseDocument('[]')
  for (const slug of slugs) {
    const document = parseDocument(await readFile(new URL(`../../${slug}/cordis.patch.yml`, import.meta.url), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
    const holder = isSeq(document.contents) ? document.contents.items.find(row => isMap(row) && row.has('insert')) : undefined
    const inserts = isMap(holder) ? holder.get('insert', true) : undefined
    if (!isSeq(inserts)) throw new Error('fixture expected published inserts')
    for (const row of inserts.items) effectiveDocument.add(row)
  }
  // Metadata-only fixture: verifier preparation validates an executable path but never runs Docker here; Linux E2E covers Docker execution.
  if (!isSeq(effectiveDocument.contents)) throw new Error('fixture expected effective rows')
  const isolationRow = effectiveDocument.contents.items.find(row => yamlId(row) === 'dsh-enhanced-assistant-isolation')
  if (!isMap(isolationRow)) throw new Error('fixture expected isolation row')
  const metadataExecutable = await realpath(process.execPath)
  isolationRow.setIn(['config', 'dockerPath'], metadataExecutable)
  const effective = effectiveDocument.toString()
  const initial = prepareWebOwnerProfile(input, '[]', effective)
  await mkdir(input.workspace)
  await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
  const delivery = new DeliveryStore({ path: initial.databasePath })
  const realOwner = delivery.ensureOwner(initial.principal)
  const realBinding = delivery.createBinding({ conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'session-a' }, principal: initial.principal, workspace: input.workspace, agentPreset: input.preset, sessionId: 'session-a', policyRef: 'owner-dm' })
  delivery.close()
  const prepared = { ...initial, patch: prepareAutonomyProfile({ ...input, isolation: { image: `sha256:${'a'.repeat(64)}`, maxRuns: 20, leaseMs: 3600000, maxTotalDurationMs: 600000 } }, initial.patch, effective, realOwner, now) }
  const profile = inspectAutonomyProfile(prepared.patch, input.profile, input.dshHome)
  expect(profile.dockerPath).toBe(metadataExecutable)
  const snapshot = { binding: realBinding, owner: realOwner }
  await mkdir(profile.stateRoot, { recursive: true, mode: 0o700 })
  const isolation = new IsolationLedger(join(profile.stateRoot, 'ledger.sqlite'))
  isolation.syncGrants([profile.grant]); isolation.close()
  const patchPath = join(dshHome, 'profiles/web/cordis.patch.yml')
  await writeFile(patchPath, prepared.patch, { mode: 0o600 })

  return { input, effective, prepared, profile, snapshot, patchPath }
}

function task(overrides: Record<string, unknown> = {}): string {
  const value = { version: 1, objective: 'Verify the generated artifact', model: 'deepseek-v4-flash', maxGoalRounds: 2, stepMaxDurationMs: 60_000,
    executionBudget: { modelCalls: 3, toolCalls: 3, inputTokens: 2_097_152, outputTokens: 8192, durationMs: 120_000, maxOutputTokensPerCall: 8192 },
    verification: { artifactPath: 'result.txt', command: 'node verify.mjs', maxRuns: 4, maxTotalDurationMs: 100_000, maxDurationMs: 20_000, maxOutputBytes: 4096, cases: [{ stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 }] },
    wake: { maxDelayMs: 60_000, runTimeoutMs: 30_000, maxRuns: 5 }, ...overrides } as Record<string, unknown>
  if (value.model === undefined) delete value.model
  return JSON.stringify(value)
}
function config(source: string, id: string): Record<string, any> {
  return (parseDocument(source).toJS() as Array<{ id: string; config: Record<string, any> }>).find(row => row.id === id)!.config
}
function yamlId(row: unknown): string | undefined {
  const id = isMap(row) ? row.get('id', true) : undefined
  return isScalar(id) && typeof id.value === 'string' ? id.value : undefined
}
const repositoryRoute = { provider: 'super-relay', model: 'relay-v2' }
function repositoryTask(repositoryDelivery: Record<string, unknown> = {}): string {
  const value = JSON.parse(task({ version: 2, route: repositoryRoute, model: undefined,
    executionBudget: { mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [repositoryRoute] } })) as Record<string, unknown>
  delete value.wake
  value.repositoryDelivery = { repository: 'octo/example', baseBranch: 'main', branch: 'automation/result', paths: ['result.txt'], credentialHandle: 'github', expiresAt: Date.now() + 300_000, maxActions: 3, maxTotalBytes: 4096, openPullRequest: true, ...repositoryDelivery }
  return JSON.stringify(value)
}
function repositoryEffective(source: string, handles: unknown[] = [{ id: 'github', provider: 'linux-protected-file', path: '/tmp/github-token', consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }]): string {
  const document = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (!isSeq(document.contents)) throw new Error('fixture expected rows')
  const rows = document.contents as YAMLSeq
  rows.add(document.createNode({ id: 'agent-default-model', config: repositoryRoute }))
  const keychain = rows.items.find(row => isMap(row) && row.get('id') === 'dsh-enhanced-credentials-keychain')
  if (!isMap(keychain)) throw new Error('fixture expected keychain')
  const config = keychain.get('config', true)
  if (!isMap(config)) throw new Error('fixture expected config')
  config.set('handles', document.createNode(handles))
  return String(document)
}
function repositorySource(source: string, handles: unknown[] = [{ id: 'github', provider: 'linux-protected-file', path: '/tmp/github-token', consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }]): string {
  const document = parseDocument(source)
  if (!isSeq(document.contents)) throw new Error('fixture expected source rows')
  let keychain: YAMLMap | undefined
  for (const row of document.contents.items) {
    const id = isMap(row) ? row.get('id', true) : undefined
    if (isMap(row) && isScalar(id) && typeof id.value === 'string' && id.value === 'dsh-enhanced-credentials-keychain') { keychain = row; break }
  }
  if (!isMap(keychain)) throw new Error('fixture expected keychain')
  const keychainConfig = keychain.get('config', true)
  if (!isMap(keychainConfig)) throw new Error('fixture expected keychain config')
  keychainConfig.set('handles', document.createNode(handles))
  return document.toString()
}
function withoutKeychain(source: string): string {
  const document = parseDocument(source)
  if (!isSeq(document.contents)) throw new Error('fixture expected source rows')
  const index = document.contents.items.findIndex(row => yamlId(row) === 'dsh-enhanced-credentials-keychain')
  if (index < 0) throw new Error('fixture expected keychain')
  document.contents.items.splice(index, 1)
  return document.toString()
}
function externalAdmissionId(input: WebOwnerSetupInput, snapshot: Awaited<ReturnType<typeof fixture>>['snapshot']): string {
  return `goal-${createHash('sha256').update(JSON.stringify([input.profile, snapshot.binding.id, snapshot.owner.id, snapshot.owner.version, 'Verify the generated artifact'])).digest('hex').slice(0, 24)}`
}
function externalRepositoryEffective(source: string, input: WebOwnerSetupInput, snapshot: Awaited<ReturnType<typeof fixture>>['snapshot'], now: number,
  change?: (grant: Record<string, unknown>) => void): string {
  const document = parseDocument(repositoryEffective(source))
  if (!isSeq(document.contents)) throw new Error('fixture expected rows')
  const actions = document.contents.items.find(row => yamlId(row) === 'dsh-enhanced-assistant-actions')
  if (!isMap(actions)) throw new Error('fixture expected actions')
  const admissionId = externalAdmissionId(input, snapshot)
  const grant: Record<string, unknown> = {
    id: 'operator-repository-grant', revision: 7, grantDigest: 'a'.repeat(64),
    owner: { principalDigest: createHash('sha256').update('web/web/local/operator').digest('hex'), principalRecordId: snapshot.owner.id, principalVersion: snapshot.owner.version,
      workspace: input.workspace, preset: input.preset, bindingId: snapshot.binding.id, bindingVersion: snapshot.binding.version, bindingGeneration: snapshot.binding.generation },
    sessionId: snapshot.binding.sessionId,
    destination: { classification: 'github-repository', repository: 'octo/example', branch: 'automation/result', baseBranch: 'main', paths: ['result.txt'] },
    expiresAt: now + 300_000, maxActions: 20, maxTotalBytes: 4096, source: { classification: 'internal', provenanceDigest: 'b'.repeat(64) }, maxCostUnits: 20,
    allowedOperations: ['commit', 'inspect', 'pull-request'], allowedInspectKinds: ['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'],
    verifiedDelivery: { ownerRouteId: admissionId, budgetId: `${admissionId}-runs`, acceptance: 'goal-step' },
  }
  change?.(grant)
  ;(actions as unknown as { set(key: unknown, value: unknown): void }).set('config', document.createNode({ broker: { mode: 'external-unix-v1', actionSocketPath: '/tmp/actions.sock', brokerId: 'operator-broker', brokerPublicKeyPath: '/tmp/broker.pub', clientKeyId: 'web-owner', clientSigningKeyPath: '/tmp/client.key', clientInstanceId: 'web-owner-host', clientGeneration: 1, expectedSocketUid: 1, expectedSocketGid: 1, expectedBrokerPeerUid: 1, expectedBrokerPeerGid: 1 }, grants: [], externalGrants: [grant] }))
  return document.toString()
}

describe('goal admission planning', () => {
  test('v2 uses the DSH settings overlay during formal setup and rejects malformed public routes', async () => {
    const f = await fixture(); const taskPath = join(f.input.dshHome, 'v2-task.json')
    const route = { provider: 'super-relay', model: 'auto_model' }
    const v2Task = task({ version: 2, route, model: undefined,
      executionBudget: { mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [route] } })
    await writeFile(taskPath, v2Task, { mode: 0o600 })
    await writeFile(join(f.input.dshHome, 'settings.yaml'), `agent-default-model:
  provider: super-relay
  model: auto_model
llm-pi-ai:
  providers:
    super-relay:
      apiKeyEnv: PRIVATE_DO_NOT_READ
`, { mode: 0o600 })
    await expect(configureGoalAdmission(f.input, f.effective, taskPath)).resolves.toMatchObject({ sessionId: 'session-a' })
    const configured = await readFile(f.patchPath, 'utf8')
    expect(config(configured, 'dsh-enhanced-assistant-goals').executionBudget).toMatchObject({ mode: 'calls', routes: [route] })
    expect(config(configured, 'dsh-enhanced-assistant-delivery')).toMatchObject({ agentProvider: route.provider, agentModel: route.model, agentMaxOutputTokens: 8192 })
    expect(configured).not.toContain('PRIVATE_DO_NOT_READ')
    expect(parseSettingsDefaultModelRoute('{ agent-default-model: { provider: super-relay, model: auto_model } }')).toEqual(route)
    for (const source of ['[]', 'agent-default-model: super-relay', 'agent-default-model: { provider: super-relay }', 'agent-default-model: { provider: 3, model: auto_model }']) {
      expect(() => parseSettingsDefaultModelRoute(source)).toThrow(/settings/)
    }

    const cli = await fixture(); const cliTaskPath = join(cli.input.dshHome, 'v2-cli-task.json'); const bin = join(cli.input.dshHome, 'bin')
    await writeFile(cliTaskPath, v2Task, { mode: 0o600 }); await mkdir(bin)
    const effectivePath = join(cli.input.dshHome, 'effective.yaml'); const dshPath = join(bin, 'dsh')
    await writeFile(effectivePath, cli.effective, { mode: 0o600 })
    await writeFile(dshPath, '#!/bin/sh\ncat "$DSH_WEB_OWNER_EFFECTIVE"\n', { mode: 0o700 })
    await writeFile(join(cli.input.dshHome, 'settings.yaml'), 'agent-default-model: { provider: super-relay, model: auto_model }\n', { mode: 0o600 })
    const previousPath = process.env.PATH; const previousEffective = process.env.DSH_WEB_OWNER_EFFECTIVE
    process.env.PATH = `${bin}:${previousPath ?? ''}`; process.env.DSH_WEB_OWNER_EFFECTIVE = effectivePath
    try {
      await expect(runWebOwnerSetup(['--dsh-home', cli.input.dshHome, '--profile', cli.input.profile, '--workspace', cli.input.workspace, '--preset', cli.input.preset, '--goal-admission', cliTaskPath])).resolves.toBeUndefined()
    } finally {
      process.env.PATH = previousPath
      if (previousEffective === undefined) delete process.env.DSH_WEB_OWNER_EFFECTIVE
      else process.env.DSH_WEB_OWNER_EFFECTIVE = previousEffective
    }
    expect(config(await readFile(cli.patchPath, 'utf8'), 'dsh-enhanced-assistant-goals').executionBudget).toMatchObject({ mode: 'calls', routes: [route] })
  })

  test('v2 admits only the exact already configured route and calls budget without writing a credential', async () => {
    const f = await fixture()
    const effective = parseDocument(f.effective); effective.add({ id: 'agent-default-model', config: { provider: 'super-relay', model: 'relay-v2' } })
    const configured = effective.toString()
    const input = task({ version: 2, route: { provider: 'super-relay', model: 'relay-v2' }, model: undefined,
      executionBudget: { mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [{ provider: 'super-relay', model: 'relay-v2' }] } })
    const plan = prepareGoalAdmission(f.input, f.prepared.patch, configured, input, f.snapshot)
    expect(config(plan.patch, 'dsh-enhanced-assistant-goals').executionBudget).toEqual({ mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [{ provider: 'super-relay', model: 'relay-v2' }] })
    expect(config(plan.patch, 'dsh-enhanced-assistant-delivery')).toMatchObject({ agentProvider: 'super-relay', agentModel: 'relay-v2', agentMaxOutputTokens: 8192 })
    expect(() => parseGoalAdmissionTask(task({ version: 2, route: { provider: 'super-relay', model: 'wrong' }, model: undefined,
      executionBudget: { mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [{ provider: 'super-relay', model: 'relay-v2' }] } }))).toThrow(/budget route/)
    expect(() => prepareGoalAdmission(f.input, f.prepared.patch, configured, task({ version: 2, route: { provider: 'super-relay', model: 'wrong' }, model: undefined,
      executionBudget: { mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [{ provider: 'super-relay', model: 'wrong' }] } }), f.snapshot)).toThrow(/configured default/)
  })

  test('v2 repository delivery derives one bounded Actions grant, a finite wake, and exact policy permissions', async () => {
    const now = Date.now(); const f = await fixture(now); const effective = repositoryEffective(f.effective); const source = withoutKeychain(f.prepared.patch)
    const plan = prepareGoalAdmission(f.input, source, effective, repositoryTask({ expiresAt: now + 300_000 }), f.snapshot, now)
    expect(plan.repositoryDelivery).toEqual({ repository: 'octo/example', branch: 'automation/result', paths: ['result.txt'], acceptance: 'goal-outcome' })
    expect((parseDocument(plan.patch).toJS() as Array<{ id: string }>).some(row => row.id === 'dsh-enhanced-credentials-keychain')).toBe(false)
    expect(config(plan.patch, 'dsh-enhanced-assistant-goals').backgroundWake).toMatchObject({ ownerRouteId: plan.admissionId, budgetId: `${plan.admissionId}-runs`, maxDelayMs: 60_000, runTimeoutMs: 60_000 })
    const grant = config(plan.patch, 'dsh-enhanced-assistant-actions').grants.find((entry: { id: string }) => entry.id === `${plan.admissionId}-repository`)
    expect(grant).toMatchObject({ revision: 1, principalRecordId: f.snapshot.owner.id, principalVersion: f.snapshot.owner.version, workspace: f.input.workspace, agentPreset: f.input.preset,
      repository: 'octo/example', branch: 'automation/result', paths: ['result.txt'], credentialHandle: 'github', maxActions: 3, maxTotalBytes: 4096,
      repoWorkflow: { baseBranch: 'main', allowBranchCreate: false, allowPullRequest: true }, verifiedDelivery: { ownerRouteId: plan.admissionId, budgetId: `${plan.admissionId}-runs` } })
    const rules = config(plan.patch, 'dsh-enhanced-personal-assistant').assistantPolicy.rules as PolicyRule[]
    const policy = compilePolicy(rules)
    const agent = { kind: 'agent' as const, id: f.input.preset, workspace: f.input.workspace, principal: 'web/web/local/operator' }
    for (const initiator of ['external', 'background'] as const) {
      for (const id of ['action_github_grants', 'action_github_inspect', 'action_github_deliver', 'action_github_delivery_status', `action:github:${grant.id}`]) {
        expect(evaluatePolicy(policy, { subject: agent, action: 'execute', resource: { kind: 'tool', id }, context: { initiator } }).effect).toBe('allow')
      }
    }
    expect(evaluatePolicy(policy, { subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions', workspace: f.input.workspace, principal: 'web/web/local/operator' }, action: 'execute', resource: { kind: 'tool', id: `action:github:${grant.id}` }, context: { initiator: 'background' } }).effect).toBe('allow')
    expect(evaluatePolicy(policy, { subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, action: 'credential.use', resource: { kind: 'credential', id: 'github' }, context: { initiator: 'background' } }).effect).toBe('allow')
    expect(rules.find(rule => rule.id === `${plan.admissionId}-repository-credential`)?.subject).toEqual({ kind: 'background', id: 'dsh-enhanced-assistant-actions' })
  })

  it.each([
    { provider: 'environment', environmentName: 'GITHUB_TOKEN' },
    { provider: 'macos-keychain', service: 'dsh/github', account: 'operator' },
    { provider: 'linux-secret-service', service: 'dsh/github', account: 'operator' },
  ])('accepts an existing literal $provider credential handle without copying it to the target', async handleShape => {
    const now = Date.now(); const f = await fixture(now)
    const handle = { id: 'github', ...handleShape, consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 30_000 }
    const plan = prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), repositoryEffective(f.effective, [handle]), repositoryTask({ expiresAt: now + 300_000 }), f.snapshot, now)
    expect((parseDocument(plan.patch).toJS() as Array<{ id: string }>).some(row => row.id === 'dsh-enhanced-credentials-keychain')).toBe(false)
    expect(config(plan.patch, 'dsh-enhanced-assistant-actions').grants).toEqual(expect.arrayContaining([expect.objectContaining({ credentialHandle: 'github' })]))
  })

  test('intermediate repository delivery requires an explicit accepted-step choice', async () => {
    const now = Date.now(), f = await fixture(now)
    const plan = prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), repositoryEffective(f.effective), repositoryTask({ expiresAt: now + 300_000, acceptance: 'goal-step' }), f.snapshot, now)
    expect(plan.repositoryDelivery?.acceptance).toBe('goal-step')
    const grants = config(plan.patch, 'dsh-enhanced-assistant-actions').grants
    expect(grants.find((entry: { id: string }) => entry.id === `${plan.admissionId}-repository`).verifiedDelivery.acceptance).toBe('goal-step')
    expect(() => parseGoalAdmissionTask(repositoryTask({ acceptance: 'model-says-done' }))).toThrow('invalid repository acceptance')
  })

  test('formal repository events create a finite owner-bound source and exact wake/credential permissions', async () => {
    const now = Date.now(), f = await fixture(now)
    const handle = { id: 'github', provider: 'linux-protected-file', path: '/tmp/github-token', consumers: ['dsh-enhanced-assistant-actions', 'dsh-enhanced-event-triggers'], purposes: ['github.commit', 'github.observe'], maxLeaseMs: 30_000 }
    const effective = repositoryEffective(f.effective, [handle])
    const events = { credentialHandle: 'github', maxPolls: 12, maxFires: 2, pollIntervalMs: 5000, requestTimeoutMs: 10000 }
    const outcome = { requiredChecks: [{ name: 'tests', appId: 7 }], reviewerIds: [42], minApprovals: 1, timeoutMs: 10000, freshnessMs: 30000 }
    const task = repositoryTask({ expiresAt: now + 300_000, acceptance: 'goal-step', maxActions: 30, outcome, events })
    const plan = prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), effective, task, f.snapshot, now, undefined, eventSupport)
    const source = config(plan.patch, 'dsh-enhanced-event-triggers'), trigger = source.triggers[0]
    expect(source.databasePath).toBe("dshHomePath('event-triggers/state.sqlite')")
    expect(source).toMatchObject({ pollerEnabled: true, pollIntervalMs: 5000, requestTimeoutMs: 10000 })
    expect(trigger).toMatchObject({ kind: 'github-repository', observerLifetime: 'goal', repository: 'octo/example', branch: 'automation/result', maxFires: 2,
      observer: { principalRecordId: f.snapshot.owner.id, principalVersion: f.snapshot.owner.version, ownerRouteId: plan.admissionId, expiresAt: now + 300_000 } })
    expect(config(plan.patch, 'dsh-enhanced-assistant-goals')).toMatchObject({ eventWaits: true, preauthorizedSchedule: true })
    const policy = config(plan.patch, 'dsh-enhanced-personal-assistant').assistantPolicy
    expect(policy.budgets).toEqual(expect.arrayContaining([expect.objectContaining({ id: `${trigger.id}-polls`, limit: 12 }), expect.objectContaining({ id: `${plan.admissionId}-runs`, limit: 3 })]))
    expect(policy.rules).toEqual(expect.arrayContaining([expect.objectContaining({ actions: ['wait-for-event'], resource: { kind: 'automation', id: trigger.automationId } }), expect.objectContaining({ resource: { kind: 'network', id: 'https://api.github.com/repos/octo/example' }, budget: { id: `${trigger.id}-polls`, amount: 1 } })]))
    const beforeNativeWait = compilePolicy(policy.rules.filter((rule: PolicyRule) => rule.id !== `${trigger.id}-native-wait`))
    for (const action of ['wait', 'pause']) {
      expect(evaluatePolicy(beforeNativeWait, { subject: { kind: 'agent', id: f.input.preset, workspace: f.input.workspace, principal: 'web/web/local/operator' }, action,
        resource: { kind: 'goal', id: 'business-context' }, context: { initiator: 'background' } }).effect).toBe('deny')
      expect(evaluatePolicy(compilePolicy(policy.rules), { subject: { kind: 'agent', id: f.input.preset, workspace: f.input.workspace, principal: 'web/web/local/operator' }, action,
        resource: { kind: 'goal', id: 'business-context' }, context: { initiator: 'background' } }).effect).toBe('allow')
    }
    const ctx = new Context()
    try {
      await ctx.plugin(AssistantPolicyService, { databasePath: join(f.input.dshHome, 'event-budget-regression.sqlite'), budgets: policy.budgets })
      const reserve = (budgetId: string, id: string, key: string) => ctx.assistantPolicy.reserve({ budgetId, subject: { kind: 'background', id }, amount: 1, idempotencyKey: key })
      ctx.assistantPolicy.finalize(reserve(`${plan.admissionId}-runs`, 'wake', 'wake-before-event').reservationId, 1)
      ctx.assistantPolicy.finalize(reserve(`${trigger.id}-runs`, trigger.automationId, 'event-1').reservationId, 1)
      ctx.assistantPolicy.finalize(reserve(`${trigger.id}-runs`, trigger.automationId, 'event-2').reservationId, 1)
      expect(() => reserve(`${trigger.id}-runs`, trigger.automationId, 'event-3')).toThrow(/exhausted/)
      expect(reserve(`${plan.admissionId}-runs`, 'wake', 'wake-after-event').status).toBe('reserved')
    } finally { await ctx.fiber.restart() }
    expect(prepareGoalAdmission(f.input, plan.patch, effective, task, f.snapshot, now + 1, undefined, eventSupport).patch).toBe(plan.patch)
    expect(() => prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), repositoryEffective(f.effective), task, f.snapshot, now, undefined, eventSupport)).toThrow('github.observe')
    expect(() => parseGoalAdmissionTask(repositoryTask({ acceptance: 'goal-step', maxActions: 7, outcome, events }))).toThrow('task limit')
  })

  test('formal repository outcome binds the granted target and leaves artifact checks on the step', async () => {
    const now = Date.now(), f = await fixture(now)
    const outcome = { requiredChecks: [{ name: 'tests', appId: 42 }], reviewerIds: [7], minApprovals: 1, timeoutMs: 10_000, freshnessMs: 30_000 }
    const value = repositoryTask({ expiresAt: now + 300_000, acceptance: 'goal-step', maxActions: 20, outcome })
    const plan = prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), repositoryEffective(f.effective), value, f.snapshot, now)
    const verifier = config(plan.patch, 'dsh-enhanced-assistant-verifier')
    expect(verifier.authorities).toContainEqual(expect.objectContaining({ ...outcome, kind: 'repository-readback', grantId: `${plan.admissionId}-repository`, grantRevision: 1 }))
    expect(verifier.profiles.find((p: { taskKind: string }) => p.taskKind === 'goal-step').criteria[0].kind).toBe('isolated-process-behavior')
    expect(verifier.profiles.find((p: { taskKind: string }) => p.taskKind === 'goal-outcome').criteria).toMatchObject([
      { kind: 'target-readback', objectId: 'octo/example:automation/result', expected: [{ pointer: '/ready', value: true }] },
    ])
    expect(prepareGoalAdmission(f.input, plan.patch, repositoryEffective(f.effective), value, f.snapshot, now).patch).toBe(plan.patch)
    expect(() => parseGoalAdmissionTask(repositoryTask({ outcome, maxActions: 20 }))).toThrow('explicit goal-step')
    expect(() => parseGoalAdmissionTask(repositoryTask({ outcome, acceptance: 'goal-step', maxActions: 6 }))).toThrow('task limit')
    expect(() => parseGoalAdmissionTask(repositoryTask({ outcome: { ...outcome, minApprovals: 2 }, acceptance: 'goal-step', maxActions: 20 }))).toThrow('approvals')
  })

  test('v2 admits an operator-projected external repository grant without deriving credentials or grant authority', async () => {
    const now = Date.now(), f = await fixture(now)
    const outcome = { requiredChecks: [{ name: 'tests', appId: 42 }], reviewerIds: [7], minApprovals: 1, timeoutMs: 10_000, freshnessMs: 30_000 }
    const input = repositoryTask({ credentialHandle: undefined, externalGrantId: 'operator-repository-grant', expiresAt: now + 300_000, acceptance: 'goal-step', maxActions: 20, outcome })
    const effective = externalRepositoryEffective(f.effective, f.input, f.snapshot, now)
    const plan = prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), effective, input, f.snapshot, now)
    const actions = config(plan.patch, 'dsh-enhanced-assistant-actions')
    expect(actions.grants).toEqual([])
    expect(actions.externalGrants).toEqual(config(effective, 'dsh-enhanced-assistant-actions').externalGrants)
    expect(actions.broker).toEqual(config(effective, 'dsh-enhanced-assistant-actions').broker)
    expect(plan.patch).not.toContain('credentials-keychain')
    const verifier = config(plan.patch, 'dsh-enhanced-assistant-verifier')
    expect(verifier.authorities).toContainEqual(expect.objectContaining({ kind: 'repository-readback', grantId: 'operator-repository-grant', grantRevision: 7, ...outcome }))
    const rules = config(plan.patch, 'dsh-enhanced-personal-assistant').assistantPolicy.rules as PolicyRule[]
    expect(rules.some(rule => rule.id.endsWith('-repository-credential') || rule.actions?.includes('credential.use'))).toBe(false)
    const policy = compilePolicy(rules.filter(rule => rule.id.startsWith(`${plan.admissionId}-repository-`))), agent = { kind: 'agent' as const, id: f.input.preset, workspace: f.input.workspace, principal: 'web/web/local/operator' }
    for (const tool of ['action:github:operator-repository-grant', 'action_github_grants', 'action_github_inspect', 'action_github_deliver', 'action_github_delivery_status']) {
      expect(evaluatePolicy(policy, { subject: agent, action: 'execute', resource: { kind: 'tool', id: tool }, context: { initiator: 'external' } }).effect).toBe('allow')
    }
    for (const tool of ['action_github_commit', 'action_github_pr']) {
      expect(evaluatePolicy(policy, { subject: agent, action: 'execute', resource: { kind: 'tool', id: tool }, context: { initiator: 'external' } }).effect).toBe('deny')
    }
    expect(evaluatePolicy(policy, { subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions', workspace: f.input.workspace, principal: agent.principal }, action: 'execute', resource: { kind: 'tool', id: 'action:github:operator-repository-grant' }, context: { initiator: 'background' } }).effect).toBe('allow')
    expect(evaluatePolicy(policy, { subject: { kind: 'background', id: 'delivery-worker', workspace: f.input.workspace, principal: agent.principal }, action: 'reconcile', resource: { kind: 'automation', id: 'verified-delivery-123' }, context: { initiator: 'background' } }).effect).toBe('allow')
    expect(evaluatePolicy(policy, { subject: { kind: 'background', id: 'assistant-actions-verified-delivery/v1', workspace: f.input.workspace, principal: agent.principal }, action: 'send', resource: { kind: 'message', id: f.snapshot.binding.id }, context: { initiator: 'background' } }).effect).toBe('allow')
    expect(evaluatePolicy(policy, { subject: { kind: 'background', id: 'dsh-enhanced-assistant-actions' }, action: 'credential.use', resource: { kind: 'credential', id: 'repo-fixture' }, context: { initiator: 'background' } }).effect).toBe('deny')
    expect(prepareGoalAdmission(f.input, plan.patch, effective, input, f.snapshot, now + 1).patch).toBe(plan.patch)
  })

  test('external repository events retain issued broker authority and finite observation budgets without Host credentials', async () => {
    const now = Date.now(), f = await fixture(now)
    const outcome = { requiredChecks: [{ name: 'tests', appId: 42 }], reviewerIds: [7], minApprovals: 1, timeoutMs: 10_000, freshnessMs: 30_000 }
    const events = { maxPolls: 4, maxFires: 1, pollIntervalMs: 1000, requestTimeoutMs: 1000 }
    const input = repositoryTask({ credentialHandle: undefined, externalGrantId: 'operator-repository-grant', expiresAt: now + 300_000, acceptance: 'goal-step', maxActions: 43, outcome, events })
    const effective = externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { grant.maxActions = 43; grant.maxCostUnits = 63 })
    const plan = prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), effective, input, f.snapshot, now, undefined, eventSupport)
    const triggerId = `${plan.admissionId}-repository-events`, source = config(plan.patch, 'dsh-enhanced-event-triggers')
    expect(source.triggers).toEqual([expect.objectContaining({ id: triggerId, kind: 'github-repository', observerLifetime: 'goal',
      externalGrant: { id: 'operator-repository-grant', revision: 7, digest: 'a'.repeat(64) },
      observer: expect.objectContaining({ ownerRouteId: plan.admissionId, expiresAt: now + 300_000 }) })])
    expect(source.triggers[0]).not.toHaveProperty('credentialHandle')
    expect(plan.patch).not.toContain('credentials-keychain')
    expect(config(plan.patch, 'dsh-enhanced-assistant-actions').externalGrants).toEqual(config(effective, 'dsh-enhanced-assistant-actions').externalGrants)
    const { rules, budgets } = config(plan.patch, 'dsh-enhanced-personal-assistant').assistantPolicy
    expect(rules.some((rule: PolicyRule) => rule.actions?.includes('credential.use'))).toBe(false)
    expect(budgets).toEqual(expect.arrayContaining([expect.objectContaining({ id: `${triggerId}-polls`, metric: 'repository-observations', limit: 4 })]))
    expect(prepareGoalAdmission(f.input, plan.patch, effective, input, f.snapshot, now + 1, undefined, eventSupport).patch).toBe(plan.patch)
    const insufficient = externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { grant.maxActions = 43; grant.maxCostUnits = 62 })
    expect(() => prepareGoalAdmission(f.input, withoutKeychain(f.prepared.patch), insufficient, input, f.snapshot, now, undefined, eventSupport)).toThrow('observation and outcome cost')
    expect(() => parseGoalAdmissionTask(repositoryTask({ credentialHandle: undefined, externalGrantId: 'operator-repository-grant', acceptance: 'goal-step', maxActions: 42, outcome, events }))).toThrow('task limit')
    expect(() => parseGoalAdmissionTask(repositoryTask({ acceptance: 'goal-step', maxActions: 43, outcome, events }))).toThrow('matching broker or observation credential')
  })

  test('external repository admission rejects mixed credentials and projections outside its exact owner, operation, and readback fence', async () => {
    const now = Date.now(), f = await fixture(now)
    const outcome = { requiredChecks: [{ name: 'tests', appId: 42 }], reviewerIds: [7], minApprovals: 1, timeoutMs: 10_000, freshnessMs: 30_000 }
    const externalTask = repositoryTask({ credentialHandle: undefined, externalGrantId: 'operator-repository-grant', expiresAt: now + 300_000, acceptance: 'goal-step', maxActions: 20, outcome })
    expect(() => parseGoalAdmissionTask(repositoryTask({ externalGrantId: 'operator-repository-grant' }))).toThrow('exactly one')
    expect(() => parseGoalAdmissionTask(repositoryTask({ credentialHandle: undefined, externalGrantId: 'operator-repository-grant', events: { credentialHandle: 'github', maxPolls: 4, maxFires: 1, pollIntervalMs: 1000, requestTimeoutMs: 1000 }, acceptance: 'goal-step', maxActions: 20, outcome }))).toThrow('repository events')
    const source = withoutKeychain(f.prepared.patch)
    expect(() => prepareGoalAdmission(f.input, source, externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { grant.sessionId = 'other-session' }), externalTask, f.snapshot, now)).toThrow('exactly match')
    expect(() => prepareGoalAdmission(f.input, source, externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { (grant.owner as Record<string, unknown>).bindingGeneration = 2 }), externalTask, f.snapshot, now)).toThrow('exactly match')
    expect(() => prepareGoalAdmission(f.input, source, externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { grant.credentialHandle = 'github' }), externalTask, f.snapshot, now)).toThrow('invalid external repository grant')
    expect(() => prepareGoalAdmission(f.input, source, externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { grant.allowedOperations = ['commit', 'inspect'] }), externalTask, f.snapshot, now)).toThrow('exactly match')
    expect(() => prepareGoalAdmission(f.input, source, externalRepositoryEffective(f.effective, f.input, f.snapshot, now, grant => { grant.allowedInspectKinds = ['repository', 'branch', 'file'] }), externalTask, f.snapshot, now)).toThrow('exactly match')
  })

  test('repository delivery rejects absent credentials, foreign owners, paths, deadlines, and conflicting reruns', async () => {
    const now = Date.now(); const f = await fixture(now); const effective = repositoryEffective(f.effective); const source = withoutKeychain(f.prepared.patch)
    expect(() => parseGoalAdmissionTask(repositoryTask({ paths: ['other.txt'] }))).toThrow(/repository delivery/)
    expect(() => parseGoalAdmissionTask(repositoryTask({ maxActions: 2 }))).toThrow(/task limit/)
    expect(() => parseGoalAdmissionTask(repositoryTask({ openPullRequest: false, maxActions: 1 }))).toThrow(/task limit/)
    expect(() => parseGoalAdmissionTask(task({ repositoryDelivery: {} }))).toThrow(/fields|repository delivery/)
    expect(() => prepareGoalAdmission(f.input, f.prepared.patch, repositoryEffective(f.effective, []), repositoryTask({ expiresAt: now + 300_000 }), f.snapshot, now)).toThrow(/credential handle/)
    expect(() => prepareGoalAdmission(f.input, repositorySource(f.prepared.patch, [{ id: 'github', provider: 'linux-protected-file', path: '/tmp/github-token', consumers: ['dsh-enhanced-assistant-actions'], purposes: ['github.commit'], maxLeaseMs: 29_999 }]), effective, repositoryTask({ expiresAt: now + 300_000 }), f.snapshot, now)).toThrow(/credential handle/)
    expect(() => prepareGoalAdmission(f.input, source, effective, repositoryTask({ expiresAt: now + 120_000 }), f.snapshot, now)).toThrow(/deadline/)
    expect(() => prepareGoalAdmission(f.input, source, effective, repositoryTask({ expiresAt: now + 180_000 }), f.snapshot, now)).toThrow(/deadline/)
    expect(() => prepareGoalAdmission(f.input, source, effective, repositoryTask({ expiresAt: f.profile.grant.expiresAt + 1 }), f.snapshot, now)).toThrow(/deadline/)
    expect(() => prepareGoalAdmission(f.input, source, effective, repositoryTask({ expiresAt: now + 300_000 }), { ...f.snapshot, owner: { ...f.snapshot.owner, version: f.snapshot.owner.version + 1 } }, now)).toThrow(/owner/)
    expect(() => prepareGoalAdmission(f.input, repositorySource(f.prepared.patch).replace('id: github', 'id: !!str github'), effective, repositoryTask({ expiresAt: now + 300_000 }), f.snapshot, now)).toThrow(/tagged credential handles/)
    const input = repositoryTask({ expiresAt: now + 300_000 })
    const first = prepareGoalAdmission(f.input, source, effective, input, f.snapshot, now)
    const second = prepareGoalAdmission(f.input, first.patch, effective, input, f.snapshot, now)
    expect(second.patch).toBe(first.patch)
    const conflicting = parseDocument(first.patch)
    if (!isSeq(conflicting.contents)) throw new Error('fixture expected rows')
    const personal = conflicting.contents.items.find(row => yamlId(row) === 'dsh-enhanced-personal-assistant')
    if (!isMap(personal)) throw new Error('fixture expected personal assistant')
    const personalConfig = personal.get('config', true)
    if (!isMap(personalConfig)) throw new Error('fixture expected personal config')
    const assistantPolicy = personalConfig.get('assistantPolicy', true)
    const rules = isMap(assistantPolicy) ? assistantPolicy.get('rules', true) : undefined
    if (!isSeq(rules)) throw new Error('fixture expected rules')
    const agentRule = rules.items.find(rule => yamlId(rule) === `${first.admissionId}-repository-agent`)
    const resource = isMap(agentRule) ? agentRule.get('resource', true) : undefined
    if (!isMap(resource)) throw new Error('fixture expected repository rule')
    resource.set('id', 'action:github:other')
    expect(() => prepareGoalAdmission(f.input, conflicting.toString(), effective, input, f.snapshot, now)).toThrow(/existing rules entry differs/)
    expect(() => prepareGoalAdmission(f.input, first.patch.replace(`id: ${first.admissionId}-repository-agent`, `id: !!str ${first.admissionId}-repository-agent`), effective, input, f.snapshot, now)).toThrow(/tagged rules/)
  })

  test('v2 is not bound to the expired DeepSeek contract while v1 remains protected', async () => {
    const contractExpiry = Date.parse('2026-10-08T00:00:00.000Z')
    const f = await fixture(contractExpiry)
    const effective = parseDocument(f.effective); effective.add({ id: 'agent-default-model', config: { provider: 'super-relay', model: 'auto_model' } })
    const route = { provider: 'super-relay', model: 'auto_model' }
    const v2Task = task({ version: 2, route, model: undefined,
      executionBudget: { mode: 'calls', modelCalls: 3, toolCalls: 3, durationMs: 120_000, maxOutputTokensPerCall: 8192, routes: [route] } })
    expect(() => prepareGoalAdmission(f.input, f.prepared.patch, effective.toString(), v2Task, f.snapshot, contractExpiry)).not.toThrow()
    expect(() => prepareGoalAdmission(f.input, f.prepared.patch, effective.toString(), task(), f.snapshot, contractExpiry)).toThrow(/model contract expired/)
  })

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
    const profiles = verifier.profiles.filter((profile: { id: string }) => profile.id.startsWith(plan.admissionId))
    expect(profiles).toHaveLength(2)
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKind: 'goal-step', validityMs: 120_000, bounds: { maxDurationMs: 20_000, maxEvidenceBytes: 8192 } }),
      expect.objectContaining({ taskKind: 'goal-outcome', validityMs: 120_000, bounds: { maxDurationMs: 20_000, maxEvidenceBytes: 8192 } }),
    ]))
    expect(goals.executionBudget).toMatchObject({ inputTokens: 2_097_152, maxOutputTokensPerCall: 8192 })
    expect(goals.strategy).toBeUndefined()
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

  test('optionally admits bounded native strategies without extending the goal budget or isolation grant', async () => {
    const f = await fixture()
    const input = task({ strategy: { maxRunsPerGoal: 2 } })
    const first = prepareGoalAdmission(f.input, f.prepared.patch, f.effective, input, f.snapshot, Date.now())
    const second = prepareGoalAdmission(f.input, first.patch, first.patch, input, f.snapshot, Date.now())
    expect(second.patch).toBe(first.patch)
    const goals = config(first.patch, 'dsh-enhanced-assistant-goals')
    expect(goals.strategy).toMatchObject({ maxDurationMs: 30000, maxRunsPerGoal: 2 })
    expect(goals.executionBudget).toMatchObject({ modelCalls: 3, toolCalls: 3 })
    const rules = config(first.patch, 'dsh-enhanced-personal-assistant').assistantPolicy.rules
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `${first.admissionId}-strategy-goal`, actions: ['delegate'], subject: expect.objectContaining({ workspace: f.input.workspace, id: f.input.preset }), resource: { kind: 'goal', id: 'business-context' } }),
      expect.objectContaining({ id: `${first.admissionId}-strategy-tool`, actions: ['execute'], resource: { kind: 'tool', id: 'goal_strategy' } }),
    ]))
    expect(inspectAutonomyProfile(first.patch, f.input.profile, f.input.dshHome).grant).toEqual(f.profile.grant)
    expect(() => parseGoalAdmissionTask(task({ strategy: { maxDurationMs: 0 } }))).toThrow()
    expect(() => parseGoalAdmissionTask(task({ strategy: { maxChildren: 100 } }))).toThrow()
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
    await expect(configureGoalAdmission(f.input, f.effective, path, 'session-a', async () => `${f.effective}\n# changed`)).rejects.toThrow(/effective configuration changed/)
    expect(await readFile(f.patchPath, 'utf8')).toBe(f.prepared.patch)
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

  test('discovers only real idle owner Sessions, auto-selects one, and rejects ambiguity without changing the patch', async () => {
    const f = await fixture(); const path = join(f.input.dshHome, 'task.json')
    await writeFile(path, task(), { mode: 0o600 })
    await expect(listGoalAdmissionSessions(f.input, f.effective)).resolves.toEqual(['session-a'])
    await expect(configureGoalAdmission(f.input, f.effective, path)).resolves.toMatchObject({ sessionId: 'session-a' })
    const configured = await readFile(f.patchPath, 'utf8')
    const store = new DeliveryStore({ path: f.prepared.databasePath })
    store.createBinding({ conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'session-b' }, principal: f.snapshot.binding.principal,
      workspace: f.input.workspace, agentPreset: f.input.preset, sessionId: 'session-b', policyRef: 'owner-dm' })
    store.close()
    await expect(listGoalAdmissionSessions(f.input, configured)).resolves.toEqual(['session-a', 'session-b'])
    await expect(configureGoalAdmission(f.input, configured, path)).rejects.toThrow(/multiple idle owner sessions; choose --session-id from: session-a, session-b/)
    expect(await readFile(f.patchPath, 'utf8')).toBe(configured)
  })

  test('parses only complete bounded JSON task data', () => {
    const parsed = parseGoalAdmissionTask(task())
    expect(parsed.version === 1 && parsed.model).toBe('deepseek-v4-flash')
    expect(() => parseGoalAdmissionTask('{"version":1}')).toThrow(/fields/)
    expect(() => parseGoalAdmissionTask(`${task()} trailing`)).toThrow(/JSON/)
  })

  test('requires an execution budget strictly larger than the native round plus both verification windows', () => {
    const executionBudget = { modelCalls: 3, toolCalls: 3, inputTokens: 2_097_152, outputTokens: 8192, maxOutputTokensPerCall: 8192 }
    expect(() => parseGoalAdmissionTask(task({ executionBudget: { ...executionBudget, durationMs: 100_000 } }))).toThrow(/cannot cover/)
    expect(() => parseGoalAdmissionTask(task({ executionBudget: { ...executionBudget, durationMs: 99_999 } }))).toThrow(/cannot cover/)
    expect(parseGoalAdmissionTask(task({ executionBudget: { ...executionBudget, durationMs: 100_001 } }))).toMatchObject({ executionBudget: { durationMs: 100_001 } })
  })

  test('admits a longer native round when each verification window remains short', async () => {
    const f = await fixture()
    const executionBudget = { modelCalls: 3, toolCalls: 3, inputTokens: 2_097_152, outputTokens: 8192, maxOutputTokensPerCall: 8192, durationMs: 210_000 }
    const verification = { artifactPath: 'result.txt', command: 'node verify.mjs', maxRuns: 4, maxTotalDurationMs: 100_000, maxDurationMs: 20_000, maxOutputBytes: 4096,
      cases: [{ stdin: 'one\n', expectedStdout: 'one\n', expectedExitCode: 0 }, { stdin: 'two\n', expectedStdout: 'two\n', expectedExitCode: 0 }] }
    const plan = prepareGoalAdmission(f.input, f.prepared.patch, f.effective,
      task({ stepMaxDurationMs: 120_000, executionBudget, verification }), f.snapshot)
    const profiles = config(plan.patch, 'dsh-enhanced-assistant-verifier').profiles.filter((profile: { id: string }) => profile.id.startsWith(plan.admissionId))
    expect(profiles).toHaveLength(2)
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ validityMs: 210_000, bounds: { maxDurationMs: 40_000, maxEvidenceBytes: 8192 } }),
      expect.objectContaining({ validityMs: 210_000, bounds: { maxDurationMs: 40_000, maxEvidenceBytes: 8192 } }),
    ]))
  })
})
