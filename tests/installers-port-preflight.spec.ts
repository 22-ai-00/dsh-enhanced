import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'

describe('installer port preflight diagnostics', () => {
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
