import type { Context } from '@deepseek-ai/cordis'

const marker = 'dsh-enhanced host ready: v1\n'

interface AppReady {
  onReady(listener: () => void): () => void
}

/** Observe the native launcher's post-audit signal without gating the Control Plane on its presence. */
export function installHostReadiness(ctx: Context, write: (text: string) => void = text => { process.stderr.write(text) }): void {
  ctx.inject(['appReady' as never], readyCtx => {
    readyCtx.effect(() => {
      const appReady = readyCtx.get('appReady' as never) as unknown as AppReady
      let active = true
      let reported = false
      const remove = appReady.onReady(() => {
        if (!active || reported) return
        reported = true
        write(marker)
      })
      return () => { active = false; remove() }
    }, 'plugin-control-plane.host-readiness')
  })
}
