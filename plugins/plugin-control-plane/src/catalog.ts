import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

export interface CatalogEntry {
  id: string
  capabilities: string[]
  package: string
  version: string
  integrity: string
  /** Additional top-level bundles that must be installed with this candidate. */
  requires: readonly CatalogPackage[]
  authorities: string[]
  dshBaseline: string
}

export interface CatalogPackage {
  package: string
  version: string
  integrity: string
}

export interface CapabilityCatalog { schemaVersion: 1; entries: CatalogEntry[] }
export interface LoadedCapabilityCatalog {
  catalog: CapabilityCatalog
  digest: string
  provenance: 'owner-provided-integrity-pinned'
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const packagePattern = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const integrityPattern = /^sha512-[A-Za-z0-9+/=]+$/u

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() === '') throw new Error(`plugin-control-plane: ${label} must be a non-empty string`)
  return value.normalize('NFC').trim()
}

function textList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`plugin-control-plane: ${label} must be a non-empty string array`)
  }
  return [...new Set(value.map(item => item.normalize('NFC').trim()))].sort()
}

function catalogPackage(value: unknown, label: string): CatalogPackage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`plugin-control-plane: ${label} must be an object`)
  }
  const item = value as Partial<CatalogPackage>
  const packageName = text(item.package, `${label}.package`)
  const version = text(item.version, `${label}.version`)
  const integrity = text(item.integrity, `${label}.integrity`)
  if (!packagePattern.test(packageName) || !versionPattern.test(version) || !integrityPattern.test(integrity)) {
    throw new Error(`plugin-control-plane: ${label} must pin package, exact version, and sha512 integrity`)
  }
  return Object.freeze({ package: packageName, version, integrity })
}

function catalogRequirements(value: unknown, primary: CatalogPackage, label: string): readonly CatalogPackage[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new Error(`plugin-control-plane: ${label}.requires must be an array`)
  const seen = new Set<string>([primary.package])
  const entries = value.map((raw, index) => {
    const requirement = catalogPackage(raw, `${label}.requires[${index}]`)
    if (seen.has(requirement.package)) throw new Error(`plugin-control-plane: ${label}.requires contains duplicate package ${requirement.package}`)
    seen.add(requirement.package)
    return requirement
  })
  return Object.freeze(entries.sort((left, right) => left.package.localeCompare(right.package)))
}

export function parseCatalog(value: unknown): CapabilityCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('plugin-control-plane: catalog must be an object')
  const input = value as Partial<CapabilityCatalog>
  if (input.schemaVersion !== 1 || !Array.isArray(input.entries)) throw new Error('plugin-control-plane: unsupported catalog schema')
  const seen = new Set<string>()
  const entries = input.entries.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('plugin-control-plane: catalog entry must be an object')
    const item = raw as Partial<CatalogEntry>
    const id = text(item.id, 'entry id')
    const primary = catalogPackage(item, id)
    const baseline = text(item.dshBaseline, `${id}.dshBaseline`)
    if (!idPattern.test(id) || seen.has(id)) throw new Error(`plugin-control-plane: invalid or duplicate entry id ${id}`)
    if (!versionPattern.test(baseline)) throw new Error(`plugin-control-plane: entry ${id}.dshBaseline must be an exact DSH version`)
    seen.add(id)
    return Object.freeze({ id, ...primary, requires: catalogRequirements(item.requires, primary, id), dshBaseline: baseline,
      capabilities: textList(item.capabilities, `${id}.capabilities`), authorities: textList(item.authorities, `${id}.authorities`) })
  })
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries) as CatalogEntry[] })
}

export async function loadCatalog(path: string): Promise<CapabilityCatalog> {
  const metadata = await lstat(path)
  const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid)
    || await realpath(path) !== resolve(path)) {
    throw new Error('plugin-control-plane: owner catalog must be an owner-owned regular file without writable aliases or symlink traversal')
  }
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > 1_048_576) throw new Error('plugin-control-plane: catalog exceeds 1 MiB')
  return parseCatalog(JSON.parse(source) as unknown)
}

