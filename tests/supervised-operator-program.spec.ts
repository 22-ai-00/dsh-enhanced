import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lifecycleSource = await readFile(join(repoRoot, 'scripts', 'install', 'lifecycle-profile.mjs'), 'utf8')

// 提取真实会被 `node --input-type=module --eval` 执行的嵌入 operator 程序。
// 安装测试在 LIFECYCLE_SUPERVISED_MOCK=1 下用桩替换了它，因此这里必须真实 spawn，
// 否则 overlay 派生/重派生锚定/白名单证明这类缺陷会被桩完全遮蔽。
function extractOperatorProgram(source) {
  const marker = 'const SUPERVISED_OPERATOR_PROGRAM = String.raw`'
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const bodyStart = start + marker.length
  let i = bodyStart
  while (i < source.length) {
    if (source[i] === '`' && source[i - 1] !== '\\') break
    i += 1
  }
  expect(i).toBeLessThan(source.length)
  return String.raw({ raw: [source.slice(bodyStart, i)] })
}

// CAPABILITY 程序是安装前唯一真实加载四个受监督插件、核对只读 operator seam 的探针。
// 安装器桩（LIFECYCLE_SUPERVISED_MOCK=1）会整体跳过它，所以这里必须真实 spawn。
function extractCapabilityProgram(source) {
  const marker = 'const SUPERVISED_CAPABILITY_PROGRAM = String.raw`'
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const bodyStart = start + marker.length
  let i = bodyStart
  while (i < source.length) {
    if (source[i] === '`' && source[i - 1] !== '\\') break
    i += 1
  }
  expect(i).toBeLessThan(source.length)
  return String.raw({ raw: [source.slice(bodyStart, i)] })
}

const PROGRAM = extractOperatorProgram(lifecycleSource)
const CAPABILITY_PROGRAM = extractCapabilityProgram(lifecycleSource)
// 静态 overlay 模板已被删除：preview 隔离层必须由持久化基线派生。
expect(lifecycleSource).not.toContain('SUPERVISED_PREVIEW_OVERLAY = [')
const sha256 = value => createHash('sha256').update(value).digest('hex')

// F9 夹具：持久化基线在 supervised 集合之外还声明了一个用户额外 provider。
// 派生 overlay 必须保留它，只能移除 larkChannel。
const BASE_PROVIDERS = [
  'assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations',
  'assistantHeartbeat', 'assistantEvaluation', 'preferenceLearning',
  'assistantEvolution', 'assistantGrowthExperiments', 'assistantDelivery',
  'assistantRecovery', 'larkChannel', 'credentialsKeychain',
]
const persistedConfig = () => JSON.stringify({
  lark: { enabled: true, account: 'acct', tenant: 't' },
  health: { requiredProviders: BASE_PROVIDERS },
  untouched: { keep: 'stable' },
})
// 与真实插件同构的最小派生/白名单逻辑（JSON 模型），用于驱动嵌入程序的 fail-closed 分支。
// 真实 YAML 白名单证明由 lark-channel 包内单测直接覆盖。
const larkDerivation = `
const derive = persisted => {
  const cfg = JSON.parse(persisted)
  if (cfg.lark.enabled !== true) throw new Error('persisted Lark channel must be enabled')
  if (!cfg.health.requiredProviders.includes('larkChannel')) throw new Error('persisted Health must require larkChannel')
  return JSON.stringify({
    ...cfg,
    lark: { ...cfg.lark, enabled: false },
    health: { requiredProviders: cfg.health.requiredProviders.filter(id => id !== 'larkChannel') },
  })
}
export const buildSupervisedGrowthPreviewOverlay = persisted => derive(persisted)
export const assertSupervisedGrowthPreviewDerivation = ({ persistedConfig, previewConfig }) => {
  const before = JSON.parse(persistedConfig)
  const after = JSON.parse(previewConfig)
  const beforeKeys = Object.keys(before).sort()
  const afterKeys = Object.keys(after).sort()
  if (JSON.stringify(beforeKeys) !== JSON.stringify(afterKeys)) throw new Error('preview row set changed')
  if (before.lark.enabled !== true || after.lark.enabled !== false) {
    throw new Error('preview overlay must disable the Lark row and nothing weaker')
  }
  const larkBefore = { ...before.lark, enabled: undefined }
  const larkAfter = { ...after.lark, enabled: undefined }
  if (JSON.stringify(larkBefore) !== JSON.stringify(larkAfter)) throw new Error('Lark row changed beyond enabled')
  const expectedProviders = before.health.requiredProviders.filter(id => id !== 'larkChannel')
  if (JSON.stringify(after.health.requiredProviders) !== JSON.stringify(expectedProviders)) {
    throw new Error('preview must remove exactly larkChannel while preserving every other provider')
  }
  if (JSON.stringify({ ...after, lark: undefined, health: undefined })
    !== JSON.stringify({ ...before, lark: undefined, health: undefined })) {
    throw new Error('preview changed an unrelated row')
  }
}
`

