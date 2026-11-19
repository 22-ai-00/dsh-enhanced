import { createElement, Fragment } from 'react'
import { accent, border, borderStrong, caption, el, hairline, muted, sunken, tint } from './ui.js'

export const codeFont = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace)'
/** Elevated code surfaces wired to DSH Markdown tokens with light-theme fallbacks. */
const codeBlockSurface = `var(--dsw-alias-markdown-code-block, color-mix(in srgb, ${sunken} 68%, var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2, #ffffff))))`
const codeHeaderSurface = 'var(--dsw-alias-markdown-code-block-banner, color-mix(in srgb, var(--dsw-alias-label-primary, #0f1115) 3.5%, transparent))'
const inlineCodeSurface = `var(--dsw-alias-markdown-inline-code, ${sunken})`
const hairlineBorder = `var(--dsh-hairline-width, 1px) solid ${hairline}`
const frameBorder = `var(--dsh-hairline-width, 1px) solid ${border}`
const strongFrameBorder = `var(--dsh-hairline-width, 1px) solid ${borderStrong}`

const codeCardStyle = {
  margin: '6px 0',
  minWidth: 0,
  boxSizing: 'border-box',
  borderRadius: 10,
  border: frameBorder,
  background: codeBlockSurface,
  overflow: 'hidden',
} as const

const codeHeaderStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '5px 10px 5px 12px',
  background: codeHeaderSurface,
  borderBottom: hairlineBorder,
  fontFamily: codeFont,
  fontSize: 11,
  color: caption,
} as const

const codeBodyStyle = {
  display: 'block',
  padding: '10px 12px',
  fontFamily: codeFont,
  fontSize: '0.9em',
  lineHeight: 1.55,
  overflowX: 'auto',
  whiteSpace: 'pre',
} as const

const codeCopyButtonStyle = {
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'var(--oc-btn-bg, transparent)',
  color: `var(--oc-btn-fg, ${muted})`,
  fontSize: 11,
  fontWeight: 500,
  lineHeight: 1.4,
  cursor: 'pointer',
  transition: 'background 140ms ease, color 140ms ease',
} as const

const inlineCodeStyle = {
  fontFamily: codeFont,
  fontSize: '0.88em',
  padding: '1.5px 6px',
  borderRadius: 6,
  background: inlineCodeSurface,
  border: hairlineBorder,
} as const

const quoteStyle = {
  margin: '6px 0',
  padding: '6px 12px',
  borderLeft: `2.5px solid ${tint(accent, 48)}`,
  borderRadius: '0 8px 8px 0',
  background: sunken,
  color: muted,
} as const

const linkStyle = {
  color: accent,
  textDecoration: 'underline',
  textDecorationColor: tint(accent, 45),
  textUnderlineOffset: '2px',
} as const

const hrStyle = {
  border: 'none',
  borderTop: frameBorder,
  margin: '10px 0',
} as const

const tableWrapStyle = {
  margin: '6px 0',
  width: '100%',
  maxWidth: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  overflowX: 'auto',
  overscrollBehaviorX: 'contain',
  borderRadius: 10,
  border: frameBorder,
} as const

const tableStyle = {
  minWidth: '100%',
  width: 'max-content',
  borderCollapse: 'collapse',
  fontSize: '0.93em',
  lineHeight: 1.5,
  overflowWrap: 'break-word',
  wordBreak: 'normal',
} as const

