import { z } from 'zod'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

const codec = <T>(typeSymbol: string, create: () => z.ZodType<T>) => ({ mode: 'strict' as const, typeSymbol, create })

const dependency = z.object({ name: z.string().min(1), available: z.boolean() }).readonly()
const bundleError = z.object({ code: z.string().min(1).max(64), diagnostic: z.string().max(2_048).optional() }).readonly()
const bundleRow = z.object({
  rowId: z.string().min(1).max(200),
  moduleName: z.string().min(1).max(200),
  entryId: z.string().min(1).max(200).optional(),
}).readonly()
const bundle = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  enabled: z.boolean(),
  installed: z.boolean(),
  removable: z.boolean(),
  error: bundleError.optional(),
  rows: z.array(bundleRow).max(32).readonly(),
}).readonly()
const plugin = z.object({
  entryId: z.string().min(1),
  moduleName: z.string().min(1),
  enabled: z.boolean(),
  fiberPhase: z.enum(['pending', 'loading', 'active', 'failed', 'unloading']).nullable(),
  diagnostic: z.string().max(4_096).optional(),
}).readonly()
/** `ok` read succeeds; `unavailable` means the Host service is absent; `failed` means the read rejected. */
const readPhase = z.enum(['ok', 'unavailable', 'failed'])
const host = z.object({
  settings: z.boolean(),
  pluginManager: z.boolean(),
  bundles: readPhase,
  plugins: readPhase,
  diagnostic: z.string().max(1_024).optional(),
}).readonly()
/** `absent`: no larkChannel service; `unknown`: it exists but gave no valid health. */
export const LARK_CONNECTIONS = ['absent', 'unknown', 'connected', 'connected-with-gap', 'connecting',
  'disabled', 'disconnected', 'reconnecting'] as const
export const LARK_ERROR_CODES = ['format_error', 'not_connected', 'permission_denied', 'rate_limited',
  'send_timeout', 'ssrf_blocked', 'target_revoked', 'unknown', 'upload_failed'] as const
/**
 * Scope-free availability of the intake agreement read. `absent`: no Evaluation service;
 * `unknown`: it exists but the read or its switch cannot be determined; `disabled`:
 * `intakeAttentionAgreementEnabled` is off; `available`: the switch is on. No scope or count.
 */
export const INTAKE_AGREEMENT_AVAILABILITY = ['absent', 'unknown', 'disabled', 'available'] as const
export type IntakeAgreementAvailability = typeof INTAKE_AGREEMENT_AVAILABILITY[number]
export const OwnerConsoleStatusSchema = z.object({
  feishu: z.object({
    entry: z.string().min(1).optional(),
    mode: z.enum(['env', 'handle']),
    installed: z.boolean(),
    enabled: z.boolean(),
    appIdConfigured: z.boolean(),
    connected: z.boolean(),
    connection: z.enum(LARK_CONNECTIONS),
    lastErrorCode: z.enum(LARK_ERROR_CODES).optional(),
  }).readonly(),
  traex: z.object({ entry: z.string().min(1).optional(), installed: z.boolean(), enabled: z.boolean(), command: z.string() }).readonly(),
  agy: z.object({ entry: z.string().min(1).optional(), installed: z.boolean(), enabled: z.boolean(), command: z.string() }).readonly(),
  defaultModel: z.object({
    entry: z.string().min(1).optional(),
    available: z.boolean(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
  }).readonly(),
  llmProviders: z.array(z.object({ id: z.string().min(1), name: z.string() }).readonly()).readonly(),
  host,
  dependencies: z.array(dependency).readonly(),
  evaluation: z.object({ intakeAgreement: z.enum(INTAKE_AGREEMENT_AVAILABILITY) }).readonly(),
  bundles: z.array(bundle).readonly(),
  plugins: z.array(plugin).readonly(),
}).readonly()
export type OwnerConsoleStatus = Readonly<z.infer<typeof OwnerConsoleStatusSchema>>

export const CODING_TOOL_PROBE_STATES = [
  'ready', 'missing-binary', 'auth-required', 'disabled', 'not-installed', 'invalid-command', 'error',
] as const
export const CodingToolProbeSchema = z.object({
  tool: z.enum(['traex', 'agy']),
  command: z.string().max(1_024),
  installed: z.boolean(),
  binaryFound: z.boolean(),
  loggedIn: z.boolean(),
  enabled: z.boolean(),
  routeRegistered: z.boolean(),
  ready: z.boolean(),
  state: z.enum(CODING_TOOL_PROBE_STATES),
  summary: z.string().max(1_024),
  remediation: z.string().max(1_024).optional(),
  discoveredPath: z.string().max(1_024).optional(),
  needsPathPin: z.boolean().optional(),
  loginCommand: z.string().max(1_024).optional(),
  modelCount: z.number().int().nonnegative().optional(),
  checkedAt: z.number().int().nonnegative(),
  cached: z.boolean(),
}).readonly()
export type CodingToolProbe = Readonly<z.infer<typeof CodingToolProbeSchema>>

export const SETUP_DOCTOR_SEVERITIES = ['error', 'warn', 'info'] as const
export const SETUP_DOCTOR_CATEGORIES = ['plugins', 'acp', 'autonomy', 'config'] as const
export const SetupDoctorIssueSchema = z.object({
  id: z.string().min(1).max(200),
  severity: z.enum(SETUP_DOCTOR_SEVERITIES),
  category: z.enum(SETUP_DOCTOR_CATEGORIES).optional(),
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(1_024),
  autoFixable: z.boolean(),
  fixLabel: z.string().min(1).max(120),
  copyCommand: z.string().max(500).optional(),
}).readonly()
export type SetupDoctorIssue = Readonly<z.infer<typeof SetupDoctorIssueSchema>>

export const SetupDoctorReportSchema = z.object({
  protocol: z.literal('owner-console/setup-doctor/v1'),
  checkedAt: z.number().int().nonnegative(),
  profileName: z.string().max(200),
  dshHome: z.string().max(4_096).nullable(),
  frozenSystemdProfile: z.boolean(),
  writable: z.boolean(),
  healthy: z.boolean(),
  autoFixableCount: z.number().int().nonnegative(),
  restartRequiredHint: z.boolean(),
  issues: z.array(SetupDoctorIssueSchema).max(64).readonly(),
}).readonly()
export type SetupDoctorReport = Readonly<z.infer<typeof SetupDoctorReportSchema>>

export const ModelReasoningEffortOptionSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  description: z.string().max(300).optional(),
}).readonly()
export type ModelReasoningEffortOption = Readonly<z.infer<typeof ModelReasoningEffortOptionSchema>>

