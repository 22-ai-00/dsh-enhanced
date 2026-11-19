/**
 * Dedicated 文鳐 Ray assistant dialog.
 * Runs as an independent assistant-first conversation UI backed directly by DSH Host
 * `sessions` (`create({ cwd: assistantWorkspace })` + `retain` + `prompt`/`cancel`/projections),
 * completely decoupled from the native `conversation.content` coding layout while sharing the
 * Host's durable session log, permission presets, and `/model` catalog.
 */
import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'
import { KAI_FONT, QUIET_PHRASE } from './art.js'
import { WENYAO_BACKDROP_DATA_URI, WENYAO_BACKDROP_HEIGHT, WENYAO_BACKDROP_WIDTH, WENYAO_ICON_DATA_URI, WENYAO_SEAL_DATA_URI } from './artwork.js'
import { codeFont, renderChatMarkdown } from './chat-markdown.js'
import {
  boundedText, chatMessages, forgetChatSession, modelSelectionFromProjection, openDedicatedChatSession,
  permissionLabel, permissionOptions, permissionValue, remoteFailureSummary, requiresPermissionConfirmation,
  sendChatMessage, streamingAssistantText,
  type ChatBinding, type ChatEventWindow, type ChatMessage, type ChatReference, type ChatRuntime,
  type ChatSessionSnapshot, type PermissionCatalog, type SpeechRecognitionLike,
} from './chat.js'
import { ModelRouteSelects, resolveEffectiveModelCatalog } from './model-route-ui.js'
import type { AssistantChatContext, OwnerConsoleModelCatalog } from './typert.js'
import {
  accent, backdropImageStyle, backdropStyle, border, borderStrong, buttonStyle, caption, danger,
  el, hairline, hintStyle, idle, ink, muted, placeholder, primaryButtonStyle, sunken,
  tint, toneColor, type StatusTone,
} from './ui.js'

type ChatNotice = Readonly<{ tone: 'info' | 'error'; text: string }>

type SessionState =
  | Readonly<{ phase: 'preparing' }>
  | Readonly<{ phase: 'unavailable' }>
  | Readonly<{ phase: 'failed'; error: string }>
  | Readonly<{ phase: 'ready'; reference: ChatReference; binding: ChatBinding }>

/** Renderer seat shapes are structural: the Host injects these props, no package import is needed. */
export type FactoryRenderSlotSeat = (name: string, props: Readonly<Record<string, unknown>>,
  options?: Readonly<{ slots?: Readonly<Record<string, unknown>>, fallback?: unknown }>) => unknown
export type RenderSlotSeat = (name: string, props: Readonly<Record<string, unknown>>,
  options?: Readonly<{ fallback?: unknown }>) => unknown
export type SessionProviderSeat = (props: Readonly<{ session: ChatReference, children?: unknown }>) => unknown
/** Props every renderer-created component receives; kept for structural host compatibility. */
export type OwnerConsoleRendererSeat = Readonly<{
  renderFactorySlot?: FactoryRenderSlotSeat
  renderSlot?: RenderSlotSeat
  SessionProvider?: SessionProviderSeat
}>

type ConversationSnapshotLike = Readonly<{ activeTargets: ReadonlySet<string> }>
type SessionListLike = Readonly<{ byId: Readonly<Record<string, Readonly<{ blank?: boolean }> | undefined>> }>
const EMPTY_SESSION: ChatSessionSnapshot = {}
const EMPTY_CONVERSATION: ConversationSnapshotLike = { activeTargets: new Set() }
const EMPTY_SESSION_LIST: SessionListLike = { byId: {} }
const readEmptySession = <T,>(selector: (value: ChatSessionSnapshot) => T): T => selector(EMPTY_SESSION)
const readEmptyConversation = <T,>(selector: (value: ConversationSnapshotLike) => T): T => selector(EMPTY_CONVERSATION)
const readEmptySessionList = <T,>(selector: (value: SessionListLike) => T): T => selector(EMPTY_SESSION_LIST)

type CatalogState =
  | Readonly<{ phase: 'loading' }>
  | Readonly<{ phase: 'absent' }>
  | Readonly<{ phase: 'failed'; error: string }>
  | Readonly<{ phase: 'ok'; catalog: PermissionCatalog }>

const STARTER_PROMPTS: readonly string[] = [
  '介绍一下你自己和当前能力',
  '帮我检查本机插件、模型和飞书健康',
  '帮我记一条长期偏好',
  '查看近期自主做梦灵感与待办',
]

const CHAT_STYLE_ID = 'owner-console-chat-styles'
const CHAT_SCOPED_CSS = `
[data-owner-console-chat] [data-owner-console-chat-log]::-webkit-scrollbar { width: var(--dsh-scrollbar-width, 6px); height: var(--dsh-scrollbar-width, 6px); }
[data-owner-console-chat] [data-owner-console-chat-log]::-webkit-scrollbar-track { background: transparent; }
[data-owner-console-chat] [data-owner-console-chat-log]::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1, color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 26%, transparent));
  border-radius: 999px;
  corner-shape: round;
}
[data-owner-console-chat] [data-chat-primary-circle],
[data-owner-console-chat] [data-owner-console-art="chat-mark"],
[data-owner-console-chat] [data-owner-console-welcome] img,
[data-owner-console-chat] [data-chat-round],
[data-owner-console-chat] [data-chat-pulse],
[data-owner-console-chat] [data-chat-message-kind="tool"] {
  corner-shape: round;
}
[data-owner-console-chat] [data-owner-console-chat-header] button {
  -webkit-app-region: no-drag;
}
[data-owner-console-chat] [data-owner-console-composer] {
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
}
[data-owner-console-chat] [data-owner-console-composer]:focus-within {
  --dsw-elevation-stroke-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 62%, var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.14)));
  --oc-composer-shadow: var(--dsw-elevation-soft, 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 52%, rgba(0, 0, 0, 0.14)), 0 6px 24px rgba(0, 0, 0, 0.08)), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent);
}
[data-owner-console-chat] textarea[aria-label="给文鳐的消息"]:focus { outline: none; }
[data-owner-console-chat] [data-chat-primary-circle]:active:not(:disabled) { transform: scale(0.94); }
[data-owner-console-chat] [data-chat-ghost-btn]:focus-visible,
[data-owner-console-chat] [data-chat-surface-btn]:focus-visible,
[data-owner-console-chat] [data-chat-primary-circle]:focus-visible,
[data-owner-console-chat] [data-chat-select-wrap]:focus-within,
[data-owner-console-chat] [data-chat-starter]:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 58%, transparent));
  outline-offset: 1px;
}
[data-owner-console-chat] [data-chat-starter] [data-chat-starter-arrow] {
  opacity: 0.52;
  transition: opacity 150ms ease, transform 150ms ease;
}
@media (hover: hover) {
  [data-owner-console-chat] [data-owner-console-chat-log]::-webkit-scrollbar-thumb:hover {
    background: var(--dsw-alias-scrollbar-hover-l1, color-mix(in srgb, var(--dsw-alias-label-tertiary, #81858c) 46%, transparent));
  }
  [data-owner-console-chat] [data-chat-ghost-btn]:hover:not(:disabled),
  [data-owner-console-chat] [data-chat-select-wrap]:not([data-chat-select-wrap="disabled"]):hover {
    --oc-btn-bg: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
    --oc-btn-fg: var(--dsw-alias-label-primary, #0f1115);
  }
  [data-owner-console-chat] [data-chat-surface-btn]:hover:not(:disabled) {
    --oc-btn-bg: var(--dsw-alias-interactive-bg-hover-solid, color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 8%, var(--dsw-specific-input-major, #ffffff)));
    --oc-btn-fg: var(--dsw-alias-label-primary, #0f1115);
  }
  [data-owner-console-chat] [data-owner-console-permissions][data-permission-tone="error"]:not([data-chat-select-wrap="disabled"]):hover {
    --oc-btn-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ec1313) 16%, transparent);
    --oc-btn-fg: var(--dsw-alias-state-error-primary, #ec1313);
  }
  [data-owner-console-chat] [data-owner-console-permissions][data-permission-tone="warn"]:not([data-chat-select-wrap="disabled"]):hover {
    --oc-btn-bg: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #f59e0b) 16%, transparent);
    --oc-btn-fg: var(--dsw-alias-label-primary, #0f1115);
  }
  [data-owner-console-chat] [data-chat-primary-circle]:hover:not(:disabled) {
    --oc-primary-bg: var(--dsw-alias-button-info-hover, color-mix(in srgb, var(--dsw-alias-button-info-fill, #4176e6) 88%, #000000));
  }
  [data-owner-console-chat] [data-chat-starter]:hover:not(:disabled) {
    --oc-starter-border: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16));
    --oc-starter-bg: var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, #ffffff));
    --oc-starter-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  }
  [data-owner-console-chat] [data-chat-starter]:hover:not(:disabled) [data-chat-starter-arrow] {
    opacity: 1;
    transform: translate(1px, -1px);
  }
  [data-owner-console-chat] [data-chat-msg-actions] { opacity: 0.56; transition: opacity 150ms ease; }
  [data-owner-console-chat] [data-chat-message-kind="assistant"]:hover [data-chat-msg-actions],
  [data-owner-console-chat] [data-chat-message-kind="assistant"]:focus-within [data-chat-msg-actions] { opacity: 1; }
}
[data-owner-console-chat] [data-chat-md] > :first-child { margin-top: 0 !important; }
[data-owner-console-chat] [data-chat-md] > :last-child { margin-bottom: 0 !important; }
@keyframes ownerConsolePulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.84); }
}
[data-owner-console-chat] [data-chat-pulse] { animation: ownerConsolePulse 1.5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  [data-owner-console-chat] [data-chat-pulse] { animation: none; }
}
`

