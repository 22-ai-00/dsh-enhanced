import { execFile as nodeExecFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { buildSubscriptionEnv } from './process.js'
import { version } from './version.js'

export interface SubscriptionCatalogInvocation {
  readonly command: string
  readonly cwd: string
}

export interface SubscriptionCatalogReasoningEffort {
  readonly id: string
  readonly name: string
  readonly description?: string
}

export interface SubscriptionCatalogModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly reasoning?: {
    readonly efforts: readonly SubscriptionCatalogReasoningEffort[]
    readonly defaultEffort?: string
  }
  readonly inputModalities: readonly string[]
}

export interface SubscriptionCatalog {
  readonly models: readonly SubscriptionCatalogModel[]
  readonly defaultModel?: string
  readonly observedAt: number
}

export interface CatalogCommandResult {
  readonly exitCode: number
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

export interface CatalogCommandOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly extraEnvNames: readonly string[]
  readonly stdin: string
  readonly signal?: AbortSignal
}

export type CatalogCommandRunner = (
  command: string,
  args: readonly string[],
  options: CatalogCommandOptions,
) => Promise<CatalogCommandResult>

export interface DiscoverSubscriptionCatalogOptions {
  readonly runCommand?: CatalogCommandRunner
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly extraEnvNames?: readonly string[]
}

const CLAUDE_REQUEST_ID = 'dsh-model-catalog'
const GROK_REQUEST_ID = 1
const defaults = { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }
const effortDescriptions: Readonly<Record<string, string>> = {
  low: 'Minimal reasoning, fastest responses',
  medium: 'Balanced reasoning depth and latency',
  high: 'Deep reasoning for complex tasks',
  xhigh: 'Extra-high reasoning depth',
  max: 'Maximum reasoning effort',
}

const claudeArgs = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode',
  '--permission-mode', 'dontAsk',
  '--tools', '',
] as const

export async function discoverClaudeModels(
  invocation: SubscriptionCatalogInvocation,
  options: DiscoverSubscriptionCatalogOptions = {},
): Promise<SubscriptionCatalog> {
  const result = await execute(invocation, claudeArgs, `${JSON.stringify({
    type: 'control_request',
    request_id: CLAUDE_REQUEST_ID,
    request: { subtype: 'initialize' },
  })}\n`, options)
  const messages = parseJsonLines(result.stdout)
  const envelope = messages.find(message => {
    const candidate = jsonObject(message)
    const response = jsonObject(candidate?.response)
    return candidate?.type === 'control_response' && response?.request_id === CLAUDE_REQUEST_ID
  })
  const outer = jsonObject(jsonObject(envelope)?.response)
  const payload = jsonObject(outer?.response)
  if (outer?.subtype !== 'success' || !Array.isArray(payload?.models)) throw catalogError('protocol')

  const models = disambiguateClaudeModelNames(payload.models.map(parseClaudeModel))
  validateModels(models)
  return {
    models,
    ...(models.some(model => model.id === 'default') ? { defaultModel: 'default' } : {}),
    observedAt: Date.now(),
  }
}

export async function discoverGrokModels(
  invocation: SubscriptionCatalogInvocation,
  options: DiscoverSubscriptionCatalogOptions = {},
): Promise<SubscriptionCatalog> {
  const result = await execute(invocation, ['agent', 'stdio'], `${JSON.stringify({
    jsonrpc: '2.0',
    id: GROK_REQUEST_ID,
    method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-enhanced', title: 'DSH Enhanced', version },
    },
  })}\n`, options)
  const messages = parseJsonLines(result.stdout)
  const envelope = messages.map(jsonObject).find(message => message?.jsonrpc === '2.0' && message.id === GROK_REQUEST_ID)
  const initialized = jsonObject(envelope?.result)
  const meta = jsonObject(initialized?._meta)
  const modelState = jsonObject(meta?.modelState)
  if (initialized?.protocolVersion !== 1 || typeof modelState?.currentModelId !== 'string'
    || !Array.isArray(modelState.availableModels)) {
    throw catalogError('protocol')
  }
  const models = modelState.availableModels.map(parseGrokModel)
  validateModels(models)
  if (!models.some(model => model.id === modelState.currentModelId)) throw catalogError('protocol')
  return { models, defaultModel: modelState.currentModelId, observedAt: Date.now() }
}

