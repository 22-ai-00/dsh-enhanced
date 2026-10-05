import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { validatePluginCreationVerificationCertificate, validatePluginRevisionParentBinding,
  validateSourceGrowthRunBinding, type PluginCreationVerificationCertificate, type PluginRevisionParentBinding,
  type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { validateCreationCapabilitySource, type CreationCapabilitySourceSnapshot } from './creation-capability-source.js'
import { ControlPlaneCliError } from './errors.js'
import { inspectCreationHostScaffold, prepareCreationHostScaffold, validateSourceCreationFiles,
  verifyCreationHostScaffold, type SourceCreationHostScaffold } from './source-creation.js'
import type { SourceInspection } from './source-context.js'
import { controlPlaneDigest } from './store.js'
import { writeCreatedPluginFiles, type ScopedPluginFile } from './source-workspace.js'

const NAME = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const GRANT_ID = /^(?=.{1,128}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const DIGEST = /^[a-f0-9]{64}$/u
const RESERVED = new Set(['package.json', 'cordis.patch.yml', 'LICENSE', 'tsconfig.json',
  'tsconfig.build.json', 'src/version.ts'])
const MAX_FILES = 64
const MAX_FILE_BYTES = 65_536
const MAX_TOTAL_BYTES = 262_144

export interface SourceRevisionGrant {
  id: string
  expiresAt: number
  maxRevisions: number
  namePrefix: string
}

export interface SourceRevisionBinding {
  grant: SourceRevisionGrant
  generatorDigest: string
  parent: PluginRevisionParentBinding
  growthRun: SourceGrowthRunBinding
}

function fail(reason: string): never { throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source revision ${reason}`) }

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) fail(label)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const actual = Object.keys(descriptors).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]
    || !descriptors[key]!.enumerable || !('value' in descriptors[key]!))) fail(label)
  return value as Record<string, unknown>
}

/** Shape remains valid for historical grants after their expiry. */
export function validateSourceRevisionGrant(value: unknown): asserts value is SourceRevisionGrant {
  const grant = exact(value, ['id', 'expiresAt', 'maxRevisions', 'namePrefix'], 'grant')
  if (typeof grant.id !== 'string' || !GRANT_ID.test(grant.id) || grant.id.normalize('NFC') !== grant.id
    || !Number.isSafeInteger(grant.expiresAt) || Number(grant.expiresAt) < 1
    || !Number.isSafeInteger(grant.maxRevisions) || Number(grant.maxRevisions) < 1 || Number(grant.maxRevisions) > 1_000
    || typeof grant.namePrefix !== 'string' || grant.namePrefix.length < 2 || grant.namePrefix.length > 48
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-$/u.test(grant.namePrefix)) fail('grant fields')
}

export function validateSourceRevisionBinding(value: unknown): asserts value is SourceRevisionBinding {
  const binding = exact(value, ['grant', 'generatorDigest', 'parent', 'growthRun'], 'binding')
  validateSourceRevisionGrant(binding.grant)
  validatePluginRevisionParentBinding(binding.parent)
  validateSourceGrowthRunBinding(binding.growthRun)
  if (typeof binding.generatorDigest !== 'string' || !DIGEST.test(binding.generatorDigest)
    || !(binding.growthRun as SourceGrowthRunBinding).revisionAcceptance
    || (binding.growthRun as SourceGrowthRunBinding).revisionAcceptance!.namePrefix !== (binding.grant as SourceRevisionGrant).namePrefix) {
    fail('binding fields')
  }
}

function currentGrant(grant: SourceRevisionGrant, name: string): void {
  validateSourceRevisionGrant(grant)
  if (!NAME.test(name) || name.normalize('NFC') !== name || !name.startsWith(grant.namePrefix)
    || name.length <= grant.namePrefix.length || grant.expiresAt <= Date.now()) fail('grant expired or plugin name outside namespace')
}

function parentFiles(name: string, parent: PluginRevisionParentBinding, parentSource: CreationCapabilitySourceSnapshot,
  parentCertificate: PluginCreationVerificationCertificate, scaffold: SourceCreationHostScaffold): Map<string, string> {
  validatePluginRevisionParentBinding(parent)
  validatePluginCreationVerificationCertificate(parentCertificate)
  validateCreationCapabilitySource(parentSource, parentCertificate)
  if (parent.planId !== parentCertificate.plan.id || parent.certificateDigest !== controlPlaneDigest(parentCertificate)
    || parent.artifactSha256 !== parentCertificate.plan.artifactSha256 || parent.sourceDigest !== parentSource.digest
    || parentCertificate.plan.name !== name || parentCertificate.plan.generatorDigest !== scaffold.generatorDigest) fail('parent binding')
  // The signed archive envelope is checked by the Host port. Its digest has no
  // corresponding raw envelope here; sourceDigest binds the snapshot bytes.
  const root = `plugins/${name}/`
  const generated = new Map(scaffold.files.map(file => [file.path, file.content]))
  const source = new Map<string, string>()
  for (const file of parentSource.files) {
    if (!file.path.startsWith(root)) fail('parent root')
    const path = file.path.slice(root.length)
    if (file.mode !== '100644') fail('parent file mode')
    if (RESERVED.has(path)) {
      if (generated.get(path) !== file.content) fail(`parent protected metadata changed: ${path}`)
    } else {
      validateSourceCreationFiles([{ path, content: file.content }])
      source.set(path, file.content)
    }
  }
  for (const file of scaffold.files) {
    if (!RESERVED.has(file.path) && !source.has(file.path)) fail(`parent lacks generated candidate: ${file.path}`)
  }
  return source
}

function proposedFiles(parent: Map<string, string>, files: readonly ScopedPluginFile[]): Map<string, string> {
  validateSourceCreationFiles(files)
  const result = new Map(parent)
  let changed = false
  for (const file of files) {
    if (parent.get(file.path) !== file.content) changed = true
    result.set(file.path, file.content)
  }
  if (!changed) fail('candidate makes no source change')
  return result
}

function assertFinalBudget(scaffold: SourceCreationHostScaffold, candidate: Map<string, string>): void {
  let total = 0
  let count = 0
  for (const content of [...scaffold.files.filter(file => RESERVED.has(file.path)).map(file => file.content), ...candidate.values()]) {
    const bytes = Buffer.byteLength(content, 'utf8')
    if (++count > MAX_FILES || bytes > MAX_FILE_BYTES || (total += bytes) > MAX_TOTAL_BYTES) fail('final source exceeds bounds')
  }
}

function assertPaths(paths: readonly string[], source: Map<string, string>): void {
  if (!Array.isArray(paths) || paths.length > MAX_FILES || new Set(paths).size !== paths.length) fail('inspection paths')
  for (const path of paths) {
    if (typeof path !== 'string' || path.normalize('NFC') !== path || !source.has(path)) fail('inspection path unavailable')
  }
}

export async function inspectSourceRevisionContext(input: {
  repository: string; name: string; paths: readonly string[]; baseCommit?: string; baselineCommit?: string
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>
  grant: SourceRevisionGrant; parent: PluginRevisionParentBinding
  parentSource: CreationCapabilitySourceSnapshot; parentCertificate: PluginCreationVerificationCertificate
}): Promise<SourceInspection & { generatorDigest: string }> {
  currentGrant(input.grant, input.name)
  const scaffold = await inspectCreationHostScaffold(input)
  const source = parentFiles(input.name, input.parent, input.parentSource, input.parentCertificate, scaffold)
  assertPaths(input.paths, source)
  return Object.freeze({ name: input.name, baseCommit: scaffold.baseCommit, generatorDigest: scaffold.generatorDigest,
    files: Object.freeze([...input.parentSource.files].map(file => Object.freeze({ path: file.path.slice(`plugins/${input.name}/`.length), bytes: file.bytes }))),
    contents: Object.freeze(input.paths.map(path => Object.freeze({ path, content: source.get(path)! }))) })
}

type RevisionWorkspaceInput = {
  worktree: string; baseCommit: string; name: string; files: readonly ScopedPluginFile[]
  environment: NodeJS.ProcessEnv; signal: AbortSignal; assertCurrent: () => void | Promise<void>
  revision: SourceRevisionBinding; parentSource: CreationCapabilitySourceSnapshot
  parentCertificate: PluginCreationVerificationCertificate
}

function checkBinding(input: RevisionWorkspaceInput): void {
  validateSourceRevisionBinding(input.revision)
  currentGrant(input.revision.grant, input.name)
  if (input.revision.growthRun.revisionAcceptance!.expiresAt <= Date.now()) fail('acceptance authority expired')
}

export async function prepareRevisedPluginWorkspace(input: RevisionWorkspaceInput): Promise<{ scope: readonly string[]; generatorDigest: string }> {
  checkBinding(input)
  const preflight = await inspectCreationHostScaffold({ ...input, repository: input.worktree })
  if (preflight.generatorDigest !== input.revision.generatorDigest) fail('generator inputs changed')
  const parent = parentFiles(input.name, input.revision.parent, input.parentSource, input.parentCertificate, preflight)
  const expected = proposedFiles(parent, input.files)
  assertFinalBudget(preflight, expected)
  const scaffold = await prepareCreationHostScaffold({ ...input, expectedGeneratorDigest: input.revision.generatorDigest })
  if (scaffold.generatorDigest !== preflight.generatorDigest || scaffold.baseCommit !== preflight.baseCommit) fail('Host scaffold drift')
  await writeCreatedPluginFiles({ worktree: input.worktree, name: input.name,
    files: [...parent].map(([path, content]) => ({ path, content })) })
  await writeCreatedPluginFiles({ worktree: input.worktree, name: input.name, files: input.files })
  return verifyRevisedPluginWorkspace(input)
}

export async function verifyRevisedPluginWorkspace(input: RevisionWorkspaceInput): Promise<{ scope: readonly string[]; generatorDigest: string }> {
  checkBinding(input)
  const { expected: scaffold, actual } = await verifyCreationHostScaffold({ ...input, expectedGeneratorDigest: input.revision.generatorDigest })
  const parent = parentFiles(input.name, input.revision.parent, input.parentSource, input.parentCertificate, scaffold)
  const expected = proposedFiles(parent, input.files)
  assertFinalBudget(scaffold, expected)
  const complete = new Map([...scaffold.files.filter(file => RESERVED.has(file.path)).map(file => [file.path, file.content] as const), ...expected])
  if (actual.length !== complete.size) fail('actual source file set changed')
  for (const file of actual) {
    if (complete.get(file.path) !== file.content || file.bytes !== Buffer.byteLength(file.content, 'utf8')) fail(`actual source changed: ${file.path}`)
    if (!RESERVED.has(file.path)) {
      const stat = await lstat(join(input.worktree, 'plugins', input.name, file.path))
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) !== 0) fail(`candidate mode changed: ${file.path}`)
    }
  }
  await input.assertCurrent()
  input.signal.throwIfAborted()
  return Object.freeze({ scope: Object.freeze([`plugins/${input.name}`, 'plugins/README.md', 'pnpm-lock.yaml']),
    generatorDigest: scaffold.generatorDigest })
}
