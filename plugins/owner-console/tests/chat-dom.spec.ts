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

    // Native conversation embedding is bypassed; dedicated dialog renders cleanly with Markdown & workspace pill.
    expect(container.querySelector('[data-owner-console-chat-log]')).not.toBeNull()
    expect(container.querySelector('textarea[aria-label="给文鳐的消息"]')).not.toBeNull()
    expect(container.querySelector('[data-native-conversation-slot]')).toBeNull()
    expect(SessionProvider).not.toHaveBeenCalled()
    expect(renderSlot).not.toHaveBeenCalled()
    expect(container.textContent).toContain('工作区: assistant-workspace')
    expect(container.textContent).toContain('飞书在线')
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
})
