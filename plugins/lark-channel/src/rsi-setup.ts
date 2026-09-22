import { constants } from 'node:fs'
import { chmod, lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { ActiveLarkOwnerBindingsSnapshot } from '@dsh-enhanced/assistant-delivery'
import { compileRsiProfiles, type RsiSetupManifest } from './rsi-profile.js'
import { withDshHomeLifecycleLock } from './setup.js'
import { supervisedGrowthBindingQuery, supervisedGrowthDatabasePaths } from './supervised-growth-profile.js'
import { installDshResidentService } from './resident.js'

const MAX_BYTES = 2_097_152
const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(`rsi setup: ${message}`) }

// Compare semantic YAML nodes, including executable !!js tags, without depending
// on comments or formatting retained by the profile patch serializer.
function yamlValue(node: unknown): unknown {
  if (isScalar(node)) return { tag: node.tag, value: node.value }
  if (isSeq(node)) return { tag: node.tag, items: node.items.map(yamlValue) }
  if (isMap(node)) return { tag: node.tag, entries: node.items.map(item => [yamlValue(item.key), yamlValue(item.value)])
    .sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0]))) }
  return node
}
export function assertRsiEffectivePatch(patch: string, effective: string): void {
  const expected = parseDocument(patch), actual = parseDocument(effective)
  if (expected.errors.length || actual.errors.length || !isSeq(expected.contents) || !isSeq(actual.contents)) fail('invalid final profile composition')
  for (const row of expected.contents.items) {
    if (!isMap(row) || !row.has('config')) continue
    const matches = actual.contents.items.filter(item => isMap(item) && item.get('id') === row.get('id'))
    const resolved = matches[0]
    if (matches.length !== 1 || !isMap(resolved) || (resolved.get('disabled') as unknown) === true && (row.get('disabled') as unknown) !== true
      || !isDeepStrictEqual(yamlValue(row.get('config', true)), yamlValue(resolved.get('config', true)))) fail(`effective profile overrides compiled config for ${String(row.get('id'))}`)
  }
}

export interface RsiSetupArgs {
  manifestPath: string; dshHome: string; apply: boolean; rollback: boolean; start: boolean; confirmStopped: boolean; help: boolean
}
export function parseRsiSetupArgs(argv: readonly string[]): RsiSetupArgs {
  const result: RsiSetupArgs = { manifestPath: '', dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
    apply: false, rollback: false, start: false, confirmStopped: false, help: false }
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!
    if (seen.has(key)) fail(`duplicate option ${key}`)
    seen.add(key)
    if (key === '--help' || key === '-h') result.help = true
    else if (key === '--apply') result.apply = true
    else if (key === '--rollback') result.rollback = true
    else if (key === '--start') result.start = true
    else if (key === '--confirm-hosts-stopped') result.confirmStopped = true
    else if (key === '--manifest' || key === '--dsh-home') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail(`${key} needs a value`)
      if (key === '--manifest') result.manifestPath = resolve(value!); else result.dshHome = value!
    } else fail(`unknown option ${key}`)
  }
  if (result.help) return result
  if (!result.manifestPath || !isAbsolute(result.dshHome)) fail('--manifest and absolute DSH_HOME are required')
  if (result.rollback && (result.apply || result.start)) fail('--rollback cannot be combined with --apply or --start')
  if (result.start && !result.apply) fail('--start requires --apply')
  if ((result.apply || result.rollback) && !result.confirmStopped) fail('stop both Hosts and pass --confirm-hosts-stopped')
  return result
}

