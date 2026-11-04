import { describe, expect, it, vi } from 'vitest'
import { TYPERT_REMOTE } from '../src/typert.ts'
import { apply, feishuSecretRefs, larkConnectionLabel } from '../src/client.ts'

type Registration = Readonly<{ options: Record<string, unknown>, component: unknown }>

function fakeContext(registrations: Registration[], disposed: string[]) {
  const unmount = vi.fn(async () => undefined)
  return {
    ctx: {
      remote: { $mount: vi.fn(async (descriptor: unknown) => { expect(descriptor).toBe(TYPERT_REMOTE); return unmount }) },
      get: (name: string) => name === 'layout'
        ? { selectPanel: vi.fn() }
        : name === 'uiWorkspace' ? { startSession: vi.fn() } : undefined,
      inject: (dependencies: readonly string[], callback: (runtime: never) => unknown) => {
        expect(dependencies).toEqual(['remote.ownerConsole', 'slots'])
        const runtime = {
          remote: { ownerConsole: { status: vi.fn(async () => ({ ok: false as const })) } },

          slots: {
            // Mirrors the renderer: inject and register both return callable disposers.
            inject: (name: string, factory: () => unknown) => {
              const dispose = factory() as () => void
              return () => { disposed.push(name); dispose() }
            },
            register: (options: Record<string, unknown>, component: unknown) => {
              registrations.push({ options, component })
              return () => { disposed.push(String(options['id'] ?? options['key'])) }
            },
          },
        }
        const release = (callback as unknown as (value: unknown) => () => void)(runtime)
        return { dispose: async () => { release() } }
      },
    } as never,
    unmount,
  }
}

describe('owner console client', () => {
  it('submits exactly the secret reference the owner picked', () => {
    expect(feishuSecretRefs('env', 'LARK_APP_SECRET', 'typed-handle'))
      .toEqual({ appSecretEnv: 'LARK_APP_SECRET', credentialHandle: '' })
    expect(feishuSecretRefs('handle', 'ignored-env', 'typed-handle'))
      .toEqual({ appSecretEnv: '', credentialHandle: 'typed-handle' })
  })

  it('labels the lark-channel health snapshot without inventing a connection', () => {
    expect(larkConnectionLabel('absent')).toBe('未加载')
    expect(larkConnectionLabel('unknown')).toBe('已加载，状态未知')
    expect(larkConnectionLabel('connected')).toBe('已连接')
    expect(larkConnectionLabel('reconnecting', 'rate_limited')).toBe('重连中（最近错误：rate_limited）')
  })

  it('registers the sidebar entry and the keyed main panel, then disposes both', async () => {
    const registrations: Registration[] = [], disposed: string[] = []
    const { ctx, unmount } = fakeContext(registrations, disposed)
    const release = await apply(ctx)
    expect(registrations.map(item => item.options)).toEqual([
      { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: expect.any(Function) },
      { name: 'main', key: 'owner-console' },
    ])
    expect(typeof registrations[0]!.component).toBe('function')
    expect(typeof registrations[1]!.component).toBe('function')
    await release()
    expect(disposed).toEqual(['main', 'owner-console', 'sidebar.panellist', 'owner-console'])
    expect(unmount).toHaveBeenCalledOnce()
  })
})
