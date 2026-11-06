/**
 * Shared visual primitives for the 文鳐 surfaces. The settings console and the chat window
 * use one token set, so both stay on the Host theme (`--dsw-*`) and the 11 深海觉醒
 * artwork rather than inventing a second style.
 */
import { jsx, jsxs } from 'react/jsx-runtime'
import { CloudMark, KAI_FONT } from './art.js'

export type Props = Record<string, unknown>

/** Hyperscript helper shared by every 文鳐 surface; keeps the client bundle on jsx-runtime only.
 * Keys are passed to the runtime directly (not spread), and multiple static children use the
 * static-children entry point so React does not mistake them for an unkeyed dynamic list. */
export const el = (tag: string, props: Props, ...children: readonly unknown[]) => {
  const { key, ...rest } = props
  if (children.length === 0) return jsx(tag as never, rest as never, key as never)
  if (children.length === 1) return jsx(tag as never, { ...rest, children: children[0] } as never, key as never)
  return jsxs(tag as never, { ...rest, children } as never, key as never)
}

/*
 * Theme tokens: only Host `--dsw-alias-*` variables (light/dark switch with the shell), each
 * with a light-theme fallback so an embedding without the token set still reads correctly.
 */
export const ink = 'var(--dsw-alias-label-primary, #0f1115)'
export const muted = 'var(--dsw-alias-label-secondary, #61666b)'
export const caption = 'var(--dsw-alias-label-tertiary, #81858c)'
export const monoFont = 'ui-monospace, SFMono-Regular, Menlo, monospace'
export const monoMuted = { fontSize: 12, color: caption, fontFamily: monoFont } as const
export const hairline = 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.04))'
export const border = 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))'
export const borderStrong = 'var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))'
export const surface = 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, transparent))'
export const sunken = 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))'
export const accent = 'var(--dsw-alias-state-business-primary, #4176e6)'
export const danger = 'var(--dsw-alias-state-error-primary, #ec1313)'

/** Status tone for a pill; every pill also carries a text label, so tone is never the only signal. */
export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral'

export const toneColor: Readonly<Record<StatusTone, string>> = {
  ok: 'var(--dsw-alias-state-success-primary, #22c55e)',
  warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  error: danger,
  neutral: 'var(--dsw-alias-state-idle-primary, #a3a3a3)',
}
/** A translucent wash of a token colour; works in both themes because it mixes with transparent. */
export const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`

export const cardStyle = { border: `1px solid ${border}`, borderRadius: 12, padding: '16px 18px', background: surface,
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.04)', display: 'grid', gap: 12, minWidth: 0 }
export const inputStyle = { padding: '7px 10px', borderRadius: 8, border: `1px solid ${borderStrong}`, background: 'transparent',
  color: 'inherit', fontSize: 13, lineHeight: 1.4, width: '100%', minWidth: 0, boxSizing: 'border-box' }
/** Secondary button: outlined, quiet. */
export const buttonStyle = { padding: '6px 12px', borderRadius: 8, border: `1px solid ${borderStrong}`, background: 'transparent',
  color: ink, fontSize: 13, fontWeight: 500, lineHeight: 1.4, cursor: 'pointer', whiteSpace: 'nowrap' }
/** Primary button: the shell's own primary fill so it inverts with the theme. */
export const primaryButtonStyle = { ...buttonStyle, border: '1px solid transparent',
  background: 'var(--dsw-alias-button-primary-fill, #0f1115)', color: 'var(--dsw-alias-label-primary-foreground, #ffffff)' }
export const dangerButtonStyle = { ...buttonStyle, color: danger, border: `1px solid ${tint(danger, 40)}` }
export const gridStyle = { display: 'grid', gap: 8 }
/** Grouped read-only rows sit on a sunken well so they read as one block. */
export const listStyle = { display: 'grid', background: sunken, borderRadius: 10, padding: '2px 12px' }
export const actionsStyle = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }
export const hintStyle = { margin: 0, fontSize: 12, color: caption }
export const subheadStyle = { margin: 0, fontSize: 12, fontWeight: 600, color: muted, letterSpacing: '0.02em' }

/** Disabled buttons keep their <button> semantics; this only dims them while a write is in flight. */
export const idle = (style: Readonly<Record<string, unknown>>, busy: boolean) =>
  busy ? { ...style, opacity: 0.5, cursor: 'not-allowed' } : style

export function pill(label: string, tone: StatusTone) {
  const color = toneColor[tone]
  return el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '1px 10px 1px 8px', borderRadius: 999,
    fontSize: 12, fontWeight: 500, lineHeight: '20px', color: ink, background: tint(color, 14), border: `1px solid ${tint(color, 32)}`, whiteSpace: 'nowrap' } },
  el('span', { 'aria-hidden': true, style: { width: 6, height: 6, borderRadius: 999, background: color, flex: 'none' } }), label)
}

/** Empty/pending state; an empty list may add a short classical line under the plain message. */
export function placeholder(text: string, phrase?: string) {
  return el('div', { style: { padding: '14px 12px', borderRadius: 10, border: `1px dashed ${border}`, color: caption, fontSize: 12, textAlign: 'center', display: 'grid', gap: 2 } },
    el('p', { style: { margin: 0 } }, text),
    phrase === undefined ? null : el('p', { style: { margin: 0, fontFamily: KAI_FONT, fontSize: 13, color: muted, letterSpacing: '0.12em' } }, phrase))
}

export function row(label: string, value: unknown) {
  return el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 0', borderTop: `1px solid ${hairline}`, minWidth: 0 } },
    el('span', { style: { color: muted, flex: 'none' } }, label),
    el('span', { style: { textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' } }, value))
}

/** Every card shares one frame: a titled header followed by evenly spaced body blocks. */
export function card(title: string, ...body: readonly unknown[]) {
  return el('div', { style: cardStyle },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      el('span', { style: { color: accent, opacity: 0.75 } }, jsx(CloudMark, {})),
      el('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: ink, whiteSpace: 'nowrap' } }, title),
      el('span', { 'aria-hidden': true, style: { flex: 1, height: 1, minWidth: 24, background: `linear-gradient(90deg, ${border}, transparent)` } })),
    ...body)
}

export function field(label: string, value: string, onChange: (next: string) => void, placeholderText = '') {
  return el('label', { style: { display: 'grid', gap: 4, fontSize: 12, fontWeight: 500, color: muted, minWidth: 0, flex: '1 1 200px' } },
    el('span', {}, label),
    el('input', { value, placeholder: placeholderText, style: inputStyle,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value) }))
}

/** The artwork layer sits behind the content; `user-select`/pointer events stay off the decoration. */
export const backdropStyle = { position: 'absolute', inset: 0, zIndex: 0, overflow: 'hidden', pointerEvents: 'none', userSelect: 'none' } as const
export const backdropImageStyle = { display: 'block', width: '100%', height: 'auto', opacity: 0.2,
  maskImage: 'linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, 0.55) 55%, transparent 94%)',
  WebkitMaskImage: 'linear-gradient(to bottom, #000 0%, rgba(0, 0, 0, 0.55) 55%, transparent 94%)' } as const