const tableHeadBg = `var(--dsw-alias-markdown-code-block, ${sunken})`

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
  // Tokenize double/single-backtick inline code, bold, markdown links, and bare http(s) URLs in one pass.
  const pattern = /(``(?:[^`\n]|`(?!`))+``|`[^`\n]+`|\*\*[^*\n]+?\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()（），。、；：]+)/gu
  let lastIndex = 0
  let match: RegExpExecArray | null
  let tokenIndex = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    const token = match[0]
    const k = `${keyPrefix}-${tokenIndex++}`
    if (token.startsWith('``') && token.endsWith('``') && token.length >= 4) {
      const raw = token.slice(2, -2)
      const inner = raw.length >= 2 && raw.startsWith(' ') && raw.endsWith(' ') && raw.trim() !== '' ? raw.slice(1, -1) : raw
      nodes.push(el('code', { key: k, style: inlineCodeStyle }, inner))
    } else if (token.startsWith('`') && token.endsWith('`') && token.length >= 2) {
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
          style: linkStyle,
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
          style: linkStyle,
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

const HR_PATTERN = /^\s*(?:-{3,}|\*{3,})\s*$/u
const TABLE_SEP_CELL = /^:?-{1,}:?$/u

type TableAlign = 'left' | 'center' | 'right'

function findClosingBackticks(text: string, from: number, count: number): number {
  let j = from
  while (j < text.length) {
    if (text[j] === '`') {
      let run = 0
      while (j + run < text.length && text[j + run] === '`') run += 1
      if (run === count) return j
      j += run
      continue
    }
    j += 1
  }
  return -1
}

function unescapeTablePipes(segment: string): string {
  let out = ''
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] === '\\') {
      let run = 0
      while (i + run < segment.length && segment[i + run] === '\\') run += 1
      if (i + run < segment.length && segment[i + run] === '|' && run % 2 === 1) {
        out += '\\'.repeat(run - 1) + '|'
        i += run
        continue
      }
      out += '\\'.repeat(run)
      i += run - 1
      continue
    }
    out += segment[i]!
  }
  return out
}

function splitTableCells(line: string): string[] {
  const trimmed = line.trim()
  const cells: string[] = []
  let current = ''
  let endedWithPipe = false
  const start = trimmed.startsWith('|') ? 1 : 0

  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!
    if (ch === '\\') {
      let run = 0
      while (i + run < trimmed.length && trimmed[i + run] === '\\') run += 1
      if (i + run < trimmed.length && trimmed[i + run] === '|' && run % 2 === 1) {
        current += '\\'.repeat(run - 1) + '|'
        i += run
        endedWithPipe = false
        continue
      }
      current += '\\'.repeat(run)
      i += run - 1
      endedWithPipe = false
      continue
    }
    if (ch === '`') {
      let run = 0
      while (i + run < trimmed.length && trimmed[i + run] === '`') run += 1
      const closing = findClosingBackticks(trimmed, i + run, run)
      if (closing !== -1) {
        const spanEnd = closing + run
        // Per GFM §4.10, `\|` unescapes to `|` inside code spans too; unescaped `|` stays inside the code span.
        current += unescapeTablePipes(trimmed.slice(i, spanEnd))
        i = spanEnd - 1
        endedWithPipe = false
        continue
      }
      current += '`'.repeat(run)
      i += run - 1
      endedWithPipe = false
      continue
    }
    if (ch === '|') {
      cells.push(current.trim())
      current = ''
      endedWithPipe = i === trimmed.length - 1
      continue
    }
    current += ch
    endedWithPipe = false
  }
  if (!endedWithPipe) {
    cells.push(current.trim())
  }
  return cells
}

function parseTableStart(
  lines: readonly string[],
  idx: number,
): Readonly<{ headers: readonly string[]; alignments: readonly TableAlign[] }> | null {
  if (idx + 1 >= lines.length) return null
  const headerLine = lines[idx]!
  const sepLine = lines[idx + 1]!
  if (!headerLine.includes('|') || !sepLine.includes('|')) return null
  const headers = splitTableCells(headerLine)
  const sepCells = splitTableCells(sepLine)
  if (headers.length === 0 || sepCells.length !== headers.length) return null
  const alignments: TableAlign[] = []
  for (const cell of sepCells) {
    if (!TABLE_SEP_CELL.test(cell)) return null
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    alignments.push(left && right ? 'center' : right ? 'right' : 'left')
  }
  return { headers, alignments }
}

