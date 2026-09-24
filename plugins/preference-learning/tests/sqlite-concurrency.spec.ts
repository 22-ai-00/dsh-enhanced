import { fork } from 'node:child_process'
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
import { observeRaceWorker, type WorkerMessage } from './fixtures/sqlite-race-worker.ts'

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

const workerPath = fileURLToPath(new URL('./fixtures/sqlite-open-worker.mjs', import.meta.url))

async function concurrentlyOpen(moduleUrl: string, databasePath: string, count = 16) {
  const workers = Array.from({ length: count }, () => observeRaceWorker(fork(workerPath, [moduleUrl, databasePath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })))
  const results = Promise.all(workers.map(worker => worker.result))
  void results.catch(() => {})
  try {
    await Promise.all(workers.map(worker => worker.ready))
    await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
      worker.child.send('open', error => error === null ? resolve() : reject(error))
    })))
    return await results
  } finally {
    // A failed worker must not leave its peers opening a database while the
    // test's afterEach removes it. Successful results already await close.
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL')
    }
    await Promise.all(workers.map(worker => worker.closed))
  }
}

function assertSuccessfulMigration(results: WorkerMessage[]): void {
  expect(results.map(result => result.error)).toEqual(Array.from({ length: results.length }))
  expect(results.map(result => result.result)).toEqual(Array.from({ length: results.length }, () => ({
    schemaVersion: preferenceSchemaVersion,
    schemaTables: 15,
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
