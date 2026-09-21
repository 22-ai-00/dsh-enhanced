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

  test('未知参数报错', () => {
    expect(() => parseArgs(['--bogus'], { HOME: '/h' })).toThrow(/无法识别/)
  })

  test('带值选项缺值时报错', () => {
    expect(() => parseArgs(['purge', '--profile'], { HOME: '/h' })).toThrow(/需要一个值/)
  })
})
