import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { acceptanceDigest } from '../../packages/task-acceptance-contract/lib/index.js'
import { validateFailureCaptureProvenance } from '../../plugins/assistant-skills/lib/definition.js'

const candidateImage = 'sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8'
const exec = promisify(execFile)
const digestPattern = /^[a-f0-9]{64}$/u
const placeholderPatternSource = String.raw`\{\{([a-z][a-z0-9_]*)\}\}`

const legacySource = `import process from 'node:process'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { template, values } = JSON.parse(input)
let rendered = template
for (let pass = 0; pass <= Object.keys(values).length; pass += 1) {
  rendered = rendered.replace(new RegExp(${JSON.stringify(placeholderPatternSource)}, 'gu'), (placeholder, key) => Object.hasOwn(values, key) ? values[key] : placeholder)
}
process.stdout.write(rendered + '\\n')
`

const repairedSource = `import process from 'node:process'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { template, values } = JSON.parse(input)
const rendered = template.replace(new RegExp(${JSON.stringify(placeholderPatternSource)}, 'gu'), (placeholder, key) => Object.hasOwn(values, key) ? values[key] : placeholder)
process.stdout.write(rendered + '\\n')
`

const recursiveSource = `import process from 'node:process'

let input = ''
for await (const chunk of process.stdin) input += chunk
const { template, values } = JSON.parse(input)
let rendered = template
for (let pass = 0; pass <= Object.keys(values).length; pass += 1) {
  for (const [key, value] of Object.entries(values)) rendered = rendered.split('{{' + key + '}}').join(value)
}
process.stdout.write(rendered + String.fromCharCode(10))
`

/**
 * The public task contract used by the real-model canary. The legacy profile
 * deliberately cannot distinguish sequential recursive replacement from the
 * required literal one-pass semantics; the strict profile can.
 */
export const templateRenderCanaryTask = Object.freeze({
  id: 'template-render-v1',
  skillName: 'template-render',
  artifactPath: 'render.mjs',
  generator: 'template-render/v1',
  legacyObjective: 'Implement render.mjs: read a JSON object with template and string values from stdin, replace known {{ascii_key}} placeholders, preserve unknown placeholders, and print the rendered text followed by a newline.',
  strictObjective: 'Implement render.mjs: read a JSON object with template and string values from stdin, replace known {{ascii_key}} placeholders literally in one non-recursive pass, preserve unknown placeholders, and print the rendered text followed by a newline.',
  legacyCriteria: Object.freeze([
    Object.freeze({ id: 'simple', stdin: '{"template":"hello {{name}}","values":{"name":"world"}}\n', expectedStdout: 'hello world\n' }),
    Object.freeze({ id: 'unknown', stdin: '{"template":"hello {{missing}}","values":{"name":"world"}}\n', expectedStdout: 'hello {{missing}}\n' }),
  ]),
  strictCriteria: Object.freeze([
    Object.freeze({ id: 'literal-non-recursive', stdin: '{"template":"release={{release}};literal={{literal}}","values":{"release":"r1","literal":"{{release}}-candidate"}}\n', expectedStdout: 'release=r1;literal={{release}}-candidate\n' }),
    Object.freeze({ id: 'repeat-and-unknown', stdin: '{"template":"{{owner}}/{{owner}}/{{missing}}","values":{"owner":"team"}}\n', expectedStdout: 'team/team/{{missing}}\n' }),
  ]),
  // Both frozen arms replay from this common scaffold. The repair Goal first
  // invokes v1 to materialize the recursive implementation, then repairs it.
  scaffoldSource: "throw new Error('render.mjs has not been implemented')\n",
  qualificationInitialSource: "throw new Error('render.mjs has not been implemented')\n",
  legacySource,
  repairedSource,
  // Keep the override distinct from the edit's old_string so the native edit
  // succeeds while preserving the deliberately recursive behavior.
  negativeInputs: Object.freeze({ implementation: recursiveSource }),
  binding: Object.freeze({ name: 'implementation', path: '/new_string' }),
  failureCandidate: Object.freeze({ task_family_id: 'template-render-v1', name: 'template-render', description: 'Repair literal one-pass template rendering.', parent_version: 1 }),
  authorizedTools: Object.freeze(['read', 'edit']),
  rejectedTools: Object.freeze(['bash']),
  lifecycle: Object.freeze([
    'legacy-owner-v1',
    'strict-v1-not-achieved',
    'independent-strict-repair-achieved',
    'failure-candidate',
    'restart-and-runtime-admission',
    'prospective-positive-gain-and-canary',
    'fresh-exact-family-promotion',
    'same-family-negative-control-rollback',
    'restart-no-replay-or-resurrection',
  ]),
})

