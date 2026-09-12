import { spawn } from 'node:child_process'
import { createPublicKey } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { GoalScope } from '@dsh-enhanced/assistant-goals'
import { holdoutPathsOverlap, validateCanaryAdmission, validateHoldoutExecution, type CanaryAdmission, type HoldoutExecutionConfig, type HoldoutQualificationInput } from './holdout-qualification.js'
import { validateCanaryAdmissionTemplate, type CanaryAdmissionTemplate } from './repair-admission.js'

/** Public Host configuration. The authority owns its private dataset/key/state elsewhere. */
export interface ExternalHoldoutProfile {
  readonly id: string
  readonly version: number
  readonly scope: GoalScope
  readonly execution: HoldoutExecutionConfig
  readonly authority: { readonly executable: string; readonly args: readonly string[]; readonly publicKey: string; readonly datasetDigest?: string; readonly generatorDigest?: string }
  readonly inputs?: Readonly<Record<string, unknown>>
  readonly files?: readonly { path: string; content: string }[]
  /** Required for canary admission. Legacy prospective profiles remain qualification-only. */
  readonly canaryAdmission?: CanaryAdmission
  /** Host-only repair admission, materialized only after an exact parent/candidate read. */
  readonly canaryAdmissionTemplate?: CanaryAdmissionTemplate
  readonly maxComparisons: 1
}

function reject(): never { throw new Error('assistant-skills: invalid external holdout configuration') }
function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Object.getOwnPropertySymbols(value).length === 0 && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  return plain(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) } return value }
function validateAuthority(authority: ExternalHoldoutProfile['authority']): void {
  if (!exact(authority, ['executable', 'args', 'publicKey'], ['datasetDigest', 'generatorDigest']) || typeof authority.executable !== 'string' || !isAbsolute(authority.executable) || authority.executable.includes('\0')
    || !Array.isArray(authority.args) || authority.args.length > 64 || authority.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || Buffer.byteLength(JSON.stringify(authority.args)) > 16384
    || typeof authority.publicKey !== 'string' || authority.publicKey.length > 16384
    || Object.hasOwn(authority, 'datasetDigest') === Object.hasOwn(authority, 'generatorDigest')
    || typeof (authority.datasetDigest ?? authority.generatorDigest) !== 'string' || !/^[a-f0-9]{64}$/u.test((authority.datasetDigest ?? authority.generatorDigest)!)) reject()
  try { if (createPublicKey(authority.publicKey).asymmetricKeyType !== 'ed25519') reject() } catch { reject() }
}

export function validateExternalHoldoutProfiles(values: readonly ExternalHoldoutProfile[]): readonly ExternalHoldoutProfile[] {
  if (!Array.isArray(values) || values.length > 16) reject()
  const ids = new Set<string>(), commands = new Set<string>(), roots: string[] = []
  for (const value of values) {
    if (!exact(value, ['id', 'version', 'scope', 'execution', 'authority', 'maxComparisons'], ['inputs', 'files', 'canaryAdmission', 'canaryAdmissionTemplate']) || typeof value.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(value.id) || ids.has(value.id)
      || !Number.isSafeInteger(value.version) || value.version < 1 || value.maxComparisons !== 1
      || !exact(value.scope, ['principalId', 'principalRecordId', 'principalVersion', 'workspace', 'preset']) || ['principalId', 'principalRecordId', 'workspace', 'preset'].some(key => typeof value.scope[key as keyof GoalScope] !== 'string' || !value.scope[key as keyof GoalScope])
      || !Number.isSafeInteger(value.scope.principalVersion) || value.scope.principalVersion < 1 || !isAbsolute(value.scope.workspace)) reject()
    validateAuthority(value.authority); validateHoldoutExecution(value.execution)
    if (holdoutPathsOverlap(value.scope.workspace, value.execution.stateRoot) || roots.some(root => holdoutPathsOverlap(root, value.execution.stateRoot))) reject()
    const command = JSON.stringify([value.authority.executable, value.authority.args])
    if (commands.has(command) || value.inputs !== undefined && !plain(value.inputs) || value.files !== undefined && (!Array.isArray(value.files) || value.files.length > 32 || value.files.some((file: { path: unknown; content: unknown }) => !exact(file, ['path', 'content']) || typeof file.path !== 'string' || typeof file.content !== 'string'))
      || value.canaryAdmission !== undefined && value.canaryAdmissionTemplate !== undefined
      || (value.canaryAdmission !== undefined || value.canaryAdmissionTemplate !== undefined) && value.authority.generatorDigest === undefined) reject()
    if (value.canaryAdmission !== undefined) { try { validateCanaryAdmission(value.canaryAdmission) } catch { reject() } }
    if (value.canaryAdmissionTemplate !== undefined) { try { validateCanaryAdmissionTemplate(value.canaryAdmissionTemplate) } catch { reject() } }
    if (Buffer.byteLength(JSON.stringify({ inputs: value.inputs, files: value.files })) > value.execution.maxBytes) reject()
    ids.add(value.id); commands.add(command); roots.push(value.execution.stateRoot)
  }
  return freeze(JSON.parse(JSON.stringify(values)) as ExternalHoldoutProfile[])
}

