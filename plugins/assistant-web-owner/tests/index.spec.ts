import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-assistant-web-owner', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-web-owner')
    expect(version).toBe(manifest.version)
  })

  it('disables the upstream controller before mounting its own stable row', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain("id: session-controller")
    expect(patch).toContain('disabled: true')
    expect(patch).toContain("name: '@dsh-enhanced/assistant-web-owner'")
  })

  it('builds an owner-scoped copy of the upstream Web client', () => {
    const output = mkdtempSync(join(tmpdir(), 'assistant-web-owner-client-'))
    try {
      execFileSync(process.execPath, ['scripts/build-client.mjs'], {
        cwd: new URL('..', import.meta.url), stdio: 'pipe', env: { ...process.env, DSH_WEB_OWNER_CLIENT_OUT: output },
      })
      const client = readFileSync(join(output, 'client.js'), 'utf8')
      const licenses = readFileSync(join(output, 'THIRD_PARTY_LICENSES'), 'utf8')
      const require = createRequire(import.meta.url)
      const upstream = readFileSync(require.resolve('@deepseek-ai/dsh-api-session-controller/client'), 'utf8')
      const capture = (source: string) => {
        let registration: { id: string; factory: () => unknown } | undefined
        runInNewContext(source, { window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } } })
        if (registration === undefined) throw new Error('client did not register a ModuleLoader factory')
        return registration
      }
      const upstreamRegistration = capture(upstream)
      const ownerRegistration = capture(client)
      const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        dsh: { client: { platform: string; external: string[]; inject: string[] } }
        exports: Record<string, unknown>
      }
      expect(ownerRegistration.id).toBe('@dsh-enhanced/assistant-web-owner')
      expect(upstreamRegistration.id).toBe('@deepseek-ai/dsh-api-session-controller')
      expect(ownerRegistration.factory.toString()).toBe(upstreamRegistration.factory.toString())
      expect(licenses).toContain('Copyright (c) 2026 DeepSeek')
      expect(licenses).toContain('Permission is hereby granted')
      expect(packageJson.exports['./client']).toBeTruthy()
      expect(packageJson.dsh.client).toEqual({
        platform: 'web',
        external: ['@deepseek-ai/dsh-api-gateway/client'],
        inject: ['@deepseek-ai/dsh-api-gateway'],
      })
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
