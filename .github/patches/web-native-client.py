"""Apply the Web client repair only to its reviewed base; no publish or main writes."""
from pathlib import Path
import json
import subprocess

BASE = '1bc2bf92d0b0ec80dfd969696fcad3acd23d8dee'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip() == BASE
assert not subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], text=True)
root = Path('.')
owner = root / 'plugins/assistant-web-owner'

def replace(path, before, after):
    text = path.read_text()
    assert text.count(before) == 1, (str(path), before[:80], text.count(before))
    path.write_text(text.replace(before, after))

(owner / 'src/native-client.ts').write_text('''import type { Context, Plugin } from '@deepseek-ai/cordis'
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
''')
p = owner / 'src/index.ts'
replace(p, "import { DeliveryNoticesService } from './notices.js'", "import { DeliveryNoticesService } from './notices.js'\nimport { createOwnerSessionTree, resolveHostWebModules } from './native-client.js'")
replace(p, "export const inject = [...BundledSessionController.inject, 'assistantDelivery', 'typert']", "export const inject = [...BundledSessionController.inject, 'assistantDelivery', 'typert', 'loader']")
replace(p, "  const Controller = await resolveHostSessionController()", "  const { controllerPath, EntryTree } = await resolveHostWebModules()\n  const Controller = (await import(pathToFileURL(controllerPath).href) as { SessionController: SessionControllerConstructor }).SessionController\n  if (typeof Controller !== 'function' || !Array.isArray(Controller.inject)) fail('Host SessionController is unavailable')")
replace(p, "  scoped.inject(Controller.inject, controllerCtx => {\n    const controller = new Controller(controllerCtx, {})", "  scoped.inject(Controller.inject, async active => {\n    const tree = createOwnerSessionTree(active, EntryTree, controllerPath, {\n      name: 'assistant-web-owner-native-controller',\n      apply(controllerCtx: Context) {\n    const controller = new Controller(controllerCtx, {})")
replace(p, "    replace('canOpenWorkspacePath', () => false)\n  })", "    replace('canOpenWorkspacePath', () => false)\n      },\n    })\n    // Register cleanup before starting any child, including a partial failure.\n    active.effect(() => () => tree.root.stop(), 'assistant-web-owner.native-client-entry')\n    await tree.root.update([{ id: 'native-session-controller', name: controllerPath }])\n  })")
replace(owner / 'src/client.ts', 'type Notice =', "/** The Session client itself is supplied by the installed Host, not this bundle. */\nexport const inject = ['remote', 'slots']\n\ntype Notice =")
(owner / 'scripts/build-client.mjs').write_text('''import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// Only our notice UI is distributed here. The owner Host adapter mounts the
// installed DSH controller's native client through its own Loader metadata.
// Copying the build-time peer here mixes old submission types with newer UI.
const bundled = (await build({
  entryPoints: [new URL('../src/client.ts', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  write: false,
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'none',
})).outputFiles[0]?.text
if (bundled === undefined) throw new Error('assistant-web-owner: notice client bundle emitted no output')
const output = `window.__ModuleLoader__.load({
  id: '@dsh-enhanced/assistant-web-owner',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ${bundled}
    return module.exports;
  }
});\\n`
const directory = process.env.DSH_WEB_OWNER_CLIENT_OUT === undefined
  ? new URL('../lib/', import.meta.url)
  : pathToFileURL(resolve(process.env.DSH_WEB_OWNER_CLIENT_OUT) + sep)
await mkdir(directory, { recursive: true })
await writeFile(new URL('client.js', directory), output, 'utf8')
// tsc emits the actual notice-client declarations; do not re-export an unrelated
// installed Session client type. The explicit output seam is used by build tests.
''')
p = owner / 'package.json'
v = json.loads(p.read_text())
v['dsh']['client']['inject'].insert(1, '@deepseek-ai/dsh-api-session-controller')
v['peerDependencies']['@deepseek-ai/cordis-plugin-loader'] = '>=1.0.3 <2.0.0'
v['peerDependenciesMeta']['@deepseek-ai/cordis-plugin-loader'] = {'optional': True}
v['devDependencies']['@deepseek-ai/cordis-plugin-loader'] = 'catalog:'
p.write_text(json.dumps(v, ensure_ascii=False, indent=2) + '\n')
p = root / 'pnpm-lock.yaml'
s = p.read_text(); start = s.index('  plugins/assistant-web-owner:'); end = s.index('\n  plugins/', start + 1)
piece = s[start:end]
needle = "      '@deepseek-ai/dsh-agent':"
assert piece.count(needle) == 1
piece = piece.replace(needle, "      '@deepseek-ai/cordis-plugin-loader':\n        specifier: 'catalog:'\n        version: 1.0.3(@deepseek-ai/cordis@4.0.2)\n" + needle)
p.write_text(s[:start] + piece + s[end:])
p = owner / 'tests/index.spec.ts'
replace(p, "  it('builds an owner-scoped copy of the upstream Web client', () => {", "  it('builds only the owner notice UI and depends on the native Host Session client', () => {")
replace(p, "      const licenses = readFileSync(join(output, 'THIRD_PARTY_LICENSES'), 'utf8')\n", '')
replace(p, "      expect(ownerRegistration.factory.toString()).toContain('sessionControllerApply')\n      expect(licenses).toContain('Copyright (c) 2026 DeepSeek')\n      expect(licenses).toContain('Permission is hereby granted')", "      expect(ownerRegistration.factory.toString()).not.toContain('sessionControllerApply')\n      expect(ownerRegistration.factory.toString()).not.toContain('class ClientSessions')\n      expect(ownerRegistration.factory.toString()).not.toContain('pendingSubmissions')")
replace(p, "inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-conversation'],", "inject: ['@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-conversation'],")
replace(p, "  it('composes the final client without recursively replacing the upstream apply', async () => {", "  it('mounts and disposes notices without replacing the native Session client', async () => {")
s = p.read_text(); start = s.index("      const wrapper = built.indexOf('const ownerNoticeModule')"); end = s.index('      let registration:', start); p.write_text(s[:start] + s[end:])
replace(p, 'runInNewContext(executable,', 'runInNewContext(built,')
replace(p, "['base', 'mount', 'inject:remote.deliveryNotices,slots', 'slot-inject', 'register']", "['mount', 'inject:remote.deliveryNotices,slots', 'slot-inject', 'register']")
replace(p, "['base', 'mount', 'inject:remote.deliveryNotices,slots', 'slot-inject', 'register', 'injection-dispose', 'slot-dispose', 'unmount', 'base-dispose']", "['mount', 'inject:remote.deliveryNotices,slots', 'slot-inject', 'register', 'injection-dispose', 'slot-dispose', 'unmount']")
(owner / 'tests/native-client.spec.ts').write_text('''import { Context } from '@deepseek-ai/cordis'
import { Loader, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import { createOwnerSessionTree } from '../src/native-client.js'

// Exercise actual Cordis/Loader lifecycle, not just serialized metadata. The
// real installed-package graph is additionally covered by the browser test.
describe('owner native Session client entry', () => {
  it('uses the restricted adapter for the exact native package and disposes its entry', async () => {
    const ctx = new Context()
    let starts = 0, stops = 0
    let tree: EntryTree | undefined
    const path = '/does-not-execute/unrestricted-controller/index.js'
    try {
      await ctx.plugin(Loader)
      const owner = ctx.plugin({ async apply(active: Context) {
        tree = createOwnerSessionTree(active, EntryTree, path, { apply(inner: Context) {
          starts++
          inner.effect(() => () => { stops++ })
        } })
        active.effect(() => () => tree!.root.stop())
        await tree.root.update([{ id: 'native-session-controller', name: path }])
      } })
      await owner
      expect(starts).toBe(1)
      expect([...tree!.entries()].map(entry => entry.options.name)).toEqual([path])
      await expect(tree!.import('/different/unrestricted-controller/index.js')).rejects.toThrow('unexpected native client entry')
      await owner.dispose()
      expect(stops).toBe(1)
      expect([...tree!.entries()]).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('does not leave a partially started entry after adapter failure', async () => {
    const ctx = new Context()
    let cleanups = 0
    try {
      await ctx.plugin(Loader)
      const tree = createOwnerSessionTree(ctx, EntryTree, '/native/controller.js', { apply(active: Context) {
        active.effect(() => () => { cleanups++ })
        throw new Error('owner adapter unavailable')
      } })
      await expect(tree.root.update([{ id: 'native-session-controller', name: '/native/controller.js' }])).rejects.toThrow('owner adapter unavailable')
      await tree.root.stop()
      expect([...tree.entries()]).toEqual([])
      expect(cleanups).toBe(1)
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects a non-absolute controller source', () => {
    const ctx = new Context()
    expect(() => createOwnerSessionTree(ctx, EntryTree, 'untrusted-name', { apply() {} })).toThrow('canonical Host controller path')
  })
})
''')
p = owner / 'README.md'; s = p.read_text(); start = s.index('Web client 在构建时'); end = s.index('\n\n', start)
s = s[:start] + 'Web Session Controller 的 Host 与 browser 两半都从当前 DSH 安装解析。本包通过只含一个精确源码入口的内存 Loader 子树，将原生包的 client 元数据与已有 owner-scoped Host 包装绑定：浏览器加载该 Host 自带的 Session client，而非构建时复制的旧版本。子树不启动未过滤的上游 Host Controller，不写 profile 或 node_modules，随 owner Fiber 卸载；无法解析当前 Host 的公开 Loader/Controller 契约时拒绝启动，不回退到旧客户端。本包自己的 browser 产物只实现主动提醒，不再复制 Session RPC、提交队列或 UI 状态。' + s[end:]; p.write_text(s)
p = root / 'docs/architecture.md'
replace(p, '## 分发\n', 'Web owner 适配通过内存 `EntryTree` 将宿主实际 Session Controller 包的 client 元数据，与 owner-scoped 的 Host 包装绑定。唯一原生入口的 import 仅返回该包装，不启动未过滤 Controller；浏览器通过既有 ClientModuleRegistry 加载同一 Host 的原生 Session client。本包构建产物只含提醒 UI，不复制旧版 Session 协议。子树由 Cordis effect 释放，无 profile 写回或 node_modules 修改；跨版本浏览器测试覆盖审批后续答、历史恢复与页面异常。\n\n## 分发\n')
p = root / 'scripts/e2e/web-owner.spec.mjs'
needle = "    await writeFile(testInfo.outputPath('proof.json'), JSON.stringify({"
replace(p, needle, "    // A rendered reply must not hide a crashed native conversation/approval UI.\n    expect(transport.filter(item => item.kind === 'page-error' || item.kind === 'error' && /PendingSubmissionBubble|slot .*crashed|reading .map/i.test(item.message))).toEqual([])\n" + needle)
subprocess.run(['git', 'diff', '--check'], check=True)
