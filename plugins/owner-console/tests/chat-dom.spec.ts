// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderChatMarkdown } from '../src/chat-markdown.ts'
import { OwnerConsoleChat, OwnerConsoleConversation } from '../src/chat-view.ts'
import { OwnerConsolePanel } from '../src/client.ts'
import { CUSTOM_MODEL_OPTION } from '../src/model-route-ui.ts'
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
  setInbox(value: unknown): void
}

function harness(
  overrides: Partial<ChatRuntime> = {},
  entries: readonly ChatEntry[] = [],
  initialModelSelection: unknown = undefined,
): Harness {
  const snapshot = observable<ChatSessionSnapshot>({ openState: 'open', running: false })
  const events = observable<ChatEventWindow>({ entries, hasMore: false })
  const permission = observable<unknown>({ currentValue: 'workspace-write' })
  const inbox = observable<unknown>({ 'next-turn': [], 'next-step': [] })
  const modelSelection = observable<unknown>(initialModelSelection)
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
    projections: {
      faceOf: key => key === 'permissions'
        ? permission
        : key === 'inbox'
          ? inbox
          : key === 'modelSelection'
            ? modelSelection
            : observable(undefined),
    },
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
    setEntries: entries => events.set({ entries, hasMore: false }), setSnapshot: snapshot.set,
    setPermission: permission.set, setInbox: inbox.set }
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

  it('keeps assistant workspace implicit on the empty welcome view and header without rendering 工作区 badges', async () => {
    const fake = harness({
      assistantChatContext: async () => ({
        ok: true,
        value: {
          protocol: 'owner-console/assistant-chat/v1',
          workspace: '/Users/owner/.dsh/assistant-workspace',
          activeSessionId: 's1',
          knownSessionIds: ['s1'],
          capabilities: { memory: true, wiki: false, dreaming: false, proactive: false, growth: false, feishuConnected: false },
        },
      }),
    }, [])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    expect(container.textContent).toContain('云水无事，小鳐静候 · 你的个人助手小鳐')
    expect(container.textContent).not.toContain('专属工作区')
    expect(container.textContent).not.toContain('工作区:')
    expect(container.textContent).not.toContain('assistant-workspace')
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

describe('文鳐 dedicated assistant dialog & slot compatibility', () => {
  it('always renders 文鳐 own dedicated dialog instead of delegating to native conversation.content', async () => {
    let createdCount = 0
    const selectSessionModel = vi.fn(async () => ({ ok: true as const, value: { applied: true } }))
    const registerAssistantSession = vi.fn(async () => ({ ok: true as const, value: { applied: true, entry: 'owner-console', note: 'ok' } }))
    const SessionProvider = vi.fn((props: { session?: unknown, children?: unknown }) => props.children)
    const renderSlot = vi.fn(() => createElement('div', { 'data-native-conversation-slot': '' }, 'native conversation'))
    const fake = harness({
      createSession: vi.fn(async () => `s-new-${++createdCount}`),
      assistantChatContext: async () => ({
        ok: true,
        value: {
          protocol: 'owner-console/assistant-chat/v1',
          workspace: '/Users/owner/.dsh/assistant-workspace',
          activeSessionId: 's1',
          knownSessionIds: ['s1'],
          capabilities: { memory: true, wiki: true, dreaming: true, proactive: false, growth: false, feishuConnected: true },
        },
      }),
      registerAssistantSession,
      modelCatalog: async () => ({
        ok: true,
        value: {
          protocol: 'owner-console/model-catalog/v1',
          fetchedAt: 1_000,
          defaultSelection: { provider: 'llmgw', model: 'seed-2.0-pro', reasoningEffort: 'medium' },
          providers: [
            {
              id: 'llmgw',
              name: 'LLMBox Seed',
              kind: 'api',
              active: true,
              models: [
                {
                  id: 'seed-2.0-pro',
                  name: 'Seed 2.0 Pro',
                  efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }],
                  defaultEffort: 'medium',
                },
              ],
            },
            {
              id: 'agy-agent',
              name: 'Antigravity ACP',
              kind: 'acp',
              active: true,
              models: [
                { id: 'default', name: 'Antigravity default', efforts: [{ id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }] },
                { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: [{ id: 'high', name: 'High' }] },
              ],
            },
          ],
        },
      }),
      selectSessionModel,
    }, [
      user(1, '介绍一下你自己'),
      assistant(2, '# 你好\n我是 **文鳐** (`assistant-workspace`)。'),
    ])

    await render(createElement(OwnerConsoleChat, {
      runtime: fake.runtime,
      onOpenSettings: vi.fn(),
      renderer: { SessionProvider, renderSlot },
    }))

    // Native conversation embedding is bypassed; dedicated dialog renders cleanly with Markdown & capability chips
    // without surfacing an internal `工作区: ...` badge in the top bar (assistant workspace is implicit & fixed).
    expect(container.querySelector('[data-owner-console-chat-log]')).not.toBeNull()
    expect(container.querySelector('textarea[aria-label="给文鳐的消息"]')).not.toBeNull()
    expect(container.querySelector('[data-native-conversation-slot]')).toBeNull()
    expect(SessionProvider).not.toHaveBeenCalled()
    expect(renderSlot).not.toHaveBeenCalled()
    const headerText = container.querySelector('[data-owner-console-chat-header]')?.textContent ?? ''
    expect(headerText).not.toContain('工作区:')
    expect(headerText).not.toContain('assistant-workspace')
    expect(headerText).toContain('记忆')
    expect(headerText).toContain('Wiki')
    expect(headerText).toContain('飞书在线')
    expect(container.querySelector('strong')?.textContent).toBe('文鳐')
    expect(container.querySelector('code')?.textContent).toBe('assistant-workspace')
    expect(registerAssistantSession).toHaveBeenCalledWith('s1', true)

    // In-dialog /model cascading selector switches session model immediately.
    const providerSelect = container.querySelector('[data-model-route-select="provider"]') as HTMLSelectElement
    expect(providerSelect.value).toBe('llmgw')
    providerSelect.value = 'agy-agent'
    await act(async () => { providerSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
    expect(selectSessionModel).toHaveBeenCalledWith('s1', 'agy-agent', 'default', 'medium')

    // 新对话 creates a dedicated session cleanly.
    const newChatBtn = byLabel('新对话')
    await click(newChatBtn)
    expect(fake.runtime.createSession).toHaveBeenCalledOnce()
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

  it('renders unclosed streaming fenced code blocks without headings and trims Chinese punctuation outside bare URL links', async () => {
    const markdown = [
      '先看代码：',
      '```python  ',
      '# not a heading',
      'print("ok")',
    ].join('\n')
    await render(createElement('div', {}, renderChatMarkdown(markdown) as ReactNode))
    const code = container.querySelector('code')
    expect(code).not.toBeNull()
    expect(code!.textContent).toBe('# not a heading\nprint("ok")')
    expect(container.textContent).not.toContain('```')
    // Ensure "# not a heading" stayed inside <code> rather than rendering as a heading block.
    const headingDivs = [...container.querySelectorAll('div')].filter(
      el => el.style.fontWeight === '600' && el.textContent?.includes('not a heading'),
    )
    expect(headingDivs).toHaveLength(0)

    const urlMarkdown = '请查看 https://example.com/a。以及 https://example.com/b，结束'
    await render(createElement('div', {}, renderChatMarkdown(urlMarkdown) as ReactNode))
    const links = [...container.querySelectorAll('a')]
    expect(links).toHaveLength(2)
    expect(links[0]!.href).toBe('https://example.com/a')
    expect(links[0]!.textContent).toBe('https://example.com/a')
    expect(links[1]!.href).toBe('https://example.com/b')
    expect(links[1]!.textContent).toBe('https://example.com/b')
    expect(container.textContent).toBe('请查看 https://example.com/a。以及 https://example.com/b，结束')
  })

  it('shows thinking indicator while snapshot.running is true with empty streaming text and hides it once streaming begins', async () => {
    const fake = harness({}, [])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))
    expect(container.querySelector('[data-owner-console-welcome]')).not.toBeNull()
    expect(container.querySelector('[data-chat-message-kind="thinking"]')).toBeNull()

    await act(async () => { fake.setSnapshot({ openState: 'open', running: true }) })
    await settle()
    expect(container.querySelector('[data-owner-console-welcome]')).toBeNull()
    const thinking = container.querySelector('[data-chat-message-kind="thinking"]')
    expect(thinking).not.toBeNull()
    expect(thinking!.textContent).toContain('文鳐正在思考…')

    await act(async () => {
      fake.setEntries([
        { type: 'transient', event: { seq: 1, data: { attemptId: 'a1', chunk: { type: 'text-delta', text: '正在整理答案' } } } },
      ])
    })
    await settle()
    expect(container.querySelector('[data-chat-message-kind="thinking"]')).toBeNull()
    expect(container.querySelector('[data-chat-message-kind="streaming"]')?.textContent).toContain('正在整理答案')
  })

  it('buffers compact custom model input keystrokes and calls selectSessionModel only on 应用 click or Enter without injecting uninstalled ACP providers', async () => {
    const selectSessionModel = vi.fn(async () => ({ ok: true as const, value: { applied: true } }))
    const fake = harness({
      selectSessionModel,
      modelCatalog: async () => ({
        ok: true,
        value: {
          protocol: 'owner-console/model-catalog/v1',
          fetchedAt: 2_000,
          defaultSelection: { provider: 'llmgw', model: 'seed-2.0-pro', reasoningEffort: 'medium' },
          providers: [
            {
              id: 'llmgw',
              name: 'LLMBox Seed',
              kind: 'api',
              active: true,
              models: [
                {
                  id: 'seed-2.0-pro',
                  name: 'Seed 2.0 Pro',
                  efforts: [{ id: 'medium', name: 'Medium' }],
                  defaultEffort: 'medium',
                },
              ],
            },
          ],
        },
      }),
    }, [user(1, 'hi')])

    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))

    const providerSelect = container.querySelector('[data-model-route-select="provider"]') as HTMLSelectElement
    expect([...providerSelect.options].map(o => o.value)).toEqual(['llmgw'])

    const modelSelect = container.querySelector('[data-model-route-select="model"]') as HTMLSelectElement
    modelSelect.value = CUSTOM_MODEL_OPTION
    await act(async () => { modelSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()

    const customInput = container.querySelector('[data-model-route-custom-model]') as HTMLInputElement
    const applyBtn = container.querySelector('[data-model-route-custom-apply]') as HTMLButtonElement
    expect(customInput).not.toBeNull()
    expect(applyBtn).not.toBeNull()
    expect(applyBtn.textContent).toBe('应用')

    const setInputValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    for (const partial of ['d', 'de', 'deepseek-v4-custom']) {
      setInputValue.call(customInput, partial)
      await act(async () => { customInput.dispatchEvent(new Event('input', { bubbles: true })) })
    }
    expect(selectSessionModel).not.toHaveBeenCalled()

    await click(applyBtn)
    expect(selectSessionModel).toHaveBeenCalledTimes(1)
    expect(selectSessionModel).toHaveBeenLastCalledWith('s1', 'llmgw', 'deepseek-v4-custom', '')

    // Re-enter custom mode and commit via Enter key.
    modelSelect.value = CUSTOM_MODEL_OPTION
    await act(async () => { modelSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()

    const customInputAgain = container.querySelector('[data-model-route-custom-model]') as HTMLInputElement
    setInputValue.call(customInputAgain, 'deepseek-r2')
    await act(async () => { customInputAgain.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(selectSessionModel).toHaveBeenCalledTimes(1)

    await act(async () => {
      customInputAgain.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
    await settle()
    expect(selectSessionModel).toHaveBeenCalledTimes(2)
    expect(selectSessionModel).toHaveBeenLastCalledWith('s1', 'llmgw', 'deepseek-r2', '')
  })

  it('embeds compact model and permission controls inside the floating composer dock and reflects permission tone updates', async () => {
    const fake = harness({}, [user(1, 'hello')])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))

    const composer = container.querySelector('[data-owner-console-composer]')
    expect(composer).not.toBeNull()
    expect(composer!.querySelector('[data-owner-console-chat-controls]')).not.toBeNull()
    expect(composer!.querySelector('[data-owner-console-permissions]')).not.toBeNull()
    expect(composer!.querySelector('[data-model-route-controls="compact"]')).not.toBeNull()

    const permWrap = composer!.querySelector('[data-owner-console-permissions]') as HTMLElement
    const permSelect = byLabel('切换权限预设') as HTMLSelectElement
    expect(permWrap.getAttribute('data-permission-tone')).toBe('ok')
    expect(permSelect.value).toBe('workspace-write')

    // Canceling high-risk confirmation leaves permission untouched and closes alertdialog.
    permSelect.value = 'danger-full-access'
    await act(async () => { permSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[role="alertdialog"]')).not.toBeNull()
    const cancelBtn = [...container.querySelectorAll('[role="alertdialog"] button')].find(b => b.textContent === '取消') ?? null
    await click(cancelBtn)
    expect(container.querySelector('[role="alertdialog"]')).toBeNull()
    expect(fake.command).not.toHaveBeenCalled()

    // Host projection update updates both select value and tone attribute.
    await act(async () => { fake.setPermission({ currentValue: 'auto' }) })
    expect(permWrap.getAttribute('data-permission-tone')).toBe('warn')
    await act(async () => { fake.setPermission({ currentValue: 'danger-full-access' }) })
    expect(permWrap.getAttribute('data-permission-tone')).toBe('error')
    expect(permSelect.value).toBe('danger-full-access')
  })

  it('ref-counts scoped chat styles in document.head without polluting container text and cleans up on final unmount', async () => {
    const fakeA = harness({}, [])
    const fakeB = harness({}, [])
    await render(createElement(OwnerConsoleChat, { runtime: fakeA.runtime, onOpenSettings: vi.fn() }))
    expect(document.getElementById('owner-console-chat-styles')).not.toBeNull()
    expect(container.textContent).not.toContain('@keyframes')

    const secondHost = document.createElement('div')
    document.body.appendChild(secondHost)
    const secondRoot = createRoot(secondHost)
    try {
      await act(async () => { secondRoot.render(createElement(OwnerConsoleChat, { runtime: fakeB.runtime, onOpenSettings: vi.fn() })) })
      await settle()
      expect(document.querySelectorAll('#owner-console-chat-styles')).toHaveLength(1)

      // Unmounting one instance keeps styles alive for the remaining mounted chat.
      await act(async () => { secondRoot.unmount() })
      expect(document.getElementById('owner-console-chat-styles')).not.toBeNull()
    } finally {
      secondHost.remove()
    }

    // Unmounting the last instance cleans up the style tag cleanly.
    await act(async () => { root.unmount() })
    expect(document.getElementById('owner-console-chat-styles')).toBeNull()
    // Re-create root so afterEach unmount stays clean.
    root = createRoot(container)
  })

  it('supports markdown horizontal rules, code block copy callbacks, dismissible notices, scroll-to-bottom, and stop button', async () => {
    const onCopyCode = vi.fn()
    const md = ['第一段', '---', '```ts', 'const x = 1', '```', '第二段'].join('\n')
    await render(createElement('div', {}, renderChatMarkdown(md, onCopyCode) as ReactNode))
    expect(container.querySelector('hr')).not.toBeNull()
    const copyCodeBtn = [...container.querySelectorAll('button')].find(b => b.textContent === '复制') ?? null
    await click(copyCodeBtn)
    expect(onCopyCode).toHaveBeenCalledExactlyOnceWith('const x = 1')

    const fake = harness({}, [user(1, '问题'), assistant(2, '这是回复')])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))

    // Trigger a notice via copy in jsdom (where navigator.clipboard is absent) and dismiss it.
    await click(byLabel('复制回复'))
    expect(container.textContent).toContain('剪贴板')
    await click(byLabel('关闭提示'))
    expect(byLabel('关闭提示')).toBeNull()

    // Scroll away from bottom reveals 滚动到底部 button; clicking it jumps back and hides it.
    const logEl = container.querySelector('[data-owner-console-chat-log]') as HTMLDivElement
    Object.defineProperty(logEl, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(logEl, 'clientHeight', { configurable: true, value: 300 })
    logEl.scrollTop = 100
    await act(async () => { logEl.dispatchEvent(new Event('scroll', { bubbles: true })) })
    const scrollBtn = byLabel('滚动到底部')
    expect(scrollBtn).not.toBeNull()
    await click(scrollBtn)
    expect(logEl.scrollTop).toBe(1000)
    expect(byLabel('滚动到底部')).toBeNull()

    // Running state exposes circular 停止回复 button wired to session.cancel().
    await act(async () => { fake.setSnapshot({ openState: 'open', running: true }) })
    await settle()
    expect(byLabel('发送消息')).toBeNull()
    await click(byLabel('停止回复'))
    expect(fake.cancel).toHaveBeenCalledOnce()

    // Typing a follow-up while running reveals both 停止回复 and an enabled 发送消息 button for queueing.
    await fillMessage('补充一句')
    expect(byLabel('停止回复')).not.toBeNull()
    const queuedSend = byLabel('发送消息') as HTMLButtonElement | null
    expect(queuedSend).not.toBeNull()
    expect(queuedSend!.disabled).toBe(false)
  })

  it('avoids flashing custom model input when catalog is absent, hides empty effort dropdowns, and supports canceling custom model mode', async () => {
    // 1. Without modelCatalog (or while loading), compact composer must not auto-open custom model input/apply controls.
    const noCatalog = harness({}, [user(1, 'hello')])
    await render(createElement(OwnerConsoleChat, { runtime: noCatalog.runtime, onOpenSettings: vi.fn() }))
    expect(container.querySelector('[data-model-route-custom-model]')).toBeNull()
    expect(container.querySelector('[data-model-route-custom-apply]')).toBeNull()
    expect(container.querySelector('[data-model-route-select="effort"]')).toBeNull()

    // 2. Model without reasoning efforts hides the compact effort select; explicit custom mode can be canceled via ×.
    const withCatalog = harness({
      selectSessionModel: vi.fn(async () => ({ ok: true as const, value: { applied: true } })),
      modelCatalog: async () => ({
        ok: true,
        value: {
          protocol: 'owner-console/model-catalog/v1',
          fetchedAt: 3_000,
          defaultSelection: { provider: 'llmgw', model: 'plain-chat' },
          providers: [
            {
              id: 'llmgw',
              name: 'LLMBox',
              kind: 'api',
              active: true,
              models: [{ id: 'plain-chat', name: 'Plain Chat', efforts: [] }],
            },
          ],
        },
      }),
    }, [user(1, 'hi')])
    await render(createElement(OwnerConsoleChat, { runtime: withCatalog.runtime, onOpenSettings: vi.fn() }))
    expect(container.querySelector('[data-model-route-select="effort"]')).toBeNull()

    const modelSelect = container.querySelector('[data-model-route-select="model"]') as HTMLSelectElement
    modelSelect.value = CUSTOM_MODEL_OPTION
    await act(async () => { modelSelect.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
    expect(container.querySelector('[data-model-route-custom-model]')).not.toBeNull()

    await click(byLabel('取消自定义模型'))
    expect(container.querySelector('[data-model-route-custom-model]')).toBeNull()
    expect(modelSelect.value).toBe('plain-chat')
  })

  it('renders GFM markdown tables with alignments, inline formatting, horizontal scroll wrapper, and safe edge-case handling', async () => {
    const md = [
      '检查结果如下：',
      '| 模块 | 状态 | 备注 |',
      '| :--- | :---: | ---: |',
      '| **飞书** | `online` | 查看 [文档](https://example.com/doc) |',
      '| 管道测试 | `a | b` | x \\| y |',
      '| GFM转义 | `c \\| d` | ``e | f`` |',
      '| 未闭合反引号 | stray ` tick | path\\\\ |',
      '| 短行 |',
      '| 溢出行 | 正常 | 保留 | 应被截断 |',
      '',
      '普通含竖线句子 foo | bar',
      '',
      '| 列数不匹配 | 第二列 |',
      '| --- |',
      '',
      '| 仅表头 |',
      '| --- |',
    ].join('\n')

    await render(createElement('div', {}, renderChatMarkdown(md) as ReactNode))
    const wraps = [...container.querySelectorAll('[data-chat-md-table]')] as HTMLDivElement[]
    expect(wraps).toHaveLength(2)
    expect(wraps[0]!.style.overflowX).toBe('auto')
    expect(wraps[0]!.style.boxSizing).toBe('border-box')
    expect(wraps[0]!.style.getPropertyValue('overscroll-behavior-x')).toBe('contain')

    const table = wraps[0]!.querySelector('table') as HTMLTableElement
    expect(table).not.toBeNull()
    expect(table.style.minWidth).toBe('100%')
    expect(table.style.width).toBe('max-content')
    const headers = [...table.querySelectorAll('thead th')] as HTMLTableCellElement[]
    expect(headers.map(h => h.textContent)).toEqual(['模块', '状态', '备注'])
    expect(headers.map(h => h.style.textAlign)).toEqual(['left', 'center', 'right'])
    expect(headers[0]!.style.minWidth).toBe('96px')
    expect(headers[0]!.style.maxWidth).toBe('320px')

    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(6)

    // Row 0: inline bold, inline code, and safe http link render inside cells.
    const row0Cells = [...rows[0]!.querySelectorAll('td')] as HTMLTableCellElement[]
    expect(row0Cells.map(c => c.style.textAlign)).toEqual(['left', 'center', 'right'])
    expect(row0Cells[0]!.querySelector('strong')?.textContent).toBe('飞书')
    expect(row0Cells[1]!.querySelector('code')?.textContent).toBe('online')
    expect(row0Cells[2]!.querySelector('a')?.href).toBe('https://example.com/doc')

    // Row 1: pipes inside inline code and backslash-escaped pipes do not split columns.
    const row1Cells = [...rows[1]!.querySelectorAll('td')] as HTMLTableCellElement[]
    expect(row1Cells.map(c => c.textContent)).toEqual(['管道测试', 'a | b', 'x | y'])
    expect(row1Cells[1]!.querySelector('code')?.textContent).toBe('a | b')

    // Row 2: GFM §4.10 escaped pipe inside single-backtick code unescapes to `|`, and multi-backtick spans keep pipes intact.
    const row2Cells = [...rows[2]!.querySelectorAll('td')] as HTMLTableCellElement[]
    expect(row2Cells.map(c => c.textContent)).toEqual(['GFM转义', 'c | d', 'e | f'])
    expect(row2Cells[1]!.querySelector('code')?.textContent).toBe('c | d')
    expect(row2Cells[2]!.querySelector('code')?.textContent).toBe('e | f')

    // Row 3: unclosed stray backtick does not swallow subsequent column delimiters; even backslashes before `|` stay literal.
    const row3Cells = [...rows[3]!.querySelectorAll('td')] as HTMLTableCellElement[]
    expect(row3Cells.map(c => c.textContent)).toEqual(['未闭合反引号', 'stray ` tick', 'path\\\\'])

    // Row 4: short row padded to header column count; Row 5: extra columns truncated.
    const row4Cells = [...rows[4]!.querySelectorAll('td')] as HTMLTableCellElement[]
    expect(row4Cells.map(c => c.textContent)).toEqual(['短行', '', ''])
    const row5Cells = [...rows[5]!.querySelectorAll('td')] as HTMLTableCellElement[]
    expect(row5Cells.map(c => c.textContent)).toEqual(['溢出行', '正常', '保留'])

    // Leading paragraph before table without blank line and non-table pipe lines stay <p>.
    const paragraphs = [...container.querySelectorAll('p')].map(p => p.textContent)
    expect(paragraphs).toContain('检查结果如下：')
    expect(paragraphs).toContain('普通含竖线句子 foo | bar')
    expect(paragraphs.some(text => text?.includes('列数不匹配'))).toBe(true)

    // Header-only table (e.g. mid-stream) renders <thead> cleanly without an empty <tbody>.
    const streamingTable = wraps[1]!.querySelector('table') as HTMLTableElement
    expect([...streamingTable.querySelectorAll('thead th')].map(h => h.textContent)).toEqual(['仅表头'])
    expect(streamingTable.querySelector('tbody')).toBeNull()
  })

  it('wires macOS window-drag/leading-clearance, round corner-shape overrides, hover-gated actions, and DSH 0.2.2 native tokens', async () => {
    const fake = harness({}, [
      user(1, '帮我检查表格与代码'),
      assistant(2, '使用 `pnpm check`：\n```sh\npnpm check\n```'),
    ])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))

    // 1. Header supports macOS window drag and respects --dsh-frame-leading-clearance.
    const header = container.querySelector('[data-owner-console-chat-header]') as HTMLElement
    expect(header).not.toBeNull()
    expect(header.hasAttribute('data-window-drag')).toBe(true)
    expect(header.style.getPropertyValue('padding-inline-start')).toContain('--dsh-frame-leading-clearance')
    expect(header.style.background).toContain('--dsw-alias-bg-base')
    expect(header.style.borderBottom).toContain('--dsh-hairline-width')
    expect(header.style.borderBottom).toContain('--dsw-alias-border-l3')

    // 2. Scoped stylesheet overrides superellipse on circles/pills, guards hover rules with @media (hover: hover),
    // uses outline for focus-visible (never overridden by inline boxShadow), rebinds --dsw-elevation-stroke-color,
    // provides opaque surface-button hover, and enforces markdown first/last child margin collapse with !important.
    const styleText = document.getElementById('owner-console-chat-styles')?.textContent ?? ''
    expect(styleText).toContain('corner-shape: round;')
    expect(styleText).toContain('[data-chat-round]')
    expect(styleText).toContain('[data-chat-primary-circle]')
    expect(styleText).toContain('--dsw-elevation-stroke-color')
    expect(styleText).toContain('[data-chat-surface-btn]:hover:not(:disabled)')
    expect(styleText).toContain('--dsw-alias-interactive-bg-hover-solid')
    expect(styleText).toContain('outline: 2px solid var(--dsw-focus-ring-color')
    expect(styleText).toContain('@media (hover: hover)')
    expect(styleText).toContain('[data-chat-msg-actions]')
    expect(styleText).toContain('[data-chat-md] > :first-child { margin-top: 0 !important; }')
    expect(styleText).toContain('[data-chat-md] > :last-child { margin-bottom: 0 !important; }')

    // 3. Circular buttons carry round hooks; primary send uses DSH info-fill + on-color tokens.
    expect(byLabel('添加附件')?.hasAttribute('data-chat-round')).toBe(true)
    expect(byLabel('朗读最近一条回复')?.hasAttribute('data-chat-round')).toBe(true)
    const sendBtn = byLabel('发送消息') as HTMLButtonElement
    expect(sendBtn.hasAttribute('data-chat-primary-circle')).toBe(true)
    expect(sendBtn.style.background).toContain('--dsw-alias-button-info-fill')
    expect(sendBtn.style.color).toContain('--dsw-alias-label-on-color')

    // 4. Borderless elevation-soft composer dock (no double border), top fade veil, borderless user bubble,
    // dynamic font sizing, opaque scroll-to-bottom button, and DSH markdown code tokens.
    const rootSection = container.querySelector('[data-owner-console-chat]') as HTMLElement
    expect(rootSection.style.fontSize).toContain('--dsh-content-font-size')
    const composer = container.querySelector('[data-owner-console-composer]') as HTMLElement
    expect(composer.style.borderStyle).toBe('none')
    expect(composer.style.boxShadow).toContain('--dsw-elevation-soft')
    expect(composer.style.background).toContain('--dsw-specific-input-major')
    expect(composer.style.borderRadius).toContain('--dsw-radius-panel')
    const veil = container.querySelector('[data-chat-dock-veil]') as HTMLElement
    expect(veil).not.toBeNull()
    expect(veil.style.pointerEvents).toBe('none')

    const logEl = container.querySelector('[data-owner-console-chat-log]') as HTMLDivElement
    Object.defineProperty(logEl, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(logEl, 'clientHeight', { configurable: true, value: 300 })
    logEl.scrollTop = 50
    await act(async () => { logEl.dispatchEvent(new Event('scroll', { bubbles: true })) })
    const scrollBtn = byLabel('滚动到底部') as HTMLButtonElement
    expect(scrollBtn).not.toBeNull()
    expect(scrollBtn.hasAttribute('data-chat-surface-btn')).toBe(true)
    expect(scrollBtn.hasAttribute('data-chat-ghost-btn')).toBe(false)
    expect(scrollBtn.hasAttribute('data-chat-round')).toBe(true)

    const userBubble = container.querySelector('[data-chat-message-kind="user"]') as HTMLElement
    expect(userBubble.style.border).toBe('')
    expect(userBubble.style.background).toContain('--dsw-specific-bubble')
    expect(userBubble.style.borderRadius).toContain('--dsw-radius-xl')
    expect(userBubble.style.fontSize).toContain('--dsh-content-font-size')

    const textarea = container.querySelector('textarea[aria-label="给文鳐的消息"]') as HTMLTextAreaElement
    expect(textarea.style.fontSize).toContain('--dsh-content-font-size')
    expect(textarea.style.height).toBe('')

    const codes = [...container.querySelectorAll('code')] as HTMLElement[]
    expect(codes.length).toBeGreaterThanOrEqual(2)
    expect(codes[0]!.style.fontFamily).toContain('--ds-font-family-code')
    expect(codes[0]!.style.background).toContain('--dsw-alias-markdown-inline-code')
    const codeCard = codes[1]!.parentElement as HTMLElement
    expect(codeCard.style.background).toContain('--dsw-alias-markdown-code-block')
    const codeHeader = codeCard.firstElementChild as HTMLElement
    expect(codeHeader.style.background).toContain('--dsw-alias-markdown-code-block-banner')
  })

  it('keeps user questions visible across send, streaming, durable answer settlement, and queued follow-ups', async () => {
    const snapshot = observable<ChatSessionSnapshot>({ openState: 'open', running: false, pendingSubmissions: [] })
    const events = observable<ChatEventWindow>({ entries: [], hasMore: false })
    const permission = observable<unknown>({ currentValue: 'workspace-write' })
    const inbox = observable<unknown>({ 'next-turn': [], 'next-step': [] })
    let reqSeq = 0
    const beginSubmission = vi.fn((input: Readonly<{ mode: 'queue' | 'steer'; text: string; attachments: readonly unknown[] }>) => {
      const requestId = `req-${++reqSeq}`
      const placement: 'transcript' | 'queued' = snapshot.getSnapshot().running === true ? 'queued' : 'transcript'
      const cur = snapshot.getSnapshot()
      snapshot.set({
        ...cur,
        pendingSubmissions: [...(cur.pendingSubmissions ?? []), { requestId, placement, text: input.text, attachments: input.attachments as never }],
      })
      return {
        requestId,
        abandon: () => {
          const latest = snapshot.getSnapshot()
          snapshot.set({
            ...latest,
            pendingSubmissions: (latest.pendingSubmissions ?? []).filter(item => item.requestId !== requestId),
          })
        },
      }
    })
    const prompt = vi.fn(async () => ({ ok: true as const, value: { accepted: true } }))
    const session: ChatSessionFace = {
      getSnapshot: snapshot.getSnapshot,
      subscribe: snapshot.subscribe,
      beginSubmission,
      prompt,
      command: vi.fn(async () => ({ ok: true as const, value: { matched: true } })),
      cancel: vi.fn(async () => ({ ok: true as const, value: { accepted: true } })),
      loadOlder: vi.fn(async () => undefined),
      projections: { faceOf: key => key === 'permissions' ? permission : key === 'inbox' ? inbox : observable(undefined) },
    }
    const binding: ChatBinding = { sessionId: 's-live', session, eventSource: events }
    const runtime: ChatRuntime = {
      sessions: () => ({
        create: vi.fn(async () => 's-live'),
        retain: vi.fn(() => ({ sessionId: 's-live', binding, ready: Promise.resolve(binding), release: vi.fn() })),
      }),
      fileUploads: () => undefined,
      permissionCatalog: () => Promise.resolve({ ok: true, value: CATALOG }),
      openNativeSession: vi.fn(() => true),
      startConversation: vi.fn(),
      storage: () => undefined,
      voiceAvailable: () => false,
      createRecognition: () => undefined,
      recognitionLang: () => 'zh-CN',
      speakAvailable: () => false,
      speak: () => false,
    }

    await render(createElement(OwnerConsoleChat, { runtime, onOpenSettings: vi.fn() }))
    expect(container.querySelector('[data-owner-console-welcome]')).not.toBeNull()

    // 1. User sends first question on idle session -> appears immediately before durable user/message arrives.
    await fillMessage('介绍一下你自己和当前能力')
    await click(byLabel('发送消息'))
    expect(beginSubmission).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: '介绍一下你自己和当前能力' }], 'queue', undefined, 'req-1')
    expect(container.querySelector('[data-owner-console-welcome]')).toBeNull()
    expect([...container.querySelectorAll('[data-chat-message-kind="user"]')].map(el => el.textContent))
      .toEqual(['介绍一下你自己和当前能力'])

    // 2. Host starts turn, admits durable user/message (DSH real shape: event.data IS UserMessage) + injected runtime-context,
    //    and begins streaming -> still exactly one user bubble (zero duplication, no runtime-context leak).
    await act(async () => {
      snapshot.set({ ...snapshot.getSnapshot(), running: true })
      events.set({
        entries: [
          user(1, '介绍一下你自己和当前能力', { id: 'm-1', rpcId: 'req-1' }),
          { type: 'event', event: { type: 'user/message', seq: 2, surfaceOp: 'append', data: {
            id: 'm-ctx', role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '内部运行时上下文' }] } } },
          { type: 'transient', event: { seq: 2.5, data: { attemptId: 'a-1', turn: 1, step: 1, chunk: { type: 'text-delta', text: '你好，我是文鳐' } } } },
        ],
        hasMore: false,
      })
    })
    await settle()
    expect([...container.querySelectorAll('[data-chat-message-kind="user"]')].map(el => el.textContent))
      .toEqual(['介绍一下你自己和当前能力'])
    expect(container.textContent).not.toContain('内部运行时上下文')
    expect(container.querySelector('[data-chat-message-kind="streaming"]')?.textContent).toContain('你好，我是文鳐')

    // 3. While turn 1 is still running, user queues a follow-up question -> appears below streaming with 排队中.
    await fillMessage('帮我查一下今天的日程')
    await click(byLabel('发送消息'))
    const queuedMsg = { id: 'm-2', role: 'user', source: { kind: 'user', rpcId: 'req-2' }, content: [{ type: 'text', text: '帮我查一下今天的日程' }] }
    await act(async () => {
      events.set({
        entries: [
          ...events.getSnapshot().entries!,
          { type: 'event', event: { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, inserted: [queuedMsg] } } },
        ],
        hasMore: false,
      })
      inbox.set({
        'next-step': [],
        'next-turn': [queuedMsg],
      })
      // Real ClientSession retires queued pendingSubmissions once inbox projection observes the item.
      snapshot.set({ ...snapshot.getSnapshot(), pendingSubmissions: [] })
    })
    await settle()
    const rowsWhileRunning = [...container.querySelectorAll('[data-chat-message-kind]')]
    expect(rowsWhileRunning.map(el => el.getAttribute('data-chat-message-kind'))).toEqual(['user', 'streaming', 'user'])
    expect(rowsWhileRunning[2]!.getAttribute('data-chat-message-pending')).toBe('queued')
    expect(rowsWhileRunning[2]!.textContent).toContain('帮我查一下今天的日程')
    expect(rowsWhileRunning[2]!.textContent).toContain('排队中')

    // 3.5 Turn 1 finishes and Turn 2 claims m-2 from inbox into preStep/prepareRequest (BEFORE durable user/message arrives):
    //     both pendingSubmissions and inbox are now empty, yet m-2 MUST stay visible above thinking (never disappear!).
    await act(async () => {
      events.set({
        entries: [
          user(1, '介绍一下你自己和当前能力', { id: 'm-1', rpcId: 'req-1' }),
          { type: 'event', event: { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, inserted: [queuedMsg] } } },
          assistant(4, '你好，我是文鳐，你的长期个人助手。', 1, 1),
          { type: 'event', event: { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } } },
          { type: 'event', event: { type: 'turn/start', seq: 6, data: { turn: 2 } } },
          { type: 'event', event: { type: 'agent/inbox/spliced', seq: 7, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } } },
        ],
        hasMore: false,
      })
      inbox.set({ 'next-step': [], 'next-turn': [] })
      snapshot.set({ openState: 'open', running: true, pendingSubmissions: [] })
    })
    await settle()
    const rowsDuringTurn2PreStep = [...container.querySelectorAll('[data-chat-message-kind]')]
    expect(rowsDuringTurn2PreStep.map(el => el.getAttribute('data-chat-message-kind'))).toEqual(['user', 'assistant', 'user', 'thinking'])
    expect(rowsDuringTurn2PreStep[2]!.getAttribute('data-chat-message-pending')).toBe('transcript')
    expect(rowsDuringTurn2PreStep[2]!.textContent).toBe('帮我查一下今天的日程')

    // 4. Turn 2 finishes (durable user/message + assistant/message settle, running flips false) ->
    //    Both user questions MUST remain permanently visible above their respective answers!
    await act(async () => {
      events.set({
        entries: [
          user(1, '介绍一下你自己和当前能力', { id: 'm-1', rpcId: 'req-1' }),
          { type: 'event', event: { type: 'agent/inbox/spliced', seq: 3, data: { target: 'next-turn', start: 0, inserted: [queuedMsg] } } },
          assistant(4, '你好，我是文鳐，你的长期个人助手。', 1, 1),
          { type: 'event', event: { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } } },
          { type: 'event', event: { type: 'turn/start', seq: 6, data: { turn: 2 } } },
          { type: 'event', event: { type: 'agent/inbox/spliced', seq: 7, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } } },
          user(8, '帮我查一下今天的日程', { id: 'm-2', rpcId: 'req-2' }),
          assistant(9, '今天下午 3 点有评审会。', 2, 1),
        ],
        hasMore: false,
      })
      inbox.set({ 'next-step': [], 'next-turn': [] })
      snapshot.set({ openState: 'open', running: false, pendingSubmissions: [] })
    })
    await settle()

    const settledRows = [...container.querySelectorAll('[data-chat-message-kind]')]
    expect(settledRows.map(el => el.getAttribute('data-chat-message-kind'))).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(settledRows[0]!.textContent).toBe('介绍一下你自己和当前能力')
    expect(settledRows[1]!.textContent).toContain('你好，我是文鳐，你的长期个人助手。')
    expect(settledRows[2]!.textContent).toBe('帮我查一下今天的日程')
    expect(settledRows[3]!.textContent).toContain('今天下午 3 点有评审会。')

    // 5. Submitting a new question while scrolled up re-sticks to bottom so the newly sent question is visible.
    const logEl = container.querySelector('[data-owner-console-chat-log]') as HTMLDivElement
    Object.defineProperty(logEl, 'scrollHeight', { configurable: true, value: 1200 })
    Object.defineProperty(logEl, 'clientHeight', { configurable: true, value: 300 })
    logEl.scrollTop = 100
    await act(async () => { logEl.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(byLabel('滚动到底部')).not.toBeNull()
    await fillMessage('再来一个问题')
    await click(byLabel('发送消息'))
    expect(logEl.scrollTop).toBe(1200)
    expect(byLabel('滚动到底部')).toBeNull()
  })

  it('shows actionable model-auth recovery with failed provider/model, quick switch to alternatives, and settings shortcut on AUTH 401', async () => {
    const selectSessionModel = vi.fn(async () => ({ ok: true as const, value: {} }))
    const onOpenSettings = vi.fn()
    const h = harness({
      selectSessionModel,
      modelCatalog: vi.fn(async () => ({
        ok: true as const,
        value: {
          protocol: 'owner-console/model-catalog/v1' as const,
          fetchedAt: 1_000,
          defaultSelection: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' },
          providers: [
            { id: 'llmgw-general', name: 'LLMBox DeepSeek', kind: 'api' as const, active: true, models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', efforts: [] }] },
            { id: 'super-relay', name: 'Super Relay', kind: 'api' as const, active: true, models: [{ id: 'auto_model/alwaysday1', name: 'alwaysday1', efforts: [] }] },
            { id: 'traex-agent', name: 'TraeX ACP', kind: 'acp' as const, active: true, models: [{ id: 'default', name: 'default', efforts: [] }] },
          ],
        },
      })),
    }, [
      user(1, '帮我检查本机插件、模型和飞书健康', { id: 'm-auth-1', rpcId: 'req-auth-1' }),
      { type: 'event', event: { type: 'request/header', seq: 2, data: { header: { config: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' } } } } },
      { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401: {"message":"authentication failed","type":"authentication_error"}' } } } } },
    ])

    await act(async () => {
      root.render(createElement(OwnerConsoleChat, { runtime: h.runtime, onOpenSettings }))
    })
    await settle()

    const recovery = container.querySelector('[data-chat-auth-recovery]')
    expect(recovery).not.toBeNull()
    expect(recovery!.textContent).toContain('llmgw-general / deepseek-v4.1-flash')
    expect(container.querySelector('[data-chat-auth-switch="llmgw-general"]')).toBeNull()

    const switchSuperRelay = container.querySelector('button[data-chat-auth-switch="super-relay"]') as HTMLButtonElement | null
    expect(switchSuperRelay).not.toBeNull()
    await click(switchSuperRelay!)
    expect(selectSessionModel).toHaveBeenCalledWith(h.binding.sessionId, 'super-relay', 'auto_model/alwaysday1', '')

    const settingsBtn = container.querySelector('button[data-chat-auth-open-settings]') as HTMLButtonElement | null
    expect(settingsBtn).not.toBeNull()
    await click(settingsBtn!)
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('prioritizes Host defaultSelection first, demotes same-family failed siblings, and clears stale switch buttons after switching', async () => {
    const selectSessionModel = vi.fn(async () => ({ ok: true as const, value: {} }))
    const h = harness({
      selectSessionModel,
      modelCatalog: vi.fn(async () => ({
        ok: true as const,
        value: {
          protocol: 'owner-console/model-catalog/v1' as const,
          fetchedAt: 2_000,
          defaultSelection: { provider: 'super-relay', model: 'auto_model/alwaysday1' },
          providers: [
            { id: 'deepseek', name: 'DeepSeek', kind: 'api' as const, active: true, models: [{ id: 'deepseek-chat', name: 'deepseek-chat', efforts: [] }] },
            { id: 'deepseek-official', name: 'DeepSeek Account', kind: 'api' as const, active: true, models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', efforts: [] }] },
            { id: 'llmgw', name: 'LLMBox Seed', kind: 'api' as const, active: true, models: [{ id: 'doubao-seed-evolving', name: 'doubao-seed-evolving', efforts: [] }] },
            { id: 'llmgw-general', name: 'LLMBox DeepSeek / GLM', kind: 'api' as const, active: true, models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', efforts: [] }] },
            { id: 'super-relay', name: 'Super Relay', kind: 'api' as const, active: true, models: [{ id: 'auto_model/alwaysday1', name: 'alwaysday1', efforts: [] }] },
            { id: 'custom-relay', name: 'custom-relay', kind: 'api' as const, active: true, models: [{ id: 'relay-auto', name: 'Auto All', efforts: [] }] },
            { id: 'traex-agent', name: 'TraeX ACP', kind: 'acp' as const, active: true, models: [{ id: 'default', name: 'default', efforts: [] }] },
          ],
        },
      })),
    }, [
      user(1, 'hi', { id: 'm-auth-2', rpcId: 'req-auth-2' }),
      { type: 'event', event: { type: 'request/header', seq: 2, data: { header: { config: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' } } } } },
      { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401: {"message":"authentication failed","type":"authentication_error"}' } } } } },
    ], {
      next: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' },
    })

    await act(async () => {
      root.render(createElement(OwnerConsoleChat, { runtime: h.runtime, onOpenSettings: vi.fn() }))
    })
    await settle()

    const recovery = container.querySelector('[data-chat-auth-recovery]')!
    expect(recovery.textContent).toContain('当前系统默认模型已是 super-relay / auto_model/alwaysday1')

    const switchButtons = [...container.querySelectorAll('button[data-chat-auth-switch]')] as HTMLButtonElement[]
    const order = switchButtons.map(btn => btn.getAttribute('data-chat-auth-switch'))
    expect(order[0]).toBe('super-relay')
    expect(switchButtons[0]!.hasAttribute('data-chat-auth-switch-default')).toBe(true)
    expect(switchButtons[0]!.textContent).toContain('切换至默认模型')
    expect(order[1]).toBe('traex-agent')
    expect(order).toContain('custom-relay')
    expect(order).not.toContain('llmgw')
    expect(order).not.toContain('llmgw-general')

    await click(switchButtons[0]!)
    expect(selectSessionModel).toHaveBeenCalledWith(h.binding.sessionId, 'super-relay', 'auto_model/alwaysday1', '')
    // After switching session away from llmgw-general, stale switch buttons disappear and recovery notes the new active route
    expect(container.querySelectorAll('button[data-chat-auth-switch]').length).toBe(0)
    expect(container.querySelector('[data-chat-auth-recovery]')!.textContent).toContain('当前会话已切换至 super-relay / auto_model/alwaysday1')
    // Since Host default is already super-relay (not llmgw-general), redundant settings button also collapses
    expect(container.querySelector('button[data-chat-auth-open-settings]')).toBeNull()
  })

  it('ranks custom relays ahead of deepseek-official, excludes same-family siblings and empty-model API providers, collapses duplicate/resolved errors, and avoids misattributing providerless errors', async () => {
    // 1) Default itself failed (llmgw-general); only 3 other providers exist including same-family llmgw and an empty-model API provider
    const selectSessionModel = vi.fn(async () => ({ ok: true as const, value: {} }))
    const h = harness({
      selectSessionModel,
      modelCatalog: vi.fn(async () => ({
        ok: true as const,
        value: {
          protocol: 'owner-console/model-catalog/v1' as const,
          fetchedAt: 3_000,
          defaultSelection: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' },
          providers: [
            { id: 'deepseek', name: 'DeepSeek', kind: 'api' as const, active: true, models: [{ id: 'deepseek-chat', name: 'deepseek-chat', efforts: [] }] },
            { id: 'deepseek-official', name: 'DeepSeek Account', kind: 'api' as const, active: true, models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', efforts: [] }] },
            { id: 'llmgw', name: 'LLMBox Seed', kind: 'api' as const, active: true, models: [{ id: 'doubao-seed-evolving', name: 'doubao-seed-evolving', efforts: [] }] },
            { id: 'empty-api', name: 'Empty API', kind: 'api' as const, active: true, models: [] },
            { id: 'llmgw-general', name: 'LLMBox DeepSeek / GLM', kind: 'api' as const, active: true, models: [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash', efforts: [] }] },
            { id: 'custom-relay', name: 'custom-relay', kind: 'api' as const, active: true, models: [{ id: 'relay-fast', name: 'Relay Fast', efforts: [] }] },
          ],
        },
      })),
    }, [
      user(1, 'first', { id: 'm-1', rpcId: 'r-1' }),
      { type: 'event', event: { type: 'request/header', seq: 2, data: { header: { config: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' } } } } },
      { type: 'event', event: { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: '401 invalid token' } } } } },
      user(4, 'second', { id: 'm-2', rpcId: 'r-2' }),
      // Second error has NO request/header (simulating truncated window / pre-header failure)
      { type: 'event', event: { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'error', error: { code: 'AUTH', message: '401 invalid token' } } } } },
    ], {
      next: { provider: 'llmgw-general', model: 'deepseek-v4.1-flash' },
    })

    await act(async () => {
      root.render(createElement(OwnerConsoleChat, { runtime: h.runtime, onOpenSettings: vi.fn() }))
    })
    await settle()

    // Only the LATEST auth error displays action buttons (not duplicated on the earlier auth error)
    const recoveries = [...container.querySelectorAll('[data-chat-auth-recovery]')]
    expect(recoveries).toHaveLength(2)
    expect(recoveries[0]!.querySelectorAll('button').length).toBe(0)
    const latestSwitches = [...recoveries[1]!.querySelectorAll('button[data-chat-auth-switch]')] as HTMLButtonElement[]
    const order = latestSwitches.map(btn => btn.getAttribute('data-chat-auth-switch'))
    // Custom relay custom-relay ranks AHEAD of deepseek & deepseek-official; llmgw (same-family) & empty-api are EXCLUDED
    expect(order[0]).toBe('custom-relay')
    expect(order).not.toContain('llmgw')
    expect(order).not.toContain('empty-api')

    // Switching away on a providerless latest error MUST NOT blame custom-relay!
    await click(latestSwitches[0]!)
    expect(selectSessionModel).toHaveBeenCalledWith(h.binding.sessionId, 'custom-relay', 'relay-fast', '')
    expect(recoveries[1]!.textContent).toContain('当前会话已切换至 custom-relay')
    expect(recoveries[1]!.textContent).not.toContain('模型鉴权失败（custom-relay')
    expect(recoveries[1]!.querySelectorAll('button[data-chat-auth-switch]').length).toBe(0)

    // 2) Once a later assistant reply arrives, historical auth errors collapse to a quiet note with zero buttons
    await act(async () => {
      h.setEntries([
        ...(h.binding.eventSource.getSnapshot().entries ?? []),
        assistant(6, '已经恢复正常，有什么可以帮你？', 3, 1),
      ])
    })
    await settle()
    const postReplyRecoveries = [...container.querySelectorAll('[data-chat-auth-recovery]')]
    expect(postReplyRecoveries.every(node => node.querySelectorAll('button').length === 0)).toBe(true)
    expect(postReplyRecoveries[1]!.textContent).toContain('后续对话已恢复正常')
  })

  it('dispatches concise NL self-iteration controls via runtime.controlSelfIteration while keeping ordinary messages on SessionFace.prompt', async () => {
    const controlSelfIteration = vi.fn(async (action: string, confirmed: boolean) => ({
      ok: true as const,
      value: { ok: true, action: action as 'disableSelfIteration', state: 'disabled' as const, note: confirmed ? '已关闭自迭代' : '' },
    }))
    const fake = harness({ controlSelfIteration }, [])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))

    await fillMessage('关闭自迭代')
    await click(byLabel('发送消息'))
    expect(controlSelfIteration).toHaveBeenCalledExactlyOnceWith('disableSelfIteration', true)
    expect(fake.prompt).not.toHaveBeenCalled()
    expect(container.textContent).toContain('已关闭整体自迭代能力')

    await fillMessage('今天北京天气怎么样？')
    await click(byLabel('发送消息'))
    expect(controlSelfIteration).toHaveBeenCalledTimes(1)
    expect(fake.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: '今天北京天气怎么样？' }], 'queue', undefined)
  })

  it('dispatches /version, /autonomy version, and concise NL version/iteration queries locally without calling SessionFace.prompt and preserves draft on error', async () => {
    const sampleReport = {
      schemaVersion: 1 as const,
      protocol: 'dsh-rsi/version/v1' as const,
      generatedAt: 1_800_000_000_000,
      dshHome: '/tmp/dsh-test',
      assistant: { name: 'dsh-enhanced' as const, version: '0.1.83', cliVersion: '0.1.83' },
      host: { packageName: '@deepseek-ai/dsh' as const, boundVersion: '0.2.2-rc.5', boundStatus: 'ready', runningVersion: '0.2.2-rc.5' },
      profile: 'web',
      profiles: ['web'],
      plugins: {
        state: 'ok' as const,
        coreCount: 1,
        evolvedCount: 1,
        activeEvolvedCount: 1,
        core: [{ name: '@dsh-enhanced/owner-console', version: '0.1.83', kind: 'core' as const, installKind: 'npm' as const, enabled: true }],
        evolved: [{ name: 'daily-brief', version: '1.0.0', kind: 'evolved' as const, installKind: 'adopted' as const, enabled: true }],
      },
      selfIteration: {
        dataState: 'data' as const,
        totalIterations: 12,
        workItemsTotal: 5,
        workItemsSettled: 4,
        growthUsageJobsTotal: 3,
        dreamingRuns: 2,
        recoveryRuns: 1,
        goalStrategyRuns: 1,
        candidatesGenerated: 4,
        candidatesAdopted: 2,
        pluginsCreated: 1,
        pluginsRevised: 0,
        taskVerificationsDone: 3,
        rollbacks: 0,
        evolutionRulesAdopted: 1,
        associationParamVersion: 2,
        associationProfileAdoptions: 1,
        evaluationAttentionTuningAdoptions: 1,
        evaluationLooseningDecisionsAdopted: 1,
        activeMemories: 7,
        activePreferenceOverlays: 2,
        workflowCandidatesPromoted: 1,
        skillDeployments: 1,
        selfUpgrades: 0,
        backupSnapshotsCount: 2,
      },
    }

    let shouldFail = false
    const versionInfo = vi.fn(async () => {
      if (shouldFail) {
        return { ok: false as const, error: { code: 'probe-failed', message: '版本账本暂不可读' } }
      }
      return { ok: true as const, value: sampleReport }
    })

    const fake = harness({ versionInfo }, [])
    await render(createElement(OwnerConsoleChat, { runtime: fake.runtime, onOpenSettings: vi.fn() }))

    await fillMessage('/version')
    await click(byLabel('发送消息'))
    expect(versionInfo).toHaveBeenCalledTimes(1)
    expect(fake.prompt).not.toHaveBeenCalled()
    expect(container.textContent).toContain('0.1.83')
    expect(container.textContent).toContain('12')

    await fillMessage('/autonomy version')
    await click(byLabel('发送消息'))
    expect(versionInfo).toHaveBeenCalledTimes(2)

    await fillMessage('查看版本')
    await click(byLabel('发送消息'))
    expect(versionInfo).toHaveBeenCalledTimes(3)

    await fillMessage('自己迭代了多少次？')
    await click(byLabel('发送消息'))
    expect(versionInfo).toHaveBeenCalledTimes(4)
    expect(fake.prompt).not.toHaveBeenCalled()
    expect(container.textContent).toContain('daily-brief')

    // RPC error displays alert notice and keeps user draft intact
    shouldFail = true
    await fillMessage('自迭代次数？')
    await click(byLabel('发送消息'))
    expect(versionInfo).toHaveBeenCalledTimes(5)
    expect(container.textContent).toContain('版本账本暂不可读')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.value).toBe('自迭代次数？')

    // Ordinary prose still goes to SessionFace.prompt
    await fillMessage('请帮我总结一下今天的日程安排')
    await click(byLabel('发送消息'))
    expect(versionInfo).toHaveBeenCalledTimes(5)
    expect(fake.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: '请帮我总结一下今天的日程安排' }], 'queue', undefined)
  })
})
