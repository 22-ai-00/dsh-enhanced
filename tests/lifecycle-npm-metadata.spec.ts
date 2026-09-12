import { describe, expect, test } from 'vitest'
import { parse, stringify } from 'yaml'
import { assertLifecycleNpmMetadataSafe, lifecycleWorkspacePaths, prepareLifecycleNpmMetadata } from '../scripts/install/lifecycle-config.mjs'

const target = '@dsh-enhanced/assistant-actions@0.1.31'

function packageJson(version: string, unmanaged = '1.0.0') {
  return `${JSON.stringify({ name: 'profile', private: true, dependencies: {
    '@dsh-enhanced/assistant-actions': version,
    'left-pad': unmanaged,
  }, marker: { retained: true } }, null, 2)}\n`
}

function lockfile(version: string, { unmanaged = '1.0.0', includeTarget = true } = {}) {
  const dependencies: Record<string, unknown> = { 'left-pad': { specifier: unmanaged, version: unmanaged } }
  if (includeTarget) dependencies['@dsh-enhanced/assistant-actions'] = { specifier: version, version }
  const packages: Record<string, unknown> = { [`left-pad@${unmanaged}`]: { resolution: { integrity: 'sha512-left' } } }
  const snapshots: Record<string, unknown> = { [`left-pad@${unmanaged}`]: {} }
  if (includeTarget) {
    packages[`@dsh-enhanced/assistant-actions@${version}`] = { resolution: { integrity: 'sha512-actions' } }
    packages[`@dsh-enhanced/assistant-automations@${version}`] = { resolution: { integrity: 'sha512-automations' } }
    snapshots[`@dsh-enhanced/assistant-actions@${version}`] = {
      dependencies: { '@dsh-enhanced/assistant-automations': version },
    }
    snapshots[`@dsh-enhanced/assistant-automations@${version}`] = {}
  }
  return stringify({ lockfileVersion: '9.0', importers: { '.': { dependencies } }, packages, snapshots })
}

function workspace(excludes: string[], strict = false) {
  return stringify({ packages: ['.'], nodeLinker: 'hoisted', minimumReleaseAge: 1440,
    ...(strict ? { minimumReleaseAgeStrict: true } : {}), minimumReleaseAgeExclude: excludes, opaque: { keep: ['this'] } })
}

function metadata({
  originalVersion = '0.1.30', preparedVersion = '0.1.31', originalExcludes = [
    '@dsh-enhanced/assistant-actions@0.1.30',
    '@dsh-enhanced/assistant-automations@0.1.30',
    'left-pad@1.0.0',
  ], excludes = [
    '@dsh-enhanced/assistant-actions@0.1.30',
    '@dsh-enhanced/assistant-automations@0.1.30',
    'left-pad@1.0.0',
    '@dsh-enhanced/assistant-actions@0.1.31',
    '@dsh-enhanced/assistant-automations@0.1.31',
  ], strict = false,
} = {}) {
  return {
    original: { packageJson: packageJson(originalVersion), lockfile: lockfile(originalVersion), workspace: workspace(originalExcludes, strict) },
    prepared: { packageJson: packageJson(preparedVersion), lockfile: lockfile(preparedVersion), workspace: workspace(excludes, strict) },
  }
}

