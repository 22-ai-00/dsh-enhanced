import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './workspace.ts'

export interface WorkspacePackageManifest {
  readonly kind: 'package' | 'plugin'
  readonly slug: string
  readonly dir: string
  readonly name: string
  readonly version: string
  readonly publishConfig?: Readonly<{ access?: string }>
  readonly raw: Record<string, unknown>
}

export const loadAssistantPolicy = () => import('../../../plugins/assistant-policy/src/index.ts')
export const loadAssistantPolicyEvaluator = () => import('../../../plugins/assistant-policy/src/evaluator.ts')
export const loadPluginSetup = () => import('../../../plugins/assistant-policy/src/plugin-setup.ts')
export const loadAssistantEvaluation = () => import('../../../plugins/assistant-evaluation/src/index.ts')
export const loadNativeBenchmark = () => import('../../../plugins/assistant-evaluation/src/benchmark/native.ts')
export const loadBenchmarkStore = () => import('../../../plugins/assistant-evaluation/src/benchmark/store.ts')
export const loadBenchmarkIndex = () => import('../../../plugins/assistant-evaluation/src/benchmark/index.ts')
export const loadFamiliesCorpus = () => import('../../../plugins/assistant-evaluation/src/benchmark/families-corpus.ts')
export const loadBenchmarkRunner = () => import('../../../plugins/assistant-evaluation/src/benchmark/runner.ts')
export const loadStrategyGoalRuntime = () => import('../../../plugins/assistant-evaluation/src/benchmark/strategy-goal-runtime.ts')
export const loadAssistantWorkItems = () => import('../../../plugins/assistant-work-items/src/index.ts')
export const loadAssistantProactive = () => import('../../../plugins/assistant-proactive/src/index.ts')
export const loadAssistantIsolation = () => import('../../../plugins/assistant-isolation/src/index.ts')
export const loadAssistantIsolationConfig = () => import('../../../plugins/assistant-isolation/src/config.ts')
export const loadAssistantAssociation = () => import('../../../plugins/assistant-association/src/index.ts')
export const loadAssistantActions = () => import('../../../plugins/assistant-actions/src/index.ts')
export const loadAssistantActionsBroker = () => import('../../../plugins/assistant-actions/src/broker-protocol-v2.ts')
export const loadAssistantActionsHttpGuard = () => import('../../../plugins/assistant-actions/src/guards/http-guard.ts')
export const loadAssistantDelivery = () => import('../../../plugins/assistant-delivery/src/index.ts')
export const loadPluginControlPlane = () => import('../../../plugins/plugin-control-plane/src/index.ts')
export const loadSourceCreation = () => import('../../../plugins/plugin-control-plane/src/source-creation.ts')
export const loadSourceRevision = () => import('../../../plugins/plugin-control-plane/src/source-revision.ts')
export const loadAdoptionCoordinator = () => import('../../../plugins/plugin-control-plane/src/adoption-coordinator.ts')
export const loadAssistantVerifier = () => import('../../../plugins/assistant-verifier/src/index.ts')
export const loadPluginBehaviorRunner = () => import('../../../plugins/assistant-verifier/src/plugin-behavior-runner.ts')
export const loadNativeBehaviorArtifact = () => import('../../../plugins/assistant-verifier/src/native-behavior-artifact.ts')
export const loadNativeBehaviorWorker = () => import('../../../plugins/assistant-verifier/src/native-behavior-worker.ts')
export const loadAssistantGrowthDriver = () => import('../../../plugins/assistant-growth-driver/src/index.ts')
export const loadAssistantEvolution = () => import('../../../plugins/assistant-evolution/src/index.ts')
export const loadAssistantMemoryLearning = () => import('../../../plugins/assistant-memory-learning/src/index.ts')
export const loadPersonalMemory = () => import('../../../plugins/personal-memory/src/index.ts')
export const loadPersonalAssistant = () => import('../../../plugins/personal-assistant/src/index.ts')
export const loadAssistantDreaming = () => import('../../../plugins/assistant-dreaming/src/index.ts')
export const loadPreferenceLearning = () => import('../../../plugins/preference-learning/src/index.ts')
export const loadAssistantGoals = () => import('../../../plugins/assistant-goals/src/index.ts')
export const loadAssistantGoalsStrategy = () => import('../../../plugins/assistant-goals/src/strategy.ts')
export const loadAssistantGoalsStrategyRouter = () => import('../../../plugins/assistant-goals/src/strategy-router.ts')
export const loadAssistantRecovery = () => import('../../../plugins/assistant-recovery/src/index.ts')
export const loadAssistantSkills = () => import('../../../plugins/assistant-skills/src/index.ts')
export const loadAssistantSkillsDefinition = () => import('../../../plugins/assistant-skills/src/definition.ts')
export const loadEventTriggers = () => import('../../../plugins/event-triggers/src/index.ts')
export const loadLarkChannel = () => import('../../../plugins/lark-channel/src/index.ts')
export const loadOwnerConsole = () => import('../../../plugins/owner-console/src/index.ts')
export const loadAssistantWebOwner = () => import('../../../plugins/assistant-web-owner/src/index.ts')
export const loadAssistantWebOwnerSetup = () => import('../../../plugins/assistant-web-owner/src/setup.ts')
export const loadAssistantHeartbeat = () => import('../../../plugins/assistant-heartbeat/src/index.ts')
export const loadAssistantHealth = () => import('../../../plugins/assistant-health/src/index.ts')
export const loadCredentialsKeychain = () => import('../../../plugins/credentials-keychain/src/index.ts')
export const loadDshRayCli = () => import('../../../packages/cli/src/index.ts')
export const loadDshRayUpgrade = () => import('../../../packages/cli/src/upgrade.ts')
export const loadTaskAcceptanceContract = () => import('../../../packages/task-acceptance-contract/src/index.ts')
export const loadAssistantGrowthContract = () => import('../../../packages/assistant-growth-contract/src/index.ts')
export const loadUpgradeProgram = () => import('../../../scripts/install/upgrade-program.mjs')
export const loadRepoAutonomyFixture = () => import('../../../scripts/e2e/repo-verified-delivery-fixture.mjs')
export const loadRepoExternalDeliveryFixture = () => import('../../../scripts/e2e/repo-external-delivery-fixture.mjs')
export const loadRepoAutonomyObserver = () => import('../../../scripts/e2e/repo-autonomy-observer.mjs')
export const loadRepoLiveInput = () => import('../../../scripts/e2e/repo-live-input.mjs')

