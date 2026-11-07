// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnerConsoleChat, OwnerConsoleConversation } from '../src/chat-view.ts'
import { OwnerConsolePanel } from '../src/client.ts'
import type {
  ChatBinding, ChatEntry, ChatEventWindow, ChatRuntime, ChatSessionFace, ChatSessionSnapshot, ChatUploads,
  PermissionCatalog, SpeechRecognitionEventLike, SpeechRecognitionLike,
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

const CATALOG: PermissionCatalog = {
  defaultPreset: 'workspace-write',
  options: [
    { value: 'read-only', name: 'Read only' },
    { value: 'workspace-write', name: 'Workspace write' },
    { value: 'danger-full-access', name: 'Full access' },
  ],
}

const user = (seq: number, text: string): ChatEntry => ({ type: 'event', event: {
  type: 'user/message', seq, data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text }] } } } })
const assistant = (seq: number, text: string): ChatEntry => ({ type: 'event', event: {
  type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } } })

interface Harness {
  readonly runtime: ChatRuntime
  readonly binding: ChatBinding
  readonly prompt: ReturnType<typeof vi.fn>
  readonly command: ReturnType<typeof vi.fn>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly upload: ReturnType<typeof vi.fn>
  readonly uploadImage: ReturnType<typeof vi.fn>
  readonly release: ReturnType<typeof vi.fn>
  readonly create: ReturnType<typeof vi.fn>
  readonly recognition: SpeechRecognitionLike & { start: ReturnType<typeof vi.fn>, stop: ReturnType<typeof vi.fn> }
  setEntries(entries: readonly ChatEntry[]): void
  setSnapshot(snapshot: ChatSessionSnapshot): void
  setPermission(value: unknown): void
}

function harness(overrides: Partial<ChatRuntime> = {}, entries: readonly ChatEntry[] = []): Harness {
  const snapshot = observable<ChatSessionSnapshot>({ openState: 'open', running: false })
  const events = observable<ChatEventWindow>({ entries, hasMore: false })
  const permission = observable<unknown>({ currentValue: 'workspace-write' })
  const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true } }))
  const command = vi.fn(async () => ({ ok: true as const, value: { matched: true } }))
  const cancel = vi.fn(async () => ({ ok: true as const, value: { accepted: true } }))
  const upload = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'r-file' } }))
  const uploadImage = vi.fn(async () => ({ ok: true as const, value: { receiptId: 'r-image' } }))
  const release = vi.fn()
  const create = vi.fn(async () => 's1')
  const recognition = {
    lang: '', interimResults: false, continuous: false, start: vi.fn(), stop: vi.fn(),
    onresult: null as ((event: SpeechRecognitionEventLike) => void) | null,
    onerror: null as ((event: { error?: string }) => void) | null,
    onend: null as (() => void) | null,
  }
  const session: ChatSessionFace = {
    getSnapshot: snapshot.getSnapshot,
    subscribe: snapshot.subscribe,
    prompt,
    command,
    cancel,
    loadOlder: vi.fn(async () => undefined),
    projections: { faceOf: key => key === 'permissions' ? permission : observable(undefined) },
  }
  const binding: ChatBinding = { sessionId: 's1', session, eventSource: events }
  const storage = { value: undefined as string | undefined,
    getItem: () => storage.value ?? null,
    setItem: (_key: string, value: string) => { storage.value = value },
    removeItem: () => { storage.value = undefined } }
  const uploads: ChatUploads = { upload, uploadImage }
  const runtime: ChatRuntime = {
    sessions: () => ({ create, retain: vi.fn(() => ({ sessionId: 's1', binding, ready: Promise.resolve(binding), release })) }),
    fileUploads: () => uploads,
    permissionCatalog: () => Promise.resolve({ ok: true, value: CATALOG }),
    openNativeSession: vi.fn(() => true),
    startConversation: vi.fn(),
    storage: () => storage,
    voiceAvailable: () => false,
    createRecognition: () => undefined,
    recognitionLang: () => 'zh-CN',
    speakAvailable: () => false,
    speak: () => false,
    ...overrides,
  }
  return { runtime, binding, prompt, command, cancel, upload, uploadImage, release, create, recognition,
    setEntries: entries => events.set({ entries, hasMore: false }), setSnapshot: snapshot.set, setPermission: permission.set }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

