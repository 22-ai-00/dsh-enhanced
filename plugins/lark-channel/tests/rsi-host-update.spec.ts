import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { parseDocument } from 'yaml'
import type { RsiAuthorityResources } from '../src/rsi-authority-resources.js'
import { readRsiHostUpdateOverlayChain, rebaseRsiHostActivePatch, rebaseRsiHostValue,
  rsiHostUpdateOverlayDigest, signRsiHostUpdateOverlay } from '../src/rsi-host-update.js'

const oldSha = 'a'.repeat(64), newSha = 'b'.repeat(64)
const rebase = { oldHostRoot: '/old-host', oldHostVersion: '0.1.5-rc.3', candidateHostVersion: '0.1.5',
  pins: { '/old-host/bin/dsh': { path: '/new-host/bin/dsh', sha256: newSha } } }

describe('bounded RSI Host update projections', () => {
  test('rebases only pinned executor and explicit DSH baseline fields', () => {
    expect(rebaseRsiHostValue({ ownerModel: '0.1.5-rc.3', version: '0.1.5-rc.3',
      dshBaseline: '0.1.5-rc.3', executor: { path: '/old-host/bin/dsh', sha256: oldSha, version: '0.1.5-rc.3' } }, rebase))
      .toEqual({ ownerModel: '0.1.5-rc.3', version: '0.1.5-rc.3', dshBaseline: '0.1.5',
        executor: { path: '/new-host/bin/dsh', sha256: newSha, version: '0.1.5' } })
    expect(() => rebaseRsiHostValue({ stray: '/old-host/unpinned' }, rebase)).toThrow('unmapped Host path')
  })

  test('preserves an adopted patch’s unrelated rows while migrating its pinned rows', () => {
    const patch = `[
      { id: dsh-enhanced-plugin-control-plane, config: { runtimeObserver: { targets: [] }, executor: { path: /old-host/bin/dsh, sha256: '${oldSha}', version: 0.1.5-rc.3 } } },
      { id: dsh-enhanced-assistant-growth-driver, config: { dshBaseline: 0.1.5-rc.3, ownerModel: 0.1.5-rc.3 } },
      { id: dsh-enhanced-assistant-verifier, config: { sourceReviews: [] } },
      { id: owner-extra, config: { version: 0.1.5-rc.3 } }
    ]`
    const changed = rebaseRsiHostActivePatch({ patch, rebase })
    const rows = parseDocument(changed).toJSON() as Array<{ id: string; config: unknown }>
    expect(rows.find(row => row.id === 'dsh-enhanced-plugin-control-plane')?.config).toMatchObject({
      executor: { path: '/new-host/bin/dsh', sha256: newSha, version: '0.1.5' },
    })
    expect(rows.find(row => row.id === 'dsh-enhanced-assistant-growth-driver')?.config).toEqual({
      dshBaseline: '0.1.5', ownerModel: '0.1.5-rc.3',
    })
    expect(rows.find(row => row.id === 'owner-extra')?.config).toEqual({ version: '0.1.5-rc.3' })
    expect(() => rebaseRsiHostActivePatch({ patch: patch.replace('version: 0.1.5-rc.3 } }\n    ]',
      'version: 0.1.5-rc.3, unbound: /old-host/other } }\n    ]'), rebase }))
      .toThrow('unmapped Host path')
  })

  test('binds a multi-step overlay chain to original bootstrap bytes and the installed Host identity', () => {
    const keys = generateKeyPairSync('ed25519')
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const resources = { installationId: 'install-1', configRoot: '/home/rsi-authorities/target/config',
      identities: { host: { authority: 'host-install-1', keyId: 'host-install-1-key',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } } as RsiAuthorityResources
    const bootstrapSource = '{"schemaVersion":1}\n'
    const base = { schemaVersion: 1 as const, kind: 'rsi-host-update-overlay' as const,
      transactionId: 'txn-1', dshHome: '/home', targetProfile: 'target', installationId: 'install-1',
      currentPlanId: 'plan-1', activationId: 'activation-1',
      sequence: 1, previousDigest: null, bootstrapDigest: '',
      files: { '/home/rsi-authorities/target/config/manifest.json': oldSha },
      patches: { target: oldSha, coordinator: oldSha }, runtimeReceiptDigest: oldSha,
      planDigest: oldSha, result: { schemaVersion: 1 as const,
        manifestPath: '/home/rsi-authorities/target/config/manifest.json', manifestDigest: oldSha,
        targetProfile: 'target', coordinatorProfile: 'coordinator' },
      issuedAt: 1, authority: 'host-install-1', keyId: 'host-install-1-key' }
    base.bootstrapDigest = createHash('sha256').update(bootstrapSource).digest('hex')
    const first = signRsiHostUpdateOverlay(base, privateKey, resources, bootstrapSource, [])
    const second = signRsiHostUpdateOverlay({ ...base, transactionId: 'txn-2', sequence: 2,
      previousDigest: rsiHostUpdateOverlayDigest(first), issuedAt: 2 }, privateKey, resources, bootstrapSource, [first])
    const source = JSON.stringify({ schemaVersion: 1, kind: 'rsi-host-update-overlays', records: [first, second] })
    expect(readRsiHostUpdateOverlayChain({ source, resources, dshHome: '/home', profile: 'target', bootstrapSource }).latest)
      .toEqual(second)
    expect(() => readRsiHostUpdateOverlayChain({ source, resources, dshHome: '/home', profile: 'target',
      bootstrapSource: 'changed' })).toThrow('overlay shape')
    expect(() => readRsiHostUpdateOverlayChain({ source: JSON.stringify({ schemaVersion: 1,
      kind: 'rsi-host-update-overlays', records: [first, { ...second, runtimeReceiptDigest: newSha }] }), resources, dshHome: '/home',
    profile: 'target', bootstrapSource })).toThrow('signature')
  })
})
