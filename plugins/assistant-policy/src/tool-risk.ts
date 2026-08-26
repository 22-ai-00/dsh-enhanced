import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export type ToolRiskClassification =
  | 'allow'
  | 'ask-review'
  | 'ask-human'
  | 'defer-native-approval'

export const AUTO_REVIEW_APPROVAL_REASON =
  'assistant-policy: ask-review (unclassified or potentially low-risk tool action)'
export const HUMAN_APPROVAL_REASON =
  'assistant-policy: ask-human (locally detected sensitive tool action)'

export interface ToolRiskInput {
  readonly name: string
  readonly arguments: unknown
  readonly workspace: string
}

const WRITE_TOOLS = new Set(['write', 'edit'])
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])
const NATIVE_ESCALATION_TOOLS = new Set(['bash', 'pwsh', 'write', 'edit'])
const NATIVE_ESCALATION_TARGETS = new Set(['workspace-write', 'danger-full-access'])
const BASH_ARGUMENT_KEYS = new Set([
  'command',
  'description',
  'justification',
  'run_in_background',
  'sandbox_permissions',
  'timeoutMs',
  'workdir',
])

// These are argv shapes, not shell-string prefixes. Extending this list should
// be a deliberate policy change because an unrecognised form falls back to ask.
const SAFE_EXACT_COMMANDS: readonly (readonly string[])[] = [
  ['pwd'],
  ['git', 'status', '--short'],
  ['git', 'branch', '--show-current'],
  ['git', 'rev-parse', '--show-toplevel'],
  ['git', 'diff', '--no-ext-diff', '--stat'],
]

const SAFE_LS_OPTIONS = new Set(['-1', '-a', '-al', '-l', '-la'])
const MKFS_COMMANDS = new Set([
  'mkfs',
  'mkfs.btrfs',
  'mkfs.ext2',
  'mkfs.ext3',
  'mkfs.ext4',
  'mkfs.xfs',
])
const NETWORK_COMMANDS = new Set([
  'curl',
  'ftp',
  'nc',
  'ncat',
  'rsync',
  'scp',
  'sftp',
  'ssh',
  'telnet',
  'wget',
])
const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'ls-remote', 'pull', 'push'])
const PRIVILEGE_COMMANDS = new Set(['doas', 'pkexec', 'su', 'sudo'])
const BACKGROUND_COMMANDS = new Set(['disown', 'nohup', 'setsid'])
const SHELL_WRAPPER_COMMANDS = new Set(['command', 'eval', 'exec', 'ionice', 'nice', 'time', 'timeout', 'xargs'])
const SHELL_INTERPRETERS = new Set(['bash', 'dash', 'fish', 'sh', 'zsh'])
const CREDENTIAL_COMMANDS = new Set(['env', 'keychain', 'op', 'pass', 'printenv', 'security'])
const DESTRUCTIVE_COMMANDS = new Set(['dd', 'rm', 'shred'])
const PACKAGE_MANAGER_COMMANDS = new Set(['bun', 'npm', 'pnpm', 'yarn'])
const PACKAGE_NETWORK_SUBCOMMANDS = new Set(['add', 'install', 'update', 'upgrade'])
const PACKAGE_EXEC_COMMANDS = new Set(['bunx', 'npx'])
const PYTHON_PACKAGE_COMMANDS = new Set(['pip', 'pip3'])
const CREDENTIAL_MARKER = /(?:^|[^a-z0-9])(?:api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)(?:[^a-z0-9]|$)/iu
const CREDENTIAL_PATH = /(?:^|[/\\])(?:\.aws[/\\](?:config|credentials)|\.codex[/\\]auth\.json|\.docker[/\\]config\.json|\.env(?:\.[^/\\\s]+)?|\.gnupg|\.kube[/\\]config|\.netrc|\.npmrc|\.ssh|auth\.json|credentials\.json|id_(?:ed25519|rsa))(?:$|[\s/\\])/iu
const EMBEDDED_SECRET = /(?:bearer\s+[a-z0-9._~-]+|(?:^|[^a-z0-9])(?:ghp|github_pat|sk|xox[baprs])[-_][a-z0-9_-]+)/iu
const URI_USER_INFO = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/iu
const PEM_PRIVATE_KEY = /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/iu
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u

