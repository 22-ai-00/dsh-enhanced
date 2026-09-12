import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createProspectiveCanaryAuthority, repairPolicy } from '../scripts/e2e/real-canary-helpers.mjs'
import { compilePolicy, evaluatePolicy } from '../plugins/assistant-policy/src/evaluator.ts'

const digest = (character: string) => character.repeat(64)
const template = Object.freeze({ protocol: 'assistant-skills/canary-admission-template/v1', skillName: 'repair-render', taskFamily: Object.freeze({
  goalDefinitionDigest: digest('a'), outcomeProfile: Object.freeze({ id: 'repair-outcome', version: 1, digest: digest('b') }),
}) })

test('repair authority creates a parent-agnostic template profile from the common scaffold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'real-repair-authority-'))
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  const cli = join(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-skills/lib/holdout-cli.js')
  const previousImage = process.env.DSH_HOLDOUT_TEST_IMAGE
  try {
    await mkdir(join(workspace), { recursive: true })
    await mkdir(join(cli, '..'), { recursive: true })
    await writeFile(cli, `import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
const config = JSON.parse(readFileSync(process.argv.at(-1), 'utf8'))
const publicKey = createPublicKey(createPrivateKey(readFileSync(config.privateKeyPath))).export({ type: 'spki', format: 'pem' }).toString()
process.stdout.write(JSON.stringify({ publicKey, profileVersion: config.prospective.generator, profileDigest: '${digest('c')}', generatorDigest: '${digest('c')}' }))
`)
    process.env.DSH_HOLDOUT_TEST_IMAGE = `sha256:${digest('d')}`
    const authority = await createProspectiveCanaryAuthority({ root, home, workspace, task: { id: 'repair-render-v1', generator: 'template-render/v1', skillName: 'repair-render', artifactPath: 'render.mjs', scaffoldSource: 'throw new Error("scaffold")\n' } })
    const profile = authority.repairProfile({ id: 'owner-record', version: 3 }, { canaryAdmissionTemplate: template })

    expect(profile).toMatchObject({ id: 'real-repair-render-v1-repair', scope: { principalId: 'web/web/local/operator', principalRecordId: 'owner-record', principalVersion: 3, workspace, preset: 'standard' },
      files: [{ path: 'render.mjs', content: 'throw new Error("scaffold")\n' }], canaryAdmissionTemplate: template, authority: { generatorDigest: digest('c') } })
    expect(profile).not.toHaveProperty('canaryAdmission')
    expect(() => authority.repairProfile({ id: 'owner-record', version: 3 }, { canaryAdmissionTemplate: { ...template, parentDefinitionDigest: digest('e') } })).toThrow('exact repair canary admission template is required')
    expect(() => authority.repairProfile({ id: 'owner-record', version: 3 }, { canaryAdmissionTemplate: { ...template, skillName: 'wrong-skill' } })).toThrow('repair canary admission template has the wrong skill')
  } finally {
    if (previousImage === undefined) delete process.env.DSH_HOLDOUT_TEST_IMAGE
    else process.env.DSH_HOLDOUT_TEST_IMAGE = previousImage
    await rm(root, { recursive: true, force: true })
  }
})

test('repair policy keeps the canary permissions and adds bounded repair actions', () => {
  const policy = repairPolicy('/workspace')
  expect(policy.find(rule => rule.id === 'canary-owner')?.actions).toEqual(['inspect', 'run', 'compare', 'canary', 'watch'])
  expect(policy.find(rule => rule.id === 'canary-background')?.actions).toEqual(['capture', 'promote', 'watch', 'rollback'])
  expect(policy.find(rule => rule.id === 'repair-owner')?.actions).toEqual(['draft', 'compare', 'canary', 'watch'])
  expect(policy.find(rule => rule.id === 'repair-background')?.actions).toEqual(['draft', 'compare', 'canary', 'promote', 'watch', 'rollback'])
})

test('the native repair agent can capture and compare only in its authorized background scope', () => {
  const rules = repairPolicy('/workspace')
  const policy = compilePolicy(rules)
  const subject = { kind: 'agent' as const, id: 'standard', workspace: '/workspace', principal: 'web/web/local/operator' }
  for (const action of ['draft', 'compare', 'canary', 'watch']) {
    const request = { subject, action, resource: { kind: 'evolution', id: 'verified-workflows' }, context: { initiator: 'background' as const } }
    expect(evaluatePolicy(policy, request).effect).toBe('allow')
    expect(evaluatePolicy(compilePolicy(rules.filter(rule => rule.id !== 'repair-agent')), request).effect).toBe('deny')
    expect(evaluatePolicy(policy, { ...request, subject: { ...subject, principal: 'foreign-owner' } }).effect).toBe('deny')
    expect(evaluatePolicy(policy, { ...request, subject: { ...subject, workspace: '/foreign-workspace' } }).effect).toBe('deny')
  }
})
