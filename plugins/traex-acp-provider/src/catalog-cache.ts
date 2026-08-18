import type { CatalogObservation } from './acp-client.js'

/**
 * NON-AUTHORITATIVE, in-memory cache of the last model catalog observed during an ACP handshake.
 * It exists for diagnostics and model-directory display only. Per the DSH catalog contract, it
 * MUST NOT:
 *
 *   - gate, pre-validate, admit, or reject any request;
 *   - return `MODEL_NOT_FOUND` / `ACP_ENTITLEMENT_REQUIRED` from a stored value;
 *   - suppress or short-circuit a new `session/new`.
 *
 * The catalog returned by the CURRENT `session/new` always remains the sole execution authority.
 * The stored value can be stale the instant it is written (the operator may switch accounts or
 * plans, TraeX may update its catalog, or the executable may be upgraded in place), so a short TTL
 * bounds how long a stale observation is even shown, and callers must invalidate it on auth
 * failure, config/plugin reload, and CLI version changes.
 *
 * The cache key uses ONLY non-sensitive, verifiable identifiers. It NEVER fingerprints environment
 * variable values (neither plaintext nor a hash — either could become a correlatable identifier).
 */

export interface CatalogCacheKeyParts {
  /** Stable provider route id. */
  readonly route: string
  /** Normalized executable name or path handed to spawn (no shell parsing). */
  readonly command: string
  /** Working directory exposed to the ACP session. */
  readonly cwd: string
  /**
   * A revision string for the non-sensitive configuration that affects catalog shape (e.g. the
   * deployer advisory model aliases). Never derive this from environment variable values.
   */
  readonly configRevision: string
}

/** A stored observation plus the monotonic-ish wall-clock time it was recorded, for TTL checks. */
export interface CachedCatalog {
  readonly key: string
  readonly observation: CatalogObservation
  /** `Date.now()` at record time. */
  readonly recordedAt: number
}

export interface CatalogCacheOptions {
  /** How long a stored observation may still be shown, in ms. Defaults to 5 minutes. */
  readonly ttlMs?: number
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

const DEFAULT_TTL_MS = 5 * 60_000

/** Build the opaque cache key from non-sensitive parts only. Never include env values. */
export function catalogCacheKey(parts: CatalogCacheKeyParts): string {
  // A control-character-free join; the parts are all non-secret identifiers already.
  return [parts.route, parts.command, parts.cwd, parts.configRevision]
    .map(part => part.replaceAll('\u0000', ' ').replaceAll('\u001f', ' '))
    .join('\u0000')
}

/**
 * In-memory, per-adapter catalog observation cache. It may serve recently completed prompt-free
 * discovery to model listing/resolution, but never authorizes execution; every request still
 * performs a fresh `session/new` and validates the selected model/effort there.
 */
export class CatalogObservationCache {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly entries = new Map<string, CachedCatalog>()

  constructor(options: CatalogCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
  }

  /** Store the observation seen during a real handshake. Overwrites any prior value for the key. */
  record(parts: CatalogCacheKeyParts, observation: CatalogObservation): void {
    const key = catalogCacheKey(parts)
    this.entries.set(key, { key, observation, recordedAt: this.now() })
  }

  /**
   * Read the last observation for a key IF it is still within TTL. Returns undefined when absent or
   * expired (and drops the expired entry). Callers may use it for metadata display, but must NEVER
   * use the result to admit, reject, or route a request.
   */
  peek(parts: CatalogCacheKeyParts): CachedCatalog | undefined {
    const key = catalogCacheKey(parts)
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (this.now() - entry.recordedAt >= this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    return entry
  }

  /** Explicitly drop one key's observation (e.g. on auth failure or CLI version change). */
  invalidate(parts: CatalogCacheKeyParts): void {
    this.entries.delete(catalogCacheKey(parts))
  }

  /** Drop every observation (e.g. on config/plugin reload). */
  clear(): void {
    this.entries.clear()
  }

  /** Number of live (not-yet-evicted) entries; primarily for diagnostics and tests. */
  get size(): number {
    return this.entries.size
  }
}
