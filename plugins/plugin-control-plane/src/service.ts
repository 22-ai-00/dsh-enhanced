import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { candidateDigest, discover, loadCatalogWithFirstPartyFallback, type CatalogEntry } from './catalog.js'
import { registerPluginControlTools } from './tools.js'

export interface Config { catalogPath: string; statePath: string; proposalTtlMs?: number }
const schema = Schema.object({
  catalogPath: Schema.string().required(), statePath: Schema.string().required(),
  proposalTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
}) as Schema<Config>

export interface PluginActivationPlan {
  schemaVersion: 1; id: string; status: 'pending-owner-approval'; createdAt: number; expiresAt: number
  profile: string; candidate: CatalogEntry; digest: string
}

declare module '@deepseek-ai/cordis' { interface Context { pluginControlPlane: PluginControlPlaneService } }

export class PluginControlPlaneService extends Service {
  static Config = schema
  private readonly config: Required<Config>
  constructor(ctx: Context, input: Config) {
    super(ctx, 'pluginControlPlane')
    this.config = schema(input) as Required<Config>
    if (!isAbsolute(this.config.catalogPath) || !isAbsolute(this.config.statePath)) throw new Error('plugin-control-plane: catalogPath and statePath must be absolute')
    ctx.inject(['tools'], toolsCtx => registerPluginControlTools(toolsCtx, this))
  }

  async discover(capability: string): Promise<CatalogEntry[]> {
    return discover(await loadCatalogWithFirstPartyFallback(this.config.catalogPath), capability)
  }

  async plan(candidateId: string, profile: string): Promise<PluginActivationPlan> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)) throw new Error('plugin-control-plane: invalid profile')
    const candidate = (await loadCatalogWithFirstPartyFallback(this.config.catalogPath)).entries.find(item => item.id === candidateId)
    if (candidate === undefined) throw new Error('plugin-control-plane: candidate not found')
    const createdAt = Date.now()
    const digest = candidateDigest(candidate, profile)
    const plan: PluginActivationPlan = Object.freeze({ schemaVersion: 1, id: `plugin-${digest.slice(0, 24)}`,
      status: 'pending-owner-approval', createdAt, expiresAt: createdAt + this.config.proposalTtlMs, profile, candidate, digest })
    await mkdir(this.config.statePath, { recursive: true, mode: 0o700 })
    const target = join(this.config.statePath, `${plan.id}.json`)
    const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
    try {
      await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, target)
    } finally {
      // A failed write must not leave a plan that a later owner could mistake
      // for an authenticated proposal.  Missing files are benign here.
      await unlink(temporary).catch(() => undefined)
    }
    return plan
  }
}

export const Config = schema
