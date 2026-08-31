import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyApprovedPackagesInLockfile } from '../src/lockfile.ts'

const approved = [{ package: '@dsh-enhanced/example', version: '1.2.3', integrity: 'sha512-YXBwcm92ZWQ=' }]
const registryLock = (body: string): string => `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@dsh-enhanced/example':
        specifier: 1.2.3
        version: 1.2.3
packages:
${body}
snapshots:
`

describe('structured pnpm lock verification', () => {
  test('accepts one exact registry package/version/integrity association', () => {
    expect(() => verifyApprovedPackagesInLockfile(registryLock(`  '@dsh-enhanced/example@1.2.3':
    resolution:
      integrity: sha512-YXBwcm92ZWQ=
`), approved)).not.toThrow()
  })

  test('does not accept an integrity string attached to another package or version', () => {
    expect(() => verifyApprovedPackagesInLockfile(registryLock(`  '@dsh-enhanced/attacker@9.9.9':
    resolution: {integrity: sha512-YXBwcm92ZWQ=}
  '@dsh-enhanced/example@1.2.4':
    resolution: {integrity: sha512-YXBwcm92ZWQ=}
`), approved)).toThrow('does not bind')
  })

  test('fails closed on duplicate keys, aliases, tags and ambiguous inline mappings', () => {
    expect(() => verifyApprovedPackagesInLockfile(registryLock(`  '@dsh-enhanced/example@1.2.3':
    resolution: &shared
      integrity: sha512-YXBwcm92ZWQ=
`), approved)).toThrow()
    expect(() => verifyApprovedPackagesInLockfile(registryLock(`  '@dsh-enhanced/example@1.2.3':
    resolution: {tarball: x, integrity: sha512-YXBwcm92ZWQ=}
`), approved)).toThrow('approved integrity')
    expect(() => verifyApprovedPackagesInLockfile(registryLock(`  '@dsh-enhanced/example@1.2.3':
    resolution: {integrity: sha512-YXBwcm92ZWQ=}
  '@dsh-enhanced/example@1.2.3':
    resolution: {integrity: sha512-YXBwcm92ZWQ=}
`), approved)).toThrow('duplicate')
  })

  test('binds pnpm 11 local tarball importer, package resolution, manifest version and integrity', () => {
    const artifactPath = join('/var/lib/dsh-registry/packages', encodeURIComponent('@dsh-enhanced/example'), '1.2.3/package.tgz')
    const reference = pathToFileURL(artifactPath).href
    const local = [{ ...approved[0]!, registry: { id: 'local', locator: 'file:///var/lib/dsh-registry', reference } }]
    const source = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      '@dsh-enhanced/example':
        specifier: file:${artifactPath}
        version: file:../../var/lib/dsh-registry/packages/%40dsh-enhanced%2Fexample/1.2.3/package.tgz(yaml@2.9.0)
packages:
  '@dsh-enhanced/example@file:../../var/lib/dsh-registry/packages/%40dsh-enhanced%2Fexample/1.2.3/package.tgz':
    resolution: {integrity: sha512-YXBwcm92ZWQ=, tarball: file:../../var/lib/dsh-registry/packages/%40dsh-enhanced%2Fexample/1.2.3/package.tgz}
    version: 1.2.3
snapshots:
`
    expect(() => verifyApprovedPackagesInLockfile(source, local, '/tmp/profile')).not.toThrow()
    expect(() => verifyApprovedPackagesInLockfile(source.replace('version: 1.2.3\nsnapshots', 'version: 9.9.9\nsnapshots'), local, '/tmp/profile'))
      .toThrow('approved local artifact')
    expect(() => verifyApprovedPackagesInLockfile(source.replace('sha512-YXBwcm92ZWQ=', 'sha512-dGFtcGVy'), local, '/tmp/profile'))
      .toThrow('approved local artifact')
    expect(() => verifyApprovedPackagesInLockfile(source.replaceAll('package.tgz', 'other.tgz'), local, '/tmp/profile'))
      .toThrow('approved local artifact')
  })
})
