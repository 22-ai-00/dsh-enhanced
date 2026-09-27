import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  readRsiServiceEnvironment, rsiServiceEnvironmentPath, validateRsiServiceEnvironment,
} from '../src/rsi-service-environment.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-rsi-service-env-')); roots.push(root)
  const home = join(root, '.dsh')
  await mkdir(home, { mode: 0o755 })
  await mkdir(join(home, 'rsi-service-environments'), { mode: 0o700 })
  const config = join(root, 'host private config %.json')
  await writeFile(config, '{}', { mode: 0o600 })
  const binding = rsiServiceEnvironmentPath(home, 'web')
  const writeBinding = async (environment: Record<string, string>) => writeFile(binding, JSON.stringify({
    schemaVersion: 1, dshHome: home, profile: 'web', environment,
  }), { mode: 0o600 })
  return { root, home, config, binding, writeBinding }
}

describe('RSI systemd service environment binding', () => {
  test('missing binding keeps the legacy service environment, while a valid binding reads sorted paths', async () => {
    const value = await fixture()
    expect(await readRsiServiceEnvironment(value.home, 'web')).toBeUndefined()
    await value.writeBinding({
      DSH_RELEASE_REVIEW_CONFIG: value.config,
      DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: value.config,
    })
    expect(await readRsiServiceEnvironment(value.home, 'web')).toEqual({
      DSH_RELEASE_REVIEW_CONFIG: value.config,
      DSH_SYSTEMD_HOST_ATTESTOR_CONFIG: value.config,
    })
    expect(Object.keys((await readRsiServiceEnvironment(value.home, 'web'))!)).toEqual([
      'DSH_RELEASE_REVIEW_CONFIG', 'DSH_SYSTEMD_HOST_ATTESTOR_CONFIG',
    ])
    expect(await readFile(value.binding, 'utf8')).not.toContain('SECRET')
  })

  test('rejects unknown names and noncanonical, candidate writable, missing, and public files', async () => {
    const value = await fixture()
    await expect(validateRsiServiceEnvironment({ PATH: value.config }, value.home, 'web')).rejects.toThrow('unsupported environment name')
    for (const path of ['relative.json', join(value.root, '.', 'missing.json'), `${value.root}/../outside.json`]) {
      await expect(validateRsiServiceEnvironment({ DSH_RELEASE_PR_CONFIG: path }, value.home, 'web')).rejects.toThrow()
    }
    const candidate = join(value.home, 'profiles', 'web', 'config.json')
    await mkdir(join(value.home, 'profiles', 'web'), { recursive: true })
    await writeFile(candidate, '{}', { mode: 0o600 })
    await expect(validateRsiServiceEnvironment({ DSH_RELEASE_PR_CONFIG: candidate }, value.home, 'web'))
      .rejects.toThrow('inside profiles')
    await chmod(value.config, 0o644)
    await expect(validateRsiServiceEnvironment({ DSH_RELEASE_PR_CONFIG: value.config }, value.home, 'web'))
      .rejects.toThrow('unsafe file')
    await chmod(value.config, 0o600)
    await link(value.config, join(value.root, 'second-link.json'))
    await expect(validateRsiServiceEnvironment({ DSH_RELEASE_PR_CONFIG: value.config }, value.home, 'web'))
      .rejects.toThrow('unsafe file')
  })

  test('an existing malformed or public binding hard fails', async () => {
    const value = await fixture()
    await writeFile(value.binding, '{', { mode: 0o600 })
    await expect(readRsiServiceEnvironment(value.home, 'web')).rejects.toThrow('invalid environment JSON')
    await value.writeBinding({ DSH_RELEASE_PR_CONFIG: value.config })
    await chmod(value.binding, 0o644)
    await expect(readRsiServiceEnvironment(value.home, 'web')).rejects.toThrow('unsafe file')
    await chmod(value.binding, 0o600)
    await chmod(join(value.home, 'rsi-service-environments'), 0o755)
    await expect(readRsiServiceEnvironment(value.home, 'web')).rejects.toThrow('unsafe directory')
  })
})
