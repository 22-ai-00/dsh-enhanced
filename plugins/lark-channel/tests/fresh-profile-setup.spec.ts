import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { isMap, isSeq, parseDocument, type Node, type YAMLMap } from 'yaml'
import {
  managedProfileOverrideNeedsMaterialization,
  materializeManagedProfileOverride,
} from '../src/setup-materialization.ts'
import { runLarkSetup } from '../src/setup.ts'

function effectiveFreshProfile(): string {
  return `
# == @dsh-enhanced/assistant-delivery
- id: dsh-enhanced-assistant-delivery
  name: '@dsh-enhanced/assistant-delivery'
  inject: [assistantPolicy]
  config:
    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')
    spoolPath: !!js dshHomePath('assistant-delivery/spool')
    schedulerEnabled: true
    defaultWorkspace: !!js dshHomePath('assistant-workspace')
    defaultAgentPreset: standard
# == @dsh-enhanced/personal-assistant
- id: dsh-enhanced-personal-assistant
  name: '@dsh-enhanced/personal-assistant'
  config:
    assistantPolicy:
      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')
      rules:
        - id: deployment-deny-background-shell
          effect: deny
          subject: { kind: background, id: '*' }
          actions: [execute]
          resource: { kind: tool, id: bash }
          context: { initiators: [background] }
        - id: dsh-enhanced-foreground-capability-*
          effect: allow
          subject: { kind: agent, id: '*', workspace: '*' }
          actions: ['*']
          resource: { kind: '*', id: '*' }
          context: { initiators: [foreground] }
      budgets: []
    personalMemory:
      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')
      approvalMode: delivery-required
    personalWiki:
      vaultRoot: !!js dshHomePath('personal-wiki/vault')
      databasePath: !!js dshHomePath('personal-wiki/state.sqlite')
    assistantAutomations:
      databasePath: !!js dshHomePath('assistant-automations/state.sqlite')
      runsPath: !!js dshHomePath('assistant-automations/runs')
      schedulerEnabled: false
`
}

function rowConfig(profilePatch: string, id: string): YAMLMap {
  const document = parseDocument(profilePatch)
  expect(document.errors).toEqual([])
  expect(isSeq(document.contents)).toBe(true)
  const rows = document.contents
  if (!isSeq(rows)) throw new Error('expected profile patch sequence')
  const row = rows.items.find(item => isMap(item) && (item.get('id') as unknown) === id)
  expect(isMap(row)).toBe(true)
  if (!isMap(row)) throw new Error(`missing ${id}`)
  const config = row.get('config', true) as Node | undefined
  expect(isMap(config)).toBe(true)
  if (!isMap(config)) throw new Error(`missing ${id} config`)
  return config
}

function mountManagedRows(profilePatch: string): string {
  const document = parseDocument(profilePatch)
  if (!isSeq(document.contents)) throw new Error('expected profile patch sequence')
  for (const [id, name] of [
    ['dsh-enhanced-personal-assistant', '@dsh-enhanced/personal-assistant'],
    ['dsh-enhanced-assistant-delivery', '@dsh-enhanced/assistant-delivery'],
  ] as const) {
    const row = document.contents.items.find(item => isMap(item)
      && (item.get('id') as unknown) === id)
    if (!isMap(row)) throw new Error(`missing ${id}`)
    const mountedRow = row as YAMLMap
    mountedRow.set('name', name)
  }
  return document.toString({ lineWidth: 0 })
}

