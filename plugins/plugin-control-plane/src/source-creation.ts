import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AnySourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { ControlPlaneCliError } from './errors.js'
import { awaitSourceSignal, type SourceInspection } from './source-context.js'
import { changedSourcePaths, linkedWorktrees, runLocalBuffer, runLocalCommand, writeCreatedPluginFiles,
  validateScopedPluginFiles, type ScopedPluginFile } from './source-workspace.js'

const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const GRANT_ID = /^(?=.{1,128}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const DIGEST = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_FILE_BYTES = 65_536
const MAX_TOTAL_BYTES = 262_144
const MAX_OUTPUT_BYTES = 8_192
const CREATE_SCOPE = (name: string): readonly string[] => Object.freeze([`plugins/${name}`, 'plugins/README.md', 'pnpm-lock.yaml'])
const HOST_INPUTS = ['scripts/create-plugin.mjs', 'LICENSE', 'plugins/README.md', 'package.json',
  'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json'] as const
/** Host-generated plugin metadata outside candidate authority. */
export const RESERVED_OUTPUTS = ['package.json', 'cordis.patch.yml', 'LICENSE', 'tsconfig.json',
  'tsconfig.build.json', 'src/version.ts'] as const
/** Strictly immutable Host-generated files that candidates can never edit. */
export const IMMUTABLE_OUTPUTS = ['LICENSE', 'tsconfig.json', 'tsconfig.build.json', 'src/version.ts'] as const
/** Controlled metadata files editable within strict schema/security invariants. */
export const CONTROLLED_OUTPUTS = ['package.json', 'cordis.patch.yml'] as const

export type CandidatePluginKind = 'tool' | 'service' | 'channel' | 'ui'
export const CANDIDATE_PLUGIN_KINDS: readonly CandidatePluginKind[] = Object.freeze(['tool', 'service', 'channel', 'ui'])

export function normalizeCandidatePluginKind(value: unknown): CandidatePluginKind {
  if (value === undefined) return 'tool'
  if (typeof value === 'string' && (CANDIDATE_PLUGIN_KINDS as readonly string[]).includes(value)) {
    return value as CandidatePluginKind
  }
  throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate pluginKind is invalid: ${String(value)}`)
}

export interface SourceCreationGrant {
  id: string
  workItemFailures?: boolean
  expiresAt: number
  maxCreates: number
  namePrefix: string
}

export interface SourceCreationBinding {
  grant: SourceCreationGrant
  generatorDigest: string
  /** Host-frozen ordinary-use run; absent on historical and manual creations. */
  growthRun?: AnySourceGrowthRunBinding
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

/** Shape validation remains valid for historical, already-expired grants. */
export function validateSourceCreationGrant(value: unknown): asserts value is SourceCreationGrant {
  if (!record(value) || Object.keys(value).sort().join(',') !== ['expiresAt','id','maxCreates','namePrefix',...(Object.hasOwn(value,'workItemFailures')?['workItemFailures']:[])].sort().join(',')
    || Object.hasOwn(value,'workItemFailures')&&typeof value['workItemFailures']!=='boolean'
    || typeof value.id !== 'string' || !GRANT_ID.test(value.id) || value.id.normalize('NFC') !== value.id
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0
    || typeof value.maxCreates !== 'number' || !Number.isSafeInteger(value.maxCreates) || value.maxCreates < 1 || value.maxCreates > 1_000
    || typeof value.namePrefix !== 'string' || value.namePrefix.length < 2 || value.namePrefix.length > 48
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u.test(value.namePrefix)) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'source creation grant is invalid')
  }
}

export function normalizeSourceCreationGrant(value:SourceCreationGrant):SourceCreationGrant {
  validateSourceCreationGrant(value)
  const result=structuredClone(value);if(result.workItemFailures!==true)delete result.workItemFailures
  return result
}

const VALID_PKG_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/u
const ALLOWED_MANIFEST_KEYS = new Set([
  'name', 'version', 'description', 'license', 'type', 'main', 'types', 'exports', 'files',
  'scripts', 'engines', 'publishConfig', 'repository', 'keywords', 'dsh',
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta',
])
const ALLOWED_DSH_KEYS = new Set(['bundle', 'pluginKind', 'kind', 'ui', 'channel', 'client'])
const ALLOWED_DSH_META_KEYS = ['ui', 'channel', 'client'] as const
const ALLOWED_PATCH_DECL_KEYS = ['ui', 'routes', 'sections', 'settings', 'channel', 'services', 'provides'] as const
const ALLOWED_PATCH_ROW_KEYS = new Set(['id', 'name', 'inject', 'config', 'disabled', ...ALLOWED_PATCH_DECL_KEYS])
const ALLOWED_EXPORT_KEYS = new Set(['.', './cordis.patch.yml', './package.json', './client'])
const CONTROL_CHAR_RE = /[\p{Cc}]/u
const CLIENT_JS_EXPORT_RE = /^\.\/lib\/[A-Za-z0-9._/-]+\.js$/u
const CLIENT_DTS_EXPORT_RE = /^\.\/lib\/[A-Za-z0-9._/-]+\.d\.ts$/u

function isSafePeerDependencyRange(range: string): boolean {
  if (range === 'catalog:' || range === 'workspace:*' || range === 'workspace:^' || range === 'workspace:~') return true
  if (range.length === 0 || range.length > 128 || CONTROL_CHAR_RE.test(range)) return false
  if (range.includes(':') || range.includes('/') || range.includes('\\')) return false
  return /^[~^>=<0-9*][~^>=<0-9A-Za-z.*| -]*$/u.test(range)
}

function isSafeClientExportPath(pathValue: unknown, pattern: RegExp): boolean {
  return typeof pathValue === 'string'
    && pathValue.length <= 256
    && !CONTROL_CHAR_RE.test(pathValue)
    && pattern.test(pathValue)
    && !pathValue.split('/').includes('..')
    && !pathValue.includes('//')
}

function validateCandidateClientExport(entry: unknown): void {
  if (typeof entry === 'string') {
    if (!isSafeClientExportPath(entry, CLIENT_JS_EXPORT_RE)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports["./client"]')
    }
    return
  }
  if (!record(entry)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports["./client"]')
  }
  const keys = Object.keys(entry)
  if (keys.length === 0 || keys.some(key => key !== 'types' && key !== 'import' && key !== 'default')
    || (entry.default === undefined && entry.import === undefined)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports["./client"]')
  }
  if (entry.default !== undefined && !isSafeClientExportPath(entry.default, CLIENT_JS_EXPORT_RE)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports["./client"].default')
  }
  if (entry.import !== undefined && !isSafeClientExportPath(entry.import, CLIENT_JS_EXPORT_RE)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports["./client"].import')
  }
  if (entry.types !== undefined && !isSafeClientExportPath(entry.types, CLIENT_DTS_EXPORT_RE)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports["./client"].types')
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function assertSafeJsonData(value: unknown, label: string, depth = 0): void {
  if (depth > 12) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} exceeds nesting depth`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} contains non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJsonData(item, label, depth + 1)
    return
  }
  if (!record(value)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} must be plain JSON object`)
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `${label} contains unsafe property ${key}`)
    }
    assertSafeJsonData(item, label, depth + 1)
  }
}

function validateControlledManifestShape(content: string): Record<string, unknown> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: exceeds size limit')
  }
  let parsed: unknown
  try { parsed = JSON.parse(content) as unknown } catch {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid JSON')
  }
  if (!record(parsed)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: manifest must be a plain object')
  }
  assertSafeJsonData(parsed, 'package.json')
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_MANIFEST_KEYS.has(key)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: disallowed key ${key}`)
    }
  }
  if (typeof parsed.name !== 'string' || !VALID_PKG_NAME.test(parsed.name) || typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: missing name or version')
  }
  if (parsed.description !== undefined && (typeof parsed.description !== 'string'
    || Buffer.byteLength(parsed.description, 'utf8') > 512 || CONTROL_CHAR_RE.test(parsed.description))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid description')
  }
  if (parsed.keywords !== undefined) {
    if (!Array.isArray(parsed.keywords) || parsed.keywords.length > 16
      || parsed.keywords.some(kw => typeof kw !== 'string' || kw.length === 0 || Buffer.byteLength(kw, 'utf8') > 64 || CONTROL_CHAR_RE.test(kw))) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid keywords')
    }
  }
  if (parsed.exports !== undefined) {
    if (!record(parsed.exports)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid exports')
    }
    for (const key of Object.keys(parsed.exports)) {
      if (!ALLOWED_EXPORT_KEYS.has(key)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: disallowed exports key ${key}`)
      }
    }
    if (Object.hasOwn(parsed.exports, './client')) {
      validateCandidateClientExport(parsed.exports['./client'])
    }
  }
  if (parsed.dsh !== undefined) {
    if (!record(parsed.dsh)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid dsh metadata')
    }
    for (const key of Object.keys(parsed.dsh)) {
      if (!ALLOWED_DSH_KEYS.has(key)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: disallowed dsh key ${key}`)
      }
    }
    const normalizedPluginKind = parsed.dsh.pluginKind !== undefined ? normalizeCandidatePluginKind(parsed.dsh.pluginKind) : undefined
    const normalizedKind = parsed.dsh.kind !== undefined ? normalizeCandidatePluginKind(parsed.dsh.kind) : undefined
    if (normalizedPluginKind !== undefined && normalizedKind !== undefined && normalizedPluginKind !== normalizedKind) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: dsh.pluginKind and dsh.kind disagree')
    }
    for (const metaKey of ALLOWED_DSH_META_KEYS) {
      const metaVal = parsed.dsh[metaKey]
      if (metaVal === undefined) continue
      if (!record(metaVal) || Object.keys(metaVal).length > 32) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: invalid dsh.${metaKey}`)
      }
      assertSafeJsonData(metaVal, `package.json dsh.${metaKey}`)
      if (Buffer.byteLength(JSON.stringify(metaVal), 'utf8') > 8_192) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: dsh.${metaKey} exceeds size limit`)
      }
    }
    if (parsed.dsh.bundle !== undefined && (!record(parsed.dsh.bundle) || parsed.dsh.bundle.patch !== './cordis.patch.yml'
      || Object.keys(parsed.dsh.bundle).length !== 1)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid dsh.bundle')
    }
  }
  const seenDeps = new Set<string>()
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const map = parsed[group]
    if (map === undefined) continue
    if (!record(map) || Object.keys(map).length > 64) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: invalid ${group}`)
    }
    for (const [depName, spec] of Object.entries(map)) {
      if (!VALID_PKG_NAME.test(depName) || spec !== 'catalog:' || seenDeps.has(depName)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: dependency ${depName} must use catalog:`)
      }
      seenDeps.add(depName)
    }
  }
  if (parsed.peerDependencies !== undefined) {
    if (!record(parsed.peerDependencies) || Object.keys(parsed.peerDependencies).length > 32) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid peerDependencies')
    }
    const meta = parsed.peerDependenciesMeta
    if (!record(meta)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: peerDependencies requires peerDependenciesMeta')
    }
    for (const [peerName, range] of Object.entries(parsed.peerDependencies)) {
      if ((!peerName.startsWith('@deepseek-ai/') && !peerName.startsWith('@dsh-enhanced/'))
        || !VALID_PKG_NAME.test(peerName) || typeof range !== 'string' || !isSafePeerDependencyRange(range)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: invalid peer ${peerName}`)
      }
      const peerMeta = meta[peerName]
      if (!record(peerMeta) || peerMeta.optional !== true) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: peer ${peerName} must be marked optional`)
      }
    }
  }
  if (parsed.peerDependenciesMeta !== undefined) {
    if (!record(parsed.peerDependenciesMeta)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "package.json" is outside candidate authority: invalid peerDependenciesMeta')
    }
    for (const [peerName, entry] of Object.entries(parsed.peerDependenciesMeta)) {
      if (!VALID_PKG_NAME.test(peerName) || !record(entry) || typeof entry.optional !== 'boolean' || Object.keys(entry).length !== 1) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "package.json" is outside candidate authority: invalid peerDependenciesMeta for ${peerName}`)
      }
    }
  }
  return parsed
}

export function validateCandidatePackageJson(name: string, baseManifestText: string, candidateText: string): Record<string, unknown> {
  const base = JSON.parse(baseManifestText) as Record<string, unknown>
  const cand = validateControlledManifestShape(candidateText)
  if (cand.name !== `@dsh-enhanced/${name}` || cand.name !== base.name) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'candidate package.json cannot alter package name')
  }
  for (const field of ['version', 'license', 'type', 'main', 'types', 'files', 'scripts', 'engines', 'publishConfig', 'repository'] as const) {
    if (canonicalJson(cand[field]) !== canonicalJson(base[field])) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate package.json cannot alter immutable field ${field}`)
    }
  }
  const baseExports = record(base.exports) ? base.exports : undefined
  const candExports = record(cand.exports) ? cand.exports : undefined
  if (baseExports === undefined || candExports === undefined) {
    if (canonicalJson(cand.exports) !== canonicalJson(base.exports)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'candidate package.json cannot alter immutable field exports')
    }
  } else {
    for (const key of Object.keys(candExports)) {
      if (!ALLOWED_EXPORT_KEYS.has(key)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate package.json exports key is disallowed: ${key}`)
      }
    }
    for (const key of ['.', './cordis.patch.yml', './package.json'] as const) {
      if (canonicalJson(candExports[key]) !== canonicalJson(baseExports[key])) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate package.json cannot alter immutable field exports[${key}]`)
      }
    }
  }
  const baseDsh = record(base.dsh) ? base.dsh : {}
  const candDsh = record(cand.dsh) ? cand.dsh : undefined
  if (candDsh === undefined || canonicalJson(candDsh.bundle) !== canonicalJson(baseDsh.bundle)
    || canonicalJson(candDsh.protection) !== canonicalJson(baseDsh.protection)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'candidate package.json cannot alter dsh.bundle or dsh.protection')
  }
  if (cand.keywords !== undefined) {
    const kws = cand.keywords as string[]
    for (const reqKw of ['deepseek', 'deepseek-harness', 'dsh-plugin']) {
      if (!kws.includes(reqKw)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate package.json keywords must retain ${reqKw}`)
      }
    }
  }
  const baseDev = record(base.devDependencies) ? base.devDependencies : {}
  const candDev = record(cand.devDependencies) ? cand.devDependencies : {}
  for (const [dep, spec] of Object.entries(baseDev)) {
    if (candDev[dep] !== spec) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate package.json must retain scaffold devDependency ${dep}`)
    }
  }
  const basePeers = record(base.peerDependencies) ? base.peerDependencies : {}
  const candPeers = record(cand.peerDependencies) ? cand.peerDependencies : {}
  for (const [peer, range] of Object.entries(basePeers)) {
    if (candPeers[peer] !== range) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate package.json must retain scaffold peerDependency ${peer}`)
    }
  }
  return cand
}

interface YamlLine { indent: number; text: string }

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | undefined
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote === "'") {
      if (ch === "'" && line[i + 1] === "'") { i++; continue }
      if (ch === "'") quote = undefined
    } else if (quote === '"') {
      if (ch === '\\') { i++; continue }
      if (ch === '"') quote = undefined
    } else {
      if (ch === "'" || ch === '"') quote = ch
      else if (ch === '#' && (i === 0 || line[i - 1] === ' ')) return line.slice(0, i).trimEnd()
    }
  }
  return line.trimEnd()
}

function parseYamlScalar(raw: string): unknown {
  const s = raw.trim()
  if (s === '') return ''
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('!') || s.includes('<<:')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'cordis.patch.yml uses forbidden YAML anchors, tags, or merges')
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(s)) {
    const num = Number(s)
    if (!Number.isFinite(num)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'cordis.patch.yml number is not finite')
    return num
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replaceAll("''", "'")
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) as unknown } catch {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'cordis.patch.yml contains invalid double-quoted string')
    }
  }
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      const parsed = JSON.parse(s) as unknown
      assertSafeJsonData(parsed, 'cordis.patch.yml')
      return parsed
    } catch (error) {
      if (error instanceof ControlPlaneCliError) throw error
      if (s.startsWith('[') && s.endsWith(']') && !s.includes('{') && !s.includes('}')) {
        const inner = s.slice(1, -1).trim()
        if (inner === '') return []
        if (!inner.includes('[') && !inner.includes(']')) {
          const items = inner.split(',').map(part => part.trim())
          if (items.every(part => part.length > 0)) {
            const parsedItems = items.map(part => parseYamlScalar(part))
            assertSafeJsonData(parsedItems, 'cordis.patch.yml')
            return parsedItems
          }
        }
      }
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'cordis.patch.yml contains invalid inline flow collection')
    }
  }
  return s
}

function splitKeyVal(text: string): { key: string; rest: string } {
  const colonIdx = text.indexOf(':')
  if (colonIdx <= 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `cordis.patch.yml invalid mapping line: ${text}`)
  const rawKey = text.slice(0, colonIdx).trim()
  const after = text.slice(colonIdx + 1)
  if (after.length > 0 && after[0] !== ' ') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', `cordis.patch.yml invalid mapping syntax: ${text}`)
  }
  const keyVal = parseYamlScalar(rawKey)
  if (typeof keyVal !== 'string' || keyVal.length === 0 || keyVal === '<<' || keyVal === '__proto__' || keyVal === 'constructor' || keyVal === 'prototype') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', `cordis.patch.yml invalid key: ${rawKey}`)
  }
  return { key: keyVal, rest: after.trim() }
}

function parseYamlBlock(lines: readonly YamlLine[], start: number, indent: number): { value: unknown; next: number } {
  if (start >= lines.length) return { value: {}, next: start }
  const first = lines[start]!
  if (first.indent < indent) return { value: {}, next: start }
  if (first.text === '-' || first.text.startsWith('- ')) {
    const arr: unknown[] = []
    let idx = start
    while (idx < lines.length && lines[idx]!.indent === first.indent && (lines[idx]!.text === '-' || lines[idx]!.text.startsWith('- '))) {
      const itemText = lines[idx]!.text.slice(1).trim()
      idx += 1
      if (itemText === '') {
        const nested = parseYamlBlock(lines, idx, first.indent + 1)
        arr.push(nested.value); idx = nested.next
      } else if (/^[a-zA-Z0-9_'"@./-]+:(?:\s.*)?$/u.test(itemText) && !itemText.startsWith("'") && !itemText.startsWith('"') && itemText.includes(':')) {
        const { key, rest } = splitKeyVal(itemText)
        const obj: Record<string, unknown> = {}
        const itemIndent = first.indent + 2
        if (rest === '') {
          const nextIsSeq = idx < lines.length && (lines[idx]!.text === '-' || lines[idx]!.text.startsWith('- '))
          const nested = parseYamlBlock(lines, idx, nextIsSeq ? itemIndent : itemIndent + 1)
          obj[key] = nested.value; idx = nested.next
        } else {
          obj[key] = parseYamlScalar(rest)
        }
        while (idx < lines.length && lines[idx]!.indent >= itemIndent) {
          if (lines[idx]!.indent !== itemIndent || lines[idx]!.text.startsWith('-')) {
            throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'cordis.patch.yml has inconsistent indentation')
          }
          const nextPair = splitKeyVal(lines[idx]!.text)
          idx += 1
          if (nextPair.rest === '') {
            const nextIsSeq = idx < lines.length && (lines[idx]!.text === '-' || lines[idx]!.text.startsWith('- '))
            const nested = parseYamlBlock(lines, idx, nextIsSeq ? itemIndent : itemIndent + 1)
            obj[nextPair.key] = nested.value; idx = nested.next
          } else {
            obj[nextPair.key] = parseYamlScalar(nextPair.rest)
          }
        }
        arr.push(obj)
      } else {
        arr.push(parseYamlScalar(itemText))
      }
    }
    return { value: arr, next: idx }
  }
  const obj: Record<string, unknown> = {}
  let idx = start
  while (idx < lines.length && lines[idx]!.indent === first.indent) {
    if (lines[idx]!.text.startsWith('-')) break
    const { key, rest } = splitKeyVal(lines[idx]!.text)
    idx += 1
    if (rest === '') {
      const nextIsSeq = idx < lines.length && (lines[idx]!.text === '-' || lines[idx]!.text.startsWith('- '))
      const nested = parseYamlBlock(lines, idx, nextIsSeq ? first.indent : first.indent + 1)
      obj[key] = nested.value; idx = nested.next
    } else {
      obj[key] = parseYamlScalar(rest)
    }
  }
  return { value: obj, next: idx }
}

export interface ControlledPatchRow {
  id: string
  name: string
  inject?: string[] | Record<string, boolean>
  config?: Record<string, unknown>
  disabled?: boolean
  ui?: unknown
  routes?: unknown
  sections?: unknown
  settings?: unknown
  channel?: unknown
  services?: unknown
  provides?: unknown
}

export function parseControlledPatchYaml(content: string): ControlledPatchRow {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES || content.includes('\t') || content.includes('\r')
    || content.includes('\0') || content.includes('{{')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: forbidden characters or tokens')
  }
  const parsedLines: YamlLine[] = []
  for (const rawLine of content.split('\n')) {
    const stripped = stripYamlComment(rawLine)
    if (stripped.trim() === '') continue
    if (stripped.trim() === '---' || stripped.trim() === '...') {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: document markers forbidden')
    }
    const leading = stripped.length - stripped.trimStart().length
    parsedLines.push({ indent: leading, text: stripped.trimStart() })
  }
  if (parsedLines.length === 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: empty patch')
  }
  const root = parseYamlBlock(parsedLines, 0, 0)
  if (root.next !== parsedLines.length || !Array.isArray(root.value) || root.value.length !== 1 || !record(root.value[0])) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: must contain single - insert block')
  }
  const insertBlock = root.value[0]
  if (Object.keys(insertBlock).length !== 1 || !Array.isArray(insertBlock.insert) || insertBlock.insert.length !== 1 || !record(insertBlock.insert[0])) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: - insert must contain exactly one entry')
  }
  const row = insertBlock.insert[0]
  for (const key of Object.keys(row)) {
    if (!ALLOWED_PATCH_ROW_KEYS.has(key)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "cordis.patch.yml" is outside candidate authority: disallowed patch key ${key}`)
    }
  }
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || row.id.length === 0 || row.name.length === 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: entry requires string id and name')
  }
  if (row.disabled !== undefined && typeof row.disabled !== 'boolean') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: disabled must be boolean')
  }
  if (row.inject !== undefined) {
    if (Array.isArray(row.inject)) {
      if (row.inject.length > 32 || row.inject.some(item => typeof item !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/u.test(item))) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: invalid inject array')
      }
    } else if (record(row.inject)) {
      if (Object.keys(row.inject).length > 32 || Object.entries(row.inject).some(([k, v]) => !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/u.test(k) || typeof v !== 'boolean')) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: invalid inject map')
      }
    } else {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: invalid inject')
    }
  }
  if (row.config !== undefined) {
    if (!record(row.config)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file "cordis.patch.yml" is outside candidate authority: config must be a plain object')
    }
    assertSafeJsonData(row.config, 'cordis.patch.yml config')
  }
  for (const declKey of ALLOWED_PATCH_DECL_KEYS) {
    const declVal = row[declKey]
    if (declVal === undefined) continue
    assertSafeJsonData(declVal, `cordis.patch.yml ${declKey}`)
    if (Buffer.byteLength(JSON.stringify(declVal), 'utf8') > 16_384) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file "cordis.patch.yml" is outside candidate authority: ${declKey} exceeds size limit`)
    }
  }
  return row as unknown as ControlledPatchRow
}

export function validateCandidateCordisPatch(name: string, _basePatchText: string, candidateText: string): void {
  const row = parseControlledPatchYaml(candidateText)
  if (row.id !== `dsh-enhanced-${name}` || row.name !== `@dsh-enhanced/${name}`) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', `candidate cordis.patch.yml must mount @dsh-enhanced/${name} with id dsh-enhanced-${name}`)
  }
}

export function extractCandidatePluginKindFromManifestText(content: string): CandidatePluginKind {
  const parsed = validateControlledManifestShape(content)
  if (!record(parsed.dsh)) return 'tool'
  if (parsed.dsh.pluginKind !== undefined) return normalizeCandidatePluginKind(parsed.dsh.pluginKind)
  if (parsed.dsh.kind !== undefined) return normalizeCandidatePluginKind(parsed.dsh.kind)
  return 'tool'
}

export function extractCandidatePluginKindFromFiles(files: readonly ScopedPluginFile[]): CandidatePluginKind {
  const pkg = files.find(file => file.path === 'package.json')
  if (!pkg) return 'tool'
  return extractCandidatePluginKindFromManifestText(pkg.content)
}

/** Candidate authority includes runtime source, documentation, tests, and controlled manifest/patch metadata. */
export function validateSourceCreationFiles(files: readonly ScopedPluginFile[]): void {
  validateScopedPluginFiles(files)
  for (const file of files) {
    if (file.path === 'package.json') {
      validateControlledManifestShape(file.content)
      continue
    }
    if (file.path === 'cordis.patch.yml') {
      parseControlledPatchYaml(file.content)
      continue
    }
    if (file.path !== file.path.normalize('NFC')
      || !(file.path === 'README.md' || /^(?:src|tests)\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(file.path))
      || file.path === 'src/version.ts' || file.path.endsWith('/package.json')
      || file.path.endsWith('/cordis.patch.yml') || file.path.endsWith('/LICENSE')
      || file.path.endsWith('/tsconfig.json') || file.path.endsWith('/tsconfig.build.json')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation file is outside candidate authority: ${JSON.stringify(file.path)}`)
    }
  }
}