async function render(element: ReturnType<typeof createElement>) {
  await act(async () => { root.render(element) })
  await settle()
}

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`)

async function fillMessage(value: string) {
  const textarea = container.querySelector('textarea[aria-label="给文鳐的消息"]') as HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  await act(async () => { textarea.dispatchEvent(new Event('input', { bubbles: true })) })
}

async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).click() })
  await settle()
}

describe('文鳐 chat window rendering', () => {
  it('renders the real session transcript and sends typed text through SessionFace.prompt', async () => {
    const fake = harness({}, [user(1, '帮我看看这个错误'), assistant(2, '看起来是依赖没有安装。')])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    expect(container.querySelector('[data-owner-console-chat]')).not.toBeNull()
    expect(container.textContent).toContain('帮我看看这个错误')
    expect(container.textContent).toContain('看起来是依赖没有安装。')
    expect(container.textContent).toContain('文鳐 Ray')

    await fillMessage('继续')
    await click(byLabel('发送消息'))
    expect(fake.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: '继续' }], 'queue', undefined)
    const textarea = container.querySelector('textarea[aria-label="给文鳐的消息"]') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
  })

  it('uploads selected attachments and cites their receipts in the prompt', async () => {
    const fake = harness({}, [])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('note.txt')

    await fillMessage('看附件')
    await click(byLabel('发送消息'))
    expect(fake.upload).toHaveBeenCalledWith('s1', file, 'note.txt')
    expect(fake.prompt).toHaveBeenCalledWith([
      { type: 'text', text: '看附件' },
      { type: 'file', receiptId: 'r-file' },
    ], 'queue', undefined)
    expect(container.textContent).not.toContain('note.txt')
  })

  it('reports an unavailable upload service instead of pretending the attachment was staged', async () => {
    const fake = harness({ fileUploads: () => undefined })
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['x'], 'x.txt')] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('fileUpload 未加载')
    expect(container.textContent).not.toContain('x.txt')
    await fillMessage('只发文字')
    await click(byLabel('发送消息'))
    expect(fake.prompt).toHaveBeenCalledWith([{ type: 'text', text: '只发文字' }], 'queue', undefined)
  })

  it('renders a disabled 语音对话 button with a browser-capability tooltip when SpeechRecognition is absent', async () => {
    const fake = harness()
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    const voice = byLabel('语音对话（当前浏览器不支持）') as HTMLButtonElement
    expect(voice.disabled).toBe(true)
    expect(String(voice.title)).toContain('SpeechRecognition')
    expect(container.textContent).toContain('不是 DSH 模型功能')
  })

  it('starts browser speech recognition and appends its final transcript when available', async () => {
    let fake: Harness
    fake = harness({ voiceAvailable: () => true, createRecognition: () => fake.recognition })
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    await click(byLabel('语音对话'))
    expect(fake.recognition.start).toHaveBeenCalledOnce()
    expect(byLabel('停止语音对话')).not.toBeNull()
    await act(async () => {
      fake.recognition.onresult?.({
        resultIndex: 0,
        results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: '你好文鳐' } } },
      })
    })
    const textarea = container.querySelector('textarea[aria-label="给文鳐的消息"]') as HTMLTextAreaElement
    expect(textarea.value).toBe('你好文鳐')
    await click(byLabel('停止语音对话'))
    expect(fake.recognition.stop).toHaveBeenCalledOnce()
  })

  it('shows the current permission and switches only through the native /permission command', async () => {
    const fake = harness()
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    expect(container.textContent).toContain('工作区写入')
    const select = byLabel('切换权限预设') as HTMLSelectElement
    select.value = 'read-only'
    await act(async () => { select.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
    expect(fake.command).toHaveBeenCalledWith('/permission read-only')

    const selectAgain = byLabel('切换权限预设') as HTMLSelectElement
    selectAgain.value = 'danger-full-access'
    await act(async () => { selectAgain.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.textContent).toContain('会扩大文鳐的权限')
    expect(fake.command).toHaveBeenCalledTimes(1)
    await click(container.querySelector('[role="alertdialog"] button') as HTMLButtonElement)
    expect(fake.command).toHaveBeenLastCalledWith('/permission danger-full-access')
  })

  it('projects a native permission change from the session projection rather than local state', async () => {
    const fake = harness()
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    await act(async () => { fake.setPermission({ currentValue: 'danger-full-access' }) })
    expect(container.textContent).toContain('完全访问')
  })

  it('reports missing session services and delegates to the native conversation instead of faking a session', async () => {
    const startConversation = vi.fn()
    const fake = harness({ sessions: () => undefined, startConversation })
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    expect(container.textContent).toContain('sessions 未加载')
    await click(Array.from(container.querySelectorAll('button')).find(button => button.textContent === '进入原生会话') ?? null)
    expect(startConversation).toHaveBeenCalledOnce()
  })
})

describe('文鳐 settings entry', () => {
  it('opens the configuration console from the gear and returns to chat', async () => {
    const fake = harness()
    const status = {
      feishu: { mode: 'env', installed: true, entry: 'dsh-enhanced-lark-channel', connection: 'connected', appIdConfigured: false },
      traex: { installed: false, enabled: false, command: '' },
      host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
      dependencies: [],
      evaluation: { intakeAgreement: 'disabled' },
      bundles: [],
      plugins: [],
    }
    const remote = {
      status: vi.fn(async () => ({ ok: true as const, value: status })),
      trendSnapshots: vi.fn(async () => ({ ok: true as const, value: { state: 'absent', causal: false, items: [] } })),
      intakeAgreement: vi.fn(),
    }
    const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
    await render(createElement(OwnerConsolePanel, { remote: remote as never, navigation, runtime: fake.runtime }))
    expect(container.querySelector('[data-owner-console-chat]')).not.toBeNull()
    await click(byLabel('打开设置'))
    expect(container.querySelector('[data-owner-console-settings]')).not.toBeNull()
    expect(container.querySelector('[data-owner-console-chat]')).toBeNull()
    expect(container.textContent).toContain('远程接入（飞书）')
    expect(container.textContent).toContain('TraeX')
    expect(container.textContent).toContain('本项目插件管理')
    expect(container.textContent).toContain('趋势快照（只读）')
    expect(container.textContent).toContain('intake 吻合度（只读）')
    await click(byLabel('返回对话'))
    expect(container.querySelector('[data-owner-console-chat]')).not.toBeNull()
    expect(container.querySelector('[data-owner-console-settings]')).toBeNull()
  })
})

describe('文鳐 native Conversation embedding', () => {
  it('uses the renderer-injected SessionProvider and child slot instead of the fallback transcript', async () => {
    const fake = harness()
    const SessionProvider = vi.fn((props: { session?: unknown, children?: unknown }) => props.children)
    const renderSlot = vi.fn(() => createElement('div', { 'data-native-conversation-slot': '' }, 'native conversation'))
    const runtime = { ...fake.runtime }
    await render(createElement(OwnerConsoleChat, {
      runtime,
      onOpenSettings: vi.fn(),
      renderer: { SessionProvider, renderSlot },
    }))
    expect(container.querySelector('[data-owner-console-native-conversation]')).not.toBeNull()
    expect(container.querySelector('[data-native-conversation-slot]')).not.toBeNull()
    expect(container.querySelector('[data-owner-console-chat-log]')).toBeNull()
    expect(container.querySelector('textarea[aria-label="给文鳐的消息"]')).toBeNull()
    expect(SessionProvider).toHaveBeenCalled()
    expect(SessionProvider.mock.calls.at(-1)?.[0].session).toBeDefined()
    expect(renderSlot).toHaveBeenCalledWith('owner-console.conversation', { sessionId: 's1' },
      { fallback: expect.anything() })
    // The native composer owns voice input through its Host slot; no duplicate toolbar.
    expect(container.querySelector('[data-owner-console-voice-toolbar]')).toBeNull()
  })

  it('computes the native phase from Session snapshots and selects the Chat view', async () => {
    const renderFactorySlot = vi.fn((_name: string, _props: Record<string, unknown>, _options?: unknown) =>
      createElement('div', { 'data-native-factory': '' }))
    const renderSlot = vi.fn()
    const seat = (session: ChatSessionSnapshot, blank: boolean | undefined, running = false) => ({
      sessionId: 's1',
      renderFactorySlot,
      useSession: <T,>(selector: (value: ChatSessionSnapshot) => T): T => selector({ ...session, running }),
      useConversation: <T,>(selector: (value: { activeTargets: ReadonlySet<string> }) => T): T => selector({ activeTargets: new Set() }),
      useSessions: <T,>(selector: (value: { byId: Record<string, { blank?: boolean }> }) => T): T => selector({ byId: { s1: blank === undefined ? {} : { blank } } }),
    })

    await render(createElement(OwnerConsoleConversation as never, seat({ blank: true, openState: 'open' }, true)))
    // The hero layout is suppressed, so the native surface gets the sticky active phase instead.
    expect(renderFactorySlot).toHaveBeenLastCalledWith('conversation.content',
      { variant: 'embedded', phase: 'active', hero: false }, expect.objectContaining({ slots: expect.any(Object) }))
    const options = renderFactorySlot.mock.calls.at(-1)?.[2] as unknown as { slots: { views: (props: unknown) => unknown } }
    options.slots.views({ renderSlot })
    expect(renderSlot).toHaveBeenCalledWith('conversation.session', { view: 'chat' })

    renderFactorySlot.mockClear()
    await render(createElement(OwnerConsoleConversation as never, seat({ blank: false, openState: 'open' }, false, true)))
    expect(renderFactorySlot).toHaveBeenLastCalledWith('conversation.content',
      { variant: 'embedded', phase: 'active', hero: false }, expect.anything())

    renderFactorySlot.mockClear()
    await render(createElement(OwnerConsoleConversation as never, seat({ blank: true, openState: 'loading' }, undefined)))
    expect(renderFactorySlot).toHaveBeenLastCalledWith('conversation.content',
      { variant: 'embedded', phase: 'settling', hero: false }, expect.anything())
  })
})
