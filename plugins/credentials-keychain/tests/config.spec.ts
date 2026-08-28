import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Config, name, version } from '../src/index.ts'
import { normalizeHandles } from '../src/config.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('credentials-keychain configuration', () => {
  test('exposes stable package identity and conservative defaults', () => {
    expect(name).toBe('dsh-enhanced-credentials-keychain')
    expect(version).toBe(manifest.version)
    expect(Config({ databasePath: '/private/credentials.sqlite', handles: [] })).toMatchObject({
      defaultLeaseMs: 300_000, maxSecretBytes: 65_536, providerTimeoutMs: 5_000,
    })
  })

  test('normalizes exact provider handles without accepting values or executable paths', () => {
    expect(normalizeHandles([{
      id: 'lark-app-secret', provider: 'macos-keychain', service: 'dsh/lark', account: 'personal',
      consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 3_600_000,
    }])).toEqual([{
      id: 'lark-app-secret', provider: 'macos-keychain', service: 'dsh/lark', account: 'personal',
      consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 3_600_000,
    }])
    expect(normalizeHandles([{
      id: 'windows-secret', provider: 'windows-dpapi',
      path: 'C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml',
      consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 3_600_000,
    }])).toEqual([{
      id: 'windows-secret', provider: 'windows-dpapi',
      path: 'C:\\Users\\test\\.dsh\\credentials-keychain\\lark-primary.clixml',
      consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 3_600_000,
    }])
    expect(normalizeHandles([{
      id: 'linux-file', provider: 'linux-protected-file',
      path: '/home/test/.dsh/credentials-keychain/lark-web-primary.secret',
      consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 3_600_000,
    }])).toEqual([{
      id: 'linux-file', provider: 'linux-protected-file',
      path: '/home/test/.dsh/credentials-keychain/lark-web-primary.secret',
      consumers: ['dsh-enhanced-lark-channel'], purposes: ['connect'], maxLeaseMs: 3_600_000,
    }])
    for (const value of [
      { id: 'x', provider: 'environment', environmentName: 'LARK_SECRET', consumers: ['p'], purposes: ['use'],
        maxLeaseMs: 1_000, value: 'secret' },
      { id: 'x', provider: 'macos-keychain', service: 's', account: 'a', consumers: ['p'], purposes: ['use'],
        maxLeaseMs: 1_000, executable: '/tmp/fake' },
      { id: 'x', provider: 'environment', environmentName: 'bad-name', consumers: ['p'], purposes: ['use'],
        maxLeaseMs: 1_000 },
      { id: 'x', provider: 'windows-dpapi', path: 'relative.clixml', consumers: ['p'], purposes: ['use'],
        maxLeaseMs: 1_000 },
      { id: 'x', provider: 'linux-protected-file', path: 'relative.secret', consumers: ['p'], purposes: ['use'],
        maxLeaseMs: 1_000 },
      { id: 'x', provider: 'linux-protected-file', path: '/private/../escaped.secret',
        consumers: ['p'], purposes: ['use'], maxLeaseMs: 1_000 },
      { id: 'x', provider: 'linux-protected-file', path: '/private/secret', consumers: ['p'], purposes: ['use'],
        maxLeaseMs: 1_000, service: 'forbidden' },
    ]) expect(() => normalizeHandles([value as never])).toThrow()
  })

  test('rejects duplicate ids, wrong provider locators and unbounded allowlists', () => {
    const env = { id: 'same', provider: 'environment' as const, environmentName: 'TOKEN',
      consumers: ['plugin'], purposes: ['connect'], maxLeaseMs: 1_000 }
    expect(() => normalizeHandles([env, env])).toThrow(/duplicate/i)
    expect(() => normalizeHandles([{ ...env, service: 'forbidden' } as never])).toThrow()
    expect(() => normalizeHandles([{ ...env, consumers: [] }])).toThrow(/consumer/i)
    expect(() => normalizeHandles([{ ...env, purposes: Array.from({ length: 33 }, (_, index) => `p${index}`) }]))
      .toThrow(/purpose/i)
  })
})
