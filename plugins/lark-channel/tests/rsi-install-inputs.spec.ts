import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'

import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.ts'
import { collectRsiInstalledInputs, resolveInstalledRsiDsh, RsiInstalledInputsUnavailableError } from '../src/rsi-install-inputs.ts'
import type { RsiSourceWorkspace } from '../src/rsi-source.ts'

const require = createRequire(import.meta.url)
const loaderRequire = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include/package.json'))
const loaderYaml = loaderRequire('js-yaml') as { load(source: string, options: { schema: unknown }): unknown }

async function file(path: string, value: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, { mode })
  await chmod(path, mode)
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-install-inputs-')))
  const home = join(root, 'home'), profile = join(home, 'profiles', 'target')
  await mkdir(profile, { recursive: true })
  const dsh = join(root, 'dsh'), bin = join(root, 'bin')
  await mkdir(bin)
  await file(join(dsh, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.3', bin: { dsh: 'lib/bin.js' } }))
  await file(join(dsh, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 0o700)
  await symlink(join(dsh, 'lib', 'bin.js'), join(bin, 'dsh'))
  for (const entry of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) await file(join(profile, entry), `fixture ${entry}\n`)
  const plugin = 'assistant-health', packageRoot = join(profile, 'node_modules', '@dsh-enhanced', plugin)
  await file(join(packageRoot, 'package.json'), JSON.stringify({ name: `@dsh-enhanced/${plugin}`, version: '0.1.48',
    main: './lib/entry.js', exports: { '.': { default: './lib/entry.js' } }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  await file(join(packageRoot, 'cordis.patch.yml'), `- insert:\n    - id: dsh-enhanced-${plugin}\n      name: '@dsh-enhanced/${plugin}'\n`)
  await file(join(packageRoot, 'lib', 'entry.js'), 'export default {}\n')
  const resources = await prepareRsiAuthorityResources({ dshHome: home, profile: 'target' })
  const source = { schemaVersion: 1, version: '0.1.48', baseline: { targetBranch: 'repairs' } } as RsiSourceWorkspace
  const effective = `- id: dsh-enhanced-assistant-delivery\n  name: '@dsh-enhanced/assistant-delivery'\n  config:\n    defaultWorkspace: !!js dshHomePath('assistant-workspace')\n    enabled: true\n- id: dsh-enhanced-lark-channel\n  name: '@dsh-enhanced/lark-channel'\n  config:\n    credentialHandle: !!js dshHomePath('lark/credential')\n    enabled: true\n- id: dsh-enhanced-assistant-health\n  name: '@dsh-enhanced/assistant-health'\n  config: {}\n`
  const environment = { PATH: `${bin}:/usr/bin:/bin` }
  return { root, home, profile, dsh, bin, plugin, resources, source, effective, environment,
    cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('installed owner setup input capture', () => {
  test('reports local development links as unavailable before deployment authority is prepared', async () => {
    const data = await fixture()
    try {
      const linked = join(data.profile, 'node_modules', '@dsh-enhanced', data.plugin)
      const checkout = join(data.root, 'checkout-package')
      await rename(linked, checkout)
      await symlink(checkout, linked)
      await expect(collectRsiInstalledInputs({ dshHome: data.home, targetProfile: 'target', targetEffective: data.effective,
        resources: data.resources, source: data.source, environment: data.environment }))
        .rejects.toBeInstanceOf(RsiInstalledInputsUnavailableError)
    } finally { await data.cleanup() }
  })
  test('captures real installed entry, Host files, pins and exact Include raw !!js digests', async () => {
    const data = await fixture()
    try {
      const result = await collectRsiInstalledInputs({ dshHome: data.home, targetProfile: 'target', targetEffective: data.effective,
        resources: data.resources, source: data.source, environment: data.environment })
      const installed = await resolveInstalledRsiDsh(data.environment)
      expect(result.dsh).toEqual(installed)
      expect(result.plugins).toEqual(['assistant-health'])
      expect(result.hostDeploymentInputs).toEqual(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml',
        'node_modules/@dsh-enhanced/assistant-health/package.json',
        'node_modules/@dsh-enhanced/assistant-health/cordis.patch.yml',
        'node_modules/@dsh-enhanced/assistant-health/lib/entry.js'])
      const loader = loaderYaml.load(data.effective, { schema: entryListSchema }) as Array<{ id: string; config: unknown }>
      for (const target of result.observerTargets) {
        const raw = loader.find(row => row.id === target.entryId)!.config
        expect(target.configDigest).toBe(runtimeConfigDigest(raw))
      }
      expect(result.observerTargets.map(target => target.services)).toEqual([['assistantDelivery'], ['larkChannel']])
      expect(result.executor).toMatchObject({ id: '@deepseek-ai/dsh', version: '0.1.5-rc.3', path: join(data.dsh, 'lib', 'bin.js') })
      expect(result.systemctl.interpreter).toBeNull()
      expect(result.policies).toMatchObject([{ candidateId: 'assistant-health', dshBaseline: '0.1.5-rc.3',
        capabilities: ['owner-installed'], authorities: ['owner-installed'], requires: [] }])
      expect(await readFile(result.dsh.path, 'utf8')).toContain('node')
    } finally { await data.cleanup() }
  })

  test('rejects mismatched installed entry, escaped package file, disabled ingress and unsupported tags', async () => {
    const data = await fixture()
    try {
      const request = { dshHome: data.home, targetProfile: 'target', targetEffective: data.effective,
        resources: data.resources, source: data.source, environment: data.environment }
      const packagePath = join(data.profile, 'node_modules', '@dsh-enhanced', data.plugin, 'package.json')
      await file(packagePath, JSON.stringify({ name: '@dsh-enhanced/other', version: '0.1.48', main: './lib/entry.js',
        exports: { '.': { default: './lib/entry.js' } }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await expect(collectRsiInstalledInputs(request)).rejects.toThrow('installed package identity')
      await file(packagePath, JSON.stringify({ name: '@dsh-enhanced/assistant-health', version: '0.1.48', main: './lib/../escape.js',
        exports: { '.': { default: './lib/../escape.js' } }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await expect(collectRsiInstalledInputs(request)).rejects.toThrow('package-local lib JS')
      await file(packagePath, JSON.stringify({ name: '@dsh-enhanced/assistant-health', version: '0.1.48', main: './lib/entry.js',
        exports: { '.': { default: './lib/entry.js' } }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
      await file(join(data.profile, 'node_modules', '@dsh-enhanced', data.plugin, 'cordis.patch.yml'),
        "- insert:\n    - id: dsh-enhanced-assistant-health\n      name: '@dsh-enhanced/other'\n")
      await expect(collectRsiInstalledInputs(request)).rejects.toThrow('package patch mounts the wrong package')
      await file(join(data.profile, 'node_modules', '@dsh-enhanced', data.plugin, 'cordis.patch.yml'),
        "- insert:\n    - id: dsh-enhanced-assistant-health\n      name: '@dsh-enhanced/assistant-health'\n")
      const mainPath = join(data.profile, 'node_modules', '@dsh-enhanced', data.plugin, 'lib', 'entry.js')
      await rm(mainPath)
      await symlink(join(data.dsh, 'lib', 'bin.js'), mainPath)
      await expect(collectRsiInstalledInputs(request)).rejects.toThrow('escapes installed root')
      await expect(collectRsiInstalledInputs({ ...request, targetEffective: data.effective.replace("name: '@dsh-enhanced/lark-channel'", "name: '@dsh-enhanced/lark-channel'\n  disabled: true") })).rejects.toThrow('required dsh-enhanced-lark-channel is unavailable')
      await expect(collectRsiInstalledInputs({ ...request, targetEffective: data.effective.replace('    enabled: true\n- id: dsh-enhanced-assistant-health', '    enabled: false\n- id: dsh-enhanced-assistant-health') })).rejects.toThrow('installed Lark channel is not enabled')
      await expect(collectRsiInstalledInputs({ ...request, targetEffective: data.effective.replace("name: '@dsh-enhanced/assistant-health'", "name: '@dsh-enhanced/assistant-health'\n  disabled: true") })).rejects.toThrow('scope is empty')
      await expect(collectRsiInstalledInputs({ ...request, targetEffective: data.effective.replace("!!js dshHomePath('assistant-workspace')", '!unsafe payload') })).rejects.toThrow('unsupported YAML tag')
    } finally { await data.cleanup() }
  })
})
