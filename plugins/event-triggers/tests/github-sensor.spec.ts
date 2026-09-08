import { describe, expect, it, vi } from 'vitest'
import { readGitHubRepositoryObservation } from '../src/github-sensor.ts'

const repository = 'owner/repository', branch = 'delivery/fix', baseBranch = 'main', head = 'a'.repeat(40)
const lookup = async () => [{ address: '93.184.216.34', family: 4 }]
const pull = { id: 1, number: 7, state: 'open', head: { ref: branch, sha: head, repo: { full_name: repository } }, base: { ref: baseBranch, repo: { full_name: repository } } }
const checks = { total_count: 1, check_runs: [{ id: 1, name: 'CI', app: { id: 7 }, head_sha: head, status: 'completed', conclusion: 'success' }] }
const review = [{ id: 1, user: { id: 42 }, commit_id: head, state: 'APPROVED' }]
function fixture(overrides: Partial<Record<'checks' | 'pulls' | 'reviews', unknown>> = {}) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET'); expect(init.redirect).toBe('manual')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token')
    expect(new Headers(init.headers).get('user-agent')).toBe('dsh-enhanced-event-triggers')
    const path = new URL(url).pathname
    const body = path.includes('/check-runs') ? (overrides.checks ?? checks) : path.endsWith('/pulls') ? (overrides.pulls ?? [pull]) : (overrides.reviews ?? review)
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return fetcher
}
function read(fetcher: ReturnType<typeof vi.fn>, extra: Partial<Parameters<typeof readGitHubRepositoryObservation>[0]> = {}) {
  return readGitHubRepositoryObservation({ repository, branch, baseBranch, token: 'fixture-token', maxBodyBytes: 16_384, timeoutMs: 1_000, signal: new AbortController().signal, lookup, fetcher: fetcher as unknown as import('../src/sensors.ts').Fetcher, ...extra })
}

describe('GitHub repository observation sensor', () => {
  it('uses the three fixed GitHub endpoints and fixed bearer headers', async () => {
    const fetcher = fixture(), beforeRequest = vi.fn()
    const observed = await read(fetcher, { beforeRequest })
    expect(observed.truthy).toBe(true); expect(fetcher).toHaveBeenCalledTimes(3); expect(beforeRequest).toHaveBeenCalledTimes(6)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`,
      `https://api.github.com/repos/${repository}/pulls?state=open&head=owner%3A${encodeURIComponent(branch)}&base=main&per_page=100`,
      `https://api.github.com/repos/${repository}/pulls/7/reviews?per_page=100`,
    ])
    expect(JSON.stringify(observed)).not.toContain('fixture-token')
  })

  it('changes the untrusted fingerprint for CI or review changes and accepts no-PR baseline with two reads', async () => {
    const first = await read(fixture())
    const changed = await read(fixture({ checks: { ...checks, check_runs: [{ ...checks.check_runs[0], conclusion: 'failure' }] } }))
    const reviewChanged = await read(fixture({ reviews: [{ ...review[0], state: 'CHANGES_REQUESTED' }] }))
    expect(changed.fingerprint).not.toBe(first.fingerprint); expect(reviewChanged.fingerprint).not.toBe(first.fingerprint)
    const noPr = fixture({ pulls: [] }); await expect(read(noPr)).resolves.toMatchObject({ truthy: true }); expect(noPr).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['foreign repository', [{ ...pull, head: { ...pull.head, repo: { full_name: 'other/repository' } } }]],
    ['foreign branch', [{ ...pull, head: { ...pull.head, ref: 'other' } }]],
    ['truncated pulls', Array.from({ length: 100 }, () => pull)],
  ])('rejects %s rather than using an ambiguous snapshot', async (_name, pulls) => {
    await expect(read(fixture({ pulls }), { maxBodyBytes: 100_000 })).rejects.toThrow('unavailable')
  })

  it('rejects a truncated CI page even when the returned checks are green', async () => {
    await expect(read(fixture({ checks: { ...checks, total_count: 2 } }))).rejects.toThrow('unavailable')
  })

  it('cancels the pinned request when the shared deadline expires', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    await expect(read(fetcher, { timeoutMs: 10 })).rejects.toThrow('unavailable')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('shares cancellation with the outer signal before dispatch', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'))
    const fetcher = fixture()
    await expect(readGitHubRepositoryObservation({ repository, branch, baseBranch, token: 'fixture-token', maxBodyBytes: 16_384, timeoutMs: 1_000, signal: controller.signal, lookup, fetcher })).rejects.toThrow('unavailable')
    expect(fetcher).not.toHaveBeenCalled()
  })
})

  it('rejects a paginated response rather than observing only its first page', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const pathname = new URL(url).pathname
      if (pathname.includes('/check-runs')) return new Response(JSON.stringify(checks), { status: 200 })
      return new Response(JSON.stringify([pull]), { status: 200, headers: { link: '<https://api.github.com/next>; rel="next"' } })
    })
    await expect(read(fetcher)).rejects.toThrow('unavailable')
  })

  it('rejects duplicate review identities instead of reordering GitHub’s chronological array', async () => {
    await expect(read(fixture({ reviews: [review[0], { ...review[0], state: 'CHANGES_REQUESTED' }] }))).rejects.toThrow('unavailable')
  })
