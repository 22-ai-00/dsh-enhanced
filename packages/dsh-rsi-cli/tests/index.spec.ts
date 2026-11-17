import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { main, parseArgs, version } from '../src/index.ts'

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
        symlinkSync(resolveDepRoot(dep), targetLink, 'dir')
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
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
