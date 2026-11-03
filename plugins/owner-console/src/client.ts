import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { TYPERT_REMOTE } from './typert.js'
import type { OwnerConsoleStatus, OwnerConsoleWriteResult } from './typert.js'

/** The installed Host supplies remote and the slot registry. */
export const inject = ['remote', 'slots']

type RemoteResult<T> = Readonly<{ ok: true, value: T }> | Readonly<{ ok: false }>
type ConsoleRemote = Readonly<{
  status(): Promise<RemoteResult<OwnerConsoleStatus>>
  configureFeishu(mode: 'lark-cli' | 'app', appId: string, appSecretEnv: string,
    credentialHandle: string, account: string, tenant: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureTraex(enabled: boolean, command: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<RemoteResult<OwnerConsoleWriteResult>>
}>
type SlotRuntime = {
  readonly remote: Readonly<{ ownerConsole: ConsoleRemote }>
  readonly slots: {
    inject(name: string, factory: () => unknown): () => void
    register(options: unknown, component: unknown): () => void
  }
}
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  inject(dependencies: readonly string[], callback: (runtime: SlotRuntime) => unknown): { dispose(): Promise<void> }
}

type Props = Record<string, unknown>
const el = (tag: string, props: Props, ...children: readonly unknown[]) => children.length === 0
  ? jsx(tag as never, props as never)
  : jsx(tag as never, { ...props, children: children.length === 1 ? children[0] : children } as never)

const muted = 'var(--dsw-alias-label-primary-dimmed)'
const panelStyle = { padding: '24px', maxWidth: 760, margin: '0 auto', display: 'grid', gap: 16 }
const cardStyle = { border: '1px solid var(--dsw-alias-border-secondary)', borderRadius: 8, padding: 16 }
const inputStyle = { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary)', background: 'transparent', color: 'inherit', fontSize: 13 }
const buttonStyle = { ...inputStyle, cursor: 'pointer' }
const gridStyle = { display: 'grid', gap: 6 }

function row(label: string, value: string) {
  return el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '3px 0' } },
    el('span', { style: { color: muted } }, label), el('span', {}, value))
}

