/**
 * Structural seam between the growth agent and the plugin-control-plane source
 * lane. The driver depends on this NARROW shape, not on the concrete service:
 * index.ts adapts `ctx.get('pluginControlPlane', false)` onto it. When the
 * service is absent or the owner did not opt in, no source-plane tool is
 * registered and the capability fails closed.
 *
 * This module intentionally carries no runtime import of
 * @dsh-enhanced/plugin-control-plane (an optional peer): every field here is a
 * structural subset, so the driver still builds and loads without that package.
 */

/**
 * Local mirror of the control-plane protected-plugin denylist
 * (PROTECTED_PLUGIN_DENYLIST in plugins/plugin-control-plane/src/source-workspace.ts).
 * It is the growth-side SECOND layer of defence; the control plane re-checks
 * the identical set inside prepareModifySourcePlan. Keep both lists in sync;
 * a growth proposal may never retarget a T3 safety-root plugin.
 */
export const GROWTH_PROTECTED_PLUGIN_DENYLIST: ReadonlySet<string> = new Set([
  'assistant-policy', // 策略规则、授权寿命、急停根
  'credentials-keychain', // 凭据根
  'assistant-evaluation', // 评测答案根
  'assistant-verifier', // 验证/私钥评测根
  'assistant-deepseek-budget', // 预算上限根
  'assistant-super-relay-budget', // 预算上限根
  'assistant-skills', // sealed holdout 私钥与 holdout 数据集
  'assistant-isolation', // 隔离沙箱机制本身
  'assistant-web-owner', // owner 安全控制台
  'plugin-control-plane', // 审批/激活控制面本身（自举提权面）
])

/** Projection of an pre-existing control-plane capability gap safe to surface to the model. */
export interface GrowthSourceGap {
  readonly id: string
  readonly capability: string
  readonly context: string
  readonly status: 'open' | 'matched' | 'closed'
  readonly candidateId?: string
  readonly createdAt: number
}

export interface GrowthSourcePreparedFile {
  /** Path relative to plugins/<plugin_name>/; the Host rejects any escape. */
  readonly path: string
  readonly content: string
}

/** Read-only projection of the persisted pending modify plan. */
export interface GrowthSourcePreparedPlan {
  readonly id: string
  readonly status: string
  readonly name: string
  readonly mode: string
  readonly repository?: string
  readonly worktree?: string
  readonly baseCommit?: string
  /** Present on modify plans: the frozen isolated-worktree checked digests. */
  readonly sourceCheck?: { readonly treeDigest: string; readonly patchDigest: string; readonly checkedAt: number }
}

export interface GrowthSourcePlanePort {
  /** Enumerate recently recorded gaps; the caller filters to still-open ones. */
  listOpenGaps(): readonly GrowthSourceGap[]
  /**
   * Prepare a PENDING modify source plan. Every build-shaping argument
   * (repository, ttl, timeout, offline) is Host configuration forwarded
   * verbatim — never model input. Resolves only with a pending-approval plan;
   * any build/boundary failure rejects and leaves no plan row or gap claim.
   */
  prepareModifySourcePlan(input: {
    gapId: string
    name: string
    repository: string
    files: readonly GrowthSourcePreparedFile[]
    idempotencyKey: string
    ttlMs: number
    timeoutMs: number
    offline: boolean
    signal: AbortSignal
    assertCurrent: () => void
  }): Promise<GrowthSourcePreparedPlan>
}

/** Per-wake counters surfaced into driver health by the index.ts adapter. */
export interface GrowthSourcePlaneStats {
  prepared: number
  rejected: number
}