export async function discoverCursorModels(
  invocation: SubscriptionCatalogInvocation,
  options: DiscoverSubscriptionCatalogOptions = {},
): Promise<SubscriptionCatalog> {
  const result = await execute(invocation, ['--list-models'], '', options)
  const lines = stripAnsi(result.stdout).split(/\r?\n/)
  const header = lines.findIndex(line => /^\s*available models\s*:\s*$/i.test(line))
  if (header < 0) throw catalogError('protocol')
  let defaultModel: string | undefined
  const models: SubscriptionCatalogModel[] = []
  for (const line of lines.slice(header + 1)) {
    if (line.trim().length === 0) continue
    const match = /^\s*[*•-]\s+([A-Za-z0-9][A-Za-z0-9._:/+-]*)(?:\s+\((default)\))?\s*$/.exec(line)
    if (match === null) throw catalogError('protocol')
    const id = match[1]!
    if (match[2] !== undefined || id.toLowerCase() === 'auto') {
      if (defaultModel !== undefined && defaultModel !== id) throw catalogError('protocol')
      defaultModel = id
    }
    models.push({ id, name: id, inputModalities: ['text'] })
  }
  validateModels(models)
  return { models, ...(defaultModel === undefined ? {} : { defaultModel }), observedAt: Date.now() }
}

export const runCatalogCommand: CatalogCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
  let settled = false
  const settle = (operation: () => void): void => {
    if (settled) return
    settled = true
    operation()
  }
  const child = nodeExecFile(command, [...args], {
    cwd: options.cwd,
    env: buildSubscriptionEnv(options.extraEnvNames),
    encoding: 'utf8',
    maxBuffer: options.maxOutputBytes,
    timeout: options.timeoutMs,
    signal: options.signal,
    shell: false,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    if (error === null) {
      settle(() => resolve({ exitCode: 0, signal: null, stdout, stderr }))
      return
    }
    if (options.signal?.aborted) {
      settle(() => reject(abortError(options.signal!)))
      return
    }
    if (error.killed) {
      settle(() => reject(catalogError('timeout')))
      return
    }
    if (error.code === 'ENOENT') {
      settle(() => reject(error))
      return
    }
    if (typeof error.code === 'number') {
      settle(() => resolve({
        exitCode: error.code as number,
        signal: error.signal as NodeJS.Signals | null,
        stdout,
        stderr,
      }))
      return
    }
    settle(() => reject(new Error('subscription model catalog exceeded its safety limit', { cause: 'output-limit' })))
  })
  child.stdin?.once('error', error => settle(() => reject(error)))
  child.stdin?.end(options.stdin)
})

