import { describe, expect, it, vi } from 'vitest'
import {
  boundedText, CHAT_SESSION_KEY, chatMessages, messageText, openDedicatedChatSession, permissionLabel,
  permissionOptions, permissionValue, remoteFailureSummary, requiresPermissionConfirmation, sendChatMessage,
  storedChatSession, streamingAssistantText,
  type ChatBinding, type ChatEntry, type ChatReference, type ChatSessions, type ChatUploads, type PermissionCatalog,
} from '../src/chat.ts'

const observable = <T>(initial: T) => {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T) => { value = next; for (const listener of listeners) listener() },
  }
}

const binding = (): ChatBinding => ({
  sessionId: 's1',
  session: {
    getSnapshot: () => ({}), subscribe: () => () => {},
    prompt: vi.fn(async () => ({ ok: true as const, value: { accepted: true } })),
    command: vi.fn(async () => ({ ok: true as const, value: { matched: true } })),
    cancel: vi.fn(async () => ({ ok: true as const, value: { accepted: true } })),
    loadOlder: vi.fn(async () => undefined),
    projections: { faceOf: () => observable(undefined) },
  },
  eventSource: observable({ entries: [] as readonly ChatEntry[] }),
})

function fakeSessions(bind: ChatBinding, ready: Promise<ChatBinding> = Promise.resolve(bind)) {
  const create = vi.fn(async () => 's1')
  const references: ChatReference[] = []
  const retain = vi.fn((_id: string, _options: Readonly<{ source: string }>) => {
    // Only the first acquisition sees the supplied readiness; a replacement after a stale
    // generation must be able to open normally.
    const reference: ChatReference = { binding: bind, ready: references.length === 0 ? ready : Promise.resolve(bind), release: vi.fn() }
    references.push(reference)
    return reference
  })
  return { sessions: { create, retain } as ChatSessions, create, retain, references }
}

const user = (seq: number, text: string): ChatEntry => ({ type: 'event', event: {
  type: 'user/message', seq, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } } })
const assistant = (seq: number, text: string): ChatEntry => ({ type: 'event', event: {
  type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } } })
const toolCall = (seq: number, callId: string, name: string): ChatEntry => ({ type: 'event', event: {
  type: 'tool/call', seq, data: { callId, name } } })
const toolResult = (seq: number, callId: string, isError = false): ChatEntry => ({ type: 'event', event: {
  type: 'tool/result', seq, data: { callId, message: { isError } } } })

describe('owner console chat transcript', () => {
  it('projects only human prompts and assistant text, plus compact tool and error rows', () => {
    const entries: ChatEntry[] = [
      user(1, '帮我整理一下'),
      { type: 'event', event: { type: 'user/message', seq: 2, data: { message: {
        source: { kind: 'plugin' }, content: [{ type: 'text', text: '注入的工作区上下文' }] } } } },
      assistant(3, '好的，我先看看。'),
      toolCall(4, 'call-1', 'fs_read'),
      toolResult(5, 'call-1'),
      toolCall(6, 'call-2', 'shell'),
      toolResult(7, 'call-2', true),
      { type: 'event', event: { type: 'turn/end', seq: 8, data: { reason: {
        kind: 'error', error: { code: 'provider/error', message: 'supplier failed' } } } } },
    ]
    const rows = chatMessages(entries)
    expect(rows.map(row => row.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'error'])
    expect(rows[0]).toMatchObject({ kind: 'user', text: '帮我整理一下' })
    expect(rows[1]).toMatchObject({ kind: 'assistant', text: '好的，我先看看。' })
    expect(rows[2]).toMatchObject({ kind: 'tool', name: 'fs_read', status: 'ok' })
    expect(rows[3]).toMatchObject({ kind: 'tool', name: 'shell', status: 'error' })
    expect(rows[4]).toMatchObject({ kind: 'error', text: 'provider/error：supplier failed' })
  })

  it('names attachments instead of inventing their content and bounds the transcript window', () => {
    expect(messageText({ content: [
      { type: 'text', text: '看这个' },
      { type: 'image' },
      { type: 'file', attachment: { name: 'notes.txt' } },
    ] })).toBe('看这个\n[图片]\n[文件：notes.txt]')
    const many = Array.from({ length: 260 }, (_value, index) => assistant(index + 1, `m${index}`))
    const rows = chatMessages(many)
    expect(rows).toHaveLength(200)
    expect(rows[0]).toMatchObject({ seq: 61 })
  })

  it('exposes the live text of the open assistant attempt only', () => {
    const entries: ChatEntry[] = [
      { type: 'transient', event: { seq: 9, data: { attemptId: 'a', chunk: { type: 'text-delta', text: '你' } } } },
      { type: 'transient', event: { seq: 10, data: { attemptId: 'a', chunk: { type: 'text-delta', text: '好' } } } },
      { type: 'transient', event: { seq: 11, data: { attemptId: 'a', chunk: { type: 'reasoning-delta', text: '想' } } } },
    ]
    expect(streamingAssistantText(entries)).toBe('你好')
    expect(streamingAssistantText(undefined)).toBe('')
  })
})

