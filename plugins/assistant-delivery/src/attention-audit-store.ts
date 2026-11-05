import type { DatabaseSync } from 'node:sqlite'
import { attentionAuditReasons, type AttentionAssessment, type AttentionAuditEntry, type AttentionAuditReason, type AttentionLane, type AttentionLedgerView } from './attention.js'

/** Append-only WP19 stage-1 audit. One row per Outbox record; replays keep the first verdict. */
export const attentionAuditSchema = `
  CREATE TABLE delivery_attention_audit (
    outbox_id TEXT PRIMARY KEY REFERENCES outbox_messages(id),
    audit_sequence INTEGER NOT NULL UNIQUE CHECK(audit_sequence>=1),
    binding_id TEXT NOT NULL,
    lane TEXT NOT NULL CHECK(lane IN ('background','background-route','owner-notification','automation-result','work-item-report','scheduled-goal-result')),
    source_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('result','attention','answer')),
    purpose_source TEXT NOT NULL CHECK(purpose_source IN ('declared','lane','default')),
    work_item_id TEXT,
    question_id TEXT,
    answers_question_id TEXT,
    word_count INTEGER NOT NULL CHECK(word_count>=0),
    word_cap INTEGER NOT NULL CHECK(word_cap>=1),
    verdict TEXT NOT NULL CHECK(verdict IN ('would-accept','would-attach','would-reject')),
    reasons_json TEXT NOT NULL CHECK(json_valid(reasons_json)),
    recorded_at INTEGER NOT NULL CHECK(recorded_at>=0)
  ) STRICT;
  CREATE INDEX delivery_attention_audit_question ON delivery_attention_audit(binding_id,question_id);
  CREATE INDEX delivery_attention_audit_answer ON delivery_attention_audit(binding_id,answers_question_id);
  CREATE INDEX delivery_attention_audit_work_item ON delivery_attention_audit(binding_id,work_item_id);
  CREATE TRIGGER delivery_attention_audit_immutable BEFORE UPDATE ON delivery_attention_audit
    BEGIN SELECT RAISE(ABORT,'attention audit is append-only'); END;
  CREATE TRIGGER delivery_attention_audit_no_delete BEFORE DELETE ON delivery_attention_audit
    BEGIN SELECT RAISE(ABORT,'attention audit is durable'); END;
`

interface Row {
  outbox_id: string; audit_sequence: number; binding_id: string; lane: AttentionLane; source_id: string
  purpose: AttentionAssessment['purpose']; purpose_source: AttentionAssessment['purposeSource']
  work_item_id: string | null; question_id: string | null; answers_question_id: string | null
  word_count: number; word_cap: number; verdict: AttentionAssessment['verdict']; reasons_json: string; recorded_at: number
}

function entry(row: Row): AttentionAuditEntry {
  const reasons = JSON.parse(row.reasons_json) as unknown
  if (!Array.isArray(reasons) || !reasons.every(reason => (attentionAuditReasons as readonly unknown[]).includes(reason))) {
    throw new Error('invalid attention audit reasons')
  }
  return Object.freeze({
    sequence: row.audit_sequence, outboxId: row.outbox_id, bindingId: row.binding_id, lane: row.lane, sourceId: row.source_id,
    purpose: row.purpose, purposeSource: row.purpose_source,
    ...(row.work_item_id === null ? {} : { workItemId: row.work_item_id }),
    ...(row.question_id === null ? {} : { questionId: row.question_id }),
    ...(row.answers_question_id === null ? {} : { answersQuestionId: row.answers_question_id }),
    wordCount: row.word_count, wordCap: row.word_cap, verdict: row.verdict,
    reasons: Object.freeze(reasons as AttentionAuditReason[]), recordedAt: row.recorded_at,
  })
}

export class AttentionAuditStore {
  constructor(private readonly database: DatabaseSync, private readonly transaction: <T>(fn: () => T) => T, private readonly now: () => number) {}

  get(outboxId: string): AttentionAuditEntry | undefined {
    const row = this.database.prepare('SELECT * FROM delivery_attention_audit WHERE outbox_id=?').get(outboxId) as unknown as Row | undefined
    return row === undefined ? undefined : entry(row)
  }

