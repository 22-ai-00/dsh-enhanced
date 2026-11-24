import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { FsError } from '@deepseek-ai/dsh-fs'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import WorkingDirectoryService from '@deepseek-ai/dsh-working-directory'
import { AssistantCompensationService } from '@dsh-enhanced/assistant-recovery'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { execFile } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SUPPORTED_SKILL_PRECONDITIONS,
  WORKFLOW_FAMILIES,
  WORKFLOW_FAMILY_IDS,
  assertDefinitionProtocol,
  buildWorkflowSkillDefinition,
  buildWorkflowSourceForTemplate,
  classifyWorkflowFamily,
  createDefinition,
  evaluatePreconditionPlan,
  evaluatePreconditions,
  getWorkflowSkillTemplate,
  instantiate,
  listWorkflowSkillTemplates,
  preconditionDirective,
  projectWorkflowLineage,
  validateStepGraph,
  type SkillPreconditionKind,
  type SkillPreconditionPlan,
} from '../src/index.ts'
import { capturePreimageForStep, isNonMutatingStep, NON_MUTATING_OBSERVATION_TOOLS } from '../src/compensation.ts'
import { HoldoutAuthority, type HoldoutDataset } from '../src/holdout-authority.ts'
import { qualifyHoldout, verifyHoldoutReceipt } from '../src/holdout-qualification.ts'
import { extractPatchAffectedPaths, parsePatchOperationPaths, rewritePatchHeaderPaths } from '../src/patch-paths.ts'
import { replaySkill, validateReplayTrace } from '../src/replay.ts'
import { AssistantSkillsService } from '../src/service.ts'
import { nativeExecution } from './helpers/native-holdout-fixture.ts'

const execFileAsync = promisify(execFile)
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn()
  }
})

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function makeAgent(ctx: Context, workspace: string, id = 'owner-agent'): Agent {
  const sid = SessionId(id)
  const session = Session.create(sid, [], {
    version: SESSION_FORMAT_VERSION,
    id: sid,
    createdAt: 1,
    isSeeded: false,
    cwd: workspace,
    agentPreset: 'primary',
  })
  const agent: Agent = {
    id: sid,
    options: { provider: 'fixture', model: 'fixture' },
    model: { current: () => ({ provider: 'fixture', model: 'fixture' }), select: () => {} },
    session,
    inbox: createInboxStub(),
    ctx: undefined as unknown as Context,
    status: 'idle',
    cancel() {},
    whenIdle: async () => {},
    runMaintenance: task => task(new AbortController().signal),
    send() {},
    followup() {},
    steer() {},
    inject() {},
  }
  ;(agent as unknown as { ctx: Context }).ctx = createScope(ctx, agent).ctx
  session.append('turn/start', { turn: 1 })
  return agent
}

