import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { discover, loadCatalogWithMetadata, type CatalogEntry } from './catalog.js'
import { ControlPlaneStore } from './store.js'
import { loadTrustConfig } from './trust.js'
import type { CapabilityGapInput, PluginActivationPlan, PluginControlPlaneHealth, StoredCapabilityGap } from './types.js'
import { registerPluginControlTools } from './tools.js'

export interface Config { catalogPath: string; statePath: string; trustPath: string; proposalTtlMs?: number }
const schema = Schema.object({
  catalogPath: Schema.string().required(), statePath: Schema.string().required(), trustPath: Schema.string().required(),
  proposalTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
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
  private readonly config: Required<Config>
  private readonly store: ControlPlaneStore

  constructor(ctx: Context, input: Config) {
    super(ctx, 'pluginControlPlane')
    this.config = schema(input) as Required<Config>
    if (![this.config.catalogPath, this.config.statePath, this.config.trustPath].every(isAbsolute)) throw new Error('plugin-control-plane: catalogPath, statePath and trustPath must be absolute')
    this.store = new ControlPlaneStore({ path: join(this.config.statePath, 'control.sqlite') })
    ctx.effect(() => () => this.store.close(), 'plugin-control-plane.store')
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
}

export type { PluginActivationPlan } from './types.js'
export const Config = schema
