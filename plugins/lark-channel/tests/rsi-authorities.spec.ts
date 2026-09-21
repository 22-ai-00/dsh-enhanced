import { afterEach, describe, expect, test } from 'vitest'
import { validateRsiAuthorities } from '../src/rsi-setup.js'
import { createRsiAuthorityFixture, type RsiAuthorityFixture } from './fixtures/rsi-authorities.js'

const fixtures: RsiAuthorityFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())) })
async function fixture(): Promise<RsiAuthorityFixture> { const value = await createRsiAuthorityFixture(); fixtures.push(value); return value }

describe('RSI finite authority deployment binding', () => {
  test('accepts four owner-private finite authority files pinned to schema-v4 trust', async () => {
    const value = await fixture()
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).resolves.toBeUndefined()
  })

  test.each([
    ['owner', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('approvals'); authority.grant.owner.principalRecordId = 'other-owner'; await value.writeAuthority('approvals', authority) }, 'authority owner/ledger mismatch'],
    ['ledger', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('releases'); authority.controlDatabasePath = `${value.root}/other-control.sqlite`; await value.writeAuthority('releases', authority) }, 'authority owner/ledger mismatch'],
    ['key', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('adoptions'); authority.keyPath = (await value.readAuthority('releases')).keyPath; await value.writeAuthority('adoptions', authority) }, 'authority key does not match registered trust'],
    ['expiry', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('observations'); const expiresAt = Date.now() - 1; authority.grant.policy.expiresAt = expiresAt; value.manifest.controlPlane.taskObservations!.policy.expiresAt = expiresAt; await value.writeAuthority('observations', authority) }, 'finite authority has expired'],
    ['allowlists', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('approvals'); authority.grant.plugins = ['other-plugin']; await value.writeAuthority('approvals', authority) }, 'observation package allowlist does not match'],
    ['executor', async (value: RsiAuthorityFixture) => { const authority = await value.readAuthority('adoptions'); authority.grant.executor.id = 'other-executor'; await value.writeAuthority('adoptions', authority) }, 'authority deployment terms mismatch'],
  ])('rejects %s drift', async (_label, change, message) => {
    const value = await fixture()
    await change(value)
    await expect(validateRsiAuthorities(value.manifest, value.binding as any)).rejects.toThrow(message)
  })
})
