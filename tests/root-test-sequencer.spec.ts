import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { BaseSequencer, type TestSpecification, type Vitest } from 'vitest/node'
import { RootTestSequencer } from './root-test-sequencer.ts'

const root = resolve('/root-suite')
const heavy = ['installers-linux-lifecycle.spec.ts', 'installers-local-source.spec.ts']
const ordinary = ['installers.spec.ts', 'release-adapter.spec.ts', 'other.spec.ts', 'new.spec.ts', 'last.test.ts']
const specifications = (names: string[]) => names.map(name => ({ moduleId: resolve(root, 'tests', name) }) as TestSpecification)
const context = (index: number, count: number) => ({ config: { root, shard: { index, count } } }) as Vitest
const ids = (files: TestSpecification[]) => files.map(file => file.moduleId)

describe('root test sharding', () => {
  test('keeps the two slow installer groups on different runners', async () => {
    const files = specifications([...ordinary, ...heavy])
    const first = ids(await new RootTestSequencer(context(1, 2)).shard(files))
    const second = ids(await new RootTestSequencer(context(2, 2)).shard(files))
    expect(first).toContain(resolve(root, 'tests', heavy[0]!))
    expect(first).not.toContain(resolve(root, 'tests', heavy[1]!))
    expect(second).toContain(resolve(root, 'tests', heavy[1]!))
    expect(second).not.toContain(resolve(root, 'tests', heavy[0]!))
  })

  test.each([1, 2, 3])('covers every selected file once with %i shards', async count => {
    const files = specifications([...ordinary, ...heavy])
    const shards = await Promise.all(Array.from({ length: count }, (_, offset) =>
      new RootTestSequencer(context(offset + 1, count)).shard(files)))
    expect(ids(shards.flat()).sort()).toEqual(ids(files).sort())
    expect(new Set(ids(shards.flat())).size).toBe(files.length)
  })

  test('retains default assignment for other files and honors a filtered selection', async () => {
    const files = specifications(ordinary)
    for (const index of [1, 2]) {
      expect(await new RootTestSequencer(context(index, 2)).shard(files))
        .toEqual(await new BaseSequencer(context(index, 2)).shard(files))
      const selected = specifications([ordinary[0]!, heavy[1]!])
      const result = ids(await new RootTestSequencer(context(index, 2)).shard(selected))
      expect(result.every(id => ids(selected).includes(id))).toBe(true)
      expect(result.includes(resolve(root, 'tests', heavy[1]!))).toBe(index === 2)
    }
  })
})
