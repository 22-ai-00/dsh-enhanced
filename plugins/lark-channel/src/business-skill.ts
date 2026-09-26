import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path'
import { parse as parseYaml, stringify } from 'yaml'
import { LARK_BUSINESS_CLEARED_ENV } from './business-environment.js'

export interface LarkBusinessSkillInput {
  dshHome: string
  profile: string
  account: string
  cliCommand: string
  cliProfile: string
  cliConfigDir: string
  cliDataDir: string
  ownerUserId: string
  appId: string
  platform?: NodeJS.Platform
}

export interface LarkBusinessSkillReconcileInput {
  dshHome: string
  profile: string
  account: string
  appId: string
  ownerUserId: string
  enabled: boolean
  previousAccount?: string
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const ownerPattern = /^ou_[A-Za-z0-9_-]{1,124}$/u
const appIdPattern = /^cli_[0-9a-fA-F]{16}$/u
const markerPrefix = '<!-- managed-by:@dsh-enhanced/lark-channel/business-skill:v1 '

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(char => {
    const code = char.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) {
    throw new Error(`lark business skill: invalid ${field}`)
  }
  return value
}

function requireBinding(input: Pick<LarkBusinessSkillInput, 'profile' | 'account' | 'appId' | 'ownerUserId'>): {
  profile: string; account: string; appId: string; ownerUserId: string
} {
  const profile = requireIdentifier(input.profile, 'profile')
  const account = requireIdentifier(input.account, 'account')
  if (typeof input.ownerUserId !== 'string' || !ownerPattern.test(input.ownerUserId)) {
    throw new Error('lark business skill: invalid ownerUserId')
  }
  if (typeof input.appId !== 'string' || !appIdPattern.test(input.appId)) {
    throw new Error('lark business skill: invalid appId')
  }
  return { profile, account, appId: input.appId, ownerUserId: input.ownerUserId }
}

function requireAbsolutePath(value: string, field: string, platform: NodeJS.Platform): string {
  if (typeof value !== 'string' || hasControlCharacter(value)
    || !(isAbsolute(value) || (platform === 'win32' && win32.isAbsolute(value)))) {
    throw new Error(`lark business skill: ${field} must be an absolute path without control characters`)
  }
  return platform === 'win32' && win32.isAbsolute(value) && !isAbsolute(value)
    ? win32.normalize(value) : resolve(value)
}

function validate(input: LarkBusinessSkillInput): LarkBusinessSkillInput {
  const platform = input.platform ?? process.platform
  const binding = requireBinding(input)
  const cliProfile = requireIdentifier(input.cliProfile, 'cliProfile')
  return {
    dshHome: requireAbsolutePath(input.dshHome, 'dshHome', platform),
    ...binding,
    cliCommand: requireAbsolutePath(input.cliCommand, 'cliCommand', platform),
    cliProfile,
    cliConfigDir: requireAbsolutePath(input.cliConfigDir, 'cliConfigDir', platform),
    cliDataDir: requireAbsolutePath(input.cliDataDir, 'cliDataDir', platform),
    platform,
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function skillName(input: Pick<LarkBusinessSkillInput, 'profile' | 'account'>): string {
  const hash = createHash('sha256').update(input.profile).update('\0').update(input.account).digest('hex').slice(0, 16)
  return `lark-business-${hash}`
}

export function renderLarkBusinessSkill(input: LarkBusinessSkillInput): { name: string; content: string } {
  const checked = validate(input)
  const name = skillName(checked)
  const marker = `${markerPrefix}${name} -->`
  const cli = checked.platform === 'win32'
    ? `${LARK_BUSINESS_CLEARED_ENV.map(name => `Remove-Item Env:${name} -ErrorAction SilentlyContinue;`).join(' ')} $env:LARKSUITE_CLI_CONFIG_DIR=${powershellQuote(checked.cliConfigDir)}; $env:LARKSUITE_CLI_DATA_DIR=${powershellQuote(checked.cliDataDir)}; $env:LARKSUITE_CLI_NO_UPDATE_NOTIFIER='1'; $env:LARKSUITE_CLI_NO_SKILLS_NOTIFIER='1'; & ${powershellQuote(checked.cliCommand)} --profile ${powershellQuote(checked.cliProfile)}`
    : `env ${LARK_BUSINESS_CLEARED_ENV.map(name => `-u ${name}`).join(' ')} LARKSUITE_CLI_CONFIG_DIR=${shellQuote(checked.cliConfigDir)} LARKSUITE_CLI_DATA_DIR=${shellQuote(checked.cliDataDir)} LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 ${shellQuote(checked.cliCommand)} --profile ${shellQuote(checked.cliProfile)}`
  const frontmatter = stringify({
    name,
    description: `Use the configured Lark CLI for owner-authorized documents, sheets, Base, calendar, tasks, mail, meetings, contacts, and approvals. Only for DSH profile ${checked.profile}, Lark account ${checked.account}, app ${checked.appId}, and owner ${checked.ownerUserId}; read current embedded official skills and schemas before acting.`,
    metadata: { appId: checked.appId, ownerUserId: checked.ownerUserId,
      profile: checked.profile, account: checked.account },
  }).trimEnd()
  const content = `---\n${frontmatter}\n---\n${marker}\n# Lark business operations\n\nThis skill belongs to DSH profile **${checked.profile}**, Lark account **${checked.account}**, application **${checked.appId}**, and owner open ID **${checked.ownerUserId}**. Use it only when the current DSH profile, channel account, application, and owner all match this binding. If any value differs, stop using this skill and rerun channel setup. These values identify this installation; they are not credentials. Never print tokens, secrets, or configuration contents.\n\nUse the native skill and shell tools for this task (${checked.platform === 'win32' ? 'PowerShell on Windows' : 'a POSIX shell on this platform'}). Do not start another Agent loop. Every CLI invocation must use the exact command prefix below, including its explicit profile and private configuration directory. Linux uses the private data directory for CLI token files; on macOS and Windows the CLI may use a system keychain shared by the OS account. Do not use an unbound CLI command or the machine's default CLI profile/configuration.\n\n    ${cli} skills list\n    ${cli} skills read lark-shared\n\nBefore each business operation, discover the current embedded official instructions with \`skills list\`, then \`skills read <relevant-skill>\`. Read its referenced files on demand with \`skills list <skill>/references\` and \`skills read <skill> <reference-path>\`. The embedded instructions and command schemas are the source of truth; do not rely on a copied catalogue. For example, a document task can start with:\n\n    ${cli} skills read lark-doc\n\nUse the operation's \`--help\` and \`schema <service.resource.method>\` when the exact arguments or risk level are unclear. Keep the same isolated prefix for these calls and for every subsequent business command. Select \`--as user\` for the owner's personal resources; use \`--as bot\` only for application/bot resources. The bot identity may not see the owner's resources.\n\nThe owner's current request authorizes the operations necessary to complete that task; do not ask again for an already authorized action. If a CLI command exits with code 10, add \`--yes\` only when the specific operation is already authorized by that request, then retry that command once. Otherwise request the missing authorization. Authentication, scope, and network failures are not approval gates: diagnose them, never turn them into a successful retry.\n\nKeep all subsequent examples and real invocations bound to this exact prefix, including explicit \`--profile\`. Do not disclose credentials in replies or logs.\n`
  return { name, content }
}

async function existingKind(path: string): Promise<'missing' | 'directory' | 'file' | 'symlink' | 'other'> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return 'symlink'
    if (stat.isDirectory()) return 'directory'
    if (stat.isFile()) return 'file'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

async function ensureRealDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment)
    const kind = await existingKind(current)
    if (kind === 'missing') await mkdir(current, { mode: 0o700 })
    else if (kind !== 'directory') throw new Error(`lark business skill: directory path is ${kind}: ${current}`)
  }
}

