import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { AssistantPolicyService } from '../../lib/service.js'

// Run against a separately installed DSH CLI. This exercises its real
// PermissionPresetService.registerAuto rather than a local method double.
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
  const policy = ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  await policy
  const mountPermission = () => ctx.plugin(PermissionPresetService, {
    presets: {
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: 'Ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: 'Full' },
    },
  })

  const first = mountPermission()
  await first
  assert.ok(ctx.permissionPresets.names.includes('auto'))
  assert.deepEqual(ctx.permissionPresets.resolve('auto'), { sandbox: 'danger-full-access', approval: 'ask' })
  const firstAdmit = ctx.permissionPresets.autoAdmit
  assert.equal(typeof firstAdmit, 'function')
  firstAdmit()
  await first.dispose()
  assert.throws(firstAdmit, /integration is inactive/)

  const second = mountPermission()
  await second
  assert.ok(ctx.permissionPresets.names.includes('auto'))
  const secondAdmit = ctx.permissionPresets.autoAdmit
  secondAdmit()
  await policy.dispose()
  assert.ok(!ctx.permissionPresets.names.includes('auto'))
  assert.throws(secondAdmit, /integration is inactive/)
  await second.dispose()
  console.log(JSON.stringify({
    status: 'passed',
    host: require('@deepseek-ai/dsh/package.json').version,
    checks: ['actual-registerAuto', 'dependency-replacement', 'inactive-admission'],
  }))
} finally {
  await ctx.fiber.restart().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
