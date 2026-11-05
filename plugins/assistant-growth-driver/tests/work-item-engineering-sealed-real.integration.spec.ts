// Linux-only, explicitly opted-in acceptance: a sealed Docker-era tool returns only under a NEW plan id
// with a fresh linux-native v3 certificate, is called by a new owner session, and the sealed id is refused.
// Real model calls happen only for Growth (author + creation verifier); every other turn is scripted.
// Never runs in root checks: requires DSH_SEALED_REAL_LIVE=1, linux and a prepared engineering resource.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityJournal, creationCapabilityAuthorityDigest } from '../../plugin-control-plane/lib/creation-capability-journal.js'
import { creationCapabilitySourceDigest, type CreationCapabilitySourceSnapshot } from '../../plugin-control-plane/lib/creation-capability-source.js'
import { planSealedAdoptionHandoff, applySealedAdoptionHandoff } from '../../plugin-control-plane/lib/creation-capability-sealed-handoff.js'
import type { CreationCapabilityConfig } from '../../plugin-control-plane/lib/creation-capability-types.js'
import { query, workItemEngineeringFixture } from './work-item-engineering.fixture.ts'
import { normalizeConfig } from '../src/index.ts'
// @ts-expect-error untyped e2e helper module
import { prepareRealRoute } from '../../../scripts/e2e/web-owner-real-route.mjs'

const live = process.platform === 'linux' && process.env['DSH_SEALED_REAL_LIVE'] === '1'
  && !!process.env['DSH_WORK_ITEM_ENGINEERING_RESOURCES']
const PROVIDER = process.env['DSH_WEB_REAL_PROVIDER'] ?? 'llmgw-default'
const MODEL = process.env['DSH_WEB_REAL_MODEL'] ?? 'deepseek-v4.1-flash'
// Author 10 model calls + creation verifier 2. Attempt 3 used all 5 author calls and was cut off; attempt 5 used 5 of 7
// and failed its native tsc check with no repair: the author now waits for the build and may repair once (docs/rsi-status.md).
const MAX_REAL_CALLS = 12
const MAX_SOURCE_JOBS = 2
const SEALED_ID = 'sealed-docker-normalize'
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const dshPackage = () => process.env['DSH_SEALED_REAL_DSH_PACKAGE']
  ?? '/home/jiataorui/.local/share/pnpm/nodejs/24.7.0/lib/node_modules/@deepseek-ai/dsh/package.json'

/** Selected public route only; the credential stays in the child env and is never logged or written. */
async function realRoute(workspace: string) {
  const routeHome = await mkdtemp(join(tmpdir(), 'sealed-real-route-'))
  try {
    const env: Record<string, string | undefined> = { ...process.env, DSH_WEB_REAL_PROVIDER: PROVIDER, DSH_WEB_REAL_MODEL: MODEL,
      DSH_WEB_REAL_SOURCE_PROFILE: process.env['DSH_WEB_REAL_SOURCE_PROFILE'] ?? 'web' }
    const route = await prepareRealRoute({ env, home: routeHome, workspace }) as { provider: string; model: string }
    const config = parse(await readFile(join(routeHome, 'settings.yaml'), 'utf8'))['llm-pi-ai'].providers[route.provider] as { apiKeyEnv: string; headers?: Record<string, string> }
    return { route, config, secret: env[config.apiKeyEnv] }
  } finally { await rm(routeHome, { recursive: true, force: true }) }
}