function creationName(name: string, grant: SourceCreationGrant): void {
  validateSourceCreationGrant(grant)
  if (name.normalize('NFC') !== name || !NAME.test(name) || !name.startsWith(grant.namePrefix)
    || name.length <= grant.namePrefix.length) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin name is outside the owner creation namespace')
  }
}

interface BaseBlob { path: string; hash: string; mode: string; bytes: number }
interface BaseAssets { repository: string; baseCommit: string; generatorDigest: string; blobs: ReadonlyMap<string, BaseBlob> }

async function checked<T>(signal: AbortSignal, assertCurrent: () => void | Promise<void>, operation: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted(); await awaitSourceSignal(signal, assertCurrent)
  const result = await operation(); signal.throwIfAborted(); await awaitSourceSignal(signal, assertCurrent)
  return result
}

async function canonicalGitRoot(path: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const repository = await realpath(path)
  if (repository !== resolve(path)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source repository must be canonical')
  const top = (await runLocalCommand('git', ['rev-parse', '--show-toplevel'], repository, environment,
    { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })).trim()
  if (top !== repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source repository must be a Git top-level')
  return repository
}

async function baseAssets(input: { repository: string; baseCommit?: string; baselineCommit?: string;
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void> }): Promise<BaseAssets> {
  const repository = await checked(input.signal, input.assertCurrent,
    () => canonicalGitRoot(input.repository, input.environment, input.signal))
  if (input.baseCommit !== undefined && !COMMIT.test(input.baseCommit)
    || input.baselineCommit !== undefined && !COMMIT.test(input.baselineCommit)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base commit is invalid')
  }
  const baseCommit = (await checked(input.signal, input.assertCurrent,
    () => runLocalCommand('git', ['rev-parse', '--verify', `${input.baselineCommit ?? 'HEAD'}^{commit}`], repository,
      input.environment, { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal: input.signal }))).trim()
  if (!COMMIT.test(baseCommit) || input.baseCommit !== undefined && input.baseCommit !== baseCommit
    || input.baselineCommit !== undefined && input.baselineCommit !== baseCommit) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base commit changed')
  }
  const listed = await checked(input.signal, input.assertCurrent,
    () => runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', baseCommit, '--',
      ...HOST_INPUTS, 'templates/plugin'], repository, input.environment,
    { capture: true, maximumOutput: 65_536, timeoutMs: 15_000, signal: input.signal }))
  const blobs = new Map<string, BaseBlob>()
  for (const entry of listed.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/u.exec(entry)
    if (match === null || blobs.has(match[4]!) || Number(match[3]) > 8_388_608
      || !(HOST_INPUTS as readonly string[]).includes(match[4]!) && !match[4]!.startsWith('templates/plugin/')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base inputs are unsafe')
    }
    blobs.set(match[4]!, { path: match[4]!, hash: match[2]!, mode: match[1]!, bytes: Number(match[3]) })
  }
  if (HOST_INPUTS.some(path => !blobs.has(path)) || ![...blobs.keys()].some(path => path.startsWith('templates/plugin/'))
    || [...blobs.keys()].some(path => path.startsWith('templates/plugin/') && !path.endsWith('.tpl'))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation template or Host inputs are missing')
  }
  const manifest = JSON.parse((await gitBlob(repository, blobs.get('package.json')!, input.environment, input.signal)).toString('utf8')) as { scripts?: Record<string, unknown> }
  if (manifest.scripts?.['create:plugin'] !== 'node ./scripts/create-plugin.mjs') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base public generator command changed')
  }
  const digest = createHash('sha256').update('dsh-prepared-create-generator-v1\0')
  for (const blob of [...blobs.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(blob.path).update('\0').update(blob.mode).update('\0').update(blob.hash).update('\0')
  }
  return { repository, baseCommit, generatorDigest: digest.digest('hex'), blobs }
}

