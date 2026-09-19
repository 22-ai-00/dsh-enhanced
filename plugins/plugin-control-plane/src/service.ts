import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { discover, loadCatalogWithMetadata, type CatalogEntry } from './catalog.js'
import { ControlPlaneCliError } from './errors.js'
import {
  assertPluginModificationAllowed,
  createIsolatedWorktree,
  gcPreparedModifyWorktrees,
  runLocalCommand,
  writeScopedPluginFiles,
  type ScopedPluginFile,
} from './source-workspace.js'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST } from './store.js'
import { runDockerPreparedChecks, validateSourceBuildConfig, type SourceBuildConfig } from './source-build.js'
import { inheritedEnvironment, loadTrustConfig } from './trust.js'
import type { CapabilityGapInput, PluginActivationPlan, PluginControlPlaneHealth, PluginSourcePlan, StoredCapabilityGap } from './types.js'
import { registerPluginControlTools } from './tools.js'

export interface Config {
  catalogPath: string
  statePath: string
  trustPath: string
  proposalTtlMs?: number
  /** Optional for legacy deployments; required by prepareModifySourcePlan. */
  sourceBuild?: SourceBuildConfig
}
const schema = Schema.object({
  catalogPath: Schema.string().required(), statePath: Schema.string().required(), trustPath: Schema.string().required(),
  proposalTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
  sourceBuild: Schema.any(),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' { interface Context { pluginControlPlane: PluginControlPlaneService } }

async function canonicalTarget(dshHome: string, profile: string): Promise<PluginActivationPlan['target']> {
  const profiles = join(dshHome, 'profiles')
  if (await realpath(profiles) !== resolve(profiles)) throw new Error('plugin-control-plane: profiles directory is not canonical')
  const profilePath = join(profiles, profile)
  try {
    const metadata = await lstat(profilePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(profilePath) !== resolve(profilePath)) throw new Error('plugin-control-plane: target profile must be a canonical directory')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    if (await realpath(dirname(profilePath)) !== resolve(dirname(profilePath)) || basename(profilePath) !== profile) throw new Error('plugin-control-plane: missing target parent is not canonical')
  }
  return Object.freeze({ dshHome, profile, profilePath })
}

export class PluginControlPlaneService extends Service {
  static Config = schema
  private readonly config: Required<Omit<Config, 'sourceBuild'>> & Pick<Config, 'sourceBuild'>
  private readonly store: ControlPlaneStore
  private readonly abort = new AbortController()
  private readonly sourceBuilds = new Set<Promise<unknown>>()

  constructor(ctx: Context, input: Config) {
    super(ctx, 'pluginControlPlane')
    this.config = schema(input) as Required<Omit<Config, 'sourceBuild'>> & Pick<Config, 'sourceBuild'>
    if (this.config.sourceBuild !== undefined) validateSourceBuildConfig(this.config.sourceBuild)
    if (![this.config.catalogPath, this.config.statePath, this.config.trustPath].every(isAbsolute)) throw new Error('plugin-control-plane: catalogPath, statePath and trustPath must be absolute')
    this.store = new ControlPlaneStore({ path: join(this.config.statePath, 'control.sqlite') })
    ctx.effect(() => async () => { this.abort.abort(); await Promise.allSettled(this.sourceBuilds); this.store.close() }, 'plugin-control-plane.store')
    ctx.inject(['tools'], toolsCtx => registerPluginControlTools(toolsCtx, this))
  }

  private async boundTrust(): Promise<Awaited<ReturnType<typeof loadTrustConfig>>> {
    const trust = await loadTrustConfig(this.config.trustPath)
    if (resolve(join(this.config.statePath, 'control.sqlite')) !== trust.ledger.path
      || resolve(this.config.catalogPath) !== trust.catalog.path) {
      throw new Error('plugin-control-plane: configured ledger/catalog do not match the owner trust binding')
    }
    return trust
  }

  async discover(capability: string): Promise<CatalogEntry[]> {
    await this.boundTrust()
    const loaded = await loadCatalogWithMetadata(this.config.catalogPath)
    return discover(loaded.catalog, capability)
  }

  recordGap(input: CapabilityGapInput): StoredCapabilityGap { return this.store.recordGap(input) }
  gaps(limit: number): readonly StoredCapabilityGap[] { return this.store.listGaps(limit) }
  health(): PluginControlPlaneHealth { return this.store.health() }
  canPrepareSource(): boolean { return this.config.sourceBuild !== undefined }

  async plan(candidateId: string, profile: string, idempotencyKey: string, gapId: string): Promise<PluginActivationPlan> {
    const gap = this.store.getGap(gapId)
    const loaded = await loadCatalogWithMetadata(this.config.catalogPath)
    const matches = discover(loaded.catalog, gap.capability)
    const candidate = matches.find(item => item.id === candidateId)
    if (candidate === undefined) throw new Error('plugin-control-plane: candidate does not match the exact open capability gap')
    const trust = await this.boundTrust()
    if (profile.normalize('NFC').trim() !== profile) throw new Error('plugin-control-plane: profile must already be canonical text')
    const target = await canonicalTarget(trust.dshHome, profile)
    return this.store.createPlan({ candidate, catalog: loaded, matchedCapabilities: candidate.capabilities,
      profile, target, installationId: trust.installationId, ledger: trust.ledger,
      executor: { id: trust.executor.id, version: trust.executor.version, path: trust.executor.path, sha256: trust.executor.sha256 }, ttlMs: this.config.proposalTtlMs,
      gapId, idempotencyKey }).result
  }

  /**
   * Prepare a 'modify' source plan for an pre-existing control-plane open capability gap:
   * write the caller-supplied bounded patch into a fresh isolated worktree and
   * persist a pending plan.  The build gate is deliberately delegated to the
   * configured owner isolation runner; this Host service must never execute
   * proposal-controlled package scripts in its own process environment.
   *
   * This is a proposal-only entry point. It never approves, signs, releases,
   * activates, reloads or touches a production profile; the repository, base
   * commit, environment, timeouts and TTL are host-controlled and cannot be
   * supplied by the proposal caller. On any worktree/build failure the isolated
   * worktree is removed and no plan row is written and no gap is reserved.
   */
  async prepareModifySourcePlan(input: {
    gapId: string
    name: string
    repository: string
    files: readonly ScopedPluginFile[]
    idempotencyKey: string
    ttlMs?: number
    timeoutMs?: number
    offline?: boolean
    signal?: AbortSignal
    assertCurrent?: () => void | Promise<void>
  }): Promise<PluginSourcePlan> {
    this.abort.signal.throwIfAborted()
    if (this.sourceBuilds.size !== 0) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'another isolated source preparation is still draining')
    const operation = this.prepareModifySourcePlanOwned(input)
    this.sourceBuilds.add(operation)
    void operation.then(() => this.sourceBuilds.delete(operation), () => this.sourceBuilds.delete(operation))
    return operation
  }

  private async prepareModifySourcePlanOwned(input: Parameters<PluginControlPlaneService['prepareModifySourcePlan']>[0]): Promise<PluginSourcePlan> {
    const signal = input.signal === undefined ? this.abort.signal : AbortSignal.any([this.abort.signal, input.signal])
    const assertCurrent = async (): Promise<void> => { signal.throwIfAborted(); await input.assertCurrent?.(); signal.throwIfAborted() }
    await assertCurrent()
    const trust = await this.boundTrust()
    const name = input.name.normalize('NFC').trim()
    if (!/^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'plugin name is invalid')
    assertPluginModificationAllowed(name)
    // Re-validate the gap reservation immediately before doing the work: the
    // store re-checks under BEGIN IMMEDIATE, but failing early avoids building
    // a patch against a gap that is already matched or closed.
    const gap = this.store.getGap(input.gapId)
    if (gap.status !== 'open' || gap.candidateId !== undefined) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'only an unreserved pre-existing control-plane open gap can receive a modify proposal')
    }
    const repository = await realpath(resolve(input.repository))
    if (resolve(repository) !== repository) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository path must be canonical')
    const ttlMs = input.ttlMs ?? 86_400_000
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 900_000 || ttlMs > 86_400_000) {
      throw new ControlPlaneCliError('INVALID_ARGUMENT', 'ttlMs must be an integer within 900000..86400000')
    }
    const timeoutMs = input.timeoutMs ?? 180_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 240_000) {
      throw new ControlPlaneCliError('INVALID_ARGUMENT', 'timeoutMs must be an integer within 60000..240000')
    }
    const offline = input.offline ?? true
    const environment = inheritedEnvironment(trust)
    const baseCommit = (await runLocalCommand('git', ['rev-parse', 'HEAD'], repository, environment, { capture: true })).trim()
    await assertCurrent()
    if (!/^[a-f0-9]{40}$/u.test(baseCommit)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'repository HEAD is not a 40-hex commit id')

    const stateRoot = join(this.config.statePath, 'source-worktrees')
    const isolated = await createIsolatedWorktree({ stateRoot, repository, baseCommit, environment })
    try {
      await writeScopedPluginFiles({ worktree: isolated.worktree, name, files: input.files })
      await assertCurrent()
      if (this.config.sourceBuild === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'isolated source build runner is not configured')
      if (!offline) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'isolated source builds must remain offline')
      const configured = this.config.sourceBuild
      const checked = await runDockerPreparedChecks({ config: { ...configured, timeoutMs: Math.min(timeoutMs, configured.timeoutMs) },
        worktree: isolated.worktree, baseCommit, name, scope: [`plugins/${name}`], environment, signal,
        assertCurrent, preparedAt: Date.now() })
      await assertCurrent()
      // The worktree survives success: the owner recomputes its digests on this
      // exact directory during `source verify-prepared`.
      return this.store.createSourcePlan({ gapId: input.gapId, repository, worktree: isolated.worktree, baseCommit,
        name, generatorDigest: MODIFY_GENERATOR_DIGEST, scope: [`plugins/${name}`], mode: 'modify', ttlMs,
        idempotencyKey: input.idempotencyKey,
        prepared: { treeDigest: checked.treeDigest, patchDigest: checked.patchDigest, checkedAt: checked.checkedAt, evidence: checked.evidence } }).result
    } catch (error) {
      await isolated.remove()
      throw error
    }
  }

  /**
   * Garbage-collect prepared modify worktrees whose plans expired while still
   * pending owner action. The trust binding is re-checked first.
   */
  async gcPreparedSourceWorktrees(now: number = Date.now()): Promise<{ removed: readonly string[] }> {
    const trust = await this.boundTrust()
    return gcPreparedModifyWorktrees({ store: this.store,
      statePath: this.config.statePath, environment: inheritedEnvironment(trust), now })
  }
}

export type { PluginActivationPlan } from './types.js'
export const Config = schema
