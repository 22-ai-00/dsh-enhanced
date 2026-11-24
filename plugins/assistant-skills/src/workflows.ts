import type { GoalScope, VerifiedWorkflowSource } from '@dsh-enhanced/assistant-goals'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import {
  assertDefinitionProtocol,
  createDefinition,
  validateStepGraph,
  WORKFLOW_FAMILY_IDS,
  type CreateDefinitionOptions,
  type SkillBinding,
  type SkillCompensationKind,
  type SkillCompensationPlan,
  type SkillDefinition,
  type SkillInput,
  type SkillPreconditionKind,
  type SkillPreconditionPlan,
  type SkillStep,
  type WorkflowFamilyId,
} from './definition.js'

export interface WorkflowFamilyMetadata {
  readonly id: WorkflowFamilyId
  readonly description: string
  readonly defaultPreconditions: SkillPreconditionKind
  readonly defaultCompensation: Exclude<SkillCompensationKind, 'stop-and-report' | 'compensating-action'>
  readonly primaryTools: readonly string[]
  readonly observationTools: readonly string[]
  readonly domainTools: readonly string[]
  readonly compensatorKeys: readonly string[]
}

export interface WorkflowPermissionDelta {
  readonly parent: readonly string[]
  readonly candidate: readonly string[]
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly expandsAuthority: boolean
}

export interface WorkflowLineage {
  readonly parent: { readonly name: string; readonly version: number | null; readonly digest: string | null }
  readonly reason: string
  readonly metrics: {
    readonly maxToolCalls: number
    readonly maxBytes: number
    readonly expectedExecutedSteps: number
    readonly expectedOmittedObservations: number
  }
  readonly permissionDelta: WorkflowPermissionDelta
  readonly rollbackTarget: { readonly kind: SkillCompensationKind; readonly version: number | null }
}

export interface WorkflowSkillTemplate {
  readonly protocol: 'assistant-skills/workflow-template/v1'
  readonly name: WorkflowFamilyId
  readonly category: WorkflowFamilyId
  readonly workflowFamily: WorkflowFamilyId
  readonly description: string
  readonly preconditions: SkillPreconditionKind
  readonly preconditionPlan: SkillPreconditionPlan
  readonly compensation: Exclude<SkillCompensationKind, 'stop-and-report' | 'compensating-action'>
  readonly compensationPlan: SkillCompensationPlan
  readonly allowedTools: readonly string[]
  readonly domainTools: readonly string[]
  readonly inputs: readonly SkillInput[]
  readonly steps: readonly SkillStep[]
  readonly lineage: WorkflowLineage
}

export interface WorkflowClassificationResult {
  readonly family: WorkflowFamilyId
  readonly confidence: 'explicit' | 'tool-signature' | 'fallback'
  readonly matchedTools: readonly string[]
  readonly recommendedPreconditions: SkillPreconditionKind
  readonly recommendedCompensation: Exclude<SkillCompensationKind, 'stop-and-report' | 'compensating-action'>
}

export interface BuildWorkflowSkillOptions {
  readonly name?: string
  readonly description?: string
  readonly bindings?: readonly SkillBinding[]
  readonly preconditions?: SkillPreconditionKind
  readonly preconditionPlan?: Omit<SkillPreconditionPlan, 'protocol'>
  readonly compensation?: SkillCompensationKind
  readonly compensationPlan?: Omit<SkillCompensationPlan, 'protocol'>
  readonly allowedTools?: readonly string[]
  readonly parentVersion?: number | null
  readonly parentDigest?: string | null
  readonly parentTools?: readonly string[]
}

const familySet = new Set<string>(WORKFLOW_FAMILY_IDS)

function computePermissionDelta(
  parentTools: readonly string[],
  candidateTools: readonly string[],
): WorkflowPermissionDelta {
  const parent = [...new Set(parentTools)].sort()
  const candidate = [...new Set(candidateTools)].sort()
  const parentSet = new Set(parent)
  const candidateSet = new Set(candidate)
  const added = candidate.filter(tool => !parentSet.has(tool)).sort()
  const removed = parent.filter(tool => !candidateSet.has(tool)).sort()
  return Object.freeze({
    parent: Object.freeze(parent),
    candidate: Object.freeze(candidate),
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    expandsAuthority: added.length > 0,
  })
}

