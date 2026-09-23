import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * 守卫：安装器任一 scenario 中「会被安装、但它的某个 optional peer 不会被
 * 安装」的插件，其生产代码不得静态值导入该 peer。
 *
 * optional peer 的语义是「宿主未安装时本插件仍可加载」。静态值导入会在
 * 模块链接期触发 ERR_MODULE_NOT_FOUND——0.1.36 的 core 场景里
 * assistant-automations 静态值导入未安装的 assistant-evaluation，profile
 * 运行时自检启动即崩。允许的访问方式：`import type`（编译期擦除）或
 * 动态 `await import('...')`（运行时按需、可 .catch 兜底）。
 *
 * 场景拓扑直接解析 scripts/install/common.sh 的 slug 清单（不在测试中
 * 双写，避免清单演进时守卫漂移），再沿各包 package.json 的硬 dependencies
 * 做 @dsh-enhanced/* 闭包扩展。
 */
const workspaceRoot = new URL('..', import.meta.url).pathname
const installerLibrary = join(workspaceRoot, 'scripts', 'install', 'common.sh')

interface PackageManifest {
  name: string
  directory: string
  hardDependencies: Set<string>
  optionalPeers: Set<string>
}

function loadPackageManifests(): Map<string, PackageManifest> {
  const packages = new Map<string, PackageManifest>()
  for (const group of ['plugins', 'packages']) {
    const groupDirectory = join(workspaceRoot, group)
    if (!existsSync(groupDirectory)) continue
    for (const entry of readdirSync(groupDirectory)) {
      const manifestPath = join(groupDirectory, entry, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string
        dependencies?: Record<string, string>
        peerDependenciesMeta?: Record<string, { optional?: boolean }>
      }
      if (manifest.name === undefined) continue
      packages.set(manifest.name, {
        name: manifest.name,
        directory: join(groupDirectory, entry),
        hardDependencies: new Set(Object.keys(manifest.dependencies ?? {}).filter(n => n.startsWith('@dsh-enhanced/'))),
        optionalPeers: new Set(
          Object.entries(manifest.peerDependenciesMeta ?? {})
            .filter(([, meta]) => meta.optional === true)
            .map(([name]) => name)
            .filter(name => name.startsWith('@dsh-enhanced/')),
        ),
      })
    }
  }
  return packages
}

function extractArraySlugs(source: string, arrayName: string): string[] {
  const block = source.match(new RegExp(`${arrayName}=\\((?<body>[\\s\\S]*?)\\)`, 'u'))?.groups?.body ?? ''
  return [...block.matchAll(/'([a-z0-9-]+)'/gu)].map(match => match[1]!)
}

function extractCaseSlugs(source: string, branch: string): string[] {
  const section = source.match(new RegExp(`^\\s*${branch}\\)\\s*(?<body>[\\s\\S]*?);;`, 'mu'))?.groups?.body ?? ''
  const slugs: string[] = []
  // 两种写法都支持：逐字 dsh_enhanced_append_slug 'slug'
  // 与 for slug in slug-a slug-b; do dsh_enhanced_append_slug "$slug"; done
  for (const match of section.matchAll(/dsh_enhanced_append_slug\s+'([a-z0-9-]+)'/gu)) {
    slugs.push(match[1]!)
  }
  for (const match of section.matchAll(/for\s+slug\s+in\s+(?<list>[a-z0-9\s-]+?)\s*;/gu)) {
    for (const slug of match.groups!.list!.split(/\s+/u).filter(Boolean)) slugs.push(slug)
  }
  return [...new Set(slugs)]
}

