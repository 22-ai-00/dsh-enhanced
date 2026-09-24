import { Context } from '@deepseek-ai/cordis'
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
      const owner = ctx.plugin({ inject: ['loader'], async apply(active: Context) {
        tree = createOwnerSessionTree(active, EntryTree, path, { inject: ['loader'], apply(inner: Context) {
          expect(inner.loader).toBeDefined()
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
