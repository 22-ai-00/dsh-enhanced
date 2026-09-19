#!/usr/bin/env node
/* Owner-operated holdout.  It intentionally never imports candidate code. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PLUGIN_PREFIX = 'plugins/personal-memory/'
const IMAGE = 'sha256:321f72f637710ad1a69425cd0915a7a8a6101f325080ab5eefc19f244eeaefc8'
const COMMAND = '/bin/busybox cp /workspace/artifact /workspace/program.mjs && node /workspace/program.mjs < /workspace/input'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const die = message => { throw new Error(`personal-memory acceptance: ${message}`) }

function args(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) die(`unexpected argument ${key}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) die(`missing value for ${key}`)
    out[key.slice(2)] = value
  }
  if (!out.evidence) die('--evidence <absolute-path> is required')
  return out
}

function safeCandidatePath(path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) die('candidate file path must be relative to plugins/personal-memory')
  if (path.split('/').some(part => ['node_modules', '.git'].includes(part))) die('candidate dependency or git paths are forbidden')
  return path
}

async function candidateFiles(option) {
  if (!option) return { files: [] }
  const document = JSON.parse(await readFile(resolve(option), 'utf8'))
  const rows = Array.isArray(document) ? document : [
    ...(document?.observations?.enqueues ?? []), ...(document?.observations?.preparations ?? []),
    ...(document?.candidateFiles ?? []),
  ]
  const files = []
  for (const row of rows) {
    const path = row?.path ?? row?.file?.path
    const content = row?.content ?? row?.file?.content
    if (typeof content !== 'string') continue
    files.push({ path: safeCandidatePath(path), content })
  }
  if (files.length === 0) die('--candidate contains no {path,content} source files')
  if (document.queued?.baseCommit !== undefined && document.queued.baseCommit !== document.baseCommit) die('candidate queue/base commit mismatch')
  return { files, baseCommit: document.baseCommit }
}

function committedSources(repository, requestedBase) {
  const git = (...argv) => execFileSync('/usr/bin/git', argv, { cwd: repository, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  const baseCommit = requestedBase ?? git('rev-parse', 'HEAD').toString().trim()
  if (!/^[a-f0-9]{40}$/.test(baseCommit)) die('expected a full immutable base commit')
  if (git('rev-parse', '--verify', `${baseCommit}^{commit}`).toString().trim() !== baseCommit) die('invalid base commit')
  const rows = git('ls-tree', '-rz', baseCommit, '--', `${PLUGIN_PREFIX}src`, `${PLUGIN_PREFIX}package.json`).toString().split('\0').filter(Boolean)
  if (rows.length === 0) die('base commit has no personal-memory sources')
  const files = rows.map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row)
    if (!match || !match[3].startsWith(PLUGIN_PREFIX)) die('unsupported committed source entry')
    return { path: safeCandidatePath(match[3].slice(PLUGIN_PREFIX.length)), content: git('cat-file', 'blob', match[2]) }
  })
  const lock = git('show', `${baseCommit}:pnpm-lock.yaml`)
  return { baseCommit, files, lockDigest: sha256(lock) }
}

async function esbuild() {
  const require = createRequire(import.meta.url)
  const vitest = require.resolve('vitest')
  const fromVitest = createRequire(vitest)
  try { return await import(pathToFileURL(fromVitest.resolve('esbuild')).href) } catch { die('esbuild transitively provided by vitest/vite is unavailable') }
}

async function bundle(entryPoint, output, sourceRoot) {
  const build = await esbuild()
  await build.build({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    outfile: output, packages: 'bundle', sourcemap: false, logLevel: 'silent', external: ['node:*'],
    plugins: [{ name: 'owner-source-boundary', setup(api) { api.onLoad({ filter: /.*/ }, async args => {
      const file = await realpath(args.path)
      const roots = [join(ROOT, 'node_modules'), join(ROOT, 'packages'), join(ROOT, 'plugins'), sourceRoot]
      if (file !== entryPoint && !roots.some(root => file.startsWith(`${root}${sep}`))) throw new Error('bundle import escapes owner source boundary')
      const extension = file.split('.').at(-1)
      if (!['ts','js','mjs','cjs','json'].includes(extension)) throw new Error('bundle import is not a source module')
      return { contents: await readFile(file), loader: extension === 'ts' ? 'ts' : extension === 'json' ? 'json' : 'js', resolveDir: dirname(file) }
    }) } }] })
  return await readFile(output, 'utf8')
}

