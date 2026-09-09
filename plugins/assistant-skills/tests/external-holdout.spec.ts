import { generateKeyPairSync } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { openHoldoutProcess, validateExternalHoldoutProfiles, type ExternalHoldoutProfile } from '../src/external-holdout.ts'

const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const ready = `process.stdout.write(JSON.stringify({event:'ready',protocol:'assistant-skills/holdout-ipc/v1'})+'\\n');`
const authority = (code: string) => ({ executable: process.execPath, args: ['-e', code], publicKey, datasetDigest: 'a'.repeat(64) })
const profile = (): ExternalHoldoutProfile => ({ id: 'operator', version: 1, scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' },
  execution: { image: `sha256:${'b'.repeat(64)}`, dockerPath: '/usr/bin/docker', stateRoot: '/tmp/operator-state', command: 'cat', artifactPath: 'artifact.sh', expiresAt: Date.now() + 60000, repeats: 2, maxToolCalls: 4, maxBytes: 65536, maxOutputBytes: 16384, cellDurationMs: 2000, verificationDurationMs: 1000 }, authority: authority(''), maxComparisons: 1 })

describe('external authority configuration', () => {
  test('freezes exact scoped public configuration and permits expired profiles for status readback', () => {
    const input = profile(), [saved] = validateExternalHoldoutProfiles([input])
    ;(input.authority.args as string[]).push('mutated')
    expect(saved?.authority.args).not.toContain('mutated')
    expect(Object.isFrozen(saved?.execution)).toBe(true)
    expect(validateExternalHoldoutProfiles([{ ...profile(), execution: { ...profile().execution, expiresAt: 1 } }])).toHaveLength(1)
  })
  test('rejects authority reuse, workspace overlap and caller private answers', () => {
    expect(() => validateExternalHoldoutProfiles([profile(), { ...profile(), id: 'other' }])).toThrow(/invalid external/)
    expect(() => validateExternalHoldoutProfiles([{ ...profile(), execution: { ...profile().execution, stateRoot: '/tmp/workspace/private' } }])).toThrow(/invalid external/)
    expect(() => validateExternalHoldoutProfiles([{ ...profile(), expectedStdout: 'answer' } as ExternalHoldoutProfile])).toThrow(/invalid external/)
  })

  test('requires exactly one public holdout identity digest', () => {
    const prospective = { ...profile(), authority: { executable: process.execPath, args: [], publicKey, generatorDigest: 'c'.repeat(64) } }
    expect(validateExternalHoldoutProfiles([prospective])).toHaveLength(1)
    expect(() => validateExternalHoldoutProfiles([{ ...prospective, authority: { ...prospective.authority, datasetDigest: 'd'.repeat(64) } }])).toThrow(/invalid external/)
    expect(() => validateExternalHoldoutProfiles([{ ...prospective, authority: { executable: prospective.authority.executable, args: prospective.authority.args, publicKey } }])).toThrow(/invalid external/)
  })
})

test('production pipe decodes split UTF-8 and correlates replies without returning operator stderr', async () => {
  const processCode = `${ready}process.stderr.write('operator-private-data');process.stdin.once('data',line=>{const {id}=JSON.parse(line);const b=Buffer.from(JSON.stringify({id,ok:true,value:'答案'})+'\\n');const at=b.indexOf(Buffer.from('答'))+1;process.stdout.write(b.subarray(0,at));setTimeout(()=>process.stdout.write(b.subarray(at)),10)});process.stdin.on('end',()=>process.exit(0))`
  const client = await openHoldoutProcess(authority(processCode), new AbortController().signal)
  try { expect(await client.transport.request('finish')).toBe('答案') } finally { await client.close() }
})

test('an unrelated response poisons the channel and cannot settle another request', async () => {
  const client = await openHoldoutProcess(authority(`${ready}process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:'foreign',ok:true,value:'not-a-receipt'})+'\\n'))`), new AbortController().signal)
  try {
    await expect(client.transport.request('finish')).rejects.toThrow(/identity rejected/)
    await expect(client.transport.request('next')).rejects.toThrow(/unavailable/)
  } finally { await client.close() }
})

test('cancellation ends an unresponsive process and rejects late reuse', async () => {
  const client = await openHoldoutProcess(authority(`${ready}process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)`), new AbortController().signal)
  const abort = new AbortController()
  const response = client.transport.request('next', undefined, abort.signal)
  const rejection = expect(response).rejects.toThrow(/cancelled/)
  abort.abort(); await rejection
  await client.close()
  await expect(client.transport.request('next')).rejects.toThrow(/unavailable/)
}, 10000)

test('abort while awaiting ready stops startup instead of hanging for a handshake', async () => {
  const abort = new AbortController()
  const startup = openHoldoutProcess(authority('process.stdin.resume()'), abort.signal)
  const rejected = expect(startup).rejects.toThrow(/cancelled/)
  await delay(20); abort.abort(); await rejected
})
