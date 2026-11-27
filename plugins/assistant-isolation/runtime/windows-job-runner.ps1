param(
  [Parameter(Mandatory = $true)]
  [string]$SpecPath
)

$ErrorActionPreference = 'Stop'

$csharp = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace DshIsolation {
  public sealed class JobRunner {
    private const uint JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004;
    private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
    private const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    private const uint JOB_OBJECT_UILIMIT_HANDLES = 0x00000001;
    private const uint JOB_OBJECT_UILIMIT_READCLIPBOARD = 0x00000002;
    private const uint JOB_OBJECT_UILIMIT_WRITECLIPBOARD = 0x00000004;
    private const uint JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS = 0x00000008;
    private const uint JOB_OBJECT_UILIMIT_DISPLAYSETTINGS = 0x00000010;
    private const uint JOB_OBJECT_UILIMIT_GLOBALATOMS = 0x00000020;
    private const uint JOB_OBJECT_UILIMIT_DESKTOP = 0x00000040;
    private const uint JOB_OBJECT_UILIMIT_EXITWINDOWS = 0x00000080;

    private const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x00000001;
    private const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x00000004;

    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectBasicUIRestrictions = 4;
    private const int JobObjectExtendedLimitInformation = 9;
    private const int JobObjectCpuRateControlInformation = 15;

    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint WAIT_OBJECT_0 = 0x00000000;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES {
      public int nLength;
      public IntPtr lpSecurityDescriptor;
      public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFOW {
      public int cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public int dwX;
      public int dwY;
      public int dwXSize;
      public int dwYSize;
      public int dwXCountChars;
      public int dwYCountChars;
      public int dwFillAttribute;
      public uint dwFlags;
      public short wShowWindow;
      public short cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_UI_RESTRICTIONS {
      public uint UIRestrictionsClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
      public uint ControlFlags;
      public uint CpuRate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
      public long TotalUserTime;
      public long TotalKernelTime;
      public long ThisPeriodTotalUserTime;
      public long ThisPeriodTotalKernelTime;
      public uint TotalPageFaultCount;
      public uint TotalProcesses;
      public uint ActiveProcesses;
      public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, out uint lpReturnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
      string lpApplicationName,
      StringBuilder lpCommandLine,
      IntPtr lpProcessAttributes,
      IntPtr lpThreadAttributes,
      bool bInheritHandles,
      uint dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFOW lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    public sealed class RunOutcome {
      public string Status = "failed";
      public bool Quiescent = true;
      public int ExitCode = -1;
      public bool HasExitCode = false;
      public string StdoutBase64 = "";
      public string StderrBase64 = "";
      public uint Pid = 0;
      public uint ActiveProcessesRemaining = 0;
      public string Reason = "";
    }

    private static void CloseIfValid(ref IntPtr handle) {
      if (handle != IntPtr.Zero && handle != new IntPtr(-1)) {
        CloseHandle(handle);
        handle = IntPtr.Zero;
      }
    }

    private static uint QueryActiveProcesses(IntPtr hJob) {
      int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
      IntPtr ptr = Marshal.AllocHGlobal(size);
      try {
        uint retLen = 0;
        if (!QueryInformationJobObject(hJob, JobObjectBasicAccountingInformation, ptr, (uint)size, out retLen)) {
          return 1;
        }
        var info = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(ptr, typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        return info.ActiveProcesses;
      } finally {
        Marshal.FreeHGlobal(ptr);
      }
    }

    public static RunOutcome Execute(
      string applicationName,
      string commandLine,
      string workingDirectory,
      string[] envEntries,
      byte[] stdinBytes,
      int timeoutMs,
      int closeGraceMs,
      int maxOutputBytes,
      long memoryLimitBytes,
      int activeProcessLimit,
      long jobTime100Ns,
      uint cpuRate,
      uint uiRestrictionsFlags,
      bool controlOnStdin,
      string cancelFilePath
    ) {
      var outcome = new RunOutcome();
      IntPtr hJob = IntPtr.Zero;
      IntPtr envPtr = IntPtr.Zero;
      IntPtr stdinRead = IntPtr.Zero, stdinWrite = IntPtr.Zero;
      IntPtr stdoutRead = IntPtr.Zero, stdoutWrite = IntPtr.Zero;
      IntPtr stderrRead = IntPtr.Zero, stderrWrite = IntPtr.Zero;
      PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

      try {
        if (!string.IsNullOrEmpty(cancelFilePath) && File.Exists(cancelFilePath)) {
          outcome.Status = "cancelled";
          outcome.Quiescent = true;
          outcome.Reason = "cancelled";
          return outcome;
        }
        hJob = CreateJobObjectW(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
        }

        var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        uint limitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        if (activeProcessLimit > 0) {
          limitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
          ext.BasicLimitInformation.ActiveProcessLimit = (uint)activeProcessLimit;
        }
        if (memoryLimitBytes > 0) {
          limitFlags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY;
          ext.ProcessMemoryLimit = new UIntPtr((ulong)memoryLimitBytes);
          ext.JobMemoryLimit = new UIntPtr((ulong)memoryLimitBytes);
        }
        if (jobTime100Ns > 0) {
          limitFlags |= JOB_OBJECT_LIMIT_JOB_TIME;
          ext.BasicLimitInformation.PerJobUserTimeLimit = jobTime100Ns;
        }
        ext.BasicLimitInformation.LimitFlags = limitFlags;

        int extSize = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr extPtr = Marshal.AllocHGlobal(extSize);
        try {
          Marshal.StructureToPtr(ext, extPtr, false);
          if (!SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, extPtr, (uint)extSize)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(ExtendedLimitInformation) failed");
          }
        } finally {
          Marshal.FreeHGlobal(extPtr);
        }

        if (uiRestrictionsFlags != 0) {
          var ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS { UIRestrictionsClass = uiRestrictionsFlags };
          int uiSize = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_UI_RESTRICTIONS));
          IntPtr uiPtr = Marshal.AllocHGlobal(uiSize);
          try {
            Marshal.StructureToPtr(ui, uiPtr, false);
            if (!SetInformationJobObject(hJob, JobObjectBasicUIRestrictions, uiPtr, (uint)uiSize)) {
              throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject(BasicUIRestrictions) failed");
            }
          } finally {
            Marshal.FreeHGlobal(uiPtr);
          }
        }

        if (cpuRate > 0 && cpuRate < 10000) {
          var cpu = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
            ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
            CpuRate = cpuRate
          };
          int cpuSize = Marshal.SizeOf(typeof(JOBOBJECT_CPU_RATE_CONTROL_INFORMATION));
          IntPtr cpuPtr = Marshal.AllocHGlobal(cpuSize);
          try {
            Marshal.StructureToPtr(cpu, cpuPtr, false);
            SetInformationJobObject(hJob, JobObjectCpuRateControlInformation, cpuPtr, (uint)cpuSize);
          } finally {
            Marshal.FreeHGlobal(cpuPtr);
          }
        }

        var sa = new SECURITY_ATTRIBUTES {
          nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)),
          lpSecurityDescriptor = IntPtr.Zero,
          bInheritHandle = true
        };
        if (!CreatePipe(out stdinRead, out stdinWrite, ref sa, 0) ||
            !CreatePipe(out stdoutRead, out stdoutWrite, ref sa, 0) ||
            !CreatePipe(out stderrRead, out stderrWrite, ref sa, 0)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreatePipe failed");
        }
        SetHandleInformation(stdinWrite, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stdoutRead, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(stderrRead, HANDLE_FLAG_INHERIT, 0);

        var envSb = new StringBuilder();
        foreach (string entry in envEntries) {
          envSb.Append(entry).Append('\0');
        }
        envSb.Append('\0');
        envPtr = Marshal.StringToHGlobalUni(envSb.ToString());

        var si = new STARTUPINFOW {
          cb = Marshal.SizeOf(typeof(STARTUPINFOW)),
          dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW,
          wShowWindow = 0,
          hStdInput = stdinRead,
          hStdOutput = stdoutWrite,
          hStdError = stderrWrite
        };

        var cmdSb = new StringBuilder(commandLine);
        uint flags = CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT;
        bool created = CreateProcessW(
          string.IsNullOrEmpty(applicationName) ? null : applicationName,
          cmdSb,
          IntPtr.Zero,
          IntPtr.Zero,
          true,
          flags,
          envPtr,
          workingDirectory,
          ref si,
          out pi
        );
        if (!created) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
        }
        outcome.Pid = pi.dwProcessId;

        CloseIfValid(ref stdinRead);
        CloseIfValid(ref stdoutWrite);
        CloseIfValid(ref stderrWrite);

        if (!AssignProcessToJobObject(hJob, pi.hProcess)) {
          int err = Marshal.GetLastWin32Error();
          TerminateProcess(pi.hProcess, 1);
          throw new Win32Exception(err, "AssignProcessToJobObject failed");
        }

        if (ResumeThread(pi.hThread) == unchecked((uint)-1)) {
          int err = Marshal.GetLastWin32Error();
          TerminateJobObject(hJob, 1);
          throw new Win32Exception(err, "ResumeThread failed");
        }
        CloseIfValid(ref pi.hThread);

        var outBuffer = new MemoryStream();
        var errBuffer = new MemoryStream();
        object ioLock = new object();
        int totalBytes = 0;
        string stopReason = null;

        Action terminateForReason = () => {
          TerminateJobObject(hJob, 1);
        };

        var stdoutSafeHandle = new SafeFileHandle(stdoutRead, true);
        stdoutRead = IntPtr.Zero;
        var stderrSafeHandle = new SafeFileHandle(stderrRead, true);
        stderrRead = IntPtr.Zero;
        var stdinSafeHandle = new SafeFileHandle(stdinWrite, true);
        stdinWrite = IntPtr.Zero;

        int minWorkerThreads;
        int minCompletionPortThreads;
        ThreadPool.GetMinThreads(out minWorkerThreads, out minCompletionPortThreads);
        ThreadPool.SetMinThreads(Math.Max(minWorkerThreads, 8), Math.Max(minCompletionPortThreads, 8));

        Task readOut = Task.Run(() => {
          using (stdoutSafeHandle)
          using (var fs = new FileStream(stdoutSafeHandle, FileAccess.Read)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = fs.Read(buf, 0, buf.Length)) > 0) {
              lock (ioLock) {
                int remaining = Math.Max(0, maxOutputBytes - totalBytes);
                int take = Math.Min(n, remaining);
                if (take > 0) {
                  outBuffer.Write(buf, 0, take);
                  totalBytes += take;
                }
                if (n > remaining && stopReason == null) {
                  stopReason = "output-limit";
                  terminateForReason();
                }
              }
            }
          }
        });

        Task readErr = Task.Run(() => {
          using (stderrSafeHandle)
          using (var fs = new FileStream(stderrSafeHandle, FileAccess.Read)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = fs.Read(buf, 0, buf.Length)) > 0) {
              lock (ioLock) {
                int remaining = Math.Max(0, maxOutputBytes - totalBytes);
                int take = Math.Min(n, remaining);
                if (take > 0) {
                  errBuffer.Write(buf, 0, take);
                  totalBytes += take;
                }
                if (n > remaining && stopReason == null) {
                  stopReason = "output-limit";
                  terminateForReason();
                }
              }
            }
          }
        });

        using (var cancelCts = new CancellationTokenSource()) {
          if (controlOnStdin) {
            Task.Run(() => {
              try {
                using (var parentIn = Console.OpenStandardInput()) {
                  byte[] b = new byte[64];
                  while (!cancelCts.IsCancellationRequested) {
                    int r = parentIn.Read(b, 0, b.Length);
                    if (r <= 0) {
                      lock (ioLock) {
                        if (stopReason == null) {
                          stopReason = "cancelled";
                          terminateForReason();
                        }
                      }
                      break;
                    }
                    string text = Encoding.UTF8.GetString(b, 0, r);
                    if (text.Contains("cancel")) {
                      lock (ioLock) {
                        if (stopReason == null) {
                          stopReason = "cancelled";
                          terminateForReason();
                        }
                      }
                      break;
                    }
                  }
                }
              } catch {
                // Parent stdin unavailable.
              }
            });
          }

          Task writeStdin = Task.Run(() => {
            try {
              using (stdinSafeHandle)
              using (var stdinStream = new FileStream(stdinSafeHandle, FileAccess.Write)) {
                if (stdinBytes != null && stdinBytes.Length > 0) {
                  stdinStream.Write(stdinBytes, 0, stdinBytes.Length);
                  stdinStream.Flush();
                }
              }
            } catch (IOException) {
              // Child exited or closed stdin early.
            } catch (ObjectDisposedException) {
              // Stdin handle disposed during shutdown.
            }
          });

          long waitDeadlineTicks = DateTime.UtcNow.Ticks + (long)Math.Max(1, timeoutMs) * 10000L;
          uint waited = WaitForSingleObject(pi.hProcess, 0);
          while (waited != WAIT_OBJECT_0) {
            if (!string.IsNullOrEmpty(cancelFilePath) && File.Exists(cancelFilePath)) {
              lock (ioLock) {
                if (stopReason == null) stopReason = "cancelled";
              }
              TerminateJobObject(hJob, 1);
              WaitForSingleObject(pi.hProcess, (uint)Math.Max(500, closeGraceMs));
              break;
            }
            long remainingMs = (waitDeadlineTicks - DateTime.UtcNow.Ticks) / 10000L;
            if (remainingMs <= 0) {
              lock (ioLock) {
                if (stopReason == null) stopReason = "timed-out";
              }
              TerminateJobObject(hJob, 1);
              WaitForSingleObject(pi.hProcess, (uint)Math.Max(500, closeGraceMs));
              break;
            }
            uint sliceMs = (uint)Math.Min(25L, remainingMs);
            waited = WaitForSingleObject(pi.hProcess, sliceMs);
          }
          cancelCts.Cancel();

          uint exitCode = 0;
          if (GetExitCodeProcess(pi.hProcess, out exitCode)) {
            outcome.ExitCode = unchecked((int)exitCode);
            outcome.HasExitCode = true;
          }

          if (QueryActiveProcesses(hJob) > 0) {
            TerminateJobObject(hJob, 1);
          }

          Task.WaitAll(new[] { readOut, readErr, writeStdin }, Math.Max(500, closeGraceMs));

          long graceUntil = DateTime.UtcNow.Ticks + (long)Math.Max(500, closeGraceMs) * 10000L;
          uint active = QueryActiveProcesses(hJob);
          while (active > 0 && DateTime.UtcNow.Ticks < graceUntil) {
            Thread.Sleep(25);
            active = QueryActiveProcesses(hJob);
          }
          outcome.ActiveProcessesRemaining = active;
          outcome.Quiescent = (active == 0);
          byte[] stdoutData;
          byte[] stderrData;
          lock (ioLock) {
            stdoutData = outBuffer.ToArray();
            stderrData = errBuffer.ToArray();
          }
          outcome.StdoutBase64 = Convert.ToBase64String(stdoutData);
          outcome.StderrBase64 = Convert.ToBase64String(stderrData);

          if (!outcome.Quiescent) {
            outcome.Status = "unknown";
            outcome.Reason = (stopReason ?? "close") + "-close-unconfirmed";
          } else if (stopReason != null) {
            outcome.Status = stopReason;
            outcome.Reason = stopReason;
          } else if (outcome.HasExitCode && outcome.ExitCode == 0) {
            outcome.Status = "succeeded";
          } else {
            outcome.Status = "failed";
          }
        }
      } catch (Exception ex) {
        outcome.Status = "failed";
        outcome.Quiescent = true;
        outcome.Reason = ex.Message;
        if (hJob != IntPtr.Zero) {
          TerminateJobObject(hJob, 1);
        }
      } finally {
        CloseIfValid(ref pi.hThread);
        CloseIfValid(ref pi.hProcess);
        CloseIfValid(ref hJob);
        CloseIfValid(ref stdinRead);
        CloseIfValid(ref stdinWrite);
        CloseIfValid(ref stdoutRead);
        CloseIfValid(ref stdoutWrite);
        CloseIfValid(ref stderrRead);
        CloseIfValid(ref stderrWrite);
        if (envPtr != IntPtr.Zero) Marshal.FreeHGlobal(envPtr);
      }

      return outcome;
    }
  }
}
'@