/** Data-only blueprint consumed by the Playwright driver once the paid run is enabled. */
export const templateRenderCanaryPlan = Object.freeze([
  Object.freeze({ id: 'legacy-owner-v1', session: 'baseline', objective: templateRenderCanaryTask.legacyObjective, expectedOutcome: 'achieved', artifact: templateRenderCanaryTask.artifactPath, reusableTools: templateRenderCanaryTask.authorizedTools }),
  Object.freeze({ id: 'strict-v1-not-achieved', session: 'failure', objective: templateRenderCanaryTask.strictObjective, expectedOutcome: 'not-achieved', soleBusinessTool: 'skill_run', skillVersion: 1 }),
  Object.freeze({ id: 'independent-strict-repair-achieved', session: 'repair', objective: templateRenderCanaryTask.strictObjective, expectedOutcome: 'achieved', reusableTools: templateRenderCanaryTask.authorizedTools }),
  Object.freeze({ id: 'failure-candidate', tool: 'skill_failure_candidate', triggerSession: 'failure', repairSession: 'repair', parentVersion: 1, binding: templateRenderCanaryTask.binding }),
  Object.freeze({ id: 'restart-and-runtime-admission', restart: true, admissionSource: Object.freeze(['skill_definitions', 'skill_candidates', 'goal_records', 'acceptance_contracts']) }),
  Object.freeze({ id: 'prospective-positive-gain-and-canary', tool: 'skill_canary', generator: templateRenderCanaryTask.generator, expectedGain: 'positive' }),
  Object.freeze({ id: 'fresh-exact-family-promotion', session: 'promotion', objective: templateRenderCanaryTask.strictObjective, expectedOutcome: 'achieved', soleBusinessTool: 'skill_run' }),
  Object.freeze({ id: 'same-family-negative-control-rollback', session: 'negative-control', objective: templateRenderCanaryTask.strictObjective, expectedOutcome: 'not-achieved', soleBusinessTool: 'skill_run', inputs: templateRenderCanaryTask.negativeInputs }),
  Object.freeze({ id: 'restart-no-replay-or-resurrection', restart: true, unchanged: Object.freeze(['runs', 'comparisons', 'deployments', 'watches', 'goals', 'processed-inbox']) }),
])

const privateStatusKeys = new Set([
  'receipt', 'receipts',
  'cell', 'cells', 'celldigest', 'cellsdigest', 'cellverdict', 'cellverdicts', 'caseid', 'caseids', 'armdigest',
  'input', 'inputs', 'inputdigest', 'inputsdigest', 'inputjson', 'inputdata', 'stdin',
  'expectedanswer', 'expectedanswers', 'expectedanswerdigest', 'expectedanswersdigest', 'expectedoutput', 'expectedoutputs', 'expectedstdout',
  'observation', 'observations', 'observationdigest', 'observationdigests',
  'key', 'keys', 'keydigest', 'keysdigest', 'privatekey', 'publickey', 'secretkey', 'signingkey', 'keymaterial',
])
function privateStatusKey(key) {
  const words = key.normalize('NFKC').replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
  const compact = words.join('')
  return privateStatusKeys.has(compact) || words.some(word => ['cell', 'cells', 'input', 'inputs', 'observation', 'observations', 'key', 'keys'].includes(word))
    || words.some((word, index) => word === 'expected' && ['answer', 'answers', 'output', 'outputs', 'stdout'].includes(words[index + 1]))
}

/** Fail if a model-visible comparison/deployment status exposes private authority material. */
export function assertPublicCanaryStatus(value) {
  const visit = item => {
    if (item === null || typeof item !== 'object') return
    if (Array.isArray(item)) { for (const child of item) visit(child); return }
    for (const [key, child] of Object.entries(item)) {
      if (privateStatusKey(key)) throw new Error(`private canary status field leaked: ${key}`)
      visit(child)
    }
  }
  visit(value)
  return value
}

