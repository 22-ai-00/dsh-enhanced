import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { AssistantAutomationsService, type Config as AutomationsConfig } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService, type Config as PolicyConfig } from '@dsh-enhanced/assistant-policy'
import { PersonalMemoryService, type Config as MemoryConfig } from '@dsh-enhanced/personal-memory'
import { PersonalWikiService, type Config as WikiConfig } from '@dsh-enhanced/personal-wiki'
import { version } from './version.js'

export interface Config {
  assistantPolicy: PolicyConfig
  personalMemory: MemoryConfig
  personalWiki: WikiConfig
  assistantAutomations: AutomationsConfig
}

export const Config = Schema.object({
  assistantPolicy: AssistantPolicyService.Config.required(),
  personalMemory: PersonalMemoryService.Config.required(),
  personalWiki: PersonalWikiService.Config.required(),
  assistantAutomations: AssistantAutomationsService.Config.required(),
}) as Schema<Config>

export const name = 'dsh-enhanced-personal-assistant'
export { version }

export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = Config(input)
  await ctx.plugin(AssistantPolicyService, config.assistantPolicy)
  await ctx.plugin(PersonalMemoryService, config.personalMemory)
  await ctx.plugin(PersonalWikiService, config.personalWiki)
  await ctx.plugin(AssistantAutomationsService, config.assistantAutomations)
}
