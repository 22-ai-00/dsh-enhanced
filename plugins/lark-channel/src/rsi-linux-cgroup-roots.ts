/** Compatibility adapter; discovery is independent of RSI preparation. */
export {
  discoverLinuxCgroupRoots,
  parseLinuxV1ControllerMounts,
  parseLinuxV2UnifiedMount,
  RsiLinuxCgroupUnavailableError,
  type LinuxCgroupRoots,
  type LinuxV1CgroupRoots,
  type LinuxV2CgroupRoots,
} from '@dsh-ray/assistant-isolation/native-resources'
