import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import type {
  AssistantPolicyService,
  RayHomeRuntime,
  RayInterest,
  RayStageGoal,
} from '@dsh-ray/assistant-policy'

export type RayIdeaSource = 'conversation' | 'dreaming' | 'event' | 'web-learning' | 'reflection'
export type RayIdeaTier = 'silent_explore' | 'natural_mention' | 'propose_work' | 'hold'
export type RayIdeaStatus = 'pooled' | 'explored' | 'mentioned' | 'proposed' | 'accepted' | 'ignored' | 'annoyed' | 'rejected'
export type RayReflectionCadence = 'aftertaste' | 'daily-diary' | 'weekly-review' | 'stage-review'
export type RayCandidateDisposition = 'adopted' | 'vetoed' | 'rolled_back' | 'rejected'

export interface RayIdeaRecord {
  readonly ideaId: string
  readonly source: RayIdeaSource
  readonly title: string
  readonly summary: string
  readonly topic: string
  readonly interestScore: number
  readonly ownerValueScore: number
  readonly combinedScore: number
  readonly tier: RayIdeaTier
  readonly status: RayIdeaStatus
  readonly explorationNote?: string
  readonly mentionCount: number
  readonly requiresExternalEffect: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RayIdeaTuning {
  readonly naturalMentionThreshold: number
  readonly proposeWorkThreshold: number
  readonly silentExploreThreshold: number
  readonly dailyNaturalMentionCap: number
  readonly updatedAt: number
}

export interface RayCandidateOutcomeRecord {
  readonly recordId: string
  readonly candidateId: string
  readonly kind: string
  readonly rootCause: string
  readonly predictedImpact: string
  readonly observedOutcome: string
  readonly supplier: string
  readonly disposition: RayCandidateDisposition
  readonly createdAt: number
}

export interface RayReflectionRecord {
  readonly reflectionId: string
  readonly cadence: RayReflectionCadence
  readonly summary: string
  readonly tokensUsed: number
  readonly artifactPath: string
  readonly createdAt: number
}

export interface RayCognitiveSummary {
  readonly active: boolean
  readonly pooledCount: number
  readonly exploredCount: number
  readonly naturalMentionCount: number
  readonly proposeWorkCount: number
  readonly acceptedCount: number
  readonly annoyedCount: number
  readonly tuning: RayIdeaTuning
  readonly recentReflections: readonly RayReflectionRecord[]
}

const DEFAULT_TUNING: RayIdeaTuning = {
  naturalMentionThreshold: 0.55,
  proposeWorkThreshold: 0.72,
  silentExploreThreshold: 0.35,
  dailyNaturalMentionCap: 3,
  updatedAt: 0,
}

const MAX_CANDIDATE_OUTCOMES = 200
const SEVEN_DAYS_MS = 7 * 86_400_000

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Number(value.toFixed(4))))
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = text.toLowerCase()
  for (const m of lower.match(/[a-z0-9_-]{2,}/gu) ?? []) tokens.add(m)
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/gu) ?? []) {
    tokens.add(run)
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return tokens
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let hits = 0
  for (const item of a) {
    if (b.has(item)) hits += 1
  }
  return hits / Math.min(a.size, b.size)
}

