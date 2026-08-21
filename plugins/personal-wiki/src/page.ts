import { createHash, randomBytes } from 'node:crypto'
import type {
  WikiPage,
  WikiPageAuthority,
  WikiPageInput,
  WikiPageMetadata,
  WikiPageStatus,
  WikiPageType,
  WikiSource,
} from './types.js'

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const SHA256 = /^[a-f0-9]{64}$/
const PAGE_TYPES = new Set<WikiPageType>([
  'concept', 'decision', 'meta', 'person', 'project', 'question', 'source',
])
const AUTHORITIES = new Set<WikiPageAuthority>(['curated', 'derived'])
const STATUSES = new Set<WikiPageStatus>(['active', 'archived', 'draft'])
const FRONTMATTER_KEYS = new Set([
  'aliases', 'authority', 'created', 'derivedFrom', 'id', 'sources', 'status', 'tags', 'title', 'type', 'updated',
])
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export class WikiPageError extends Error {
  constructor(readonly code: 'invalid-frontmatter' | 'invalid-page', message: string) {
    super(message)
    this.name = 'WikiPageError'
  }
}

function encodeBase32(value: bigint, length: number): string {
  let remaining = value
  let output = ''
  for (let index = 0; index < length; index += 1) {
    output = CROCKFORD[Number(remaining & 31n)] + output
    remaining >>= 5n
  }
  return output
}

export function createPageId(now: number, entropy: Uint8Array = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new WikiPageError('invalid-page', 'page timestamp is outside the ULID range')
  }
  if (entropy.length !== 10) throw new WikiPageError('invalid-page', 'page id entropy must be 10 bytes')
  let random = 0n
  for (const byte of entropy) random = (random << 8n) | BigInt(byte)
  return encodeBase32(BigInt(now), 10) + encodeBase32(random, 16)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WikiPageError('invalid-page', `${field} must be a non-empty string`)
  }
  return value.normalize('NFC').trim()
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new WikiPageError('invalid-page', `${field} must be an array`)
  const normalized = value.map(item => text(item, field))
  const folded = new Set<string>()
  for (const item of normalized) {
    const key = item.normalize('NFKC').toLocaleLowerCase('en-US')
    if (folded.has(key)) throw new WikiPageError('invalid-page', `${field} contains a duplicate`)
    folded.add(key)
  }
  return normalized
}

function sources(value: unknown): WikiSource[] {
  if (!Array.isArray(value)) throw new WikiPageError('invalid-page', 'sources must be an array')
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new WikiPageError('invalid-page', 'source must be an object')
    }
    const source = item as Record<string, unknown>
    if (Object.keys(source).some(key => key !== 'sha256' && key !== 'uri')) {
      throw new WikiPageError('invalid-page', 'source contains an unknown field')
    }
    const uri = text(source['uri'], 'source uri')
    const sha256 = text(source['sha256'], 'source sha256').toLocaleLowerCase('en-US')
    if (!SHA256.test(sha256)) throw new WikiPageError('invalid-page', 'source sha256 must be 64 lowercase hex')
    return Object.freeze({ uri, sha256 })
  })
}

function timestamp(value: unknown, field: string): string {
  const normalized = text(value, field)
  if (!Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) {
    throw new WikiPageError('invalid-page', `${field} must be a canonical ISO timestamp`)
  }
  return normalized
}