$loadedJobRunner = $false
try {
  $cacheVersionInput = $csharp + '|' + $PSVersionTable.CLRVersion + '|' + [IntPtr]::Size
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($cacheVersionInput))
  } finally {
    $sha256.Dispose()
  }
  $cacheHash = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
  $cacheKey24 = $cacheHash.Substring(0, 24)
  $cacheKey16 = $cacheHash.Substring(0, 16)

  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  if (-not [string]::IsNullOrWhiteSpace($localAppData)) {
    $cacheDir = Join-Path $localAppData 'dsh-ray\winjob-cache'
  } else {
    $cacheDir = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-ray-winjob-cache'
  }
  $dllPath = Join-Path $cacheDir "JobRunner-$cacheKey24.dll"

  if (Test-Path -LiteralPath $dllPath -PathType Leaf) {
    try {
      Add-Type -Path $dllPath
      $loadedJobRunner = $true
    } catch {
      $loadedJobRunner = $false
    }
  }

  if (-not $loadedJobRunner) {
    if (-not (Test-Path -LiteralPath $cacheDir -PathType Container)) {
      New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    }
    $mutex = New-Object System.Threading.Mutex($false, "Local\DshRayWinJob_$cacheKey16")
    $mutexAcquired = $false
    try {
      try {
        $mutexAcquired = $mutex.WaitOne(15000)
      } catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
      }
      if ($mutexAcquired) {
        if (Test-Path -LiteralPath $dllPath -PathType Leaf) {
          try {
            Add-Type -Path $dllPath
            $loadedJobRunner = $true
          } catch {
            Remove-Item -LiteralPath $dllPath -Force -ErrorAction SilentlyContinue
          }
        }
        if (-not $loadedJobRunner) {
          $tempDll = Join-Path $cacheDir ("JobRunner-$cacheKey24-" + [Guid]::NewGuid().ToString('N') + '.tmp.dll')
          try {
            Add-Type -TypeDefinition $csharp -Language CSharp -OutputAssembly $tempDll -IgnoreWarnings
            if (-not (Test-Path -LiteralPath $dllPath -PathType Leaf)) {
              [System.IO.File]::Move($tempDll, $dllPath)
            }
          } finally {
            if (Test-Path -LiteralPath $tempDll -PathType Leaf) {
              Remove-Item -LiteralPath $tempDll -Force -ErrorAction SilentlyContinue
            }
          }
          if (-not ('DshIsolation.JobRunner' -as [type])) {
            Add-Type -Path $dllPath
          }
          $loadedJobRunner = $true
        }
      }
    } finally {
      if ($mutexAcquired) {
        try { $mutex.ReleaseMutex() } catch {}
      }
      $mutex.Dispose()
    }
  }
} catch {
  $loadedJobRunner = $false
}

