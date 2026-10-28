import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { readLinuxExecutionReceipt, LinuxVerifierRunner,
  type IsolationResult, type LinuxExecutionContract, type LinuxExecutionIntent } from '@dsh-enhanced/assistant-isolation'
import { afterEach, describe, expect, test } from 'vitest'
import type { LinuxPluginBehaviorRuntime } from '../src/linux-behavior-runtime.js'

const descriptorPath = process.env.DSH_LINUX_BEHAVIOR_RUNTIME
const enabled = process.env.DSH_NATIVE_CGROUP_REAL === '1' && process.platform === 'linux'
  && process.arch === 'x64' && !!process.getuid?.() && !!descriptorPath
const evidenceDir = fileURLToPath(new URL('../../../docs/evidence/linux-behavior-protection/', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type ProbeRecord = { key: string; command: string; artifactSha256: string; startedAt: number; elapsedMs: number;
  result?: IsolationResult; error?: string }

// This fixture is Host-authored and finite. It grants only two 30-second
// ordinary runs per private state root; it never grants repository execution.
async function fixture(label: string, command: string) {
  if (!descriptorPath || !isAbsolute(descriptorPath)) throw new Error('absolute prepared runtime JSON required')
  const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as LinuxPluginBehaviorRuntime
  const root = await mkdtemp(join(tmpdir(), `dsh-linux-protection-${label}-`))
  const uid = process.getuid!()
  const config = { backend: 'linux-native' as const, stateRoot: root, runtime: descriptor.runtime,
    authorityDigest: createHash('sha256').update(randomUUID()).digest('hex'), expiresAt: Date.now() + 600_000,
    maxRuns: 2, maxDurationMs: 30_000, maxTotalDurationMs: 60_000, maxOutputBytes: 4096,
    command, cgroupRoots: { mode: 'v1' as const,
      cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`,
      pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
  const records: ProbeRecord[] = []
  const runner = new LinuxVerifierRunner(config)
  cleanups.push(async () => {
    await runner.close()
    const db = new DatabaseSync(join(root, 'ledger.sqlite'), { readOnly: true })
    let rows: Record<string, unknown>[]
    try { rows = db.prepare('SELECT id, status, linux_contract_json, linux_intent_json FROM isolation_jobs ORDER BY created_at').all() }
    finally { db.close() }
    const receipts: unknown[] = []
    const errors: string[] = []
    for (const row of rows) {
      try {
        const contract = JSON.parse(String(row.linux_contract_json)) as LinuxExecutionContract
        const intent = JSON.parse(String(row.linux_intent_json)) as LinuxExecutionIntent
        expect(contract.profile).toBe('ordinary')
        const receipt = await readLinuxExecutionReceipt({ stateRoot: join(root, 'linux-executions'), contract, intent })
        expect(receipt?.result.jobId).toBe(row.id)
        expect(receipt?.result.quiescent).toBe(true)
        receipts.push({ id: row.id, status: row.status, receiptDigest: receipt?.receiptDigest,
          result: receipt?.result, resources: receipt?.resources, completedAt: receipt?.completedAt,
          resourceAbsenceRechecked: true })
      } catch (error) { errors.push(`${String(row.id)}: ${String(error)}`) }
    }
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    await writeFile(join(evidenceDir, `${label}-${config.authorityDigest}.json`),
      JSON.stringify({ label, descriptorPath, root, config, records, receipts, errors }, null, 2) + '\n', { mode: 0o600 })
    // Preserve the raw /tmp ledger and private execution state for review,
    // especially when a receipt or physical cleanup check is inconclusive.
    expect(errors).toEqual([])
    expect(receipts).toHaveLength(records.length)
  })
  const run = async (key: string, artifact: string): Promise<IsolationResult> => {
    const record: ProbeRecord = { key, command, artifactSha256: createHash('sha256').update(artifact).digest('hex'),
      startedAt: Date.now(), elapsedMs: 0 }
    records.push(record)
    try {
      const result = await runner.run(key, artifact, '', AbortSignal.timeout(120_000))
      record.result = result
      return result
    } catch (error) { record.error = String(error); throw error }
    finally { record.elapsedMs = Date.now() - record.startedAt }
  }
  return { run }
}

const parentScript = `const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
fs.closeSync(1);if(fs.openSync('/workspace/parent-fd1','w+')!==1)process.exit(6);
const child=spawnSync(process.execPath,['-e',\`const fs=require('node:fs');
try{const fd=fs.openSync('/proc/'+process.ppid+'/fd/1','r');fs.closeSync(fd);console.log('allowed')}
catch(e){console.log(e.code);if(!['EACCES','EPERM'].includes(e.code))process.exit(4)}\`],
{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}});
if(child.error||child.status!==0){console.error(JSON.stringify({status:child.status,error:child.error?.code,stdout:child.stdout,stderr:child.stderr}));process.exit(5)}
process.stderr.write(child.stdout);`

// Byte-for-byte syscall sequence from plugin-behavior-process.spec.ts. Host
// compiles this trusted fixture; only the isolated child executes the binary.
const rawProbe = `
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(void) {
  int fd = open("/usr/bin/true", O_PATH); if (fd < 0) return 2;
  if (dup2(fd, 4) != 4) return 3;
  char *args[] = { "true", NULL }; char *env[] = { NULL };
  errno = 0;
  if (syscall(SYS_execveat, 4, "", args, env, AT_EMPTY_PATH) != -1 || errno != EPERM) return 4;
  errno = 0;
  if (syscall(SYS_execve, "/usr/bin/true", args, env) != -1 || errno != EPERM) return 5;
  puts("denied"); return 0;
}
`

describe.skipIf(!enabled)('real Linux behavior preload protection', () => {
  test('parent preload denies same-UID child access while the ordinary control allows it', async () => {
    const node = '/runtime/0/bin/node --disable-sigusr1'
    const protectedRun = await fixture('parent-protected',
      `exec /usr/bin/env LD_PRELOAD=/runtime/0/dsh-plugin-verifier/parent-protect.so ${node} /workspace/artifact`)
    const protectedResult = await protectedRun.run('parent-protected', parentScript)
    expect(protectedResult).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0 })
    expect(['EACCES\n', 'EPERM\n']).toContain(protectedResult.stderr)

    const control = await fixture('parent-control', `exec ${node} /workspace/artifact`)
    const controlResult = await control.run('parent-control', parentScript)
    expect(controlResult).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0, stderr: 'allowed\n' })
  }, 180_000)

  test.runIf(existsSync('/usr/bin/cc'))('child preload denies raw execveat and execve after fd 4 reuse', async () => {
    const host = await mkdtemp(join(tmpdir(), 'dsh-linux-protection-cc-'))
    const source = join(host, 'probe.c'), executable = join(host, 'probe')
    await writeFile(source, rawProbe)
    const startedAt = Date.now()
    execFileSync('/usr/bin/cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable],
      { timeout: 30_000, maxBuffer: 4096 })
    const compiled = await readFile(executable)
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    await writeFile(join(evidenceDir, `trusted-compile-${randomUUID()}.json`), JSON.stringify({
      sourceSha256: createHash('sha256').update(rawProbe).digest('hex'),
      executableSha256: createHash('sha256').update(compiled).digest('hex'),
      command: ['/usr/bin/cc', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable],
      exitCode: 0, elapsedMs: Date.now() - startedAt, host
    }, null, 2) + '\n', { mode: 0o600 })
    const python = `import base64,os,subprocess,sys\n` +
      `data=base64.b64decode(sys.stdin.buffer.read(),validate=True)\n` +
      `path='/workspace/probe'\n` +
      `with open(path,'wb') as out: out.write(data)\n` +
      `os.chmod(path,0o700)\n` +
      `result=subprocess.run([path],env={'LD_PRELOAD':'/runtime/0/dsh-plugin-verifier/child-protect.so','PATH':'/usr/bin:/bin'},capture_output=True,text=True,timeout=10)\n` +
      `sys.stdout.write(result.stdout);sys.stderr.write(result.stderr);sys.exit(result.returncode)\n`
    const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
    const command = `exec /usr/bin/python3 -c ${shellQuote(python)} < /workspace/artifact`
    const f = await fixture('child-raw', command)
    const result = await f.run('child-raw', compiled.toString('base64'))
    expect(result).toMatchObject({ status: 'succeeded', quiescent: true, exitCode: 0, stdout: 'denied\n', stderr: '' })
  }, 180_000)
})
