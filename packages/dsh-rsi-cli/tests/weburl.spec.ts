import { describe, expect, test } from 'vitest'
import type { CommandResult, CommandRunner } from '../src/run.ts'
import { extractWebUrlFromText, formatWebUrlResult, resolveManagedWebUrl } from '../src/weburl.ts'

describe('extractWebUrlFromText', () => {
  test('从 dsh web 行提取带 token 的完整 URL', () => {
    const text = '启动中...\ndsh web: http://127.0.0.1:43210/?token=eyJhbGciOiJIUzI1NiJ9.abc.def\nready'
    expect(extractWebUrlFromText(text)).toBe('http://127.0.0.1:43210/?token=eyJhbGciOiJIUzI1NiJ9.abc.def')
  })

  test('多行时取最后一次启动输出的 URL（token 随重启变化）', () => {
    const text = [
      'dsh web: http://127.0.0.1:1111/?token=OLD',
      'some log',
      'dsh web: http://127.0.0.1:22222/?token=NEW',
    ].join('\n')
    expect(extractWebUrlFromText(text)).toBe('http://127.0.0.1:22222/?token=NEW')
  })

  test('缺 token / 格式异常：只要 http(s) URL 行就提取，不要求 token', () => {
    // 裸 URL 也提取；token 缺失不影响提取本身（URL 完整性由 DSH 输出保证）
    expect(extractWebUrlFromText('dsh web: http://127.0.0.1:8080\n')).toBe('http://127.0.0.1:8080')
  })

  test('没有匹配返回 undefined', () => {
    expect(extractWebUrlFromText('只有普通日志，没有 dsh web 行\n')).toBeUndefined()
    expect(extractWebUrlFromText('')).toBeUndefined()
  })
})

describe('resolveManagedWebUrl', () => {
  const quietRunner: CommandRunner = () => ({ status: 0, stdout: '', stderr: '' } satisfies CommandResult)

  test('服务未注册时给出指引，不报错也不暴露 URL', async () => {
    const entry = await resolveManagedWebUrl('linux', '/home/u', '/home/u/.dsh', 'web', quietRunner)
    expect(entry.url).toBeUndefined()
    expect(entry.errors).toEqual([])
    expect(entry.notice).toMatch(/尚未注册/)
  })

  test('不支持的平台：按未注册处理，给出指引而非错误', async () => {
    const entry = await resolveManagedWebUrl('win32', '/h', '/h/.dsh', 'web', quietRunner)
    expect(entry.url).toBeUndefined()
    expect(entry.errors).toEqual([])
    expect(entry.notice).toMatch(/尚未注册|常驻服务/)
  })

  test('formatWebUrlResult：有 URL 时打印 URL 与来源，notice/error 分别成行', () => {
    const out = formatWebUrlResult([
      { profile: 'web', url: 'http://127.0.0.1:1/?token=x', source: 'journalctl --user -u dsh-profile-web.service', errors: [] },
      { profile: 'lark', notice: '未运行', errors: [] },
      { profile: 'bad', errors: ['boom'] },
    ])
    expect(out).toContain('web：http://127.0.0.1:1/?token=x')
    expect(out).toContain('lark：未运行')
    expect(out).toContain('bad：! boom')
  })
})
