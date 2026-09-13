import { describe, expect, test } from 'vitest'
import { renderCompactGoalContext } from '../src/service.ts'

const record: any = {
  id: 'goal-current', version: 7, originalObjective: 'ignored',
  definition: { version: 4, digest: 'a'.repeat(64), objective: `Repair <broken> &#123; ${'objective '.repeat(80)}` },
  native: { phase: 'active', revision: 9, roundsStarted: 2 },
}
function decode(value: string): Record<string, unknown> {
  const json = value.split('<business-goal-data>\n')[1]!.split('\n</business-goal-data>')[0]!
    .replaceAll('&#123;', '{').replaceAll('&#125;', '}').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  return JSON.parse(json) as Record<string, unknown>
}

describe('compact goal context', () => {
  test('keeps current failed feedback as bounded valid JSON when full context cannot fit', () => {
    const feedback: any = { protocol: 'assistant-goals/feedback/v1', goalId: record.id, goalOutcome: 'unverified',
      definition: { version: record.definition.version, digest: record.definition.digest, objective: { excerpt: '', truncated: true } },
      verification: { current: { status: 'not-achieved', runId: 'run-current', criteria: [{ id: 'criterion-current', status: 'failed', reason: `Missing <evidence> {{unsafe}} ${'reason '.repeat(80)}` }] }, pending: null, history: [] },
      nextAction: 'revise-plan' }
    const context = renderCompactGoalContext(record, feedback, undefined, 1024)
    expect(context.length).toBeLessThanOrEqual(1024)
    expect(context).toContain('Truncated; native completion is not success or authority.')
    expect(context).not.toContain('{{unsafe}}')
    expect(context).not.toContain('<evidence>')
    expect(decode(context)).toMatchObject({ truncated: true, id: record.id,
      definition: { version: 4, digest: 'a'.repeat(64) }, native: { phase: 'active', revision: 9, roundsStarted: 2 }, outcome: 'unverified',
      feedback: { current: { status: 'not-achieved', runId: 'run-current' }, pending: null, nextAction: 'revise-plan' } })
    expect((decode(context) as any).feedback.current.criteria[0]).toMatchObject({ id: 'criterion-current', status: 'failed' })
    expect((decode(context) as any).feedback.current.criteria[0].reason).toContain('Missing <evidence>')
  })

  test('keeps a current expired or unknown result separate from a newer pending current-definition run', () => {
    for (const status of ['unknown', 'expired'] as const) {
      const feedback: any = { protocol: 'assistant-goals/feedback/v1', goalId: record.id, goalOutcome: 'unverified',
        definition: { version: 4, digest: 'a'.repeat(64), objective: { excerpt: '', truncated: false } },
        verification: { current: { status, runId: `settled-${status}`, criteria: [] }, pending: { status: 'pending', runId: `pending-${status}`, criteria: [] }, history: [{ status: 'achieved', runId: 'old-definition' }] },
        nextAction: 'await-verification' }
      const data: any = decode(renderCompactGoalContext(record, feedback, undefined, 1024))
      expect(data.feedback).toMatchObject({ current: { status, runId: `settled-${status}` }, pending: { status: 'pending', runId: `pending-${status}` }, nextAction: 'await-verification' })
      expect(JSON.stringify(data.feedback)).not.toContain('old-definition')
    }
  })

  test('keeps whole-goal failures distinct when the native step achieved its own criterion', () => {
    const feedback: any = { protocol: 'assistant-goals/feedback/v1', goalId: record.id, goalOutcome: 'unverified',
      definition: { version: 4, digest: 'a'.repeat(64), objective: { excerpt: '', truncated: false } },
      verification: { current: { status: 'achieved', runId: 'step-achieved', criteria: [{ id: 'step-only', status: 'passed', reason: 'step passed' }] }, pending: null, history: [] },
      nextAction: 'review-remaining-criteria' }
    const outcome: any = { status: 'not-achieved', definitionVersion: 4, assessmentId: 'whole-current',
      criteria: [{ id: 'whole-write', status: 'failed', reason: `Write validation failed: ${'missing durable evidence '.repeat(24)}` }, { id: 'whole-read', status: 'passed', reason: 'read passed' }] }
    const data: any = decode(renderCompactGoalContext(record, feedback, outcome, 1024))
    expect(data).toMatchObject({ outcome: 'not-achieved', wholeGoal: { status: 'not-achieved', criteria: [{ id: 'whole-write', status: 'failed' }] },
      feedback: { current: { status: 'achieved', runId: 'step-achieved' } } })
    expect(data.wholeGoal.criteria[0].reason).toContain('Write validation failed')
    expect(JSON.stringify(data.wholeGoal)).not.toContain('step-only')
  })

  test('never calls native completion achieved and retains valid JSON at the smallest render reservation', () => {
    const context = renderCompactGoalContext({ ...record, native: { ...record.native, phase: 'complete' } }, undefined, undefined, 256)
    expect(context.length).toBeLessThanOrEqual(256)
    expect(decode(context)).toMatchObject({ truncated: true, id: record.id, outcome: 'awaiting-verification' })
    expect(context).not.toContain('"achieved"')
  })
})
