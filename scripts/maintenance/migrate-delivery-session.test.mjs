import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isStrictDeliverySource } from './migrate-delivery-session.mjs'

const script = fileURLToPath(new URL('./migrate-delivery-session.mjs', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const suppliedHostCli = process.env.DSH_SESSION_MIGRATION_TEST_CLI
const digest = value => createHash('sha256').update(value).digest('hex')

function run(args, { scriptPath = script } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8', timeout: 60_000 })
}

function records(output) {
  return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function identity(path) {
  const entry = await lstat(path)
  return { dev: entry.dev, ino: entry.ino, size: entry.size, mtimeMs: entry.mtimeMs, digest: digest(await readFile(path)) }
}

function sameArtifact(a, b) {
  return a.digest === b.digest && a.size === b.size
}

async function createLegacy(root, suffix = 'a') {
  const { Context } = require('@deepseek-ai/cordis')
  const { SessionStore, SessionId } = require('@deepseek-ai/dsh-session')
  const { createUserMessage } = require('@deepseek-ai/dsh-llm')
  const Jsonl = require('@deepseek-ai/dsh-session-persistence-jsonl').default
  const ctx = new Context()
  const id = `delivery-${suffix.length === 32 ? suffix : suffix.repeat(32)}-g1`
  try {
    new SessionStore(ctx)
    new Jsonl(ctx, { root, compression: 'zstd' })
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/synthetic/workspace', agentPreset: 'standard', delegationDepth: 0 } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Synthetic maintenance test.' }],
      source: { kind: 'delivery', channel: 'test', account: 'test', eventId: 'test', trust: 'untrusted' },
    }), { surfaceOp: 'append' })
    await ctx.sessions.flush(session)
  } finally {
    await ctx.fiber.restart()
  }
  const legacy = join(root, '--synthetic-workspace--', id, 'session.jsonl.zstd')
  return { id, legacy, sessionDir: dirname(legacy) }
}

async function mutateDeliverySource(path, change) {
  const decoded = spawnSync('zstd', ['-q', '-d', '-c', path], { encoding: 'utf8' })
  assert.equal(decoded.status, 0, decoded.stderr)
  const lines = decoded.stdout.trimEnd().split('\n').map(line => JSON.parse(line))
  let changed = false
  const visit = value => {
    if (value === null || typeof value !== 'object') return
    if (value.kind === 'delivery' && Object.hasOwn(value, 'channel') && !changed) { change(value); changed = true; return }
    for (const child of Object.values(value)) visit(child)
  }
  for (const row of lines) visit(row)
  assert.equal(changed, true, 'fixture must contain the synthetic delivery source')
  const work = join(dirname(path), '.migration-test-frame')
  const staged = `${path}.staged`
  await rm(staged, { force: true })
  try {
    for (const row of lines) {
      await writeFile(work, `${JSON.stringify(row)}\n`)
      const frame = `${work}.zst`
      const compressed = spawnSync('zstd', ['-q', '-f', work, '-o', frame], { encoding: 'utf8' })
      assert.equal(compressed.status, 0, compressed.stderr)
      await appendFile(staged, await readFile(frame))
      await rm(frame, { force: true })
    }
    await rename(staged, path)
  } finally { await rm(work, { force: true }); await rm(`${work}.zst`, { force: true }); await rm(staged, { force: true }) }
}

test('usage and strict delivery classifier reject malformed sources', () => {
  const help = run(['--help'])
  assert.equal(help.status, 0)
  assert.match(help.stdout, /^usage: migrate-delivery-session\.mjs/m)
  const good = { kind: 'delivery', channel: 'test', account: 'test', eventId: 'test', trust: 'untrusted' }
  assert.equal(isStrictDeliverySource(good), true)
  const invalid = [
    (({ channel: _channel, ...rest }) => rest)(good),
    { ...good, unexpected: 'field' },
    { ...good, trust: 'trusted' },
    { ...good, account: '' },
    { ...good, eventId: 1 },
  ]
  for (const source of invalid) assert.equal(isStrictDeliverySource(source), false)
})

test('apply requires the explicit stopped-host confirmation', () => {
  const result = run(['--host-cli', '/tmp/not-a-host/lib/bin.js', '--session-file', '/tmp/delivery-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-g1/session.jsonl.zstd', '--apply'])
  assert.notEqual(result.status, 0)
  assert.equal(records(result.stderr)[0].error, 'maintenance-refused')
})

