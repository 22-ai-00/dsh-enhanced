import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { AssistantPolicyService } from '../../assistant-policy/lib/index.js'
import { growthObjectDigest } from '../../../packages/assistant-growth-contract/lib/index.js'
import { normalizeConfig as validateDreamingConfig } from '../../assistant-dreaming/lib/index.js'
import { normalizeConfig as validateGrowthConfig } from '../../assistant-growth-driver/lib/index.js'
import { validateLearningConfig } from '../../assistant-memory-learning/lib/index.js'
import { validateMemoryReviewConfig } from '../../assistant-verifier/lib/index.js'
import { validateMemoryLearningAdoptionGrant } from '../../personal-memory/lib/index.js'
import { parseDocument, isMap, isSeq } from 'yaml'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { inspectAutonomyReadiness } from '../src/doctor.ts'
import {
  applyWebOwnerAutonomySetup,
  compileWebOwnerAutonomyGrants,
  inspectWebOwnerAutonomyPrerequisites,
} from '../src/index.ts'
import { prepareWebOwnerProfile, runWebOwnerSetup, type WebOwnerSetupInput } from '../src/setup.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  process.exitCode = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function buildEffectiveSource(slugs: readonly string[]): Promise<string> {
  return (async () => {
    const effectiveDocument = parseDocument('[]')
    for (const slug of slugs) {
      const source = await readFile(new URL(`../../${slug}/cordis.patch.yml`, import.meta.url), 'utf8')
      const doc = parseDocument(source, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
      const holder = isSeq(doc.contents) ? doc.contents.items.find(row => isMap(row) && row.has('insert')) : undefined
      const inserts = isMap(holder) ? holder.get('insert', true) : undefined
      if (!isSeq(inserts)) throw new Error(`missing insert block in ${slug}`)
      for (const row of inserts.items) effectiveDocument.add(row)
    }
    return effectiveDocument.toString()
  })()
}

function rowConfig(yamlSource: string, id: string): Record<string, any> {
  const rows = parseDocument(yamlSource).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
  return rows.find(row => row.id === id)!.config ?? {}
}

function findRow(yamlSource: string, id: string): { id: string; disabled?: boolean; config?: Record<string, any> } {
  const rows = parseDocument(yamlSource).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, any> }>
  return rows.find(row => row.id === id)!
}

async function createWebAutonomyFixture(options: { withBinding?: boolean; withSecondBinding?: boolean; withSettingsModel?: boolean } = {}) {
  const dshHome = await realpath(await mkdtemp(join(tmpdir(), 'web-owner-rsi-grants-')))
  roots.push(dshHome)
  const workspace = join(dshHome, 'workspace')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })

  const effective = await buildEffectiveSource([
    'personal-assistant',
    'assistant-delivery',
    'assistant-goals',
    'assistant-web-owner',
    'assistant-verifier',
    'assistant-memory-learning',
    'assistant-dreaming',
    'assistant-growth-driver',
  ])

  const input: WebOwnerSetupInput = { dshHome, profile: 'web', workspace, preset: 'standard' }
  const initial = prepareWebOwnerProfile(input, '[]', effective)
  const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  await writeFile(patchPath, initial.patch, { mode: 0o600 })

  const delivery = new DeliveryStore({ path: initial.databasePath })
  const owner = delivery.ensureOwner(initial.principal)
  if (options.withBinding !== false) {
    delivery.createBinding({
      conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'session-primary' },
      principal: initial.principal,
      workspace,
      agentPreset: 'standard',
      sessionId: 'session-primary',
      policyRef: 'owner-dm',
    })
  }
  if (options.withSecondBinding) {
    delivery.createBinding({
      conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'session-secondary' },
      principal: initial.principal,
      workspace,
      agentPreset: 'standard',
      sessionId: 'session-secondary',
      policyRef: 'owner-dm',
    })
  }
  delivery.close()

  if (options.withSettingsModel !== false) {
    await writeFile(join(dshHome, 'settings.yaml'), 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-chat\n', { mode: 0o600 })
  }

  return { dshHome, workspace, patchPath, initial, effective, owner }
}

