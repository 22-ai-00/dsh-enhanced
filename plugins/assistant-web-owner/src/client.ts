import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { TYPERT_REMOTE } from './typert.js'

/** The Session client itself is supplied by the installed Host, not this bundle. */
export const inject = ['remote', 'slots']

type NoticeAttachment = Readonly<{
  kind: 'text'
  name: string
  mediaType: 'text/plain' | 'text/markdown'
  text: string
  sha256: string
}>
type Notice = Readonly<{
  id: string
  text: string
  createdAt: number
  status?: 'accepted' | 'delivered'
  attachment?: NoticeAttachment
}>
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

const MAX_INLINE_ATTACHMENT_CHARS = 16_384
const SAFE_ATTACHMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

function isTextAttachment(value: unknown): value is NoticeAttachment {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<NoticeAttachment>
  return candidate.kind === 'text'
    && typeof candidate.name === 'string'
    && (candidate.mediaType === 'text/plain' || candidate.mediaType === 'text/markdown')
    && typeof candidate.text === 'string' && candidate.text.length > 0
}

export function safeAttachmentName(name: string, mediaType: 'text/plain' | 'text/markdown'): string {
  return SAFE_ATTACHMENT_NAME.test(name) ? name : `notice-attachment.${mediaType === 'text/markdown' ? 'md' : 'txt'}`
}

export function boundedAttachmentPreview(text: string, maxChars = MAX_INLINE_ATTACHMENT_CHARS): Readonly<{ text: string, truncated: boolean }> {
  if (text.length <= maxChars) return { text, truncated: false }
  let end = Math.max(0, maxChars)
  if (end > 0) {
    const last = text.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
  }
  return { text: text.slice(0, end), truncated: true }
}

function attachmentMime(mediaType: 'text/plain' | 'text/markdown'): string {
  return mediaType === 'text/markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
}

export function downloadNoticeAttachment(attachment: NoticeAttachment): boolean {
  const scope = globalThis as unknown as {
    Blob?: new (parts: string[], options?: { type?: string }) => unknown
    URL?: { createObjectURL?: (blob: unknown) => string, revokeObjectURL?: (url: string) => void }
    document?: {
      createElement?: (tag: string) => {
        href?: string, download?: string, rel?: string, style?: { display?: string }, click?: () => void, remove?: () => void
      }
      body?: { appendChild?: (node: unknown) => void }
    }
  }
  const BlobCtor = scope.Blob
  const urlApi = scope.URL
  const doc = scope.document
  if (typeof BlobCtor !== 'function' || typeof urlApi?.createObjectURL !== 'function' || typeof doc?.createElement !== 'function') {
    return false
  }
  const mediaType = attachment.mediaType === 'text/markdown' ? 'text/markdown' : 'text/plain'
  const blob = new BlobCtor([attachment.text], { type: attachmentMime(mediaType) })
  const href = urlApi.createObjectURL(blob)
  const link = doc.createElement('a')
  link.href = href
  link.download = safeAttachmentName(attachment.name, mediaType)
  link.rel = 'noopener noreferrer'
  if (link.style !== undefined) link.style.display = 'none'
  try {
    doc.body?.appendChild?.(link)
    link.click?.()
    return true
  } finally {
    link.remove?.()
    setTimeout(() => urlApi.revokeObjectURL?.(href), 0)
  }
}

export function NoticeDock({ sessionId, list, ack }: Readonly<{
  sessionId: string
  list: (sessionId: string) => Promise<RemoteResult>
  ack: (sessionId: string, ids: readonly string[], status: NoticeAckStatus) => Promise<unknown>
}>) {
  const [notices, setNotices] = useState<readonly Notice[]>([])
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({})
  const generation = useRef(0)
  const delivered = useRef(new Set<string>())
  useEffect(() => {
    const current = ++generation.current
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setNotices([])
    setExpanded({})
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
    children: notices.map((notice) => {
      const attachment = isTextAttachment(notice.attachment) ? notice.attachment : undefined
      if (attachment === undefined) {
        return jsx('p', {
          style: { margin: '4px 0', whiteSpace: 'pre-wrap', cursor: 'pointer' },
          title: '点击确认（表示已查看提醒，不代表已阅读内容）',
          onClick: () => { void ack(sessionId, [notice.id], 'read').catch(() => { /* best-effort UI acknowledgement */ }) },
          children: notice.text,
        }, notice.id)
      }
      const fileName = safeAttachmentName(attachment.name, attachment.mediaType)
      const isOpen = expanded[notice.id] === true
      const preview = isOpen ? boundedAttachmentPreview(attachment.text) : undefined
      return jsx('div', {
        style: { margin: '4px 0' },
        children: [
          jsx('p', {
            style: { margin: 0, whiteSpace: 'pre-wrap', cursor: 'pointer' },
            title: '点击确认（表示已查看提醒，不代表已阅读内容）',
            onClick: () => { void ack(sessionId, [notice.id], 'read').catch(() => { /* best-effort UI acknowledgement */ }) },
            children: notice.text,
          }, 'summary'),
          jsx('div', {
            style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 },
            children: [
              jsx('button', {
                type: 'button',
                'aria-expanded': isOpen,
                style: { padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
                onClick: () => setExpanded(prev => ({ ...prev, [notice.id]: !prev[notice.id] })),
                children: `${isOpen ? '收起附件' : '查看附件'} ${fileName}`,
              }, 'toggle'),
              jsx('button', {
                type: 'button',
                style: { padding: '2px 8px', fontSize: 12, cursor: 'pointer' },
                onClick: () => { downloadNoticeAttachment(attachment) },
                children: `下载 ${fileName}`,
              }, 'download'),
            ],
          }, 'actions'),
          preview === undefined ? null : jsx('pre', {
            style: {
              margin: '6px 0 0',
              padding: '8px 10px',
              maxHeight: 240,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-primary, rgba(128, 128, 128, 0.25))',
              fontSize: 12,
            },
            children: preview.truncated ? `${preview.text}\n…（预览已截断，完整内容请下载附件）` : preview.text,
          }, 'preview'),
        ],
      }, notice.id)
    }),
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
