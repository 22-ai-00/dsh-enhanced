"""Opt-in Linux probe of a private rootless Docker daemon's process identity.

Run from the repository root after building assistant-isolation. Requires Python 3,
Node, dockerd, rootlesskit, and unprivileged user/mount/network namespaces. No image
pull, worker execution, global configuration edit, or shared daemon restart occurs.
Limited private map helpers map only the caller's existing UID/GID. Temporary data
and logs remain under /tmp for inspection; all owned process groups are stopped.
This diagnoses restart candidates. It never releases production ledger capacity.
"""
import subprocess,tempfile,os,time,json,signal,shutil
from pathlib import Path
if os.getuid() == 0 or not Path('/proc/sys/kernel/random/boot_id').exists():
 raise RuntimeError('requires a non-root Linux caller')
for binary in ['node', 'dockerd', 'rootlesskit']:
 if shutil.which(binary) is None:raise RuntimeError('missing probe prerequisite: '+binary)
root=Path(tempfile.mkdtemp(prefix='dsh-witness-restart-')); helpers=root/'helpers';helpers.mkdir()
for kind in ['uid','gid']:
 script='#!/usr/bin/python3\nimport os,sys\nfrom pathlib import Path\np=Path("/proc")/sys.argv[1]\n'
 if kind=='gid':script+='try: (p/"setgroups").write_text("deny")\nexcept OSError: pass\n'
 script+=f'(p/"{kind}_map").write_text("0 %s 1" % os.get{kind}())\n'
 helper=helpers/('new'+kind+'map');helper.write_text(script);helper.chmod(0o700)
(root/'daemon.json').write_text('{}')
socket=root/'docker.sock';pidfile=root/'docker.pid';processes=[];logs=[];record={'root':str(root),'stages':[]}
module=(Path.cwd()/'plugins/assistant-isolation/lib/runtime-witness.js').as_uri()
node=shutil.which('node')
def nodeprobe(code,payload):
 p=subprocess.run([node,'--input-type=module','-e','const m = await import(process.argv[1]); const data = JSON.parse(process.argv[2]); '+code,module,json.dumps(payload)],capture_output=True,text=True,timeout=15)
 if p.returncode:raise RuntimeError(p.stderr)
 return json.loads(p.stdout)
def start(n):
 args=['/usr/bin/rootlesskit','--net=none','--state-dir='+str(root/('kit'+str(n))),'--copy-up=/etc','/bin/sh','-c','mount -t tmpfs -o mode=755 tmpfs /run && exec "$@"','sh','/usr/bin/dockerd','--config-file='+str(root/'daemon.json'),'--rootless','--group=0','--data-root='+str(root/'data'),'--exec-root='+str(root/'exec'),'--pidfile='+str(pidfile),'--host=unix://'+str(socket),'--iptables=false','--bridge=none','--ip-forward=false','--ip-masq=false','--storage-driver=vfs']
 f=(root/('daemon'+str(n)+'.log')).open('w');logs.append(f)
 p=subprocess.Popen(args,stdout=f,stderr=subprocess.STDOUT,start_new_session=True,env=dict(os.environ,XDG_RUNTIME_DIR=str(root),PATH=str(helpers)+':'+os.environ['PATH']));processes.append(p)
 for _ in range(100):
  if p.poll() is not None:raise RuntimeError('private daemon failed: '+str(p.returncode))
  try:
   w=nodeprobe('console.log(JSON.stringify(await m.captureDaemonWitness(data) ?? null))',{'dockerPath':'/usr/bin/docker','socketPath':str(socket),'pidFile':str(pidfile)})
   if w:return p,w
  except subprocess.TimeoutExpired:pass
  time.sleep(.1)
 raise RuntimeError('private daemon startup timed out')
def stop(p):
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=5)
def candidate(original):return nodeprobe('console.log(JSON.stringify(await m.eligibleRestartWitness(data) ?? null))',original)
supervisor=subprocess.Popen([node,'-e','setInterval(() => {}, 1000)'],start_new_session=True)
try:
 first,old=start(1)
 sup=nodeprobe('console.log(JSON.stringify(await m.processWitness(data.pid)))',{'pid':supervisor.pid})
 original={'daemon':old,'supervisor':sup}
 assert candidate(original) is None;record['stages'].append({'name':'both-original-processes-live','eligible':False})
 stop(supervisor)
 assert candidate(original) is None;record['stages'].append({'name':'supervisor-reaped-daemon-live','eligible':False})
 volume='dsh-witness-probe-'+str(os.getpid())
 subprocess.run(['/usr/bin/docker','-H','unix://'+str(socket),'volume','create',volume],capture_output=True,check=True,timeout=10)
 stop(first)
 assert candidate(original) is None;record['stages'].append({'name':'daemon-offline','eligible':False})
 second,current=start(2)
 assert current['engineId']==old['engineId'];assert current['process']!=old['process']
 fresh=candidate(original);assert fresh==current
 record['stages'].append({'name':'same-store-daemon-restart','eligible':True,'old':old,'current':current})
 other=json.loads(json.dumps(original));other['daemon']['engineId']='different-store'
 assert candidate(other) is None;record['stages'].append({'name':'different-engine-id','eligible':False})
 subprocess.run(['/usr/bin/docker','-H','unix://'+str(socket),'volume','inspect',volume],capture_output=True,check=True,timeout=10)
 subprocess.run(['/usr/bin/docker','-H','unix://'+str(socket),'volume','rm',volume],capture_output=True,check=True,timeout=10)
 record['stages'].append({'name':'real-volume-survives-restart-and-is-removed','passed':True})
 record['passed']=True
except Exception as e:record['passed']=False;record['error']=str(e);raise
finally:
 stop(supervisor)
 for p in processes:stop(p)
 for f in logs:f.close()
 record['processExitCodes']=[p.returncode for p in processes]
 record['scope']='isolated rootless daemon identity only; no worker cgroup enforcement or automatic quota release claim'
 Path('/tmp/dsh-witness-restart.json').write_text(json.dumps(record,indent=2));print(json.dumps(record,indent=2))
