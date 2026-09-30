import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { ControlPlaneDatabaseError, ControlPlaneStore, controlPlaneDigest, hostMaintenanceCanonical, hostMaintenanceDigest,
  signSourceMaintenanceRecord, sourceBaselineChain, sourceMaintenanceDigest, verifySourceMaintenanceRecords,
  type SourceMaintenanceAnchor, type SourceMaintenanceRecord } from '@dsh-enhanced/plugin-control-plane'
import { rsiBuildResources as io } from './rsi-build.js'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { prepareRsiAuthorityResources } from './rsi-authority-resources.js'
import type { RsiLocalCohort } from './rsi-local-cohort.js'
import type { RsiLocalUpdatePreparation } from './rsi-local-update.js'
import { readRsiSourceMaintenance } from './rsi-source-maintenance.js'

const HASH = /^[a-f0-9]{64}$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
function fail(message: string): never { throw new Error(`rsi local activation: ${message}`) }
function canonical(path: string): boolean { return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0') }
function inside(root: string, path: string): boolean { return path === root || path.startsWith(`${root}${sep}`) }
async function privateHostKey(path: string): Promise<string> {
  const item = await lstat(path)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1 || item.size > 16_384
    || (item.mode & 0o077) !== 0 || process.getuid && item.uid !== process.getuid()) fail(`unsafe Host key: ${path}`)
  return (await io.readStable(path, 16_384, true)).toString('utf8')
}

export type LiveRsiSourceMaintenance = Awaited<ReturnType<typeof readRsiSourceMaintenance>>

export interface ProduceRsiLocalMaintenanceInput {
  /** Logical Home path; every receipt and ledger field retains this path. */
  logicalHome: string
  profile: string
  /** Locked, TOCTOU-verified preparation produced outside the Home tree. */
  preparation: RsiLocalUpdatePreparation
  /** Physical path of the copied, already stopped Home stage with the next cohort materialized. */
  stagePhysicalHome: string
  /** Signed maintenance state read from the live Home before the stage was copied. */
  live: LiveRsiSourceMaintenance
  /** The next cohort receipt after its paths were rewritten to the logical Home. */
  nextCohort: Pick<RsiLocalCohort, 'sourceCommit' | 'version' | 'receiptDigest'>
  /** An absent ledger never selects pre-owner implicitly. */
  maintenanceMode?: 'owner-ledger' | 'pre-owner'
  now?: () => number
  signal?: AbortSignal
}

export interface AssertRsiPreOwnerInstallationInput {
  logicalHome: string
  physicalHome: string
  profile: string
  /** Optional frozen expectations. Both are revalidated against real files. */
  anchor?: SourceMaintenanceAnchor
  /** Expected sidecar in physicalHome; defaults to the current live sidecar.
   * A caller checking a newly maintained stage supplies its full next chain. */
  records?: readonly SourceMaintenanceRecord[]
  /** CLI --patch overlays are outside this copied Home proof and unsupported. */
  extraPatchFiles?: readonly string[]
  signal?: AbortSignal
}
export interface RsiPreOwnerInstallationProof {
  mode: 'pre-owner'
  anchor: SourceMaintenanceAnchor
  records: readonly SourceMaintenanceRecord[]
  workspace: LiveRsiSourceMaintenance['workspace']
  sourceChainTip: string
  originalBootstrapDigest: string
  authorityBootstrapDigest: string
}

