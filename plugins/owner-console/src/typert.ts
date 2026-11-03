import { z } from 'zod'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

const status = z.object({
  feishu: z.object({
    mode: z.enum(['lark-cli', 'app']),
    connected: z.boolean(),
    appIdConfigured: z.boolean(),
  }).readonly(),
  traex: z.object({ enabled: z.boolean() }).readonly(),
  dependencies: z.array(z.object({ name: z.string().min(1), available: z.boolean() }).readonly()).readonly(),
}).readonly()

/** Strict Host and client descriptor for the read-only console status. */
export const TYPERT = {
  package: '@dsh-enhanced/owner-console',
  face: 'host',
  schemas: [],
  invocations: [{
    id: '@dsh-enhanced/owner-console#ownerConsole/status',
    service: 'ownerConsole',
    namespace: 'ownerConsole',
    method: 'status',
    invocation: { kind: 'direct' },
    parameters: [],
    result: {
      mode: 'strict',
      typeSymbol: '@dsh-enhanced/owner-console#OwnerConsoleStatus',
      create: () => status,
    },
    sourceLocation: { file: 'plugins/owner-console/src/typert.ts', line: 20, column: 3 },
  }],
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution

export type OwnerConsoleStatus = Readonly<z.infer<typeof status>>

/** The generated client shape is bundled into the Web module by build-client. */
export const TYPERT_REMOTE = {
  package: TYPERT.package,
  descriptors: TYPERT.invocations,
}
