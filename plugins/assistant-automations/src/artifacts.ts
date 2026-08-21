import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'

export type AutomationArtifactErrorCode = 'idempotency-conflict' | 'invalid-id' | 'invalid-path' | 'too-large'

export class AutomationArtifactError extends Error {
  constructor(readonly code: AutomationArtifactErrorCode, message: string) {
    super(message)
    this.name = 'AutomationArtifactError'
  }
}

export class AutomationArtifactStore {
  private readonly rootPath: string
  private readonly maxBytes: number

  constructor(options: { rootPath: string; maxBytes: number }) {
    if (!isAbsolute(options.rootPath)) {
      throw new AutomationArtifactError('invalid-path', 'artifact root must be absolute')
    }
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 128 || options.maxBytes > 16 * 1024 * 1024) {
      throw new AutomationArtifactError('too-large', 'artifact byte limit is invalid')
    }
    this.rootPath = options.rootPath
    this.maxBytes = options.maxBytes
    mkdirSync(this.rootPath, { recursive: true, mode: 0o700 })
    chmodSync(this.rootPath, 0o700)
  }

  write(occurrenceId: string, value: unknown): string {
    if (!/^occ-[A-Za-z0-9_-]{1,190}$/.test(occurrenceId)) {
      throw new AutomationArtifactError('invalid-id', 'artifact occurrence id is invalid')
    }
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    if (bytes.byteLength > this.maxBytes) {
      throw new AutomationArtifactError('too-large', `artifact exceeds ${this.maxBytes} bytes`)
    }
    const ref = `${occurrenceId}.json`
    const target = join(this.rootPath, ref)
    if (existsSync(target)) {
      if (readFileSync(target).equals(bytes)) return ref
      throw new AutomationArtifactError('idempotency-conflict', 'artifact id was reused with different content')
    }
    const temporary = join(this.rootPath, `.${occurrenceId}.${process.pid}.${Date.now()}.tmp`)
    let descriptor: number | undefined
    try {
      descriptor = openSync(temporary, 'wx', 0o600)
      writeFileSync(descriptor, bytes)
      fsyncSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, target)
      chmodSync(target, 0o600)
      const directory = openSync(this.rootPath, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      return ref
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      if (existsSync(temporary)) unlinkSync(temporary)
    }
  }
}
