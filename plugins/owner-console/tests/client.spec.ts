import { describe, expect, it, vi } from 'vitest'
import { TYPERT_REMOTE } from '../src/typert.ts'
import { apply, feishuSecretRefs, intakeAgreementView, larkConnectionLabel, trendSnapshotsView } from '../src/client.ts'
import type { OwnerConsoleIntakeAgreement, OwnerConsoleTrendSnapshots } from '../src/typert.ts'

type Node = { type?: unknown, props?: Record<string, unknown> & { children?: unknown } }
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node !== 'object' || node === null) return
  visit(node as Node)
  walk((node as Node).props?.children, visit)
}
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node !== 'object' || node === null) return ''
  return text((node as Node).props?.children)
}

type Registration = Readonly<{ options: Record<string, unknown>, component: unknown }>

function fakeContext(registrations: Registration[], disposed: string[]) {
  const unmount = vi.fn(async () => undefined)
  return {
    ctx: {
      remote: { $mount: vi.fn(async (descriptor: unknown) => { expect(descriptor).toBe(TYPERT_REMOTE); return unmount }) },
      get: (name: string) => name === 'layout'
        ? { selectPanel: vi.fn() }
        : name === 'uiWorkspace' ? { startSession: vi.fn() } : undefined,
      inject: (dependencies: readonly string[], callback: (runtime: never) => unknown) => {
        expect(dependencies).toEqual(['remote.ownerConsole', 'slots'])
        const runtime = {
          remote: { ownerConsole: { status: vi.fn(async () => ({ ok: false as const })) } },

          slots: {
            // Mirrors the renderer: inject and register both return callable disposers.
            inject: (name: string, factory: () => unknown) => {
              const dispose = factory() as () => void
              return () => { disposed.push(name); dispose() }
            },
            register: (options: Record<string, unknown>, component: unknown) => {
              registrations.push({ options, component })
              return () => { disposed.push(String(options['id'] ?? options['key'])) }
            },
          },
        }
        const release = (callback as unknown as (value: unknown) => () => void)(runtime)
        return { dispose: async () => { release() } }
      },
    } as never,
    unmount,
  }
}

