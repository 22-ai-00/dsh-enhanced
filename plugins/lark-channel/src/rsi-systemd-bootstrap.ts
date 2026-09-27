import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { SystemdHostAuthorityConfig } from '@dsh-enhanced/plugin-control-plane'
import type { Pin } from './rsi-authority-runtime.js'
import type { RsiServiceEnvironment } from './rsi-service-environment.js'
import { renderDshSystemdService, systemdServicePaths, type SystemdInstallOptions } from './systemd.js'

const unitKeys = ['FragmentPath', 'DropInPaths', 'ExecStart', 'Environment', 'WorkingDirectory', 'User', 'Group', 'Type', 'KillMode'] as const
const statusKeys = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'ControlGroup', 'Job'] as const
const allKeys = [...statusKeys, ...unitKeys]
type UnitProperties = SystemdHostAuthorityConfig['template']['unitProperties']
export type RsiSystemdStatus = Record<typeof statusKeys[number], string>
export interface RsiSystemdCommand {
  command: string
  fd: number
  args: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
}
export interface RsiSystemdResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type RsiSystemdRunner = (request: RsiSystemdCommand) => RsiSystemdResult | Promise<RsiSystemdResult>
export interface RsiSystemdCaptureOptions extends Pick<SystemdInstallOptions, 'home' | 'nodePath' | 'dshPath' | 'path'> {
  environment?: RsiServiceEnvironment
  systemctl: Pin & { interpreter: null }
  timeoutMs?: number
  signal?: AbortSignal
  run?: RsiSystemdRunner
}
interface Journal { schemaVersion: 1; unitPath: string; unitName: string; before: string | null; beforeMode: number | null; after: string }

function fail(message: string): never { throw new Error(`rsi systemd capture: ${message}`) }
function hash(value: Buffer): string { return createHash('sha256').update(value).digest('hex') }
function exactPath(value: string): boolean { return isAbsolute(value) && resolve(value) === value
  && !value.includes('\0') && !value.includes('\r') && !value.includes('\n') }