const READ_ARGUMENT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  read: new Set(['file_path', 'limit', 'offset', 'path']),
  read_image: new Set(['detail', 'file_path', 'path']),
  glob: new Set(['path', 'pattern']),
  grep: new Set(['include', 'path', 'pattern']),
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Readonly<Record<string, unknown>>
}

function nativeEscalation(
  argumentsRecord: Readonly<Record<string, unknown>> | undefined,
): 'none' | 'valid' | 'invalid' {
  if (argumentsRecord === undefined) return 'none'
  if (!Object.hasOwn(argumentsRecord, 'sandbox_permissions')) {
    return Object.hasOwn(argumentsRecord, 'justification') ? 'invalid' : 'none'
  }
  if (typeof argumentsRecord.sandbox_permissions !== 'string'
    || !NATIVE_ESCALATION_TARGETS.has(argumentsRecord.sandbox_permissions)) return 'invalid'
  return typeof argumentsRecord.justification === 'string' && argumentsRecord.justification.trim() !== ''
    ? 'valid'
    : 'invalid'
}

function isWorkspacePath(target: string, workspace: string): boolean {
  if (target.trim() === '' || target.includes('\0')
    || workspace.trim() === '' || !isAbsolute(workspace)) return false
  const workspacePath = resolve(workspace)
  const targetPath = resolve(workspacePath, target)
  const fromWorkspace = relative(workspacePath, targetPath)
  const firstSegment = fromWorkspace.split(sep, 1)[0]
  return fromWorkspace === '' || (!isAbsolute(fromWorkspace) && firstSegment !== '..')
}

function isCredentialSensitivePath(target: string, workspace: string): boolean {
  return CREDENTIAL_PATH.test(target) || CREDENTIAL_PATH.test(resolve(workspace, target))
}

function isWorkspaceReadTarget(target: string, workspace: string): boolean {
  return isWorkspacePath(target, workspace) && !isCredentialSensitivePath(target, workspace)
}

function hasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function onePathArgument(
  value: Readonly<Record<string, unknown>>,
): string | undefined {
  const keys = ['path', 'file_path'].filter(key => Object.hasOwn(value, key))
  if (keys.length !== 1) return undefined
  const path = value[keys[0]!]
  return typeof path === 'string' ? path : undefined
}

function validReadBounds(value: Readonly<Record<string, unknown>>): boolean {
  return ['offset', 'limit'].every(key => !Object.hasOwn(value, key)
    || (Number.isSafeInteger(value[key]) && (value[key] as number) >= 0))
}

function classifyReadTool(
  name: string,
  argumentsRecord: Readonly<Record<string, unknown>> | undefined,
  workspace: string,
): ToolRiskClassification {
  const allowed = READ_ARGUMENT_KEYS[name]
  if (argumentsRecord === undefined || allowed === undefined || !hasOnlyKeys(argumentsRecord, allowed)) {
    return 'ask-human'
  }
  if (name === 'read' || name === 'read_image') {
    const target = onePathArgument(argumentsRecord)
    if (target === undefined || !isWorkspaceReadTarget(target, workspace)) return 'ask-human'
    if (name === 'read' && !validReadBounds(argumentsRecord)) return 'ask-human'
    if (name === 'read_image' && Object.hasOwn(argumentsRecord, 'detail')
      && !['auto', 'high', 'low', 'original'].includes(String(argumentsRecord.detail))) return 'ask-human'
    return 'allow'
  }
  if (typeof argumentsRecord.pattern !== 'string' || argumentsRecord.pattern.trim() === '') return 'ask-human'
  const root = argumentsRecord.path ?? workspace
  if (typeof root !== 'string' || !isWorkspaceReadTarget(root, workspace)) return 'ask-human'
  const resolvedRoot = resolve(workspace, root)
  if (name === 'glob') {
    return isWorkspaceReadTarget(resolve(resolvedRoot, argumentsRecord.pattern), workspace) ? 'allow' : 'ask-human'
  }
  if (Object.hasOwn(argumentsRecord, 'include')) {
    if (typeof argumentsRecord.include !== 'string' || argumentsRecord.include.trim() === ''
      || !isWorkspaceReadTarget(resolve(resolvedRoot, argumentsRecord.include), workspace)) return 'ask-human'
  }
  return 'allow'
}

