import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { lifecycleProfileTest } from '../scripts/install/lifecycle-profile.mjs'
import { matchesOwnerRepairActivation } from '../scripts/install/owner-repair-readiness.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-owner-repair-readiness-')))
  roots.push(root)
  const homePath = join(root, 'home')
  const profile = 'assistant', coordinatorProfile = 'rsi-assistant'
  const services = [profile, coordinatorProfile].map((name, index) => ({
    unit: `dsh-profile-${name}.service`, profile: name, wasActive: true,
    serviceHome: homePath, pathEnvironment: 'PATH=/usr/bin:/bin',
    mainPid: 100 + index, invocationId: `old-${name}`, nRestarts: 0,
  }))
  const states = Object.fromEntries(services.map(service => [service.unit, {
    pid: service.mainPid, invocationId: service.invocationId,
  }]))
  const statePath = join(root, 'systemd.json')
  await writeFile(statePath, JSON.stringify(states))
  const systemctl = join(root, 'systemctl')
  await writeFile(systemctl, `#!${process.execPath}\n`
    + `const fs = require('node:fs'); const unit = process.argv[4];\n`
    + `const state = JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'))[unit];\n`
    + `const fields = { Id: unit, LoadState: 'loaded', UnitFileState: 'enabled', ActiveState: 'active',\n`
    + `  SubState: 'running', MainPID: state.pid, ControlPID: 0, InvocationID: state.invocationId,\n`
    + `  NRestarts: 0, WorkingDirectory: ${JSON.stringify(homePath + '/profiles/')} + unit.slice(12, -8),\n`
    + `  Environment: 'DSH_HOME=' + ${JSON.stringify(homePath)} + ' PATH=/usr/bin:/bin'\n`
    + `    + ' DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${process.getuid()}/bus'\n`
    + `    + ' XDG_RUNTIME_DIR=/run/user/${process.getuid()}' };\n`
    + `for (const field of process.argv.filter(value => value.startsWith('--property='))) {\n`
    + `  const name = field.slice(11); process.stdout.write(name + '=' + fields[name] + '\\n') }\n`, { mode: 0o700 })
  const quietJournal = join(root, 'quiet-journal')
  const readyJournal = join(root, 'ready-journal')
  await writeFile(quietJournal, `#!${process.execPath}\nprocess.stdout.write('not ready\\n')\n`, { mode: 0o700 })
  await writeFile(readyJournal, `#!${process.execPath}\nprocess.stdout.write('dsh-enhanced host ready: v1\\n')\n`, { mode: 0o700 })
  const sourceProof = { ownerRepair: { coordinatorProfile } }
  return { root, homePath, profile, coordinatorProfile, services, statePath, systemctl, quietJournal,
    readyJournal, sourceProof }
}

