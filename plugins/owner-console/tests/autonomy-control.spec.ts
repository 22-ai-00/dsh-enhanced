import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import {
  PROTECTED_ROW_IDS,
  SELF_ITERATION_TOGGLE_ROWS,
} from '../src/autonomy-control.js'
import {
  OWNER_UPDATE_SLASH_USAGE,
  apply,
  handleOwnerConsoleControlAction,
  parseOwnerSelfIterationCommand,
  parseOwnerUpdateSlashUsageError,
} from '../src/index.js'
import { OwnerConsoleService } from '../src/service.js'
import type { SetupDoctorReport } from '../src/typert.js'

const tempRoots: string[] = []
afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function makeTempHome(): { root: string; dshHome: string; profileDir: string; patchPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'owner-console-ctrl-'))
  tempRoots.push(root)
  const dshHome = join(root, 'dsh-home')
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  return {
    root,
    dshHome,
    profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
  }
}

function healthyDoctor(dshHome: string, profileName = 'web'): SetupDoctorReport {
  return {
    protocol: 'owner-console/setup-doctor/v1',
    checkedAt: 1_760_000_000_000,
    profileName,
    dshHome,
    frozenSystemdProfile: false,
    writable: true,
    healthy: true,
    autoFixableCount: 0,
    restartRequiredHint: false,
    issues: [],
  }
}

describe('parseOwnerSelfIterationCommand', () => {
  it('parses concise Chinese and /autonomy owner commands and rejects ordinary chat', () => {
    expect(parseOwnerSelfIterationCommand('开启自迭代')?.action).toBe('enableSelfIteration')
    expect(parseOwnerSelfIterationCommand('打开自迭代！')?.action).toBe('enableSelfIteration')
    expect(parseOwnerSelfIterationCommand('启用自迭代')?.action).toBe('enableSelfIteration')
    expect(parseOwnerSelfIterationCommand('enable autonomy')?.action).toBe('enableSelfIteration')
    expect(parseOwnerSelfIterationCommand('/autonomy enable')?.action).toBe('enableSelfIteration')

    expect(parseOwnerSelfIterationCommand('关闭自迭代')?.action).toBe('disableSelfIteration')
    expect(parseOwnerSelfIterationCommand('停用自迭代。')?.action).toBe('disableSelfIteration')
    expect(parseOwnerSelfIterationCommand('暂停自迭代')?.action).toBe('disableSelfIteration')
    expect(parseOwnerSelfIterationCommand('disable autonomy')?.action).toBe('disableSelfIteration')
    expect(parseOwnerSelfIterationCommand('/AUTONOMY   disable')?.action).toBe('disableSelfIteration')

    expect(parseOwnerSelfIterationCommand('升级整体助手')?.action).toBe('upgradeAssistantAndRecover')
    expect(parseOwnerSelfIterationCommand('升级助手')?.action).toBe('upgradeAssistantAndRecover')
    expect(parseOwnerSelfIterationCommand('upgrade assistant')?.action).toBe('upgradeAssistantAndRecover')
    expect(parseOwnerSelfIterationCommand('/autonomy upgrade')?.action).toBe('upgradeAssistantAndRecover')
    expect(parseOwnerSelfIterationCommand('/update')?.action).toBe('upgradeAssistantAndRecover')
    expect(parseOwnerSelfIterationCommand('  /UPGRADE  ')?.action).toBe('upgradeAssistantAndRecover')

    expect(parseOwnerSelfIterationCommand('/update foo')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('/upgrade --yes')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('/update!')).toBeUndefined()
    expect(parseOwnerUpdateSlashUsageError('/update foo')).toBe(OWNER_UPDATE_SLASH_USAGE)
    expect(parseOwnerUpdateSlashUsageError('/upgrade bar')).toBe(OWNER_UPDATE_SLASH_USAGE)
    expect(parseOwnerUpdateSlashUsageError('/update')).toBeUndefined()
    expect(parseOwnerUpdateSlashUsageError('/upgrade  ')).toBeUndefined()

    expect(parseOwnerSelfIterationCommand('')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('   ')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('关闭自迭代？')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('开启自迭代?')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('enable autonomy?')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('请不要 disable autonomy')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('今天北京天气怎么样？')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('开启自迭代是什么意思？')).toBeUndefined()
    expect(parseOwnerSelfIterationCommand('请帮我写一段代码')).toBeUndefined()
  })
})

