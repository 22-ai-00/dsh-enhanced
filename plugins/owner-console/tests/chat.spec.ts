import { describe, expect, it, vi } from 'vitest'
import {
  boundedText, CHAT_SESSION_KEY, chatMessages, messageText, modelSelectionFromProjection, openDedicatedChatSession,
  pendingUserMessages, permissionLabel, permissionOptions, permissionValue, remoteFailureSummary,
  requiresPermissionConfirmation, sendChatMessage, storedChatSession, streamingAssistantText,
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
  const retain = vi.fn((_id: string, _options: Readonly<{ source: string; signal?: AbortSignal }>) => {
    // Only the first acquisition sees the supplied readiness; a replacement after a stale
    // generation must be able to open normally.
    const reference: ChatReference = { sessionId: _id, binding: bind,
      ready: references.length === 0 ? ready : Promise.resolve(bind), release: vi.fn() }
    references.push(reference)
    return reference
  })
  return { sessions: { create, retain } as ChatSessions, create, retain, references }
}

/** Real DSH `user/message` wire shape: `event.data` IS `UserMessage` directly (no `data.message` wrapper). */
const user = (seq: number, text: string, extra: Readonly<{ id?: string; rpcId?: string }> = {}): ChatEntry => ({
  type: 'event',
  event: {
    type: 'user/message',
    seq,
    surfaceOp: 'append',
    data: {
      id: extra.id ?? `msg-user-${seq}`,
      role: 'user',
      source: { kind: 'user', ...(extra.rpcId === undefined ? {} : { rpcId: extra.rpcId }) },
      content: [{ type: 'text', text }],
    },
  },
})
const assistant = (seq: number, text: string, turn = 1, step = 1): ChatEntry => ({
  type: 'event',
  event: {
    type: 'assistant/message',
    seq,
    surfaceOp: 'append',
    data: { turn, step, message: { id: `msg-asst-${seq}`, role: 'assistant', content: [{ type: 'text', text }] } },
  },
})
const toolCall = (seq: number, callId: string, name: string): ChatEntry => ({ type: 'event', event: {
  type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: '{}' } } })
/** Real `tool/result` data: no top-level call id; identity rides on the tool-role message. */
const toolResult = (seq: number, callId: string, isError = false): ChatEntry => ({ type: 'event', event: {
  type: 'tool/result', seq, surfaceOp: 'append', data: { turn: 1, step: 1, message: {
    role: 'tool', content: [{ type: 'text', text: 'done' }],
    source: { kind: 'tool', callId }, toolCallId: callId, isError } } } })