let mountedChatInstances = 0

function useChatScopedStyles(): void {
  useEffect(() => {
    mountedChatInstances += 1
    if (typeof document !== 'undefined' && document.head !== null && document.getElementById(CHAT_STYLE_ID) === null) {
      const styleNode = document.createElement('style')
      styleNode.id = CHAT_STYLE_ID
      styleNode.textContent = CHAT_SCOPED_CSS
      document.head.appendChild(styleNode)
    }
    return () => {
      mountedChatInstances = Math.max(0, mountedChatInstances - 1)
      if (mountedChatInstances === 0 && typeof document !== 'undefined') {
        document.getElementById(CHAT_STYLE_ID)?.remove()
      }
    }
  }, [])
}

/** Crisp inline SF-Symbols-style vector icons: zero dependencies, theme-aware via currentColor. */
function svgIcon(size: number, viewBox: string, ...children: readonly unknown[]) {
  return el('svg', {
    'aria-hidden': 'true',
    focusable: 'false',
    viewBox,
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    style: { display: 'block', flex: 'none' },
  }, ...children)
}

const PlusIcon = (size = 15) => svgIcon(size, '0 0 16 16', el('path', { d: 'M8 3.25v9.5M3.25 8h9.5' }))
const GearIcon = () => svgIcon(15, '0 0 16 16',
  el('circle', { cx: 8, cy: 8, r: 2.3 }),
  el('path', { d: 'M6.8 2.2h2.4l.4 1.5c.4.15.78.36 1.12.63l1.48-.44 1.2 2.08-1.1 1.07c.05.31.08.63.08.96s-.03.65-.08.96l1.1 1.07-1.2 2.08-1.48-.44c-.34.27-.72.48-1.12.63l-.4 1.5H6.8l-.4-1.5a4.6 4.6 0 0 1-1.12-.63l-1.48.44-1.2-2.08 1.1-1.07A5.6 5.6 0 0 1 3.62 8c0-.33.03-.65.08-.96L2.6 5.97l1.2-2.08 1.48.44c.34-.27.72-.48 1.12-.63l.4-1.5Z' }))
const ShieldIcon = () => svgIcon(13, '0 0 16 16',
  el('path', { d: 'M8 1.8 13.2 4v4c0 3.3-2.2 5.6-5.2 6.4C5 13.6 2.8 11.3 2.8 8V4L8 1.8Z' }))
const ChevronDownIcon = () => el('svg', {
  'aria-hidden': 'true',
  focusable: 'false',
  viewBox: '0 0 12 12',
  width: 11,
  height: 11,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  style: { flex: 'none', pointerEvents: 'none', opacity: 0.58 },
}, el('path', { d: 'M3 4.5 6 7.5 9 4.5' }))
const MicIcon = () => svgIcon(15, '0 0 16 16',
  el('rect', { x: 5.75, y: 2, width: 4.5, height: 7.2, rx: 2.25 }),
  el('path', { d: 'M3.6 7.8a4.4 4.4 0 0 0 8.8 0M8 12.2v2.1M5.8 14.3h4.4' }))
const SpeakerIcon = () => svgIcon(15, '0 0 16 16',
  el('path', { d: 'M3 6.3h2.4l3-2.6v8.6l-3-2.6H3V6.3Z' }),
  el('path', { d: 'M10.8 5.8a3.2 3.2 0 0 1 0 4.4M12.6 4.2a5.5 5.5 0 0 1 0 7.6' }))
const ArrowUpIcon = () => svgIcon(15, '0 0 16 16',
  el('path', { d: 'M8 12.6V3.6M4.3 7.1 8 3.4l3.7 3.7', strokeWidth: 2 }))
const ArrowDownIcon = () => svgIcon(14, '0 0 16 16',
  el('path', { d: 'M8 3.6v8.8M4.5 9.1 8 12.6l3.5-3.5', strokeWidth: 1.85 }))
const StopSquareIcon = () => el('svg', {
  'aria-hidden': 'true',
  focusable: 'false',
  viewBox: '0 0 16 16',
  width: 12,
  height: 12,
  fill: 'currentColor',
  style: { display: 'block', flex: 'none' },
}, el('rect', { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 2.2 }))
const CopyIcon = () => svgIcon(13, '0 0 16 16',
  el('rect', { x: 5.2, y: 5.2, width: 8.2, height: 8.2, rx: 1.8 }),
  el('path', { d: 'M10.8 5.2V3.8A1.6 1.6 0 0 0 9.2 2.2H3.8A1.6 1.6 0 0 0 2.2 3.8v5.4a1.6 1.6 0 0 0 1.6 1.6h1.4' }))
const FolderIcon = () => svgIcon(12, '0 0 16 16',
  el('path', { d: 'M2.2 4.3A1.3 1.3 0 0 1 3.5 3h3l1.3 1.5h4.7a1.3 1.3 0 0 1 1.3 1.3v6a1.3 1.3 0 0 1-1.3 1.3h-9a1.3 1.3 0 0 1-1.3-1.3V4.3Z' }))
const CheckIcon = () => svgIcon(11, '0 0 16 16', el('path', { d: 'M3.2 8.4 6.5 11.7 12.8 4.8', strokeWidth: 2 }))
const PaperclipIcon = () => svgIcon(12, '0 0 16 16',
  el('path', { d: 'M11.6 7.5 6.8 12.3a2.6 2.6 0 0 1-3.7-3.7l5.4-5.4a1.75 1.75 0 0 1 2.5 2.5L5.7 11a.9.9 0 0 1-1.3-1.3l4.6-4.6' }))
const ArrowUpRightIcon = () => svgIcon(13, '0 0 16 16', el('path', { d: 'M5 11 11 5M6.2 5H11v4.8' }))

const READING_MAX_WIDTH = 760
/** Base canvas surface aligned to DSH 0.2.2 `--dsw-alias-bg-base` so dark mode never draws grey seams. */
const chatCanvas = 'var(--dsw-alias-bg-base, #ffffff)'
/** Elevated composer / floating surface aligned to DSH 0.2.2 `--dsw-specific-input-major`. */
const composerSurface = 'var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, #ffffff))'
/** Dynamic reading font size that scales with DSH `Cmd+`/`Cmd-` preferences. */
const contentFontSize = 'var(--dsh-content-font-size, 14px)'

const chatRootStyle = {
  position: 'relative',
  isolation: 'isolate',
  height: '100%',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: chatCanvas,
  color: ink,
  fontSize: contentFontSize,
  lineHeight: 1.6,
} as const

/** Upper-right radial fade frames the 水墨化鹏 wings gracefully without casting a milky haze in dark mode. */
const chatBackdropImageStyle = {
  ...backdropImageStyle,
  opacity: 0.12,
  maskImage: 'radial-gradient(ellipse 74% 88% at 84% 16%, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0.44) 48%, transparent 82%)',
  WebkitMaskImage: 'radial-gradient(ellipse 74% 88% at 84% 16%, rgba(0, 0, 0, 0.92) 0%, rgba(0, 0, 0, 0.44) 48%, transparent 82%)',
} as const

const topBarStyle = {
  position: 'relative',
  zIndex: 2,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  height: 48,
  paddingTop: 0,
  paddingBottom: 0,
  paddingInlineStart: 'max(16px, var(--dsh-frame-leading-clearance, 0px))',
  paddingInlineEnd: 16,
  boxSizing: 'border-box',
  borderBottom: 'var(--dsh-hairline-width, 1px) solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08))',
  background: chatCanvas,
} as const

const scrollAreaStyle = {
  position: 'relative',
  zIndex: 1,
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  display: 'flex',
  flexDirection: 'column',
} as const

const transcriptInnerStyle = {
  width: '100%',
  maxWidth: READING_MAX_WIDTH,
  margin: '0 auto',
  padding: '20px 24px 32px',
  boxSizing: 'border-box',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  alignContent: 'start',
  gap: 16,
  flex: '1 0 auto',
} as const

const welcomeInnerStyle = {
  width: '100%',
  maxWidth: READING_MAX_WIDTH,
  margin: '0 auto',
  padding: '24px 24px 7vh',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '1 0 auto',
} as const

const dockShellStyle = {
  position: 'relative',
  zIndex: 2,
  flex: 'none',
  background: chatCanvas,
} as const

