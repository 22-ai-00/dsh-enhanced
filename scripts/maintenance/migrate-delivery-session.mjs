#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, lstat, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const V2_TO_V3_SHA256 = '2d35e1e0ed497af569d5735fc590187de1568489cfe60d070b5f61330cd5a338'
const MAX_CHILD_MS = 30_000
const MAX_TOTAL_MS = 90_000
const DELIVERY_KEYS = ['kind', 'channel', 'account', 'eventId', 'trust']

const digest = value => createHash('sha256').update(value).digest('hex')
const identity = async path => {
  const entry = await lstat(path)
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('session-file must be an existing regular file, not a symlink')
  const resolved = await realpath(path)
  if (resolved !== path) throw new Error('session-file must be canonical (realpath must equal input)')
  const metadata = await stat(path, { bigint: true })
  return { path, digest: digest(await readFile(path)), dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs }
}
const sameIdentity = (a, b) => a.digest === b.digest && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs
async function assertNoCurrentGeneration(sessionDir) {
  try { await lstat(join(sessionDir, 'session.v3.jsonl.zstd')); throw new Error('a current v3 generation already exists; refusing conflicting apply') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
}
const publicRecord = record => ({ phase: record.phase, version: record.version, events: record.events, logicalHash: record.logicalHash, deliverySourceHash: record.deliverySourceHash, deliverySourceCount: record.deliverySourceCount, legacyArtifactHash: record.legacyArtifactHash, ...(record.backup === undefined ? {} : { backup: record.backup }) })

function canonical(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}
const logicalHash = (header, events) => digest(JSON.stringify(canonical({ header, events })))

async function assertSessionDirectory(sessionDir) {
  const root = await lstat(sessionDir)
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('session directory must be a real directory')
  const entries = await readdir(sessionDir, { withFileTypes: true })
  if (entries.length < 1 || entries.length > 2) throw new Error('session directory has an unsupported file count')
  let total = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !['session.jsonl.zstd', 'session.lock'].includes(entry.name)) throw new Error('session directory contains an unsupported entry')
    total += Number((await stat(join(sessionDir, entry.name))).size)
  }
  if (total > 128 * 1024 * 1024) throw new Error('session directory exceeds maintenance copy limit')
}
async function currentGeneration(sessionDir) {
  const path = join(sessionDir, 'session.v3.jsonl.zstd')
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isFile() || await realpath(path) !== path) return { state: 'unexpected' }
    return { state: 'present', hash: digest(await readFile(path)) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' }
    return { state: 'unexpected' }
  }
}

/** Pure strict classifier used by the exact audited loader patch and unit tests. */
export function isStrictDeliverySource(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== DELIVERY_KEYS.length || keys.some((key, index) => key !== [...DELIVERY_KEYS].sort()[index])) return false
  const source = value
  return source.kind === 'delivery' && source.trust === 'untrusted'
    && ['channel', 'account', 'eventId'].every(key => typeof source[key] === 'string' && source[key].length > 0)
}

/** Patches exactly the audited v2→v3 source vocabulary and source validator. */
export function patchDeliveryV2ToV3Source(source) {
  if (digest(source) !== V2_TO_V3_SHA256) throw new Error('unsupported v2-to-v3 migration implementation hash')
  const vocabulary = '\t"agent-message"\n]);'
  const start = 'function assertSource(message) {\n\tconst source = record(message["source"], "message source");'
  if (source.split(vocabulary).length !== 2 || source.split(start).length !== 2) throw new Error('unsupported v2-to-v3 migration structure')
  const check = `\n\tif (source["kind"] === "delivery") {\n\t\tkeys(source, ["kind", "channel", "account", "eventId", "trust"], [], "delivery source");\n\t\tif (source["trust"] !== "untrusted" || ["channel", "account", "eventId"].some(key => typeof source[key] !== "string" || source[key].length === 0)) throw new SessionFormatError("invalid delivery source");\n\t}`
  return source.replace(vocabulary, '\t"agent-message",\n\t"delivery"\n]);').replace(start, start + check)
}