export const ModelCatalogItemSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(400).optional(),
  efforts: z.array(ModelReasoningEffortOptionSchema).max(16).readonly(),
  defaultEffort: z.string().min(1).max(128).optional(),
}).readonly()
export type ModelCatalogItem = Readonly<z.infer<typeof ModelCatalogItemSchema>>

export const ModelCatalogProviderSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  kind: z.enum(['acp', 'api']),
  active: z.boolean(),
  models: z.array(ModelCatalogItemSchema).max(200).readonly(),
  diagnostic: z.string().max(400).optional(),
}).readonly()
export type ModelCatalogProvider = Readonly<z.infer<typeof ModelCatalogProviderSchema>>

export const OwnerConsoleModelCatalogSchema = z.object({
  protocol: z.literal('owner-console/model-catalog/v1'),
  fetchedAt: z.number().int().nonnegative(),
  defaultSelection: z.object({
    provider: z.string().max(200),
    model: z.string().max(256),
    reasoningEffort: z.string().max(128).optional(),
  }).readonly(),
  providers: z.array(ModelCatalogProviderSchema).max(64).readonly(),
}).readonly()
export type OwnerConsoleModelCatalog = Readonly<z.infer<typeof OwnerConsoleModelCatalogSchema>>

export const AssistantChatCapabilitiesSchema = z.object({
  memory: z.boolean(),
  wiki: z.boolean(),
  dreaming: z.boolean(),
  proactive: z.boolean(),
  growth: z.boolean(),
  feishuConnected: z.boolean(),
}).readonly()
export type AssistantChatCapabilities = Readonly<z.infer<typeof AssistantChatCapabilitiesSchema>>

export const AssistantChatContextSchema = z.object({
  protocol: z.literal('owner-console/assistant-chat/v1'),
  workspace: z.string().max(4_096),
  agentPreset: z.string().min(1).max(200).optional(),
  activeSessionId: z.string().max(200).nullable(),
  knownSessionIds: z.array(z.string().min(1).max(200)).max(32).readonly(),
  capabilities: AssistantChatCapabilitiesSchema,
}).readonly()
export type AssistantChatContext = Readonly<z.infer<typeof AssistantChatContextSchema>>

export const FEISHU_QR_ONBOARDING_STATES = [
  'idle',
  'awaiting-scan',
  'applying',
  'completed',
  'expired',
  'denied',
  'cancelled',
  'failed',
] as const
export type FeishuQrOnboardingState = typeof FEISHU_QR_ONBOARDING_STATES[number]

export const FEISHU_QR_OWNER_BINDINGS = [
  'bound-owner',
  'reused-owner',
  'linked-to-owner',
  'reused-linked',
  'not-returned',
  'unmodified',
] as const
export type FeishuQrOwnerBinding = typeof FEISHU_QR_OWNER_BINDINGS[number]

/** Strict wire snapshot for official Feishu/Lark OAuth 2.0 Device Authorization onboarding.
 * Never carries `device_code` or `client_secret` across the Host/Web boundary. */
export const FeishuQrOnboardingSnapshotSchema = z.object({
  protocol: z.literal('owner-console/feishu-qr-onboarding/v1'),
  sessionId: z.string().max(128),
  state: z.enum(FEISHU_QR_ONBOARDING_STATES),
  domain: z.enum(['feishu', 'lark']),
  domainSwitched: z.boolean(),
  verificationUrl: z.string().max(4_096).optional(),
  qrCodeDataUrl: z.string().max(131_072).optional(),
  startedAt: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  pollIntervalMs: z.number().int().positive().max(120_000).optional(),
  appId: z.string().max(64).optional(),
  openId: z.string().max(256).optional(),
  ownerBinding: z.enum(FEISHU_QR_OWNER_BINDINGS).optional(),
  applied: z.boolean().optional(),
  connected: z.boolean().optional(),
  restartRecommended: z.boolean().optional(),
  note: z.string().max(2_048),
  errorCode: z.string().max(128).optional(),
}).readonly()
export type FeishuQrOnboardingSnapshot = Readonly<z.infer<typeof FeishuQrOnboardingSnapshotSchema>>

const subsystemState = z.enum(['absent', 'disabled', 'ok', 'error'])
const boundedCountMap = z.record(z.string(), z.number().int().nonnegative())

const dreamIdeaSummary = z.object({
  id: z.string().min(1).max(200),
  runId: z.string().max(200),
  createdAt: z.number().int().nonnegative(),
  dayKey: z.string().max(32),
  state: z.string().max(32),
  summary: z.string().max(400),
  detail: z.string().max(800),
  evidenceCount: z.number().int().nonnegative(),
}).readonly()

const proactiveDraftSummary = z.object({
  id: z.string().min(1).max(200),
  goalId: z.string().max(200),
  profileId: z.string().max(120).optional(),
  objective: z.string().max(400).optional(),
  state: z.string().max(32),
  reason: z.string().max(200).optional(),
  decisionState: z.string().max(32).optional(),
  feedback: z.string().max(32).optional(),
  updatedAt: z.number().int().nonnegative(),
  outputPreview: z.string().max(400).optional(),
  verified: z.boolean(),
}).readonly()

const attentionQuestionSummary = z.object({
  questionId: z.string().min(1).max(200),
  proposalId: z.string().max(200).optional(),
  cohortLane: z.string().min(1).max(160),
  cohortSourceId: z.string().min(1).max(160),
  workspace: z.string().max(4_096).optional(),
  preset: z.string().max(200).optional(),
  open: z.boolean().optional(),
  actionable: z.boolean().optional(),
  deliveryStatus: z.string().max(32),
  recordedAt: z.number().int().nonnegative(),
  questionSummary: z.string().max(400).optional(),
  replyChoice: z.string().max(64).optional(),
  repliedAt: z.number().int().nonnegative().optional(),
}).readonly()