const dockVeilStyle = {
  position: 'absolute',
  left: 0,
  right: 'var(--dsh-scrollbar-width, 6px)',
  bottom: '100%',
  height: 28,
  pointerEvents: 'none',
  background: `linear-gradient(180deg, color-mix(in srgb, ${chatCanvas} 0%, transparent) 0%, ${chatCanvas} 100%)`,
} as const

/** Shares READING_MAX_WIDTH with tighter outer clearance (10px + 12px card pad + 2px textarea pad = 24px),
 * so composer text aligns to the pixel with transcript prose at EVERY viewport width while the card frames it. */
const dockContainerStyle = {
  position: 'relative',
  width: '100%',
  maxWidth: READING_MAX_WIDTH,
  margin: '0 auto',
  padding: '4px 10px 12px',
  boxSizing: 'border-box',
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 7,
} as const

const composerStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: 6,
  padding: '10px 12px 8px 12px',
  borderRadius: 'var(--dsw-radius-panel, 24px)',
  border: 'none',
  background: composerSurface,
  boxShadow: 'var(--oc-composer-shadow, var(--dsw-elevation-soft, 0 0 0 1px rgba(0, 0, 0, 0.1), 0 4px 20px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)))',
  transition: 'box-shadow 160ms ease',
} as const

const composerTextareaStyle = {
  width: '100%',
  minWidth: 0,
  minHeight: 40,
  maxHeight: 180,
  padding: '4px 2px 6px',
  margin: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  color: 'inherit',
  caretColor: accent,
  fontFamily: 'inherit',
  fontSize: contentFontSize,
  lineHeight: 1.55,
  resize: 'none',
  overflowY: 'auto',
  boxSizing: 'border-box',
} as const

const userBubbleStyle = {
  justifySelf: 'end',
  maxWidth: '78%',
  padding: '10px 16px',
  borderRadius: 'var(--dsw-radius-xl, 20px)',
  background: `var(--dsw-specific-bubble, ${tint(accent, 11)})`,
  color: ink,
  fontSize: contentFontSize,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const

const assistantRowStyle = {
  justifySelf: 'stretch',
  width: '100%',
  minWidth: 0,
  padding: '2px 0',
  color: ink,
  fontSize: contentFontSize,
  lineHeight: 1.68,
  overflowWrap: 'anywhere',
} as const

const toolRowStyle = {
  justifySelf: 'start',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  margin: '-4px 0',
  padding: '3px 10px',
  borderRadius: 999,
  border: `var(--dsh-hairline-width, 1px) solid ${hairline}`,
  background: sunken,
  color: muted,
  fontFamily: codeFont,
  fontSize: 11.5,
  lineHeight: 1.5,
} as const

const errorRowStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 8,
  padding: '9px 12px',
  borderRadius: 12,
  fontSize: 12.5,
  lineHeight: 1.5,
  color: ink,
  background: tint(danger, 8),
  border: `1px solid ${tint(danger, 26)}`,
} as const

const ghostIconButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: 999,
  border: '1px solid transparent',
  background: 'var(--oc-btn-bg, transparent)',
  color: `var(--oc-btn-fg, ${muted})`,
  cursor: 'pointer',
  flex: 'none',
  transition: 'background 140ms ease, color 140ms ease',
} as const

const headerActionButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 28,
  padding: '0 10px',
  borderRadius: 8,
  border: 'var(--dsh-hairline-width, 1px) solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1))',
  background: 'var(--oc-btn-bg, transparent)',
  color: `var(--oc-btn-fg, ${ink})`,
  fontSize: 12,
  fontWeight: 500,
  lineHeight: 1,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  transition: 'background 140ms ease, color 140ms ease',
} as const

const headerIconButtonStyle = {
  ...ghostIconButtonStyle,
  borderRadius: 8,
} as const

const sendCircleButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 32,
  height: 32,
  padding: 0,
  borderRadius: '50%',
  border: 'none',
  background: 'var(--oc-primary-bg, var(--dsw-alias-button-info-fill, #4176e6))',
  color: 'var(--dsw-alias-label-on-color, #ffffff)',
  cursor: 'pointer',
  flex: 'none',
  transition: 'background-color 140ms ease, opacity 140ms ease, transform 120ms ease',
} as const

const stopCircleButtonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  padding: 0,
  borderRadius: '50%',
  border: `1px solid ${borderStrong}`,
  background: `var(--oc-btn-bg, var(--dsw-specific-selector, ${sunken}))`,
  color: `var(--oc-btn-fg, ${ink})`,
  cursor: 'pointer',
  flex: 'none',
  transition: 'background 140ms ease, color 140ms ease',
} as const

const smallActionButtonStyle = {
  ...buttonStyle,
  padding: '3px 10px',
  borderRadius: 8,
  fontSize: 12,
  lineHeight: 1.4,
} as const

const starterCardStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  width: '100%',
  padding: '10px 13px',
  borderRadius: 12,
  border: `1px solid var(--oc-starter-border, ${border})`,
  background: `var(--oc-starter-bg, color-mix(in srgb, ${composerSurface} 84%, transparent))`,
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  boxShadow: 'var(--oc-starter-shadow, none)',
  color: ink,
  fontSize: 12.5,
  fontWeight: 450,
  lineHeight: 1.45,
  textAlign: 'left',
  cursor: 'pointer',
  transition: 'border-color 150ms ease, background 150ms ease, box-shadow 150ms ease',
} as const

const scrollBottomButtonStyle = {
  position: 'absolute',
  top: -40,
  right: 20,
  zIndex: 1,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  padding: 0,
  borderRadius: '50%',
  border: 'var(--dsh-hairline-width, 1px) solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.1))',
  background: `var(--oc-btn-bg, ${composerSurface})`,
  color: `var(--oc-btn-fg, ${muted})`,
  boxShadow: '0 2px 10px rgba(0, 0, 0, 0.08)',
  cursor: 'pointer',
  transition: 'background 140ms ease, color 140ms ease',
} as const

const TOOL_STATUS_LABELS: Readonly<Record<'running' | 'ok' | 'error', string>> = {
  running: '运行中', ok: '完成', error: '失败',
}

function copyTextToClipboard(value: string, setNotice: (next: ChatNotice) => void): void {
  const nav = (globalThis as unknown as { navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } } }).navigator
  if (typeof nav?.clipboard?.writeText === 'function') {
    void nav.clipboard.writeText(value).then(
      () => setNotice({ tone: 'info', text: '已复制到剪贴板' }),
      () => setNotice({ tone: 'info', text: '当前环境限制自动复制，请手动选择复制' }),
    )
    return
  }
  setNotice({ tone: 'info', text: '当前环境不支持剪贴板 API' })
}

function pathBasename(pathValue: string): string {
  const clean = pathValue.replace(/\/+$/u, '')
  const at = clean.lastIndexOf('/')
  return at >= 0 ? clean.slice(at + 1) : clean
}

/** Quiet compact status chip used in the slim top bar. */
function statusChip(label: string, tone: StatusTone, pulse = false) {
  const color = toneColor[tone]
  return el('span', {
    'data-chat-round': '',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '1px 8px 1px 6px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: '18px',
      color: muted,
      background: tint(color, 12),
      whiteSpace: 'nowrap',
    },
  },
  el('span', {
    'aria-hidden': true,
    'data-chat-round': '',
    ...(pulse ? { 'data-chat-pulse': '' } : {}),
    style: { width: 5.5, height: 5.5, borderRadius: 999, background: color, flex: 'none' },
  }),
  label)
}

/** Quiet capability chip in the top bar metadata strip; live connections carry a status dot. */
function capabilityChip(label: string, live = false) {
  return el('span', {
    'data-chat-round': '',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: live ? '1px 7px 1px 6px' : '1px 7px',
      borderRadius: 999,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: '18px',
      color: muted,
      background: live ? tint(toneColor.ok, 11) : sunken,
      whiteSpace: 'nowrap',
    },
  },
  live
    ? el('span', {
      'aria-hidden': true,
      'data-chat-round': '',
      style: { width: 4.5, height: 4.5, borderRadius: 999, background: toneColor.ok, flex: 'none' },
    })
    : null,
  label)
}

/** The factory-local view selection kept for standalone slot compatibility. */
function ChatConversationView({ renderSlot }: Readonly<{ renderSlot?: RenderSlotSeat }>) {
  return renderSlot?.('conversation.session', { view: 'chat' }) ?? null
}

export interface OwnerConsoleConversationSeat {
  readonly sessionId?: string
  readonly renderFactorySlot?: FactoryRenderSlotSeat
  readonly useSession?: (selector: (value: ChatSessionSnapshot) => unknown) => unknown
  readonly useConversation?: (selector: (value: ConversationSnapshotLike) => unknown) => unknown
  readonly useSessions?: (selector: (value: SessionListLike) => unknown) => unknown
}

/**
 * Retained for host-slot contract compatibility; computes the native phase when embedded directly.
 */