describe('fresh profile setup', () => {
  const identityOnlyPatch = `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy:
      rules:
        - id: user-deny-shell
          effect: deny
          subject: { kind: agent, id: '*' }
          actions: [execute]
          resource: { kind: tool, id: bash }
- id: dsh-enhanced-assistant-delivery
  config:
    databasePath: !!js dshHomePath('assistant-delivery/state.sqlite')
    spoolPath: !!js dshHomePath('assistant-delivery/spool')
    defaultWorkspace: !!js dshHomePath('assistant-workspace')
    defaultAgentPreset: standard
`

  test('does not early-return when identity fields exist but required sibling configs are missing', () => {
    expect(managedProfileOverrideNeedsMaterialization(identityOnlyPatch)).toBe(true)
    const materialized = materializeManagedProfileOverride({
      profilePatch: identityOnlyPatch,
      effectiveProfile: effectiveFreshProfile(),
    })
    const personal = rowConfig(materialized, 'dsh-enhanced-personal-assistant')
    expect(isMap(personal.get('personalMemory', true) as Node | undefined)).toBe(true)
    expect(isMap(personal.get('personalWiki', true) as Node | undefined)).toBe(true)
    expect(isMap(personal.get('assistantAutomations', true) as Node | undefined)).toBe(true)
    const policy = personal.get('assistantPolicy', true) as Node | undefined
    expect(isMap(policy)).toBe(true)
    const rules = isMap(policy) ? policy.get('rules', true) as Node | undefined : undefined
    expect(isSeq(rules) && rules.items.some(item => isMap(item)
      && (item.get('id') as unknown) === 'user-deny-shell')).toBe(true)
  })

  test('fails closed when the composed row cannot supply missing sibling configs', () => {
    const incompleteEffective = identityOnlyPatch
      .replace(
        '- id: dsh-enhanced-personal-assistant',
        "- id: dsh-enhanced-personal-assistant\n  name: '@dsh-enhanced/personal-assistant'",
      )
      .replace(
        '- id: dsh-enhanced-assistant-delivery',
        "- id: dsh-enhanced-assistant-delivery\n  name: '@dsh-enhanced/assistant-delivery'",
      )
    expect(() => materializeManagedProfileOverride({
      profilePatch: identityOnlyPatch,
      effectiveProfile: incompleteEffective,
    })).toThrow(/assistantPolicy|personalMemory/iu)
  })

  test.each([
    { flag: '--allow-agent-tools', enabled: true },
    { flag: '--disable-agent-tools', enabled: false },
  ])('materializes managed overrides before $flag policy refresh', async ({ flag, enabled }) => {
    const dshHome = await mkdtemp(join(tmpdir(), 'lark-fresh-profile-'))
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await mkdir(profileDirectory, { recursive: true })
    await writeFile(patchPath, '# Fresh DSH profile override\n[]\n', 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      let effectiveReads = 0
      const run = runLarkSetup as unknown as (
        argv: readonly string[],
        runtime: {
          readEffectiveProfile(profile: string): string
          validateProfile(profile: string): void
        },
      ) => Promise<void>
      await run(
        ['--profile', 'web', '--refresh-agent-policy', flag],
        {
          readEffectiveProfile(profile) {
            expect(profile).toBe('web')
            effectiveReads += 1
            return effectiveReads === 1
              ? effectiveFreshProfile()
              : mountManagedRows(readFileSync(patchPath, 'utf8'))
          },
          validateProfile(profile) { expect(profile).toBe('web') },
        },
      )
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }

    const output = await readFile(patchPath, 'utf8')
    const personal = rowConfig(output, 'dsh-enhanced-personal-assistant')
    const policy = personal.get('assistantPolicy', true) as Node | undefined
    expect(isMap(policy)).toBe(true)
    if (!isMap(policy)) throw new Error('missing assistantPolicy config')
    const rules = policy.get('rules', true) as Node | undefined
    expect(isSeq(rules)).toBe(true)
    if (!isSeq(rules)) throw new Error('missing assistantPolicy rules')
    expect(rules.items.some(item => isMap(item)
      && (item.get('id') as unknown) === 'dsh-enhanced-foreground-capability-*')).toBe(enabled)
    expect(rules.items.some(item => isMap(item)
      && (item.get('id') as unknown) === 'deployment-deny-background-shell')).toBe(true)
    expect(policy.get('databasePath')).toBe("dshHomePath('assistant-policy/policy.sqlite')")
    expect(isSeq(policy.get('budgets', true) as Node | undefined)).toBe(true)
    expect(isMap(personal.get('personalMemory', true) as Node | undefined)).toBe(true)
    expect(isMap(personal.get('personalWiki', true) as Node | undefined)).toBe(true)
    expect(isMap(personal.get('assistantAutomations', true) as Node | undefined)).toBe(true)

    const delivery = rowConfig(output, 'dsh-enhanced-assistant-delivery')
    expect(delivery.get('databasePath')).toBe("dshHomePath('assistant-delivery/state.sqlite')")
    expect(delivery.get('spoolPath')).toBe("dshHomePath('assistant-delivery/spool')")
    expect(delivery.get('schedulerEnabled')).toBe(true)
    expect(delivery.get('defaultAgentPreset')).toBe('standard')
    expect(delivery.get('defaultWorkspace')).toBe("dshHomePath('assistant-workspace')")
    expect(output).not.toContain('inject:')
    expect(output).not.toContain('dsh-enhanced-lark-channel')
  })

  test.each([
    {
      label: 'disabled personal-assistant row',
      expected: /personal-assistant.*must not be disabled/iu,
      mutate: (patch: string) => patch.replace(
        '- id: dsh-enhanced-personal-assistant',
        '- id: dsh-enhanced-personal-assistant\n  disabled: true',
      ),
    },
    {
      label: 'conflicting personal-assistant package',
      expected: /personal-assistant.*conflicting package name/iu,
      mutate: (patch: string) => patch.replace(
        '- id: dsh-enhanced-personal-assistant',
        "- id: dsh-enhanced-personal-assistant\n  name: '@attacker/not-personal-assistant'",
      ),
    },
    {
      label: 'dynamic personal-assistant disabled expression',
      expected: /personal-assistant.*must not be disabled/iu,
      mutate: (patch: string) => patch.replace(
        '- id: dsh-enhanced-personal-assistant',
        "- id: dsh-enhanced-personal-assistant\n  disabled: !!js process.env.DISABLE_PERSONAL === '1'",
      ),
    },
    {
      label: 'disabled assistant-delivery row',
      expected: /assistant-delivery.*must not be disabled/iu,
      mutate: (patch: string) => patch.replace(
        '- id: dsh-enhanced-assistant-delivery',
        '- id: dsh-enhanced-assistant-delivery\n  disabled: true',
      ),
    },
    {
      label: 'conflicting assistant-delivery package',
      expected: /assistant-delivery.*conflicting package name/iu,
      mutate: (patch: string) => patch.replace(
        '- id: dsh-enhanced-assistant-delivery',
        "- id: dsh-enhanced-assistant-delivery\n  name: '@attacker/not-assistant-delivery'",
      ),
    },
    {
      label: 'duplicate reserved personal-assistant row',
      expected: /duplicate reserved row.*personal-assistant/iu,
      mutate: (patch: string) => `${patch}
- id: dsh-enhanced-personal-assistant
  name: '@attacker/not-personal-assistant'
  config:
    assistantPolicy: { rules: [] }
`,
    },
  ])('rejects a $label before refreshing a complete raw override', async ({ mutate, expected }) => {
    const dshHome = await mkdtemp(join(tmpdir(), 'lark-reserved-profile-row-'))
    const profileDirectory = join(dshHome, 'profiles', 'web')
    const patchPath = join(profileDirectory, 'cordis.patch.yml')
    await mkdir(profileDirectory, { recursive: true })
    const completePatch = `
- id: dsh-enhanced-personal-assistant
  config:
    assistantPolicy: { rules: [] }
- id: dsh-enhanced-assistant-delivery
  config:
    defaultWorkspace: ${join(dshHome, 'assistant-workspace')}
    defaultAgentPreset: standard
`
    const profilePatch = mutate(completePatch)
    await writeFile(patchPath, profilePatch, 'utf8')
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = dshHome
    try {
      await expect(runLarkSetup(
        ['--profile', 'web', '--refresh-agent-policy', '--allow-agent-tools'],
        {
          readEffectiveProfile() { return effectiveFreshProfile() },
          validateProfile() {},
        },
      )).rejects.toThrow(expected)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
    expect(await readFile(patchPath, 'utf8')).toBe(profilePatch)
  })
})