async function gitBlob(repository: string, blob: BaseBlob, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<Buffer> {
  const bytes = await runLocalBuffer('git', ['cat-file', 'blob', blob.hash], repository, environment,
    { maximumOutput: blob.bytes + 1, timeoutMs: 15_000, signal })
  if (bytes.length !== blob.bytes) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base blob changed')
  return bytes
}

async function safeBytes(path: string, maxBytes: number): Promise<Buffer> {
  const expected = resolve(path)
  if (await realpath(expected) !== expected) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file is not canonical')
  const before = await lstat(expected)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file is not a bounded regular file')
  }
  const handle = await open(expected, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const bytes = await handle.readFile(); const after = await lstat(expected)
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation file changed while read')
    }
    return bytes
  } finally { await handle.close() }
}

async function assertBaseFiles(worktree: string, assets: BaseAssets, environment: NodeJS.ProcessEnv, signal: AbortSignal,
  generated = false): Promise<void> {
  for (const blob of assets.blobs.values()) {
    if (generated && (blob.path === 'plugins/README.md' || blob.path === 'pnpm-lock.yaml')) continue
    signal.throwIfAborted()
    const path = resolve(worktree, blob.path)
    if (!path.startsWith(`${worktree}/`) || dirname(path) === worktree && blob.path.includes('..')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation base file escapes worktree')
    }
    const current = await safeBytes(path, blob.bytes)
    const baseline = await gitBlob(assets.repository, blob, environment, signal)
    if (!current.equals(baseline)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation base input changed: ${blob.path}`)
  }
}

async function assertCleanBase(worktree: string, assets: BaseAssets, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const root = await canonicalGitRoot(worktree, environment, signal)
  if (root !== worktree || (await runLocalCommand('git', ['rev-parse', 'HEAD'], worktree, environment,
    { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })).trim() !== assets.baseCommit
    || (await changedSourcePaths(worktree, assets.baseCommit, environment, signal)).length !== 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation worktree is not clean at the exact base')
  }
  await assertBaseFiles(worktree, assets, environment, signal)
}

async function assertFreshName(assets: BaseAssets, name: string, environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const listed = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', assets.baseCommit,
    '--', `plugins/${name}`, `packages/${name}`], assets.repository, environment,
  { capture: true, maximumOutput: 4_096, timeoutMs: 15_000, signal })
  if (listed !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin name already exists at base')
  const catalog = (await gitBlob(assets.repository, assets.blobs.get('plugins/README.md')!, environment, signal)).toString('utf8')
  if (catalog.includes(`@dsh-enhanced/${name}`) || catalog.includes(`](${name})`)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin identity collides with catalog')
  }
  // A published package can retain its identity after its directory is renamed.
  // Check the pinned tree rather than relying on the directory or catalog alone.
  const tree = await runLocalCommand('git', ['--literal-pathspecs', 'ls-tree', '-r', '-l', '-z', assets.baseCommit,
    '--', 'plugins', 'packages'], assets.repository, environment,
  { capture: true, maximumOutput: 1_048_576, timeoutMs: 15_000, signal })
  for (const entry of tree.split('\0').filter(Boolean)) {
    const separator = entry.indexOf('\t')
    const path = entry.slice(separator + 1)
    if (!/^(?:plugins|packages)\/[^/]+\/package\.json$/u.test(path)) continue
    const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)$/u.exec(entry.slice(0, separator))
    if (separator < 0 || match === null || Number(match[3]) > 65_536) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base package manifest is unsafe')
    }
    const manifest = JSON.parse((await gitBlob(assets.repository,
      { path, mode: match[1]!, hash: match[2]!, bytes: Number(match[3]) }, environment, signal)).toString('utf8')) as { name?: unknown }
    if (manifest?.name === `@dsh-enhanced/${name}`) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin package identity already exists at base')
    }
  }
}

async function runPublicGenerator(worktree: string, name: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    signal.throwIfAborted()
    const child = spawn(process.execPath, ['./scripts/create-plugin.mjs', name], {
      cwd: worktree, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: worktree, NODE_OPTIONS: '' },
    })
    let bytes = 0; let tail = ''; let limited = false; let timedOut = false
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length; tail = `${tail}${chunk.toString('utf8')}`.slice(-1_024)
      if (bytes > MAX_OUTPUT_BYTES) { limited = true; child.kill('SIGKILL') }
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15_000)
    const abort = (): void => { child.kill('SIGKILL') }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error) })
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (signal.aborted) reject(signal.reason)
      else if (code !== 0 || timedOut || limited) reject(new ControlPlaneCliError('EXECUTOR_FAILED',
        `fixed public generator failed (${timedOut ? 'timeout' : limited ? 'output limit' : `exit ${code}`}): ${tail}`))
      else resolvePromise()
    })
  })
}

async function generatedFiles(worktree: string, name: string,
  bounds: { files: number; bytes: number } = { files: 64, bytes: MAX_TOTAL_BYTES }): Promise<readonly { path: string; bytes: number; content: string }[]> {
  const root = resolve(worktree, 'plugins', name)
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin root is unsafe')
  const output: { path: string; bytes: number; content: string }[] = []
  let nodes = 0
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin directory depth exceeds bound')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (++nodes > 256 || Buffer.byteLength(path, 'utf8') > 1_024) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin path or entry count exceeds bound')
      }
      if (entry.isDirectory()) await visit(join(directory, entry.name), path, depth + 1)
      else if (entry.isFile()) {
        const bytes = await safeBytes(join(directory, entry.name), MAX_FILE_BYTES)
        if (bytes.includes(0)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin contains binary data')
        output.push({ path, bytes: bytes.length, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) })
      } else throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin contains non-regular entry')
      if (output.length > bounds.files) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated plugin exceeds file bound')
    }
  }
  await visit(root, '', 0)
  if (RESERVED_OUTPUTS.some(path => !output.some(file => file.path === path))
    || !output.some(file => file.path === 'README.md') || !output.some(file => file.path === 'tests/index.spec.ts')
    || output.reduce((total, file) => total + file.bytes, 0) > bounds.bytes) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator output is incomplete or exceeds bounds')
  }
  return Object.freeze(output.sort((a, b) => a.path.localeCompare(b.path)))
}

async function generateChecked(worktree: string, name: string, assets: BaseAssets,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<readonly { path: string; bytes: number; content: string }[]> {
  await assertCleanBase(worktree, assets, environment, signal)
  const target = resolve(worktree, 'plugins', name)
  if (await lstat(target).then(() => true, (error: NodeJS.ErrnoException) => error.code !== 'ENOENT')) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin root already exists')
  }
  await runPublicGenerator(worktree, name, signal)
  const changed = await changedSourcePaths(worktree, assets.baseCommit, environment, signal)
  if (changed.length < 2 || changed.some(path => path !== 'plugins/README.md' && !path.startsWith(`plugins/${name}/`))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator changed files outside new plugin and catalog')
  }
  return generatedFiles(worktree, name)
}

async function isolatedGenerator<T>(assets: BaseAssets, name: string, environment: NodeJS.ProcessEnv,
  signal: AbortSignal, action: (worktree: string, files: readonly { path: string; bytes: number; content: string }[]) => Promise<T>): Promise<T> {
  // The public generator runs against only approved Git blobs in a disposable
  // capsule. Inspect never changes the source repository or its worktree list.
  const stateRoot = await realpath(await mkdtemp(join(tmpdir(), 'dsh-create-inspect-')))
  try {
    for (const blob of assets.blobs.values()) {
      signal.throwIfAborted()
      const target = resolve(stateRoot, blob.path)
      if (!target.startsWith(`${stateRoot}/`)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generator capsule input escapes')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await gitBlob(assets.repository, blob, environment, signal), { flag: 'wx', mode: 0o600 })
    }
    await mkdir(join(stateRoot, 'plugins'), { recursive: true })
    await runPublicGenerator(stateRoot, name, signal)
    const files = await generatedFiles(stateRoot, name)
    return await action(stateRoot, files)
  } finally { await rm(stateRoot, { recursive: true, force: true }) }
}

export async function inspectSourceCreationContext(input: {
  repository: string; name: string; paths: readonly string[]; baseCommit?: string; baselineCommit?: string
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>; grant: SourceCreationGrant
}): Promise<SourceInspection & { generatorDigest: string }> {
  creationName(input.name, input.grant)
  if (input.grant.expiresAt <= Date.now()) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation grant expired')
  if (!Array.isArray(input.paths) || input.paths.length > 64 || input.paths.length !== new Set(input.paths).size) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'source creation context paths are invalid')
  }
  for (const path of input.paths) {
    if (typeof path !== 'string' || path !== path.normalize('NFC') || path === '' || isAbsolute(path)
      || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation context path is invalid')
    }
  }
  const assets = await baseAssets(input)
  await assertFreshName(assets, input.name, input.environment, input.signal)
  return checked(input.signal, input.assertCurrent, async () => isolatedGenerator(assets, input.name, input.environment,
    input.signal, async (_worktree, generated) => {
      const selected = input.paths.map(path => {
        const file = generated.find(item => item.path === path)
        if (!file) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `new plugin context path is unavailable: ${JSON.stringify(path)}`)
        return Object.freeze({ path, content: file.content })
      })
      if (selected.reduce((total, file) => total + Buffer.byteLength(file.content), 0) > MAX_TOTAL_BYTES) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin context exceeds content bound')
      }
      return Object.freeze({ name: input.name, baseCommit: assets.baseCommit, generatorDigest: assets.generatorDigest,
        files: Object.freeze(generated.map(file => Object.freeze({ path: file.path, bytes: file.bytes }))),
        contents: Object.freeze(selected) })
    }))
}

function lockImporter(base: string, manifest: Record<string, unknown>, name: string): string {
  if (Buffer.byteLength(base) > 8_388_608 || base.includes('\t') || base.includes('\r')
    || !base.startsWith("lockfileVersion: '9.0'\n")) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lockfile has unsupported format')
  }
  const start = base.indexOf('\nimporters:\n')
  const end = base.indexOf('\npackages:\n')
  if (start < 0 || end <= start || base.indexOf('\nimporters:\n', start + 1) !== -1) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lockfile importer section is ambiguous')
  }
  const importers = base.slice(start + '\nimporters:\n'.length, end)
  const newImporter = `plugins/${name}`
  const needed = new Map<string, { group: string; specifier: string }>()
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const dependencies = manifest[group]
    if (dependencies === undefined) continue
    if (!record(dependencies)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated manifest dependencies are invalid')
    for (const [packageName, specifier] of Object.entries(dependencies)) {
      if (needed.has(packageName) || typeof specifier !== 'string' || specifier !== 'catalog:') {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new plugin dependency is not a fixed catalog selection')
      }
      needed.set(packageName, { group, specifier })
    }
  }
  const scalar = (raw: string): string => {
    if (raw.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/u.test(raw)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous')
      return raw.slice(1, -1).replaceAll("''", "'")
    }
    if (raw.startsWith('"')) {
      let value: unknown
      try { value = JSON.parse(raw) } catch { throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous') }
      if (typeof value !== 'string') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous')
      return value
    }
    if (!/^[a-zA-Z0-9@._/+()-]+$/u.test(raw)
      && !/^(?:workspace:(?:\*|\^)|link:[a-zA-Z0-9./_-]+|[~^][0-9][0-9.]+)$/u.test(raw)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock scalar is ambiguous')
    }
    return raw
  }
  const candidate = new Map<string, Set<string>>()
  const importersSeen = new Set<string>()
  const groupsSeen = new Set<string>()
  const dependenciesSeen = new Set<string>()
  let importer = ''; let group = ''; let dependency = ''
  let specifier: string | undefined; let version: string | undefined
  const finishDependency = (): void => {
    if (dependency !== '' && needed.has(dependency) && specifier === needed.get(dependency)!.specifier) {
      if (version === undefined || !/^[a-zA-Z0-9][a-zA-Z0-9@.+()/_-]*$/u.test(version)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `base lock resolution for ${dependency} is incomplete or unsafe`)
      }
      const selected = candidate.get(dependency) ?? new Set<string>()
      selected.add(version); candidate.set(dependency, selected)
    }
    dependency = ''; specifier = undefined; version = undefined
  }
  for (const line of importers.split('\n')) {
    if (line === '') continue
    const importerMatch = /^  ([^ ].*):$/u.exec(line)
    if (importerMatch) {
      finishDependency()
      importer = scalar(importerMatch[1]!); group = ''; groupsSeen.clear(); dependenciesSeen.clear()
      if (importersSeen.has(importer) || importer === newImporter) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer is duplicate or already exists')
      }
      importersSeen.add(importer)
      continue
    }
    const groupMatch = /^    ([^ ].*):$/u.exec(line)
    if (groupMatch) {
      finishDependency()
      group = scalar(groupMatch[1]!); dependenciesSeen.clear()
      if (importer === '' || groupsSeen.has(group)
        || !['dependencies', 'devDependencies', 'optionalDependencies'].includes(group)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer group is unsupported or duplicate')
      }
      groupsSeen.add(group)
      continue
    }
    const dependencyMatch = /^      ([^ ].*):$/u.exec(line)
    if (dependencyMatch) {
      finishDependency()
      dependency = scalar(dependencyMatch[1]!)
      if (group === '' || dependenciesSeen.has(dependency)) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer dependency is duplicate or misplaced')
      }
      dependenciesSeen.add(dependency)
      continue
    }
    const fieldMatch = /^        (specifier|version): (.+)$/u.exec(line)
    if (!fieldMatch || dependency === '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer syntax is unsupported')
    if (fieldMatch[1] === 'specifier') {
      if (specifier !== undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer repeats specifier')
      specifier = scalar(fieldMatch[2]!)
    } else {
      if (version !== undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'base lock importer repeats version')
      version = scalar(fieldMatch[2]!)
    }
  }
  finishDependency()
  for (const key of needed.keys()) {
    if (candidate.get(key)?.size !== 1) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `base lock resolution for ${key} is absent or ambiguous`)
  }
  let block = `  ${newImporter}:\n`
  for (const selectedGroup of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    const entries = [...needed].filter(([, item]) => item.group === selectedGroup).sort(([a], [b]) => a.localeCompare(b))
    if (entries.length === 0) continue
    block += `    ${selectedGroup}:\n`
    for (const [key, value] of entries) {
      block += `      '${key.replaceAll("'", "''")}':\n        specifier: '${value.specifier}'\n        version: ${JSON.stringify([...candidate.get(key)!][0]!)}\n`
    }
  }
  const result = `${base.slice(0, end)}\n${block}${base.slice(end)}`
  if (result.replace(`\n${block}`, '') !== base) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'new lock importer projection changed existing lock data')
  return result
}

