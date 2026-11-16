import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { getApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'

// Read the shipped composition, not an independently copied default.
const patch = readFileSync(new URL('../plugins/personal-assistant/cordis.patch.yml', import.meta.url), 'utf8')
const permissionConfig = parse(patch.split('\n- insert:')[0]!).find((entry: { id: string }) => entry.id === 'permission').config
const contexts: Context[] = []

async function fixture(defaultPreset: string = permissionConfig.defaultPreset) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  await ctx.plugin(AgentLoop, { agents: [] })
  // No OS command runs in this contract test; initialization reads this mode.
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(PermissionPresets, { ...permissionConfig, defaultPreset })
  return ctx
}

async function session(ctx: Context, seed?: readonly SessionEvent[]) {
  // Agent creation completes SessionStore entry/announcement and fires
  // agent/created where PermissionPresets pins the initial preset.
  const handle = await ctx.agents.create({
    sessionId: seed?.[0]?.sessionId ?? SessionId(randomUUID()),
    ...(seed === undefined ? {} : { seed: [...seed] }),
    meta: { cwd: '/work/owner', agentPreset: 'primary' },
  })
  return handle.agent.session
}

function expectPermission(ctx: Context, current: Session, preset: string, reviewer: 'user' | 'auto-review' | 'none') {
  expect(ctx.permissionPresets.current(current)).toBe(preset)
  expect(getApprovalReviewer(current)).toBe(reviewer)
  const spec = ctx.permissionPresets.resolve(preset)
  expect(current.snapshotEvents().findLast(event => event.type === 'sandbox/mode')?.data).toEqual({ mode: spec.sandbox })
  expect(current.snapshotEvents().findLast(event => event.type === 'approval/policy')?.data).toEqual({ policy: spec.approval })
}

afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart())) })

describe('shipped full-access default through the native Host permission service', () => {
  test('pins full access and no reviewer before the first fresh session turn', async () => {
    const ctx = await fixture()
    expect(ctx.permissionPresets.defaultPreset).toBe('danger-full-access')
    expectPermission(ctx, await session(ctx), 'danger-full-access', 'none')
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access'])
  })

  test.each([
    ['workspace-write', 'user'], ['danger-full-access', 'none'],
  ] as const)('honors the configured %s default instead of the shipped default', async (preset, reviewer) => {
    const ctx = await fixture(preset)
    expect(ctx.permissionPresets.defaultPreset).toBe(preset)
    expectPermission(ctx, await session(ctx), preset, reviewer)
  })

  test('keeps native Auto separate from the assistant reviewer', async () => {
    const ctx = await fixture()
    const current = await session(ctx)
    expect(() => ctx.permissionPresets.set(current, 'auto')).toThrow()
    ctx.permissionPresets.registerAuto(() => {})
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'danger-full-access', 'auto'])
    ctx.permissionPresets.set(current, 'auto')
    expectPermission(ctx, current, 'auto', 'user')
    expect(current.snapshotEvents().some(event => event.type === 'assistant-policy/approval-reviewer')).toBe(false)
  })

  test('allows a live downgrade and preserves it on replay without widening it on restart', async () => {
    const ctx = await fixture()
    const current = await session(ctx)
    ctx.permissionPresets.set(current, 'workspace-write')
    expectPermission(ctx, current, 'workspace-write', 'user')
    const restoredHost = await fixture()
    expectPermission(restoredHost, await session(restoredHost, current.snapshotEvents()), 'workspace-write', 'user')
  })

  test('a changed default on restart applies only to future sessions', async () => {
    const original = await fixture()
    const existing = await session(original)
    const changed = await fixture('workspace-write')
    expectPermission(changed, await session(changed), 'workspace-write', 'user')
    expectPermission(changed, await session(changed, existing.snapshotEvents()), 'danger-full-access', 'none')
    expectPermission(original, existing, 'danger-full-access', 'none')
  })

  test('keeps partially initialized restrictive sessions restrictive', async () => {
    const ctx = await fixture()
    const id = SessionId('partially-initialized-permission')
    const existing = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
      createdAt: 1, isSeeded: false, cwd: '/work/owner', agentPreset: 'primary' })
    existing.append('approval/policy', { policy: 'ask' })
    expectPermission(ctx, await session(ctx, existing.snapshotEvents()), 'workspace-write', 'user')
  })
})