describe('owner console client', () => {
  it('submits exactly the secret reference the owner picked', () => {
    expect(feishuSecretRefs('env', 'LARK_APP_SECRET', 'typed-handle'))
      .toEqual({ appSecretEnv: 'LARK_APP_SECRET', credentialHandle: '' })
    expect(feishuSecretRefs('handle', 'ignored-env', 'typed-handle'))
      .toEqual({ appSecretEnv: '', credentialHandle: 'typed-handle' })
  })

  it('labels the lark-channel health snapshot without inventing a connection', () => {
    expect(larkConnectionLabel('absent')).toBe('未加载')
    expect(larkConnectionLabel('unknown')).toBe('已加载，状态未知')
    expect(larkConnectionLabel('connected')).toBe('已连接')
    expect(larkConnectionLabel('reconnecting', 'rate_limited')).toBe('重连中（最近错误：rate_limited）')
  })

  it('registers the sidebar entry and the keyed main panel, then disposes both', async () => {
    const registrations: Registration[] = [], disposed: string[] = []
    const { ctx, unmount } = fakeContext(registrations, disposed)
    const release = await apply(ctx)
    expect(registrations.map(item => item.options)).toEqual([
      { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: expect.any(Function) },
      { name: 'main', key: 'owner-console' },
    ])
    expect(typeof registrations[0]!.component).toBe('function')
    expect(typeof registrations[1]!.component).toBe('function')
    await release()
    expect(disposed).toEqual(['main', 'owner-console', 'sidebar.panellist', 'owner-console'])
    expect(unmount).toHaveBeenCalledOnce()
  })

  it('renders trend snapshots read-only: no input, and the only control re-reads an older page', () => {
    const item = { sequence: 3, sealedAt: 1_700_000_000_000, planId: 'plan', digest: 'd'.repeat(64), inputsDigest: 'b'.repeat(64),
      trendDigest: 'c'.repeat(64), window: { windowMs: 86_400_000, preWindows: 2, postWindows: 2, startExclusive: 1_699_800_000_000,
        endInclusive: 1_700_100_000_000, complete: false }, cohorts: { treatedSessions: 3, controlSessions: 4 },
      flags: ['partial-window'], strata: [
        { model: { state: 'frozen', provider: 'supplier', model: 'task-model' },
          differenceInDifferences: { status: 'estimated', estimate: 0.17, low: -0.27, high: 0.55 }, parallelTrend: 'not-flagged' },
        { model: { state: 'missing' }, differenceInDifferences: { status: 'insufficient' }, parallelTrend: 'untestable' }] }
    const page = { state: 'ok', causal: false, items: [item], nextBeforeSequence: 3 } as unknown as OwnerConsoleTrendSnapshots
    const older = vi.fn()
    const view = trendSnapshotsView(page, false, older)
    const types: unknown[] = [], buttons: Node[] = []
    walk(view, node => { types.push(node.type); if (node.type === 'button') buttons.push(node) })
    expect(types).not.toContain('input')
    expect(types).not.toContain('select')
    expect(types).not.toContain('textarea')
    expect(types).not.toContain('form')
    const rendered = text(view)
    expect(rendered).toContain('causal: false')
    expect(rendered).toContain('#3 · plan')
    expect(rendered).toContain('末窗未满')
    expect(rendered).toContain('supplier/task-model：DiD 0.170（95%：-0.270 ~ 0.550）')
    expect(rendered).toContain('模型未冻结：DiD 样本不足')
    expect(rendered).toContain('digest dddddddddddd')
    expect(buttons.map(button => text(button.props?.children))).toEqual(['更早的快照'])
    ;(buttons[0]!.props!['onClick'] as () => void)()
    expect(older).toHaveBeenCalledExactlyOnceWith(3)
    // Last page, failure, unverifiable and absent states render no controls at all.
    for (const [state, failed] of [[{ ...page, nextBeforeSequence: undefined }, false], [undefined, true],
      [{ state: 'unverifiable', causal: false, items: [] }, false], [{ state: 'absent', causal: false, items: [] }, false]] as const) {
      const found: Node[] = []
      walk(trendSnapshotsView(state as OwnerConsoleTrendSnapshots | undefined, failed, older), node => {
        if (node.type === 'button' || node.type === 'input') found.push(node)
      })
      expect(found).toEqual([])
    }
    expect(text(trendSnapshotsView({ state: 'unverifiable', causal: false, items: [] }, false, older))).toContain('未通过校验')
  })
  it('renders intake agreement read-only: counts and causal: false, a not-enabled state and no controls', () => {
    const outcomes = { pending: 1, delivered: 0, reacted: 1, accepted: 1, rejected: 1, 'expired-unhandled': 0, failed: 0 }
    const cell = { notifications: 4, items: 3, outcomes, agreed: 2, disagreed: 1, agreementPpm: 666_667 }
    const empty = { ...cell, notifications: 0, items: 0, agreed: 0, disagreed: 0, agreementPpm: null }
    const result = { state: 'ok', causal: false, summary: { fromNotifiedAt: 1_700_000_000_000, toNotifiedAt: 1_700_000_100_000, scanned: 6,
      truncated: true, provenanceAvailable: false, notIntake: 1, unresolved: 2, foreign: 1, intake: cell,
      byLevel: [{ level: 'notify', cell: empty }, { level: 'accept', cell }] } } as unknown as OwnerConsoleIntakeAgreement
    const view = intakeAgreementView(result, false)
    const found: Node[] = []
    walk(view, node => { if (['button', 'input', 'select', 'textarea', 'form'].includes(String(node.type))) found.push(node) })
    expect(found).toEqual([])
    const rendered = text(view)
    expect(rendered).toContain('causal: false')
    expect(rendered).toContain('[2023-11-14T22:13:20.000Z, 2023-11-14T22:15:00.000Z)')
    expect(rendered).toContain('吻合 2 / 不吻合 1 · 66.7%（通知 4，工作项 3）')
    expect(rendered).toContain('notify（通知）')
    expect(rendered).toContain('尚无已决结果')
    expect(rendered).toContain('已截断')
    expect(rendered).toContain('1 / 2 / 1')
    expect(rendered).toContain('WorkItems 未提供来源')
    expect(text(intakeAgreementView({ state: 'disabled', causal: false }, false))).toContain('未启用')
    expect(text(intakeAgreementView({ state: 'unverifiable', causal: false }, false))).toContain('未通过校验')
    expect(text(intakeAgreementView({ state: 'absent', causal: false }, false))).toContain('assistant-evaluation 未加载')
    expect(text(intakeAgreementView(undefined, true))).toContain('暂时无法读取')
    expect(text(intakeAgreementView(undefined, false))).toContain('workspace 与 preset')
  })
})