const workItemQueueEntry = z.object({
  id: z.string().min(1).max(200),
  entryKind: z.enum(['admission', 'observed', 'outcome']).optional(),
  source: z.string().max(120).optional(),
  mode: z.string().max(32).optional(),
  outcome: z.string().max(64),
  reasonCode: z.string().max(120).optional(),
  observeReason: z.string().max(120).optional(),
  summary: z.string().max(400).optional(),
  wouldReject: z.array(z.string().max(120)).max(16).readonly().optional(),
  recordedAt: z.number().int().nonnegative(),
}).readonly()

const growthProposalSummary = z.object({
  id: z.string().min(1).max(200),
  kind: z.string().max(64),
  state: z.string().max(64),
  summary: z.string().max(400),
  recordedAt: z.number().int().nonnegative(),
}).readonly()

export const OwnerConsoleAssistantOverviewSchema = z.object({
  resolvedScope: z.object({
    workspace: z.string().max(4_096),
    preset: z.string().max(200),
  }).readonly().optional(),
  dreaming: z.object({
    state: subsystemState,
    health: z.object({
      enabled: z.boolean(),
      scheduler: z.enum(['active', 'dormant', 'unavailable']),
      lastRunAt: z.number().int().nonnegative().optional(),
      lastRunOutcome: z.string().max(160).optional(),
      lastSkipReason: z.string().max(160).optional(),
      runs: z.number().int().nonnegative(),
      ideas: z.number().int().nonnegative(),
      recorded: z.number().int().nonnegative(),
    }).readonly().optional(),
    ideas: z.array(dreamIdeaSummary).max(20).readonly(),
    canAcknowledge: z.boolean(),
    canValidate: z.boolean(),
    canReject: z.boolean(),
    canRetire: z.boolean(),
    missingPrerequisites: z.array(z.string().max(64)).max(16).readonly(),
    note: z.string().max(400).optional(),
  }).readonly(),
  proactive: z.object({
    state: subsystemState,
    profileCount: z.number().int().nonnegative(),
    intakeEvaluation: z.object({
      enabled: z.boolean(),
      registered: z.boolean(),
      callsLastHour: z.number().int().nonnegative(),
      consecutiveFailures: z.number().int().nonnegative(),
      degradedReason: z.string().max(240).optional(),
    }).readonly().optional(),
    canResolveDraft: z.boolean().optional(),
    drafts: z.array(proactiveDraftSummary).max(20).readonly(),
    attentionQuestions: z.array(attentionQuestionSummary).max(20).readonly(),
    note: z.string().max(400).optional(),
  }).readonly(),
  workItems: z.object({
    state: subsystemState,
    health: z.object({
      enabled: z.boolean(),
      mode: z.string().max(32),
      openItems: z.number().int().nonnegative(),
      workerConnected: z.boolean(),
      ownerRouteValid: z.boolean(),
      lastAdmitAt: z.number().int().nonnegative().optional(),
      evaluationPending: z.number().int().nonnegative(),
      intakeEnabled: z.boolean().optional(),
      intakeLedgerEnabled: z.boolean().optional(),
      admitMode: z.string().max(32).optional(),
      hasAcceptanceObjective: z.boolean().optional(),
      pendingAdmissions: z.number().int().nonnegative().optional(),
      intakeEvaluated: z.number().int().nonnegative().optional(),
    }).readonly().optional(),
    queue: z.array(workItemQueueEntry).max(20).readonly(),
    note: z.string().max(400).optional(),
  }).readonly(),
  memoryLearning: z.object({
    state: subsystemState,
    health: z.object({
      enabled: z.boolean(),
      connected: z.boolean(),
      available: z.boolean(),
      remainingExtractions: z.number().int().nonnegative(),
      lastScanAt: z.number().int().nonnegative().optional(),
      lastError: z.string().max(300).optional(),
      counts: boundedCountMap,
    }).readonly().optional(),
    note: z.string().max(400).optional(),
  }).readonly(),
  growthDriver: z.object({
    state: subsystemState,
    health: z.object({
      enabled: z.boolean(),
      outcome: z.string().max(64),
      lastWakeAt: z.number().int().nonnegative().optional(),
      reason: z.string().max(240).optional(),
      lastRunOutcome: z.string().max(64).optional(),
      usageEnabled: z.boolean(),
      usageConnected: z.boolean(),
      usageLastScanAt: z.number().int().nonnegative().optional(),
      usageCounts: boundedCountMap,
      dreamingIntake: z.object({
        enabled: z.boolean(),
        considered: z.number().int().nonnegative(),
        ingested: z.number().int().nonnegative(),
        rejectedUnvalidated: z.number().int().nonnegative(),
      }).readonly().optional(),
    }).readonly().optional(),
    proposals: z.array(growthProposalSummary).max(20).readonly(),
    note: z.string().max(400).optional(),
  }).readonly(),
}).readonly()
export type OwnerConsoleAssistantOverview = Readonly<z.infer<typeof OwnerConsoleAssistantOverviewSchema>>

/** `pendingBuilds` names dependency build scripts the Host recorded and a confirmed retry may approve. */
export const WRITE_RESULT = z.object({
  applied: z.boolean(),
  entry: z.string(),
  note: z.string(),
  pendingBuilds: z.array(z.string().min(1).max(200)).max(64).readonly().optional(),
}).readonly()
export type OwnerConsoleWriteResult = Readonly<z.infer<typeof WRITE_RESULT>>

export const AUTONOMY_BUDGET_TIERS = ['conservative', 'balanced', 'custom'] as const
export type AutonomyBudgetTier = typeof AUTONOMY_BUDGET_TIERS[number]

export const AUTONOMY_SETUP_ACTIONS = ['enable', 'pause', 'disable'] as const
export type AutonomySetupAction = typeof AUTONOMY_SETUP_ACTIONS[number]

export const AutonomyBudgetLimitsSchema = z.object({
  dailyMemoryExtractions: z.number().int().min(1).max(10_000),
  dailyMemoryScans: z.number().int().min(1).max(10_000),
  dailyDreams: z.number().int().min(1).max(24),
  dailyGrowthReviews: z.number().int().min(1).max(1_000),
  dailyGrowthDiscoveryScans: z.number().int().min(1).max(10_000),
  maxIdeasPerWake: z.number().int().min(1).max(5),
  grantLeaseDays: z.number().int().min(1).max(365),
}).readonly()
export type AutonomyBudgetLimits = Readonly<z.infer<typeof AutonomyBudgetLimitsSchema>>