describe('handleOwnerConsoleControlAction', () => {
  it('fails closed without disk writes on unauthorized callers, unknown actions, or unsafe paths', async () => {
    const { root, dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const initial = '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  config:\n    enabled: true\n'
    writeFileSync(patchPath, initial, 'utf8')

    const ctx = new Context()
    const unauthorized = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: false,
      action: 'disableSelfIteration',
    })
    expect(unauthorized.ok).toBe(false)
    expect(unauthorized.error ?? unauthorized.reason).toBeTruthy()
    expect(readFileSync(patchPath, 'utf8')).toBe(initial)

    const unknownAction = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'deleteEverything',
    })
    expect(unknownAction.ok).toBe(false)
    expect(unknownAction.error ?? unknownAction.reason).toBeTruthy()
    expect(readFileSync(patchPath, 'utf8')).toBe(initial)

    const relativeHome = await handleOwnerConsoleControlAction(ctx, {
      dshHome: 'relative/dsh-home',
      ownerAuthorized: true,
      action: 'enableSelfIteration',
    })
    expect(relativeHome.ok).toBe(false)

    const symlinkHome = join(root, 'home-link')
    symlinkSync(dshHome, symlinkHome)
    const symlinkRes = await handleOwnerConsoleControlAction(ctx, {
      dshHome: symlinkHome,
      ownerAuthorized: true,
      action: 'enableSelfIteration',
    })
    expect(symlinkRes.ok).toBe(false)
    expect(readFileSync(patchPath, 'utf8')).toBe(initial)

    // Symlink DSH_HOME via env (with request.dshHome omitted) must also fail closed without disk writes
    const disabledPatch = '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  disabled: true\n  config:\n    enabled: false\n'
    writeFileSync(patchPath, disabledPatch, 'utf8')
    const envSymlinkRes = await handleOwnerConsoleControlAction(null, {
      ownerAuthorized: true,
      action: 'enableSelfIteration',
      env: { DSH_HOME: symlinkHome },
    })
    expect(envSymlinkRes.ok).toBe(false)
    expect(envSymlinkRes.error ?? envSymlinkRes.reason).toMatch(/symlink/iu)
    expect(readFileSync(patchPath, 'utf8')).toBe(disabledPatch)

    // Symlink profileContext.home (with request.dshHome omitted) must also fail closed without disk writes
    const ctxSymlink = new Context()
    ctxSymlink.provide('profileContext' as never, { home: symlinkHome, name: 'web' } as never)
    const profileSymlinkRes = await handleOwnerConsoleControlAction(ctxSymlink, {
      ownerAuthorized: true,
      action: 'enableSelfIteration',
    })
    expect(profileSymlinkRes.ok).toBe(false)
    expect(profileSymlinkRes.error ?? profileSymlinkRes.reason).toMatch(/symlink/iu)
    expect(readFileSync(patchPath, 'utf8')).toBe(disabledPatch)
  })

  it('fails closed without disk writes on symlinked dshHome with trailing / or /. across request, env, and profileContext', async () => {
    const { root, dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const symlinkHome = join(root, 'home-link-trailing')
    symlinkSync(dshHome, symlinkHome)

    const enabledPatch = '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  config:\n    enabled: true\n'
    const disabledPatch = '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  disabled: true\n  config:\n    enabled: false\n'

    const actions = [
      { action: 'enableSelfIteration', seed: disabledPatch },
      { action: 'disableSelfIteration', seed: enabledPatch },
      { action: 'upgradeAssistantAndRecover', seed: enabledPatch },
    ] as const

    for (const suffix of ['/', '/.'] as const) {
      const candidateHome = `${symlinkHome}${suffix}`
      for (const { action, seed } of actions) {
        writeFileSync(patchPath, seed, 'utf8')
        let depCalled = false
        const guardDeps = {
          runUpgrade: async () => {
            depCalled = true
            return { ok: true }
          },
          runDoctor: async () => {
            depCalled = true
            return healthyDoctor(dshHome)
          },
          restartService: async () => {
            depCalled = true
            return { applied: true, entry: 'profile-restart', note: 'restarted' }
          },
        }

        const reqRes = await handleOwnerConsoleControlAction(new Context(), {
          dshHome: candidateHome,
          ownerAuthorized: true,
          action,
          deps: guardDeps,
        })
        expect(reqRes.ok, `request.dshHome ${suffix} ${action}`).toBe(false)
        expect(reqRes.error ?? reqRes.reason).toMatch(/symlink/iu)
        expect(readFileSync(patchPath, 'utf8')).toBe(seed)
        expect(depCalled).toBe(false)

        const envRes = await handleOwnerConsoleControlAction(null, {
          ownerAuthorized: true,
          action,
          env: { DSH_HOME: candidateHome },
          deps: guardDeps,
        })
        expect(envRes.ok, `env.DSH_HOME ${suffix} ${action}`).toBe(false)
        expect(envRes.error ?? envRes.reason).toMatch(/symlink/iu)
        expect(readFileSync(patchPath, 'utf8')).toBe(seed)
        expect(depCalled).toBe(false)

        const ctxSymlink = new Context()
        ctxSymlink.provide('profileContext' as never, { home: candidateHome, name: 'web' } as never)
        const profileRes = await handleOwnerConsoleControlAction(ctxSymlink, {
          ownerAuthorized: true,
          action,
          deps: guardDeps,
        })
        expect(profileRes.ok, `profileContext.home ${suffix} ${action}`).toBe(false)
        expect(profileRes.error ?? profileRes.reason).toMatch(/symlink/iu)
        expect(readFileSync(patchPath, 'utf8')).toBe(seed)
        expect(depCalled).toBe(false)
      }
    }
  })

  it('enables self-iteration on a fresh empty dshHome without existing cordis.patch.yml', async () => {
    const { dshHome, patchPath } = makeTempHome()
    const ctx = new Context()
    const res = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'enableSelfIteration',
    })
    expect(res.ok).toBe(true)
    expect(res.state).toBe('enabled')
    const rows = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{
      id: string
      disabled?: boolean
      config?: { enabled?: boolean }
    }>
    const workItems = rows.find(r => r.id === 'dsh-ray-assistant-work-items')
    expect(workItems).toBeDefined()
    expect(workItems?.disabled).not.toBe(true)
    expect(workItems?.config?.enabled).toBe(true)
  })

  it('toggles all 9 self-iteration rows while keeping all 7 protected rows enabled and preserving ownerRoutes', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const initialRows = [
      ...SELF_ITERATION_TOGGLE_ROWS.map(spec => ({
        id: spec.rowId,
        name: spec.pkgName,
        config: spec.rowId === 'dsh-ray-assistant-dreaming'
          ? {
              enabled: true,
              scope: {
                workspace: '/tmp/ws',
                preset: 'standard',
                principalId: 'web/local/default/owner',
                ownerRouteId: 'owner-web-primary',
              },
              databasePath: '/tmp/dreaming.sqlite',
              provider: 'openai',
              model: 'gpt-5',
              budgetId: 'web-dreaming',
              budgetAmount: 5,
            }
          : { enabled: true },
      })),
      ...[...PROTECTED_ROW_IDS].map(rowId => ({
        id: rowId,
        name: `@dsh-ray/${rowId.replace(/^dsh-ray-/u, '')}`,
        config: rowId === 'dsh-ray-assistant-delivery'
          ? { enabled: true, ownerRoutes: [{ id: 'owner-web-primary', policyRef: 'owner-dm' }] }
          : { enabled: true },
      })),
    ]
    writeFileSync(patchPath, `${JSON.stringify(initialRows, null, 2)}\n`, 'utf8')

    const ctx = new Context()
    const disabled = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'disableSelfIteration',
      now: 1000,
    })
    expect(disabled.ok).toBe(true)
    expect(disabled.state).toBe('disabled')

    const afterDisable = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{
      id: string
      disabled?: boolean
      config?: Record<string, unknown>
    }>
    for (const spec of SELF_ITERATION_TOGGLE_ROWS) {
      const row = afterDisable.find(r => r.id === spec.rowId)
      expect(row?.disabled).toBe(true)
      expect(row?.config?.enabled).toBe(false)
    }
    for (const rowId of PROTECTED_ROW_IDS) {
      const row = afterDisable.find(r => r.id === rowId)
      expect(row?.disabled).not.toBe(true)
      expect(row?.config?.enabled).toBe(true)
    }
    const deliveryAfterDisable = afterDisable.find(r => r.id === 'dsh-ray-assistant-delivery')
    expect(deliveryAfterDisable?.config?.ownerRoutes).toEqual([{ id: 'owner-web-primary', policyRef: 'owner-dm' }])

    const enabled = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'enableSelfIteration',
      now: 2000,
    })
    expect(enabled.ok).toBe(true)
    expect(enabled.state).toBe('enabled')

    const afterEnable = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{
      id: string
      disabled?: boolean
      config?: Record<string, unknown>
    }>
    for (const spec of SELF_ITERATION_TOGGLE_ROWS) {
      const row = afterEnable.find(r => r.id === spec.rowId)
      expect(row?.disabled).not.toBe(true)
      expect(row?.config?.enabled).toBe(true)
    }
  })

  it('keeps assistant-dreaming enabled: false on enableSelfIteration when 6 prerequisite fields are incomplete, while clearing retired', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-dreaming',
      '  name: "@dsh-ray/assistant-dreaming"',
      '  disabled: true',
      '  config:',
      '    enabled: false',
      '    retired: true',
      '    databasePath: /tmp/dreaming.sqlite',
      '- id: dsh-ray-assistant-work-items',
      '  name: "@dsh-ray/assistant-work-items"',
      '  disabled: true',
      '  config:',
      '    enabled: false',
    ].join('\n') + '\n', 'utf8')

    const res = await handleOwnerConsoleControlAction(new Context(), {
      dshHome,
      ownerAuthorized: true,
      action: 'enableSelfIteration',
      now: 3000,
    })
    expect(res.ok).toBe(true)
    expect(res.state).toBe('enabled')
    const rows = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{
      id: string
      disabled?: boolean
      config?: Record<string, unknown>
    }>
    const dreaming = rows.find(r => r.id === 'dsh-ray-assistant-dreaming')!
    expect(dreaming.disabled).toBeUndefined()
    expect(dreaming.config?.enabled).toBe(false)
    expect(dreaming.config).not.toHaveProperty('retired')
    expect(rows.find(r => r.id === 'dsh-ray-assistant-work-items')?.config?.enabled).toBe(true)
  })

  it('rejects string scope, relative/non-canonical paths, and out-of-range budgetAmount for dreaming while cleaning up retired: false and allowing !!js paths', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })

    const invalidDreamConfigs = [
      {
        label: 'string scope + retired: false',
        yaml: [
          '- id: dsh-ray-assistant-dreaming',
          '  name: "@dsh-ray/assistant-dreaming"',
          '  disabled: true',
          '  config:',
          '    enabled: false',
          '    retired: false',
          '    scope: owner-scope',
          '    databasePath: /tmp/dreaming.sqlite',
          '    provider: openai',
          '    model: gpt-5',
          '    budgetId: dreaming-daily',
          '    budgetAmount: 5000',
        ].join('\n') + '\n',
      },
      {
        label: 'relative paths',
        yaml: [
          '- id: dsh-ray-assistant-dreaming',
          '  name: "@dsh-ray/assistant-dreaming"',
          '  disabled: true',
          '  config:',
          '    enabled: false',
          '    retired: false',
          '    scope:',
          '      workspace: relative/ws',
          '      preset: standard',
          '      principalId: web/local/default/owner',
          '      ownerRouteId: owner-web-primary',
          '    databasePath: relative/dreaming.sqlite',
          '    provider: openai',
          '    model: gpt-5',
          '    budgetId: dreaming-daily',
          '    budgetAmount: 5000',
        ].join('\n') + '\n',
      },
      {
        label: 'non-canonical path and budgetAmount > 10_000_000',
        yaml: [
          '- id: dsh-ray-assistant-dreaming',
          '  name: "@dsh-ray/assistant-dreaming"',
          '  disabled: true',
          '  config:',
          '    enabled: false',
          '    scope:',
          '      workspace: /tmp/ws/',
          '      preset: standard',
          '      principalId: web/local/default/owner',
          '      ownerRouteId: owner-web-primary',
          '    databasePath: /tmp/dreaming.sqlite',
          '    provider: openai',
          '    model: gpt-5',
          '    budgetId: dreaming-daily',
          '    budgetAmount: 10000001',
        ].join('\n') + '\n',
      },
    ]

    for (const item of invalidDreamConfigs) {
      writeFileSync(patchPath, item.yaml, 'utf8')
      const res = await handleOwnerConsoleControlAction(new Context(), {
        dshHome,
        ownerAuthorized: true,
        action: 'enableSelfIteration',
        now: 3100,
      })
      expect(res.ok, item.label).toBe(true)
      const rows = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{
        id: string
        disabled?: boolean
        config?: Record<string, unknown>
      }>
      const dreaming = rows.find(r => r.id === 'dsh-ray-assistant-dreaming')!
      expect(dreaming.disabled, item.label).toBeUndefined()
      expect(dreaming.config?.enabled, item.label).toBe(false)
      expect(dreaming.config, item.label).not.toHaveProperty('retired')
    }

    // Valid !!js dshHomePath(...) + YAMLMap scope + retired: false enables cleanly
    writeFileSync(patchPath, [
      '- id: dsh-ray-assistant-dreaming',
      '  name: "@dsh-ray/assistant-dreaming"',
      '  disabled: true',
      '  config:',
      '    enabled: false',
      '    retired: false',
      '    scope:',
      "      workspace: !!js dshHomePath('workspace')",
      '      preset: standard',
      '      principalId: web/local/default/owner',
      '      ownerRouteId: owner-web-primary',
      "    databasePath: !!js dshHomePath('assistant-dreaming/web.sqlite')",
      '    provider: openai',
      '    model: gpt-5',
      '    budgetId: dreaming-daily',
      '    budgetAmount: 10000000',
    ].join('\n') + '\n', 'utf8')
    const validRes = await handleOwnerConsoleControlAction(new Context(), {
      dshHome,
      ownerAuthorized: true,
      action: 'enableSelfIteration',
      now: 3200,
    })
    expect(validRes.ok).toBe(true)
    const validRows = parseDocument(readFileSync(patchPath, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }],
    }).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
    expect(validRows[0]?.config?.enabled).toBe(true)
    expect(validRows[0]?.config).not.toHaveProperty('retired')
  })

  it('upgrades & recovers minimal unbound fixture via doctor repair, delegates frozen-linux-systemd via out-of-cgroup updater, and fails closed on corrupt host metadata', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    writeFileSync(
      patchPath,
      '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  config:\n    enabled: true\n',
      'utf8',
    )

    const ctx = new Context()
    const minimalOk = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'upgradeAssistantAndRecover',
      env: {},
    })
    expect(minimalOk.ok).toBe(true)
    expect(minimalOk.state).toBe('upgraded')
    expect(minimalOk.healthy).toBe(true)
    // Doctor repair scoped the missing databasePath inside $DSH_HOME
    const repaired = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{ id: string; config?: { databasePath?: string } }>
    expect(repaired.find(r => r.id === 'dsh-ray-assistant-work-items')?.config?.databasePath)
      .toContain(join('assistant-work-items', 'web.sqlite'))

    // Corrupt .dsh-ray-host.json must fail closed
    writeFileSync(join(dshHome, '.dsh-ray-host.json'), '{not-json', { mode: 0o600 })
    const corruptHost = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'upgradeAssistantAndRecover',
      env: {},
    })
    expect(corruptHost.ok).toBe(false)
    expect(corruptHost.error ?? corruptHost.reason).toBeTruthy()
    rmSync(join(dshHome, '.dsh-ray-host.json'))

    // Frozen Linux systemd profile routes cleanly through shared out-of-cgroup launcher when authorized
    mkdirSync(join(dshHome, 'rsi-local-cohorts', 'web'), { recursive: true })
    writeFileSync(join(dshHome, 'rsi-local-cohorts', 'web', 'receipt.json'), '{}', 'utf8')
    const frozenCalls: Array<Record<string, unknown>> = []
    const frozenUnauth = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: false,
      action: 'upgradeAssistantAndRecover',
      platform: 'linux',
      env: {},
      deps: {
        launchAutoUpdate: async opts => {
          frozenCalls.push(opts as unknown as Record<string, unknown>)
          return { ok: true, state: 'upgraded', started: true, message: 'unexpected' }
        },
      },
    })
    expect(frozenUnauth.ok).toBe(false)
    expect(frozenCalls).toHaveLength(0)

    const frozen = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'upgradeAssistantAndRecover',
      platform: 'linux',
      env: {},
      deps: {
        launchAutoUpdate: async opts => {
          frozenCalls.push(opts as unknown as Record<string, unknown>)
          return {
            ok: true,
            state: 'upgraded',
            started: true,
            background: true,
            launcher: 'systemd-run',
            toNpm: true,
            message: '🔄 已启动后台自动升级与服务恢复（v0.2.0 -> v0.2.2），完成后服务将自动重启恢复并通知结果，全程无需人工干预。',
          }
        },
      },
    })
    expect(frozen.ok).toBe(true)
    expect(frozen.state).toBe('upgraded')
    expect(frozen.note).toContain('🔄 已启动后台自动升级与服务恢复')
    expect(frozenCalls).toHaveLength(1)
    expect(frozenCalls[0]).toMatchObject({ dshHome, profile: 'web', platform: 'linux' })

    const frozenFail = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'upgradeAssistantAndRecover',
      platform: 'linux',
      env: {},
      deps: {
        launchAutoUpdate: async () => ({
          ok: false,
          state: 'upgraded',
          started: false,
          message: 'systemd-run unavailable',
          error: 'systemd-run unavailable',
        }),
      },
    })
    expect(frozenFail.ok).toBe(false)
    expect(frozenFail.error).toContain('systemd-run unavailable')
  })

  it('orchestrates bound upgrade -> doctor -> restart and fails closed if doctor remains unhealthy', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    writeFileSync(patchPath, '[]\n', 'utf8')

    const steps: string[] = []
    const ctx = new Context()
    const okRes = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'upgradeAssistantAndRecover',
      confirmDshHomeStopped: true,
      env: {},
      deps: {
        runUpgrade: async () => {
          steps.push('upgrade')
          return { ok: true, note: 'upgraded' }
        },
        runDoctor: async () => {
          steps.push('doctor')
          return healthyDoctor(dshHome)
        },
        restartService: async () => {
          steps.push('restart')
          return { applied: true, entry: 'profile-restart', note: 'restarted' }
        },
      },
    })
    expect(okRes.ok).toBe(true)
    expect(steps).toEqual(['upgrade', 'doctor', 'restart'])

    const unhealthyRes = await handleOwnerConsoleControlAction(ctx, {
      dshHome,
      ownerAuthorized: true,
      action: 'upgradeAssistantAndRecover',
      env: {},
      deps: {
        runUpgrade: async () => ({ ok: true }),
        runDoctor: async () => ({
          ...healthyDoctor(dshHome),
          healthy: false,
          issues: [{
            id: 'core-bundle-failed:@dsh-ray/assistant-policy',
            severity: 'error',
            category: 'plugins',
            title: '核心策略加载失败',
            detail: 'broken',
            autoFixable: false,
            fixLabel: 'manual',
          }],
        }),
        restartService: async () => {
          throw new Error('restart should not be called when doctor is unhealthy')
        },
      },
    })
    expect(unhealthyRes.ok).toBe(false)
    expect(unhealthyRes.healthy).toBe(false)
  })
})

