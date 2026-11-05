import { createHash, generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { RsiAuthorityResources } from '../src/rsi-authority-resources.js'
import type { RsiSetupManifest } from '../src/rsi-profile.js'
import { rawLoaderConfig } from '../src/rsi-bootstrap-manifest.js'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { readRsiHostPatchConfig, readRsiHostUpdateOverlayChain, rebaseRsiHostActivePatch, rebaseRsiHostProfiles,
  rebaseRsiHostValue, replaceRsiHostPatchConfig,
  rsiHostUpdateOverlayDigest, signRsiHostUpdateOverlay, signRsiOwnerRepairOverlay, signRsiOwnerProgramUpdateOverlay } from '../src/rsi-host-update.js'

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

  test('rebases a tagged owner patch while preserving Loader expressions and observer digest', () => {
    const verifier = { databasePath: { __jsExpr: "dshHomePath('verifier/state.sqlite')" }, sourceReviews: [] }
    const digest = runtimeConfigDigest(verifier)
    const patch = `[
      { id: dsh-enhanced-plugin-control-plane, config: { runtimeObserver: { targets: [{ entryId: dsh-enhanced-assistant-verifier, configDigest: ${digest} }] }, executor: { path: /old-host/bin/dsh, sha256: '${oldSha}', version: 0.1.5-rc.3 } } },
      { id: dsh-enhanced-assistant-growth-driver, config: { dshBaseline: 0.1.5-rc.3 } },
      { id: dsh-enhanced-assistant-verifier, config: { databasePath: !!js "dshHomePath('verifier/state.sqlite')", sourceReviews: [] } },
      { id: personal-assistant, config: { nested: [{ databasePath: !!js 'dshHomePath("personal/state.sqlite")' }] } }
    ]`
    const coordinator = `[{ id: coordinator, config: { path: !!js "dshHomePath('coordinator/state.sqlite')" } }]`
    const manifest = { controlPlane: readRsiHostPatchConfig(patch, 'dsh-enhanced-plugin-control-plane'),
      growthDriver: readRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-growth-driver'), sourceReviews: [] } as unknown as RsiSetupManifest
    const changed = rebaseRsiHostProfiles({ manifest, targetPatch: patch, coordinatorPatch: coordinator, rebase })
    expect(changed.manifest.controlPlane.runtimeObserver!.targets[0]!.configDigest).toBe(digest)
    expect(readRsiHostPatchConfig(changed.targetPatch, 'dsh-enhanced-assistant-verifier')).toEqual(verifier)
    expect(changed.targetPatch).toContain('!!js')
    expect(changed.coordinatorPatch).toContain('!!js')
    const adopted = rebaseRsiHostActivePatch({ patch, rebase })
    expect(readRsiHostPatchConfig(adopted, 'dsh-enhanced-assistant-verifier')).toEqual(verifier)
    const document = parseDocument(adopted, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (s: string) => s }] })
    const verifierRow = document.contents
    expect(rawLoaderConfig(verifierRow, 'patch')).toMatchObject(expect.arrayContaining([
      { id: 'dsh-enhanced-assistant-verifier', config: verifier },
    ]))
    const rows = document.contents
    if (!isSeq(rows)) throw new Error('invalid test patch')
    const verifierNode = rows.items.find(item => isMap(item) && (item.get('id') as unknown) === 'dsh-enhanced-assistant-verifier')
    if (!isMap(verifierNode)) throw new Error('missing verifier')
    const configNode = verifierNode.get('config', true)
    if (!isMap(configNode)) throw new Error('missing config')
    const databaseNode = configNode.get('databasePath', true)
    expect(isScalar(databaseNode) && databaseNode.tag).toBe('tag:yaml.org,2002:js')
  })

  test('rejects unknown tags, duplicates, string impersonation and tagged expression changes', () => {
    const patch = `[{ id: dsh-enhanced-assistant-verifier, config: { databasePath: !!js "dshHomePath('verifier/state.sqlite')", sourceReviews: [] } }]`
    const old = readRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-verifier')
    expect(old.databasePath).toEqual({ __jsExpr: "dshHomePath('verifier/state.sqlite')" })
    expect(() => replaceRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-verifier',
      { ...old, databasePath: "dshHomePath('verifier/state.sqlite')" }, old)).toThrow('row changed')
    expect(() => replaceRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-verifier', old,
      { ...old, databasePath: { __jsExpr: "dshHomePath('other.sqlite')" } })).toThrow('tagged Loader expression')
    expect(() => replaceRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-verifier', old,
      { ...old, databasePath: '/tmp/plain.sqlite' })).toThrow('tagged Loader expression')
    const once = replaceRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-verifier', old,
      { ...old, sourceReviews: [{ id: 'one' }] })
    const twice = replaceRsiHostPatchConfig(once, 'dsh-enhanced-assistant-verifier',
      { ...old, sourceReviews: [{ id: 'one' }] }, { ...old, sourceReviews: [{ id: 'two' }] })
    expect(twice).toContain('!!js')
    expect(readRsiHostPatchConfig(twice, 'dsh-enhanced-assistant-verifier').sourceReviews).toEqual([{ id: 'two' }])
    expect(() => readRsiHostPatchConfig(patch.replace('!!js', '!!python'), 'dsh-enhanced-assistant-verifier'))
      .toThrow('bounded patch')
    expect(() => readRsiHostPatchConfig(patch.replace('sourceReviews: []', 'sourceReviews: [], sourceReviews: []'),
      'dsh-enhanced-assistant-verifier')).toThrow('bounded patch')
    expect(() => readRsiHostPatchConfig(patch.replace('!!js "dshHomePath(\'verifier/state.sqlite\')"',
      "{ __jsExpr: \"dshHomePath('verifier/state.sqlite')\" }"), 'dsh-enhanced-assistant-verifier'))
      .toThrow('untagged Loader expression marker')
  })

  test('expands a bounded native YAML alias without losing tagged expressions', () => {
    const patch = `[
      { id: dsh-enhanced-plugin-control-plane, config: {
        runtimeObserver: { targets: [] },
        taskObservations: { scope: &a1 { account: owner, tenant: stable } },
        liveQualification: { scope: *a1 },
        executor: { path: /old-host/bin/dsh, sha256: '${oldSha}', version: 0.1.5-rc.3 }
      } },
      { id: dsh-enhanced-assistant-growth-driver, config: { dshBaseline: 0.1.5-rc.3 } },
      { id: dsh-enhanced-assistant-verifier, config: { databasePath: !!js "dshHomePath('verifier/state.sqlite')", sourceReviews: [] } }
    ]`
    const cp = readRsiHostPatchConfig(patch, 'dsh-enhanced-plugin-control-plane')
    expect(cp.liveQualification).toEqual({ scope: { account: 'owner', tenant: 'stable' } })
    const changed = rebaseRsiHostActivePatch({ patch, rebase })
    expect(changed).toContain('!!js')
    expect(changed).not.toContain('*a1')
    expect(changed).not.toContain('&a1')
    expect(readRsiHostPatchConfig(changed, 'dsh-enhanced-plugin-control-plane')).toMatchObject({
      taskObservations: { scope: { account: 'owner', tenant: 'stable' } },
      liveQualification: { scope: { account: 'owner', tenant: 'stable' } },
      executor: { path: '/new-host/bin/dsh' },
    })
    expect(() => readRsiHostPatchConfig('[{ id: x, config: { cycle: &a1 [*a1] } }]', 'x'))
      .toThrow('cyclic YAML alias')
    expect(() => readRsiHostPatchConfig('[{ id: x, config: { missing: *notThere } }]', 'x'))
      .toThrow()
  })

  test('writes changed verifier observer digests back to the control-plane patch', () => {
    const reviews = { runner: { path: '/old-host/bin/dsh', sha256: oldSha } }
    const verifier = { databasePath: { __jsExpr: "dshHomePath('verifier/state.sqlite')" }, sourceReviews: reviews }
    const digest = runtimeConfigDigest(verifier)
    const patch = `[
      { id: dsh-enhanced-plugin-control-plane, config: { runtimeObserver: { targets: [{ entryId: dsh-enhanced-assistant-verifier, configDigest: ${digest} }] } } },
      { id: dsh-enhanced-assistant-growth-driver, config: { dshBaseline: 0.1.5-rc.3 } },
      { id: dsh-enhanced-assistant-verifier, config: {
        databasePath: !!js "dshHomePath('verifier/state.sqlite')",
        sourceReviews: { runner: { path: /old-host/bin/dsh, sha256: '${oldSha}' } }
      } }
    ]`
    const manifest = { controlPlane: readRsiHostPatchConfig(patch, 'dsh-enhanced-plugin-control-plane'),
      growthDriver: readRsiHostPatchConfig(patch, 'dsh-enhanced-assistant-growth-driver'),
      sourceReviews: reviews } as unknown as RsiSetupManifest
    const changed = rebaseRsiHostProfiles({ manifest, targetPatch: patch, coordinatorPatch: '[]', rebase })
    const newControl = readRsiHostPatchConfig(changed.targetPatch, 'dsh-enhanced-plugin-control-plane')
    expect(newControl).toEqual(changed.manifest.controlPlane)
    expect(newControl.runtimeObserver).toEqual({ targets: [{ entryId: 'dsh-enhanced-assistant-verifier',
      configDigest: runtimeConfigDigest(readRsiHostPatchConfig(changed.targetPatch, 'dsh-enhanced-assistant-verifier')) }] })
    expect(newControl.runtimeObserver).not.toEqual(manifest.controlPlane.runtimeObserver)
    expect(changed.targetPatch).toContain('!!js')
    expect(() => replaceRsiHostPatchConfig(changed.targetPatch, 'dsh-enhanced-plugin-control-plane',
      newControl, { ...newControl })).not.toThrow()
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

  test('binds a repair without an activation to Host identity and either chain predecessor', () => {
    const keys = generateKeyPairSync('ed25519'), foreign = generateKeyPairSync('ed25519')
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const resources = { installationId: 'install-1', configRoot: '/home/rsi-authorities/target/config',
      identities: { host: { authority: 'host-install-1', keyId: 'host-install-1-key',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } } as RsiAuthorityResources
    const bootstrapSource = '{"schemaVersion":1}\n'
    const manifestPath = `${resources.configRoot}/manifest.json`
    const common = { schemaVersion: 1 as const, transactionId: 'txn-1', dshHome: '/home', targetProfile: 'target',
      installationId: 'install-1', sequence: 1, previousDigest: null, bootstrapDigest: createHash('sha256')
        .update(bootstrapSource).digest('hex'), files: { [manifestPath]: oldSha }, patches: { target: oldSha, coordinator: oldSha },
      runtimeReceiptDigest: oldSha, planDigest: oldSha, result: { schemaVersion: 1 as const,
        manifestPath, manifestDigest: oldSha, targetProfile: 'target', coordinatorProfile: 'coordinator' },
      issuedAt: 1, authority: 'host-install-1', keyId: 'host-install-1-key' }
    const host = signRsiHostUpdateOverlay({ ...common, kind: 'rsi-host-update-overlay',
      currentPlanId: 'plan', activationId: 'activation' }, privateKey, resources, bootstrapSource, [])
    const repairInput = { ...common, kind: 'rsi-owner-repair-overlay' as const, transactionId: 'repair',
      sequence: 2, previousDigest: rsiHostUpdateOverlayDigest(host), issuedAt: 2,
      repair: { sourceMaintenanceDigest: oldSha,
        before: { files: { [manifestPath]: oldSha }, patches: { target: oldSha, coordinator: oldSha },
          runtimeReceiptDigest: oldSha, creationReceiptDigest: oldSha, journalDigest: oldSha },
        after: { creationReceiptDigest: newSha, journalDigest: newSha }, permissionPreset: 'workspace-write' as const } }
    const repair = signRsiOwnerRepairOverlay(repairInput, privateKey, resources, bootstrapSource, [host])
    const next = signRsiHostUpdateOverlay({ ...common, transactionId: 'next', kind: 'rsi-host-update-overlay',
      currentPlanId: 'plan-next', activationId: 'activation-next', sequence: 3,
      previousDigest: rsiHostUpdateOverlayDigest(repair), issuedAt: 3 }, privateKey, resources, bootstrapSource, [host, repair])
    const read = (records: unknown[]) => readRsiHostUpdateOverlayChain({ source: JSON.stringify({ schemaVersion: 1,
      kind: 'rsi-host-update-overlays', records }), resources, dshHome: '/home', profile: 'target', bootstrapSource })
    expect(read([host, repair, next]).latest).toEqual(next)
    const firstRepair = signRsiOwnerRepairOverlay({ ...repairInput, sequence: 1, previousDigest: null }, privateKey,
      resources, bootstrapSource, [])
    const secondRepair = signRsiOwnerRepairOverlay({ ...repairInput, previousDigest: rsiHostUpdateOverlayDigest(firstRepair) },
      privateKey, resources, bootstrapSource, [firstRepair])
    expect(read([firstRepair, secondRepair]).latest).toEqual(secondRepair)
    expect(() => read([host, { ...repair, activationId: 'forged' }])).toThrow('repair overlay shape')
    expect(() => read([host, { ...repair, currentPlanId: 'forged' }])).toThrow('repair overlay shape')
    expect(() => read([host, { ...repair, previousDigest: newSha }])).toThrow('repair overlay shape')
    expect(() => read([host, { ...repair, repair: { ...repair.repair, after: {
      ...repair.repair.after, journalDigest: oldSha } } }])).toThrow('signature')
    expect(() => signRsiOwnerRepairOverlay(repairInput, foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      resources, bootstrapSource, [host])).toThrow('signature')
    expect(() => signRsiOwnerRepairOverlay({ ...repairInput, repair: { ...repairInput.repair,
      before: { ...repairInput.repair.before, files: { '/outside/manifest.json': oldSha } } } },
    privateKey, resources, bootstrapSource, [host])).toThrow('repair overlay shape')
    expect(() => signRsiOwnerRepairOverlay({ ...repairInput, patches: { ...repairInput.patches, extra: oldSha } },
      privateKey, resources, bootstrapSource, [host])).toThrow('repair overlay shape')
    expect(() => signRsiOwnerRepairOverlay({ ...repairInput, repair: { ...repairInput.repair,
      before: { ...repairInput.repair.before, runtimeReceiptDigest: 'invalid' } } },
    privateKey, resources, bootstrapSource, [host])).toThrow('repair overlay shape')
  })

  test('program update is purpose-bound and composes with legacy repair and Host records', () => {
    const keys = generateKeyPairSync('ed25519'), foreign = generateKeyPairSync('ed25519')
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const resources = { installationId: 'install-1', configRoot: '/home/rsi-authorities/target/config',
      identities: { host: { authority: 'host-install-1', keyId: 'host-install-1-key',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } } as RsiAuthorityResources
    const bootstrapSource = '{"schemaVersion":1}\n'
    const manifestPath = `${resources.configRoot}/manifest.json`
    const common = { schemaVersion: 1 as const, transactionId: 'txn', dshHome: '/home', targetProfile: 'target',
      installationId: 'install-1', sequence: 1, previousDigest: null,
      bootstrapDigest: createHash('sha256').update(bootstrapSource).digest('hex'),
      files: { [manifestPath]: oldSha }, patches: { target: oldSha, coordinator: oldSha },
      runtimeReceiptDigest: oldSha, planDigest: oldSha,
      result: { schemaVersion: 1 as const, manifestPath, manifestDigest: oldSha,
        targetProfile: 'target', coordinatorProfile: 'coordinator' }, issuedAt: 1,
      authority: 'host-install-1', keyId: 'host-install-1-key' }
    const repair = signRsiOwnerRepairOverlay({ ...common, kind: 'rsi-owner-repair-overlay',
      repair: { sourceMaintenanceDigest: oldSha, permissionPreset: 'workspace-write',
        before: { files: common.files, patches: common.patches, runtimeReceiptDigest: oldSha,
          creationReceiptDigest: oldSha, journalDigest: oldSha },
        after: { creationReceiptDigest: newSha, journalDigest: newSha } } },
    privateKey, resources, bootstrapSource, [])
    const input = { ...common, kind: 'rsi-owner-program-update-overlay' as const, transactionId: 'update',
      sequence: 2, previousDigest: rsiHostUpdateOverlayDigest(repair), issuedAt: 2,
      update: { sourceMaintenanceDigest: oldSha, authorityDigest: oldSha, hostPlanDigest: oldSha,
        before: { files: common.files, patches: common.patches, runtimeReceiptDigest: oldSha,
          creationReceiptDigest: newSha, journalDigest: newSha },
        after: { creationReceiptDigest: oldSha, journalDigest: oldSha } } }
    const update = signRsiOwnerProgramUpdateOverlay(input, privateKey, resources, bootstrapSource, [repair])
    const host = signRsiHostUpdateOverlay({ ...common, kind: 'rsi-host-update-overlay', transactionId: 'host',
      currentPlanId: 'plan', activationId: 'activation', sequence: 3,
      previousDigest: rsiHostUpdateOverlayDigest(update), issuedAt: 3 },
    privateKey, resources, bootstrapSource, [repair, update])
    const read = (records: unknown[]) => readRsiHostUpdateOverlayChain({ source: JSON.stringify({ schemaVersion: 1,
      kind: 'rsi-host-update-overlays', records }), resources, dshHome: '/home', profile: 'target', bootstrapSource })
    expect(read([repair, update, host]).latest).toEqual(host)
    expect(() => read([repair, { ...update, kind: 'rsi-owner-repair-overlay' }])).toThrow('repair overlay shape')
    expect(() => read([repair, { ...update, kind: 'rsi-host-update-overlay' }])).toThrow('overlay shape')
    expect(() => read([repair, { ...update, kind: 'unknown' }])).toThrow('overlay shape')
    expect(() => read([update, repair])).toThrow('program update overlay shape')
    expect(() => read([repair, { ...update, sequence: 4 }])).toThrow('program update overlay shape')
    expect(() => read([repair, { ...update, update: { ...update.update, authorityDigest: newSha } }]))
      .toThrow('program update overlay signature')
    expect(() => signRsiOwnerProgramUpdateOverlay(input,
      foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), resources, bootstrapSource, [repair]))
      .toThrow('program update overlay signature')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      update: { ...input.update, authorityDigest: 'bad' } }, privateKey, resources, bootstrapSource, [repair]))
      .toThrow('program update overlay shape')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      files: { ...input.files, '/outside/file': oldSha } }, privateKey, resources, bootstrapSource, [repair]))
      .toThrow('program update overlay shape')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      patches: { ...input.patches, extra: oldSha } }, privateKey, resources, bootstrapSource, [repair]))
      .toThrow('program update overlay shape')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      result: { ...input.result, manifestDigest: newSha } }, privateKey, resources, bootstrapSource, [repair]))
      .toThrow('program update overlay shape')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      update: { ...input.update, before: { ...input.update.before, files: {} } } },
    privateKey, resources, bootstrapSource, [repair])).toThrow('program update overlay shape')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input, activationId: 'forged' } as typeof input,
      privateKey, resources, bootstrapSource, [repair])).toThrow('program update overlay shape')
  })

  test('program update binds one signed adoption handoff with exact sealed-history metadata', () => {
    const keys = generateKeyPairSync('ed25519')
    const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const resources = { installationId: 'install-1', configRoot: '/home/rsi-authorities/target/config',
      stateRoot: '/home/rsi-authorities/target/state',
      identities: { host: { authority: 'host-install-1', keyId: 'host-install-1-key',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } } as RsiAuthorityResources
    const bootstrapSource = '{"schemaVersion":1}\n'
    const manifestPath = `${resources.configRoot}/manifest.json`
    const logicalPath = `${resources.stateRoot}/control-plane/creation-adoptions.sqlite`
    const archiveDirectory = `${resources.stateRoot}/control-plane/creation-adoptions.sealed`
    const fileIdentity = { dev: '16777232', ino: '42', uid: 501, gid: 20, mode: 0o100600, nlink: 1 as const }
    const sealed = { protocol: 'dsh-owner-sealed-adoption-handoff/v1' as const, transactionId: 'update', logicalPath,
      archiveLogicalPath: `${archiveDirectory}/${'c'.repeat(64)}.sqlite`, planDigest: oldSha, proofDigest: oldSha,
      hostAnchor: oldSha, archiveDigest: newSha, pendingReverificationDigest: newSha, fileIdentity,
      archiveFileIdentity: { ...fileIdentity, ino: '43', mode: 0o100400 }, inheritedUsage: { adoptions: 3, calls: 7 } }
    const empty = { protocol: 'dsh-owner-empty-adoption-handoff/v1' as const, transactionId: 'update', logicalPath,
      planDigest: oldSha, proofDigest: oldSha, hostAnchor: oldSha, fileIdentity }
    const input = { schemaVersion: 1 as const, kind: 'rsi-owner-program-update-overlay' as const, transactionId: 'update',
      dshHome: '/home', targetProfile: 'target', installationId: 'install-1', sequence: 1, previousDigest: null,
      bootstrapDigest: createHash('sha256').update(bootstrapSource).digest('hex'),
      files: { [manifestPath]: oldSha }, patches: { target: oldSha, coordinator: oldSha },
      runtimeReceiptDigest: oldSha, planDigest: oldSha,
      result: { schemaVersion: 1 as const, manifestPath, manifestDigest: oldSha,
        targetProfile: 'target', coordinatorProfile: 'coordinator' }, issuedAt: 1,
      authority: 'host-install-1', keyId: 'host-install-1-key',
      update: { sourceMaintenanceDigest: oldSha, authorityDigest: oldSha, hostPlanDigest: oldSha,
        sealedAdoptionHandoff: sealed,
        before: { files: { [manifestPath]: oldSha }, patches: { target: oldSha, coordinator: oldSha },
          runtimeReceiptDigest: oldSha, creationReceiptDigest: oldSha, journalDigest: oldSha },
        after: { creationReceiptDigest: newSha, journalDigest: newSha } } }
    const signWith = (handoff: Record<string, unknown>) => signRsiOwnerProgramUpdateOverlay({ ...input,
      update: { ...input.update, sealedAdoptionHandoff: handoff as typeof sealed } }, privateKey, resources, bootstrapSource, [])
    const read = (records: unknown[]) => readRsiHostUpdateOverlayChain({ source: JSON.stringify({ schemaVersion: 1,
      kind: 'rsi-host-update-overlays', records }), resources, dshHome: '/home', profile: 'target', bootstrapSource })

    const update = signRsiOwnerProgramUpdateOverlay(input, privateKey, resources, bootstrapSource, [])
    expect(read([update]).latest).toEqual(update)
    expect(signWith({ ...sealed, inheritedUsage: { adoptions: 0, calls: 0 } }).update.sealedAdoptionHandoff?.inheritedUsage)
      .toEqual({ adoptions: 0, calls: 0 })
    for (const archiveFileIdentity of [{ ...sealed.archiveFileIdentity, mode: 0o400 },
      { ...fileIdentity, dev: '16777233', mode: 0o100400 }])
      expect(signWith({ ...sealed, archiveFileIdentity }).update.sealedAdoptionHandoff?.archiveFileIdentity)
        .toEqual(archiveFileIdentity)
    const { sealedAdoptionHandoff: _, ...emptyUpdate } = input.update
    expect(signRsiOwnerProgramUpdateOverlay({ ...input, update: { ...emptyUpdate, emptyAdoptionHandoff: empty } },
      privateKey, resources, bootstrapSource, []).update.emptyAdoptionHandoff).toEqual(empty)

    const { pendingReverificationDigest: __, ...missing } = sealed
    const malformed: Record<string, unknown>[] = [
      { ...sealed, extra: true }, missing,
      { ...sealed, protocol: 'dsh-owner-empty-adoption-handoff/v1' },
      { ...sealed, transactionId: 'other' },
      { ...sealed, logicalPath: `${resources.stateRoot}/control-plane/other.sqlite` },
      { ...sealed, logicalPath: sealed.archiveLogicalPath },
      ...['planDigest', 'proofDigest', 'hostAnchor', 'archiveDigest', 'pendingReverificationDigest'].flatMap(key => [
        { ...sealed, [key]: 'A'.repeat(64) }, { ...sealed, [key]: 'a'.repeat(63) }, { ...sealed, [key]: 1 }]),
      ...(['fileIdentity', 'archiveFileIdentity'] as const).flatMap(key => [
        { ...sealed, [key]: { ...sealed[key], nlink: 2 } },
        { ...sealed, [key]: { ...sealed[key], dev: 16777232 } },
        { ...sealed, [key]: { ...sealed[key], ino: '042' } },
        { ...sealed, [key]: { ...sealed[key], uid: -1 } },
        { ...sealed, [key]: { ...sealed[key], mode: 1.5 } },
        { ...sealed, [key]: { ...sealed[key], extra: 1 } },
        { ...sealed, [key]: { dev: '1', ino: '2', uid: 0, gid: 0, mode: 0o100400 } },
        { ...sealed, [key]: null }]),
      { ...sealed, archiveFileIdentity: { ...sealed.archiveFileIdentity, ino: fileIdentity.ino } },
      { ...sealed, archiveFileIdentity: { ...fileIdentity, mode: 0o100400 } },
      ...[0o100600, 0o100444, 0o100000, 0o100500, 0o100440, 0o600].map(mode =>
        ({ ...sealed, archiveFileIdentity: { ...sealed.archiveFileIdentity, mode } })),
      { ...sealed, inheritedUsage: { adoptions: -1, calls: 0 } },
      { ...sealed, inheritedUsage: { adoptions: 0, calls: 1.5 } },
      { ...sealed, inheritedUsage: { adoptions: 0, calls: Number.MAX_SAFE_INTEGER + 1 } },
      { ...sealed, inheritedUsage: { adoptions: '1', calls: 0 } },
      { ...sealed, inheritedUsage: { adoptions: 0 } },
      { ...sealed, inheritedUsage: { adoptions: 0, calls: 0, extra: 0 } },
      { ...sealed, inheritedUsage: [0, 0] },
      ...[`${resources.stateRoot}/control-plane/creation-adoptions.archive/${'c'.repeat(64)}.sqlite`,
        `${resources.configRoot}/control-plane/creation-adoptions.sealed/${'c'.repeat(64)}.sqlite`,
        `${archiveDirectory}/nested/${'c'.repeat(64)}.sqlite`,
        `${archiveDirectory}/../${'c'.repeat(64)}.sqlite`,
        `${archiveDirectory}/${'C'.repeat(64)}.sqlite`,
        `${archiveDirectory}/${'c'.repeat(63)}.sqlite`,
        `${archiveDirectory}/${'c'.repeat(64)}.db`,
        `${archiveDirectory}/${'c'.repeat(64)}.sqlite-wal`,
        `${archiveDirectory}/${'c'.repeat(64)}`,
        `${archiveDirectory}${'c'.repeat(64)}.sqlite`,
        `relative/creation-adoptions.sealed/${'c'.repeat(64)}.sqlite`,
        42].map(archiveLogicalPath => ({ ...sealed, archiveLogicalPath }))]
    for (const handoff of malformed) expect(() => signWith(handoff)).toThrow('sealed adoption handoff metadata differs')
    expect(() => signWith(null as unknown as Record<string, unknown>)).toThrow('sealed adoption handoff metadata differs')

    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      update: { ...input.update, emptyAdoptionHandoff: empty } }, privateKey, resources, bootstrapSource, []))
      .toThrow('program update overlay shape')
    expect(() => read([{ ...update, update: { ...update.update, emptyAdoptionHandoff: empty } }]))
      .toThrow('program update overlay shape')
    expect(() => signRsiOwnerProgramUpdateOverlay({ ...input,
      update: { ...input.update, unknownAdoptionHandoff: sealed } } as typeof input, privateKey, resources, bootstrapSource, []))
      .toThrow('program update overlay shape')

    expect(() => read([{ ...update, update: { ...update.update, sealedAdoptionHandoff: {
      ...sealed, inheritedUsage: { adoptions: 3, calls: 8 } } } }])).toThrow('program update overlay signature')
    expect(() => read([{ ...update, update: { ...update.update, sealedAdoptionHandoff: {
      ...sealed, archiveLogicalPath: `${archiveDirectory}/${'d'.repeat(64)}.sqlite` } } }]))
      .toThrow('program update overlay signature')
    expect(() => read([{ ...update, update: { ...update.update, sealedAdoptionHandoff: {
      ...sealed, archiveFileIdentity: { ...sealed.archiveFileIdentity, ino: '44' } } } }]))
      .toThrow('program update overlay signature')
    expect(() => read([{ ...update, update: emptyUpdate }])).toThrow('program update overlay signature')

    // Review-lane handoff summary: exact keys, LANES order, headDigest null iff empty, at least one handed off.
    const reviews = { protocol: 'dsh-owner-review-grant-handoffs/v1' as const, transactionId: 'update', digest: newSha,
      lanes: [{ lane: 'creation-reviews' as const, status: 'handed-off' as const, headDigest: oldSha },
        { lane: 'revision-reviews' as const, status: 'empty' as const, headDigest: null }] }
    const signReviews = (value: unknown) => signRsiOwnerProgramUpdateOverlay({ ...input,
      update: { ...input.update, reviewGrantHandoffs: value as typeof reviews } }, privateKey, resources, bootstrapSource, [])
    const withReviews = signReviews(reviews)
    expect(read([withReviews]).latest).toEqual(withReviews)
    const lane = reviews.lanes[0]!, empty2 = reviews.lanes[1]!
    for (const bad of [
      { ...reviews, extra: 1 }, { ...reviews, protocol: 'other' }, { ...reviews, transactionId: 'other' },
      { ...reviews, digest: 'A'.repeat(64) }, { ...reviews, digest: undefined }, { ...reviews, lanes: [] }, { ...reviews, lanes: {} },
      { ...reviews, lanes: [lane, empty2, empty2, empty2] },
      { ...reviews, lanes: [empty2, lane] },
      { ...reviews, lanes: [lane, lane] },
      { ...reviews, lanes: [{ ...lane, lane: 'source-reviews' }] },
      { ...reviews, lanes: [{ ...lane, headDigest: null }] },
      { ...reviews, lanes: [{ ...lane, headDigest: 'a'.repeat(63) }] },
      { ...reviews, lanes: [lane, { ...empty2, headDigest: oldSha }] },
      { ...reviews, lanes: [{ ...lane, status: 'sealed' }] },
      { ...reviews, lanes: [{ ...lane, grants: [] }] },
      { ...reviews, lanes: [empty2] },
      null,
    ]) expect(() => signReviews(bad)).toThrow('review grant handoffs metadata differs')
    // The signature covers the summary; review handoffs compose with the sealed adoption handoff.
    expect(() => read([{ ...withReviews, update: { ...withReviews.update, reviewGrantHandoffs: { ...reviews, digest: oldSha } } }]))
      .toThrow('program update overlay signature')
    expect(() => read([{ ...withReviews, update: { ...withReviews.update, reviewGrantHandoffs: { ...reviews,
      lanes: [{ ...lane, headDigest: newSha }, empty2] } } }])).toThrow('program update overlay signature')
    const { reviewGrantHandoffs: _reviews, ...withoutReviews } = withReviews.update
    expect(() => read([{ ...withReviews, update: withoutReviews }])).toThrow('program update overlay signature')
  })

})