async function assertOnlyCreationChanges(worktree: string, baseCommit: string, name: string,
  environment: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const changed = await changedSourcePaths(worktree, baseCommit, environment, signal)
  if (changed.some(path => path !== 'plugins/README.md' && path !== 'pnpm-lock.yaml' && !path.startsWith(`plugins/${name}/`))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation changed outside exact scope')
  }
}

/** Reconstruct Host-owned output with the same base generator in a disposable
 * capsule, then compare bytes. This is also called after Docker checks so a
 * candidate cannot change its manifest, patch, catalog, lock or scaffold
 * config between preflight and durable plan creation. */
export async function verifyCreatedPluginWorkspace(input: {
  worktree: string; baseCommit: string; name: string; environment: NodeJS.ProcessEnv
  signal: AbortSignal; assertCurrent: () => void | Promise<void>; creation: SourceCreationBinding
  files?: readonly ScopedPluginFile[]
}): Promise<{ scope: readonly string[]; generatorDigest: string }> {
  creationName(input.name, input.creation.grant)
  if (!DIGEST.test(input.creation.generatorDigest)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator digest is invalid')
  if (input.files !== undefined) validateSourceCreationFiles(input.files)
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  const assets = await baseAssets({ repository: input.worktree, baseCommit: input.baseCommit,
    environment: input.environment, signal, assertCurrent: input.assertCurrent })
  if (assets.generatorDigest !== input.creation.generatorDigest) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator inputs changed')
  const worktree = assets.repository
  await checked(signal, input.assertCurrent, () => assertBaseFiles(worktree, assets, input.environment, signal, true))
  await assertOnlyCreationChanges(worktree, assets.baseCommit, input.name, input.environment, signal)
  const expected = await isolatedGenerator(assets, input.name, input.environment, signal, async (capsule, generated) => ({
    files: generated, catalog: await safeBytes(join(capsule, 'plugins', 'README.md'), MAX_FILE_BYTES),
  }))
  // The generated scaffold counts against the same final candidate budget.
  const observed = await generatedFiles(worktree, input.name)
  const existing = new Map(observed.map(file => [file.path, file]))
  const initial = new Map(expected.files.map(file => [file.path, file]))
  for (const path of IMMUTABLE_OUTPUTS) {
    if (existing.get(path)?.content !== initial.get(path)?.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `Host-owned generated file changed: ${path}`)
    }
  }
  const submittedPkg = input.files?.find(file => file.path === 'package.json')
  if (input.files !== undefined && submittedPkg === undefined) {
    if (existing.get('package.json')?.content !== initial.get('package.json')?.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned generated file changed: package.json')
    }
  } else if (existing.get('package.json')?.content === undefined) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned generated file changed: package.json')
  } else {
    validateCandidatePackageJson(input.name, initial.get('package.json')!.content, existing.get('package.json')!.content)
  }
  const submittedPatch = input.files?.find(file => file.path === 'cordis.patch.yml')
  if (input.files !== undefined && submittedPatch === undefined) {
    if (existing.get('cordis.patch.yml')?.content !== initial.get('cordis.patch.yml')?.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned generated file changed: cordis.patch.yml')
    }
  } else if (existing.get('cordis.patch.yml')?.content === undefined) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned generated file changed: cordis.patch.yml')
  } else {
    validateCandidateCordisPatch(input.name, initial.get('cordis.patch.yml')!.content, existing.get('cordis.patch.yml')!.content)
  }
  const catalog = await safeBytes(join(worktree, 'plugins', 'README.md'), MAX_FILE_BYTES)
  if (!catalog.equals(expected.catalog)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated catalog changed')
  const manifest = JSON.parse(existing.get('package.json')!.content) as Record<string, unknown>
  const baseLock = (await gitBlob(worktree, assets.blobs.get('pnpm-lock.yaml')!, input.environment, signal)).toString('utf8')
  const expectedLock = lockImporter(baseLock, manifest, input.name)
  if (!(await safeBytes(join(worktree, 'pnpm-lock.yaml'), 8_388_608)).equals(Buffer.from(expectedLock))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned new lock importer changed')
  }
  for (const file of observed) {
    if (!initial.has(file.path) && !creationCandidatePath(file.path)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `new plugin contains unauthorized file: ${file.path}`)
    }
  }
  if (input.files !== undefined) {
    for (const file of input.files) {
      if (existing.get(file.path)?.content !== file.content) {
        throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation proposed file changed: ${file.path}`)
      }
    }
  }
  const changed = await changedSourcePaths(worktree, assets.baseCommit, input.environment, signal)
  for (const path of changed) {
    if (path === 'plugins/README.md' || path === 'pnpm-lock.yaml') continue
    const prefix = `plugins/${input.name}/`
    if (!path.startsWith(prefix)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation changed outside exact scope')
    const within = path.slice(prefix.length)
    if (!initial.has(within) && !creationCandidatePath(within)
      || initial.has(within) && !creationCandidatePath(within) && existing.get(within)?.content !== initial.get(within)?.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source creation changed protected file: ${within}`)
    }
  }
  await checked(signal, input.assertCurrent, () => Promise.resolve())
  return Object.freeze({ scope: CREATE_SCOPE(input.name), generatorDigest: assets.generatorDigest })
}

