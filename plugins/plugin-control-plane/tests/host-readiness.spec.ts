import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { installHostReadiness } from '../src/host-readiness.js'
import { PluginControlPlaneService } from '../src/service.js'

const fixtures: Array<{ ctx: Context; root?: string }> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) {
    await fixture.ctx.fiber.dispose()
    if (fixture.root) await rm(fixture.root, { recursive: true, force: true })
  }
})

class ReadyPeer {
  readonly listeners = new Set<() => void>()
  onReady(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  commit(): void { for (const listener of this.listeners) listener() }
}

async function provider(ctx: Context, ready: ReadyPeer) {
  const fiber = ctx.plugin({ name: 'native-app-ready-test-peer', apply(peerCtx: Context) {
    peerCtx.provide('appReady' as never, ready as never)
  } })
  await fiber
  await vi.waitFor(() => expect(ready.listeners.size).toBe(1))
  return fiber
}

describe.sequential('native Host readiness notification on pinned Cordis', () => {
  test('mounted Control Plane remains active without appReady, then writes stderr only after commit and removes stale listeners', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-host-ready-'))
    const ctx = new Context(); fixtures.push({ ctx, root })
    const stderrWrites: string[] = []
    const stdoutWrites: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderrWrites.push(String(chunk)); return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdoutWrites.push(String(chunk)); return true })
    const consumer = ctx.plugin(PluginControlPlaneService, {
      catalogPath: join(root, 'catalog.json'), statePath: join(root, 'state'), trustPath: join(root, 'trust.json'),
    })
    await consumer
    expect(ctx.get('pluginControlPlane')).toBeInstanceOf(PluginControlPlaneService)
    expect(stderrWrites).toEqual([])
    expect(stdoutWrites).toEqual([])

    const first = new ReadyPeer()
    const firstFiber = await provider(ctx, first)
    expect(stderrWrites).toEqual([])
    expect(stdoutWrites).toEqual([])
    const staleFirst = [...first.listeners][0]!
    first.commit()
    first.commit()
    expect(stderrWrites).toEqual(['dsh-enhanced host ready: v1\n'])
    expect(stdoutWrites).toEqual([])
    await firstFiber.dispose()
    expect(first.listeners.size).toBe(0)
    staleFirst()
    expect(stderrWrites).toHaveLength(1)
    expect(stdoutWrites).toEqual([])

    const second = new ReadyPeer()
    await provider(ctx, second)
    const staleSecond = [...second.listeners][0]!
    second.commit()
    expect(stderrWrites).toEqual(['dsh-enhanced host ready: v1\n', 'dsh-enhanced host ready: v1\n'])
    expect(stdoutWrites).toEqual([])
    await consumer.dispose()
    expect(second.listeners.size).toBe(0)
    staleSecond()
    expect(stderrWrites).toHaveLength(2)
    expect(stdoutWrites).toEqual([])
  })

  test('provider removal before readiness suppresses a late callback; replacement can commit', async () => {
    const ctx = new Context(); fixtures.push({ ctx })
    const writes: string[] = []
    const consumer = ctx.plugin({ name: 'host-ready-consumer', apply(ownerCtx: Context) {
      installHostReadiness(ownerCtx, text => { writes.push(text) })
    } })
    await consumer
    const first = new ReadyPeer()
    const firstFiber = await provider(ctx, first)
    const stale = [...first.listeners][0]!
    await firstFiber.dispose()
    expect(first.listeners.size).toBe(0)
    stale()
    expect(writes).toEqual([])

    const replacement = new ReadyPeer()
    await provider(ctx, replacement)
    replacement.commit()
    expect(writes).toEqual(['dsh-enhanced host ready: v1\n'])
    await consumer.dispose()
    expect(replacement.listeners.size).toBe(0)
  })
})
