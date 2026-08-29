import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Config, name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('lark-channel bundle contract', () => {
  test('has stable package identity', () => {
    expect(name).toBe('dsh-enhanced-lark-channel')
    expect(version).toBe(manifest.version)
  })

  test('accepts only a secret environment name and rejects plaintext-looking config fields', () => {
    expect(Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef', appSecretEnv: 'LARK_APP_SECRET' }))
      .toMatchObject({ appSecretEnv: 'LARK_APP_SECRET', enabled: false, requireMentionInGroups: true,
        showProgress: true, progressDetails: 'direct', statusReactions: true, imageDownloadTimeoutMs: 30_000 })
    expect(() => Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef', appSecretEnv: 'not-valid' }))
      .toThrow()
    expect(() => Config({
      account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef', appSecretEnv: 'LARK_APP_SECRET', appSecret: 'plaintext',
    } as never)).toThrow()
  })

  test('shows detailed progress only in direct messages', () => {
    expect(Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET', progressDetails: 'off' }))
      .toMatchObject({ progressDetails: 'off' })
    expect(() => Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET', progressDetails: 'all' } as never)).toThrow()
  })

  test('bounds the image resource request timeout independently from the websocket handshake', () => {
    expect(Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET', imageDownloadTimeoutMs: 45_000 }))
      .toMatchObject({ imageDownloadTimeoutMs: 45_000 })
    expect(() => Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET', imageDownloadTimeoutMs: 999 })).toThrow()
    expect(() => Config({ account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      appSecretEnv: 'LARK_APP_SECRET', imageDownloadTimeoutMs: 120_001 })).toThrow()
  })

  test('accepts one credential handle instead of environment access but never both', () => {
    expect(Config({ enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      credentialHandle: 'lark-app-secret', credentialPurpose: 'connect', credentialLeaseMs: 3_600_000 }))
      .toMatchObject({ credentialHandle: 'lark-app-secret', credentialPurpose: 'connect', credentialLeaseMs: 3_600_000 })
    expect(() => Config({ enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef',
      credentialHandle: 'lark-app-secret', appSecretEnv: 'LARK_APP_SECRET' })).toThrow(/credential|secret/i)
    expect(() => Config({ enabled: true, account: 'primary', tenant: 'tenant-a', appId: 'cli_0123456789abcdef' }))
      .toThrow(/credential|secret/i)
  })
})
