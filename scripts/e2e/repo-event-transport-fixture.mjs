import { EventTriggersService } from '../../plugins/event-triggers/lib/index.js'
import { appendFileSync } from 'node:fs'
import { repositoryFixtureSnapshot } from './repo-verified-delivery-fixture.mjs'

export const name = 'dsh-enhanced-event-triggers'
export const inject = ['assistantPolicy', 'assistantAutomations', 'assistantDelivery', 'credentialsKeychain']
export default { name, inject, apply }

/** Only HTTPS transport/DNS are fixtures; the packaged sensor, lease, observer and event store run unchanged. */
export function apply(ctx, config) {
  if (process.env.DSH_REPO_EVENT_SOURCE_LOG) appendFileSync(process.env.DSH_REPO_EVENT_SOURCE_LOG, `${JSON.stringify({ at: Date.now(), consumer: ctx.fiber.name })}\n`, { mode: 0o600 })
  new EventTriggersService(ctx, config, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetcher: async (url, options) => {
      options.signal.throwIfAborted()
      if (new URL(url).origin !== 'https://api.github.com' || new Headers(options.headers).get('authorization') !== 'Bearer non-production-github-fixture') throw new Error('unexpected repository fixture request')
      const state = repositoryFixtureSnapshot(), path = new URL(url).pathname
      if (process.env.DSH_REPO_EVENT_SOURCE_LOG) appendFileSync(process.env.DSH_REPO_EVENT_SOURCE_LOG, `${JSON.stringify({ at: Date.now(), path, ready: state.ready, headOid: state.headOid, pullRequest: state.pullRequest?.number ?? null })}\n`, { mode: 0o600 })
      const body = path.endsWith('/check-runs') ? { total_count: state.checks.length, check_runs: state.checks }
        : path.endsWith('/pulls') ? state.pullRequest ? [state.pullRequest] : [] : state.reviews
      return new Response(JSON.stringify(body), { status: 200 })
    },
  })
}