function hasWorkspaceContainedTarget(
  argumentsRecord: Readonly<Record<string, unknown>> | undefined,
  workspace: string,
): boolean {
  if (argumentsRecord === undefined) return false
  const targets = [argumentsRecord.path, argumentsRecord.file_path]
    .filter((value): value is string => typeof value === 'string')
  return targets.length > 0 && targets.every(target => isWorkspacePath(target, workspace))
}

/**
 * Tokenises only a deliberately small shell-free subset. It is not a shell
 * parser: quoting, expansion, control operators, globbing, comments and line
 * breaks all make the command ineligible for automatic approval.
 */
function simpleArgv(command: string): readonly string[] | undefined {
  const normalized = command.trim()
  if (normalized === '') return undefined
  if (!/^[A-Za-z0-9_@%+=:,./\- \t]+$/u.test(normalized)) return undefined
  return normalized.split(/[ \t]+/u)
}

function argvEquals(argv: readonly string[], expected: readonly string[]): boolean {
  return argv.length === expected.length && argv.every((token, index) => token === expected[index])
}

function classifyLs(
  argv: readonly string[],
  workdir: string,
  workspace: string,
): ToolRiskClassification | undefined {
  if (argv[0] !== 'ls') return undefined
  let unsupportedOption = false
  for (const token of argv.slice(1)) {
    if (token[0] === '-') {
      if (!SAFE_LS_OPTIONS.has(token)) unsupportedOption = true
      continue
    }
    if (!isWorkspaceReadTarget(resolve(workdir, token), workspace)) return 'ask-human'
  }
  return unsupportedOption ? 'ask-review' : 'allow'
}

function commandName(argv: readonly string[]): string {
  return basename(argv[0] ?? '')
}

function isDeterministicallySensitive(argv: readonly string[], raw: string): boolean {
  const command = commandName(argv)
  if (CREDENTIAL_MARKER.test(raw) || CREDENTIAL_PATH.test(raw) || EMBEDDED_SECRET.test(raw)
    || URI_USER_INFO.test(raw) || PEM_PRIVATE_KEY.test(raw)
    || JWT_TOKEN.test(raw) || AWS_ACCESS_KEY.test(raw)) return true
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[0] ?? '')) return true
  if (NETWORK_COMMANDS.has(command) || PRIVILEGE_COMMANDS.has(command)
    || BACKGROUND_COMMANDS.has(command) || CREDENTIAL_COMMANDS.has(command)
    || DESTRUCTIVE_COMMANDS.has(command) || MKFS_COMMANDS.has(command)
    || SHELL_WRAPPER_COMMANDS.has(command)) return true
  if (SHELL_INTERPRETERS.has(command) && argv.includes('-c')) return true
  if ((command === 'busybox' || command === 'toybox')
    && argv.slice(1).some(token => NETWORK_COMMANDS.has(token)
      || DESTRUCTIVE_COMMANDS.has(token) || MKFS_COMMANDS.has(token))) return true
  if (command === 'git') {
    if (argv.slice(1).some(token => GIT_NETWORK_SUBCOMMANDS.has(token))) return true
    if (argv.includes('clean')) return true
    if (argv.includes('reset') && argv.includes('--hard')) return true
    const submodule = argv.indexOf('submodule', 1)
    if (submodule >= 0 && argv.slice(submodule + 1).includes('update')) return true
  }
  const argumentsAfterCommand = argv.slice(1)
  if (PACKAGE_MANAGER_COMMANDS.has(command)
    && argumentsAfterCommand.some(token => PACKAGE_NETWORK_SUBCOMMANDS.has(token))) return true
  if (PACKAGE_EXEC_COMMANDS.has(command)) return true
  if (command === 'npm' && argumentsAfterCommand.some(token => token === 'exec' || token === 'x')) return true
  if ((command === 'pnpm' || command === 'yarn') && argumentsAfterCommand.includes('dlx')) return true
  if (PYTHON_PACKAGE_COMMANDS.has(command) && argumentsAfterCommand.includes('install')) return true
  if ((command === 'python' || command === 'python3')
    && argumentsAfterCommand.some((token, index) => token === '-m'
      && PYTHON_PACKAGE_COMMANDS.has(argumentsAfterCommand[index + 1] ?? '')
      && argumentsAfterCommand.slice(index + 2).includes('install'))) return true
  if (command === 'uv' && argumentsAfterCommand[0] === 'pip'
    && argumentsAfterCommand.includes('install')) return true
  if ((command === 'cargo' || command === 'gem' || command === 'brew')
    && argumentsAfterCommand.includes('install')) return true
  if (command === 'go' && argumentsAfterCommand[0] === 'get') return true
  if (command === 'composer'
    && argumentsAfterCommand.some(token => token === 'install' || token === 'require' || token === 'update')) return true
  if (command === 'docker'
    && argumentsAfterCommand.some(token => token === 'pull' || token === 'push' || token === 'login')) return true
  return command === 'gh' || command === 'glab'
}

