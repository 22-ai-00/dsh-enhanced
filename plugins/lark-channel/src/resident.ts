import { installDshLaunchAgent } from './launchd.js'
import { installDshSystemdService } from './systemd.js'
import { installDshWindowsTask } from './windows-task.js'

export type ResidentServiceKind = 'launchd' | 'systemd' | 'windows-task-best-effort'

export interface InstalledResidentService {
  kind: ResidentServiceKind
  target: string
  statusCommand: string
  logCommand: string
}

export function residentServiceKind(platform: string): ResidentServiceKind {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux') return 'systemd'
  if (platform === 'win32') return 'windows-task-best-effort'
  throw new Error(`lark-channel setup: unsupported platform: ${platform}`)
}

export async function installDshResidentService(
  input: { dshHome: string; profile: string },
  platform: NodeJS.Platform = process.platform,
): Promise<InstalledResidentService> {
  const kind = residentServiceKind(platform)
  if (kind === 'launchd') {
    const service = await installDshLaunchAgent(input)
    return {
      kind,
      target: service.target,
      statusCommand: `launchctl print ${service.target}`,
      logCommand: `tail -f ${service.stderrPath}`,
    }
  }
  if (kind === 'systemd') {
    const service = await installDshSystemdService(input)
    return {
      kind,
      target: service.target,
      statusCommand: `systemctl --user status ${service.target}`,
      logCommand: service.logCommand,
    }
  }
  const service = await installDshWindowsTask(input)
  return {
    kind,
    target: service.target,
    statusCommand: `schtasks.exe /Query /TN "${service.target}"`,
    logCommand: service.logCommand,
  }
}
