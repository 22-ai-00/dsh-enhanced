// Disposable real-Host fixture only; never included in a published plugin.
import { appendFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'

export default {
  name: 'replay-host-probe',
  inject: ['tools', 'agents'],
  async apply(ctx, config) {
    ctx.logger.exporter({ export(message) {
      if (message.type === 'error') process.stderr.write(`fixture Host error: ${message.args.map(String).join(' ')}\n`)
    } })
    const { defineTool } = await import(config.toolsModule)
    const record = (kind, sessionId) => appendFileSync(config.auditPath,
      JSON.stringify({ kind, sessionId, processId: process.pid }) + '\n', { mode: 0o600 })
    const lifetime = new AbortController()
    ctx.effect(() => () => lifetime.abort())
    ctx.on('agent/session-start', ({ agent }) => {
      if (!agent.session.id.startsWith('effect-replay-')) return
      record('create', agent.session.id)
      agent.ctx.tools.register(defineTool({ name: 'endpoint_probe', description: 'Fixture replay probe.', parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
        execute: async () => { record('tool-body', agent.session.id); return {} },
      }))
      agent.session.append('approval/policy', { policy: 'never' })
      agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
      agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
    })
    if (config.mode === 'crash') ctx.on('tools/pre-execute', async (_execution, next) => {
      record('gate-entered', null)
      await setTimeout(30_000, undefined, { signal: lifetime.signal })
      return next()
    })
    ctx.provide('replayFixture', {})
  },
}
