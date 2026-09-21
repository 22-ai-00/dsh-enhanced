import { chmod, stat } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import type { CommandRunner } from './run.ts'

export interface BackupResult {
  archivePath: string
  /** tar 输出（成功时通常为空）。 */
  detail: string
}

/**
 * 用系统 tar 把整个 DSH home 打包为 tar.gz。
 * `-C <home 父目录> <home 名>` 保证归档内路径是相对的 .dsh/。
 * BSD tar（macOS）与 GNU tar（Linux）均支持这些参数。
 * 成功后将归档权限收紧为 0600 并校验非空。
 */
export function createHomeBackup(
  dshHome: string,
  archivePath: string,
  runner: CommandRunner,
): BackupResult {
  const parent = dirname(dshHome.replace(/\/$/u, ''))
  const name = basename(dshHome)
  const result = runner('tar', ['-czf', archivePath, '-C', parent, name])
  if (result.status !== 0) {
    throw new Error(`备份失败（tar 退出码 ${result.status ?? 'null'}）：${result.stderr.trim() || result.stdout.trim()}`)
  }
  return { archivePath, detail: result.stderr.trim() || result.stdout.trim() }
}

/** 校验归档存在、是普通文件且非空；返回字节数。 */
export async function verifyBackup(archivePath: string): Promise<number> {
  const metadata = await stat(archivePath)
  if (!metadata.isFile() || metadata.size <= 0) {
    throw new Error(`备份归档校验失败（不存在或为空）：${archivePath}`)
  }
  await chmod(archivePath, 0o600)
  return metadata.size
}
