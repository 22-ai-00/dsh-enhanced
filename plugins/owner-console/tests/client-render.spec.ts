import { describe, expect, it, vi } from 'vitest'
import type { OwnerConsoleStatus } from '../src/typert.ts'

/**
 * Renders the panel tree without a DOM: hooks are stubbed so the first `useState` (the status)
 * can be seeded, then function components are expanded and the element tree is walked.
 */
const seed: { status: OwnerConsoleStatus | undefined, calls: number } = { status: undefined, calls: 0 }
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    // Only the panel's first useState (the status) is seeded; the counter resets per render so nested cards' hooks don't shift it.
    useState: (initial: unknown) => [seed.calls++ === 0 ? seed.status : initial, () => undefined],
    useEffect: () => undefined,
    useRef: (value: unknown) => ({ current: value }),
  }
})

const { OwnerConsoleIcon, OwnerConsoleSettingsPanel, larkConnectionTone } = await import('../src/client.ts')

type Node = { type: unknown, props: Record<string, unknown> }
function expand(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const element = node as Node
  if (typeof element.type === 'function') return expand((element.type as (props: unknown) => unknown)(element.props))
  return [element, ...expand(element.props['children'])]
}
const text = (nodes: readonly Node[]) => nodes.flatMap(node => {
  const children = node.props['children']
  return (Array.isArray(children) ? children : [children]).filter(child => typeof child === 'string')
}).join('|')

function render(status?: OwnerConsoleStatus) {
  seed.status = status
  seed.calls = 0
  const navigation = { openConversation: vi.fn(), openPlugins: vi.fn() }
  return { nodes: expand(OwnerConsoleSettingsPanel({ remote: {} as never, navigation })), navigation }
}

const STATUS = {
  feishu: { mode: 'env', installed: true, entry: 'dsh-enhanced-lark-channel', connection: 'connected', appIdConfigured: false },
  traex: { installed: false, enabled: false, command: '' },
  host: { settings: true, pluginManager: true, bundles: 'ok', plugins: 'ok' },
  dependencies: [{ name: 'assistantDelivery', available: true }],
  evaluation: { intakeAgreement: 'disabled' },
  bundles: [],
  plugins: [],
} as unknown as OwnerConsoleStatus

const LARK = '@dsh-enhanced/lark-channel'
const TRAEX = '@dsh-enhanced/traex-acp-provider'
const bundle = (name: string, overrides: Record<string, unknown> = {}) => ({
  name, enabled: true, installed: true, removable: true,
  rows: [{ rowId: name.replace('@dsh-enhanced/', 'dsh-enhanced-'), moduleName: name }], ...overrides,
})
const withState = (overrides: Record<string, unknown>) => ({ ...STATUS, ...overrides }) as unknown as OwnerConsoleStatus
const buttons = (nodes: readonly Node[]) => nodes.filter(node => node.type === 'button')
  .map(node => String(node.props['children']))
const textareas = (nodes: readonly Node[]) => nodes.filter(node => node.type === 'textarea')

