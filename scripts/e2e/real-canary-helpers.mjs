import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const candidateImage = 'sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8'
const exec = promisify(execFile)

/** Creates operator-only material outside the owner workspace. */
export async function createProspectiveCanaryAuthority({ root, home, workspace, docker = process.env.DSH_WEB_REAL_DOCKER ?? '/usr/bin/docker' }) {
  const authorityImage = process.env.DSH_HOLDOUT_TEST_IMAGE
  if (!/^sha256:[a-f0-9]{64}$/u.test(authorityImage ?? '')) throw new Error('DSH_HOLDOUT_TEST_IMAGE must pin the isolated authority image')
  const privateRoot = join(root, 'private-holdout'); await mkdir(privateRoot, { recursive: true, mode: 0o700 }); await chmod(privateRoot, 0o700)
  const keys = generateKeyPairSync('ed25519'), key = join(privateRoot, 'key.pem'), config = join(privateRoot, 'authority.json'), state = join(privateRoot, 'state.sqlite')
  await writeFile(key, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const cli = resolve(home, 'profiles/web/node_modules/@dsh-enhanced/assistant-skills/lib/holdout-cli.js')
  const localConfig = join(privateRoot, 'inspect.json')
  await writeFile(localConfig, JSON.stringify({ prospective: { generator: 'order-summary/v2' }, privateKeyPath: key, statePath: state, limits: { maxToolCalls: 8, maxOutputBytes: 16384 } }), { mode: 0o600 })
  const inspected = JSON.parse((await exec(process.execPath, [cli, '--inspect-config', localConfig], { encoding: 'utf8' })).stdout)
  if (typeof inspected.generatorDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(inspected.generatorDigest)) throw new Error('private prospective authority did not return a generator pin')
  if (inspected.publicKey !== keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()) throw new Error('private prospective authority returned the wrong public key')
  await stat(state).then(() => { throw new Error('prospective inspect created authority state') }, error => { if (error?.code !== 'ENOENT') throw error })
  await writeFile(config, JSON.stringify({ prospective: { generator: 'order-summary/v2' }, privateKeyPath: '/authority/key.pem', statePath: '/authority/state.sqlite', limits: { maxToolCalls: 8, maxOutputBytes: 16384 } }), { mode: 0o600 })
  return {
    privateRoot, state, config, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    profile: (owner, sourceArtifact) => ({ id: 'real-order-summary-v2', version: 1, scope: { principalId: 'web/web/local/operator', principalRecordId: owner.id, principalVersion: owner.version, workspace, preset: 'standard' },
      execution: { image: candidateImage, dockerPath: docker, stateRoot: join(privateRoot, 'candidate-state'), command: '/usr/local/bin/node /workspace/artifact < /workspace/input', artifactPath: 'summarize.mjs', expiresAt: Date.now() + 300000, repeats: 2, maxToolCalls: 8, maxBytes: 16384, maxOutputBytes: 16384, cellDurationMs: 30000, verificationDurationMs: 15000 },
      files: [{ path: 'summarize.mjs', content: sourceArtifact }], authority: { executable: docker, args: ['run', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid()}:${process.getgid()}`, '--pids-limit', '32', '--memory', '128m', '--cpus', '1', '--mount', `type=bind,source=${resolve(cli, '..')},target=/runtime,readonly`, '--mount', `type=bind,source=${privateRoot},target=/authority`, '--entrypoint', '/usr/local/bin/node', authorityImage, '/runtime/holdout-cli.js', '--config', '/authority/authority.json'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest: inspected.generatorDigest }, maxComparisons: 1 }),
  }
}

export function canaryPolicy(workspace) {
  const agent = { kind: 'agent', id: 'standard', workspace, principal: 'web/web/local/operator' }
  const background = { kind: 'background', id: 'dsh-enhanced-assistant-skills', workspace, principal: 'web/web/local/operator' }
  const resource = { kind: 'evolution', id: 'verified-workflows' }
  return [
    { id: 'canary-owner', effect: 'allow', subject: agent, actions: ['inspect', 'capture', 'trial', 'activate', 'run', 'compare', 'canary', 'watch'], resource, context: { initiators: ['external'] } },
    { id: 'canary-background', effect: 'allow', subject: background, actions: ['capture', 'promote', 'watch', 'rollback'], resource, context: { initiators: ['background'] } },
  ]
}
