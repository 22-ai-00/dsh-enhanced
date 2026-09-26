import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const maximumInputBytes = 64n * 1024n * 1024n

function insideProfile(profilePath: string, physical: string): string {
  const inside = relative(profilePath, physical)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Host input escapes profile')
  return inside
}

function validInput(input: string): void {
  if (!input || input.includes('\\') || input.includes('\0') || isAbsolute(input)
    || input.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Host input path is invalid')
}

function trustedFile(stat: { isFile(): boolean; size: bigint; mode: bigint; uid: bigint }): boolean {
  const uid = process.getuid?.()
  return stat.isFile() && stat.size <= maximumInputBytes && (stat.mode & 0o022n) === 0n
    && (stat.mode & 0o7000n) === 0n && (uid === undefined || stat.uid === 0n || stat.uid === BigInt(uid))
}

/**
 * Break pnpm-style hardlinks only for signed, declared inputs. The caller holds
 * the profile mutation lock; directory-descriptor paths keep every write in
 * the already-open private profile directory if a pathname is swapped.
 */
export async function materializeHostInputFiles(profilePath: string, inputs: readonly string[]): Promise<void> {
  if (!isAbsolute(profilePath) || resolve(profilePath) !== profilePath || await realpath(profilePath) !== profilePath) {
    throw new Error('Host input profile is not canonical')
  }
  if (inputs.length < 1 || inputs.length > 128) throw new Error('Host input count is invalid')
  const physicalPaths = new Set<string>()
  let copiedBytes = 0n
  for (const input of inputs) {
    validInput(input)
    const logical = join(profilePath, input), physical = await realpath(logical)
    insideProfile(profilePath, physical)
    if (physicalPaths.has(physical)) throw new Error('Host inputs alias the same file')
    physicalPaths.add(physical)
    const parent = dirname(physical)
    if (await realpath(parent) !== parent) throw new Error('Host input parent is not canonical')
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    let temporary: string | undefined
    try {
      const directoryStat = await directory.stat({ bigint: true }), uid = process.getuid?.()
      if (!directoryStat.isDirectory() || (directoryStat.mode & 0o022n) !== 0n
        || (uid !== undefined && directoryStat.uid !== 0n && directoryStat.uid !== BigInt(uid))) {
        throw new Error('Host input parent is not a trusted directory')
      }
      // /proc/self/fd anchors both rename operands to the opened directory,
      // so a concurrent parent symlink swap cannot redirect writes outside it.
      const anchored = `/proc/self/fd/${directory.fd}`
      if (await realpath(anchored) !== parent) throw new Error('Host input parent changed before copy')
      const target = join(anchored, basename(physical))
      const pathname = await lstat(target, { bigint: true })
      if (!trustedFile(pathname)) throw new Error('Host input is not a trusted regular file')
      const source = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await source.stat({ bigint: true })
        if (before.dev !== pathname.dev || before.ino !== pathname.ino || before.size !== pathname.size
          || before.mtimeNs !== pathname.mtimeNs || before.ctimeNs !== pathname.ctimeNs) throw new Error('Host input changed before copy')
        if (before.nlink === 1n) continue
        copiedBytes += before.size
        if (copiedBytes > 512n * 1024n * 1024n) throw new Error('Host input materialization byte budget exceeded')
        const bytes = await source.readFile(), after = await source.stat({ bigint: true })
        if (BigInt(bytes.length) !== before.size || after.dev !== before.dev || after.ino !== before.ino
          || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
          throw new Error('Host input changed during copy')
        }
        temporary = join(anchored, `.dsh-host-input-${randomUUID()}`)
        const copy = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          await copy.writeFile(bytes)
          await copy.chmod(Number(before.mode & 0o777n))
          const copied = await copy.stat({ bigint: true })
          if (!copied.isFile() || copied.nlink !== 1n || copied.size !== before.size) throw new Error('Host input copy is incomplete')
          await copy.sync()
        } finally { await copy.close() }
        const current = await lstat(target, { bigint: true })
        if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
          || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs
          || await realpath(anchored) !== parent || await realpath(logical) !== physical
          || await realpath(profilePath) !== profilePath) {
          throw new Error('Host input changed before atomic replacement')
        }
        await rename(temporary, target)
        temporary = undefined
        await directory.sync()
        const detached = await lstat(target, { bigint: true })
        if (!trustedFile(detached) || detached.nlink !== 1n || detached.size !== before.size
          || await realpath(anchored) !== parent || await realpath(logical) !== physical) {
          throw new Error('Host input changed after atomic replacement')
        }
      } finally { await source.close() }
    } finally {
      try {
        if (temporary !== undefined) {
          await unlink(temporary).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
          await directory.sync()
        }
      } finally { await directory.close() }
    }
  }
}

/** Capture declared deployment inputs before a staged profile can reach its Host. */
export async function captureHostInputFiles(profilePath: string, finalProfilePath: string, inputs: readonly string[]): Promise<readonly {
  input: string; path: string; sha256: string
}[]> {
  if (!isAbsolute(profilePath) || resolve(profilePath) !== profilePath || await realpath(profilePath) !== profilePath
    || !isAbsolute(finalProfilePath) || resolve(finalProfilePath) !== finalProfilePath) throw new Error('Host input profile is not canonical')
  const captured = []
  for (const input of inputs) {
    validInput(input)
    const logical = join(profilePath, input), physical = await realpath(logical)
    const inside = insideProfile(profilePath, physical)
    const pathname = await lstat(physical, { bigint: true }), uid = process.getuid?.()
    if (!trustedFile(pathname) || pathname.nlink !== 1n
      || (uid !== undefined && pathname.uid !== 0n && pathname.uid !== BigInt(uid))) throw new Error('Host input is not a trusted regular file')
    const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat({ bigint: true })
      if (before.dev !== pathname.dev || before.ino !== pathname.ino || before.size !== pathname.size
        || before.mtimeNs !== pathname.mtimeNs || before.ctimeNs !== pathname.ctimeNs) throw new Error('Host input changed before read')
      const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), linked = await lstat(physical, { bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size || before.dev !== linked.dev
        || before.ino !== linked.ino || await realpath(logical) !== physical) throw new Error('Host input changed during read')
      captured.push({ input, path: join(finalProfilePath, inside), sha256: createHash('sha256').update(bytes).digest('hex') })
    } finally { await handle.close() }
  }
  if (new Set(captured.map(file => file.path)).size !== captured.length) throw new Error('Host inputs alias the same file')
  return captured
}
