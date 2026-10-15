import { spawnSync } from 'node:child_process'
import { fstatSync, lstatSync, readdirSync } from 'node:fs'

interface FileIdentity { readonly dev: bigint; readonly ino: bigint; readonly descriptor: number }
const perl = '/usr/bin/perl'
const environment = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
const lockScript = String.raw`use strict; use warnings; use Fcntl qw(F_GETLK F_RDLCK F_WRLCK F_UNLCK SEEK_SET);
@ARGV == 2*$ENV{OPERATOR_FD_COUNT} or die "argument count\n";
my @result;
for my $slot (0..$ENV{OPERATOR_FD_COUNT}-1) {
  my $fd = 3+$slot;
  open(my $file, "<&=$fd") or die "inherited fd\n";
  my @stat = stat($file) or die "fstat\n";
  "$stat[0]" eq $ARGV[2*$slot] && "$stat[1]" eq $ARGV[2*$slot+1] or die "fd identity\n";
  my $lock = pack('q q i! s! s!', 0, 0, 0, F_RDLCK, SEEK_SET);
  defined(fcntl($file, F_GETLK, $lock)) or die "F_GETLK\n";
  my (undef, undef, undef, $type, undef) = unpack('q q i! s! s!', $lock);
  push @result, $type == F_WRLCK ? 'W' : $type == F_UNLCK ? 'U' : die "unknown lock\n";
}
print join('', @result), "\n";`
const cleanupScript = String.raw`use strict; use warnings;
@ARGV == 2 or die "argument count\n";
open(my $dir, '<&=3') or die "inherited directory\n";
my @pin = stat($dir) or die "fstat directory\n";
"$pin[0]" eq $ARGV[0] && "$pin[1]" eq $ARGV[1] or die "directory identity\n";
chdir($dir) or die "fchdir\n";
my @cwd = stat('.') or die "stat cwd\n";
"$cwd[0]" eq $ARGV[0] && "$cwd[1]" eq $ARGV[1] or die "cwd identity\n";
opendir(my $entries, '.') or die "readdir\n";
my @names = grep { $_ ne '.' && $_ ne '..' } readdir($entries);
closedir($entries);
my %allowed = map { $_ => 1 } qw(automations.sqlite automations.sqlite-wal automations.sqlite-shm);
for my $name (@names) { $allowed{$name} or die "unknown file\n"; -l $name and die "symbolic link\n"; -f $name or die "not regular\n"; }
for my $name (@names) { unlink($name) == 1 or die "unlink\n"; }
print "clean\n";`

function run(script: string, args: string[], fds: readonly number[], extraEnv: Record<string, string> = {}): string {
  const result = spawnSync(perl, ['-e', script, ...args], { cwd: '/', env: { ...environment, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', ...fds], encoding: 'utf8', timeout: 3_000, maxBuffer: 4_096 })
  if (result.error || result.status !== 0 || result.signal || result.stderr) throw new Error('macOS operator helper unavailable')
  return result.stdout
}

export function assertNoMacProcessConnection(paths: readonly string[]): void {
  const files = paths.flatMap(path => {
    try {
      const stat = lstatSync(path, { bigint: true })
      return stat.isFile() ? [{ dev: stat.dev, ino: stat.ino }] : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error('cannot inspect macOS operator path')
    }
  })
  const descriptors = readdirSync('/dev/fd').map(Number).filter(value => Number.isSafeInteger(value) && value > 2)
  for (const descriptor of descriptors) {
    let stat
    try { stat = fstatSync(descriptor, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBADF') continue; throw error }
    if (stat.isFile() && files.some(file => file.dev === stat.dev && file.ino === stat.ino)) {
      throw new Error('macOS operator source is open in this process')
    }
  }
}

export function macConnectionInodes(exclude: ReadonlySet<number>): Array<{ device: bigint; inode: bigint }> {
  const inodes: Array<{ device: bigint; inode: bigint }> = []
  for (const entry of readdirSync('/dev/fd')) {
    const descriptor = Number(entry)
    if (!Number.isSafeInteger(descriptor) || descriptor <= 2 || exclude.has(descriptor)) continue
    let stat
    try { stat = fstatSync(descriptor, { bigint: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EBADF') continue; throw error }
    if (stat.isFile()) inodes.push({ device: stat.dev, inode: stat.ino })
  }
  return inodes
}

export function macExclusiveWriter(files: readonly FileIdentity[]): boolean {
  if (files.length < 1 || files.length > 3) throw new Error('invalid lock probe count')
  const args = files.flatMap(file => [file.dev.toString(), file.ino.toString()])
  const result = run(lockScript, args, files.map(file => file.descriptor), { OPERATOR_FD_COUNT: String(files.length) })
  return parseMacLockOutput(result, files.length)
}

export function parseMacLockOutput(output: string, count: number): boolean {
  if (!Number.isSafeInteger(count) || count < 1 || count > 3
    || !new RegExp(`^[UW]{${count}}\\n$`, 'u').test(output)) throw new Error('invalid lock probe result')
  return output.includes('W')
}

export function macCleanupPinnedDirectory(directory: FileIdentity): void {
  const output = run(cleanupScript, [directory.dev.toString(), directory.ino.toString()], [directory.descriptor])
  if (output !== 'clean\n') throw new Error('invalid cleanup result')
}