export function projectWorkflowLineage(options: {
  readonly skillName: string
  readonly steps: readonly Pick<SkillStep, 'toolName'>[]
  readonly compensation: SkillCompensationKind
  readonly parentName?: string
  readonly parentVersion?: number | null
  readonly parentDigest?: string | null
  readonly parentTools?: readonly string[]
  readonly reason: string
  readonly maxToolCalls?: number
  readonly maxBytes?: number
}): WorkflowLineage {
  const candidateTools = options.steps.map(step => step.toolName)
  const parentTools = options.parentTools ?? []
  const omittedCount = options.steps.filter(step => ['glob', 'grep', 'get_goal'].includes(step.toolName)).length
  const executedCount = options.steps.length - omittedCount
  return Object.freeze({
    parent: Object.freeze({
      name: options.parentName ?? options.skillName,
      version: options.parentVersion ?? null,
      digest: options.parentDigest ?? null,
    }),
    reason: options.reason,
    metrics: Object.freeze({
      maxToolCalls: options.maxToolCalls ?? Math.max(8, options.steps.length * 2),
      maxBytes: options.maxBytes ?? 65_536,
      expectedExecutedSteps: executedCount,
      expectedOmittedObservations: omittedCount,
    }),
    permissionDelta: computePermissionDelta(parentTools, candidateTools),
    rollbackTarget: Object.freeze({
      kind: options.compensation,
      version: options.parentVersion ?? null,
    }),
  })
}

export const WORKFLOW_FAMILIES: Readonly<Record<WorkflowFamilyId, WorkflowFamilyMetadata>> = Object.freeze({
  'repo-ci-fix': Object.freeze({
    id: 'repo-ci-fix',
    description: 'Repository and CI failure triage, targeted fix, and verification summary.',
    defaultPreconditions: 'clean-git-worktree-and-policy-grant',
    defaultCompensation: 'rollback-state',
    primaryTools: Object.freeze(['read', 'edit', 'apply_patch', 'write']),
    observationTools: Object.freeze(['glob', 'grep', 'read', 'action_github_inspect']),
    domainTools: Object.freeze(['action_github_inspect', 'action_github_branch', 'action_github_commit']),
    compensatorKeys: Object.freeze(['fs.remove-created-file', 'repo.revert-branch']),
  }),
  'calendar-meeting-prep': Object.freeze({
    id: 'calendar-meeting-prep',
    description: 'Calendar window inspection, meeting agenda preparation, and brief generation.',
    defaultPreconditions: 'calendar-window-and-route-binding',
    defaultCompensation: 'rollback-state',
    primaryTools: Object.freeze(['read', 'write']),
    observationTools: Object.freeze(['read', 'action_calendar_action', 'work_item_list', 'work_item_read_context']),
    domainTools: Object.freeze(['action_calendar_action', 'work_item_list', 'work_item_read_context', 'work_item_status']),
    compensatorKeys: Object.freeze(['calendar.cancel-event', 'calendar.undo-event']),
  }),
  'email-inbox-triage': Object.freeze({
    id: 'email-inbox-triage',
    description: 'Authenticated inbox batch triage, classification log, and owner digest synthesis.',
    defaultPreconditions: 'authenticated-inbox-and-idempotency-key',
    defaultCompensation: 'compensate-via-registry',
    primaryTools: Object.freeze(['read', 'write']),
    observationTools: Object.freeze(['read', 'action_lark_action']),
    domainTools: Object.freeze(['action_lark_action', 'action_http_request']),
    compensatorKeys: Object.freeze(['email.unarchive', 'lark.undo-message']),
  }),
  'wiki-knowledge-synthesis': Object.freeze({
    id: 'wiki-knowledge-synthesis',
    description: 'Owner-scoped knowledge search, source note synthesis, and wiki page update.',
    defaultPreconditions: 'wiki-vault-revision-and-owner-scope',
    defaultCompensation: 'rollback-state',
    primaryTools: Object.freeze(['read', 'write', 'wiki_upsert']),
    observationTools: Object.freeze(['grep', 'read', 'wiki_search', 'wiki_read', 'wiki_lint']),
    domainTools: Object.freeze(['wiki_search', 'wiki_read', 'wiki_lint', 'wiki_upsert']),
    compensatorKeys: Object.freeze(['wiki.restore-entry', 'fs.remove-created-file']),
  }),
  'dependency-config-audit': Object.freeze({
    id: 'dependency-config-audit',
    description: 'Workspace manifest discovery, configuration audit, multi-file patch, and audit report.',
    defaultPreconditions: 'workspace-manifest-and-isolation-grant',
    defaultCompensation: 'rollback-state',
    primaryTools: Object.freeze(['read', 'edit', 'apply_patch', 'write', 'isolation_run']),
    observationTools: Object.freeze(['glob', 'read', 'isolation_grants']),
    domainTools: Object.freeze(['isolation_grants', 'isolation_run']),
    compensatorKeys: Object.freeze(['fs.remove-created-file']),
  }),
})

