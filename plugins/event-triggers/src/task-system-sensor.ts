import { createHash } from 'node:crypto'
import type { TaskSystemAuthScheme, TaskSystemFieldsConfig } from './config.js'
import {
  readHttpJsonWithMeta,
  selectJsonPointer,
  type Fetcher,
  type Lookup,
  type OperationTracker,
  type SensorObservation,
} from './sensors.js'
import type { TriggerCursor } from './store.js'

export interface TaskSystemObservationInput {
  url: string
  itemsPointer: string
  fields?: Readonly<Required<TaskSystemFieldsConfig>>
  statusFilter?: readonly string[]
  assigneeFilter?: readonly string[]
  since?: string
  maxItems: number
  token?: string
  authScheme?: TaskSystemAuthScheme
  cursor?: Readonly<TriggerCursor>
  hasBaseline?: boolean
  maxBodyBytes: number
  timeoutMs: number
  allowedHosts?: ReadonlySet<string>
  allowedOrigins?: ReadonlySet<string>
  allowIpv6?: boolean
  fetcher?: Fetcher
  lookup?: Lookup
  trackOperation?: OperationTracker
  signal?: AbortSignal
  beforeRequest?: () => void | Promise<void>
}

export interface TaskSystemObservation extends SensorObservation {
  readonly notModified?: boolean
  readonly nextCursor?: TriggerCursor
}

interface ProjectedTask {
  readonly id: string
  readonly status?: string
  readonly assignee?: string
  readonly updatedAt?: string
  readonly titleDigest?: string
}