export function OwnerConsoleConversation({ sessionId, renderFactorySlot, useSession, useConversation,
  useSessions }: OwnerConsoleConversationSeat) {
  const session = (useSession ?? readEmptySession)(value => value) as ChatSessionSnapshot
  const conversation = (useConversation ?? readEmptyConversation)(value => value) as ConversationSnapshotLike
  const summaryBlank = (useSessions ?? readEmptySessionList)(state => state.byId[sessionId ?? '']?.blank)
  if (renderFactorySlot === undefined) return placeholder('原生对话组件未加载，可用右上角「原生会话」进入完整会话。')
  const active = conversation.activeTargets.size > 0
    || (session.blank !== true && session.awaitingFirstTurn !== true)
    || session.running === true
  const shellPhase = active ? 'active' : session.promptAttempted === true ? 'engaging' : 'blank'
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  const phase = settling ? 'settling' : hero ? 'active' : 'active'
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase, hero: false }, {
    slots: { views: ChatConversationView },
    fallback: placeholder('原生对话组件未加载，可用右上角「原生会话」进入完整会话。'),
  })
}

/** Round 02 水墨化鹏 fish-and-peng mark used by the slim chat header. */
function ChatMark() {
  return el('img', {
    src: WENYAO_ICON_DATA_URI,
    alt: '',
    'aria-hidden': 'true',
    draggable: false,
    'data-owner-console-art': 'chat-mark',
    width: 24,
    height: 24,
    style: {
      display: 'block',
      width: 24,
      height: 24,
      borderRadius: '50%',
      objectFit: 'cover',
      flex: 'none',
      boxShadow: `0 0 0 1px ${border}`,
    },
  })
}

/** Open-canvas Markdown transcript row for 文鳐 assistant dialog. */
function ChatMessageRow({ message, onCopy }: Readonly<{ message: ChatMessage; onCopy: (text: string) => void }>) {
  if (message.kind === 'tool') {
    const statusGlyph = message.status === 'ok'
      ? el('span', { style: { color: toneColor.ok, display: 'inline-flex' } }, CheckIcon())
      : el('span', {
        'aria-hidden': true,
        'data-chat-round': '',
        ...(message.status === 'running' ? { 'data-chat-pulse': '' } : {}),
        style: {
          width: 6,
          height: 6,
          borderRadius: 999,
          background: message.status === 'error' ? danger : accent,
          flex: 'none',
        },
      })
    return el('div', {
      'data-chat-message-kind': 'tool',
      style: toolRowStyle,
      role: 'status',
      'aria-label': `工具 ${message.name}：${TOOL_STATUS_LABELS[message.status]}`,
    },
    statusGlyph,
    el('span', { style: { color: ink } }, message.name),
    el('span', { 'aria-hidden': true, style: { color: caption } }, '·'),
    el('span', { style: { color: caption } }, TOOL_STATUS_LABELS[message.status]))
  }
  if (message.kind === 'error') {
    return el('div', { 'data-chat-message-kind': 'error', role: 'alert', style: errorRowStyle },
      el('span', {
        'aria-hidden': true,
        'data-chat-round': '',
        style: { width: 6, height: 6, borderRadius: 999, background: danger, flex: 'none', marginTop: 6 },
      }),
      el('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, message.text))
  }
  if (message.kind === 'user') {
    return el('div', { 'data-chat-message-kind': 'user', style: userBubbleStyle }, message.text)
  }
  return el('div', { 'data-chat-message-kind': 'assistant', style: assistantRowStyle },
    renderChatMarkdown(message.text, onCopy),
    el('div', {
      'data-chat-msg-actions': '',
      style: { display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 },
    },
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'aria-label': '复制回复',
      title: '复制回复',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 7px',
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'var(--oc-btn-bg, transparent)',
        color: `var(--oc-btn-fg, ${caption})`,
        fontSize: 11.5,
        lineHeight: 1.3,
        cursor: 'pointer',
        transition: 'background 140ms ease, color 140ms ease',
      },
      onClick: () => onCopy(message.text),
    }, CopyIcon(), '复制')))
}

/** Session lifecycle as a compact status chip. */
function sessionStatusChip(snapshot: ChatSessionSnapshot, ready: boolean) {
  if (!ready) return statusChip('准备中', 'neutral', true)
  if (snapshot.openState === 'error') return statusChip('会话不可用', 'error')
  if (snapshot.removed === true) return statusChip('会话已移除', 'error')
  if (snapshot.running === true) return statusChip('思考回复中', 'warn', true)
  if (snapshot.openState === 'loading' || snapshot.openState === 'cold') return statusChip('连接中', 'neutral', true)
  return statusChip('就绪', 'ok')
}

/** Permission tone: full access and auto are visibly elevated without screaming. */
function permissionTone(value: string | undefined): StatusTone {
  if (value === undefined) return 'neutral'
  if (value === 'danger-full-access') return 'error'
  if (value === 'auto') return 'warn'
  return 'ok'
}

interface PermissionControlProps {
  readonly session: ChatBinding['session'] | undefined
  readonly permission: string | undefined
  readonly catalog: CatalogState
  readonly switching: boolean
  readonly request: (value: string) => void
}