describe('owner repair original readiness', () => {
  test('captures both running systemd identities without inventing absent markers or activation', async () => {
    const setup = await fixture()
    const readiness = await lifecycleProfileTest.captureOwnerRepairOriginalReadiness({
      systemctlExecutable: setup.systemctl, journalctlExecutable: setup.quietJournal,
      services: setup.services, homePath: setup.homePath, profile: setup.profile,
      sourceProof: setup.sourceProof, activationInspector: () => false,
    })
    expect(readiness.services).toEqual(setup.services.map(service => ({
      unit: service.unit, profile: service.profile, invocationId: service.invocationId,
      mainPid: service.mainPid, hostReady: false,
      coordinatorActivated: service.profile === setup.coordinatorProfile ? false : null,
    })))
    expect(lifecycleProfileTest.validOwnerRepairOriginalReadiness(readiness, setup.services,
      setup.profile, setup.coordinatorProfile)).toBe(true)
  })

  test('fails closed when systemd identity changes during baseline capture', async () => {
    const setup = await fixture()
    await expect(lifecycleProfileTest.captureOwnerRepairOriginalReadiness({
      systemctlExecutable: setup.systemctl, journalctlExecutable: setup.quietJournal,
      services: setup.services, homePath: setup.homePath, profile: setup.profile,
      sourceProof: setup.sourceProof, activationInspector: () => {
        const states = JSON.parse(readFileSync(setup.statePath, 'utf8'))
        states[setup.services[1].unit].pid = 999
        writeFileSync(setup.statePath, JSON.stringify(states))
        return false
      },
    })).rejects.toThrow('changed during readiness capture')
  })

  test('rechecks the first service after capturing the second service readiness', async () => {
    const setup = await fixture()
    await expect(lifecycleProfileTest.captureOwnerRepairOriginalReadiness({
      systemctlExecutable: setup.systemctl, journalctlExecutable: setup.quietJournal,
      services: setup.services, homePath: setup.homePath, profile: setup.profile,
      sourceProof: setup.sourceProof, activationInspector: () => {
        const states = JSON.parse(readFileSync(setup.statePath, 'utf8'))
        states[setup.services[0].unit].invocationId = 'restarted-during-peer-capture'
        writeFileSync(setup.statePath, JSON.stringify(states))
        return false
      },
    })).rejects.toThrow('changed before pair capture completed')
  })

  test('restores only previously missing signals, never candidate or previously ready signals', async () => {
    const setup = await fixture()
    const missing = { schemaVersion: 1, services: setup.services.map(service => ({
      unit: service.unit, profile: service.profile, invocationId: service.invocationId,
      mainPid: service.mainPid, hostReady: false,
      coordinatorActivated: service.profile === setup.coordinatorProfile ? false : null,
    })) }
    const restarted = setup.services.map(service => ({ ...service,
      invocationId: `fresh-${service.profile}`, mainPid: service.mainPid + 100 }))
    const degraded = lifecycleProfileTest.ownerRepairRestorationPolicy(missing, setup.services,
      setup.profile, setup.coordinatorProfile, () => false)
    expect(lifecycleProfileTest.serviceRuntimeReady(setup.services[0], {
      activeState: 'active', subState: 'running', mainPid: setup.services[0].mainPid,
      controlPid: 0, invocationId: restarted[0].invocationId,
    }, degraded)).toBe(false)
    const states = JSON.parse(readFileSync(setup.statePath, 'utf8'))
    for (const service of restarted) states[service.unit] = { pid: service.mainPid, invocationId: service.invocationId }
    writeFileSync(setup.statePath, JSON.stringify(states))
    const running = await lifecycleProfileTest.readRawServiceState(setup.systemctl, restarted[0].unit)
    expect(lifecycleProfileTest.serviceRuntimeReady(setup.services[0], running, degraded)).toBe(true)
    expect(await lifecycleProfileTest.serviceReadySignal(setup.quietJournal, setup.homePath,
      restarted[0], Date.now(), degraded)).toBe(true)
    expect(await lifecycleProfileTest.serviceReadySignal(setup.quietJournal, setup.homePath,
      restarted[1], Date.now(), degraded)).toBe(true)
    expect(await lifecycleProfileTest.serviceReadySignal(setup.quietJournal, setup.homePath,
      restarted[0], Date.now(), undefined)).toBe(false)
    const priorReady = { ...missing, services: missing.services.map(entry => ({ ...entry,
      hostReady: true, coordinatorActivated: entry.profile === setup.coordinatorProfile ? true : null })) }
    const strict = lifecycleProfileTest.ownerRepairRestorationPolicy(priorReady, setup.services,
      setup.profile, setup.coordinatorProfile, () => false)
    expect(await lifecycleProfileTest.serviceReadySignal(setup.quietJournal, setup.homePath,
      restarted[0], Date.now(), strict)).toBe(false)
    expect(await lifecycleProfileTest.serviceReadySignal(setup.readyJournal, setup.homePath,
      restarted[1], Date.now(), strict)).toBe(false)
    const newlyActive = lifecycleProfileTest.ownerRepairRestorationPolicy(priorReady, setup.services,
      setup.profile, setup.coordinatorProfile, () => true)
    expect(await lifecycleProfileTest.serviceReadySignal(setup.readyJournal, setup.homePath,
      restarted[1], Date.now(), newlyActive)).toBe(true)
  })

  test('requires the exact owner-bound native coordinator registration', () => {
    const scope = { workspace: 'workspace', preset: 'default', principalId: 'owner', ownerRouteId: 'route' }
    const record = { id: 'adoption-coordinator-exact', owner: 'plugin-control-plane-adoption-coordinator',
      status: 'active', updatedAt: 200, definition: { execution: { kind: 'host',
        executorId: 'plugin-control-plane-adoption-coordinator-v1', ownerRouteId: scope.ownerRouteId },
      principal: scope.principalId, workspace: scope.workspace, agentPreset: scope.preset } }
    expect(matchesOwnerRepairActivation(record, record.id, scope, 200)).toBe(true)
    for (const changed of [{ ...record, id: 'other' }, { ...record, status: 'paused' },
      { ...record, updatedAt: 199 }, { ...record, definition: { ...record.definition,
        execution: { ...record.definition.execution, ownerRouteId: 'other' } } }]) {
      expect(matchesOwnerRepairActivation(changed, record.id, scope, 200)).toBe(false)
    }
  })
})