function freezeStep(step: SkillStep): SkillStep {
  return Object.freeze({
    id: step.id,
    toolName: step.toolName,
    arguments: Object.freeze(JSON.parse(JSON.stringify(step.arguments)) as unknown),
    dependsOn: Object.freeze([...step.dependsOn]),
  })
}

function freezeInput(input: SkillInput): SkillInput {
  return Object.freeze({ ...input })
}

function makeTemplate(spec: Omit<WorkflowSkillTemplate, 'protocol' | 'lineage'> & { readonly reason: string }): WorkflowSkillTemplate {
  validateStepGraph(spec.steps)
  const template: WorkflowSkillTemplate = {
    protocol: 'assistant-skills/workflow-template/v1',
    name: spec.name,
    category: spec.category,
    workflowFamily: spec.workflowFamily,
    description: spec.description,
    preconditions: spec.preconditions,
    preconditionPlan: Object.freeze({
      ...spec.preconditionPlan,
      checks: Object.freeze(spec.preconditionPlan.checks.map(check => Object.freeze({ ...check }))),
    }),
    compensation: spec.compensation,
    compensationPlan: Object.freeze({
      ...spec.compensationPlan,
      entries: Object.freeze(spec.compensationPlan.entries.map(entry => Object.freeze({ ...entry }))),
    }),
    allowedTools: Object.freeze([...spec.allowedTools]),
    domainTools: Object.freeze([...spec.domainTools]),
    inputs: Object.freeze(spec.inputs.map(freezeInput)),
    steps: Object.freeze(spec.steps.map(freezeStep)),
    lineage: projectWorkflowLineage({
      skillName: spec.name,
      steps: spec.steps,
      compensation: spec.compensation,
      reason: spec.reason,
    }),
  }
  assertDefinitionProtocol({
    preconditions: template.preconditions,
    preconditionPlan: template.preconditionPlan,
    workflowFamily: template.workflowFamily,
    compensation: template.compensation,
    compensationPlan: template.compensationPlan,
    steps: template.steps,
  })
  return Object.freeze(template)
}

