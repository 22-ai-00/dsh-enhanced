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

/** Content-free projection of a Host-owned durable source job. */
export interface SourceJobProjection {
  readonly id: string
  readonly name: string
  readonly gapId: string
  readonly baseCommit: string
  readonly status: 'queued' | 'running' | 'prepared' | 'failed' | 'unknown'
  readonly createdAt: number
  readonly expiresAt: number
  readonly planId?: string
  readonly failureCode?: string
}

/** @deprecated Prefer SourceJobProjection; retained for local source-port compatibility. */
export type GrowthSourceJobProjection = SourceJobProjection

export interface GrowthSourceJobOwner {
  readonly ownerRouteId: string
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly preset: string
}

export interface GrowthSourceSnapshot {
  readonly name: string
  readonly baseCommit: string
  /** Complete eligible committed-text manifest; omission must never mean a file is new. */
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
  readonly contents: readonly GrowthSourcePreparedFile[]
}

export interface GrowthSourcePlanePort {
  /** Read committed text only; paths=[] discovers the bounded plugin manifest. */
  inspectSource(input: {
    repository: string
    name: string
    paths: readonly string[]
    baseCommit?: string
    signal: AbortSignal
    assertCurrent: () => void
  }): Promise<GrowthSourceSnapshot>
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
    expectedBaseCommit: string
    ttlMs: number
    timeoutMs: number
    offline: boolean
    owner?: GrowthSourceJobOwner
    signal: AbortSignal
    assertCurrent: () => void
  }): Promise<GrowthSourcePreparedPlan>
  /** Queue Host-owned source preparation that outlives the model wake. */
  enqueueSourceJob(input: {
    gapId: string
    name: string
    repository: string
    files: readonly GrowthSourcePreparedFile[]
    idempotencyKey: string
    expectedBaseCommit: string
    ttlMs: number
    owner: GrowthSourceJobOwner
    signal: AbortSignal
    assertCurrent: () => void
  }): Promise<SourceJobProjection>
  /** Read a content-free durable-job status under the live Growth owner. */
  inspectSourceJob(input: { id: string; owner: GrowthSourceJobOwner }): SourceJobProjection
}

/** Per-wake counters surfaced into driver health by the index.ts adapter. */
export interface GrowthSourcePlaneStats {
  queued: number
  prepared: number
  rejected: number
}
