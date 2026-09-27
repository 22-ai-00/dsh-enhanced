import { advanceSourceRelease } from '../../src/source-release-runner.ts'
import { fixture } from './source-release-runner.ts'

/** Real Store, approvals, and eight signed release receipts; external adapters alone are scripted by the fixture. */
export async function sourceBaselineRelease(input: { repository: string; baseCommit: string; mergeCommit: string }) {
  const first = await fixture(true, input)
  if ((await advanceSourceRelease(first.options)).status !== 'awaiting-review') throw new Error('source baseline fixture did not request review')
  await first.decide()
  if ((await advanceSourceRelease(first.options)).status !== 'release-complete') throw new Error('source baseline fixture did not complete release')
  return {
    ...first,
    completeNext: async (next: { baseCommit: string; mergeCommit: string; repository?: string; managed?: boolean;
      baseline?: import('../../src/source-baseline.ts').SourceBaselineConfig;
      trustOverride?: import('../../src/trust.ts').PluginControlTrustConfig }) => {
      const second = await first.next(next)
      if ((await advanceSourceRelease(second.options)).status !== 'awaiting-review') throw new Error('second baseline fixture did not request review')
      await second.decide()
      if ((await advanceSourceRelease(second.options)).status !== 'release-complete') throw new Error('second baseline fixture did not complete release')
      return second
    },
  }
}
