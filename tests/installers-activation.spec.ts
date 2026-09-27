import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, test } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const common = join(repoRoot, 'scripts', 'install', 'common.sh')
const cordis = pathToFileURL(join(repoRoot, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-installer-activation-'))
  roots.push(root)
  const home = join(root, 'home')
  const fakeBin = join(root, 'bin')
  const log = join(root, 'fake-dsh.log')
  await mkdir(join(home, 'profiles', 'custom'), { recursive: true })
  await mkdir(fakeBin)
  await writeFile(join(home, 'profiles', 'custom', 'cordis.patch.yml'), '[]\n')
  const fakeDsh = join(fakeBin, 'dsh')
  await writeFile(fakeDsh, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from ${JSON.stringify(cordis)}
const log = ${JSON.stringify(log)}
const record = value => appendFileSync(log, value + '\\n')
const args = process.argv.slice(2)
const required = ['--profile', 'custom', '--host', '127.0.0.1', '--no-open', '--port', '0']
for (let index = 0; index < required.length; index++) {
  if (!args.includes(required[index])) throw new Error('missing required DSH argument: ' + required[index])
}
const patchIndex = args.indexOf('--patch')
if (patchIndex < 0) throw new Error('missing readiness overlay')
const overlayPath = args[patchIndex + 1]
const rows = JSON.parse(readFileSync(overlayPath, 'utf8'))
if (rows.length !== 1 || rows[0].insert?.length !== 1
  || rows[0].insert[0].id !== 'dsh-enhanced-installer-readiness') throw new Error('invalid readiness overlay')
const modulePath = rows[0].insert[0].name
if (typeof modulePath !== 'string' || !modulePath.startsWith('/')) throw new Error('readiness module is not absolute')
if (dirname(modulePath) !== dirname(overlayPath)) throw new Error('readiness module escaped probe directory')
const plugin = (await import(pathToFileURL(modulePath).href)).default
if (plugin.name !== 'dsh-enhanced-installer-readiness' || JSON.stringify(plugin.inject) !== JSON.stringify(['appReady'])) {
  throw new Error('invalid mounted readiness plugin')
}
record('loaded:' + basename(dirname(modulePath)))
const ctx = new Context()
const listeners = new Set()
ctx.provide('appReady', { onReady(listener) {
  listeners.add(listener)
  record('listener-registered')
  return () => { listeners.delete(listener); record('listener-disposed') }
} })
const fiber = await ctx.plugin(plugin)
await fiber
record('fiber-active')
const mode = process.env.ACTIVATION_TEST_MODE
if (mode === 'failure') {
  await fiber.dispose()
  record('listeners-after-dispose:' + listeners.size)
  record('plugin-failed-before-ready')
  process.exit(7)
}
if (mode === 'no-ready') {
  await fiber.dispose()
  record('listeners-after-dispose:' + listeners.size)
  record('no-ready-exit')
  process.exit(8)
}
process.on('SIGINT', async () => {
  await fiber.dispose()
  record('listeners-after-dispose:' + listeners.size)
  record('fiber-disposed')
  process.exit(0)
})
for (const listener of [...listeners]) { listener(); record('ready-callback-invoked') }
setInterval(() => {}, 1000)
`, { mode: 0o755 })
  await chmod(fakeDsh, 0o755)
  return { root, home, fakeBin, log }
}

function runProbe(f: Awaited<ReturnType<typeof fixture>>, mode: string, profile = 'custom') {
  return spawnSync('/bin/bash', ['-c', 'source "$ACTIVATION_COMMON"; dsh_enhanced_verify_profile_activation "$ACTIVATION_PROFILE" "$DSH_HOME" 0'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 12_000,
    env: {
      ...process.env,
      PATH: `${f.fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      TMPDIR: f.root,
      DSH_HOME: f.home,
      ACTIVATION_COMMON: common,
      ACTIVATION_PROFILE: profile,
      ACTIVATION_TEST_MODE: mode,
    },
  })
}

async function expectProbeCleaned(root: string) {
  expect((await readdir(root)).filter(name => name.startsWith('dsh-enhanced-activation.'))).toEqual([])
}

describe('custom profile activation through the installer readiness overlay', () => {
  test('real pinned Cordis mount receives appReady without a Web line, then disposes the listener', async () => {
    const f = await fixture()
    const result = runProbe(f, 'ready')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('profile 运行时自检通过')
    expect(result.stdout).not.toContain('dsh web:')
    const events = (await readFile(f.log, 'utf8')).trim().split('\n')
    expect(events).toEqual([
      expect.stringMatching(/^loaded:dsh-enhanced-activation\./u),
      'listener-registered', 'fiber-active', 'ready-callback-invoked', 'listener-disposed',
      'listeners-after-dispose:0', 'fiber-disposed',
    ])
    await expectProbeCleaned(f.root)
  }, 15_000)

  test.each(['no-ready', 'failure'])('%s exits before readiness and cannot pass activation', async mode => {
    const f = await fixture()
    const result = runProbe(f, mode)
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('profile 运行时自检失败')
    expect(result.stdout).not.toContain('profile 运行时自检通过')
    const events = await readFile(f.log, 'utf8')
    expect(events).toContain('listener-registered')
    expect(events).toContain('listener-disposed')
    expect(events).toContain('listeners-after-dispose:0')
    expect(events).not.toContain('ready-callback-invoked')
    await expectProbeCleaned(f.root)
  }, 15_000)

  test.each(['dsh web: http://127.0.0.1:43210/probe', 'dsh-enhanced host ready: v1'])('the Web-named profile accepts native readiness without a custom overlay: %s', async marker => {
    const f = await fixture()
    await mkdir(join(f.home, 'profiles', 'web'))
    await writeFile(join(f.home, 'profiles', 'web', 'cordis.patch.yml'), '[]\n')
    const webDsh = join(f.fakeBin, 'dsh')
    await writeFile(webDsh, `#!/bin/bash
printf '%s\\n' "$@" > ${JSON.stringify(f.log)}
printf '%s\\n' '${marker}'${marker.startsWith('dsh web:') ? '' : ' >&2'}
`, { mode: 0o755 })
    await chmod(webDsh, 0o755)
    const result = runProbe(f, 'web', 'web')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('profile 运行时自检通过')
    if (marker.startsWith('dsh web:')) expect(result.stdout).toContain('DSH 已打印带 token 的 Web URL')
    else expect(result.stdout).not.toContain('Web URL')
    expect(await readFile(f.log, 'utf8')).not.toContain('--patch')
    await expectProbeCleaned(f.root)
  }, 15_000)
})
