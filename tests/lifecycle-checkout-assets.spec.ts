import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from 'vitest'

test('ordinary lifecycle loads from its published assets without checkout-only candidate helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-assets-'))
  try {
    for (const name of ['lifecycle-profile.mjs', 'lifecycle-config.mjs', 'host-lifecycle.mjs']) {
      await copyFile(resolve('scripts/install', name), join(root, name))
    }
    const moduleUrl = pathToFileURL(join(root, 'lifecycle-profile.mjs')).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const { lifecycleProfileTest } = await import(${JSON.stringify(moduleUrl)}); if (typeof lifecycleProfileTest.sandboxArgs !== 'function') process.exit(2);`],
    { encoding: 'utf8', timeout: 10000 })
    expect(result.error).toBeUndefined()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
