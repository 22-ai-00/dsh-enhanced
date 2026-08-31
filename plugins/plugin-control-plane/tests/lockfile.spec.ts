import { describe, expect, test } from 'vitest'
import { verifyApprovedPackagesInLockfile } from '../src/lockfile.ts'

const approved = [{ package: '@dsh-enhanced/example', version: '1.2.3', integrity: 'sha512-YXBwcm92ZWQ=' }]

describe('structured pnpm lock verification', () => {
  test('accepts one exact package/version/integrity association', () => {
    expect(() => verifyApprovedPackagesInLockfile(`lockfileVersion: '9.0'\npackages:\n  '@dsh-enhanced/example@1.2.3':\n    resolution:\n      integrity: sha512-YXBwcm92ZWQ=\nsnapshots:\n`, approved)).not.toThrow()
  })

  test('does not accept an integrity string attached to another package or version', () => {
    expect(() => verifyApprovedPackagesInLockfile(`packages:\n  '@dsh-enhanced/attacker@9.9.9':\n    resolution: {integrity: sha512-YXBwcm92ZWQ=}\n  '@dsh-enhanced/example@1.2.4':\n    resolution: {integrity: sha512-YXBwcm92ZWQ=}\n`, approved)).toThrow('does not bind')
  })

  test('fails closed on duplicate keys, aliases, tags and ambiguous inline mappings', () => {
    expect(() => verifyApprovedPackagesInLockfile(`packages:\n  '@dsh-enhanced/example@1.2.3':\n    resolution: &shared\n      integrity: sha512-YXBwcm92ZWQ=\n`, approved)).toThrow()
    expect(() => verifyApprovedPackagesInLockfile(`packages:\n  '@dsh-enhanced/example@1.2.3':\n    resolution: {tarball: x, integrity: sha512-YXBwcm92ZWQ=}\n`, approved)).toThrow('ambiguous')
    expect(() => verifyApprovedPackagesInLockfile(`packages:\n  '@dsh-enhanced/example@1.2.3':\n    resolution: {integrity: sha512-YXBwcm92ZWQ=}\n  '@dsh-enhanced/example@1.2.3':\n    resolution: {integrity: sha512-YXBwcm92ZWQ=}\n`, approved)).toThrow('duplicate')
  })
})