const DEFAULT_FIELDS: Readonly<Required<TaskSystemFieldsConfig>> = Object.freeze({
  id: 'id',
  updatedAt: 'updatedAt',
  status: 'status',
  assignee: 'assignee',
  title: 'title',
})

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function boundedText(value: unknown, field: string, max = 512): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  if (typeof value !== 'string') {
    throw new Error(`event-triggers: task-system item ${field} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0 || normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error(`event-triggers: task-system item ${field} is invalid`)
  }
  return normalized
}

function optionalBoundedText(value: unknown, max = 256): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  if (typeof value !== 'string') throw new Error('event-triggers: task-system field must be a string')
  const normalized = value.normalize('NFC').trim()
  if (normalized.length === 0) return undefined
  if (normalized.length > max || /[\p{Cc}]/u.test(normalized)) {
    throw new Error('event-triggers: task-system field is invalid')
  }
  return normalized
}

function parseTimestampMs(value: string): number {
  if (/^[0-9]+$/u.test(value)) {
    const numeric = Number(value)
    if (!Number.isSafeInteger(numeric) || numeric < 0) {
      throw new Error('event-triggers: task-system timestamp is invalid')
    }
    return numeric
  }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error('event-triggers: task-system timestamp is invalid')
  }
  return ms
}

function optionalAssignee(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return optionalBoundedText(value, 256)
  if (isPlainObject(value)) {
    for (const key of ['id', 'email', 'username', 'name']) {
      if (value[key] !== undefined && value[key] !== null) {
        return optionalBoundedText(value[key], 256)
      }
    }
    return undefined
  }
  throw new Error('event-triggers: task-system assignee field is invalid')
}

export async function readTaskSystemObservation(input: TaskSystemObservationInput): Promise<TaskSystemObservation> {
  if (!Number.isSafeInteger(input.maxItems) || input.maxItems < 1 || input.maxItems > 500) {
    throw new Error('event-triggers: task-system maxItems is invalid')
  }
  if (input.signal?.aborted) {
    throw (input.signal.reason instanceof Error ? input.signal.reason : new Error('event-triggers: task-system sensor aborted'))
  }
  const fields = input.fields ?? DEFAULT_FIELDS
  const sinceMs = input.since !== undefined ? parseTimestampMs(input.since) : undefined
  const statusSet = input.statusFilter !== undefined ? new Set(input.statusFilter) : undefined
  const assigneeSet = input.assigneeFilter !== undefined ? new Set(input.assigneeFilter) : undefined

  const url = new URL(input.url)
  if (input.cursor?.syncToken !== undefined && !url.searchParams.has('syncToken')) {
    url.searchParams.set('syncToken', input.cursor.syncToken)
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  if (input.token !== undefined && input.token.length > 0) {
    if (input.authScheme === 'x-api-key') {
      headers['x-api-key'] = input.token
    } else {
      headers['authorization'] = `Bearer ${input.token}`
    }
  }

  await input.beforeRequest?.()
  const response = await readHttpJsonWithMeta({
    url: url.toString(),
    maxBodyBytes: input.maxBodyBytes,
    timeoutMs: input.timeoutMs,
    ...(input.allowedHosts === undefined ? {} : { allowedHosts: input.allowedHosts }),
    ...(input.allowedOrigins === undefined ? {} : { allowedOrigins: input.allowedOrigins }),
    ...(input.allowIpv6 === undefined ? {} : { allowIpv6: input.allowIpv6 }),
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.lookup === undefined ? {} : { lookup: input.lookup }),
    ...(input.trackOperation === undefined ? {} : { trackOperation: input.trackOperation }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    headers,
    rejectPagination: true,
    allowNotModified: Boolean(input.hasBaseline),
    ...(input.hasBaseline && input.cursor?.etag !== undefined ? { ifNoneMatch: input.cursor.etag } : {}),
  })
  await input.beforeRequest?.()

  if (response.notModified) {
    const nextCursor: TriggerCursor = {
      ...input.cursor,
      ...(response.etag === undefined ? {} : { etag: response.etag }),
    }
    return Object.freeze({
      fingerprint: '',
      truthy: true,
      notModified: true,
      ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
    })
  }

  const rawSyncToken = isPlainObject(response.value)
    ? optionalBoundedText(response.value['syncToken'] ?? response.value['nextSyncToken'], 1_024)
    : undefined

  const selected = selectJsonPointer(response.value, input.itemsPointer)
  if (!Array.isArray(selected)) {
    throw new Error('event-triggers: task-system itemsPointer must select an array')
  }
  if (selected.length > input.maxItems) {
    throw new Error('event-triggers: task-system response exceeds maxItems')
  }

  if (input.hasBaseline && input.cursor?.syncToken !== undefined && rawSyncToken === input.cursor.syncToken && selected.length === 0) {
    const nextCursor: TriggerCursor = {
      ...input.cursor,
      ...(response.etag === undefined ? {} : { etag: response.etag }),
      syncToken: rawSyncToken,
    }
    return Object.freeze({
      fingerprint: '',
      truthy: true,
      notModified: true,
      nextCursor: Object.freeze(nextCursor),
    })
  }

  const seenIds = new Set<string>()
  const projected: ProjectedTask[] = []
  let maxUpdatedMs: number | undefined
  let maxUpdatedStr: string | undefined

  for (const item of selected) {
    if (!isPlainObject(item)) {
      throw new Error('event-triggers: task-system item must be a plain object')
    }
    const id = boundedText(item[fields.id], 'id', 512)
    if (seenIds.has(id)) {
      throw new Error('event-triggers: task-system response contains duplicate task id')
    }
    seenIds.add(id)

    const status = optionalBoundedText(item[fields.status], 128)
    const assignee = optionalAssignee(item[fields.assignee])
    const updatedAt = optionalBoundedText(item[fields.updatedAt], 64)
    const updatedAtMs = updatedAt !== undefined ? parseTimestampMs(updatedAt) : undefined
    const rawTitle = item[fields.title]
    if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== 'string') {
      throw new Error('event-triggers: task-system title must be a string')
    }

    if (statusSet !== undefined && (status === undefined || !statusSet.has(status))) continue
    if (assigneeSet !== undefined && (assignee === undefined || !assigneeSet.has(assignee))) continue
    if (sinceMs !== undefined && (updatedAtMs === undefined || updatedAtMs < sinceMs)) continue

    if (updatedAtMs !== undefined && updatedAt !== undefined && (maxUpdatedMs === undefined || updatedAtMs > maxUpdatedMs)) {
      maxUpdatedMs = updatedAtMs
      maxUpdatedStr = updatedAt
    }

    const titleDigest = typeof rawTitle === 'string' && rawTitle.length > 0 ? sha256(rawTitle) : undefined
    projected.push(Object.freeze({
      id,
      ...(status === undefined ? {} : { status }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(titleDigest === undefined ? {} : { titleDigest }),
    }))
  }

  projected.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const fingerprint = `sha256:${sha256(JSON.stringify({ items: projected }))}`

  const nextCursor: TriggerCursor = {
    ...(response.etag === undefined ? {} : { etag: response.etag }),
    ...(rawSyncToken === undefined ? {} : { syncToken: rawSyncToken }),
    ...(maxUpdatedStr !== undefined ? { since: maxUpdatedStr } : (input.cursor?.since !== undefined ? { since: input.cursor.since } : {})),
  }

  return Object.freeze({
    fingerprint,
    truthy: projected.length > 0,
    ...(Object.keys(nextCursor).length === 0 ? {} : { nextCursor: Object.freeze(nextCursor) }),
  })
}
