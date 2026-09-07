import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { buildGoalFeedback, type GoalStepFeedback } from './feedback.js'
import type { GoalBudgetRunUsage } from './budget-store.js'
import type { StrategyRecord } from './strategy-store.js'
import type { GoalExecutionRun, GoalRecord } from './types.js'

export interface GoalStrategyAssessment {
  readonly id: string
  readonly kind: StrategyRecord['intent']['kind']
  readonly state: StrategyRecord['state']
  readonly outcome?: StrategyRecord['outcome']
  readonly terminationReason?: StrategyRecord['terminationReason']
  readonly durationMs?: number
  readonly definitionCurrent: boolean
  readonly parentRunId: string
  readonly parentSessionId: string
  /** Correlation to one exact execution, never causal credit or a strategy verdict. */
  readonly attribution: 'same-parent-step-only'
  readonly parentStep: GoalStepFeedback | null
  readonly nextAction: 'reconcile-execution' | 'inspect-strategy-execution' | 'await-parent-verification'
    | 'inspect-parent-verification' | 'revise-solution' | 'review-remaining-goal' | 'plan-current-definition'
  readonly children: ReadonlyArray<Readonly<StrategyRecord['children'][number] & { usage?: Readonly<GoalBudgetRunUsage> }>>
}

export interface GoalStrategyHistory {
  readonly available: true
  readonly records: readonly GoalStrategyAssessment[]
}

const same = (left: unknown, right: unknown): boolean => {
  try { return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right) } catch { return false }
}

/** Read-only association. It revalidates the exact parent's independent receipt on every read. */
export function buildGoalStrategyHistory(
  goal: GoalRecord,
  strategies: readonly StrategyRecord[],
  runs: readonly GoalExecutionRun[],
  lookup: ((id: string) => unknown) | undefined,
  usage: (runId: string) => Readonly<GoalBudgetRunUsage> | undefined,
  now: number,
): GoalStrategyHistory {
  const records = strategies.slice(0, 32).filter(value => value.intent.goalId === goal.id && same(value.intent.scope, goal.scope)).slice(0, 3).map(value => {
    const intent = value.intent
    const matches = runs.slice(0, 50).filter(run => run.intent.runId === intent.parentRunId
      && run.intent.task.goal.runId === intent.parentRunId && run.intent.task.ref === intent.parentRunId
      && run.intent.task.goal.sessionId === intent.parentSessionId && intent.parentSessionId === goal.native.sessionId
      && run.intent.task.goal.nativeGoalId === goal.native.goalId && run.intent.task.goal.id === goal.id
      && run.intent.task.goal.definitionVersion === intent.definitionVersion && run.intent.task.goal.definitionDigest === intent.definitionDigest
      && same(run.intent.scope, intent.scope)
      && run.dispatchedAt !== undefined && run.dispatchedAt <= intent.createdAt
      && intent.createdAt < run.intent.admission.expiresAt && intent.expiresAt <= run.intent.admission.expiresAt)
    // Duplicate or absent parents are not resolved by picking whichever receipt passed.
    const assessed = matches.length === 1
      ? buildGoalFeedback(goal, matches, lookup, now).verification.history[0] ?? null : null
    const parentStep = assessed === null ? null : Object.freeze({ ...assessed,
      criteria: Object.freeze(assessed.criteria.slice(0, 3)), criteriaTruncated: assessed.criteriaTruncated || assessed.criteria.length > 3,
    })
    const definitionCurrent = intent.definitionVersion === goal.definition.version && intent.definitionDigest === goal.definition.digest
    const nextAction: GoalStrategyAssessment['nextAction'] = value.state === 'unknown' || value.children.some(child => !child.quiescent)
      || parentStep?.execution?.quiescent === false ? 'reconcile-execution'
      : !definitionCurrent ? 'plan-current-definition'
        : value.outcome === 'execution-failed' || value.outcome === 'cancelled' ? 'inspect-strategy-execution'
          : value.state === 'prepared' || value.state === 'starting' || parentStep?.status === 'pending' ? 'await-parent-verification'
            : parentStep?.status === 'not-achieved' ? 'revise-solution'
              : parentStep?.status === 'achieved' ? 'review-remaining-goal' : 'inspect-parent-verification'
    return Object.freeze({ id: intent.id, kind: intent.kind, state: value.state,
      ...(value.outcome === undefined ? {} : { outcome: value.outcome }),
      ...(value.terminationReason === undefined ? {} : { terminationReason: value.terminationReason }),
      ...(value.completedAt === undefined ? {} : { durationMs: value.completedAt - intent.createdAt }),
      definitionCurrent, parentRunId: intent.parentRunId, parentSessionId: intent.parentSessionId,
      attribution: 'same-parent-step-only' as const, parentStep, nextAction,
      children: Object.freeze(value.children.map(child => {
        const measured = usage(`strategy-${child.sessionId}`)
        const diagnostics = child.diagnostics === undefined ? undefined : Object.freeze({ ...child.diagnostics,
          ...(child.diagnostics.failure === undefined ? {} : { failure: Object.freeze({ ...child.diagnostics.failure }) }),
        })
        return Object.freeze({ ...child, ...(diagnostics === undefined ? {} : { diagnostics }), ...(measured === undefined ? {} : { usage: Object.freeze({ ...measured }) }) })
      })),
    })
  })
  return Object.freeze({ available: true, records: Object.freeze(records) })
}