function launcher(baseline, candidate) {
  const b64 = value => gzipSync(value, { level: 9 }).toString('base64')
  return `import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
const root='/tmp/personal-memory'; mkdirSync(root,{recursive:true}); writeFileSync('/tmp/package.json','{}');
writeFileSync(root+'/baseline.mjs',gunzipSync(Buffer.from(${JSON.stringify(b64(baseline))},'base64')));
writeFileSync(root+'/candidate.mjs',gunzipSync(Buffer.from(${JSON.stringify(b64(candidate))},'base64')));
const context={workspace:'/work/holdout',agentPreset:'primary',namespace:{mode:'delivery',principalDigest:'a'.repeat(64),principalRecordId:'holdout-owner',principalVersion:7}};
const identity={owner:'user',scope:'workspace',workspace:'/work/holdout'};
const entry=(content,knowledge)=>({kind:'fact',content,sensitivity:'private',trust:'user-confirmed',confidence:1,provenance:{source:'holdout',observedAt:1000},...(knowledge?{knowledge}:{})});
const add=(store,key,content,knowledge)=>store.applyApprovedMutation({op:'add',idempotencyKey:key,namespace:context.namespace,identity,entry:entry(content,knowledge)});
const db=root+'/memory.sqlite';
const snapshot=()=>{const sql=new DatabaseSync(db);try{return {
 records:sql.prepare('SELECT * FROM memory_records ORDER BY id').all(),
 audit:sql.prepare('SELECT * FROM memory_audit ORDER BY sequence').all(),
 tokens:sql.prepare('SELECT token,memory_id FROM memory_tokens ORDER BY memory_id,token').all(),
 version:sql.prepare('PRAGMA user_version').get().user_version,
 meta:sql.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get().value,
}}finally{sql.close()}};
const output={};
try {
 const base=await import('file://'+root+'/baseline.mjs');
 const before=new base.MemoryStore({path:db,now:()=>100000});
 const keep=add(before,'keep','Quartz缓存 北京，上海',{applicability:['Nimbus插件 故障恢复'],counterexamples:['旧版 不适用'],claim:{key:'cache.mode',value:'writeback'}});
 const removed=add(before,'remove','Removed令牌');
 before.applyApprovedMutation({op:'remove',idempotencyKey:'remove-record',namespace:context.namespace,identity,id:removed.id,expectedVersion:removed.version}); before.close();
 output.ids={keep:keep.id,removed:removed.id}; output.before=snapshot();
 const {MemoryStore,tokenizeMemory}=await import('file://'+root+'/candidate.mjs');
 output.tokenCases=['ＡＢＣ缓存，上海 Quartz插件','甲 乙','甲，乙','甲Latin乙','日本語','Hello-world_42','ＡＢＣ缓存 ＡＢＣ缓存'].map(value=>({value,tokens:tokenizeMemory(value)}));
 const store=new MemoryStore({path:db,now:()=>100000}); output.migrated=snapshot();
 const search=(query,ctx=context)=>store.search({context:ctx,query,limit:10}).map(hit=>hit.record.id);
 output.legacy=search('quartz'); output.knowledge=search('nimbus');
 output.foreign=search('quartz',{...context,namespace:{...context.namespace,principalDigest:'b'.repeat(64),principalRecordId:'foreign'}});
 output.removed=search('removed');
 const fresh=add(store,'fresh','Zephyr插件 東京。大阪');output.ids.fresh=fresh.id;
 output.fresh=search('zephyr'); output.cjk=search('東京');store.close();output.after=snapshot();
 const reopen=new MemoryStore({path:db,now:()=>100000});
 output.again=reopen.search({context,query:'nimbus',limit:10}).map(hit=>hit.record.id);reopen.close();output.reopened=snapshot();
} catch(error) {output.error={name:error.name,message:String(error.message)}}
process.stdout.write(JSON.stringify(output));`
}

