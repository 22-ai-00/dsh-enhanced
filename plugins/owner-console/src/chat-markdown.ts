import { createElement, Fragment } from 'react'
import { accent, border, borderStrong, buttonStyle, caption, el, hairline, muted, sunken, tint } from './ui.js'

const codeFont = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

const preStyle = {
  margin: '6px 0',
  padding: '10px 12px',
  borderRadius: 8,
  border: `1px solid ${border}`,
  background: sunken,
  fontFamily: codeFont,
  fontSize: 12,
  lineHeight: 1.5,
  overflowX: 'auto',
  whiteSpace: 'pre',
} as const

const codeHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  marginBottom: 6,
  paddingBottom: 4,
  borderBottom: `1px solid ${hairline}`,
  fontSize: 11,
  color: caption,
} as const

const inlineCodeStyle = {
  fontFamily: codeFont,
  fontSize: '0.9em',
  padding: '1px 5px',
  borderRadius: 5,
  background: sunken,
  border: `1px solid ${hairline}`,
} as const

const quoteStyle = {
  margin: '6px 0',
  padding: '4px 10px',
  borderLeft: `3px solid ${borderStrong}`,
  color: muted,
} as const

function safeHttpUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}

const TRAILING_URL_PUNCT = new Set(['。', '，', '、', '）', '；', '：', '.', ',', ';', ':', ')'])

function splitTrailingUrlPunctuation(raw: string): readonly [string, string] {
  let end = raw.length
  while (end > 0 && TRAILING_URL_PUNCT.has(raw[end - 1]!)) {
    end -= 1
  }
  return [raw.slice(0, end), raw.slice(end)]
}

function renderInline(text: string, keyPrefix: string): unknown[] {
  const nodes: unknown[] = []
  // Tokenize inline code, bold, markdown links, and bare http(s) URLs cleanly in one pass.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+?\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()（），。、；：]+)/gu
  let lastIndex = 0
  let match: RegExpExecArray | null
  let tokenIndex = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    const k = `${keyPrefix}-${tokenIndex++}`
    if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
      nodes.push(el('code', { key: k, style: inlineCodeStyle }, token.slice(1, -1)))
    } else if (token.startsWith('**') && token.endsWith('**') && token.length >= 4) {
      nodes.push(el('strong', { key: k, style: { fontWeight: 600 } }, token.slice(2, -2)))
    } else if (token.startsWith('[')) {
      const splitAt = token.indexOf('](')
      const label = token.slice(1, splitAt)
      const href = safeHttpUrl(token.slice(splitAt + 2, -1))
      nodes.push(href === undefined
        ? token
        : el('a', {
          key: k,
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { color: accent, textDecoration: 'underline' },
        }, label))
    } else {
      const [cleanUrl, trailing] = splitTrailingUrlPunctuation(token)
      const href = safeHttpUrl(cleanUrl)
      if (href === undefined) {
        nodes.push(token)
      } else {
        nodes.push(el('a', {
          key: k,
          href,
          target: '_blank',
          rel: 'noopener noreferrer',
          style: { color: accent, textDecoration: 'underline' },
        }, cleanUrl))
        if (trailing !== '') nodes.push(trailing)
      }
    }
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  return nodes
}

function renderInlineLines(lines: readonly string[], keyPrefix: string): unknown[] {
  const out: unknown[] = []
  lines.forEach((line, idx) => {
    if (idx > 0) out.push(createElement('br', { key: `${keyPrefix}-br-${idx}` }))
    out.push(...renderInline(line, `${keyPrefix}-l${idx}`))
  })
  return out
}

