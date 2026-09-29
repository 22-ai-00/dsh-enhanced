import { chmod, cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { prepareRsiLocalCohort, readRsiLocalCohort, verifyRsiLocalInstalledPackages, rsiLocalPeerOverrides, type RsiLocalCohortPorts } from '../src/rsi-local-cohort.js'
import { localCohortFixture, installFixture } from './fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() { const value = await localCohortFixture(); roots.push(value.root); return value }

describe('frozen local tarball cohort', () => {
  test('builds exact committed runtime closure; replay checks receipt without rebuilding', async () => {
    const f = await fixture()
    await writeFile(join(f.sourceRepository, 'plugins', 'target', 'lib', 'index.js'), 'dirty original checkout\n')
    const input = { dshHome: f.home, profile: f.profile, source: f.source, bundles: ['target'] }
    const cohort = await prepareRsiLocalCohort(input, f.ports)
    expect(cohort.sourceCommit).toBe(f.source.sourceCommit)
    expect(cohort.allowBuilds).toEqual({ esbuild: true, koffi: true, protobufjs: false })
    expect(cohort.packages.map(item => item.name)).toEqual([
      '@dsh-enhanced/assistant-automations', '@dsh-enhanced/assistant-policy', '@dsh-enhanced/optional-plugin',
      '@dsh-enhanced/plugin-control-plane', '@dsh-enhanced/shared-lib', '@dsh-enhanced/target'])
    expect(cohort.packages.find(item => item.name === '@dsh-enhanced/target')?.runtimeDependencies)
      .toEqual(['@dsh-enhanced/optional-plugin', '@dsh-enhanced/shared-lib'])
    expect(cohort.packages.find(item => item.name === '@dsh-enhanced/target')?.files.some(item => item.path === 'lib/index.js')).toBe(true)
    expect(cohort.packages.find(item => item.name === '@dsh-enhanced/target')?.files.map(item => item.path))
      .toEqual(['LICENSE', 'README.md', 'cordis.patch.yml', 'lib/index.js', 'package.json'])
    const installed = await installFixture(f, cohort)
    expect(await readFile(join(installed, 'node_modules', '@dsh-enhanced', 'target', 'lib', 'index.js'), 'utf8'))
      .toBe("export const identity = 'target-committed'\n")
    await verifyRsiLocalInstalledPackages({ cohort, profilePath: installed })
    await chmod(join(installed, 'node_modules', '@dsh-enhanced', 'target', 'README.md'), 0o600)
    await verifyRsiLocalInstalledPackages({ cohort, profilePath: installed })
    const targetOnly = await installFixture(f, cohort, ['target', 'shared-lib', 'optional-plugin'], 'target-only')
    const nested = join(targetOnly, 'node_modules', '@dsh-enhanced', 'target', 'node_modules', '@dsh-enhanced')
    await mkdir(nested, { recursive: true })
    for (const slug of ['shared-lib', 'optional-plugin']) {
      await rename(join(targetOnly, 'node_modules', '@dsh-enhanced', slug), join(nested, slug))
    }
    await verifyRsiLocalInstalledPackages({ cohort, profilePath: targetOnly })
    const coordinatorOnly = await installFixture(f, cohort, ['assistant-policy', 'assistant-automations', 'plugin-control-plane'], 'coordinator-only')
    await verifyRsiLocalInstalledPackages({ cohort, profilePath: coordinatorOnly,
      bundles: ['assistant-policy', 'assistant-automations', 'plugin-control-plane'] })
    expect(await prepareRsiLocalCohort(input, f.ports)).toEqual(cohort)
    expect(f.builds).toBe(1)
    expect(await readRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source })).toEqual(cohort)
  })

  test('rejects changed bundle set, tarball, receipt, installed file and escape', async () => {
    const f = await fixture(), input = { dshHome: f.home, profile: f.profile, source: f.source, bundles: ['target'] }
    const cohort = await prepareRsiLocalCohort(input, f.ports)
    await expect(prepareRsiLocalCohort({ ...input, bundles: [] }, f.ports)).rejects.toThrow('bundle selection differs')
    const installed = await installFixture(f, cohort)
    const code = join(installed, 'node_modules', '@dsh-enhanced', 'target', 'lib', 'index.js')
    await writeFile(code, 'altered\n')
    await expect(verifyRsiLocalInstalledPackages({ cohort, profilePath: installed })).rejects.toThrow('installed package file differs')
    await rm(code)
    await symlink(join(f.root, 'outside.js'), code)
    await writeFile(join(f.root, 'outside.js'), "export const identity = 'target-committed'\n")
    await expect(verifyRsiLocalInstalledPackages({ cohort, profilePath: installed })).rejects.toThrow('installed package file escapes')
    await rm(code)
    await writeFile(code, "export const identity = 'target-committed'\n")
    const tarball = cohort.packages[0]!.tarball, original = await readFile(tarball)
    await writeFile(tarball, Buffer.concat([original, Buffer.from('x')]))
    await expect(readRsiLocalCohort({ dshHome: f.home, profile: f.profile })).rejects.toThrow('cohort tarball differs')
    await writeFile(tarball, original)
    const receipt = join(cohort.root, 'receipt.json'), receiptBytes = await readFile(receipt, 'utf8')
    await writeFile(receipt, receiptBytes.replace('0.1.48', '0.1.49'))
    await expect(readRsiLocalCohort({ dshHome: f.home, profile: f.profile })).rejects.toThrow('cohort receipt digest differs')
  })

  test('rejects a build that mutates a tracked source manifest', async () => {
    const f = await fixture()
    const ports: RsiLocalCohortPorts = { build: async (workspace, output, paths, signal) => {
      await f.ports.build(workspace, output, paths, signal)
      const path = join(workspace, 'plugins', 'target', 'package.json')
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
      value.description = 'changed by build'
      await writeFile(path, JSON.stringify(value, null, 2) + '\n')
    } }
    await expect(prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source,
      bundles: ['target'] }, ports)).rejects.toThrow('tracked build input changed')
    await expect(readRsiLocalCohort({ dshHome: f.home, profile: f.profile })).rejects.toThrow()
  })
})