const WORKFLOW_TEMPLATES: readonly WorkflowSkillTemplate[] = Object.freeze([
  makeTemplate({
    name: 'repo-ci-fix',
    category: 'repo-ci-fix',
    workflowFamily: 'repo-ci-fix',
    description: 'Inspect repository state, read CI failure diagnostics, apply a targeted fix, and write a verification summary.',
    preconditions: 'clean-git-worktree-and-policy-grant',
    preconditionPlan: {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'clean-git-worktree-and-policy-grant',
      workflowFamily: 'repo-ci-fix',
      checks: [
        { id: 'ci-report-regular', kind: 'path-regular-file', inputName: 'report_path', path: 'ci-report.txt' },
        { id: 'target-file-regular', kind: 'path-regular-file', inputName: 'target_file', path: 'src/fix.txt' },
        { id: 'edit-tool-ready', kind: 'tool-available', toolName: 'edit' },
        { id: 'write-tool-ready', kind: 'tool-available', toolName: 'write' },
        { id: 'family-match', kind: 'workflow-family', workflowFamily: 'repo-ci-fix' },
      ],
    },
    compensation: 'rollback-state',
    compensationPlan: {
      protocol: 'assistant-skills/compensation-plan/v1',
      kind: 'rollback-state',
      entries: [
        { stepId: 'apply-fix', capturePreimage: true },
        { stepId: 'write-summary', capturePreimage: true },
      ],
    },
    allowedTools: ['glob', 'read', 'edit', 'write', 'apply_patch'],
    domainTools: ['action_github_inspect', 'action_github_branch', 'action_github_commit'],
    inputs: [
      { name: 'report_path', stepId: 'read-ci-report', path: '/file_path', type: 'string', default: 'ci-report.txt' },
      { name: 'target_file', stepId: 'apply-fix', path: '/file_path', type: 'string', default: 'src/fix.txt' },
      { name: 'summary_path', stepId: 'write-summary', path: '/file_path', type: 'string', default: 'ci-summary.txt' },
    ],
    steps: [
      { id: 'inspect-repo', toolName: 'glob', arguments: { pattern: '**/*.txt' }, dependsOn: [] },
      { id: 'read-ci-report', toolName: 'read', arguments: { file_path: 'ci-report.txt' }, dependsOn: ['inspect-repo'] },
      { id: 'apply-fix', toolName: 'edit', arguments: { file_path: 'src/fix.txt', old_string: 'FAIL', new_string: 'PASS', replace_all: false }, dependsOn: ['read-ci-report'] },
      { id: 'write-summary', toolName: 'write', arguments: { file_path: 'ci-summary.txt', content: 'CI status: PASS\n' }, dependsOn: ['apply-fix'] },
    ],
    reason: 'Canonical WP13 repository/CI repair workflow with clean-git preconditions and rollback-state preimages.',
  }),
  makeTemplate({
    name: 'calendar-meeting-prep',
    category: 'calendar-meeting-prep',
    workflowFamily: 'calendar-meeting-prep',
    description: 'Read upcoming calendar window and meeting agenda, then synthesize a prepared meeting brief.',
    preconditions: 'calendar-window-and-route-binding',
    preconditionPlan: {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'calendar-window-and-route-binding',
      workflowFamily: 'calendar-meeting-prep',
      checks: [
        { id: 'agenda-file-regular', kind: 'path-regular-file', inputName: 'agenda_path', path: 'meeting-agenda.md' },
        { id: 'read-tool-ready', kind: 'tool-available', toolName: 'read' },
        { id: 'write-tool-ready', kind: 'tool-available', toolName: 'write' },
        { id: 'family-match', kind: 'workflow-family', workflowFamily: 'calendar-meeting-prep' },
      ],
    },
    compensation: 'rollback-state',
    compensationPlan: {
      protocol: 'assistant-skills/compensation-plan/v1',
      kind: 'rollback-state',
      entries: [
        { stepId: 'write-meeting-brief', capturePreimage: true },
      ],
    },
    allowedTools: ['read', 'write'],
    domainTools: ['action_calendar_action', 'work_item_list', 'work_item_read_context', 'work_item_status'],
    inputs: [
      { name: 'window_path', stepId: 'read-calendar-window', path: '/file_path', type: 'string', default: 'calendar-window.json' },
      { name: 'agenda_path', stepId: 'read-meeting-context', path: '/file_path', type: 'string', default: 'meeting-agenda.md' },
      { name: 'brief_path', stepId: 'write-meeting-brief', path: '/file_path', type: 'string', default: 'meeting-brief.md' },
    ],
    steps: [
      { id: 'read-calendar-window', toolName: 'read', arguments: { file_path: 'calendar-window.json' }, dependsOn: [] },
      { id: 'read-meeting-context', toolName: 'read', arguments: { file_path: 'meeting-agenda.md' }, dependsOn: ['read-calendar-window'] },
      { id: 'write-meeting-brief', toolName: 'write', arguments: { file_path: 'meeting-brief.md', content: '# Meeting Brief\nPrepared.\n' }, dependsOn: ['read-meeting-context'] },
    ],
    reason: 'Canonical WP13 calendar/meeting preparation workflow bound to calendar window and owner route.',
  }),
  makeTemplate({
    name: 'email-inbox-triage',
    category: 'email-inbox-triage',
    workflowFamily: 'email-inbox-triage',
    description: 'Triage authenticated inbox batch records, write structured triage state, and emit an inbox digest with registry compensation.',
    preconditions: 'authenticated-inbox-and-idempotency-key',
    preconditionPlan: {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'authenticated-inbox-and-idempotency-key',
      workflowFamily: 'email-inbox-triage',
      checks: [
        { id: 'inbox-batch-regular', kind: 'path-regular-file', inputName: 'inbox_path', path: 'inbox-batch.json' },
        { id: 'read-tool-ready', kind: 'tool-available', toolName: 'read' },
        { id: 'write-tool-ready', kind: 'tool-available', toolName: 'write' },
        { id: 'family-match', kind: 'workflow-family', workflowFamily: 'email-inbox-triage' },
      ],
    },
    compensation: 'compensate-via-registry',
    compensationPlan: {
      protocol: 'assistant-skills/compensation-plan/v1',
      kind: 'compensate-via-registry',
      entries: [
        { stepId: 'write-triage-log', compensatorKey: 'email.unarchive', capturePreimage: true },
        { stepId: 'write-inbox-digest', compensatorKey: 'email.unarchive', capturePreimage: true },
      ],
    },
    allowedTools: ['read', 'write'],
    domainTools: ['action_lark_action', 'action_http_request'],
    inputs: [
      { name: 'inbox_path', stepId: 'read-inbox-batch', path: '/file_path', type: 'string', default: 'inbox-batch.json' },
      { name: 'triage_path', stepId: 'write-triage-log', path: '/file_path', type: 'string', default: 'triage-log.json' },
      { name: 'digest_path', stepId: 'write-inbox-digest', path: '/file_path', type: 'string', default: 'inbox-digest.md' },
    ],
    steps: [
      { id: 'read-inbox-batch', toolName: 'read', arguments: { file_path: 'inbox-batch.json' }, dependsOn: [] },
      { id: 'write-triage-log', toolName: 'write', arguments: { file_path: 'triage-log.json', content: '{"status":"triaged"}\n' }, dependsOn: ['read-inbox-batch'] },
      { id: 'write-inbox-digest', toolName: 'write', arguments: { file_path: 'inbox-digest.md', content: '# Inbox Digest\nTriaged.\n' }, dependsOn: ['write-triage-log'] },
    ],
    reason: 'Canonical WP13 inbox triage workflow using authenticated idempotency preconditions and email.unarchive registry compensation.',
  }),
  makeTemplate({
    name: 'wiki-knowledge-synthesis',
    category: 'wiki-knowledge-synthesis',
    workflowFamily: 'wiki-knowledge-synthesis',
    description: 'Search workspace notes, read source knowledge documents, and synthesize an owner-scoped wiki page.',
    preconditions: 'wiki-vault-revision-and-owner-scope',
    preconditionPlan: {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'wiki-vault-revision-and-owner-scope',
      workflowFamily: 'wiki-knowledge-synthesis',
      checks: [
        { id: 'source-note-regular', kind: 'path-regular-file', inputName: 'source_path', path: 'source-note.md' },
        { id: 'read-tool-ready', kind: 'tool-available', toolName: 'read' },
        { id: 'write-tool-ready', kind: 'tool-available', toolName: 'write' },
        { id: 'family-match', kind: 'workflow-family', workflowFamily: 'wiki-knowledge-synthesis' },
      ],
    },
    compensation: 'rollback-state',
    compensationPlan: {
      protocol: 'assistant-skills/compensation-plan/v1',
      kind: 'rollback-state',
      entries: [
        { stepId: 'write-wiki-synthesis', capturePreimage: true },
      ],
    },
    allowedTools: ['grep', 'read', 'write'],
    domainTools: ['wiki_search', 'wiki_read', 'wiki_lint', 'wiki_upsert'],
    inputs: [
      { name: 'source_path', stepId: 'read-source-note', path: '/file_path', type: 'string', default: 'source-note.md' },
      { name: 'wiki_page_path', stepId: 'write-wiki-synthesis', path: '/file_path', type: 'string', default: 'wiki-synthesis.md' },
    ],
    steps: [
      { id: 'find-notes', toolName: 'grep', arguments: { pattern: 'Summary' }, dependsOn: [] },
      { id: 'read-source-note', toolName: 'read', arguments: { file_path: 'source-note.md' }, dependsOn: ['find-notes'] },
      { id: 'write-wiki-synthesis', toolName: 'write', arguments: { file_path: 'wiki-synthesis.md', content: '# Knowledge Synthesis\nUpdated.\n' }, dependsOn: ['read-source-note'] },
    ],
    reason: 'Canonical WP13 wiki knowledge synthesis workflow bound to vault revision and owner scope.',
  }),
  makeTemplate({
    name: 'dependency-config-audit',
    category: 'dependency-config-audit',
    workflowFamily: 'dependency-config-audit',
    description: 'Discover workspace manifests, inspect dependency config, patch configuration settings, and write an audit report.',
    preconditions: 'workspace-manifest-and-isolation-grant',
    preconditionPlan: {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      checks: [
        { id: 'manifest-regular', kind: 'path-regular-file', inputName: 'manifest_path', path: 'package.json' },
        { id: 'config-regular', kind: 'path-regular-file', inputName: 'config_path', path: 'audit-config.json' },
        { id: 'edit-tool-ready', kind: 'tool-available', toolName: 'edit' },
        { id: 'write-tool-ready', kind: 'tool-available', toolName: 'write' },
        { id: 'family-match', kind: 'workflow-family', workflowFamily: 'dependency-config-audit' },
      ],
    },
    compensation: 'rollback-state',
    compensationPlan: {
      protocol: 'assistant-skills/compensation-plan/v1',
      kind: 'rollback-state',
      entries: [
        { stepId: 'patch-config', capturePreimage: true },
        { stepId: 'write-audit-report', capturePreimage: true },
      ],
    },
    allowedTools: ['glob', 'read', 'edit', 'write', 'apply_patch'],
    domainTools: ['isolation_grants', 'isolation_run'],
    inputs: [
      { name: 'manifest_path', stepId: 'read-manifest', path: '/file_path', type: 'string', default: 'package.json' },
      { name: 'config_path', stepId: 'patch-config', path: '/file_path', type: 'string', default: 'audit-config.json' },
      { name: 'report_path', stepId: 'write-audit-report', path: '/file_path', type: 'string', default: 'audit-report.md' },
    ],
    steps: [
      { id: 'discover-manifests', toolName: 'glob', arguments: { pattern: '**/package.json' }, dependsOn: [] },
      { id: 'read-manifest', toolName: 'read', arguments: { file_path: 'package.json' }, dependsOn: ['discover-manifests'] },
      { id: 'patch-config', toolName: 'edit', arguments: { file_path: 'audit-config.json', old_string: '"audit": false', new_string: '"audit": true', replace_all: false }, dependsOn: ['read-manifest'] },
      { id: 'write-audit-report', toolName: 'write', arguments: { file_path: 'audit-report.md', content: '# Dependency Audit\nStatus: verified\n' }, dependsOn: ['patch-config'] },
    ],
    reason: 'Canonical WP13 dependency and config audit workflow guarded by manifest and isolation-grant preconditions.',
  }),
])

