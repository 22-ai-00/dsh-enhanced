import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { parseDocument } from 'yaml'
import {
  collectVersionReport,
  formatVersionReport,
  main,
  parseArgs,
  upgradeAssistantAndRecover,
  version,
  type AssistantVersionPluginEntry,
  type AssistantVersionReport,
  type CollectVersionReportOptions,
} from '../src/index.ts'

describe('capability probe', () => {
  test('仅精确 --capabilities 返回只读 JSON，不调用服务依赖', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const forbidden = () => { throw new Error('must not be called') }
      expect(await main(['--capabilities'], { DSH_HOME: '/does/not/exist' }, {
        purge: forbidden as never, install: forbidden as never, selfUpdate: forbidden as never,
      })).toBe(0)
      expect(output).toHaveBeenCalledExactlyOnceWith('{"capabilities":["macos-launchd-ownership-v1"]}\n')
      expect(error).not.toHaveBeenCalled()
      expect(await main(['--capabilities', '--yes'], {})).toBe(2)
      expect(output).toHaveBeenCalledTimes(1)
    } finally {
      output.mockRestore()
      error.mockRestore()
    }
  })
})

describe('version', () => {
  test('导出稳定的三段式版本字面量', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('parseArgs', () => {
  test('无参数默认 status，DSH_HOME 作为默认 home', () => {
    expect(parseArgs([], { HOME: '/h' }).command).toBe('status')
    expect(parseArgs([], { DSH_HOME: '/custom/.dsh' }).dshHome).toBe('/custom/.dsh')
  })

  test('全量 purge 选项解析', () => {
    const args = parseArgs(
      ['purge', '--yes', '--no-backup', '--keep-keychain', '--remove-host', '--profile', 'web'],
      { HOME: '/h' },
    )
    expect(args).toMatchObject({
      command: 'purge',
      yes: true,
      backup: false,
      keepKeychain: true,
      removeHost: true,
      profile: 'web',
    })
  })

  test('doctor/version/dry-run 与自定义 home 解析', () => {
    expect(parseArgs(['doctor'], { HOME: '/h' }).command).toBe('doctor')
    expect(parseArgs(['--dsh-home', '/x/.dsh', 'status'], { HOME: '/h' }).dshHome).toBe('/x/.dsh')
    expect(parseArgs(['--dry-run', 'purge'], { HOME: '/h' }).dryRun).toBe(true)
  })

  test('运维命令解析：start/stop/restart/logs', () => {
    expect(parseArgs(['start'], { HOME: '/h' }).command).toBe('start')
    expect(parseArgs(['stop', '--profile', 'web'], { HOME: '/h' })).toMatchObject({
      command: 'stop', profile: 'web',
    })
    expect(parseArgs(['restart', '--dry-run'], { HOME: '/h' })).toMatchObject({
      command: 'restart', dryRun: true,
    })
  })

  test('logs 默认 200 行，可用 --lines 与 --errors-only 覆盖', () => {
    expect(parseArgs(['logs'], { HOME: '/h' })).toMatchObject({
      command: 'logs', lines: 200, errorsOnly: false,
    })
    expect(parseArgs(['logs', '--lines', '50', '--errors-only'], { HOME: '/h' })).toMatchObject({
      command: 'logs', lines: 50, errorsOnly: true,
    })
  })

  test('--lines 非法值必须报错，而不是静默回落默认值', () => {
    expect(() => parseArgs(['logs', '--lines', 'abc'], { HOME: '/h' })).toThrow(/正整数/)
    expect(() => parseArgs(['logs', '--lines', '0'], { HOME: '/h' })).toThrow(/1\.\.10000/)
    expect(() => parseArgs(['logs', '--lines', '10001'], { HOME: '/h' })).toThrow(/1\.\.10000/)
    expect(() => parseArgs(['logs', '--lines'], { HOME: '/h' })).toThrow(/需要一个值/)
  })

  test('未知参数报错', () => {
    expect(() => parseArgs(['--bogus'], { HOME: '/h' })).toThrow(/无法识别/)
  })

  test('带值选项缺值时报错', () => {
    expect(() => parseArgs(['purge', '--profile'], { HOME: '/h' })).toThrow(/需要一个值/)
  })

  test('open / --wait / --no-browser / --json 解析与范围校验', () => {
    expect(parseArgs(['open', '--profile', 'web', '--wait', '12', '--no-browser'], { HOME: '/h' })).toMatchObject({
      command: 'open', profile: 'web', waitSeconds: 12, noBrowser: true,
    })
    expect(parseArgs(['web-url', '--wait', '5'], { HOME: '/h' })).toMatchObject({
      command: 'web-url', waitSeconds: 5,
    })
    expect(parseArgs(['doctor', '--json', '--profile', 'web'], { HOME: '/h' })).toMatchObject({
      command: 'doctor', json: true, profile: 'web',
    })
    expect(() => parseArgs(['open', '--wait', '61'], { HOME: '/h' })).toThrow(/0\.\.60/)
    expect(() => parseArgs(['start', '--json'], { HOME: '/h' })).toThrow(/仅适用于 status 与 doctor/)
    expect(() => parseArgs(['status', '--no-browser'], { HOME: '/h' })).toThrow(/仅适用于 open/)
    expect(() => parseArgs(['doctor', '--wait', '5'], { HOME: '/h' })).toThrow(/仅适用于 open 与 web-url/)
  })

  test('顶层 --version / -V 与 version --short / --json / update --version 路由解析', () => {
    expect(parseArgs(['--version'], { HOME: '/h' })).toMatchObject({ command: 'version', versionFlag: true })
    expect(parseArgs(['-V'], { HOME: '/h' })).toMatchObject({ command: 'version', versionFlag: true })
    expect(parseArgs(['version'], { HOME: '/h' })).toMatchObject({ command: 'version', short: false, json: false })
    expect(parseArgs(['version', '--short'], { HOME: '/h' })).toMatchObject({ command: 'version', short: true })
    expect(parseArgs(['version', '--json', '--dsh-home', '/x', '--profile', 'web'], { HOME: '/h' })).toMatchObject({
      command: 'version', json: true, dshHome: '/x', profile: 'web',
    })
    expect(parseArgs(['update', '--version', '0.1.83'], { HOME: '/h' })).toMatchObject({
      command: 'update', targetVersion: '0.1.83',
    })

    expect(() => parseArgs(['version', '--short', '--json'], { HOME: '/h' })).toThrow(/--short 与 --json 不能同时使用/)
    expect(() => parseArgs(['status', '--short'], { HOME: '/h' })).toThrow(/--short 仅适用于 version/)
    expect(() => parseArgs(['--version', '--json'], { HOME: '/h' })).toThrow(/不能同时使用/)
    expect(() => parseArgs(['--version', 'status'], { HOME: '/h' })).toThrow(/不能与子命令同时使用/)
    expect(() => parseArgs(['status', '--version'], { HOME: '/h' })).toThrow(/--version 仅适用于顶层调用/)
    expect(() => parseArgs(['status', '-V'], { HOME: '/h' })).toThrow(/-V 仅适用于顶层调用/)
    expect(() => parseArgs(['version', '--bogus'], { HOME: '/h' })).toThrow(/无法识别/)
  })

  test('--help 输出无重复 maintenance 行且列出 open 与 --json', async () => {
    let helpText = ''
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
      helpText += String(chunk)
      return true
    })
    try {
      expect(await main(['--help'])).toBe(0)
      const maintenanceLines = helpText.split('\n').filter(line => line.trimStart().startsWith('maintenance '))
      expect(maintenanceLines).toHaveLength(1)
      expect(helpText).toContain('open ')
      expect(helpText).toContain('--json')
      expect(helpText).toContain('--wait')
      expect(helpText).toContain('--short')
      expect(helpText).toContain('-V, --version')
    } finally {
      out.mockRestore()
    }
  })

  test('status --json 与 doctor --json 返回结构化 JSON', async () => {
    const capture = async (argv: string[]) => {
      let stdout = ''
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        stdout += String(chunk)
        return true
      })
      try {
        expect(await main(argv, { DSH_HOME: '/does/not/exist-dsh-home' })).toBe(0)
        return JSON.parse(stdout) as Record<string, unknown>
      } finally {
        out.mockRestore()
      }
    }
    const statusJson = await capture(['status', '--json'])
    expect(statusJson.homeExists).toBe(false)
    expect(statusJson.dshHome).toBe('/does/not/exist-dsh-home')

    const doctorJson = await capture(['doctor', '--json'])
    expect(doctorJson.schemaVersion).toBe(1)
    expect(Array.isArray(doctorJson.checks)).toBe(true)
    expect(doctorJson.agentTools).toBeTruthy()
  })

  test('main 执行 --version / -V / version --short / version --json / version 文本', async () => {
    const captureMain = async (argv: string[]) => {
      let stdout = ''
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        stdout += String(chunk)
        return true
      })
      try {
        const code = await main(argv, { DSH_HOME: '/does/not/exist-dsh-home' })
        return { code, stdout }
      } finally {
        out.mockRestore()
      }
    }

    for (const argv of [['--version'], ['-V'], ['version', '--short']]) {
      const res = await captureMain(argv)
      expect(res.code).toBe(0)
      expect(res.stdout).toBe(`${version}\n`)
    }

    const jsonRes = await captureMain(['version', '--json'])
    expect(jsonRes.code).toBe(0)
    const parsed = JSON.parse(jsonRes.stdout) as AssistantVersionReport
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.protocol).toBe('dsh-ray/version/v1')
    expect(parsed.assistant.version).toBe(version)
    expect(parsed.selfIteration.dataState).toBe('no-data')

    const textRes = await captureMain(['version'])
    expect(textRes.code).toBe(0)
    expect(textRes.stdout).toContain(`dsh-ray v${version}`)
    expect(textRes.stdout).toContain('no-data')

    // Ensure re-exported helpers & types are wired cleanly
    const opts: CollectVersionReportOptions = { dshHome: '/does/not/exist-dsh-home', runningVersion: null }
    const directReport = await collectVersionReport(opts)
    const entryCheck: readonly AssistantVersionPluginEntry[] = directReport.plugins.core
    expect(entryCheck).toEqual([])
    expect(formatVersionReport(directReport)).toContain(`dsh-ray v${version}`)
  })
})

