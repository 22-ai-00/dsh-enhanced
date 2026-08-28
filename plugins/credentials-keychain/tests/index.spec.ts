import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import plugin, {
  Config,
  CredentialsKeychainService,
  inject,
  name,
  supportedCredentialProviders,
  version,
} from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

describe('dsh-enhanced-credentials-keychain entrypoint', () => {
  test('exports stable identity, injection, service, and config', () => {
    expect(name).toBe('dsh-enhanced-credentials-keychain')
    expect(version).toBe(manifest.version)
    expect(inject).toEqual(['assistantPolicy'])
    expect(supportedCredentialProviders).toContain('linux-protected-file')
    expect(plugin).toBe(CredentialsKeychainService)
    expect(Config).toBe(CredentialsKeychainService.Config)
  })
})
