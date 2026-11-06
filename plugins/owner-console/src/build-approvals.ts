/** Record owner-confirmed dependency build scripts in the profile's pnpm workspace file.
 *
 * The Host records pnpm's blocked-build report itself, but its parser misses the line when
 * pnpm decorates it with ANSI colour (pnpm 11 does), so `pendingBuilds` stays empty and its
 * own approval retry answers `stale-approval`. The console therefore writes the exact names
 * the owner confirmed—only names pnpm reported for this install—before retrying once.
 */
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, parseDocument } from 'yaml'

const MAX_NAMES = 64
const MAX_NAME_LENGTH = 200
const UNSAFE_NAME = /[*?\s]/u
const isControl = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0
  return code < 0x20 || code === 0x7f
}

/** Reject a name the Host would not accept as an `allowBuilds` key. */
export function assertBuildName(name: string): void {
  if (name === '' || name.length > MAX_NAME_LENGTH || UNSAFE_NAME.test(name) || [...name].some(isControl)) {
    throw new Error(`构建脚本名称无效：${JSON.stringify(name)}`)
  }
}

/** Add `allowBuilds: <name>: true` entries to a profile's `pnpm-workspace.yaml`.
 *
 * Existing decisions are kept; only the listed names are set. The write replaces the file
 * atomically with mode 0600 so an interrupted retry cannot leave a half-written policy.
 * @param dir Absolute profile directory supplied by the Host.
 * @param names Exact package keys the owner confirmed; all must pass {@link assertBuildName}.
 */
export async function persistAllowedBuilds(dir: string, names: readonly string[]): Promise<void> {
  const unique = [...new Set(names)]
  if (unique.length === 0) return
  if (unique.length > MAX_NAMES) throw new Error(`构建脚本名称过多（上限 ${String(MAX_NAMES)}）`)
  for (const name of unique) assertBuildName(name)
  const filename = join(dir, 'pnpm-workspace.yaml')
  let text: string
  try {
    text = await readFile(filename, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    text = ''
  }
  const document = parseDocument(text)
  if (document.errors[0] !== undefined) throw document.errors[0]
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error('pnpm-workspace.yaml 必须是 YAML 映射')
  }
  const builds = document.get('allowBuilds')
  if (builds !== undefined && !isMap(builds)) throw new Error('allowBuilds 必须是 YAML 映射')
  for (const name of unique) document.setIn(['allowBuilds', name], true)
  const temporary = `${filename}.owner-console-${process.pid.toString()}`
  await writeFile(temporary, String(document), { mode: 0o600 })
  await rename(temporary, filename)
}