const PACKAGES = {
  larkChannel: {
    dir: 'lark-channel',
    body: `
${larkDerivation}
const f = () => ({})
export const supervisedGrowthDatabasePaths = (config, home) => ({
  deliveryDatabasePath: join(home, 'delivery.sqlite'),
  automationsDatabasePath: join(home, 'automations.sqlite'),
  recoveryDatabasePath: join(home, 'recovery.sqlite'),
})
export const supervisedGrowthBindingQuery = f
export const configureSupervisedGrowthProfilePatch = ({ activationState }) => 'PATCH-CONTENT-' + activationState
export const assertEffectiveSupervisedGrowthConfig = ({ effectiveConfig }) => {
  if (JSON.parse(effectiveConfig).lark.enabled !== true) {
    throw new Error('fake assert: effective Lark onboarding is not enabled')
  }
}
export const expectedSupervisedGrowthRecoveryBootstrap = async () => ({ attestationSetDigest: '${'a'.repeat(64)}' })
export const expectedSupervisedGrowthManagedAutomationDigest = async () => ({
  protocol: 'dsh-enhanced/supervised-growth-managed-automations/v1',
  records: [], digest: '${'b'.repeat(64)}',
})
export const captureSupervisedGrowthLifecycleAttestation = async ({ stage }) => ({
  protocol: 'dsh-enhanced/supervised-growth-lifecycle-attestation/v1', stage,
  externalProviderExemptions: stage === 'preview' ? ['larkChannel'] : [],
})
`,
    deps: ["import { join } from 'node:path'"],
  },
  delivery: {
    dir: 'assistant-delivery',
    deps: [],
    body: `
export const inspectActiveLarkOwnerBindingsLocally = () => ({
  protocol: 'assistant-delivery/active-lark-owner-bindings-snapshot/v1',
  scope: {}, storageDigest: '${'c'.repeat(64)}', bindings: [{ id: 'binding-1' }],
})
`,
  },
  recovery: {
    dir: 'assistant-recovery',
    deps: [],
    body: `
export const RECOVERY_CATALOG_DIGEST = '${'d'.repeat(64)}'
export const inspectRecoveryOperatorSnapshot = () => ({
  protocol: 'assistant-recovery/operator-snapshot/v1',
  bootstrap: { status: 'succeeded', generation: 1, attestationValid: true, attestations: [] },
})
`,
  },
  automations: {
    dir: 'assistant-automations',
    deps: [],
    body: `
export const inspectAutomationsOperatorSnapshot = () => ({
  protocol: 'assistant-automations-operator-snapshot/v1',
  inFlightCount: 0, inventoryDigest: '${'e'.repeat(64)}', records: [],
})
export const automationDefinitionDigest = () => '${'f'.repeat(64)}'
`,
  },
}

// 假 dsh：--dump-config 无 --patch 返回持久化（Lark enabled）配置；带 --patch 时返回
// 派生出的 overlay 内容（即 preview effective 配置）。DSH_FAKE_FORCE_ENABLED=1 时即使
// 带 overlay 也返回 enabled 基线，用于验证白名单证明必须拒绝「overlay 未真正禁用 Lark」。
const FAKE_DSH = `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const persisted = readFileSync(process.env.DSH_FAKE_PERSISTED, 'utf8')
const argv = process.argv.slice(1)
let patch = null
for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--patch') patch = argv[i + 1]
if (argv.includes('--dump-config')) {
  if (patch && process.env.DSH_FAKE_FORCE_ENABLED !== '1') {
    process.stdout.write(readFileSync(patch, 'utf8'))
  } else {
    process.stdout.write(persisted)
  }
}
`

