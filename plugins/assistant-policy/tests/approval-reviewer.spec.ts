import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, test } from 'vitest'
import {
  approvalReviewerOf,
  foldApprovalReviewer,
  getApprovalReviewer,
  setApprovalReviewer,
} from '../src/approval-reviewer.ts'

function session(seed: readonly SessionEvent[] = []): Session {
  const id = SessionId('approval-reviewer-test')
  return Session.create(id, seed, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: '/work/alpha',
    agentPreset: 'primary',
  })
}

function appendSandboxMode(current: Session, mode: 'workspace-write' | 'danger-full-access'): void {
  const append = current.append as unknown as (type: string, data: unknown) => unknown
  append.call(current, 'sandbox/mode', { mode })
}

function appendPermissionPreset(current: Session, preset: string): void {
  const append = current.append as unknown as (type: string, data: unknown) => unknown
  append.call(current, 'permission/preset', { preset })
}

describe('durable approval reviewer', () => {
  test('folds the last event and replays it from a restored event log', () => {
    const original = session()
    expect(foldApprovalReviewer(original.events)).toBeUndefined()
    expect(approvalReviewerOf(original.events)).toBe('user')
    expect(setApprovalReviewer(original, 'auto-review')).toBe(true)
    expect(getApprovalReviewer(original)).toBe('user')
    original.append('approval/policy', { policy: 'ask' })
    expect(getApprovalReviewer(original)).toBe('user')
    appendSandboxMode(original, 'workspace-write')
    expect(getApprovalReviewer(original)).toBe('auto-review')

    const replayed = session(structuredClone(original.events))
    expect(foldApprovalReviewer(replayed.events)).toBe('auto-review')
    expect(approvalReviewerOf(replayed.events)).toBe('auto-review')
    expect(getApprovalReviewer(replayed)).toBe('auto-review')
  })

  test('validates values and does not append the current effective value', () => {
    const current = session()
    const initialLength = current.events.length
    expect(setApprovalReviewer(current, 'user')).toBe(false)
    expect(current.events).toHaveLength(initialLength)
    expect(() => setApprovalReviewer(current, 'automatic' as never)).toThrow(TypeError)
    expect(current.events).toHaveLength(initialLength)

    expect(setApprovalReviewer(current, 'auto-review')).toBe(true)
    const length = current.events.length
    expect(setApprovalReviewer(current, 'auto-review')).toBe(false)
    expect(current.events).toHaveLength(length)
  })

  test('requires an explicit coherent sandbox, approval, and reviewer triple for full access', () => {
    const never = session()
    never.append('approval/policy', { policy: 'never' })
    expect(approvalReviewerOf(never.events)).toBe('user')
    expect(setApprovalReviewer(never, 'auto-review')).toBe(true)
    expect(foldApprovalReviewer(never.events)).toBe('auto-review')
    expect(getApprovalReviewer(never)).toBe('user')

    setApprovalReviewer(never, 'none')
    expect(getApprovalReviewer(never)).toBe('user')
    appendSandboxMode(never, 'danger-full-access')
    expect(getApprovalReviewer(never)).toBe('none')

    appendSandboxMode(never, 'workspace-write')
    expect(getApprovalReviewer(never)).toBe('user')

    const ask = session()
    appendSandboxMode(ask, 'danger-full-access')
    setApprovalReviewer(ask, 'none')
    expect(foldApprovalReviewer(ask.events)).toBe('none')
    expect(getApprovalReviewer(ask)).toBe('user')

    ask.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(getApprovalReviewer(ask)).toBe('user')
  })

  test('treats malformed explicit permission events as stricter than missing defaults', () => {
    const invalidApproval = session()
    appendSandboxMode(invalidApproval, 'workspace-write')
    setApprovalReviewer(invalidApproval, 'auto-review')
    const appendApproval = invalidApproval.append as unknown as (type: string, data: unknown) => unknown
    appendApproval.call(invalidApproval, 'approval/policy', { policy: 'sometimes' })
    expect(getApprovalReviewer(invalidApproval)).toBe('user')

    const invalidSandbox = session()
    setApprovalReviewer(invalidSandbox, 'auto-review')
    const appendSandbox = invalidSandbox.append as unknown as (type: string, data: unknown) => unknown
    appendSandbox.call(invalidSandbox, 'sandbox/mode', { mode: 'host-write' })
    expect(getApprovalReviewer(invalidSandbox)).toBe('user')
  })

  test('uses the latest official three-level preset as reviewer intent without a custom event', () => {
    const current = session()
    appendSandboxMode(current, 'workspace-write')
    current.append('approval/policy', { policy: 'ask' })

    appendPermissionPreset(current, 'auto')
    expect(foldApprovalReviewer(current.events)).toBeUndefined()
    expect(getApprovalReviewer(current)).toBe('auto-review')

    appendPermissionPreset(current, 'workspace-write')
    expect(getApprovalReviewer(current)).toBe('user')

    current.append('approval/policy', { policy: 'never' })
    appendSandboxMode(current, 'danger-full-access')
    appendPermissionPreset(current, 'danger-full-access')
    expect(getApprovalReviewer(current)).toBe('none')
    expect(current.events.some(event => event.type === 'assistant-policy/approval-reviewer')).toBe(false)
  })

  test('folds official preset and legacy reviewer events in durable log order', () => {
    const current = session()
    appendSandboxMode(current, 'workspace-write')
    current.append('approval/policy', { policy: 'ask' })

    setApprovalReviewer(current, 'auto-review')
    appendPermissionPreset(current, 'workspace-write')
    expect(getApprovalReviewer(current)).toBe('user')

    setApprovalReviewer(current, 'auto-review')
    expect(getApprovalReviewer(current)).toBe('auto-review')

    appendPermissionPreset(current, 'auto')
    setApprovalReviewer(current, 'user')
    appendPermissionPreset(current, 'auto')
    expect(getApprovalReviewer(current)).toBe('auto-review')
  })

  test('fails closed when official reviewer intent and execution knobs are incoherent', () => {
    const auto = session()
    appendPermissionPreset(auto, 'auto')
    expect(getApprovalReviewer(auto)).toBe('user')
    auto.append('approval/policy', { policy: 'ask' })
    appendSandboxMode(auto, 'danger-full-access')
    expect(getApprovalReviewer(auto)).toBe('user')

    const full = session()
    appendPermissionPreset(full, 'danger-full-access')
    full.append('approval/policy', { policy: 'never' })
    appendSandboxMode(full, 'workspace-write')
    expect(getApprovalReviewer(full)).toBe('user')
  })
})