function card(title: string, ...body: readonly unknown[]) {
  return el('div', { style: cardStyle }, el('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, title), ...body)
}

function field(label: string, value: string, onChange: (next: string) => void, placeholder = '') {
  return el('label', { style: { display: 'grid', gap: 2, fontSize: 12, color: muted } },
    el('span', {}, label),
    el('input', { value, placeholder, style: inputStyle,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value) }))
}

function copyText(text: string): void {
  const clipboard = (globalThis as unknown as { navigator?: { clipboard?: { writeText(value: string): Promise<void> } } }).navigator?.clipboard
  void clipboard?.writeText(text).catch(() => undefined)
}

export function OwnerConsoleIcon() {
  return el('span', {
    'aria-hidden': true,
    style: { display: 'block', width: 18, height: 18, borderRadius: 4, border: '1px solid currentColor', textAlign: 'center', lineHeight: '16px', fontSize: 11 },
  }, '控')
}

export function OwnerConsolePanel({ remote }: Readonly<{ remote: ConsoleRemote }>) {
  const [status, setStatus] = useState<OwnerConsoleStatus>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [appId, setAppId] = useState('')
  const [secretEnv, setSecretEnv] = useState('LARK_APP_SECRET')
  const [secretHandle, setSecretHandle] = useState('')
  const [account, setAccount] = useState('')
  const [tenant, setTenant] = useState('')
  const [traexCommand, setTraexCommand] = useState('')
  const [bundleEntry, setBundleEntry] = useState('')
  const [bundleJson, setBundleJson] = useState('{}')

  const refresh = async () => {
    try {
      const result = await remote.status()
      if (result.ok) setStatus(result.value)
      else setError('Host 没有返回状态；请确认 settings 服务已加载。')
    } catch {
      setError('暂时无法读取状态，稍后重试。')
    }
  }
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])
  useEffect(() => { void refresh().catch(() => undefined) }, [])

  const run = async (action: () => Promise<RemoteResult<OwnerConsoleWriteResult>>) => {
    setBusy(true); setError('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) setError('Host 拒绝了这次操作，请检查输入。')
      else if (!result.value.applied) setError(result.value.note)
      else { setError(result.value.note); await refresh() }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const pending = status === undefined
  const feishuRows = pending
    ? el('p', { style: { margin: 0, color: muted } }, '…')
    : el('div', { style: gridStyle },
      row('方式', status.feishu.mode === 'lark-cli' ? '环境变量 secret（lark-cli 向导）' : 'keychain secret（直接配置）'),
      row('入口', status.feishu.entry ?? '未安装 lark-channel'),
      row('连接', status.feishu.connected ? '已加载' : '未连接'),
      row('appId', status.feishu.appIdConfigured ? '已配置' : '未配置'))
  const feishuActions = el('div', { style: { ...gridStyle, marginTop: 10 } },
    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
      field('appId（直接模式）', appId, setAppId, 'cli_0123456789abcdef'),
      field('secret 环境变量名', secretEnv, setSecretEnv, 'LARK_APP_SECRET'),
      field('或 keychain handle', secretHandle, setSecretHandle, 'lark-app-secret'),
      field('account', account, setAccount, '保留当前 owner'),
      field('tenant', tenant, setTenant, '保留当前 owner')),
    el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => void run(() => remote.configureFeishu('app', appId, secretEnv, '', account, tenant)) }, '应用配置'),
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => void run(() => remote.configureFeishu('lark-cli', '', secretEnv, '', account, tenant)) }, '一键配置（从 Host 环境探测 appId）'),
      el('button', { style: { ...buttonStyle, color: muted },
        onClick: () => copyText(status?.feishu.setupCommand ?? 'dsh-lark-setup') }, '复制向导命令')),
    el('p', { style: { margin: 0, fontSize: 12, color: muted } },
      `lark-cli 向导：${status?.feishu.setupCommand ?? 'dsh-lark-setup --profile web'}`))

  const traexRows = el('div', { style: gridStyle },
    row('入口', status?.traex.entry ?? '未安装 traex-acp-provider'),
    row('状态', status?.traex.enabled === true ? '已启用' : '未启用'),
    row('命令', status === undefined || status.traex.command === '' ? '（默认）' : status.traex.command),
    el('div', { style: { display: 'flex', gap: 8, alignItems: 'end' } },
      field('command（可选）', traexCommand, setTraexCommand, 'traex'),
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => void run(() => remote.configureTraex(true, traexCommand)) }, '启用'),
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => void run(() => remote.configureTraex(false, '')) }, '停用')))

  const bundleRows = pending
    ? el('p', { style: { margin: 0, color: muted } }, '…')
    : status.bundles.length === 0
      ? el('p', { style: { margin: 0, color: muted } }, '本 profile 中没有本项目的插件条目。')
      : el('div', { style: gridStyle }, ...status.bundles.map(item => row(item.entry, item.enabled ? '已启用' : '未启用')))
  const bundles = el('div', { style: gridStyle },
    bundleRows,
    el('p', { style: { margin: 0, fontSize: 12, color: muted } }, '只允许修改本项目的 dsh-enhanced 条目；合并写入，不重置其它字段。'),
    field('entry', bundleEntry, setBundleEntry, status?.bundles[0]?.entry ?? 'dsh-enhanced-...'),
    el('textarea', { value: bundleJson, rows: 5, style: { ...inputStyle, fontFamily: 'monospace', resize: 'vertical' },
      onChange: (event: { target: { value: string } }) => setBundleJson(event.target.value) }),
    el('button', { style: buttonStyle, disabled: busy, onClick: () => {
      try {
        const parsed = JSON.parse(bundleJson) as Readonly<Record<string, unknown>>
        void run(() => remote.configureBundle(bundleEntry, parsed))
      } catch { setError('配置必须是 JSON 对象') }
    } }, '应用配置'))

  return el('section', { 'aria-label': '主人控制台', style: panelStyle },
    el('h2', { style: { margin: 0, fontSize: 18 } }, '控制台'),
    el('p', { style: { margin: 0, fontSize: 13, color: muted } }, '只显示需要你处理的事。'),
    error === '' ? null : el('p', { role: 'alert', style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-danger)' } }, error),
    card('远程接入（飞书）', feishuRows, feishuActions),
    card('TraeX', traexRows),
    card('本项目插件管理', bundles))
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
    const injection = ctx.inject(['remote.ownerConsole', 'slots'], runtime => {
      const remote = runtime.remote.ownerConsole
      const panel = () => jsx(OwnerConsolePanel, { remote })
      const sidebar = runtime.slots.inject('sidebar.panellist', () => runtime.slots.register(
        { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: () => '控制台' }, OwnerConsoleIcon))
      const main = runtime.slots.inject('main', () => runtime.slots.register(
        { name: 'main', key: 'owner-console' }, panel))
      // Cordis effects accept a function: dispose the slot registrations in reverse order.
      return () => { main(); sidebar() }
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
