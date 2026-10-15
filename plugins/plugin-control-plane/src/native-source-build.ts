import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { nativeMacRuntimeDigest, verifyNativeMacRuntime, type NativeMacVerifierRunner } from '@dsh-enhanced/assistant-isolation'
import { ControlPlaneCliError } from './errors.js'
import { verifyCreatedPluginWorkspace, type SourceCreationBinding } from './source-creation.js'
import { verifyRevisedPluginWorkspace, type SourceRevisionBinding } from './source-revision.js'
import { checkedSourceSnapshot, type ScopedPluginFile } from './source-workspace.js'
import type { CreationCapabilitySourceSnapshot } from './creation-capability-source.js'
import type { PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { NativeSourceBuildConfig, SourceBuildResult } from './source-build.js'
import { NATIVE_SOURCE_COMPILER } from './native-source-build-worker.js'
import { packNativeCreatedPlugin } from './native-source-pack.js'
import type { NativeSourcePreparedEvidence } from './types.js'

const DIGEST = /^[a-f0-9]{64}$/u
const compilerSha256 = createHash('sha256').update(NATIVE_SOURCE_COMPILER).digest('hex')

interface NativeBuildInput {
  config: NativeSourceBuildConfig
  runner: NativeMacVerifierRunner
  worktree: string
  baseCommit: string
  name: string
  scope: readonly string[]
  environment: NodeJS.ProcessEnv
  signal: AbortSignal
  assertCurrent: () => Promise<void>
  preparedAt: number
  sourceJob: { id: string }
  creation?: SourceCreationBinding
  revision?: { binding: SourceRevisionBinding; parentSource: CreationCapabilitySourceSnapshot;
    parentCertificate: PluginCreationVerificationCertificate; files: readonly ScopedPluginFile[] }
  capturePack?: true
}

function fail(message: string): never { throw new ControlPlaneCliError('SOURCE_BOUNDARY', `native source build ${message}`) }

async function pluginFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  let bytes = 0; let count = 0
  const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 32) fail('directory depth exceeds bound')
    for (const name of (await readdir(directory)).sort()) {
      if (!/^[A-Za-z0-9._-]+$/u.test(name) || name === '.' || name === '..') fail('unsafe path')
      const path = join(directory, name), relative = prefix === '' ? name : `${prefix}/${name}`
      const info = await lstat(path)
      if (info.isSymbolicLink() || info.nlink !== 1 && info.isFile()) fail('linked plugin file')
      if (info.isDirectory()) await visit(path, relative, depth + 1)
      else if (info.isFile()) {
        if (info.size > 65_536 || ++count > 64) fail('file size/count exceeds bound')
        const content = await readFile(path)
        bytes += content.length
        if (bytes > 262_144 || content.includes(0)) fail('plugin bytes exceed bound')
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
        if (!Buffer.from(decoded).equals(content)) fail('noncanonical UTF-8 plugin file')
        files.set(relative, decoded)
      } else fail('special plugin file')
    }
  }
  const canonical = await realpath(root)
  if (canonical !== resolve(root) || !(await lstat(root)).isDirectory()) fail('plugin root is not canonical')
  await visit(root, '', 0)
  return files
}

function compilerOutput(value: unknown): Map<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('compiler output is invalid')
  const item = value as Record<string, unknown>
  if (Object.keys(item).sort().join() !== 'checks,files,schemaVersion,typescriptVersion'
    || item.schemaVersion !== 1 || !Array.isArray(item.checks)
    || item.checks.join() !== 'semantic-typecheck,js-declaration-emit'
    || !Array.isArray(item.files) || item.files.length < 2 || item.files.length > 128) fail('compiler output contract differs')
  const files = new Map<string, string>()
  let total = 0
  for (const value of item.files) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('compiler file is invalid')
    const file = value as Record<string, unknown>
    if (Object.keys(file).sort().join() !== 'content,path' || typeof file.path !== 'string' || typeof file.content !== 'string'
      || !/^lib\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:js|d\.ts)$/u.test(file.path)
      || files.has(file.path)) fail('compiler file path is unsafe')
    total += Buffer.byteLength(file.content)
    if (total > 512 * 1024) fail('compiler output exceeds bound')
    files.set(file.path, file.content)
  }
  return files
}

