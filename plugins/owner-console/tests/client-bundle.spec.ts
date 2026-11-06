import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

type BundleRegistration = { id: string, factory(require: (id: string) => unknown): { apply(ctx: unknown): Promise<() => Promise<void>> } }

const require = createRequire(import.meta.url)

/** Load the emitted Web bundle through the shell's module-loader contract. */
function loadBundle(): BundleRegistration {
  let registration: BundleRegistration | undefined
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: (value: BundleRegistration) => { registration = value } } },
    AbortController, AbortSignal, URL, console, Promise, setTimeout, clearTimeout,
  })
  if (registration === undefined) throw new Error('owner-console client bundle did not register a ModuleLoader factory')
  return registration
}

function clientContext() {
  const registrations: { name: string, options: Record<string, unknown>, component: unknown }[] = []
  const disposed: string[] = []
  const unmount = vi.fn(async () => undefined)
  const ctx = {
    remote: { $mount: vi.fn(async () => unmount) },
    get: () => undefined,
    inject: (dependencies: readonly string[], callback: (runtime: never) => unknown) => {
      const runtime = {
        remote: { ownerConsole: {
          status: vi.fn(async () => ({ ok: false as const })),
          configureFeishu: vi.fn(), configureTraex: vi.fn(), configureBundle: vi.fn(),
          setBundleEnabled: vi.fn(), setPluginEnabled: vi.fn(), installProjectBundle: vi.fn(), removeProjectBundle: vi.fn(),
        } },
        slots: {
          inject: (name: string, factory: () => unknown) => {
            const dispose = factory() as () => void
            return () => { disposed.push(name); dispose() }
          },
          register: (options: Record<string, unknown>, component: unknown) => {
            registrations.push({ name: String(options['name']), options, component })
            expect(typeof component).toBe('function')
            return () => { disposed.push(String(options['id'] ?? options['key'])) }
          },
        },
      }
      const release = (callback as unknown as (value: unknown) => () => void)(runtime)
      expect(dependencies).toEqual(['remote.ownerConsole', 'slots'])
      return { dispose: async () => release() }
    },
  }
  return { ctx, registrations, disposed, unmount }
}

describe('owner console client bundle', () => {
  it('registers the sidebar entry and keyed main panel from the emitted bundle', async () => {
    const registration = loadBundle()
    expect(registration.id).toBe('@dsh-enhanced/owner-console')
    const React = require('react') as unknown
    const jsxRuntime = require('react/jsx-runtime') as unknown
    const module = registration.factory(id => {
      if (id === 'react') return React
      if (id === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected bundle dependency ${id}`)
    })
    const fake = clientContext()
    const release = await module.apply(fake.ctx)
    expect(fake.ctx.remote.$mount).toHaveBeenCalledOnce()
    expect(fake.registrations.map(item => item.options)).toEqual([
      { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: expect.any(Function) },
      { name: 'main', key: 'owner-console' },
    ])
    expect((fake.registrations[0]!.options['label'] as () => string)()).toBe('文鳐')
    // The main slot root must own vertical scrolling so lower cards stay reachable on short windows.
    type Element = { type: (props: unknown) => Element, props: { style?: Record<string, unknown> } & Record<string, unknown> }
    const mainElement = (fake.registrations[1]!.component as () => Element)()
    const root = mainElement.type(mainElement.props)
    expect(root.props['data-owner-console-scroll']).toBe('')
    expect(root.props.style).toMatchObject({ height: '100%', minHeight: 0, overflowY: 'auto' })
    // The brand header and its banner are self-contained in the emitted bundle (no asset URL).
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    expect(source).toContain('data-owner-console-header')
    expect(source).toContain('data:image/webp;base64,')
    await release()
    expect(fake.disposed).toEqual(['main', 'owner-console', 'sidebar.panellist', 'owner-console'])
    expect(fake.unmount).toHaveBeenCalledOnce()
  })
})