function creationCandidatePath(path: string): boolean {
  if (path === 'package.json' || path === 'cordis.patch.yml' || path === 'README.md') return true
  try { validateSourceCreationFiles([{ path, content: '' }]); return true } catch { return false }
}

/** Grant-free Host scaffold data for a new root. Revision callers supply their
 * own independent owner authority and must verify the archived parent. */
export interface SourceCreationHostScaffold {
  baseCommit: string
  generatorDigest: string
  files: readonly { path: string; bytes: number; content: string }[]
  catalog: Buffer
  lock: string
  baseLock: string
}

type SourceCreationHostInput = {
  repository: string; name: string; baseCommit?: string; baselineCommit?: string
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>
}

async function hostScaffold(assets: BaseAssets, name: string, environment: NodeJS.ProcessEnv,
  signal: AbortSignal): Promise<SourceCreationHostScaffold> {
  return isolatedGenerator(assets, name, environment, signal, async (capsule, files) => {
    const manifest = JSON.parse(files.find(file => file.path === 'package.json')!.content) as Record<string, unknown>
    if (manifest.name !== `@dsh-enhanced/${name}` || typeof manifest.version !== 'string'
      || !record(manifest.dsh) || !record(manifest.dsh.bundle) || manifest.dsh.bundle.patch !== './cordis.patch.yml') {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator emitted invalid plugin identity')
    }
    const baseLock = (await gitBlob(assets.repository, assets.blobs.get('pnpm-lock.yaml')!, environment, signal)).toString('utf8')
    return Object.freeze({ baseCommit: assets.baseCommit, generatorDigest: assets.generatorDigest, files,
      catalog: await safeBytes(join(capsule, 'plugins', 'README.md'), MAX_FILE_BYTES),
      lock: lockImporter(baseLock, manifest, name), baseLock })
  })
}

