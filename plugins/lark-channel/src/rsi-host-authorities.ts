import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, realpath, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { inspectTrustedExecutable, resolveTrustKey, validateSystemdHostAuthorityConfig,
  type PluginControlTrustConfig, type SourceAdoptionAuthorityConfig, type SystemdHostAuthorityConfig } from '@dsh-enhanced/plugin-control-plane'

type Pin = { path: string; sha256: string }
type Wrapper = { schemaVersion: 4; template: SystemdHostAuthorityConfig['template']; resolver: {
  executable: Pin; interpreter: Pin | null; configPath: string; configSha256: string; timeoutMs: number
} }

function fail(detail: string): never { throw new Error(`rsi setup: systemd Host authority ${detail}`) }
function exactFields(value: unknown, fields: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort())) fail('wrapper fields differ from runtime contract')
}
function hash(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex') }
async function pinned(spec: Pin): Promise<Buffer> {
  await inspectTrustedExecutable(spec.path, spec.sha256)
  return readFile(spec.path)
}
async function regularPin(spec: Pin, maximum = 268_435_456): Promise<void> {
  if (await realpath(spec.path) !== spec.path) fail('pinned file is not canonical')
  const stat = await lstat(spec.path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || (stat.mode & 0o022) !== 0
    || (stat.uid !== 0 && stat.uid !== process.getuid?.()) || hash(await readFile(spec.path)) !== spec.sha256) fail('pinned file changed')
}
async function privateDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path) fail('directory is not canonical')
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) fail('directory is not owner-private')
}

