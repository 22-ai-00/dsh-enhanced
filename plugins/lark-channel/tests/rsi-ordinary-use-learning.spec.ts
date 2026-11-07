import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { isMap, isSeq, parseDocument, stringify, type YAMLMap, type YAMLSeq } from 'yaml'
import { applyRecommendedPluginPreset } from '@dsh-enhanced/assistant-policy/plugin-setup'
import type { MemoryLearningOwner } from '@dsh-enhanced/assistant-growth-contract'

import { createRsiMemoryLearningSetup } from '../src/rsi-memory-learning.js'
import {
  createRsiOrdinaryUseLearningSetup,
  validateRsiOrdinaryUseLearningSetup,
} from '../src/rsi-ordinary-use-learning.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const owner: MemoryLearningOwner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64),
  principalId: 'lark/account/tenant/owner', principalRecordId: 'principal-record', principalVersion: 1,
  workspace: '/tmp/rsi-ordinary-workspace', agentPreset: 'primary' }

/** The preset's documented merge: base rows, then home/profile patch rows replace config whole. */
function dumpFixture(source: string) {
  return async (home: string, profile: string): Promise<YAMLSeq> => {
    const rows = parseDocument(source).contents as YAMLSeq
    for (const path of [join(home, 'cordis.patch.yml'), join(home, 'profiles', profile, 'cordis.patch.yml')]) {
      let patchSource: string
      try { patchSource = await readFile(path, 'utf8') } catch { continue }
      const patch = parseDocument(patchSource)
      if (patch.errors.length > 0 || !isSeq(patch.contents)) continue
      for (const entry of patch.contents.items) {
        if (!isMap(entry)) continue
        const target = rows.items.find(row => isMap(row) && row.get('id') === entry.get('id')) as YAMLMap | undefined
        if (target === undefined) continue
        if (entry.has('disabled')) target.set('disabled', entry.get('disabled'))
        const config = entry.get('config', true)
        if (isMap(config)) target.set('config', config.clone())
      }
    }
    return rows
  }
}

describe('RSI ordinary-use evaluator setup', () => {
  test('takes the route from the deployment or an explicit setup input and never guesses one', () => {
    expect(createRsiOrdinaryUseLearningSetup({ deliveryConfig: {
      agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' } }).intakeEvaluation)
      .toEqual({ enabled: true, rules: [{ ruleId: 'ordinary-use-intake', ceiling: 'digest' }],
        provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(createRsiOrdinaryUseLearningSetup({ deliveryConfig: {},
      intakeProvider: 'explicit-provider', intakeModel: 'explicit-model' }).intakeEvaluation)
      .toMatchObject({ provider: 'explicit-provider', model: 'explicit-model' })
    expect(() => createRsiOrdinaryUseLearningSetup({ deliveryConfig: {} }))
      .toThrow('requires Delivery agentProvider/agentModel')
    expect(() => createRsiOrdinaryUseLearningSetup({ deliveryConfig: {
      agentProvider: 'a', agentModel: 'b' }, intakeProvider: 'only-one' })).toThrow('together')
    expect(() => validateRsiOrdinaryUseLearningSetup({ intakeEvaluation: { enabled: true,
      rules: [{ ruleId: 'triage', ceiling: 'accept' }], provider: 'a', model: 'b' } }))
      .toThrow('digest or notify')
  })

  test('fails closed when the route is not a composed LLM provider', () => {
    expect(() => createRsiOrdinaryUseLearningSetup({ deliveryConfig: {
      agentProvider: 'traex-agent', agentModel: 'default' }, llmProviders: new Set(['deepseek-official']) }))
      .toThrow('not configured as an LLM provider')
    expect(createRsiOrdinaryUseLearningSetup({ deliveryConfig: {
      agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' },
      llmProviders: new Set(['deepseek-official']) }).intakeEvaluation.provider).toBe('deepseek-official')
    // An empty discovery result keeps legacy/simple profiles working; only a
    // positively discovered registry can prove a provider is unusable.
    expect(createRsiOrdinaryUseLearningSetup({ deliveryConfig: {
      agentProvider: 'x', agentModel: 'y' }, llmProviders: new Set() }).intakeEvaluation.provider).toBe('x')
  })

  test('the recommended preset flips only the switches whose RSI prerequisites already exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rsi-ordinary-preset-')); roots.push(home)
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    const evaluator = createRsiOrdinaryUseLearningSetup({ deliveryConfig: {
      agentProvider: 'deepseek-official', agentModel: 'deepseek-v4-flash' } }).intakeEvaluation
    const now = Date.now()
    const memory = createRsiMemoryLearningSetup({ installationId: 'preset-fixture', stateRoot: '/tmp/rsi-state',
      owner, now, expiresAt: now + 60_000, workItemExperiences: true })
    const source = stringify([
      { id: 'dsh-enhanced-assistant-work-items', name: '@dsh-enhanced/assistant-work-items',
        config: { enabled: true, mode: 'observe', intakeLedger: { enabled: true } } },
      { id: 'dsh-enhanced-assistant-proactive', name: '@dsh-enhanced/assistant-proactive',
        config: { intakeEvaluation: { rules: evaluator.rules, provider: evaluator.provider, model: evaluator.model } } },
      { id: 'dsh-enhanced-assistant-memory-learning', name: '@dsh-enhanced/assistant-memory-learning',
        config: { databasePath: '/tmp/rsi-learning.sqlite' } },
      { id: 'dsh-enhanced-assistant-verifier', name: '@dsh-enhanced/assistant-verifier',
        config: { memoryReviews: memory.reviews } },
      { id: 'dsh-enhanced-personal-assistant', name: '@dsh-enhanced/personal-assistant',
        config: { personalMemory: { automaticLearning: memory.adoption } } },
    ])
    const options = { readDump: dumpFixture(source) }
    const result = await applyRecommendedPluginPreset({ dshHome: home, profile: 'web' }, options)
    expect(result.changes).toEqual([
      { id: 'dsh-enhanced-assistant-work-items', key: 'intakeLedger.evaluation.enabled', from: undefined, to: true },
      { id: 'dsh-enhanced-assistant-proactive', key: 'intakeEvaluation.enabled', from: undefined, to: true },
      { id: 'dsh-enhanced-assistant-memory-learning', key: 'workItemExperiences', from: undefined, to: true },
    ])
    const patch = parseDocument(await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toJSON() as
      Array<{ id: string; config?: Record<string, any> }>
    const configOf = (id: string) => patch.find(row => row.id === id)?.config
    expect(configOf('dsh-enhanced-assistant-work-items')).toMatchObject({ intakeLedger: { evaluation: { enabled: true } } })
    expect(configOf('dsh-enhanced-assistant-proactive')).toMatchObject({ intakeEvaluation: { enabled: true } })
    expect(configOf('dsh-enhanced-assistant-memory-learning')).toMatchObject({ workItemExperiences: true })
    const again = await applyRecommendedPluginPreset({ dshHome: home, profile: 'web' }, options)
    expect(again.changes).toEqual([])
  }, 30_000)
})
