import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { name, version } from '../src/index.ts'
import { TYPERT } from '../src/typert.ts'
import { DeliveryNoticesService } from '../src/notices.ts'

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
      expect(ownerRegistration.factory.toString()).toContain('deliveryNotices/list')
      expect(ownerRegistration.factory.toString()).toContain('conversation.input.dock')
      expect(ownerRegistration.factory.toString()).toContain('sessionControllerApply')
      expect(licenses).toContain('Copyright (c) 2026 DeepSeek')
      expect(licenses).toContain('Permission is hereby granted')
      expect(packageJson.exports['./client']).toBeTruthy()
      expect(packageJson.dsh.client).toEqual({
        platform: 'web',
        external: ['@deepseek-ai/dsh-api-gateway/client'],
        inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-conversation'],
      })
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })

  it('declares a strict, owner-scoped notice RPC rather than an SRC fallback', () => {
    const descriptor = TYPERT.invocations[0]
    expect(descriptor?.namespace).toBe('deliveryNotices')
    expect(descriptor?.method).toBe('list')
    expect(descriptor?.parameters[0]?.codec.mode).toBe('strict')
    expect(descriptor?.result.mode).toBe('strict')
    expect(() => descriptor?.parameters[0]?.codec.schema.parse('')).toThrow()
    expect(descriptor?.result.schema.parse([{ id: 'n1', text: '提醒', createdAt: 1 }])).toEqual([{ id: 'n1', text: '提醒', createdAt: 1 }])
    expect(() => descriptor?.result.schema.parse([{ id: 'n1', text: 1, createdAt: 1 }])).toThrow()
  })

  it('serves notices through a real strict Gateway binding', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(TypertRegistry)
      ctx.typert.register(TYPERT)
      await ctx.plugin(TypertGatewayService, {})
      const access = { notifications: (sessionId: string) => {
        if (sessionId !== 'owned-session') throw new Error('owner session denied')
        return [{ id: 'notice-1', text: '已准备', createdAt: 1 }]
      } }
      const service = new DeliveryNoticesService(ctx, access as never)
      expect(service.typertRemote.service).toBe(service)
      expect(service.typertRemote.serviceKey).toBe('deliveryNotices')
      expect(service.typertRemote.namespace).toBe('deliveryNotices')
      expect(ctx.get('deliveryNotices')).toBeDefined()
      await expect(ctx.typertGateway.invoke({ namespace: 'deliveryNotices', method: 'list', args: { sessionId: 'owned-session' } })).resolves.toEqual([
        { id: 'notice-1', text: '已准备', createdAt: 1 },
      ])
      await expect(ctx.typertGateway.invoke({ namespace: 'deliveryNotices', method: 'list', args: { sessionId: '' } })).rejects.toThrow()
      await expect(ctx.typertGateway.invoke({ namespace: 'deliveryNotices', method: 'list', args: { sessionId: 'foreign-session' } })).rejects.toThrow('owner session denied')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('composes the final client without recursively replacing the upstream apply', async () => {
    const output = mkdtempSync(join(tmpdir(), 'assistant-web-owner-client-runtime-'))
    try {
      execFileSync(process.execPath, ['scripts/build-client.mjs'], {
        cwd: new URL('..', import.meta.url), stdio: 'pipe', env: { ...process.env, DSH_WEB_OWNER_CLIENT_OUT: output },
      })
      const built = readFileSync(join(output, 'client.js'), 'utf8')
      const wrapper = built.indexOf('const ownerNoticeModule')
      const base = built.lastIndexOf('function apply(ctx)', wrapper)
      expect(base).toBeGreaterThan(0)
      // Keep the actual final composed wrapper, while replacing only the very
      // large upstream implementation with a deterministic stand-in. This
      // executes the ModuleLoader factory and proves the wrapper calls the
      // captured upstream apply before mounting/registering the notice client.
      const executable = `${built.slice(0, base)}function apply(ctx) { ctx.order.push('base'); return async () => { ctx.order.push('base-dispose') }; }\n${built.slice(wrapper)}`
      let registration: { factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
      const Empty = class {}
      const fallback = new Proxy({}, { get: () => Empty })
      runInNewContext(executable, { window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } } })
      if (registration === undefined) throw new Error('client did not register a ModuleLoader factory')
      const exports = registration.factory((id) => {
        if (id === 'react') return { useEffect: () => undefined, useRef: (value: unknown) => ({ current: value }), useState: (value: unknown) => [value, () => undefined] }
        if (id === 'react/jsx-runtime') return { jsx: () => null }
        return fallback
      })
      const order: string[] = []
      let descriptor: unknown
      let slot: unknown
      const ctx = {
        order,
        remote: {
          $mount: async (value: unknown) => { order.push('mount'); descriptor = value; return async () => { order.push('unmount') } },
        },
        inject: (dependencies: readonly string[], callback: (runtime: unknown) => unknown) => {
          order.push(`inject:${dependencies.join(',')}`)
          const child = callback({
            remote: { deliveryNotices: { list: async () => ({ ok: true, value: [] }) } },
            slots: {
              inject: (_name: string, factory: () => unknown) => { order.push('slot-inject'); factory(); return () => { order.push('slot-dispose') } },
              register: (value: unknown) => { order.push('register'); slot = value; return () => undefined },
            },
          })
          return { dispose: async () => {
            order.push('injection-dispose')
            if (typeof child === 'function') await Promise.resolve(child())
          } }
        },
      }
      const dispose = await (exports.apply as (value: typeof ctx) => Promise<() => Promise<void>>)(ctx)
      expect(order).toEqual(['base', 'mount', 'inject:remote.deliveryNotices,slots', 'slot-inject', 'register'])
      expect(JSON.stringify(descriptor)).toContain('deliveryNotices/list')
      expect(JSON.stringify(slot)).toContain('delivery-notices')
      expect((exports.inject as readonly string[])).toContain('slots')
      await dispose()
      expect(order).toEqual(['base', 'mount', 'inject:remote.deliveryNotices,slots', 'slot-inject', 'register', 'injection-dispose', 'slot-dispose', 'unmount', 'base-dispose'])
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  })
})