/** Only the Host-scaffolded create/revise-created lane may call this. The
 * candidate is passed to a fixed compiler as data, never launched as code. */
export async function runNativePreparedChecks(input: NativeBuildInput): Promise<SourceBuildResult<NativeSourcePreparedEvidence>> {
  if (process.platform !== 'darwin' || !/^source-job-[a-f0-9]{64}$/u.test(input.sourceJob.id)
    || !DIGEST.test(input.config.authorityDigest) || input.config.expiresAt <= Date.now()
    || (input.creation === undefined) === (input.revision === undefined)) fail('durable creation authority is required')
  const verify = async (): Promise<void> => {
    const grant = input.creation?.grant ?? input.revision!.binding.grant
    if (grant.expiresAt <= Date.now()) fail('creation or revision grant expired')
    const result = input.creation === undefined
      ? await verifyRevisedPluginWorkspace({ worktree: input.worktree, baseCommit: input.baseCommit,
        name: input.name, environment: input.environment, signal: input.signal, assertCurrent: input.assertCurrent,
        revision: input.revision!.binding, parentSource: input.revision!.parentSource,
        parentCertificate: input.revision!.parentCertificate, files: input.revision!.files })
      : await verifyCreatedPluginWorkspace({ worktree: input.worktree, baseCommit: input.baseCommit,
        name: input.name, environment: input.environment, signal: input.signal, assertCurrent: input.assertCurrent,
        creation: input.creation })
    const expected = [...input.scope].sort(), actual = [...result.scope].sort()
    if (expected.length !== actual.length || expected.some((path, i) => path !== actual[i])) fail('scope differs from Host scaffold')
    await input.assertCurrent()
  }
  await verifyNativeMacRuntime(input.config.runtime)
  await verify()
  const before = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment,
    undefined, input.signal)
  const files = await pluginFiles(join(input.worktree, 'plugins', input.name))
  const sources = [...files].filter(([path]) => path.startsWith('src/') && /\.tsx?$/u.test(path))
    .map(([path, content]) => ({ path, content }))
  if (!sources.some(file => file.path === 'src/index.ts')) fail('source entry is missing')
  const result = await input.runner.run(input.sourceJob.id, [], JSON.stringify({ schemaVersion: 1,
    modulesPath: input.config.runtime.modulesPath, files: sources }), input.signal)
  await input.assertCurrent()
  if (!result.quiescent || result.status !== 'succeeded' || result.exitCode !== 0 || result.stderr !== '') {
    throw new ControlPlaneCliError('EXECUTOR_FAILED', `native source compiler ${result.status}: ${result.reason ?? result.stderr.slice(0, 512)}`)
  }
  let decoded: unknown
  try { decoded = JSON.parse(result.stdout) as unknown }
  catch { fail('compiler output is not JSON') }
  const compiler = compilerOutput(decoded)
  if ((decoded as { typescriptVersion?: unknown }).typescriptVersion !== input.config.runtime.versions.typescript) fail('TypeScript version differs')
  const packed = packNativeCreatedPlugin(input.name, files, compiler)
  await verifyNativeMacRuntime(input.config.runtime)
  await verify()
  const after = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, input.environment,
    undefined, input.signal)
  if (after.checkedTreeDigest !== before.checkedTreeDigest || after.checkedPatchDigest !== before.checkedPatchDigest) {
    fail('source changed during native compilation')
  }
  const checkedAt = Date.now()
  return { treeDigest: after.checkedTreeDigest, patchDigest: after.checkedPatchDigest, checkedAt,
    ...(input.capturePack ? { packArtifact: packed.bytes } : {}),
    evidence: Object.freeze({ schemaVersion: 2, kind: 'dsh-source-prepared-evidence',
      boundary: 'macos-seatbelt-single-process-v1', runtimeDigest: nativeMacRuntimeDigest(input.config.runtime),
      fixedCompilerSha256: compilerSha256,
      checks: Object.freeze(['semantic-typecheck', 'js-declaration-emit', 'host-safe-pack'] as const),
      pack: Object.freeze({ name: packed.name, version: packed.version, sizeBytes: packed.bytes.length, sha256: packed.sha256 }),
      preparedAt: input.preparedAt }) }
}
