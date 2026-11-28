declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ray-episodic': {
      kind: 'ray-episodic'
      episodeIds: readonly string[]
    }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'compaction/prune': {
      shadowedRange: { start: import('@deepseek-ai/dsh-session').SessionSeq; end: import('@deepseek-ai/dsh-session').SessionSeq }
      shadowedSeqs: import('@deepseek-ai/dsh-session').SessionSeq[]
      shadowedTokenCount: number
    }
  }
}

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantPolicyService } from '@dsh-ray/assistant-policy'

export interface RayEpisodeSummary {
  readonly episodeId: string
  readonly title: string
  readonly topicKeywords: readonly string[]
  readonly channels: readonly string[]
  readonly sessionIds: readonly string[]
  readonly ticketId?: string
  readonly turnCount: number
  readonly charCount: number
  readonly previewText: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly closedAt?: number
}

export interface RayEpisodeTurnRecord {
  readonly turnId: string
  readonly episodeId: string
  readonly sessionId: string
  readonly channel: string
  readonly turnNumber: number
  readonly seqStart: number
  readonly seqEnd: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly ticketId?: string
  readonly createdAt: number
}

export interface RayEpisodeRecallResult {
  readonly episodes: readonly RayEpisodeSummary[]
  readonly turns: readonly RayEpisodeTurnRecord[]
}

export interface RaySurfacePruneResult {
  readonly pruned: boolean
  readonly prunedNodeCount: number
  readonly archivedTurnsCount: number
  readonly shadowedTokenCount: number
  readonly episodeIds: readonly string[]
  readonly pointerSeq?: SessionSeq
}

export interface RayEpisodicRuntimeOptions {
  readonly rayHome: string
  readonly policy: AssistantPolicyService
  readonly resolveChannel: (session: Session) => string
  readonly idleSplitMs?: number
  readonly maxSurfaceNodes?: number
  readonly retainRecentNodes?: number
  readonly warn?: (message: string) => void
}

interface RayEpisodeRow {
  episode_id: string
  title: string
  topic_keywords: string
  channels_json: string
  session_ids_json: string
  ticket_id: string | null
  turn_count: number
  char_count: number
  first_turn_id: string | null
  last_turn_id: string | null
  preview_text: string
  started_at: number
  updated_at: number
  closed_at: number | null
}

interface RayEpisodeTurnRow {
  turn_id: string
  episode_id: string
  session_id: string
  channel: string
  turn_number: number
  seq_start: number
  seq_end: number
  role: string
  text: string
  ticket_id: string | null
  created_at: number
}

const DEFAULT_IDLE_SPLIT_MS = 30 * 60_000
const DEFAULT_MAX_SURFACE_NODES = 64
const DEFAULT_RETAIN_RECENT_NODES = 16
const TOPIC_SPLIT_MIN_TURNS = 12

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'have', 'what', 'when', 'where', 'will',
  'your', 'about', 'into', 'they', 'been', 'were', 'also', 'just', 'like', 'some', 'please',
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何', '现在', '已经', '可以', '就是', '但是', '因为',
])

function extractTextFromBlocks(blocks: readonly { type?: unknown; text?: unknown }[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

function extractMessageText(event: SessionEvent): string {
  if (event.type === 'user/message') {
    const sourceKind = (event.data as { source?: { kind?: unknown } }).source?.kind
    if (sourceKind === 'runtime-context' || sourceKind === 'compact-checkpoint' || sourceKind === 'ray-episodic') {
      return ''
    }
    return extractTextFromBlocks((event.data as UserMessage).content)
  }
  if (event.type === 'assistant/message') {
    return extractTextFromBlocks(event.data.message.content)
  }
  return ''
}

function tokenizeTopic(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const lower = text.toLowerCase()
  const latinMatches = lower.match(/[a-z0-9_-]{2,}/gu) ?? []
  for (const tok of latinMatches) {
    if (!STOPWORDS.has(tok) && !seen.has(tok)) {
      seen.add(tok)
      out.push(tok)
    }
  }
  const cjkRuns = lower.match(/[\u4e00-\u9fff]{2,}/gu) ?? []
  for (const run of cjkRuns) {
    for (let i = 0; i <= run.length - 2; i += 1) {
      const bg = run.slice(i, i + 2)
      if (!STOPWORDS.has(bg) && !seen.has(bg)) {
        seen.add(bg)
        out.push(bg)
      }
      if (out.length >= 24) break
    }
    if (out.length >= 24) break
  }
  return out.slice(0, 24)
}

function keywordOverlapRatio(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 1
  const setA = new Set(a)
  let hit = 0
  for (const item of b) {
    if (setA.has(item)) hit += 1
  }
  return hit / Math.min(setA.size, b.length)
}

function makeEpisodeTitle(text: string, ticketId?: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  const base = clean.length > 48 ? `${clean.slice(0, 47)}…` : clean || '日常对话片段'
  return ticketId ? `[${ticketId}] ${base}` : base
}

function estimateFallbackTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8')
  return Math.max(1, Math.ceil(bytes / 3))
}

function episodeRowToSummary(row: RayEpisodeRow): RayEpisodeSummary {
  return Object.freeze({
    episodeId: row.episode_id,
    title: row.title,
    topicKeywords: JSON.parse(row.topic_keywords) as string[],
    channels: JSON.parse(row.channels_json) as string[],
    sessionIds: JSON.parse(row.session_ids_json) as string[],
    ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id }),
    turnCount: row.turn_count,
    charCount: row.char_count,
    previewText: row.preview_text,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  })
}

