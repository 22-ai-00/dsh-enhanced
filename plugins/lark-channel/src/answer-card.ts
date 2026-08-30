import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

const MAX_LARK_TABLES_PER_CARD = 5
const MAX_LARK_TABLE_COLUMNS = 50
const MAX_LARK_TABLE_PAGE_SIZE = 10

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false })

export interface LarkAnswerMarkdownElement {
  tag: 'markdown'
  content: string
  text_align: 'left'
  text_size?: 'heading-1' | 'heading-2' | 'heading-3'
}

export interface LarkAnswerTableColumn {
  name: string
  display_name: string
  data_type: 'lark_md'
  horizontal_align: 'left' | 'center' | 'right'
  vertical_align: 'top'
  width: 'auto'
}

export interface LarkAnswerTableElement {
  tag: 'table'
  page_size: number
  row_height: 'auto'
  row_max_height: '120px'
  header_style: {
    text_size: 'normal'
    background_style: 'grey'
    text_color: 'default'
    bold: true
    lines: 2
  }
  columns: readonly LarkAnswerTableColumn[]
  rows: readonly Readonly<Record<string, string>>[]
}

export type LarkAnswerCardElement = LarkAnswerMarkdownElement | LarkAnswerTableElement

interface ParsedTable {
  headers: readonly string[]
  alignments: readonly LarkAnswerTableColumn['horizontal_align'][]
  rows: readonly (readonly string[])[]
}

function matchingClose(tokens: readonly Token[], openIndex: number): number {
  const open = tokens[openIndex]
  if (open === undefined) return openIndex
  const closeType = open.type.replace(/_open$/u, '_close')
  let depth = 1
  for (let index = openIndex + 1; index < tokens.length; index++) {
    const token = tokens[index]
    if (token?.type === open.type) depth += 1
    if (token?.type === closeType) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return tokens.length - 1
}

function cellAlignment(token: Token): LarkAnswerTableColumn['horizontal_align'] {
  const style = token.attrGet('style') ?? ''
  if (/text-align\s*:\s*center/iu.test(style)) return 'center'
  if (/text-align\s*:\s*right/iu.test(style)) return 'right'
  return 'left'
}

function plainHeader(value: string, index: number): string {
  const inlineTokens = markdown.parseInline(value, {})
  const content: string[] = []
  const collect = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === 'text' || token.type === 'code_inline' || token.type === 'image') {
        content.push(token.content)
      } else if (token.type === 'softbreak' || token.type === 'hardbreak') {
        content.push(' ')
      }
      if (token.children !== null && token.type !== 'image') collect(token.children)
    }
  }
  collect(inlineTokens)
  return content.join('').trim() || `列 ${index + 1}`
}

function parseTable(tokens: readonly Token[]): ParsedTable | undefined {
  const headers: string[] = []
  const alignments: LarkAnswerTableColumn['horizontal_align'][] = []
  const rows: string[][] = []
  let section: 'body' | 'head' | undefined
  let currentRow: string[] | undefined
  let currentCellAlignment: LarkAnswerTableColumn['horizontal_align'] = 'left'
  let inCell = false

  for (const token of tokens) {
    switch (token.type) {
      case 'thead_open':
        section = 'head'
        break
      case 'thead_close':
        section = undefined
        break
      case 'tbody_open':
        section = 'body'
        break
      case 'tbody_close':
        section = undefined
        break
      case 'tr_open':
        currentRow = []
        break
      case 'tr_close':
        if (section === 'body' && currentRow !== undefined) rows.push(currentRow)
        currentRow = undefined
        break
      case 'th_open':
      case 'td_open':
        inCell = true
        currentCellAlignment = cellAlignment(token)
        break
      case 'th_close':
      case 'td_close':
        inCell = false
        break
      case 'inline':
        if (!inCell) break
        if (section === 'head') {
          headers.push(token.content)
          alignments.push(currentCellAlignment)
        } else if (section === 'body' && currentRow !== undefined) {
          currentRow.push(token.content)
        }
        break
      default:
        break
    }
  }

  if (headers.length === 0) return undefined
  return {
    headers,
    alignments,
    rows: rows.map(row => headers.map((_header, index) => row[index] ?? '')),
  }
}