function classifyBash(
  argumentsRecord: Readonly<Record<string, unknown>> | undefined,
  workspace: string,
): ToolRiskClassification {
  if (argumentsRecord === undefined || typeof argumentsRecord.command !== 'string'
    || !hasOnlyKeys(argumentsRecord, BASH_ARGUMENT_KEYS)) return 'ask-human'
  if (Object.hasOwn(argumentsRecord, 'description')
    && (typeof argumentsRecord.description !== 'string' || argumentsRecord.description.trim() === '')) {
    return 'ask-human'
  }
  if (Object.hasOwn(argumentsRecord, 'timeoutMs')
    && (typeof argumentsRecord.timeoutMs !== 'number'
      || !Number.isFinite(argumentsRecord.timeoutMs) || argumentsRecord.timeoutMs <= 0)) {
    return 'ask-human'
  }
  const workdir = argumentsRecord.workdir ?? workspace
  if (typeof workdir !== 'string' || !isWorkspaceReadTarget(workdir, workspace)) return 'ask-human'
  const command = argumentsRecord.command
  const argv = simpleArgv(command)
  // Anything that needs real shell parsing is deliberately ineligible for
  // automatic review: operators, expansion, quoting, redirection and globbing
  // may materially change the command that actually runs.
  if (argv === undefined) return 'ask-human'
  if (isDeterministicallySensitive(argv, command)) return 'ask-human'
  const lsRisk = classifyLs(argv, resolve(workspace, workdir), workspace)
  if (lsRisk !== undefined) return lsRisk
  if (SAFE_EXACT_COMMANDS.some(expected => argvEquals(argv, expected))) return 'allow'
  return 'ask-review'
}

export function classifyToolRisk(input: Readonly<ToolRiskInput>): ToolRiskClassification {
  const argumentsRecord = asRecord(input.arguments)
  if (input.name === 'bash' && argumentsRecord !== undefined
    && Object.hasOwn(argumentsRecord, 'run_in_background')
    && argumentsRecord.run_in_background !== false) return 'ask-human'
  const escalation = nativeEscalation(argumentsRecord)
  if (escalation === 'valid') {
    return NATIVE_ESCALATION_TOOLS.has(input.name) ? 'defer-native-approval' : 'ask-human'
  }
  if (escalation === 'invalid') return 'ask-human'
  if (NETWORK_TOOLS.has(input.name)) return 'ask-human'
  // `run_code` executes arbitrary worker code and is not an OS sandbox. Its
  // source cannot be reduced to the narrow argv grammar below, so auto review
  // must never grant it without a human decision.
  if (input.name === 'run_code') return 'ask-human'
  if (input.name === 'bash') return classifyBash(argumentsRecord, input.workspace)
  // PowerShell has materially different quoting, invocation and background
  // semantics. Until it has its own strict parser, never send it to the LLM
  // reviewer; native sandbox escalation above remains owned by the tool.
  if (input.name === 'pwsh') return 'ask-human'
  if (Object.hasOwn(READ_ARGUMENT_KEYS, input.name)) {
    return classifyReadTool(input.name, argumentsRecord, input.workspace)
  }
  if (WRITE_TOOLS.has(input.name)) {
    return hasWorkspaceContainedTarget(argumentsRecord, input.workspace) ? 'allow' : 'ask-human'
  }
  return 'ask-review'
}
