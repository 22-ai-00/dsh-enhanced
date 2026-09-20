// Owner-run Day 1 proof: a real bounded Growth wake queues a durable source
// job, then a fresh non-Agent Host claims it and performs the Docker check.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AssistantPolicyService } from '../../plugins/assistant-policy/lib/index.js'
import { AssistantAutomationsService } from '../../plugins/assistant-automations/lib/index.js'
import { loadTrustConfig } from '../../plugins/plugin-control-plane/lib/trust.js'
import { AssistantGrowthDriverService } from '../../plugins/assistant-growth-driver/lib/index.js'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { createSourceModelControlFixture } from './source-model-control-fixture.mjs'

assert.equal(process.env.DSH_SOURCE_MODEL_LIVE, '1', 'set DSH_SOURCE_MODEL_LIVE=1')
const image = process.env.DSH_SOURCE_BUILD_IMAGE
assert.match(image ?? '', /^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/)
assert.ok(process.env.DSH_SOURCE_MODEL_EVIDENCE, 'set DSH_SOURCE_MODEL_EVIDENCE')
assert.ok(process.env.DSH_SOURCE_MODEL_TASK, 'set DSH_SOURCE_MODEL_TASK')
const task = JSON.parse(await readFile(resolve(process.env.DSH_SOURCE_MODEL_TASK), 'utf8'))
assert.ok(task && typeof task.name === 'string' && typeof task.capability === 'string' && typeof task.context === 'string', 'task must contain name, capability, context')
assert.match(task.name, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
const repository = await realpath(process.env.DSH_SOURCE_MODEL_REPOSITORY ?? fileURLToPath(new URL('../..', import.meta.url)))
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
assert.equal(git('status', '--porcelain=v1', '--', `plugins/${task.name}`), '', 'candidate plugin scope must be a clean HEAD checkout')
const baseCommit = git('rev-parse', 'HEAD')
const dshPackage = resolve(process.env.DSH_SOURCE_MODEL_DSH_PACKAGE ?? '/home/jiataorui/.local/share/pnpm/nodejs/24.7.0/lib/node_modules/@deepseek-ai/dsh/package.json')
const installed = createRequire(dshPackage)
const Pi = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-launch-environment')).href)
const root = await mkdtemp(join(tmpdir(), 'dsh-source-durable-'))
const progress = stage => process.stderr.write(JSON.stringify({ stage, at: new Date().toISOString() }) + '\n')
const digest = value => createHash('sha256').update(value).digest('hex')
const evidencePath = resolve(process.env.DSH_SOURCE_MODEL_EVIDENCE)
const preflight = process.env.DSH_SOURCE_MODEL_PREFLIGHT === '1'
const reasoningProbe = process.env.DSH_SOURCE_MODEL_REASONING_PROBE
assert.ok(reasoningProbe === undefined || reasoningProbe === 'low', 'reasoning probe must be low or omitted')
const proof = { kind: preflight ? 'durable-source-wiring-preflight' : 'real-day1-durable-source-job', root, passed: false, checkedAt: new Date().toISOString(), repository, baseCommit, image, task: { name: task.name, capability: task.capability }, stages: [], modelCalls: [], toolCalls: [], candidateFiles: [], limits: [
  'fixture uses one owner route and no approval, release, publication, or activation',
  'schema-4 fixture binds a local empty catalog; it does not exercise release adapters',
  'queued Context replacement in one Node process; running crash recovery is not exercised',
  'owner route, empty goal/skill history and tool approval are fixtures',
  'owner instrumentation records the private Host preparation method without changing its outcome',
] }
const mark = stage => { proof.stages.push({ stage, at: Date.now() }); progress(stage) }
let first; let second; let routeSecret
const mounts = new Map()
async function closeContext(ctx) {
  if (!ctx) return
  const owned = mounts.get(ctx)
  if (owned) { await owned.control?.dispose(); await owned.automationFiber?.dispose(); await owned.policyFiber?.dispose(); mounts.delete(ctx) }
  await ctx.fiber.dispose()
}
function query(path, sql, ...values) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all(...values).map(row => ({ ...row })) } finally { db.close() }
}
try {
  proof.task = { ...task, digest: digest(JSON.stringify(task)) }
  proof.runtimeDigests = Object.fromEntries(await Promise.all([
    'scripts/e2e/source-model-durable-smoke.mjs',
    'scripts/e2e/source-model-control-fixture.mjs',
    'plugins/assistant-growth-driver/lib/growth-agent.js',
    'plugins/assistant-growth-driver/lib/source-edits.js',
    'plugins/plugin-control-plane/lib/source-jobs.js',
  ].map(async path => [path, digest(await readFile(resolve(fileURLToPath(new URL('../..', import.meta.url)), path)))])))
  const principal = 'source-durable-owner'; const preset = 'personal-memory'; const routeId = 'source-durable-route'
  const scope = { principalId: principal, workspace: repository, preset, ownerRouteId: routeId }
  const policyRules = [
    { id: 'growth-tools', effect: 'allow', subject: { kind: 'agent', id: preset, workspace: repository, principal }, actions: ['execute'], resource: { kind: 'tool', id: 'growth_*' }, context: { initiators: ['background'] } },
    { id: 'source-tools', effect: 'allow', subject: { kind: 'agent', id: preset, workspace: repository, principal }, actions: ['execute'], resource: { kind: 'tool', id: 'plugin_source_*' }, context: { initiators: ['background'] } },
    { id: 'automation-reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: repository, principal }, actions: ['reconcile'], resource: { kind: 'automation', id: 'source-job-*' }, context: { initiators: ['background'] } },
    { id: 'automation-execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: repository, principal }, actions: ['execute'], resource: { kind: 'automation', id: 'source-job-*' }, context: { initiators: ['background'] } },
  ]
  const serviceConfig = control => ({ catalogPath: control.catalogPath, statePath: control.statePath, trustPath: control.trustPath,
    sourceBuild: { dockerPath: '/usr/bin/docker', image, profile: 'repository', timeoutMs: 1_800_000, memoryMiB: 16_384, cpus: 8, pidsLimit: 1_024, workspaceMiB: 4_096, temporaryMiB: 2_048, outputBytes: 65_536, repositorySandbox: { seccompPath: resolve(repository, 'scripts/isolation/source-builder-seccomp.json') } },
    sourceJobs: frozenSourceJobs })
  const mountCommon = async ctx => {
    const owned = {}; mounts.set(ctx, owned)
    owned.policyFiber = ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), proposalMaintenanceIntervalMs: 0, budgets: [
      { id: 'source-model-wakes', metric: 'automation-runs', limit: 1, periodMs: 3_600_000, scope: 'subject' },
      { id: 'source-job-runs', metric: 'automation-runs', limit: 1, periodMs: 3_600_000, scope: 'subject' },
    ], rules: policyRules })
    await owned.policyFiber
    ctx.provide('assistantDelivery', { validateOwnerRoute: () => ({ receiptVersion: 2, authorityId: routeId, authorityHash: 'a'.repeat(64), principalId: principal, principalRecordId: 'source-durable-record', principalVersion: 1, workspace: repository, agentPreset: preset, bindingVersion: 1, generation: 1 }) })
    owned.automationFiber = ctx.plugin(AssistantAutomationsService, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
    await owned.automationFiber
    owned.control = await createSourceModelControlFixture({ ctx, root, repository, image, trustSchemaVersion: 4, reuseTrust: ctx === second, serviceConfig })
    await new Promise(done => setImmediate(done))
    return { control: owned.control, automations: ctx.get('assistantAutomations') }
  }
  const frozenSourceJobs = { authorityId: 'source-durable-authority', expiresAt: Date.now() + 3_600_000, maxSubmissions: 1, repository, ownerRouteId: routeId, principalId: principal, workspace: repository, preset, budgetId: 'source-job-runs', budgetAmount: 1 }
  first = new Context()
  const { control } = await mountCommon(first)
  const trust = await loadTrustConfig(control.trustPath)
  assert.equal(trust.ledger.path, join(control.statePath, 'control.sqlite'))
  assert.equal(trust.catalog.path, control.catalogPath)
  const trustFileDigest = digest(await readFile(control.trustPath))
  proof.trustFileDigest = trustFileDigest
  const caller = { ...scope, principalRecordId: 'source-durable-record', principalVersion: 1 }
  const controlDb = join(control.statePath, 'control.sqlite')
  const cp = first.get('pluginControlPlane')
  const inspectSource = control.service.inspectSource.bind(control.service)
  control.service.inspectSource = async input => { const result = await inspectSource(input); proof.reads ??= []; proof.reads.push({ name: result.name, baseCommit: result.baseCommit, paths: result.contents.map(file => file.path) }); return result }
  if (preflight) {
    const snapshot = await cp.inspectSource({ repository, name: task.name, paths: ['README.md'] })
    const gap = cp.recordGap({ idempotencyKey: 'preflight', capability: 'wiring preflight', context: 'No model or Docker execution', expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    const job = await cp.enqueueSourceJob({ gapId: gap.id, name: task.name, repository, files: snapshot.contents, expectedBaseCommit: baseCommit, ttlMs: 3_600_000, owner: caller, idempotencyKey: 'preflight', signal: new AbortController().signal, assertCurrent: () => {} })
    assert.equal(job.status, 'queued')
    await closeContext(first); first = undefined
    second = new Context(); const rebound = await mountCommon(second)
    assert.equal(digest(await readFile(rebound.control.trustPath)), trustFileDigest)
    assert.equal(second.get('pluginControlPlane').inspectSourceJob({ id: job.id, owner: caller }).status, 'queued')
    assert.deepEqual(query(join(root, 'automations.sqlite'), 'SELECT id FROM automation_runs'), [])
    proof.preflight = { schemaVersion: 4, queuedAfterContextReplacement: true, noModelOrDocker: true }; proof.passed = true; mark('preflight-passed')
  } else {
  const routeHome = join(root, 'route'); await mkdir(routeHome)
  const env = { ...process.env, DSH_WEB_REAL_PROVIDER: 'super-relay', DSH_WEB_REAL_MODEL: 'auto_model/alwaysday1' }
  const route = await prepareRealRoute({ env, home: routeHome, workspace: repository }); proof.route = route.proof
  const routeConfig = parse(await readFile(join(routeHome, 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers['super-relay']
  if (reasoningProbe !== undefined) {
    // Owner-run configuration experiment in this private Context only. Dispatch
    // alone proves neither effective effort selection nor gateway enforcement.
    routeConfig.models = routeConfig.models.map(model => model.id === 'auto_model/alwaysday1'
      ? { ...model, reasoningEfforts: { low: 'low' } } : model)
    routeConfig.reasoning = reasoningProbe
    proof.reasoningProbe = { requested: reasoningProbe, mapping: { low: 'low' }, gatewayEnforcementVerified: false }
  }
  const secret = env[routeConfig.apiKeyEnv]; assert.ok(secret); routeSecret = secret
  first.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { [routeConfig.apiKeyEnv]: secret } }]))
  first.provide('credentials', { resolve: async ref => String(ref) === routeConfig.apiKeyEnv ? { value: secret } : undefined })
  first.provide('approval', { config: { policy: 'ask' }, request: async () => 'allowed-once' })
  first.provide('assistantGoals', { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: () => { throw new Error('fixture has no verified history') } })
  first.provide('assistantSkills', { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [], stageOwnerVerifiedSuccessCandidate: () => { throw new Error('outside source proof') } })
  await mountAgentLoopTestDependencies(first, { systemPrompt: { persona: '' } }); await first.plugin(SessionProjectionRegistry); await first.plugin(Pi, { providers: { 'super-relay': routeConfig } }); await first.plugin(AgentLoop, { agents: [] })
  first.on('llm/stream', async function* (options, next) {
    const call = { provider: options.provider, model: options.model, maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort,
      tools: (options.tools ?? []).map(tool => tool.name).sort(), startedAt: Date.now(),
      chunks: 0, chunkTypes: {}, textCharacters: 0, argumentCharacters: 0, reasoningCharacters: 0, settled: false }
    proof.modelCalls.push(call); mark('model-call')
    try {
      for await (const chunk of next()) {
        call.chunks += 1
        call.chunkTypes[chunk.type] = (call.chunkTypes[chunk.type] ?? 0) + 1
        if (chunk.type === 'text-delta') call.textCharacters += chunk.text?.length ?? 0
        if (chunk.type === 'reasoning-delta') call.reasoningCharacters += chunk.text?.length ?? 0
        if (chunk.type === 'tool-call-delta') call.argumentCharacters += chunk.argumentsDelta?.length ?? 0
        if (chunk.type === 'finish') call.finishReason = chunk.reason
        if (chunk.type === 'usage') call.usage = chunk.usage
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') proof.toolCalls.push({ name: chunk.block.name, argumentsDigest: digest(chunk.block.arguments) })
        yield chunk
      }
      call.settled = true
    } finally { call.endedAt = Date.now() }
  })
  const gap = cp.recordGap({ idempotencyKey: 'day1-personal-memory-source', capability: task.capability, context: task.context, expectedValue: 100, frequency: 1, estimatedCost: 1, risk: 0.1 })
  const driver = new AssistantGrowthDriverService(first, { enabled: true, provider: 'super-relay', model: 'auto_model/alwaysday1', scope, intervalMs: 0, maxDurationMs: 240_000, maxModelCalls: 12, maxToolCalls: 20, maxOutputTokens: 8_192, apiKeyEnv: routeConfig.apiKeyEnv, budgetId: 'source-model-wakes', budgetAmount: 1, pluginSourceProposals: { enabled: true, preparationMode: 'durable', repository, maxPlansPerWake: 1, isolatedBuildTimeoutMs: 60_000, offline: true, planTtlMs: 3_600_000 } })
  await new Promise(resolvePromise => setImmediate(resolvePromise)); mark('wake-start'); await driver.wake(); mark('wake-end')
  const health = driver.health(); proof.wake = health;
  assert.ok(proof.modelCalls.length > 0 && proof.modelCalls.every(call => call.provider === 'super-relay' && call.model === 'auto_model/alwaysday1' && call.tools.length === 8))
  assert.equal(health.run?.sourceProposals.prepared, 0);
  assert.equal(health.run?.sourceProposals.queued, 1, JSON.stringify(health))
  const jobs = new DatabaseSync(join(control.statePath, 'control.sqlite'), { readOnly: true }); let row
  try { row = jobs.prepare('SELECT id, status, intent_json FROM source_jobs').get() } finally { jobs.close() }
  assert.equal(row.status, 'queued'); const frozen = JSON.parse(row.intent_json); assert.equal(frozen.baseCommit, baseCommit); assert.equal(frozen.trustDigest.length, 64); assert.equal(frozen.build.timeoutMs, 1_800_000)
  assert.ok(proof.reads?.some(read => read.baseCommit === baseCommit && read.paths.length > 0), 'model did not read committed source provenance')
  assert.equal(frozen.gapId, gap.id)
  proof.queued = { id: row.id, status: row.status, baseCommit: frozen.baseCommit, trustDigest: frozen.trustDigest, ownerDigest: frozen.ownerDigest, containerName: frozen.containerName, worktree: frozen.worktree }
  assert.equal(frozen.files.some(file => file.content.includes(secret)), false, 'candidate echoed route secret')
  proof.candidateFiles = frozen.files.map(file => ({ path: file.path, sha256: digest(file.content), bytes: Buffer.byteLength(file.content), content: file.content }))
  assert.ok(proof.candidateFiles.length > 0)
  await writeFile(evidencePath, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 })
  mark('teardown-queued'); await closeContext(first); first = undefined
  second = new Context(); const { control: rebound, automations } = await mountCommon(second)
  assert.equal(digest(await readFile(rebound.trustPath)), trustFileDigest)
  assert.equal(second.get('agents'), undefined)
  const cp2 = second.get('pluginControlPlane'); assert.equal(cp2.canEnqueueSource(), true); mark('rebind-no-agent')
  const prepareSourceJob = rebound.service.prepareSourceJob.bind(rebound.service)
  rebound.service.prepareSourceJob = async (...args) => {
    mark('host-check-start')
    try { const plan = await prepareSourceJob(...args); proof.preparedPlan = plan; return plan }
    catch (error) { proof.hostCheckFailure = { name: error.name, message: String(error.message).replaceAll(secret, '[redacted]').slice(0, 8192) }; throw error }
    finally { mark('host-check-end') }
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1100)); mark('native-tick-first'); await automations.tick(); mark('docker-check-wait'); await automations.whenIdle(); mark('native-tick-second'); await automations.tick(); await automations.whenIdle()
  const after = new DatabaseSync(join(control.statePath, 'control.sqlite'), { readOnly: true }); let finalJob; let plan
  try { finalJob = after.prepare('SELECT status, occurrence_id FROM source_jobs WHERE id = ?').get(row.id); plan = after.prepare('SELECT status, base_commit FROM source_plans').get() } finally { after.close() }
  assert.equal(finalJob.status, 'prepared'); assert.equal(plan.status, 'pending-approval'); assert.equal(plan.base_commit, baseCommit)
  const automationDb = new DatabaseSync(join(root, 'automations.sqlite'), { readOnly: true }); let occurrences
  try { occurrences = automationDb.prepare("SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id = ?").get(row.id).count } finally { automationDb.close() }
  assert.equal(occurrences, 1)
  const nativeRuns = query(join(root, 'automations.sqlite'), 'SELECT status, occurrence_id, execution_mode, diagnostic_json FROM automation_runs WHERE automation_id = ?', row.id)
  assert.equal(nativeRuns[0].status, 'succeeded'); assert.equal(nativeRuns[0].occurrence_id, finalJob.occurrence_id); assert.equal(nativeRuns[0].execution_mode, 'production')
  const plans = query(controlDb, 'SELECT id, status, base_commit, gap_id, worktree, prepared_evidence_json FROM source_plans')
  assert.equal(plans.length, 1); assert.equal(plans[0].gap_id, gap.id); assert.equal(plans[0].worktree, frozen.worktree)
  const preparedEvidence = JSON.parse(plans[0].prepared_evidence_json)
  assert.equal(preparedEvidence.commands[0].exitCode, 0); assert.ok(preparedEvidence.pack.sizeBytes > 0)
  const remaining = execFileSync('/usr/bin/docker', ['container', 'ls', '--all', '--quiet', '--filter', `name=^/${frozen.containerName}$`], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 }).trim()
  assert.equal(remaining, '')
  assert.equal(git('rev-parse', 'HEAD'), baseCommit); assert.equal(git('status', '--porcelain=v1', '--', `plugins/${task.name}`), '')
  proof.remount = { noAgent: true, finalJob, plan, occurrences, nativeRuns, preparedEvidence, containerAbsent: true, pendingWorktreeRetained: true, originalPluginUnchanged: true }; proof.passed = true; mark('passed')
  }
} catch (error) {
  const message = String(error?.message ?? error)
  proof.failure = { name: error?.name ?? 'Error', message: routeSecret ? message.replaceAll(routeSecret, '[redacted]') : message }; mark('failed'); throw new Error(proof.failure.message)
} finally {
  try { await closeContext(first); await closeContext(second) } catch (error) { proof.passed = false; proof.cleanupFailure = String(error.message); process.exitCode = 1 }
  const serialized = JSON.stringify(proof, null, 2) + '\n'
  await writeFile(evidencePath, routeSecret ? serialized.replaceAll(routeSecret, '[redacted]') : serialized, { mode: 0o600 })
  // Pending-plan worktrees remain for owner review/export.
}
process.stdout.write(JSON.stringify({ passed: proof.passed, modelCalls: proof.modelCalls.length, toolCalls: proof.toolCalls.length, remount: proof.remount }) + '\n')
