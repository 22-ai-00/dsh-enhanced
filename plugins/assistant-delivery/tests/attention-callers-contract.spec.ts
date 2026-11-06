import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// WP19 guard: every in-repo caller of a Delivery background/owner notice
// declares its purpose. `attentionEnforce` stays off by default, so an
// undeclared caller would only be audited as `result`; this scan makes a new
// undeclared caller fail here instead. Tests are not scanned: they exercise
// undeclared legacy sends on purpose.
const root = fileURLToPath(new URL('../../../', import.meta.url))

/** Public notice seams: the first argument must declare `attention`. */
const noticeMethods = new Set(['enqueueBackground', 'enqueueBackgroundRoute', 'enqueueOwnerNotification'])
/** Delivery-internal seams: the audit argument must carry `envelope` or `lanePurpose`. */
const auditMethods = new Map([['enqueueBackgroundAuthorized', 2], ['auditAttention', 2]])

/** Call sites that forward an already typed input unchanged; the origin is checked where it is built. */
const forwarders = new Set([
  'plugins/assistant-automations/src/service.ts:enqueueBackground:input',
  'plugins/assistant-automations/src/service.ts:enqueueBackgroundRoute:input',
  'plugins/assistant-delivery/src/service.ts:auditAttention:audit',
])

interface CallSite { file: string; line: number; method: string; declared: boolean; argument: string }

function declares(node: ts.Expression | undefined, names: readonly string[]): boolean {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return false
  return node.properties.some(property => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && ts.isIdentifier(property.name) && names.includes(property.name.text))
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function scanAttentionCallers(file: string, text: string): { calls: CallSite[]; unexamined: string[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const calls: CallSite[] = []
  const unexamined: string[] = []
  const aliases = new Map<string, string>()
  const examined = new Set<ts.Node>()
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const methodOf = (node: ts.Expression): string | undefined => {
    const callee = unwrap(node)
    if (ts.isPropertyAccessExpression(callee) && (noticeMethods.has(callee.name.text) || auditMethods.has(callee.name.text))) {
      examined.add(callee)
      return callee.name.text
    }
    if (ts.isIdentifier(callee)) return aliases.get(callee.text)
    return undefined
  }
  const record = (method: string, args: readonly ts.Expression[], at: ts.Node) => {
    const index = auditMethods.get(method) ?? 0
    const argument = args[index]
    const names = noticeMethods.has(method) ? ['attention'] : ['envelope', 'lanePurpose']
    const forwarded = argument !== undefined && ts.isIdentifier(argument) && forwarders.has(`${file}:${method}:${argument.text}`)
    calls.push({ file, line: line(at), method, declared: forwarded || declares(argument, names),
      argument: argument === undefined ? '<none>' : argument.getText(source).slice(0, 80) })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const initializer = unwrap(node.initializer)
      if (ts.isPropertyAccessExpression(initializer) && (noticeMethods.has(initializer.name.text) || auditMethods.has(initializer.name.text))) {
        aliases.set(node.name.text, initializer.name.text)
        examined.add(initializer)
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression)
      // `seam.call(thisArg, input)`: the input is the second argument.
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'call') {
        const method = methodOf(callee.expression)
        if (method !== undefined) record(method, node.arguments.slice(1), node)
      } else {
        const method = methodOf(node.expression)
        if (method !== undefined) record(method, node.arguments, node)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  // Any other reference (a method passed as a callback, an element access, ...) escapes this scan.
  const references = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && (noticeMethods.has(node.name.text) || auditMethods.has(node.name.text))
      && !examined.has(node) && !ts.isTypeOfExpression(node.parent)) unexamined.push(`${file}:${line(node)} ${node.getText(source)}`)
    ts.forEachChild(node, references)
  }
  references(source)
  return { calls, unexamined }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.(?:c|m)?tsx?$/u.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

function repoSources(): string[] {
  return ['plugins', 'packages'].flatMap(group => readdirSync(join(root, group), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const src = join(root, group, entry.name, 'src')
      try { return sourceFiles(src) } catch { return [] }
    }))
}

describe('WP19 attention purpose callers', () => {
  const scans = repoSources().map(path => scanAttentionCallers(relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')))
  const calls = scans.flatMap(scan => scan.calls)

  it('finds the known in-repo notice and report callers', () => {
    const files = new Set(calls.map(call => call.file))
    for (const file of [
      'plugins/assistant-actions/src/service.ts', 'plugins/assistant-automations/src/coordinator.ts',
      'plugins/assistant-delivery/src/service.ts', 'plugins/assistant-proactive/src/index.ts',
      'plugins/assistant-skills/src/repair-feedback.ts', 'plugins/assistant-work-items/src/dispatch.ts',
    ]) expect(files).toContain(file)
  })

  it('every caller declares its purpose', () => {
    expect(calls.filter(call => !call.declared).map(call => `${call.file}:${call.line} ${call.method}(${call.argument})`)).toEqual([])
  })

  it('no notice seam is referenced outside an examined call', () => {
    expect(scans.flatMap(scan => scan.unexamined)).toEqual([])
  })

  it('rejects an undeclared caller, an aliased call and an escaped reference', () => {
    const scan = scanAttentionCallers('plugins/example/src/index.ts', [
      "delivery.enqueueBackground({ sourceId: 's', text: 't' })",
      "delivery.enqueueOwnerNotification!({ text: 't', attention: { purpose: 'result' } })",
      'const send = delivery.enqueueBackgroundRoute',
      "send.call(delivery, { text: 't' })",
      'register(delivery.enqueueOwnerNotification)',
      "if (typeof delivery?.enqueueBackground === 'function') {}",
    ].join('\n'))
    expect(scan.calls.map(call => [call.line, call.method, call.declared]))
      .toEqual([[1, 'enqueueBackground', false], [2, 'enqueueOwnerNotification', true], [4, 'enqueueBackgroundRoute', false]])
    expect(scan.unexamined).toEqual(['plugins/example/src/index.ts:5 delivery.enqueueOwnerNotification'])
  })
})
