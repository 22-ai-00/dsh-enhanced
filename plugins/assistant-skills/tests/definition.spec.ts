import { describe, expect, it } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { createDefinition, fileObservationSteps, instantiate, type SkillRunExpansion, type VerifiedWorkflowSource } from '../src/definition.ts'

function source(steps: VerifiedWorkflowSource['steps'] = [{ id: 'call-1', toolName: 'files_read', arguments: { path: '/tmp/report.txt', retry: false, limit: 10 } }]): VerifiedWorkflowSource {
  return { protocol: 'assistant-goals/verified-workflow-source/v1', scope: { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' },
    goal: { id: 'goal', definition: { version: 1, digest: 'a'.repeat(64), objective: 'Read the report.' }, sessionId: 'session', nativeGoalId: 'native' },
    runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: 'b'.repeat(64), receiptDigest: 'c'.repeat(64), verifiedAt: 1, validUntil: 2 }, steps }
}

describe('skill definitions', () => {
  it('derives scalar bindings and instantiates declared values without mutating defaults', () => {
    const definition = createDefinition(source([{ id: 'read', toolName: 'files_read', arguments: { path: '/tmp/a', retry: false } }, { id: 'summarize', toolName: 'text_summary', arguments: { max: 10 } }]),
      { name: 'read-report', description: 'Read and summarize a report.', bindings: [{ name: 'path', stepId: 'read', path: '/path' }, { name: 'max', stepId: 'summarize', path: '/max' }] }, ['files_read', 'text_summary'])
    expect(definition.steps[1]!.dependsOn).toEqual(['read'])
    const materialized = instantiate(definition, { path: '/tmp/b', max: 20 })
    expect(materialized.steps).toMatchObject([{ arguments: { path: '/tmp/b', retry: false } }, { arguments: { max: 20 } }])
    expect(definition.steps).toMatchObject([{ arguments: { path: '/tmp/a' } }, { arguments: { max: 10 } }])
    expect(instantiate(definition).steps).toMatchObject([{ arguments: { path: '/tmp/a' } }, { arguments: { max: 10 } }])
  })

  it('rejects untrusted traces, unsafe bindings, and invalid invocation inputs', () => {
    expect(() => createDefinition(source([]), { name: 'empty', description: 'x' }, [])).toThrow()
    expect(() => createDefinition(source([{ id: 'goal', toolName: 'goal_control', arguments: {} }]), { name: 'blocked', description: 'x' }, ['goal_control'])).toThrow()
    expect(() => createDefinition(source([{ id: 'other', toolName: 'files_read', arguments: {} }]), { name: 'not-allowed', description: 'x' }, [])).toThrow()
    expect(() => createDefinition(source(), { name: 'bad_name', description: 'x' }, ['files_read'])).toThrow()
    expect(() => createDefinition(source(), { name: 'bad-path', description: 'x', bindings: [{ name: 'path', stepId: 'call-1', path: '/__proto__' }] }, ['files_read'])).toThrow()
    expect(() => createDefinition(source(), { name: 'nested', description: 'x', bindings: [{ name: 'path', stepId: 'call-1', path: '/path/x' }] }, ['files_read'])).toThrow()
    expect(() => createDefinition(source(), { name: 'duplicate', description: 'x', bindings: [{ name: 'path', stepId: 'call-1', path: '/path' }, { name: 'path', stepId: 'call-1', path: '/retry' }] }, ['files_read'])).toThrow()
    expect(() => createDefinition(source(), { name: 'duplicate-path', description: 'x', bindings: [{ name: 'path', stepId: 'call-1', path: '/path' }, { name: 'other_path', stepId: 'call-1', path: '/path' }] }, ['files_read'])).toThrow()
    expect(() => createDefinition(source([{ id: 'code', toolName: 'run_code', arguments: {} }]), { name: 'code', description: 'x' }, ['run_code'])).toThrow()
    expect(() => createDefinition(source([{ id: 'goal-read', toolName: 'get_goal', arguments: {} }]), { name: 'goal-read', description: 'x' }, [])).toThrow()
    expect(() => createDefinition(source([{ id: 'goal-args', toolName: 'get_goal', arguments: { ignored: true } }]), { name: 'goal-args', description: 'x' }, ['get_goal'])).toThrow()
    expect(() => createDefinition(source([{ id: 'goal-create', toolName: 'create_goal', arguments: {} }]), { name: 'goal-create', description: 'x' }, ['create_goal'])).toThrow()
    const argumentsWithGetter = Object.create(Object.prototype, { path: { enumerable: true, get: () => '/tmp/x' } })
    expect(() => createDefinition(source([{ id: 'getter', toolName: 'files_read', arguments: argumentsWithGetter }]), { name: 'getter', description: 'x' }, ['files_read'])).toThrow()
    const definition = createDefinition(source(), { name: 'read-report', description: 'x', bindings: [{ name: 'path', stepId: 'call-1', path: '/path' }] }, ['files_read'])
    expect(() => instantiate(definition, { path: 3 })).toThrow()
    expect(() => instantiate(definition, { path: 'x'.repeat(262144) })).toThrow(/too large/u)
    expect(() => instantiate(definition, { unknown: '/tmp/x' })).toThrow()
    const getter = Object.create(null, { path: { enumerable: true, get: () => '/tmp/x' } })
    expect(() => instantiate(definition, getter)).toThrow()
  })

  it('permits only Host-allowlisted parameterless native get_goal reads', () => {
    const definition = createDefinition(source([{ id: 'goal-read', toolName: 'get_goal', arguments: {} }]), { name: 'goal-read', description: 'Read current Goal.' }, ['get_goal'])
    expect(definition.steps).toEqual([{ id: 'goal-read', toolName: 'get_goal', arguments: {}, dependsOn: [] }])
  })

  it('preserves trusted failed read-only observations without replaying them as steps', () => {
    const enriched: VerifiedWorkflowSource = { ...source([{ id: 'write', toolName: 'write', arguments: { file: 'result.txt', data: 'done' } }]),
      failedObservations: [{ id: 'missing', toolName: 'read', arguments: { file: 'missing.txt' }, outcome: 'failed' }] }
    const definition = createDefinition(enriched, { name: 'write-result', description: 'Write result.' }, ['write'])
    expect(definition.source.failedObservations).toEqual(enriched.failedObservations)
    expect(definition.steps).toEqual([{ id: 'write', toolName: 'write', arguments: { file: 'result.txt', data: 'done' }, dependsOn: [] }])
    expect(() => createDefinition({ ...enriched, failedObservations: [{ id: 'failed-write', toolName: 'write', arguments: {}, outcome: 'failed' }] }, { name: 'bad-observation', description: 'x' }, ['write'])).toThrow()
    expect(() => createDefinition({ ...enriched, failedObservations: [{ id: 'failed-read', toolName: 'read', arguments: {}, outcome: 'unknown' as never }] }, { name: 'unknown-observation', description: 'x' }, ['write'])).toThrow()
  })

  it('expands an exact successful skill_run into fixed bound steps while preserving source provenance', () => {
    const call = { id: 'active-run', toolName: 'skill_run', arguments: { goal_id: 'goal', name: 'active', version: 1, inputs_json: '{"path":"result.md"}', invocation_id: 'review' } }
    const proof: SkillRunExpansion = { protocol: 'assistant-skills/run-expansion/v1', callId: call.id, runId: 'skill-run-id', runDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64), inputsDigest: 'c'.repeat(64),
      steps: [{ id: 'write-result', toolName: 'write', arguments: { file_path: 'result.md', content: 'done' } }] }
    expect(() => createDefinition(source([call]), { name: 'without-proof', description: 'A control call cannot be replayed.' }, ['write'])).toThrow(/untrusted tool trace/u)
    const expandedId = `expanded:${acceptanceDigest([call.id, proof.steps[0]!.id])}`
    const definition = createDefinition(source([call]), { name: 'expanded-run', description: 'Use the fixed successful active run.', bindings: [{ name: 'path', stepId: expandedId, path: '/file_path' }] }, ['read', 'write'], [proof])
    expect(definition.source.steps).toEqual([call])
    expect(definition.runExpansions).toEqual([proof])
    expect(definition.steps).toEqual([{ id: expandedId, toolName: 'write', arguments: { file_path: 'result.md', content: 'done' }, dependsOn: [] }])
    expect(definition.fileObservations).toEqual({ protocol: 'assistant-skills/file-observations/v1', beforeSteps: [expandedId] })
    expect(fileObservationSteps(instantiate(definition, { path: 'bound.md' }))).toEqual([{ id: 'file-observation:1', beforeStepId: expandedId, filePath: 'bound.md', allowAbsent: true }])
  })

  it('rejects forged, uncontrolled, duplicate, and oversized skill-run expansions', () => {
    const call = { id: 'active-run', toolName: 'skill_run', arguments: { goal_id: 'goal', name: 'active', version: 1, inputs_json: '{}', invocation_id: 'review' } }
    const proof = (): SkillRunExpansion => ({ protocol: 'assistant-skills/run-expansion/v1', callId: call.id, runId: 'skill-run-id', runDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64), inputsDigest: 'c'.repeat(64),
      steps: [{ id: 'write-result', toolName: 'write', arguments: { file_path: 'result.md', content: 'done' } }] })
    const derive = (expansions: readonly SkillRunExpansion[]) => createDefinition(source([call]), { name: 'expanded-guard', description: 'Reject untrusted expansion proofs.' }, ['write'], expansions)
    expect(() => derive([{ ...proof(), callId: 'other-call' }])).toThrow(/run expansion/u)
    expect(() => derive([{ ...proof(), runDigest: 'bad' }])).toThrow(/run expansion/u)
    expect(() => derive([proof(), proof()])).toThrow(/run expansion/u)
    expect(() => derive([{ ...proof(), steps: [] }])).toThrow(/run expansion/u)
    expect(() => derive([{ ...proof(), steps: [{ ...proof().steps[0]! }, { ...proof().steps[0]! }] }])).toThrow(/run expansion/u)
    expect(() => derive([{ ...proof(), steps: [{ ...proof().steps[0]!, toolName: 'skill_run' }] }])).toThrow(/untrusted tool trace/u)
    expect(() => derive([{ ...proof(), steps: [{ ...proof().steps[0]!, toolName: 'unknown' }] }])).toThrow(/untrusted tool trace/u)
    expect(() => createDefinition(source([call]), { name: 'expanded-extra', description: 'Reject extra proof fields.' }, ['write'], [{ ...proof(), extra: true } as unknown as SkillRunExpansion])).toThrow(/run expansion/u)
    const writes = Array.from({ length: 17 }, (_, index) => ({ id: `write-${index}`, toolName: 'write', arguments: { file_path: `${index}.md`, content: 'x' } }))
    expect(() => derive([{ ...proof(), steps: writes }])).toThrow(/bounded tool trace/u)
  })

  it('declares bounded same-path native file observations and applies path bindings before use', () => {
    const definition = createDefinition(source([
      { id: 'write', toolName: 'write', arguments: { file_path: 'draft.md', content: 'draft' } },
      { id: 'edit', toolName: 'edit', arguments: { file_path: 'draft.md', old_string: 'draft', new_string: 'done' } },
    ]), { name: 'guarded-file', description: 'Write and edit one guarded file.', bindings: [{ name: 'path', stepId: 'write', path: '/file_path' }, { name: 'edit_path', stepId: 'edit', path: '/file_path' }] }, ['read', 'write', 'edit'])
    expect(definition.fileObservations).toEqual({ protocol: 'assistant-skills/file-observations/v1', beforeSteps: ['write', 'edit'] })
    expect(fileObservationSteps(instantiate(definition, { path: 'created.md', edit_path: 'created.md' }))).toEqual([
      { id: 'file-observation:1', beforeStepId: 'write', filePath: 'created.md', allowAbsent: true },
      { id: 'file-observation:2', beforeStepId: 'edit', filePath: 'created.md', allowAbsent: false },
    ])
  })

  it('rejects forged file-observation declarations and preserves legacy definitions without inference', () => {
    const definition = createDefinition(source([
      { id: 'write', toolName: 'write', arguments: { file_path: 'draft.md', content: 'draft' } },
      { id: 'edit', toolName: 'edit', arguments: { file_path: 'draft.md', old_string: 'draft', new_string: 'done' } },
    ]), { name: 'guarded-file', description: 'Write and edit one guarded file.' }, ['read', 'write', 'edit'])
    const forged = (change: (value: any) => void) => { const value = JSON.parse(JSON.stringify(definition)); change(value); return value }
    expect(() => instantiate(forged(value => { value.fileObservations.beforeSteps = ['edit', 'write'] }))).toThrow(/file observations/u)
    expect(() => instantiate(forged(value => { value.fileObservations.protocol = 'forged' }))).toThrow(/file observations/u)
    expect(() => instantiate(forged(value => { value.fileObservations.beforeSteps = ['write'] }))).toThrow(/file observations/u)
    expect(() => fileObservationSteps(forged(value => { value.steps[0].id = 'file-observation:1'; value.fileObservations.beforeSteps[0] = 'file-observation:1' }))).toThrow(/file observations/u)
    expect(() => createDefinition(source([{ id: 'file-observation:1', toolName: 'write', arguments: { file_path: 'draft.md', content: 'draft' } }]), { name: 'captured-collision', description: 'Reject generated observation ID collisions.' }, ['read', 'write'])).toThrow(/file observations/u)
    const legacy = forged(value => { delete value.fileObservations })
    expect(fileObservationSteps(instantiate(legacy))).toEqual([])
  })

  it('bounds generated observations with their standard file mutators', () => {
    const writes = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `write-${index}`, toolName: 'write', arguments: { file_path: `${index}.md`, content: 'x' } }))
    expect(createDefinition(source(writes(16)), { name: 'sixteen-writes', description: 'Bounded native writes.' }, ['read', 'write']).fileObservations?.beforeSteps).toHaveLength(16)
    expect(() => createDefinition(source(writes(17)), { name: 'seventeen-writes', description: 'Over the combined bound.' }, ['read', 'write'])).toThrow(/bounded/u)
  })

  it('counts generated preflight read arguments toward the capture byte limit even without read permission', () => {
    const empty = Buffer.byteLength(JSON.stringify([{ file_path: 'x', content: '' }]), 'utf8')
    expect(() => createDefinition(source([{ id: 'write', toolName: 'write', arguments: { file_path: 'x', content: 'x'.repeat(256 * 1024 - empty) } }]),
      { name: 'preflight-bytes', description: 'Reject synthetic reads above the argument bound.' }, ['write'])).toThrow(/file observations exceed argument limit/u)
  })

  it('retains only exact valid todo_write planning provenance', () => {
    const todo = { id: 'todo', toolName: 'todo_write', arguments: { todos: [{ content: 'Capture result', status: 'completed' }] } }
    const write = { id: 'write', toolName: 'write', arguments: { file_path: 'result.md', content: 'done' } }
    const definition = createDefinition(source([todo, write]), { name: 'todo-provenance', description: 'Keep planning provenance.' }, ['write'])
    expect(definition.source.steps).toEqual([todo, write])
    expect(definition.steps).toEqual([{ ...write, dependsOn: [] }])
    expect(definition.fileObservations).toEqual({ protocol: 'assistant-skills/file-observations/v1', beforeSteps: ['write'] })
    expect(() => createDefinition(source([todo, write]), { name: 'todo-binding', description: 'Reject omitted bindings.', bindings: [{ name: 'todos', stepId: 'todo', path: '/todos' }] }, ['write'])).toThrow(/binding step/u)
    for (const arguments_ of [
      { todos: [{ content: 'x', status: 'completed', extra: true }] },
      { todos: [{ content: '', status: 'completed' }] },
      { todos: [{ content: 'x', status: 'invalid' }] },
      { todos: [{ content: 'x', status: 'completed' }, { content: ' x ', status: 'pending' }] },
      { todos: [], other: true },
    ]) expect(() => createDefinition(source([{ ...todo, arguments: arguments_ }, write]), { name: 'invalid-todo', description: 'Reject invalid planning provenance.' }, ['write'])).toThrow(/todo provenance/u)
  })

  it('bounds steps and serialized arguments', () => {
    const many = Array.from({ length: 33 }, (_, index) => ({ id: `call-${index}`, toolName: 'files_read', arguments: {} }))
    expect(() => createDefinition(source(many), { name: 'many', description: 'x' }, ['files_read'])).toThrow()
    expect(() => createDefinition(source([{ id: 'large', toolName: 'files_read', arguments: { text: 'x'.repeat(256 * 1024) } }]), { name: 'large', description: 'x' }, ['files_read'])).toThrow()
  })

  it('retains exact source Goal checkpoints as planning provenance without replay or bindings', () => {
    const write = { id: 'write', toolName: 'write', arguments: { content: 'draft' } }
    const note = { id: 'note', toolName: 'goal_checkpoint', arguments: { goal_id: 'goal', expected_version: 2, next_step: 'verify', blockers: [], assumptions: [], evidence_refs: [], dependencies: [] } }
    const edit = { id: 'edit', toolName: 'edit', arguments: { new_string: 'final' } }
    const options = { name: 'with-planning', description: 'Preserve the work and its planning provenance.' }
    const derive = (steps: VerifiedWorkflowSource['steps']) => createDefinition(source(steps), options, ['write', 'edit', 'goal_checkpoint'])
    const definition = derive([write, note, edit])
    expect(definition.source.steps).toEqual([write, note, edit])
    expect(instantiate(definition).steps).toEqual([{ ...write, dependsOn: [] }, { ...edit, dependsOn: ['write'] }])
    expect(() => derive([note])).toThrow(/executable/u)
    for (const args of [{ ...note.arguments, goal_id: 'foreign' }, { ...note.arguments, expected_version: 0 }, { ...note.arguments, operation: 'resume' }, { ...note.arguments, assumptions: [{ statement: 'x', expires_at: 'tomorrow' }] }]) {
      expect(() => derive([write, { ...note, arguments: args }])).toThrow(/untrusted/u)
    }
    expect(() => derive([write, { ...note, id: 'write' }])).toThrow(/bounded/u)
    expect(() => derive([write, { ...note, arguments: { ...note.arguments, next_step: 'x'.repeat(262144) } }])).toThrow(/bounded/u)
    expect(() => createDefinition(source([write, note]), { ...options, bindings: [{ name: 'next', stepId: 'note', path: '/next_step' }] }, ['write'])).toThrow(/binding step/u)
    expect(() => createDefinition({ ...source([write]), failedObservations: [{ ...note, outcome: 'failed' }] }, options, ['write'])).toThrow(/observation/u)
  })

  it('retains owner skill catalog inspection as provenance without replaying control tools', () => {
    const read = { id: 'read', toolName: 'read', arguments: { file_path: 'summarize.mjs' } }
    const inspection = { id: 'status', toolName: 'skill_status', arguments: {} }
    const goal = { id: 'goal', toolName: 'get_goal', arguments: {} }
    const options = { name: 'review-summary', description: 'Review existing summary.' }
    const derive = (steps: VerifiedWorkflowSource['steps']) => createDefinition(source(steps), options, ['read', 'get_goal'])
    const definition = derive([read, inspection, goal])
    expect(definition.source.steps).toEqual([read, inspection, goal])
    expect(instantiate(definition).steps).toEqual([{ ...read, dependsOn: [] }, { ...goal, dependsOn: ['read'] }])
    expect(() => derive([inspection])).toThrow(/executable/u)
    for (const step of [{ ...inspection, arguments: { run_id: 'other-run' } }, { ...inspection, arguments: { operation: 'activate' } }, { ...inspection, toolName: 'skill_activate' }]) {
      expect(() => derive([read, step])).toThrow(/untrusted/u)
    }
    expect(() => createDefinition(source([read, inspection]), { ...options, bindings: [{ name: 'catalog', stepId: 'status', path: '/run_id' }] }, ['read'])).toThrow(/binding step/u)
  })

  it('keeps the complete write-then-repair sequence and excludes observations across native rounds', () => {
    const write = { id: 'initial-write', toolName: 'write', arguments: { file_path: 'report.txt', content: 'draft' } }
    const repair = { id: 'repair', toolName: 'edit', arguments: { file_path: 'report.txt', old_string: 'draft', new_string: 'verified' } }
    const value: VerifiedWorkflowSource = { ...source([repair]), runId: 'final-run', turn: 4, segments: [
      { runId: 'initial-run', turn: 3, round: 1, nativeRevision: 1, steps: [write], failedObservations: [{ id: 'probe', toolName: 'read', arguments: { file_path: 'report.txt' }, outcome: 'failed' }] },
      { runId: 'final-run', turn: 4, round: 2, nativeRevision: 2, steps: [repair] },
    ] }
    const derive = (input: VerifiedWorkflowSource) => createDefinition(input, { name: 'repair-report', description: 'Write and repair the report.' }, ['write', 'edit'])
    const definition = derive(value)
    expect(definition.steps).toEqual([{ ...write, dependsOn: [] }, { ...repair, dependsOn: ['initial-write'] }])
    expect(definition.source.steps).toEqual([repair])
    expect(definition.source.segments).toEqual(value.segments)
    expect(instantiate(definition).steps.map(step => step.id)).toEqual(['initial-write', 'repair'])
    expect(() => derive({ ...value, segments: [value.segments![1]!] })).toThrow()
    expect(() => derive({ ...value, segments: [value.segments![0]!, { ...value.segments![1]!, round: 3 }] })).toThrow()
    expect(() => derive({ ...value, segments: [{ ...value.segments![0]!, runId: 'final-run' }, value.segments![1]!] })).toThrow()
    expect(() => derive({ ...value, steps: [write] })).toThrow(/final source segment mismatch/u)
    expect(() => derive({ ...value, segments: [{ ...value.segments![0]!, steps: [{ ...write, id: 'repair' }] }, value.segments![1]!] })).toThrow()
    expect(() => derive({ ...value, segments: [{ ...value.segments![0]!, failedObservations: [{ id: 'failed-write', toolName: 'write', arguments: {}, outcome: 'failed' }] }, value.segments![1]!] })).toThrow()
    expect(() => derive({ ...value, segments: [{ ...value.segments![0]!, steps: Array.from({ length: 32 }, (_, index) => ({ ...write, id: `write-${index}` })) }, value.segments![1]!] })).toThrow()
  })
})
