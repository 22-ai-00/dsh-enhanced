import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AssistantPolicyService } from '../../lib/service.js'

// Run against a separately installed DSH CLI. This exercises its real
// PermissionPresetService.registerAuto and effect ownership.
const [cliPath] = process.argv.slice(2)
if (cliPath === undefined) throw new Error('usage: node auto-preset-host-probe.mjs /absolute/path/to/dsh')
const require = createRequire(await realpath(cliPath))
const { Context } = require('@deepseek-ai/cordis')
const { SessionStore } = require('@deepseek-ai/dsh-session')
const { default: PermissionPresetService } = require('@deepseek-ai/dsh-permission-presets')
const root = await mkdtemp(join(tmpdir(), 'policy-auto-host-probe-'))
const ctx = new Context()
try {
  new SessionStore(ctx)
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('approval', { config: { policy: 'ask' } })
  ctx.provide('sessionProjections', {
    register() {},
    stateOf() { return { preset: null, sandbox: null, approval: null, seeded: false } },
  })
  await ctx.plugin(PermissionPresetService, {
    presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Full' },
    },
  })
  const mountPolicy = () => ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  const mountNativeAuto = () => ctx.plugin({
    inject: ['permissionPresets'],
    apply(nativeCtx) {
      nativeCtx.permissionPresets.registerAuto(() => {})
    },
  })

  for (const policyFirst of [true, false]) {
    const first = policyFirst ? mountPolicy() : mountNativeAuto()
    await first
    assert.equal(ctx.permissionPresets.names.includes('auto'), !policyFirst)
    const second = policyFirst ? mountNativeAuto() : mountPolicy()
    await second
    assert.equal(ctx.assistantPolicy.health().emergencyStop, false)
    assert.equal(ctx.permissionPresets.names.filter(name => name === 'auto').length, 1)
    assert.deepEqual(ctx.permissionPresets.resolve('auto'), { sandbox: 'danger-full-access', approval: 'ask' })
    const [policy, nativeAuto] = policyFirst ? [first, second] : [second, first]
    await policy.dispose()
    assert.ok(ctx.permissionPresets.names.includes('auto'))
    await nativeAuto.dispose()
    assert.ok(!ctx.permissionPresets.names.includes('auto'))
  }

  console.log(JSON.stringify({
    status: 'passed',
    host: require('@deepseek-ai/dsh/package.json').version,
    checks: ['native-only-registerAuto', 'both-mount-orders', 'independent-disposal'],
  }))
} finally {
  await ctx.fiber.restart().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
