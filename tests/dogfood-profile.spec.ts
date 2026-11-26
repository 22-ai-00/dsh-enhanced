import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeliveryStore } from '../plugins/assistant-delivery/lib/store.js'
import { EvaluationStore } from '../plugins/assistant-evaluation/lib/index.js'
import { applyDogfoodPluginPreset } from '../plugins/assistant-policy/lib/plugin-setup.js'
import { applyWebOwnerAutonomySetup } from '../plugins/assistant-web-owner/lib/index.js'
import { prepareWebOwnerProfile } from '../plugins/assistant-web-owner/src/setup.ts'
import { AssistantWorkItemsService, ConfigSchema as WorkItemsConfigSchema } from '../plugins/assistant-work-items/lib/index.js'
import { collectGrowthReport } from '../packages/dsh-ray/lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(root, 'scripts', 'install', 'install-local.sh')
const exampleProfilePath = join(root, 'docs', 'examples', 'dogfood-macos.profile.json')

const tempHomes: string[] = []
afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function createTempHome(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-dogfood-e2e-')))
  tempHomes.push(dir)
  return dir
}

const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve: (value: string) => value,
}

async function buildMergedEffectiveDump(slugs: readonly string[], patchPath: string): Promise<{ seq: YAMLSeq; yaml: string }> {
  const baseDoc = parseDocument('[]', { customTags: [JS_TAG] })
  const baseSeq = baseDoc.contents as YAMLSeq
  for (const slug of slugs) {
    const patchSource = await readFile(join(root, 'plugins', slug, 'cordis.patch.yml'), 'utf8')
    const doc = parseDocument(patchSource, { customTags: [JS_TAG] })
    const seq = doc.contents as YAMLSeq
    for (const item of seq.items) {
      if (!isMap(item)) continue
      const inserts = item.get('insert', true)
      if (isSeq(inserts)) {
        for (const inserted of inserts.items) baseSeq.add(inserted)
      } else if (item.has('id')) {
        baseSeq.add(item)
      }
    }
  }

  // Overlay profile cordis.patch.yml row replacements (matching DSH profile patch semantics)
  let patchSource = ''
  try {
    patchSource = await readFile(patchPath, 'utf8')
  } catch {
    patchSource = ''
  }
  if (patchSource.trim() !== '') {
    const patchDoc = parseDocument(patchSource, { customTags: [JS_TAG] })
    if (isSeq(patchDoc.contents)) {
      for (const patchRow of patchDoc.contents.items) {
        if (!isMap(patchRow)) continue
        const rowId = patchRow.get('id')
        if (typeof rowId !== 'string') continue
        const existingIdx = baseSeq.items.findIndex(entry => isMap(entry) && entry.get('id') === rowId)
        if (existingIdx >= 0) {
          const targetRow = baseSeq.items[existingIdx] as YAMLMap
          if (patchRow.has('disabled')) targetRow.set('disabled', patchRow.get('disabled', true))
          if (patchRow.has('config')) targetRow.set('config', patchRow.get('config', true))
        } else {
          baseSeq.add(patchRow)
        }
      }
    }
  }

  return { seq: baseSeq, yaml: baseDoc.toString({ lineWidth: 0 }) }
}

