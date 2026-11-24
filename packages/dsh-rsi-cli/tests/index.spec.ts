import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
    expect(parsed.protocol).toBe('dsh-rsi/version/v1')
    expect(parsed.assistant.version).toBe(version)
    expect(parsed.selfIteration.dataState).toBe('no-data')

    const textRes = await captureMain(['version'])
    expect(textRes.code).toBe(0)
    expect(textRes.stdout).toContain(`dsh-enhanced v${version}`)
    expect(textRes.stdout).toContain('no-data')

    // Ensure re-exported helpers & types are wired cleanly
    const opts: CollectVersionReportOptions = { dshHome: '/does/not/exist-dsh-home', runningVersion: null }
    const directReport = await collectVersionReport(opts)
    const entryCheck: readonly AssistantVersionPluginEntry[] = directReport.plugins.core
    expect(entryCheck).toEqual([])
    expect(formatVersionReport(directReport)).toContain(`dsh-enhanced v${version}`)
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

    const tmp = mkdtempSync(join(tmpdir(), 'dsh-rsi-standalone-'))
    try {
      cpSync(join(pkgRoot, 'package.json'), join(tmp, 'package.json'))
      cpSync(join(pkgRoot, 'bin'), join(tmp, 'bin'), { recursive: true })
      cpSync(join(pkgRoot, 'lib'), join(tmp, 'lib'), { recursive: true })
      for (const dep of deps) {
        const targetLink = join(tmp, 'node_modules', dep)
        mkdirSync(dirname(targetLink), { recursive: true })
        symlinkSync(resolveDepRoot(dep), targetLink, process.platform === 'win32' ? 'junction' : 'dir')
      }

      const upgradeHelpOut = execFileSync(
        process.execPath,
        [join(tmp, 'bin', 'dsh-rsi.js'), 'upgrade', '--help'],
        { cwd: tmp, encoding: 'utf8' },
      )
      expect(upgradeHelpOut).toContain('dsh-rsi — DSH enhanced')
      expect(upgradeHelpOut).toContain('upgrade ')

      const capabilitiesOut = execFileSync(
        process.execPath,
        [join(tmp, 'bin', 'dsh-rsi.js'), '--capabilities'],
        { cwd: tmp, encoding: 'utf8' },
      )
      expect(capabilitiesOut).toBe('{"capabilities":["macos-launchd-ownership-v1"]}\n')

      const verOut = execFileSync(
        process.execPath,
        [join(tmp, 'bin', 'dsh-rsi.js'), '--version'],
        { cwd: tmp, encoding: 'utf8' },
      )
      expect(verOut).toBe(`${version}\n`)

      const shortOut = execFileSync(
        process.execPath,
        [join(tmp, 'bin', 'dsh-rsi.js'), 'version', '--short'],
        { cwd: tmp, encoding: 'utf8' },
      )
      expect(shortOut).toBe(`${version}\n`)

      const verJsonOut = execFileSync(
        process.execPath,
        [join(tmp, 'bin', 'dsh-rsi.js'), 'version', '--json', '--dsh-home', join(tmp, 'absent-home')],
        { cwd: tmp, encoding: 'utf8' },
      )
      const parsedVerJson = JSON.parse(verJsonOut) as AssistantVersionReport
      expect(parsedVerJson.protocol).toBe('dsh-rsi/version/v1')
      expect(parsedVerJson.schemaVersion).toBe(1)
      expect(parsedVerJson.selfIteration.dataState).toBe('no-data')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('F21 enable / disable / upgradeAssistantAndRecover', () => {
  test('parseArgs 解析 enable / disable 与 --allow-non-empty-history-migration 并拒绝误用', () => {
    expect(parseArgs(['enable', '--profile', 'web', '--json'], { HOME: '/h' })).toMatchObject({
      command: 'enable', profile: 'web', json: true,
    })
    expect(parseArgs(['disable', '--profile', 'web', '--dry-run', '--json'], { HOME: '/h' })).toMatchObject({
      command: 'disable', profile: 'web', dryRun: true, json: true,
    })
    expect(parseArgs(['upgrade', '--yes', '--allow-non-empty-history-migration'], { HOME: '/h' })).toMatchObject({
      command: 'upgrade', yes: true, allowNonEmptyHistoryMigration: true,
    })
    expect(() => parseArgs(['status', '--allow-non-empty-history-migration'], { HOME: '/h' })).toThrow(/仅适用于 upgrade/)
  })

  test('enable / disable 原地 AST 切换自迭代开关，保留 !js、注释、ownerRoutes 与受保护行，并在非法输入时 fail-closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-toggle-'))
    try {
      const dshHome = join(root, 'dsh-home')
      const profileDir = join(dshHome, 'profiles', 'web')
      mkdirSync(profileDir, { recursive: true })
      const patchPath = join(profileDir, 'cordis.patch.yml')
      const initialPatch = `# preserve header comment
- id: dsh-enhanced-assistant-web-owner
  name: "@dsh-enhanced/assistant-web-owner"
  config:
    enabled: true
- id: dsh-enhanced-assistant-delivery
  name: "@dsh-enhanced/assistant-delivery"
  config:
    ownerRoutes:
      - owner-route-1
- id: dsh-enhanced-assistant-work-items
  name: "@dsh-enhanced/assistant-work-items"
  config:
    enabled: true
    databasePath: !js dshHomePath('assistant-work-items', 'web.sqlite')
- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
  config:
    enabled: false
    retired: true
    databasePath: !js dshHomePath('assistant-dreaming', 'web.sqlite')
- id: dsh-enhanced-assistant-evolution
  name: "@dsh-enhanced/assistant-evolution"
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
      expect(disableById.get('dsh-enhanced-assistant-web-owner')?.disabled).toBeUndefined()
      expect(disableById.get('dsh-enhanced-assistant-web-owner')?.config?.enabled).toBe(true)
      expect(disableById.get('dsh-enhanced-assistant-delivery')?.disabled).toBeUndefined()
      expect(disableById.get('dsh-enhanced-assistant-work-items')?.disabled).toBe(true)
      expect(disableById.get('dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(false)
      expect(disableById.get('dsh-enhanced-assistant-evolution')?.disabled).toBe(true)
      expect(disableById.get('dsh-enhanced-assistant-evolution')?.config).not.toHaveProperty('enabled')

      // 3. enable restores work-items, clears retired on dreaming, and keeps incomplete dreaming disabled (enabled: false)
      const en = await captureRun(['enable', '--profile', 'web', '--dsh-home', dshHome, '--json'])
      expect(en.exitCode).toBe(0)
      expect(JSON.parse(en.stdout)).toMatchObject({ ok: true, state: 'enabled', profile: 'web', dshHome })
      const afterEnable = readFileSync(patchPath, 'utf8')
      const enableRows = parseDocument(afterEnable, {
        customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v: string) => v }],
      }).toJS() as Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }>
      const enableById = new Map(enableRows.map(r => [r.id, r]))
      expect(enableById.get('dsh-enhanced-assistant-work-items')?.disabled).toBeUndefined()
      expect(enableById.get('dsh-enhanced-assistant-work-items')?.config?.enabled).toBe(true)
      expect(enableById.get('dsh-enhanced-assistant-dreaming')?.disabled).toBeUndefined()
      expect(enableById.get('dsh-enhanced-assistant-dreaming')?.config?.enabled).toBe(false)
      expect(enableById.get('dsh-enhanced-assistant-dreaming')?.config).not.toHaveProperty('retired')

      // 3b. dreaming with all 6 required fields (map scope + retired: true) IS enabled & retired cleared on `dsh-rsi enable`
      writeFileSync(patchPath, `- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
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
          yaml: `- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
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
          yaml: `- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
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
          yaml: `- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
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
      writeFileSync(patchPath, `- id: dsh-enhanced-assistant-dreaming
  name: "@dsh-enhanced/assistant-dreaming"
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
    const unmanagedRoot = mkdtempSync(join(tmpdir(), 'dsh-rsi-unmanaged-'))
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
    const root = mkdtempSync(join(tmpdir(), 'dsh-rsi-toggle-svc-'))
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
        '- id: dsh-enhanced-assistant-work-items\n  name: "@dsh-enhanced/assistant-work-items"\n  config:\n    enabled: true\n',
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
})