/** 从安装器脚本推导 scenario -> 顶层 slug 列表。 */
function loadScenarios(): Record<string, string[]> {
  const source = readFileSync(installerLibrary, 'utf8')
  const core = extractArraySlugs(source, 'DSH_ENHANCED_CORE_PLUGIN_SLUGS')
  const lark = extractArraySlugs(source, 'DSH_ENHANCED_LARK_PLUGIN_SLUGS')
  const supervised = extractArraySlugs(source, 'DSH_ENHANCED_SUPERVISED_GROWTH_PLUGIN_SLUGS')
  const full = extractArraySlugs(source, 'DSH_ENHANCED_LEGACY_FULL_PLUGIN_SLUGS')
  return {
    core,
    web: [...core, ...extractCaseSlugs(source, 'web')],
    autonomy: [...core, ...extractCaseSlugs(source, 'autonomy')],
    lark: [...core, ...lark],
    supervised: [...core, ...lark, ...supervised],
    full,
  }
}

/** 顶层 slug 集合沿硬 dependencies 展开为「该场景实际安装的包名闭包」。 */
function scenarioClosure(topSlugs: readonly string[], packages: Map<string, PackageManifest>): Set<string> {
  const installed = new Set<string>()
  const queue = topSlugs.map(slug => `@dsh-enhanced/${slug}`)
  while (queue.length > 0) {
    const name = queue.pop()!
    if (installed.has(name)) continue
    installed.add(name)
    const manifest = packages.get(name)
    if (manifest === undefined) {
      throw new Error(`安装器引用了工作区中不存在的包：${name}`)
    }
    for (const dependency of manifest.hardDependencies) {
      if (!installed.has(dependency)) queue.push(dependency)
    }
  }
  return installed
}

const STATIC_IMPORT_PATTERN = /(?<![\w.])import\s+(?:type\s+)?[^'";]+?\s+from\s+['"](?<specifier>[^'"]+)['"]|(?<![\w.])import\s+['"](?<sideEffect>[^'"]+)['"]/gu

/**
 * 主入口（src/index.ts）沿相对 import 可达的全部生产模块。
 * 仅独立 bin（如 lark-channel 的 dsh-rsi-setup）可达的模块不约束：
 * bin 是独立可执行体，有权要求其专属 peer 存在。
 */
function mainEntryReach(manifest: PackageManifest): Set<string> | undefined {
  const entry = join(manifest.directory, 'src', 'index.ts')
  if (!existsSync(entry)) return undefined
  const reached = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (reached.has(file)) continue
    reached.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(STATIC_IMPORT_PATTERN)) {
      const specifier = match.groups!.specifier ?? match.groups!.sideEffect!
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue
      const resolved = resolveRelativeTypeScript(file, specifier)
      if (resolved !== undefined && !reached.has(resolved)) queue.push(resolved)
    }
  }
  return reached
}

function resolveRelativeTypeScript(fromFile: string, specifier: string): string | undefined {
  const base = join(join(fromFile, '..'), specifier.replace(/\.js$/u, '.ts'))
  const candidates = [base, join(base, 'index.ts')]
  return candidates.find(candidate => existsSync(candidate))
}

