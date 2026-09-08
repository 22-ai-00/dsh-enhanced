import { describe, expect, it } from 'vitest'
import { createDefinition, instantiate, type VerifiedWorkflowSource } from '../src/definition.ts'

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
    const argumentsWithGetter = Object.create(Object.prototype, { path: { enumerable: true, get: () => '/tmp/x' } })
    expect(() => createDefinition(source([{ id: 'getter', toolName: 'files_read', arguments: argumentsWithGetter }]), { name: 'getter', description: 'x' }, ['files_read'])).toThrow()
    const definition = createDefinition(source(), { name: 'read-report', description: 'x', bindings: [{ name: 'path', stepId: 'call-1', path: '/path' }] }, ['files_read'])
    expect(() => instantiate(definition, { path: 3 })).toThrow()
    expect(() => instantiate(definition, { path: 'x'.repeat(262144) })).toThrow(/too large/u)
    expect(() => instantiate(definition, { unknown: '/tmp/x' })).toThrow()
    const getter = Object.create(null, { path: { enumerable: true, get: () => '/tmp/x' } })
    expect(() => instantiate(definition, getter)).toThrow()
  })

  it('bounds steps and serialized arguments', () => {
    const many = Array.from({ length: 33 }, (_, index) => ({ id: `call-${index}`, toolName: 'files_read', arguments: {} }))
    expect(() => createDefinition(source(many), { name: 'many', description: 'x' }, ['files_read'])).toThrow()
    expect(() => createDefinition(source([{ id: 'large', toolName: 'files_read', arguments: { text: 'x'.repeat(256 * 1024) } }]), { name: 'large', description: 'x' }, ['files_read'])).toThrow()
  })
})
