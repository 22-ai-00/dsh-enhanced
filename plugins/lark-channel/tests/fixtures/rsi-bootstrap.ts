import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import { runtimeConfigDigest, type SourceReleaseAuthorityConfig } from '@dsh-enhanced/plugin-control-plane'
import type { ActiveLarkOwnerBinding } from '@dsh-enhanced/assistant-delivery'

import { prepareRsiAuthorityResources } from '../../src/rsi-authority-resources.js'
import { prepareRsiAuthorityRuntime } from '../../src/rsi-authority-runtime.js'
import { createRsiBootstrapManifest } from '../../src/rsi-bootstrap-manifest.js'
import type { RsiAuthorityConfigInput } from '../../src/rsi-authority-config.js'
import { prepareRsiSourceWorkspace } from '../../src/rsi-source.js'

const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
function git(args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 30_000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  if (result.status !== 0 || result.error) throw new Error(`fixture Git failed: ${result.stderr}`)
  return result.stdout.trim()
}
async function privateDirectory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700) }
async function file(path: string, value: string): Promise<void> { await privateDirectory(dirname(path)); await writeFile(path, value, { mode: 0o600 }) }

/** Real signing keys, copied authority programs, local source Git, and pinned
 * tools. The Docker image and executor are private test stand-ins: this fixture
 * proves configuration and Host preflight, not a live source build or adoption. */