const IMPORT_PATTERN = /(?<![\w.])import\s+(?:type\s+)?(?<clause>[^'";]+?)\s+from\s+['"](?<specifier>[^'"]+)['"]|(?<![\w.])import\s+['"](?<sideEffect>[^'"]+)['"]/gsu

/** 判断 import 子句是否完全 type-only（`import type` 已在外层排除，这里处理混合大括号）。 */
function clauseIsTypeOnly(clause: string): boolean {
  const braceMatch = /^\{(?<members>[\s\S]*)\}$/u.exec(clause.trim())
  if (!braceMatch) return false // 默认导入或命名空间导入必为值
  return braceMatch.groups!.members!.split(',')
    .map(member => member.trim())
    .filter(member => member.length > 0)
    .every(member => member.startsWith('type '))
}

describe('optional peer 静态导入守卫（按安装器场景闭包）', () => {
  const packages = loadPackageManifests()
  const scenarios = loadScenarios()

  test('安装器场景解析非空', () => {
    for (const [name, slugs] of Object.entries(scenarios)) {
      expect(slugs.length, `场景 ${name} 至少含一个 slug`).toBeGreaterThan(0)
    }
  })

  test('场景分支 slug 解析正确（防止正则静默退化为 core）', () => {
    expect(scenarios.web).toContain('assistant-delivery')
    expect(scenarios.autonomy).toContain('assistant-evaluation')
    expect(scenarios.autonomy).toContain('assistant-skills')
    expect(scenarios.lark).toContain('lark-channel')
    expect(scenarios.supervised).toContain('assistant-evolution')
    expect(scenarios.supervised).toContain('assistant-goals')
    expect(scenarios.supervised).toContain('assistant-recovery')
  })

  const closures = new Map<string, Set<string>>(
    Object.entries(scenarios).map(([name, slugs]) => [name, scenarioClosure(slugs, packages)]),
  )

  test('supervised runtime providers cover Recovery required enhanced peers', () => {
    const supervised = closures.get('supervised')!
    const recovery = packages.get('@dsh-enhanced/assistant-recovery')!
    // Recovery's mounted class declares these as required Cordis injections.
    // peerDependenciesMeta.optional cannot make the runtime injection optional.
    for (const provider of [
      '@dsh-enhanced/assistant-automations',
      '@dsh-enhanced/assistant-delivery',
      '@dsh-enhanced/assistant-evaluation',
      '@dsh-enhanced/assistant-evolution',
      '@dsh-enhanced/assistant-goals',
      '@dsh-enhanced/assistant-health',
      '@dsh-enhanced/preference-learning',
    ]) {
      expect(supervised.has(provider), `supervised 缺少 Recovery provider ${provider}`).toBe(true)
      expect(recovery.optionalPeers.has(provider), `Recovery manifest 缺少 peer ${provider}`).toBe(true)
    }
  })

  // 包名 -> 至少一个「装它但不装该 peer」的场景名列表（仅真·可选 peer）。
  const genuinelyOptional = new Map<string, Map<string, string[]>>()
  for (const [scenarioName, closure] of closures) {
    for (const packageName of closure) {
      const manifest = packages.get(packageName)!
      for (const peer of manifest.optionalPeers) {
        if (closure.has(peer)) continue
        const peers = genuinelyOptional.get(packageName) ?? new Map<string, string[]>()
        const missingIn = peers.get(peer) ?? []
        missingIn.push(scenarioName)
        peers.set(peer, missingIn)
        genuinelyOptional.set(packageName, peers)
      }
    }
  }

  test('守卫覆盖到至少一条真·可选边（防止解析退化空转）', () => {
    expect(genuinelyOptional.size).toBeGreaterThan(0)
  })

  for (const [packageName, peerScenarios] of genuinelyOptional) {
    const manifest = packages.get(packageName)!
    const reach = mainEntryReach(manifest)
    for (const [peer, scenarioNames] of peerScenarios) {
      test(`${packageName} 主入口不静态值导入 ${peer}（场景 ${scenarioNames.join('/')} 不安装该 peer）`, () => {
        if (reach === undefined) return // 无主入口的工具包（如 rsi-cli）不适用
        const violations: string[] = []
        for (const file of reach) {
          const source = readFileSync(file, 'utf8')
          for (const match of source.matchAll(IMPORT_PATTERN)) {
            const specifier = match.groups!.specifier ?? match.groups!.sideEffect
            if (specifier === undefined) continue
            // 子路径导入（如 assistant-evaluation/benchmark）同属一个包。
            if (specifier !== peer && !specifier.startsWith(`${peer}/`)) continue
            if (/^import\s+type\s+/u.test(match[0])) continue
            if (match.groups!.sideEffect !== undefined || !clauseIsTypeOnly(match.groups!.clause ?? '')) {
              const line = source.slice(0, match.index).split('\n').length
              violations.push(`${file.replace(`${workspaceRoot}/`, '')}:${line}`)
            }
          }
        }
        expect(violations).toEqual([])
      })
    }
  }
})