/** Static approval policy for the template canary's native and nested calls. */
export function templateCanaryApproval(toolName, args, workspace) {
  if (toolName === 'bash') return 'reject'
  if (!templateRenderCanaryTask.authorizedTools.includes(toolName)) return 'deny'
  return typeof args?.file_path === 'string' && resolve(workspace, args.file_path) === join(workspace, templateRenderCanaryTask.artifactPath) ? 'allow' : 'deny'
}

const controlToolsByStage = Object.freeze({
  'legacy-owner-v1': Object.freeze(['goal_create', 'get_goal', 'skill_save', 'skill_status']),
  'strict-v1-not-achieved': Object.freeze(['goal_create', 'get_goal', 'skill_run', 'skill_status']),
  'independent-strict-repair-achieved': Object.freeze(['goal_create', 'get_goal']),
  'failure-candidate': Object.freeze(['skill_failure_candidate', 'skill_candidates']),
  'prospective-positive-gain-and-canary': Object.freeze(['skill_comparison_status', 'skill_canary', 'skill_deployment_status', 'skill_watches']),
  'fresh-exact-family-promotion': Object.freeze(['goal_create', 'get_goal', 'skill_run', 'skill_deployment_status', 'skill_watches']),
  'same-family-negative-control-rollback': Object.freeze(['goal_create', 'get_goal', 'skill_run', 'skill_deployment_status', 'skill_watches']),
})

/** Allow only a runtime-pinned exact control call in the current lifecycle stage. */
export function templateCanaryControlApproval(toolName, args, stage, expectedCalls) {
  if (toolName === 'bash') return 'reject'
  if (toolName === 'skill_activate' || !controlToolsByStage[stage]?.includes(toolName) || !Array.isArray(expectedCalls)) return 'deny'
  return expectedCalls.some(call => call?.toolName === toolName && acceptanceDigest(call.arguments) === acceptanceDigest(args)) ? 'allow' : 'deny'
}

/** Exact production skill_failure_candidate payload with runtime Goal and trace identities. */
export function templateFailureCandidatePayload({ ownerRouteId, triggerGoalId, triggerSessionId, repairGoalId, repairSessionId, repairStepId, task = templateRenderCanaryTask }) {
  const runtimeValues = { ownerRouteId, triggerGoalId, triggerSessionId, repairGoalId, repairSessionId, repairStepId }
  if (Object.values(runtimeValues).some(value => typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\p{Cc}]/u.test(value))) {
    throw new Error('template failure candidate requires exact runtime identities')
  }
  const fixed = object(task.failureCandidate, 'failure candidate template')
  if (fixed.name !== task.skillName || !Number.isSafeInteger(fixed.parent_version) || fixed.parent_version < 1
    || typeof fixed.task_family_id !== 'string' || typeof fixed.description !== 'string' || !task.binding || typeof task.binding.name !== 'string' || typeof task.binding.path !== 'string') {
    throw new Error('invalid template failure candidate')
  }
  return Object.freeze({
    owner_route_id: ownerRouteId,
    trigger_goal_id: triggerGoalId,
    trigger_session_id: triggerSessionId,
    repair_goal_id: repairGoalId,
    repair_session_id: repairSessionId,
    task_family_id: fixed.task_family_id,
    name: fixed.name,
    description: fixed.description,
    bindings_json: JSON.stringify([{ ...task.binding, stepId: repairStepId }]),
    parent_version: fixed.parent_version,
  })
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`missing runtime ${label}`)
  return value
}
function storedObject(value, field, label) {
  const outer = object(value, label)
  if (!Object.hasOwn(outer, field)) return outer
  try { return object(JSON.parse(outer[field]), label) } catch { throw new Error(`invalid runtime ${label}`) }
}

