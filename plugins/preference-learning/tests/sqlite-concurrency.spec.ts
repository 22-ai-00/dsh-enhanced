import { fork, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, describe, expect, test } from 'vitest'
import { openPreferenceDatabase, preferenceSchemaVersion } from '../src/sqlite.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `preference-learning-${name}-`))
  roots.push(value)
  return value
}

/** Compile the dependency-free SQLite module so every child loads an isolated production copy. */
function sqliteModule(root: string): string {
  const output = join(root, 'worker-module')
  mkdirSync(output)
  const source = fileURLToPath(new URL('../src/sqlite.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    fileName: 'sqlite.ts',
  }).outputText
  writeFileSync(join(output, 'sqlite.js'), compiled)
  writeFileSync(join(output, 'package.json'), JSON.stringify({ type: 'module' }))
  return pathToFileURL(join(output, 'sqlite.js')).href
}

interface WorkerMessage {
  type: 'ready' | 'result'
  result?: {
    schemaVersion: number
    schemaTables: number
    journalMode: string
    secureDelete: number
  }
  error?: { name: string; code?: string; message: string }
}

interface RaceWorker {
  child: ChildProcess
  ready: Promise<void>
  result: Promise<WorkerMessage>
}

const workerPath = fileURLToPath(new URL('./fixtures/sqlite-open-worker.mjs', import.meta.url))

function startWorker(moduleUrl: string, databasePath: string): RaceWorker {
  const child = fork(workerPath, [moduleUrl, databasePath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr?.on('data', chunk => { stderr += String(chunk) })

  let ready = false
  let settled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveResult!: (message: WorkerMessage) => void
  let rejectResult!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const resultPromise = new Promise<WorkerMessage>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const fail = (error: Error): void => {
    if (!ready) rejectReady(error)
    if (!settled) rejectResult(error)
  }

  child.on('message', value => {
    const message = value as WorkerMessage
    if (message.type === 'ready') {
      ready = true
      resolveReady()
      return
    }
    if (message.type === 'result') {
      settled = true
      resolveResult(message)
    }
  })
  child.once('error', error => { fail(error) })
  child.once('exit', code => {
    if (!settled) {
      fail(new Error(`SQLite race worker exited ${code ?? 'by signal'}${stderr === '' ? '' : `: ${stderr}`}`))
    }
  })
  return { child, ready: readyPromise, result: resultPromise }
}

async function concurrentlyOpen(moduleUrl: string, databasePath: string, count = 16) {
  const workers = Array.from({ length: count }, () => startWorker(moduleUrl, databasePath))
  await Promise.all(workers.map(worker => worker.ready))
  for (const worker of workers) worker.child.send?.('open')
  return Promise.all(workers.map(worker => worker.result))
}

function assertSuccessfulMigration(results: WorkerMessage[]): void {
  expect(results.map(result => result.error)).toEqual(Array.from({ length: results.length }))
  expect(results.map(result => result.result)).toEqual(Array.from({ length: results.length }, () => ({
    schemaVersion: preferenceSchemaVersion,
    schemaTables: 11,
    journalMode: 'wal',
    secureDelete: 1,
  })))
}

describe('preference SQLite first-open concurrency', () => {
  test('serializes first creation across real processes without EEXIST or duplicate DDL', async () => {
    const root = temporaryRoot('new-database-race')
    const databasePath = join(root, 'preferences.sqlite')
    const results = await concurrentlyOpen(sqliteModule(root), databasePath)

    assertSuccessfulMigration(results)
    const database = openPreferenceDatabase(databasePath)
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    database.close()
  }, 30_000)

  test('serializes migration of a pre-created empty database across real processes', async () => {
    const root = temporaryRoot('empty-database-race')
    const databasePath = join(root, 'preferences.sqlite')
    closeSync(openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600))

    const results = await concurrentlyOpen(sqliteModule(root), databasePath)

    assertSuccessfulMigration(results)
    const database = openPreferenceDatabase(databasePath)
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    database.close()
  }, 30_000)
})