async function assertAbsent(path: string): Promise<void> {
  try { await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  fail(`pre-owner residue exists: ${path}`)
}
async function optionalBytes(path: string, maximum: number, privateMode = true): Promise<Buffer | undefined> {
  try { await lstat(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const item = await lstat(path)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1
    || item.size > maximum || (item.mode & 0o022) !== 0 || await realpath(path) !== path) fail(`unsafe pre-owner file: ${path}`)
  return io.readStable(path, maximum, privateMode)
}

const PRE_OWNER_FIELDS = new Set(['sourceJobs', 'sourceApprovals', 'sourceReleases', 'sourceReleaseExecution',
  'sourceAdoptions', 'sourceBuild', 'runtimeObserver', 'foregroundDeployments', 'taskObservations', 'adoptionCoordinator',
  'memoryReviews', 'automaticLearning'])
function assertPreOwnerConfiguration(source: string, path: string, authorityConfig: string): void {
  const document = parseDocument(source, { uniqueKeys: true,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] })
  if (document.errors.length || document.warnings.length || !isSeq(document.contents)) throw new Error(`rsi local activation: pre-owner configuration layer is invalid: ${path}`)
  const inspect = (node: unknown): void => {
    if (isScalar(node)) {
      const value: unknown = node.value
      if (typeof value === 'string' && value.includes(authorityConfig)) fail(`pre-owner layer references owner authority configuration: ${path}`)
      if (node.tag === 'tag:yaml.org,2002:js' && typeof value === 'string'
        && [...PRE_OWNER_FIELDS].some(field => new RegExp(`\\b${field}\\b`, 'u').test(value))) fail(`pre-owner dynamic owner configuration is unsupported: ${path}`)
    } else if (isMap(node)) for (const pair of node.items) {
      const key: unknown = isScalar(pair.key) ? pair.key.value : undefined
      const value: unknown = isScalar(pair.value) ? pair.value.value : pair.value
      if (typeof key === 'string' && PRE_OWNER_FIELDS.has(key) && value !== null && value !== false) fail(`pre-owner layer contains owner source configuration: ${path}`)
      inspect(pair.key); inspect(pair.value)
    } else if (isSeq(node)) node.items.forEach(inspect)
  }
  for (const row of document.contents.items) {
    if (!isMap(row)) fail(`pre-owner dynamic or non-mapping row is unsupported: ${path}`)
    const identity = ['name', 'module', 'id'].map(key => row.get(key, true))
      .filter(isScalar).map(node => String(node!.value)).join(' ')
    if (/rsi-setup-/u.test(identity)) fail(`pre-owner layer contains an RSI owner row: ${path}`)
    if (/cordis-plugin-(?:include|loader)/u.test(identity)) fail(`pre-owner include or Loader override is unsupported: ${path}`)
    const config = row.get('config', true)
    if (identity.includes('assistant-memory-learning') && ((row.get('disabled') as unknown) !== true || config !== undefined)) {
      fail(`pre-owner memory learner is not inert: ${path}`)
    }
    if (identity.includes('plugin-control-plane') && isScalar(config) && config.tag === 'tag:yaml.org,2002:js') fail(`pre-owner dynamic control-plane configuration is unsupported: ${path}`)
    inspect(row)
  }
}

/** Read-only absence proof for an installation whose authority bootstrap exists
 * but owner grants, coordinator and control ledger have never been installed.
 * It neither creates a ledger nor interprets a partial owner setup as fresh.
 * Only Home/profile cordis.yml and cordis.patch.yml layers are supported.
 * Alternate formats, dynamic owner rows/config, includes and explicit CLI
 * overlays are rejected. The outer transaction must verify the effective
 * graph and launch arguments, and owns package/Git materialization checks. */
export async function assertRsiPreOwnerInstallation(input: AssertRsiPreOwnerInstallationInput): Promise<RsiPreOwnerInstallationProof> {
  if (!canonical(input.logicalHome) || !canonical(input.physicalHome) || !PROFILE.test(input.profile)) fail('invalid pre-owner Home or profile')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  signal.throwIfAborted()
  if (input.extraPatchFiles?.length) fail('pre-owner external --patch overrides are unsupported')
  if (await realpath(input.logicalHome) !== input.logicalHome || await realpath(input.physicalHome) !== input.physicalHome) fail('pre-owner Homes must be physical')
  const live = await readRsiSourceMaintenance({ logicalHome: input.logicalHome, physicalHome: input.logicalHome, profile: input.profile, signal })
  if (input.anchor && controlPlaneDigest(input.anchor) !== controlPlaneDigest(live.anchor)) fail('pre-owner installation anchor changed')
  const resources = await prepareRsiAuthorityResources({ dshHome: input.logicalHome, profile: input.profile, existingOnly: true, signal })
  if (resources.installationId !== live.anchor.installationId || resources.ledgerId !== live.anchor.ledger.id
    || controlPlaneDigest(resources.identities.host.publicKeyPem) !== controlPlaneDigest(live.anchor.hostIdentity.publicKeyPem)) fail('pre-owner authority anchor changed')
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
  const authorityRelative = join('rsi-authorities', input.profile)
  const sourceRelative = join('rsi-sources', input.profile)
  const authorityBootstrap = await io.readStable(join(input.logicalHome, authorityRelative, 'bootstrap.json'), 65_536, true)
  const sourceBootstrap = await io.readStable(join(input.logicalHome, sourceRelative, 'bootstrap.json'), 65_536, true)
  const profileDigest = createHash('sha256').update(input.profile).digest('hex')
  const coordinator = `rsi-${input.profile.slice(0, 43)}-${profileDigest.slice(0, 12)}`
  for (const home of new Set([input.logicalHome, input.physicalHome])) {
    signal.throwIfAborted()
    const authority = join(home, authorityRelative)
    await io.directory(authority)
    await io.directory(join(home, sourceRelative))
    if ((await readdir(authority)).sort().join(',') !== 'bootstrap.json,catalog.json,config,identities,registry,state') fail(`pre-owner authority layout differs: ${authority}`)
    for (const name of ['config', 'state', 'registry']) {
      const directory = join(authority, name); await io.directory(directory)
      if ((await readdir(directory)).length) fail(`pre-owner ${name} is not empty: ${directory}`)
    }
    const catalog = JSON.parse((await io.readStable(join(authority, 'catalog.json'), 2_097_152, true)).toString('utf8')) as unknown
    if (controlPlaneDigest(catalog) !== controlPlaneDigest({ schemaVersion: 1, entries: [] })) fail(`pre-owner catalog is not empty: ${authority}`)
    if (!(await io.readStable(join(authority, 'bootstrap.json'), 65_536, true)).equals(authorityBootstrap)
      || !(await io.readStable(join(home, sourceRelative, 'bootstrap.json'), 65_536, true)).equals(sourceBootstrap)) fail('pre-owner live and staged bootstraps differ')
    const keys = join(authority, 'identities'); await io.directory(keys)
    if ((await readdir(keys)).sort().join(',') !== Object.keys(resources.identities).map(role => `${role}.pem`).sort().join(',')) fail('pre-owner signing identities differ')
    for (const [role, identity] of Object.entries(resources.identities)) {
      const actual = await privateHostKey(join(keys, `${role}.pem`))
      const expected = await privateHostKey(identity.keyPath)
      if (actual !== expected) fail(`pre-owner signing identity differs: ${role}`)
    }
    for (const path of [join(home, 'profiles', coordinator), join(home, 'rsi-coordinators', coordinator),
      join(home, `.rsi-coordinator-${profileDigest.slice(0, 16)}.json`), join(home, '.rsi-setup-journal.json')]) await assertAbsent(path)
    const profileRoot = join(home, 'profiles', input.profile)
    for (const root of [home, profileRoot]) {
      for (const name of ['cordis.yaml', 'cordis.patch.yaml', 'cordis.json', 'cordis.patch.json']) {
        const unsupported = await optionalBytes(join(root, name), 2_097_152, false)
        if (unsupported) fail(`pre-owner configuration layer is unsupported: ${join(root, name)}`)
      }
      for (const name of ['cordis.patch.yml', 'cordis.yml']) {
        const path = join(root, name), bytes = await optionalBytes(path, 2_097_152, false)
        if (bytes) assertPreOwnerConfiguration(bytes.toString('utf8'), path, join(input.logicalHome, authorityRelative, 'config'))
      }
    }

  }
  const sidecar = await optionalBytes(join(input.physicalHome, sourceRelative, 'maintenance.json'), 4_194_304)
  const parsed: unknown = sidecar ? JSON.parse(sidecar.toString('utf8')) : []
  if (!Array.isArray(parsed) || parsed.length > 256 || sidecar && !parsed.length) fail('pre-owner source maintenance sidecar is invalid')
  const records = verifySourceMaintenanceRecords(parsed as SourceMaintenanceRecord[], live.anchor)
  const expected = input.records ?? live.records
  verifySourceMaintenanceRecords(expected, live.anchor)
  if (expected.length < live.records.length || expected.length > live.records.length + 1
    || live.records.some((record, index) => sourceMaintenanceDigest(record) !== sourceMaintenanceDigest(expected[index]!))) fail('pre-owner live sidecar changed or staged chain does not extend it')
  if (records.some(record => record.host !== null) || live.records.some(record => record.host !== null)
    || expected.some(record => record.host !== null)) fail('pre-owner maintenance contains owner Host activation evidence')
  if (controlPlaneDigest(records) !== controlPlaneDigest(expected)) fail('pre-owner sidecar differs from the expected maintenance chain')
  const sourceChainTip = sourceBaselineChain(live.anchor.baseline, [], records).at(-1)!
  sourceBaselineChain(live.anchor.baseline, [], live.records)
  signal.throwIfAborted()
  return { mode: 'pre-owner', anchor: live.anchor, records, workspace: live.workspace, sourceChainTip,
    originalBootstrapDigest: live.originalBootstrapDigest, authorityBootstrapDigest: digest(authorityBootstrap) }
}

type ActivationState = { kind: 'watched'; planId: string } | { kind: 'unsettled' } | { kind: 'none' }

function openReadOnlyLedger(path: string, label: string): ControlPlaneStore {
  try {
    return new ControlPlaneStore({ path, readOnly: true })
  } catch (error) {
    if (error instanceof ControlPlaneDatabaseError) fail(`${label} control ledger is unavailable: ${error.message}`)
    throw error
  }
}

function sameActivationState(left: ActivationState, right: ActivationState): boolean {
  return left.kind === right.kind && (left.kind !== 'watched' || left.planId === (right as { planId: string }).planId)
}

function watchedDeployment(store: ControlPlaneStore, input: ProduceRsiLocalMaintenanceInput,
  state: Extract<ActivationState, { kind: 'watched' }>) {
  const context = store.currentRuntimeEpochDeployment(join(input.logicalHome, 'profiles', input.profile))
  const { plan, readiness } = context, receipt = readiness.receipt, anchor = input.live.anchor
  if (!receipt) throw new Error('rsi local activation: runtime epoch readiness receipt is absent')
  if (plan.id !== state.planId || plan.installationId !== anchor.installationId
    || controlPlaneDigest(plan.ledger) !== controlPlaneDigest(anchor.ledger)
    || plan.target.dshHome !== input.logicalHome || plan.profile !== input.profile
    || receipt.authority !== anchor.hostIdentity.authority || receipt.keyId !== anchor.hostIdentity.keyId) {
    fail('watched readiness was not issued by the installed Host identity or deployment')
  }
  const { signature, ...unsigned } = receipt
  if (!verify(null, Buffer.from(hostMaintenanceCanonical(unsigned)), createPublicKey(anchor.hostIdentity.publicKeyPem),
    Buffer.from(signature, 'base64'))) fail('watched original Host readiness signature changed')
  return context
}

/**
 * Derive the next Host-signed source maintenance record for a frozen local
 * update, without mutating anything. The caller applies it to the stopped stage
 * and appends it to the staged ledger as one owned transaction.
 *
 * Explicit pre-owner mode uses a read-only absence proof and an empty release
 * history; it signs host:null without creating either ledger. In owner mode,
 * both the live ledger and the copied stage ledger are opened strictly
 * read-only and must already exist at the current schema. Their release history,
 * maintenance rows, and activation classification must agree byte-for-byte.
 * When the stage anchors a watched runtime epoch, the record binds that plan and
 * its original applied readiness receipt; with no watch the record carries
 * `host: null`. Any other activation state, or any failure to read a watched
 * deployment, aborts production — it is never silently downgraded, because the
 * ledger append rejects a mismatched anchor anyway.
 */
export async function produceRsiLocalSourceMaintenance(input: ProduceRsiLocalMaintenanceInput): Promise<SourceMaintenanceRecord> {
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  if (!canonical(input.logicalHome) || !canonical(input.stagePhysicalHome) || !PROFILE.test(input.profile)) fail('invalid activation Home or profile')
  const livePhysicalHome = await realpath(input.logicalHome)
  const stagePhysicalHome = await realpath(input.stagePhysicalHome)
  if (stagePhysicalHome !== input.stagePhysicalHome || inside(livePhysicalHome, stagePhysicalHome)
    || inside(stagePhysicalHome, livePhysicalHome)) {
    fail('activation stage must be a distinct stopped copy outside the live Home')
  }
  signal.throwIfAborted()
  const { preparation } = input
  if (preparation.dshHome !== input.logicalHome || preparation.profile !== input.profile) fail('preparation is bound to another Home')
  const anchor: SourceMaintenanceAnchor = input.live.anchor
  const source = preparation.source
  if (anchor.repository !== join(input.logicalHome, 'rsi-sources', input.profile, 'checkout')
    || anchor.ledger.path !== join(input.logicalHome, 'rsi-authorities', input.profile, 'state', 'control-plane', 'control.sqlite')
    || controlPlaneDigest(anchor.baseline) !== controlPlaneDigest(input.live.workspace.baseline)) fail('source installation anchor changed')
  verifySourceMaintenanceRecords(input.live.records, anchor)
  if (input.live.originalBootstrapDigest !== source.originalBootstrapDigest) fail('source bootstrap identity changed')
  if (input.nextCohort.sourceCommit !== source.sourceCommit || input.nextCohort.version !== source.version
    || !HASH.test(input.nextCohort.receiptDigest)) fail('next cohort does not match the prepared source')

  // The ledger is the authority for published release edges; the signed sidecar
  // only covers maintenance edges. Live and copied-stage ledgers must agree with
  // the sidecar before the chain is extended.
  const mode = input.maintenanceMode ?? 'owner-ledger'
  if (mode !== 'owner-ledger' && mode !== 'pre-owner') fail('invalid maintenance mode')
  let currentTip: string
  let liveState: ActivationState = { kind: 'none' }
  let liveSnapshotDigest = ''
  let liveDeploymentDigest: string | undefined
  let liveHistory: ReturnType<ControlPlaneStore['readSourceMaintenanceState']>['history']
  if (mode === 'pre-owner') {
    const proof = await assertRsiPreOwnerInstallation({ logicalHome: input.logicalHome, physicalHome: stagePhysicalHome,
      profile: input.profile, anchor, records: input.live.records, signal })
    if (proof.originalBootstrapDigest !== input.live.originalBootstrapDigest
      || controlPlaneDigest(proof.workspace) !== controlPlaneDigest(input.live.workspace)) fail('pre-owner source bootstrap or workspace snapshot changed')
    currentTip = proof.sourceChainTip; liveHistory = []
  } else {
    const liveLedger = openReadOnlyLedger(anchor.ledger.path, 'live')
    try {
      const state = liveLedger.readSourceMaintenanceState(anchor.repository)
      const { history, records: ledgerRecords } = state
      liveHistory = history
      if (ledgerRecords.length !== input.live.records.length
        || ledgerRecords.some((record, index) => sourceMaintenanceDigest(record) !== sourceMaintenanceDigest(input.live.records[index]!))) {
        fail('live ledger and sidecar source maintenance histories differ')
      }
      currentTip = sourceBaselineChain(anchor.baseline, history, ledgerRecords).at(-1)!
      liveSnapshotDigest = controlPlaneDigest({ history, records: ledgerRecords })
      liveState = liveLedger.readSourceMaintenanceActivationState(input.logicalHome)
      if (liveState.kind === 'unsettled') fail('live Host activation is unsettled')
      if (liveState.kind === 'watched') liveDeploymentDigest = controlPlaneDigest(watchedDeployment(liveLedger, input, liveState))
    } finally { liveLedger.close() }
  }
  signal.throwIfAborted()

  const prior = input.live.records.at(-1)
  const sequence = input.live.records.length + 1
  const before = prior ? prior.after : { sourceCommit: input.live.workspace.sourceCommit,
    version: input.live.workspace.version, cohortDigest: preparation.originalCohortDigest }
  if (source.repairCommit !== currentTip) fail('prepared repair ref is not the current source chain tip')
  if (prior && prior.after.cohortDigest !== preparation.originalCohortDigest) fail('prepared original cohort is not the signed current cohort')
  if (!prior && !HASH.test(preparation.originalCohortDigest)) fail('original cohort digest is invalid')

  // Probe the STOPPED stage ledger read-only: a missing/corrupt/stale stage is
  // an abort, never an excuse to invent host: null.
  const authorityRoot = join('rsi-authorities', input.profile, 'state', 'control-plane')
  const stageLedgerPath = join(stagePhysicalHome, authorityRoot, 'control.sqlite')
  let host: SourceMaintenanceRecord['host'] = null
  if (mode === 'owner-ledger') {
    const stageLedger = openReadOnlyLedger(stageLedgerPath, 'staged')
    try {
      const { history: stageHistory, records: stageRecords } = stageLedger.readSourceMaintenanceState(anchor.repository)
      if (stageRecords.length !== input.live.records.length
        || stageRecords.some((record, index) => sourceMaintenanceDigest(record) !== sourceMaintenanceDigest(input.live.records[index]!))) {
        fail('staged ledger and live sidecar source maintenance histories differ')
      }
      if (controlPlaneDigest({ history: stageHistory, records: stageRecords }) !== liveSnapshotDigest) {
        fail('staged ledger and live ledger source histories differ')
      }
      const stageState = stageLedger.readSourceMaintenanceActivationState(input.logicalHome)
      if (!sameActivationState(liveState, stageState)) fail('live and staged Host activation states differ')
      if (stageState.kind === 'unsettled') fail('staged Host activation is unsettled')
      if (stageState.kind === 'watched') {
        // A watched epoch must resolve completely. Invalid/conflicting rows abort
        // production; they are never downgraded to an unanchored record.
        const context = watchedDeployment(stageLedger, input, stageState)
        if (controlPlaneDigest(context) !== liveDeploymentDigest) fail('live and staged watched Host deployments differ')
        const receipt = context.readiness.receipt
        if (!receipt) throw new Error('rsi local activation: runtime epoch readiness receipt is absent')
        if (receipt.authority !== anchor.hostIdentity.authority || receipt.keyId !== anchor.hostIdentity.keyId) {
          fail('watched readiness was not issued by the installed Host identity')
        }
        // An owner installation holds exactly one Host key; the watched readiness
        // must have been issued by that same identity for the local key to sign a
        // record the store will accept. The store re-verifies this independently.
        host = { planId: context.plan.id, planDigest: context.plan.digest,
          readinessOperationId: context.readiness.operationId, readinessReceiptDigest: hostMaintenanceDigest(receipt) }
      }
    } finally { stageLedger.close() }
  }
  signal.throwIfAborted()

  const signingKey = await privateHostKey(join(stagePhysicalHome, 'rsi-authorities', input.profile, 'identities', 'host.pem'))
  if (createPublicKey(signingKey).export({ format: 'pem', type: 'spki' }).toString() !== anchor.hostIdentity.publicKeyPem) {
    fail('staged Host key does not match the signed installation anchor')
  }

  const now = input.now ?? Date.now
  const issuedAt = now()
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) fail('invalid signing time')
  if (prior && issuedAt < prior.issuedAt) fail('clock moved backwards before signing the maintenance record')
  const record = signSourceMaintenanceRecord({ schemaVersion: 1, kind: 'dsh-source-maintenance',
    transactionId: `local-update-${sequence}-${preparation.receiptDigest.slice(0, 16)}`,
    installationId: anchor.installationId, ledger: anchor.ledger, repository: anchor.repository,
    baseline: anchor.baseline, sequence, previousDigest: prior ? sourceMaintenanceDigest(prior) : null,
    previousTip: currentTip, candidateTip: source.sourceCommit, upstreamCommit: source.upstreamCommit,
    sourceTree: source.sourceTree, preparationReceiptDigest: source.receiptDigest,
    originalBootstrapDigest: input.live.originalBootstrapDigest, before,
    after: { sourceCommit: source.sourceCommit, version: source.version, cohortDigest: input.nextCohort.receiptDigest },
    host, issuedAt, authority: anchor.hostIdentity.authority, keyId: anchor.hostIdentity.keyId }, signingKey)
  verifySourceMaintenanceRecords([...input.live.records, record], anchor)
  // Reject a duplicate candidate or fork before handing a signed record to the
  // stage transaction; appendSourceMaintenance independently checks this again.
  sourceBaselineChain(anchor.baseline, liveHistory, [...input.live.records, record])
  signal.throwIfAborted()
  return record
}