/** Reconstruct expected Host bytes without touching the repository. */
export async function inspectCreationHostScaffold(input: SourceCreationHostInput): Promise<SourceCreationHostScaffold> {
  if (!NAME.test(input.name) || input.name.normalize('NFC') !== input.name) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation Host plugin name is invalid')
  }
  const assets = await baseAssets(input)
  await checked(input.signal, input.assertCurrent,
    () => assertFreshName(assets, input.name, input.environment, input.signal))
  return checked(input.signal, input.assertCurrent,
    () => hostScaffold(assets, input.name, input.environment, input.signal))
}

/** Build only the fixed Host scaffold in a clean private linked worktree. */
export async function prepareCreationHostScaffold(input: Omit<SourceCreationHostInput, 'repository'> & {
  worktree: string; expectedGeneratorDigest: string
}): Promise<SourceCreationHostScaffold> {
  if (!NAME.test(input.name) || input.name.normalize('NFC') !== input.name || !DIGEST.test(input.expectedGeneratorDigest)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation Host name or generator digest is invalid')
  }
  const assets = await baseAssets({ ...input, repository: input.worktree })
  if (assets.generatorDigest !== input.expectedGeneratorDigest) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator inputs changed')
  const linked = await linkedWorktrees(assets.repository, input.environment)
  const privateParent = await lstat(dirname(assets.repository))
  if (linked.length < 2 || linked[0] === assets.repository || !linked.includes(assets.repository)
    || !privateParent.isDirectory() || privateParent.isSymbolicLink() || (privateParent.mode & 0o022) !== 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation requires a private linked non-primary worktree')
  }
  await checked(input.signal, input.assertCurrent, () => assertFreshName(assets, input.name, input.environment, input.signal))
  const expected = await checked(input.signal, input.assertCurrent,
    () => hostScaffold(assets, input.name, input.environment, input.signal))
  await checked(input.signal, input.assertCurrent,
    () => generateChecked(assets.repository, input.name, assets, input.environment, input.signal))
  await checked(input.signal, input.assertCurrent,
    () => writeFile(join(assets.repository, 'pnpm-lock.yaml'), expected.lock, { flag: 'w' }))
  return expected
}

