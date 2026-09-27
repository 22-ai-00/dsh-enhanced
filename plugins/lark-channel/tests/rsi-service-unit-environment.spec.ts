import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { validateRsiServiceUnitEnvironment } from '../src/rsi-setup.js'

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), spawnSync: vi.fn(),
}))
const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('standing schema-4 checks the loaded unit environment before starting the Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-unit-environment-')); roots.push(root)
  const path = join(root, 'wrapper.json'), expected = 'DSH_HOME=/private/home DSH_RELEASE_PR_CONFIG=/private/pr.json'
  await writeFile(path, JSON.stringify({ schemaVersion: 4, template: { unitProperties: { Environment: expected } } }), { mode: 0o600 })
  const readback = (stdout: string, status = 0) => vi.mocked(spawnSync).mockReturnValue({ stdout, status } as SpawnSyncReturns<string>)
  const validate = () => validateRsiServiceUnitEnvironment({ targetProfile: 'owner' }, { DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: path })
  readback(`${expected}\n`)
  await expect(validate()).resolves.toBeUndefined()
  expect(spawnSync).toHaveBeenCalledWith('systemctl', ['--user', 'show', 'dsh-profile-owner.service', '--property=Environment', '--value'], expect.any(Object))
  readback('DSH_HOME=/another/home\n')
  await expect(validate()).rejects.toThrow('effective service environment differs')
  readback(`${expected}\n`, 1)
  await expect(validate()).rejects.toThrow('effective service environment differs')
})
