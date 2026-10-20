import { expect, test, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProgramUpgrade } from '../scripts/install/upgrade-program.mjs'

test('program entry accepts only its exact pending manifest up to 8 MiB', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-program-pending-test-')))
  const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  const home = join(root, 'home')
  const transactionPath = `${home}.dsh-enhanced-transaction`
  const manifestPath = join(transactionPath, 'manifest.json')
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    await mkdir(home, { mode: 0o700 })
    await mkdir(transactionPath, { mode: 0o700 })
    await writeFile(join(home, '.dsh-rsi-host.json'), '{}', { mode: 0o600 })
    const base = { version: 4, operation: 'host-update', homePath: home, profile: 'owner', transactionPath,
      hostMigration: { localSource: { protocol: 'dsh-enhanced/host-owner-program-update/v1',
        installer: { root: repository } } } }
    const large = { ...base, padding: 'x'.repeat(2 * 1024 * 1024) }
    await writeFile(manifestPath, JSON.stringify(large), { mode: 0o600 })
    const options = { home, profile: 'owner', selector: 'latest', dryRun: true, recover: false }
    expect(await runProgramUpgrade(options)).toBe(0)
    const exactLimit = 8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify({ ...base, padding: '' }))
    await writeFile(manifestPath, JSON.stringify({ ...base, padding: 'x'.repeat(exactLimit) }))
    expect(await runProgramUpgrade(options)).toBe(0)
    for (const changed of [
      { ...large, operation: 'upgrade' },
      { ...large, hostMigration: { localSource: { protocol: 'unknown', installer: { root: repository } } } },
      { ...large, hostMigration: { localSource: { protocol: 'dsh-enhanced/host-owner-program-update/v1',
        installer: { root: '/foreign' } } } },
    ]) {
      await writeFile(manifestPath, JSON.stringify(changed))
      await expect(runProgramUpgrade(options)).rejects.toThrow('belongs to another reviewed installer or operation')
    }
    await writeFile(manifestPath, JSON.stringify({ ...base, padding: 'x'.repeat(8 * 1024 * 1024) }))
    await expect(runProgramUpgrade(options)).rejects.toThrow('unsafe metadata')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    output.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