/** Recheck generated metadata, catalog and lock while exposing the complete
 * actual plugin file set, including ignored extras, to the revision verifier. */
export async function verifyCreationHostScaffold(input: Omit<SourceCreationHostInput, 'repository'> & {
  worktree: string; expectedGeneratorDigest: string
}): Promise<{ expected: SourceCreationHostScaffold; actual: readonly { path: string; bytes: number; content: string }[] }> {
  if (!NAME.test(input.name) || input.name.normalize('NFC') !== input.name || !DIGEST.test(input.expectedGeneratorDigest)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation Host name or generator digest is invalid')
  }
  const assets = await baseAssets({ ...input, repository: input.worktree })
  if (assets.generatorDigest !== input.expectedGeneratorDigest) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator inputs changed')
  await checked(input.signal, input.assertCurrent,
    () => assertFreshName(assets, input.name, input.environment, input.signal))
  await checked(input.signal, input.assertCurrent,
    () => assertBaseFiles(assets.repository, assets, input.environment, input.signal, true))
  await assertOnlyCreationChanges(assets.repository, assets.baseCommit, input.name, input.environment, input.signal)
  const expected = await checked(input.signal, input.assertCurrent,
    () => hostScaffold(assets, input.name, input.environment, input.signal))
  const listed = await generatedFiles(assets.repository, input.name)
  const actual = await Promise.all(listed.map(async file => {
    const bytes = await safeBytes(join(assets.repository, 'plugins', input.name, file.path), MAX_FILE_BYTES)
    if (bytes.includes(0)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation plugin contains binary data')
    return Object.freeze({ path: file.path, bytes: bytes.length,
      content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) })
  }))
  const existing = new Map(actual.map(file => [file.path, file]))
  for (const file of expected.files.filter(file => IMMUTABLE_OUTPUTS.includes(file.path as typeof IMMUTABLE_OUTPUTS[number]))) {
    if (existing.get(file.path)?.content !== file.content) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `Host-owned generated file changed: ${file.path}`)
    }
  }
  const baseManifestFile = expected.files.find(file => file.path === 'package.json')
  const actualManifestFile = existing.get('package.json')
  if (!baseManifestFile || !actualManifestFile) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned generated file changed: package.json')
  }
  const actualManifest = actualManifestFile.content === baseManifestFile.content
    ? (JSON.parse(baseManifestFile.content) as Record<string, unknown>)
    : validateCandidatePackageJson(input.name, baseManifestFile.content, actualManifestFile.content)
  const basePatchFile = expected.files.find(file => file.path === 'cordis.patch.yml')
  const actualPatchFile = existing.get('cordis.patch.yml')
  if (!basePatchFile || !actualPatchFile) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned generated file changed: cordis.patch.yml')
  }
  if (actualPatchFile.content !== basePatchFile.content) {
    validateCandidateCordisPatch(input.name, basePatchFile.content, actualPatchFile.content)
  }
  if (!(await safeBytes(join(assets.repository, 'plugins', 'README.md'), MAX_FILE_BYTES)).equals(expected.catalog)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'generated catalog changed')
  }
  const expectedLock = lockImporter(expected.baseLock, actualManifest, input.name)
  if (!(await safeBytes(join(assets.repository, 'pnpm-lock.yaml'), 8_388_608)).equals(Buffer.from(expectedLock))) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'Host-owned new lock importer changed')
  }
  await checked(input.signal, input.assertCurrent, () => Promise.resolve())
  return Object.freeze({ expected, actual: Object.freeze(actual) })
}

