import { describe, expect, test } from 'vitest'
import { parseArgs, version } from '../src/index.ts'

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
})
