import { useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { KAI_FONT } from './art.js'
import { TYPERT_REMOTE } from './typert.js'
import {
  WENYAO_BACKDROP_DATA_URI, WENYAO_BACKDROP_HEIGHT, WENYAO_BACKDROP_WIDTH,
  WENYAO_HERO_DATA_URI, WENYAO_HERO_HEIGHT, WENYAO_HERO_WIDTH, WENYAO_ICON_DATA_URI, WENYAO_SEAL_DATA_URI,
} from './artwork.js'
import type { OwnerConsoleStatus } from './typert.js'
import { OwnerConsoleChat, OwnerConsoleConversation, type OwnerConsoleRendererSeat } from './chat-view.js'
import {
  browserLang, browserSpeechRecognition, browserSpeechSynthesisAvailable, browserStorage, speakInBrowser,
  type ChatRuntime, type ChatSessions, type ChatUploads, type PermissionCatalog,
} from './chat.js'
import {
  actionsStyle, backdropImageStyle, backdropStyle, border, buttonStyle, caption, el, hairline,
  ink, muted, primaryButtonStyle, surface,
} from './ui.js'
import {
  AutonomyWizardCard, BundleConfigSlotView, BundlesCard, CodingToolsCard, DREAMING_PACKAGE, DreamingCard,
  FeishuCard, GeneralCodingToolItem, GROWTH_PACKAGE, GrowthMemoryCard, IntakeAgreementCard, LARK_PACKAGE,
  MEMORY_LEARNING_PACKAGE, ModelsCodingAgentsFooter, PROACTIVE_PACKAGE, ProactiveWorkItemsCard,
  SelfUpgradeCard, StatusBanners, TRAEX_PACKAGE, TrendSnapshotsCard, useConsoleActions, WenyaoSectionIcon,
  WenyaoSettingsSection, type ConsoleRemote, type OwnerConsoleNavigation,
} from './settings-cards.js'

export {
  askOwner, AutonomyWizardCard, boundedLine, confirmationNotice, feishuSecretRefs, fiberState, installWithApproval,
  installWithCompanions, intakeAgreementHistoryView, intakeAgreementView, intakeAvailabilityPill,
  IntakeAgreementCard, larkConnectionLabel, larkConnectionTone, remoteFailureText, SelfUpgradeCard, trendSnapshotsView,
  TrendSnapshotsCard, BundleConfigSlotView, BundlesCard, CodingToolsCard, DreamingCard, FeishuCard,
  GeneralCodingToolItem, GrowthMemoryCard, ModelsCodingAgentsFooter, ProactiveWorkItemsCard,
  WenyaoSectionIcon, WenyaoSettingsSection,
} from './settings-cards.js'
export type { ConsoleRemote, OwnerConsoleNavigation } from './settings-cards.js'
export type { StatusTone } from './ui.js'

const BUNDLE_CONFIG_SLUGS = [
  TRAEX_PACKAGE,
  LARK_PACKAGE,
  PROACTIVE_PACKAGE,
  DREAMING_PACKAGE,
  GROWTH_PACKAGE,
  MEMORY_LEARNING_PACKAGE,
] as const

const settingsSectionStyle = { position: 'relative', isolation: 'isolate', height: '100%', minHeight: 0 } as const
const settingsScrollStyle = { position: 'relative', zIndex: 1, height: '100%', overflowY: 'auto', boxSizing: 'border-box' } as const
const panelStyle = { padding: '28px 24px 40px', maxWidth: 840, margin: '0 auto', display: 'grid', gap: 16, color: ink,
  fontSize: 13, lineHeight: 1.5 } as const
const mainRootStyle = { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
  boxSizing: 'border-box' } as const

/** The installed Host supplies remote and the slot registry. */
export const inject = ['remote', 'slots']

type SlotRuntime = {
  readonly remote: Readonly<{ ownerConsole: ConsoleRemote }>
  readonly slots: {
    inject(name: string, factory: () => unknown): () => void
    register(options: unknown, component: unknown): () => void
  }
}
type PermissionPresetsRemote = Readonly<{ catalog(): Promise<import('./settings-cards.js').RemoteResult<PermissionCatalog>> }>
type ClientContext = {
  readonly remote: { readonly $mount: (value: unknown) => Promise<() => Promise<void>> }
  readonly get: <T>(name: string) => T | undefined
  inject(dependencies: readonly string[], callback: (runtime: SlotRuntime) => unknown): { dispose(): Promise<void> }
}

/** Sidebar entry: the 02 水墨化鹏 fish-and-peng mark, cropped square and shown as a round avatar. */
export function OwnerConsoleIcon() {
  return el('span', { 'aria-hidden': true, style: { display: 'block', width: 18, height: 18, borderRadius: '50%', overflow: 'hidden', flex: 'none' } },
    el('img', { src: WENYAO_ICON_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false, 'data-owner-console-art': 'sidebar-icon',
      width: 18, height: 18, style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' } }))
}

/** The main-slot panel: chat by default, with the configuration console behind the gear.
 * The renderer's seats arrive as top-level props (no package import); in their absence the
 * compact self-contained chat is the fallback. */
export type OwnerConsolePanelProps = OwnerConsoleRendererSeat & Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
  runtime: ChatRuntime
}>

export function OwnerConsolePanel({ remote, navigation, runtime, ...renderer }: OwnerConsolePanelProps) {
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  return view === 'chat'
    ? jsx(OwnerConsoleChat, { runtime, onOpenSettings: () => setView('settings'), renderer })
    : jsx(OwnerConsoleSettingsPanel, { remote, navigation, onBack: () => setView('chat') })
}

/** The existing configuration console, unified with DSH left-sidebar settings via `settings-cards.ts`. */
export function OwnerConsoleSettingsPanel({ remote, navigation, onBack }: Readonly<{
  remote: ConsoleRemote
  navigation: OwnerConsoleNavigation
  onBack?: () => void
}>) {
  // Keep `status` as the very first useState so hook-order render tests can seed it deterministically.
  const [status, setStatus] = useState<OwnerConsoleStatus>()
  const ctrl = useConsoleActions(remote, navigation, status, setStatus)

  return el('section', { 'data-owner-console-settings': '', 'aria-label': '文鳐设置（主人控制台）', style: settingsSectionStyle },
    el('div', { style: backdropStyle },
      el('img', { src: WENYAO_BACKDROP_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false,
        'data-owner-console-art': 'backdrop', width: WENYAO_BACKDROP_WIDTH, height: WENYAO_BACKDROP_HEIGHT,
        style: backdropImageStyle })),
    el('div', { 'data-owner-console-settings-scroll': '', style: settingsScrollStyle },
      el('div', { 'data-owner-console-content': '', style: panelStyle },
        onBack === undefined ? null : el('div', { 'data-owner-console-settings-bar': '',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        el('button', { type: 'button', style: buttonStyle, onClick: onBack, 'aria-label': '返回对话' }, '← 返回对话'),
        el('h2', { style: { margin: 0, fontSize: 13, fontWeight: 600, color: muted } }, '设置')),
        header(navigation),
        jsx(StatusBanners, { ctrl }),
        jsx(AutonomyWizardCard, { ctrl }),
        jsx(SelfUpgradeCard, { ctrl }),
        jsx(FeishuCard, { ctrl }),
        jsx(CodingToolsCard, { ctrl }),
        jsx(DreamingCard, { ctrl }),
        jsx(ProactiveWorkItemsCard, { ctrl }),
        jsx(GrowthMemoryCard, { ctrl }),
        jsx(BundlesCard, { ctrl }),
        jsx(TrendSnapshotsCard, { remote }),
        jsx(IntakeAgreementCard, { remote, availability: status?.evaluation.intakeAgreement }))))
}

function header(navigation: OwnerConsoleNavigation) {
  return el('header', { 'data-owner-console-header': '', style: { overflow: 'hidden', borderRadius: 16,
    border: `1px solid ${border}`, color: ink, background: surface, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)' } },
  el('img', { src: WENYAO_HERO_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false, 'data-owner-console-art': 'hero',
    width: WENYAO_HERO_WIDTH, height: WENYAO_HERO_HEIGHT,
    style: { display: 'block', width: '100%', height: 'auto', aspectRatio: `${WENYAO_HERO_WIDTH} / ${WENYAO_HERO_HEIGHT}`,
      minHeight: 108, maxHeight: 300, objectFit: 'cover', objectPosition: 'center', borderBottom: `1px solid ${hairline}` } }),
  el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px 18px' } },
    el('div', { style: { display: 'grid', gap: 4, minWidth: 0, flex: '1 1 280px' } },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        el('h2', { style: { margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1.25 } }, '文鳐 Ray'),
        el('img', { src: WENYAO_SEAL_DATA_URI, alt: '', 'aria-hidden': 'true', draggable: false, 'data-owner-console-art': 'seal',
          width: 30, height: 30, style: { display: 'block', width: 30, height: 30, borderRadius: '50%', objectFit: 'cover', flex: 'none' } })),
      el('p', { style: { margin: 0, fontSize: 13, color: muted, fontFamily: KAI_FONT, letterSpacing: '0.04em' } }, '你的个人助手小鳐 · 小鳐小鳐，游而化飞'),
      el('p', { style: { margin: '2px 0 0', fontSize: 12, color: caption } }, '只显示需要你处理的事；需要直接对话时从这里进入。')),
    el('div', { style: actionsStyle },
      el('button', { style: { ...primaryButtonStyle, padding: '8px 18px', fontSize: 14 }, onClick: () => navigation.openConversation() }, '开始对话'),
      el('button', { style: buttonStyle, onClick: () => navigation.openPlugins() }, '打开插件页'))))
}

/** Main-slot root: fills the fixed-height Host pane; each view owns its own scrolling. */
export function OwnerConsoleMain(props: OwnerConsolePanelProps) {
  return el('div', { 'data-owner-console-scroll': '', style: mainRootStyle }, jsx(OwnerConsolePanel, props))
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  try {
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
      const chatRuntime: ChatRuntime = {
        sessions: () => ctx.get<ChatSessions>('sessions'),
        fileUploads: () => ctx.get<ChatUploads>('fileUpload'),
        permissionCatalog: () => {
          try {
            const presets = ctx.get<PermissionPresetsRemote>('remote.permissionPresets')
            if (presets === undefined || typeof presets.catalog !== 'function') return undefined
            return presets.catalog()
          } catch {
            return undefined
          }
        },
        openNativeSession: sessionId => {
          try {
            const workspace = ctx.get<{ openSession(id: string): void }>('uiWorkspace')
            if (workspace === undefined || typeof workspace.openSession !== 'function') return false
            workspace.openSession(sessionId)
            return true
          } catch {
            return false
          }
        },
        startConversation: () => navigation.openConversation(),
        storage: () => browserStorage(),
        voiceAvailable: () => browserSpeechRecognition() !== undefined,
        createRecognition: () => {
          const Recognition = browserSpeechRecognition()
          return Recognition === undefined ? undefined : new Recognition()
        },
        recognitionLang: () => browserLang(),
        speakAvailable: () => browserSpeechSynthesisAvailable(),
        speak: text => speakInBrowser(text),
        createSession: async () => {
          const sessions = ctx.get<ChatSessions>('sessions')
          if (sessions === undefined) throw new Error('会话服务不可用')
          let workspaceId: string | undefined
          try {
            const workspaces = ctx.get<{
              initializeDefault(signal?: AbortSignal): Promise<Readonly<{ workspaceId?: string }> | undefined>
            }>('workspaces')
            workspaceId = (await workspaces?.initializeDefault())?.workspaceId
          } catch {
            // The default Workspace is optional; fall through to the Host default cwd.
          }
          if (workspaceId === undefined || workspaceId === '') return await sessions.create()
          try {
            const workspace = ctx.get<{ connectWorkspace?(id: string): Promise<string> }>('uiWorkspace')
            if (typeof workspace?.connectWorkspace === 'function') return await workspace.connectWorkspace(workspaceId)
          } catch {
            // Unknown workspace or absent seat: create the grouped Session directly.
          }
          return await sessions.create({ workspaceId })
        },
        insertDraft: (reference, text) => {
          if (reference.binding.ctx === undefined) return false
          try {
            const conversation = ctx.get<{
              input?: {
                for(actx: unknown): {
                  state?: { getSnapshot(): Readonly<{ draft?: string }> }
                  setDraft(value: string): void
                  focus?(): void
                }
              }
            }>('conversation')
            const facade = conversation?.input?.for(reference.binding.ctx)
            if (facade === undefined) return false
            if (typeof facade.state?.getSnapshot !== 'function') return false
            const draft = facade.state.getSnapshot().draft ?? ''
            facade.setDraft(draft === '' ? text : `${draft} ${text}`)
            facade.focus?.()
            return true
          } catch {
            return false
          }
        },
      }

      const panel = (seats: Readonly<Record<string, unknown>>) =>
        jsx(OwnerConsoleMain, { ...seats, remote, navigation, runtime: chatRuntime })
      const settingsSection = (props: Readonly<{ close?: () => void }>) =>
        jsx(WenyaoSettingsSection, { ...props, remote, navigation })
      const sectionIcon = (props: Readonly<{ size?: number; active?: boolean }>) =>
        jsx(WenyaoSectionIcon, props)
      const generalCodingTool = () =>
        jsx(GeneralCodingToolItem, { remote, navigation })
      const modelsFooter = () =>
        jsx(ModelsCodingAgentsFooter, { remote, navigation })

      const disposers = [
        runtime.slots.inject('sidebar.panellist', () => runtime.slots.register(
          { name: 'sidebar.panellist', id: 'owner-console', order: 30, label: () => '文鳐' }, OwnerConsoleIcon)),
        runtime.slots.inject('main', () => runtime.slots.register(
          { name: 'main', key: 'owner-console',
            children: { 'owner-console.conversation': { kind: 'single', scope: 'session' } } }, panel)),
        runtime.slots.inject('owner-console.conversation', () => runtime.slots.register(
          { name: 'owner-console.conversation' }, OwnerConsoleConversation)),
        runtime.slots.inject('settings.section', () => runtime.slots.register(
          { name: 'settings.section', id: 'wenyao-assistant', order: 12, label: () => '文鳐助手' }, settingsSection)),
        runtime.slots.inject('settings.section.icon', () => runtime.slots.register(
          { name: 'settings.section.icon', id: 'wenyao-assistant' }, sectionIcon)),
        runtime.slots.inject('settings.general.item', () => runtime.slots.register(
          { name: 'settings.general.item', id: 'wenyao-coding-tool', order: 20 }, generalCodingTool)),
        runtime.slots.inject('settings.models.footer', () => runtime.slots.register(
          { name: 'settings.models.footer', id: 'wenyao-coding-agents', order: 20 }, modelsFooter)),
        ...BUNDLE_CONFIG_SLUGS.map(packageName => runtime.slots.inject('plugins.bundle.config', () => runtime.slots.register(
          { name: 'plugins.bundle.config', key: packageName },
          (props: Readonly<{ view?: 'summary' | 'page' }>) =>
            jsx(BundleConfigSlotView, { packageName, view: props?.view, remote, navigation })))),
      ]
      return () => {
        for (const dispose of [...disposers].reverse()) dispose()
      }
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
