# One-click Installers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide two one-command installers and one development restart command that target `web` by default, install the complete non-duplicating personal-assistant deployment set from either this checkout or npm, ensure the compatible DSH/pnpm toolchain, and run the existing Feishu onboarding flow without destroying a working local bot unless the user chooses replacement.

**Architecture:** Three executable Bash entrypoints live under `scripts/install/`: two installers share a Bash library for argument parsing, dependency checks, package selection, DSH profile validation, Feishu state detection, and onboarding, while a separate restart command accepts only an optional profile positional argument, rebuilds linked source, and kickstarts an existing launchd job without running installation or onboarding. The npm entrypoint can download the shared library when invoked remotely as a single script. Tests execute the scripts in dry-run mode and against fake tool binaries so no real profile, registry, Keychain, launchd job, or network state is changed.

**Tech Stack:** Bash 3.2+, Node.js 22.19+/24+, npm, pnpm 11.7.0, DSH 0.1.0-rc.8, Vitest 4.

## Global Constraints

- Default profile is `web`; `--profile <name>` accepts only DSH-safe profile identifiers.
- Source mode links absolute `plugins/*` directories from this checkout after `pnpm install` and `pnpm build`.
- npm mode installs `@dsh-enhanced/*@latest` by default and supports `--plugin-version <version>`.
- The deployment set uses `personal-assistant` as the core meta-bundle; it must not also mount its four internal bundles separately.
- `acp` remains exclusive to the ACP profile and `hello` remains an example, so neither joins the Web deployment set.
- Claude and other unavailable local subscription CLIs are never enabled by the installer.
- Existing enabled Feishu configuration defaults to keep/restart; replacing it requires the explicit configure choice.
- Secrets remain inside the existing `dsh-lark-setup` Keychain/device-authorization flow and never become script arguments or logs.
- macOS uses Keychain + launchd; Linux uses Secret Service + systemd user services and is equally supported.
- Windows uses a DPAPI-bound credential file + Task Scheduler as a best-effort implementation without a support guarantee.

---

### Task 1: Executable installer contract tests

**Files:**
- Create: `tests/installers.spec.ts`
- Test: `tests/installers.spec.ts`

**Interfaces:**
- Consumes: `scripts/install/install-local.sh`, `scripts/install/install-npm.sh` CLI surfaces.
- Produces: regression coverage for default profile, package source, safe package set, argument validation, DSH bootstrap plan, and Feishu choices.

- [x] **Step 1: Write the failing tests**

```ts
test('local installer targets web and absolute checkout plugins', () => {
  const result = run('install-local.sh', ['--dry-run', '--lark', 'skip'])
  expect(result.stdout).toContain('profile: web')
  expect(result.stdout).toContain('/plugins/personal-assistant')
  expect(result.stdout).not.toContain('/plugins/acp')
})

test('npm installer pins DSH and accepts a release selector', () => {
  const result = run('install-npm.sh', ['--dry-run', '--lark', 'skip', '--plugin-version', '0.2.0'])
  expect(result.stdout).toContain('@deepseek-ai/dsh@0.1.0-rc.8')
  expect(result.stdout).toContain('@dsh-enhanced/personal-assistant@0.2.0')
})
```

- [x] **Step 2: Run tests to verify RED**

Run: `pnpm exec vitest run tests/installers.spec.ts`

Expected: FAIL because both installer entrypoints do not exist.

- [x] **Step 3: Keep the tests isolated**

Use a temporary `DSH_HOME`, `--dry-run`, and fake commands where an execution-path assertion is required. Assert that no real profile or Keychain path is written.

- [x] **Step 4: Run tests after implementation**

Run: `pnpm exec vitest run tests/installers.spec.ts`

Expected: all installer tests pass with no network or host mutation.

### Task 2: Shared installer engine and two entrypoints

**Files:**
- Create: `scripts/install/common.sh`
- Create: `scripts/install/install-local.sh`
- Create: `scripts/install/install-npm.sh`
- Create: `scripts/install/restart.sh`

**Interfaces:**
- Consumes: `dsh plugin --profile <profile> add`, `dsh --profile <profile> --dump-config`, and the installed profile's `dsh-lark-setup` binary.
- Produces: `dsh_enhanced_install <local|npm> [args...]` and two executable user-facing scripts.

- [x] **Step 1: Implement strict argument parsing**

```bash
PROFILE=web
LARK_MODE=auto
DSH_VERSION=0.1.0-rc.8
PLUGIN_VERSION=latest
MANAGE_SERVICE=1
DRY_RUN=0
```

Support `--profile`, `--lark auto|keep|configure|skip`, `--dsh-version`, `--plugin-version`, `--no-service`, `--yes`, `--dry-run`, and `--help`; reject unknown options and unsafe profile identifiers.

- [x] **Step 2: Implement compatible toolchain bootstrap**

Require a compatible Node runtime. If `dsh --version` is absent or differs from the requested baseline, execute `npm install --global @deepseek-ai/dsh@<version>`. In local mode, ensure pnpm `11.7.0`, then run `pnpm install` and `pnpm build` from the resolved repository root.

- [x] **Step 3: Install the deployment bundles in one idempotent DSH operation**

```bash
PLUGIN_SLUGS=(
  coding-subscription-provider traex-acp-provider personal-assistant
  assistant-delivery credentials-keychain lark-channel memory-wiki-bridge
  assistant-heartbeat event-triggers assistant-health
)
```

Local mode maps each slug to an absolute checkout directory. npm mode maps each slug to `@dsh-enhanced/<slug>@<plugin-version>`. Run one `dsh plugin --profile "$PROFILE" add ...` and then `dsh --profile "$PROFILE" --dump-config`.

