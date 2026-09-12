import process from 'node:process'
import { spawn } from 'node:child_process'
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'

const protocol = 'dsh-benchmark/holdout-provider-transport/v1'
const mode = process.env.HOLDOUT_FIXTURE_MODE ?? 'echo'
const acknowledgedPath = process.env.HOLDOUT_FIXTURE_ACKNOWLEDGED_PATH
const injectedPath = process.env.HOLDOUT_FIXTURE_INJECTED_PATH
const descendant = mode === 'orphan-descendant'
  ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })
  : undefined
const envelopeProtocol = 'dsh-benchmark/independent-holdout/v1'
const privateKey = createPrivateKey('-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFJ2wvKo99Cp2NVDEXfLpW/ynV8fu2n3VIK1lQHXMZ3x\n-----END PRIVATE KEY-----\n')
const commitmentKey = Buffer.from('e13a9fa1ef63dc3b8467324909196f3e571d7cc755ad30f445f222f041600aa3', 'hex')
const publicKey = createPublicKey(privateKey)
const canonical = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
}
const digest = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : canonical(value)).digest('hex')
const commitment = value => createHmac('sha256', commitmentKey).update(value).digest('hex')
const signed = value => ({ ...value, signature: sign(null, Buffer.from(canonical(value)), privateKey).toString('base64url') })
const same = (left, right) => canonical(left) === canonical(right)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|')
const authorityKeyId = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex')
const privateCases = [{ id: 'private-case', domain: 'research', input: 'private question: answer forty-two', oracle: '42' }]
const cases = privateCases.map(item => ({ id: item.id, domain: item.domain, inputDigest: digest(item.input), acceptanceDigest: commitment(item.oracle) }))
const dataset = { id: 'synthetic-private', version: 'v1', split: 'holdout', digest: digest({ id: 'synthetic-private', version: 'v1', split: 'holdout', cases }) }
const manifest = signed({ protocol: envelopeProtocol, kind: 'manifest', manifestId: 'synthetic-manifest-v1', authorityKeyId, dataset, cases, issuedAt: 100 })
const manifestDigest = digest(manifest)
const schedule = plan => {
  const values = []
  for (let repeat = 0; repeat < plan.repeats; repeat++) plan.cases.forEach((task, caseIndex) => {
    const seed = Number.parseInt(digest([plan.seed, task.id, repeat]).slice(0, 8), 16)
    for (let index = 0; index < plan.variants.length; index++) {
      const variant = plan.variants[(index + repeat + caseIndex) % plan.variants.length]
      values.push({ id: digest([plan.id, task.id, variant.id, repeat]), caseId: task.id, variantId: variant.id, repeat, seed })
    }
  })
  return values
}
const split = value => {
  if (mode !== 'fragment') { process.stdout.write(value); return }
  const bytes = Buffer.from(value), at = Math.max(1, Math.floor(bytes.length / 2))
  process.stdout.write(bytes.subarray(0, at)); setTimeout(() => process.stdout.write(bytes.subarray(at)), 5)
}
const waitForAcknowledgement = async () => {
  if (!acknowledgedPath || !injectedPath) return false
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (existsSync(acknowledgedPath)) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}
if (mode === 'stderr-secret') process.stderr.write('secret fixture stderr that must not escape\n')
if (mode === 'oversize-stderr') process.stderr.write('x'.repeat(4096))
if (mode === 'oversize-line') process.stdout.write('x'.repeat(4096))
else if (mode === 'ready-partial') process.stdout.write(JSON.stringify({ protocol, type: 'ready' }) + '\n{"partial":')
else if (mode !== 'no-ready') split(JSON.stringify({ protocol, type: 'ready' }) + '\n')
if (mode === 'ready-unsolicited-partial') setTimeout(() => process.stdout.write('{"preloaded":'), 10)