async function execute(
  invocation: SubscriptionCatalogInvocation,
  args: readonly string[],
  stdin: string,
  options: DiscoverSubscriptionCatalogOptions,
): Promise<CatalogCommandResult> {
  if (invocation.command.trim().length === 0 || !isAbsolute(invocation.cwd)) throw catalogError('protocol')
  if (options.signal?.aborted) throw abortError(options.signal)
  const result = await (options.runCommand ?? runCatalogCommand)(invocation.command, args, {
    cwd: invocation.cwd,
    timeoutMs: positiveInteger(options.timeoutMs, defaults.timeoutMs),
    maxOutputBytes: positiveInteger(options.maxOutputBytes, defaults.maxOutputBytes),
    extraEnvNames: options.extraEnvNames ?? [],
    stdin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (result.exitCode !== 0 || result.signal !== null) throw catalogError('process-exit')
  return result
}

function parseClaudeModel(value: unknown): SubscriptionCatalogModel {
  const model = jsonObject(value)
  if (typeof model?.value !== 'string' || model.value.length === 0
    || typeof model.displayName !== 'string' || model.displayName.length === 0
    || typeof model.description !== 'string') {
    throw catalogError('protocol')
  }
  let reasoning: SubscriptionCatalogModel['reasoning']
  if (model.supportsEffort === true) {
    if (!Array.isArray(model.supportedEffortLevels) || model.supportedEffortLevels.length === 0) throw catalogError('protocol')
    const efforts = model.supportedEffortLevels.map(value => {
      if (typeof value !== 'string' || effortDescriptions[value] === undefined) throw catalogError('protocol')
      return { id: value, name: displayEffort(value), description: effortDescriptions[value] }
    })
    if (new Set(efforts.map(effort => effort.id)).size !== efforts.length) throw catalogError('protocol')
    reasoning = { efforts }
  } else if (model.supportsEffort !== false && model.supportsEffort !== undefined) {
    throw catalogError('protocol')
  }
  return {
    id: model.value,
    name: model.displayName,
    ...(model.description.length === 0 ? {} : { description: model.description }),
    ...(reasoning === undefined ? {} : { reasoning }),
    inputModalities: ['text'],
  }
}

function disambiguateClaudeModelNames(
  models: readonly SubscriptionCatalogModel[],
): readonly SubscriptionCatalogModel[] {
  const counts = new Map<string, number>()
  for (const model of models) counts.set(model.name, (counts.get(model.name) ?? 0) + 1)
  return models.map(model => counts.get(model.name) === 1
    ? model
    : { ...model, name: `${displayEffort(model.id)} (${model.name})` })
}

function parseGrokModel(value: unknown): SubscriptionCatalogModel {
  const model = jsonObject(value)
  const meta = jsonObject(model?._meta)
  if (typeof model?.modelId !== 'string' || model.modelId.length === 0
    || typeof model.name !== 'string' || model.name.length === 0
    || (model.description !== undefined && typeof model.description !== 'string')
    || typeof meta?.supportsReasoningEffort !== 'boolean') {
    throw catalogError('protocol')
  }
  let reasoning: SubscriptionCatalogModel['reasoning']
  if (meta.supportsReasoningEffort) {
    if (!Array.isArray(meta.reasoningEfforts) || meta.reasoningEfforts.length === 0
      || typeof meta.reasoningEffort !== 'string') {
      throw catalogError('protocol')
    }
    const efforts = meta.reasoningEfforts.map(value => {
      const effort = jsonObject(value)
      if (typeof effort?.id !== 'string' || effort.id.length === 0 || effort.value !== effort.id
        || typeof effort.label !== 'string' || effort.label.length === 0
        || (effort.description !== undefined && typeof effort.description !== 'string')) {
        throw catalogError('protocol')
      }
      return {
        id: effort.id,
        name: effort.label,
        ...(typeof effort.description === 'string' && effort.description.length > 0
          ? { description: effort.description }
          : {}),
      }
    })
    if (new Set(efforts.map(effort => effort.id)).size !== efforts.length
      || !efforts.some(effort => effort.id === meta.reasoningEffort)) {
      throw catalogError('protocol')
    }
    reasoning = { efforts, defaultEffort: meta.reasoningEffort }
  }
  return {
    id: model.modelId,
    name: model.name,
    ...(typeof model.description === 'string' && model.description.length > 0
      ? { description: model.description }
      : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    inputModalities: ['text'],
  }
}

function parseJsonLines(value: string): unknown[] {
  const lines = value.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length === 0) throw catalogError('protocol')
  try {
    return lines.map(line => JSON.parse(line) as unknown)
  } catch {
    throw catalogError('protocol')
  }
}

function validateModels(models: readonly SubscriptionCatalogModel[]): void {
  if (models.length === 0 || new Set(models.map(model => model.id)).size !== models.length) throw catalogError('protocol')
}

function displayEffort(value: string): string {
  return value.split(/[-_]/).map(part => part.length === 0 ? part : `${part[0]!.toUpperCase()}${part.slice(1)}`).join(' ')
}

function stripAnsi(value: string): string {
  const escape = String.fromCodePoint(0x1b)
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw catalogError('protocol')
  return value
}

function catalogError(cause: 'protocol' | 'timeout' | 'process-exit'): Error {
  return new Error(`subscription model catalog ${cause}`, { cause })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('subscription model catalog aborted', { cause: 'abort' })
}
