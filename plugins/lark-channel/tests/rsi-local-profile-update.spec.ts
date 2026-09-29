import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { isMap, isScalar, parseDocument } from 'yaml'
import type { RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { mergeRsiLocalOverrides, rsiLocalDependencyOverrides } from '../src/rsi-local-install.js'
import { assertRsiLocalProfileRoots, rebaseRsiLocalProfileWorkspace } from '../src/rsi-local-profile-update.js'

const root = '/private/owner home/rsi-local-cohorts/owner'
const internal = (slug: string): string => `@dsh-enhanced/${slug}`
function cohort(version = '0.1.48', dependencies = ['policy', 'removed-lib']): RsiLocalCohort {
  const names = ['target', 'policy', ...dependencies].filter((name, index, values) => values.indexOf(name) === index).sort()
  const content = { schemaVersion: 1 as const, root, sourceRepository: '/private/source', sourceCommit: 'a'.repeat(40), version,
    bundles: ['target'], allowBuilds: { esbuild: true, protobufjs: false },
    packages: names.map(slug => ({ name: internal(slug), path: `${slug.endsWith('-lib') ? 'packages' : 'plugins'}/${slug}`,
      bundle: !slug.endsWith('-lib'), runtimeDependencies: slug === 'target' ? dependencies.map(internal).sort() : [],
      tarball: join(root, 'artifacts', `${slug}.tgz`), sha256: 'b'.repeat(64), files: [] })) }
  return { ...content, receiptDigest: createHash('sha256').update(JSON.stringify(content)).digest('hex') }
}
function workspace(original: RsiLocalCohort): string {
  const source = '# owner settings\npackages: [.]\nautoInstallPeers: false\nnodeLinker: isolated\n'
    + 'customSetting: preserved\noverrides:\n  # unrelated pin comment\n  another-package: 1.2.3 # unrelated inline\n'
    + 'allowBuilds:\n  owner-tool: true # owner approval\n'
  const document = parseDocument(mergeRsiLocalOverrides(source, rsiLocalDependencyOverrides(original), original.allowBuilds))
  const overrides = document.get('overrides', true)
  if (!isMap(overrides)) throw new Error('fixture overrides absent')
  for (const item of overrides.items) if (isScalar(item.key) && String(item.key.value).includes(internal('target')) && isScalar(item.value)) {
    item.key.commentBefore = ` original edge ${item.key.value}`
    item.value.comment = ' frozen tarball comment'
  }
  return document.toString()
}
function mutate(source: string, path: string[], value?: unknown): string {
  const document = parseDocument(source)
  if (value === undefined) document.deleteIn(path)
  else document.setIn(path, value)
  return document.toString()
}

test('advances version, adds/removes runtime edges, and preserves unrelated owner configuration and comments', () => {
  const original = cohort(), candidate = cohort('0.1.49', ['policy', 'added-lib']), source = workspace(original)
  candidate.allowBuilds = { ...candidate.allowBuilds, newlyBlocked: false }
  const before = JSON.stringify({ original, candidate })
  const result = rebaseRsiLocalProfileWorkspace({ source, original, candidate }), value = parseDocument(result).toJS()
  expect(value).toMatchObject({ packages: ['.'], autoInstallPeers: false, nodeLinker: 'isolated', customSetting: 'preserved',
    overrides: { 'another-package': '1.2.3', ...rsiLocalDependencyOverrides(candidate) },
    allowBuilds: { esbuild: true, protobufjs: false, 'owner-tool': true, newlyBlocked: false } })
  expect(Object.keys(value.overrides).sort()).toEqual(['another-package', ...Object.keys(rsiLocalDependencyOverrides(candidate))].sort())
  for (const comment of ['# owner settings', '# unrelated pin comment', '# unrelated inline', '# owner approval',
    'original edge @dsh-enhanced/target@0.1.48>@dsh-enhanced/policy',
    'original edge @dsh-enhanced/target@0.1.48>@dsh-enhanced/removed-lib', 'frozen tarball comment']) expect(result).toContain(comment)
  expect(JSON.stringify({ original, candidate })).toBe(before)
  expect(rebaseRsiLocalProfileWorkspace({ source: result, original: candidate, candidate })).toBe(result)
})

test('same-version byte updates keep identical selectors, paths, configuration and comments', () => {
  const original = cohort(), candidate = structuredClone(original), source = workspace(original)
  candidate.sourceCommit = 'c'.repeat(40); candidate.packages[0]!.sha256 = 'd'.repeat(64)
  expect(rebaseRsiLocalProfileWorkspace({ source, original, candidate })).toBe(source)
})

test.each(['missing', 'conflicting', 'stale-version', 'unknown-package', 'global-internal', 'unknown-parent'] as const)(
  'rejects %s old runtime override drift', kind => {
    const original = cohort(), candidate = cohort('0.1.49'), selector = Object.keys(rsiLocalDependencyOverrides(original))[0]!
    let source = workspace(original)
    if (kind === 'missing') source = mutate(source, ['overrides', selector])
    else if (kind === 'conflicting') source = mutate(source, ['overrides', selector], 'file:/wrong.tgz')
    else {
      const extra = kind === 'stale-version' ? selector.replace('0.1.48', '0.1.47')
        : kind === 'global-internal' ? internal('policy')
          : kind === 'unknown-parent' ? `foreign-parent>${internal('policy')}` : internal('unknown')
      source = mutate(source, ['overrides', extra], 'file:/unknown.tgz')
    }
    expect(() => rebaseRsiLocalProfileWorkspace({ source, original, candidate })).toThrow(/override/u)
  })

test.each(['added-true', 'false-to-true', 'true-to-false', 'removed', 'workspace-missing', 'workspace-changed', 'workspace-conflict'] as const)(
  'rejects %s build authorization changes', kind => {
    const original = cohort(), candidate = cohort('0.1.49')
    let source = workspace(original)
    if (kind === 'added-true') candidate.allowBuilds['new-build'] = true
    else if (kind === 'false-to-true') candidate.allowBuilds.protobufjs = true
    else if (kind === 'true-to-false') candidate.allowBuilds.esbuild = false
    else if (kind === 'removed') delete candidate.allowBuilds.esbuild
    else if (kind === 'workspace-missing') source = mutate(source, ['allowBuilds', 'esbuild'])
    else if (kind === 'workspace-changed') source = mutate(source, ['allowBuilds', 'esbuild'], false)
    else { candidate.allowBuilds['owner-tool'] = false }
    expect(() => rebaseRsiLocalProfileWorkspace({ source, original, candidate })).toThrow(/build/u)
  })

test.each(['root', 'repository', 'bundles', 'tarball', 'package-path', 'missing-child', 'duplicate-edge', 'version-backwards'] as const)(
  'rejects %s frozen cohort identity drift', kind => {
    const original = cohort(), candidate = cohort('0.1.49'), source = workspace(original)
    if (kind === 'root') candidate.root = '/elsewhere/rsi-local-cohorts/owner'
    else if (kind === 'repository') candidate.sourceRepository = '/elsewhere/source'
    else if (kind === 'bundles') candidate.bundles = ['policy']
    else if (kind === 'tarball') candidate.packages[0]!.tarball = '/wrong/artifact.tgz'
    else if (kind === 'package-path') candidate.packages[0]!.path = 'packages/policy'
    else if (kind === 'missing-child') candidate.packages = candidate.packages.filter(item => item.name !== internal('policy'))
    else if (kind === 'duplicate-edge') candidate.packages.find(item => item.name === internal('target'))!.runtimeDependencies.push(internal('policy'))
    else candidate.version = '0.1.47'
    expect(() => rebaseRsiLocalProfileWorkspace({ source, original, candidate })).toThrow()
  })

test.each(['overrides-list', 'builds-scalar', 'build-value', 'duplicate-keys', 'linker-drift'] as const)(
  'rejects malformed or drifted %s configuration', kind => {
    const original = cohort(), candidate = cohort('0.1.49')
    let source = workspace(original)
    if (kind === 'overrides-list') source = mutate(source, ['overrides'], [])
    else if (kind === 'builds-scalar') source = mutate(source, ['allowBuilds'], false)
    else if (kind === 'build-value') source = mutate(source, ['allowBuilds', 'owner-tool'], 'yes')
    else if (kind === 'duplicate-keys') source += 'overrides: {}\n'
    else source = mutate(source, ['nodeLinker'], 'hoisted')
    expect(() => rebaseRsiLocalProfileWorkspace({ source, original, candidate })).toThrow()
  })

test('checks both profile root selections, accepts exact absolute/relative tarballs, and preserves unrelated manifest bytes', () => {
  const original = cohort(), candidate = cohort('0.1.49')
  for (const selected of [['target'], ['policy']]) for (const prefix of [`file:${root}`, 'file:../../rsi-local-cohorts/owner']) {
    const manifest = JSON.stringify({ name: 'owner-profile', private: true, scripts: { keep: 'echo owner' },
      dependencies: { [internal(selected[0]!)]: `${prefix}/artifacts/${selected[0]}.tgz`, external: '^1.2.3' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...selected.map(internal)], patchReload: 'live' } },
      devDependencies: { 'owner-dev-tool': '2.0.0' } }, null, 2) + '\n'
    expect(() => assertRsiLocalProfileRoots({ source: manifest, cohort: original, bundles: selected })).not.toThrow()
    expect(() => assertRsiLocalProfileRoots({ source: manifest, cohort: candidate, bundles: selected })).not.toThrow()
    expect(JSON.parse(manifest).scripts.keep).toBe('echo owner')
  }
})