async function setupServiceFixture(options: {
  allowedTools?: string[]
  withRecovery?: boolean
  failStepName?: string
  failPredicate?: (args: Record<string, unknown>) => boolean
  applyPatchImpl?: (workspace: string, input: string) => Promise<void>
} = {}) {
  const root = await makeTempDir('skills-wp13-svc-')
  const stateDir = await makeTempDir('skills-wp13-db-')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.restart())

  const owner = makeAgent(ctx, root, 'owner-session')
  const scope = {
    principalId: 'owner',
    principalRecordId: 'owner-record',
    principalVersion: 1,
    workspace: root,
    preset: 'primary',
  }
  const principal = (agent: Agent) => ({
    principalId: agent === owner ? 'owner' : 'foreign',
    principalLineage: {
      principalRecordId: agent === owner ? 'owner-record' : 'foreign-record',
      principalVersion: 1,
    },
    scope: { workspace: root, preset: 'primary' },
  })
  ctx.provide('agents' as never, { get: (id: string) => (id === owner.id ? owner : undefined), list: () => [owner] } as never)
  ctx.provide('assistantDelivery' as never, {
    preferencePrincipalForAgent: principal,
    currentPreferenceTurn: principal,
    validateOwnerRoute: (input: { authorityId: string; principalId: string; workspace: string; agentPreset: string }) =>
      input.authorityId === 'owner-route' && input.principalId === 'owner' && input.workspace === root && input.agentPreset === 'primary'
        ? {
            authorityId: input.authorityId,
            principalId: 'owner',
            principalRecordId: 'owner-record',
            principalVersion: 1,
            workspace: root,
            agentPreset: 'primary',
            bindingVersion: 1,
            generation: 1,
          }
        : undefined,
  } as never)
  let policyAllowed = true
  ctx.provide('assistantPolicy' as never, {
    evaluate: () => ({ effect: policyAllowed ? 'allow' : 'deny' }),
    authorize: () => ({ effect: policyAllowed ? 'allow' : 'deny' }),
    evaluateAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }),
    authorizeAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }),
  } as never)
  ctx.provide('assistantVerifier' as never, {} as never)

  let currentSource = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
    goalId: 'source-goal',
    sessionId: String(owner.session.id),
    nativeGoalId: 'native-source-goal',
  })
  ctx.provide('assistantGoals' as never, {
    inspectVerifiedWorkflowSource: () => currentSource,
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({
      scope,
      goalId,
      sessionId: String(owner.session.id),
      goalExecutionRunId: `goal-exec-${goalId}`,
      nativeGoalId: `native-${goalId}`,
      definition: { version: 1, digest: 'd'.repeat(64) },
    }),
  } as never)

  await new Promise<void>(resolve => setImmediate(resolve))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(SkillRegistry)

  let compensationService: AssistantCompensationService | undefined
  if (options.withRecovery) {
    await ctx.plugin(AssistantCompensationService, {
      databasePath: join(root, 'recovery-comp.sqlite'),
    })
    compensationService = ctx.get('assistantCompensation' as never) as unknown as AssistantCompensationService
  }

  ctx.tools.register(defineTool({
    name: 'read',
    description: 'Fixture reader',
    parameters: { file_path: { type: 'string', required: true }, limit: { type: 'integer' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => {
      if (options.failStepName === 'read' && (!options.failPredicate || options.failPredicate(args))) {
        throw new Error('simulated read failure')
      }
      const target = join(root, String(args.file_path))
      try {
        return await readFile(target, 'utf8')
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          throw new FsError('not found', 'FS_NOT_FOUND')
        }
        throw error
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Fixture writer',
    parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => {
      if (options.failStepName === 'write' && (!options.failPredicate || options.failPredicate(args))) {
        throw new Error('simulated write failure')
      }
      const target = join(root, String(args.file_path))
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, String(args.content), 'utf8')
      return JSON.stringify({ path: target })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Fixture editor',
    parameters: {
      file_path: { type: 'string', required: true },
      old_string: { type: 'string', required: true },
      new_string: { type: 'string', required: true },
      replace_all: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => {
      if (options.failStepName === 'edit' && (!options.failPredicate || options.failPredicate(args))) {
        throw new Error('simulated edit failure')
      }
      const target = join(root, String(args.file_path))
      const text = await readFile(target, 'utf8')
      if (!text.includes(String(args.old_string))) {
        throw new Error('old_string not found')
      }
      await writeFile(target, text.replace(String(args.old_string), String(args.new_string)), 'utf8')
      return 'edited'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'apply_patch',
    description: 'Fixture apply_patch',
    parameters: { input: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => {
      if (options.failStepName === 'apply_patch' && (!options.failPredicate || options.failPredicate(args))) {
        throw new Error('simulated apply_patch failure')
      }
      if (options.applyPatchImpl) {
        await options.applyPatchImpl(root, String(args.input))
      }
      return 'patched'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'wiki_search',
    description: 'Fixture wiki search',
    parameters: { query: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => JSON.stringify({ matches: [args.query] }),
  }))

  ctx.tools.register(defineTool({
    name: 'action_lark_action',
    description: 'Fixture lark action',
    parameters: { action: { type: 'string', required: true }, message_id: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => {
      if (options.failStepName === 'action_lark_action' && (!options.failPredicate || options.failPredicate(args))) {
        throw new Error('simulated lark failure')
      }
      return JSON.stringify({ ok: true, action: args.action, messageId: args.message_id })
    },
  }))

  const dbPath = join(stateDir, 'skills.sqlite')
  await ctx.plugin(AssistantSkillsService, {
    databasePath: dbPath,
    allowedTools: options.allowedTools ?? ['read', 'write', 'edit', 'apply_patch', 'wiki_search', 'action_lark_action'],
  })
  const service = ctx.get('assistantSkills')!

  const execute = async (name: string, args: Record<string, unknown>) => {
    const batch = await owner.ctx.get('tools')!.execute({
      calls: [{ type: 'tool-call', id: ToolCallId(`call-${Math.random()}`), name, arguments: JSON.stringify(args) }],
      signal: new AbortController().signal,
      agent: owner,
    })
    return batch.results[0]!.result
  }

  return {
    root,
    dbPath,
    ctx,
    owner,
    scope,
    service,
    compensationService,
    setSource: (src: typeof currentSource) => {
      currentSource = src
    },
    setPolicyAllowed: (allowed: boolean) => {
      policyAllowed = allowed
    },
    execute,
  }
}

describe('WP13 / F18 real workflow skill coverage', () => {
  it('preserves the legacy order-summary 9-key default SkillDefinition and SHA-256 digest', () => {
    const objective = 'Implement summarize.mjs: normalize orders.'
    const orderSummary = {
      ...buildWorkflowSourceForTemplate('repo-ci-fix', {
        principalId: 'owner',
        principalRecordId: 'record',
        principalVersion: 1,
        workspace: '/tmp/workspace',
        preset: 'primary',
      }, {
        goalId: 'goal',
        sessionId: 'session',
        nativeGoalId: 'native',
        runId: 'run',
        objective,
        verifiedAt: 1,
        validUntil: 2,
        steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'summarize.mjs', content: 'export default true\n' } }],
      }),
      acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 },
      goal: {
        id: 'goal',
        definition: { version: 1, digest: acceptanceDigest({ objective }), objective },
        sessionId: 'session',
        nativeGoalId: 'native',
      },
    }
    const definition = createDefinition(orderSummary, { name: 'order-summary', description: 'Write an order summary program.' }, ['write'])
    expect(Object.keys(definition)).toEqual(['protocol', 'name', 'description', 'source', 'inputs', 'steps', 'fileObservations', 'preconditions', 'compensation'])
    expect(acceptanceDigest(definition)).toBe('6e3b69ed060b9952cd0c21c58effb90e98854a44c845e73f985e5ca86e98d4e4')
  })

  it('enforces all 6 SkillPreconditionKind families fail-closed and exposes preconditionDirective', () => {
    expect(SUPPORTED_SKILL_PRECONDITIONS).toEqual([
      'current-owner-policy-and-fresh-goal',
      'clean-git-worktree-and-policy-grant',
      'calendar-window-and-route-binding',
      'authenticated-inbox-and-idempotency-key',
      'wiki-vault-revision-and-owner-scope',
      'workspace-manifest-and-isolation-grant',
    ])

    const base = {
      ownerScopeDigest: 'scope-1',
      currentScopeDigest: 'scope-1',
      goalId: 'goal-new',
      sourceGoalId: 'goal-src',
    }

    const validDecisions: Record<SkillPreconditionKind, Parameters<typeof evaluatePreconditions>[1]> = {
      'current-owner-policy-and-fresh-goal': base,
      'clean-git-worktree-and-policy-grant': { ...base, cleanGitWorktree: true, policyGrantValid: true },
      'calendar-window-and-route-binding': { ...base, calendarWindowValid: true, ownerRouteBound: true },
      'authenticated-inbox-and-idempotency-key': { ...base, authenticatedSource: true, idempotencyKeyPresent: true },
      'wiki-vault-revision-and-owner-scope': { ...base, vaultRevisionCurrent: true },
      'workspace-manifest-and-isolation-grant': { ...base, workspaceCleanOrScoped: true, isolationGrantValid: true },
    }

    for (const kind of SUPPORTED_SKILL_PRECONDITIONS) {
      expect(() => evaluatePreconditions(kind, validDecisions[kind])).not.toThrow()
      expect(preconditionDirective(kind).kind).toBe(kind)
      if (kind !== 'current-owner-policy-and-fresh-goal') {
        expect(() => evaluatePreconditions(kind, base)).toThrow()
      }
    }

    expect(() => evaluatePreconditions('clean-git-worktree-and-policy-grant', { ...base, cleanGitWorktree: false, policyGrantValid: true })).toThrow(/git worktree/i)
    expect(() => evaluatePreconditions('clean-git-worktree-and-policy-grant', { ...base, cleanGitWorktree: true, policyGrantValid: false })).toThrow(/policy grant/i)
    expect(() => evaluatePreconditions('calendar-window-and-route-binding', { ...base, calendarWindowValid: false, ownerRouteBound: true })).toThrow(/calendar window/i)
    expect(() => evaluatePreconditions('calendar-window-and-route-binding', { ...base, calendarWindowValid: true, ownerRouteBound: false })).toThrow(/route binding/i)
    expect(() => evaluatePreconditions('authenticated-inbox-and-idempotency-key', { ...base, authenticatedSource: false, idempotencyKeyPresent: true })).toThrow(/authenticated inbox/i)
    expect(() => evaluatePreconditions('authenticated-inbox-and-idempotency-key', { ...base, authenticatedSource: true, idempotencyKeyPresent: false })).toThrow(/idempotency key/i)
    expect(() => evaluatePreconditions('wiki-vault-revision-and-owner-scope', { ...base, vaultRevisionCurrent: false })).toThrow(/vault revision/i)
    expect(() => evaluatePreconditions('workspace-manifest-and-isolation-grant', { ...base, workspaceCleanOrScoped: false, isolationGrantValid: true })).toThrow(/workspace manifest/i)
    expect(() => evaluatePreconditions('workspace-manifest-and-isolation-grant', { ...base, workspaceCleanOrScoped: true, isolationGrantValid: false })).toThrow(/isolation grant/i)
    expect(() => evaluatePreconditions('unknown-kind' as SkillPreconditionKind, base)).toThrow(/unsupported skill preconditions/i)
    expect(() => preconditionDirective('unknown-kind' as SkillPreconditionKind)).toThrow(/unsupported skill preconditions/i)
  })

  it('validates and enforces all SkillPreconditionPlan check kinds fail-closed', () => {
    const plan: SkillPreconditionPlan = {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      checks: [
        { id: 'c-exists', kind: 'path-exists', path: 'package.json' },
        { id: 'c-absent', kind: 'path-absent', path: 'lock.tmp' },
        { id: 'c-file', kind: 'path-regular-file', inputName: 'manifest_path', path: 'package.json' },
        { id: 'c-tool', kind: 'tool-available', toolName: 'edit' },
        { id: 'c-input', kind: 'input-nonempty', inputName: 'manifest_path' },
        { id: 'c-window', kind: 'time-window', notBefore: 1000, notAfter: 2000 },
        { id: 'c-family', kind: 'workflow-family', workflowFamily: 'dependency-config-audit' },
      ],
    }

    const okProbe = (p: string) => ({
      contained: !p.includes('..'),
      isSymlink: false,
      exists: p !== 'lock.tmp',
      isRegularFile: p !== 'lock.tmp',
    })

    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: 'package.json' },
      now: 1500,
      pathProbe: okProbe,
    })).not.toThrow()

    // Symlink rejected
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: 'package.json' },
      now: 1500,
      pathProbe: p => ({ ...okProbe(p), isSymlink: p === 'package.json' }),
    })).toThrow(/unsafe/i)

    // External path rejected
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: '../secret.json' },
      now: 1500,
      pathProbe: okProbe,
    })).toThrow(/unsafe/i)

    // Missing pathProbe fails closed
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: 'package.json' },
      now: 1500,
    })).toThrow(/probe unavailable/i)

    // Out-of-window fails closed
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: 'package.json' },
      now: 5000,
      pathProbe: okProbe,
    })).toThrow(/time window/i)

    // Missing tool fails closed
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'write'],
      inputs: { manifest_path: 'package.json' },
      now: 1500,
      pathProbe: okProbe,
    })).toThrow(/unavailable/i)

    // Empty input fails closed on inputName path check AND input-nonempty check
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: '   ' },
      now: 1500,
      pathProbe: okProbe,
    })).toThrow(/invalid path/i)
    expect(() => evaluatePreconditionPlan({
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'workspace-manifest-and-isolation-grant',
      checks: [{ id: 'c-input-only', kind: 'input-nonempty', inputName: 'manifest_path' }],
    }, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      inputs: { manifest_path: '   ' },
    })).toThrow(/empty/i)

    // Wrong workflow family fails closed
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'repo-ci-fix',
      allowedTools: ['read', 'edit', 'write'],
      inputs: { manifest_path: 'package.json' },
      now: 1500,
      pathProbe: okProbe,
    })).toThrow(/mismatch/i)
  })

  it('rejects unmet preconditions in live AssistantSkillsService.#run before claiming an invocation key', async () => {
    const fx = await setupServiceFixture({ allowedTools: ['glob', 'read', 'edit', 'write'] })
    await writeFile(join(fx.root, 'ci-report.txt'), 'FAIL\n', 'utf8')
    await mkdir(join(fx.root, 'src'), { recursive: true })
    await writeFile(join(fx.root, 'src/fix.txt'), 'status=FAIL\n', 'utf8')

    // Save a repo-ci-fix workflow requiring clean-git-worktree-and-policy-grant
    const tpl = getWorkflowSkillTemplate('repo-ci-fix')!
    const source = buildWorkflowSourceForTemplate('repo-ci-fix', fx.scope, {
      goalId: 'source-goal',
      sessionId: String(fx.owner.session.id),
      nativeGoalId: 'native-source-goal',
      steps: [
        { id: 'read-ci-report', toolName: 'read', arguments: { file_path: 'ci-report.txt' } },
        { id: 'apply-fix', toolName: 'edit', arguments: { file_path: 'src/fix.txt', old_string: 'FAIL', new_string: 'PASS', replace_all: false } },
        { id: 'write-summary', toolName: 'write', arguments: { file_path: 'ci-summary.txt', content: 'PASS\n' } },
      ],
    })
    fx.setSource(source)

    const saved = fx.service.save(fx.owner, 'source-goal', {
      name: 'repo-ci-fix',
      description: tpl.description,
      bindings: [{ name: 'report_path', stepId: 'read-ci-report', path: '/file_path' }],
      preconditions: 'clean-git-worktree-and-policy-grant',
      preconditionPlan: {
        kind: 'clean-git-worktree-and-policy-grant',
        workflowFamily: 'repo-ci-fix',
        checks: [{ id: 'report-file', kind: 'path-regular-file', inputName: 'report_path', path: 'ci-report.txt' }],
      },
      workflowFamily: 'repo-ci-fix',
      compensation: 'rollback-state',
    })
    expect(saved.version).toBe(1)

    // 1) Workspace is NOT a git repo yet -> #run rejects before claim()!
    const notGitRes = await fx.execute('skill_run', {
      goal_id: 'fresh-goal-1',
      name: 'repo-ci-fix',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-precondition-1',
    })
    expect(notGitRes.isError).toBe(true)
    const db1 = new DatabaseSync(fx.dbPath)
    try {
      expect((db1.prepare('SELECT count(*) AS c FROM skill_runs').get() as { c: number }).c).toBe(0)
    } finally {
      db1.close()
    }

    // 2) Initialize git repo and commit files -> clean worktree!
    await execFileAsync('git', ['init'], { cwd: fx.root })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: fx.root })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: fx.root })
    await execFileAsync('git', ['add', 'ci-report.txt', 'src/fix.txt'], { cwd: fx.root })
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: fx.root })

    // Dirty worktree (untracked file) -> still rejects before claim()!
    await writeFile(join(fx.root, 'dirty.txt'), 'dirty', 'utf8')
    const dirtyRes = await fx.execute('skill_run', {
      goal_id: 'fresh-goal-2',
      name: 'repo-ci-fix',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-precondition-1',
    })
    expect(dirtyRes.isError).toBe(true)
    await rm(join(fx.root, 'dirty.txt'))

    // Clean worktree + symlink check -> symlink rejected before claim()!
    await symlink(join(fx.root, 'ci-report.txt'), join(fx.root, 'ci-symlink.txt'))
    const symlinkRes = await fx.execute('skill_run', {
      goal_id: 'fresh-goal-3',
      name: 'repo-ci-fix',
      version: 1,
      inputs_json: JSON.stringify({ report_path: 'ci-symlink.txt' }),
      invocation_id: 'inv-precondition-1',
    })
    expect(symlinkRes.isError).toBe(true)
    await rm(join(fx.root, 'ci-symlink.txt'))

    const db2 = new DatabaseSync(fx.dbPath)
    try {
      expect((db2.prepare('SELECT count(*) AS c FROM skill_runs').get() as { c: number }).c).toBe(0)
    } finally {
      db2.close()
    }

    // Clean worktree + same invocation_id 'inv-precondition-1' was NOT burned and succeeds now!
    const okRes = await fx.execute('skill_run', {
      goal_id: 'fresh-goal-4',
      name: 'repo-ci-fix',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-precondition-1',
    })
    expect(okRes.isError ? okRes.error : undefined).toBeUndefined()
    expect(okRes.isError).toBe(false)
    expect(await readFile(join(fx.root, 'src/fix.txt'), 'utf8')).toBe('status=PASS\n')
  })

  it('covers all 5 workflow families, classification, lineage projections, and replay across all 5 families', async () => {
    const templates = listWorkflowSkillTemplates()
    expect(templates.length).toBe(5)
    expect(templates.map(t => t.name)).toEqual([...WORKFLOW_FAMILY_IDS])
    expect(Object.keys(WORKFLOW_FAMILIES)).toEqual([...WORKFLOW_FAMILY_IDS])

    const scope = {
      principalId: 'owner',
      principalRecordId: 'record',
      principalVersion: 1,
      workspace: '/source-workspace',
      preset: 'primary',
    }
    const stateRoot = await makeTempDir('skills-wp13-replay-')
    await chmod(stateRoot, 0o700)

    const artifactsByFamily: Record<string, { files: { path: string; content: string }[]; artifactPath: string; expected: string }> = {
      'repo-ci-fix': {
        files: [
          { path: 'ci-report.txt', content: 'test failed\n' },
          { path: 'src/fix.txt', content: 'FAIL\n' },
        ],
        artifactPath: 'ci-summary.txt',
        expected: 'CI status: PASS\n',
      },
      'calendar-meeting-prep': {
        files: [
          { path: 'calendar-window.json', content: '{"events":[]}\n' },
          { path: 'meeting-agenda.md', content: '# Agenda\n' },
        ],
        artifactPath: 'meeting-brief.md',
        expected: '# Meeting Brief\nPrepared.\n',
      },
      'email-inbox-triage': {
        files: [
          { path: 'inbox-batch.json', content: '[{"id":"m1"}]\n' },
        ],
        artifactPath: 'inbox-digest.md',
        expected: '# Inbox Digest\nTriaged.\n',
      },
      'wiki-knowledge-synthesis': {
        files: [
          { path: 'source-note.md', content: 'Summary: notes\n' },
        ],
        artifactPath: 'wiki-synthesis.md',
        expected: '# Knowledge Synthesis\nUpdated.\n',
      },
      'dependency-config-audit': {
        files: [
          { path: 'package.json', content: '{"name":"demo"}\n' },
          { path: 'audit-config.json', content: '{"audit": false}\n' },
        ],
        artifactPath: 'audit-report.md',
        expected: '# Dependency Audit\nStatus: verified\n',
      },
    }

    for (const template of templates) {
      expect(getWorkflowSkillTemplate(template.name)).toBe(template)
      expect(template.compensation).not.toBe('compensating-action')
      validateStepGraph(template.steps)
      // T3-GR-01 / T3-GR-02 compatibility: passes both with and without compensationPlan
      expect(() => assertDefinitionProtocol({
        preconditions: template.preconditions,
        compensation: template.compensation,
        steps: template.steps,
      })).not.toThrow()
      expect(() => assertDefinitionProtocol(template)).not.toThrow()

      const source = buildWorkflowSourceForTemplate(template.name, scope)
      const def = buildWorkflowSkillDefinition(template.name, source)
      expect(def.workflowFamily).toBe(template.workflowFamily)
      expect(def.preconditions).toBe(template.preconditions)
      expect(def.compensation).toBe(template.compensation)

      const materialized = instantiate(def)
      expect(materialized.workflowFamily).toBe(template.workflowFamily)

      const classified = classifyWorkflowFamily(template.steps, { description: template.description })
      expect(classified.family).toBe(template.workflowFamily)

      const lineage = projectWorkflowLineage({
        skillName: template.name,
        steps: template.steps,
        compensation: template.compensation,
        parentVersion: 1,
        parentDigest: 'a'.repeat(64),
        parentTools: ['read'],
        reason: 'unit check',
      })
      expect(lineage.permissionDelta.expandsAuthority).toBe(true)
      expect(lineage.rollbackTarget.kind).toBe(template.compensation)

      const caseData = artifactsByFamily[template.name]!
      const replay = await replaySkill({
        definition: def,
        inputs: {},
        files: caseData.files,
        artifactPath: caseData.artifactPath,
        stateRoot,
        maxToolCalls: 32,
        maxBytes: 100_000,
        signal: new AbortController().signal,
        authorize: () => {},
      })
      expect(replay.artifact).toBe(caseData.expected)
      expect(replay.quiescent).toBe(true)
    }

    // Also verify classifier matches domain tools accurately
    expect(classifyWorkflowFamily([{ toolName: 'wiki_search', arguments: { query: 'x' } }, { toolName: 'wiki_upsert', arguments: {} }]).family).toBe('wiki-knowledge-synthesis')
    expect(classifyWorkflowFamily([{ toolName: 'action_calendar_action', arguments: { action: 'calendar.list-events' } }]).family).toBe('calendar-meeting-prep')
    expect(classifyWorkflowFamily([{ toolName: 'action_lark_action', arguments: { action: 'lark.send-message' } }]).family).toBe('email-inbox-triage')
    expect(classifyWorkflowFamily([{ toolName: 'isolation_run', arguments: { command: 'npm audit' } }]).family).toBe('dependency-config-audit')
    expect(classifyWorkflowFamily([{ toolName: 'action_github_inspect', arguments: {} }]).family).toBe('repo-ci-fix')
    expect(await readdir(stateRoot)).toEqual([])
  })

  it('replays contained apply_patch, bounded domainToolHandlers, and executes reverse compensation on mid-run failure', async () => {
    const stateRoot = await makeTempDir('skills-wp13-patch-replay-')
    await chmod(stateRoot, 0o700)
    const scope = {
      principalId: 'owner',
      principalRecordId: 'record',
      principalVersion: 1,
      workspace: '/source-workspace',
      preset: 'primary',
    }

    const patch = [
      '*** Begin Patch',
      '*** Update File: /source-workspace/a.txt',
      '@@',
      '-old-a',
      '+new-a',
      '*** Add File: b.txt',
      '+added-b',
      '*** End Patch',
    ].join('\n')

    const patchSource = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
      steps: [
        { id: 'patch-files', toolName: 'apply_patch', arguments: { input: patch } },
        { id: 'read-b', toolName: 'read', arguments: { file_path: 'b.txt' } },
      ],
    })
    const patchDef = buildWorkflowSkillDefinition('repo-ci-fix', patchSource, {
      allowedTools: ['apply_patch', 'read'],
      compensation: 'rollback-state',
      compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'patch-files', capturePreimage: true }] },
    })

    const patchReplay = await replaySkill({
      definition: patchDef,
      inputs: {},
      files: [{ path: 'a.txt', content: 'old-a\n' }],
      artifactPath: 'b.txt',
      stateRoot,
      maxToolCalls: 32,
      maxBytes: 100_000,
      signal: new AbortController().signal,
      authorize: () => {},
    })
    expect(patchReplay.artifact).toBe('added-b\n')
    expect(patchReplay.steps.map(s => s.toolName)).toEqual(['apply_patch', 'read'])

    // Escaping patch rejected by validateReplayTrace and replaySkill
    const escapePatch = [
      '*** Begin Patch',
      '*** Update File: ../escape.txt',
      '@@',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n')
    const escapeSource = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
      steps: [{ id: 'escape', toolName: 'apply_patch', arguments: { input: escapePatch } }],
    })
    const escapeDef = buildWorkflowSkillDefinition('repo-ci-fix', escapeSource, {
      allowedTools: ['apply_patch'],
      compensation: 'rollback-state',
      compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'escape', capturePreimage: true }] },
    })
    expect(() => validateReplayTrace(escapeDef, 32, 100_000)).toThrow(/invalid path/i)

    // Bounded domainToolHandlers + reverse compensate-via-registry on mid-run failure
    const compCalls: string[] = []
    const domainSource = buildWorkflowSourceForTemplate('email-inbox-triage', scope, {
      steps: [
        { id: 'probe-wiki', toolName: 'wiki_search', arguments: { query: 'triage' } },
        { id: 'send-lark', toolName: 'action_lark_action', arguments: { action: 'lark.send-message', message_id: 'm1' } },
        { id: 'fail-read', toolName: 'read', arguments: { file_path: 'missing-artifact.txt' } },
      ],
    })
    const domainDef = buildWorkflowSkillDefinition('email-inbox-triage', domainSource, {
      allowedTools: ['wiki_search', 'action_lark_action', 'read'],
      compensation: 'compensate-via-registry',
      compensationPlan: {
        kind: 'compensate-via-registry',
        entries: [{ stepId: 'send-lark', compensatorKey: 'email.unarchive', capturePreimage: true }],
      },
    })

    // Strict 3-arg validateReplayTrace still rejects un-opted domain tools
    expect(() => validateReplayTrace(domainDef, 32, 100_000)).toThrow(/invalid tool/i)
    // Opt-in domainTools allows it
    expect(validateReplayTrace(domainDef, 32, 100_000, {
      domainTools: { wiki_search: { mutating: false }, action_lark_action: { mutating: true } },
    })).toHaveLength(3)

    await expect(replaySkill({
      definition: domainDef,
      inputs: {},
      files: [],
      artifactPath: 'missing-artifact.txt',
      stateRoot,
      maxToolCalls: 32,
      maxBytes: 100_000,
      signal: new AbortController().signal,
      authorize: () => {},
      domainToolHandlers: {
        wiki_search: () => ({ hits: ['note-1'] }),
        action_lark_action: args => ({ sent: true, id: args.message_id }),
      },
      compensationPort: {
        async executeCompensation(record) {
          compCalls.push(`${record.kind}:${String(record.stepId)}`)
          return { status: 'succeeded', resultCode: 'reverted' }
        },
      },
    })).rejects.toThrow(/read failed/)

    expect(compCalls).toEqual(['email.unarchive:send-lark'])
    expect(await readdir(stateRoot)).toEqual([])
  })

  it('executes live multi-file apply_patch rollback-state and registry compensation with AssistantCompensationService', async () => {
    // 1) Multi-file apply_patch rollback-state
    const fxPatch = await setupServiceFixture({
      failStepName: 'edit',
      applyPatchImpl: async (workspace, _input) => {
        await writeFile(join(workspace, 'existing.txt'), 'mutated-content\n', 'utf8')
        await writeFile(join(workspace, 'created.txt'), 'brand-new\n', 'utf8')
      },
    })
    await writeFile(join(fxPatch.root, 'existing.txt'), 'original-content\n', 'utf8')
    await writeFile(join(fxPatch.root, 'trigger.txt'), 'unchanged\n', 'utf8')

    const multiPatch = [
      '*** Begin Patch',
      '*** Update File: existing.txt',
      '@@',
      '-original-content',
      '+mutated-content',
      '*** Add File: created.txt',
      '+brand-new',
      '*** End Patch',
    ].join('\n')

    const patchCaptured = await capturePreimageForStep(fxPatch.root, {
      id: 'p1',
      toolName: 'apply_patch',
      arguments: { input: multiPatch },
      dependsOn: [],
    })
    expect(patchCaptured?.files).toHaveLength(2)

    fxPatch.setSource(buildWorkflowSourceForTemplate('repo-ci-fix', fxPatch.scope, {
      goalId: 'source-goal',
      sessionId: String(fxPatch.owner.session.id),
      nativeGoalId: 'native-source-goal',
      steps: [
        { id: 'patch-step', toolName: 'apply_patch', arguments: { input: multiPatch } },
        { id: 'fail-step', toolName: 'edit', arguments: { file_path: 'trigger.txt', old_string: 'unchanged', new_string: 'changed', replace_all: false } },
      ],
    }))
    fxPatch.service.save(fxPatch.owner, 'source-goal', {
      name: 'patch-rollback-wf',
      description: 'Rollback multi-file apply_patch on failure.',
      compensation: 'rollback-state',
    })

    const runPatchFail = await fxPatch.execute('skill_run', {
      goal_id: 'run-patch-fail',
      name: 'patch-rollback-wf',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-patch-1',
    })
    expect(runPatchFail.isError).toBe(true)
    expect(await readFile(join(fxPatch.root, 'existing.txt'), 'utf8')).toBe('original-content\n')
    await expect(readFile(join(fxPatch.root, 'created.txt'), 'utf8')).rejects.toThrow()

    // 2) Live AssistantCompensationService registry compensation + NON_MUTATING_OBSERVATION_TOOLS skip
    expect(NON_MUTATING_OBSERVATION_TOOLS.has('wiki_search')).toBe(true)
    expect(isNonMutatingStep({ toolName: 'action_calendar_action', arguments: { action: 'calendar.list-events' } })).toBe(true)
    expect(isNonMutatingStep({ toolName: 'action_calendar_action', arguments: { action: 'calendar.create-event' } })).toBe(false)

    const fxReg = await setupServiceFixture({
      withRecovery: true,
      failStepName: 'write',
      failPredicate: args => args.file_path === 'inbox-digest.md',
    })
    await writeFile(join(fxReg.root, 'inbox-batch.json'), '[{"id":"m1"}]\n', 'utf8')

    const compPayloads: Array<{ kind: string; preimage?: unknown }> = []
    fxReg.compensationService!.registerCompensator({
      kind: 'email.unarchive',
      category: 'revert',
      compensate: async req => {
        compPayloads.push({ kind: req.record.kind, preimage: req.record.preimage })
        return { status: 'succeeded', resultCode: 'unarchived' }
      },
    })

    fxReg.setSource(buildWorkflowSourceForTemplate('email-inbox-triage', fxReg.scope, {
      goalId: 'source-goal',
      sessionId: String(fxReg.owner.session.id),
      nativeGoalId: 'native-source-goal',
      steps: [
        { id: 'wiki-probe', toolName: 'wiki_search', arguments: { query: 'inbox' } },
        { id: 'lark-triage', toolName: 'action_lark_action', arguments: { action: 'lark.archive-message', message_id: 'msg-42' } },
        { id: 'write-digest', toolName: 'write', arguments: { file_path: 'inbox-digest.md', content: 'done\n' } },
      ],
    }))
    fxReg.service.save(fxReg.owner, 'source-goal', {
      name: 'email-registry-wf',
      description: 'Triage inbox with email.unarchive compensation.',
      preconditions: 'authenticated-inbox-and-idempotency-key',
      workflowFamily: 'email-inbox-triage',
      compensation: 'compensate-via-registry',
      compensationPlan: {
        kind: 'compensate-via-registry',
        entries: [{ stepId: 'lark-triage', compensatorKey: 'email.unarchive', capturePreimage: true }],
      },
    })

    const runRegFail = await fxReg.execute('skill_run', {
      goal_id: 'run-reg-fail',
      name: 'email-registry-wf',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-reg-1',
    })
    expect(runRegFail.isError).toBe(true)
    expect(compPayloads).toHaveLength(1)
    expect(compPayloads[0]!.kind).toBe('email.unarchive')
    expect((compPayloads[0]!.preimage as { snapshot?: { toolName?: string } }).snapshot?.toolName).toBe('action_lark_action')

    const db = new DatabaseSync(fxReg.dbPath)
    let runId: string
    try {
      const row = db.prepare('SELECT id, state FROM skill_runs').get() as { id: string; state: string }
      expect(row.state).toBe('failed')
      runId = row.id
    } finally {
      db.close()
    }
    const statusRes = await fxReg.execute('skill_status', { run_id: runId })
    const statusJson = JSON.parse((statusRes.content[0] as { text: string }).text) as {
      compensations?: Array<{ stepId: string; status: string; compensatorKey?: string }>
    }
    expect(statusJson.compensations).toHaveLength(1)
    expect(statusJson.compensations![0]).toMatchObject({
      stepId: 'lark-triage',
      status: 'succeeded',
      compensatorKey: 'email.unarchive',
    })
  })

  it('supports HoldoutAuthority receipt verification and qualifyHoldout pre-flight binding over instantiated workflow definitions', async () => {
    const workspace = await makeTempDir('skills-wp13-holdout-ws-')
    const stateRoot = await makeTempDir('skills-wp13-holdout-state-')
    await chmod(stateRoot, 0o700)

    const scope = {
      principalId: 'owner',
      principalRecordId: 'record',
      principalVersion: 1,
      workspace,
      preset: 'primary',
    }
    const baseSource = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
      steps: [{ id: 'write-artifact', toolName: 'write', arguments: { file_path: 'result.sh', content: 'printf bad' } }],
    })
    const baseline = buildWorkflowSkillDefinition('repo-ci-fix', baseSource, {
      name: 'repo-ci-fix',
      bindings: [],
      allowedTools: ['write'],
      compensation: 'rollback-state',
      compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'write-artifact', capturePreimage: true }] },
    })

    const patch = [
      '*** Begin Patch',
      '*** Add File: result.sh',
      '+cat',
      '*** End Patch',
    ].join('\n')
    const candSource = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
      steps: [{ id: 'patch-artifact', toolName: 'apply_patch', arguments: { input: patch } }],
    })
    const candidate = buildWorkflowSkillDefinition('repo-ci-fix', candSource, {
      name: 'repo-ci-fix',
      bindings: [],
      allowedTools: ['apply_patch'],
      compensation: 'rollback-state',
      compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'patch-artifact', capturePreimage: true }] },
    })

    expect(validateReplayTrace(baseline, 4, 32_768)).toHaveLength(2)
    expect(validateReplayTrace(candidate, 4, 32_768)).toHaveLength(1)

    const replay = await replaySkill({
      definition: candidate,
      inputs: {},
      files: [],
      artifactPath: 'result.sh',
      stateRoot,
      maxToolCalls: 4,
      maxBytes: 32_768,
      signal: new AbortController().signal,
      authorize: () => {},
    })
    expect(replay.artifact).toBe('cat\n')

    const dataset: HoldoutDataset = {
      id: 'wp13-repo-holdout',
      version: '1',
      cases: [
        { id: 'replay', kind: 'replay', stdin: 'r', expectedStdout: 'r', expectedExitCode: 0 },
        { id: 'evaluation', kind: 'evaluation', stdin: 'e', expectedStdout: 'e', expectedExitCode: 0 },
        { id: 'regression', kind: 'regression', stdin: 'g', expectedStdout: 'g', expectedExitCode: 0 },
      ],
    }
    const keys = generateKeyPairSync('ed25519')
    const pinnedPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const authority = HoldoutAuthority.create({
      dataset,
      privateKey: keys.privateKey,
      limits: { maxToolCalls: 4, maxOutputBytes: 1024 },
    })

    const execution = {
      ...nativeExecution(stateRoot),
      command: '/bin/sh /workspace/artifact < /workspace/input',
      artifactPath: 'result.sh',
      expiresAt: Date.now() + 60_000,
      repeats: 2,
      maxToolCalls: 4,
      maxBytes: 32_768,
      maxOutputBytes: 1024,
      cellDurationMs: 2000,
      verificationDurationMs: 1000,
    }

    // Verify qualifyHoldout validates materialized workflow traces and binds begin cleanly
    let beginSeen: ReturnType<typeof authority.begin> | undefined
    await expect(qualifyHoldout({
      baseline,
      candidate,
      scope,
      execution,
      expectedDatasetDigest: acceptanceDigest(dataset),
      pinnedPublicKey,
      signal: new AbortController().signal,
      authorize: () => {},
      transport: {
        async request(op, val) {
          if (op === 'begin') {
            beginSeen = authority.begin(val as Parameters<typeof authority.begin>[0])
            return { ...beginSeen, publicKey: 'stop-before-runner' }
          }
          throw new Error('unexpected transport op')
        },
      },
    })).rejects.toThrow(/pinned key/)

    expect(beginSeen).toBeDefined()
    const issued = new Map<string, string>()
    while (true) {
      const cell = authority.next()
      if (!cell) break
      issued.set(cell.cellId, cell.armDigest)
      const c = dataset.cases.find(item => item.stdin === cell.stdin)!
      const isCand = cell.armDigest === acceptanceDigest(candidate)
      authority.record({
        cellId: cell.cellId,
        armDigest: cell.armDigest,
        stdout: isCand ? c.expectedStdout : 'bad',
        exitCode: c.expectedExitCode,
        quiescent: true,
        status: 'completed',
        artifactDigest: acceptanceDigest(isCand ? replay.artifact : 'printf bad'),
        toolCalls: [],
      })
    }
    const receipt = authority.finish()
    expect(verifyHoldoutReceipt(receipt, beginSeen!, issued, pinnedPublicKey)).toBe(true)
  })

  it('fails closed on grant_id when assistantIsolation is absent or discover() rejects, and validates discover(agent) when mounted', async () => {
    const fx = await setupServiceFixture({ allowedTools: ['read', 'write'] })
    await writeFile(join(fx.root, 'package.json'), '{"name":"demo"}\n', 'utf8')

    const source = buildWorkflowSourceForTemplate('dependency-config-audit', fx.scope, {
      goalId: 'source-goal-grant',
      sessionId: String(fx.owner.session.id),
      nativeGoalId: 'native-source-goal-grant',
      steps: [
        { id: 'read-manifest', toolName: 'read', arguments: { file_path: 'package.json' } },
        { id: 'write-report', toolName: 'write', arguments: { file_path: 'audit-report.md', content: 'grant:grant-1\n' } },
      ],
    })
    fx.setSource(source)

    fx.service.save(fx.owner, 'source-goal-grant', {
      name: 'grant-bound-audit',
      description: 'Validates isolation grant_id fail-closed.',
      bindings: [
        { name: 'manifest_path', stepId: 'read-manifest', path: '/file_path' },
        { name: 'grant_id', stepId: 'write-report', path: '/content' },
      ],
      preconditions: 'workspace-manifest-and-isolation-grant',
      workflowFamily: 'dependency-config-audit',
      compensation: 'rollback-state',
    })

    // 1) Absent assistantIsolation -> fails closed before claim()
    const absentRes = await fx.execute('skill_run', {
      goal_id: 'goal-grant-absent',
      name: 'grant-bound-audit',
      version: 1,
      inputs_json: JSON.stringify({ grant_id: 'forged-grant' }),
      invocation_id: 'inv-grant-1',
    })
    expect(absentRes.isError).toBe(true)

    // 2) Mounted assistantIsolation exposing discover(agent) -> rejects unknown/empty/throwing, admits matching grant
    const discoverCalls: Array<Agent | undefined> = []
    let discoverThrows = false
    fx.ctx.provide('assistantIsolation' as never, {
      discover: async (agent: Agent | undefined) => {
        discoverCalls.push(agent)
        if (discoverThrows) throw new Error('policy denied')
        return [{ id: 'valid-grant-1' }]
      },
    } as never)

    const emptyGrantRes = await fx.execute('skill_run', {
      goal_id: 'goal-grant-empty',
      name: 'grant-bound-audit',
      version: 1,
      inputs_json: JSON.stringify({ grant_id: '   ' }),
      invocation_id: 'inv-grant-1',
    })
    expect(emptyGrantRes.isError).toBe(true)

    const bogusGrantRes = await fx.execute('skill_run', {
      goal_id: 'goal-grant-bogus',
      name: 'grant-bound-audit',
      version: 1,
      inputs_json: JSON.stringify({ grant_id: 'forged-grant' }),
      invocation_id: 'inv-grant-1',
    })
    expect(bogusGrantRes.isError).toBe(true)
    expect(discoverCalls).toEqual([fx.owner])

    discoverThrows = true
    const throwGrantRes = await fx.execute('skill_run', {
      goal_id: 'goal-grant-throw',
      name: 'grant-bound-audit',
      version: 1,
      inputs_json: JSON.stringify({ grant_id: 'valid-grant-1' }),
      invocation_id: 'inv-grant-1',
    })
    expect(throwGrantRes.isError).toBe(true)

    const db = new DatabaseSync(fx.dbPath)
    try {
      expect((db.prepare('SELECT count(*) AS c FROM skill_runs').get() as { c: number }).c).toBe(0)
    } finally {
      db.close()
    }

    discoverThrows = false
    const okGrantRes = await fx.execute('skill_run', {
      goal_id: 'goal-grant-ok',
      name: 'grant-bound-audit',
      version: 1,
      inputs_json: JSON.stringify({ grant_id: 'valid-grant-1' }),
      invocation_id: 'inv-grant-1',
    })
    expect(okGrantRes.isError).toBe(false)
    expect(await readFile(join(fx.root, 'audit-report.md'), 'utf8')).toBe('valid-grant-1')
  })

  it('rejects empty/whitespace owner_route_id, future window_start, empty inputName overrides, while honoring materialized defaults', async () => {
    const fx = await setupServiceFixture({ allowedTools: ['read', 'write'] })
    await writeFile(join(fx.root, 'ci-report.txt'), 'OK\n', 'utf8')
    await writeFile(join(fx.root, 'meeting-agenda.md'), '# Agenda\n', 'utf8')
    await writeFile(join(fx.root, 'inbox-batch.json'), '[]\n', 'utf8')

    // 1) Calendar window & owner_route_id checks
    const fxCal = await setupServiceFixture({ allowedTools: ['read', 'write'] })
    await writeFile(join(fxCal.root, 'meeting-agenda.md'), '# Agenda\n', 'utf8')
    fxCal.setSource(buildWorkflowSourceForTemplate('calendar-meeting-prep', fxCal.scope, {
      goalId: 'source-goal-cal2',
      sessionId: String(fxCal.owner.session.id),
      nativeGoalId: 'native-source-goal-cal2',
      steps: [
        { id: 'read-agenda', toolName: 'read', arguments: { file_path: 'meeting-agenda.md' } },
        { id: 'write-brief', toolName: 'write', arguments: { file_path: 'brief.md', content: 'owner-route' } },
        { id: 'probe-window', toolName: 'read', arguments: { file_path: 'meeting-agenda.md', limit: 1 } },
      ],
    }))
    fxCal.service.save(fxCal.owner, 'source-goal-cal2', {
      name: 'cal-window-route',
      description: 'Validates owner_route_id and window_start.',
      bindings: [
        { name: 'owner_route_id', stepId: 'write-brief', path: '/content' },
        { name: 'window_start', stepId: 'probe-window', path: '/limit' },
      ],
      preconditions: 'calendar-window-and-route-binding',
      workflowFamily: 'calendar-meeting-prep',
      compensation: 'rollback-state',
    })

    const emptyRouteCal = await fxCal.execute('skill_run', {
      goal_id: 'g-cal-empty-route',
      name: 'cal-window-route',
      version: 1,
      inputs_json: JSON.stringify({ owner_route_id: '', window_start: 1 }),
      invocation_id: 'inv-cal-1',
    })
    expect(emptyRouteCal.isError).toBe(true)

    const wsRouteCal = await fxCal.execute('skill_run', {
      goal_id: 'g-cal-ws-route',
      name: 'cal-window-route',
      version: 1,
      inputs_json: JSON.stringify({ owner_route_id: '   ', window_start: 1 }),
      invocation_id: 'inv-cal-1',
    })
    expect(wsRouteCal.isError).toBe(true)

    const futureStartCal = await fxCal.execute('skill_run', {
      goal_id: 'g-cal-future-start',
      name: 'cal-window-route',
      version: 1,
      inputs_json: JSON.stringify({ owner_route_id: 'owner-route', window_start: Date.now() + 3_600_000 }),
      invocation_id: 'inv-cal-1',
    })
    expect(futureStartCal.isError).toBe(true)

    const dbCal = new DatabaseSync(fxCal.dbPath)
    try {
      expect((dbCal.prepare('SELECT count(*) AS c FROM skill_runs').get() as { c: number }).c).toBe(0)
    } finally {
      dbCal.close()
    }

    const okCal = await fxCal.execute('skill_run', {
      goal_id: 'g-cal-ok',
      name: 'cal-window-route',
      version: 1,
      inputs_json: JSON.stringify({ owner_route_id: 'owner-route', window_start: Date.now() - 1000 }),
      invocation_id: 'inv-cal-1',
    })
    expect(okCal.isError).toBe(false)

    // 2) authenticated-inbox-and-idempotency-key empty owner_route_id
    fx.setSource(buildWorkflowSourceForTemplate('email-inbox-triage', fx.scope, {
      goalId: 'source-goal-inbox',
      sessionId: String(fx.owner.session.id),
      nativeGoalId: 'native-source-goal-inbox',
      steps: [
        { id: 'read-inbox', toolName: 'read', arguments: { file_path: 'inbox-batch.json' } },
        { id: 'write-digest', toolName: 'write', arguments: { file_path: 'inbox-digest.md', content: 'owner-route' } },
      ],
    }))
    fx.service.save(fx.owner, 'source-goal-inbox', {
      name: 'inbox-route-check',
      description: 'Validates empty owner_route_id in inbox preconditions.',
      bindings: [{ name: 'owner_route_id', stepId: 'write-digest', path: '/content' }],
      preconditions: 'authenticated-inbox-and-idempotency-key',
      workflowFamily: 'email-inbox-triage',
      compensation: 'rollback-state',
    })
    const emptyRouteInbox = await fx.execute('skill_run', {
      goal_id: 'g-inbox-empty-route',
      name: 'inbox-route-check',
      version: 1,
      inputs_json: JSON.stringify({ owner_route_id: '' }),
      invocation_id: 'inv-inbox-1',
    })
    expect(emptyRouteInbox.isError).toBe(true)

    // 3) SkillPreconditionPlan empty-string inputName override & materialized defaults
    const plan: SkillPreconditionPlan = {
      protocol: 'assistant-skills/precondition-plan/v1',
      kind: 'current-owner-policy-and-fresh-goal',
      checks: [
        { id: 'report-file', kind: 'path-regular-file', inputName: 'report_path', path: 'ci-report.txt' },
      ],
    }
    const probe = (p: string) => ({ contained: true, isSymlink: false, exists: p === 'ci-report.txt', isRegularFile: p === 'ci-report.txt' })
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'current-owner-policy-and-fresh-goal',
      inputs: { report_path: '' },
      pathProbe: probe,
    })).toThrow(/invalid path/i)
    expect(() => evaluatePreconditionPlan(plan, {
      preconditions: 'current-owner-policy-and-fresh-goal',
      inputs: { report_path: 42 as unknown as string },
      pathProbe: probe,
    })).toThrow(/invalid path/i)

    fx.setSource(buildWorkflowSourceForTemplate('repo-ci-fix', fx.scope, {
      goalId: 'source-goal-plan-def',
      sessionId: String(fx.owner.session.id),
      nativeGoalId: 'native-source-goal-plan-def',
      steps: [
        { id: 'read-ci-report', toolName: 'read', arguments: { file_path: 'ci-report.txt' } },
        { id: 'write-summary', toolName: 'write', arguments: { file_path: 'ci-out.txt', content: 'done\n' } },
      ],
    }))
    fx.service.save(fx.owner, 'source-goal-plan-def', {
      name: 'plan-input-defaults',
      description: 'Validates empty inputName override and materialized defaults.',
      bindings: [{ name: 'report_path', stepId: 'read-ci-report', path: '/file_path' }],
      preconditions: 'current-owner-policy-and-fresh-goal',
      preconditionPlan: {
        kind: 'current-owner-policy-and-fresh-goal',
        checks: [
          { id: 'report-file', kind: 'path-regular-file', inputName: 'report_path', path: 'ci-report.txt' },
          { id: 'report-nonempty', kind: 'input-nonempty', inputName: 'report_path' },
        ],
      },
      compensation: 'rollback-state',
    })

    // Explicit empty override must fail BEFORE store.claim() without burning inv-plan-1
    const emptyOverrideRes = await fx.execute('skill_run', {
      goal_id: 'g-plan-empty',
      name: 'plan-input-defaults',
      version: 1,
      inputs_json: JSON.stringify({ report_path: '' }),
      invocation_id: 'inv-plan-1',
    })
    expect(emptyOverrideRes.isError).toBe(true)

    const dbFx = new DatabaseSync(fx.dbPath)
    try {
      expect((dbFx.prepare('SELECT count(*) AS c FROM skill_runs').get() as { c: number }).c).toBe(0)
    } finally {
      dbFx.close()
    }

    // Omitted input uses materialized default 'ci-report.txt' and passes both path-regular-file & input-nonempty!
    const defaultInputRes = await fx.execute('skill_run', {
      goal_id: 'g-plan-default',
      name: 'plan-input-defaults',
      version: 1,
      inputs_json: '{}',
      invocation_id: 'inv-plan-1',
    })
    expect(defaultInputRes.isError).toBe(false)
    expect(await readFile(join(fx.root, 'ci-out.txt'), 'utf8')).toBe('done\n')
  })

  it('prevents symlink write/unlink escapes in replaySkill rollback-state and enforces maxBytes over compensationPlan args', async () => {
    const stateRoot = await makeTempDir('skills-wp13-replay-sec-')
    await chmod(stateRoot, 0o700)
    const outsideDir = await makeTempDir('skills-wp13-outside-')
    const victimFile = join(outsideDir, 'victim.txt')
    await writeFile(victimFile, 'UNTOUCHED', 'utf8')

    const scope = {
      principalId: 'owner',
      principalRecordId: 'record',
      principalVersion: 1,
      workspace: '/source-workspace',
      preset: 'primary',
    }

    // 1) Existing file swapped to symlink by failing step -> rollback-state must fail closed without overwriting victimFile
    const defExisting = buildWorkflowSkillDefinition('wiki-knowledge-synthesis', buildWorkflowSourceForTemplate('wiki-knowledge-synthesis', scope, {
      steps: [
        { id: 'mutate-target', toolName: 'write', arguments: { file_path: 'target.txt', content: 'v1' } },
        { id: 'swap-and-fail', toolName: 'wiki_search', arguments: { query: 'trigger' } },
      ],
    }), {
      name: 'replay-sym-existing',
      bindings: [],
      allowedTools: ['write', 'wiki_search'],
      compensation: 'rollback-state',
      compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'mutate-target', capturePreimage: true }] },
    })

    await expect(replaySkill({
      definition: defExisting,
      inputs: {},
      files: [{ path: 'target.txt', content: 'original' }],
      artifactPath: 'target.txt',
      stateRoot,
      maxToolCalls: 8,
      maxBytes: 32_768,
      signal: new AbortController().signal,
      authorize: () => {},
      domainToolHandlers: {
        wiki_search: async (_args, context) => {
          await unlink(join(context.root, 'target.txt'))
          await symlink(victimFile, join(context.root, 'target.txt'))
          throw new Error('simulated failure after symlink swap')
        },
      },
    })).rejects.toThrow(/symlink|unsafe/i)
    expect(await readFile(victimFile, 'utf8')).toBe('UNTOUCHED')

    // 2) Newly created file swapped to symlink by failing step -> rollback-state must fail closed without unlinking victimFile
    const defCreated = buildWorkflowSkillDefinition('wiki-knowledge-synthesis', buildWorkflowSourceForTemplate('wiki-knowledge-synthesis', scope, {
      steps: [
        { id: 'create-target', toolName: 'write', arguments: { file_path: 'created.txt', content: 'v1' } },
        { id: 'swap-and-fail', toolName: 'wiki_search', arguments: { query: 'trigger' } },
      ],
    }), {
      name: 'replay-sym-created',
      bindings: [],
      allowedTools: ['write', 'wiki_search'],
      compensation: 'rollback-state',
      compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'create-target', capturePreimage: true }] },
    })

    await expect(replaySkill({
      definition: defCreated,
      inputs: {},
      files: [],
      artifactPath: 'created.txt',
      stateRoot,
      maxToolCalls: 8,
      maxBytes: 32_768,
      signal: new AbortController().signal,
      authorize: () => {},
      domainToolHandlers: {
        wiki_search: async (_args, context) => {
          await unlink(join(context.root, 'created.txt'))
          await symlink(victimFile, join(context.root, 'created.txt'))
          throw new Error('simulated failure after symlink swap')
        },
      },
    })).rejects.toThrow(/symlink|unsafe/i)
    expect(await readFile(victimFile, 'utf8')).toBe('UNTOUCHED')

    // 3) replaySkill enforces maxBytes consistently with validateReplayTrace including compensationPlan argument bytes
    const compDef = createDefinition(
      buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        steps: [{ id: 's1', toolName: 'write', arguments: { file_path: 'out.txt', content: 'hi' } }],
      }),
      {
        name: 'replay-comp-bytes',
        description: 'Checks compensationPlan byte accounting.',
        compensation: 'compensating-action',
        compensationPlan: {
          kind: 'compensating-action',
          entries: [{ stepId: 's1', toolName: 'write', arguments: { file_path: 'out.txt', content: 'x'.repeat(200) } }],
        },
      },
      ['write'],
    )
    const stepOnlyBytes = Buffer.byteLength(JSON.stringify(compDef.steps[0]!.arguments), 'utf8')
      + Buffer.byteLength(JSON.stringify({ file_path: 'out.txt', limit: 1 }), 'utf8')
    await expect(replaySkill({
      definition: compDef,
      inputs: {},
      files: [],
      artifactPath: 'out.txt',
      stateRoot,
      maxToolCalls: 8,
      maxBytes: stepOnlyBytes + 100,
      signal: new AbortController().signal,
      authorize: () => {},
    })).rejects.toThrow(/byte limit/i)
    expect(await readdir(stateRoot)).toEqual([])
  })

  it('preserves leading-space update hunk context lines and rejects mid-patch Environment ID headers in patch-paths', () => {
    const patchWithContextHeaders = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      ' *** Update File: /etc/passwd',
      ' *** Add File: /etc/shadow',
      ' *** Delete File: /etc/hosts',
      ' *** Move to: /tmp/evil',
      ' *** Environment ID: local',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')

    expect(extractPatchAffectedPaths(patchWithContextHeaders)).toEqual(['a.txt'])
    const rewritten = rewritePatchHeaderPaths(patchWithContextHeaders, p => `mapped(${p})`)
    expect(rewritten).toBe([
      '*** Begin Patch',
      '*** Update File: mapped(a.txt)',
      '@@',
      ' *** Update File: /etc/passwd',
      ' *** Add File: /etc/shadow',
      ' *** Delete File: /etc/hosts',
      ' *** Move to: /tmp/evil',
      ' *** Environment ID: local',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'))

    const midPatchEnv = [
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+hello',
      '*** Environment ID: local',
      '*** End Patch',
    ].join('\n')
    expect(() => parsePatchOperationPaths(midPatchEnv)).toThrow(/Environment ID/i)
  })

  it('handles mid-patch partial apply_patch failures, unknown outcomes, and rollback-state without write in allowedTools', async () => {
    // 1) Real FileTools({ applyPatch: true }) partial commit failure in live AssistantSkillsService.#run -> fails and rolls back op 1!
    {
      const root = await makeTempDir('skills-wp13-real-patch-')
      const stateDir = await makeTempDir('skills-wp13-real-patch-db-')
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.restart())

      const owner = makeAgent(ctx, root, 'owner-session')
      const scope = {
        principalId: 'owner',
        principalRecordId: 'owner-record',
        principalVersion: 1,
        workspace: root,
        preset: 'primary',
      }
      const principal = () => ({
        principalId: 'owner',
        principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 },
        scope: { workspace: root, preset: 'primary' },
      })
      ctx.provide('agents' as never, { get: (id: string) => (id === owner.id ? owner : undefined), list: () => [owner] } as never)
      ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: principal } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluate: () => ({ effect: 'allow' }),
        authorize: () => ({ effect: 'allow' }),
        evaluateAgent: () => ({ effect: 'allow' }),
        authorizeAgent: () => ({ effect: 'allow' }),
      } as never)
      ctx.provide('assistantVerifier' as never, {} as never)

      const partialPatch = [
        '*** Begin Patch',
        '*** Update File: existing.txt',
        '@@',
        '-before',
        '+after',
        '*** Add File: blocker',
        '+blocking-file',
        '*** Add File: blocker/child.txt',
        '+unreachable',
        '*** End Patch',
      ].join('\n')
      await writeFile(join(root, 'existing.txt'), 'before\n', 'utf8')

      const source = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        goalId: 'source-goal-real-patch',
        sessionId: String(owner.session.id),
        nativeGoalId: 'native-source-goal-real-patch',
        steps: [{ id: 'patch-1', toolName: 'apply_patch', arguments: { input: partialPatch } }],
      })
      ctx.provide('assistantGoals' as never, {
        inspectVerifiedWorkflowSource: () => source,
        inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({
          scope,
          goalId,
          sessionId: String(owner.session.id),
          goalExecutionRunId: `goal-exec-${goalId}`,
          nativeGoalId: `native-${goalId}`,
          definition: { version: 1, digest: 'd'.repeat(64) },
        }),
      } as never)

      await new Promise<void>(resolve => setImmediate(resolve))
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
      await ctx.plugin(FileTools, { applyPatch: true })
      await ctx.plugin(AssistantSkillsService, {
        databasePath: join(stateDir, 'skills.sqlite'),
        // Intentionally omit 'write' to also verify rollback-state works when only apply_patch/read are allowed!
        allowedTools: ['read', 'apply_patch'],
      })

      const service = ctx.get('assistantSkills')!
      service.save(owner, 'source-goal-real-patch', {
        name: 'partial-patch-rollback',
        description: 'Rolls back partial apply_patch commit without write in allowedTools.',
        compensation: 'rollback-state',
      })

      const batch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('call-partial-patch'),
          name: 'skill_run',
          arguments: JSON.stringify({
            goal_id: 'fresh-goal-partial',
            name: 'partial-patch-rollback',
            version: 1,
            inputs_json: '{}',
            invocation_id: 'inv-partial-1',
          }),
        }],
        signal: new AbortController().signal,
        agent: owner,
      })
      const runRes = batch.results[0]!.result
      expect(runRes.isError).toBe(true)
      expect(await readFile(join(root, 'existing.txt'), 'utf8')).toBe('before\n')
      await expect(readFile(join(root, 'blocker'), 'utf8')).rejects.toThrow()

      const runId = JSON.stringify(runRes).match(/skill-run-[a-f0-9]{64}/u)![0]
      const statusBatch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('call-partial-status'),
          name: 'skill_status',
          arguments: JSON.stringify({ run_id: runId }),
        }],
        signal: new AbortController().signal,
        agent: owner,
      })
      const status = JSON.parse((statusBatch.results[0]!.result.value as { context: string }).context)
      expect(status.state).toBe('failed')
      expect(status.compensations).toMatchObject([
        { stepId: 'patch-1', status: 'succeeded' },
      ])
    }

    // 2) Simulated throwing apply_patch after partial mutation -> rolls back failed apply_patch preimage
    {
      const fx = await setupServiceFixture({
        allowedTools: ['read', 'apply_patch'],
        failStepName: 'apply_patch',
        failPredicate: () => false,
      })
      await writeFile(join(fx.root, 'existing.txt'), 'before-throw\n', 'utf8')
      const throwPatch = [
        '*** Begin Patch',
        '*** Update File: existing.txt',
        '@@',
        '-before-throw',
        '+mutated-before-throw',
        '*** Add File: partial.txt',
        '+partial',
        '*** End Patch',
      ].join('\n')
      fx.ctx.tools.register(defineTool({
        name: 'apply_patch_unused',
        description: 'noop',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
        execute: async () => 'ok',
      }))
      // Mutate files inside tools/execute before failing
      fx.ctx.on('tools/execute', async (exec, next) => {
        if (exec.name === 'apply_patch') {
          await writeFile(join(fx.root, 'existing.txt'), 'mutated-before-throw\n', 'utf8')
          await writeFile(join(fx.root, 'partial.txt'), 'partial\n', 'utf8')
          throw new Error('mid-patch crash')
        }
        return next()
      })
      fx.setSource(buildWorkflowSourceForTemplate('repo-ci-fix', fx.scope, {
        goalId: 'source-goal-throw-patch',
        sessionId: String(fx.owner.session.id),
        nativeGoalId: 'native-source-goal-throw-patch',
        steps: [{ id: 'patch-throw', toolName: 'apply_patch', arguments: { input: throwPatch } }],
      }))
      fx.service.save(fx.owner, 'source-goal-throw-patch', {
        name: 'throw-patch-rollback',
        description: 'Rolls back throwing apply_patch.',
        compensation: 'rollback-state',
      })
      const res = await fx.execute('skill_run', {
        goal_id: 'g-throw-patch',
        name: 'throw-patch-rollback',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-throw-patch',
      })
      expect(res.isError).toBe(true)
      expect(await readFile(join(fx.root, 'existing.txt'), 'utf8')).toBe('before-throw\n')
      await expect(readFile(join(fx.root, 'partial.txt'), 'utf8')).rejects.toThrow()
    }

    // 2b) Partial apply_patch commit with unknown operation -> settles unknown & skipped-unknown (no speculative rollback)
    {
      const root = await makeTempDir('skills-wp13-unknown-patch-')
      const stateDir = await makeTempDir('skills-wp13-unknown-patch-db-')
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.restart())

      const owner = makeAgent(ctx, root, 'owner-session')
      const scope = {
        principalId: 'owner',
        principalRecordId: 'owner-record',
        principalVersion: 1,
        workspace: root,
        preset: 'primary',
      }
      const principal = () => ({
        principalId: 'owner',
        principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 },
        scope: { workspace: root, preset: 'primary' },
      })
      ctx.provide('agents' as never, { get: (id: string) => (id === owner.id ? owner : undefined), list: () => [owner] } as never)
      ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: principal } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluate: () => ({ effect: 'allow' }),
        authorize: () => ({ effect: 'allow' }),
        evaluateAgent: () => ({ effect: 'allow' }),
        authorizeAgent: () => ({ effect: 'allow' }),
      } as never)
      ctx.provide('assistantVerifier' as never, {} as never)

      const unknownPatch = [
        '*** Begin Patch',
        '*** Add File: partial-unknown.txt',
        '+kept',
        '*** End Patch',
      ].join('\n')
      const source = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        goalId: 'source-goal-unk-patch',
        sessionId: String(owner.session.id),
        nativeGoalId: 'native-source-goal-unk-patch',
        steps: [{ id: 'patch-unk', toolName: 'apply_patch', arguments: { input: unknownPatch } }],
      })
      ctx.provide('assistantGoals' as never, {
        inspectVerifiedWorkflowSource: () => source,
        inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({
          scope,
          goalId,
          sessionId: String(owner.session.id),
          goalExecutionRunId: `goal-exec-${goalId}`,
          nativeGoalId: `native-${goalId}`,
          definition: { version: 1, digest: 'd'.repeat(64) },
        }),
      } as never)

      await new Promise<void>(resolve => setImmediate(resolve))
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(SkillRegistry)
      ctx.tools.register(defineTool({
        name: 'apply_patch',
        description: 'Partial unknown apply_patch stub',
        parameters: { input: { type: 'string', required: true } },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              phase: { type: 'string', required: true },
              cancelled: { type: 'boolean', required: true },
              operations: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer', required: true },
                    kind: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    patchLine: { type: 'integer', required: true },
                    status: { type: 'string', required: true },
                  },
                },
              },
              affectedPaths: { type: 'array', items: { type: 'string' }, required: true },
            },
          },
          render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        execute: async () => {
          await writeFile(join(root, 'partial-unknown.txt'), 'kept\n', 'utf8')
          return {
            phase: 'commit',
            cancelled: true,
            operations: [
              { index: 0, kind: 'add', path: 'partial-unknown.txt', patchLine: 2, status: 'completed' },
              { index: 1, kind: 'add', path: 'other.txt', patchLine: 4, status: 'unknown' },
            ],
            affectedPaths: ['partial-unknown.txt', 'other.txt'],
          }
        },
      }))
      await ctx.plugin(AssistantSkillsService, {
        databasePath: join(stateDir, 'skills.sqlite'),
        allowedTools: ['read', 'apply_patch'],
      })
      const service = ctx.get('assistantSkills')!
      service.save(owner, 'source-goal-unk-patch', {
        name: 'unk-patch-fence',
        description: 'Preserves unknown fence on partial-unknown apply_patch.',
        compensation: 'rollback-state',
      })
      const runBatch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('call-unk-patch'),
          name: 'skill_run',
          arguments: JSON.stringify({
            goal_id: 'g-unk-patch',
            name: 'unk-patch-fence',
            version: 1,
            inputs_json: '{}',
            invocation_id: 'inv-unk-patch',
          }),
        }],
        signal: new AbortController().signal,
        agent: owner,
      })
      const runRes = runBatch.results[0]!.result
      expect(runRes.isError).toBe(true)
      // Must NOT speculatively roll back when outcome is unknown
      expect(await readFile(join(root, 'partial-unknown.txt'), 'utf8')).toBe('kept\n')
      const runId = JSON.stringify(runRes).match(/skill-run-[a-f0-9]{64}/u)![0]
      const statusBatch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('call-unk-status'),
          name: 'skill_status',
          arguments: JSON.stringify({ run_id: runId }),
        }],
        signal: new AbortController().signal,
        agent: owner,
      })
      const status = JSON.parse((statusBatch.results[0]!.result.value as { context: string }).context)
      expect(status.state).toBe('unknown')
      expect(status.compensations).toMatchObject([
        { status: 'skipped-unknown', detail: 'unknown-execution-state-no-speculative-compensation' },
      ])
    }

    // 3) replaySkill with real FileTools partial commit failure -> fails closed
    {
      const stateRoot = await makeTempDir('skills-wp13-replay-partial-')
      await chmod(stateRoot, 0o700)
      const scope = {
        principalId: 'owner',
        principalRecordId: 'record',
        principalVersion: 1,
        workspace: '/source-workspace',
        preset: 'primary',
      }
      const partialPatch = [
        '*** Begin Patch',
        '*** Add File: blocker',
        '+blocking-file',
        '*** Add File: blocker/child.txt',
        '+unreachable',
        '*** End Patch',
      ].join('\n')
      const def = buildWorkflowSkillDefinition('repo-ci-fix', buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        steps: [{ id: 'patch-1', toolName: 'apply_patch', arguments: { input: partialPatch } }],
      }), {
        name: 'replay-partial-patch',
        bindings: [],
        allowedTools: ['apply_patch'],
        compensation: 'rollback-state',
        compensationPlan: { kind: 'rollback-state', entries: [{ stepId: 'patch-1', capturePreimage: true }] },
      })
      await expect(replaySkill({
        definition: def,
        inputs: {},
        files: [],
        artifactPath: 'blocker',
        stateRoot,
        maxToolCalls: 8,
        maxBytes: 32_768,
        signal: new AbortController().signal,
        authorize: () => {},
      })).rejects.toThrow(/apply_patch failed/i)
      expect(await readdir(stateRoot)).toEqual([])
    }
  })

  it('skips absent/ENOTDIR targets before dispatching fs.remove-created-file to live AssistantCompensationService', async () => {
    const root = await makeTempDir('skills-wp13-comp-enotdir-')
    const stateDir = await makeTempDir('skills-wp13-comp-enotdir-db-')
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.restart())

    const owner = makeAgent(ctx, root, 'owner-session')
    const scope = {
      principalId: 'owner',
      principalRecordId: 'owner-record',
      principalVersion: 1,
      workspace: root,
      preset: 'primary',
    }
    const principal = () => ({
      principalId: 'owner',
      principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 },
      scope: { workspace: root, preset: 'primary' },
    })
    ctx.provide('agents' as never, { get: (id: string) => (id === owner.id ? owner : undefined), list: () => [owner] } as never)
    ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: principal } as never)
    ctx.provide('assistantPolicy' as never, {
      evaluate: () => ({ effect: 'allow' }),
      authorize: () => ({ effect: 'allow' }),
      evaluateAgent: () => ({ effect: 'allow' }),
      authorizeAgent: () => ({ effect: 'allow' }),
    } as never)
    ctx.provide('assistantVerifier' as never, {} as never)

    const partialPatch = [
      '*** Begin Patch',
      '*** Add File: blocker',
      '+blocking-file',
      '*** Add File: blocker/child.txt',
      '+unreachable',
      '*** End Patch',
    ].join('\n')

    const source = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
      goalId: 'source-goal-enotdir-comp',
      sessionId: String(owner.session.id),
      nativeGoalId: 'native-source-goal-enotdir-comp',
      steps: [{ id: 'patch-1', toolName: 'apply_patch', arguments: { input: partialPatch } }],
    })
    ctx.provide('assistantGoals' as never, {
      inspectVerifiedWorkflowSource: () => source,
      inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({
        scope,
        goalId,
        sessionId: String(owner.session.id),
        goalExecutionRunId: `goal-exec-${goalId}`,
        nativeGoalId: `native-${goalId}`,
        definition: { version: 1, digest: 'd'.repeat(64) },
      }),
    } as never)

    await new Promise<void>(resolve => setImmediate(resolve))
    new SessionProjectionRegistry(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
    await ctx.plugin(FileTools, { applyPatch: true })
    await ctx.plugin(AssistantCompensationService, {
      databasePath: join(stateDir, 'recovery.sqlite'),
    })
    await ctx.plugin(AssistantSkillsService, {
      databasePath: join(stateDir, 'skills.sqlite'),
      allowedTools: ['read', 'write', 'apply_patch'],
    })
    await expect.poll(() => ctx.tools.get('apply_patch')).toBeDefined()
    await expect.poll(() => ctx.tools.get('skill_run')).toBeDefined()

    const compService = ctx.get('assistantCompensation')!
    const removedTargets: string[] = []
    compService.registerCompensator?.({
      kind: 'fs.remove-created-file',
      category: 'delete',
      compensate: async ({ record }) => {
        const target = record.target as { filePath: string; resolvedPath: string }
        removedTargets.push(target.filePath)
        await unlink(target.resolvedPath)
        return { status: 'succeeded', resultCode: 'removed-created-file' }
      },
    })

    const service = ctx.get('assistantSkills')!
    service.save(owner, 'source-goal-enotdir-comp', {
      name: 'enotdir-live-comp',
      description: 'Skips absent ENOTDIR child path before dispatching fs.remove-created-file.',
      compensation: 'rollback-state',
    })

    const batch = await owner.ctx.get('tools')!.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('call-enotdir-comp'),
        name: 'skill_run',
        arguments: JSON.stringify({
          goal_id: 'fresh-goal-enotdir-comp',
          name: 'enotdir-live-comp',
          version: 1,
          inputs_json: '{}',
          invocation_id: 'inv-enotdir-comp-1',
        }),
      }],
      signal: new AbortController().signal,
      agent: owner,
    })
    const runRes = batch.results[0]!.result
    expect(runRes.isError).toBe(true)
    expect(removedTargets).toEqual(['blocker'])
    await expect(lstat(join(root, 'blocker'))).rejects.toMatchObject({ code: 'ENOENT' })

    const runId = JSON.stringify(runRes).match(/skill-run-[a-f0-9]{64}/u)![0]
    const statusBatch = await owner.ctx.get('tools')!.execute({
      calls: [{
        type: 'tool-call',
        id: ToolCallId('call-enotdir-comp-status'),
        name: 'skill_status',
        arguments: JSON.stringify({ run_id: runId }),
      }],
      signal: new AbortController().signal,
      agent: owner,
    })
    const status = JSON.parse((statusBatch.results[0]!.result.value as { context: string }).context)
    expect(status.state).toBe('failed')
    expect(status.compensations).toMatchObject([
      { stepId: 'patch-1', status: 'succeeded', detail: 'removed-created-file' },
    ])
  })

  it('rolls back partial apply_patch nested-dir Add File conflicts in live #run and replaySkill while still failing closed on genuine directory swaps', async () => {
    const nestedConflictPatch = [
      '*** Begin Patch',
      '*** Add File: a/b/c.txt',
      '+created-nested-file',
      '*** Add File: a/b',
      '+conflicting-file-at-parent-dir',
      '*** End Patch',
    ].join('\n')

    // 1) Live AssistantSkillsService.#run with real FileTools({ applyPatch: true }) -> unlinks a/b/c.txt and succeeds compensation
    {
      const root = await makeTempDir('skills-wp13-nested-dir-')
      const stateDir = await makeTempDir('skills-wp13-nested-dir-db-')
      const ctx = new Context()
      cleanups.push(() => ctx.fiber.restart())

      const owner = makeAgent(ctx, root, 'owner-session')
      const scope = {
        principalId: 'owner',
        principalRecordId: 'owner-record',
        principalVersion: 1,
        workspace: root,
        preset: 'primary',
      }
      const principal = () => ({
        principalId: 'owner',
        principalLineage: { principalRecordId: 'owner-record', principalVersion: 1 },
        scope: { workspace: root, preset: 'primary' },
      })
      ctx.provide('agents' as never, { get: (id: string) => (id === owner.id ? owner : undefined), list: () => [owner] } as never)
      ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: principal, currentPreferenceTurn: principal } as never)
      ctx.provide('assistantPolicy' as never, {
        evaluate: () => ({ effect: 'allow' }),
        authorize: () => ({ effect: 'allow' }),
        evaluateAgent: () => ({ effect: 'allow' }),
        authorizeAgent: () => ({ effect: 'allow' }),
      } as never)
      ctx.provide('assistantVerifier' as never, {} as never)

      const source = buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        goalId: 'source-goal-nested-dir',
        sessionId: String(owner.session.id),
        nativeGoalId: 'native-source-goal-nested-dir',
        steps: [{ id: 'patch-nested', toolName: 'apply_patch', arguments: { input: nestedConflictPatch } }],
      })
      ctx.provide('assistantGoals' as never, {
        inspectVerifiedWorkflowSource: () => source,
        inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({
          scope,
          goalId,
          sessionId: String(owner.session.id),
          goalExecutionRunId: `goal-exec-${goalId}`,
          nativeGoalId: `native-${goalId}`,
          definition: { version: 1, digest: 'd'.repeat(64) },
        }),
      } as never)

      await new Promise<void>(resolve => setImmediate(resolve))
      new SessionProjectionRegistry(ctx)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(NativeToolExecutor)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(LocalFileSystem, { cwd: root })
      await ctx.plugin(WorkingDirectoryService, { defaultDirectory: root })
      await ctx.plugin(FileTools, { applyPatch: true })
      await ctx.plugin(AssistantSkillsService, {
        databasePath: join(stateDir, 'skills.sqlite'),
        allowedTools: ['read', 'apply_patch'],
      })
      await expect.poll(() => ctx.tools.get('apply_patch')).toBeDefined()
      await expect.poll(() => ctx.tools.get('skill_run')).toBeDefined()

      const service = ctx.get('assistantSkills')!
      service.save(owner, 'source-goal-nested-dir', {
        name: 'nested-dir-conflict-rollback',
        description: 'Unlinks created nested child when Add File later hits parent directory EISDIR.',
        compensation: 'rollback-state',
      })

      const batch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('call-nested-dir'),
          name: 'skill_run',
          arguments: JSON.stringify({
            goal_id: 'fresh-goal-nested-dir',
            name: 'nested-dir-conflict-rollback',
            version: 1,
            inputs_json: '{}',
            invocation_id: 'inv-nested-dir-1',
          }),
        }],
        signal: new AbortController().signal,
        agent: owner,
      })
      const runRes = batch.results[0]!.result
      expect(runRes.isError).toBe(true)
      await expect(lstat(join(root, 'a', 'b', 'c.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

      const runId = JSON.stringify(runRes).match(/skill-run-[a-f0-9]{64}/u)![0]
      const statusBatch = await owner.ctx.get('tools')!.execute({
        calls: [{
          type: 'tool-call',
          id: ToolCallId('call-nested-dir-status'),
          name: 'skill_status',
          arguments: JSON.stringify({ run_id: runId }),
        }],
        signal: new AbortController().signal,
        agent: owner,
      })
      const status = JSON.parse((statusBatch.results[0]!.result.value as { context: string }).context)
      expect(status.state).toBe('failed')
      expect(status.compensations).toMatchObject([
        { stepId: 'patch-nested', status: 'succeeded', detail: 'rollback-deleted-created-file' },
      ])
    }

    // 2) replaySkill with real FileTools({ applyPatch: true }) on *** Add File: a/b/c.txt + *** Add File: a/b
    //    rejects with apply_patch failed (NOT rollback target unsafe) and cleans sandbox
    {
      const stateRoot = await makeTempDir('skills-wp13-replay-nested-')
      await chmod(stateRoot, 0o700)
      const scope = {
        principalId: 'owner',
        principalRecordId: 'record',
        principalVersion: 1,
        workspace: '/source-workspace',
        preset: 'primary',
      }
      const def = buildWorkflowSkillDefinition('repo-ci-fix', buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        steps: [
          { id: 'step-prior', toolName: 'write', arguments: { file_path: 'prior.txt', content: 'after' } },
          { id: 'patch-nested', toolName: 'apply_patch', arguments: { input: nestedConflictPatch } },
        ],
      }), {
        name: 'replay-nested-dir-conflict',
        bindings: [],
        allowedTools: ['write', 'apply_patch'],
        compensation: 'rollback-state',
        compensationPlan: {
          kind: 'rollback-state',
          entries: [
            { stepId: 'step-prior', capturePreimage: true },
            { stepId: 'patch-nested', capturePreimage: true },
          ],
        },
      })
      await expect(replaySkill({
        definition: def,
        inputs: {},
        files: [{ path: 'prior.txt', content: 'before' }],
        artifactPath: 'a/b/c.txt',
        stateRoot,
        maxToolCalls: 8,
        maxBytes: 32_768,
        signal: new AbortController().signal,
        authorize: () => {},
      })).rejects.toThrow(/apply_patch failed/i)
      expect(await readdir(stateRoot)).toEqual([])
    }

    // 3) Negative: genuine post-step directory swap on a previously created file STILL fails closed with rollback-target-unsafe
    {
      const fx = await setupServiceFixture({
        allowedTools: ['read', 'write', 'edit'],
        failStepName: 'edit',
        failPredicate: () => true,
      })
      await writeFile(join(fx.root, 'b.txt'), 'present-b', 'utf8')
      fx.ctx.on('tools/execute', async (exec, next) => {
        if (exec.name === 'edit') {
          await unlink(join(fx.root, 'created.txt'))
          await mkdir(join(fx.root, 'created.txt'))
        }
        return next()
      })
      fx.setSource(buildWorkflowSourceForTemplate('repo-ci-fix', fx.scope, {
        goalId: 'source-goal-dir-swap',
        sessionId: String(fx.owner.session.id),
        nativeGoalId: 'native-source-goal-dir-swap',
        steps: [
          { id: 'step-create', toolName: 'write', arguments: { file_path: 'created.txt', content: 'created' } },
          { id: 'step-fail', toolName: 'edit', arguments: { file_path: 'b.txt', old_string: 'x', new_string: 'y' } },
        ],
      }))
      fx.service.save(fx.owner, 'source-goal-dir-swap', {
        name: 'genuine-dir-swap-fail',
        description: 'Rejects genuine directory swap on a previously created file.',
        compensation: 'rollback-state',
      })

      const runRes = await fx.execute('skill_run', {
        goal_id: 'fresh-goal-dir-swap',
        name: 'genuine-dir-swap-fail',
        version: 1,
        inputs_json: '{}',
        invocation_id: 'inv-dir-swap-1',
      })
      expect(runRes.isError).toBe(true)
      const runId = JSON.stringify(runRes).match(/skill-run-[a-f0-9]{64}/u)![0]
      const statusRes = await fx.execute('skill_status', { run_id: runId })
      const status = JSON.parse((statusRes.value as { context: string }).context)
      expect(status.state).toBe('failed')
      expect(status.compensations).toMatchObject([
        { stepId: 'step-create', status: 'failed', detail: 'rollback-target-unsafe' },
      ])
    }

    // 4) Negative in replaySkill: genuine post-step directory swap on a previously created file fails closed with rollback target unsafe
    {
      const stateRoot = await makeTempDir('skills-wp13-replay-dir-swap-')
      await chmod(stateRoot, 0o700)
      const scope = {
        principalId: 'owner',
        principalRecordId: 'record',
        principalVersion: 1,
        workspace: '/source-workspace',
        preset: 'primary',
      }
      const def = buildWorkflowSkillDefinition('repo-ci-fix', buildWorkflowSourceForTemplate('repo-ci-fix', scope, {
        steps: [
          { id: 'step-create', toolName: 'write', arguments: { file_path: 'created.txt', content: 'created' } },
          { id: 'step-swap-fail', toolName: 'wiki_upsert', arguments: { path: 'created.txt' } },
        ],
      }), {
        name: 'replay-genuine-dir-swap',
        bindings: [],
        allowedTools: ['write', 'wiki_upsert'],
        compensation: 'rollback-state',
        compensationPlan: {
          kind: 'rollback-state',
          entries: [{ stepId: 'step-create', capturePreimage: true }],
        },
      })
      await expect(replaySkill({
        definition: def,
        inputs: {},
        files: [],
        artifactPath: 'created.txt',
        stateRoot,
        maxToolCalls: 8,
        maxBytes: 32_768,
        signal: new AbortController().signal,
        authorize: () => {},
        domainToolHandlers: {
          wiki_upsert: {
            mutating: true,
            handler: async (_args, ctx) => {
              await unlink(join(ctx.root, 'created.txt'))
              await mkdir(join(ctx.root, 'created.txt'))
              throw new Error('simulated failure after dir swap')
            },
          },
        },
      })).rejects.toThrow(/rollback target unsafe/i)
      expect(await readdir(stateRoot)).toEqual([])
    }
  })
})