const dynamicPackageLoaders: Readonly<Record<string, () => Promise<Record<string, unknown>>>> = {
  'assistant-policy': loadAssistantPolicy,
  'assistant-policy/evaluator': loadAssistantPolicyEvaluator,
  'assistant-policy/plugin-setup': loadPluginSetup,
  'assistant-evaluation': loadAssistantEvaluation,
  'assistant-evaluation/benchmark/native': loadNativeBenchmark,
  'assistant-evaluation/benchmark/store': loadBenchmarkStore,
  'assistant-evaluation/benchmark/index': loadBenchmarkIndex,
  'assistant-evaluation/benchmark/families-corpus': loadFamiliesCorpus,
  'assistant-evaluation/benchmark/runner': loadBenchmarkRunner,
  'assistant-evaluation/benchmark/strategy-goal-runtime': loadStrategyGoalRuntime,
  'assistant-work-items': loadAssistantWorkItems,
  'assistant-proactive': loadAssistantProactive,
  'assistant-isolation': loadAssistantIsolation,
  'assistant-isolation/config': loadAssistantIsolationConfig,
  'assistant-association': loadAssistantAssociation,
  'assistant-actions': loadAssistantActions,
  'assistant-actions/broker-protocol-v2': loadAssistantActionsBroker,
  'assistant-actions/guards/http-guard': loadAssistantActionsHttpGuard,
  'assistant-delivery': loadAssistantDelivery,
  'plugin-control-plane': loadPluginControlPlane,
  'plugin-control-plane/source-creation': loadSourceCreation,
  'plugin-control-plane/source-revision': loadSourceRevision,
  'plugin-control-plane/adoption-coordinator': loadAdoptionCoordinator,
  'assistant-verifier': loadAssistantVerifier,
  'assistant-verifier/plugin-behavior-runner': loadPluginBehaviorRunner,
  'assistant-growth-driver': loadAssistantGrowthDriver,
  'assistant-evolution': loadAssistantEvolution,
  'assistant-memory-learning': loadAssistantMemoryLearning,
  'personal-memory': loadPersonalMemory,
  'personal-assistant': loadPersonalAssistant,
  'assistant-dreaming': loadAssistantDreaming,
  'preference-learning': loadPreferenceLearning,
  'assistant-goals': loadAssistantGoals,
  'assistant-goals/strategy': loadAssistantGoalsStrategy,
  'assistant-goals/strategy-router': loadAssistantGoalsStrategyRouter,
  'assistant-recovery': loadAssistantRecovery,
  'assistant-skills': loadAssistantSkills,
  'assistant-skills/definition': loadAssistantSkillsDefinition,
  'event-triggers': loadEventTriggers,
  'lark-channel': loadLarkChannel,
  'owner-console': loadOwnerConsole,
  'assistant-web-owner': loadAssistantWebOwner,
  'assistant-web-owner/setup': loadAssistantWebOwnerSetup,
  'assistant-heartbeat': loadAssistantHeartbeat,
  'assistant-health': loadAssistantHealth,
  'credentials-keychain': loadCredentialsKeychain,
  'cli': loadDshRayCli,
  'cli/upgrade': loadDshRayUpgrade,
  'task-acceptance-contract': loadTaskAcceptanceContract,
  'assistant-growth-contract': loadAssistantGrowthContract,
}