describe('owner console panel presentation', () => {
  it('renders the 文鳐 brand header with a primary 开始对话 action', () => {
    const { nodes, navigation } = render()
    const header = nodes.find(node => node.props['data-owner-console-header'] === '')
    expect(header?.type).toBe('header')
    const headerNodes = expand(header)
    expect(text(headerNodes)).toContain('文鳐 Ray')
    expect(text(headerNodes)).toContain('你的个人助手小鳐 · 小鳐小鳐，游而化飞')
    const start = headerNodes.find(node => node.type === 'button' && node.props['children'] === '开始对话')
    expect(start).toBeDefined()
    ;(start!.props['onClick'] as () => void)()
    expect(navigation.openConversation).toHaveBeenCalledOnce()
  })

  it('renders the 02 水墨化鹏 hero, panel backdrop, seal and sidebar icon as decoration only', () => {
    const { nodes } = render()
    const hero = nodes.find(node => node.props['data-owner-console-art'] === 'hero')
    expect(hero?.type).toBe('img')
    expect(hero!.props['alt']).toBe('')
    expect(hero!.props['aria-hidden']).toBe('true')
    // Inlined: no network fetch or bundler asset URL.
    expect(String(hero!.props['src'])).toMatch(/^data:image\/webp;base64,/)

    // The background is on the panel's own surface, behind the cards, not just the header.
    const backdrop = nodes.find(node => node.props['data-owner-console-art'] === 'backdrop')
    expect(backdrop?.type).toBe('img')
    expect(String(backdrop!.props['src'])).toMatch(/^data:image\/webp;base64,/)
    expect(backdrop!.props['alt']).toBe('')
    expect(backdrop!.props['aria-hidden']).toBe('true')
    expect(Number((backdrop!.props['style'] as Record<string, unknown>)['opacity'])).toBeLessThanOrEqual(0.25)
    const backdropLayer = nodes.find(node => node.type === 'div' && node.props['style'] !== undefined
      && (node.props['style'] as Record<string, unknown>)['position'] === 'absolute')
    expect(backdropLayer).toBeDefined()

    // Brand seal is the round-cropped icon image, still decorative.
    const seal = nodes.find(node => node.props['data-owner-console-art'] === 'seal')
    expect(seal?.type).toBe('img')
    expect(String(seal!.props['src'])).toMatch(/^data:image\/webp;base64,/)
    expect(seal!.props['alt']).toBe('')
    expect(seal!.props['aria-hidden']).toBe('true')
    expect((seal!.props['style'] as Record<string, unknown>)['borderRadius']).toBe('50%')
    expect(nodes.some(node => node.type === 'svg' && node.props['data-owner-console-art'] === 'cloud')).toBe(true)
    // Decorative images only; the product name stays live text.
    expect(nodes.filter(node => node.type === 'img')).toHaveLength(3)
    expect(text(nodes)).toContain('文鳐 Ray')

    // Sidebar entry: the same 02 水墨化鹏 icon, square-cropped into a round avatar.
    const icon = expand(OwnerConsoleIcon())
    expect(icon[0]!.props['aria-hidden']).toBe(true)
    const iconImage = icon.find(node => node.type === 'img')
    expect(iconImage).toBeDefined()
    expect(String(iconImage!.props['src'])).toMatch(/^data:image\/webp;base64,/)
    expect(iconImage!.props['alt']).toBe('')
    expect(iconImage!.props['aria-hidden']).toBe('true')
    expect(icon.some(node => node.type === 'svg')).toBe(false)
  })

  it('shows statuses as pills with text labels and friendly empty states', () => {
    const { nodes } = render(STATUS)
    const all = text(nodes)
    expect(all).toContain('已连接')
    expect(all).toContain('未配置')
    expect(all).toContain('本 profile 中没有本项目的 bundle。')
    expect(all).toContain('云水无事，小鳐静候')
    expect(nodes.filter(node => node.type === 'button').length).toBeGreaterThan(3)
  })

  it('shows the scope-free intake agreement switch from status without blocking the read', () => {
    const labels = { absent: '未加载', unknown: '已加载，开关状态未知', disabled: '未启用', available: '已启用' } as const
    for (const [availability, label] of Object.entries(labels)) {
      const { nodes } = render({ ...STATUS, evaluation: { intakeAgreement: availability } } as unknown as OwnerConsoleStatus)
      const all = text(nodes)
      expect(all).toContain(`Evaluation 开关|${label}`)
    }
    expect(text(render().nodes)).toContain('Evaluation 开关|正在读取…')
  })

  it('stops the dead-end 启用 on an enabled bundle and shows why it is not loaded', () => {
    const pending = render(withState({
      feishu: { mode: 'env', installed: true, enabled: true, appIdConfigured: true,
        connected: false, connection: 'disconnected' },
      dependencies: [{ name: 'assistantDelivery', available: false }],
      bundles: [bundle(LARK)],
      plugins: [{ entryId: 'lark', moduleName: LARK, enabled: true, fiberPhase: 'pending', diagnostic: 'waiting for assistantDelivery' }],
    }))
    const all = text(pending.nodes)
    expect(all).toContain('已启用，等待依赖服务')
    expect(all).toContain('等待依赖服务')
    expect(all).toContain('waiting for assistantDelivery')
    expect(all).toContain('assistantDelivery（安装 @dsh-enhanced/assistant-delivery）')
    expect(buttons(pending.nodes)).not.toContain('启用 lark-channel')
    expect(buttons(pending.nodes)).toContain('安装 @dsh-enhanced/assistant-delivery')
    const repair = textareas(pending.nodes).find(node => String(node.props['aria-label']).includes(LARK))
    expect(String(repair?.props['value'])).toContain('disabled: true')
    expect(repair?.props['readOnly']).toBe(true)

    const failedTraex = render(withState({
      feishu: { mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' },
      bundles: [bundle(TRAEX)],
      plugins: [{ entryId: 'traex', moduleName: TRAEX, enabled: true, fiberPhase: 'failed', diagnostic: 'spawn failed' }],
    }))
    expect(text(failedTraex.nodes)).toContain('已启用但加载失败')
    expect(text(failedTraex.nodes)).toContain('spawn failed')
    expect(buttons(failedTraex.nodes)).not.toContain('启用 traex-acp-provider')
  })

  it('offers 启用 only when the bundle is installed but not selected', () => {
    const disabled = render(withState({ bundles: [bundle(LARK, { enabled: false })] }))
    expect(text(disabled.nodes)).toContain('已安装但未启用')
    expect(buttons(disabled.nodes)).toContain('启用 lark-channel')
    expect(buttons(disabled.nodes)).not.toContain('安装 lark-channel')
  })

  it('keeps an errored bundle visible with its code and no misleading install button', () => {
    const errored = render(withState({
      feishu: { mode: 'env', installed: true, enabled: true, appIdConfigured: false, connected: false, connection: 'disconnected' },
      bundles: [bundle(LARK, { error: { code: 'incompatible-version', diagnostic: 'pins 0.2.1-rc.2' } })],
    }))
    const all = text(errored.nodes)
    expect(all).toContain('Host 报告错误')
    expect(all).toContain('incompatible-version')
    expect(all).toContain('pins 0.2.1-rc.2')
    expect(buttons(errored.nodes)).not.toContain('安装 lark-channel')
    expect(buttons(errored.nodes)).not.toContain('启用 lark-channel')
  })

  it('reports missing Host services explicitly instead of reading as "not installed"', () => {
    const missing = render(withState({
      host: { settings: false, pluginManager: false, bundles: 'unavailable', plugins: 'unavailable' },
      feishu: { mode: 'env', installed: false, enabled: false, appIdConfigured: false, connected: false, connection: 'absent' },
    }))
    const all = text(missing.nodes)
    expect(all).toContain('Host 服务不完整')
    expect(all).toContain('settings 未加载')
    expect(all).toContain('pluginManager 未加载')
    expect(all).toContain('Host pluginManager 未加载')
    expect(buttons(missing.nodes)).not.toContain('安装 lark-channel')
  })

  it('never promises that dependency bundles are installed with the package', () => {
    const all = text(render(STATUS).nodes)
    expect(all).not.toContain('含依赖')
    expect(all).toContain('只装该包及其 pnpm 依赖')
  })

  it('maps lark connection states to tones without relying on colour alone', () => {
    expect(larkConnectionTone('connected')).toBe('ok')
    expect(larkConnectionTone('connected', 'rate_limited')).toBe('warn')
    expect(larkConnectionTone('reconnecting')).toBe('warn')
    expect(larkConnectionTone('disconnected')).toBe('error')
    expect(larkConnectionTone('absent')).toBe('neutral')
  })
})