export function validatePageInput(input: WikiPageInput): WikiPageInput {
  const title = text(input.title, 'title')
  if (!PAGE_TYPES.has(input.type)) throw new WikiPageError('invalid-page', 'invalid page type')
  if (!AUTHORITIES.has(input.authority)) throw new WikiPageError('invalid-page', 'invalid page authority')
  if (!STATUSES.has(input.status)) throw new WikiPageError('invalid-page', 'invalid page status')
  const tags = stringList(input.tags, 'tags')
  const aliases = stringList(input.aliases, 'aliases')
  const pageSources = sources(input.sources)
  const derivedFrom = input.derivedFrom === undefined ? undefined : stringList(input.derivedFrom, 'derivedFrom')
  if (derivedFrom?.some(id => !ULID.test(id))) {
    throw new WikiPageError('invalid-page', 'derivedFrom must contain page ULIDs')
  }
  if (input.authority === 'derived' && pageSources.length === 0 && (derivedFrom?.length ?? 0) === 0) {
    throw new WikiPageError('invalid-page', 'derived pages require direct source evidence')
  }
  if (typeof input.body !== 'string') throw new WikiPageError('invalid-page', 'body must be a string')
  return Object.freeze({
    title,
    type: input.type,
    authority: input.authority,
    status: input.status,
    tags: Object.freeze(tags) as unknown as string[],
    aliases: Object.freeze(aliases) as unknown as string[],
    sources: Object.freeze(pageSources) as unknown as WikiSource[],
    ...(derivedFrom === undefined ? {} : { derivedFrom: Object.freeze(derivedFrom) as unknown as string[] }),
    body: input.body.normalize('NFC'),
  })
}

export function validateMetadata(value: unknown): WikiPageMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WikiPageError('invalid-frontmatter', 'frontmatter must be an object')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !FRONTMATTER_KEYS.has(key))) {
    throw new WikiPageError('invalid-frontmatter', 'frontmatter contains an unknown field')
  }
  const id = text(input['id'], 'id')
  if (!ULID.test(id)) throw new WikiPageError('invalid-page', 'page id must be a ULID')
  const created = timestamp(input['created'], 'created')
  const updated = timestamp(input['updated'], 'updated')
  if (Date.parse(updated) < Date.parse(created)) {
    throw new WikiPageError('invalid-page', 'page updated timestamp precedes created')
  }
  const page = validatePageInput({
    title: input['title'] as string,
    type: input['type'] as WikiPageType,
    authority: input['authority'] as WikiPageAuthority,
    status: input['status'] as WikiPageStatus,
    tags: input['tags'] as string[],
    aliases: input['aliases'] as string[],
    sources: input['sources'] as WikiSource[],
    ...(input['derivedFrom'] === undefined ? {} : { derivedFrom: input['derivedFrom'] as string[] }),
    body: '',
  })
  return Object.freeze({
    id,
    title: page.title,
    type: page.type,
    authority: page.authority,
    status: page.status,
    tags: page.tags,
    aliases: page.aliases,
    sources: page.sources,
    ...(page.derivedFrom === undefined ? {} : { derivedFrom: page.derivedFrom }),
    created,
    updated,
  })
}

export function serializePage(metadata: WikiPageMetadata, body: string): string {
  const document = {
    id: metadata.id,
    title: metadata.title,
    type: metadata.type,
    authority: metadata.authority,
    status: metadata.status,
    tags: metadata.tags,
    aliases: metadata.aliases,
    sources: metadata.sources,
    ...(metadata.derivedFrom === undefined ? {} : { derivedFrom: metadata.derivedFrom }),
    created: metadata.created,
    updated: metadata.updated,
  }
  return `---\n${JSON.stringify(document, null, 2)}\n---\n${body}`
}

export function parsePage(markdown: string, relativePath: string): WikiPage {
  if (!markdown.startsWith('---\n')) {
    throw new WikiPageError('invalid-frontmatter', 'page must start with frontmatter')
  }
  const boundary = markdown.indexOf('\n---\n', 4)
  if (boundary < 0) throw new WikiPageError('invalid-frontmatter', 'page frontmatter is not closed')
  let decoded: unknown
  try {
    decoded = JSON.parse(markdown.slice(4, boundary))
  } catch (error) {
    throw new WikiPageError('invalid-frontmatter', `page frontmatter is not valid JSON-compatible YAML: ${String(error)}`)
  }
  const metadata = validateMetadata(decoded)
  const body = markdown.slice(boundary + 5).normalize('NFC')
  return Object.freeze({
    metadata,
    body,
    relativePath,
    revision: createHash('sha256').update(markdown).digest('hex'),
  })
}

export function pageSlug(title: string): string {
  const slug = title.normalize('NFKD').toLocaleLowerCase('en-US')
    .replaceAll(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 60)
  return slug === '' ? 'page' : slug
}