function evaluate(o) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const cases = []
  const check = (name, pass) => cases.push({ name, pass: Boolean(pass) })
  if (o.error || !o.ids || !o.before || !o.migrated || !o.after || !o.reopened) return [{ name: 'complete-observations', pass: false }]
  const tokens = o.tokenCases.map(row => row.tokens)
  check('legacy-v6-fixture', o.before.version === 6 && o.before.meta === '6')
  check('nfkc-mixed-latin-cjk', tokens[0].includes('abc') && tokens[0].includes('quartz') && tokens[0].includes('缓存') && !tokens[0].includes('存上') && !tokens[0].includes('海插'))
  check('no-bigrams-across-space-punctuation-latin', tokens.slice(1,4).every(row => !row.includes('甲乙')) && tokens[3].includes('latin'))
  check('contiguous-cjk-bigrams', same(tokens[4], ['日', '日本', '本', '本語', '語'].sort()))
  check('existing-ascii-word-semantics', same(tokens[5], ['hello-world_42']))
  check('sorted-unique', tokens.every(row => same(row, [...new Set(row)].sort())))
  check('legacy-mixed-latin-recall', same(o.legacy, [o.ids.keep]))
  check('legacy-knowledge-mixed-recall', same(o.knowledge, [o.ids.keep]))
  check('fresh-mixed-latin-recall', same(o.fresh, [o.ids.fresh]))
  check('fresh-cjk-recall', o.cjk.includes(o.ids.fresh))
  check('foreign-namespace-excluded', same(o.foreign, []))
  check('removed-record-excluded', same(o.removed, []) && !o.migrated.tokens.some(row => row.memory_id === o.ids.removed))
  check('legacy-boundary-index-rebuilt', !o.migrated.tokens.some(row => row.memory_id === o.ids.keep && ['京上', '存北', '海插', '件故'].includes(row.token)))
  check('record-and-audit-preserved-by-migration', same(o.before.records, o.migrated.records) && same(o.before.audit, o.migrated.audit))
  check('schema-consistent', o.migrated.version >= 6 && String(o.migrated.version) === o.migrated.meta)
  check('reopen-idempotent', same(o.again, [o.ids.keep]) && same(o.after, o.reopened))
  return cases
}