const usageText = 'usage: migrate-delivery-session.mjs --host-cli <absolute dsh/lib/bin.js> --session-file <absolute .../session.jsonl.zstd> [--apply --confirm-host-stopped]'
function usage() { throw new Error(usageText) }
function parse(argv) {
  const options = { apply: false, confirm: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--confirm-host-stopped') options.confirm = true
    else if (arg === '--host-cli' || arg === '--session-file') options[arg.slice(2).replace('-', '')] = argv[++i]
    else usage()
  }
  if (typeof options.hostcli !== 'string' || typeof options.sessionfile !== 'string' || !isAbsolute(options.hostcli) || !isAbsolute(options.sessionfile)) usage()
  if (options.apply && !options.confirm) throw new Error('--apply requires --confirm-host-stopped')
  return options
}
function sessionLayout(path) {
  if (basename(path) !== 'session.jsonl.zstd') throw new Error('--session-file must name exact legacy session.jsonl.zstd')
  const sessionDir = dirname(path), id = basename(sessionDir), workspaceDir = dirname(sessionDir), root = dirname(workspaceDir)
  if (!/^delivery-[a-f0-9]{32}-g[1-9][0-9]*$/u.test(id)) throw new Error('session-file must belong to a delivery session directory')
  return { root, workspaceDir, sessionDir, id }
}
function assertDeadline(started) { if (Date.now() - started > MAX_TOTAL_MS) throw new Error('maintenance deadline exceeded') }
function child(script, input, phase, started) {
  assertDeadline(started)
  const remaining = MAX_TOTAL_MS - (Date.now() - started)
  const result = spawnSync(process.execPath, [script, '--worker', phase, JSON.stringify(input)], { encoding: 'utf8', timeout: Math.min(MAX_CHILD_MS, remaining), maxBuffer: 1_000_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`worker ${phase} failed`)
  return JSON.parse(result.stdout)
}
function hook(expectedUrl) {
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    if (url !== expectedUrl) return loaded
    return { ...loaded, source: patchDeliveryV2ToV3Source(String(loaded.source)) }
  } })
}
function deliverySourceHash(events) {
  const values = []
  const visit = value => {
    if (value === null || typeof value !== 'object') return
    if (isStrictDeliverySource(value)) values.push(JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))))
    for (const child of Object.values(value)) visit(child)
  }
  visit(events)
  return digest(values.sort().join('\n'))
}
async function worker(phase, raw) {
  const input = JSON.parse(raw)
  const hostCli = await realpath(input.hostCli)
  const require = createRequire(hostCli)
  const migrationUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-v2-to-v3')).href
  const before = await identity(input.legacyPath)
  if (before.digest !== input.expectedLegacyHash) throw new Error('legacy artifact changed before worker')
  if (phase === 'migrate') hook(migrationUrl)
  const { Context } = require('@deepseek-ai/cordis')
  const { default: Jsonl } = require('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionId } = require('@deepseek-ai/dsh-session')
  const ctx = new Context()
  try {
    const backend = new Jsonl(ctx, { root: input.root, compression: 'zstd' })
    const selected = await backend.stat(SessionId(input.id))
    const currentPath = selected === undefined ? undefined : resolve(backend.locate(selected.header).path)
    if (selected === undefined || selected.header.id !== input.id || basename(currentPath) !== 'session.v3.jsonl.zstd'
      || dirname(currentPath) !== dirname(resolve(input.legacyPath))) throw new Error('backend location does not match selected session directory')
    const handle = await backend.open(SessionId(input.id), phase === 'migrate' ? 'write' : 'read')
    try {
      const result = await handle.read()
      const sources = []
      const visit = value => { if (value !== null && typeof value === 'object') { if (isStrictDeliverySource(value)) sources.push(value); for (const child of Object.values(value)) visit(child) } }
      visit(result.events)
      const after = await identity(input.legacyPath)
      if (!sameIdentity(before, after) || after.digest !== input.expectedLegacyHash) throw new Error('worker changed legacy artifact')
      process.stdout.write(JSON.stringify({ phase, version: handle.header.version, events: result.events.length, logicalHash: logicalHash(handle.header, result.events), deliverySourceHash: deliverySourceHash(result.events), deliverySourceCount: sources.length, legacyArtifactHash: after.digest }))
    } finally { await handle.close() }
  } finally { await ctx.fiber.restart() }
}
async function main() {
  const started = Date.now()
  if (process.argv.slice(2).includes('--help')) { console.log(usageText); return }
  const options = parse(process.argv.slice(2))
  const script = fileURLToPath(import.meta.url)
  const hostCli = await realpath(options.hostcli)
  if (!isAbsolute(hostCli) || hostCli !== options.hostcli || basename(hostCli) !== 'bin.js') throw new Error('--host-cli must be a canonical absolute dsh/lib/bin.js')
  const layout = sessionLayout(options.sessionfile)
  const initial = await identity(options.sessionfile)
  await assertSessionDirectory(layout.sessionDir)
  await assertNoCurrentGeneration(layout.sessionDir)
  assertDeadline(started)
  const temp = await mkdtemp(join(tmpdir(), 'dsh-delivery-maintenance-'))
  await chmod(temp, 0o700)
  let applyState
  try {
    const copyRoot = join(temp, 'sessions')
    const copySessionDir = join(copyRoot, relative(layout.root, layout.sessionDir))
    await cp(layout.sessionDir, copySessionDir, { recursive: true, dereference: false, errorOnExist: true })
    const copyLegacy = join(copySessionDir, 'session.jsonl.zstd')
    const previewInput = { hostCli, root: copyRoot, id: layout.id, legacyPath: copyLegacy, expectedLegacyHash: initial.digest }
    const preview = child(script, previewInput, 'migrate', started)
    const previewCold = child(script, previewInput, 'read', started)
    if (preview.version !== 3 || previewCold.version !== 3 || preview.events !== previewCold.events
      || preview.logicalHash !== previewCold.logicalHash || preview.deliverySourceHash !== previewCold.deliverySourceHash
      || preview.deliverySourceCount !== previewCold.deliverySourceCount || preview.deliverySourceCount < 1) throw new Error('preview migration did not produce independently cold-readable v3')
    if ((await identity(copyLegacy)).digest !== initial.digest || preview.legacyArtifactHash !== initial.digest) throw new Error('preview changed the legacy artifact')
    if (!options.apply) { console.log(JSON.stringify(publicRecord({ ...preview, phase: 'preview', legacyArtifactHash: initial.digest }))); return }
    assertDeadline(started)
    const current = await identity(options.sessionfile)
    if (!sameIdentity(initial, current)) throw new Error('legacy artifact changed after preview; refusing apply')
    await assertNoCurrentGeneration(layout.sessionDir)
    await assertSessionDirectory(layout.sessionDir)
    applyState = { backup: undefined, legacy: initial, sessionDir: layout.sessionDir, legacyPath: options.sessionfile }
    const backupRoot = await mkdtemp(join(layout.workspaceDir, '.delivery-migration-backup-'))
    await chmod(backupRoot, 0o700)
    const backup = join(backupRoot, layout.id)
    await cp(layout.sessionDir, backup, { recursive: true, dereference: false, errorOnExist: true })
    applyState.backup = backup
    if (!sameIdentity(initial, await identity(options.sessionfile))) throw new Error('legacy artifact changed while creating backup')
    console.log(JSON.stringify({ phase: 'backup-created', backup }))
    const appliedInput = { hostCli, root: layout.root, id: layout.id, legacyPath: options.sessionfile, expectedLegacyHash: initial.digest }
    const applied = child(script, appliedInput, 'migrate', started)
    const post = child(script, appliedInput, 'read', started)
    if (applied.version !== 3 || post.version !== 3 || applied.events !== preview.events || post.events !== preview.events
      || applied.logicalHash !== preview.logicalHash || post.logicalHash !== preview.logicalHash
      || applied.deliverySourceHash !== preview.deliverySourceHash || post.deliverySourceHash !== preview.deliverySourceHash
      || applied.deliverySourceCount !== preview.deliverySourceCount || post.deliverySourceCount !== preview.deliverySourceCount) throw new Error('applied migration verification mismatch')
    if (!sameIdentity(initial, await identity(options.sessionfile))) throw new Error('legacy artifact changed after apply')
    console.log(JSON.stringify(publicRecord({ ...applied, phase: 'applied', legacyArtifactHash: initial.digest, backup })))
  } catch (error) {
    if (applyState !== undefined) {
      let legacyUnchanged = false
      try { legacyUnchanged = sameIdentity(applyState.legacy, await identity(applyState.legacyPath)) } catch {}
      const generation = await currentGeneration(applyState.sessionDir)
      console.error(JSON.stringify({ phase: 'apply-incomplete', backup: applyState.backup ?? null, keepHostStopped: true,
        legacyUnchanged, currentGeneration: generation.state, ...(generation.hash === undefined ? {} : { currentGenerationHash: generation.hash }) }))
      process.exitCode = 1
      return
    }
    throw error
  } finally { await rm(temp, { recursive: true, force: true }) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--worker') await worker(process.argv[3], process.argv[4])
    else await main()
  } catch {
    process.stderr.write(JSON.stringify({ phase: process.argv[2] === '--worker' ? 'worker-failed' : 'failed', error: 'maintenance-refused' }) + '\n')
    process.exitCode = 1
  }
}