/** Build admission only from rows read after restart from the production stores. */
export function runtimeCanaryAdmission({ skillName, parent, candidate, strictGoal, outcomeContract }) {
  const parentDefinition = storedObject(parent, 'definition_json', 'parent definition')
  const candidateRecord = storedObject(candidate, 'candidate_json', 'candidate')
  const candidateDefinition = object(candidateRecord.definition, 'candidate definition')
  const goalRecord = object(strictGoal, 'strict Goal')
  const goalDefinition = Object.hasOwn(goalRecord, 'definition_json')
    ? storedObject(goalRecord, 'definition_json', 'strict Goal definition')
    : object(goalRecord.definition ?? goalRecord, 'strict Goal definition')
  const nativeGoal = Object.hasOwn(goalRecord, 'native_json')
    ? storedObject(goalRecord, 'native_json', 'strict native Goal')
    : object(goalRecord.native ?? goalRecord.nativeAtLastObservation, 'strict native Goal')
  const contract = Object.hasOwn(object(outcomeContract, 'outcome contract'), 'payload')
    ? storedObject(outcomeContract, 'payload', 'outcome contract')
    : object(outcomeContract?.contract ?? outcomeContract, 'outcome contract')
  const taskGoal = object(contract.task?.goal, 'outcome task Goal')
  const profile = object(contract.profile, 'outcome profile')
  const sourceGoal = object(candidateDefinition.source?.goal, 'candidate source Goal')
  const provenance = validateFailureCaptureProvenance(candidateRecord.failureProvenance)
  const failure = provenance.trigger.failures[0]
  const parentDigest = acceptanceDigest(parentDefinition)
  const candidateDigest = acceptanceDigest(candidateDefinition)
  const parentTools = [...new Set(parentDefinition.steps?.map(step => step.toolName) ?? [])].sort()
  const candidateTools = [...new Set(candidateDefinition.steps?.map(step => step.toolName) ?? [])].sort()
  const nativeRecordId = createHash('sha256').update(nativeGoal.sessionId).update('\0').update(nativeGoal.goalId).digest('hex')
  if (candidateDefinition.name !== skillName || parentDefinition.name !== skillName || candidateRecord.state !== 'pending' || parentDefinition.retired !== false
    || !Number.isSafeInteger(parentDefinition.version) || parentDefinition.version < 1 || !Number.isSafeInteger(goalDefinition.version) || goalDefinition.version < 1
    || goalRecord.id !== nativeRecordId || typeof nativeGoal.sessionId !== 'string' || typeof nativeGoal.goalId !== 'string'
    || candidateRecord.parentVersion !== parentDefinition.version || candidateRecord.parentDigest !== parentDigest
    || sourceGoal.id !== goalRecord.id || sourceGoal.definition?.digest !== goalDefinition.digest
    || sourceGoal.definition?.objective !== goalDefinition.objective || goalDefinition.digest !== acceptanceDigest({ objective: goalDefinition.objective })
    || nativeGoal.objective !== goalDefinition.objective
    || contract.task?.kind !== 'goal-outcome' || taskGoal.id !== goalRecord.id || taskGoal.definitionVersion !== goalDefinition.version
    || taskGoal.definitionDigest !== goalDefinition.digest || taskGoal.sessionId !== sourceGoal.sessionId || taskGoal.nativeGoalId !== sourceGoal.nativeGoalId
    || nativeGoal.sessionId !== sourceGoal.sessionId || nativeGoal.goalId !== sourceGoal.nativeGoalId
    || provenance.trigger.failureCategory !== 'objective-not-achieved' || provenance.trigger.triggerCondition.kind !== 'not-achieved-count'
    || provenance.trigger.triggerCondition.minimumOccurrences !== 1 || provenance.trigger.failures.length !== 1 || failure?.outcome !== 'not-achieved'
    || candidateRecord.trigger !== `failure:${provenance.trigger.taskFamily.id}:${failure.goal.id}`
    || provenance.trigger.taskFamily.definitionDigest !== goalDefinition.digest || provenance.trigger.taskFamily.objective !== goalDefinition.objective
    || acceptanceDigest(provenance.trigger.scope) !== acceptanceDigest(candidateDefinition.source?.scope)
    || acceptanceDigest(parentDefinition.source?.scope) !== acceptanceDigest(candidateDefinition.source?.scope)
    || acceptanceDigest(provenance.trigger.repairGoal) !== acceptanceDigest(sourceGoal)
    || acceptanceDigest(provenance.repair.goal) !== acceptanceDigest(sourceGoal)
    || provenance.repair.runId !== candidateDefinition.source?.runId || provenance.repair.sourceDigest !== acceptanceDigest(candidateDefinition.source)
    || provenance.repair.acceptanceDigest !== acceptanceDigest(candidateDefinition.source?.acceptance)
    || failure.acceptance.verifiedAt >= candidateDefinition.source?.acceptance?.verifiedAt
    || candidateDefinition.source?.acceptance?.verifiedAt > provenance.trigger.attestedAt
    || candidateDefinition.source?.acceptance?.validUntil <= provenance.trigger.attestedAt
    || provenance.parent.name !== skillName || provenance.parent.version !== parentDefinition.version || provenance.parent.digest !== parentDigest
    || provenance.rollbackTarget.name !== skillName || provenance.rollbackTarget.version !== parentDefinition.version || provenance.rollbackTarget.digest !== parentDigest
    || provenance.candidate.name !== skillName || provenance.candidate.definitionDigest !== candidateDigest
    || acceptanceDigest(provenance.permissionDelta.parent) !== acceptanceDigest(parentTools)
    || acceptanceDigest(provenance.permissionDelta.candidate) !== acceptanceDigest(candidateTools)
    || typeof profile.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(profile.id)
    || !Number.isSafeInteger(profile.version) || profile.version < 1 || !digestPattern.test(profile.digest ?? '')) {
    throw new Error('runtime canary admission inputs do not describe one exact repaired task family')
  }
  return Object.freeze({ protocol: 'assistant-skills/canary-admission/v1', skillName, parentDefinitionDigest: parentDigest, candidateDefinitionDigest: candidateDigest,
    taskFamily: Object.freeze({ goalDefinitionDigest: goalDefinition.digest, outcomeProfile: Object.freeze({ id: profile.id, version: profile.version, digest: profile.digest }) }) })
}