describe('macOS dogfood profile end-to-end closed loop', () => {
  test('install-local.sh --scenario web --plugin-preset dogfood installs the full dogfood cohort matching docs/examples/dogfood-macos.profile.json', async () => {
    const dshHome = await createTempHome()
    const workspace = join(dshHome, 'workspace')
    const example = JSON.parse(await readFile(exampleProfilePath, 'utf8')) as {
      schemaVersion: number
      preset: string
      installedCohort: string[]
      applyCommands: string[]
      inspectionCommand: string
    }

    expect(example.schemaVersion).toBe(1)
    expect(example.preset).toBe('dogfood')
    expect(example.applyCommands).toHaveLength(5)
    expect(example.applyCommands[0]).toContain('--scenario web')
    expect(example.applyCommands[0]).toContain('--plugin-preset dogfood')
    expect(example.applyCommands[1]).toContain('dsh-ray open --profile web')
    expect(example.applyCommands[2]).toContain('/profiles/web/node_modules/.bin/dsh-web-owner-setup')
    expect(example.applyCommands[2]).toContain('--autonomy-setup')
    expect(example.applyCommands[2]).toContain('--enable-memory-learning')
    expect(example.applyCommands[3]).toContain('/profiles/web/node_modules/.bin/dsh-plugin-setup')
    expect(example.applyCommands[4]).toContain('dsh-ray open --profile web')
    expect(example.inspectionCommand).toBe('dsh-ray growth-report --profile web --since 14d')

    const result = spawnSync(
      '/bin/bash',
      [installer, '--dry-run', '--profile', 'web', '--scenario', 'web', '--workspace', workspace, '--model', 'skip', '--plugin-preset', 'dogfood', '--yes'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: dshHome, DSH_RAY_PLATFORM_OVERRIDE: 'Darwin' },
      },
    )
    expect(result.status, result.stderr).toBe(0)

    for (const slug of example.installedCohort) {
      expect(result.stdout).toContain(join(root, 'plugins', slug))
    }
    expect(result.stdout).toContain(`dsh-web-owner-setup --dsh-home ${dshHome} --profile web --workspace ${workspace} --preset standard`)
    expect(result.stdout).toContain(`dsh-plugin-setup preset dogfood --yes --dsh-home ${dshHome} --profile web`)
  })

  test('completes Web-owner install -> session binding -> autonomy memory-learning grant -> dogfood preset -> growth-report without no-data gaps', async () => {
    const dshHome = await createTempHome()
    const workspace = join(dshHome, 'workspace')
    await mkdir(workspace, { recursive: true })
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })

    const example = JSON.parse(await readFile(exampleProfilePath, 'utf8')) as { installedCohort: string[] }
    const cohort = example.installedCohort
    const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')

    // Materialize profile package.json + node_modules markers so profile-scoped growth-report recognizes installed families
    for (const slug of cohort) {
      await mkdir(join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-ray', slug), { recursive: true })
      await writeFile(
        join(dshHome, 'profiles', 'web', 'node_modules', '@dsh-ray', slug, 'package.json'),
        JSON.stringify({ name: `@dsh-ray/${slug}`, version: '0.1.76' }),
      )
    }
    await writeFile(
      join(dshHome, 'profiles', 'web', 'package.json'),
      JSON.stringify({
        private: true,
        dependencies: Object.fromEntries(cohort.map(slug => [`@dsh-ray/${slug}`, '0.1.76'])),
      }),
    )

    // Step 1a: Initial Web-owner setup (during `dsh-ray install --scenario web --plugin-preset dogfood`)
    const initialEffective = await buildMergedEffectiveDump(cohort, patchPath)
    const initialPlan = prepareWebOwnerProfile(
      { dshHome, profile: 'web', workspace, preset: 'standard' },
      '[]',
      initialEffective.yaml,
    )
    await writeFile(patchPath, initialPlan.patch, { mode: 0o600 })

    // Step 1b: First-pass `preset dogfood` during install (before Web session pairing)
    const firstPass = await applyDogfoodPluginPreset(
      { dshHome, profile: 'web' },
      { readDump: async () => (await buildMergedEffectiveDump(cohort, patchPath)).seq },
    )
    expect(firstPass.changed).toBe(true)

    // Step 2: `dsh-ray open --profile web` creates the real idle Web owner Session binding + model settings
    await mkdir(dirname(initialPlan.databasePath), { recursive: true })
    const delivery = new DeliveryStore({ path: initialPlan.databasePath })
    try {
      delivery.ensureOwner(initialPlan.principal)
      delivery.createBinding({
        conversation: { channel: 'web', account: 'web', tenant: 'local', kind: 'dm', chat: 'session-dogfood-1' },
        principal: initialPlan.principal,
        workspace,
        agentPreset: 'standard',
        sessionId: 'session-dogfood-1',
        policyRef: 'owner-dm',
      })
    } finally {
      delivery.close()
    }
    await writeFile(
      join(dshHome, 'settings.yaml'),
      'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-chat\n',
      { mode: 0o600 },
    )

    // Step 3: `dsh-web-owner-setup --autonomy-setup --budget-tier conservative --enable-memory-learning --work-item-experiences`
    const autonomyResult = await applyWebOwnerAutonomySetup(
      {
        dshHome,
        profile: 'web',
        workspace,
        preset: 'standard',
        budgetTier: 'conservative',
        memoryLearning: true,
        workItemExperiences: true,
      },
      {
        readEffectiveSource: async () => (await buildMergedEffectiveDump(cohort, patchPath)).yaml,
      },
    )
    expect(autonomyResult.ok).toBe(true)
    expect(autonomyResult.applied).toBe(true)
    expect(autonomyResult.enabled.memoryLearning).toBe(true)
    expect(autonomyResult.enabled.workItemExperiences).toBe(true)

    // Step 4: `dsh-plugin-setup preset dogfood --profile web --yes` completes with zero missing-bundle or missing-memory-grant skips
    const secondPass = await applyDogfoodPluginPreset(
      { dshHome, profile: 'web' },
      { readDump: async () => (await buildMergedEffectiveDump(cohort, patchPath)).seq },
    )
    expect(secondPass.skipped.filter(s => s.id === 'dsh-ray-assistant-memory-learning')).toEqual([])
    expect(secondPass.skipped.filter(s => s.reason === 'not installed')).toEqual([])
    expect(secondPass.skipped).toContainEqual({
      id: 'dsh-ray-assistant-work-items',
      reason: expect.stringMatching(/originBindingId/u),
    })

    const finalDump = (await buildMergedEffectiveDump(cohort, patchPath)).seq.toJSON() as Array<{
      id: string
      disabled?: boolean
      config?: Record<string, unknown>
    }>
    const byId = new Map(finalDump.map(r => [r.id, r]))
    expect(byId.get('dsh-ray-preference-learning')?.config).toMatchObject({
      enabled: true,
      autonomousT1Enabled: true,
    })
    expect(byId.get('dsh-ray-assistant-evaluation')?.config).toMatchObject({
      notificationOutcomesEnabled: true,
      intakeAttentionAgreementEnabled: true,
      intakeEvaluationAgreementEnabled: true,
      attentionTuningAutoAdopt: true,
      attentionLooseningEnabled: true,
    })
    const wiCfg = byId.get('dsh-ray-assistant-work-items')?.config
    expect(wiCfg).toMatchObject({
      enabled: true,
      mode: 'observe',
      intakeLedger: { enabled: true, evaluation: { enabled: true } },
    })
    expect((wiCfg?.['intakeLedger'] as { evaluation?: { admit?: unknown } } | undefined)?.evaluation?.admit).toBeUndefined()
    const wiService = new AssistantWorkItemsService(new Context(), WorkItemsConfigSchema({
      ...wiCfg,
      databasePath: join(dshHome, 'assistant-work-items', 'state.sqlite'),
      workRoot: join(dshHome, 'assistant-work-items', 'work'),
    }))
    expect(wiService.intakeAdmissionMode()).toBe('disabled')
    expect(byId.get('dsh-ray-assistant-memory-learning')?.disabled).toBe(false)
    expect(byId.get('dsh-ray-assistant-memory-learning')?.config).toMatchObject({
      workItemExperiences: true,
    })
    expect(byId.get('dsh-ray-assistant-association')?.config).toMatchObject({
      enabled: true,
      dreaming: { enabled: true },
      intakeSignal: { enabled: true },
      webLearning: { enabled: true },
    })

    // Step 5: Initialize the configured SQLite ledgers (as Host boot does) and verify `growth-report` has zero `no-data` sections!
    await mkdir(join(dshHome, 'assistant-evaluation'), { recursive: true })
    const evalStore = new EvaluationStore({ path: join(dshHome, 'assistant-evaluation', 'evaluation.sqlite') })
    evalStore.close()

    await mkdir(join(dshHome, 'personal-memory'), { recursive: true })
    const memDb = new DatabaseSync(join(dshHome, 'personal-memory', 'memory.sqlite'))
    memDb.exec('CREATE TABLE memory_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    memDb.close()

    await mkdir(join(dshHome, 'preference-learning'), { recursive: true })
    const prefDb = new DatabaseSync(join(dshHome, 'preference-learning', 'preferences.sqlite'))
    prefDb.exec(`
      CREATE TABLE preference_hypotheses (id TEXT PRIMARY KEY, effect_state TEXT NOT NULL);
      CREATE TABLE preference_exposures (idempotency_key TEXT PRIMARY KEY, state TEXT NOT NULL, exposed_at INTEGER NOT NULL);
      CREATE TABLE preference_signals (id TEXT PRIMARY KEY, stance TEXT NOT NULL, actor_trust TEXT NOT NULL, occurred_at INTEGER NOT NULL);
      CREATE TABLE preference_transitions (id INTEGER PRIMARY KEY AUTOINCREMENT, reason TEXT NOT NULL, occurred_at INTEGER NOT NULL);
    `)
    prefDb.close()

    const report = await collectGrowthReport({ dshHome, profile: 'web', since: '14d' })
    expect(report.overallState).toBe('zero')
    expect(report.tasks.state).toBe('zero')
    expect(report.memory.state).toBe('zero')
    expect(report.candidates.state).toBe('zero')
    expect(report.notifications.state).toBe('zero')
    expect(report.suppliers.state).toBe('zero')
    expect(report.memoryLaneGate.status).toBe('collecting')
  })

  test('enables intakeLedger.evaluation.admit.enabled and boots AssistantWorkItemsService cleanly when originBindingId is configured in cordis.patch.yml', async () => {
    const dshHome = await createTempHome()
    await mkdir(join(dshHome, 'profiles', 'web'), { recursive: true })
    const example = JSON.parse(await readFile(exampleProfilePath, 'utf8')) as { installedCohort: string[] }
    const cohort = example.installedCohort
    const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
    await writeFile(patchPath, [
      '- id: dsh-ray-assistant-work-items',
      '  config:',
      '    enabled: false',
      '    mode: observe',
      '    intakeSourceId: work-items/v1',
      '    intakeLedger:',
      '      enabled: false',
      '      evaluation:',
      '        enabled: true',
      '        admit:',
      '          originBindingId: binding-origin-1',
      '',
    ].join('\n'), { mode: 0o600 })

    const presetResult = await applyDogfoodPluginPreset(
      { dshHome, profile: 'web' },
      { readDump: async () => (await buildMergedEffectiveDump(cohort, patchPath)).seq },
    )
    expect(presetResult.changes).toContainEqual({
      id: 'dsh-ray-assistant-work-items',
      key: 'enabled',
      from: false,
      to: true,
    })
    expect(presetResult.changes).toContainEqual({
      id: 'dsh-ray-assistant-work-items',
      key: 'intakeLedger.enabled',
      from: false,
      to: true,
    })
    expect(presetResult.changes).toContainEqual({
      id: 'dsh-ray-assistant-work-items',
      key: 'intakeLedger.evaluation.admit.enabled',
      from: undefined,
      to: true,
    })
    expect(presetResult.skipped.some(s => s.id === 'dsh-ray-assistant-work-items' && s.reason.includes('originBindingId'))).toBe(false)

    const finalDump = (await buildMergedEffectiveDump(cohort, patchPath)).seq.toJSON() as Array<{
      id: string
      config?: Record<string, unknown>
    }>
    const wiCfg = finalDump.find(r => r.id === 'dsh-ray-assistant-work-items')?.config
    expect(wiCfg).toMatchObject({
      enabled: true,
      mode: 'observe',
      intakeLedger: {
        enabled: true,
        evaluation: {
          admit: {
            enabled: true,
            originBindingId: 'binding-origin-1',
          },
        },
      },
    })
    const wiService = new AssistantWorkItemsService(new Context(), WorkItemsConfigSchema({
      ...wiCfg,
      databasePath: join(dshHome, 'assistant-work-items', 'state.sqlite'),
      workRoot: join(dshHome, 'assistant-work-items', 'work'),
    }))
    expect(wiService.intakeAdmissionMode()).toBe('observe')
  })
})
