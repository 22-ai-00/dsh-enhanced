import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { describe, expect, test } from 'vitest'

describe('installer port preflight diagnostics', () => {
  test.each([['web', false], ['web', true], ['assistant-live', false]] as const)('occupied Web port only blocks the native Web template: %s, empty directory %s', async (profile, partial) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-profile-port-'))
    const server = createServer()
    try {
      if (partial) await mkdir(join(root,'profiles',profile),{recursive:true})
      await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no TCP address')
      const result = spawnSync('/bin/bash', [
        '-c', `source "$1"
dsh_enhanced_reject_incompatible_existing_dsh() { :; }
dsh_enhanced_ensure_dsh() { printf 'REACHED_HOST_PREPARATION\\n'; return 77; }
dsh_enhanced_install local "$2" --profile "$3" --scenario supervised --yes`,
        'profile-port-test', resolve('scripts/install/common.sh'), resolve('.'), profile,
      ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: root, DSH_ENHANCED_WEB_PORT: String(address.port) } })
      if (profile === 'web') {
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('EADDRINUSE')
        expect(result.stdout).not.toContain('REACHED_HOST_PREPARATION')
      } else {
        expect(result.status, result.stderr).toBe(77)
        expect(result.stdout).toContain('REACHED_HOST_PREPARATION')
        expect(result.stderr).not.toContain('EADDRINUSE')
      }
    } finally {
      await new Promise<void>(done => server.close(() => done()))
      await rm(root, { recursive: true, force: true })
    }
  })
  test.each([
    ['EADDRINUSE', '已被占用', '权限'],
    ['EPERM', '权限', '已被占用'],
    ['EACCES', '权限', '已被占用'],
    ['EADDRNOTAVAIL', '无法监听', '已被占用'],
  ])('reports %s without prescribing an unrelated repair', async (code, expected, absent) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-port-diagnostic-'))
    try {
      const preload = join(root, 'net-error.cjs')
      // Inject the OS error at the network boundary, retaining the real node
      // probe and shell error handling. No sandbox port permission is needed.
      await writeFile(preload, `
const { EventEmitter } = require('node:events');
require('node:net').createServer = () => {
  const server = new EventEmitter();
  server.listen = () => {
    process.nextTick(() => server.emit('error', Object.assign(new Error('listen ${code}'), { code: '${code}' })));
    return server;
  };
  return server;
};
`)
      const result = spawnSync('/bin/bash', [
        '-c', 'source "$1"; dsh_enhanced_check_web_port_available "$2"',
        'port-test', resolve('scripts/install/common.sh'), '43191',
      ], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, NODE_OPTIONS: `--require=${preload}` },
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(code)
      expect(result.stderr).toContain(expected)
      expect(result.stderr).not.toContain(absent)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
