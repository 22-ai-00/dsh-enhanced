import type { Context } from '@deepseek-ai/cordis'
import { PluginControlPlaneService, type Config } from './service.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-plugin-control-plane'
export { PluginControlPlaneService, version }
export { Config } from './service.js'
export * from './catalog.js'
export * from './service.js'

export function apply(ctx: Context, config: Config): void {
  new PluginControlPlaneService(ctx, config)
}

export default PluginControlPlaneService