/** Production has one frozen files array for both arms, so both edit traces must start identically. */
export function templateCanaryMaterializedSources({ parent, candidate, task = templateRenderCanaryTask }) {
  const parentDefinition = storedObject(parent, 'definition_json', 'parent definition')
  const candidateRecord = storedObject(candidate, 'candidate_json', 'candidate')
  const candidateDefinition = object(candidateRecord.definition ?? candidateRecord, 'candidate definition')
  const initialSource = task.qualificationInitialSource
  if (typeof initialSource !== 'string') throw new Error('template qualification initial source is required')
  const replay = (definition, label) => {
    const sourceWorkspace = definition.source?.scope?.workspace
    if (definition.name !== task.skillName || typeof sourceWorkspace !== 'string' || !Array.isArray(definition.steps)) throw new Error(`invalid ${label} replay definition`)
    let content = initialSource
    for (const step of definition.steps) {
      if (!['read', 'edit'].includes(step?.toolName) || typeof step.arguments?.file_path !== 'string'
        || resolve(sourceWorkspace, step.arguments.file_path) !== join(sourceWorkspace, task.artifactPath)) throw new Error(`invalid ${label} replay step`)
      if (step.toolName === 'read') continue
      const { old_string: oldString, new_string: newString, replace_all: replaceAll } = step.arguments
      if (typeof oldString !== 'string' || typeof newString !== 'string' || replaceAll !== undefined && typeof replaceAll !== 'boolean') throw new Error(`invalid ${label} replay edit`)
      const occurrences = oldString === '' ? 0 : content.split(oldString).length - 1
      if (occurrences === 0 || replaceAll !== true && occurrences !== 1) throw new Error(`unreplayable ${label} initial source`)
      content = replaceAll === true ? content.split(oldString).join(newString) : content.replace(oldString, () => newString)
    }
    return content
  }
  const baselineSource = replay(parentDefinition, 'baseline')
  const candidateSource = replay(candidateDefinition, 'candidate')
  if (baselineSource === candidateSource) throw new Error('production prospective replay did not produce a distinct repair arm')
  return Object.freeze({ initialSource, baselineSource, candidateSource })
}

export function templateCanaryReplayInitialSource(input) { return templateCanaryMaterializedSources(input).initialSource }

