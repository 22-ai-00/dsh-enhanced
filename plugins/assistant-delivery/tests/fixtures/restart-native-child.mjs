import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, root] = process.argv.slice(2)
if (!['seed', 'claim', 'resume', 'resume-false', 'resume-throw', 'resume-revoke', 'resume-followup-throw', 'resume-drift', 'settle', 'inspect'].includes(mode) || !root) {
  throw new Error('usage: restart-native-child <mode> <root>')
}
const require = createRequire(new URL('../../package.json', import.meta.url))
const load = async name => await import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { AgentRegistry } = await load('@deepseek-ai/dsh-agent')
const { default: AgentLoop } = await load('@deepseek-ai/dsh-agent-loop')
const { LlmAdapter, LlmRuntime } = await load('@deepseek-ai/dsh-llm')
const { SessionStore } = await load('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { name: jsonlName, apply: applyJsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime } = await load('@deepseek-ai/dsh-tools')
const native = await import(new URL('../../lib/restart-native.js', import.meta.url))
const output = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const state = (agent, message) => {
  try { return native.inspectRestartContinuation(agent, message) }
  catch (error) { return { kind: 'error', code: error.code } }
}

class Adapter extends LlmAdapter {
  calls = 0
  async *stream() {
    this.calls++
    output({ event: 'model-start', calls: this.calls })
    if (mode === 'claim') await new Promise(() => {})
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'continuation completed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'continuation completed' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
new SessionProjectionRegistry(ctx)
await ctx.plugin({ name: jsonlName, apply: applyJsonl }, { root: join(root, 'sessions'), compression: 'none' })
await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' })
await ctx.plugin(ToolRuntime, { mode: 'native' })
await ctx.plugin(AgentRegistry)
await ctx.plugin(AgentLoop, { agents: [] })
const adapter = new Adapter()
ctx.llm.registerAdapter(['fixture'], adapter)
let activeAgent
// The production Delivery lane must persist the native claim/header and its
// budget reservation before next() reaches the model.  A Session-only cold
// repair cannot reconstruct an unflushed claim after SIGKILL.
ctx.on('llm/stream', async function* (_request, next) {
  if (mode === 'claim' && activeAgent && !await ctx.sessions.flush(activeAgent.session)) {
    throw new Error('native claim was not durable before model dispatch')
  }
  yield* next()
}, { prepend: true })
const message = native.createRestartContinuation({ continuationId: 'task-1', text: mode === 'resume-drift'
  ? 'Different text under the same continuation ID' : 'Continue the original owner task after maintenance.' })
const handle = mode === 'seed' || mode === 'claim' || mode === 'settle'
  ? await ctx.agents.create({ sessionId: 'restart-native-session', meta: { cwd: root },
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  : await ctx.agents.resume({ resumeSessionId: 'restart-native-session',
    agentOptions: { provider: 'fixture', model: 'fixture' } })
const agent = handle.agent
activeAgent = agent
if (mode === 'resume-followup-throw') {
  const original = agent.followup.bind(agent)
  agent.followup = message => { original(message); throw new Error('fixture throw after native append') }
}
if (mode === 'seed') {
  agent.send(message, 'next-turn', false)
  if (!await ctx.sessions.flush(agent.session)) throw new Error('seed pending flush failed')
  output({ event: 'seeded', state: native.inspectRestartContinuation(agent, message).kind, calls: adapter.calls })
  setInterval(() => {}, 1_000)
} else if (mode === 'inspect') {
  output({ event: 'inspected', state: state(agent, message), calls: adapter.calls })
  await handle.dispose(); await ctx.fiber.dispose()
} else {
  let error
  let checks = 0
  try {
    await native.admitRestartContinuation(agent, message, {
      authorize: () => {
        if (mode === 'resume-revoke' && ++checks === 2) {
          throw new native.RestartContinuationError('authorization-revoked', 'fixture owner revoked after flush')
        }
      },
      flush: async () => mode === 'resume-false' ? false
        : mode === 'resume-throw' ? Promise.reject(new Error('fixture flush error'))
          : ctx.sessions.flush(agent.session),
    })
  } catch (cause) { error = { name: cause.name, code: cause.code, message: cause.message } }
  if (mode === 'claim') {
    setInterval(() => {}, 1_000)
  } else {
    await agent.whenIdle()
    if (error === undefined) await ctx.sessions.flush(agent.session)
    output({ event: 'settled', state: state(agent, message),
      calls: adapter.calls, error, turns: agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length })
    await handle.dispose(); await ctx.fiber.dispose()
  }
}