describe('OwnerConsoleService RPC and Host tool wiring', () => {
  it('gates controlSelfIteration confirmation and owner_console_self_iteration_control tool authorization', async () => {
    const { dshHome, profileDir, patchPath } = makeTempHome()
    mkdirSync(profileDir, { recursive: true, mode: 0o700 })
    const initialPatch = '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  config:\n    enabled: true\n'
    writeFileSync(patchPath, initialPatch, 'utf8')

    const registeredTools: Array<{
      def: { name: string; execute: (args: unknown, exec: unknown) => Promise<Record<string, unknown>> }
      opts?: { when?: (ctx: { agent?: unknown }) => boolean | Promise<boolean> } | undefined
    }> = []
    const preauthPredicates: Array<(exec: { agent?: unknown }) => boolean> = []

    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    ctx.provide('profileContext' as never, { home: dshHome, dir: profileDir, name: 'web' } as never)
    ctx.provide('tools' as never, {
      register: (def: typeof registeredTools[number]['def'], opts?: typeof registeredTools[number]['opts']) => {
        registeredTools.push({ def, opts })
        return () => {}
      },
    } as never)
    ctx.provide('assistantPolicy' as never, {
      registerPreauthorizedTool: (_c: unknown, _d: unknown, pred: (exec: { agent?: unknown }) => boolean) => {
        preauthPredicates.push(pred)
        return () => {}
      },
    } as never)

    apply(ctx, { feishuAppId: '' })
    const svc = ctx.get('ownerConsole' as never) as unknown as OwnerConsoleService

    try {
      const unconfirmed = await svc.controlSelfIteration('disableSelfIteration', false)
      expect(unconfirmed.ok).toBe(false)
      expect(readFileSync(patchPath, 'utf8')).toBe(initialPatch)

      const confirmed = await svc.controlSelfIteration('disableSelfIteration', true)
      expect(confirmed.ok).toBe(true)
      expect(confirmed.state).toBe('disabled')

      const tool = registeredTools.find(item => item.def.name === 'owner_console_self_iteration_control')
      expect(tool).toBeDefined()

      // Non-owner session is denied by both `when` and `execute` (fail-closed)
      const foreignAgent = { id: 'foreign-session', session: { id: 'foreign-session' } }
      expect(tool!.opts?.when?.({ agent: foreignAgent })).toBe(false)
      expect(preauthPredicates[0]?.({ agent: foreignAgent })).toBe(false)
      const deniedExec = await tool!.def.execute(
        { action: 'enableSelfIteration' },
        { agent: foreignAgent },
      )
      expect(deniedExec.ok).toBe(false)

      // Registered Wenyao session is authorized
      await svc.registerAssistantSession('wenyao-owner-session', true)
      const ownerAgent = { id: 'wenyao-owner-session', session: { id: 'wenyao-owner-session' } }
      expect(tool!.opts?.when?.({ agent: ownerAgent })).toBe(true)
      expect(preauthPredicates[0]?.({ agent: ownerAgent })).toBe(true)
      const okExec = await tool!.def.execute(
        { action: 'enableSelfIteration' },
        { agent: ownerAgent },
      )
      expect(okExec.ok).toBe(true)
      expect(okExec.state).toBe('enabled')
      const finalRows = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{ id: string; disabled?: boolean }>
      expect(finalRows.find(r => r.id === 'dsh-ray-assistant-work-items')?.disabled).not.toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