async function main() {
  const option = args(process.argv)
  const repository = resolve(option.repository ?? ROOT)
  if (!isAbsolute(repository)) die('--repository must be absolute')
  const evidencePath = resolve(option.evidence)
  const proposal = await candidateFiles(option.candidate)
  const files = proposal.files
  if (option['base-commit'] && proposal.baseCommit && option['base-commit'] !== proposal.baseCommit) die('explicit base does not match candidate evidence')
  const requestedBase = proposal.baseCommit ?? option['base-commit']
  if (option.candidate && !requestedBase) die('candidate requires baseCommit evidence or --base-commit')
  const source = committedSources(repository, requestedBase)
  if (sha256(await readFile(join(repository, 'pnpm-lock.yaml'))) !== source.lockDigest) die('installed dependency lock differs from proposal base')
  const work = await mkdtemp(join(tmpdir(), 'personal-memory-source-acceptance-'))
  const candidateRoot = join(work, 'candidate')
  const baselineRoot = join(work, 'baseline')
  let retainWork = false
  try {
    for (const root of [baselineRoot, candidateRoot]) {
      await mkdir(root)
      for (const file of source.files) { const target = join(root, file.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content) }
      await symlink(join(repository, 'node_modules'), join(root, 'node_modules'))
    }
    // Bundling follows package imports, but candidate modules are never loaded
    // by the Host.  This link supplies only the repository's locked inputs.
    for (const file of files) { const target = resolve(candidateRoot, file.path); if (!target.startsWith(`${candidateRoot}${sep}`)) die('candidate path escapes plugin'); await mkdir(dirname(target), { recursive: true }); await writeFile(target, file.content) }
    const baselineEntry = join(work, 'baseline-entry.ts'); const candidateEntry = join(candidateRoot, 'acceptance-entry.ts')
    await writeFile(baselineEntry, `export { MemoryStore } from ${JSON.stringify(join(baselineRoot, 'src/store.ts'))}; export { tokenizeMemory } from ${JSON.stringify(join(baselineRoot, 'src/tokenize.ts'))};`)
    await writeFile(candidateEntry, "export { MemoryStore } from './src/store.ts'; export { tokenizeMemory } from './src/tokenize.ts';")
    const frozenBaselinePath = option['baseline-bundle'] === undefined ? `${evidencePath}.baseline.mjs` : resolve(option['baseline-bundle'])
    const baseline = option['baseline-bundle'] === undefined
      ? await bundle(baselineEntry, join(work, 'baseline.mjs'), baselineRoot)
      : await readFile(frozenBaselinePath, 'utf8')
    if (option['baseline-bundle'] === undefined) await writeFile(frozenBaselinePath, baseline, { mode: 0o600 })
    const candidate = await bundle(candidateEntry, join(work, 'candidate.mjs'), candidateRoot)
    const artifact = launcher(baseline, candidate)
    if (Buffer.byteLength(artifact) > 1_048_576) die('artifact exceeds isolated runner 1 MiB limit')
    const { IsolatedVerifierRunner } = await import(pathToFileURL(join(repository, 'plugins/assistant-isolation/lib/index.js')).href)
    const stateRoot = join(work, 'state')
    retainWork = true // Keep the ledger if construction, dispatch or settlement throws.
    const runner = new IsolatedVerifierRunner({ stateRoot, image: IMAGE, dockerPath: '/usr/bin/docker', authorityDigest: sha256(COMMAND), command: COMMAND,
      expiresAt: Date.now() + 120000, maxRuns: 1, maxTotalDurationMs: 60000, maxDurationMs: 45000, maxOutputBytes: 131072 })
    let receipt
    try { receipt = await runner.run(`personal-memory-${sha256(artifact).slice(0,24)}`, artifact, JSON.stringify({ version: 1 }), new AbortController().signal) } finally { await runner.close() }
    let observation; try { observation = JSON.parse(receipt.stdout) } catch { observation = { error: { message: 'invalid isolated observation', stdout: receipt.stdout } } }
    const result = { contract: 'personal-memory-source-acceptance/v1', repository, candidate: option.candidate ? resolve(option.candidate) : null,
      source: { baseCommit: source.baseCommit, lockDigest: source.lockDigest, files: source.files.map(file => ({ path: file.path, sha256: sha256(file.content) })) },
      expectationsDigest: sha256(launcher.toString() + evaluate.toString()),
      inputDigest: sha256(JSON.stringify(files)), artifactDigest: sha256(artifact), scriptDigest: sha256(await readFile(fileURLToPath(import.meta.url))),
      checkedAt: new Date().toISOString(), limits: ['operator-held deterministic engineering cases, not a signed production holdout', 'candidate observations remain untrusted; source review and regression checks are separate gates'],
      frozenBaseline: { path: frozenBaselinePath, sha256: sha256(baseline), bytes: Buffer.byteLength(baseline) }, image: IMAGE,
      receipt: { jobId: receipt.jobId, status: receipt.status, quiescent: receipt.quiescent, exitCode: receipt.exitCode, reason: receipt.reason }, observation,
      cases: evaluate(observation),
      pass: receipt.status === 'succeeded' && receipt.quiescent === true && evaluate(observation).every(item => item.pass),
      stateRoot: receipt.quiescent ? undefined : stateRoot }
    retainWork = receipt.quiescent !== true
    await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${JSON.stringify({ pass: result.pass, evidence: evidencePath, receipt: result.receipt })}\n`)
    if (!result.pass) process.exitCode = 1
  } finally { if (!retainWork) await rm(work, { recursive: true, force: true }) }
}
await main()
