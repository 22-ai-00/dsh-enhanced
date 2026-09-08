import type { Context } from '@deepseek-ai/cordis'
import { AssistantSkillsService, Config } from './service.js'
import { version } from './version.js'
export const name = 'dsh-enhanced-assistant-skills'
export { version, AssistantSkillsService, Config }
export type * from './definition.js'
export type { SkillComparisonProfile } from './comparison.js'
export type { SkillComparison, SkillComparisonIdentity, SkillCandidate, SkillRun, StoredSkillDefinition } from './store.js'
export function apply(ctx: Context, config: Config = {}): void { new AssistantSkillsService(ctx, config) }
export default { name, Config, apply }
