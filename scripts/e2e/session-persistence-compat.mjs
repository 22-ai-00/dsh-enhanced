import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Explicit CLI path: only its installed module graph is read. All runtime
// storage is temporary, with a fresh process for each write/cold-read phase.
const [cliPath, mode, storageRoot] = process.argv.slice(2)
if (!cliPath) throw new Error('Usage: node scripts/e2e/session-persistence-compat.mjs /absolute/path/to/dsh')
const cli = await realpath(cliPath)
if (!mode) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-persistence-compat-'))
  try {
    for (const phase of ['write', 'unregistered', 'read']) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), cli, phase, root], {
        encoding: 'utf8', timeout: 30_000,
      })
      assert.equal(result.status, 0, `${phase}: ${result.error ?? ''}\n${result.stderr}\n${result.stdout}`)
      process.stdout.write(result.stdout)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
} else {
  const require = createRequire(cli)
  const { Context } = require('@deepseek-ai/cordis')
  const { default: Loader } = require('@deepseek-ai/cordis-plugin-loader')
  const { SessionStore, SessionId, SESSION_FORMAT_VERSION } = require('@deepseek-ai/dsh-session')
  const { registerApprovalReviewerSessionEvent } = await import('../../plugins/assistant-policy/lib/session-event-registration.js')
  const { setApprovalReviewer, foldApprovalReviewer } = await import('../../plugins/assistant-policy/lib/approval-reviewer.js')
  const ctx = new Context()
  try {
    new SessionStore(ctx)
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(cli).href })
    const loader = ctx.loader
    await loader.create({ name: '@deepseek-ai/dsh-session-persistence-jsonl', config: {
      root: join(storageRoot, 'sessions'), compression: 'none',
    } })
    await loader.await()
    assert.ok(ctx.sessionPersistence)
    const id = SessionId('policy-cold-compat')
    if (mode === 'unregistered') {
      await assert.rejects(ctx.sessionPersistence.open(id, 'read'), /assistant-policy\/approval-reviewer.*unknown to this harness/)
    } else {
      const registration = registerApprovalReviewerSessionEvent(ctx)
      await registration.assertReady()
      assert.equal(registration.isReady(), true)
      if (mode === 'write') {
        const session = ctx.sessions.create(id, { meta: { cwd: storageRoot, agentPreset: 'primary', delegationDepth: 0 } })
        // Modern Agent admission acquires a write handle before publishing
        // the Session. Reproduce that storage contract for this focused probe.
        const writer = await ctx.sessionPersistence.create(session.header)
        try {
          await writer.append(session.snapshotEvents())
          setApprovalReviewer(session, 'auto-review')
          assert.equal(await ctx.sessions.flush(session), true)
        } finally { await writer.close() }
      } else if (mode === 'read') {
        const handle = await ctx.sessionPersistence.open(id, 'read')
        try {
          const result = await handle.read()
          assert.equal(foldApprovalReviewer(result.events), 'auto-review')
          assert.ok(result.events.some(event => event.type === 'assistant-policy/approval-reviewer' && event.ignorable !== true))
        } finally { await handle.close() }
      } else throw new Error('unknown phase')
    }
    console.log(JSON.stringify({ phase: mode, status: 'passed', sessionFormat: SESSION_FORMAT_VERSION }))
  } finally { await ctx.fiber.restart() }
}
