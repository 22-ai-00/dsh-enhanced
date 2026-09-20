import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { requestSourceApproval, SourceApprovalClientError, validateSourceApprovalClientConfig,
  type SourceApprovalClientConfig, type SourceApprovalRequest } from '../src/source-approval-client.ts'

const roots: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const request: SourceApprovalRequest = { protocol: 'dsh-source-approval/v1', planId: 'source-plan-1',
  planDigest: 'a'.repeat(64), sourceReferenceDigest: 'b'.repeat(64) }

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, approvalId: 'source-approval-1', authority: 'owner', keyId: 'key-1',
    planId: request.planId, planDigest: request.planDigest, decision: 'approved', principal: 'owner-user',
    decidedAt: 1, expiresAt: 2, signature: 'c2lnbmF0dXJl', ...overrides })
}

async function fixture(body: string): Promise<{ config: SourceApprovalClientConfig; path: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-approval-client-')))
  roots.push(root)
  const node = join(root, 'node')
  await copyFile(await realpath(process.execPath), node); await chmod(node, 0o700)
  const path = join(root, 'authority.js')
  const source = `#!${node}\n${body}\n`
  await writeFile(path, source, { mode: 0o700 }); await chmod(path, 0o700)
  const config: SourceApprovalClientConfig = { executable: { path, sha256: digest(source) },
    interpreter: { path: node, sha256: digest(await readFile(node)) }, configPath: join(root, 'authority.json'), timeoutMs: 5_000 }
  return { config, path }
}

describe('source approval client', () => {
  test.runIf(process.platform === 'linux')('passes a bounded request to the descriptor-pinned authority and accepts its exact approval', async () => {
    const value = await fixture(`
      let source = '';
      process.stdin.setEncoding('utf8'); process.stdin.on('data', value => { source += value });
      process.stdin.on('end', () => {
        const request = JSON.parse(source);
        if (process.argv[1] !== '/proc/self/fd/3' || process.argv[2] !== '--config') process.exit(19);
        process.stdout.write(${JSON.stringify(receipt())});
      });`)
    await expect(requestSourceApproval(value.config, request)).resolves.toMatchObject({ decision: 'approved', planId: request.planId })
  })

  test.runIf(process.platform === 'linux')('rejects a receipt for another plan before it can reach the control plane', async () => {
    const value = await fixture(`process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${JSON.stringify(receipt({ planId: 'other-plan' }))}));`)
    await expect(requestSourceApproval(value.config, request)).rejects.toMatchObject({ code: 'FAILED' })
  })

  test.runIf(process.platform === 'linux')('classifies malformed authority output as a failed response, not executable drift', async () => {
    const value = await fixture("process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}'))")
    await expect(requestSourceApproval(value.config, request)).rejects.toMatchObject({ code: 'FAILED' })
  })

  test.runIf(process.platform === 'linux')('waits for controlled timeout cleanup and maps an overdue authority to TIMEOUT', async () => {
    const value = await fixture("process.stdin.resume(); setTimeout(() => process.stdout.write('{}'), 500)")
    value.config.timeoutMs = 20
    await expect(requestSourceApproval(value.config, request)).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  test.runIf(process.platform === 'linux')('suppresses a completed authority result when the owning flight was aborted', async () => {
    const value = await fixture(`process.stdin.resume(); setTimeout(() => process.stdout.write(${JSON.stringify(receipt())}), 100)`)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 10)
    await expect(requestSourceApproval(value.config, request, controller.signal)).rejects.toMatchObject({ code: 'ABORTED' })
  })

  test.runIf(process.platform === 'linux')('rejects a pathname whose contents changed while its pinned descriptor executed', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'source-approval-client-drift-')))
    roots.push(root)
    const node = join(root, 'node')
    await copyFile(await realpath(process.execPath), node); await chmod(node, 0o700)
    const path = join(root, 'authority.js')
    const replacement = `#!${node}\nprocess.stdout.write('{}')\n`
    const source = `#!${node}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(replacement)}, { mode: 0o700 }); process.stdout.write(${JSON.stringify(receipt())});\n`
    await writeFile(path, source, { mode: 0o700 }); await chmod(path, 0o700)
    const config: SourceApprovalClientConfig = { executable: { path, sha256: digest(source) },
      interpreter: { path: node, sha256: digest(await readFile(node)) }, configPath: join(root, 'authority.json'), timeoutMs: 5_000 }
    await expect(requestSourceApproval(config, request)).rejects.toMatchObject({ code: 'EXECUTABLE_CHANGED' })
  })

  test('rejects unknown configuration fields and canonical-text path drift before opening a helper', () => {
    expect(() => validateSourceApprovalClientConfig({ executable: { path: '/tmp/../authority', sha256: 'a'.repeat(64) },
      configPath: '/tmp/config.json', timeoutMs: 1, extra: true })).toThrow(SourceApprovalClientError)
    expect(() => validateSourceApprovalClientConfig({ executable: { path: '/tmp/authority', sha256: 'a'.repeat(64) },
      configPath: '/tmp/config\n.json', timeoutMs: 1 })).toThrow(SourceApprovalClientError)
  })
})
