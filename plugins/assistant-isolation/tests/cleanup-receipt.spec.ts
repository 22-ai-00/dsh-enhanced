import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { cleanupIsolationResources, receiptData } from '../src/cleanup-receipt.ts'

const roots: string[] = []
const name = 'dsh-isolation-12345678-1234-1234-1234-123456789abc'
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fake(mode: string): Promise<{ bin: string, log: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cleanup-receipt-')); roots.push(root)
  const bin = join(root, 'docker'); const log = join(root, 'calls')
  const body = `const fs=require('fs'),cp=require('child_process'),a=process.argv.slice(2),i=a.includes('inspect'),t=a.at(-1),mode=${JSON.stringify(mode)};fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(mode==='hang'){setInterval(()=>{},1000)}else if(mode==='kill'){process.kill(process.pid,'SIGKILL')}else{if(mode==='delayed-stderr'&&i){cp.spawn(process.execPath,['-e',${JSON.stringify("setTimeout(() => process.stderr.write('No such container\\n'), 50)")}],{stdio:['ignore','ignore','inherit']});process.exit(1)}if(mode==='overflow'){process.stderr.write('x'.repeat(5000));process.exit(1)}if(i&&mode==='present'&&t===${JSON.stringify(name)})process.exit(0);if(i&&mode==='bad'){process.stderr.write('permission denied');process.exit(1)}if(i){process.stderr.write('No such container');process.exit(1)}process.exit(0)}`
  await writeFile(bin, `#!/usr/bin/env node\n${body}`, { mode: 0o700 }); await chmod(bin, 0o700)
  return { bin, log }
}
async function targets(log: string): Promise<string[]> { try { return (await readFile(log, 'utf8')).trim().split('\n').map(x => (JSON.parse(x) as string[]).at(-1) ?? '') } catch { return [] } }

describe('cleanup receipts', () => {
  test('requires close/drain and mints opaque data only after every absence check', async () => {
    const { bin } = await fake('ok'); const receipt = await cleanupIsolationResources(bin, name)
    expect(receiptData(receipt)?.resources).toHaveLength(3)
    expect(receiptData({ ...(receipt as object) })).toBeUndefined()
  })
  test('rejects overflow and non-absence errors', async () => {
    expect(await cleanupIsolationResources((await fake('overflow')).bin, name)).toBeUndefined()
    expect(await cleanupIsolationResources((await fake('bad')).bin, name)).toBeUndefined()
  })
  test('rejects a CLI killed by SIGKILL', async () => {
    expect(await cleanupIsolationResources((await fake('kill')).bin, name)).toBeUndefined()
  })
  test('waits for a descendant which keeps stderr open after the CLI exits', async () => {
    const { bin } = await fake('delayed-stderr')
    const started = Date.now()
    expect(receiptData(await cleanupIsolationResources(bin, name))?.resources).toHaveLength(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(45)
  })
  test('rejects an inspect which says worker remains and still attempts remaining resources', async () => {
    const { bin, log } = await fake('present')
    expect(await cleanupIsolationResources(bin, name)).toBeUndefined()
    expect(await targets(log)).toEqual(expect.arrayContaining([`${name}-keeper`, `${name}-workspace`]))
  })
  test('rejects abort and timeout', async () => {
    const controller = new AbortController(); const hanging = await fake('hang')
    const pending = cleanupIsolationResources(hanging.bin, name, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10).unref(); expect(await pending).toBeUndefined()
    const already = new AbortController(); already.abort()
    expect(await cleanupIsolationResources((await fake('ok')).bin, name, { signal: already.signal })).toBeUndefined()
  })
  test('rejects a command that reaches the cleanup timeout', async () => {
    const hanging = await fake('hang')
    await expect(cleanupIsolationResources(hanging.bin, name)).resolves.toBeUndefined()
  }, 40_000)
})