/**
 * Package-local example used by documentation and tests. It is deliberately
 * not a runtime fallback or trust source because it is not signature-verified.
 * Runtime discovery requires an owner-provided, integrity-pinned regular file.
 */
export const exampleIntegrityPinnedCatalog: CapabilityCatalog = parseCatalog({
  schemaVersion: 1,
  entries: [
    {
      id: 'coding-subscription-provider',
      capabilities: ['coding agent', 'codex', 'claude code', 'cursor', 'grok'],
      package: '@dsh-enhanced/coding-subscription-provider', version: '0.1.3',
      integrity: 'sha512-LMyIzx2NJrK7+ExsoB049fkLi4rJncYBU8Mn56ssWNBoW+LqtuzlofymwBHL2In7UPwHG3V+7MxBE0MjkrWmlQ==',
      authorities: ['filesystem: local coding-client credentials', 'subprocess: locally installed coding clients', 'network: configured provider route'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'traex-acp-provider',
      capabilities: ['coding agent', 'traex', 'acp', 'reasoning effort'],
      package: '@dsh-enhanced/traex-acp-provider', version: '0.1.3',
      integrity: 'sha512-qGoYNAcO/uNHw/WMzOTD6q3Z8hIC7HwMGrp996BrJGB5HpUayuz58oCjyYQQ+caREnb8vESS9DoaW5nOGpB9sA==',
      authorities: ['subprocess: local TraeX ACP client', 'network: TraeX-managed provider route'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'assistant-health',
      capabilities: ['health', 'readiness', 'liveness', 'diagnostics'],
      package: '@dsh-enhanced/assistant-health', version: '0.1.3',
      integrity: 'sha512-GcNqvjjSul+jrx52dFzxsKASPXUeMDi+ia40DXXI77rZQaqWc6O49iOPCXkrbo43pbsZmCY5cpjb1zLtWLkuQA==',
      authorities: ['read-only: mounted service health and diagnostics'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'assistant-heartbeat',
      capabilities: ['heartbeat', 'proactive check-in', 'active hours'],
      package: '@dsh-enhanced/assistant-heartbeat', version: '0.1.3',
      integrity: 'sha512-wXTOl2LAGg3fvnZ9rxiQTv6w8nxLsjODA74V5QipoYitm2hezx30obPQBWqEtpTym3dvC7AEVBTqgRLDWt+Ycw==',
      authorities: ['persistent schedule state', 'agent invocation during configured active hours'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'event-triggers',
      capabilities: ['events', 'webhook', 'file watch', 'https polling'],
      package: '@dsh-enhanced/event-triggers', version: '0.1.3',
      integrity: 'sha512-iMl6zwuYwFpqLq0nIGW59mcQlDvu8370ex9FRtTW7WwW5Ab40Hk7cbHTJ2UpZQj0yEBi0lraVD0t7boXopfigg==',
      authorities: ['filesystem: configured watched paths', 'network: configured HTTPS endpoints', 'network ingress: HMAC webhook endpoint'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'memory-wiki-bridge',
      capabilities: ['memory', 'wiki', 'knowledge promotion'],
      package: '@dsh-enhanced/memory-wiki-bridge', version: '0.1.3',
      integrity: 'sha512-vvsh72xDsxcyUZHT67T/nJgtN+h2uiXVG3ez+BovzFR/owFtLWjELbFZeV2TVvQJARRizcdEFqq6mIawCOovZw==',
      authorities: ['filesystem: configured personal Wiki vault', 'persistent proposal state'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'lark-assistant',
      capabilities: ['lark', 'feishu', 'chat channel', 'resident assistant'],
      package: '@dsh-enhanced/lark-channel', version: '0.1.3',
      integrity: 'sha512-CWwxX1cW2PYldWz/p3+EMG1VRwu1EzKyFS984sMq/tzY0a1TGjgZsLNOn0EHq2hpwCBdZd861gnmmKTqF7nwng==',
      requires: [
        { package: '@dsh-enhanced/assistant-delivery', version: '0.1.3', integrity: 'sha512-ZgPV8CYY0L5X7rUHG4b9/ulPlQi5PNnrDi8LPpTPj+y8Mc5oE7bbZQnKpniGkjEftmWK16GRlhx+A9Z00sYsTw==' },
        { package: '@dsh-enhanced/credentials-keychain', version: '0.1.3', integrity: 'sha512-g8OOFqnDwd0/SRldZmWN6f6FScD1llN+jdjRu4lLmZ1xdQ6nOacEGvUK4l1rCa89xNWkJVFdgQLuOC/e2VbDXw==' },
      ],
      authorities: ['network: Lark WebSocket and API', 'credentials: OS keychain/secret store', 'resident process: current-user service'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'supervised-evolution',
      capabilities: ['supervised growth', 'evolution', 'behaviour guidance'],
      package: '@dsh-enhanced/assistant-evolution', version: '0.1.3',
      integrity: 'sha512-WeerqdqJuqUNqCPb/QtTuvF4amJ3YlS/mJ0QoUlqt5Bygso2nz6K4o2vDF4MaDaIhjpuCR0KTiqFLXXQHAEEEg==',
      requires: [
        { package: '@dsh-enhanced/assistant-delivery', version: '0.1.3', integrity: 'sha512-ZgPV8CYY0L5X7rUHG4b9/ulPlQi5PNnrDi8LPpTPj+y8Mc5oE7bbZQnKpniGkjEftmWK16GRlhx+A9Z00sYsTw==' },
        { package: '@dsh-enhanced/credentials-keychain', version: '0.1.3', integrity: 'sha512-g8OOFqnDwd0/SRldZmWN6f6FScD1llN+jdjRu4lLmZ1xdQ6nOacEGvUK4l1rCa89xNWkJVFdgQLuOC/e2VbDXw==' },
        { package: '@dsh-enhanced/lark-channel', version: '0.1.3', integrity: 'sha512-CWwxX1cW2PYldWz/p3+EMG1VRwu1EzKyFS984sMq/tzY0a1TGjgZsLNOn0EHq2hpwCBdZd861gnmmKTqF7nwng==' },
        { package: '@dsh-enhanced/traex-acp-provider', version: '0.1.3', integrity: 'sha512-qGoYNAcO/uNHw/WMzOTD6q3Z8hIC7HwMGrp996BrJGB5HpUayuz58oCjyYQQ+caREnb8vESS9DoaW5nOGpB9sA==' },
      ],
      authorities: ['network: Lark approval channel', 'credentials: OS keychain/secret store', 'subprocess: local TraeX ACP client', 'persistent guidance and approval state'],
      dshBaseline: '0.1.0-rc.8',
    },
  ],
})

export async function loadCatalogWithMetadata(path: string): Promise<LoadedCapabilityCatalog> {
  const catalog = await loadCatalog(path)
  return Object.freeze({ catalog, digest: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'), provenance: 'owner-provided-integrity-pinned' })
}

export function discover(catalog: CapabilityCatalog, capability: string): CatalogEntry[] {
  const terms = capability.normalize('NFC').toLocaleLowerCase('en-US').trim().split(/\s+/u).filter(Boolean)
  if (terms.length === 0 || terms.length > 12) throw new Error('plugin-control-plane: capability query must contain 1..12 terms')
  return catalog.entries.filter(entry => {
    const haystack = `${entry.id} ${entry.capabilities.join(' ')}`.toLocaleLowerCase('en-US')
    return terms.every(term => haystack.includes(term))
  })
}

export function candidateDigest(entry: CatalogEntry, profile: string): string {
  return createHash('sha256').update(JSON.stringify({ entry, profile })).digest('hex')
}
