import { useEffect, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { TYPERT_REMOTE } from './typert.js'
import type { OwnerConsoleStatus } from './typert.js'

/** The installed Host supplies remote and the slot registry. */
export const inject = ['remote', 'slots']

type RemoteResult = Readonly<{ ok: true, value: OwnerConsoleStatus }> | Readonly<{ ok: false }>
type ConsoleRemote = Readonly<{ status(): Promise<RemoteResult> }>
type SlotRuntime = {
  readonly remote: Readonly<{ ownerConsole: ConsoleRemote }>
  readonly slots: {
    inject(name: string, factory: () => unknown): () => void
    register(options: unknown, component: unknown): () => void
  }
}
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  inject(dependencies: readonly string[], callback: (runtime: SlotRuntime) => unknown): { dispose(): Promise<void> }
}

const muted = 'var(--dsw-alias-label-primary-dimmed)'

function row(label: string, value: string) {
  return jsx('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0' },
    children: [
      jsx('span', { style: { color: muted }, children: label }),
      jsx('span', { children: value }),
    ] })
}

function card(title: string, body: unknown) {
  return jsx('div', { style: { border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: 8, padding: 16 },
    children: [
      jsx('h3', { style: { margin: '0 0 8px', fontSize: 14 }, children: title }),
      body,
    ] })
}

/** Left-sidebar icon; the shipped panel row supplies size/active owner props. */
export function OwnerConsoleIcon() {
  return jsx('span', {
    'aria-hidden': true,
    style: { display: 'block', width: 18, height: 18, borderRadius: 4, border: '1px solid currentColor', textAlign: 'center', lineHeight: '16px', fontSize: 11 },
    children: '控',
  })
}

/** One page, three cards: only the rows a person may need to act on. */
export function OwnerConsolePanel({ remote }: Readonly<{ remote: ConsoleRemote }>) {
  const [status, setStatus] = useState<OwnerConsoleStatus>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let disposed = false
    void (async () => {
      try {
        const result = await remote.status()
        if (disposed) return
        if (result.ok) setStatus(result.value)
        else setFailed(true)
      } catch {
        if (!disposed) setFailed(true)
      }
    })()
    return () => { disposed = true }
  }, [remote])
  const pending = status === undefined
  const feishu = failed
    ? jsx('p', { style: { margin: 0, fontSize: 13, color: muted }, children: '暂时无法读取状态，稍后重试。' })
    : jsx('div', { style: { fontSize: 13 }, children: [
      row('方式', pending ? '…' : status.feishu.mode === 'lark-cli' ? 'lark-cli 向导' : '直接填写'),
      row('连接', pending ? '…' : status.feishu.connected ? '已加载' : '未连接'),
      row('appId', pending ? '…' : status.feishu.appIdConfigured ? '已配置' : '未配置'),
    ] })
  const traex = jsx('p', { style: { margin: 0, fontSize: 13, color: muted },
    children: pending ? '…' : status.traex.enabled ? '入口已启用' : '入口未启用' })
  const dependencies = jsx('div', { style: { fontSize: 13 }, children: pending
    ? [jsx('p', { style: { margin: 0, color: muted }, children: '…' })]
    : status.dependencies.map(item => row(item.name, item.available ? '可用' : '缺失')) })
  return jsx('section', {
    'aria-label': '主人控制台',
    style: { padding: '24px', maxWidth: 720, margin: '0 auto', display: 'grid', gap: 16 },
    children: [
      jsx('h2', { style: { margin: 0, fontSize: 18 }, children: '控制台' }),
      jsx('p', { style: { margin: 0, fontSize: 13, color: muted }, children: '只显示需要你处理的事。' }),
      card('远程接入（飞书）', feishu),
      card('TraeX', traex),
      card('依赖自检', dependencies),
    ],
  })
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
    const injection = ctx.inject(['remote.ownerConsole', 'slots'], runtime => {
      const remote = runtime.remote.ownerConsole
      const panel = () => jsx(OwnerConsolePanel, { remote })
      const sidebar = runtime.slots.inject('sidebar.panellist', () => runtime.slots.register(
        { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: () => '控制台' }, OwnerConsoleIcon))
      const main = runtime.slots.inject('main', () => runtime.slots.register(
        { name: 'main', key: 'owner-console' }, panel))
      // Cordis effects accept a function: dispose the slot registrations in reverse order.
      return () => { main(); sidebar() }
    })
    return async () => {
      await injection.dispose()
      await unmount()
    }
  } catch (error) {
    await unmount()
    throw error
  }
}
