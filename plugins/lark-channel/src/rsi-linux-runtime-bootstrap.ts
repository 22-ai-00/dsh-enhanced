import { isDeepStrictEqual } from 'node:util'
import {
  freezeLinuxRuntimeSource, prepareLinuxRuntime, readLinuxRuntime,
  LinuxRsiRuntimeUnavailableError,
  type FrozenLinuxRuntimeSource, type LinuxRuntimeInput, type PreparedLinuxRuntime,
} from '@dsh-enhanced/assistant-isolation/native-resources'
import { readRsiSourceWorkspace, type RsiSourceWorkspace } from './rsi-source.js'

// Existing RSI import paths, constants, error identity and schema-3 receipts stay compatible.
export { NODE_VERSION, NODE_ARCHIVES, LinuxRsiRuntimeUnavailableError,
  officialArchive, extractExact } from '@dsh-enhanced/assistant-isolation/native-resources'
export type LinuxRsiBuildEnvironment = PreparedLinuxRuntime
export interface LinuxRsiBootstrapInput extends Omit<LinuxRuntimeInput, 'source' | 'revalidateSource'> {
  source: RsiSourceWorkspace
}

async function adapted(input: LinuxRsiBootstrapInput): Promise<LinuxRuntimeInput> {
  input.signal?.throwIfAborted()
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    throw new LinuxRsiRuntimeUnavailableError('Linux x64/arm64 required')
  }
  input = { ...input, source: structuredClone(input.source) }
  const expected = input.source
  let frozen: FrozenLinuxRuntimeSource
  const revalidateSource = async (): Promise<void> => {
    const source = await readRsiSourceWorkspace({ dshHome: input.dshHome, profile: input.profile,
      version: expected.version, ...(expected.origin.kind === 'local-head'
        ? { sourceRepository: expected.origin.locator } : {}),
      ...(input.signal ? { signal: input.signal } : {}) })
    if (!isDeepStrictEqual(source, expected)) throw new Error('rsi Linux runtime: frozen source receipt changed')
    const current = await freezeLinuxRuntimeSource({ kind: 'git-object', repository: expected.repository,
      commit: expected.sourceCommit, version: expected.version, ...(input.signal ? { signal: input.signal } : {}) })
    if (frozen && !isDeepStrictEqual(current, frozen)) throw new Error('rsi Linux runtime: frozen manifest changed during prepare')
    frozen = current
  }
  await revalidateSource()
  // The callback reopens the independently authenticated RSI workspace and Git
  // objects before/after shared preparation; it never compares only memory.
  return { ...input, source: frozen!, revalidateSource }
}
export async function prepareLinuxRsiRuntime(input: LinuxRsiBootstrapInput): Promise<LinuxRsiBuildEnvironment> {
  return prepareLinuxRuntime(await adapted(input))
}
export async function readLinuxRsiRuntime(input: LinuxRsiBootstrapInput): Promise<LinuxRsiBuildEnvironment> {
  return readLinuxRuntime(await adapted(input))
}
