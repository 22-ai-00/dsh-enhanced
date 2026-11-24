import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isPrivateDirectoryStats, noFollowFlag } from '../lib/fs-ownership.js'
import { runWindowsJobProcess } from '../lib/windows-job.js'

// Detached supervisor for windows-job. Mirrors native-macos-supervisor.mjs
// crash-safe fsynced receipt protocol using cross-platform ownership checks.
const abort = new AbortController()
let started = false
let disconnected = false
process.on('disconnect', () => { disconnected = true; abort.abort(); if (!started) process.exit(0) })
process.on('message', async message => {
  if (message?.kind === 'cancel') { abort.abort(); return }
  if (started || disconnected || !message || message.kind !== 'command') return
  started = true
  const { jobId, requestDigest, nonce, nativeResourceId, receiptRoot, input } = message
  try {
    if (typeof jobId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(jobId)
      || typeof requestDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(requestDigest)
      || typeof nonce !== 'string' || !/^[0-9a-f-]{36}$/iu.test(nonce)
      || nativeResourceId !== `native-${jobId}` || typeof receiptRoot !== 'string') {
      throw new Error('invalid supervisor envelope')
    }
    const result = await runWindowsJobProcess({ ...input, signal: abort.signal })
    if (!result.quiescent) {
      if (process.connected) process.send?.({ kind: 'unconfirmed' })
      return
    }
    const info = lstatSync(receiptRoot)
    if (!isPrivateDirectoryStats(info)) throw new Error('invalid receipt root')
    const receipt = {
      schemaVersion: 1,
      backend: 'windows-job',
      jobId,
      requestDigest,
      nonce,
      nativeResourceId,
      closed: true,
      closedAt: Date.now(),
      result: { ...result, quiescent: true },
    }
    const file = join(receiptRoot, `${jobId}.json`)
    const temporary = join(receiptRoot, `.${jobId}.${randomUUID()}.tmp`)
    const bytes = Buffer.from(JSON.stringify(receipt))
    if (bytes.length > 3_000_000) throw new Error('receipt exceeds limit')
    let fd
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600)
      if (!fstatSync(fd).isFile() || fstatSync(fd).nlink !== 1) throw new Error('invalid receipt temp')
      let offset = 0
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    renameSync(temporary, file)
    if (process.platform !== 'win32') {
      const dirFd = openSync(receiptRoot, constants.O_RDONLY)
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
    }
    if (process.connected) process.send?.({ kind: 'receipt', jobId })
  } catch {
    if (process.connected) process.send?.({ kind: 'unconfirmed' })
  } finally {
    if (process.connected) process.disconnect?.()
  }
})
