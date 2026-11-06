import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { TYPERT_REMOTE } from './typert.js'
import type { OwnerConsoleStatus, OwnerConsoleWriteResult } from './typert.js'

/** The installed Host supplies remote and the slot registry. */
export const inject = ['remote', 'slots']

type RemoteResult<T> = Readonly<{ ok: true, value: T }> | Readonly<{ ok: false }>
type ConsoleRemote = Readonly<{
  status(): Promise<RemoteResult<OwnerConsoleStatus>>
  configureFeishu(appId: string, appSecretEnv: string, credentialHandle: string,
    account: string, tenant: string, discoverAppId: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureTraex(enabled: boolean, command: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  configureBundle(entry: string, config: Readonly<Record<string, unknown>>): Promise<RemoteResult<OwnerConsoleWriteResult>>
  setBundleEnabled(name: string, enabled: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<RemoteResult<OwnerConsoleWriteResult>>
  installProjectBundle(spec: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
  removeProjectBundle(name: string): Promise<RemoteResult<OwnerConsoleWriteResult>>
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
  readonly get: <T>(name: string) => T | undefined
  inject(dependencies: readonly string[], callback: (runtime: SlotRuntime) => unknown): { dispose(): Promise<void> }
}

type Props = Record<string, unknown>
const el = (tag: string, props: Props, ...children: readonly unknown[]) => children.length === 0
  ? jsx(tag as never, props as never)
  : jsx(tag as never, { ...props, children: children.length === 1 ? children[0] : children } as never)

/** Only the reference the owner picked is submitted; the other stays empty. */
export function feishuSecretRefs(source: 'env' | 'handle', env: string,
  handle: string): Readonly<{ appSecretEnv: string, credentialHandle: string }> {
  return source === 'env' ? { appSecretEnv: env, credentialHandle: '' } : { appSecretEnv: '', credentialHandle: handle }
}

const LARK_CONNECTION_LABELS: Readonly<Record<OwnerConsoleStatus['feishu']['connection'], string>> = {
  absent: '未加载',
  unknown: '已加载，状态未知',
  connected: '已连接',
  'connected-with-gap': '已连接（期间有断档）',
  connecting: '连接中',
  disabled: '已停用',
  disconnected: '未连接',
  reconnecting: '重连中',
}

/** Read-only label for `larkChannel.health()`; the error code is shown as its stable identifier. */
export function larkConnectionLabel(connection: OwnerConsoleStatus['feishu']['connection'],
  lastErrorCode?: string): string {
  const label = LARK_CONNECTION_LABELS[connection]
  return lastErrorCode === undefined ? label : `${label}（最近错误：${lastErrorCode}）`
}

const OWN_PACKAGE = '@dsh-enhanced/owner-console'
const muted = 'var(--dsw-alias-label-primary-dimmed)'
/**
 * The Host main slot is a fixed-height pane; the panel owns its own vertical scroll so
 * the lower cards stay reachable on short windows. `minHeight: 0` lets a flex/grid
 * parent shrink this root below its content height instead of clipping it.
 */
export const scrollRootStyle = { height: '100%', minHeight: 0, flex: '1 1 auto', overflowY: 'auto', boxSizing: 'border-box' } as const
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

export function OwnerConsoleIcon() {
  return el('span', {
    'aria-hidden': true,
    style: { display: 'block', width: 18, height: 18, borderRadius: 4, border: '1px solid currentColor', textAlign: 'center', lineHeight: '16px', fontSize: 11 },
  }, '鳐')
}

export function OwnerConsolePanel({ remote, navigation }: Readonly<{
  remote: ConsoleRemote
  navigation: Readonly<{ openConversation(): void, openPlugins(): void }>
}>) {
  const [status, setStatus] = useState<OwnerConsoleStatus>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [appId, setAppId] = useState('')
  const [secretSource, setSecretSource] = useState<'env' | 'handle'>('env')
  const [secretEnv, setSecretEnv] = useState('LARK_APP_SECRET')
  const [secretHandle, setSecretHandle] = useState('')
  const [account, setAccount] = useState('')
  const [tenant, setTenant] = useState('')
  const [traexCommand, setTraexCommand] = useState('')
  const [bundleEntry, setBundleEntry] = useState('')
  const [bundleJson, setBundleJson] = useState('{}')
  const [installSpec, setInstallSpec] = useState('@dsh-enhanced/')

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
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { void refresh().catch(() => undefined) }, [])

  const run = async (action: () => Promise<RemoteResult<OwnerConsoleWriteResult>>) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await action()
      if (!mounted.current) return
      if (!result.ok) { setError('Host 拒绝了这次操作，请检查输入。'); return }
      if (!result.value.applied) { setError(result.value.note); return }
      // A persisted change can still need a profile restart; refresh the rows and
      // show the Host note as information, not as a failed action.
      setError(''); setNotice(result.value.note); await refresh()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const pending = status === undefined
  const larkReady = status !== undefined && status.feishu.entry !== undefined
  const feishuRows = pending
    ? el('p', { style: { margin: 0, color: muted } }, '…')
    : el('div', { style: gridStyle },
      row('方式', status.feishu.mode === 'env' ? '环境变量 secret' : 'keychain secret'),
      row('入口', status.feishu.entry ?? (status.feishu.installed ? 'lark-channel 已安装但未启用' : '未安装 lark-channel')),
      row('连接', larkConnectionLabel(status.feishu.connection, status.feishu.lastErrorCode)),
      row('appId', status.feishu.appIdConfigured ? '已配置' : '未配置'))
  const installLark = status !== undefined && !status.feishu.installed && status.feishu.entry === undefined
    ? el('button', { style: buttonStyle, disabled: busy,
      onClick: () => void run(() => remote.installProjectBundle('@dsh-enhanced/lark-channel')) },
    '安装 lark-channel（含依赖）')
    : null
  const enableLark = status !== undefined && status.feishu.installed && status.feishu.entry === undefined
    ? el('button', { style: buttonStyle, disabled: busy,
      onClick: () => void run(() => remote.setBundleEnabled('@dsh-enhanced/lark-channel', true)) },
    '启用 lark-channel')
    : null
  const feishuActions = !larkReady && !installLark && !enableLark
    ? null
    : el('div', { style: { ...gridStyle, marginTop: 10 } },
      installLark, enableLark,
      ...(larkReady ? [
    el('div', { style: { display: 'flex', gap: 12, fontSize: 13 }, role: 'radiogroup', 'aria-label': 'secret 引用方式' },
      el('label', {}, el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'env',
        onChange: () => setSecretSource('env') }), ' 环境变量'),
      el('label', {}, el('input', { type: 'radio', name: 'secret-source', checked: secretSource === 'handle',
        onChange: () => setSecretSource('handle') }), ' keychain handle')),
    el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 } },
      field('appId', appId, setAppId, 'cli_0123456789abcdef'),
      secretSource === 'env'
        ? field('secret 环境变量名', secretEnv, setSecretEnv, 'LARK_APP_SECRET')
        : field('keychain handle', secretHandle, setSecretHandle, 'lark-app-secret'),
      field('account', account, setAccount, '保留当前 owner'),
      field('tenant', tenant, setTenant, '保留当前 owner')),
    el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => {
          const refs = feishuSecretRefs(secretSource, secretEnv, secretHandle)
          void run(() => remote.configureFeishu(appId, refs.appSecretEnv, refs.credentialHandle, account, tenant, false))
        } }, '应用配置'),
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => {
          const refs = feishuSecretRefs(secretSource, secretEnv, secretHandle)
          void run(() => remote.configureFeishu('', refs.appSecretEnv, refs.credentialHandle, account, tenant, true))
        } }, '一键配置（从 Host 环境探测 appId）')),
    el('p', { style: { margin: 0, fontSize: 12, color: muted } },
      '这里配置的是 lark-channel 通道；secret 只接受环境变量名或 keychain handle，明文不入配置。')] : []))

  const traexReady = status !== undefined && status.traex.entry !== undefined
  const traexRows = el('div', { style: gridStyle },
    row('入口', status?.traex.entry ?? (status?.traex.installed ? 'traex-acp-provider 已安装但未启用' : '未安装 traex-acp-provider')),
    row('状态', status?.traex.enabled === true ? '已启用' : '未启用'),
    row('命令', status === undefined || status.traex.command === '' ? '（默认）' : status.traex.command),
    traexReady
      ? el('div', { style: { display: 'flex', gap: 8, alignItems: 'end' } },
        field('command（可选）', traexCommand, setTraexCommand, 'traex'),
        el('button', { style: buttonStyle, disabled: busy,
          onClick: () => void run(() => remote.configureTraex(true, traexCommand)) }, '启用'),
        el('button', { style: buttonStyle, disabled: busy,
          onClick: () => void run(() => remote.configureTraex(false, '')) }, '停用'))
      : status === undefined
        ? el('p', { style: { margin: 0, color: muted } }, '…')
        : !status.traex.installed
          ? el('button', { style: buttonStyle, disabled: busy,
            onClick: () => void run(() => remote.installProjectBundle('@dsh-enhanced/traex-acp-provider')) },
          '安装 traex-acp-provider（含依赖）')
          : el('button', { style: buttonStyle, disabled: busy,
            onClick: () => void run(() => remote.setBundleEnabled('@dsh-enhanced/traex-acp-provider', true)) },
          '启用 traex-acp-provider'))

  const bundleRows = pending
    ? el('p', { style: { margin: 0, color: muted } }, '…')
    : status.bundles.length === 0
      ? el('p', { style: { margin: 0, color: muted } }, '本 profile 中没有本项目的 bundle。')
      : el('div', { style: gridStyle }, ...status.bundles.map(bundle => el('div', {
        style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
        el('span', {}, `${bundle.name}${bundle.version === undefined ? '' : ` @${bundle.version}`}${bundle.installed ? '' : '（未安装）'}`),
        el('button', { style: buttonStyle, disabled: busy,
          onClick: () => void run(() => remote.setBundleEnabled(bundle.name, !bundle.enabled)) },
        bundle.enabled ? '停用' : '启用'),
        bundle.removable && bundle.name !== OWN_PACKAGE
          ? el('button', { style: { ...buttonStyle, color: 'var(--dsw-alias-label-danger)' }, disabled: busy,
            onClick: () => {
              const ask = (globalThis as unknown as { confirm?: (message: string) => boolean }).confirm
              // Without a confirmation channel the panel never performs the destructive step.
              if (ask !== undefined && ask(`移除 ${bundle.name}？重新安装可用面板的安装入口。`)) {
                void run(() => remote.removeProjectBundle(bundle.name))
              }
            } }, '移除')
          : null)))
  const pluginRows = pending || status.plugins.length === 0
    ? el('p', { style: { margin: 0, color: muted } }, pending ? '…' : '没有已加载的本项目插件条目。')
    : el('div', { style: gridStyle }, ...status.plugins.map(plugin => el('div', {
      style: { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' } },
      el('span', { style: { fontSize: 12 } }, `${plugin.moduleName} · ${plugin.entryId} · ${plugin.fiberPhase ?? 'null'}`),
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => void run(() => remote.setPluginEnabled(plugin.entryId, !plugin.enabled)) },
      plugin.enabled ? '禁用' : '启用'))))
  const bundles = el('div', { style: gridStyle },
    el('h4', { style: { margin: 0, fontSize: 13 } }, 'Bundle 层'),
    bundleRows,
    el('h4', { style: { margin: '6px 0 0', fontSize: 13 } }, '已加载条目'),
    pluginRows,
    el('div', { style: { display: 'flex', gap: 8, alignItems: 'end' } },
      field('安装本项目 bundle（含依赖）', installSpec, setInstallSpec, '@dsh-enhanced/plugin-name'),
      el('button', { style: buttonStyle, disabled: busy,
        onClick: () => void run(() => remote.installProjectBundle(installSpec)) }, '安装')),
    el('p', { style: { margin: 0, fontSize: 12, color: muted } }, '安装使用 DSH 自身的 pnpm 路径，会一并安装该包声明的依赖；安装/启用后如提示需要重启 profile，请依提示操作。'),
    el('details', { style: { marginTop: 6 } },
      el('summary', { style: { fontSize: 12, color: muted } }, '高级：合并配置（只对声明了 live 字段的条目生效）'),
      field('entry', bundleEntry, setBundleEntry, 'dsh-enhanced-...'),
      el('textarea', { value: bundleJson, rows: 4, style: { ...inputStyle, fontFamily: 'monospace', resize: 'vertical', marginTop: 6 },
        onChange: (event: { target: { value: string } }) => setBundleJson(event.target.value) }),
      el('button', { style: { ...buttonStyle, marginTop: 6 }, disabled: busy, onClick: () => {
        try {
          const parsed = JSON.parse(bundleJson) as Readonly<Record<string, unknown>>
          void run(() => remote.configureBundle(bundleEntry, parsed))
        } catch { setError('配置必须是 JSON 对象') }
      } }, '应用配置')))

  return el('section', { 'aria-label': '文鳐（主人控制台）', style: panelStyle },
    el('div', {},
      el('h2', { style: { margin: 0, fontSize: 18 } }, '文鳐 Ray'),
      el('p', { style: { margin: '2px 0 0', fontSize: 12, color: muted } }, '你的个人助手小鳐 · 小鳐小鳐，从游到飞')),
    el('p', { style: { margin: 0, fontSize: 13, color: muted } }, '只显示需要你处理的事；需要直接对话时从这里进入。'),
    el('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      el('button', { style: buttonStyle, onClick: () => navigation.openConversation() }, '开始对话'),
      el('button', { style: { ...buttonStyle, color: muted }, onClick: () => navigation.openPlugins() }, '打开插件页')),
    error === '' ? null : el('p', { role: 'alert', style: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-danger)' } }, error),
    notice === '' ? null : el('p', { role: 'status', style: { margin: 0, fontSize: 12, color: muted } }, notice),
    card('远程接入（飞书）', feishuRows, feishuActions),
    card('TraeX', traexRows),
    card('本项目插件管理', bundles))
}

/** Main-slot root: a scroll container around the panel. */
export function OwnerConsoleMain(props: Parameters<typeof OwnerConsolePanel>[0]) {
  return el('div', { 'data-owner-console-scroll': '', style: scrollRootStyle }, jsx(OwnerConsolePanel, props))
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
    // Core registration depends only on the remote namespace and the slot registry;
    // navigation services are resolved lazily so an embedding without them still
    // gets the sidebar entry and status page.
    const injection = ctx.inject(['remote.ownerConsole', 'slots'], runtime => {
      const remote = runtime.remote.ownerConsole
      const navigation = {
        openConversation: () => {
          try {
            ctx.get<{ startSession(): void }>('uiWorkspace')?.startSession()
          } catch { /* native shell only; a missing workspace is not an error here */ }
        },
        openPlugins: () => {
          try {
            ctx.get<{ selectPanel(panelId: string): void }>('layout')?.selectPanel('plugins')
          } catch { /* the native plugins page may not be registered in an embedding */ }
        },
      }
      const panel = () => jsx(OwnerConsoleMain, { remote, navigation })
      const sidebar = runtime.slots.inject('sidebar.panellist', () => runtime.slots.register(
        { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: () => '文鳐' }, OwnerConsoleIcon))
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
