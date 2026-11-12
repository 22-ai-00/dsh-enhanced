import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { TYPERT_REMOTE } from './typert.js'

/** The Session client itself is supplied by the installed Host, not this bundle. */
export const inject = ['remote', 'slots']

type Notice = Readonly<{ id: string, text: string, createdAt: number, status?: 'accepted' | 'delivered' }>
type RemoteResult = Readonly<{ ok: true, value: readonly Notice[] }> | Readonly<{ ok: false }>
type NoticeAckStatus = 'delivered' | 'read'
type NoticeRemote = Readonly<{
  list(sessionId: string): Promise<RemoteResult>
  ack(sessionId: string, ids: readonly string[], status: NoticeAckStatus): Promise<unknown>
}>
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  inject(dependencies: readonly string[], callback: (runtime: NoticeRuntime) => unknown): { dispose(): Promise<void> }
}
type NoticeRuntime = {
  readonly remote: { readonly deliveryNotices: NoticeRemote }
  readonly slots: { inject(name: string, factory: () => unknown): unknown, register(options: unknown, component: unknown): unknown }
}

function NoticeDock({ sessionId, list, ack }: Readonly<{
  sessionId: string
  list: (sessionId: string) => Promise<RemoteResult>
  ack: (sessionId: string, ids: readonly string[], status: NoticeAckStatus) => Promise<unknown>
}>) {
  const [notices, setNotices] = useState<readonly Notice[]>([])
  const generation = useRef(0)
  const delivered = useRef(new Set<string>())
  useEffect(() => {
    const current = ++generation.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setNotices([])
    delivered.current.clear()
    const poll = async () => {
      try {
        const result = await list(sessionId)
        if (!disposed && generation.current === current) {
          setNotices(result.ok ? result.value : [])
          if (result.ok) {
            // A successful list/render is the Web transport's delivery fact.
            const fresh = result.value.map(notice => notice.id).filter(id => !delivered.current.has(id))
            if (fresh.length > 0) {
              void ack(sessionId, fresh, 'delivered').then(() => {
                if (!disposed && generation.current === current) for (const id of fresh) delivered.current.add(id)
              }, () => { /* best-effort; the next poll retries an unmarked notice */ })
            }
          }
        }
      } catch {
        // A disconnected, revoked, or malformed response must not leave a
        // stale owner notice visible, and never exposes transport internals.
        if (!disposed && generation.current === current) setNotices([])
      }
      if (!disposed && generation.current === current) timer = setTimeout(poll, 2_000)
    }
    void poll()
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer) }
  }, [ack, list, sessionId])
  return jsx('section', {
    'aria-label': '主动提醒',
    style: { margin: '0 auto 6px', width: 'calc(100% - 24px)', maxWidth: 'calc(var(--dsh-composer-card-max-width) - 24px)', color: 'var(--dsw-alias-label-primary-dimmed)', fontSize: 13 },
    children: notices.map((notice) => jsx('p', {
      style: { margin: '4px 0', whiteSpace: 'pre-wrap', cursor: 'pointer' },
      title: '点击确认（表示已查看提醒，不代表已阅读内容）',
      onClick: () => { void ack(sessionId, [notice.id], 'read').catch(() => { /* best-effort UI acknowledgement */ }) },
      children: notice.text,
    }, notice.id)),
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
      const ack = (sessionId: string, ids: readonly string[], status: NoticeAckStatus): Promise<unknown> =>
        runtime.remote.deliveryNotices.ack(sessionId, ids, status)
      return runtime.slots.inject('conversation.input.dock', () => runtime.slots.register({
        name: 'conversation.input.dock', id: 'delivery-notices', order: 5,
        inject: (sessionId: string) => ({ sessionId, list, ack }),
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