export const AUTONOMY_TIER_DEFAULTS: Readonly<Record<Exclude<AutonomyBudgetTier, 'custom'>, AutonomyBudgetLimits>> = Object.freeze({
  conservative: Object.freeze({
    dailyMemoryExtractions: 10,
    dailyMemoryScans: 1440,
    dailyDreams: 2,
    dailyGrowthReviews: 5,
    dailyGrowthDiscoveryScans: 1440,
    maxIdeasPerWake: 3,
    grantLeaseDays: 30,
  }),
  balanced: Object.freeze({
    dailyMemoryExtractions: 25,
    dailyMemoryScans: 1440,
    dailyDreams: 6,
    dailyGrowthReviews: 15,
    dailyGrowthDiscoveryScans: 1440,
    maxIdeasPerWake: 3,
    grantLeaseDays: 30,
  }),
})

export const AutonomySetupStatusSchema = z.object({
  profile: z.object({
    dshHome: z.string().max(4_096).nullable(),
    profileName: z.string().max(200),
    patchPath: z.string().max(4_096).nullable(),
    patchExists: z.boolean(),
    writable: z.boolean(),
    dbPathsScoped: z.boolean(),
    unscopedDbPaths: z.array(z.string().max(4_096)).max(16).readonly(),
    restartCommand: z.string().max(500).nullable(),
  }).readonly(),
  ownerRoute: z.object({
    configured: z.boolean(),
    active: z.boolean(),
    channel: z.enum(['web', 'lark', 'other', 'absent']),
    authorityId: z.string().max(200).nullable(),
    principalId: z.string().max(200).nullable(),
    workspace: z.string().max(4_096),
    preset: z.string().max(200),
    webGrantReady: z.boolean(),
    missingReason: z.string().max(500).nullable(),
  }).readonly(),
  modelRoute: z.object({
    provider: z.string().max(200).nullable(),
    model: z.string().max(256).nullable(),
    reasoningEffort: z.string().max(128).nullable(),
    routeKind: z.enum(['traex-agent', 'agy-agent', 'api', 'unconfigured']),
    traexInstalled: z.boolean(),
    traexEnabled: z.boolean(),
    agyEnabled: z.boolean(),
    apiProviders: z.array(z.object({
      id: z.string().max(200),
      name: z.string().max(200),
    }).readonly()).max(64).readonly(),
    ready: z.boolean(),
    missingReason: z.string().max(500).nullable(),
  }).readonly(),
  grants: z.object({
    memoryLearning: z.object({
      installed: z.boolean(),
      configured: z.boolean(),
      enabled: z.boolean(),
      threeAuthoritiesIndependent: z.boolean(),
      expiresAt: z.number().int().nonnegative().nullable(),
      expired: z.boolean(),
      workItemExperiences: z.boolean(),
      databasePath: z.string().max(4_096).nullable(),
    }).readonly(),
    dreaming: z.object({
      installed: z.boolean(),
      configured: z.boolean(),
      enabled: z.boolean(),
      retired: z.boolean(),
      maxDreamsPerDay: z.number().int().nonnegative().nullable(),
      maxIdeasPerWake: z.number().int().nonnegative().nullable(),
      databasePath: z.string().max(4_096).nullable(),
    }).readonly(),
    growthDriver: z.object({
      installed: z.boolean(),
      configured: z.boolean(),
      enabled: z.boolean(),
      usageEnabled: z.boolean(),
      dreamingIdeasEnabled: z.boolean(),
      databasePath: z.string().max(4_096).nullable(),
    }).readonly(),
    assistantPolicy: z.object({
      installed: z.boolean(),
      schedulerEnabled: z.boolean(),
      allowUnbudgetedExecution: z.boolean(),
      rulesCount: z.number().int().nonnegative(),
      budgetsCount: z.number().int().nonnegative(),
      ready: z.boolean(),
    }).readonly(),
  }).readonly(),
  activeTier: z.enum(AUTONOMY_BUDGET_TIERS),
  activeBudgets: AutonomyBudgetLimitsSchema,
  overallReady: z.boolean(),
  blockingReasons: z.array(z.string().max(500)).max(32).readonly(),
}).readonly()
export type AutonomySetupStatus = Readonly<z.infer<typeof AutonomySetupStatusSchema>>

export const SelfUpgradeStatusSchema = z.object({
  currentEnhancedVersion: z.string().max(128),
  latestEnhancedVersion: z.string().max(128).nullable(),
  enhancedUpdateAvailable: z.boolean(),
  boundHostVersion: z.string().max(128).nullable(),
  installedHostVersion: z.string().max(128).nullable(),
  targetHostVersion: z.string().max(128).nullable(),
  hostUpdateAvailable: z.boolean(),
  frozenSystemdProfile: z.boolean(),
  profileName: z.string().max(200),
  dshHome: z.string().max(4_096).nullable(),
  canTriggerDetached: z.boolean(),
  upgradeCommand: z.string().max(1_024),
  checkedAt: z.number().int().nonnegative(),
  cached: z.boolean(),
  offline: z.boolean(),
  checkSource: z.enum(['dsh-rsi', 'npm-registry', 'offline']),
  note: z.string().max(500),
}).readonly()
export type SelfUpgradeStatus = Readonly<z.infer<typeof SelfUpgradeStatusSchema>>

export const SelfUpgradePreviewSchema = z.object({
  supported: z.boolean(),
  frozenSystemdProfile: z.boolean(),
  requiresOutOfBandCli: z.boolean(),
  command: z.string().max(1_024),
  currentEnhancedVersion: z.string().max(128),
  targetEnhancedVersion: z.string().max(128).nullable(),
  boundHostVersion: z.string().max(128).nullable(),
  targetHostVersion: z.string().max(128).nullable(),
  backupRequired: z.boolean(),
  warnings: z.array(z.string().max(500)).max(32).readonly(),
  summary: z.string().max(1_000),
}).readonly()
export type SelfUpgradePreview = Readonly<z.infer<typeof SelfUpgradePreviewSchema>>