async function readOwnedFile(path: string, privateFile = true, allowRoot = false): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) fail(`noncanonical file: ${path}`)
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = await descriptor.stat(), linked = await lstat(path)
    if (!entry.isFile() || (!allowRoot && entry.nlink !== 1) || (entry.uid !== process.getuid?.() && !(allowRoot && entry.uid === 0)) || entry.size > MAX_BYTES
      || (entry.mode & (privateFile ? 0o077 : 0o022)) !== 0 || linked.ino !== entry.ino || linked.dev !== entry.dev) fail(`unsafe file: ${path}`)
    return await descriptor.readFile('utf8')
  } finally { await descriptor.close() }
}
async function safeDirectory(path: string): Promise<void> {
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (entry.mode & 0o022) !== 0 || await realpath(path) !== path) fail(`unsafe directory: ${path}`)
}
async function syncDirectory(path: string): Promise<void> {
  const descriptor = await open(path, constants.O_RDONLY)
  try { await descriptor.sync() } finally { await descriptor.close() }
}
async function atomicWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`
  const descriptor = await open(temporary, 'wx', 0o600)
  try { await descriptor.writeFile(value); await descriptor.sync() } finally { await descriptor.close() }
  try { await rename(temporary, path); await chmod(path, 0o600); await syncDirectory(dirname(path)) }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }) }
}

interface JournalEntry { profile: string; before: string; after: string }
interface Journal { schemaVersion: 1; manifestDigest: string; stage: 'prepared' | 'applied'; entries: [JournalEntry, JournalEntry] }
function profiles(manifest: Pick<RsiSetupManifest, 'targetProfile' | 'coordinatorProfile'>): [string, string] {
  const values: [string, string] = [manifest.targetProfile, manifest.coordinatorProfile]
  if (!values.every(value => typeof value === 'string' && profilePattern.test(value)) || values[0] === values[1]) fail('profiles must be distinct canonical names')
  return values
}
function patchPath(home: string, profile: string): string { return join(home, 'profiles', profile, 'cordis.patch.yml') }
async function readJournal(path: string, expected: readonly string[]): Promise<Journal | undefined> {
  let content: string
  try { content = await readOwnedFile(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  const value = JSON.parse(content) as Journal
  if (value.schemaVersion !== 1 || !['prepared', 'applied'].includes(value.stage) || !/^[a-f0-9]{64}$/u.test(value.manifestDigest)
    || !Array.isArray(value.entries) || value.entries.length !== 2
    || value.entries.some((entry, index) => entry.profile !== expected[index] || typeof entry.before !== 'string' || typeof entry.after !== 'string')) fail('journal does not match this profile pair')
  return value
}
async function rollback(home: string, journalPath: string, journal: Journal): Promise<void> {
  // Check both files before restoring either. Retry also accepts a half-restored pair.
  for (const entry of journal.entries) {
    const current = await readOwnedFile(patchPath(home, entry.profile), false)
    if (current !== entry.before && current !== entry.after) fail('profile changed outside setup; retain journal for reconciliation')
  }
  for (const entry of journal.entries) await atomicWrite(patchPath(home, entry.profile), entry.before)
  await unlink(journalPath); await syncDirectory(home)
}

export interface RsiSetupPorts {
  dump(profile: string, home: string): string
  base(profile: string, home: string): Promise<string>
  snapshot(effective: string, home: string): Promise<ActiveLarkOwnerBindingsSnapshot>
  compile: typeof compileRsiProfiles
  validateAuthorities(manifest: RsiSetupManifest, owner: ActiveLarkOwnerBindingsSnapshot['bindings'][number]): Promise<void>
  assertStopped(profile: string): void
  start(profile: string, home: string): Promise<void>
}

const defaultPorts: RsiSetupPorts = {
  async base(profile, home) {
    // Resolve the installed package symlink, then pin a bounded non-writable file.
    const path = await realpath(join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'))
    return readOwnedFile(path, false, true)
  },
  dump(profile, home) {
    const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8', timeout: 60_000,
      maxBuffer: MAX_BYTES, env: { ...process.env, DSH_HOME: home } })
    if (result.status !== 0 || result.error) fail(`cannot compose profile ${profile}`)
    return result.stdout
  },
  async snapshot(effective, home) {
    const { inspectActiveLarkOwnerBindingsLocally } = await import('@dsh-enhanced/assistant-delivery')
    return inspectActiveLarkOwnerBindingsLocally({ databasePath: supervisedGrowthDatabasePaths(effective, home).deliveryDatabasePath,
      ...supervisedGrowthBindingQuery(effective, home) })
  },
  compile: compileRsiProfiles,
  validateAuthorities: validateRsiAuthorities,
  assertStopped(profile) {
    const result = spawnSync('systemctl', ['--user', 'show', `dsh-profile-${profile}.service`, '--property=ActiveState', '--value'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536 })
    if (result.status !== 0 || result.error || !['inactive', 'failed'].includes(result.stdout.trim())) fail(`systemd profile ${profile} must be stopped`)
  },
  async start(profile, home) { await installDshResidentService({ dshHome: home, profile }) },
}

/** Validate imported finite grants, without calling any signing/authorization method. */
export async function validateRsiAuthorities(manifest: RsiSetupManifest, binding: ActiveLarkOwnerBindingsSnapshot['bindings'][number]): Promise<void> {
  const cp: typeof import('@dsh-enhanced/plugin-control-plane') = await import('@dsh-enhanced/plugin-control-plane')
  const config = manifest.controlPlane
  if (!config.sourceJobs || !config.sourceApprovals || !config.sourceReleases || !config.sourceAdoptions || !config.taskObservations) fail('source authority chain is incomplete')
  const approvals: unknown = JSON.parse(await readOwnedFile(config.sourceApprovals!.configPath))
  const releases: unknown = JSON.parse(await readOwnedFile(config.sourceReleases!.configPath))
  const adoptions: unknown = JSON.parse(await readOwnedFile(config.sourceAdoptions!.authority.configPath))
  const observations: unknown = JSON.parse(await readOwnedFile(config.taskObservations!.authority.configPath))
  cp.validateSourceApprovalAuthorityConfig(approvals); cp.validateSourceReleaseAuthorityConfig(releases)
  cp.validateSourceAdoptionAuthorityConfig(adoptions); cp.validateTaskObservationAuthorityConfig(observations)
  const expectedOwner = manifest.sourceReviews.owner
  if (expectedOwner.principalRecordId !== binding.owner.id || expectedOwner.principalVersion !== binding.owner.version) fail('grant owner has changed')
  const trust = await cp.loadTrustConfig(config.trustPath)
  if (trust.schemaVersion !== 4 || !trust.hostAttestor || !trust.releaseAdapters
    || ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission'].some(phase => !Object.hasOwn(trust.releaseAdapters!, phase))) fail('complete release and Host attestation adapters are required')
  const ledgerPath = join(config.statePath, 'control.sqlite')
  const { id, version, path, sha256 } = trust.executor
  for (const authority of [approvals, releases, adoptions, observations]) {
    if (authority.controlDatabasePath !== ledgerPath || !isDeepStrictEqual(authority.grant.owner, expectedOwner)) fail('authority owner/ledger mismatch')
  }
  if (trust.ledger.path !== ledgerPath || adoptions.grant.ledger.path !== ledgerPath
    || !isDeepStrictEqual(adoptions.grant.ledger, trust.ledger) || adoptions.grant.installationId !== trust.installationId
    || adoptions.grant.target.dshHome !== trust.dshHome || trust.catalog.path !== config.catalogPath
    || adoptions.grant.target.profile !== manifest.targetProfile || adoptions.grant.target.profilePath !== config.runtimeObserver?.profilePath
    || adoptions.grant.target.profilePath !== join(trust.dshHome, 'profiles', manifest.targetProfile)
    || !isDeepStrictEqual(adoptions.grant.executor, { id, version, path, sha256 })
    || adoptions.grant.catalogPath !== config.catalogPath || !isDeepStrictEqual(adoptions.grant.handoff, config.sourceAdoptions!.handoff)
    || approvals.grant.repository !== config.sourceJobs!.repository || releases.grant.repository !== config.sourceJobs!.repository
    || approvals.grant.worktreeRoot !== join(config.statePath, 'source-worktrees') || releases.grant.worktreeRoot !== approvals.grant.worktreeRoot
    || approvals.grant.versioning !== 'patch' || releases.grant.versioning !== 'patch'
    || !isDeepStrictEqual(observations.grant.policy, config.taskObservations!.policy)
    || observations.grant.profilePath !== config.taskObservations!.profilePath
    || observations.grant.installationId !== trust.installationId || !isDeepStrictEqual(observations.grant.ledger, trust.ledger)) fail('authority deployment terms mismatch')
  const selected = [...approvals.grant.plugins].sort()
  if (!isDeepStrictEqual([...observations.grant.packages].sort(), selected.map(plugin => `@dsh-enhanced/${plugin}`))) fail('observation package allowlist does not match')
  for (const plugins of [releases.grant.plugins, adoptions.grant.policies.map(policy => policy.candidateId), manifest.sourceReviews.plugins]) {
    if (!isDeepStrictEqual(selected, [...plugins].sort())) fail('authority plugin allowlists do not match')
  }
  for (const policy of adoptions.grant.policies) {
    const release = releases.grant.policies.find(item => item.candidateId === policy.candidateId)
    if (!release || release.catalogId !== trust.catalog.id || release.catalogPath !== trust.catalog.path
      || Object.entries(policy).some(([key, value]) => !isDeepStrictEqual(value, release[key as keyof typeof release]))) fail('release and adoption policies do not match')
  }
  for (const [authority, purpose] of [[approvals, 'approval'], [adoptions, 'approval'], [releases, 'release-authorization'], [observations, 'host-attestation']] as const) {
    const trusted = cp.resolveTrustKey(trust, purpose, authority.authority, authority.keyId)
    const configured = createPublicKey(await readOwnedFile(authority.keyPath)).export({ type: 'spki', format: 'der' })
    const registered = createPublicKey(trusted.publicKeyPem).export({ type: 'spki', format: 'der' })
    if (!configured.equals(registered)) fail('authority key does not match registered trust')
  }
  if ([approvals.grant.expiresAt, releases.grant.expiresAt, adoptions.grant.expiresAt, observations.grant.policy.expiresAt,
    manifest.sourceReviews.expiresAt].some(value => value <= Date.now())) fail('finite authority has expired')
}

export async function configureRsiSetup(args: RsiSetupArgs, ports: RsiSetupPorts = defaultPorts): Promise<{ mode: string; profiles: readonly string[] }> {
  if (args.rollback && (args.apply || args.start) || args.start && !args.apply) fail('incompatible setup operations')
  const home = args.dshHome
  await safeDirectory(home)
  const manifestBytes = await readOwnedFile(args.manifestPath)
  const manifest = JSON.parse(manifestBytes) as RsiSetupManifest
  const pair = profiles(manifest)
  return withDshHomeLifecycleLock(home, async () => {
    for (const profile of pair) await safeDirectory(join(home, 'profiles', profile))
    const journalPath = join(home, '.rsi-setup-journal.json')
    const previous = await readJournal(journalPath, pair)
    if (args.apply || args.rollback) {
      if (!args.confirmStopped) fail('both Hosts must be stopped')
      for (const profile of pair) ports.assertStopped(profile)
    }
    if (args.rollback) {
      if (!previous) fail('no setup journal to roll back')
      await rollback(home, journalPath, previous!)
      return { mode: 'rolled-back', profiles: pair }
    }
    if (previous?.stage === 'prepared') fail('interrupted setup; use --rollback before continuing')
    const original = await Promise.all(pair.map(profile => readOwnedFile(patchPath(home, profile), false)))
    const effective = pair.map(profile => ports.dump(profile, home))
    const coordinatorBase = await ports.base(pair[1], home)
    const snapshot = await ports.snapshot(effective[0]!, home)
    if (snapshot.bindings.length !== 1) fail('exactly one active owner DM binding is required')
    const owner = snapshot.bindings[0]!
    const input = { manifest, dshHome: home, targetPatch: original[0]!, coordinatorPatch: original[1]!,
      targetEffective: effective[0]!, coordinatorEffective: effective[1]!, coordinatorBase, owner }
    const compiled = await ports.compile(input)
    await ports.validateAuthorities(manifest, owner)
    if (!args.apply) return { mode: 'checked', profiles: pair }
    if (await readOwnedFile(args.manifestPath) !== manifestBytes || await ports.base(pair[1], home) !== coordinatorBase
      || !isDeepStrictEqual(snapshot, await ports.snapshot(effective[0]!, home))) fail('manifest or owner snapshot changed before write')
    for (let i = 0; i < pair.length; i++) {
      ports.assertStopped(pair[i]!)
      if (await readOwnedFile(patchPath(home, pair[i]!), false) !== original[i]) fail('profile changed before write')
    }
    const next = [compiled.targetPatch, compiled.coordinatorPatch]
    if (previous && previous.entries.some((entry, i) => entry.after !== original[i])) fail('profile changed since previous setup; reconcile its journal first')
    const journal: Journal = { schemaVersion: 1, manifestDigest: digest(manifestBytes), stage: 'prepared',
      entries: pair.map((profile, i) => ({ profile, before: original[i]!, after: next[i]! })) as Journal['entries'] }
    if (Buffer.byteLength(JSON.stringify(journal)) > MAX_BYTES) fail('combined profile journal exceeds setup size limit')
    const unchanged = next.every((value, i) => value === original[i])
    if (unchanged) for (let i = 0; i < pair.length; i++) assertRsiEffectivePatch(next[i]!, effective[i]!)
    if (!unchanged) {
      await atomicWrite(journalPath, JSON.stringify(journal))
      try {
        for (const entry of journal.entries) await atomicWrite(patchPath(home, entry.profile), entry.after)
        const final = pair.map(profile => ports.dump(profile, home))
        for (let i = 0; i < pair.length; i++) assertRsiEffectivePatch(next[i]!, final[i]!)
        const recompiled = await ports.compile({ ...input, targetPatch: next[0]!, coordinatorPatch: next[1]!,
          targetEffective: final[0]!, coordinatorEffective: final[1]! })
        if (!isDeepStrictEqual(recompiled, compiled)) fail('effective profile differs from the compiled deployment')
        journal.stage = 'applied'; await atomicWrite(journalPath, JSON.stringify(journal))
      } catch (error) {
        await rollback(home, journalPath, journal)
        if (previous) await atomicWrite(journalPath, JSON.stringify(previous))
        throw error
      }
    }
    // Starting is explicit and follows successful composition of both profiles.
    // A failed start retains the applied journal; it never rewrites a live Host.
    if (args.start) { await ports.start(pair[1], home); await ports.start(pair[0], home) }
    return { mode: args.start ? 'services-started' : 'configured', profiles: pair }
  })
}

export async function runRsiSetup(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseRsiSetupArgs(argv)
  if (args.help) {
    process.stdout.write('Usage: dsh-rsi-setup --manifest <private.json> [--dsh-home <absolute>] [--apply --confirm-hosts-stopped [--start] | --rollback --confirm-hosts-stopped]\nDefault: validate installed profiles and finite authority configuration without changing profiles.\n')
    return
  }
  // 平台门控只属于 CLI 外壳：事务逻辑经注入的 ports 隔离 systemctl/服务安装，
  // 单测须能在任意平台跑；真实 systemd 用户服务只在 Linux 可用。
  if (process.platform !== 'linux') fail('dual Host setup currently requires Linux systemd user services')
  process.stdout.write(`${JSON.stringify(await configureRsiSetup(args))}\n`)
}