function renderTextBlocks(chunk: string, blockPrefix: string): unknown[] {
  const out: unknown[] = []
  const lines = chunk.replace(/\r\n/gu, '\n').split('\n')
  let idx = 0
  let itemKey = 0

  while (idx < lines.length) {
    const line = lines[idx]!
    if (line.trim() === '') {
      idx += 1
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/u.exec(line)
    if (heading !== null) {
      const level = heading[1]!.length
      const fontSize = level === 1 ? 16 : level === 2 ? 15 : 14
      out.push(el('div', {
        key: `${blockPrefix}-h-${itemKey++}`,
        style: { fontWeight: 600, fontSize, lineHeight: 1.4, margin: '6px 0 2px' },
      }, ...renderInline(heading[2]!, `${blockPrefix}-hi-${itemKey}`)))
      idx += 1
      continue
    }

    if (/^>\s?/u.test(line)) {
      const quoted: string[] = []
      while (idx < lines.length && /^>\s?/u.test(lines[idx]!)) {
        quoted.push(lines[idx]!.replace(/^>\s?/u, ''))
        idx += 1
      }
      out.push(el('blockquote', { key: `${blockPrefix}-q-${itemKey++}`, style: quoteStyle },
        ...renderInlineLines(quoted, `${blockPrefix}-qi-${itemKey}`)))
      continue
    }

    if (/^\s*[-*]\s+/u.test(line)) {
      const items: string[] = []
      while (idx < lines.length && /^\s*[-*]\s+/u.test(lines[idx]!)) {
        items.push(lines[idx]!.replace(/^\s*[-*]\s+/u, ''))
        idx += 1
      }
      out.push(el('ul', {
        key: `${blockPrefix}-ul-${itemKey++}`,
        style: { margin: '4px 0', paddingLeft: 18, display: 'grid', gap: 2 },
      }, ...items.map((item, j) => el('li', { key: j }, ...renderInline(item, `${blockPrefix}-uli-${itemKey}-${j}`)))))
      continue
    }

    if (/^\s*\d+\.\s+/u.test(line)) {
      const items: string[] = []
      while (idx < lines.length && /^\s*\d+\.\s+/u.test(lines[idx]!)) {
        items.push(lines[idx]!.replace(/^\s*\d+\.\s+/u, ''))
        idx += 1
      }
      out.push(el('ol', {
        key: `${blockPrefix}-ol-${itemKey++}`,
        style: { margin: '4px 0', paddingLeft: 20, display: 'grid', gap: 2 },
      }, ...items.map((item, j) => el('li', { key: j }, ...renderInline(item, `${blockPrefix}-oli-${itemKey}-${j}`)))))
      continue
    }

    const para: string[] = []
    while (
      idx < lines.length
      && lines[idx]!.trim() !== ''
      && !/^(#{1,4})\s+/u.test(lines[idx]!)
      && !/^>\s?/u.test(lines[idx]!)
      && !/^\s*[-*]\s+/u.test(lines[idx]!)
      && !/^\s*\d+\.\s+/u.test(lines[idx]!)
    ) {
      para.push(lines[idx]!)
      idx += 1
    }
    out.push(el('p', {
      key: `${blockPrefix}-p-${itemKey++}`,
      style: { margin: '2px 0', whiteSpace: 'pre-wrap' },
    }, ...renderInlineLines(para, `${blockPrefix}-pi-${itemKey}`)))
  }

  return out
}

function renderCodeBlock(lang: string, code: string, key: string, onCopyCode?: (code: string) => void): unknown {
  return el('div', {
    key,
    style: { ...preStyle, background: tint(accent, 4) },
  },
  el('div', { style: codeHeaderStyle },
    el('span', {}, lang),
    onCopyCode === undefined ? null : el('button', {
      type: 'button',
      style: { ...buttonStyle, padding: '1px 7px', fontSize: 11 },
      onClick: () => onCopyCode(code),
    }, '复制')),
  el('code', { style: { display: 'block', overflowX: 'auto' } }, code))
}

/** Render assistant chat text cleanly with XSS-safe inline formatting and fenced code blocks. */
export function renderChatMarkdown(text: string, onCopyCode?: (code: string) => void): unknown {
  const normalized = text.replace(/\r\n/gu, '\n')
  const fencePattern = /```([A-Za-z0-9_+-]*)[ \t]*\n([\s\S]*?)```/gu
  const segments: unknown[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  let blockIndex = 0

  while ((match = fencePattern.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      segments.push(...renderTextBlocks(normalized.slice(lastIndex, match.index), `t-${blockIndex++}`))
    }
    const lang = match[1]?.trim() || 'code'
    const code = match[2]!.replace(/\n$/u, '')
    segments.push(renderCodeBlock(lang, code, `code-${blockIndex++}`, onCopyCode))
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < normalized.length) {
    const rest = normalized.slice(lastIndex)
    const unclosed = /```([A-Za-z0-9_+-]*)[ \t]*\n([\s\S]*)$/u.exec(rest)
    if (unclosed !== null) {
      if (unclosed.index > 0) {
        segments.push(...renderTextBlocks(rest.slice(0, unclosed.index), `t-${blockIndex++}`))
      }
      const lang = unclosed[1]?.trim() || 'code'
      const code = unclosed[2]!.replace(/\n$/u, '')
      segments.push(renderCodeBlock(lang, code, `code-${blockIndex++}`, onCopyCode))
    } else {
      segments.push(...renderTextBlocks(rest, `t-${blockIndex++}`))
    }
  }

  return segments.length === 0
    ? createElement(Fragment, {}, text)
    : el('div', { style: { display: 'grid', gap: 4 } }, ...segments)
}