export function listWorkflowSkillTemplates(): readonly WorkflowSkillTemplate[] {
  return WORKFLOW_TEMPLATES
}

export function getWorkflowSkillTemplate(name: string): WorkflowSkillTemplate | undefined {
  return WORKFLOW_TEMPLATES.find(
    template => template.name === name || template.category === name || template.workflowFamily === name,
  )
}

export function classifyWorkflowFamily(
  steps: readonly Pick<SkillStep, 'toolName' | 'arguments'>[],
  options?: { readonly workflowFamily?: WorkflowFamilyId; readonly description?: string; readonly preconditions?: SkillPreconditionKind },
): WorkflowClassificationResult {
  const matchedTools = [...new Set(steps.map(step => step.toolName))]
  if (options?.workflowFamily !== undefined) {
    if (!familySet.has(options.workflowFamily)) {
      throw new Error(`assistant-skills: unsupported workflow family ${String(options.workflowFamily)}`)
    }
    const meta = WORKFLOW_FAMILIES[options.workflowFamily]
    return Object.freeze({
      family: meta.id,
      confidence: 'explicit',
      matchedTools: Object.freeze(matchedTools),
      recommendedPreconditions: meta.defaultPreconditions,
      recommendedCompensation: meta.defaultCompensation,
    })
  }

  const preconditionMatches = (Object.values(WORKFLOW_FAMILIES) as WorkflowFamilyMetadata[]).find(
    meta => options?.preconditions !== undefined && meta.defaultPreconditions === options.preconditions,
  )
  if (preconditionMatches !== undefined) {
    return Object.freeze({
      family: preconditionMatches.id,
      confidence: 'explicit',
      matchedTools: Object.freeze(matchedTools),
      recommendedPreconditions: preconditionMatches.defaultPreconditions,
      recommendedCompensation: preconditionMatches.defaultCompensation,
    })
  }

  const serialized = JSON.stringify({ steps, description: options?.description ?? '' }).toLowerCase()
  const scores: Record<WorkflowFamilyId, number> = {
    'repo-ci-fix': 0,
    'calendar-meeting-prep': 0,
    'email-inbox-triage': 0,
    'wiki-knowledge-synthesis': 0,
    'dependency-config-audit': 0,
  }

  for (const step of steps) {
    if (step.toolName === 'action_github_inspect' || step.toolName === 'action_github_branch' || step.toolName === 'action_github_commit') scores['repo-ci-fix'] += 5
    if (step.toolName === 'action_calendar_action' || step.toolName.startsWith('work_item_')) scores['calendar-meeting-prep'] += 5
    if (step.toolName === 'action_lark_action' || step.toolName === 'action_http_request') scores['email-inbox-triage'] += 4
    if (step.toolName.startsWith('wiki_') || step.toolName === 'memory_search' || step.toolName === 'memory_read_evidence') scores['wiki-knowledge-synthesis'] += 5
    if (step.toolName === 'isolation_run' || step.toolName === 'isolation_grants') scores['dependency-config-audit'] += 4
    if (step.toolName === 'apply_patch' || step.toolName === 'edit') {
      scores['repo-ci-fix'] += 2
      scores['dependency-config-audit'] += 1
    }
    if (step.toolName === 'grep') scores['wiki-knowledge-synthesis'] += 2
    if (step.toolName === 'glob') {
      scores['repo-ci-fix'] += 1
      scores['dependency-config-audit'] += 1
    }
  }

  if (/\b(ci|git|repo|build|test|lint)\b/u.test(serialized)) scores['repo-ci-fix'] += 2
  if (/\b(calendar|meeting|agenda|schedule|brief)\b/u.test(serialized)) scores['calendar-meeting-prep'] += 3
  if (/\b(email|inbox|triage|unarchive|digest|lark)\b/u.test(serialized)) scores['email-inbox-triage'] += 3
  if (/\b(wiki|vault|knowledge|synthesis|notes?)\b/u.test(serialized)) scores['wiki-knowledge-synthesis'] += 3
  if (/\b(package\.json|manifest|dependency|dependencies|config|audit|lockfile)\b/u.test(serialized)) scores['dependency-config-audit'] += 4

  let bestFamily: WorkflowFamilyId = 'repo-ci-fix'
  let bestScore = -1
  for (const id of WORKFLOW_FAMILY_IDS) {
    if (scores[id] > bestScore) {
      bestScore = scores[id]
      bestFamily = id
    }
  }

  const meta = WORKFLOW_FAMILIES[bestFamily]
  return Object.freeze({
    family: meta.id,
    confidence: bestScore > 0 ? 'tool-signature' : 'fallback',
    matchedTools: Object.freeze(matchedTools),
    recommendedPreconditions: meta.defaultPreconditions,
    recommendedCompensation: meta.defaultCompensation,
  })
}

