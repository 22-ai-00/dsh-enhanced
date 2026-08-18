import { describe, expect, it, vi } from 'vitest'
import { verifyTraexAuth, type AuthCommandRunner, type VerifyTraexAuthOptions } from '../src/auth.ts'

const options: VerifyTraexAuthOptions = {
  command: 'traex',
  cwd: '/repo',
  timeoutMs: 1_000,
  maxOutputBytes: 4_096,
  extraEnvNames: [],
}

function result(stdout = '', stderr = '') {
  return { exitCode: 0, signal: null, stdout, stderr } as const
}

describe('TraeX tool-account authentication gate', () => {
  it('accepts only the exact Trae login status', async () => {
    const trae = vi.fn(() => Promise.resolve(result('Logged in using Trae\n'))) as AuthCommandRunner
    await expect(verifyTraexAuth(options, trae)).resolves.toBeUndefined()
    expect(trae).toHaveBeenCalledWith('traex', ['login', 'status'], options)
  })

  it.each([
    'Not logged in',
    'Logged in using ChatGPT',
    'Logged in using an API key',
    'Logged in using access token',
    'notice\nLogged in using Trae',
  ])('rejects a non-Trae or ambiguous status: %s', async stdout => {
    const runner = vi.fn(() => Promise.resolve(result(stdout))) as AuthCommandRunner
    await expect(verifyTraexAuth(options, runner)).rejects.toMatchObject({ cause: 'auth' })
  })

  it('rejects a nonzero status probe without exposing its output', async () => {
    const runner = vi.fn(() => Promise.resolve({ ...result('account@example.com'), exitCode: 1 })) as AuthCommandRunner
    await expect(verifyTraexAuth(options, runner)).rejects.toMatchObject({ cause: 'auth' })
  })
})