function dayStartMs(atMs: number): number {
  const d = new Date(atMs)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

interface IdeaRow {
  idea_id: string
  source: RayIdeaSource
  title: string
  summary: string
  topic: string
  interest_score: number
  owner_value_score: number
  combined_score: number
  tier: RayIdeaTier
  status: RayIdeaStatus
  exploration_note: string | null
  mention_count: number
  requires_external_effect: number
  created_at: number
  updated_at: number
}

interface OutcomeRow {
  record_id: string
  candidate_id: string
  kind: string
  root_cause: string
  predicted_impact: string
  observed_outcome: string
  supplier: string
  disposition: RayCandidateDisposition
  created_at: number
}

interface ReflectionRow {
  reflection_id: string
  cadence: RayReflectionCadence
  summary: string
  tokens_used: number
  artifact_path: string
  created_at: number
}

function rowToIdea(row: IdeaRow): RayIdeaRecord {
  return {
    ideaId: row.idea_id,
    source: row.source,
    title: row.title,
    summary: row.summary,
    topic: row.topic,
    interestScore: row.interest_score,
    ownerValueScore: row.owner_value_score,
    combinedScore: row.combined_score,
    tier: row.tier,
    status: row.status,
    ...(row.exploration_note === null ? {} : { explorationNote: row.exploration_note }),
    mentionCount: row.mention_count,
    requiresExternalEffect: row.requires_external_effect === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class RayCognitiveLoopRuntime {
  readonly databasePath: string
  readonly tuningPath: string
  readonly reflectionsDir: string
  private readonly rayHome: string
  private readonly policy: AssistantPolicyService
  private readonly raySelf: RayHomeRuntime
  private readonly db: DatabaseSync
  private readonly disposers: Array<() => void> = []
  private tuning: RayIdeaTuning
  private closed = false

  constructor(
    private readonly ctx: Context,
    policy: AssistantPolicyService,
    raySelf: RayHomeRuntime,
  ) {
    this.policy = policy
    this.raySelf = raySelf
    this.rayHome = raySelf.rayHome
    this.databasePath = join(this.rayHome, 'ideas', 'ideas.sqlite')
    this.tuningPath = join(this.rayHome, 'ideas', 'tuning.json')
    this.reflectionsDir = join(this.rayHome, 'reflections')

    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    mkdirSync(this.reflectionsDir, { recursive: true, mode: 0o700 })

    this.tuning = this.loadOrCreateTuning()

    const db = new DatabaseSync(this.databasePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ray_ideas (
        idea_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        topic TEXT NOT NULL,
        interest_score REAL NOT NULL,
        owner_value_score REAL NOT NULL,
        combined_score REAL NOT NULL,
        tier TEXT NOT NULL CHECK(tier IN ('silent_explore','natural_mention','propose_work','hold')),
        status TEXT NOT NULL CHECK(status IN ('pooled','explored','mentioned','proposed','accepted','ignored','annoyed','rejected')),
        exploration_note TEXT,
        mention_count INTEGER NOT NULL DEFAULT 0,
        requires_external_effect INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_ideas_tier_status ON ray_ideas(tier, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS ray_candidate_outcomes (
        record_id TEXT PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        predicted_impact TEXT NOT NULL,
        observed_outcome TEXT NOT NULL,
        supplier TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('adopted','vetoed','rolled_back','rejected')),
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_candidate_outcomes_created ON ray_candidate_outcomes(created_at DESC);
      CREATE TABLE IF NOT EXISTS ray_reflections (
        reflection_id TEXT PRIMARY KEY,
        cadence TEXT NOT NULL CHECK(cadence IN ('aftertaste','daily-diary','weekly-review','stage-review')),
        summary TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        artifact_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_reflections_cadence ON ray_reflections(cadence, created_at DESC);
    `)
    this.db = db
    try { chmodSync(this.databasePath, 0o600) } catch { /* ignore */ }
    try {
      this.raySelf.registerDatabase('assistant-proactive/ideas', this.databasePath)
    } catch {
      // Ignore if manifest not writable in stripped test harness.
    }

    this.installDreamingBridge()
    this.installPromptIntegration()
    this.installToolsIntegration()
  }

  private assertOpen(): DatabaseSync {
    if (this.closed) throw new Error('assistant-proactive: RayCognitiveLoopRuntime is disposed')
    return this.db
  }

  private loadOrCreateTuning(): RayIdeaTuning {
    if (existsSync(this.tuningPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.tuningPath, 'utf8')) as Partial<RayIdeaTuning>
        return {
          naturalMentionThreshold: clamp(parsed.naturalMentionThreshold ?? DEFAULT_TUNING.naturalMentionThreshold, 0.25, 0.95),
          proposeWorkThreshold: clamp(parsed.proposeWorkThreshold ?? DEFAULT_TUNING.proposeWorkThreshold, 0.45, 0.98),
          silentExploreThreshold: clamp(parsed.silentExploreThreshold ?? DEFAULT_TUNING.silentExploreThreshold, 0.15, 0.8),
          dailyNaturalMentionCap: Math.max(1, Math.min(10, Math.trunc(parsed.dailyNaturalMentionCap ?? DEFAULT_TUNING.dailyNaturalMentionCap))),
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
        }
      } catch {
        // Fall through and rewrite clean default tuning file.
      }
    }
    const initial: RayIdeaTuning = { ...DEFAULT_TUNING, updatedAt: Date.now() }
    writeFileSync(this.tuningPath, `${JSON.stringify(initial, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    return initial
  }

  private saveTuning(next: RayIdeaTuning): void {
    this.tuning = next
    writeFileSync(this.tuningPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  private installDreamingBridge(): void {
    try {
      const inject = this.ctx.inject as unknown as (
        deps: readonly string[],
        cb: (c: Context) => unknown,
      ) => { dispose(): void | Promise<void> }
      const handle = inject(['assistantDreaming'], dreamCtx => {
        const dreaming = dreamCtx.get('assistantDreaming' as never) as {
          onIdeaRecorded?: (listener: (idea: {
            id: string
            summary: string
            detail: string
          }) => void) => () => void
        } | undefined
        if (typeof dreaming?.onIdeaRecorded !== 'function') return
        const unsub = dreaming.onIdeaRecorded(idea => {
          if (this.closed) return
          try {
            this.ingestSignal({
              ideaId: `dream-${idea.id}`,
              source: 'dreaming',
              title: idea.summary,
              summary: idea.detail || idea.summary,
              topic: idea.summary.slice(0, 64),
              internalOnly: true,
              autoExplore: true,
            })
          } catch {
            // Dreaming ingestion must not disrupt upstream scheduler.
          }
        })
        return unsub
      })
      this.disposers.push(() => { void handle.dispose() })
    } catch {
      // Optional peer may not be registered in test Context.
    }
  }

  private installPromptIntegration(): void {
    try {
      const inject = this.ctx.inject as unknown as (
        deps: readonly string[],
        cb: (c: {
          systemPrompt: {
            context(options: { name: string; order: number; text: (input: { agent?: Agent }) => string }): () => void
          }
        }) => unknown,
      ) => { dispose(): void | Promise<void> }
      const handle = inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.context({
        name: 'ray:proactive-mentions',
        order: 244,
        text: ({ agent }) => {
          if (this.closed || agent?.session?.header?.origin === 'subagent') return ''
          const session = agent?.session
          if (session === undefined) return ''
          const msgs = session.deriveMessages()
          const latestUser = [...msgs].reverse().find(m => m.role === 'user')
          const query = latestUser?.content
            .flatMap(b => (b.type === 'text' ? [b.text] : []))
            .join(' ')
            .trim() ?? ''
          if (query === '') return ''
          const matches = this.findRelevantNaturalMentions(query, 2)
          if (matches.length === 0) return ''
          return [
            '## 可顺口提及的联想点子（受每日打扰配额约束）',
            '- 仅当确实与当前话题紧密相关时顺口带出一句，若主人未响应或嫌烦，调用 `ray_idea_pool({ action: "react", idea_id, reaction })` 调节阈值：',
            ...matches.map(m => `- [${m.ideaId}] ${m.title}（${m.summary.slice(0, 100)}）`),
          ].join('\n')
        },
      }))
      this.disposers.push(() => { void handle.dispose() })
    } catch {
      // Ignore if systemPrompt is absent.
    }
  }

  private isEligibleSession(agent: Agent | undefined): boolean {
    if (this.closed || agent === undefined || agent.session === undefined) return false
    if (agent.session.header.origin === 'subagent') return false
    if (agent.session.header.delegationDepth !== undefined) return false
    return this.raySelf.isRayOwnedSession(agent)
  }

  private installToolsIntegration(): void {
    try {
      const handle = this.ctx.inject(['tools'], toolsCtx => {
        const ideaPoolTool = defineTool({
          name: 'ray_idea_pool',
          description: 'Interact with Ray Unified Idea Pool (ingest, list, explore with free energy, surface natural mention, or record owner reaction accepted|ignored|annoyed).',
          parameters: {
            action: {
              type: 'string',
              enum: ['list', 'ingest', 'explore', 'mention', 'react', 'outcomes'],
              required: true,
            },
            idea_id: { type: 'string' },
            source: { type: 'string', enum: ['conversation', 'dreaming', 'event', 'web-learning', 'reflection'] },
            title: { type: 'string' },
            summary: { type: 'string' },
            topic: { type: 'string' },
            requires_external_effect: { type: 'boolean' },
            reaction: { type: 'string', enum: ['accepted', 'ignored', 'annoyed'] },
            context_text: { type: 'string' },
            limit: { type: 'integer' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.isEligibleSession(exec.agent)) {
              throw new Error('ray_idea_pool requires a non-subagent Ray session')
            }
            if (args.action === 'ingest') {
              if (!args.title || !args.summary) throw new Error('ray_idea_pool ingest requires title and summary')
              return JSON.parse(JSON.stringify(this.ingestSignal({
                source: (args.source as RayIdeaSource | undefined) ?? 'conversation',
                title: args.title,
                summary: args.summary,
                topic: args.topic ?? args.title,
                ...(args.requires_external_effect === undefined ? {} : { requiresExternalEffect: args.requires_external_effect }),
              }))) as Record<string, never>
            }
            if (args.action === 'explore') {
              if (!args.idea_id) throw new Error('ray_idea_pool explore requires idea_id')
              return JSON.parse(JSON.stringify(this.exploreIdea(args.idea_id))) as Record<string, never>
            }
            if (args.action === 'mention') {
              return JSON.parse(JSON.stringify(this.surfaceNaturalMention(args.context_text ?? args.topic ?? '', args.idea_id))) as Record<string, never>
            }
            if (args.action === 'react') {
              if (!args.idea_id || !args.reaction) throw new Error('ray_idea_pool react requires idea_id and reaction')
              return JSON.parse(JSON.stringify(this.recordReaction(args.idea_id, args.reaction as 'accepted' | 'ignored' | 'annoyed'))) as Record<string, never>
            }
            if (args.action === 'outcomes') {
              return JSON.parse(JSON.stringify({ outcomes: this.listCandidateOutcomes(args.limit ?? 20) })) as Record<string, never>
            }
            return JSON.parse(JSON.stringify({
              summary: this.summary(),
              ideas: this.listIdeas({ limit: args.limit ?? 20 }),
            })) as Record<string, never>
          },
        })

        const reflectTool = defineTool({
          name: 'ray_reflect',
          description: 'Run one of Ray 4 reflection cadences (aftertaste, daily-diary, weekly-review, stage-review) bounded by Kernel free energy.',
          parameters: {
            cadence: { type: 'string', enum: ['aftertaste', 'daily-diary', 'weekly-review', 'stage-review'], required: true },
            notes_json: { type: 'string' },
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          execute: async (args, exec) => {
            if (!this.isEligibleSession(exec.agent)) {
              throw new Error('ray_reflect requires a non-subagent Ray session')
            }
            let opts: Record<string, unknown> = {}
            if (typeof args.notes_json === 'string' && args.notes_json.trim() !== '') {
              const parsed = JSON.parse(args.notes_json) as unknown
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                opts = parsed as Record<string, unknown>
              }
            }
            return JSON.parse(JSON.stringify(this.runReflection(args.cadence as RayReflectionCadence, opts))) as Record<string, never>
          },
        })

        const when = (activation: { agent?: unknown }) => this.isEligibleSession(activation.agent as Agent | undefined)
        const authorize = (exec: ToolExecution) => this.isEligibleSession(exec.agent)
        const registered: Array<() => void> = []
        for (const def of [ideaPoolTool, reflectTool]) {
          registered.push(toolsCtx.tools.register(def, { when }))
          registered.push(this.policy.registerPreauthorizedTool(
            this.ctx,
            def as unknown as ReturnType<typeof defineTool>,
            authorize,
            { denialReason: 'assistant-proactive: Ray cognitive tool requires an active non-subagent Ray session' },
          ))
        }
        const cleanup = () => {
          for (const d of registered.splice(0).reverse()) {
            try { d() } catch { /* ignore */ }
          }
        }
        toolsCtx.effect?.(() => cleanup)
        return cleanup
      })
      this.disposers.push(() => { void handle.dispose() })
    } catch {
      // Ignore if tools service is absent.
    }
  }

  private scoreInterest(topic: string, title: string, summary: string, hint?: number): number {
    const interests = this.raySelf.snapshot(0).selfModel.interests
    const sigTokens = tokenize(`${topic} ${title} ${summary}`)
    let best = typeof hint === 'number' && Number.isFinite(hint) ? clamp(hint, 0, 1) : 0.35
    for (const item of interests) {
      const ov = tokenOverlap(sigTokens, tokenize(item.topic))
      if (ov > 0) {
        best = Math.max(best, clamp(item.weight * (0.45 + 0.55 * ov), 0, 1))
      }
    }
    return best
  }

  private classifyTier(input: {
    combinedScore: number
    requiresExternalEffect: boolean
    internalOnly?: boolean
  }): RayIdeaTier {
    if (input.requiresExternalEffect || (!input.internalOnly && input.combinedScore >= this.tuning.proposeWorkThreshold)) {
      return 'propose_work'
    }
    if (!input.internalOnly && input.combinedScore >= this.tuning.naturalMentionThreshold) {
      return 'natural_mention'
    }
    if (input.internalOnly || input.combinedScore >= this.tuning.silentExploreThreshold) {
      return 'silent_explore'
    }
    return 'hold'
  }

  ingestSignal(input: {
    ideaId?: string
    source: RayIdeaSource
    title: string
    summary: string
    topic?: string
    interestHint?: number
    ownerValueHint?: number
    requiresExternalEffect?: boolean
    internalOnly?: boolean
    autoExplore?: boolean
  }): { idea: RayIdeaRecord; explorationConsumed: boolean } {
    const db = this.assertOpen()
    const now = Date.now()
    const ideaId = input.ideaId ?? `idea-${randomUUID()}`
    const topic = (input.topic ?? input.title).trim()
    const interestScore = this.scoreInterest(topic, input.title, input.summary, input.interestHint)
    const defaultValue = input.source === 'conversation' || input.source === 'reflection' ? 0.65
      : input.source === 'dreaming' ? 0.6
        : 0.55
    const ownerValueScore = clamp(input.ownerValueHint ?? defaultValue, 0, 1)
    const combinedScore = clamp(interestScore * 0.45 + ownerValueScore * 0.55, 0, 1)
    const requiresExternalEffect = Boolean(input.requiresExternalEffect)
    const tier = this.classifyTier({
      combinedScore,
      requiresExternalEffect,
      ...(input.internalOnly === undefined ? {} : { internalOnly: input.internalOnly }),
    })

    db.prepare(`
      INSERT OR REPLACE INTO ray_ideas (
        idea_id, source, title, summary, topic, interest_score, owner_value_score,
        combined_score, tier, status, exploration_note, mention_count, requires_external_effect,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pooled', NULL, 0, ?, ?, ?)
    `).run(
      ideaId,
      input.source,
      input.title.trim(),
      input.summary.trim(),
      topic,
      interestScore,
      ownerValueScore,
      combinedScore,
      tier,
      requiresExternalEffect ? 1 : 0,
      now,
      now,
    )

    let explorationConsumed = false
    if (tier === 'silent_explore' && input.autoExplore !== false) {
      const explored = this.exploreIdea(ideaId, 300)
      explorationConsumed = explored.explored
    }
    const row = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(ideaId) as unknown as IdeaRow
    return { idea: rowToIdea(row), explorationConsumed }
  }

  exploreIdea(ideaId: string, tokenCost = 350): {
    explored: boolean
    reason?: string
    idea?: RayIdeaRecord
  } {
    const db = this.assertOpen()
    const existing = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(ideaId) as unknown as IdeaRow | undefined
    if (existing === undefined) return { explored: false, reason: 'idea-not-found' }
    if (existing.requires_external_effect === 1) {
      return { explored: false, reason: 'external-effect-requires-owner-approval', idea: rowToIdea(existing) }
    }
    const spent = this.raySelf.tryConsumeFreeEnergy(tokenCost, `idea:silent-explore:${ideaId}`)
    if (!spent.ok) {
      return { explored: false, reason: spent.check.reason, idea: rowToIdea(existing) }
    }
    const now = Date.now()
    const note = `自由精力静默探索（消耗 ${tokenCost} tokens，零打扰）：已完成「${existing.title}」资料整理与关联草稿。`
    db.prepare(`
      UPDATE ray_ideas SET status = 'explored', exploration_note = ?, updated_at = ? WHERE idea_id = ?
    `).run(note, now, ideaId)
    const updated = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(ideaId) as unknown as IdeaRow
    return { explored: true, idea: rowToIdea(updated) }
  }

  mentionsTodayCount(atMs = Date.now()): number {
    const db = this.assertOpen()
    const start = dayStartMs(atMs)
    const row = db.prepare(`
      SELECT COALESCE(SUM(mention_count), 0) AS c
      FROM ray_ideas
      WHERE status IN ('mentioned','accepted','ignored','annoyed') AND updated_at >= ?
    `).get(start) as { c: number }
    return Math.max(0, Math.trunc(row.c))
  }

  findRelevantNaturalMentions(contextText: string, limit = 2): RayIdeaRecord[] {
    const db = this.assertOpen()
    if (this.mentionsTodayCount() >= this.tuning.dailyNaturalMentionCap) return []
    const ctxTokens = tokenize(contextText)
    if (ctxTokens.size === 0) return []
    const rows = db.prepare(`
      SELECT * FROM ray_ideas
      WHERE tier = 'natural_mention' AND status IN ('pooled','explored')
      ORDER BY combined_score DESC, updated_at DESC
      LIMIT 30
    `).all() as unknown as IdeaRow[]
    const matched: Array<{ rec: RayIdeaRecord; overlap: number }> = []
    for (const row of rows) {
      const ov = tokenOverlap(ctxTokens, tokenize(`${row.topic} ${row.title} ${row.summary}`))
      if (ov > 0) matched.push({ rec: rowToIdea(row), overlap: ov })
    }
    matched.sort((a, b) => b.overlap - a.overlap || b.rec.combinedScore - a.rec.combinedScore)
    return matched.slice(0, limit).map(m => m.rec)
  }

  surfaceNaturalMention(contextText: string, explicitIdeaId?: string): {
    surfaced: boolean
    reason?: string
    idea?: RayIdeaRecord
    remainingToday: number
  } {
    const db = this.assertOpen()
    const usedToday = this.mentionsTodayCount()
    if (usedToday >= this.tuning.dailyNaturalMentionCap) {
      return { surfaced: false, reason: 'daily-mention-cap-reached', remainingToday: 0 }
    }
    const candidate = explicitIdeaId
      ? (() => {
          const row = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(explicitIdeaId) as unknown as IdeaRow | undefined
          return row === undefined ? undefined : rowToIdea(row)
        })()
      : this.findRelevantNaturalMentions(contextText, 1)[0]
    if (candidate === undefined) {
      return { surfaced: false, reason: 'no-matching-idea', remainingToday: this.tuning.dailyNaturalMentionCap - usedToday }
    }
    if (candidate.requiresExternalEffect || candidate.tier === 'propose_work') {
      return { surfaced: false, reason: 'propose-work-requires-explicit-owner-consent', idea: candidate, remainingToday: this.tuning.dailyNaturalMentionCap - usedToday }
    }
    const now = Date.now()
    db.prepare(`
      UPDATE ray_ideas SET status = 'mentioned', mention_count = mention_count + 1, updated_at = ? WHERE idea_id = ?
    `).run(now, candidate.ideaId)
    this.raySelf.recordGrowthEvent({ category: 'proactive-surfaced', metricKey: candidate.source, subjectId: candidate.ideaId })
    const row = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(candidate.ideaId) as unknown as IdeaRow
    return {
      surfaced: true,
      idea: rowToIdea(row),
      remainingToday: Math.max(0, this.tuning.dailyNaturalMentionCap - (usedToday + 1)),
    }
  }

  recordReaction(
    ideaId: string,
    reaction: 'accepted' | 'ignored' | 'annoyed',
  ): { ok: true; idea: RayIdeaRecord; tuning: RayIdeaTuning } {
    const db = this.assertOpen()
    const existing = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(ideaId) as unknown as IdeaRow | undefined
    if (existing === undefined) {
      throw new Error(`assistant-proactive: idea not found: ${ideaId}`)
    }
    const now = Date.now()
    db.prepare('UPDATE ray_ideas SET status = ?, updated_at = ? WHERE idea_id = ?').run(reaction, now, ideaId)

    let nextTuning = { ...this.tuning, updatedAt: now }
    const interests = [...this.raySelf.snapshot(0).selfModel.interests]
    const topicTokens = tokenize(existing.topic)
    let matchedIdx = interests.findIndex(item => tokenOverlap(topicTokens, tokenize(item.topic)) > 0)

    if (reaction === 'accepted') {
      nextTuning = {
        ...nextTuning,
        naturalMentionThreshold: clamp(nextTuning.naturalMentionThreshold - 0.03, 0.3, 0.9),
      }
      if (matchedIdx >= 0) {
        const cur = interests[matchedIdx]!
        interests[matchedIdx] = { ...cur, weight: clamp(cur.weight + 0.12, 0.1, 1), lastActiveAt: now }
      } else {
        interests.push({
          id: `interest-${randomUUID().slice(0, 8)}`,
          topic: existing.topic,
          weight: 0.72,
          lastActiveAt: now,
          source: existing.source === 'web-learning' ? 'web' : existing.source === 'reflection' ? 'conversation' : existing.source,
        })
      }
      this.raySelf.recordGrowthEvent({ category: 'proactive-accepted', metricKey: existing.source, subjectId: ideaId })
    } else if (reaction === 'ignored') {
      nextTuning = {
        ...nextTuning,
        naturalMentionThreshold: clamp(nextTuning.naturalMentionThreshold + 0.02, 0.3, 0.9),
      }
      if (matchedIdx >= 0) {
        const cur = interests[matchedIdx]!
        interests[matchedIdx] = { ...cur, weight: clamp(cur.weight - 0.05, 0.1, 1) }
      }
    } else {
      nextTuning = {
        ...nextTuning,
        naturalMentionThreshold: clamp(nextTuning.naturalMentionThreshold + 0.08, 0.3, 0.92),
        dailyNaturalMentionCap: Math.max(1, nextTuning.dailyNaturalMentionCap - 1),
      }
      if (matchedIdx >= 0) {
        const cur = interests[matchedIdx]!
        interests[matchedIdx] = { ...cur, weight: clamp(cur.weight - 0.25, 0.08, 1) }
      }
      this.raySelf.recordGrowthEvent({ category: 'proactive-annoyed', metricKey: existing.source, subjectId: ideaId })
    }

    this.saveTuning(nextTuning)
    this.raySelf.evolveSelfModel({
      interests,
      reason: `根据 Owner 对点子「${existing.title}」的反馈（${reaction}）自动调节兴趣权重与主动阈值`,
    })
    const updatedRow = db.prepare('SELECT * FROM ray_ideas WHERE idea_id = ?').get(ideaId) as unknown as IdeaRow
    return { ok: true, idea: rowToIdea(updatedRow), tuning: nextTuning }
  }

  recordCandidateOutcome(input: {
    candidateId: string
    kind: string
    rootCause: string
    predictedImpact: string
    observedOutcome: string
    supplier: string
    disposition: RayCandidateDisposition
  }): RayCandidateOutcomeRecord {
    const db = this.assertOpen()
    const recordId = `out-${randomUUID()}`
    const createdAt = Date.now()
    db.prepare(`
      INSERT INTO ray_candidate_outcomes (
        record_id, candidate_id, kind, root_cause, predicted_impact, observed_outcome,
        supplier, disposition, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      input.candidateId,
      input.kind,
      input.rootCause,
      input.predictedImpact,
      input.observedOutcome,
      input.supplier,
      input.disposition,
      createdAt,
    )
    // Keep capped rejection/outcome ledger bounded to latest 200 records.
    db.prepare(`
      DELETE FROM ray_candidate_outcomes
      WHERE record_id NOT IN (
        SELECT record_id FROM ray_candidate_outcomes ORDER BY created_at DESC LIMIT ?
      )
    `).run(MAX_CANDIDATE_OUTCOMES)
    return { recordId, ...input, createdAt }
  }

  listCandidateOutcomes(limit = 20): RayCandidateOutcomeRecord[] {
    const db = this.assertOpen()
    const rows = db.prepare('SELECT * FROM ray_candidate_outcomes ORDER BY created_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Math.trunc(limit)))) as unknown as OutcomeRow[]
    return rows.map(r => ({
      recordId: r.record_id,
      candidateId: r.candidate_id,
      kind: r.kind,
      rootCause: r.root_cause,
      predictedImpact: r.predicted_impact,
      observedOutcome: r.observed_outcome,
      supplier: r.supplier,
      disposition: r.disposition,
      createdAt: r.created_at,
    }))
  }

  runReflection(
    cadence: RayReflectionCadence,
    options: {
      tokens?: number
      nowMs?: number
      conversationNote?: string
      seedTopics?: readonly string[]
      completedGoalIds?: readonly string[]
      invalidatedGoalIds?: readonly string[]
      newStageGoals?: readonly RayStageGoal[]
    } = {},
  ): {
    ok: boolean
    skipped?: boolean
    reason?: string
    reflection?: RayReflectionRecord
    energy: ReturnType<RayHomeRuntime['energySnapshot']>
  } {
    const db = this.assertOpen()
    const now = options.nowMs ?? Date.now()
    const tokenCost = Math.max(1, Math.trunc(options.tokens ?? (cadence === 'aftertaste' ? 400 : cadence === 'daily-diary' ? 800 : 1200)))
    const spent = this.raySelf.tryConsumeFreeEnergy(tokenCost, `reflection:${cadence}`)
    if (!spent.ok) {
      return {
        ok: false,
        skipped: true,
        reason: spent.check.reason,
        energy: this.raySelf.energySnapshot(),
      }
    }

    const snap = this.raySelf.snapshot(0)
    const growth = this.raySelf.growthReport()
    let summary = ''

    if (cadence === 'aftertaste') {
      const decayed: RayInterest[] = []
      let mutated = false
      for (const item of snap.selfModel.interests) {
        if (now - item.lastActiveAt > SEVEN_DAYS_MS) {
          const nextWeight = Number((item.weight * 0.95).toFixed(4))
          mutated = true
          if (nextWeight >= 0.1) decayed.push({ ...item, weight: nextWeight })
        } else {
          decayed.push(item)
        }
      }
      for (const topic of options.seedTopics ?? []) {
        const clean = topic.trim()
        if (clean === '') continue
        this.ingestSignal({
          source: 'reflection',
          title: clean,
          summary: options.conversationNote?.trim() || `事后回味联想主题：${clean}`,
          topic: clean,
          autoExplore: false,
        })
        if (!decayed.some(d => tokenOverlap(tokenize(d.topic), tokenize(clean)) > 0)) {
          decayed.push({
            id: `interest-${randomUUID().slice(0, 8)}`,
            topic: clean,
            weight: 0.55,
            lastActiveAt: now,
            source: 'conversation',
          })
          mutated = true
        }
      }
      if (mutated && decayed.length > 0) {
        this.raySelf.evolveSelfModel({
          interests: decayed,
          reason: 'aftertaste 事后回味反思：衰减陈旧兴趣并沉淀近期对话联想主题',
        })
      }
      summary = `事后回味（aftertaste）：巩固近期对话线索${options.seedTopics?.length ? `（新增点子 ${options.seedTopics.length} 项）` : ''}，保留 ${decayed.length} 个活跃兴趣。`
    } else if (cadence === 'daily-diary') {
      const sum = this.summary()
      summary = `每日日记（daily-diary）：今日 owner=${spent.snapshot.ownerTokensUsed} tokens，自由精力=${spent.snapshot.freeTokensUsed}/${spent.snapshot.freeAllowanceTokens} tokens；点子池待处理 ${sum.pooledCount} 项、静默探索 ${sum.exploredCount} 项。`
    } else if (cadence === 'weekly-review') {
      const outcomes = this.listCandidateOutcomes(10)
      const regressionHeadline = growth.ownerService.newlyRegressedCount > 0
        ? `优先修复新伤退化 ${growth.ownerService.newlyRegressedCount} 项（固有缺口 ${growth.ownerService.persistentGapCount} 项）`
        : `无新增新伤退化（固有缺口 ${growth.ownerService.persistentGapCount} 项）`
      summary = `每周复盘（weekly-review）：${regressionHeadline}；近 ${outcomes.length} 条候选归因三元组已核对，Owner 采纳率 ${(growth.proactiveValue.acceptanceRate * 100).toFixed(0)}%。`
    } else {
      const doneSet = new Set(options.completedGoalIds ?? [])
      const invSet = new Set(options.invalidatedGoalIds ?? [])
      const nextGoals: RayStageGoal[] = snap.selfModel.stageGoals.map(g => {
        if (doneSet.has(g.id)) return { ...g, status: 'completed', updatedAt: now }
        if (invSet.has(g.id)) return { ...g, status: 'invalidated', updatedAt: now }
        return g
      })
      for (const addGoal of options.newStageGoals ?? []) {
        if (!nextGoals.some(g => g.id === addGoal.id)) nextGoals.push(addGoal)
      }
      let activeCount = nextGoals.filter(g => g.status === 'active').length
      let replenIdx = 1
      while (activeCount < 2) {
        nextGoals.push({
          id: `goal-stage-${randomUUID().slice(0, 8)}`,
          title: `巩固可验证自主协作效率（阶段目标 #${replenIdx}）`,
          completionCriteria: '通过真实任务纠错率下降与新增技能零退化独立验证。',
          targetHorizonDays: 30,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        })
        activeCount += 1
        replenIdx += 1
      }
      // Trim excess active goals cleanly beyond 4 if needed, preserving latest goals.
      let seenActive = 0
      const boundedGoals: RayStageGoal[] = []
      for (let i = nextGoals.length - 1; i >= 0; i -= 1) {
        const g = nextGoals[i]!
        if (g.status === 'active') {
          if (seenActive >= 4) {
            boundedGoals.unshift({ ...g, status: 'completed', updatedAt: now })
          } else {
            seenActive += 1
            boundedGoals.unshift(g)
          }
        } else {
          boundedGoals.unshift(g)
        }
      }
      this.raySelf.evolveSelfModel({
        stageGoals: boundedGoals,
        reason: 'stage-review 阶段复盘：结算已完成/失效阶段目标并保持 2–4 个可衡量活跃目标（保留核心理想稳定）',
      })
      summary = `阶段复盘（stage-review）：完成 ${doneSet.size} 个目标、废止 ${invSet.size} 个目标，维持 ${seenActive} 个可衡量活跃阶段目标。`
    }

    const artifactPath = join(this.reflectionsDir, `${cadence}.jsonl`)
    const reflectionId = `refl-${randomUUID()}`
    const record: RayReflectionRecord = {
      reflectionId,
      cadence,
      summary,
      tokensUsed: tokenCost,
      artifactPath,
      createdAt: now,
    }
    appendFileSync(artifactPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    db.prepare(`
      INSERT INTO ray_reflections (reflection_id, cadence, summary, tokens_used, artifact_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reflectionId, cadence, summary, tokenCost, artifactPath, now)

    this.raySelf.recordAutobiography({
      kind: 'reflection',
      summary,
      reason: `${cadence} 节律反思（消耗自由精力 ${tokenCost} tokens）`,
      targetRef: reflectionId,
    })

    return {
      ok: true,
      reflection: record,
      energy: this.raySelf.energySnapshot(),
    }
  }

  listIdeas(filter: { tier?: RayIdeaTier; status?: RayIdeaStatus; limit?: number } = {}): RayIdeaRecord[] {
    const db = this.assertOpen()
    const clauses: string[] = []
    const params: (string | number)[] = []
    if (filter.tier !== undefined) {
      clauses.push('tier = ?')
      params.push(filter.tier)
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(100, Math.trunc(filter.limit ?? 20)))
    params.push(limit)
    const rows = db.prepare(`SELECT * FROM ray_ideas ${where} ORDER BY combined_score DESC, updated_at DESC LIMIT ?`)
      .all(...params) as unknown as IdeaRow[]
    return rows.map(rowToIdea)
  }

  summary(): RayCognitiveSummary {
    const db = this.assertOpen()
    const rows = db.prepare('SELECT tier, status, COUNT(*) AS cnt FROM ray_ideas GROUP BY tier, status')
      .all() as Array<{ tier: RayIdeaTier; status: RayIdeaStatus; cnt: number }>
    let pooledCount = 0
    let exploredCount = 0
    let naturalMentionCount = 0
    let proposeWorkCount = 0
    let acceptedCount = 0
    let annoyedCount = 0
    for (const r of rows) {
      if (r.status === 'pooled') pooledCount += r.cnt
      if (r.status === 'explored') exploredCount += r.cnt
      if (r.tier === 'natural_mention' && (r.status === 'pooled' || r.status === 'explored')) naturalMentionCount += r.cnt
      if (r.tier === 'propose_work' && r.status === 'pooled') proposeWorkCount += r.cnt
      if (r.status === 'accepted') acceptedCount += r.cnt
      if (r.status === 'annoyed') annoyedCount += r.cnt
    }
    const reflections = (db.prepare('SELECT * FROM ray_reflections ORDER BY created_at DESC LIMIT 6').all() as unknown as ReflectionRow[])
      .map(r => ({
        reflectionId: r.reflection_id,
        cadence: r.cadence,
        summary: r.summary,
        tokensUsed: r.tokens_used,
        artifactPath: r.artifact_path,
        createdAt: r.created_at,
      }))
    return {
      active: !this.closed,
      pooledCount,
      exploredCount,
      naturalMentionCount,
      proposeWorkCount,
      acceptedCount,
      annoyedCount,
      tuning: this.tuning,
      recentReflections: reflections,
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop()!
      try { fn() } catch { /* ignore */ }
    }
    try { this.db.close() } catch { /* ignore */ }
  }
}