export const GROWTH_DATA_STATES = ['no-data', 'zero', 'data'] as const
export type GrowthDataState = typeof GROWTH_DATA_STATES[number]
const growthDataState = z.enum(GROWTH_DATA_STATES)
const nullablePpm = z.number().int().min(0).max(1_000_000).nullable()

export const OwnerConsoleGrowthSupplierSchema = z.object({
  supplier: z.string().min(1).max(256),
  runs: z.number().int().nonnegative(),
  costUsdMicros: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  latencySamples: z.number().int().nonnegative(),
  avgLatencyMs: z.number().int().nonnegative().nullable(),
  p50LatencyMs: z.number().int().nonnegative().nullable(),
  p95LatencyMs: z.number().int().nonnegative().nullable(),
}).readonly()
export type OwnerConsoleGrowthSupplier = Readonly<z.infer<typeof OwnerConsoleGrowthSupplierSchema>>

export const OwnerConsoleGrowthReportSchema = z.object({
  protocol: z.literal('owner-console/growth-report/v1'),
  sinceDays: z.number().int().min(1).max(365),
  fromAt: z.number().int().nonnegative(),
  toAt: z.number().int().nonnegative(),
  resolvedScope: z.object({
    workspace: z.string().max(4_096),
    preset: z.string().max(200),
  }).readonly().optional(),
  overallState: growthDataState,
  cliCommand: z.string().max(256),
  tasks: z.object({
    state: growthDataState,
    totalTasks: z.number().int().nonnegative(),
    achieved: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    notAchieved: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    ownerCorrections: z.number().int().nonnegative(),
    ownerWithdrawals: z.number().int().nonnegative(),
    reworkTasks: z.number().int().nonnegative(),
    correctionRatePpm: nullablePpm,
    reworkRatePpm: nullablePpm,
    withdrawalRatePpm: nullablePpm,
    previousTotalTasks: z.number().int().nonnegative(),
    previousCorrectionRatePpm: nullablePpm,
    correctionRateDeltaPpm: z.number().int().min(-1_000_000).max(1_000_000).nullable(),
    trend: z.enum(['improving', 'regressing', 'flat', 'insufficient-data']),
  }).readonly(),
  memory: z.object({
    state: growthDataState,
    activeMemoriesTotal: z.number().int().nonnegative(),
    newMemories: z.number().int().nonnegative(),
    sourcedMemories: z.number().int().nonnegative(),
    withdrawnOrRemovedMemories: z.number().int().nonnegative(),
    activePreferenceOverlays: z.number().int().nonnegative(),
    promptExposures: z.number().int().nonnegative(),
    postExposureSameClassCorrections: z.number().int().nonnegative(),
    postExposureCorrectionRatePpm: nullablePpm,
    sameClassCorrectionTrend: z.enum(['reduced', 'unchanged', 'increased', 'insufficient-data']),
  }).readonly(),
  candidates: z.object({
    state: growthDataState,
    generated: z.number().int().nonnegative(),
    verificationPassed: z.number().int().nonnegative(),
    verificationFailed: z.number().int().nonnegative(),
    adopted: z.number().int().nonnegative(),
    rolledBack: z.number().int().nonnegative(),
  }).readonly(),
  notifications: z.object({
    state: growthDataState,
    total: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    reacted: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    ignoredOrExpired: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    wouldAcceptTotal: z.number().int().nonnegative(),
    agreementDecided: z.number().int().nonnegative(),
    agreementAgreed: z.number().int().nonnegative(),
    agreementDisagreed: z.number().int().nonnegative(),
    agreementPpm: nullablePpm,
    holdoutDecidedSamples: z.number().int().nonnegative(),
    looseningMinHoldoutSamples: z.number().int().positive(),
    looseningGateStatus: z.enum(['insufficient-samples', 'ready-for-review']),
  }).readonly(),
  suppliers: z.object({
    state: growthDataState,
    totalRuns: z.number().int().nonnegative(),
    totalCostUsdMicros: z.number().int().nonnegative(),
    suppliers: z.array(OwnerConsoleGrowthSupplierSchema).max(32).readonly(),
  }).readonly(),
  memoryLaneGate: z.object({
    targetWindowDays: z.number().int().positive(),
    windowSatisfied: z.boolean(),
    authenticatedCorrections: z.number().int().nonnegative(),
    minAuthenticatedCorrections: z.number().int().positive(),
    sourcedMemories: z.number().int().nonnegative(),
    minSourcedMemories: z.number().int().positive(),
    promptExposures: z.number().int().nonnegative(),
    minPromptExposures: z.number().int().positive(),
    correctionRateDropped: z.boolean(),
    conflictedTasks: z.number().int().nonnegative(),
    status: z.enum(['no-data', 'collecting', 'passed', 'attention-needed']),
  }).readonly(),
}).readonly()
export type OwnerConsoleGrowthReport = Readonly<z.infer<typeof OwnerConsoleGrowthReportSchema>>

/** Bounds of the read-only trend snapshot page; the control plane enforces the same page limit. */
export const TREND_SNAPSHOT_PAGE_MAX = 100
const DIGEST = z.string().regex(/^[a-f0-9]{64}$/u)
const PLAN_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u)
const label = z.string().min(1).max(200)
const count = z.number().int().nonnegative()
export const TREND_FLAGS = ['parallel-trend-suspect', 'no-control-cohort', 'concurrent-adoptions', 'partial-window',
  'adoption-not-active'] as const