/** Compact inline permission selector inside the floating composer toolbar. */
function PermissionControl({ session, permission, catalog, switching, request }: PermissionControlProps) {
  const selectable = session !== undefined && permission !== undefined && catalog.phase === 'ok'
  const options = catalog.phase === 'ok' ? permissionOptions(catalog.catalog, permission) : []
  const tone = permissionTone(permission)
  const currentCatalog = catalog.phase === 'ok' ? catalog.catalog : undefined
  const label = permissionLabel(permission, currentCatalog)
  const elevated = tone === 'error' || tone === 'warn'
  const iconColor = elevated ? toneColor[tone] : muted

  const containerStyle = {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 26,
    padding: '0 6px 0 8px',
    borderRadius: 8,
    background: elevated ? `var(--oc-btn-bg, ${tint(toneColor[tone], 9)})` : 'var(--oc-btn-bg, transparent)',
    border: elevated ? `1px solid ${tint(toneColor[tone], 24)}` : '1px solid transparent',
    color: tone === 'error' ? `var(--oc-btn-fg, ${danger})` : `var(--oc-btn-fg, ${muted})`,
    fontSize: 12,
    fontWeight: 500,
    lineHeight: '26px',
    whiteSpace: 'nowrap',
    flex: 'none',
    minWidth: 0,
    opacity: switching ? 0.55 : 1,
    transition: 'background 140ms ease, border-color 140ms ease, color 140ms ease',
  } as const

  if (selectable) {
    return el('div', {
      'data-owner-console-permissions': '',
      'data-permission-tone': tone,
      'data-chat-select-wrap': switching ? 'disabled' : '',
      style: containerStyle,
    },
    el('span', {
      'aria-hidden': 'true',
      style: { display: 'inline-flex', alignItems: 'center', color: iconColor, flex: 'none' },
    }, ShieldIcon()),
    el('span', {
      'aria-hidden': 'true',
      style: { maxWidth: 108, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, label),
    ChevronDownIcon(),
    el('select', {
      'aria-label': '切换权限预设',
      title: `当前权限：${label}（${permission}）· 切换通过 Host /permission 命令完成`,
      value: permission,
      disabled: switching,
      onChange: (event: { target: { value: string } }) => request(event.target.value),
      style: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        margin: 0,
        opacity: 0,
        cursor: switching ? 'not-allowed' : 'pointer',
        fontSize: 12,
      },
    },
    ...options.map(option => el('option', { key: option.value, value: option.value },
      permissionLabel(option.value, currentCatalog)))))
  }

  return el('div', {
    'data-owner-console-permissions': '',
    'data-permission-tone': tone,
    style: {
      ...containerStyle,
      padding: '0 8px',
      gap: 5,
    },
    title: catalog.phase === 'failed' ? `权限读取失败：${boundedText(catalog.error, 120)}` : undefined,
  },
  el('span', { style: { display: 'inline-flex', color: iconColor } }, ShieldIcon()),
  el('span', {}, label),
  catalog.phase === 'loading' ? el('span', { style: { fontSize: 11, color: caption } }, '…') : null)
}

interface ComposerProps {
  readonly disabled: boolean
  readonly sending: boolean
  readonly draft: string
  readonly files: readonly Blob[]
  readonly running: boolean
  readonly cancelling: boolean
  readonly voiceAvailable: boolean
  readonly listening: boolean
  readonly speakAvailable: boolean
  readonly speakReady: boolean
  readonly permissionControl: unknown
  readonly modelControls: unknown
  readonly onDraft: (value: string) => void
  readonly onSubmit: (event: { preventDefault(): void }) => void
  readonly onKeyDown: (event: KeyboardEventLike) => void
  readonly onFiles: (files: ArrayLike<Blob> | null) => void
  readonly onRemoveFile: (index: number) => void
  readonly onVoice: () => void
  readonly onSpeak: () => void
  readonly onStop: () => void
}

type KeyboardEventLike = {
  readonly key?: string
  readonly shiftKey?: boolean
  readonly nativeEvent?: { readonly isComposing?: boolean }
  preventDefault(): void
}

/** Unified floating composer dock: borderless auto-sizing input + compact inline controls. */
function Composer(props: ComposerProps) {
  const input = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const hasPayload = props.draft.trim() !== '' || props.files.length > 0
  const blocked = props.disabled || props.sending || !hasPayload
  const showSendButton = !props.running || hasPayload

  // Smoothly auto-size textarea height between 1 compact line and 180px without jumpiness;
  // clear inline height when empty so live --dsh-content-font-size changes never clip the placeholder.
  useEffect(() => {
    const node = textareaRef.current
    if (node === null) return
    if (props.draft === '') {
      node.style.height = ''
      return
    }
    node.style.height = 'auto'
    if (node.scrollHeight > 0) {
      node.style.height = `${Math.min(Math.max(node.scrollHeight, 40), 180)}px`
    }
  }, [props.draft])

  const voiceDisabled = !props.voiceAvailable || props.sending
  const speakDisabled = !props.speakAvailable || !props.speakReady || props.sending

  return el('form', {
    'data-owner-console-composer': '',
    style: composerStyle,
    'aria-label': '消息输入',
    onSubmit: props.onSubmit,
    onClick: (event: { target: unknown }) => {
      const target = event.target as { closest?: (selector: string) => unknown } | null
      if (target?.closest?.('button, select, input, textarea, a, [data-chat-select-wrap]') === null) {
        textareaRef.current?.focus()
      }
    },
  },
  props.files.length === 0 ? null : el('ul', {
    'aria-label': '待发送附件',
    style: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', listStyle: 'none', margin: '0 0 2px', padding: 0 },
  },
  ...props.files.map((file, index) => {
    const name = (file as Blob & { name?: string }).name ?? `附件 ${index + 1}`
    return el('li', {
      key: `${name}:${index}`,
      'data-chat-round': '',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 7px 2px 9px',
        borderRadius: 999,
        border: `1px solid ${border}`,
        fontSize: 12,
        background: sunken,
        color: ink,
      },
    },
    el('span', { style: { color: muted, display: 'inline-flex' } }, PaperclipIcon()),
    el('span', { style: { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, name),
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'data-chat-round': '',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        padding: 0,
        border: 'none',
        borderRadius: 999,
        background: 'var(--oc-btn-bg, transparent)',
        color: `var(--oc-btn-fg, ${muted})`,
        fontSize: 14,
        lineHeight: 1,
        cursor: 'pointer',
        transition: 'background 140ms ease, color 140ms ease',
      },
      'aria-label': `移除附件 ${name}`,
      onClick: () => props.onRemoveFile(index),
    }, '×'))
  })),
  el('textarea', {
    ref: textareaRef,
    value: props.draft,
    rows: 1,
    'aria-label': '给文鳐的消息',
    placeholder: '给文鳐发消息…（Enter 发送，Shift+Enter 换行）',
    disabled: props.disabled || props.sending,
    onChange: (event: { target: { value: string } }) => props.onDraft(event.target.value),
    onKeyDown: props.onKeyDown,
    style: composerTextareaStyle,
  }),
  el('div', {
    'data-owner-console-chat-controls': '',
    style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap', paddingTop: 2 },
  },
  el('input', {
    ref: input,
    type: 'file',
    multiple: true,
    'aria-label': '选择附件',
    tabIndex: -1,
    style: { display: 'none' },
    onChange: (event: { target: { files?: ArrayLike<Blob> | null; value?: string } }) => {
      props.onFiles(event.target.files ?? null)
      if (event.target.value !== undefined) event.target.value = ''
    },
  }),
  el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none', marginRight: 'auto', minWidth: 0 } },
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'data-chat-round': '',
      disabled: props.disabled,
      style: idle({ ...ghostIconButtonStyle, border: `var(--dsh-hairline-width, 1px) solid ${border}` }, props.disabled),
      onClick: () => input.current?.click(),
      'aria-label': '添加附件',
      title: '添加附件（先上传到本会话，再随消息发送）',
    }, PlusIcon(14)),
    props.permissionControl),
  el('div', {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      flexWrap: 'wrap',
      justifyContent: 'flex-end',
      flex: '0 1 auto',
      minWidth: 0,
      maxWidth: '100%',
    },
  },
  props.modelControls),
  el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 3, flex: 'none' } },
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'data-chat-round': '',
      style: idle({
        ...ghostIconButtonStyle,
        ...(props.listening
          ? { color: danger, background: tint(danger, 12), border: `1px solid ${tint(danger, 30)}` }
          : {}),
      }, voiceDisabled),
      'aria-label': props.voiceAvailable ? (props.listening ? '停止语音对话' : '语音对话') : '语音对话（当前浏览器不支持）',
      'aria-pressed': props.listening,
      title: props.voiceAvailable
        ? '语音输入由浏览器 SpeechRecognition 提供，音频可能发送给浏览器厂商的语音服务，不属于 DSH 权限模型或审计范围'
        : '当前浏览器未提供 SpeechRecognition，语音输入不可用；该功能由浏览器提供，不是 DSH 模型功能',
      disabled: voiceDisabled,
      onClick: props.onVoice,
    },
    props.listening
      ? el('span', { 'data-chat-pulse': '', style: { display: 'inline-flex' } }, MicIcon())
      : MicIcon()),
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'data-chat-round': '',
      style: idle(ghostIconButtonStyle, speakDisabled),
      'aria-label': '朗读最近一条回复',
      title: props.speakAvailable
        ? '用浏览器 SpeechSynthesis 朗读最近一条回复；远端语音可能把文本发送给浏览器厂商，不是 DSH 模型'
        : '当前浏览器未提供 SpeechSynthesis，朗读不可用',
      disabled: speakDisabled,
      onClick: props.onSpeak,
    }, SpeakerIcon()),
    props.running ? el('button', {
      type: 'button',
      ...(showSendButton ? { 'data-chat-surface-btn': '', 'data-chat-round': '' } : { 'data-chat-primary-circle': '' }),
      style: idle(showSendButton ? stopCircleButtonStyle : sendCircleButtonStyle, props.cancelling),
      disabled: props.cancelling,
      'aria-label': props.cancelling ? '正在停止' : '停止回复',
      title: props.cancelling ? '停止中…' : '停止当前回复',
      onClick: props.onStop,
    }, StopSquareIcon()) : null,
    showSendButton ? el('button', {
      type: 'submit',
      'data-chat-primary-circle': '',
      style: blocked
        ? { ...sendCircleButtonStyle, opacity: 0.4, cursor: 'not-allowed' }
        : sendCircleButtonStyle,
      disabled: blocked,
      'aria-label': props.sending ? '正在发送消息' : '发送消息',
      title: props.sending ? '正在发送…' : '发送消息（Enter）',
    }, ArrowUpIcon()) : null)))
}

export interface OwnerConsoleChatProps {
  readonly runtime: ChatRuntime
  readonly onOpenSettings: () => void
  readonly renderer?: OwnerConsoleRendererSeat
}

