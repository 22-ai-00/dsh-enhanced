import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  AssistantAutomationsService,
  AutomationRecord,
  SystemAutomationReconcileInput,
} from '@dsh-enhanced/assistant-automations'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import {
  ConfigSchema,
  heartbeatDefinition,
  heartbeatRevision,
  normalizeHeartbeatConfig,
  type Config,
  type HeartbeatConfig,
  type NormalizedHeartbeatConfig,
} from './config.js'
import { HeartbeatScratch } from './scratch.js'
import { registerHeartbeatTools } from './tools.js'

export type AssistantHeartbeatErrorCode =
  | 'disposed'
  | 'identity-mismatch'
  | 'not-found'
  | 'policy-denied'

export class AssistantHeartbeatError extends Error {
  constructor(readonly code: AssistantHeartbeatErrorCode, message: string) {
    super(message)
    this.name = 'AssistantHeartbeatError'
  }
}

export interface HeartbeatStatus {
  id: string
  automationId: string
  status: 'active' | 'paused'
  empty: boolean
  revision: string
  automationVersion: number
}

interface Entry {
  profile: NormalizedHeartbeatConfig
  scratch: HeartbeatScratch
  automation: AutomationRecord
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantHeartbeat: AssistantHeartbeatService
  }
}

function policyDenied(decision: PolicyDecision): AssistantHeartbeatError {
  return new AssistantHeartbeatError('policy-denied', `assistant-heartbeat policy denied operation: ${decision.reasonCode}`)
}

export class AssistantHeartbeatService extends Service {
  static Config = ConfigSchema

  private readonly policy: AssistantPolicyService
  private readonly automations: AssistantAutomationsService
  private readonly entries = new Map<string, Entry>()
  private active = true

  constructor(ctx: Context, input: Config) {
    super(ctx, 'assistantHeartbeat')
    const config = normalizeHeartbeatConfig(input)
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    const automations = ctx.get('assistantAutomations') as AssistantAutomationsService | undefined
    if (policy === undefined || automations === undefined) {
      throw new Error('assistant-heartbeat: assistantPolicy and assistantAutomations services are required')
    }
    this.policy = policy
    this.automations = automations
    for (const profile of config.heartbeats) {
      const scratch = new HeartbeatScratch({
        path: profile.scratchPath,
        maxBytes: config.maxScratchBytes,
        initialContent: profile.initialScratch,
      })
      const automation = this.reconcile(profile, scratch)
      this.entries.set(profile.id, { profile, scratch, automation })
    }
    ctx.inject(['tools'], toolsCtx => registerHeartbeatTools(toolsCtx, this))
    ctx.effect(() => () => { this.active = false }, 'assistant-heartbeat.runtime')
  }

  status(agent: Agent | undefined, heartbeatId: string): HeartbeatStatus {
    const entry = this.authorize(agent, heartbeatId, 'inspect')
    return this.publicStatus(entry)
  }

  updateScratch(agent: Agent | undefined, input: {
    heartbeatId: string
    expectedRevision: string
    content: string
  }): HeartbeatStatus {
    const entry = this.authorize(agent, input.heartbeatId, 'update')
    entry.scratch.write({ expectedRevision: input.expectedRevision, content: input.content })
    entry.automation = this.reconcile(entry.profile, entry.scratch)
    return this.publicStatus(entry)
  }

  health(): { active: number; paused: number; empty: number } {
    this.assertActive()
    const values = [...this.entries.values()].map(entry => ({
      active: entry.automation.status === 'active',
      empty: entry.scratch.read().empty,
    }))
    return {
      active: values.filter(value => value.active).length,
      paused: values.filter(value => !value.active).length,
      empty: values.filter(value => value.empty).length,
    }
  }

  private authorize(agent: Agent | undefined, heartbeatId: string, action: 'inspect' | 'update'): Entry {
    this.assertActive()
    const entry = this.entries.get(heartbeatId)
    if (entry === undefined) throw new AssistantHeartbeatError('not-found', 'heartbeat configuration was not found')
    const workspace = agent?.session.header.cwd
    const preset = agent?.session.header.agentPreset
    if (workspace !== entry.profile.workspace || preset !== entry.profile.agentPreset) {
      throw new AssistantHeartbeatError('identity-mismatch', 'heartbeat requires its exact workspace and agent preset')
    }
    const decision = this.policy.authorizeAgent(
      agent,
      action,
      { kind: 'automation', id: `heartbeat:${entry.profile.id}` },
    )
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return entry
  }

  private reconcile(profile: NormalizedHeartbeatConfig, scratch: HeartbeatScratch): AutomationRecord {
    const snapshot = scratch.read()
    const desiredStatus = profile.enabled && !snapshot.empty ? 'active' : 'paused'
    const input: SystemAutomationReconcileInput = {
      owner: 'assistant-heartbeat',
      automationId: `heartbeat:${profile.id}`,
      idempotencyKey: heartbeatRevision(profile, snapshot.revision),
      desiredStatus,
      definition: heartbeatDefinition(profile, snapshot.content, snapshot.revision),
    }
    return this.automations.reconcileSystem(input)
  }

  private publicStatus(entry: Entry): HeartbeatStatus {
    const snapshot = entry.scratch.read()
    return Object.freeze({
      id: entry.profile.id,
      automationId: entry.automation.id,
      status: entry.automation.status === 'active' ? 'active' : 'paused',
      empty: snapshot.empty,
      revision: snapshot.revision,
      automationVersion: entry.automation.version,
    })
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantHeartbeatError('disposed', 'assistant-heartbeat service is disposed')
  }
}

export { ConfigSchema as Config }
export type { Config as AssistantHeartbeatConfig, HeartbeatConfig }
