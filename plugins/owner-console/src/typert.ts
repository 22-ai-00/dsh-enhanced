import { z } from 'zod'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

const codec = <T>(typeSymbol: string, create: () => z.ZodType<T>) => ({ mode: 'strict' as const, typeSymbol, create })

const dependency = z.object({ name: z.string().min(1), available: z.boolean() }).readonly()
const bundle = z.object({ entry: z.string().min(1), enabled: z.boolean() }).readonly()
export const OwnerConsoleStatusSchema = z.object({
  feishu: z.object({
    entry: z.string().min(1).optional(),
    mode: z.enum(['lark-cli', 'app']),
    enabled: z.boolean(),
    appIdConfigured: z.boolean(),
    connected: z.boolean(),
    setupCommand: z.string().min(1),
  }).readonly(),
  traex: z.object({ entry: z.string().min(1).optional(), enabled: z.boolean(), command: z.string() }).readonly(),
  dependencies: z.array(dependency).readonly(),
  bundles: z.array(bundle).readonly(),
}).readonly()
export type OwnerConsoleStatus = Readonly<z.infer<typeof OwnerConsoleStatusSchema>>

export const WRITE_RESULT = z.object({ applied: z.boolean(), entry: z.string(), note: z.string() }).readonly()
export type OwnerConsoleWriteResult = Readonly<z.infer<typeof WRITE_RESULT>>

/** Strict Host and client descriptors: one read plus owner-clicked one-step writes. */
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
      id: '@dsh-enhanced/owner-console#ownerConsole/configureFeishu',
      service: 'ownerConsole', namespace: 'ownerConsole', method: 'configureFeishu',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'mode', wire: 'mode', source: 'json', codec: codec('owner-console#mode', () => z.enum(['lark-cli', 'app'])) },
        { name: 'appId', wire: 'appId', source: 'json', codec: codec('owner-console#appId', () => z.string().max(64)) },
        { name: 'appSecretEnv', wire: 'appSecretEnv', source: 'json', codec: codec('owner-console#appSecretEnv', () => z.string().max(128)) },
        { name: 'credentialHandle', wire: 'credentialHandle', source: 'json', codec: codec('owner-console#credentialHandle', () => z.string().max(128)) },
        { name: 'account', wire: 'account', source: 'json', codec: codec('owner-console#account', () => z.string().max(128)) },
        { name: 'tenant', wire: 'tenant', source: 'json', codec: codec('owner-console#tenant', () => z.string().max(128)) },
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
  ],
  model: { services: [], events: [], objects: [] },
} satisfies TypertContribution

/** The generated client shape is bundled into the Web module by build-client. */
export const TYPERT_REMOTE = { package: TYPERT.package, descriptors: TYPERT.invocations }