describe('owner console chat transcript', () => {
  it('projects only append-origin human prompts and assistant text, plus compact tool and error rows', () => {
    const entries: ChatEntry[] = [
      user(1, '帮我整理一下', { rpcId: 'req-1' }),
      // Injected runtime/plugin contexts share `user/message` with `event.data` = UserMessage, distinguished by `source.kind`.
      { type: 'event', event: { type: 'user/message', seq: 2, surfaceOp: 'append', data: {
        id: 'msg-ctx-2', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入的工作区上下文' }] } } },
      { type: 'event', event: { type: 'user/message', seq: 3, surfaceOp: 'append', data: {
        id: 'msg-mem-3', role: 'user', source: { kind: 'personal-memory' }, content: [{ type: 'text', text: '注入的长期记忆' }] } } },
      // Compaction / surface replacement copies stay model-only even if their event type is user/message or tool/result.
      { type: 'event', event: { type: 'user/message', seq: 4, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, data: {
        id: 'msg-compact-4', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '摘要检查点' }] } } },
      assistant(5, '好的，我先看看。'),
      toolCall(6, 'call-1', 'fs_read'),
      toolResult(7, 'call-1'),
      // Pruned tool/result replacement copy must not alter settled tool rows or add a duplicate tool row.
      { type: 'event', event: { type: 'tool/result', seq: 8, surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 }, data: {
        turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: true } } } },
      toolCall(9, 'call-2', 'shell'),
      toolResult(10, 'call-2', true),
      { type: 'event', event: { type: 'turn/end', seq: 11, data: { reason: {
        kind: 'error', error: { code: 'provider/error', message: 'supplier failed' } } } } },
    ]
    const rows = chatMessages(entries)
    expect(rows.map(row => row.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'error'])
    expect(rows.filter(row => row.kind === 'tool')).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'user', text: '帮我整理一下' })
    expect(rows[1]).toMatchObject({ kind: 'assistant', text: '好的，我先看看。' })
    // Each result settles the preceding call row rather than appending a new tool row.
    expect(rows[2]).toMatchObject({ kind: 'tool', name: 'fs_read', status: 'ok' })
    expect(rows[3]).toMatchObject({ kind: 'tool', name: 'shell', status: 'error' })
    expect(rows[4]).toMatchObject({ kind: 'error', text: 'provider/error：supplier failed' })
  })

  it('retains human attachment-only user prompts and suppresses assistant replacement copies', () => {
    const entries: ChatEntry[] = [
      { type: 'event', event: { type: 'user/message', seq: 1, surfaceOp: 'append', data: {
        id: 'msg-img-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'image' }, { type: 'file', attachment: { name: 'spec.md' } }] } } },
      { type: 'event', event: { type: 'assistant/message', seq: 2, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: {
        turn: 1, step: 1, message: { content: [{ type: 'text', text: '模型替换副本' }] } } } },
      assistant(3, '我看到了图片和 spec.md。'),
    ]
    const rows = chatMessages(entries)
    expect(rows).toEqual([
      { kind: 'user', key: 'user:1', seq: 1, text: '[图片]\n[文件：spec.md]' },
      { kind: 'assistant', key: 'assistant:3', seq: 3, text: '我看到了图片和 spec.md。' },
    ])
  })

  it('pairs a tool result through message.toolCallId and keeps an unpaired result explicit', () => {
    const rows = chatMessages([
      toolCall(1, 'call-1', 'fs_read'),
      { type: 'event', event: { type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: {
        role: 'tool', source: { kind: 'tool' }, toolCallId: 'call-1', isError: false } } } },
      { type: 'event', event: { type: 'tool/result', seq: 3, data: { turn: 1, step: 1, message: {
        role: 'tool', source: { kind: 'tool', callId: 'call-lost' }, isError: true } } } },
    ])
    expect(rows[0]).toMatchObject({ kind: 'tool', name: 'fs_read', status: 'ok' })
    expect(rows[1]).toMatchObject({ kind: 'tool', name: 'tool', status: 'error' })
  })

  it('names attachments instead of inventing their content and bounds the transcript window', () => {
    expect(messageText({ content: [
      { type: 'text', text: '看这个' },
      { type: 'image' },
      { type: 'file', attachment: { name: 'notes.txt' } },
      { type: 'file', attachment: { name: '   ' } },
    ] })).toBe('看这个\n[图片]\n[文件：notes.txt]\n[文件]')
    const many = Array.from({ length: 260 }, (_value, index) => assistant(index + 1, `m${index}`))
    const rows = chatMessages(many)
    expect(rows).toHaveLength(200)
    expect(rows[0]).toMatchObject({ seq: 61 })
  })

  it('exposes the live text of the open assistant attempt only and suppresses chunks once that step settles durably', () => {
    const entries: ChatEntry[] = [
      { type: 'transient', event: { seq: 9, data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', text: '你' } } } },
      { type: 'transient', event: { seq: 10, data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'text-delta', text: '好' } } } },
      { type: 'transient', event: { seq: 11, data: { attemptId: 'a', turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: '想' } } } },
    ]
    expect(streamingAssistantText(entries)).toBe('你好')
    // Once durable assistant/message for (turn: 1, step: 1) publishes (even before step/end retires transient rows),
    // streamingAssistantText stops duplicating it.
    expect(streamingAssistantText([...entries, assistant(12, '你好', 1, 1)])).toBe('')
    // A subsequent step (turn: 1, step: 2) still streams normally.
    expect(streamingAssistantText([
      ...entries,
      assistant(12, '你好', 1, 1),
      { type: 'transient', event: { seq: 13, data: { attemptId: 'b', turn: 1, step: 2, chunk: { type: 'text-delta', text: '继续' } } } },
    ])).toBe('继续')
    expect(streamingAssistantText(undefined)).toBe('')
  })

  it('reconciles pendingSubmissions and Host inbox without duplicating admitted durable user messages', () => {
    // 1. Idle send accepted: echo stays in transcript and suppresses duplicate inbox item with same rpcId.
    const idlePending = pendingUserMessages(
      [],
      [{
        requestId: 'req-1',
        placement: 'transcript',
        text: '介绍一下你自己',
        attachments: [{ type: 'image', value: { previewUrl: '' } }, { type: 'file', value: { attachmentId: '', name: 'a.txt', bytes: 1 } }],
      }],
      {
        'next-step': [],
        'next-turn': [
          { id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'req-1' }, content: [{ type: 'text', text: '介绍一下你自己' }] },
          { id: 'm-goal', role: 'user', source: { kind: 'goal' }, content: [{ type: 'text', text: '不应展示的后台目标' }] },
        ],
      },
      true,
    )
    expect(idlePending).toEqual({
      transcript: [{ key: 'pending:req-1', text: '介绍一下你自己\n[图片]\n[文件：a.txt]', queued: false }],
      queued: [],
    })

    // 2. Durable user/message arrives with same rpcId: both pendingSubmission and stale inbox row disappear immediately.
    const admitted = pendingUserMessages(
      [user(1, '介绍一下你自己', { id: 'm1', rpcId: 'req-1' })],
      [{ requestId: 'req-1', placement: 'transcript', text: '介绍一下你自己' }],
      { 'next-step': [], 'next-turn': [{ id: 'm1', role: 'user', source: { kind: 'user', rpcId: 'req-1' }, content: [{ type: 'text', text: '介绍一下你自己' }] }] },
      true,
    )
    expect(admitted).toEqual({ transcript: [], queued: [] })

    // 3. Queued follow-up while running: deduplicated across inbox and pendingSubmissions, ordered next-step before next-turn.
    const queuedWhileRunning = pendingUserMessages(
      [user(1, '第一问', { id: 'm1', rpcId: 'req-1' })],
      [
        { requestId: 'req-2', placement: 'queued', text: '第二问' },
        { requestId: 'req-3', placement: 'queued', text: '第三问' },
      ],
      {
        'next-step': [{ id: 'm-steer', role: 'user', source: { kind: 'user', rpcId: 'req-steer' }, content: [{ type: 'text', text: '插队补充' }] }],
        'next-turn': [{ id: 'm2', role: 'user', source: { kind: 'user', rpcId: 'req-2' }, content: [{ type: 'text', text: '第二问' }] }],
      },
      true,
    )
    expect(queuedWhileRunning).toEqual({
      transcript: [],
      queued: [
        { key: 'inbox:m-steer', text: '插队补充', queued: true },
        { key: 'inbox:m2', text: '第二问', queued: true },
        { key: 'pending:req-3', text: '第三问', queued: true },
      ],
    })

    // 4. Once running flips false, an un-reflected queued local echo renders in transcript rather than 排队中.
    expect(pendingUserMessages(
      [],
      [{ requestId: 'req-idle', placement: 'queued', text: '刚刚排队的问题' }],
      { 'next-step': [], 'next-turn': [] },
      false,
    )).toEqual({
      transcript: [{ key: 'pending:req-idle', text: '刚刚排队的问题', queued: false }],
      queued: [],
    })
  })

  it('keeps claimed inbox prompts visible during preStep/prepareRequest and reconciles edits, steers, cancels, and expiry', () => {
    const spliced = (
      seq: number,
      data: Readonly<{
        target: 'next-turn' | 'next-step'
        start: number
        removedCount?: number
        inserted: readonly Readonly<{ id: string; role: 'user'; source: Readonly<{ kind: string; rpcId?: string }>; content: readonly Readonly<{ type: 'text'; text: string }>[] }>[]
        outcome?: string
      }>,
    ): ChatEntry => ({ type: 'event', event: { type: 'agent/inbox/spliced', seq, data } })

    const q2 = { id: 'm2', role: 'user' as const, source: { kind: 'user', rpcId: 'req-2' }, content: [{ type: 'text' as const, text: '第二问' }] }
    const q2Edited = { id: 'm2', role: 'user' as const, source: { kind: 'user', rpcId: 'req-2' }, content: [{ type: 'text' as const, text: '第二问（已编辑）' }] }
    const q3 = { id: 'm3', role: 'user' as const, source: { kind: 'user', rpcId: 'req-3' }, content: [{ type: 'text' as const, text: '第三问' }] }

    // 1. Queued follow-up edited, then claimed by Turn 2 after ClientSession already retired its local echo
    //    and inbox projection emptied; compaction replacement during preStep must NOT expire it.
    const claimedEntries: ChatEntry[] = [
      user(1, '第一问', { id: 'm1', rpcId: 'req-1' }),
      spliced(2, { target: 'next-turn', start: 0, inserted: [q2] }),
      spliced(3, { target: 'next-turn', start: 1, inserted: [q3] }),
      spliced(4, { target: 'next-turn', start: 0, removedCount: 1, inserted: [q2Edited], outcome: 'canceled' }),
      assistant(5, '第一答', 1, 1),
      { type: 'event', event: { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } } },
      { type: 'event', event: { type: 'turn/start', seq: 7, data: { turn: 2 } } },
      spliced(8, { target: 'next-turn', start: 0, removedCount: 1, inserted: [] }),
      // Compaction replacement copy during preStep must not prematurely drop the claimed prompt.
      { type: 'event', event: { type: 'assistant/message', seq: 9, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 5 }, data: {
        turn: 1, step: 1, message: { content: [{ type: 'text', text: '摘要替换' }] } } } },
    ]
    expect(pendingUserMessages(
      claimedEntries,
      [],
      { 'next-step': [], 'next-turn': [q2Edited, q3] }, // even if inbox projection momentarily lags behind claim!
      true,
    )).toEqual({
      transcript: [{ key: 'claimed:m2', text: '第二问（已编辑）', queued: false }],
      queued: [{ key: 'inbox:m3', text: '第三问', queued: true }],
    })

    // 2. Claimed prompt expires once durable user/message arrives (zero duplication).
    expect(pendingUserMessages(
      [...claimedEntries, user(10, '第二问（已编辑）', { id: 'm2', rpcId: 'req-2' })],
      [],
      { 'next-step': [], 'next-turn': [q3] },
      true,
    )).toEqual({
      transcript: [],
      queued: [{ key: 'inbox:m3', text: '第三问', queued: true }],
    })

    // 3. Claimed prompt expires if turn closes / moves past admission without emitting user/message (e.g. rejected in preStep).
    expect(pendingUserMessages(
      [...claimedEntries, { type: 'event', event: { type: 'turn/end', seq: 10, data: { turn: 2, reason: { kind: 'blocked' } } } }],
      [],
      { 'next-step': [], 'next-turn': [] },
      false,
    )).toEqual({ transcript: [], queued: [] })

    // 4. Removed queue item suppresses stale inbox copy in same target, while a steer (remove next-turn -> insert next-step)
    //    never suppresses a fresh next-step inbox entry even if follow stream lags behind control stream.
    const removedFromNextTurn: ChatEntry[] = [
      spliced(1, { target: 'next-turn', start: 0, inserted: [q2] }),
      spliced(2, { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' }),
    ]
    expect(pendingUserMessages(
      removedFromNextTurn,
      [{ requestId: 'req-2', placement: 'queued', text: '第二问' }],
      { 'next-step': [], 'next-turn': [q2] },
      true,
    )).toEqual({ transcript: [], queued: [] })

    expect(pendingUserMessages(
      removedFromNextTurn,
      [],
      { 'next-step': [q2], 'next-turn': [] },
      true,
    )).toEqual({
      transcript: [],
      queued: [{ key: 'inbox:m2', text: '第二问', queued: true }],
    })
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

  it('cancels a hung open, releases its reference, and keeps the stored session id', async () => {
    const bind = binding()
    const controller = new AbortController()
    const release = vi.fn()
    const retain = vi.fn((_id: string, options: Readonly<{ source: string; signal?: AbortSignal }>) => {
      // The real retain waiter rejects its `ready` when the acquisition signal aborts.
      const ready = new Promise<ChatBinding>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason))
      })
      return { sessionId: _id, binding: bind, ready, release } as ChatReference
    })
    const create = vi.fn(async () => 's1')
    const storage = (() => {
      let value: string | undefined = 'old'
      return { getItem: () => value ?? null, setItem: (_key: string, next: string) => { value = next },
        removeItem: () => { value = undefined }, value: () => value }
    })()
    const opening = openDedicatedChatSession({ create, retain }, storage, undefined, undefined, controller.signal)
    controller.abort(new Error('unmounted'))
    await expect(opening).rejects.toThrow('unmounted')
    expect(retain).toHaveBeenCalledWith('old', expect.objectContaining({ signal: controller.signal }))
    expect(release).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
    expect(storage.value()).toBe('old')
  })

  it('replaces a stored session whose ready resolves with a failed open state', async () => {
    const bind = binding()
    const broken: ChatBinding = {
      ...bind,
      session: { ...bind.session, getSnapshot: () => ({ openState: 'error', removed: false }) },
    }
    const good = fakeSessions(bind)
    // The stored generation opens (ready resolves) but its history is in the error state.
    const retain = vi.fn((_id: string, _options: Readonly<{ source: string; signal?: AbortSignal }>) => {
      const reference: ChatReference = { sessionId: _id, binding: retain.mock.calls.length === 1 ? broken : bind,
        ready: Promise.resolve(retain.mock.calls.length === 1 ? broken : bind), release: vi.fn() }
      return reference
    })
    const sessions: ChatSessions = { create: good.create, retain }
    const storage = (() => {
      let value: string | undefined = 'old'
      return { getItem: () => value ?? null, setItem: (_key: string, next: string) => { value = next },
        removeItem: () => { value = undefined }, value: () => value }
    })()
    const reference = await openDedicatedChatSession(sessions, storage)
    expect(reference.binding).toBe(bind)
    expect(retain.mock.calls.map(call => call[0])).toEqual(['old', 's1'])
    expect(storage.value()).toBe('s1')
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

  it('registers a native submission echo when beginSubmission is available and abandons it on failure', async () => {
    const abandonOk = vi.fn()
    const beginSubmission = vi.fn(() => ({ requestId: 'req-echo-1', abandon: abandonOk }))
    const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true } }))
    const upload = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'r-file' } }))
    const uploadImage = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'r-image' } }))
    const outcome = await sendChatMessage({
      sessionId: 's1',
      session: { beginSubmission, prompt },
      uploads: { upload, uploadImage },
      text: '帮我看一下',
      files: [new File(['a'], 'doc.txt', { type: 'text/plain' }), new File(['b'], 'pic.png', { type: 'image/png' })],
    })
    expect(outcome).toEqual({ ok: true })
    expect(beginSubmission).toHaveBeenCalledExactlyOnceWith({
      mode: 'queue',
      text: '帮我看一下',
      attachments: [
        { type: 'file', value: { attachmentId: '', name: 'doc.txt', bytes: 1 } },
        { type: 'image', value: { previewUrl: '', name: 'pic.png' } },
      ],
    })
    expect(prompt).toHaveBeenCalledExactlyOnceWith([
      { type: 'text', text: '帮我看一下' },
      { type: 'file', receiptId: 'r-file' },
      { type: 'file', receiptId: 'r-image' },
    ], 'queue', undefined, 'req-echo-1')
    expect(abandonOk).not.toHaveBeenCalled()

    // Prompt refusal abandons the registered submission echo.
    const abandonRefused = vi.fn()
    const refused = await sendChatMessage({
      sessionId: 's1',
      session: {
        beginSubmission: () => ({ requestId: 'req-refused', abandon: abandonRefused }),
        prompt: vi.fn(async () => ({ ok: false as const, error: { code: 'BUSY', message: 'busy' } })),
      },
      text: '重试',
    })
    expect(refused).toMatchObject({ ok: false })
    expect(abandonRefused).toHaveBeenCalledOnce()

    // Upload failure aborts before beginSubmission is ever called.
    const beginNever = vi.fn()
    const uploadFail = await sendChatMessage({
      sessionId: 's1',
      session: { beginSubmission: beginNever, prompt },
      uploads: { upload: vi.fn(async () => ({ ok: false as const, error: { code: 'ERR', message: 'nope' } })) },
      text: '带文件',
      files: [new File(['x'], 'x.txt')],
    })
    expect(uploadFail).toMatchObject({ ok: false })
    expect(beginNever).not.toHaveBeenCalled()
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

  it('reads modelSelectionFromProjection preferring DSH 0.2.2 next over pending and lastUsed', () => {
    expect(modelSelectionFromProjection({
      lastUsed: { provider: 'llmgw', model: 'old-model', reasoningEffort: 'low' },
      next: { provider: 'agy-agent', model: 'claude-sonnet-5-5', reasoningEffort: 'high' },
    })).toEqual({ provider: 'agy-agent', model: 'claude-sonnet-5-5', reasoningEffort: 'high' })

    expect(modelSelectionFromProjection({
      lastUsed: null,
      next: { provider: ' traex-agent ', model: ' default ' },
    })).toEqual({ provider: 'traex-agent', model: 'default' })

    expect(modelSelectionFromProjection({
      pending: { provider: 'llmgw', model: 'seed-2.0-pro', reasoningEffort: 'medium' },
      lastUsed: { provider: 'llmgw', model: 'old-model' },
    })).toEqual({ provider: 'llmgw', model: 'seed-2.0-pro', reasoningEffort: 'medium' })

    expect(modelSelectionFromProjection({
      next: null,
      pending: null,
      lastUsed: { provider: 'llmgw', model: 'deepseek-v4', reasoningEffort: '   ' },
    })).toEqual({ provider: 'llmgw', model: 'deepseek-v4' })

    expect(modelSelectionFromProjection(null)).toBeUndefined()
    expect(modelSelectionFromProjection({ next: { provider: '', model: 'm' } })).toBeUndefined()
  })
})