function equal(a: Buffer | null, b: Buffer | null): boolean { return a === null ? b === null : b !== null && a.equals(b) }
function fdBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
    if (count === 0) fail('pinned systemctl changed while reading')
    offset += count
  }
  return bytes
}
async function command(args: readonly string[], options: RsiSystemdCaptureOptions): Promise<string> {
  options.signal?.throwIfAborted()
  const spec = options.systemctl
  if (spec.interpreter !== null || !exactPath(spec.path) || !/^[a-f0-9]{64}$/u.test(spec.sha256)
    || await realpath(spec.path) !== spec.path) fail('systemctl must be a canonical pinned native executable')
  const pathStat = lstatSync(spec.path)
  if (!pathStat.isFile() || pathStat.nlink !== 1 || pathStat.size < 4 || pathStat.size > 268_435_456
    || (pathStat.mode & 0o022) !== 0 || (pathStat.uid !== 0 && pathStat.uid !== process.getuid?.())) fail('unsafe systemctl executable')
  const fd = openSync(spec.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const fdStat = fstatSync(fd)
    if (fdStat.dev !== pathStat.dev || fdStat.ino !== pathStat.ino) fail('systemctl inode changed')
    const bytes = fdBytes(fd, fdStat.size)
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || hash(bytes) !== spec.sha256) fail('systemctl pin changed')
    const uid = process.getuid?.()
    if (uid === undefined) fail('Linux user identity unavailable')
    const runtime = `/run/user/${uid}`
    const request: RsiSystemdCommand = { command: '/proc/self/fd/3', fd,
      args: ['--user', ...args], env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0',
        XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` },
      timeoutMs: options.timeoutMs ?? 10_000, ...(options.signal ? { signal: options.signal } : {}) }
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1000 || request.timeoutMs > 60_000) fail('invalid command timeout')
    const result = await (options.run ?? defaultRun)(request)
    options.signal?.throwIfAborted()
    const finalStat = lstatSync(spec.path)
    if (finalStat.dev !== fdStat.dev || finalStat.ino !== fdStat.ino || hash(fdBytes(fd, fdStat.size)) !== spec.sha256) fail('systemctl changed after command')
    if (result.error || result.status !== 0 || Buffer.byteLength(result.stdout) > 65_536) fail(`systemctl ${args[0]} failed`)
    return result.stdout
  } finally { closeSync(fd) }
}
function defaultRun(request: RsiSystemdCommand): RsiSystemdResult {
  const result = spawnSync(request.command, [...request.args], { env: request.env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe', request.fd], timeout: request.timeoutMs, signal: request.signal, maxBuffer: 65_536 })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
    ...(result.error ? { error: result.error } : {}) }
}
export function parseRsiSystemdShow(source: string, keys: readonly string[] = allKeys): Record<string, string> {
  if (Buffer.byteLength(source) > 65_536 || !source.endsWith('\n')) fail('invalid systemctl show output')
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('='), key = line.slice(0, separator)
    if (separator < 0 || !keys.includes(key) || Object.hasOwn(result, key)) fail('invalid or duplicate supervisor property')
    result[key] = line.slice(separator + 1)
  }
  if (Object.keys(result).length !== keys.length) fail('missing supervisor property')
  return result
}
function normalizeExecStart(value: string): string {
  const match = value.match(/^(\{ path=[^\r\n]* ; argv\[\]=[^\r\n]* ; ignore_errors=(?:yes|no)) ; (?:start_time=[^\r\n]* )?\}$/u)
  if (!match || value.split('{ path=').length !== 2) fail('unsupported ExecStart representation')
  return `${match[1]} ; }`
}
export function assertRsiSystemdUnitStopped(status: RsiSystemdStatus, unitName: string): void {
  if (status.Id !== unitName || !['loaded', 'not-found'].includes(status.LoadState)
    || status.ActiveState !== 'inactive' || status.SubState !== 'dead'
    || status.MainPID !== '0' || status.ControlPID !== '0' || status.ControlGroup !== ''
    || !['', '0'].includes(status.Job)) fail('target service is not fully stopped')
}
export async function readRsiSystemdUnitStatus(unitName: string, options: RsiSystemdCaptureOptions): Promise<RsiSystemdStatus> {
  const fields = parseRsiSystemdShow(await command(['show', unitName, '--no-pager', ...statusKeys.map(key => `--property=${key}`)], options), statusKeys)
  return fields as unknown as RsiSystemdStatus
}
/** Reads the currently loaded service for post-install and post-start comparison with the frozen Host grant. */
export async function readRsiSystemdUnitProperties(
  input: { dshHome: string; profile: string }, options: RsiSystemdCaptureOptions,
): Promise<UnitProperties> {
  const { unitPath, unitName } = systemdServicePaths({ dshHome: input.dshHome, profile: input.profile,
    ...(options.home ? { home: options.home } : {}) })
  const fields = parseRsiSystemdShow(await command(['show', unitName, '--no-pager', ...allKeys.map(key => `--property=${key}`)], options))
  if (fields.Id !== unitName || fields.LoadState !== 'loaded' || fields.FragmentPath !== unitPath
    || fields.DropInPaths !== '' || fields.Type !== 'simple' || fields.KillMode !== 'control-group') {
    fail('loaded unit differs from supported deployment')
  }
  fields.ExecStart = normalizeExecStart(fields.ExecStart!)
  return Object.fromEntries(unitKeys.map(key => [key, fields[key]])) as UnitProperties
}
async function readUnit(path: string, maximum = 65_536): Promise<{ bytes: Buffer | null; mode: number | null }> {
  let stat
  try { stat = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: null, mode: null }
    throw error
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > maximum) fail('unsafe unit file')
  const bytes = await readFile(path)
  const after = await lstat(path)
  if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size) fail('unit file changed during read')
  return { bytes, mode: stat.mode & 0o777 }
}
async function syncDirectory(path: string): Promise<void> { const fd = await open(path, 'r'); try { await fd.sync() } finally { await fd.close() } }
async function atomicWrite(path: string, bytes: Buffer, mode: number): Promise<void> {
  const tmp = `${path}.rsi-${process.pid}-${createHash('sha256').update(String(Math.random())).digest('hex')}`
  const fd = await open(tmp, 'wx', mode)
  try {
    try { await fd.writeFile(bytes); await fd.chmod(mode); await fd.sync() } finally { await fd.close() }
    await rename(tmp, path); await syncDirectory(dirname(path))
  } catch (error) {
    await unlink(tmp).catch(() => undefined); throw error
  }
}
async function readJournal(path: string, unitPath: string, unitName: string): Promise<Journal | null> {
  const unit = await readUnit(path, 262_144)
  if (unit.bytes === null) return null
  if (unit.mode !== 0o600 || unit.bytes.length > 262_144) fail('unsafe recovery journal')
  let value: Journal
  try { value = JSON.parse(unit.bytes.toString('utf8')) as Journal } catch { fail('invalid recovery journal') }
  if (value.schemaVersion !== 1 || value.unitPath !== unitPath || value.unitName !== unitName
    || Object.keys(value).sort().join() !== ['after', 'before', 'beforeMode', 'schemaVersion', 'unitName', 'unitPath'].sort().join()
    || typeof value.after !== 'string' || (value.before !== null && typeof value.before !== 'string')
    || (value.before === null ? value.beforeMode !== null : !Number.isInteger(value.beforeMode) || value.beforeMode! < 0 || value.beforeMode! > 0o777)) fail('recovery journal differs from target')
  for (const encoded of [value.after, value.before]) if (encoded !== null && (encoded.length > 90_000
    || Buffer.from(encoded, 'base64').toString('base64') !== encoded)) fail('invalid recovery journal bytes')
  return value
}
async function restore(path: string, journalPath: string, journal: Journal, options: RsiSystemdCaptureOptions): Promise<void> {
  const current = await readUnit(path)
  const before = journal.before === null ? null : Buffer.from(journal.before, 'base64')
  const after = Buffer.from(journal.after, 'base64')
  if (!equal(current.bytes, before) && !equal(current.bytes, after)) fail('unit changed outside capture; retain journal for reconciliation')
  assertRsiSystemdUnitStopped(await readRsiSystemdUnitStatus(journal.unitName, options), journal.unitName)
  if (!equal(current.bytes, before) || (before !== null && current.mode !== journal.beforeMode)) {
    if (before === null) { await unlink(path); await syncDirectory(dirname(path)) }
    else await atomicWrite(path, before, journal.beforeMode!)
  }
  await command(['daemon-reload'], options)
  await unlink(journalPath)
  await syncDirectory(dirname(journalPath))
}
/** Caller owns the DSH_HOME lifecycle lock and has stopped the target service. No command here can start it. */
export async function captureRsiSystemdUnitProperties(
  input: { dshHome: string; profile: string }, options: RsiSystemdCaptureOptions,
): Promise<UnitProperties> {
  if (process.platform !== 'linux' || !exactPath(input.dshHome)) fail('Linux absolute DSH_HOME required')
  const homeStat = await lstat(input.dshHome)
  if (!homeStat.isDirectory() || homeStat.uid !== process.getuid?.() || (homeStat.mode & 0o077) !== 0
    || await realpath(input.dshHome) !== input.dshHome) fail('DSH_HOME must be owner-private and canonical')
  const { unitPath, unitName } = systemdServicePaths({ dshHome: input.dshHome, profile: input.profile,
    ...(options.home ? { home: options.home } : {}) })
  const journalPath = join(input.dshHome, '.rsi-systemd-capture-journal.json')
  const previous = await readJournal(journalPath, unitPath, unitName)
  if (previous) {
    const recoveryOptions = { ...options }
    delete recoveryOptions.signal
    await restore(unitPath, journalPath, previous, recoveryOptions)
  }
  options.signal?.throwIfAborted()
  const rendered = await renderDshSystemdService(input, { platform: 'linux',
    ...(options.home ? { home: options.home } : {}), ...(options.nodePath ? { nodePath: options.nodePath } : {}),
    ...(options.dshPath ? { dshPath: options.dshPath } : {}), ...(options.path ? { path: options.path } : {}),
    ...(options.environment ? { environment: options.environment } : {}) })
  if (rendered.unitPath !== unitPath || rendered.unitName !== unitName) fail('rendered unit path changed')
  await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 })
  const actualUnitDirectory = await realpath(dirname(unitPath))
  if (actualUnitDirectory !== join(await realpath(options.home ?? homedir()), '.config', 'systemd', 'user')
    || (await lstat(dirname(unitPath))).uid !== process.getuid?.()) fail('unit directory differs from user home')
  assertRsiSystemdUnitStopped(await readRsiSystemdUnitStatus(unitName, options), unitName)
  const before = await readUnit(unitPath), after = Buffer.from(rendered.source, 'utf8')
  if (after.length > 65_536) fail('rendered unit too large')
  const journal: Journal = { schemaVersion: 1, unitPath, unitName,
    before: before.bytes?.toString('base64') ?? null, beforeMode: before.mode, after: after.toString('base64') }
  await atomicWrite(journalPath, Buffer.from(JSON.stringify(journal)), 0o600)
  let properties: UnitProperties | undefined, failure: unknown
  try {
    await atomicWrite(unitPath, after, 0o600)
    await command(['daemon-reload'], options)
    const fields = parseRsiSystemdShow(await command(['show', unitName, '--no-pager', ...allKeys.map(key => `--property=${key}`)], options))
    assertRsiSystemdUnitStopped(fields as unknown as RsiSystemdStatus, unitName)
    if (fields.LoadState !== 'loaded' || fields.FragmentPath !== unitPath || fields.DropInPaths !== ''
      || fields.Type !== 'simple' || fields.KillMode !== 'control-group') fail('loaded unit differs from supported deployment')
    fields.ExecStart = normalizeExecStart(fields.ExecStart!)
    properties = Object.fromEntries(unitKeys.map(key => [key, fields[key]])) as UnitProperties
  } catch (error) { failure = error }
  const recoveryOptions = { ...options }
  delete recoveryOptions.signal
  try { await restore(unitPath, journalPath, journal, recoveryOptions) } catch (error) {
    if (failure) throw new AggregateError([failure, error], 'rsi systemd capture and recovery failed')
    throw error
  }
  if (failure) throw failure
  return properties!
}