export function buildWorkflowSourceForTemplate(
  templateName: WorkflowFamilyId | string,
  scope: GoalScope,
  overrides?: {
    readonly goalId?: string
    readonly sessionId?: string
    readonly nativeGoalId?: string
    readonly runId?: string
    readonly objective?: string
    readonly steps?: VerifiedWorkflowSource['steps']
    readonly verifiedAt?: number
    readonly validUntil?: number
  },
): VerifiedWorkflowSource {
  const template = getWorkflowSkillTemplate(templateName)
  if (!template) throw new Error(`assistant-skills: unknown workflow template ${templateName}`)
  const objective = overrides?.objective ?? template.description
  const now = overrides?.verifiedAt ?? 1
  return {
    protocol: 'assistant-goals/verified-workflow-source/v1',
    scope,
    goal: {
      id: overrides?.goalId ?? `goal-${template.name}`,
      definition: {
        version: 1,
        digest: acceptanceDigest({ objective }),
        objective,
      },
      sessionId: overrides?.sessionId ?? `session-${template.name}`,
      nativeGoalId: overrides?.nativeGoalId ?? `native-${template.name}`,
    },
    runId: overrides?.runId ?? `run-${template.name}`,
    turn: 1,
    acceptance: {
      contractId: `contract-${template.name}`,
      contractDigest: acceptanceDigest({ contract: template.name, objective }),
      receiptDigest: acceptanceDigest({ receipt: template.name, objective }),
      verifiedAt: now,
      validUntil: overrides?.validUntil ?? now + 60_000,
    },
    steps: overrides?.steps
      ? overrides.steps.map(step => ({ id: step.id, toolName: step.toolName, arguments: step.arguments }))
      : template.steps.map(step => ({ id: step.id, toolName: step.toolName, arguments: step.arguments })),
  }
}