- [x] **Step 4: Implement Feishu keep/configure/skip flow**

Detect an enabled, non-placeholder `dsh-enhanced-lark-channel` row in the selected profile patch. In `auto`, offer keep/restart or configure/overwrite for an existing bot, and configure-now or skip when no bot exists. `configure` runs `dsh-lark-setup --profile "$PROFILE"`, preserving the existing wizard's App ID prompt and official select/create page. `keep` runs only `--install-service` unless `--no-service` was selected.

- [x] **Step 5: Make npm remote bootstrap self-contained**

When `install-npm.sh` is not beside `common.sh`, download the matching raw `common.sh` into an isolated `mktemp -d` directory via curl or wget, source it, then remove only the explicitly created file and directory.

- [x] **Step 6: Mark entrypoints executable and run shell syntax checks**

Implement `restart.sh [profile]`: the sole optional argument is the profile name and defaults to `web`. Run `pnpm build` from this checkout, then require the existing macOS launchd job and execute `launchctl kickstart -k gui/$(id -u)/ai.deepseek.dsh.profile.<profile>`. Under `DSH_ENHANCED_DRY_RUN=1`, print both operations without executing them so tests remain non-mutating. It must not call `dsh plugin`, `dsh-lark-setup`, or modify profile files.

Run: `chmod +x scripts/install/install-local.sh scripts/install/install-npm.sh scripts/install/restart.sh`

Run: `bash -n scripts/install/common.sh scripts/install/install-local.sh scripts/install/install-npm.sh scripts/install/restart.sh`

Expected: exit 0.

### Task 3: User documentation and verification

**Files:**
- Create: `scripts/install/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: final installer flags and deployment-set semantics.
- Produces: short local command, remote npm command, rerun/overwrite behavior, package inventory, and troubleshooting guidance.

- [x] **Step 1: Document the two primary commands**

```sh
./scripts/install/install-local.sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/22-ai-00/dsh-enhanced/main/scripts/install/install-npm.sh)"
```

Explain `--profile`, `--lark`, `--plugin-version`, `--no-service`, and `--dry-run`, and state that npm mode is usable only after the packages are published.

- [x] **Step 2: Document package selection and exclusions**

List the ten top-level deployment bundles, the four core packages transitively supplied by `personal-assistant`, and the deliberate exclusion of `acp` and `hello` from Web installation.

- [x] **Step 3: Run safe installer smoke checks**

Run:

```sh
scripts/install/install-local.sh --dry-run --lark skip
scripts/install/install-npm.sh --dry-run --lark skip --plugin-version 0.2.0
DSH_ENHANCED_DRY_RUN=1 scripts/install/restart.sh web
```

Expected: both print the selected profile, exact package targets, validation, and skipped Feishu action without modifying a profile.

- [x] **Step 4: Run complete repository verification**

Run: `pnpm check`

Expected: manifest validation, zero lint warnings, typechecking, all tests, builds, and every plugin dry-run pack succeed.

### Task 4: Cross-platform Feishu credentials and resident services

**Files:**
- Modify: `plugins/credentials-keychain/src/types.ts`
- Modify: `plugins/credentials-keychain/src/config.ts`
- Modify: `plugins/credentials-keychain/src/providers.ts`
- Modify: `plugins/lark-channel/src/setup.ts`
- Modify: `plugins/lark-channel/src/setup-profile.ts`
- Create: `plugins/lark-channel/src/systemd.ts`
- Create: `plugins/lark-channel/src/windows-task.ts`
- Create: `plugins/lark-channel/src/resident.ts`
- Test: `plugins/credentials-keychain/tests/config.spec.ts`
- Test: `plugins/credentials-keychain/tests/providers.spec.ts`
- Test: `plugins/lark-channel/tests/setup.spec.ts`
- Test: `plugins/lark-channel/tests/setup-profile.spec.ts`
- Create: `plugins/lark-channel/tests/systemd.spec.ts`
- Create: `plugins/lark-channel/tests/windows-task.spec.ts`

**Interfaces:**
- Consumes: fixed OS credential CLIs, `systemctl --user`, launchd, and Windows Task Scheduler.
- Produces: `windows-dpapi` credential handles and `installDshResidentService()` platform routing.

- [x] **Step 1: Add failing provider/profile tests**

Require `linux-secret-service` handles from Linux onboarding and `windows-dpapi` handles containing only an absolute encrypted-file locator. Verify fixed no-shell provider commands and that plaintext secrets never enter argv.

- [x] **Step 2: Add failing resident-service tests**

Require a private systemd user unit with a minimal environment, restart policy, and explicit node/DSH argv. Require a Windows launcher and scheduled task containing no secret. Verify the unified installer selects launchd, systemd, or Task Scheduler by platform.

- [x] **Step 3: Implement Linux and Windows onboarding storage**

Store generated/manual secrets through stdin: `/usr/bin/secret-tool store` on Linux and a fixed PowerShell DPAPI `Export-Clixml` command on Windows. Read them through the same locator used by `credentials-keychain`; retain `/usr/bin/security` on macOS.

- [x] **Step 4: Implement resident-service routing**

Install/restart launchd on Darwin, a systemd user unit on Linux, and a best-effort current-user scheduled task on Windows. Expose platform-specific status and log commands without copying ambient tokens or passwords.

- [x] **Step 5: Make restart.sh choose the OS service manager**

After `pnpm build`, use launchd on Darwin, `systemctl --user restart dsh-profile-<profile>.service` on Linux, and Task Scheduler end/run commands on Windows. Keep `[profile]` as its only optional argument.