if (-not $loadedJobRunner -and -not ('DshIsolation.JobRunner' -as [type])) {
  Add-Type -TypeDefinition $csharp -Language CSharp -IgnoreWarnings
}

$specRaw = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8
$spec = ConvertFrom-Json -InputObject $specRaw

$envMap = New-Object 'System.Collections.Generic.Dictionary[string, string]' ([System.StringComparer]::OrdinalIgnoreCase)
if ($null -ne $spec.env) {
  foreach ($prop in $spec.env.PSObject.Properties) {
    $envName = [string]$prop.Name
    if ([string]::IsNullOrEmpty($envName) -or $envName.Contains('=')) {
      continue
    }
    $envMap[$envName] = [string]$prop.Value
  }
}
$sortedEnvKeys = New-Object System.Collections.Generic.List[string] ($envMap.Keys)
$sortedEnvKeys.Sort([System.StringComparer]::OrdinalIgnoreCase)
$envList = New-Object System.Collections.Generic.List[string]
foreach ($envKey in $sortedEnvKeys) {
  $envList.Add("$envKey=$($envMap[$envKey])")
}

$stdinBytes = [byte[]]@()
if ($null -ne $spec.stdinBase64 -and $spec.stdinBase64.Length -gt 0) {
  $stdinBytes = [Convert]::FromBase64String([string]$spec.stdinBase64)
}

