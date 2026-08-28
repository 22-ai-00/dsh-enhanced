/**
 * Side-effect-free feature handshake for independently installed consumers.
 * Keep this subpath free of Cordis and service imports so setup tools can
 * verify compatibility before loading a profile or starting OAuth.
 */
export const supportedCredentialProviders = Object.freeze([
  'environment',
  'linux-protected-file',
  'linux-secret-service',
  'macos-keychain',
  'windows-dpapi',
] as const)