describe('owner console chat session handling', () => {
  it('creates and remembers a dedicated session when no usable one is stored', async () => {
    const bind = binding()
    const fake = fakeSessions(bind)
    const storage = { value: undefined as string | undefined,
      getItem: vi.fn(() => storage.value ?? null),
      setItem: vi.fn((_key: string, value: string) => { storage.value = value }),
      removeItem: vi.fn(() => { storage.value = undefined }) }
    const reference = await openDedicatedChatSession(fake.sessions, storage)
    expect(reference.binding).toBe(bind)
    expect(fake.create).toHaveBeenCalledOnce()
    expect(fake.retain).toHaveBeenCalledWith('s1', expect.objectContaining({ source: 'ownerConsoleChat' }))
    expect(storage.setItem).toHaveBeenCalledWith(CHAT_SESSION_KEY, 's1')
    expect(storedChatSession(storage)).toBe('s1')
  })

  it('reuses a stored session and replaces one whose generation no longer opens', async () => {
    const bind = binding()
    const good = fakeSessions(bind)
    const storage: { value: string | undefined, getItem: () => string | null,
      setItem: (_key: string, value: string) => void, removeItem: () => void } = {
      value: 'old',
      getItem: () => storage.value ?? null,
      setItem: (_key: string, value: string) => { storage.value = value },
      removeItem: () => { storage.value = undefined },
    }
    const reference = await openDedicatedChatSession(good.sessions, storage)
    expect(reference.binding).toBe(bind)
    expect(good.create).not.toHaveBeenCalled()
    expect(storage.value).toBe('old')

    let rejectReady: ((reason: Error) => void) | undefined
    const ready = new Promise<ChatBinding>((_resolve, reject) => { rejectReady = reject })
    const stale = fakeSessions(bind, ready)
    const opening = openDedicatedChatSession(stale.sessions, storage)
    rejectReady?.(new Error('unknown session'))
    const replaced = await opening
    expect(replaced.binding).toBe(bind)
    expect(stale.create).toHaveBeenCalledOnce()
    expect(stale.retain.mock.calls[0]?.[0]).toBe('old')
    expect(stale.retain.mock.calls[1]?.[0]).toBe('s1')
    expect(storage.value).toBe('s1')
  })
})

describe('owner console chat sending and permissions', () => {
  it('uploads staged attachments first and sends one real native prompt', async () => {
    const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true } }))
    const upload = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'r-file' } }))
    const uploadImage = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'r-image' } }))
    const uploads: ChatUploads = { upload, uploadImage }
    const outcome = await sendChatMessage({ sessionId: 's1', session: { prompt }, uploads, text: '看看附件',
      files: [new File(['a'], 'note.txt', { type: 'text/plain' }), new File(['b'], 'shot.png', { type: 'image/png' })] })
    expect(outcome).toEqual({ ok: true })
    expect(upload).toHaveBeenCalledWith('s1', expect.any(Blob), 'note.txt')
    expect(uploadImage).toHaveBeenCalledWith('s1', expect.any(Blob), 'image/png', 'shot.png')
    expect(prompt).toHaveBeenCalledWith([
      { type: 'text', text: '看看附件' },
      { type: 'file', receiptId: 'r-file' },
      { type: 'file', receiptId: 'r-image' },
    ], 'queue', undefined)
  })

  it('never reports sent when the upload or prompt is refused', async () => {
    const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true } }))
    const refusedUpload: ChatUploads = { upload: vi.fn(async () => ({ ok: false as const, error: { code: 'QUOTA', message: 'full' } })) }
    const uploadOutcome = await sendChatMessage({ sessionId: 's1', session: { prompt }, uploads: refusedUpload, text: 'x',
      files: [new File(['a'], 'a.txt')] })
    expect(uploadOutcome).toMatchObject({ ok: false, error: expect.stringContaining('QUOTA：full') })
    expect(prompt).not.toHaveBeenCalled()

    const missing: ChatUploads | undefined = undefined
    expect(await sendChatMessage({ sessionId: 's1', session: { prompt }, uploads: missing, text: 'x',
      files: [new File(['a'], 'a.txt')] })).toMatchObject({ ok: false, error: expect.stringContaining('fileUpload 未加载') })

    const refusedPrompt = vi.fn(async () => ({ ok: false as const, error: { code: 'EMPTY', message: 'no input' } }))
    expect(await sendChatMessage({ sessionId: 's1', session: { prompt: refusedPrompt }, text: 'x' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('EMPTY：no input') })
    expect(await sendChatMessage({ sessionId: 's1', session: { prompt }, text: '   ' }))
      .toMatchObject({ ok: false, error: '消息不能为空。' })
  })

  it('reads and labels the session permission without inventing a value', () => {
    const catalog: PermissionCatalog = { defaultPreset: 'workspace-write', options: [
      { value: 'read-only', name: 'Read only' },
      { value: 'workspace-write', name: 'Workspace write' },
      { value: 'danger-full-access', name: 'Full access' },
      { value: 'custom', name: 'Custom' },
    ] }
    expect(permissionValue({ currentValue: 'read-only' })).toBe('read-only')
    expect(permissionValue({ currentValue: '' })).toBeUndefined()
    expect(permissionValue(null)).toBeUndefined()
    expect(permissionLabel('workspace-write', catalog)).toBe('工作区写入')
    expect(permissionLabel('danger-full-access')).toBe('完全访问')
    expect(permissionLabel('unconfigured', catalog)).toBe('unconfigured')
    expect(permissionLabel(undefined)).toBe('权限不可用')
    expect(permissionOptions(catalog, 'custom').map(option => option.value))
      .toEqual(['read-only', 'workspace-write', 'danger-full-access', 'custom'])
    expect(permissionOptions({ options: [] }, 'custom')).toEqual([{ value: 'custom', name: '自定义' }])
    expect(requiresPermissionConfirmation('danger-full-access')).toBe(true)
    expect(requiresPermissionConfirmation('auto')).toBe(true)
    expect(requiresPermissionConfirmation('read-only')).toBe(false)
  })

  it('bounds Host text and keeps unknown failures explicit', () => {
    expect(boundedText('a\n b\t c', 10)).toBe('a b c')
    expect(boundedText('abcdefghijk', 4)).toBe('abcd…')
    expect(remoteFailureSummary({ code: 'code', message: 'why' })).toBe('code：why')
    expect(remoteFailureSummary(undefined)).toContain('未说明')
  })
})
