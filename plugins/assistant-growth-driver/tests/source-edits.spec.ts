import { describe, expect, it } from 'vitest'
import { MAX_SOURCE_FILE_BYTES, MAX_SOURCE_TOTAL_BYTES, resolveSourcePreparation } from '../src/source-edits.ts'

const validPath = (path: string) => path.length > 0
const snapshot = (entries: Record<string, string>) => ({ paths: new Set(Object.keys(entries)), read: new Map(Object.entries(entries)) })

describe('resolveSourcePreparation', () => {
  it('combines disjoint full files and exact edits without changing the original cache', () => {
    const source = snapshot({ 'src/a.ts': 'one TARGET two' })
    expect(resolveSourcePreparation({
      files: [{ path: 'tests/new.spec.ts', content: 'new test' }],
      edits: [{ path: 'src/a.ts', before: 'TARGET', after: 'resolved' }],
    }, source, validPath)).toEqual([
      { path: 'tests/new.spec.ts', content: 'new test' },
      { path: 'src/a.ts', content: 'one resolved two' },
    ])
    expect(source.read.get('src/a.ts')).toBe('one TARGET two')
  })

  it.each([
    ['repeated anchors', { 'src/a.ts': 'same same' }, [{ path: 'src/a.ts', before: 'same', after: 'next' }], /one exact literal occurrence/],
    ['overlapping occurrences of one anchor', { 'src/a.ts': 'aaa' }, [{ path: 'src/a.ts', before: 'aa', after: 'x' }], /one exact literal occurrence/],
    ['overlapping anchors', { 'src/a.ts': 'abcdef' }, [{ path: 'src/a.ts', before: 'abc', after: 'x' }, { path: 'src/a.ts', before: 'bcd', after: 'y' }], /overlap/],
    ['missing anchor', { 'src/a.ts': 'abc' }, [{ path: 'src/a.ts', before: 'missing', after: 'x' }], /one exact literal occurrence/],
    ['unread target', { 'src/a.ts': 'abc' }, [{ path: 'src/a.ts', before: 'abc', after: 'x' }], /already-read/],
    ['new edit target', { 'src/a.ts': 'abc' }, [{ path: 'src/new.ts', before: 'abc', after: 'x' }], /already-read/],
  ])('rejects %s', (_name, entries, edits, error) => {
    const source = snapshot(entries)
    if (_name === 'unread target') source.read.clear()
    expect(() => resolveSourcePreparation({ edits }, source, validPath)).toThrow(error)
  })

  it('applies length-changing replacements against original positions even when new text contains another anchor', () => {
    const source = snapshot({ 'src/a.ts': 'first / second / third' })
    expect(resolveSourcePreparation({ edits: [
      { path: 'src/a.ts', before: 'first', after: 'second expanded' },
      { path: 'src/a.ts', before: 'third', after: '' },
      { path: 'src/a.ts', before: 'second', after: 'middle' },
    ] }, source, validPath)).toEqual([{ path: 'src/a.ts', content: 'second expanded / middle / ' }])
  })

  it('rejects empty modes, full-file duplicates, and path collisions', () => {
    const source = snapshot({ 'src/a.ts': 'abc' })
    expect(() => resolveSourcePreparation({}, source, validPath)).toThrow(/nonempty/)
    expect(() => resolveSourcePreparation({ files: [] }, source, validPath)).toThrow(/nonempty/)
    expect(() => resolveSourcePreparation({ edits: [] }, source, validPath)).toThrow(/nonempty/)
    expect(() => resolveSourcePreparation({ files: 'not-an-array' as never }, source, validPath)).toThrow(/arrays/)
    expect(() => resolveSourcePreparation({ edits: [{ path: 'src/a.ts', before: 1, after: 'x' }] as never }, source, validPath)).toThrow(/edits exceed/)
    expect(() => resolveSourcePreparation({ files: [{ path: 'src/a.ts', content: 'x' }, { path: 'src/a.ts', content: 'y' }] }, source, validPath)).toThrow(/duplicate/)
    expect(() => resolveSourcePreparation({ files: [{ path: 'src/a.ts', content: 'x' }], edits: [{ path: 'src/a.ts', before: 'abc', after: 'y' }] }, source, validPath)).toThrow(/disjoint/)
  })

  it('accepts an unused empty mode alongside a nonempty mode', () => {
    const source = snapshot({ 'src/a.ts': 'abc' })
    expect(resolveSourcePreparation({ files: [{ path: 'src/a.ts', content: 'x' }], edits: [] }, source, validPath))
      .toEqual([{ path: 'src/a.ts', content: 'x' }])
    expect(resolveSourcePreparation({ files: [], edits: [{ path: 'src/a.ts', before: 'abc', after: 'y' }] }, source, validPath))
      .toEqual([{ path: 'src/a.ts', content: 'y' }])
    expect(() => resolveSourcePreparation({ files: [], edits: [] }, source, validPath)).toThrow(/nonempty/)
  })

  it('enforces operation, UTF-8 field, resolved-file, and aggregate limits', () => {
    const source = snapshot({ 'src/a.ts': 'anchor' })
    const edits = Array.from({ length: 65 }, () => ({ path: 'src/a.ts', before: 'anchor', after: 'x' }))
    expect(() => resolveSourcePreparation({ edits }, source, validPath)).toThrow(/operations/)
    expect(() => resolveSourcePreparation({ edits: [{ path: 'src/a.ts', before: 'anchor', after: '界'.repeat(Math.ceil(MAX_SOURCE_FILE_BYTES / 3)) }] }, source, validPath)).toThrow(/edits exceed/)
    expect(() => resolveSourcePreparation({ files: [{ path: 'new.ts', content: '界'.repeat(Math.ceil(MAX_SOURCE_FILE_BYTES / 3)) }] }, source, validPath)).toThrow(/files exceed/)
    expect(() => resolveSourcePreparation({ edits: [{ path: 'src/a.ts', before: 'anchor', after: 'x'.repeat(MAX_SOURCE_FILE_BYTES + 1) }] }, source, validPath)).toThrow(/edits exceed/)
    expect(() => resolveSourcePreparation({ edits: [{ path: 'src/a.ts', before: 'anchor', after: 'anchor!' }] },
      snapshot({ 'src/a.ts': 'anchor' + 'x'.repeat(MAX_SOURCE_FILE_BYTES - 6) }), validPath)).toThrow(/resolved source file exceeds/)
    const aggregateFiles = Array.from({ length: 5 }, (_, index) => ({ path: `new-${index}.ts`, content: 'x'.repeat(Math.floor(MAX_SOURCE_TOTAL_BYTES / 4)) }))
    expect(() => resolveSourcePreparation({ files: aggregateFiles }, source, validPath)).toThrow(/files exceed/)
  })
})