function nativeTable(table: ParsedTable): LarkAnswerTableElement {
  const columns = table.headers.map((header, index): LarkAnswerTableColumn => ({
    name: `col_${index}`,
    display_name: plainHeader(header, index),
    data_type: 'lark_md',
    horizontal_align: table.alignments[index] ?? 'left',
    vertical_align: 'top',
    width: 'auto',
  }))
  return {
    tag: 'table',
    page_size: Math.min(MAX_LARK_TABLE_PAGE_SIZE, Math.max(1, table.rows.length)),
    row_height: 'auto',
    row_max_height: '120px',
    header_style: {
      text_size: 'normal',
      background_style: 'grey',
      text_color: 'default',
      bold: true,
      lines: 2,
    },
    columns,
    rows: table.rows.map(row => Object.fromEntries(columns.map((column, index) => [
      column.name,
      row[index] ?? '',
    ]))),
  }
}

function tableAsMarkdownList(table: ParsedTable): string {
  if (table.rows.length === 0) {
    return table.headers.map((header, index) => `- **${plainHeader(header, index)}**`).join('\n')
  }
  return table.rows.map(row => {
    const fields = table.headers.map((header, index) => {
      const label = plainHeader(header, index)
      return `**${label}：** ${row[index] ?? ''}`
    })
    return `- ${fields.join('  \n  ')}`
  }).join('\n')
}

function headingSize(token: Token): NonNullable<LarkAnswerMarkdownElement['text_size']> {
  if (token.tag === 'h1') return 'heading-1'
  if (token.tag === 'h2') return 'heading-2'
  return 'heading-3'
}

function sourceLines(lines: readonly string[], map: readonly [number, number]): string {
  return lines.slice(map[0], map[1]).join('\n')
}

/**
 * Convert authored Markdown into Feishu Card JSON 2.0 body elements.
 *
 * Feishu's Markdown component does not lay out GFM pipe tables. Top-level tables therefore become
 * native table components. A card supports at most five table components and fifty columns per
 * table, so overflow becomes readable Markdown lists rather than leaking raw pipe syntax or making
 * the whole card invalid.
 */
export function renderLarkAnswerElements(input: string): readonly LarkAnswerCardElement[] {
  if (input.length === 0) return [{ tag: 'markdown', content: '', text_align: 'left' }]
  let tokens: readonly Token[]
  try {
    tokens = markdown.parse(input.replaceAll('\r\n', '\n'), {})
  } catch {
    return [{ tag: 'markdown', content: input, text_align: 'left' }]
  }
  const lines = input.replaceAll('\r\n', '\n').split('\n')
  if (!tokens.some(token => token.level === 0
    && (token.type === 'table_open' || token.type === 'heading_open'))) {
    return [{ tag: 'markdown', content: input, text_align: 'left' }]
  }
  const elements: LarkAnswerCardElement[] = []
  const markdownBuffer: string[] = []
  let nativeTableCount = 0

  const flushMarkdown = () => {
    const content = markdownBuffer.join('\n\n').replace(/\n{3,}/gu, '\n\n').trim()
    markdownBuffer.length = 0
    if (content.length > 0) elements.push({ tag: 'markdown', content, text_align: 'left' })
  }

  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    if (token === undefined) break
    if (token.level !== 0) {
      index += 1
      continue
    }

    if (token.type === 'table_open') {
      const closeIndex = matchingClose(tokens, index)
      const table = parseTable(tokens.slice(index, closeIndex + 1))
      if (table === undefined) {
        if (token.map !== null) markdownBuffer.push(sourceLines(lines, token.map))
      } else if (nativeTableCount < MAX_LARK_TABLES_PER_CARD
        && table.headers.length <= MAX_LARK_TABLE_COLUMNS) {
        flushMarkdown()
        elements.push(nativeTable(table))
        nativeTableCount += 1
      } else {
        markdownBuffer.push(tableAsMarkdownList(table))
      }
      index = closeIndex + 1
      continue
    }

    if (token.type === 'heading_open') {
      flushMarkdown()
      const inline = tokens[index + 1]
      if (inline?.type === 'inline' && inline.content.trim().length > 0) {
        elements.push({
          tag: 'markdown',
          content: inline.content.trim(),
          text_align: 'left',
          text_size: headingSize(token),
        })
      }
      index = matchingClose(tokens, index) + 1
      continue
    }

    if (token.type === 'fence' || token.type === 'code_block') {
      const fence = token.markup || '```'
      const info = token.info.trim()
      markdownBuffer.push(`${fence}${info}\n${token.content.replace(/\n+$/u, '')}\n${fence}`)
      index += 1
      continue
    }

    if (token.type.endsWith('_open') && token.map !== null) {
      markdownBuffer.push(sourceLines(lines, token.map))
      index = matchingClose(tokens, index) + 1
      continue
    }

    if (token.type === 'hr') markdownBuffer.push('---')
    index += 1
  }

  flushMarkdown()
  return elements.length > 0
    ? elements
    : [{ tag: 'markdown', content: input, text_align: 'left' }]
}