const trendModel = z.union([
  z.object({ state: z.literal('frozen'), provider: label, model: label, reasoningEffort: label.optional() }).readonly(),
  z.object({ state: z.enum(['missing', 'inconsistent']) }).readonly(),
])
const trendStratum = z.object({
  model: trendModel,
  differenceInDifferences: z.union([
    z.object({ status: z.literal('estimated'), estimate: z.number(), low: z.number(), high: z.number() }).readonly(),
    z.object({ status: z.literal('insufficient') }).readonly(),
  ]),
  parallelTrend: z.enum(['not-flagged', 'parallel-trend-suspect', 'untestable']),
}).readonly()
const trendSnapshotItem = z.object({
  sequence: z.number().int().positive(),
  sealedAt: z.number().int().positive(),
  planId: PLAN_ID,
  digest: DIGEST,
  inputsDigest: DIGEST,
  trendDigest: DIGEST,
  window: z.object({ windowMs: z.number().int().positive(), preWindows: count, postWindows: count,
    startExclusive: z.number().int(), endInclusive: z.number().int(), complete: z.boolean() }).readonly(),
  cohorts: z.object({ treatedSessions: count, controlSessions: count }).readonly(),
  flags: z.array(z.enum(TREND_FLAGS)).max(TREND_FLAGS.length).readonly(),
  strata: z.array(trendStratum).max(64).readonly(),
}).readonly()
/**
 * `absent`: no control plane service; `unverifiable`: it refused the query or a sealed row failed its digest check.
 * Observational only: `causal` is always false and nothing here adopts, promotes or revokes.
 */
export const OwnerConsoleTrendSnapshotsSchema = z.object({
  state: z.enum(['absent', 'unverifiable', 'ok']),
  causal: z.literal(false),
  items: z.array(trendSnapshotItem).max(TREND_SNAPSHOT_PAGE_MAX).readonly(),
  nextBeforeSequence: z.number().int().positive().optional(),
}).readonly()
export type OwnerConsoleTrendSnapshots = Readonly<z.infer<typeof OwnerConsoleTrendSnapshotsSchema>>
export type OwnerConsoleTrendSnapshotItem = OwnerConsoleTrendSnapshots['items'][number]

/** Notification outcomes and intake levels as Evaluation's intake attention agreement reports them. */
export const INTAKE_AGREEMENT_OUTCOMES = ['pending', 'delivered', 'reacted', 'accepted', 'rejected', 'expired-unhandled', 'failed'] as const
export const INTAKE_AGREEMENT_LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
const intakeAgreementCell = z.object({
  notifications: count,
  items: count,
  outcomes: z.object(Object.fromEntries(INTAKE_AGREEMENT_OUTCOMES.map(outcome => [outcome, count])) as
    Record<typeof INTAKE_AGREEMENT_OUTCOMES[number], typeof count>).readonly(),
  agreed: count,
  disagreed: count,
  agreementPpm: z.number().int().min(0).max(1_000_000).nullable(),
}).readonly()
/**
 * `absent`: no Evaluation service; `disabled`: `intakeAttentionAgreementEnabled` is off;
 * `unverifiable`: the read was refused, failed or returned an unexpected shape.
 * Observational only: `causal` is always false and nothing here writes, adopts or sends.
 */
export const OwnerConsoleIntakeAgreementSchema = z.object({
  state: z.enum(['absent', 'disabled', 'unverifiable', 'ok']),
  causal: z.literal(false),
  summary: z.object({
    fromNotifiedAt: z.number().int().nonnegative(),
    toNotifiedAt: z.number().int().positive(),
    scanned: count,
    truncated: z.boolean(),
    provenanceAvailable: z.boolean(),
    notIntake: count,
    unresolved: count,
    foreign: count,
    intake: intakeAgreementCell,
    byLevel: z.array(z.object({ level: z.enum(INTAKE_AGREEMENT_LEVELS), cell: intakeAgreementCell }).readonly())
      .max(INTAKE_AGREEMENT_LEVELS.length).readonly(),
  }).readonly().optional(),
}).readonly()
export type OwnerConsoleIntakeAgreement = Readonly<z.infer<typeof OwnerConsoleIntakeAgreementSchema>>

/** One persisted E1 agreement snapshot; labeled level cells and counts only (no scope, ids or digest). */
const intakeAgreementHistorySnapshot = z.object({
  fromNotifiedAt: count,
  toNotifiedAt: count,
  computedAt: count,
  windowMs: z.number().int().min(60_000),
  scanLimit: z.number().int().min(1).max(10_000),
  truncated: z.boolean(),
  provenanceAvailable: z.boolean(),
  notIntake: count,
  unresolved: count,
  foreign: count,
  intake: intakeAgreementCell,
  byLevel: z.array(z.object({ level: z.enum(INTAKE_AGREEMENT_LEVELS), cell: intakeAgreementCell }).strict().readonly())
    .max(INTAKE_AGREEMENT_LEVELS.length).readonly(),
}).strict().readonly()
export const OwnerConsoleIntakeAgreementHistorySchema = z.object({
  state: z.enum(['absent', 'disabled', 'unverifiable', 'ok']),
  causal: z.literal(false),
  snapshots: z.array(intakeAgreementHistorySnapshot).max(100).readonly().optional(),
}).strict().readonly()
export type OwnerConsoleIntakeAgreementHistory = Readonly<z.infer<typeof OwnerConsoleIntakeAgreementHistorySchema>>