async function buildFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-supervised-operator-'))
  const home = join(root, 'dsh-home')
  const profile = 'test-profile'
  const profileDir = join(home, 'profiles', profile)
  const modulesDir = join(profileDir, 'node_modules', '@dsh-enhanced')
  await mkdir(modulesDir, { recursive: true, mode: 0o700 })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true }, null, 2))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: owner-initial\n')
  for (const pkg of Object.values(PACKAGES)) {
    const dir = join(modulesDir, pkg.dir)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: `@dsh-enhanced/${pkg.dir}`, version: '0.1.0', type: 'module', main: 'index.mjs',
    }, null, 2))
    await writeFile(join(dir, 'index.mjs'), `${pkg.deps.join('\n')}\n${pkg.body}`)
  }
  const dsh = join(root, 'fake-dsh.cjs')
  await writeFile(dsh, FAKE_DSH)
  await chmod(dsh, 0o755)
  const persistedPath = join(home, 'persisted.json')
  await writeFile(persistedPath, persistedConfig())
  const overlayPath = join(home, `.dsh-enhanced-disable-lark-tx.yml`)
  const run = (action, nonce, extraEnv = {}) => spawnSync(process.execPath, [
    '--input-type=module', '--eval', PROGRAM,
    action, home, profile, dsh, ...(nonce === undefined ? [] : [nonce]),
  ], {
    encoding: 'utf8',
    env: {
      ...process.env, DSH_HOME: home, DSH_FAKE_PERSISTED: persistedPath,
      DSH_ENHANCED_SUPERVISED_PREVIEW_OVERLAY: overlayPath, ...extraEnv,
    },
  })
  const packageEntry = key => join(modulesDir, PACKAGES[key].dir, 'index.mjs')
  const writePackage = async key => writeFile(
    packageEntry(key), `${PACKAGES[key].deps.join('\n')}\n${PACKAGES[key].body}`)
  const rewritePackage = async (key, body) => writeFile(packageEntry(key), body)
  const runCapability = () => spawnSync(process.execPath, [
    '--input-type=module', '--eval', CAPABILITY_PROGRAM, home, profile,
  ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
  const previewConfig = JSON.stringify({
    lark: { enabled: false, account: 'acct', tenant: 't' },
    health: { requiredProviders: BASE_PROVIDERS.filter(id => id !== 'larkChannel') },
    untouched: { keep: 'stable' },
  })
  return {
    root, home, dsh, overlayPath, run, runCapability, writePackage, rewritePackage, persistedPath, previewConfig,
    resetOverlay: async body => writeFile(overlayPath, body, { mode: 0o600 }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const NONCE = '12345678-1234-4123-8234-123456789abc'

describe('supervised operator program（真实 node --eval spawn，无安装器桩）', () => {
  let fx
  beforeAll(async () => { fx = await buildFixture() })
  afterAll(async () => { await fx.cleanup() })

  test('prepare-preview：缺 overlay 路径环境时 fail-closed', () => {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '--eval', PROGRAM, 'prepare-preview', fx.home, 'test-profile',
      fx.dsh, NONCE,
    ], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: fx.home, DSH_FAKE_PERSISTED: fx.persistedPath },
    })
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('runtime overlay path inside DSH_HOME')
  })

  test('prepare-preview：overlay 路径逃逸 DSH_HOME 时 fail-closed', () => {
    const result = fx.run('prepare-preview', NONCE, {
      DSH_ENHANCED_SUPERVISED_PREVIEW_OVERLAY: '/etc/passwd',
    })
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('inside DSH_HOME')
  })

  test('prepare-preview：从持久化基线派生 overlay，仅禁用 Lark/移除 larkChannel 且保留用户额外 provider（F9）', async () => {
    await rm(fx.overlayPath, { force: true })
    const result = fx.run('prepare-preview', NONCE)
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.catalogDigest).toBe('d'.repeat(64))
    expect(output.plan.externalProviderExemptions).toEqual(['larkChannel'])
    expect(output.plan.effectiveConfigDigest).toBe(sha256(fx.previewConfig))
    expect(output.plan.effectiveConfigDigest).not.toBe(sha256(persistedConfig()))
    expect(output.plan.runtimeOverlayDigest).toBe(sha256(await readFile(fx.overlayPath, 'utf8')))
    // 落盘的派生 overlay 确实移除了 larkChannel，同时保留了用户额外 provider。
    const staged = JSON.parse(await readFile(fx.overlayPath, 'utf8'))
    expect(staged.lark.enabled).toBe(false)
    expect(staged.health.requiredProviders).not.toContain('larkChannel')
    expect(staged.health.requiredProviders).toContain('credentialsKeychain')
  })

  test('attest-preview：磁盘 overlay 被篡改/陈旧（与当前基线重派生不一致）时 fail-closed', async () => {
    await fx.resetOverlay(JSON.stringify({ tampered: true }))
    const result = fx.run('attest-preview')
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('not derived from the current persisted baseline')
  })

  test('prepare-preview：overlay 已被预植（flag wx 拒绝）时 fail-closed，不覆盖攻击者文件', async () => {
    await fx.resetOverlay('pre-planted')
    const result = fx.run('prepare-preview', NONCE)
    expect(result.status).not.toBe(0)
    expect(await readFile(fx.overlayPath, 'utf8')).toBe('pre-planted')
  })

  test('prepare-preview：白名单证明拒绝「overlay 未真正禁用 Lark」', async () => {
    await rm(fx.overlayPath, { force: true })
    const result = fx.run('prepare-preview', NONCE, { DSH_FAKE_FORCE_ENABLED: '1' })
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('disable the Lark row')
  })

  test('prepare-active：即使存在 overlay 环境也绝不派生/使用 overlay，配置保持 Lark enabled', async () => {
    const result = fx.run('prepare-active', NONCE)
    expect(result.status, result.stderr).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.plan.externalProviderExemptions).toEqual([])
    expect(output.plan).not.toHaveProperty('runtimeOverlayDigest')
    expect(output.plan.effectiveConfigDigest).toBe(sha256(persistedConfig()))
  })

  test('prepare-preview：非法 nonce 被拒绝', async () => {
    await rm(fx.overlayPath, { force: true })
    const result = fx.run('prepare-preview', 'not-a-uuid')
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('invalid fresh lifecycle nonce')
  })

  // CAPABILITY 探针：安装前真实加载四个受监督插件并核对只读 seam。桩安装器会整体跳过它，
  // 所以这里四类场景全部真实 spawn，且把程序的真实 stdout 直接送进安装器侧的同一强校函数。
  afterEach(async () => {
    await Promise.all(Object.keys(PACKAGES).map(key => fx.writePackage(key)))
  })

  test('capability：四个插件 seam 齐全且 digest 合法时通过，证明恰好只有 protocol 一个键', () => {
    const result = fx.runCapability()
    expect(result.status, result.stderr).toBe(0)
    const proof = JSON.parse(result.stdout)
    expect(proof).toEqual({ protocol: 'dsh-enhanced/supervised-lifecycle-capability/v1' })
    // 真实 spawn 产物必须通过安装器侧消费的同一个强校，而不是测试自己另写一套判定。
    expect(lifecycleProfileTest.validSupervisedCapabilityProof(proof)).toBe(true)
  })

  test('capability：缺少任一必需只读 seam 时 fail-closed', async () => {
    await fx.rewritePackage('automations', `
export const inspectAutomationsOperatorSnapshot = () => ({
  protocol: 'assistant-automations-operator-snapshot/v1',
  inFlightCount: 0, inventoryDigest: '${'e'.repeat(64)}', records: [],
})
`)
    const result = fx.runCapability()
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('required read-only operator seam is unavailable')
  })

  test('capability：Recovery catalog digest 非法时 fail-closed', async () => {
    await fx.rewritePackage('recovery', `
export const RECOVERY_CATALOG_DIGEST = 'not-a-hex-digest'
export const inspectRecoveryOperatorSnapshot = () => ({
  protocol: 'assistant-recovery/operator-snapshot/v1',
  bootstrap: { status: 'succeeded', generation: 1, attestationValid: true, attestations: [] },
})
`)
    const result = fx.runCapability()
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('Recovery catalog identity is unavailable')
  })

  test('capability：真实探针夹带额外键时，安装器侧强校对其原始 stdout fail-closed（程序自身退出 0 也不接受）', () => {
    // 模拟被调包的探针/中间层：seam 检查全部通过、进程退出 0，但在 proof 里走私字段。
    const tamperedProgram = CAPABILITY_PROGRAM.replace(
      "process.stdout.write(JSON.stringify({ protocol: 'dsh-enhanced/supervised-lifecycle-capability/v1' }))",
      "process.stdout.write(JSON.stringify({ protocol: 'dsh-enhanced/supervised-lifecycle-capability/v1', smuggled: 1 }))",
    )
    expect(tamperedProgram).not.toBe(CAPABILITY_PROGRAM)
    const result = spawnSync(process.execPath, [
      '--input-type=module', '--eval', tamperedProgram, fx.home, 'test-profile',
    ], { encoding: 'utf8', env: { ...process.env, DSH_HOME: fx.home } })
    // 被调包的探针自身并不报错——fail-closed 边界必须在安装器消费侧。
    expect(result.status, result.stderr).toBe(0)
    const proof = JSON.parse(result.stdout)
    expect(proof.smuggled).toBe(1)
    expect(lifecycleProfileTest.validSupervisedCapabilityProof(proof)).toBe(false)
  })
})
