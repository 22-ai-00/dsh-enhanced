import { describe, expect, test } from 'vitest'
import { compilePolicy, evaluatePolicy } from '../src/evaluator.ts'
import type { PolicyRequest, PolicyRule } from '../src/types.ts'

const baseRequest: PolicyRequest = {
  subject: {
    kind: 'agent',
    id: 'assistant-primary',
    workspace: '/work/projects/alpha',
  },
  action: 'execute',
  resource: {
    kind: 'tool',
    id: 'bash',
  },
  context: {
    initiator: 'foreground',
  },
}

function decide(rules: readonly PolicyRule[], request: PolicyRequest = baseRequest) {
  return evaluatePolicy(compilePolicy(rules), request)
}

describe('assistant policy evaluator', () => {
  test('fails closed when no rule matches', () => {
    expect(decide([])).toEqual({
      effect: 'deny',
      reasonCode: 'default-deny',
      ruleId: undefined,
    })
  })

  test('matches exact subject, action, and resource fields', () => {
    const decision = decide([{
      id: 'allow-primary-bash',
      effect: 'allow',
      subject: {
        kind: 'agent',
        id: 'assistant-primary',
        workspace: '/work/projects/alpha',
      },
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
    }])

    expect(decision).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'allow-primary-bash',
    })
  })

  test('supports bounded wildcard patterns', () => {
    const decision = decide([{
      id: 'allow-project-tools',
      effect: 'allow',
      subject: { kind: 'agent', id: 'assistant-*', workspace: '/work/projects/*' },
      actions: ['exec*'],
      resource: { kind: 'tool', id: '*' },
    }])

    expect(decision.effect).toBe('allow')
    expect(decision.ruleId).toBe('allow-project-tools')
  })

  test('gives any matching deny precedence over matching allows', () => {
    const decision = decide([
      {
        id: 'allow-project-tools',
        effect: 'allow',
        subject: { kind: 'agent', id: 'assistant-*', workspace: '/work/projects/*' },
        actions: ['execute'],
        resource: { kind: 'tool', id: '*' },
      },
      {
        id: 'deny-shell',
        effect: 'deny',
        actions: ['execute'],
        resource: { kind: 'tool', id: 'bash' },
      },
    ])

    expect(decision).toEqual({
      effect: 'deny',
      reasonCode: 'rule-deny',
      ruleId: 'deny-shell',
    })
  })

  test('matches foreground and background conditions explicitly', () => {
    const rules: PolicyRule[] = [{
      id: 'allow-foreground-read',
      effect: 'allow',
      actions: ['read'],
      resource: { kind: 'filesystem', id: '/work/projects/*' },
      context: { initiators: ['foreground'] },
    }]
    const foreground = {
      ...baseRequest,
      action: 'read',
      resource: { kind: 'filesystem' as const, id: '/work/projects/alpha/README.md' },
    }
    const background = {
      ...foreground,
      context: { initiator: 'background' as const },
    }

    expect(decide(rules, foreground).effect).toBe('allow')
    expect(decide(rules, background).reasonCode).toBe('default-deny')
  })

  test('keeps reversible preference authority separate from confirmed Memory writes', () => {
    const rules: PolicyRule[] = [{
      id: 'allow-local-preference-overlay',
      effect: 'allow',
      actions: ['activate'],
      resource: { kind: 'preference', id: '*' },
    }]
    const preference = {
      ...baseRequest,
      action: 'activate',
      resource: { kind: 'preference' as const, id: 'response.verbosity' },
    }
    const memory = {
      ...baseRequest,
      action: 'activate',
      resource: { kind: 'memory' as const, id: 'preference:response.verbosity' },
    }

    expect(decide(rules, preference).effect).toBe('allow')
    expect(decide(rules, memory).reasonCode).toBe('default-deny')
  })

  test('uses declaration order to break ties between matching deny rules', () => {
    const decision = decide([
      { id: 'first-deny', effect: 'deny', actions: ['execute'] },
      { id: 'second-deny', effect: 'deny', actions: ['execute'] },
    ])

    expect(decision.ruleId).toBe('first-deny')
  })

  test('carries a policy-owned hard-budget charge on an allow decision', () => {
    const decision = decide([{
      id: 'allow-budgeted-bash',
      effect: 'allow',
      actions: ['execute'],
      resource: { kind: 'tool', id: 'bash' },
      budget: { id: 'tool-calls', amount: 1 },
    }])

    expect(decision).toEqual({
      effect: 'allow',
      reasonCode: 'rule-allow',
      ruleId: 'allow-budgeted-bash',
      budget: { id: 'tool-calls', amount: 1 },
    })
  })

  test('rejects invalid hard-budget charges while compiling', () => {
    expect(() => compilePolicy([{
      id: 'invalid-budget',
      effect: 'allow',
      budget: { id: 'tool-calls', amount: 0 },
    }])).toThrow(/budget amount/i)
  })

  test('rejects duplicate rule identifiers while compiling', () => {
    expect(() => compilePolicy([
      { id: 'duplicate', effect: 'allow', actions: ['read'] },
      { id: 'duplicate', effect: 'deny', actions: ['write'] },
    ])).toThrow(/duplicate policy rule id/i)
  })

  test('snapshots caller-owned rules during compilation', () => {
    const rules: PolicyRule[] = [{
      id: 'allow-read',
      effect: 'allow',
      actions: ['read'],
    }]
    const compiled = compilePolicy(rules)
    rules[0]!.actions = ['write']

    expect(evaluatePolicy(compiled, { ...baseRequest, action: 'read' }).effect).toBe('allow')
    expect(evaluatePolicy(compiled, { ...baseRequest, action: 'write' }).effect).toBe('deny')
  })
})
