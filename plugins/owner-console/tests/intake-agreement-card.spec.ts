import { describe, expect, it, vi } from 'vitest'
import type { OwnerConsoleIntakeAgreement } from '../src/typert.ts'

/** A minimal working hook store: state persists across re-renders in call order, like React's. */
const hooks: { states: unknown[], refs: Array<{ current: unknown }>, state: number, ref: number } = { states: [], refs: [], state: 0, ref: 0 }
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const key = hooks.state++
      if (!(key in hooks.states)) hooks.states[key] = initial
      return [hooks.states[key], (value: unknown) => { hooks.states[key] = value }]
    },
    useRef: (value: unknown) => {
      const key = hooks.ref++
      hooks.refs[key] ??= { current: value }
      return hooks.refs[key]
    },
    useEffect: () => undefined,
  }
})

const { IntakeAgreementCard } = await import('../src/client.ts')

type Node = { type: unknown, props: Record<string, unknown> }
function expand(node: unknown): Node[] {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node === null || typeof node !== 'object' || !('type' in node)) return []
  const element = node as Node
  if (typeof element.type === 'function') return expand((element.type as (props: unknown) => unknown)(element.props))
  return [element, ...expand(element.props['children'])]
}
const text = (nodes: readonly Node[]) => nodes.flatMap(node => {
  const children = node.props['children']
  return (Array.isArray(children) ? children : [children]).filter(child => typeof child === 'string')
}).join('|')

const outcomes = { pending: 0, delivered: 0, reacted: 0, accepted: 1, rejected: 0, 'expired-unhandled': 0, failed: 0 }
const answer = (agreed: number): OwnerConsoleIntakeAgreement => ({ state: 'ok', causal: false, summary: { fromNotifiedAt: 1, toNotifiedAt: 2,
  scanned: agreed, truncated: false, provenanceAvailable: true, notIntake: 0, unresolved: 0, foreign: 0,
  intake: { notifications: agreed, items: agreed, outcomes: { ...outcomes, accepted: agreed }, agreed, disagreed: 0, agreementPpm: 1_000_000 },
  byLevel: [] } })

function harness() {
  hooks.states = []; hooks.refs = []
  const pending: Array<(value: unknown) => void> = []
  const intakeAgreement = vi.fn(() => new Promise(resolve => { pending.push(resolve) }))
  const intakeAgreementHistory = vi.fn(async () => ({ ok: true as const, value: { state: 'ok' as const, causal: false as const, snapshots: [] } }))
  const remote = { intakeAgreement, intakeAgreementHistory } as never
  const render = () => { hooks.state = 0; hooks.ref = 0; return expand(IntakeAgreementCard({ remote })) }
  const inputs = () => render().filter(node => node.type === 'input')
  const button = () => render().find(node => node.type === 'button')!
  const type = (index: number, value: string) => { (inputs()[index]!.props['onChange'] as (event: unknown) => void)({ target: { value } }) }
  return { intakeAgreement, intakeAgreementHistory, pending, render, button, type }
}

describe('intake agreement card', () => {
  it('reads only a complete scope and blocks a second read while one is in flight', async () => {
    const f = harness()
    expect(f.button().props['disabled']).toBe(true)
    f.type(0, '/work/alpha')
    expect(f.button().props['disabled']).toBe(true)
    f.type(1, 'primary')
    expect(f.button().props['disabled']).toBe(false)
    ;(f.button().props['onClick'] as () => void)()
    expect(f.intakeAgreement).toHaveBeenCalledExactlyOnceWith('/work/alpha', 'primary')
    expect(f.intakeAgreementHistory).toHaveBeenCalledExactlyOnceWith('/work/alpha', 'primary', 20)
    expect(f.button().props).toMatchObject({ disabled: true, children: '读取中…' })
    f.pending[0]!({ ok: true, value: answer(3) })
    await Promise.resolve(); await Promise.resolve()
    expect(text(f.render())).toContain('吻合 3 / 不吻合 0')
    expect(text(f.render())).toContain('还没有持久化')
    expect(f.button().props['disabled']).toBe(false)
  })

  it('never shows an answer for a scope that is no longer in the fields', async () => {
    const f = harness()
    f.type(0, '/work/alpha'); f.type(1, 'primary')
    ;(f.button().props['onClick'] as () => void)()
    // Editing the scope while the read is in flight drops its answer.
    f.type(0, '/work/beta')
    f.pending[0]!({ ok: true, value: answer(3) })
    await Promise.resolve(); await Promise.resolve()
    expect(text(f.render())).not.toContain('吻合 3')
    expect(text(f.render())).toContain('workspace 与 preset')
    ;(f.button().props['onClick'] as () => void)()
    expect(f.intakeAgreement).toHaveBeenLastCalledWith('/work/beta', 'primary')
    f.pending[1]!({ ok: true, value: answer(5) })
    await Promise.resolve(); await Promise.resolve()
    expect(text(f.render())).toContain('吻合 5 / 不吻合 0')
    // Editing after a shown answer clears it too.
    f.type(1, 'other')
    expect(text(f.render())).not.toContain('吻合 5')
  })
})