export function computeLockImporter(baseLock: string, manifest: Record<string, unknown>, name: string): string {
  return lockImporter(baseLock, manifest, name)
}

export async function prepareCreatedPluginWorkspace(input: {
  worktree: string; baseCommit: string; name: string; files: readonly ScopedPluginFile[]
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>; creation: SourceCreationBinding
}): Promise<{ scope: readonly string[]; generatorDigest: string }> {
  creationName(input.name, input.creation.grant)
  validateSourceCreationFiles(input.files)
  if (!DIGEST.test(input.creation.generatorDigest) || input.creation.grant.expiresAt <= Date.now()) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation binding expired or has invalid generator digest')
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(120_000)])
  const assets = await baseAssets({ repository: input.worktree, baseCommit: input.baseCommit,
    environment: input.environment, signal, assertCurrent: input.assertCurrent })
  if (assets.generatorDigest !== input.creation.generatorDigest) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation generator inputs changed')
  const worktree = assets.repository
  const linked = await linkedWorktrees(worktree, input.environment)
  const privateParent = await lstat(dirname(worktree))
  if (linked.length < 2 || linked[0] === worktree || !linked.includes(worktree)
    || !privateParent.isDirectory() || privateParent.isSymbolicLink() || (privateParent.mode & 0o022) !== 0) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source creation requires a private linked non-primary worktree')
  }
  await assertFreshName(assets, input.name, input.environment, signal)
  await checked(signal, input.assertCurrent, () => assertCleanBase(worktree, assets, input.environment, signal))
  const generated = await checked(signal, input.assertCurrent,
    () => generateChecked(worktree, input.name, assets, input.environment, signal))
  const baseManifestText = generated.find(file => file.path === 'package.json')!.content
  const basePatchText = generated.find(file => file.path === 'cordis.patch.yml')!.content
  const manifest = JSON.parse(baseManifestText) as Record<string, unknown>
  if (manifest.name !== `@dsh-enhanced/${input.name}` || typeof manifest.version !== 'string'
    || !record(manifest.dsh) || !record(manifest.dsh.bundle) || manifest.dsh.bundle.patch !== './cordis.patch.yml') {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'public generator emitted invalid plugin identity')
  }
  const candidateManifestFile = input.files.find(file => file.path === 'package.json')
  const effectiveManifest = candidateManifestFile === undefined
    ? manifest
    : validateCandidatePackageJson(input.name, baseManifestText, candidateManifestFile.content)
  const candidatePatchFile = input.files.find(file => file.path === 'cordis.patch.yml')
  if (candidatePatchFile !== undefined) {
    validateCandidateCordisPatch(input.name, basePatchText, candidatePatchFile.content)
  }
  const lockBase = (await gitBlob(worktree, assets.blobs.get('pnpm-lock.yaml')!, input.environment, signal)).toString('utf8')
  const lock = lockImporter(lockBase, effectiveManifest, input.name)
  await checked(signal, input.assertCurrent, () => writeFile(join(worktree, 'pnpm-lock.yaml'), lock, { flag: 'w' }))
  await checked(signal, input.assertCurrent, () => assertOnlyCreationChanges(worktree, assets.baseCommit, input.name, input.environment, signal))
  await checked(signal, input.assertCurrent, () => writeCreatedPluginFiles({ worktree, name: input.name, files: input.files }))
  return verifyCreatedPluginWorkspace({ ...input, worktree, signal })
}