test.each(['missing', 'registry', 'foreign-path', 'stale-relative', 'unknown-root', 'extra-known-root', 'dev-root', 'optional-root', 'peer-root',
  'unmounted', 'missing-mounted', 'extra-mounted', 'duplicate-mounted', 'aliased-mounted', 'invalid-json'] as const)(
  'rejects %s profile manifest root drift', kind => {
    const frozen = cohort()
    const manifest: Record<string, unknown> = { dependencies: { [internal('target')]: `file:${root}/artifacts/target.tgz` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', internal('target')] } } }
    const dependencies = manifest.dependencies as Record<string, string>
    if (kind === 'missing') delete dependencies[internal('target')]
    else if (kind === 'registry') dependencies[internal('target')] = frozen.version
    else if (kind === 'foreign-path') dependencies[internal('target')] = 'file:/wrong/target.tgz'
    else if (kind === 'stale-relative') dependencies[internal('target')] = 'file:../../rsi-local-cohorts/other/artifacts/target.tgz'
    else if (kind === 'unknown-root') dependencies[internal('unknown')] = '1.0.0'
    else if (kind === 'extra-known-root') dependencies[internal('policy')] = `file:${root}/artifacts/policy.tgz`
    else if (kind === 'dev-root' || kind === 'optional-root' || kind === 'peer-root') {
      const field = kind === 'dev-root' ? 'devDependencies' : kind === 'optional-root' ? 'optionalDependencies' : 'peerDependencies'
      manifest[field] = { [internal('target')]: dependencies[internal('target')] }
    }
    else if (kind.endsWith('mounted')) {
      if (kind === 'missing-mounted') delete manifest.dsh
      else manifest.dsh = { profile: { bundles: kind === 'unmounted' ? ['@deepseek-ai/dsh-base']
        : kind === 'extra-mounted' ? [internal('target'), internal('policy')]
          : kind === 'duplicate-mounted' ? [internal('target'), internal('target')]
            : [`npm:${internal('target')}`] } }
    }
    const source = kind === 'invalid-json' ? '{' : JSON.stringify(manifest)
    expect(() => assertRsiLocalProfileRoots({ source, cohort: frozen, bundles: ['target'] })).toThrow()
  })
