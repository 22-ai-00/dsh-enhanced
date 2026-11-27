import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LINUX_BEHAVIOR_COMMAND = 'exec /usr/bin/env LD_PRELOAD=/runtime/0/dsh-plugin-verifier/parent-protect.so /runtime/0/bin/node --disable-sigusr1 /runtime/0/dsh-plugin-verifier/worker.mjs'
export const LINUX_BEHAVIOR_PREFIX = '/runtime/0/dsh-plugin-verifier'
// Node checks both the package alias and its resolved SDK path. The historical
// second SDK alias is redundant here; use that grant for the exact real tree.
// Keep the first alias for package.json reads, never grant the whole runtime.
export const LINUX_BEHAVIOR_MAPPINGS = [
  ['/opt/dsh-plugin-verifier/plugins/assistant-verifier/node_modules', '/runtime/0/node_modules'],
  ['/opt/dsh-plugin-verifier', LINUX_BEHAVIOR_PREFIX],
] as const
export const LINUX_BEHAVIOR_COMPILE_FLAGS = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DDSH_NODE_PATH="/runtime/0/bin/node"'] as const
export const behaviorSha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

async function readCheckedBehaviorFile(path: string, limit: number, allowHardlinks: boolean): Promise<Buffer> {
  const before = await lstat(path)
  const disallowedUid = typeof process.getuid === 'function'
    && before.uid !== process.getuid() && before.uid !== 0
  if (!before.isFile() || (allowHardlinks ? before.nlink < 1 : before.nlink !== 1)
    || !Number.isFinite(limit) || limit < 0 || before.size < 0 || before.size > limit
    || before.mode & 0o7022
    || disallowedUid || await realpath(path) !== path) throw new Error('unsafe Linux behavior asset')
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const stamp = (info: typeof before): string => JSON.stringify([
    info.dev, info.ino, info.mode, info.uid, info.size, info.mtimeMs,
    ...(allowHardlinks ? [] : [info.nlink, info.ctimeMs]),
  ])
  try {
    if (stamp(await fd.stat()) !== stamp(before)) throw new Error('Linux behavior asset changed')
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < buffer.length) {
      const result = await fd.read(buffer, count, buffer.length - count)
      if (!result.bytesRead) break
      count += result.bytesRead
    }
    if (count !== before.size || stamp(await fd.stat()) !== stamp(before)
      || stamp(await lstat(path)) !== stamp(before)) throw new Error('Linux behavior asset changed')
    return buffer.subarray(0, count)
  } finally { await fd.close() }
}

/** Bounded descriptor reads: private assets must be ordinary, stable, unlinked files. */
export async function readBehaviorFile(path: string, limit: number): Promise<Buffer> {
  return readCheckedBehaviorFile(path, limit, false)
}

/** Installed package assets may be hardlinked into node_modules by pnpm's content-addressable store. */
export async function readInstalledBehaviorAsset(path: string, limit: number): Promise<Buffer> {
  return readCheckedBehaviorFile(path, limit, true)
}

/** Same unique markers and byte limit as the existing Docker asset extractor. */
export function extractLinuxBehaviorAsset(raw: string, name: 'WORKER' | 'CANDIDATE'): string {
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Linux behavior source too large')
  const begin = `/* DSH_PLUGIN_VERIFIER_${name}_START\n`
  const end = `\nDSH_PLUGIN_VERIFIER_${name}_END */`
  const first = raw.indexOf(begin), last = raw.indexOf(end, first + begin.length)
  if (first < 0 || last < 0 || raw.indexOf(begin, first + 1) >= 0 || raw.indexOf(end) !== last
    || raw.indexOf(end, last + 1) >= 0) throw new Error('Linux behavior fixed markers invalid')
  const result = raw.slice(first + begin.length, last) + '\n'
  if (Buffer.byteLength(result) > 32 * 1024) throw new Error('Linux behavior fixed asset too large')
  return result
}

export interface LinuxBehaviorAssets {
  worker: string
  candidate: string
  launcher: string
  sourceSha256: string
}

export async function loadLinuxBehaviorAssets(): Promise<LinuxBehaviorAssets> {
  const packageRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)))
  const raw = (await readInstalledBehaviorAsset(join(packageRoot, 'lib', 'plugin-behavior-runner.js'), 256 * 1024)).toString('utf8')
  const launcher = (await readInstalledBehaviorAsset(join(packageRoot, 'runtime', 'plugin-observer-launcher.c'), 64 * 1024)).toString('utf8')
  const worker = extractLinuxBehaviorAsset(raw, 'WORKER'), candidate = extractLinuxBehaviorAsset(raw, 'CANDIDATE')
  const map = (source: string): string => LINUX_BEHAVIOR_MAPPINGS.reduce((value, [from, to]) => value.replaceAll(from, to), source)
  // Canonical fixed-source identity: only these ordered fields, original UTF-8
  // bytes, exact prefix mapping, command and compiler flags enter this digest.
  // Compiler/helper identity is independently bound by the private receipt.
  const sourceSha256 = behaviorSha256(JSON.stringify({ schemaVersion: 1, workerSha256: behaviorSha256(worker),
    candidateSha256: behaviorSha256(candidate), launcherSourceSha256: behaviorSha256(launcher),
    mapping: LINUX_BEHAVIOR_MAPPINGS, command: LINUX_BEHAVIOR_COMMAND,
    compileFlags: LINUX_BEHAVIOR_COMPILE_FLAGS }))
  return { worker: map(worker), candidate: map(candidate), launcher: map(launcher), sourceSha256 }
}