/** Strict Host and client descriptors: three reads plus owner-clicked one-step writes. */
export const TYPERT = {
  package: '@dsh-enhanced/owner-console',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/status',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'status',
      invocation: { kind: 'direct' }, parameters: [],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleStatus', () => OwnerConsoleStatusSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 30, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/trendSnapshots',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'trendSnapshots',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'planId', wire: 'planId', source: 'json', codec: codec('owner-console#trendPlanId', () => z.string().max(160)) },
        { name: 'beforeSequence', wire: 'beforeSequence', source: 'json',
          codec: codec('owner-console#trendBeforeSequence', () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)) },
        { name: 'limit', wire: 'limit', source: 'json',
          codec: codec('owner-console#trendLimit', () => z.number().int().min(1).max(TREND_SNAPSHOT_PAGE_MAX)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleTrendSnapshots', () => OwnerConsoleTrendSnapshotsSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 37, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/intakeAgreement',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'intakeAgreement',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#intakeWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#intakePreset', () => z.string().max(200)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleIntakeAgreement', () => OwnerConsoleIntakeAgreementSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 109, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/intakeAgreementHistory',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'intakeAgreementHistory',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#intakeWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#intakePreset', () => z.string().max(200)) },
        { name: 'limit', wire: 'limit', source: 'json',
          codec: codec('owner-console#intakeHistoryLimit', () => z.number().int().min(1).max(100)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleIntakeAgreementHistory', () => OwnerConsoleIntakeAgreementHistorySchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 160, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureFeishu',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureFeishu',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'appId', wire: 'appId', source: 'json', codec: codec('owner-console#appId', () => z.string().max(64)) },
        { name: 'appSecretEnv', wire: 'appSecretEnv', source: 'json', codec: codec('owner-console#appSecretEnv', () => z.string().max(128)) },
        { name: 'credentialHandle', wire: 'credentialHandle', source: 'json', codec: codec('owner-console#credentialHandle', () => z.string().max(128)) },
        { name: 'account', wire: 'account', source: 'json', codec: codec('owner-console#account', () => z.string().max(128)) },
        { name: 'tenant', wire: 'tenant', source: 'json', codec: codec('owner-console#tenant', () => z.string().max(128)) },
        { name: 'discoverAppId', wire: 'discoverAppId', source: 'json', codec: codec('owner-console#discoverAppId', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 38, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureTraex',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureTraex',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#enabled', () => z.boolean()) },
        { name: 'command', wire: 'command', source: 'json', codec: codec('owner-console#command', () => z.string().max(1_024)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 52, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureBundle',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureBundle',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'entry', wire: 'entry', source: 'json', codec: codec('owner-console#entry', () => z.string().max(128)) },
        { name: 'config', wire: 'config', source: 'json', codec: codec('owner-console#config', () => z.record(z.string(), z.unknown())) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 62, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/setBundleEnabled',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'setBundleEnabled',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: codec('owner-console#bundleName', () => z.string().max(200)) },
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#enabled', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 74, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/setPluginEnabled',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'setPluginEnabled',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'entryId', wire: 'entryId', source: 'json', codec: codec('owner-console#entryId', () => z.string().max(200)) },
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#enabled', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 84, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/removeProjectBundle',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'removeProjectBundle',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'name', wire: 'name', source: 'json', codec: codec('owner-console#bundleName', () => z.string().max(200)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 102, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/installProjectBundle',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'installProjectBundle',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'spec', wire: 'spec', source: 'json', codec: codec('owner-console#spec', () => z.string().max(300)) },
        { name: 'approvedBuilds', wire: 'approvedBuilds', source: 'json',
          codec: codec('owner-console#approvedBuilds', () => z.array(z.string().min(1).max(200)).max(64)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 93, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureAgy',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureAgy',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'enabled', wire: 'enabled', source: 'json', codec: codec('owner-console#agyEnabled', () => z.boolean()) },
        { name: 'command', wire: 'command', source: 'json', codec: codec('owner-console#agyCommand', () => z.string().max(1_024)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 470, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/probeCodingTool',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'probeCodingTool',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'tool', wire: 'tool', source: 'json', codec: codec('owner-console#codingTool', () => z.enum(['traex', 'agy'])) },
        { name: 'command', wire: 'command', source: 'json', codec: codec('owner-console#probeCommand', () => z.string().max(1_024)) },
        { name: 'force', wire: 'force', source: 'json', codec: codec('owner-console#probeForce', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#CodingToolProbe', () => CodingToolProbeSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 480, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/setDefaultModelRoute',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'setDefaultModelRoute',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'provider', wire: 'provider', source: 'json', codec: codec('owner-console#defaultModelProvider', () => z.string().max(200)) },
        { name: 'model', wire: 'model', source: 'json', codec: codec('owner-console#defaultModelId', () => z.string().max(256)) },
        { name: 'reasoningEffort', wire: 'reasoningEffort', source: 'json', codec: codec('owner-console#defaultReasoningEffort', () => z.string().max(128)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 492, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/assistantOverview',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'assistantOverview',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#overviewWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#overviewPreset', () => z.string().max(200)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleAssistantOverview', () => OwnerConsoleAssistantOverviewSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 504, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/actDreamingIdea',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'actDreamingIdea',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'ideaId', wire: 'ideaId', source: 'json', codec: codec('owner-console#dreamIdeaId', () => z.string().max(200)) },
        { name: 'action', wire: 'action', source: 'json',
          codec: codec('owner-console#dreamAction', () => z.enum(['acknowledge', 'validate', 'reject', 'retire'])) },
        { name: 'note', wire: 'note', source: 'json', codec: codec('owner-console#dreamNote', () => z.string().max(500)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 515, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/actAttentionQuestion',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'actAttentionQuestion',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#attentionWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#attentionPreset', () => z.string().max(200)) },
        { name: 'cohortLane', wire: 'cohortLane', source: 'json', codec: codec('owner-console#attentionLane', () => z.string().max(160)) },
        { name: 'cohortSourceId', wire: 'cohortSourceId', source: 'json', codec: codec('owner-console#attentionSourceId', () => z.string().max(160)) },
        { name: 'questionId', wire: 'questionId', source: 'json', codec: codec('owner-console#attentionQuestionId', () => z.string().max(200)) },
        { name: 'choice', wire: 'choice', source: 'json', codec: codec('owner-console#attentionChoice', () => z.enum(['authorize-once', 'decline'])) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 527, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/actProactiveDraft',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'actProactiveDraft',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'id', wire: 'id', source: 'json', codec: codec('owner-console#draftId', () => z.string().max(200)) },
        { name: 'action', wire: 'action', source: 'json',
          codec: codec('owner-console#draftAction', () => z.enum(['accept', 'reject', 'cancel'])) },
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#draftWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#draftPreset', () => z.string().max(200)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 541, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/autonomySetupStatus',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'autonomySetupStatus',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dsh-enhanced/owner-console#AutonomySetupStatus', () => AutonomySetupStatusSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 735, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureAutonomySetup',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureAutonomySetup',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'action', wire: 'action', source: 'json', codec: codec('owner-console#autonomySetupAction', () => z.enum(AUTONOMY_SETUP_ACTIONS)) },
        { name: 'tier', wire: 'tier', source: 'json', codec: codec('owner-console#autonomyBudgetTier', () => z.enum(AUTONOMY_BUDGET_TIERS)) },
        { name: 'provider', wire: 'provider', source: 'json', codec: codec('owner-console#autonomyProvider', () => z.string().max(200)) },
        { name: 'model', wire: 'model', source: 'json', codec: codec('owner-console#autonomyModel', () => z.string().max(256)) },
        { name: 'reasoningEffort', wire: 'reasoningEffort', source: 'json', codec: codec('owner-console#autonomyReasoningEffort', () => z.string().max(128)) },
        { name: 'enableMemoryLearning', wire: 'enableMemoryLearning', source: 'json', codec: codec('owner-console#autonomyEnableMemoryLearning', () => z.boolean()) },
        { name: 'enableDreaming', wire: 'enableDreaming', source: 'json', codec: codec('owner-console#autonomyEnableDreaming', () => z.boolean()) },
        { name: 'enableGrowth', wire: 'enableGrowth', source: 'json', codec: codec('owner-console#autonomyEnableGrowth', () => z.boolean()) },
        { name: 'workItemExperiences', wire: 'workItemExperiences', source: 'json', codec: codec('owner-console#autonomyWorkItemExperiences', () => z.boolean()) },
        { name: 'customBudget', wire: 'customBudget', source: 'json', codec: codec('owner-console#AutonomyBudgetLimits', () => AutonomyBudgetLimitsSchema) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 743, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/checkSelfUpgrade',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'checkSelfUpgrade',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'force', wire: 'force', source: 'json', codec: codec('owner-console#upgradeForce', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#SelfUpgradeStatus', () => SelfUpgradeStatusSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 763, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/dryRunSelfUpgrade',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'dryRunSelfUpgrade',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dsh-enhanced/owner-console#SelfUpgradePreview', () => SelfUpgradePreviewSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 773, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/runSelfUpgrade',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'runSelfUpgrade',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'confirmed', wire: 'confirmed', source: 'json', codec: codec('owner-console#upgradeConfirmed', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 781, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/growthReport',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'growthReport',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'workspace', wire: 'workspace', source: 'json', codec: codec('owner-console#growthWorkspace', () => z.string().max(4_096)) },
        { name: 'preset', wire: 'preset', source: 'json', codec: codec('owner-console#growthPreset', () => z.string().max(200)) },
        { name: 'sinceDays', wire: 'sinceDays', source: 'json', codec: codec('owner-console#growthSinceDays', () => z.number().int().min(1).max(365)) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleGrowthReport', () => OwnerConsoleGrowthReportSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 912, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/setupDoctor',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'setupDoctor',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dsh-enhanced/owner-console#SetupDoctorReport', () => SetupDoctorReportSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 945, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/applyDoctorRepair',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'applyDoctorRepair',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'issueIds', wire: 'issueIds', source: 'json', codec: codec('owner-console#doctorIssueIds', () => z.array(z.string().min(1).max(200)).max(64)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 954, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/configureFeishuEasy',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureFeishuEasy',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'appId', wire: 'appId', source: 'json', codec: codec('owner-console#easyAppId', () => z.string().max(128)) },
        { name: 'appSecret', wire: 'appSecret', source: 'json', codec: codec('owner-console#easyAppSecret', () => z.string().max(512)) },
        { name: 'account', wire: 'account', source: 'json', codec: codec('owner-console#easyAccount', () => z.string().max(512)) },
        { name: 'tenant', wire: 'tenant', source: 'json', codec: codec('owner-console#easyTenant', () => z.string().max(512)) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 966, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/modelCatalog',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'modelCatalog',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'force', wire: 'force', source: 'json', codec: codec('owner-console#modelCatalogForce', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#OwnerConsoleModelCatalog', () => OwnerConsoleModelCatalogSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 1005, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/assistantChatContext',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'assistantChatContext',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec('@dsh-enhanced/owner-console#AssistantChatContext', () => AssistantChatContextSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 1030, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/registerAssistantSession',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'registerAssistantSession',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: codec('owner-console#assistantSessionId', () => z.string().min(1).max(200)) },
        { name: 'makeActive', wire: 'makeActive', source: 'json', codec: codec('owner-console#assistantMakeActive', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#write', () => WRITE_RESULT),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 1040, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/startFeishuQrOnboarding',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'startFeishuQrOnboarding',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'domain', wire: 'domain', source: 'json', codec: codec('owner-console#feishuQrDomain', () => z.enum(['feishu', 'lark'])) },
        { name: 'appName', wire: 'appName', source: 'json', codec: codec('owner-console#feishuQrAppName', () => z.string().max(64)) },
        { name: 'existingAppId', wire: 'existingAppId', source: 'json', codec: codec('owner-console#feishuQrExistingAppId', () => z.string().max(64)) },
        { name: 'account', wire: 'account', source: 'json', codec: codec('owner-console#feishuQrAccount', () => z.string().max(128)) },
        { name: 'tenant', wire: 'tenant', source: 'json', codec: codec('owner-console#feishuQrTenant', () => z.string().max(128)) },
        { name: 'calendarReadonly', wire: 'calendarReadonly', source: 'json', codec: codec('owner-console#feishuQrCalendarReadonly', () => z.boolean()) },
        { name: 'businessTools', wire: 'businessTools', source: 'json', codec: codec('owner-console#feishuQrBusinessTools', () => z.boolean()) },
      ],
      result: codec('@dsh-enhanced/owner-console#FeishuQrOnboardingSnapshot', () => FeishuQrOnboardingSnapshotSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 1082, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/feishuQrOnboardingStatus',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'feishuQrOnboardingStatus',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: codec('owner-console#feishuQrSessionId', () => z.string().max(128)) },
      ],
      result: codec('@dsh-enhanced/owner-console#FeishuQrOnboardingSnapshot', () => FeishuQrOnboardingSnapshotSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 1098, column: 3 },
    },
    {
      id: '@dsh-enhanced/owner-console#ownerConsole/cancelFeishuQrOnboarding',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'cancelFeishuQrOnboarding',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'sessionId', wire: 'sessionId', source: 'json', codec: codec('owner-console#feishuQrCancelSessionId', () => z.string().max(128)) },
      ],
      result: codec('@dsh-enhanced/owner-console#FeishuQrOnboardingSnapshot', () => FeishuQrOnboardingSnapshotSchema),
      sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 1108, column: 3 },
    },
  ],
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution

/** The generated client shape is bundled into the Web module by build-client. */
export const TYPERT_REMOTE = { package: TYPERT.package, descriptors: TYPERT.invocations }
