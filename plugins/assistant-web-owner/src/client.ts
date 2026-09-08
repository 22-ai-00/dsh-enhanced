import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { TYPERT_REMOTE } from './typert.js'

type Notice = Readonly<{ id: string, text: string, createdAt: number }>
type RemoteResult = Readonly<{ ok: true, value: readonly Notice[] }> | Readonly<{ ok: false }>
type NoticeRemote = Readonly<{ list(sessionId: string): Promise<RemoteResult> }>
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  inject(dependencies: readonly string[], callback: (runtime: NoticeRuntime) => unknown): { dispose(): Promise<void> }
}
type NoticeRuntime = {
  readonly remote: { readonly deliveryNotices: NoticeRemote }
  readonly slots: { inject(name: string, factory: () => unknown): unknown, register(options: unknown, component: unknown): unknown }
}

function NoticeDock({ sessionId, list }: Readonly<{ sessionId: string, list: (sessionId: string) => Promise<RemoteResult> }>) {
  const [notices, setNotices] = useState<readonly Notice[]>([])
  const generation = useRef(0)
  useEffect(() => {
    const current = ++generation.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setNotices([])
    const poll = async () => {
      try {
        const result = await list(sessionId)
        if (!disposed && generation.current === current) setNotices(result.ok ? result.value : [])
      } catch {
        // A disconnected, revoked, or malformed response must not leave a
        // stale owner notice visible, and never exposes transport internals.
        if (!disposed && generation.current === current) setNotices([])
      }
      if (!disposed && generation.current === current) timer = setTimeout(poll, 2_000)
    }
    void poll()
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer) }
  }, [list, sessionId])
  return jsx('section', {
    'aria-label': '主动提醒',
    style: { margin: '0 auto 6px', width: 'calc(100% - 24px)', maxWidth: 'calc(var(--dsh-composer-card-max-width) - 24px)', color: 'var(--dsw-alias-label-primary-dimmed)', fontSize: 13 },
    children: notices.map((notice) => jsx('p', { style: { margin: '4px 0', whiteSpace: 'pre-wrap' }, children: notice.text }, notice.id)),
  })
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
    // `$mount()` provides this namespace. It cannot be a top-level plugin
    // injection, because that would wait for this very apply function before
    // mounting it. The nested Cordis fiber owns the slot while the namespace
    // is present and passes the injected runtime to the polling closure.
    const injection = ctx.inject(['remote.deliveryNotices', 'slots'], (runtime) => {
      const list = (sessionId: string): Promise<RemoteResult> => runtime.remote.deliveryNotices.list(sessionId)
      return runtime.slots.inject('conversation.input.dock', () => runtime.slots.register({
        name: 'conversation.input.dock', id: 'delivery-notices', order: 5,
        inject: (sessionId: string) => ({ sessionId, list }),
      }, NoticeDock))
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