describe('standalone installation smoke test', () => {
  test('仅链接 manifest.dependencies 后可在仓库外独立运行 upgrade --help 与 --capabilities', () => {
    const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = Object.keys(manifest.dependencies ?? {})
    expect(deps).toContain('yaml')
    expect(existsSync(join(pkgRoot, 'lib', 'index.js'))).toBe(true)

    const requireFromTest = createRequire(import.meta.url)
    const resolveDepRoot = (dep: string): string => {
      try {
        return dirname(requireFromTest.resolve(`${dep}/package.json`))
      } catch {
        let dir = dirname(requireFromTest.resolve(dep))
        while (true) {
          const candidate = join(dir, 'package.json')
          if (existsSync(candidate)) {
            const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string }
            if (pkg.name === dep) return dir
          }
          const parent = dirname(dir)
          if (parent === dir) throw new Error(`Unable to resolve dependency root for ${dep}`)
          dir = parent
        }
      }
    }

    const tmp = mkdtempSync(join(tmpdir(), 'dsh-ray-standalone-'))
    try {
      cpSync(join(pkgRoot, 'package.json'), join(tmp, 'package.json'))
      cpSync(join(pkgRoot, 'bin'), join(tmp, 'bin'), { recursive: true })
      cpSync(join(pkgRoot, 'lib'), join(tmp, 'lib'), { recursive: true })
      for (const dep of deps) {
        const targetLink = join(tmp, 'node_modules', dep)
        mkdirSync(dirname(targetLink), { recursive: true })
        symlinkSync(resolveDepRoot(dep), targetLink, process.platform === 'win32' ? 'junction' : 'dir')
      }

      const runBin = (args: readonly string[]) => {
        const res = spawnSync(
          process.execPath,
          [join(tmp, 'bin', 'dsh-ray.js'), ...args],
          { cwd: tmp, encoding: 'utf8' },
        )
        expect(res.error).toBeUndefined()
        expect(res.status, `exit status for ${args.join(' ')}: ${res.stderr}`).toBe(0)
        expect(res.stderr, `stderr for ${args.join(' ')}`).toBe('')
        return res.stdout
      }

      const upgradeHelpOut = runBin(['upgrade', '--help'])
      expect(upgradeHelpOut).toContain('dsh-ray — DSH Ray')
      expect(upgradeHelpOut).toContain('upgrade ')

      const capabilitiesOut = runBin(['--capabilities'])
      expect(capabilitiesOut).toBe('{"capabilities":["macos-launchd-ownership-v1"]}\n')

      const verOut = runBin(['--version'])
      expect(verOut).toBe(`${version}\n`)

      const shortOut = runBin(['version', '--short'])
      expect(shortOut).toBe(`${version}\n`)

      const verJsonOut = runBin(['version', '--json', '--dsh-home', join(tmp, 'absent-home')])
      const parsedVerJson = JSON.parse(verJsonOut) as AssistantVersionReport
      expect(parsedVerJson.protocol).toBe('dsh-ray/version/v1')
      expect(parsedVerJson.schemaVersion).toBe(1)
      expect(parsedVerJson.selfIteration.dataState).toBe('no-data')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('F21 enable / disable / upgradeAssistantAndRecover', () => {
  test('parseArgs 解析 enable / disable 与 --allow-non-empty-history-migration / --to-npm 并拒绝误用', () => {
    expect(parseArgs(['enable', '--profile', 'web', '--json'], { HOME: '/h' })).toMatchObject({
      command: 'enable', profile: 'web', json: true,
    })
    expect(parseArgs(['disable', '--profile', 'web', '--dry-run', '--json'], { HOME: '/h' })).toMatchObject({
      command: 'disable', profile: 'web', dryRun: true, json: true,
    })
    expect(parseArgs(['upgrade', '--yes', '--allow-non-empty-history-migration'], { HOME: '/h' })).toMatchObject({
      command: 'upgrade', yes: true, allowNonEmptyHistoryMigration: true,
    })
    expect(parseArgs(['upgrade', '--yes', '--to-npm'], { HOME: '/h' })).toMatchObject({
      command: 'upgrade', yes: true, toNpm: true,
    })
    expect(parseArgs(['update', '--all', '--yes', '--to-npm', '--confirm-dsh-home-stopped'], { HOME: '/h' })).toMatchObject({
      command: 'update', all: true, yes: true, toNpm: true, confirmDshHomeStopped: true,
    })
    expect(() => parseArgs(['status', '--allow-non-empty-history-migration'], { HOME: '/h' })).toThrow(/仅适用于 upgrade/)
    expect(() => parseArgs(['status', '--to-npm'], { HOME: '/h' })).toThrow(/仅适用于 upgrade 与 update/)
  })

  test('enable / disable 原地 AST 切换自迭代开关，保留 !js、注释、ownerRoutes 与受保护行，并在非法输入时 fail-closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ray-toggle-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profileDir = join(dshHome, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      const patchPath = join(profileDir, 'cordis.patch.yml')
      const initialPatch = `# preserve header comment
- id: dsh-ray-assistant-web-owner
  name: "@dsh-ray/assistant-web-owner"
  config:
    enabled: true
- id: dsh-ray-assistant-delivery
  name: "@dsh-ray/assistant-delivery"
  config:
    ownerRoutes:
      - owner-route-1
- id: dsh-ray-assistant-work-items
  name: "@dsh-ray/assistant-work-items"
  config:
    enabled: true
    databasePath: !js dshHomePath('assistant-work-items', 'web.sqlite')
- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  config:
    enabled: false
    retired: true
    databasePath: !js dshHomePath('assistant-dreaming', 'web.sqlite')
- id: dsh-ray-assistant-evolution
  name: "@dsh-ray/assistant-evolution"
  config:
    intervalMs: 60000
`
      writeFileSync(patchPath, initialPatch, { mode: 0o600 })

      const captureRun = async (argv: string[]) => {
        let stdout = ''
        let stderr = ''
        const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(c => { stdout += String(c); return true })
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(c => { stderr += String(c); return true })
        try {
          const exitCode = await main(argv, { DSH_HOME: dshHome })
          return { exitCode, stdout, stderr }
        } finally {
          outSpy.mockRestore()
          errSpy.mockRestore()
        }
      }

      // 1. --dry-run does not mutate disk
      const dryDis = await captureRun(['disable', '--profile', 'web', '--dsh-home', dshHome, '--dry-run', '--json'])
      expect(dryDis.exitCode).toBe(0)
      expect(JSON.parse(dryDis.stdout)).toMatchObject({ ok: true, state: 'disabled', dryRun: true })
      expect(readFileSync(patchPath, 'utf8')).toBe(initialPatch)

      // 2. disable mutates work-items & dreaming while preserving !js, comments, ownerRoutes & protected rows
      const dis = await captureRun(['disable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
      expect(dis.exitCode).toBe(0)
      expect(JSON.parse(dis.stdout)).toMatchObject({ ok: true, state: 'disabled', profile: 'web', dshHome })
      const afterDisable = readFileSync(patchPath, 'utf8')
      expect(afterDisable).toContain('# preserve header comment')
      expect(afterDisable).toContain('!js')
      expect(afterDisable).toContain('owner-route-1')
      expect(afterDisable).toContain('disabled: true')
      const disableRows = parseDocument(afterDisable, {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }],
      }).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
      const disableById = new Map(disableRows.map(r => [r.id, r]))
      expect(disableById.get('dsh-ray-assistant-web-owner')?.disabled).toBeUndefined()
      expect(disableById.get('dsh-ray-assistant-web-owner')?.config?.enabled).toBe(true)
      expect(disableById.get('dsh-ray-assistant-delivery')?.disabled).toBeUndefined()
      expect(disableById.get('dsh-ray-assistant-work-items')?.disabled).toBe(true)
      expect(disableById.get('dsh-ray-assistant-work-items')?.config?.enabled).toBe(false)
      expect(disableById.get('dsh-ray-assistant-evolution')?.disabled).toBe(true)
      expect(disableById.get('dsh-ray-assistant-evolution')?.config).not.toHaveProperty('enabled')

      // 3. enable restores work-items, clears retired on dreaming, and keeps incomplete dreaming disabled (enabled: false)
      const en = await captureRun(['enable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
      expect(en.exitCode).toBe(0)
      expect(JSON.parse(en.stdout)).toMatchObject({ ok: true, state: 'enabled', profile: 'web', dshHome })
      const afterEnable = readFileSync(patchPath, 'utf8')
      const enableRows = parseDocument(afterEnable, {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }],
      }).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
      const enableById = new Map(enableRows.map(r => [r.id, r]))
      expect(enableById.get('dsh-ray-assistant-work-items')?.disabled).toBeUndefined()
      expect(enableById.get('dsh-ray-assistant-work-items')?.config?.enabled).toBe(true)
      expect(enableById.get('dsh-ray-assistant-dreaming')?.disabled).toBeUndefined()
      expect(enableById.get('dsh-ray-assistant-dreaming')?.config?.enabled).toBe(false)
      expect(enableById.get('dsh-ray-assistant-dreaming')?.config).not.toHaveProperty('retired')

      // 3b. dreaming with all 6 required fields (map scope + retired: true) IS enabled & retired cleared on `dsh-ray enable`
      writeFileSync(patchPath, `- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  disabled: true
  config:
    enabled: false
    retired: true
    scope:
      workspace: ${join(root, 'ws')}
      preset: standard
      principalId: web/local/default/owner
      ownerRouteId: owner-web-primary
    databasePath: !js dshHomePath('assistant-dreaming', 'web.sqlite')
    provider: openai
    model: gpt-5
    budgetId: dreaming-daily
    budgetAmount: 5
`, { mode: 0o600 })
      const enDreaming = await captureRun(['enable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
      expect(enDreaming.exitCode).toBe(0)
      const dreamingRows = parseDocument(readFileSync(patchPath, 'utf8'), {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }],
      }).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
      expect(dreamingRows[0]?.disabled).toBeUndefined()
      expect(dreamingRows[0]?.config?.enabled).toBe(true)
      expect(dreamingRows[0]?.config).not.toHaveProperty('retired')

      // 3c. string scope, relative/non-canonical paths, and budgetAmount > 10_000_000 keep enabled: false
      const invalidDreamCases = [
        {
          label: 'string scope',
          yaml: `- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  disabled: true
  config:
    enabled: false
    retired: false
    scope: owner-scope
    databasePath: /tmp/dream.sqlite
    provider: openai
    model: gpt-5
    budgetId: dreaming-daily
    budgetAmount: 5000
`,
        },
        {
          label: 'relative paths',
          yaml: `- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  disabled: true
  config:
    enabled: false
    scope:
      workspace: relative/ws
      preset: standard
      principalId: web/local/default/owner
      ownerRouteId: owner-web-primary
    databasePath: relative/dream.sqlite
    provider: openai
    model: gpt-5
    budgetId: dreaming-daily
    budgetAmount: 5000
`,
        },
        {
          label: 'non-canonical workspace and oversized budgetAmount',
          yaml: `- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  disabled: true
  config:
    enabled: false
    scope:
      workspace: /tmp/ws/../other
      preset: standard
      principalId: web/local/default/owner
      ownerRouteId: owner-web-primary
    databasePath: /tmp/dream.sqlite
    provider: openai
    model: gpt-5
    budgetId: dreaming-daily
    budgetAmount: 99999999
`,
        },
      ]
      for (const item of invalidDreamCases) {
        writeFileSync(patchPath, item.yaml, { mode: 0o600 })
        const res = await captureRun(['enable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
        expect(res.exitCode, item.label).toBe(0)
        const rows = parseDocument(readFileSync(patchPath, 'utf8')).toJS() as Array<{
          config?: Record<string, unknown>
        }>
        expect(rows[0]?.config?.enabled, item.label).toBe(false)
        expect(rows[0]?.config, item.label).not.toHaveProperty('retired')
      }

      // 3d. !js / !!js dshHomePath(...) paths with valid YAMLMap scope enable dreaming cleanly
      writeFileSync(patchPath, `- id: dsh-ray-assistant-dreaming
  name: "@dsh-ray/assistant-dreaming"
  disabled: true
  config:
    enabled: false
    scope:
      workspace: !!js dshHomePath('workspace')
      preset: standard
      principalId: web/local/default/owner
      ownerRouteId: owner-web-primary
    databasePath: !js dshHomePath('assistant-dreaming', 'web.sqlite')
    provider: openai
    model: gpt-5
    budgetId: dreaming-daily
    budgetAmount: 10000000
`, { mode: 0o600 })
      const enJsDreaming = await captureRun(['enable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
      expect(enJsDreaming.exitCode).toBe(0)
      const jsDreamingRows = parseDocument(readFileSync(patchPath, 'utf8'), {
        customTags: [
          { tag: '!js', resolve: (v: string) => v },
          { tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v },
        ],
      }).toJS() as Array<{ config?: Record<string, unknown> }>
      expect(jsDreamingRows[0]?.config?.enabled).toBe(true)

      // 4. fail closed on missing profile or relative --dsh-home
      const missing = await captureRun(['disable', '--profile', 'does-not-exist', '--dsh-home', dshHome, '--json'])
      expect(missing.exitCode).toBe(1)
      expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false })

      const rel = await captureRun(['enable', '--profile', 'web', '--dsh-home', 'relative/dsh-home', '--json'])
      expect(rel.exitCode).toBe(1)
      expect(JSON.parse(rel.stdout)).toMatchObject({ ok: false })

      // 4b. fail closed on symlinked dshHome (exact, /, and /.) without mutating target; allow real dshHome with / and /.
      writeFileSync(patchPath, initialPatch, { mode: 0o600 })
      const symlinkHome = join(root, 'dsh-home-link')
      symlinkSync(dshHome, symlinkHome, process.platform === 'win32' ? 'junction' : 'dir')
      for (const suffix of ['', '/', '/.']) {
        const symHomeRes = await captureRun(['disable', '--profile', 'web', '--dsh-home', `${symlinkHome}${suffix}`, '--json'])
        expect(symHomeRes.exitCode, `symlink dshHome suffix=${suffix}`).toBe(1)
        expect(JSON.parse(symHomeRes.stdout)).toMatchObject({ ok: false })
        expect(readFileSync(patchPath, 'utf8')).toBe(initialPatch)
      }
      for (const suffix of ['/', '/.']) {
        const realHomeRes = await captureRun(['disable', '--profile', 'web', '--dsh-home', `${dshHome}${suffix}`, '--json'])
        expect(realHomeRes.exitCode, `real dshHome suffix=${suffix}`).toBe(0)
      }

      // 5. fail closed on symlinked cordis.patch.yml
      const targetFile = join(root, 'outside.yml')
      writeFileSync(targetFile, initialPatch, 'utf8')
      rmSync(patchPath)
      symlinkSync(targetFile, patchPath)
      const sym = await captureRun(['disable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
      expect(sym.exitCode).toBe(1)
      expect(JSON.parse(sym.stdout)).toMatchObject({ ok: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('upgradeAssistantAndRecover 按严格顺序执行并在任一步失败时 fail-closed', async () => {
    const order: string[] = []
    const okRes = await upgradeAssistantAndRecover({ dshHome: resolve('/tmp/dsh-test-abs'), profile: 'web', yes: true }, {
      runUpgrade: async () => { order.push('upgrade'); return { ok: true, ready: true } },
      runDoctor: async () => { order.push('doctor'); return { ok: true, ready: true } },
      restartService: async () => { order.push('restart'); return { ok: true, restarted: true } },
    })
    expect(okRes).toEqual({ ok: true, healthy: true, upgraded: true, restarted: true })
    expect(order).toEqual(['upgrade', 'doctor', 'restart'])

    const upFailOrder: string[] = []
    const upFail = await upgradeAssistantAndRecover({ dshHome: resolve('/tmp/dsh-test-abs'), profile: 'web', yes: true }, {
      runUpgrade: async () => { upFailOrder.push('upgrade'); return { ok: false, error: 'upgrade err' } },
      runDoctor: async () => { upFailOrder.push('doctor'); return { ok: true } },
      restartService: async () => { upFailOrder.push('restart'); return { ok: true } },
    })
    expect(upFail).toMatchObject({ ok: false, healthy: false, upgraded: false, restarted: false, error: 'upgrade err' })
    expect(upFailOrder).toEqual(['upgrade'])

    const docFailOrder: string[] = []
    const docFail = await upgradeAssistantAndRecover({ dshHome: resolve('/tmp/dsh-test-abs'), profile: 'web', yes: true }, {
      runUpgrade: async () => { docFailOrder.push('upgrade'); return { ok: true } },
      runDoctor: async () => { docFailOrder.push('doctor'); return { ok: false, ready: false, error: 'doctor err' } },
      restartService: async () => { docFailOrder.push('restart'); return { ok: true } },
    })
    expect(docFail).toMatchObject({ ok: false, healthy: false, upgraded: true, restarted: false, error: 'doctor err' })
    expect(docFailOrder).toEqual(['upgrade', 'doctor'])

    const relHome = await upgradeAssistantAndRecover({ dshHome: 'relative/home', profile: 'web' })
    expect(relHome).toMatchObject({ ok: false, healthy: false })

    // Default restartService skips unmanaged profiles cleanly without failing
    const unmanagedRoot = mkdtempSync(join(tmpdir(), 'dsh-ray-unmanaged-'))
    try {
      const dshHome = join(unmanagedRoot, 'dsh-home')
      const profileDir = join(dshHome, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }), 'utf8')
      const unmRes = await upgradeAssistantAndRecover({
        dshHome,
        profile: 'web',
        osHome: unmanagedRoot,
        platform: 'linux',
        yes: true,
      }, {
        runUpgrade: async () => ({ ok: true, ready: true }),
        runDoctor: async () => ({ ok: true, ready: true }),
      })
      expect(unmRes).toEqual({ ok: true, healthy: true, upgraded: true, restarted: false })
    } finally {
      rmSync(unmanagedRoot, { recursive: true, force: true })
    }
  })

  test('upgradeAssistantAndRecover 在 yes=false / dryRun=true 不重启服务，捕获异常并返回结构化错误，且默认允许非空历史迁移', async () => {
    const checkCalls: string[] = []
    let capturedAllowMigration: unknown
    const checkRes = await upgradeAssistantAndRecover({
      dshHome: resolve('/tmp/dsh-test-abs'),
      profile: 'web',
      yes: false,
    }, {
      runUpgrade: async (opts) => {
        checkCalls.push(`upgrade:${String(opts.action)}`)
        capturedAllowMigration = opts.allowNonEmptyHistoryMigration
        return { ok: true, ready: true }
      },
      runDoctor: async () => {
        checkCalls.push('doctor')
        return { ok: true, ready: true }
      },
      restartService: async () => {
        checkCalls.push('restart')
        return { ok: true, restarted: true }
      },
    })
    expect(checkRes).toEqual({ ok: true, healthy: true, upgraded: false, restarted: false })
    expect(checkCalls).toEqual(['upgrade:check', 'doctor'])
    expect(capturedAllowMigration).toBe(true)

    const dryCalls: string[] = []
    let explicitFalseMigration: unknown
    const dryRes = await upgradeAssistantAndRecover({
      dshHome: resolve('/tmp/dsh-test-abs'),
      profile: 'web',
      dryRun: true,
      allowNonEmptyHistoryMigration: false,
    }, {
      runUpgrade: async (opts) => {
        dryCalls.push(`upgrade:${String(opts.action)}`)
        explicitFalseMigration = opts.allowNonEmptyHistoryMigration
        return { ok: true, ready: true }
      },
      runDoctor: async () => {
        dryCalls.push('doctor')
        return { ok: true, ready: true }
      },
      restartService: async () => {
        dryCalls.push('restart')
        return { ok: true, restarted: true }
      },
    })
    expect(dryRes).toEqual({ ok: true, healthy: true, upgraded: false, restarted: false })
    expect(dryCalls).toEqual(['upgrade:dry-run', 'doctor'])
    expect(explicitFalseMigration).toBe(false)

    // Thrown exceptions in runUpgrade, runDoctor, or restartService are caught cleanly.
    await expect(upgradeAssistantAndRecover({ dshHome: resolve('/tmp/dsh-test-abs'), yes: true }, {
      runUpgrade: async () => { throw new Error('boom in runUpgrade') },
      runDoctor: async () => ({ ok: true }),
      restartService: async () => ({ ok: true }),
    })).resolves.toEqual({
      ok: false,
      healthy: false,
      upgraded: false,
      restarted: false,
      error: 'boom in runUpgrade',
    })

    await expect(upgradeAssistantAndRecover({ dshHome: resolve('/tmp/dsh-test-abs'), yes: true }, {
      runUpgrade: async () => ({ ok: true }),
      runDoctor: async () => { throw new Error('doctor crashed') },
      restartService: async () => ({ ok: true }),
    })).resolves.toEqual({
      ok: false,
      healthy: false,
      upgraded: true,
      restarted: false,
      error: 'doctor crashed',
    })

    await expect(upgradeAssistantAndRecover({ dshHome: resolve('/tmp/dsh-test-abs'), yes: true }, {
      runUpgrade: async () => ({ ok: true }),
      runDoctor: async () => ({ ok: true }),
      restartService: async () => { throw new Error('restart crashed') },
    })).resolves.toEqual({
      ok: false,
      healthy: false,
      upgraded: true,
      restarted: false,
      error: 'restart crashed',
    })
  })

  test('enable / disable 仅重启严格匹配当前 DSH_HOME 且运行中的受管服务，不触碰其他 Home 的 daemon', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ray-toggle-svc-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const otherHome = join(root, 'other-dsh-home')
      const osHome = join(root, 'os-home')
      const profileDir = join(dshHome, 'profiles', 'web')
      const unitDir = join(osHome, '.config', 'systemd', 'user')
      mkdirSync(profileDir, { recursive: true })
      mkdirSync(unitDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }), 'utf8')
      writeFileSync(
        join(profileDir, 'cordis.patch.yml'),
        '- id: dsh-ray-assistant-work-items\n  name: "@dsh-ray/assistant-work-items"\n  config:\n    enabled: true\n',
        'utf8',
      )

      const unitPath = join(unitDir, 'dsh-profile-web.service')
      // 1. Unit belonging to a DIFFERENT DSH_HOME must NOT be restarted.
      writeFileSync(
        unitPath,
        `[Unit]\nDescription=DeepSeek Harness profile web\n[Service]\nWorkingDirectory=${join(otherHome, 'profiles', 'web')}\nEnvironment="DSH_HOME=${otherHome}"\nExecStart=/usr/bin/node /opt/dsh/bin/dsh.js --profile web --no-open\n`,
        'utf8',
      )
      const foreignRunnerCalls: string[] = []
      const outSpy1 = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        const code1 = await main(
          ['disable', '--profile', 'web', '--dsh-home', dshHome, '--json'],
          { DSH_HOME: dshHome },
          {
            platform: 'linux',
            osHome,
            upgradeDeps: {
              runner: (cmd, args) => {
                foreignRunnerCalls.push([cmd, ...args].join(' '))
                return { status: 0, stdout: 'active\n', stderr: '' }
              },
            },
          },
        )
        expect(code1).toBe(0)
        expect(foreignRunnerCalls).toEqual([])
      } finally {
        outSpy1.mockRestore()
      }

      // 2. Unit belonging strictly to THIS DSH_HOME and actively running IS restarted cleanly.
      writeFileSync(
        unitPath,
        `[Unit]\nDescription=DeepSeek Harness profile web\n[Service]\nWorkingDirectory=${join(dshHome, 'profiles', 'web')}\nEnvironment="DSH_HOME=${dshHome}"\nExecStart=/usr/bin/node /opt/dsh/bin/dsh.js --profile web --no-open\n`,
        'utf8',
      )
      const ownRunnerCalls: string[] = []
      const outSpy2 = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        const code2 = await main(
          ['enable', '--profile', 'web', '--dsh-home', dshHome, '--json'],
          { DSH_HOME: dshHome },
          {
            platform: 'linux',
            osHome,
            upgradeDeps: {
              runner: (cmd, args) => {
                ownRunnerCalls.push([cmd, ...args].join(' '))
                if (cmd === 'systemctl' && args.includes('MainPID')) {
                  return { status: 0, stdout: '43210\n', stderr: '' }
                }
                return { status: 0, stdout: 'active\n', stderr: '' }
              },
            },
          },
        )
        expect(code2).toBe(0)
        expect(ownRunnerCalls).toContain('systemctl --user restart dsh-profile-web.service')
      } finally {
        outSpy2.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('provider 子命令路由：透传 --json / --profile、复用 DSH 包目录并返回语义退出码', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-ray-cli-provider-dispatch-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profileDir = join(dshHome, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web' }))
      writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')

      const dshPkgDir = join(root, 'dsh-pkg')
      const piAiDir = join(dshPkgDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
      mkdirSync(piAiDir, { recursive: true })
      writeFileSync(join(dshPkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-test' }))
      writeFileSync(
        join(dshPkgDir, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'),
        JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-test' }),
      )
      writeFileSync(join(piAiDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', main: 'index.cjs' }))
      writeFileSync(join(piAiDir, 'index.cjs'), [
        'exports.Config = raw => raw;',
        'exports.supportedProtocols = () => ["openai-completions"];',
        'exports.apply = ctx => {',
        '  ctx.llm.registerConfigurableProviders([{ provider: "openrouter", displayName: "OpenRouter", settingsNs: "llm-pi-ai", settingsPath: ["providers", "openrouter"], declared: false }]);',
        '  ctx.llm.registerModelDiscovery("llm-pi-ai", async () => [{ id: "openai/gpt-5", name: "GPT-5" }]);',
        '};',
      ].join('\n'))

      const chunks: string[] = []
      const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
        chunks.push(String(chunk))
        return true
      })
      try {
        const listCode = await main(
          ['--json', '--dsh-home', dshHome, '--profile', 'web', 'provider', 'list'],
          { DSH_PACKAGE_ROOT: dshPkgDir },
          { platform: 'linux', osHome: root },
        )
        expect(listCode).toBe(0)
        const parsed = JSON.parse(chunks.join('')) as {
          action: string
          profile: string
          builtinCatalogProviders: Array<{ provider: string }>
        }
        expect(parsed.action).toBe('list')
        expect(parsed.profile).toBe('web')
        expect(parsed.builtinCatalogProviders.map(p => p.provider)).toEqual(['openrouter'])
      } finally {
        outSpy.mockRestore()
      }

      const errChunks: string[] = []
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
        errChunks.push(String(chunk))
        return true
      })
      try {
        const badCode = await main(
          ['provider', '--dsh-home', dshHome, '--unknown-option'],
          { DSH_PACKAGE_ROOT: dshPkgDir },
          { platform: 'linux', osHome: root },
        )
        expect(badCode).toBe(2)
        expect(errChunks.join('')).toContain('未知 provider 选项')
      } finally {
        errSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('F27: subprocess stderr cleanliness and non-SQLite warning preservation', () => {
  const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const binPath = join(pkgRoot, 'bin', 'dsh-ray.js')

  const spawnNodeAsync = (args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('error', rejectPromise)
      child.on('close', status => resolvePromise({ status, stdout, stderr }))
    })

  test('真实子进程执行 --version/-V/version/status/update/upgrade 时 stderr 零 SQLite ExperimentalWarning', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-ray-f27-')))
    const server = createServer((req, res) => {
      const url = req.url ?? '/'
      res.writeHead(200, { 'content-type': 'application/json' })
      if (url.includes('@dsh-ray/cli')) {
        res.end(JSON.stringify({ 'dist-tags': { latest: version } }))
      } else {
        res.end(JSON.stringify({ 'dist-tags': { latest: '0.2.2-rc.5' } }))
      }
    })
    try {
      await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected loopback port')
      const registryUrl = `http://127.0.0.1:${address.port}`

      const absentHome = join(root, 'absent-home')
      const seededHome = join(root, 'seeded-home')
      const profileDir = join(seededHome, 'profiles', 'web')
      const enhancedDir = join(profileDir, 'node_modules', '@dsh-ray', 'assistant-web-owner')
      const cpDir = join(seededHome, 'plugin-control-plane')
      mkdirSync(enhancedDir, { recursive: true })
      mkdirSync(cpDir, { recursive: true })
      writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: dsh-ray-assistant-web-owner\n  name: "@dsh-ray/assistant-web-owner"\n', 'utf8')
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { '@dsh-ray/assistant-web-owner': version } }), 'utf8')
      writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
      writeFileSync(join(enhancedDir, 'package.json'), JSON.stringify({ name: '@dsh-ray/assistant-web-owner', version }), 'utf8')
      const db = new DatabaseSync(join(cpDir, 'web.sqlite'))
      try {
        db.exec('CREATE TABLE IF NOT EXISTS control_plane_meta (k TEXT PRIMARY KEY, v TEXT)')
      } finally {
        db.close()
      }

      const shimDir = join(root, 'shim-bin')
      mkdirSync(shimDir, { recursive: true })
      if (process.platform === 'win32') {
        writeFileSync(join(shimDir, 'npm.cmd'), `@echo off\r\nif "%1"=="prefix" (echo ${join(root, 'npm-prefix')}& exit /b 0)\r\nif "%1"=="view" (echo ${version}& exit /b 0)\r\nexit /b 0\r\n`, 'utf8')
      } else {
        const npmShim = join(shimDir, 'npm')
        writeFileSync(npmShim, `#!/usr/bin/env sh\nif [ "$1" = "prefix" ]; then printf '%s\\n' "${join(root, 'npm-prefix')}"; exit 0; fi\nif [ "$1" = "view" ]; then printf '%s\\n' "${version}"; exit 0; fi\nexit 0\n`, 'utf8')
        chmodSync(npmShim, 0o755)
      }
      const env = { ...process.env, DSH_HOME: absentHome, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}` }

      const syncCases: ReadonlyArray<{ args: string[]; check: (stdout: string) => void }> = [
        { args: ['--version'], check: out => expect(out).toBe(`${version}\n`) },
        { args: ['-V'], check: out => expect(out).toBe(`${version}\n`) },
        { args: ['version', '--short'], check: out => expect(out).toBe(`${version}\n`) },
        {
          args: ['version', '--json', '--dsh-home', absentHome],
          check: out => expect(JSON.parse(out)).toMatchObject({ protocol: 'dsh-ray/version/v1', assistant: { version } }),
        },
        {
          args: ['status', '--json', '--dsh-home', absentHome],
          check: out => expect(JSON.parse(out)).toMatchObject({ homeExists: false, dshHome: absentHome }),
        },
        { args: ['update', '--help'], check: out => expect(out).toContain('update') },
        { args: ['upgrade', '--help'], check: out => expect(out).toContain('upgrade') },
        { args: ['provider', '--help'], check: out => expect(out).toContain('dsh-ray provider') },
        { args: ['--help'], check: out => expect(out).toContain('provider') },
        { args: ['update', '--dry-run', '--version', version], check: out => expect(out.length).toBeGreaterThan(0) },
      ]

      for (const item of syncCases) {
        const res = spawnSync(process.execPath, [binPath, ...item.args], { encoding: 'utf8', env })
        expect(res.error, item.args.join(' ')).toBeUndefined()
        expect(res.status, `${item.args.join(' ')}: ${res.stderr}`).toBe(0)
        expect(res.stderr, item.args.join(' ')).toBe('')
        expect(res.stderr).not.toContain('ExperimentalWarning')
        expect(res.stderr).not.toContain('SQLite is an experimental feature')
        item.check(res.stdout)
      }

      for (const upgradeArgs of [
        ['upgrade', '--check', '--json', '--dsh-home', seededHome, '--registry', registryUrl],
        ['upgrade', '--dry-run', '--json', '--dsh-home', seededHome, '--registry', registryUrl],
      ]) {
        const res = await spawnNodeAsync([binPath, ...upgradeArgs], env)
        expect(res.status, `${upgradeArgs.join(' ')}: ${res.stderr}`).toBe(0)
        expect(res.stderr, upgradeArgs.join(' ')).toBe('')
        expect(res.stderr).not.toContain('ExperimentalWarning')
        expect(res.stderr).not.toContain('SQLite is an experimental feature')
        const parsed = JSON.parse(res.stdout) as { command: string; dshHome: string; packages: { cliPackageVersion: string } }
        expect(parsed.command).toBe('upgrade')
        expect(parsed.dshHome).toBe(seededHome)
        expect(parsed.packages.cliPackageVersion).toBe(version)
      }

      // Real subprocess check for `dsh-ray provider --dsh-home <dir> list --json`
      const fakeDshPkg = join(root, 'fake-dsh', 'node_modules', '@deepseek-ai', 'dsh')
      const fakeBasePkg = join(fakeDshPkg, 'node_modules', '@deepseek-ai', 'dsh-base')
      const fakePiAi = join(fakeBasePkg, 'node_modules', '@deepseek-ai', 'dsh-llm-pi-ai')
      mkdirSync(fakePiAi, { recursive: true })
      writeFileSync(join(fakeDshPkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-f27' }))
      writeFileSync(join(fakeBasePkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.2.2-f27' }))
      writeFileSync(join(fakePiAi, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm-pi-ai', main: 'index.cjs' }))
      writeFileSync(join(fakePiAi, 'index.cjs'), `
        exports.Config = (raw) => raw;
        exports.supportedProtocols = () => ['openai-completions'];
        exports.apply = (ctx) => {
          ctx.llm.registerConfigurableProviders([
            { provider: 'openrouter', displayName: 'OpenRouter', declared: false, defaultBaseURL: 'https://openrouter.ai/api/v1' }
          ]);
        };
      `)
      const providerRes = await spawnNodeAsync(
        [binPath, 'provider', '--dsh-home', seededHome, 'list', '--json'],
        { ...env, PATH: shimDir, DSH_PACKAGE_ROOT: fakeDshPkg },
      )
      expect(providerRes.status, providerRes.stderr).toBe(0)
      expect(providerRes.stderr).toBe('')
      expect(JSON.parse(providerRes.stdout)).toMatchObject({
        ok: true,
        action: 'list',
        profile: 'web',
        dshVersion: '0.2.2-f27',
        supportedProtocols: ['openai-completions'],
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolveClose => server.close(() => resolveClose()))
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('保留非 SQLite 的 ExperimentalWarning 与 DeprecationWarning 输出', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-ray-warn-preserve-')))
    try {
      const preloadPath = join(root, 'emit-warnings.mjs')
      writeFileSync(
        preloadPath,
        [
          "process.once('beforeExit', () => {",
          "  process.emitWarning('Custom experimental feature', 'ExperimentalWarning')",
          "  process.emitWarning('Legacy API deprecated', 'DeprecationWarning')",
          '})',
          '',
        ].join('\n'),
        'utf8',
      )
      const res = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(preloadPath).href, binPath, '--version'],
        { encoding: 'utf8' },
      )
      expect(res.error).toBeUndefined()
      expect(res.status).toBe(0)
      expect(res.stdout).toBe(`${version}\n`)
      expect(res.stderr).not.toContain('SQLite is an experimental feature')
      expect(res.stderr).toContain('ExperimentalWarning: Custom experimental feature')
      expect(res.stderr).toContain('DeprecationWarning: Legacy API deprecated')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