/** The sidebar's 文鳐 panel: dedicated personal-assistant dialog decoupled from native coding conversation. */
export function OwnerConsoleChat({ runtime, onOpenSettings }: OwnerConsoleChatProps) {
  useChatScopedStyles()

  const [state, setState] = useState<SessionState>({ phase: 'preparing' })
  const [attempt, setAttempt] = useState(0)
  const [assistantCtx, setAssistantCtx] = useState<AssistantChatContext>()
  const [modelCatalog, setModelCatalog] = useState<OwnerConsoleModelCatalog>()
  const [modelSwitching, setModelSwitching] = useState(false)
  const [localSelection, setLocalSelection] = useState<{ provider: string; model: string; reasoningEffort: string }>()
  const [snapshot, setSnapshot] = useState<ChatSessionSnapshot>({})
  const [window, setWindow] = useState<ChatEventWindow>({})
  const [permission, setPermission] = useState<string>()
  const [sessionModelSel, setSessionModelSel] = useState<Readonly<{ provider: string; model: string; reasoningEffort?: string }>>()
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading' })
  const [pendingPermission, setPendingPermission] = useState<string>()
  const [switching, setSwitching] = useState(false)
  const [permissionNotice, setPermissionNotice] = useState('')
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<readonly Blob[]>([])
  const [sending, setSending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [notice, setNotice] = useState<ChatNotice>()
  const [listening, setListening] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const forceNewRef = useRef(false)
  const activeSessionIdRef = useRef<string | undefined>(undefined)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const log = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // Auto-dismiss transient info notices after a calm pause; errors persist until dismissed.
  useEffect(() => {
    if (notice === undefined || notice.tone !== 'info') return
    const timer = setTimeout(() => { setNotice(undefined) }, 4500)
    return () => { clearTimeout(timer) }
  }, [notice])

  // Auto-dismiss confirmation notices for successful permission requests.
  useEffect(() => {
    if (!permissionNotice.startsWith('已请求切换到')) return
    const timer = setTimeout(() => { setPermissionNotice('') }, 4500)
    return () => { clearTimeout(timer) }
  }, [permissionNotice])

  // Acquire one dedicated assistant Session bound on Host so systemPrompt stays strictly scoped to 文鳐.
  useEffect(() => {
    alive.current = true
    let disposed = false
    let reference: ChatReference | undefined
    const controller = new AbortController()
    const forceNew = forceNewRef.current
    forceNewRef.current = false
    const sessions = runtime.sessions()
    if (sessions === undefined) {
      setState({ phase: 'unavailable' })
      return () => { disposed = true }
    }
    setState({ phase: 'preparing' })
    void (async () => {
      try {
        let preferredSessionId: string | null = null
        if (typeof runtime.assistantChatContext === 'function') {
          try {
            const ctxResult = await runtime.assistantChatContext()
            if (disposed) return
            if (ctxResult.ok) {
              setAssistantCtx(ctxResult.value)
              preferredSessionId = ctxResult.value.activeSessionId
            }
          } catch {
            // Proceed cleanly even if Host hasn't exposed assistantChatContext yet.
          }
        }
        reference = await openDedicatedChatSession(
          sessions,
          runtime.storage(),
          undefined,
          runtime.createSession,
          controller.signal,
          {
            forceNew,
            preferredSessionId,
            onSessionReady: async (sid) => {
              await runtime.registerAssistantSession?.(sid, true)
            },
          },
        )
        if (disposed) {
          reference.release()
          return
        }
        setState({ phase: 'ready', reference, binding: reference.binding })
      } catch (error) {
        if (disposed) return
        setState({ phase: 'failed', error: error instanceof Error ? boundedText(error.message) : '无法打开对话。' })
      }
    })()
    return () => {
      disposed = true
      controller.abort()
      reference?.release()
    }
  }, [runtime, attempt])

  // Load `/model`-aligned catalog on mount and re-fetch catalog + assistant context on cross-surface settings changes.
  useEffect(() => {
    let disposed = false
    let catalogSeq = 0
    let ctxSeq = 0
    const fetchCatalog = () => {
      if (typeof runtime.modelCatalog !== 'function') return
      const seq = ++catalogSeq
      void runtime.modelCatalog(false).then(res => {
        if (!disposed && seq === catalogSeq && res.ok) setModelCatalog(res.value)
      }, () => undefined)
    }
    const fetchContext = () => {
      if (typeof runtime.assistantChatContext !== 'function') return
      const seq = ++ctxSeq
      void runtime.assistantChatContext().then(res => {
        if (!disposed && seq === ctxSeq && res.ok) setAssistantCtx(res.value)
      }, () => undefined)
    }
    fetchCatalog()
    const unsubscribe = runtime.subscribeRefresh?.(() => {
      fetchCatalog()
      fetchContext()
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [runtime])

  const binding = state.phase === 'ready' ? state.binding : undefined
  activeSessionIdRef.current = binding?.sessionId

  // Session lifecycle, durable transcript, permissions, and modelSelection subscriptions.
  useEffect(() => {
    setPendingPermission(undefined)
    setPermissionNotice('')
    setLocalSelection(undefined)
    setModelSwitching(false)
    setLoadingOlder(false)
    setAtBottom(true)
    stick.current = true
    if (binding === undefined) {
      setSnapshot({})
      setWindow({})
      setPermission(undefined)
      setSessionModelSel(undefined)
      return
    }
    const syncSession = () => setSnapshot(binding.session.getSnapshot())
    const syncEvents = () => setWindow(binding.eventSource.getSnapshot())
    const permFace = binding.session.projections.faceOf('permissions')
    const syncPerm = () => setPermission(permissionValue(permFace.getSnapshot()))
    const modelFace = binding.session.projections.faceOf('modelSelection')
    const syncModel = () => {
      setSessionModelSel(modelSelectionFromProjection(modelFace.getSnapshot()))
      setLocalSelection(undefined)
    }

    syncSession()
    syncEvents()
    syncPerm()
    syncModel()

    const stopSession = binding.session.subscribe(syncSession)
    const stopEvents = binding.eventSource.subscribe(syncEvents)
    const stopPerm = permFace.subscribe(syncPerm)
    const stopModel = modelFace.subscribe(syncModel)
    return () => { stopSession(); stopEvents(); stopPerm(); stopModel() }
  }, [binding])

  // Selectable permission presets come from the Host's process catalog Remote.
  useEffect(() => {
    let disposed = false
    let pending: ReturnType<ChatRuntime['permissionCatalog']>
    try {
      pending = runtime.permissionCatalog()
    } catch (error) {
      setCatalog({ phase: 'failed', error: error instanceof Error ? error.message : '权限目录读取失败' })
      return () => { disposed = true }
    }
    if (pending === undefined) {
      setCatalog({ phase: 'absent' })
      return () => { disposed = true }
    }
    setCatalog({ phase: 'loading' })
    void pending.then(result => {
      if (disposed) return
      if (result.ok) setCatalog({ phase: 'ok', catalog: result.value })
      else setCatalog({ phase: 'failed', error: remoteFailureSummary(result.error) })
    }, (error: unknown) => {
      if (!disposed) setCatalog({ phase: 'failed', error: error instanceof Error ? error.message : '权限目录读取失败' })
    })
    return () => { disposed = true }
  }, [runtime])

  const messages = chatMessages(window.entries)
  const streaming = streamingAssistantText(window.entries)
  const lastAssistant = [...messages].reverse().find(message => message.kind === 'assistant')
  const voiceAvailable = runtime.voiceAvailable()
  const speakAvailable = runtime.speakAvailable()

  // Follow new output only while the reader is already at the bottom.
  useEffect(() => {
    const node = log.current
    if (node !== null && stick.current) node.scrollTop = node.scrollHeight
  }, [messages, streaming, snapshot.running, binding])

  useEffect(() => () => {
    const active = recognition.current
    recognition.current = null
    try { active?.stop() } catch { /* a browser may already have ended it */ }
  }, [])

  const submitPayload = (textValue: string, filesValue: readonly Blob[], clearDraftOnSuccess: boolean) => {
    if (binding === undefined || sending) return
    if (textValue.trim() === '' && filesValue.length === 0) return
    setSending(true)
    setNotice(undefined)
    void sendChatMessage({
      sessionId: binding.sessionId,
      session: binding.session,
      uploads: runtime.fileUploads(),
      text: textValue,
      files: filesValue,
    }).then(outcome => {
      if (!alive.current) return
      setSending(false)
      if (!outcome.ok) {
        setNotice({ tone: 'error', text: outcome.error })
        return
      }
      if (clearDraftOnSuccess) {
        setDraft('')
        setFiles([])
      }
    }, (error: unknown) => {
      if (!alive.current) return
      setSending(false)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '消息未发送，稍后重试。' })
    })
  }

  const submit = () => submitPayload(draft, files, true)

  const stop = () => {
    if (binding === undefined || cancelling) return
    setCancelling(true)
    setNotice(undefined)
    void binding.session.cancel().then(result => {
      if (!alive.current) return
      setCancelling(false)
      if (!result.ok) setNotice({ tone: 'error', text: `停止失败（${remoteFailureSummary(result.error)}）` })
    }, (error: unknown) => {
      if (!alive.current) return
      setCancelling(false)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '停止失败。' })
    })
  }

  const applyPermission = (value: string) => {
    if (binding === undefined || switching) return
    setPendingPermission(undefined)
    setSwitching(true)
    setPermissionNotice('')
    void binding.session.command(`/permission ${value}`).then(result => {
      if (!alive.current) return
      setSwitching(false)
      if (!result.ok) {
        setPermissionNotice(`权限切换被拒绝（${remoteFailureSummary(result.error)}）`)
        return
      }
      if (result.value.matched === false) {
        setPermissionNotice('Host 没有提供 /permission 命令，权限未改变。')
        return
      }
      setPermissionNotice(`已请求切换到「${permissionLabel(value, catalog.phase === 'ok' ? catalog.catalog : undefined)}」`)
    }, (error: unknown) => {
      if (!alive.current) return
      setSwitching(false)
      setPermissionNotice(error instanceof Error ? boundedText(error.message) : '权限切换失败。')
    })
  }

  const requestPermission = (value: string) => {
    if (value === permission) return
    if (requiresPermissionConfirmation(value)) {
      setPendingPermission(value)
      return
    }
    applyPermission(value)
  }

  const startFreshChat = () => {
    if (sending || modelSwitching) return
    setNotice(undefined)
    setLocalSelection(undefined)
    forgetChatSession(runtime.storage())
    forceNewRef.current = true
    setAttempt(v => v + 1)
  }

  const handleModelRouteChange = (next: Readonly<{ provider: string; model: string; reasoningEffort: string }>) => {
    const provider = next.provider.trim()
    const model = next.model.trim()
    const reasoningEffort = next.reasoningEffort.trim()
    setLocalSelection({ provider, model, reasoningEffort })
    if (provider === '' || model === '') return
    if (binding === undefined || typeof runtime.selectSessionModel !== 'function') return
    const targetSessionId = binding.sessionId
    const modelFace = binding.session.projections.faceOf('modelSelection')
    setModelSwitching(true)
    setNotice(undefined)
    void runtime.selectSessionModel(targetSessionId, provider, model, reasoningEffort).then(res => {
      if (!alive.current || activeSessionIdRef.current !== targetSessionId) return
      setModelSwitching(false)
      if (!res.ok) {
        setLocalSelection(undefined)
        setNotice({ tone: 'error', text: `切换模型失败（${remoteFailureSummary(res.error)}）` })
        return
      }
      const projected = modelSelectionFromProjection(modelFace.getSnapshot())
      if (projected !== undefined
        && projected.provider === provider
        && projected.model === model
        && (projected.reasoningEffort ?? '') === reasoningEffort) {
        setSessionModelSel(projected)
        setLocalSelection(undefined)
      }
      setNotice({
        tone: 'info',
        text: `已切换模型：${provider} / ${model}${reasoningEffort ? `（${reasoningEffort}）` : ''}`,
      })
    }, (cause: unknown) => {
      if (!alive.current || activeSessionIdRef.current !== targetSessionId) return
      setModelSwitching(false)
      setLocalSelection(undefined)
      setNotice({ tone: 'error', text: cause instanceof Error ? boundedText(cause.message) : '切换模型失败。' })
    })
  }

  const loadOlder = () => {
    if (binding === undefined || loadingOlder) return
    const targetSessionId = binding.sessionId
    setLoadingOlder(true)
    setNotice(undefined)
    void binding.session.loadOlder().then(() => {
      if (!alive.current || activeSessionIdRef.current !== targetSessionId) return
      setLoadingOlder(false)
    }, (cause: unknown) => {
      if (!alive.current || activeSessionIdRef.current !== targetSessionId) return
      setLoadingOlder(false)
      setNotice({
        tone: 'error',
        text: `载入更早的消息失败（${cause instanceof Error ? boundedText(cause.message) : '请稍后重试'}）`,
      })
    })
  }

  const toggleVoice = () => {
    if (listening) {
      const active = recognition.current
      recognition.current = null
      setListening(false)
      try { active?.stop() } catch { /* already ended */ }
      return
    }
    const created = runtime.createRecognition()
    if (created === undefined) {
      setNotice({ tone: 'error', text: '当前浏览器未提供 SpeechRecognition，语音输入不可用；语音识别由浏览器提供，不是 DSH 模型功能。' })
      return
    }
    created.lang = runtime.recognitionLang()
    created.interimResults = true
    created.continuous = false
    created.onresult = event => {
      if (!alive.current || recognition.current !== created) return
      let finalText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]
        if (result?.isFinal === true) finalText += result[0]?.transcript ?? ''
      }
      if (finalText === '') return
      setDraft(previous => previous === '' ? finalText : `${previous} ${finalText}`)
    }
    created.onerror = event => {
      if (!alive.current || recognition.current !== created) return
      recognition.current = null
      setListening(false)
      setNotice({ tone: 'error', text: `语音识别失败：${event.error ?? '未知错误'}。语音识别由浏览器提供，不是 DSH 模型功能。` })
    }
    created.onend = () => {
      if (!alive.current || recognition.current !== created) return
      recognition.current = null
      setListening(false)
    }
    recognition.current = created
    try {
      created.start()
      setListening(true)
      setNotice(undefined)
    } catch {
      recognition.current = null
      setNotice({ tone: 'error', text: '浏览器拒绝启动语音识别。' })
    }
  }

  const speak = () => {
    if (lastAssistant === undefined) {
      setNotice({ tone: 'info', text: '还没有可朗读的回复。' })
      return
    }
    if (!runtime.speak(lastAssistant.text)) {
      setNotice({ tone: 'error', text: '浏览器语音合成不可用。' })
    }
  }

  const addFiles = (chosen: ArrayLike<Blob> | null) => {
    if (runtime.fileUploads() === undefined) {
      setNotice({ tone: 'error', text: '当前界面未提供附件上传服务（fileUpload 未加载），无法上传附件。' })
      return
    }
    const next = [...files]
    for (const file of Array.from(chosen ?? [])) next.push(file)
    if (next.length > 10) {
      setNotice({ tone: 'error', text: '一次最多附加 10 个文件。' })
    }
    setFiles(next.slice(0, 10))
  }

  const keyDown = (event: KeyboardEventLike) => {
    if (event.key !== 'Enter' || event.shiftKey === true || event.nativeEvent?.isComposing === true) return
    event.preventDefault()
    submit()
  }

  const ready = binding !== undefined
  const disabled = !ready || sending
  const scroll = (event: { currentTarget: { scrollHeight: number; scrollTop: number; clientHeight: number } }) => {
    const nearBottom = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 56
    stick.current = nearBottom
    setAtBottom(nearBottom)
  }

  const scrollToBottom = () => {
    const node = log.current
    if (node === null) return
    stick.current = true
    setAtBottom(true)
    node.scrollTop = node.scrollHeight
  }

  const effectiveCatalog = resolveEffectiveModelCatalog({ modelCatalog })
  const defaultSelection = modelCatalog !== undefined && modelCatalog.defaultSelection.provider.trim() !== ''
    ? modelCatalog.defaultSelection
    : undefined
  const sourceSelection = localSelection ?? sessionModelSel ?? defaultSelection
  const activeModelProvider = sourceSelection?.provider ?? effectiveCatalog.providers[0]?.id ?? ''
  const activeModelId = sourceSelection !== undefined
    ? sourceSelection.model
    : (effectiveCatalog.providers.find(p => p.id === activeModelProvider)?.models[0]?.id ?? '')
  const activeModelEffort = sourceSelection?.reasoningEffort ?? ''

  const caps = assistantCtx?.capabilities
  const workspaceName = assistantCtx?.workspace ? pathBasename(assistantCtx.workspace) : ''
  const hasMetadata = workspaceName !== '' || caps?.memory === true || caps?.wiki === true || caps?.feishuConnected === true

  const isWelcome = state.phase === 'ready' && messages.length === 0 && streaming === '' && snapshot.running !== true && window.hasMore !== true

  let transcriptContent: unknown
  if (state.phase === 'preparing') {
    transcriptContent = el('div', { style: { display: 'grid', justifyItems: 'center', padding: '12vh 12px 0' } },
      el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, color: muted, fontSize: 13 } },
        el('span', { 'data-chat-pulse': '', 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: 999, background: accent } }),
        '正在准备文鳐专属助手会话…'))
  } else if (state.phase === 'unavailable') {
    transcriptContent = el('div', { style: { display: 'grid', gap: 12, justifyItems: 'center', padding: '10vh 12px 0', maxWidth: 460, margin: '0 auto' } },
      placeholder('当前界面未提供会话服务（sessions 未加载），无法在这里对话。可以进入原生会话界面继续。'),
      el('button', { type: 'button', style: primaryButtonStyle, onClick: () => runtime.startConversation() }, '进入原生会话'))
  } else if (state.phase === 'failed') {
    transcriptContent = el('div', { style: { display: 'grid', gap: 12, justifyItems: 'center', padding: '10vh 12px 0', maxWidth: 460, margin: '0 auto' } },
      el('p', { role: 'alert', style: { ...errorRowStyle, margin: 0, width: '100%' } }, `无法打开对话：${state.error}`),
      el('button', { type: 'button', style: primaryButtonStyle, onClick: () => setAttempt(value => value + 1) }, '重试'))
  } else if (isWelcome) {
    transcriptContent = el('div', {
      'data-owner-console-welcome': '',
      style: { display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center', width: '100%', maxWidth: 560 },
    },
    el('img', {
      src: WENYAO_SEAL_DATA_URI,
      alt: '',
      'aria-hidden': 'true',
      draggable: false,
      width: 52,
      height: 52,
      style: {
        width: 52,
        height: 52,
        borderRadius: '50%',
        objectFit: 'cover',
        boxShadow: `0 6px 20px rgba(0, 0, 0, 0.08), 0 0 0 1px ${border}`,
      },
    }),
    el('div', { style: { display: 'grid', gap: 5 } },
      el('p', { style: { margin: 0, fontWeight: 600, fontSize: 22, letterSpacing: '-0.02em', lineHeight: 1.3, color: ink } }, '你好，我是文鳐 Ray'),
      el('p', { style: { margin: 0, fontFamily: KAI_FONT, fontSize: 13, color: muted, letterSpacing: '0.06em' } },
        `${QUIET_PHRASE}${workspaceName !== '' ? ` · 专属工作区 ${workspaceName}` : ' · 你的个人助手小鳐'}`)),
    el('div', {
      style: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 8,
        width: '100%',
        marginTop: 6,
      },
    },
    ...STARTER_PROMPTS.map(textPrompt => el('button', {
      key: textPrompt,
      type: 'button',
      'data-chat-starter': '',
      style: idle(starterCardStyle, !ready || sending),
      disabled: !ready || sending,
      onClick: () => submitPayload(textPrompt, [], false),
    },
    el('span', { style: { minWidth: 0 } }, textPrompt),
    el('span', { 'data-chat-starter-arrow': '', style: { color: caption, display: 'inline-flex', flex: 'none' } }, ArrowUpRightIcon())))))
  } else {
    transcriptContent = [
      window.hasMore === true ? el('div', { key: 'older', style: { display: 'flex', justifyContent: 'center' } },
        el('button', {
          type: 'button',
          'data-chat-ghost-btn': '',
          'data-chat-round': '',
          style: idle({
            ...smallActionButtonStyle,
            borderRadius: 999,
            padding: '4px 14px',
            background: 'var(--oc-btn-bg, transparent)',
            color: `var(--oc-btn-fg, ${muted})`,
            border: `1px solid ${border}`,
            transition: 'background 140ms ease, color 140ms ease',
          }, loadingOlder),
          disabled: loadingOlder,
          onClick: loadOlder,
        }, loadingOlder ? '正在载入更早的消息…' : '载入更早的消息')) : null,
      ...messages.map(message => jsx(ChatMessageRow, {
        message,
        onCopy: (value: string) => copyTextToClipboard(value, setNotice),
      }, message.key)),
      streaming !== ''
        ? el('div', { key: 'streaming', 'data-chat-message-kind': 'streaming', style: assistantRowStyle, 'aria-live': 'polite' },
          el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: caption, marginBottom: 4 } },
            el('span', { 'data-chat-pulse': '', 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: 999, background: accent } }),
            '文鳐正在回复…'),
          renderChatMarkdown(streaming))
        : snapshot.running === true
          ? el('div', {
            key: 'thinking',
            'data-chat-message-kind': 'thinking',
            role: 'status',
            'aria-live': 'polite',
            style: { display: 'inline-flex', alignItems: 'center', gap: 8, color: muted, padding: '4px 0', fontSize: 13 },
          },
          el('span', { 'data-chat-pulse': '', 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: 999, background: accent } }),
          '文鳐正在思考…')
          : null,
    ]
  }

  const pendingConfirmBanner = pendingPermission === undefined
    ? null
    : el('div', {
      role: 'alertdialog',
      'aria-label': '确认切换权限',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        flexWrap: 'wrap',
        padding: '8px 12px',
        borderRadius: 12,
        fontSize: 12.5,
        color: ink,
        background: tint(danger, 9),
        border: `1px solid ${tint(danger, 28)}`,
      },
    },
    el('span', { style: { minWidth: 0 } },
      `切换到「${permissionLabel(pendingPermission, catalog.phase === 'ok' ? catalog.catalog : undefined)}」会扩大文鳐的权限，确认？`),
    el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' } },
      el('button', {
        type: 'button',
        style: { ...smallActionButtonStyle, borderColor: tint(danger, 40), color: danger },
        onClick: () => applyPermission(pendingPermission),
      }, '确认切换'),
      el('button', {
        type: 'button',
        'data-chat-ghost-btn': '',
        style: {
          ...smallActionButtonStyle,
          border: '1px solid transparent',
          background: 'var(--oc-btn-bg, transparent)',
          color: `var(--oc-btn-fg, ${muted})`,
          transition: 'background 140ms ease, color 140ms ease',
        },
        onClick: () => setPendingPermission(undefined),
      }, '取消')))

  const permissionNoticeBanner = permissionNotice === ''
    ? null
    : el('div', {
      role: 'status',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 10,
        fontSize: 12,
        color: muted,
        background: sunken,
        border: `1px solid ${hairline}`,
      },
    },
    el('span', {}, permissionNotice),
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'aria-label': '关闭权限提示',
      style: {
        border: 'none',
        borderRadius: 6,
        background: 'var(--oc-btn-bg, transparent)',
        color: `var(--oc-btn-fg, ${caption})`,
        cursor: 'pointer',
        padding: '2px 5px',
        fontSize: 14,
        lineHeight: 1,
        transition: 'background 140ms ease, color 140ms ease',
      },
      onClick: () => setPermissionNotice(''),
    }, '×'))

  const noticeBanner = notice === undefined
    ? null
    : el('div', {
      role: notice.tone === 'error' ? 'alert' : 'status',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '7px 12px',
        borderRadius: 10,
        fontSize: 12,
        color: ink,
        background: notice.tone === 'error' ? tint(danger, 9) : tint(accent, 9),
        border: `1px solid ${notice.tone === 'error' ? tint(danger, 28) : tint(accent, 24)}`,
      },
    },
    el('span', { style: { minWidth: 0, overflowWrap: 'anywhere' } }, notice.text),
    el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      'aria-label': '关闭提示',
      style: {
        border: 'none',
        borderRadius: 6,
        background: 'var(--oc-btn-bg, transparent)',
        color: `var(--oc-btn-fg, ${muted})`,
        cursor: 'pointer',
        padding: '2px 5px',
        fontSize: 14,
        lineHeight: 1,
        flex: 'none',
        transition: 'background 140ms ease, color 140ms ease',
      },
      onClick: () => setNotice(undefined),
    }, '×'))

  const permissionControl = jsx(PermissionControl, {
    session: binding?.session,
    permission,
    catalog,
    switching,
    request: requestPermission,
  })

  const modelControls = jsx(ModelRouteSelects, {
    catalog: effectiveCatalog,
    provider: activeModelProvider,
    model: activeModelId,
    reasoningEffort: activeModelEffort,
    compact: true,
    disabled: !ready || modelSwitching || typeof runtime.selectSessionModel !== 'function',
    onChange: handleModelRouteChange,
  })

  return el('section', { 'aria-label': '文鳐对话', 'data-owner-console-chat': '', style: chatRootStyle },
    el('div', { style: backdropStyle },
      el('img', {
        src: WENYAO_BACKDROP_DATA_URI,
        alt: '',
        'aria-hidden': 'true',
        draggable: false,
        'data-owner-console-art': 'backdrop',
        width: WENYAO_BACKDROP_WIDTH,
        height: WENYAO_BACKDROP_HEIGHT,
        style: chatBackdropImageStyle,
      })),
    el('header', { 'data-owner-console-chat-header': '', 'data-window-drag': '', style: topBarStyle },
      el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 auto', overflow: 'hidden' } },
        el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' } },
          jsx(ChatMark, {}),
          el('h2', { style: { margin: 0, fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.015em', whiteSpace: 'nowrap' } }, '文鳐 Ray'),
          sessionStatusChip(snapshot, ready)),
        hasMetadata ? el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' } },
          el('span', { 'aria-hidden': true, style: { width: 1, height: 13, background: border, flex: 'none' } }),
          workspaceName !== ''
            ? el('span', {
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 11.5,
                color: muted,
                minWidth: 0,
                flex: '0 1 auto',
                overflow: 'hidden',
              },
              title: assistantCtx?.workspace,
            },
            FolderIcon(),
            el('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `工作区: ${workspaceName}`))
            : null,
          caps?.memory ? capabilityChip('记忆') : null,
          caps?.wiki ? capabilityChip('Wiki') : null,
          caps?.feishuConnected ? capabilityChip('飞书在线', true) : null) : null),
      el('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, flex: 'none', marginLeft: 'auto' } },
        el('button', {
          type: 'button',
          'data-chat-ghost-btn': '',
          style: idle(headerActionButtonStyle, sending || modelSwitching),
          disabled: sending || modelSwitching,
          onClick: startFreshChat,
          'aria-label': '新对话',
          title: '开启全新的文鳐助手对话（不影响原生编码会话）',
        }, PlusIcon(13), '新对话'),
        el('button', {
          type: 'button',
          'data-chat-ghost-btn': '',
          style: headerIconButtonStyle,
          onClick: onOpenSettings,
          'aria-label': '打开设置',
          title: '配置、模型工具与自愈设置',
        }, GearIcon()))),
    el('div', {
      ref: log,
      'data-owner-console-chat-log': '',
      role: 'log',
      'aria-label': '对话消息',
      'aria-live': 'polite',
      style: scrollAreaStyle,
      onScroll: scroll,
    },
    el('div', { style: isWelcome ? welcomeInnerStyle : transcriptInnerStyle }, transcriptContent)),
    el('div', { style: dockShellStyle },
      el('div', { 'aria-hidden': 'true', 'data-chat-dock-veil': '', style: dockVeilStyle }),
      el('div', { style: dockContainerStyle },
        !atBottom && messages.length > 0 ? el('button', {
          type: 'button',
          'data-chat-surface-btn': '',
          'data-chat-round': '',
          style: scrollBottomButtonStyle,
          'aria-label': '滚动到底部',
          title: '回到底部',
          onClick: scrollToBottom,
        }, ArrowDownIcon()) : null,
        pendingConfirmBanner,
        permissionNoticeBanner,
        noticeBanner,
        jsx(Composer, {
          disabled,
          sending,
          draft,
          files,
          running: snapshot.running === true,
          cancelling,
          voiceAvailable,
          listening,
          speakAvailable,
          speakReady: lastAssistant !== undefined,
          permissionControl,
          modelControls,
          onDraft: setDraft,
          onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); submit() },
          onKeyDown: keyDown,
          onFiles: addFiles,
          onRemoveFile: (index: number) => setFiles(files.filter((_file, at) => at !== index)),
          onVoice: toggleVoice,
          onSpeak: speak,
          onStop: stop,
        }),
        el('p', {
          style: {
            ...hintStyle,
            fontSize: 11,
            textAlign: 'center',
            opacity: 0.78,
          },
        }, '文鳐独立助手会话 · 语音与朗读由浏览器提供（不是 DSH 模型功能）'))))
}
