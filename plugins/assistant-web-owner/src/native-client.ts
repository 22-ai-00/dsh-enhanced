import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Use the same installed Host closure for the controller and its browser half. */
export async function resolveHostWebModules(hostEntrypoint = process.argv[1]): Promise<{
  controllerPath: string
  EntryTree: typeof EntryTree
}> {
  const hostRequire = hostEntrypoint === undefined ? createRequire(import.meta.url) : createRequire(await realpath(hostEntrypoint))
  const controllerPath = hostRequire.resolve('@deepseek-ai/dsh-api-session-controller')
  const loader = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href) as { EntryTree?: unknown }
  if (typeof loader.EntryTree !== 'function') throw new Error('assistant-web-owner: Host Loader entry tree is unavailable')
  return { controllerPath, EntryTree: loader.EntryTree as typeof EntryTree }
}

/**
 * A non-persistent native Loader subtree. The one entry keeps the installed
 * controller's real package metadata (and therefore its matching browser
 * client), but imports only our owner-scoped Host adapter. It never starts the
 * unrestricted upstream Host entry, edits a profile, or copies installed code.
 * Both entry activation and disposal remain owned by the containing Cordis
 * fiber. Unknown names are rejected rather than delegated to an arbitrary import.
 */
export function createOwnerSessionTree(ctx: Context, Tree: typeof EntryTree, controllerPath: string, adapter: Plugin): EntryTree {
  if (!isAbsolute(controllerPath)) throw new Error('assistant-web-owner: canonical Host controller path required')
  class OwnerSessionTree extends Tree {
    override write(): void { /* Runtime composition only; no profile write-back. */ }
    override async import(name: string): Promise<Plugin> {
      if (name !== controllerPath) throw new Error('assistant-web-owner: unexpected native client entry')
      return adapter
    }
  }
  return new OwnerSessionTree(ctx)
}