export async function loadPackageModule(key: string): Promise<Record<string, unknown>> {
  if (key.includes('..') || key.includes('\\') || key.startsWith('/')) {
    throw new Error(`Invalid workspace package key: ${key}`)
  }
  const loader = dynamicPackageLoaders[key]
  if (loader !== undefined) {
    return loader()
  }
  if (key.includes('/')) {
    const slashIdx = key.indexOf('/')
    const slug = key.slice(0, slashIdx)
    const subpath = key.slice(slashIdx + 1)
    for (const base of ['plugins', 'packages'] as const) {
      const candidate = join(repoRoot, base, slug, 'src', `${subpath}.ts`)
      if (existsSync(candidate)) {
        return (await import(pathToFileURL(candidate).href)) as Record<string, unknown>
      }
    }
    throw new Error(`Unknown workspace package key: ${key}`)
  }
  const pluginEntry = join(repoRoot, 'plugins', key, 'src', 'index.ts')
  if (existsSync(pluginEntry)) {
    return (await import(pathToFileURL(pluginEntry).href)) as Record<string, unknown>
  }
  const pkgEntry = join(repoRoot, 'packages', key, 'src', 'index.ts')
  if (existsSync(pkgEntry)) {
    return (await import(pathToFileURL(pkgEntry).href)) as Record<string, unknown>
  }
  throw new Error(`Unknown workspace package key: ${key}`)
}

export async function readPackageManifest(pkgDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(pkgDir, 'package.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

export async function readAllWorkspaceManifests(): Promise<readonly WorkspacePackageManifest[]> {
  const results: WorkspacePackageManifest[] = []
  for (const [kind, dirName] of [['package', 'packages'], ['plugin', 'plugins']] as const) {
    const baseDir = join(repoRoot, dirName)
    const entries = await readdir(baseDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(baseDir, entry.name)
      const manifestPath = join(dir, 'package.json')
      if (!existsSync(manifestPath)) continue
      const raw = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
      results.push({
        kind,
        slug: entry.name,
        dir,
        name: String(raw.name ?? ''),
        version: String(raw.version ?? ''),
        ...(typeof raw.publishConfig === 'object' && raw.publishConfig !== null
          ? { publishConfig: raw.publishConfig as { access?: string } }
          : {}),
        raw,
      })
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name))
}

export async function readCordisPatchRaw(pluginSlug: string): Promise<string> {
  return readFile(join(repoRoot, 'plugins', pluginSlug, 'cordis.patch.yml'), 'utf8')
}