/** Read-only preflight for the schema-4 standing Host grant. The CP validator owns its schema. */
export async function validateRsiHostAuthorities(input: {
  trust: PluginControlTrustConfig
  adoption: SourceAdoptionAuthorityConfig
  owner: SystemdHostAuthorityConfig['grant']['owner']
  ledgerPath: string
  trustPath: string
  targetProfile: string
  liveQualification: unknown
  hostDeploymentInputs: unknown
  handoff: { coordinatorId: string } | undefined
  environment?: NodeJS.ProcessEnv
  readPrivate(path: string): Promise<string>
}): Promise<void> {
  const attestor = input.trust.hostAttestor!
  const configPath = (input.environment ?? process.env).DSH_SYSTEMD_HOST_ATTESTOR_CONFIG
  const allowed = attestor.environmentAllowlist.includes('DSH_SYSTEMD_HOST_ATTESTOR_CONFIG')
  if (!allowed) return // Existing owner-provisioned explicit request configs remain valid.
  if (!configPath) fail('config path is missing')
  const wrapperSource = await input.readPrivate(configPath)
  if (Buffer.byteLength(wrapperSource) > 65_536) fail('wrapper config exceeds runtime limit')
  const wrapper = JSON.parse(wrapperSource) as Wrapper
  if ([1, 2, 3].includes(wrapper.schemaVersion)) return // Existing explicit request configurations.
  if (wrapper.schemaVersion !== 4) fail('unknown wrapper schema')
  exactFields(wrapper, ['schemaVersion', 'template', 'resolver'])
  exactFields(wrapper.template, ['authority', 'keyId', 'privateKeyPath', 'stateRoot', 'executable', 'interpreter', 'processHelper',
    'systemctl', 'scope', 'unit', 'unitProperties', 'timeoutMs', 'stableWindowMs', 'pollIntervalMs', 'readiness', 'recoveryReadiness'])
  exactFields(wrapper.resolver, ['executable', 'interpreter', 'configPath', 'configSha256', 'timeoutMs'])
  exactFields(wrapper.resolver.executable, ['path', 'sha256'])
  if (wrapper.resolver.interpreter !== null) exactFields(wrapper.resolver.interpreter, ['path', 'sha256'])
  if (attestor.version !== 'dsh-systemd-host-attestor-6' || attestor.interpreter === null) fail('trust does not select the schema-4 wrapper')
  const resolver = wrapper.resolver
  if (!Number.isSafeInteger(resolver.timeoutMs) || resolver.timeoutMs < 1000 || resolver.timeoutMs > 60_000
    || resolver.timeoutMs + wrapper.template.timeoutMs >= attestor.timeoutMs) fail('timeouts cannot cover resolver and Host operation')
  const template = wrapper.template
  if (!isDeepStrictEqual({ authority: template.authority, keyId: template.keyId, executable: template.executable, interpreter: template.interpreter },
    { authority: attestor.authority, keyId: attestor.keyId, executable: { path: attestor.path, sha256: attestor.sha256 }, interpreter: attestor.interpreter })) fail('wrapper differs from trusted attestor')
  if (template.unit !== `dsh-profile-${input.targetProfile}.service`) fail('wrapper unit differs from target')
  const wrapperBytes = await pinned(template.executable)
  const nodeBytes = await pinned(template.interpreter)
  if (!wrapperBytes.subarray(0, 2).equals(Buffer.from('#!')) || !nodeBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    || wrapperBytes.toString('utf8', 0, 512).split('\n', 1)[0] !== `#!${template.interpreter.path}`) fail('attestor interpreter cannot run pinned wrapper')
  const version = spawnSync(template.interpreter.path, [template.executable.path, '--version'],
    { encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 1024 })
  if (version.error || version.status !== 0 || version.stdout.trim() !== attestor.version) fail('pinned wrapper version cannot run')
  await regularPin(template.processHelper, 1_048_576)
  await pinned({ path: template.systemctl.path, sha256: template.systemctl.sha256 })
  if (template.systemctl.interpreter) await pinned(template.systemctl.interpreter)
  await regularPin(template.readiness.client)
  await regularPin(template.recoveryReadiness.client)
  await pinned(resolver.executable)
  const interpreterBytes = resolver.interpreter ? await pinned(resolver.interpreter) : await readFile(resolver.executable.path)
  if (!interpreterBytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) fail('resolver requires a native pinned interpreter')
  // The shipped script has a relative compiled import. Inspect it when selected,
  // while preserving the runtime's native/custom resolver contract.
  if (resolver.executable.path.endsWith('/bin/dsh-systemd-host-authority.js')) {
    if (!resolver.interpreter) fail('shipped resolver requires a native interpreter')
    const node = spawnSync(resolver.interpreter.path, ['--input-type=module', '--eval', 'process.stdout.write(process.versions.node)'],
      { encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 1024 })
    if (node.error || node.status !== 0 || !/^\d+\.\d+\.\d+$/u.test(node.stdout)) fail('pinned interpreter cannot run shipped resolver')
    const syntax = spawnSync(resolver.interpreter.path, ['--check', resolver.executable.path],
      { encoding: 'utf8', env: { LANG: 'C', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 1024 })
    if (syntax.error || syntax.status !== 0) fail('pinned interpreter cannot parse shipped resolver')
    const resolverModule = join(dirname(resolver.executable.path), '../lib/systemd-host-authority.js')
    if (await realpath(resolverModule) !== resolverModule || !(await lstat(resolverModule)).isFile()) fail('resolver module is unavailable')
  }
  await privateDirectory(dirname(configPath))
  await privateDirectory(dirname(resolver.configPath))
  const bytes = await input.readPrivate(resolver.configPath)
  if (Buffer.byteLength(bytes) > 65_536) fail('resolver config exceeds runtime limit')
  if (hash(bytes) !== resolver.configSha256) fail('resolver config pin changed')
  const config: unknown = JSON.parse(bytes)
  validateSystemdHostAuthorityConfig(config)
  if (!isDeepStrictEqual(config.template, template) || config.trustPath !== input.trustPath
    || config.controlDatabasePath !== input.ledgerPath || config.grant.profile.name !== input.targetProfile
    || config.grant.profile.path !== input.adoption.grant.target.profilePath
    || !isDeepStrictEqual(config.grant.owner, input.owner)
    || !isDeepStrictEqual([...config.grant.packages].sort(), input.adoption.grant.policies.map(policy => policy.packageName).sort())
    || config.grant.coordinatorId !== input.handoff?.coordinatorId
    || !isDeepStrictEqual(config.grant.liveQualification, input.liveQualification)
    || !isDeepStrictEqual(config.grant.hostDeploymentInputs, input.hostDeploymentInputs)
    || !isDeepStrictEqual(config.grant.hostDeploymentInputs, input.adoption.grant.hostDeploymentInputs)
    || config.grant.expiresAt <= Date.now()
    || config.grant.notBefore > Date.now()) fail('grant deployment terms differ')
  const trusted = resolveTrustKey(input.trust, 'host-attestation', template.authority, template.keyId)
  const key = createPublicKey(createPrivateKey(await input.readPrivate(template.privateKeyPath))).export({ type: 'spki', format: 'der' })
  if (!key.equals(createPublicKey(trusted.publicKeyPem).export({ type: 'spki', format: 'der' }))) fail('signing key differs from trust')
  await privateDirectory(template.stateRoot)
  await privateDirectory(dirname(config.statePath))
}