test('official v0 migration keeps the artifact, rejects malformed sources, and preserves a published generation on postread failure', { skip: suppliedHostCli ? false : 'set DSH_SESSION_MIGRATION_TEST_CLI to a canonical current Host lib/bin.js', concurrency: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-delivery-migration-test-'))
  try {
    const first = await createLegacy(root, 'a')
    const original = await identity(first.legacy)
    const base = ['--host-cli', suppliedHostCli, '--session-file', first.legacy]

    const noConfirm = run([...base, '--apply'])
    assert.notEqual(noConfirm.status, 0)
    assert.deepEqual(await identity(first.legacy), original)

    const preview = run(base)
    assert.equal(preview.status, 0, preview.stderr)
    const previewRecord = records(preview.stdout)[0]
    assert.equal(previewRecord.phase, 'preview')
    assert.equal(previewRecord.version, 3)
    assert.equal(previewRecord.events, 4)
    assert.equal(previewRecord.deliverySourceCount, 1)
    assert.deepEqual(await identity(first.legacy), original)

    const apply = run([...base, '--apply', '--confirm-host-stopped'])
    assert.equal(apply.status, 0, apply.stderr)
    const [backup, applied] = records(apply.stdout)
    assert.equal(backup.phase, 'backup-created')
    assert.equal(applied.phase, 'applied')
    assert.equal(applied.logicalHash, previewRecord.logicalHash)
    assert.equal(applied.deliverySourceHash, previewRecord.deliverySourceHash)
    assert.deepEqual(await identity(first.legacy), original)
    assert.equal(sameArtifact(await identity(join(backup.backup, 'session.jsonl.zstd')), original), true)

    const cold = run(['--worker', 'read', JSON.stringify({ hostCli: suppliedHostCli, root, id: first.id, legacyPath: first.legacy, expectedLegacyHash: original.digest })])
    assert.equal(cold.status, 0, cold.stderr)
    assert.deepEqual(records(cold.stdout)[0], { ...previewRecord, phase: 'read' })

    const currentConflict = run(base)
    assert.notEqual(currentConflict.status, 0)
    assert.deepEqual(await identity(first.legacy), original)

    const link = await createLegacy(root, 'b')
    await rm(link.legacy)
    await symlink(first.legacy, link.legacy)
    const linkResult = run(['--host-cli', suppliedHostCli, '--session-file', link.legacy])
    assert.notEqual(linkResult.status, 0)

    const malformed = [
      source => { delete source.channel },
      source => { source.unexpected = 'field' },
      source => { source.trust = 'trusted' },
      source => { source.account = '' },
      source => { source.eventId = 1 },
    ]
    for (let index = 0; index < malformed.length; index += 1) {
      const fixture = await createLegacy(root, index === 4 ? `${'a'.repeat(31)}1` : String.fromCharCode(99 + index))
      await mutateDeliverySource(fixture.legacy, malformed[index])
      const before = await identity(fixture.legacy)
      const rejected = run(['--host-cli', suppliedHostCli, '--session-file', fixture.legacy])
      assert.notEqual(rejected.status, 0, `malformed source ${index} must be refused`)
      assert.deepEqual(await identity(fixture.legacy), before)
    }

    const fault = await createLegacy(root, `${'b'.repeat(31)}2`)
    const faultOriginal = await identity(fault.legacy)
    const instrumented = join(root, 'fault-migrate-delivery-session.mjs')
    const source = await readFile(script, 'utf8')
    const needle = "const post = child(script, appliedInput, 'read', started)"
    assert.equal(source.split(needle).length, 2, 'test instrumentation must target the unique postread call')
    await writeFile(instrumented, source.replace(needle, "throw new Error('test postread failure')"))
    const failedApply = run(['--host-cli', suppliedHostCli, '--session-file', fault.legacy, '--apply', '--confirm-host-stopped'], { scriptPath: instrumented })
    assert.notEqual(failedApply.status, 0)
    const incomplete = records(failedApply.stderr)[0]
    assert.equal(incomplete.phase, 'apply-incomplete', failedApply.stderr)
    assert.equal(incomplete.keepHostStopped, true)
    assert.equal(incomplete.legacyUnchanged, true)
    assert.equal(incomplete.currentGeneration, 'present')
    assert.ok(incomplete.backup)
    assert.deepEqual(await identity(fault.legacy), faultOriginal)
    const faultCold = run(['--worker', 'read', JSON.stringify({ hostCli: suppliedHostCli, root, id: fault.id, legacyPath: fault.legacy, expectedLegacyHash: faultOriginal.digest })])
    assert.equal(faultCold.status, 0, faultCold.stderr)
    assert.equal(records(faultCold.stdout)[0].version, 3)
    assert.equal(records(faultCold.stdout)[0].deliverySourceCount, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