function turnRowToRecord(row: RayEpisodeTurnRow): RayEpisodeTurnRecord {
  return Object.freeze({
    turnId: row.turn_id,
    episodeId: row.episode_id,
    sessionId: row.session_id,
    channel: row.channel,
    turnNumber: row.turn_number,
    seqStart: row.seq_start,
    seqEnd: row.seq_end,
    role: row.role as 'user' | 'assistant',
    text: row.text,
    ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id }),
    createdAt: row.created_at,
  })
}

export function extractRayTicketId(session: Session): string | undefined {
  const id = String(session.id)
  if (!id.startsWith('ray_worker_')) return undefined
  for (const ev of session.snapshotEvents()) {
    if (ev.type === 'user/message') {
      const source = (ev.data as { source?: { kind?: unknown; ticketId?: unknown } }).source
      if (source?.kind === 'ray-worker' && typeof source.ticketId === 'string') return source.ticketId
    }
  }
  return undefined
}

export class RayEpisodicRuntime {
  readonly turnsFilePath: string
  readonly databasePath: string
  private db: DatabaseSync | undefined
  private hasFts5 = false
  private closed = false
  private readonly idleSplitMs: number
  private readonly maxSurfaceNodes: number
  private readonly retainRecentNodes: number
  private readonly disposers: (() => void)[] = []