  /** Only non-rejected rows establish question state; a would-reject notice never opens or settles a question. */
  ledger(bindingId: string): AttentionLedgerView {
    return {
      questionAsked: questionId => this.database.prepare(`SELECT 1 FROM delivery_attention_audit WHERE binding_id=? AND question_id=?
        AND purpose='attention' AND verdict!='would-reject' LIMIT 1`).get(bindingId, questionId) !== undefined,
      questionAnswered: questionId => this.database.prepare(`SELECT 1 FROM delivery_attention_audit WHERE binding_id=? AND answers_question_id=?
        AND purpose='answer' AND verdict!='would-reject' LIMIT 1`).get(bindingId, questionId) !== undefined,
      openQuestions: workItemId => (this.database.prepare(`SELECT DISTINCT q.question_id AS id FROM delivery_attention_audit q
        WHERE q.binding_id=? AND q.work_item_id=? AND q.purpose='attention' AND q.verdict!='would-reject' AND q.question_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM delivery_attention_audit a WHERE a.binding_id=q.binding_id AND a.answers_question_id=q.question_id
          AND a.purpose='answer' AND a.verdict!='would-reject') ORDER BY q.question_id`).all(bindingId, workItemId) as { id: string }[])
        .map(row => row.id),
      questionWorkItem: questionId => (this.database.prepare(`SELECT work_item_id FROM delivery_attention_audit WHERE binding_id=? AND question_id=?
        AND purpose='attention' AND verdict!='would-reject' AND work_item_id IS NOT NULL ORDER BY audit_sequence LIMIT 1`)
        .get(bindingId, questionId) as { work_item_id: string } | undefined)?.work_item_id,
    }
  }

  /**
   * Durable gap detector, derived by query (no extra state): Outbox rows that
   * carry a durable marker of an audited lane, were created at or after the
   * first audit row, and have no audit row. Plain `enqueueBackground` rows
   * carry no lane marker and are not counted here. Gaps before the first
   * successful audit write are not detectable.
   */
  unauditedOutboxCount(): number {
    return (this.database.prepare(`SELECT count(*) AS count FROM outbox_messages o
      WHERE o.created_at >= (SELECT min(recorded_at) FROM delivery_attention_audit)
      AND NOT EXISTS(SELECT 1 FROM delivery_attention_audit a WHERE a.outbox_id=o.id)
      AND (json_extract(o.intent_json,'$.metadata."dsh.native-notice"')='v1'
        OR json_extract(o.intent_json,'$.metadata."dsh.route.authority"') IS NOT NULL
        OR json_extract(o.intent_json,'$.metadata."dsh.learning.kind"') IN ('automation-run','goal-outcome')
        OR EXISTS(SELECT 1 FROM delivery_goal_outcome_targets g WHERE g.outbox_id=o.id)
        OR EXISTS(SELECT 1 FROM delivery_work_item_reports r WHERE r.outbox_id=o.id))`).get() as { count: number }).count
  }

  /**
   * WP19 stage 2b split-evasion input: inline bodies (Outbox text, never the
   * attachment) of audited notices from one source on one binding and lane,
   * recorded within the last `windowMs` of this store's clock (the same clock
   * that stamps `recorded_at`, so the window survives restarts), in audit
   * order. Notices that were never audited (best-effort audit write failed)
   * are not visible here.
   */
  recentInlineTexts(input: Readonly<{ bindingId: string; lane: AttentionLane; sourceId: string; windowMs: number }>): readonly string[] {
    return (this.database.prepare(`SELECT json_extract(o.intent_json,'$.text') AS text FROM delivery_attention_audit a
      JOIN outbox_messages o ON o.id=a.outbox_id
      WHERE a.binding_id=? AND a.lane=? AND a.source_id=? AND a.recorded_at>=? ORDER BY a.audit_sequence`)
      .all(input.bindingId, input.lane, input.sourceId, Math.max(0, this.now() - input.windowMs)) as { text: unknown }[])
      .map(row => typeof row.text === 'string' ? row.text : '')
  }

  /** Assess against the committed ledger and append in one writer transaction; an existing row wins. */
  record(input: Readonly<{ outboxId: string; bindingId: string; lane: AttentionLane; sourceId: string }>,
    assess: (ledger: AttentionLedgerView) => AttentionAssessment): AttentionAuditEntry {
    return this.transaction(() => {
      const existing = this.get(input.outboxId)
      if (existing !== undefined) return existing
      const assessment = assess(this.ledger(input.bindingId))
      const next = (this.database.prepare('SELECT coalesce(max(audit_sequence),0)+1 AS next FROM delivery_attention_audit').get() as { next: number }).next
      this.database.prepare(`INSERT INTO delivery_attention_audit(outbox_id,audit_sequence,binding_id,lane,source_id,purpose,purpose_source,
        work_item_id,question_id,answers_question_id,word_count,word_cap,verdict,reasons_json,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.outboxId, next, input.bindingId, input.lane, input.sourceId, assessment.purpose, assessment.purposeSource,
          assessment.workItemId ?? null, assessment.questionId ?? null, assessment.answersQuestionId ?? null,
          assessment.wordCount, assessment.wordCap, assessment.verdict, JSON.stringify(assessment.reasons), this.now())
      return this.get(input.outboxId)!
    })
  }

  list(afterSequence: number, limit: number): { entries: readonly AttentionAuditEntry[]; hasMore: boolean } {
    const rows = this.database.prepare('SELECT * FROM delivery_attention_audit WHERE audit_sequence>? ORDER BY audit_sequence LIMIT ?')
      .all(afterSequence, limit + 1) as unknown as Row[]
    return { entries: Object.freeze(rows.slice(0, limit).map(entry)), hasMore: rows.length > limit }
  }
}