describe('frozen internal peers', () => {
  test('derives peers from schema 1 tarballs within the selected runtime closure only', async () => {
    const f = await localCohortFixture(true); roots.push(f.root)
    const cohort = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source, bundles: ['target'] }, f.ports)
    const before = await readFile(join(cohort.root, 'receipt.json'), 'utf8')
    const provider = cohort.packages.find(item => item.name === '@dsh-enhanced/shared-lib')!
    expect(await rsiLocalPeerOverrides({ cohort, bundles: ['target'] })).toEqual({
      '@dsh-enhanced/target@0.1.48>@dsh-enhanced/shared-lib': `file:${provider.tarball}`,
      '@dsh-enhanced/optional-plugin@0.1.48>@dsh-enhanced/shared-lib': `file:${provider.tarball}`,
    })
    const policy = cohort.packages.find(item => item.name === '@dsh-enhanced/assistant-policy')!
    expect(await rsiLocalPeerOverrides({ cohort, bundles: ['assistant-policy', 'assistant-automations', 'plugin-control-plane'] })).toEqual({
      '@dsh-enhanced/assistant-automations@0.1.48>@dsh-enhanced/assistant-policy': `file:${policy.tarball}`,
    })
    expect(await readFile(join(cohort.root, 'receipt.json'), 'utf8')).toBe(before)
    const installed = await installFixture(f, cohort, ['target', 'shared-lib', 'optional-plugin'])
    expect(await rsiLocalPeerOverrides({ cohort, bundles: ['target'], profilePath: installed }))
      .toEqual(await rsiLocalPeerOverrides({ cohort, bundles: ['target'] }))
    await verifyRsiLocalInstalledPackages({ cohort, profilePath: installed })
  })

  test.each([false, true])('rejects a duplicate peer provider even at the same version (changed bytes: %s)', async changed => {
    const f = await localCohortFixture(true); roots.push(f.root)
    const cohort = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile, source: f.source,
      bundles: ['target'] }, f.ports)
    // target and optional-plugin reach shared-lib through two distinct consumers.
    const installed = await installFixture(f, cohort, ['target', 'shared-lib', 'optional-plugin'])
    const nested = join(installed, 'node_modules', '@dsh-enhanced', 'target', 'node_modules', '@dsh-enhanced', 'shared-lib')
    await mkdir(join(nested, '..'), { recursive: true })
    await cp(join(installed, 'node_modules', '@dsh-enhanced', 'shared-lib'), nested, { recursive: true })
    if (changed) await writeFile(join(nested, 'lib', 'index.js'), 'registry same-version bytes\n')
    await expect(verifyRsiLocalInstalledPackages({ cohort, profilePath: installed }))
      .rejects.toThrow(changed ? /file differs|identity split/u : /identity split/u)
  })
})
