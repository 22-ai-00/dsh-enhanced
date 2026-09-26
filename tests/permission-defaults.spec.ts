import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import SettingsProvider from '@deepseek-ai/dsh-settings'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { getApprovalReviewer } from '@dsh-enhanced/assistant-policy'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'

// Read the shipped composition, not an independently copied default.
const patch = readFileSync(new URL('../plugins/personal-assistant/cordis.patch.yml', import.meta.url), 'utf8')
const permissionConfig = parse(patch.split('\n- insert:')[0]!).find((entry: { id: string }) => entry.id === 'permission').config
const contexts: Context[] = []

class MemorySettings extends SettingsProvider {
  readonly writable = true
  constructor(ctx: Context, private readonly initial: Record<string, unknown>) { super(ctx) }
  async load() { return structuredClone(this.initial) }
  async persist(_namespace: string, _section: Record<string, unknown>) {}
}

async function fixture(document: Record<string, unknown> = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  // No OS command runs in this contract test; initialization reads this mode.
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings, document)
  await ctx.plugin(PermissionPresets, permissionConfig)
  await vi.waitFor(() => expect(ctx.settings.get('permission')).toBeDefined())
  return ctx
}

function session(ctx: Context, seed?: readonly SessionEvent[]) {
  // The real registry installs scoped append-publication hooks before it
  // announces creation. A detached Session + ctx.emit is not equivalent:
  // permission projections would not observe initialization events.
  return ctx.sessions.create(undefined, {
    ...(seed === undefined ? {} : { seed: [...seed] }),
    meta: { cwd: '/work/owner', agentPreset: 'primary' },
  })
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
    expectPermission(ctx, session(ctx), 'danger-full-access', 'none')
    expect(ctx.permissionPresets.names).toEqual(['workspace-write', 'auto', 'danger-full-access'])
  })

  test.each([
    ['workspace-write', 'user'], ['auto', 'auto-review'], ['danger-full-access', 'none'],
  ] as const)('honors the persisted user %s override instead of the bundle default', async (preset, reviewer) => {
    const ctx = await fixture({ permission: { defaultPreset: preset } })
    expect(ctx.permissionPresets.defaultPreset).toBe(preset)
    expectPermission(ctx, session(ctx), preset, reviewer)
  })

  test('allows a live downgrade and preserves it on replay without widening it on restart', async () => {
    const ctx = await fixture()
    const current = session(ctx)
    ctx.permissionPresets.set(current, 'workspace-write')
    expectPermission(ctx, current, 'workspace-write', 'user')
    const restoredHost = await fixture()
    expectPermission(restoredHost, session(restoredHost, current.snapshotEvents()), 'workspace-write', 'user')
  })

  test('changes future defaults without silently rewriting existing sessions', async () => {
    const ctx = await fixture()
    const existing = session(ctx)
    await ctx.settings.update('permission', { defaultPreset: 'auto' })
    expectPermission(ctx, session(ctx), 'auto', 'auto-review')
    expectPermission(ctx, existing, 'danger-full-access', 'none')
    await ctx.settings.replace('permission', {})
    expectPermission(ctx, session(ctx), 'danger-full-access', 'none')
  })

  test('keeps partially initialized restrictive sessions restrictive', async () => {
    const ctx = await fixture()
    const id = SessionId('partially-initialized-permission')
    const existing = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id,
      createdAt: 1, isSeeded: false, cwd: '/work/owner', agentPreset: 'primary' })
    existing.append('approval/policy', { policy: 'ask' })
    expectPermission(ctx, session(ctx, existing.snapshotEvents()), 'workspace-write', 'user')
  })
})