describe('prepareLifecycleNpmMetadata', () => {
  test('merges only the authorized target cohort closure into first exact rules without changing lockfile bytes', async () => {
    const input = metadata()
    const result = await prepareLifecycleNpmMetadata({ ...input, targets: [target] })
    const preparedWorkspace = parse(result.workspace) as { minimumReleaseAgeExclude: string[], opaque: unknown }

    expect(result.packageJson).toBe(input.prepared.packageJson)
    expect(result.lockfile).toBe(input.prepared.lockfile)
    expect(preparedWorkspace.minimumReleaseAgeExclude).toEqual([
      '@dsh-enhanced/assistant-actions@0.1.30 || 0.1.31',
      '@dsh-enhanced/assistant-automations@0.1.30 || 0.1.31',
      'left-pad@1.0.0',
      '@dsh-enhanced/assistant-actions@0.1.31',
      '@dsh-enhanced/assistant-automations@0.1.31',
    ])
    expect(preparedWorkspace.opaque).toEqual({ keep: ['this'] })
  })

  test('does not activate pre-existing shadowed versions while promoting only this cohort version', async () => {
    const input = metadata({ excludes: [
      '@dsh-enhanced/assistant-actions@0.1.29',
      '@dsh-enhanced/assistant-actions@0.1.30',
      '@dsh-enhanced/assistant-automations@0.1.30 || 0.1.29',
      '@dsh-enhanced/assistant-actions@0.1.31',
      '@dsh-enhanced/assistant-automations@0.1.31',
    ], originalExcludes: [
      '@dsh-enhanced/assistant-actions@0.1.29',
      '@dsh-enhanced/assistant-actions@0.1.30',
      '@dsh-enhanced/assistant-automations@0.1.30 || 0.1.29',
    ] })
    const result = await prepareLifecycleNpmMetadata({ ...input, targets: [target] })
    const excludes = (parse(result.workspace) as { minimumReleaseAgeExclude: string[] }).minimumReleaseAgeExclude

    expect(excludes).toEqual([
      '@dsh-enhanced/assistant-actions@0.1.29 || 0.1.31',
      '@dsh-enhanced/assistant-actions@0.1.30',
      '@dsh-enhanced/assistant-automations@0.1.30 || 0.1.29 || 0.1.31',
      '@dsh-enhanced/assistant-actions@0.1.31',
      '@dsh-enhanced/assistant-automations@0.1.31',
    ])
  })

  test('rejects strict policy instead of adding a new age exception', async () => {
    const input = metadata({ strict: true })
    await expect(prepareLifecycleNpmMetadata({ ...input, targets: [target] }))
      .rejects.toThrow('strict minimum release age forbids adding age exceptions')
  })

  test('rejects unmanaged manifest or importer resolution changes', async () => {
    const input = metadata()
    const alteredManifest = { ...input.prepared, packageJson: packageJson('0.1.31', '2.0.0') }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: alteredManifest, targets: [target] }))
      .rejects.toThrow('changes unmanaged dependency left-pad')

    const alteredLock = { ...input.prepared, lockfile: lockfile('0.1.31', { unmanaged: '2.0.0' }) }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: alteredLock, targets: [target] }))
      .rejects.toThrow('changes unmanaged importer dependency left-pad')
  })

  test('rejects unsupported wildcard policy on an authorized closure package', async () => {
    const input = metadata({ excludes: [
      '@dsh-enhanced/assistant-actions@*',
      '@dsh-enhanced/assistant-automations@0.1.30',
      '@dsh-enhanced/assistant-actions@0.1.31',
      '@dsh-enhanced/assistant-automations@0.1.31',
    ], originalExcludes: [
      '@dsh-enhanced/assistant-actions@*',
      '@dsh-enhanced/assistant-automations@0.1.30',
    ] })
    await expect(prepareLifecycleNpmMetadata({ ...input, targets: [target] }))
      .rejects.toThrow('unsupported age exclusion')
  })

  test('requires every explicit target in final lock closure', async () => {
    const input = metadata()
    const missing = { ...input.prepared, lockfile: lockfile('0.1.31', { includeTarget: false }) }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: missing, targets: [target] }))
      .rejects.toThrow('root importer does not pin')
  })

  test('rejects deletion, reordering, and unauthorized additions to original age exclusions', async () => {
    const input = metadata()
    const withoutOriginal = { ...input.prepared, workspace: workspace([
      '@dsh-enhanced/assistant-automations@0.1.30', 'left-pad@1.0.0',
      '@dsh-enhanced/assistant-actions@0.1.31', '@dsh-enhanced/assistant-automations@0.1.31',
    ]) }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: withoutOriginal, targets: [target] }))
      .rejects.toThrow('ordered prefix')
    const thirdParty = { ...input.prepared, workspace: workspace([
      '@dsh-enhanced/assistant-actions@0.1.30', '@dsh-enhanced/assistant-automations@0.1.30', 'left-pad@1.0.0',
      '@dsh-enhanced/assistant-actions@0.1.31', '@dsh-enhanced/assistant-automations@0.1.31', 'left-pad@2.0.0',
    ]) }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: thirdParty, targets: [target] }))
      .rejects.toThrow('adds unauthorized age exclusion')
  })

  test('requires target dependencies in original manifest and exact root importer', async () => {
    const input = metadata()
    const originalManifest = JSON.parse(input.original.packageJson) as { dependencies: Record<string, string> }
    delete originalManifest.dependencies['@dsh-enhanced/assistant-actions']
    const absentOriginal = { ...input.original, packageJson: `${JSON.stringify(originalManifest)}\n` }
    await expect(prepareLifecycleNpmMetadata({ original: absentOriginal, prepared: input.prepared, targets: [target] }))
      .rejects.toThrow('original package.json does not contain authorized target')
    const rootWrong = { ...input.prepared, lockfile: lockfile('0.1.30') }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: rootWrong, targets: [target] }))
      .rejects.toThrow('root importer does not pin')
  })


  test('rejects newly introduced unmanaged root and non-root importer entries', async () => {
    const input = metadata()
    const root = parse(input.prepared.lockfile) as { importers: Record<string, unknown> }
    const rootAdded = structuredClone(root)
    ;(rootAdded.importers['.'] as { dependencies: Record<string, unknown> }).dependencies.unmanaged = { specifier: '1.0.0', version: '1.0.0' }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: { ...input.prepared, lockfile: stringify(rootAdded) }, targets: [target] }))
      .rejects.toThrow('changes unmanaged importer dependency unmanaged')
    const nested = structuredClone(root)
    nested.importers.other = { dependencies: { unmanaged: { specifier: '1.0.0', version: '1.0.0' } } }
    await expect(prepareLifecycleNpmMetadata({ original: input.original, prepared: { ...input.prepared, lockfile: stringify(nested) }, targets: [target] }))
      .rejects.toThrow('changes unmanaged importer dependency unmanaged')
  })

  test('uses original manifest graph when no original lockfile exists', async () => {
    const input = metadata()
    await expect(prepareLifecycleNpmMetadata({ original: { ...input.original, lockfile: undefined }, prepared: input.prepared, targets: [target] }))
      .resolves.toMatchObject({ lockfile: input.prepared.lockfile })
  })

})

