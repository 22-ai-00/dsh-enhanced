import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('CLI SQLite ExperimentalWarning suppression across plugin & install entrypoints', () => {
  const entrypointCases: ReadonlyArray<{
    readonly relPath: string
    readonly args: readonly string[]
    readonly expectedStatus: number
    readonly expectedStderr?: string
    readonly expectedStdout?: string
  }> = [
    { relPath: 'plugins/assistant-evaluation/bin/dsh-benchmark.js', args: ['--help'], expectedStatus: 0, expectedStderr: '' },
    { relPath: 'plugins/assistant-web-owner/bin/dsh-autonomy-doctor.js', args: ['--help'], expectedStatus: 0, expectedStderr: '' },
    { relPath: 'plugins/assistant-web-owner/bin/dsh-web-owner-setup.js', args: ['--help'], expectedStatus: 0, expectedStderr: '' },
    { relPath: 'plugins/lark-channel/bin/dsh-lark-setup.js', args: ['--help'], expectedStatus: 0, expectedStderr: '' },
    { relPath: 'plugins/lark-channel/bin/dsh-ray-setup.js', args: ['--help'], expectedStatus: 0, expectedStderr: '' },
    { relPath: 'plugins/lark-channel/bin/dsh-supervised-growth-setup.js', args: ['--help'], expectedStatus: 0, expectedStderr: '' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-plugin-control.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'plugin-control-plane' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-live-qualification-authority.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'live qualification authority refused the request' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-source-adoption-authority.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'source adoption authority refused the request' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-source-approval-authority.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'source approval authority refused the request' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-source-release-authority.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'source release authority refused the request' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-systemd-host-authority.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'systemd Host authority refused the request' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-task-observation-authority.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'task observation authority refused the request' },
    { relPath: 'plugins/assistant-delivery/bin/dsh-restart-supervisor.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'restart-supervisor:' },
    { relPath: 'plugins/plugin-control-plane/bin/dsh-systemd-host-attestor.js', args: ['--version'], expectedStatus: 0, expectedStderr: '', expectedStdout: 'dsh-systemd-host-attestor-8' },
    { relPath: 'plugins/assistant-skills/lib/holdout-cli.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'holdout authority unavailable' },
    { relPath: 'plugins/assistant-actions/lib/cli.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'assistant-actions: revocation failed or invalid arguments' },
    { relPath: 'plugins/assistant-actions/lib/broker-cli.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'assistant-actions broker: command failed or invalid arguments' },
    { relPath: 'plugins/assistant-isolation/lib/cli.js', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'unknown command' },
    { relPath: 'scripts/install/local-source-cache-copy.mjs', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'invalid private backup invocation' },
    { relPath: 'scripts/install/lifecycle-profile.mjs', args: [], expectedStatus: 2, expectedStderr: 'dsh-ray lifecycle: usage:' },
    { relPath: 'scripts/install/upgrade-program.mjs', args: ['--invalid-flag'], expectedStatus: 1, expectedStderr: 'Program upgrade: unknown option --invalid-flag' },
    { relPath: 'scripts/install/local-source-maintenance.mjs', args: ['unknown-op', '/does/not/exist.json'], expectedStatus: 1, expectedStderr: 'ENOENT' },
  ]

  test.each(entrypointCases)('$relPath suppresses SQLite ExperimentalWarning while preserving expected stdout/stderr', item => {
    const res = spawnSync(
      process.execPath,
      ['--trace-warnings', join(repoRoot, item.relPath), ...item.args],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    expect(res.error).toBeUndefined()
    expect(res.status, `stderr=${res.stderr}`).toBe(item.expectedStatus)
    expect(res.stderr).not.toContain('ExperimentalWarning')
    expect(res.stderr).not.toContain('SQLite is an experimental feature')
    if (item.expectedStderr !== undefined) {
      if (item.expectedStderr === '') expect(res.stderr).toBe('')
      else expect(res.stderr).toContain(item.expectedStderr)
    }
    if (item.expectedStdout !== undefined) {
      expect(res.stdout).toContain(item.expectedStdout)
    }
  })

  test('local-source-cache-copy.mjs --snapshot-index suppresses SQLite warning when loading node:sqlite', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-sqlite-snapshot-warn-')))
    try {
      const srcDir = join(root, 'src')
      const dstDir = join(root, 'dst')
      mkdirSync(srcDir, { mode: 0o700 })
      mkdirSync(dstDir, { mode: 0o700 })
      const srcDb = join(srcDir, 'index.db')
      const dstDb = join(dstDir, 'copy.db')
      const db = new DatabaseSync(srcDb)
      try {
        db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES (\'a\')')
      } finally {
        db.close()
      }
      const res = spawnSync(
        process.execPath,
        [join(repoRoot, 'scripts/install/local-source-cache-copy.mjs'), '--snapshot-index', srcDb, dstDb],
        { cwd: root, encoding: 'utf8' },
      )
      expect(res.error).toBeUndefined()
      expect(res.status, res.stderr).toBe(0)
      expect(res.stderr).toBe('')
      expect(res.stderr).not.toContain('ExperimentalWarning')
      expect(res.stderr).not.toContain('SQLite is an experimental feature')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('non-SQLite --import warnings still emit on plugin CLI stderr when SQLite warning is filtered', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-plugin-warn-preserve-')))
    try {
      const preload = join(root, 'preload.mjs')
      writeFileSync(
        preload,
        "process.once('beforeExit', () => { process.emitWarning('Plugin custom exp', 'ExperimentalWarning'); process.emitWarning('Plugin dep', 'DeprecationWarning') })\n",
        'utf8',
      )
      const res = spawnSync(
        process.execPath,
        ['--import', `file://${preload}`, join(repoRoot, 'plugins/plugin-control-plane/bin/dsh-systemd-host-attestor.js'), '--version'],
        { cwd: repoRoot, encoding: 'utf8' },
      )
      expect(res.error).toBeUndefined()
      expect(res.status).toBe(0)
      expect(res.stdout.trim()).toBe('dsh-systemd-host-attestor-8')
      expect(res.stderr).not.toContain('SQLite is an experimental feature')
      expect(res.stderr).toContain('ExperimentalWarning: Plugin custom exp')
      expect(res.stderr).toContain('DeprecationWarning: Plugin dep')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
