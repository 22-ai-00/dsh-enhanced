import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export type HeartbeatScratchErrorCode =
  | 'content-too-large'
  | 'invalid-path'
  | 'revision-conflict'
  | 'unsafe-path'

export class HeartbeatScratchError extends Error {
  constructor(readonly code: HeartbeatScratchErrorCode, message: string) {
    super(message)
    this.name = 'HeartbeatScratchError'
  }
}

export interface HeartbeatScratchSnapshot {
  content: string
  empty: boolean
  revision: string
}

function canonical(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/gu, '\n').trim()
}

function revision(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class HeartbeatScratch {
  private readonly path: string
  private readonly maxBytes: number

  constructor(options: { path: string; maxBytes: number; initialContent?: string }) {
    if (!isAbsolute(options.path)) {
      throw new HeartbeatScratchError('invalid-path', 'heartbeat scratch path must be absolute')
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 1_048_576) {
      throw new HeartbeatScratchError('content-too-large', 'heartbeat scratch byte limit is invalid')
    }
    this.path = options.path
    this.maxBytes = options.maxBytes
    this.assertSafeLeaf()
    const parent = dirname(this.path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    chmodSync(parent, 0o700)
    if (!existsSync(this.path)) this.writeInitial(options.initialContent ?? '')
    this.assertSafeLeaf()
    chmodSync(this.path, 0o600)
    this.snapshot(readFileSync(this.path, 'utf8'))
  }

  read(): HeartbeatScratchSnapshot {
    this.assertSafeLeaf()
    return this.snapshot(readFileSync(this.path, 'utf8'))
  }

  write(input: { expectedRevision: string; content: string }): HeartbeatScratchSnapshot {
    const current = this.read()
    if (input.expectedRevision !== current.revision) {
      throw new HeartbeatScratchError('revision-conflict', 'heartbeat scratch revision changed')
    }
    const content = canonical(input.content)
    this.assertBounded(content)
    this.atomicWrite(content)
    return this.read()
  }

  private snapshot(value: string): HeartbeatScratchSnapshot {
    const content = canonical(value)
    this.assertBounded(content)
    return Object.freeze({ content, empty: content === '', revision: revision(content) })
  }

  private assertBounded(content: string): void {
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes) {
      throw new HeartbeatScratchError('content-too-large', 'heartbeat scratch exceeds its byte limit')
    }
  }

  private assertSafeLeaf(): void {
    let metadata: ReturnType<typeof lstatSync>
    try {
      metadata = lstatSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new HeartbeatScratchError('unsafe-path', 'heartbeat scratch must be a regular non-symlink file')
    }
  }

  private writeInitial(content: string): void {
    const normalized = canonical(content)
    this.assertBounded(normalized)
    this.atomicWrite(normalized)
  }

  private atomicWrite(content: string): void {
    const temporary = join(dirname(this.path), `.${randomUUID()}.heartbeat.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeSync(descriptor, content === '' ? '' : `${content}\n`, undefined, 'utf8')
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, this.path)
      chmodSync(this.path, 0o600)
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      if (existsSync(temporary)) unlinkSync(temporary)
      throw error
    }
  }
}
