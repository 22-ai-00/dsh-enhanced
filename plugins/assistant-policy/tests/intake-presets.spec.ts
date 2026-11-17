import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import {
  AUTONOMY_INTAKE_RULE_PRESETS,
  AssistantPolicyService,
  INTAKE_EVALUATION_LEVELS,
  INTAKE_PRESET_RULE_IDS,
  INTAKE_RULE_PRESETS,
  INTAKE_RULE_PRESET_CATALOG,
  INTAKE_RULE_PRESET_TIERS,
  MAX_INTAKE_EVALUATION_RULES,
  buildIntakeRulePreset,
  buildWebOwnerIntakeEvaluationConfig,
  isIntakeEvaluationLevel,
  isIntakeRulePresetTier,
  isValidIntakeRuleId,
  resolveIntakeEvaluationPresetRules,
  webOwnerIntakeRuleIds,
} from '../src/index.ts'
import {
  applyRecommendedPluginPreset,
  coerceConfigValue,
  type PluginSetupIo,
  runPluginSetup,
  setPluginConfigValue,
  unsetPluginConfigValue,
} from '../src/plugin-setup.ts'

const temporaryRoots: string[] = []

async function temporaryHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-policy-intake-presets-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'profiles', 'web'), { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const proactiveBundles = `
- id: dsh-enhanced-assistant-proactive
  name: '@dsh-enhanced/assistant-proactive'
  config:
    intakeEvaluation:
      enabled: false
      rules: []
`

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

describe('WP20 opt-in inferred intake evaluation rule presets', () => {
  test('exposes exact deterministic rule IDs and bounded ceilings for conservative and balanced tiers', () => {
    expect(INTAKE_EVALUATION_LEVELS).toEqual(['ignore', 'digest', 'notify', 'accept'])
    expect(INTAKE_RULE_PRESET_TIERS).toEqual(['conservative', 'balanced'])
    expect(INTAKE_PRESET_RULE_IDS).toEqual([
      'dsh-intake-calendar-imminent',
      'dsh-intake-file-watch-change',
      'dsh-intake-github-mention-or-review',
      'dsh-intake-webhook-priority',
    ])
    expect(webOwnerIntakeRuleIds()).toEqual(INTAKE_PRESET_RULE_IDS)
    expect(INTAKE_RULE_PRESET_CATALOG.map(entry => entry.ruleId)).toEqual(INTAKE_PRESET_RULE_IDS)

    expect(INTAKE_RULE_PRESETS.conservative).toEqual([
      { ruleId: 'dsh-intake-calendar-imminent', ceiling: 'notify' },
      { ruleId: 'dsh-intake-file-watch-change', ceiling: 'digest' },
      { ruleId: 'dsh-intake-github-mention-or-review', ceiling: 'notify' },
      { ruleId: 'dsh-intake-webhook-priority', ceiling: 'notify' },
    ])
    expect(INTAKE_RULE_PRESETS.balanced).toEqual([
      { ruleId: 'dsh-intake-calendar-imminent', ceiling: 'notify' },
      { ruleId: 'dsh-intake-file-watch-change', ceiling: 'digest' },
      { ruleId: 'dsh-intake-github-mention-or-review', ceiling: 'accept' },
      { ruleId: 'dsh-intake-webhook-priority', ceiling: 'notify' },
    ])
    expect(AUTONOMY_INTAKE_RULE_PRESETS).toBe(INTAKE_RULE_PRESETS)

    for (const tier of INTAKE_RULE_PRESET_TIERS) {
      const built = buildIntakeRulePreset(tier)
      expect(built).toEqual(INTAKE_RULE_PRESETS[tier])
      expect(built).not.toBe(INTAKE_RULE_PRESETS[tier])
      expect(Object.isFrozen(built)).toBe(true)
      for (const rule of built) {
        expect(Object.isFrozen(rule)).toBe(true)
        expect(Object.keys(rule).sort()).toEqual(['ceiling', 'ruleId'])
        expect(isValidIntakeRuleId(rule.ruleId)).toBe(true)
        expect(isIntakeEvaluationLevel(rule.ceiling)).toBe(true)
      }
      // Conservative tier never allows automatic admission (`accept`).
      if (tier === 'conservative') {
        expect(built.some(rule => rule.ceiling === 'accept')).toBe(false)
      }
    }

    expect(Object.isFrozen(INTAKE_RULE_PRESET_CATALOG)).toBe(true)
    for (const entry of INTAKE_RULE_PRESET_CATALOG) {
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.ceilings)).toBe(true)
    }
  })

  test('keeps default behavior unchanged unless explicitly opted in', async () => {
    expect(resolveIntakeEvaluationPresetRules()).toBeUndefined()
    expect(resolveIntakeEvaluationPresetRules(null)).toBeUndefined()
    expect(resolveIntakeEvaluationPresetRules({})).toBeUndefined()
    expect(resolveIntakeEvaluationPresetRules({ rules: [] })).toBeUndefined()
    expect(resolveIntakeEvaluationPresetRules({ preset: null, rules: null })).toBeUndefined()

    expect(buildWebOwnerIntakeEvaluationConfig({})).toBeUndefined()
    expect(buildWebOwnerIntakeEvaluationConfig({
      enabled: false,
      tier: 'balanced',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })).toBeUndefined()

    const root = await temporaryHome()
    const ctx = new Context()
    try {
      const service = new AssistantPolicyService(ctx, {
        databasePath: join(root, 'policy.sqlite'),
        proposalMaintenanceIntervalMs: 0,
      })
      expect(service.inspectHostConfiguration()).toEqual({
        rules: [],
        toolDefaultEffect: 'deny',
        budgets: [],
        autoReview: null,
      })
    } finally {
      await ctx.fiber.restart()
    }
  })

  test('resolves presets alone, explicit rules alone, and explicit overrides over a preset', () => {
    expect(resolveIntakeEvaluationPresetRules({ preset: 'conservative', rules: [] }))
      .toEqual(INTAKE_RULE_PRESETS.conservative)

    expect(resolveIntakeEvaluationPresetRules({
      rules: [
        { ruleId: 'z-rule', ceiling: 'notify' },
        { ruleId: 'a-rule', ceiling: 'digest' },
      ],
    })).toEqual([
      { ruleId: 'a-rule', ceiling: 'digest' },
      { ruleId: 'z-rule', ceiling: 'notify' },
    ])

    const merged = resolveIntakeEvaluationPresetRules({
      preset: 'balanced',
      rules: [
        { ruleId: 'dsh-intake-file-watch-change', ceiling: 'ignore' },
        { ruleId: 'custom-priority-alert', ceiling: 'notify' },
      ],
    })
    expect(merged).toEqual([
      { ruleId: 'custom-priority-alert', ceiling: 'notify' },
      { ruleId: 'dsh-intake-calendar-imminent', ceiling: 'notify' },
      { ruleId: 'dsh-intake-file-watch-change', ceiling: 'ignore' },
      { ruleId: 'dsh-intake-github-mention-or-review', ceiling: 'accept' },
      { ruleId: 'dsh-intake-webhook-priority', ceiling: 'notify' },
    ])
    expect(Object.isFrozen(merged)).toBe(true)

    const autonomyConfig = buildWebOwnerIntakeEvaluationConfig({
      enabled: true,
      tier: 'conservative',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxCallsPerHour: 30,
      timeoutMs: 15_000,
      maxConsecutiveFailures: 2,
    })
    expect(autonomyConfig).toEqual({
      enabled: true,
      rules: INTAKE_RULE_PRESETS.conservative,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      maxCallsPerHour: 30,
      timeoutMs: 15_000,
      maxConsecutiveFailures: 2,
    })
    expect(Object.isFrozen(autonomyConfig)).toBe(true)
  })

  test('fails closed on invalid presets, malformed rules, duplicates, and missing autonomy bounds', () => {
    expect(isIntakeRulePresetTier('conservative')).toBe(true)
    expect(isIntakeRulePresetTier('balanced')).toBe(true)
    expect(isIntakeRulePresetTier('aggressive')).toBe(false)
    expect(isIntakeRulePresetTier('')).toBe(false)

    expect(() => buildIntakeRulePreset('aggressive' as never)).toThrow(/conservative.*balanced/u)
    expect(() => resolveIntakeEvaluationPresetRules({ preset: 'custom' })).toThrow(/conservative.*balanced/u)
    expect(() => resolveIntakeEvaluationPresetRules([] as never)).toThrow(/must be an object/u)
    expect(() => resolveIntakeEvaluationPresetRules({ rules: 'bad' as never })).toThrow(/must be an array/u)
    expect(() => resolveIntakeEvaluationPresetRules({
      rules: [{ ruleId: 'valid-id', ceiling: 'notify', extra: true }],
    })).toThrow(/exactly ruleId and ceiling/u)
    expect(() => resolveIntakeEvaluationPresetRules({
      rules: [{ ruleId: 'invalid id with spaces', ceiling: 'notify' }],
    })).toThrow(/invalid shape/u)
    expect(() => resolveIntakeEvaluationPresetRules({
      rules: [{ ruleId: 'valid-id', ceiling: 'execute' }],
    })).toThrow(/ignore, digest, notify, accept/u)
    expect(() => resolveIntakeEvaluationPresetRules({
      rules: [
        { ruleId: 'dup-id', ceiling: 'digest' },
        { ruleId: 'dup-id', ceiling: 'notify' },
      ],
    })).toThrow(/repeats ruleId/u)

    const tooMany = Array.from({ length: MAX_INTAKE_EVALUATION_RULES + 1 }, (_, i) => ({
      ruleId: `rule-${i}`,
      ceiling: 'digest',
    }))
    expect(() => resolveIntakeEvaluationPresetRules({ rules: tooMany })).toThrow(/at most 16/u)

    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      ruleId: `extra-rule-${i}`,
      ceiling: 'digest',
    }))
    expect(() => resolveIntakeEvaluationPresetRules({ preset: 'conservative', rules: thirteen })).toThrow(/exceed maximum of 16/u)

    expect(() => buildWebOwnerIntakeEvaluationConfig({ enabled: 'true' as never })).toThrow(/boolean/u)
    expect(() => buildWebOwnerIntakeEvaluationConfig({ enabled: true, tier: 'conservative' })).toThrow(/provider/u)
    expect(() => buildWebOwnerIntakeEvaluationConfig({
      enabled: true,
      tier: 'conservative',
      provider: 'deepseek-official',
    })).toThrow(/model/u)
    expect(() => buildWebOwnerIntakeEvaluationConfig({
      enabled: true,
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })).toThrow(/explicit tier or at least one rule/u)
    expect(() => buildWebOwnerIntakeEvaluationConfig({
      enabled: true,
      tier: 'conservative',
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      timeoutMs: 500,
    })).toThrow(/between 1000 and 600000/u)
  })

  test('registers intakeEvaluation.preset in plugin-setup without changing recommended preset defaults', async () => {
    expect(coerceConfigValue('dsh-enhanced-assistant-proactive', 'intakeEvaluation.preset', 'conservative', undefined))
      .toBe('conservative')
    expect(coerceConfigValue('dsh-enhanced-assistant-proactive', 'intakeEvaluation.preset', 'balanced', undefined))
      .toBe('balanced')
    expect(() => coerceConfigValue('dsh-enhanced-assistant-proactive', 'intakeEvaluation.preset', 'aggressive', undefined))
      .toThrow(/intakeEvaluation\.preset must be one of conservative, balanced/u)

    const home = await temporaryHome()
    const opts = { readDump: dumpFixture(proactiveBundles) }

    // Recommended preset still refuses to invent rules or enable intakeEvaluation implicitly.
    const presetResult = await applyRecommendedPluginPreset({ dshHome: home, profile: 'web' }, opts)
    expect(presetResult.changed).toBe(false)
    expect(presetResult.skipped).toContainEqual({
      id: 'dsh-enhanced-assistant-proactive',
      reason: expect.stringMatching(/rules is missing or invalid/u),
    })

    // Explicit opt-in via plugin-setup works without --force and validates transitions.
    const first = await setPluginConfigValue({
      dshHome: home,
      profile: 'web',
      plugin: 'assistant-proactive',
      key: 'intakeEvaluation.preset',
      value: 'conservative',
    }, opts)
    expect(first.changes).toEqual([
      { id: 'dsh-enhanced-assistant-proactive', key: 'intakeEvaluation.preset', from: undefined, to: 'conservative' },
    ])

    const second = await setPluginConfigValue({
      dshHome: home,
      profile: 'web',
      plugin: 'assistant-proactive',
      key: 'intakeEvaluation.preset',
      value: 'balanced',
    }, opts)
    expect(second.changes).toEqual([
      { id: 'dsh-enhanced-assistant-proactive', key: 'intakeEvaluation.preset', from: 'conservative', to: 'balanced' },
    ])

    const answers = ['1', 'b', 'q']
    const io: PluginSetupIo & { output: string } = {
      output: '',
      isTTY: true,
      write(text: string) { io.output += text },
      async ask(question: string) { io.output += question; return answers.shift() ?? 'q' },
    }
    await runPluginSetup(['--dsh-home', home], io, opts)
    expect(io.output).toContain('intakeEvaluation.preset (conservative|balanced)')

    const unset = await unsetPluginConfigValue({
      dshHome: home,
      profile: 'web',
      plugin: 'assistant-proactive',
      key: 'intakeEvaluation.preset',
    }, opts)
    expect(unset.changes).toEqual([
      { id: 'dsh-enhanced-assistant-proactive', key: 'intakeEvaluation.preset', from: 'balanced', to: undefined },
    ])
  })
})
