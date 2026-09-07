import type { Agent } from '@deepseek-ai/dsh-agent'

export const STRATEGY_PROVIDER = 'assistant-goals-strategy/v1'

/** The native provider appends its hidden descriptor before the first request. */
export function strategyDescriptor(agent: Agent): { version: number; mode: string; provider: string; label?: string } | undefined {
  const event = agent.session.snapshotEvents().find(value => String(value.type) === 'subagent/descriptor')
  return event?.data as { version: number; mode: string; provider: string; label?: string } | undefined
}

export function isStrategyChild(agent: Agent): boolean {
  return strategyDescriptor(agent)?.provider === STRATEGY_PROVIDER
}