  constructor(private readonly ctx: Context, private readonly options: RayEpisodicRuntimeOptions) {
    const cleanHome = options.rayHome.replace(/\/+$/u, '')
    this.turnsFilePath = join(cleanHome, 'life-stream', 'turns.jsonl')
    this.databasePath = join(cleanHome, 'episodes', 'episodes.sqlite')
    this.idleSplitMs = options.idleSplitMs ?? DEFAULT_IDLE_SPLIT_MS
    this.maxSurfaceNodes = options.maxSurfaceNodes ?? DEFAULT_MAX_SURFACE_NODES
    this.retainRecentNodes = options.retainRecentNodes ?? DEFAULT_RETAIN_RECENT_NODES

    mkdirSync(dirname(this.turnsFilePath), { recursive: true, mode: 0o700 })
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    if (!existsSync(this.turnsFilePath)) {
      appendFileSync(this.turnsFilePath, '', { encoding: 'utf8', mode: 0o600 })
    }

    const db = new DatabaseSync(this.databasePath)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS ray_episodes (
        episode_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        topic_keywords TEXT NOT NULL,
        channels_json TEXT NOT NULL,
        session_ids_json TEXT NOT NULL,
        ticket_id TEXT,
        turn_count INTEGER NOT NULL DEFAULT 0,
        char_count INTEGER NOT NULL DEFAULT 0,
        first_turn_id TEXT,
        last_turn_id TEXT,
        preview_text TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_ray_episodes_updated ON ray_episodes(updated_at DESC);
      CREATE TABLE IF NOT EXISTS ray_episode_turns (
        turn_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        seq_start INTEGER NOT NULL,
        seq_end INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        ticket_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ray_episode_turns_ep ON ray_episode_turns(episode_id, seq_start);
      CREATE INDEX IF NOT EXISTS idx_ray_episode_turns_session ON ray_episode_turns(session_id, seq_start);
    `)
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS ray_episode_turns_fts USING fts5(turn_id UNINDEXED, episode_id UNINDEXED, text);')
      this.hasFts5 = true
    } catch {
      this.hasFts5 = false
    }
    this.db = db

    const raySelf = options.policy.raySelf as { registerDatabase?: (plugin: string, dbPath: string) => void } | undefined
    try {
      raySelf?.registerDatabase?.('personal-memory/episodes', this.databasePath)
    } catch {
      // Ignore if manifest has not opened yet.
    }

    this.disposers.push(ctx.on('session/event', (session, event) => {
      if (this.closed) return
      if (session.header.origin === 'subagent') return
      if (event.type === 'turn/end') {
        try {
          this.captureSessionTurns(session)
        } catch (error) {
          this.options.warn?.(`personal-memory: failed to capture life-stream turn: ${String(error)}`)
        }
      }
    }))

    this.disposers.push(ctx.on('agent/pre-step', async (payload, next) => {
      if (!this.closed) {
        const agent = (payload as { agent?: Agent }).agent
          ?? (ctx.get('agents' as never) as { currentInitiator?: () => Agent | undefined } | undefined)?.currentInitiator?.()
        const incomingCount = Array.isArray((payload as { messages?: unknown[] }).messages)
          ? (payload as { messages: unknown[] }).messages.length
          : 1
        // Account for incoming claimed user message(s) and expected assistant reply so surface stays within maxSurfaceNodes after the turn.
        if (agent !== undefined && agent.session.header.origin !== 'subagent'
          && agent.session.surface.nodes.length + incomingCount + 1 > this.maxSurfaceNodes) {
          try {
            this.pruneSessionSurface(agent.session)
          } catch (error) {
            this.options.warn?.(`personal-memory: automatic zero-LLM surface prune skipped: ${String(error)}`)
          }
        }
      }
      return await next()
    }, { prepend: true }))

    const promptFiber = ctx.inject(['systemPrompt'], promptCtx => promptCtx.systemPrompt.context({
      name: 'ray:episodic-recall',
      order: 238,
      text: ({ agent }) => {
        if (this.closed || agent?.session?.header.origin === 'subagent') return ''
        return this.renderPromptContext()
      },
    }))
    this.disposers.push(() => { void promptFiber.dispose() })
  }

  private assertOpen(): DatabaseSync {
    if (this.closed || this.db === undefined) {
      throw new Error('personal-memory: ray episodic runtime is closed')
    }
    return this.db
  }

  isSessionEligible(agent: Agent | undefined): boolean {
    if (this.closed || agent === undefined) return false
    return agent.session.header.origin !== 'subagent'
  }

  captureSessionTurns(session: Session, onlySeqs?: ReadonlySet<number>): readonly string[] {
    const db = this.assertOpen()
    if (session.header.origin === 'subagent') return []

    const sessionId = String(session.id)
    const channel = this.options.resolveChannel(session)
    const ticketId = extractRayTicketId(session)
    const touchedEpisodes: string[] = []
    const seenEpisodes = new Set<string>()

    let turnNumber = 0
    for (const ev of session.snapshotEvents()) {
      if (ev.type === 'turn/start') {
        turnNumber = ev.data.turn
        continue
      }
      if (onlySeqs !== undefined && !onlySeqs.has(Number(ev.seq))) continue
      if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue

      const text = extractMessageText(ev)
      if (text === '') continue

      const turnId = `${sessionId}:${Number(ev.seq)}`
      const existing = db.prepare('SELECT episode_id FROM ray_episode_turns WHERE turn_id = ?').get(turnId) as { episode_id: string } | undefined
      if (existing !== undefined) {
        if (!seenEpisodes.has(existing.episode_id)) {
          seenEpisodes.add(existing.episode_id)
          touchedEpisodes.push(existing.episode_id)
        }
        continue
      }

      const role: 'user' | 'assistant' = ev.type === 'user/message' ? 'user' : 'assistant'
      const createdAt = typeof ev.time === 'number' && Number.isSafeInteger(ev.time) ? ev.time : Date.now()
      const episodeId = this.assignAndRecordTurn({
        turnId,
        sessionId,
        channel,
        turnNumber,
        seqStart: Number(ev.seq),
        seqEnd: Number(ev.seq),
        role,
        text,
        ...(ticketId === undefined ? {} : { ticketId }),
        createdAt,
      })
      if (!seenEpisodes.has(episodeId)) {
        seenEpisodes.add(episodeId)
        touchedEpisodes.push(episodeId)
      }
    }
    return touchedEpisodes
  }

  private assignAndRecordTurn(input: Omit<RayEpisodeTurnRecord, 'episodeId'>): string {
    const db = this.assertOpen()
    const keywords = tokenizeTopic(input.text)
    const open = db.prepare('SELECT * FROM ray_episodes WHERE closed_at IS NULL ORDER BY updated_at DESC LIMIT 1')
      .get() as unknown as RayEpisodeRow | undefined

    let episodeRow = open
    let shouldSplit = false
    if (episodeRow !== undefined) {
      const existingKeywords = JSON.parse(episodeRow.topic_keywords) as string[]
      if (input.createdAt - episodeRow.updated_at >= this.idleSplitMs) {
        shouldSplit = true
      } else if (input.ticketId !== undefined && episodeRow.ticket_id !== null && input.ticketId !== episodeRow.ticket_id) {
        shouldSplit = true
      } else if (episodeRow.turn_count >= TOPIC_SPLIT_MIN_TURNS
        && keywords.length >= 2
        && existingKeywords.length >= 2
        && keywordOverlapRatio(keywords, existingKeywords) < 0.12) {
        shouldSplit = true
      }
      if (shouldSplit) {
        db.prepare('UPDATE ray_episodes SET closed_at = ? WHERE episode_id = ?').run(input.createdAt, episodeRow.episode_id)
        episodeRow = undefined
      }
    }

    if (episodeRow === undefined) {
      const episodeId = `ep_${randomBytes(6).toString('hex')}`
      const title = makeEpisodeTitle(input.text, input.ticketId)
      const channelsJson = JSON.stringify([input.channel])
      const sessionsJson = JSON.stringify([input.sessionId])
      const preview = input.text.length > 240 ? `${input.text.slice(0, 239)}…` : input.text
      db.prepare(`
        INSERT INTO ray_episodes (
          episode_id, title, topic_keywords, channels_json, session_ids_json, ticket_id,
          turn_count, char_count, first_turn_id, last_turn_id, preview_text,
          started_at, updated_at, closed_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL)
      `).run(
        episodeId,
        title,
        JSON.stringify(keywords),
        channelsJson,
        sessionsJson,
        input.ticketId ?? null,
        input.turnId,
        input.turnId,
        preview,
        input.createdAt,
        input.createdAt,
      )
      episodeRow = db.prepare('SELECT * FROM ray_episodes WHERE episode_id = ?').get(episodeId) as unknown as RayEpisodeRow
    }

    const episodeId = episodeRow.episode_id
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO ray_episode_turns (
        turn_id, episode_id, session_id, channel, turn_number, seq_start, seq_end, role, text, ticket_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.turnId,
      episodeId,
      input.sessionId,
      input.channel,
      input.turnNumber,
      input.seqStart,
      input.seqEnd,
      input.role,
      input.text,
      input.ticketId ?? null,
      input.createdAt,
    )

    if (Number(inserted.changes) > 0) {
      if (this.hasFts5) {
        try {
          db.prepare('INSERT INTO ray_episode_turns_fts (turn_id, episode_id, text) VALUES (?, ?, ?)')
            .run(input.turnId, episodeId, input.text)
        } catch {
          // Non-fatal: substring LIKE remains available.
        }
      }

      const channels = new Set<string>(JSON.parse(episodeRow.channels_json) as string[])
      channels.add(input.channel)
      const sessions = new Set<string>(JSON.parse(episodeRow.session_ids_json) as string[])
      sessions.add(input.sessionId)
      const mergedKeywords = new Set<string>(JSON.parse(episodeRow.topic_keywords) as string[])
      for (const kw of keywords) {
        if (mergedKeywords.size >= 36) break
        mergedKeywords.add(kw)
      }
      const nextPreview = input.role === 'user' && episodeRow.turn_count === 0
        ? (input.text.length > 240 ? `${input.text.slice(0, 239)}…` : input.text)
        : episodeRow.preview_text

      db.prepare(`
        UPDATE ray_episodes
        SET channels_json = ?, session_ids_json = ?, topic_keywords = ?,
            turn_count = turn_count + 1, char_count = char_count + ?,
            last_turn_id = ?, preview_text = ?, updated_at = MAX(updated_at, ?)
        WHERE episode_id = ?
      `).run(
        JSON.stringify([...channels]),
        JSON.stringify([...sessions]),
        JSON.stringify([...mergedKeywords]),
        input.text.length,
        input.turnId,
        nextPreview,
        input.createdAt,
        episodeId,
      )

      const lineObj: RayEpisodeTurnRecord = {
        turnId: input.turnId,
        episodeId,
        sessionId: input.sessionId,
        channel: input.channel,
        turnNumber: input.turnNumber,
        seqStart: input.seqStart,
        seqEnd: input.seqEnd,
        role: input.role,
        text: input.text,
        ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
        createdAt: input.createdAt,
      }
      appendFileSync(this.turnsFilePath, `${JSON.stringify(lineObj)}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    return episodeId
  }

  listRecentEpisodes(limit = 10): readonly RayEpisodeSummary[] {
    if (this.closed || this.db === undefined) return []
    const rows = this.db.prepare('SELECT * FROM ray_episodes ORDER BY updated_at DESC LIMIT ?')
      .all(Math.max(1, Math.min(50, Math.floor(limit)))) as unknown as RayEpisodeRow[]
    return rows.map(episodeRowToSummary)
  }

  recall(args: { query?: string; episodeId?: string; channel?: string; limit?: number }): RayEpisodeRecallResult {
    const db = this.assertOpen()
    const limit = Math.max(1, Math.min(40, Math.floor(args.limit ?? 8)))

    if (args.episodeId !== undefined && args.episodeId.trim() !== '') {
      const epId = args.episodeId.trim()
      const epRow = db.prepare('SELECT * FROM ray_episodes WHERE episode_id = ?').get(epId) as unknown as RayEpisodeRow | undefined
      const turns = db.prepare('SELECT * FROM ray_episode_turns WHERE episode_id = ? ORDER BY created_at ASC, seq_start ASC LIMIT ?')
        .all(epId, limit) as unknown as RayEpisodeTurnRow[]
      return {
        episodes: epRow === undefined ? [] : [episodeRowToSummary(epRow)],
        turns: turns.map(turnRowToRecord),
      }
    }

    const query = args.query?.trim() ?? ''
    const channel = args.channel?.trim()
    let turnRows: RayEpisodeTurnRow[] = []

    if (query === '') {
      turnRows = channel
        ? db.prepare('SELECT * FROM ray_episode_turns WHERE channel = ? ORDER BY created_at DESC, seq_start DESC LIMIT ?')
            .all(channel, limit) as unknown as RayEpisodeTurnRow[]
        : db.prepare('SELECT * FROM ray_episode_turns ORDER BY created_at DESC, seq_start DESC LIMIT ?')
            .all(limit) as unknown as RayEpisodeTurnRow[]
    } else {
      const matchedIds: string[] = []
      const seen = new Set<string>()
      const tokens = tokenizeTopic(query)
      if (this.hasFts5 && tokens.length > 0) {
        const ftsExpr = tokens.map(t => `"${t.replaceAll('"', '')}"`).join(' OR ')
        try {
          const hits = db.prepare('SELECT turn_id FROM ray_episode_turns_fts WHERE ray_episode_turns_fts MATCH ? LIMIT ?')
            .all(ftsExpr, limit * 3) as unknown as { turn_id: string }[]
          for (const h of hits) {
            if (!seen.has(h.turn_id)) {
              seen.add(h.turn_id)
              matchedIds.push(h.turn_id)
            }
          }
        } catch {
          // Fall back cleanly to LIKE matching below.
        }
      }
      const patterns = [...new Set([query, ...tokens.slice(0, 6)])]
      for (const pat of patterns) {
        const rows = db.prepare(
          channel
            ? 'SELECT * FROM ray_episode_turns WHERE channel = ? AND text LIKE ? ORDER BY created_at DESC LIMIT ?'
            : 'SELECT * FROM ray_episode_turns WHERE text LIKE ? ORDER BY created_at DESC LIMIT ?',
        ).all(...(channel ? [channel, `%${pat}%`, limit * 2] : [`%${pat}%`, limit * 2])) as unknown as RayEpisodeTurnRow[]
        for (const r of rows) {
          if (!seen.has(r.turn_id)) {
            seen.add(r.turn_id)
            matchedIds.push(r.turn_id)
          }
        }
      }
      if (matchedIds.length > 0) {
        const placeholders = matchedIds.slice(0, limit).map(() => '?').join(',')
        turnRows = db.prepare(`SELECT * FROM ray_episode_turns WHERE turn_id IN (${placeholders}) ORDER BY created_at ASC, seq_start ASC`)
          .all(...matchedIds.slice(0, limit)) as unknown as RayEpisodeTurnRow[]
      }
    }

    const epIds = [...new Set(turnRows.map(t => t.episode_id))]
    const epRows: RayEpisodeRow[] = []
    if (epIds.length > 0) {
      const placeholders = epIds.map(() => '?').join(',')
      const fetched = db.prepare(`SELECT * FROM ray_episodes WHERE episode_id IN (${placeholders}) ORDER BY updated_at DESC`)
        .all(...epIds) as unknown as RayEpisodeRow[]
      epRows.push(...fetched)
    }
    return {
      episodes: epRows.map(episodeRowToSummary),
      turns: turnRows.map(turnRowToRecord),
    }
  }

  renderPromptContext(): string {
    const episodes = this.listRecentEpisodes(8)
    if (episodes.length === 0) return ''
    const lines = [
      '## 情景记忆与生活流（Verbatim Episodic Recall）',
      `- 所有跨端原话已只追加保存在 \`${this.turnsFilePath}\` 与 \`episodes.sqlite\`；对话窗口自动无 LLM 裁剪后不会丢失任何原话。`,
      '- 需要回忆早期准确细节、原话、决定或跨渠道上下文时，请调用 `episode_recall({ query | episode_id | channel })` 读取原话，不要猜测。',
      '',
      '### 近期对话片段',
    ]
    for (const ep of episodes) {
      lines.push(`- ${ep.episodeId} | ${ep.title} | 渠道: ${ep.channels.join(',')}`)
    }
    return lines.join('\n')
  }

  pruneSessionSurface(
    session: Session,
    options: { retainRecentNodes?: number; minPruneNodes?: number } = {},
  ): RaySurfacePruneResult {
    this.assertOpen()
    const retainRecentNodes = options.retainRecentNodes ?? this.retainRecentNodes
    const minPruneNodes = options.minPruneNodes ?? 4
    const surfaceNodes = [...session.surface.nodes]
    if (surfaceNodes.length <= retainRecentNodes + minPruneNodes) {
      return { pruned: false, prunedNodeCount: 0, archivedTurnsCount: 0, shadowedTokenCount: 0, episodeIds: [] }
    }

    const events = session.snapshotEvents()
    let openTurnStartSeq: number | undefined
    for (const ev of events) {
      if (ev.type === 'turn/start') openTurnStartSeq = Number(ev.seq)
      if (ev.type === 'turn/end') openTurnStartSeq = undefined
    }

    // Track tool-call pairing across surface order so we never split call/result pairs.
    const pendingCalls = new Set<string>()
    const balancedBefore: boolean[] = []
    const balancedAfter: boolean[] = []
    for (let i = 0; i < surfaceNodes.length; i += 1) {
      balancedBefore.push(pendingCalls.size === 0)
      const ev = session.eventAt(surfaceNodes[i]!)
      if (ev?.type === 'assistant/message') {
        for (const block of ev.data.message.content) {
          if (block.type === 'tool-call') pendingCalls.add(String(block.id))
        }
      } else if (ev?.type === 'tool/result') {
        const callId = ev.data.message.toolCallId
        if (callId !== undefined) pendingCalls.delete(String(callId))
      }
      balancedAfter.push(pendingCalls.size === 0)
    }

    let startIdx = 0
    if (session.eventAt(surfaceNodes[0]!)?.type === 'system/message') {
      startIdx = 1
    }
    while (startIdx < surfaceNodes.length && !balancedBefore[startIdx]) {
      startIdx += 1
    }

    let endIdx = surfaceNodes.length - 1 - retainRecentNodes
    if (openTurnStartSeq !== undefined) {
      while (endIdx >= startIdx && Number(surfaceNodes[endIdx]!) >= openTurnStartSeq) {
        endIdx -= 1
      }
    }
    while (endIdx >= startIdx && !balancedAfter[endIdx]) {
      endIdx -= 1
    }

    if (endIdx < startIdx || (endIdx - startIdx + 1) < minPruneNodes) {
      return { pruned: false, prunedNodeCount: 0, archivedTurnsCount: 0, shadowedTokenCount: 0, episodeIds: [] }
    }

    const shadowedSeqs = surfaceNodes.slice(startIdx, endIdx + 1)
    const seqSet = new Set(shadowedSeqs.map(Number))

    // Capture all shadowed turns verbatim into life-stream + episodes.sqlite before replacing surface nodes.
    const newlyCapturedEpisodes = this.captureSessionTurns(session, seqSet)
    const mergedEpisodeIds = new Set<string>(newlyCapturedEpisodes)
    const priorEpisodePointers: string[] = []
    let archivedTurnsCount = 0
    let shadowedTokenCount = 0

    const meter = this.ctx.get('tokenMeter' as never) as { estimateMessage?: (msg: unknown) => number } | undefined
    for (const seq of shadowedSeqs) {
      const ev = session.eventAt(seq)
      if (ev === undefined) continue
      const derived = session.deriveEventMessage(ev)
      if (derived !== null && typeof meter?.estimateMessage === 'function') {
        shadowedTokenCount += Math.max(1, meter.estimateMessage(derived))
      } else {
        const raw = extractMessageText(ev)
        shadowedTokenCount += estimateFallbackTokens(raw || JSON.stringify(ev.data))
      }
      if (ev.type === 'user/message') {
        const src = (ev.data as { source?: { kind?: unknown; episodeIds?: readonly string[] } }).source
        if (src?.kind === 'ray-episodic' && Array.isArray(src.episodeIds)) {
          for (const epId of src.episodeIds) {
            mergedEpisodeIds.add(epId)
            priorEpisodePointers.push(epId)
          }
        } else if (extractMessageText(ev) !== '') {
          archivedTurnsCount += 1
        }
      } else if (ev.type === 'assistant/message' && extractMessageText(ev) !== '') {
        archivedTurnsCount += 1
      }
    }

    const db = this.assertOpen()
    const totalSessionTurns = (db.prepare('SELECT COUNT(*) AS c FROM ray_episode_turns WHERE session_id = ?')
      .get(String(session.id)) as { c: number }).c
    const episodeList = [...mergedEpisodeIds]
    const recentEpisodeLines = episodeList.slice(-6).map(epId => {
      const row = db.prepare('SELECT episode_id, title, turn_count FROM ray_episodes WHERE episode_id = ?').get(epId) as {
        episode_id: string
        title: string
        turn_count: number
      } | undefined
      return row ? `${row.episode_id}(${row.title}, ${row.turn_count}条)` : epId
    })

    const pointerText = [
      `[Ray 无LLM表面裁剪索引｜已原话归档 ${archivedTurnsCount} 条本段发言，累计会话原话 ${totalSessionTurns} 条]`,
      `关联对话片段：${recentEpisodeLines.join('；') || '生活流归档'}`,
      '如需引用早期准确原话、代码/配置/约束或具体数据，请调用 episode_recall({ episode_id | query })，禁止凭印象脑补。',
    ].join('\n')

    const pointerMessage = createUserMessage({
      content: [{ type: 'text', text: pointerText }],
      source: {
        kind: 'ray-episodic',
        episodeIds: episodeList,
      },
    })
    const replacementTokens = typeof meter?.estimateMessage === 'function'
      ? Math.max(1, meter.estimateMessage(pointerMessage))
      : estimateFallbackTokens(pointerText)
    if (shadowedTokenCount <= replacementTokens && shadowedSeqs.length < 8) {
      return { pruned: false, prunedNodeCount: 0, archivedTurnsCount: 0, shadowedTokenCount: 0, episodeIds: [] }
    }

    const startSeq = shadowedSeqs[0]!
    const endSeq = shadowedSeqs[shadowedSeqs.length - 1]!
    const pruneEvent = session.append('compaction/prune', {
      shadowedRange: { start: startSeq, end: endSeq },
      shadowedSeqs: [...shadowedSeqs],
      shadowedTokenCount,
    })
    const replaceEvent = session.append('user/message', pointerMessage, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: [pruneEvent.seq, ...shadowedSeqs],
    })
    return {
      pruned: true,
      prunedNodeCount: shadowedSeqs.length,
      archivedTurnsCount,
      shadowedTokenCount,
      episodeIds: episodeList,
      pointerSeq: replaceEvent.seq,
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop()!
      try { fn() } catch {}
    }
    try {
      this.db?.close()
    } catch {}
    this.db = undefined
  }
}

export function createCompactionId(): string {
  return randomUUID()
}
