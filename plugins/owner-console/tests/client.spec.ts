import { describe, expect, it, vi } from 'vitest'
import { TYPERT_REMOTE } from '../src/typert.ts'
import { apply, askOwner, boundedLine, confirmationNotice, feishuSecretRefs, fiberState, installWithApproval,
  installWithCompanions, intakeAgreementHistoryView, intakeAgreementView, larkConnectionLabel, remoteFailureText,
  trendSnapshotsView } from '../src/client.ts'
import type { OwnerConsoleIntakeAgreement, OwnerConsoleIntakeAgreementHistory, OwnerConsoleTrendSnapshots } from '../src/typert.ts'

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
              return () => { disposed.push(String(options['id'] ?? options['key'] ?? options['name'])) }
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

  it('retries an install only with the Host-recorded build names, and only after confirmation', async () => {
    type Write = { applied: boolean, entry: string, note: string, pendingBuilds?: readonly string[] }
    const result = (value: Write) => ({ ok: true as const, value })
    const install = vi.fn()
      .mockResolvedValueOnce(result({ applied: false, entry: 'spec', note: 'blocked', pendingBuilds: ['protobufjs@7.6.6'] }))
      .mockResolvedValueOnce(result({ applied: true, entry: 'spec', note: 'done' }))
    const confirm = vi.fn(() => true)
    await expect(installWithApproval({ installProjectBundle: install }, '@dsh-enhanced/lark-channel', confirm))
      .resolves.toMatchObject({ ok: true, value: { applied: true } })
    expect(confirm).toHaveBeenCalledExactlyOnceWith('安装需要允许这些依赖运行构建脚本：protobufjs@7.6.6。允许并重试？')
    expect(install.mock.calls).toEqual([
      ['@dsh-enhanced/lark-channel', []],
      ['@dsh-enhanced/lark-channel', ['protobufjs@7.6.6']],
    ])
    // A declined confirmation or a failure that recorded no name never retries.
    const denied = vi.fn(async () => result({ applied: false, entry: 'spec', note: 'blocked', pendingBuilds: ['esbuild@1'] }))
    await expect(installWithApproval({ installProjectBundle: denied }, '@dsh-enhanced/lark-channel', () => false))
      .resolves.toMatchObject({ ok: true, value: { applied: false } })
    expect(denied).toHaveBeenCalledOnce()
    const unrecorded = vi.fn(async () => result({ applied: false, entry: 'spec', note: 'blocked' }))
    await installWithApproval({ installProjectBundle: unrecorded }, '@dsh-enhanced/lark-channel', () => true)
    expect(unrecorded).toHaveBeenCalledOnce()
    const applied = vi.fn(async () => result({ applied: true, entry: 'spec', note: 'done' }))
    await installWithApproval({ installProjectBundle: applied }, '@dsh-enhanced/lark-channel', () => true)
    expect(applied).toHaveBeenCalledOnce()
    const refused = vi.fn(async () => ({ ok: false as const }))
    await expect(installWithApproval({ installProjectBundle: refused }, '@dsh-enhanced/lark-channel', () => true))
      .resolves.toEqual({ ok: false })
    expect(refused).toHaveBeenCalledOnce()
  })

  it('installs activation-critical companions before the requested bundle', async () => {
    const install = vi.fn(async (spec: string) => ({ ok: true as const, value: { applied: true, entry: spec, note: 'done' } }))
    await expect(installWithCompanions({ installProjectBundle: install }, '@dsh-enhanced/lark-channel',
      ['@dsh-enhanced/assistant-delivery'], () => true))
      .resolves.toMatchObject({ ok: true, value: { applied: true } })
    expect(install.mock.calls).toEqual([
      ['@dsh-enhanced/assistant-delivery', []],
      ['@dsh-enhanced/lark-channel', []],
    ])
    // A failed companion stops the chain; the requested bundle is never attempted.
    const failing = vi.fn(async (spec: string) => spec === '@dsh-enhanced/assistant-delivery'
      ? { ok: true as const, value: { applied: false, entry: spec, note: 'blocked' } }
      : { ok: true as const, value: { applied: true, entry: spec, note: 'done' } })
    await expect(installWithCompanions({ installProjectBundle: failing }, '@dsh-enhanced/lark-channel',
      ['@dsh-enhanced/assistant-delivery'], () => true))
      .resolves.toMatchObject({ ok: true, value: { applied: false } })
    expect(failing).toHaveBeenCalledOnce()
    // No companions still installs exactly the requested bundle.
    const direct = vi.fn(async (spec: string) => ({ ok: true as const, value: { applied: true, entry: spec, note: 'done' } }))
    await installWithCompanions({ installProjectBundle: direct }, '@dsh-enhanced/lark-channel', [], () => true)
    expect(direct).toHaveBeenCalledExactlyOnceWith('@dsh-enhanced/lark-channel', [])
  })

  it('surfaces the gateway failure code and message instead of one generic sentence', () => {
    expect(remoteFailureText({ code: 'gateway/internal', message: 'settings namespace "x" changed since it was read' }))
      .toBe('gateway/internal：settings namespace "x" changed since it was read')
    expect(remoteFailureText({ code: 'gateway/internal', message: 'y'.repeat(1_000) }).length).toBeLessThan(650)
    expect(remoteFailureText(undefined)).toContain('未说明的拒绝')
    expect(remoteFailureText({ code: '', message: '' })).toContain('未说明的拒绝')
    expect(boundedLine('a\n b\t c', 10)).toBe('a b c')
    expect(boundedLine('abcdefghijk', 4)).toBe('abcd…')
  })

  it('makes an unavailable or declined confirmation visible, never silent', () => {
    expect(askOwner(undefined, 'remove?')).toBe('unavailable')
    expect(askOwner(() => false, 'remove?')).toBe('declined')
    expect(askOwner(() => true, 'remove?')).toBe('approved')
    expect(confirmationNotice('unavailable', '移除 x？')).toContain('没有确认对话框')
    expect(confirmationNotice('unavailable', '移除 x？')).toContain('移除 x？')
    expect(confirmationNotice('declined', '移除 x？')).toBe('已取消操作')
    expect(confirmationNotice('approved', '移除 x？')).toBeUndefined()
  })

  it('reports fiber activity rather than the persisted enable flag', () => {
    expect(fiberState('active', true)).toEqual({ label: '已加载', tone: 'ok' })
    expect(fiberState('failed', true)).toEqual({ label: '加载失败', tone: 'error' })
    expect(fiberState('pending', true)).toEqual({ label: '等待依赖服务', tone: 'warn' })
    expect(fiberState('loading', true)).toEqual({ label: '加载中', tone: 'warn' })
    expect(fiberState('unloading', true)).toEqual({ label: '卸载中', tone: 'neutral' })
    expect(fiberState(null, true)).toEqual({ label: '已启用未启动', tone: 'warn' })
    expect(fiberState(null, false)).toEqual({ label: '已停用', tone: 'neutral' })
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
      { name: 'main', key: 'owner-console',
        children: { 'owner-console.conversation': { kind: 'single', scope: 'session' } } },
      { name: 'owner-console.conversation' },
    ])
    expect(typeof registrations[0]!.component).toBe('function')
    expect(typeof registrations[1]!.component).toBe('function')
    expect(typeof registrations[2]!.component).toBe('function')
    await release()
    expect(disposed).toEqual(['owner-console.conversation', 'owner-console.conversation',
      'main', 'owner-console', 'sidebar.panellist', 'owner-console'])
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
  it('renders persisted intake agreement history read-only with labeled levels and no controls', () => {
    const outcomes = { pending: 1, delivered: 0, reacted: 1, accepted: 1, rejected: 1, 'expired-unhandled': 0, failed: 0 }
    const cell = { notifications: 4, items: 3, outcomes, agreed: 2, disagreed: 1, agreementPpm: 666_667 }
    const empty = { ...cell, notifications: 0, items: 0, agreed: 0, disagreed: 0, agreementPpm: null }
    const snapshot = { fromNotifiedAt: 1_700_000_000_000, toNotifiedAt: 1_700_000_100_000, computedAt: 1_700_000_050_000,
      windowMs: 60_000, scanLimit: 1_000, truncated: true, provenanceAvailable: true, notIntake: 1, unresolved: 2, foreign: 1,
      intake: cell, byLevel: [{ level: 'notify', cell: empty }, { level: 'accept', cell }] }
    const history = { state: 'ok', causal: false, snapshots: [snapshot] } as unknown as OwnerConsoleIntakeAgreementHistory
    const view = intakeAgreementHistoryView(history, false)
    const controls: Node[] = []
    walk(view, node => { if (['button', 'input', 'select', 'textarea', 'form'].includes(String(node.type))) controls.push(node) })
    expect(controls).toEqual([])
    const rendered = text(view)
    expect(rendered).toContain('causal: false')
    expect(rendered).toContain('窗口 [2023-11-14T22:13:20.000Z, 2023-11-14T22:15:00.000Z)')
    expect(rendered).toContain('观察于 2023-11-14T22:14:10.000Z')
    expect(rendered).toContain('扫描上限 1000')
    expect(rendered).toContain('扫描已截断')
    expect(rendered).toContain('notify（通知）')
    expect(rendered).toContain('accept（准入）')
    expect(rendered).toContain('吻合 2 / 不吻合 1 · 66.7%（通知 4，工作项 3）')
    expect(rendered).toContain('非 intake / 无法判断 / 他 scope：1 / 2 / 1')
    expect(text(intakeAgreementHistoryView({ state: 'disabled', causal: false }, false))).toContain('未启用')
    expect(text(intakeAgreementHistoryView({ state: 'unverifiable', causal: false }, false))).toContain('未通过校验')
    expect(text(intakeAgreementHistoryView({ state: 'absent', causal: false }, false))).toContain('assistant-evaluation 未加载')
    expect(text(intakeAgreementHistoryView({ state: 'ok', causal: false, snapshots: [] }, false))).toContain('还没有持久化')
    expect(text(intakeAgreementHistoryView(undefined, true))).toContain('暂时无法读取')
    expect(text(intakeAgreementHistoryView(undefined, false))).toContain('读取后')
  })
})