/** Creates operator-only material outside the owner workspace. */
export async function createProspectiveCanaryAuthority({ root, home, workspace, task, docker = process.env.DSH_WEB_REAL_DOCKER ?? '/usr/bin/docker' }) {
  if (!task || typeof task.generator !== 'string' || typeof task.id !== 'string' || typeof task.artifactPath !== 'string' || typeof task.scaffoldSource !== 'string') throw new Error('exact prospective canary task is required')
  const authorityImage = process.env.DSH_HOLDOUT_TEST_IMAGE
  if (!/^sha256:[a-f0-9]{64}$/u.test(authorityImage ?? '')) throw new Error('DSH_HOLDOUT_TEST_IMAGE must pin the isolated authority image')
  const privateRoot = join(root, 'private-holdout'); await mkdir(privateRoot, { recursive: true, mode: 0o700 }); await chmod(privateRoot, 0o700)
  const keys = generateKeyPairSync('ed25519'), key = join(privateRoot, 'key.pem'), config = join(privateRoot, 'authority.json'), state = join(privateRoot, 'state.sqlite')
  await writeFile(key, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const cli = resolve(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-skills/lib/holdout-cli.js')
  const localConfig = join(privateRoot, 'inspect.json')
  await writeFile(localConfig, JSON.stringify({ prospective: { generator: task.generator }, privateKeyPath: key, statePath: state, limits: { maxToolCalls: 8, maxOutputBytes: 16384 } }), { mode: 0o600 })
  const inspected = JSON.parse((await exec(process.execPath, [cli, '--inspect-config', localConfig], { encoding: 'utf8' })).stdout)
  if (typeof inspected.generatorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(inspected.generatorDigest)) throw new Error('private prospective authority did not return a generator pin')
  if (inspected.profileVersion !== task.generator || inspected.profileDigest !== inspected.generatorDigest) throw new Error('private prospective authority returned the wrong generator profile')
  if (inspected.publicKey !== keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()) throw new Error('private prospective authority returned the wrong public key')
  await stat(state).then(() => { throw new Error('prospective inspect created authority state') }, error => { if (error?.code !== 'ENOENT') throw error })
  await writeFile(config, JSON.stringify({ prospective: { generator: task.generator }, privateKeyPath: '/authority/key.pem', statePath: '/authority/state.sqlite', limits: { maxToolCalls: 8, maxOutputBytes: 16384 } }), { mode: 0o600 })
  return {
    privateRoot, state, config, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    profile: (owner, { canaryAdmission, parent, candidate } = {}) => {
      if (!canaryAdmission || canaryAdmission.protocol !== 'assistant-skills/canary-admission/v1') throw new Error('runtime canary admission is required')
      const initialSource = templateCanaryReplayInitialSource({ parent, candidate, task })
      const parentDefinition = storedObject(parent, 'definition_json', 'parent definition')
      const candidateRecord = storedObject(candidate, 'candidate_json', 'candidate')
      const candidateDefinition = object(candidateRecord.definition ?? candidateRecord, 'candidate definition')
      if (canaryAdmission.parentDefinitionDigest !== acceptanceDigest(parentDefinition) || canaryAdmission.candidateDefinitionDigest !== acceptanceDigest(candidateDefinition)) throw new Error('runtime canary admission does not bind the frozen profile arms')
      return { id: `real-${task.id}`, version: 1, scope: { principalId: 'web/web/local/operator', principalRecordId: owner.id, principalVersion: owner.version, workspace, preset: 'standard' },
      execution: { image: candidateImage, dockerPath: docker, stateRoot: join(privateRoot, 'candidate-state'), command: '/usr/local/bin/node /workspace/artifact < /workspace/input', artifactPath: task.artifactPath, expiresAt: Date.now() + 600000, repeats: 2, maxToolCalls: 8, maxBytes: 16384, maxOutputBytes: 16384, cellDurationMs: 30000, verificationDurationMs: 15000 },
      // Production replay clones this one files array for both frozen arms.
      // Their edit traces must therefore share this exact pre-edit source.
      files: [{ path: task.artifactPath, content: initialSource }], authority: { executable: docker, args: ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit', '32', '--memory', '128m', '--cpus', '1', '--mount', `type=bind,source=${resolve(cli, '..')},target=/runtime,readonly`, '--mount', `type=bind,source=${privateRoot},target=/authority`, '--entrypoint', '/usr/local/bin/node', authorityImage, '/runtime/holdout-cli.js', '--config', '/authority/authority.json'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: inspected.generatorDigest }, canaryAdmission, maxComparisons: 1 }
    },
  }
}

export function canaryPolicy(workspace) {
  const agent = { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }
  const background = { kind: 'background', id: 'dsh-enhanced-assistant-skills', workspace, principal: 'web/web/local/operator' }
  const resource = { kind: 'evolution', id: 'verified-workflows' }
  return [
    { id: 'canary-owner', effect: 'allow', subject: agent, actions: ['inspect', 'run', 'compare', 'canary', 'watch'], resource, context: { initiators: ['external'] } },
    { id: 'canary-background', effect: 'allow', subject: background, actions: ['capture', 'promote', 'watch', 'rollback'], resource, context: { initiators: ['background'] } },
  ]
}
