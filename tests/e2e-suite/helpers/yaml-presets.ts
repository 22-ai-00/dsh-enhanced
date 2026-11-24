import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, isSeq, parse, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml'
import { repoRoot } from './workspace.ts'

export function parseCordisPatch(source: string): {
  document: Document
  rows: YAMLSeq | null
} {
  const document = parseDocument(source.trim() === '' ? '[]' : source, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    logLevel: 'silent',
  })
  return {
    document,
    rows: isSeq(document.contents) ? document.contents : null,
  }
}

export function findPatchRow(doc: Document, rowId: string): YAMLMap | undefined {
  if (!isSeq(doc.contents)) return undefined
  for (const item of doc.contents.items) {
    if (!isMap(item)) continue
    if (item.get('id') === rowId) return item
  }
  return undefined
}

export function getPatchConfig(row: YAMLMap | undefined): Record<string, unknown> {
  if (row === undefined) return {}
  const cfg = row.get('config', true)
  if (isMap(cfg)) {
    return cfg.toJSON() as Record<string, unknown>
  }
  return {}
}

export async function parseWorkflowYaml<T = Record<string, unknown>>(relPath: string): Promise<T> {
  const content = await readFile(join(repoRoot, relPath), 'utf8')
  return parse(content, { logLevel: 'silent' }) as T
}

export async function readInstallerCommonScript(): Promise<string> {
  return readFile(join(repoRoot, 'scripts/install/common.sh'), 'utf8')
}

export function parseBashArray(script: string, arrayName: string): string[] {
  const escaped = arrayName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const startMatch = new RegExp(`(?:^|\\n)[ \\t]*${escaped}=\\(`, 'u').exec(script)
  if (startMatch === null) {
    return []
  }

  let idx = startMatch.index + startMatch[0].length
  let quote: "'" | '"' | undefined
  let inComment = false
  let body = ''

  while (idx < script.length) {
    const ch = script[idx]!
    if (inComment) {
      if (ch === '\n') {
        inComment = false
        body += ch
      }
      idx += 1
      continue
    }
    if (quote === "'") {
      if (ch === "'") {
        quote = undefined
      }
      body += ch
      idx += 1
      continue
    }
    if (quote === '"') {
      if (ch === '\\' && idx + 1 < script.length) {
        body += ch + script[idx + 1]!
        idx += 2
        continue
      }
      if (ch === '"') {
        quote = undefined
      }
      body += ch
      idx += 1
      continue
    }
    if (ch === '#') {
      inComment = true
      idx += 1
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      body += ch
      idx += 1
      continue
    }
    if (ch === '\\' && idx + 1 < script.length) {
      body += ch + script[idx + 1]!
      idx += 2
      continue
    }
    if (ch === ')') {
      break
    }
    body += ch
    idx += 1
  }

  const items: string[] = []
  let token = ''
  let hasToken = false
  let tokQuote: "'" | '"' | undefined
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!
    if (tokQuote === "'") {
      if (ch === "'") {
        tokQuote = undefined
      } else {
        token += ch
      }
      continue
    }
    if (tokQuote === '"') {
      if (ch === '\\' && i + 1 < body.length) {
        token += body[i + 1]!
        i += 1
        continue
      }
      if (ch === '"') {
        tokQuote = undefined
      } else {
        token += ch
      }
      continue
    }
    if (ch === "'" || ch === '"') {
      tokQuote = ch
      hasToken = true
      continue
    }
    if (/\s/u.test(ch)) {
      if (hasToken) {
        items.push(token)
        token = ''
        hasToken = false
      }
      continue
    }
    if (ch === '\\' && i + 1 < body.length) {
      token += body[i + 1]!
      hasToken = true
      i += 1
      continue
    }
    token += ch
    hasToken = true
  }
  if (hasToken) {
    items.push(token)
  }
  return items
}
