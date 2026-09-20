// Live day1 + native Growth Driver/Agent/Policy + real Docker source proposal.
// Owner route/history are explicit fixtures. No approval, publication or activation.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'yaml'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { AssistantPolicyService } from '../../plugins/assistant-policy/lib/index.js'
import { AssistantGrowthDriverService } from '../../plugins/assistant-growth-driver/lib/index.js'
import { prepareRealRoute } from './web-owner-real-route.mjs'
import { createSourceModelControlFixture } from './source-model-control-fixture.mjs'

assert.equal(process.env.DSH_SOURCE_MODEL_LIVE, '1', 'explicitly set DSH_SOURCE_MODEL_LIVE=1 for the real day1 request')
const image = process.env.DSH_SOURCE_BUILD_IMAGE
assert.match(image ?? '', /^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/)
const dshPackage = resolve(process.env.DSH_SOURCE_MODEL_DSH_PACKAGE ?? '/home/jiataorui/.local/share/pnpm/nodejs/24.7.0/lib/node_modules/@deepseek-ai/dsh/package.json')
const installed = createRequire(dshPackage)
const Pi = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-launch-environment')).href)
const root = await mkdtemp(join(tmpdir(), 'dsh-source-model-'))
const ctx = new Context()
const progress = stage => process.stderr.write(JSON.stringify({ stage, at: new Date().toISOString() }) + '\n')
const digest = value => createHash('sha256').update(value).digest('hex')
const observations = { modelCalls: [], toolCalls: [], reads: [], preparations: [] }
let proof
try {
  const repository = join(root, 'repository')
  const pluginRoot = join(repository, 'plugins', 'clamp-helper')
  await mkdir(join(pluginRoot, 'src'), { recursive: true })
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'source-model-fixture', private: true, scripts: { check: 'node check.mjs' } }))
  await writeFile(join(repository, 'pnpm-workspace.yaml'), 'packages:\n  - plugins/*\n')
  await writeFile(join(repository, 'check.mjs'), `import assert from 'node:assert/strict';
import plugin, { clamp } from './plugins/clamp-helper/src/index.js';
assert.equal(plugin.name, 'dsh-enhanced-clamp-helper'); assert.equal(typeof plugin.apply, 'function');
for (let i = -100; i <= 100; i++) { const x = i / 7; assert.equal(clamp(x, -3, 5), Math.max(-3, Math.min(5, x))); }
assert.equal(clamp(10, 2, 2), 2); assert.equal(clamp(-10, 2, 2), 2);
`)
  const original = "export function clamp(value, minimum, maximum) { return value }\nexport default { name: 'dsh-enhanced-clamp-helper', apply(ctx) { ctx.provide('clamp', clamp) } }\n"
  await writeFile(join(pluginRoot, 'src/index.js'), original)
  await writeFile(join(pluginRoot, 'README.md'), '# Clamp helper\nclamp(value, minimum, maximum) must return the closest value within the inclusive bounds; inputs are finite and minimum <= maximum. The current implementation fails to clamp.\n')
  await writeFile(join(pluginRoot, 'LICENSE'), 'MIT\n')
  await writeFile(join(pluginRoot, 'cordis.patch.yml'), '- id: dsh-enhanced-clamp-helper\n  name: "@dsh-enhanced/clamp-helper"\n')
  await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/clamp-helper', version: '1.0.0', type: 'module', main: './src/index.js', files: ['src/', 'README.md', 'LICENSE', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  const gitEnv = { PATH: process.env.PATH, HOME: root }
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, env: gitEnv, encoding: 'utf8' }).trim()
  execFileSync('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: repository, env: gitEnv, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.name', 'Source model fixture'); git('config', 'user.email', 'source-model@example.invalid')
  git('add', '--all'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'broken clamp fixture')
  const baseCommit = git('rev-parse', 'HEAD')
  let baselineFailed = false
  try { execFileSync(process.execPath, ['check.mjs'], { cwd: repository, stdio: 'pipe' }) } catch { baselineFailed = true }
  assert.equal(baselineFailed, true)

  const routeHome = join(root, 'route'); await mkdir(routeHome)
  const env = { ...process.env, DSH_WEB_REAL_PROVIDER: 'super-relay', DSH_WEB_REAL_MODEL: 'auto_model/alwaysday1' }
  const route = await prepareRealRoute({ env, home: routeHome, workspace: repository })
  const routeConfig = parse(await readFile(join(routeHome, 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers['super-relay']
  const secret = env[routeConfig.apiKeyEnv]
  assert.ok(secret)
  ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { [routeConfig.apiKeyEnv]: secret } }]))
  // Only the configured reference can resolve; it is never copied to the Docker env.
  ctx.provide('credentials', { resolve: async ref => String(ref) === routeConfig.apiKeyEnv ? { value: secret } : undefined })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Pi, { providers: { 'super-relay': routeConfig } })
  ctx.on('llm/stream', async function* (options, next) {
    observations.modelCalls.push({ provider: options.provider, model: options.model, maxTokens: options.maxTokens, toolNames: (options.tools ?? []).map(tool => tool.name).sort() })
    progress('model-call')
    for await (const chunk of next()) {
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') observations.toolCalls.push({ name: chunk.block.name, argumentsDigest: digest(chunk.block.arguments) })
      yield chunk
    }
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('approval', { config: { policy: 'ask' }, request: async () => 'allowed-once' })
  const principal = 'source-model-fixture-owner'; const preset = 'source-model-fixture'; const ownerRouteId = 'source-model-fixture-route'
  const scope = { principalId: principal, workspace: repository, preset, ownerRouteId }
  ctx.provide('assistantDelivery', { validateOwnerRoute: () => ({ receiptVersion: 2, authorityId: ownerRouteId, authorityHash: 'fixture-anchor', principalId: principal,
    principalRecordId: 'fixture-owner-record', principalVersion: 1, workspace: repository, agentPreset: preset, bindingVersion: 1, generation: 1 }) })
  ctx.provide('assistantGoals', { inspectOwnerGoals: () => [], inspectOwnerVerifiedWorkflowSource: () => { throw new Error('no verified-history fixture') } })
  ctx.provide('assistantSkills', { inspectOwnerActiveSkills: () => [], inspectOwnerSkillCandidates: () => [], stageOwnerVerifiedSuccessCandidate: () => { throw new Error('skill proposals are outside this source fixture') } })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), budgets: [{ id: 'source-smoke-wake', metric: 'automation-runs', limit: 1, periodMs: 3600000, scope: 'subject' }],
    rules: ['growth_*', 'plugin_source_*'].map((id, i) => ({ id: `source-model-tool-${i}`, effect: 'allow', subject: { kind: 'agent', id: preset, workspace: repository, principal }, actions: ['execute'], resource: { kind: 'tool', id }, context: { initiators: ['background'] } })) })
  const control = await createSourceModelControlFixture({ ctx, root, repository, image })
  const service = control.service
  const originalRead = service.inspectSource.bind(service)
  service.inspectSource = async input => {
    const result = await originalRead(input)
    observations.reads.push({ name: result.name, baseCommit: result.baseCommit, paths: result.contents.map(file => file.path) })
    progress('source-read')
    return result
  }
  const originalPrepare = service.prepareModifySourcePlan.bind(service)
  service.prepareModifySourcePlan = async input => {
    progress('source-prepare')
    const plan = await originalPrepare(input)
    observations.preparations.push({ expectedBaseCommit: input.expectedBaseCommit, files: input.files, plan })
    return plan
  }
  const gap = service.recordGap({ idempotencyKey: 'source-model-clamp-gap', capability: 'clamp finite numbers to inclusive bounds',
    context: 'Existing plugin clamp-helper has a broken clamp function in src/index.js: it returns the input unchanged. Read the README and source, then fix clamp(value, minimum, maximum) for finite inputs with minimum <= maximum. Preserve the native Cordis default plugin. Prepare one pending source modification. No repeated skill history exists in this fixture; use the separate source-proposal capability.',
    expectedValue: 100, frequency: 10, estimatedCost: 1, risk: 0.1 })
  const driver = new AssistantGrowthDriverService(ctx, { enabled: true, provider: 'super-relay', model: 'auto_model/alwaysday1', scope, intervalMs: 0, maxDurationMs: 240000, maxModelCalls: 12, maxToolCalls: 20, maxOutputTokens: 4096,
    apiKeyEnv: routeConfig.apiKeyEnv, budgetId: 'source-smoke-wake', budgetAmount: 1,
    pluginSourceProposals: { enabled: true, repository, maxPlansPerWake: 1, isolatedBuildTimeoutMs: 60000 } })
  await new Promise(resolvePromise => setImmediate(resolvePromise))
  progress('wake-start')
  await driver.wake()
  const health = driver.health()
  progress('wake-end')
  proof = { kind: 'real-day1-native-source-proposal', checkedAt: new Date().toISOString(), passed: false, route: route.proof, image, baseCommit,
    observations, health, limits: ['synthetic clamp task; no full repository improvement', 'owner route, history and tool approval are fixtures', 'no owner approval, remote publication or production activation'] }
  assert.equal(health.run?.sourceProposals.prepared, 1, `expected one prepared plan; health=${JSON.stringify(health)}`)
  assert.equal(observations.preparations.length, 1)
  const { plan, expectedBaseCommit, files } = observations.preparations[0]
  assert.equal(plan.status, 'pending-approval'); assert.equal(plan.mode, 'modify'); assert.equal(plan.gapId, gap.id)
  assert.equal(expectedBaseCommit, baseCommit); assert.equal(plan.baseCommit, baseCommit)
  assert.ok(observations.reads.some(read => read.baseCommit === baseCommit && read.paths.includes('src/index.js')))
  assert.ok(files.some(file => file.path === 'src/index.js' && file.content !== original))
  assert.ok(observations.modelCalls.length > 0 && observations.modelCalls.every(call => call.provider === 'super-relay' && call.model === 'auto_model/alwaysday1' && call.toolNames.length === 7))
  assert.equal(await readFile(join(pluginRoot, 'src/index.js'), 'utf8'), original)
  const db = new DatabaseSync(join(control.statePath, 'control.sqlite'), { readOnly: true })
  try { assert.deepEqual(db.prepare('SELECT status, base_commit FROM source_plans').all().map(row => ({ ...row })), [{ status: 'pending-approval', base_commit: baseCommit }]) } finally { db.close() }
  proof.passed = true
  proof.assertions = ['baseline-failed', 'real-day1-model', 'native-seven-tool-agent', 'committed-source-read', 'same-read-and-plan-base', 'model-written-patch', 'real-offline-docker-check-pack', 'persisted-pending-only', 'original-repository-unchanged']
} catch (error) {
  progress('failed')
  if (proof) proof.failure = String(error.message)
  throw error
} finally {
  await ctx.fiber.dispose()
  if (proof && process.env.DSH_SOURCE_MODEL_EVIDENCE) await writeFile(resolve(process.env.DSH_SOURCE_MODEL_EVIDENCE), JSON.stringify(proof, null, 2) + '\n')
  await rm(root, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify({ passed: proof.passed, route: proof.route, modelCalls: proof.observations.modelCalls.length, usage: proof.health.run?.usage }) + '\n')
