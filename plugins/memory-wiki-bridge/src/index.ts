import type { Context } from '@deepseek-ai/cordis'
import { Config, MemoryWikiBridgeService } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-memory-wiki-bridge'
export { Config, MemoryWikiBridgeService, version }
export * from './service.js'

export function apply(ctx: Context, config: import('./service.js').Config): void {
  new MemoryWikiBridgeService(ctx, config)
}

export default MemoryWikiBridgeService