async function hasExistingRealDirectory(path: string): Promise<boolean> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const segment of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, segment)
    const kind = await existingKind(current)
    if (kind === 'missing') return false
    if (kind !== 'directory') throw new Error(`lark business skill: directory path is ${kind}: ${current}`)
  }
  return true
}

function metadataBinding(content: string, name: string): Record<string, unknown> | undefined {
  const marker = `${markerPrefix}${name} -->`
  const separator = `\n---\n${marker}\n`
  const end = content.startsWith('---\n') ? content.indexOf(separator, 4) : -1
  if (end < 0) throw new Error('lark business skill: existing SKILL.md is not managed by this installer')
  try {
    const document = parseYaml(content.slice(4, end)) as unknown
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined
    const metadata = (document as Record<string, unknown>).metadata
    return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? metadata as Record<string, unknown> : undefined
  } catch { return undefined }
}

/** Remove a stale managed skill after owner/app rotation or explicit opt-out. */
export async function reconcileLarkBusinessSkill(input: LarkBusinessSkillReconcileInput): Promise<void> {
  const binding = requireBinding(input)
  if (typeof input.enabled !== 'boolean') throw new Error('lark business skill: invalid enabled flag')
  const dshHome = requireAbsolutePath(input.dshHome, 'dshHome', process.platform)
  const previousAccount = input.previousAccount === undefined
    ? undefined : requireIdentifier(input.previousAccount, 'previousAccount')
  const reconcileName = async (name: string, removeRegardlessOfBinding: boolean): Promise<void> => {
    const skillDir = join(dshHome, 'skills', name)
    if (!await hasExistingRealDirectory(skillDir)) return
    const path = join(skillDir, 'SKILL.md')
    const kind = await existingKind(path)
    if (kind === 'missing') return
    if (kind !== 'file') throw new Error(`lark business skill: existing SKILL.md is ${kind}; refusing to replace it`)
    const metadata = metadataBinding(await readFile(path, 'utf8'), name)
    if (removeRegardlessOfBinding || !input.enabled || metadata?.appId !== binding.appId || metadata?.ownerUserId !== binding.ownerUserId
      || metadata?.profile !== binding.profile || metadata?.account !== binding.account) {
      await unlink(path)
    }
  }
  if (previousAccount !== undefined && previousAccount !== binding.account) {
    await reconcileName(skillName({ profile: binding.profile, account: previousAccount }), true)
  }
  await reconcileName(skillName(binding), false)
}

export async function installLarkBusinessSkill(input: LarkBusinessSkillInput): Promise<{ path: string; name: string }> {
  const { name, content } = renderLarkBusinessSkill(input)
  const dshHome = requireAbsolutePath(input.dshHome, 'dshHome', input.platform ?? process.platform)
  const skillDir = join(dshHome, 'skills', name)
  const path = join(skillDir, 'SKILL.md')
  await ensureRealDirectory(skillDir)
  const kind = await existingKind(path)
  if (kind !== 'missing' && kind !== 'file') {
    throw new Error(`lark business skill: existing SKILL.md is ${kind}; refusing to replace it`)
  }
  if (kind === 'file') {
    const previous = await readFile(path, 'utf8')
    metadataBinding(previous, name)
    if (previous === content) return { path, name }
  } else if ((await readdir(skillDir)).length !== 0) {
    throw new Error('lark business skill: existing skill directory is not managed by this installer')
  }
  const temporary = join(skillDir, `.SKILL.md.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return { path, name }
}
