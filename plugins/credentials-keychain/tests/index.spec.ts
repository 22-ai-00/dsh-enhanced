import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(plugin).toEqual({ name, Config, inject, apply: expect.any(Function) })
    expect(Config).toBe(CredentialsKeychainService.Config)
  })

  test('keeps the Loader-mounted plugin pending and follows the Policy provider lifecycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'credentials-keychain-entry-'))
    const ctx = new Context()
    try {
      const keychain = ctx.plugin(plugin, {
        databasePath: join(root, 'credentials.sqlite'),
        handles: [],
      })
      await Promise.resolve()
      expect(ctx.get('credentialsKeychain')).toBeUndefined()

      let policy = ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: [],
      })
      await policy
      await keychain
      const first = ctx.get('credentialsKeychain')
      expect(first).toBeInstanceOf(CredentialsKeychainService)

      await policy.dispose()
      await keychain.await()
      expect(ctx.get('credentialsKeychain')).toBeUndefined()

      policy = ctx.plugin(AssistantPolicyService, {
        databasePath: join(root, 'policy.sqlite'),
        rules: [],
      })
      await policy
      await keychain
      expect(ctx.get('credentialsKeychain')).toBeInstanceOf(CredentialsKeychainService)
      expect(ctx.get('credentialsKeychain')).not.toBe(first)
    } finally {
      await ctx.fiber.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