export function buildWorkflowSkillDefinition(
  templateName: WorkflowFamilyId | string,
  source: VerifiedWorkflowSource,
  overrides?: BuildWorkflowSkillOptions,
): Readonly<SkillDefinition> {
  const template = getWorkflowSkillTemplate(templateName)
  if (!template) throw new Error(`assistant-skills: unknown workflow template ${templateName}`)

  const sourceStepIds = new Set(source.steps.map(step => step.id))
  const defaultBindings: SkillBinding[] = template.inputs
    .filter(input => sourceStepIds.has(input.stepId))
    .map(input => ({ name: input.name, stepId: input.stepId, path: input.path }))

  const preconditions = overrides?.preconditions ?? template.preconditions
  const compensation = overrides?.compensation ?? template.compensation
  const compensationPlan = overrides?.compensationPlan
    ?? (compensation === 'stop-and-report'
      ? undefined
      : template.compensationPlan.kind === compensation
        ? {
            kind: template.compensationPlan.kind,
            entries: template.compensationPlan.entries.filter(entry => sourceStepIds.has(entry.stepId)),
          }
        : undefined)

  const preconditionPlan = overrides?.preconditionPlan
    ?? (preconditions === template.preconditionPlan.kind
      ? {
          kind: template.preconditionPlan.kind,
          workflowFamily: template.workflowFamily,
          checks: template.preconditionPlan.checks,
        }
      : undefined)

  const allowedTools = overrides?.allowedTools
    ?? [...new Set([...template.allowedTools, ...source.steps.map(step => step.toolName)])]

  const options: CreateDefinitionOptions = {
    name: overrides?.name ?? template.name,
    description: overrides?.description ?? template.description,
    bindings: overrides?.bindings ?? defaultBindings,
    preconditions,
    ...(preconditionPlan === undefined ? {} : { preconditionPlan }),
    workflowFamily: template.workflowFamily,
    compensation,
    ...(compensationPlan === undefined || (compensation !== 'compensating-action' && compensationPlan.entries.length === 0)
      ? {}
      : { compensationPlan }),
  }

  const definition = createDefinition(source, options, allowedTools)
  assertDefinitionProtocol(definition)
  return definition
}