function renderTable(
  headers: readonly string[],
  alignments: readonly TableAlign[],
  bodyRows: readonly (readonly string[])[],
  keyPrefix: string,
): unknown {
  return el('div', { key: keyPrefix, 'data-chat-md-table': '', style: tableWrapStyle },
    el('table', { style: tableStyle },
      el('thead', {},
        el('tr', {},
          ...headers.map((cell, colIdx) => el('th', {
            key: colIdx,
            style: {
              padding: '8px 12px',
              minWidth: 96,
              maxWidth: 320,
              boxSizing: 'border-box',
              fontWeight: 600,
              color: muted,
              background: tableHeadBg,
              textAlign: alignments[colIdx] ?? 'left',
              verticalAlign: 'top',
              ...(bodyRows.length > 0 ? { borderBottom: strongFrameBorder } : {}),
              ...(colIdx > 0 ? { borderLeft: frameBorder } : {}),
            },
          }, ...renderInline(cell, `${keyPrefix}-th-${colIdx}`))))),
      bodyRows.length === 0
        ? null
        : el('tbody', {},
          ...bodyRows.map((row, rowIdx) => el('tr', { key: rowIdx },
            ...row.map((cell, colIdx) => el('td', {
              key: colIdx,
              style: {
                padding: '8px 12px',
                minWidth: 96,
                maxWidth: 320,
                boxSizing: 'border-box',
                textAlign: alignments[colIdx] ?? 'left',
                verticalAlign: 'top',
                ...(rowIdx > 0 ? { borderTop: frameBorder } : {}),
                ...(colIdx > 0 ? { borderLeft: frameBorder } : {}),
              },
            }, ...renderInline(cell, `${keyPrefix}-td-${rowIdx}-${colIdx}`))))))))
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

    if (HR_PATTERN.test(line)) {
      out.push(el('hr', { key: `${blockPrefix}-hr-${itemKey++}`, style: hrStyle }))
      idx += 1
      continue
    }

    const heading = /^(#{1,4})\s+(.+)$/u.exec(line)
    if (heading !== null) {
      const level = heading[1]!.length
      const fontSize = level === 1 ? '1.22em' : level === 2 ? '1.11em' : '1em'
      const marginTop = level === 1 ? 12 : level === 2 ? 10 : 8
      out.push(el('div', {
        key: `${blockPrefix}-h-${itemKey++}`,
        style: { fontWeight: 600, fontSize, lineHeight: 1.38, letterSpacing: '-0.01em', margin: `${marginTop}px 0 3px` },
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
        style: { margin: '4px 0', paddingLeft: 20, display: 'grid', gap: 4, lineHeight: 1.65 },
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
        style: { margin: '4px 0', paddingLeft: 22, display: 'grid', gap: 4, lineHeight: 1.65 },
      }, ...items.map((item, j) => el('li', { key: j }, ...renderInline(item, `${blockPrefix}-oli-${itemKey}-${j}`)))))
      continue
    }

    const tableHeader = parseTableStart(lines, idx)
    if (tableHeader !== null) {
      idx += 2
      const colCount = tableHeader.headers.length
      const bodyRows: string[][] = []
      while (
        idx < lines.length
        && lines[idx]!.trim() !== ''
        && lines[idx]!.includes('|')
        && !HR_PATTERN.test(lines[idx]!)
        && !/^(#{1,4})\s+/u.test(lines[idx]!)
        && !/^>\s?/u.test(lines[idx]!)
        && !/^\s*[-*]\s+/u.test(lines[idx]!)
        && !/^\s*\d+\.\s+/u.test(lines[idx]!)
      ) {
        const parsed = splitTableCells(lines[idx]!).slice(0, colCount)
        while (parsed.length < colCount) parsed.push('')
        bodyRows.push(parsed)
        idx += 1
      }
      out.push(renderTable(tableHeader.headers, tableHeader.alignments, bodyRows, `${blockPrefix}-tbl-${itemKey++}`))
      continue
    }

    const para: string[] = []
    while (
      idx < lines.length
      && lines[idx]!.trim() !== ''
      && !HR_PATTERN.test(lines[idx]!)
      && !/^(#{1,4})\s+/u.test(lines[idx]!)
      && !/^>\s?/u.test(lines[idx]!)
      && !/^\s*[-*]\s+/u.test(lines[idx]!)
      && !/^\s*\d+\.\s+/u.test(lines[idx]!)
      && parseTableStart(lines, idx) === null
    ) {
      para.push(lines[idx]!)
      idx += 1
    }
    out.push(el('p', {
      key: `${blockPrefix}-p-${itemKey++}`,
      style: { margin: '2px 0', lineHeight: 1.68, whiteSpace: 'pre-wrap' },
    }, ...renderInlineLines(para, `${blockPrefix}-pi-${itemKey}`)))
  }

  return out
}

function renderCodeBlock(lang: string, code: string, key: string, onCopyCode?: (code: string) => void): unknown {
  return el('div', {
    key,
    style: codeCardStyle,
  },
  el('div', { style: codeHeaderStyle },
    el('span', {}, lang),
    onCopyCode === undefined ? null : el('button', {
      type: 'button',
      'data-chat-ghost-btn': '',
      style: codeCopyButtonStyle,
      onClick: () => onCopyCode(code),
    }, '复制')),
  el('code', { style: codeBodyStyle }, code))
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
    : el('div', { 'data-chat-md': '', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 5, minWidth: 0 } }, ...segments)
}
