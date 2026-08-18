import { describe, expect, it, vi } from 'vitest'
import { verifySubscriptionAuth, type AuthCommandRunner, type VerifySubscriptionAuthOptions } from '../src/auth.ts'

const options: VerifySubscriptionAuthOptions = {
  command: 'tool',
  cwd: '/repo',
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
  extraEnvNames: [],
}

function result(stdout = '', stderr = '') {
  return { exitCode: 0, signal: null, stdout, stderr } as const
}

describe('subscription authentication probes', () => {
  it('accepts only the official Codex ChatGPT status', async () => {
    const chatgpt = vi.fn(() => Promise.resolve(result('', 'Logged in using ChatGPT'))) as AuthCommandRunner
    await expect(verifySubscriptionAuth('codex', options, chatgpt)).resolves.toBeUndefined()
    expect(chatgpt).toHaveBeenCalledWith('tool', ['login', 'status'], options)

    const apiKey = vi.fn(() => Promise.resolve(result('', 'Logged in using an API key - sk-...'))) as AuthCommandRunner
    await expect(verifySubscriptionAuth('codex', options, apiKey)).rejects.toMatchObject({ cause: 'subscription-auth' })
  })

  it('accepts first-party Claude subscription OAuth and rejects API auth', async () => {
    const oauth = vi.fn(() => Promise.resolve(result(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })))) as AuthCommandRunner
    await expect(verifySubscriptionAuth('claude', options, oauth)).resolves.toBeUndefined()

    const apiKey = vi.fn(() => Promise.resolve(result(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', email: 'secret@example.com' })))) as AuthCommandRunner
    await expect(verifySubscriptionAuth('claude', options, apiKey)).rejects.toMatchObject({ cause: 'subscription-auth' })
  })

  it('requires Cursor status success and defers source verification to system/init', async () => {
    const loggedIn = vi.fn(() => Promise.resolve(result('Logged in'))) as AuthCommandRunner
    await expect(verifySubscriptionAuth('cursor', options, loggedIn)).resolves.toBeUndefined()

    const failed = vi.fn(() => Promise.resolve({ ...result(), exitCode: 1 })) as AuthCommandRunner
    await expect(verifySubscriptionAuth('cursor', options, failed)).rejects.toMatchObject({ cause: 'subscription-auth' })
  })

  it('requires explicit local verification for the Grok CLI MVP', async () => {
    const runner = vi.fn() as unknown as AuthCommandRunner
    await expect(verifySubscriptionAuth('grok', options, runner)).rejects.toMatchObject({ cause: 'subscription-auth' })
    await expect(verifySubscriptionAuth('grok', { ...options, userVerifiedSubscription: true }, runner)).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed on unknown Codex status output', async () => {
    const unknown = vi.fn(() => Promise.resolve(result('status schema changed'))) as AuthCommandRunner
    await expect(verifySubscriptionAuth('codex', options, unknown)).rejects.toMatchObject({ cause: 'subscription-auth' })
  })
})