describe('lifecycleWorkspacePaths', () => {
  test('returns deduplicated ordinary absolute workspaces only from active web owner rows', async () => {
    await expect(lifecycleWorkspacePaths(`
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    workspace: /opt/owner-workspace
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    workspace: /opt/owner-workspace
- id: unrelated
  name: '@dsh-enhanced/assistant-policy'
  config:
    workspace: /not-collected
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  disabled: true
  config:
    workspace: /disabled
`)).resolves.toEqual(['/opt/owner-workspace'])
  })

  test('allows fixture web rows with no workspace and rejects dynamic or relative workspace values', async () => {
    await expect(lifecycleWorkspacePaths(`
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config: {}
`)).resolves.toEqual([])
    await expect(lifecycleWorkspacePaths(`
- id: bash-sandbox
  name: '@deepseek-ai/dsh-sandbox'
  disabled: !!js process.platform !== 'linux'
  config:
    statePath: !!js dshHomePath('sandbox/state')
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config: {}
`)).resolves.toEqual([])
    await expect(lifecycleWorkspacePaths(`
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    workspace: relative/path
`)).rejects.toThrow('ordinary absolute web owner workspace paths')
    await expect(lifecycleWorkspacePaths(`
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    workspace: !!js dshHomePath('workspace')
`)).rejects.toThrow('ordinary absolute web owner workspace paths')
  })
})


describe('assertLifecycleNpmMetadataSafe', () => {
  test('allows inert package scripts but rejects config dependency and runtime bootstrap inputs', async () => {
    const input = metadata()
    const inert = JSON.parse(input.prepared.packageJson) as Record<string, unknown>
    inert.scripts = { prepare: 'echo inert' }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, packageJson: `${JSON.stringify(inert)}\n` } })).resolves.toBeUndefined()
    const configDependencies = JSON.parse(input.prepared.packageJson) as { pnpm: Record<string, unknown> }
    configDependencies.pnpm = { configDependencies: { '@pnpm/plugin-test': '1.0.0' } }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, packageJson: `${JSON.stringify(configDependencies)}\n` } }))
      .rejects.toThrow('pnpm.configDependencies')
    const enginesRuntime = JSON.parse(input.prepared.packageJson) as { engines: Record<string, unknown> }
    enginesRuntime.engines = { runtime: { name: 'node', version: '24.0.0' }, node: '>=22', pnpm: '>=11' }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, packageJson: `${JSON.stringify(enginesRuntime)}\n` } }))
      .rejects.toThrow('engines.runtime')
    const runtime = JSON.parse(input.prepared.packageJson) as { devEngines: Record<string, unknown> }
    runtime.devEngines = { runtime: { name: 'node', version: '24.0.0' } }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, packageJson: `${JSON.stringify(runtime)}\n` } }))
      .rejects.toThrow('devEngines.runtime')
    const packageManager = JSON.parse(input.prepared.packageJson) as { devEngines: Record<string, unknown> }
    packageManager.devEngines = { packageManager: [{ name: 'pnpm', version: '11.7.0' }] }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, packageJson: `${JSON.stringify(packageManager)}\n` } }))
      .rejects.toThrow('devEngines.packageManager')
  })

  test('rejects workspace, lockfile, and environment config dependency sources', async () => {
    const input = metadata()
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, workspace: stringify({ configDependencies: { '@pnpm/plugin-test': '1.0.0' } }) } }))
      .rejects.toThrow('workspace configDependencies')
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, workspace: stringify({ executionEnv: { nodeVersion: '24.0.0' } }) } }))
      .rejects.toThrow('workspace executionEnv')
    const lock = parse(input.prepared.lockfile) as { importers: Record<string, { configDependencies?: unknown }> }
    lock.importers['.'].configDependencies = { '@pnpm/plugin-test': '1.0.0' }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, lockfile: stringify(lock) } }))
      .rejects.toThrow('lockfile root configDependencies')
    const previous = process.env.pnpm_config_config_dependencies
    process.env.pnpm_config_config_dependencies = '@pnpm/plugin-test@1.0.0'
    try {
      await expect(assertLifecycleNpmMetadataSafe({ metadata: input.prepared }))
        .rejects.toThrow('configDependencies environment')
    } finally {
      if (previous === undefined) delete process.env.pnpm_config_config_dependencies
      else process.env.pnpm_config_config_dependencies = previous
    }
    await expect(assertLifecycleNpmMetadataSafe({ metadata: { ...input.prepared, lockfile: undefined } })).resolves.toBeUndefined()
  })
})
