import { relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// These independently isolated installer groups dominated the root suite's
// runtime. Keep them on different CI shards; the default path-hash split can
// otherwise put both on the same runner. Other files retain Vitest's sharding.
const installerGroups = [
  'tests/installers-linux-lifecycle.spec.ts',
  'tests/installers-local-source.spec.ts',
]

export class RootTestSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const groupIndex = (file: TestSpecification) => installerGroups.indexOf(
      relative(this.ctx.config.root, file.moduleId).replaceAll('\\', '/'),
    )
    const ordinary = files.filter(file => groupIndex(file) === -1)
    const assigned = files.filter(file => {
      const group = groupIndex(file)
      return group !== -1 && group % count + 1 === index
    })
    return [...await super.shard(ordinary), ...assigned]
  }
}