describe('web-owner RSI autonomy grants', () => {
  test('compiles and validates independent memory, dreaming, and growth grants passing real plugin validators & AssistantPolicyService', async () => {
    const f = await createWebAutonomyFixture()
    const now = Date.now()
    const result = await applyWebOwnerAutonomySetup(
      {
        dshHome: f.dshHome,
        profile: 'web',
        memoryLearning: true,
        dreaming: 'enabled',
        growth: true,
        usageLearning: true,
        workItemExperiences: true,
        dailyBudget: 7,
        leaseDays: 14,
        now,
      },
      { readEffectiveSource: () => f.effective },
    )

    expect(result.ok).toBe(true)
    expect(result.applied).toBe(true)
    expect(result.modelRoute).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect(result.enabled).toEqual({
      memoryLearning: true,
      dreaming: 'enabled',
      growth: true,
      usageLearning: true,
      workItemExperiences: true,
    })

    const savedPatch = await readFile(f.patchPath, 'utf8')
    const patchStat = await stat(f.patchPath)
    expect(patchStat.mode & 0o777).toBe(0o600)

    const learningRow = findRow(savedPatch, 'dsh-enhanced-assistant-memory-learning')
    expect(learningRow.disabled).toBe(false)
    const validatedLearning = validateLearningConfig(learningRow.config)
    const validatedReviews = validateMemoryReviewConfig(rowConfig(savedPatch, 'dsh-enhanced-assistant-verifier').memoryReviews)
    const validatedAdoption = validateMemoryLearningAdoptionGrant(rowConfig(savedPatch, 'dsh-enhanced-personal-assistant').personalMemory.automaticLearning)
    const validatedDreaming = validateDreamingConfig(rowConfig(savedPatch, 'dsh-enhanced-assistant-dreaming'))
    const validatedGrowth = validateGrowthConfig(rowConfig(savedPatch, 'dsh-enhanced-assistant-growth-driver'))

    // Four distinct authority identifiers and matching cryptographic digests.
    expect(new Set([
      result.owner.authorityId,
      String(validatedLearning.authorityId),
      String(validatedReviews.authorityId),
      String(validatedAdoption.authorityId),
    ]).size).toBe(4)
    expect(validatedLearning.reviewAuthorityDigest).toBe(growthObjectDigest(validatedReviews))
    expect(validatedLearning.adoptionGrantDigest).toBe(growthObjectDigest(validatedAdoption))
    expect(validatedLearning.workItemExperiences).toBe(true)
    expect(validatedReviews.workItemExperiences).toBe(true)
    expect(validatedAdoption.workItemExperiences).toBe(true)

    // Strict $DSH_HOME SQLite path scoping.
    expect(validatedLearning.databasePath).toBe(join(f.dshHome, 'assistant-memory-learning', 'web.sqlite'))
    expect(validatedDreaming.databasePath).toBe(join(f.dshHome, 'assistant-dreaming', 'web.sqlite'))
    expect(validatedGrowth.usageLearning.databasePath).toBe(join(f.dshHome, 'assistant-growth-driver', 'web-usage.sqlite'))

    // Dreaming & Growth owner scope alignment.
    expect(validatedDreaming.scope).toEqual(validatedGrowth.scope)
    expect(validatedGrowth.dreamingIdeas).toEqual({ enabled: true, maxIdeasPerWake: 3 })

    // Verify readiness doctor accepts the compiled patch.
    const readiness = inspectAutonomyReadiness(savedPatch, 'web', f.dshHome)
    const dreamCheck = readiness.checks.find(c => c.id === 'dreaming')
    expect(dreamCheck?.status).toBe('ready')
    expect(dreamCheck?.details).toMatchObject({ dreamOwnerTransitionRulesConfigured: true })
    const subCheck = readiness.checks.find(c => c.id === 'autonomy-subsystems')
    expect(subCheck?.status).toBe('ready')
    expect(subCheck?.details).toMatchObject({
      memoryAuthoritiesDistinct: true,
      growthDreamingIdeasEnabled: true,
      dreamOwnerTransitionRulesConfigured: true,
    })

    // Exercise generated policy rules & finite budgets against real AssistantPolicyService.
    const personalCfg = rowConfig(savedPatch, 'dsh-enhanced-personal-assistant')
    expect(personalCfg.assistantAutomations.schedulerEnabled).toBe(true)
    const ctx = new Context()
    const policyService = new AssistantPolicyService(ctx, {
      databasePath: join(f.dshHome, 'personal-assistant', 'policy.sqlite'),
      rules: personalCfg.assistantPolicy.rules,
      budgets: personalCfg.assistantPolicy.budgets,
    })
    expect(policyService.authorize({
      subject: { kind: 'external', id: result.owner.principalId, workspace: f.workspace, principal: result.owner.principalId },
      action: 'dream.validate',
      resource: { kind: 'evolution', id: 'assistant-dreaming:idea:123' },
      context: { initiator: 'foreground' },
    }).effect).toBe('allow')
    expect(policyService.getBudgetConfig('web-memory-learning-web')?.limit).toBe(7)
    expect(policyService.getBudgetConfig('web-dreaming-web')?.limit).toBe(7)
    expect(policyService.getBudgetConfig('web-growth-reviews-web')?.limit).toBe(7)
    await ctx.fiber.restart()
  })

  test('supports idempotent re-application, safe dreaming pause, partial disable, and preserves custom rules', async () => {
    const f = await createWebAutonomyFixture()
    const doc = parseDocument(await readFile(f.patchPath, 'utf8'))
    const rows = doc.toJS() as Array<{ id: string; config?: Record<string, any> }>
    const personal = rows.find(r => r.id === 'dsh-enhanced-personal-assistant')!
    personal.config!.assistantPolicy = {
      ...personal.config!.assistantPolicy,
      rules: [{ id: 'custom-deny-rm', effect: 'deny', actions: ['execute'], resource: { kind: 'tool', id: 'shell' } }],
      budgets: [{ id: 'custom-tokens', metric: 'tokens', limit: 999, periodMs: 86_400_000, scope: 'workspace' }],
    }
    const delivery = rows.find(r => r.id === 'dsh-enhanced-assistant-delivery')!
    delivery.config!.ownerRoutes = [{
      id: 'unrelated-lark-route',
      conversation: { channel: 'lark', account: 'bot', tenant: 't', kind: 'dm', chat: 'oc_1' },
      principal: { channel: 'lark', account: 'bot', tenant: 't', user: 'ou_1' },
      workspace: '/other/ws',
      agentPreset: 'primary',
      policyRef: 'owner-dm',
      minimumGeneration: 1,
    }]
    await writeFile(f.patchPath, JSON.stringify(rows, null, 2), { mode: 0o600 })

    const fixedNow = 1_760_000_000_000
    const first = await applyWebOwnerAutonomySetup(
      { dshHome: f.dshHome, profile: 'web', memoryLearning: true, dreaming: 'enabled', growth: true, now: fixedNow },
      { readEffectiveSource: () => f.effective },
    )
    const second = await applyWebOwnerAutonomySetup(
      { dshHome: f.dshHome, profile: 'web', memoryLearning: true, dreaming: 'enabled', growth: true, now: fixedNow },
      { readEffectiveSource: () => f.effective },
    )
    expect(second.grants.patch).toBe(first.grants.patch)

    // Pause dreaming without mentioning memoryLearning/growth -> preserves both and retains dream.* foreground rules.
    const paused = await applyWebOwnerAutonomySetup(
      { dshHome: f.dshHome, profile: 'web', dreaming: 'paused', now: fixedNow },
      { readEffectiveSource: () => f.effective },
    )
    expect(paused.enabled).toEqual({
      memoryLearning: true,
      dreaming: 'paused',
      growth: true,
      usageLearning: false,
      workItemExperiences: false,
    })
    const pausedPatch = await readFile(f.patchPath, 'utf8')
    expect(rowConfig(pausedPatch, 'dsh-enhanced-assistant-dreaming')).toMatchObject({ enabled: true, retired: true })
    expect(validateDreamingConfig(rowConfig(pausedPatch, 'dsh-enhanced-assistant-dreaming')).retired).toBe(true)

    // Disable memory learning only -> preserves custom rule/budget, unrelated lark route, and dreaming/growth.
    await applyWebOwnerAutonomySetup(
      { dshHome: f.dshHome, profile: 'web', memoryLearning: false, now: fixedNow },
      { readEffectiveSource: () => f.effective },
    )
    const afterDisableMemory = await readFile(f.patchPath, 'utf8')
    expect(findRow(afterDisableMemory, 'dsh-enhanced-assistant-memory-learning').disabled).toBe(true)
    const afterPersonal = rowConfig(afterDisableMemory, 'dsh-enhanced-personal-assistant')
    expect(afterPersonal.assistantPolicy.rules.some((r: { id: string }) => r.id === 'custom-deny-rm')).toBe(true)
    expect(afterPersonal.assistantPolicy.rules.some((r: { id: string }) => r.id.includes('memory'))).toBe(false)
    expect(afterPersonal.assistantPolicy.budgets.map((b: { id: string }) => b.id)).toContain('custom-tokens')
    expect(rowConfig(afterDisableMemory, 'dsh-enhanced-assistant-delivery').ownerRoutes.map((r: { id: string }) => r.id))
      .toContain('unrelated-lark-route')
  })

  test('fails closed on missing/ambiguous Web owner binding, missing model route, disabled ACP, or DB leak', async () => {
    // 1. Missing active Web owner binding.
    const noBinding = await createWebAutonomyFixture({ withBinding: false })
    const prereqNoBind = inspectWebOwnerAutonomyPrerequisites(
      { dshHome: noBinding.dshHome, profile: 'web' },
      await readFile(noBinding.patchPath, 'utf8'),
      noBinding.effective,
    )
    expect(prereqNoBind.ok).toBe(false)
    expect(prereqNoBind.activeOwnerBinding.ok).toBe(false)
    await expect(applyWebOwnerAutonomySetup(
      { dshHome: noBinding.dshHome, profile: 'web', memoryLearning: true },
      { readEffectiveSource: () => noBinding.effective },
    )).rejects.toThrow(/no active Web owner session binding/u)

    // 2. Ambiguous multiple bindings without sessionId, resolved cleanly when sessionId supplied.
    const multi = await createWebAutonomyFixture({ withSecondBinding: true })
    await expect(applyWebOwnerAutonomySetup(
      { dshHome: multi.dshHome, profile: 'web', dreaming: 'enabled' },
      { readEffectiveSource: () => multi.effective },
    )).rejects.toThrow(/multiple active Web owner bindings.*--session-id/u)

    const resolvedMulti = await applyWebOwnerAutonomySetup(
      { dshHome: multi.dshHome, profile: 'web', dreaming: 'enabled', sessionId: 'session-secondary' },
      { readEffectiveSource: () => multi.effective },
    )
    expect(resolvedMulti.grants.ownerRoute.conversation.chat).toBe('session-secondary')

    // 3. Missing model route & half-specified route.
    const noModel = await createWebAutonomyFixture({ withSettingsModel: false })
    await expect(applyWebOwnerAutonomySetup(
      { dshHome: noModel.dshHome, profile: 'web', dreaming: 'enabled' },
      { readEffectiveSource: () => noModel.effective },
    )).rejects.toThrow(/no active model route/u)
    await expect(applyWebOwnerAutonomySetup(
      { dshHome: noModel.dshHome, profile: 'web', dreaming: 'enabled', modelProvider: 'deepseek-official' },
      { readEffectiveSource: () => noModel.effective },
    )).rejects.toThrow(/must be specified together/u)

    // 4. Disabled traex-acp-provider when selecting traex-agent.
    const disabledDoc = parseDocument(noModel.effective)
    disabledDoc.add({ id: 'dsh-enhanced-traex-acp-provider', disabled: true, config: {} })
    const disabledAcpEffective = disabledDoc.toString()
    expect(() => compileWebOwnerAutonomyGrants(
      { dshHome: noModel.dshHome, profile: 'web', dreaming: 'enabled', modelProvider: 'traex-agent', modelId: 'default' },
      readFileSync(noModel.patchPath, 'utf8'),
      disabledAcpEffective,
    )).toThrow(/dsh-enhanced-traex-acp-provider to be enabled/u)

    // 5. Rejects pre-existing global ~/.dsh/*.sqlite database path leak.
    const leakedPatch = parseDocument(readFileSync(multi.patchPath, 'utf8'))
    leakedPatch.add({ id: 'dsh-enhanced-assistant-dreaming', config: { databasePath: join(process.env.HOME ?? '/tmp', '.dsh', 'dreaming.sqlite') } })
    expect(() => compileWebOwnerAutonomyGrants(
      { dshHome: multi.dshHome, profile: 'web', dreaming: 'enabled' },
      leakedPatch.toString(),
      multi.effective,
    )).toThrow(/within DSH_HOME|global ~\/\.dsh/u)
  })

  test('runWebOwnerSetup CLI supports --dry-run, --json, and exits non-zero cleanly on conflicts', async () => {
    const f = await createWebAutonomyFixture()
    const binDir = join(f.dshHome, 'mock-bin')
    const dumpFile = join(f.dshHome, 'effective.yaml')
    await mkdir(binDir, { recursive: true })
    await writeFile(dumpFile, f.effective, { mode: 0o600 })
    const fakeDsh = join(binDir, 'dsh')
    await writeFile(fakeDsh, '#!/bin/sh\ncat "$TEST_WEB_EFFECTIVE"\n', { mode: 0o755 })

    const prevPath = process.env.PATH
    const prevEffective = process.env.TEST_WEB_EFFECTIVE
    const stdout: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk))
      return true
    }) as never)
    process.env.PATH = `${binDir}:${prevPath ?? ''}`
    process.env.TEST_WEB_EFFECTIVE = dumpFile
    try {
      const beforePatch = await readFile(f.patchPath, 'utf8')
      await runWebOwnerSetup([
        '--dsh-home', f.dshHome,
        '--profile', 'web',
        '--enable-memory-learning',
        '--enable-dreaming',
        '--enable-growth',
        '--model-provider', 'deepseek-official',
        '--model-id', 'deepseek-chat',
        '--daily-budget', '9',
        '--dry-run',
        '--json',
      ])
      const dryPayload = JSON.parse(stdout.join('')) as { ok: boolean; dryRun: boolean; applied: boolean; enabled: Record<string, unknown> }
      expect(dryPayload).toMatchObject({
        ok: true,
        dryRun: true,
        applied: false,
        enabled: { memoryLearning: true, dreaming: 'enabled', growth: true },
      })
      expect(await readFile(f.patchPath, 'utf8')).toBe(beforePatch)

      stdout.length = 0
      await runWebOwnerSetup([
        '--dsh-home', f.dshHome,
        '--profile', 'web',
        '--enable-memory-learning',
        '--enable-dreaming',
        '--enable-growth',
        '--daily-budget', '9',
        '--json',
      ])
      const applyPayload = JSON.parse(stdout.join('')) as { ok: boolean; applied: boolean; policyIds: { budgets: string[] } }
      expect(applyPayload).toMatchObject({ ok: true, applied: true })
      expect(applyPayload.policyIds.budgets).toEqual(['web-memory-learning-web', 'web-memory-scan-web', 'web-dreaming-web', 'web-growth-reviews-web'])

      stdout.length = 0
      await expect(runWebOwnerSetup([
        '--dsh-home', f.dshHome,
        '--profile', 'web',
        '--enable-dreaming',
        '--pause-dreaming',
        '--json',
      ])).rejects.toThrow(/conflicting dreaming mode flags/u)
      expect(JSON.parse(stdout.join(''))).toMatchObject({ ok: false })
      expect(process.exitCode).toBe(2)
    } finally {
      process.env.PATH = prevPath
      if (prevEffective === undefined) delete process.env.TEST_WEB_EFFECTIVE
      else process.env.TEST_WEB_EFFECTIVE = prevEffective
    }
  })
})