/** One bounded NDJSON pipe per qualification; malformed/uncertain responses poison the channel. */
export async function openHoldoutProcess(authority: ExternalHoldoutProfile['authority'], signal: AbortSignal): Promise<{ transport: HoldoutQualificationInput['transport']; close(): Promise<void> }> {
  validateAuthority(authority); signal.throwIfAborted()
  const child = spawn(authority.executable, [...authority.args], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', shell: false })
  const decoder = new StringDecoder('utf8')
  let buffer = '', ready = false, ended = false, closing = false, serial = 0, failed: Error | undefined
  let pending: { id: string; resolve(value: unknown): void; reject(error: Error): void } | undefined
  let acceptReady!: () => void, rejectReady!: (error: Error) => void
  const handshake = new Promise<void>((resolve, rejectPromise) => { acceptReady = resolve; rejectReady = rejectPromise })
  const terminal = new Promise<void>(resolve => { child.once('close', () => { ended = true; fail('authority closed'); resolve() }) })
  const kill = (kind: NodeJS.Signals) => { if (ended || !child.pid) return; try { if (process.platform !== 'win32') process.kill(-child.pid, kind); else child.kill(kind) } catch { /* Already exited. */ } }
  function fail(reason: string): void {
    if (failed) return
    failed = new Error(`assistant-skills: holdout ${reason}`)
    rejectReady(failed); pending?.reject(failed); pending = undefined
    if (!closing) { child.stdin.destroy(); kill('SIGTERM') }
  }
  const abort = () => fail('authority cancelled')
  signal.addEventListener('abort', abort, { once: true })
  child.once('error', () => fail('authority unavailable'))
  child.stdin.on('error', () => fail('authority pipe failed'))
  child.stdout.on('error', () => fail('authority output failed'))
  child.stderr.on('data', () => { /* Consume without exposing operator errors, keys or private data. */ })
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return
    buffer += decoder.write(chunk)
    if (Buffer.byteLength(buffer) > 1048576) { fail('authority response too large'); return }
    let at: number
    while ((at = buffer.indexOf('\n')) >= 0 && !failed) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
      let message: Record<string, unknown>
      try { const parsed: unknown = JSON.parse(line); if (!plain(parsed)) throw new Error(); message = parsed } catch { fail('authority protocol rejected'); return }
      if (!ready) {
        if (message.event !== 'ready' || message.protocol !== 'assistant-skills/holdout-ipc/v1') { fail('authority protocol rejected'); return }
        ready = true; acceptReady(); continue
      }
      if (!pending || message.id !== pending.id || typeof message.ok !== 'boolean') { fail('authority response identity rejected'); return }
      if (!message.ok) { fail('authority request rejected'); return }
      const current = pending; pending = undefined; current.resolve(message.value)
    }
  })
  let cleanup: Promise<void> | undefined
  const close = () => cleanup ??= (async () => {
    closing = true; signal.removeEventListener('abort', abort)
    if (!ended) child.stdin.end()
    const soft = setTimeout(() => kill('SIGTERM'), 1000), hard = setTimeout(() => kill('SIGKILL'), 2000)
    try {
      await Promise.race([terminal, new Promise<never>((_resolve, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error('assistant-skills: holdout process termination unconfirmed')), 4000)
        void terminal.then(() => clearTimeout(timer))
      })])
    } finally { clearTimeout(soft); clearTimeout(hard) }
  })()
  const handshakeTimer = setTimeout(() => fail('authority ready deadline exceeded'), 10000)
  try { if (signal.aborted) abort(); await handshake } catch (error) { await close(); throw error } finally { clearTimeout(handshakeTimer) }
  return { close, transport: { async request(operation, value, requestSignal) {
    if (failed || closing || ended || pending || !['begin', 'next', 'record', 'finish'].includes(operation)) throw new Error('assistant-skills: holdout pipe unavailable')
    signal.throwIfAborted(); requestSignal?.throwIfAborted()
    const id = `request-${++serial}`, body = JSON.stringify({ id, operation, ...(value === undefined ? {} : { value }) }) + '\n'
    if (Buffer.byteLength(body) > 1048576) throw new Error('assistant-skills: holdout request too large')
    const cancelled = () => fail('authority request cancelled')
    const timer = setTimeout(() => fail('authority response deadline exceeded'), 300000)
    requestSignal?.addEventListener('abort', cancelled, { once: true })
    try {
      return await new Promise<unknown>((resolve, rejectPromise) => { pending = { id, resolve, reject: rejectPromise }; child.stdin.write(body, error => { if (error) fail('authority write failed') }) })
    } finally { clearTimeout(timer); requestSignal?.removeEventListener('abort', cancelled) }
  } } }
}
