import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandRunner } from './run.ts'
import { CREDENTIAL_SERVICE_PREFIX, profilesDirectory } from './paths.ts'

export type { CommandRunner }

export interface CredentialLocator {
  provider: 'macos-keychain' | 'linux-secret-service'
  service: string
  account: string
}

/**
 * lark-channel setup 落盘的凭据记录文件名（setup.ts:1637-1642）。
 * journal 记录当前 locator；credential-cleanup 记录轮换时待清理的旧 locator。
 * 两者内容均为 JSON，凭据项位于顶层 locators[]。
 */
const JOURNAL_SUFFIXES = ['.lark-setup.journal.json', '.lark-credential-cleanup.json']

/**
 * 从 DSH home 内的 setup journal / cleanup 记录反查外部凭据库条目。
 *
 * 不使用 macOS `security dump-keychain`（逐条访问会弹系统授权框），
 * 也不依赖 secret-tool 枚举（libsecret 无通配查询）；
 * setup 写入 keychain/secret-service 的每个 service/account 都在 journal 里有权威记录。
 * home 内的 linux-protected-file / windows-dpapi 凭据随 DSH home 一起删除，无需外部清理。
 */
export async function scanCredentialLocators(
  dshHome: string,
  profiles?: readonly string[],
): Promise<CredentialLocator[]> {
  const profileDirectories = profiles ?? await readProfilesOrEmpty(dshHome)
  const wanted = profiles === undefined ? undefined : new Set(profiles)
  const found = new Map<string, CredentialLocator>()
  for (const profile of profileDirectories) {
    if (wanted !== undefined && !wanted.has(profile)) continue
    const directory = profilesDirectory(dshHome)
    for (const file of await readFilesOrEmpty(join(directory, profile))) {
      if (!JOURNAL_SUFFIXES.some(suffix => file.endsWith(suffix))) continue
      const text = await readFile(join(directory, profile, file), 'utf8').catch(() => undefined)
      if (text === undefined) continue
      for (const locator of parseLocators(text)) {
        if (!locator.service.startsWith(CREDENTIAL_SERVICE_PREFIX)) continue
        // 单 profile 模式只清理归属该 profile 的条目；
        // setup-preflight（dsh/lark/setup-preflight/...）等无 profile 归属项仅全量清理时删除。
        if (wanted !== undefined && !locator.service.startsWith(`dsh/lark/${profile}/`)) continue
        found.set(`${locator.provider}\0${locator.service}\0${locator.account}`, locator)
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider) || a.service.localeCompare(b.service) || a.account.localeCompare(b.account))
}

async function readProfilesOrEmpty(dshHome: string): Promise<string[]> {
  try {
    return await readdir(profilesDirectory(dshHome))
  } catch {
    return []
  }
}

async function readFilesOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory)
  } catch {
    return []
  }
}

function parseLocators(text: string): CredentialLocator[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const raw = Array.isArray(parsed)
    ? (parsed as unknown[])
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { locators?: unknown }).locators)
      ? (parsed as { locators: unknown[] }).locators
      : []
  const result: CredentialLocator[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if ((record.provider !== 'macos-keychain' && record.provider !== 'linux-secret-service')
      || typeof record.service !== 'string' || typeof record.account !== 'string') continue
    if (!record.service.startsWith(CREDENTIAL_SERVICE_PREFIX)) continue
    result.push({
      provider: record.provider as CredentialLocator['provider'],
      service: record.service,
      account: record.account,
    })
  }
  return result
}

/** 删除一条 keychain/secret-service 条目；条目不存在视为成功。 */
export function deleteCredentialLocator(locator: CredentialLocator, runner: CommandRunner): { ok: boolean; detail?: string } {
  const result = locator.provider === 'macos-keychain'
    ? runner('/usr/bin/security', ['delete-generic-password', '-s', locator.service, '-a', locator.account])
    : runner('/usr/bin/secret-tool', ['clear', 'service', locator.service, 'account', locator.account])
  if (result.status === 0) return { ok: true }
  const stderr = result.stderr?.toString().trim() ?? ''
  // macOS security：条目不存在时退出码 44；secret-tool 无精确稳定码，stderr 含 not found/no such。
  if (locator.provider === 'macos-keychain' && result.status === 44) return { ok: true }
  if (/not found|no such|could not be found/iu.test(stderr)) return { ok: true }
  return { ok: false, detail: stderr || `exit ${result.status ?? 'null'}` }
}