export async function rsiBootstrapFixture(): Promise<{
  input: RsiAuthorityConfigInput
  binding: ActiveLarkOwnerBinding
  profiles: { targetPatch: string; targetEffective: string; coordinatorPatch: string; coordinatorEffective: string; coordinatorBase: string }
  root: string
  cleanup(): Promise<void>
}> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-bootstrap-')))
  const home = join(root, 'home'), profile = 'target', coordinator = 'coordinator'
  try {
    await privateDirectory(home)
    const targetPath = join(home, 'profiles', profile), coordinatorPath = join(home, 'profiles', coordinator)
    await privateDirectory(targetPath); await privateDirectory(coordinatorPath)
    const workspace = join(home, 'assistant-workspace')
    await privateDirectory(workspace)
    const version = (JSON.parse(await readFile(new URL('../../../../package.json', import.meta.url), 'utf8')) as { version: string }).version
    const local = join(root, 'source')
    await privateDirectory(local)
    git(['init', '--quiet', '--initial-branch=main', local])
    await file(join(local, 'package.json'), JSON.stringify({ name: 'dsh-enhanced', version }))
    git(['-C', local, 'add', 'package.json'])
    git(['-C', local, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@dsh.invalid', 'commit', '--quiet', '-m', 'fixture source'])
    const source = await prepareRsiSourceWorkspace({ dshHome: home, profile, version, sourceRepository: local })
    const resources = await prepareRsiAuthorityResources({ dshHome: home, profile })
    const runtime = await prepareRsiAuthorityRuntime({ dshHome: home, profile })
    const require = createRequire(import.meta.url)
    const cpRoot = dirname(require.resolve('@dsh-enhanced/plugin-control-plane/package.json'))
    const localAdapter = await import(pathToFileURL(join(cpRoot, 'bin', 'dsh-local-release-adapter.js')).href) as {
      inspectLocalReleaseBuildEnvironment(value: { pnpmRoot: string; storeRoot: string; cacheRoot: string }): RsiAuthorityConfigInput['releaseBuild']
    }
    const buildRoot = join(root, 'release-build'), pnpmRoot = join(buildRoot, 'toolchain')
    const storeRoot = join(buildRoot, 'store'), cacheRoot = join(buildRoot, 'cache')
    await privateDirectory(pnpmRoot); await privateDirectory(join(storeRoot, 'v11', 'projects')); await privateDirectory(cacheRoot)
    await copyFile(runtime.node.path, join(pnpmRoot, 'node'))
    await copyFile(runtime.node.path, join(pnpmRoot, 'pnpm'))
    await chmod(join(pnpmRoot, 'node'), 0o700); await chmod(join(pnpmRoot, 'pnpm'), 0o700)
    await file(join(pnpmRoot, 'package.json'), '{"version":"11.7.0"}\n')
    const releaseBuild = localAdapter.inspectLocalReleaseBuildEnvironment({ pnpmRoot, storeRoot, cacheRoot })
    const gitPath = await realpath('/usr/bin/git')
    const gitPin = { path: gitPath, sha256: hash(await readFile(gitPath)) }
    const systemctlPath = await realpath('/usr/bin/true')
    const systemctl = { path: systemctlPath, sha256: hash(await readFile(systemctlPath)), interpreter: null }
    const binding: ActiveLarkOwnerBinding = {
      id: 'binding', conversation: { channel: 'lark', account: 'account', tenant: 'tenant', kind: 'dm', chat: 'chat' },
      principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' },
      workspace, agentPreset: 'primary', sessionId: 'session', generation: 1,
      policyRef: 'owner-policy', status: 'active', createdAt: 1, updatedAt: 1, version: 1,
      owner: { id: 'principal-record', principal: { channel: 'lark', account: 'account', tenant: 'tenant', user: 'owner' },
        role: 'owner', status: 'active', createdAt: 1, updatedAt: 1, version: 1 },
    }
    const deliveryConfig = { defaultWorkspace: workspace, defaultAgentPreset: 'primary', ownerRoutes: [{ id: 'owner-route',
      conversation: binding.conversation, principal: binding.principal, workspace,
      agentPreset: 'primary', policyRef: 'owner-policy', minimumGeneration: 1 }] }
    const targetEffective = stringify([
      { id: 'dsh-enhanced-personal-assistant', name: '@dsh-enhanced/personal-assistant', config: {
        assistantPolicy: { databasePath: join(home, 'policy.sqlite'), budgets: [], rules: [] },
        assistantAutomations: { schedulerEnabled: false, allowUnbudgetedExecution: false } } },
      { id: 'dsh-enhanced-assistant-delivery', name: '@dsh-enhanced/assistant-delivery', config: deliveryConfig },
      { id: 'dsh-enhanced-lark-channel', name: '@dsh-enhanced/lark-channel', config: { enabled: true } },
      { id: 'dsh-enhanced-assistant-evaluation', name: '@dsh-enhanced/assistant-evaluation', config: {} },
      { id: 'dsh-enhanced-assistant-goals', name: '@dsh-enhanced/assistant-goals', config: {} },
      { id: 'dsh-enhanced-assistant-skills', name: '@dsh-enhanced/assistant-skills', config: {} },
      { id: 'dsh-enhanced-assistant-verifier', name: '@dsh-enhanced/assistant-verifier', config: { databasePath: join(home, 'verifier.sqlite') } },
      { id: 'dsh-enhanced-assistant-growth-driver', name: '@dsh-enhanced/assistant-growth-driver' },
      { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {} },
      { id: 'dsh-enhanced-hello', name: '@dsh-enhanced/hello', config: {} },
    ])
    const coordinatorEffective = stringify([
      { id: 'dsh-enhanced-assistant-policy', name: '@dsh-enhanced/assistant-policy', config: { databasePath: join(home, 'old.sqlite'), budgets: [], rules: [] } },
      { id: 'dsh-enhanced-assistant-automations', name: '@dsh-enhanced/assistant-automations', config: {
        databasePath: join(home, 'old-auto.sqlite'), runsPath: join(home, 'old-runs'), schedulerEnabled: false, allowUnbudgetedExecution: false } },
      { id: 'dsh-enhanced-plugin-control-plane', name: '@dsh-enhanced/plugin-control-plane', config: {} },
      { id: 'tool-web', name: '@deepseek-ai/tool-web', config: {} },
    ])
    const profiles = { targetPatch: '[]\n', targetEffective, coordinatorPatch: '[]\n', coordinatorEffective,
      coordinatorBase: stringify([{ insert: [{ id: 'tool-web', name: '@deepseek-ai/tool-web' },
        { id: 'agent-loop', name: '@deepseek-ai/agent-loop' }] }]) }
    const plugins = ['personal-assistant', 'assistant-goals', 'assistant-growth-driver', 'hello']
    const hostDeploymentInputs = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml',
      ...plugins.flatMap(plugin => [`node_modules/@dsh-enhanced/${plugin}/package.json`,
        `node_modules/@dsh-enhanced/${plugin}/cordis.patch.yml`, `node_modules/@dsh-enhanced/${plugin}/lib/index.js`])]
    for (const name of hostDeploymentInputs) await file(join(targetPath, name), `fixture ${name}\n`)
    const now = Date.now(), expiresAt = now + 3_600_000
    const manifest = createRsiBootstrapManifest({ dshHome: home, targetProfile: profile, coordinatorProfile: coordinator,
      targetEffective, owner: binding, resources, runtime, source,
      sourceBuild: { dockerPath: systemctlPath, image: `sha256:${'a'.repeat(64)}`, timeoutMs: 60_000,
        memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096, versioning: 'patch' },
      git: gitPin, now, expiresAt, plugins, hostDeploymentInputs,
      observerTargets: [{ entryId: 'dsh-enhanced-assistant-delivery', module: '@dsh-enhanced/assistant-delivery',
        configDigest: runtimeConfigDigest(deliveryConfig), services: ['assistantDelivery'] }] })
    const policies: SourceReleaseAuthorityConfig['grant']['policies'] = plugins.map(plugin => ({ targetBranch: source.baseline.targetBranch,
      candidateId: plugin, packageName: `@dsh-enhanced/${plugin}`, packagePath: `plugins/${plugin}`, dshBaseline: '0.1.5-rc.3',
      capabilities: [plugin], authorities: ['network'], requires: [], registryId: resources.registry.id,
      registryLocator: resources.registry.locator, catalogId: resources.catalog.id, catalogPath: resources.catalog.path,
      minimumReproducibleBuilds: 2 }))
    const unitProperties = { FragmentPath: join(home, 'systemd', 'dsh-profile-target.service'), DropInPaths: '',
      ExecStart: `/usr/bin/true run --profile ${profile} ; }`, Environment: '', WorkingDirectory: home,
      User: '', Group: '', Type: 'simple', KillMode: 'control-group' }
    return { input: { manifest, resources, runtime, source, releaseBuild,
      executor: { id: 'fixture-executor', version: '0.1.5-rc.3', path: systemctlPath, sha256: systemctl.sha256, environmentAllowlist: [] },
      systemctl, unitProperties, policies, now }, binding, profiles, root,
      cleanup: () => rm(root, { recursive: true, force: true }) }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