let pending = '', requestCount = 0
let manifestSent = false, frozenPlan, planDigest, cells = [], nextCell = 0, activeInput, verdictDigests = [], finished = false
const authorityResponse = (operation, value) => {
  if (operation === 'manifest') {
    if (manifestSent || frozenPlan || !exact(value, ['expectedDataset']) || !same(value.expectedDataset, { id: dataset.id, version: dataset.version, digest: dataset.digest })) throw new Error('manifest-mismatch')
    manifestSent = true
    return manifest
  }
  if (operation === 'input') {
    if (!manifestSent || finished || !exact(value, ['plan', 'cell']) || activeInput || !value.plan || !value.cell) throw new Error('input-order')
    if (!frozenPlan) {
      if (!same(value.plan.dataset, dataset) || !same(value.plan.cases, cases)) throw new Error('plan-mismatch')
      frozenPlan = JSON.parse(canonical(value.plan)); planDigest = digest(frozenPlan); cells = schedule(frozenPlan)
    }
    if (!same(value.plan, frozenPlan) || !same(value.cell, cells[nextCell])) throw new Error('cell-order')
    const privateCase = privateCases.find(item => item.id === value.cell.caseId)
    if (!privateCase) throw new Error('unknown-case')
    activeInput = signed({ protocol: envelopeProtocol, kind: 'input', authorityKeyId, manifestDigest, planDigest, cell: value.cell, inputDigest: digest(privateCase.input), contentType: 'text/plain; charset=utf-8', inputBase64url: Buffer.from(privateCase.input).toString('base64url') })
    return activeInput
  }
  if (operation === 'verdict') {
    if (finished || !activeInput || !exact(value, ['planDigest', 'cell', 'inputEnvelopeDigest', 'output']) || value.planDigest !== planDigest || !same(value.cell, cells[nextCell])
      || value.inputEnvelopeDigest !== digest(activeInput) || !exact(value.output, ['contentType', 'outputBase64url', 'outputDigest'])) throw new Error('verdict-order')
    const bytes = Buffer.from(value.output.outputBase64url, 'base64url')
    if (bytes.toString('base64url') !== value.output.outputBase64url || digest(bytes) !== value.output.outputDigest) throw new Error('output-mismatch')
    const privateCase = privateCases.find(item => item.id === value.cell.caseId)
    const envelope = signed({ protocol: envelopeProtocol, kind: 'verdict', authorityKeyId, manifestDigest, planDigest, cell: value.cell, inputDigest: activeInput.inputDigest, acceptanceDigest: privateCase ? commitment(privateCase.oracle) : commitment('missing'), outputDigest: value.output.outputDigest, verdict: privateCase && bytes.toString('utf8') === privateCase.oracle ? 'achieved' : 'not-achieved', evaluatedAt: 200 + nextCell })
    verdictDigests.push(digest(envelope)); activeInput = undefined; nextCell++
    return envelope
  }
  if (operation === 'finish') {
    if (finished || activeInput || !frozenPlan || nextCell !== cells.length || !exact(value, ['planDigest', 'cells', 'verdictEnvelopeDigests']) || value.planDigest !== planDigest || !same(value.cells, cells) || !same(value.verdictEnvelopeDigests, verdictDigests)) throw new Error('finish-order')
    const entries = cells.map((cell, index) => ({ cell, verdictDigest: verdictDigests[index] }))
    finished = true
    return signed({ protocol: envelopeProtocol, kind: 'finish', authorityKeyId, manifestDigest, planDigest, cellCount: cells.length, verdictsDigest: digest(entries), complete: true, finalizedAt: 300 })
  }
  throw new Error('unsupported-operation')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  pending += chunk
  let at
  while ((at = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, at); pending = pending.slice(at + 1)
    let message
    try { message = JSON.parse(line) } catch { process.exitCode = 2; process.stdin.destroy(); return }
    if (message?.protocol !== protocol) { process.exitCode = 3; process.stdin.destroy(); return }
    if (message.type === 'close') {
      if (mode === 'ignore-close') continue
      if (mode === 'ignore-term') { process.removeAllListeners('SIGTERM'); process.on('SIGTERM', () => {}); continue }
      process.exit(0); return
    }
    if (message.type !== 'request') { process.exitCode = 4; process.stdin.destroy(); return }
    requestCount++
    if (mode === 'hang') continue
    const id = mode === 'wrong-id' ? 'wrong' : message.id
    if (mode === 'reject' || mode === 'authority-reject-input' && message.operation === 'input' || mode === 'authority-reject-verdict' && message.operation === 'verdict') split(JSON.stringify({ protocol, type: 'response', id, ok: false, error: { code: 'fixture-rejected' } }) + '\n')
    else if (mode === 'extra-field') split(JSON.stringify({ protocol, type: 'response', id, ok: true, value: message.value, extra: true }) + '\n')
    else if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]))
    else if (mode === 'predict-next-id' && requestCount > 1) continue
    else if (mode === 'echo' || mode === 'fragment' || mode === 'extra-line' || mode === 'response-partial' || mode === 'predict-next-id' || mode === 'orphan-descendant') {
      const response = JSON.stringify({ protocol, type: 'response', id, ok: true, value: { operation: message.operation, echo: message.value, envKeys: Object.keys(process.env).sort(), cwd: process.cwd(), ...(descendant ? { descendantPid: descendant.pid } : {}) } }) + '\n'
      if (mode === 'extra-line') process.stdout.write(response + JSON.stringify({ protocol, type: 'response', id: 'extra', ok: true, value: null }) + '\n')
      else if (mode === 'response-partial') process.stdout.write(response + '{"partial":')
      else if (mode === 'predict-next-id') {
        process.stdout.write(response)
        void waitForAcknowledgement().then(acknowledged => {
          if (!acknowledged) return
          // Mark intent before stdout: the Host may correctly kill us as soon
          // as it sees this unsolicited frame.
          writeFileSync(injectedPath, 'injected\n', { mode: 0o600 })
          process.stdout.write(JSON.stringify({ protocol, type: 'response', id: 'request-2', ok: true, value: 'predicted' }) + '\n')
        })
      }
      else split(response)
    } else try { split(JSON.stringify({ protocol, type: 'response', id, ok: true, value: authorityResponse(message.operation, message.value) }) + '\n') }
    catch { split(JSON.stringify({ protocol, type: 'response', id, ok: false, error: { code: 'sequence-rejected' } }) + '\n') }
  }
})
