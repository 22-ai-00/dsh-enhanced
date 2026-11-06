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

const { OwnerConsoleIcon, OwnerConsolePanel, larkConnectionTone } = await import('../src/client.ts')

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
  return { nodes: expand(OwnerConsolePanel({ remote: {} as never, navigation })), navigation }
}

const STATUS = {
  feishu: { mode: 'env', installed: true, entry: 'dsh-enhanced-lark-channel', connection: 'connected', appIdConfigured: false },
  traex: { installed: false, enabled: false, command: '' },
  evaluation: { intakeAgreement: 'disabled' },
  bundles: [],
  plugins: [],
} as unknown as OwnerConsoleStatus

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

  it('shows the inlined 文鳐 banner and seal as decoration only', () => {
    const { nodes } = render()
    const hero = nodes.find(node => node.props['data-owner-console-art'] === 'hero')
    expect(hero?.type).toBe('img')
    expect(hero!.props['alt']).toBe('')
    expect(hero!.props['aria-hidden']).toBe('true')
    // Inlined: no network fetch or bundler asset URL.
    expect(String(hero!.props['src'])).toMatch(/^data:image\/webp;base64,/)
    for (const art of ['seal', 'cloud']) {
      const svg = nodes.find(node => node.type === 'svg' && node.props['data-owner-console-art'] === art)
      expect(svg, art).toBeDefined()
      expect(svg!.props['aria-hidden']).toBe('true')
    }
    expect(text(nodes.filter(node => node.type === 'text'))).toBe('文|鳐')
    expect(nodes.filter(node => node.type === 'img')).toHaveLength(1)
    const icon = expand(OwnerConsoleIcon())
    expect(icon[0]!.props['aria-hidden']).toBe(true)
    expect(icon.some(node => node.type === 'svg')).toBe(true)
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

  it('maps lark connection states to tones without relying on colour alone', () => {
    expect(larkConnectionTone('connected')).toBe('ok')
    expect(larkConnectionTone('connected', 'rate_limited')).toBe('warn')
    expect(larkConnectionTone('reconnecting')).toBe('warn')
    expect(larkConnectionTone('disconnected')).toBe('error')
    expect(larkConnectionTone('absent')).toBe('neutral')
  })
})