$outcome = [DshIsolation.JobRunner]::Execute(
  [string]$spec.applicationName,
  [string]$spec.commandLine,
  [string]$spec.cwd,
  $envList.ToArray(),
  $stdinBytes,
  [int]$spec.timeoutMs,
  [int]$spec.closeGraceMs,
  [int]$spec.maxOutputBytes,
  [long]$spec.limits.memoryLimitBytes,
  [int]$spec.limits.activeProcessLimit,
  [long]$spec.limits.perJobUserTimeLimit100Ns,
  [uint32]$spec.limits.cpuRate,
  [uint32]$spec.limits.uiRestrictionsFlags,
  ([bool]$spec.controlOnStdin),
  [string]$spec.cancelFilePath
)

$payload = @{
  schemaVersion = 1
  status = $outcome.Status
  quiescent = $outcome.Quiescent
  exitCode = if ($outcome.HasExitCode) { $outcome.ExitCode } else { $null }
  stdoutBase64 = $outcome.StdoutBase64
  stderrBase64 = $outcome.StderrBase64
  pid = [int]$outcome.Pid
  activeProcessesRemaining = [int]$outcome.ActiveProcessesRemaining
  reason = $outcome.Reason
}

$json = $null
if (($outcome.StdoutBase64.Length + $outcome.StderrBase64.Length) -gt 524288) {
  try {
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = [int]::MaxValue
    $json = $serializer.Serialize($payload)
  } catch {
    $json = $null
  }
}
if ($null -eq $json) {
  $json = ConvertTo-Json -InputObject $payload -Compress
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding ($false)
[Console]::Out.WriteLine($json)
