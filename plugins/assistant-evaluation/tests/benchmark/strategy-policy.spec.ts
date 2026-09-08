import { describe, expect, test } from 'vitest'
import { assertStrategyPolicyConfiguration } from '../../src/benchmark/strategy-policy.js'

function configuration() {
  const external = { initiators: ['external'] }
  const subject = { kind: 'agent', id: 'benchmark', workspace: '/work' }
  return { toolDefaultEffect: 'deny', budgets: [], autoReview: null, rules: [
    { id: 'benchmark-pair-issue', effect: 'allow', subject: { kind: 'external', id: 'local:benchmark-bootstrap-a' }, actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    { id: 'benchmark-owner-ingest', effect: 'allow', subject: { kind: 'external', id: 'principal-a' }, actions: ['pair.confirm', 'ingest'], resource: { kind: 'message', id: '*' }, context: external },
    { id: 'benchmark-owner-reply', effect: 'allow', subject: { ...subject, principal: 'principal-a' }, actions: ['reply'], resource: { kind: 'message', id: '*' }, context: external },
    { id: 'benchmark-goal', effect: 'allow', subject, actions: ['create', 'observe', 'inspect', 'focus', 'checkpoint', 'snapshot', 'execute', 'delegate'], resource: { kind: 'goal', id: 'business-context' }, context: external },
    ...['goal_create', 'goal_context', 'goal_checkpoint', 'isolation_run', 'goal_strategy', 'isolation:benchmark-work'].map(id => ({ id: `allow-${id.replace(':', '-')}`, effect: 'allow', subject, actions: ['execute'], resource: { kind: 'tool', id }, context: external })),
  ] }
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

describe('strategy Policy configuration', () => {
  test('accepts only the exact owner and enabled-strategy rule configuration', () => {
    expect(assertStrategyPolicyConfiguration(configuration(), true, '/work').toolDefaultEffect).toBe('deny')
  })
  test.each([
    ['extra allow', (value: any) => value.rules.push({ id: 'allow-all', effect: 'allow', subject: { kind: '*' }, actions: ['execute'], resource: { kind: '*', id: '*' }, context: { initiators: ['external'] } })],
    ['cross workspace', (value: any) => { value.rules.find((rule: any) => rule.id === 'allow-goal_create').subject.workspace = '/other' }],
    ['principal widening', (value: any) => { value.rules.find((rule: any) => rule.id === 'benchmark-owner-ingest').subject.id = '*' }],
    ['bootstrap wildcard', (value: any) => { value.rules[0].subject.id = 'local:benchmark-bootstrap-*' }],
    ['consistent principal wildcard', (value: any) => { value.rules[1].subject.id = '*'; value.rules[2].subject.principal = '*' }],
    ['default allow', (value: any) => { value.toolDefaultEffect = 'allow' }],
    ['budget widening', (value: any) => { value.budgets = [{ id: 'all', metric: 'toolCalls', limit: 999, periodMs: 1, scope: 'global' }] }],
    ['auto review widening', (value: any) => { value.autoReview = { enabled: true } }],
    ['extra field in rule', (value: any) => { value.rules[0].unexpected = true }],
    ['missing field', (value: any) => { delete value.rules[0].context }],
  ])('rejects %s', (_label: string, mutate: (value: any) => void) => {
    const value = copy(configuration()); mutate(value)
    expect(() => assertStrategyPolicyConfiguration(value, true, '/work')).toThrow()
  })
})