/** Docker-era history through the real journal API, then the reviewed stop/stage/seal/cutover sequence. */
function sealDockerHistory(input: { root: string; statePath: string; capabilities: CreationCapabilityConfig }, evidence: Record<string, unknown>) {
  const next = input.capabilities, verifier = generateKeyPairSync('ed25519'), now = Date.now()
  const { backend: _b, runtime: _r, cgroupRoots: _c, stateSeal: _s, ...budget } = next.runner as unknown as Record<string, unknown>
  const oldConfig = { ...next, runner: { ...budget, image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/docker' } } as unknown as CreationCapabilityConfig
  const name = `${next.namePrefix}records-sealed`, content = 'export const sealed = true\n', bytes = Buffer.from(content), artifact = Buffer.from('sealed docker-era tarball')
  const file = `plugins/${name}/src/index.ts`, baseCommit = '1'.repeat(40)
  const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const scope = [`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'].sort()
  const entries = [{ path: 'plugins/README.md', mode: '100644' as const, oid: '2'.repeat(40) },
    { path: file, mode: '100644' as const, oid }, { path: 'pnpm-lock.yaml', mode: '100644' as const, oid: '3'.repeat(40) }]
  const treeDigest = createHash('sha256').update(`dsh-source-tree-v2\0${baseCommit}\0${JSON.stringify(scope)}\0`)
    .update(entries.map(entry => `${entry.mode} ${entry.oid} 0\t${entry.path}\0`).join('')).digest('hex')
  const payload: Omit<CreationCapabilitySourceSnapshot, 'digest'> = { protocol: 'dsh-created-capability-source/v1', baseCommit, scope,
    treeDigest, patchDigest: 'e'.repeat(64), entries, files: [{ path: file, mode: '100644', oid, bytes: bytes.length, sha256: sha(bytes), content }] }
  const h = (c: string) => c.repeat(64)
  const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: `verification-${SEALED_ID}`,
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'docker-era-verifier',
      keyId: 'docker-era-verifier-key', authorityDigest: h('b'), namePrefix: next.namePrefix, expiresAt: now + 600_000 },
    plan: { id: SEALED_ID, digest: h('c'), name, sourceTreeDigest: treeDigest, sourcePatchDigest: h('e'),
      artifactSha256: sha(artifact), artifactBytes: artifact.length, generatorDigest: h('f') },
    source: { referenceDigest: h('1'), ownerDigest: h('2'), growthRunDigest: h('3') }, contractDigest: h('4'), schemaDigest: h('5'),
    environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' }, model: { provider: 'docker-era', model: 'retired' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 }, sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: [{ caseId: 'first', jobId: 'job-first', operationDigest: h('6'), observationDigest: h('7') },
      { caseId: 'second', jobId: 'job-second', operationDigest: h('8'), observationDigest: h('9') }],
    reviewDigest: h('0'), verifiedAt: now - 1000, expiresAt: now + 600_000 }
  const certificate = { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), verifier.privateKey).toString('base64url') }
  const path = join(input.statePath, 'creation-adoptions.sqlite')
  const journal = new CreationCapabilityJournal({ path, config: oldConfig })
  try {
    journal.claim({ certificate, artifact, source: { ...payload, digest: creationCapabilitySourceDigest(payload) } })
    journal.authorize(SEALED_ID, [{ originalName: 'normalize_records', name: 'normalize_records', description: 'Docker-era records parser', parameters: { type: 'object' } }])
    journal.activate(SEALED_ID)
    journal.claimCall({ planId: SEALED_ID, key: 'docker-era-call', argumentsDigest: h('a') })
    journal.settleCall({ planId: SEALED_ID, key: 'docker-era-call', status: 'completed', result: { ok: true } })
  } finally { journal.close() }
  for (const suffix of ['-wal', '-shm']) rmSync(path + suffix, { force: true })
  const stage = join(input.root, 'seal-stage'); mkdirSync(stage, { mode: 0o700 })
  const physicalPath = join(stage, 'creation-adoptions.sqlite'); copyFileSync(path, physicalPath)
  const oldDigest = creationCapabilityAuthorityDigest({ path, config: oldConfig })
  const archiveLogicalPath = join(input.statePath, 'creation-adoptions.sealed', `${oldDigest}.sqlite`)
  const archivePhysicalPath = join(stage, 'creation-adoptions.sealed', `${oldDigest}.sqlite`)
  const plan = planSealedAdoptionHandoff({ physicalPath, logicalPath: path, archiveLogicalPath, archivePhysicalPath,
    transactionId: 'sealed-real-transaction', hostAnchor: h('e'), oldConfig, nextConfig: next, now: Date.now(), expiresAt: Date.now() + 60_000 })
  const proof = applySealedAdoptionHandoff(plan, { now: plan.createdAt, expectedPlanDigest: plan.digest, expectedHostAnchor: plan.hostAnchor })
  renameSync(path, path + '.docker-era'); renameSync(physicalPath, path); renameSync(dirname(archivePhysicalPath), dirname(archiveLogicalPath))
  Object.assign(evidence, { oldAuthorityDigest: oldDigest, planDigest: plan.digest, proofDigest: proof.digest,
    archiveSha256: sha(readFileSync(archiveLogicalPath)), pendingReverification: plan.pendingReverification.map(item => item.planId),
    inheritedUsage: plan.inheritedUsage, sealedAt: Date.now() })
}

/**
 * Real-route author budget (this scenario only; config defaults stay 8192 / 120 s / 5 calls).
 * Attempt 1 at 4096 ran out writing the source file; attempt 2 was cut off by the 120 s Growth limit (300 s is the
 * config maximum); attempt 9 at 8192 ended max-tokens on reasoning before plugin_source_create, so one author call
 * now gets 16384 (provider accepts max_tokens 32767).
 */
const SEALED_REAL_AUTHOR_BUDGET = { maxOutputTokens: 16_384, maxDurationMs: 300_000, maxModelCalls: 10, maxToolCalls: 10 } as const

test('the sealed real scenario pins a 16384 per-call author budget inside config bounds without changing defaults', () => {
  expect(SEALED_REAL_AUTHOR_BUDGET).toEqual({ maxOutputTokens: 16_384, maxDurationMs: 300_000, maxModelCalls: 10, maxToolCalls: 10 })
  expect(MAX_REAL_CALLS).toBeLessThanOrEqual(14)
  const normalized = normalizeConfig({ ...SEALED_REAL_AUTHOR_BUDGET }) as Record<string, unknown>
  expect(normalized).toMatchObject(SEALED_REAL_AUTHOR_BUDGET)
  expect(normalizeConfig({})).toMatchObject({ maxOutputTokens: 8192 })
})

describe.skipIf(!live)('sealed Docker-era tool re-adopts under a new plan with a real model', () => {
  test('real Growth re-creates the tool, the new owner calls it once and the sealed id stays refused', async () => {
    const started = Date.now(), evidence: Record<string, unknown> = {}, seal: Record<string, unknown> = {}
    const calls: Array<{ provider: string; model: string; maxTokens?: number; toolNames: string[]; requestDigest: string; at: number }> = []
    const f = await workItemEngineeringFixture({ replyEnabled: true,
      sealedSeed: async input => sealDockerHistory(input as typeof input & { capabilities: CreationCapabilityConfig }, seal),
      realGrowthRoute: { provider: PROVIDER, model: MODEL, ...SEALED_REAL_AUTHOR_BUDGET } })
    const { route, config, secret } = await realRoute(f.workspace)
    if (!secret) throw new Error('real route credential reference is unavailable in the process environment')
    const installed = createRequire(dshPackage())
    const Pi = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
    const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-launch-environment')).href)
    const ctx = f.ctx as unknown as { provide(name: string, value: unknown): void; get(name: string): unknown; plugin(p: unknown, c?: unknown): { await(): Promise<unknown> }
      on(name: string, handler: unknown): void }
    if (ctx.get('launchEnvironment') === undefined) ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: { [config.apiKeyEnv]: secret } }]))
    // Only the configured reference resolves; no other credential is reachable.
    if (ctx.get('credentials') === undefined) ctx.provide('credentials', { resolve: async (ref: unknown) => String(ref) === config.apiKeyEnv ? { value: secret } : undefined })
    await ctx.plugin(Pi.default ?? Pi, { providers: { [route.provider]: config } }).await()
    ctx.on('llm/stream', async function* (options: { provider: string; model: string; maxTokens?: number; tools?: Array<{ name: string }>; system?: unknown; messages?: unknown },
      next: () => AsyncIterable<unknown>) {
      if (options.provider === route.provider) {
        if (calls.length >= MAX_REAL_CALLS) throw new Error('sealed real acceptance real-call budget exhausted')
        calls.push({ provider: options.provider, model: options.model, ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          toolNames: (options.tools ?? []).map(tool => tool.name).sort(),
          requestDigest: sha(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools })), at: Date.now() })
      }
      yield* next()
    })
    try {
      // Scripted owner failure; diagnosis and continuation stay on the local supplier.
      const itemId = await f.produce(); await f.acceptReports()
      const row = query(join(f.root, 'items.sqlite'), `SELECT delivery_id FROM work_item_report WHERE item_id='${itemId}'`)[0]!
      const report = f.operator!.getOutbox(String(row.delivery_id))!
      await f.reply(report.providerMessageId!, '还是不行', 'sealed-real-owner-failure')
      await vi.waitFor(async () => {
        await f.ctx.assistantDelivery.tick(); await f.ctx.assistantDelivery.whenIdle()
        const canonical = f.ctx.assistantEvaluation.getTrustedWorkItemLearningProjection({ scope: f.ctx.assistantEvaluation.createHostScope({ workspace: f.workspace, preset: 'primary' }), itemId })
        expect(canonical).toMatchObject({ objective: { status: 'not-achieved' } })
      }, { timeout: 15000 })
      await f.mountEngineering()
      expect(seal['pendingReverification']).toEqual([SEALED_ID])
      const journalPath = join(f.root, 'control-plane', 'creation-adoptions.sqlite')
      // The source job is discovered from the ledger: the real author has no scripted job hook.
      const owner = f.ctx.assistantDelivery.validateOwnerRoute(f.scope)
      const caller = { ownerRouteId: owner.authorityId, principalId: owner.principalId, principalRecordId: owner.principalRecordId,
        principalVersion: owner.principalVersion, workspace: owner.workspace, preset: owner.agentPreset }
      const deadline = Date.now() + 900_000
      let planId: string | undefined, alias: string | undefined
      while (!alias) {
        await f.ctx.assistantAutomations.tick(); await f.ctx.assistantAutomations.whenIdle()
        const jobs = query(join(f.root, 'control-plane/control.sqlite'), 'SELECT id FROM source_jobs ORDER BY created_at, id')
        if (jobs.length > MAX_SOURCE_JOBS) throw new Error('more real source jobs than the bounded repair allows')
        if (jobs.length === 0 && existsSync(join(f.root, 'engineering-usage.sqlite'))) {
          // A Growth run that settles without submitting source can never adopt; stop instead of waiting.
          const settled = query(join(f.root, 'engineering-usage.sqlite'),
            "SELECT state, reason FROM usage_jobs WHERE state IN ('reviewed','failed','unknown','superseded')")
          if (settled.length) throw new Error('real Growth run settled without a source job: ' + String(settled[0]!.reason))
        }
        if (jobs.length > 0) {
          const projected = jobs.map(row => f.ctx.pluginControlPlane.inspectSourceJob({ id: String(row.id), owner: caller }))
          // Only a non-final job may fail, and only as a Host-certified deterministic build/check failure.
          for (const [index, earlier] of projected.slice(0, -1).entries()) {
            if (earlier.status !== 'failed' || earlier.failureCode !== 'source-build-check-failed') throw new Error(`real source job ${index + 1} was superseded without a deterministic build failure: ${earlier.status}/${earlier.failureCode ?? ''}`)
          }
          evidence['sourceJobs'] = projected.map(job => ({ id: job.id, status: job.status, failureCode: job.failureCode, planId: job.planId,
            ...(job.diagnostics === undefined ? {} : { diagnostics: { phase: job.diagnostics.phase, exitCode: job.diagnostics.exitCode,
              entries: job.diagnostics.entries, truncated: job.diagnostics.truncated } }) }))
          const job = projected.at(-1)!
          const settledGrowth = existsSync(join(f.root, 'engineering-usage.sqlite')) && query(join(f.root, 'engineering-usage.sqlite'),
            "SELECT state FROM usage_jobs WHERE state IN ('reviewed','failed','unknown','superseded')").length > 0
          if (job.status === 'unknown') throw new Error('real source job did not prepare: unknown/' + (job.failureCode ?? ''))
          if (job.status === 'failed' && (job.failureCode !== 'source-build-check-failed' || jobs.length >= MAX_SOURCE_JOBS || settledGrowth)) {
            throw new Error(`real source job did not prepare: failed/${job.failureCode ?? ''} after ${jobs.length} job(s)`)
          }
          if (job.planId) planId = job.planId
          const verification = planId ? f.ctx.pluginControlPlane.inspectCreationVerification(planId) : undefined
          if (verification && ['unknown', 'rejected'].includes(verification.status)) throw new Error('independent verification terminal: ' + verification.status)
        }
        alias = f.ctx.tools.schemas().find(tool => tool.name.startsWith('evolved_owner_'))?.name
        if (!alias && Date.now() >= deadline) throw new Error('real re-adoption did not settle in its bounded window')
        if (!alias) await new Promise(resolve => setTimeout(resolve, 250))
      }
      expect(planId).toEqual(expect.any(String)); expect(planId).not.toBe(SEALED_ID)
      const certificate = f.ctx.pluginControlPlane.inspectVerifiedCreation(planId!)!
      expect(certificate).toMatchObject({ protocol: 'assistant-growth/creation-verification/v3', execution: { boundary: 'linux-native-process-seccomp-v1' } })
      const called = await f.invokeOwner(alias, 'z=last\na=值=sealed')
      expect(called.approvals).toEqual([expect.objectContaining({ matched: true, outcome: 'allowed-once' })])
      const artifact = f.ctx.pluginControlPlane.inspectPreparedCreation(planId!).artifact
      const journal = new CreationCapabilityJournal({ path: journalPath, config: f.controlConfig()!.creationCapabilities! })
      try {
        const sealedCopy = { ...certificate, plan: { ...certificate.plan, id: SEALED_ID } }
        expect(() => journal.claim({ certificate: sealedCopy, artifact })).toThrow()
        expect(journal.list().map(record => record.planId)).toEqual([planId])
        expect(journal.usage().adoptions).toBe(2) // one inherited sealed adoption plus the re-adoption
      } finally { journal.close() }
      expect(calls.length).toBeGreaterThan(0); expect(calls.length).toBeLessThanOrEqual(MAX_REAL_CALLS)
      Object.assign(evidence, { sealedPlanId: SEALED_ID, planId, alias, certificateProtocol: certificate.protocol,
        boundary: certificate.execution?.boundary, approvals: called.approvals.length })
    } finally {
      const output = process.env['WORK_ITEM_ENGINEERING_NATIVE_EVIDENCE']
      // Sidecar beside the fixture's own (scripted-only) evidence; digests, ids and timings only.
      if (output) await writeFile(output + '.sealed-real.json', JSON.stringify({ protocol: 'sealed-real-acceptance-evidence/v1',
        route: { provider: route.provider, model: route.model, headerNames: Object.keys(config.headers ?? {}).sort() },
        seal, ...evidence, realCalls: calls, startedAt: started, finishedAt: Date.now() }, null, 2) + '\n', { mode: 0o600 })
    }
  }, 1_500_000)
})

describe.skipIf(!(process.platform === 'linux' && process.env['DSH_SEALED_REAL_PROBE'] === '1'))('sealed real acceptance no-call probe', () => {
  test('installed Pi adapter and the selected web-profile route resolve with a dummy key and no network', async () => {
    const installed = createRequire(dshPackage())
    expect(installed.resolve('@deepseek-ai/dsh-llm-pi-ai')).toMatch(/dsh-llm-pi-ai/u)
    const workspace = await mkdtemp(join(tmpdir(), 'sealed-real-probe-'))
    try {
      const routeHome = join(workspace, 'route'), env: Record<string, string | undefined> = { DSH_WEB_REAL_PROVIDER: PROVIDER, DSH_WEB_REAL_MODEL: MODEL,
        DSH_WEB_REAL_SOURCE_PROFILE: process.env['DSH_WEB_REAL_SOURCE_PROFILE'] ?? 'web', DSH_WEB_REAL_SOURCE_HOME: process.env['DSH_WEB_REAL_SOURCE_HOME'], LLMGW_API_KEY: 'dummy-probe-value' }
      const route = await prepareRealRoute({ env, home: routeHome, workspace })
      expect(route).toMatchObject({ provider: PROVIDER, model: MODEL })
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })
})
