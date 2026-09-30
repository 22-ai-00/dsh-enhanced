# Source builder image

New supervised installations prepare this image automatically when the supported
Linux x64 Docker runtime is available. The installer pins the builder inputs,
records the immutable image ID in a private receipt, and verifies that receipt
before reusing the image. See the [RSI setup guide](../../plugins/lark-channel/docs/rsi-setup.md)
for the installed command, runtime requirements, and generated `sourceBuild` configuration.

Build the owner-controlled, manifest-only source-check image with:

```sh
node scripts/isolation/build-source-image.mjs
```

The script creates a temporary context containing only the Dockerfile, root
`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and direct workspace
`package.json` files. It does not copy repository source, `.npmrc`, credentials,
or a host package store. Docker uses a temporary empty configuration directory
and HOME so public dependency preparation does not read Host registry credentials. Docker progress is written to stderr; stdout is one
JSON record with the immutable image content ID, local tag, lock hash, and the
complete context-file inventory.

The base image and pnpm version are fixed in the script and Dockerfile. An
owner can set a bounded Docker-client path, timeout, or local tag:

```sh
node scripts/isolation/build-source-image.mjs \
  --docker-path /usr/bin/docker --timeout-ms 1800000 \
  --tag dsh-source-builder:owner-20260919
```

The image prewarms pnpm 11.7.0 from the exact lockfile while ignoring package
scripts. Its fixed launcher copies the image store into `/workspace/.pnpm-store`
and the policy metadata cache into `/workspace/.pnpm-cache` before the initial
install. This retains the lockfile supply-chain checks without network access.
The image also retains the exact successfully verified seed lock at the
read-only `/opt/dsh-source-baseline/pnpm-lock.yaml`. A new-plugin candidate
may add one Host-generated importer referencing only existing resolutions.
That changes pnpm's whole-lock verification cache key. Only after the Host
verifies the complete creation scope and the container matches the original
Git base lock SHA-256 to the image seed, the initial pnpm 11.7.0 install uses
`--trust-lockfile`, relying on the seed's completed verification. This skips
lock resolution and supply-chain re-verification; it does not authorize new
resolutions. Normal modifications retain the default verification policy.
Older images without the seed file cannot check newly created candidates.
pnpm 11 requires a writable SQLite store index even
with `--offline`. The source runner still provides writable workspace and `/tmp` tmpfs mounts and
runs every candidate check offline with a read-only root.

The image also contains native `@pnpm/exe@11.7.0` and its system libraries for
the existing release-adapter integration tests. `DSH_TEST_PNPM_ROOT` points to
that image-local toolchain for tests. The supervised installer also exports the
fixed native toolchain, Node, store, and metadata cache from the immutable image
into a private, digest-pinned release environment. Its local release adapter
uses that exported environment through Bubblewrap; it does not invoke the
source-runner launcher or bypass a test. Image preparation downloads this exact npm version with install scripts
disabled; the returned image digest pins the resulting bytes.

## Plugin behavior verifier image

After building the source image, provide its **local immutable content ID**:

```sh
node scripts/isolation/build-plugin-verifier-image.mjs \
  --source-image sha256:<64-hex-local-source-image-id>
```

The builder checks that ID, creates and removes a temporary local tag for
Docker BuildKit, and returns the verifier image's content ID. Its temporary
context contains only the root/workspace manifests, lock, Dockerfile, fixed
parent/candidate workers and native observer launcher; it excludes other product source, Host mounts, `.npmrc`, credentials and
expected behavior. It installs the exact locked Cordis 4.0.2, native tools and
system prompt 0.1.5-rc.3 packages offline with scripts disabled, and adds
BusyBox for the isolation supervisor. The build compiles the fixed launcher and
parent protection library for Linux x64. Debian package installation is a build
step; the returned image ID pins the completed image. No worker installation or
package download occurs during verification.

The Host-only behavior runner accepts a checked tgz of at most 512 KiB because
the existing isolation verifier's input limit is 1 MiB. It can discover native
schemas or invoke up to eight fixed tool calls in the isolated worker. It
reports raw observations or unknown outcomes, not goal success, source approval,
installation, or adoption. The Host must compare observations with an
independent acceptance oracle and retain the existing owner/grant fences.

The parent never imports the candidate. It calculates artifact/schema identity
and environment metadata, validates bounded results from a separate pipe and
waits for child exit. A fixed native launcher installs seccomp before the child
loads Node; the parent protection library sets non-dumpable and the parent
disables SIGUSR1 debugging. Node filesystem permissions are supplementary,
not the security boundary. No additional Docker capabilities are granted.
Wire v2 rejects old same-process worker responses; rebuild the image to use the
new runner. Tool schemas/results remain untrusted black-box output, and process
cleanup does not establish candidate lifecycle semantics or objective success.

Run the real package/process regressions against the newly built immutable ID:

```sh
DSH_PLUGIN_OBSERVER_REAL_DOCKER=1 \
DSH_PLUGIN_OBSERVER_TEST_IMAGE=sha256:<64-hex-verifier-image-id> \
pnpm --filter @dsh-enhanced/assistant-verifier exec vitest run tests/plugin-behavior-process.spec.ts
```

These also check the completed image's parent preload without Node permissions
and its child preload against raw descriptor-reuse execution. The latter uses
`/usr/bin/cc` to compile a trusted probe and mounts only its private temporary
directory read-only; candidate packages still run with the ordinary Isolation
configuration.

Ordinary checks also exercise raw kernel syscall rejection and same-UID parent
descriptor protection when Linux x64 and `/usr/bin/cc` are available; the
descriptor-reuse execution probe also requires `/usr/bin/setpriv`. The Docker
tests are explicit opt-in and their skipped status is not live verification.

## Nested sandbox profile

Full repository tests invoke the existing release adapter's Bubblewrap sandbox.
This needs an explicit owner `repositorySandbox.seccompPath` in addition to
`profile: repository`. The smoke below selects the vendored
`source-builder-seccomp.json`. The runner accepts only its fixed SHA-256
(`b1e4b5b709578785bd2aff4a3a344301997571ad0e8ae5747aec176571ddc342`),
a canonical non-writable-by-others file, Linux x64, and Docker Server
`29.4.1/linux/amd64`. It copies the verified bytes into a private temporary file
before invoking Docker and records the profile digest with the source tree.

The profile is derived from [Moby profiles/seccomp v0.1.0](https://github.com/moby/profiles/tree/c936cc7b4074219137bc0bee45670f5e4618d462/seccomp),
the module used by the tested Docker daemon. Original `default.json` SHA-256:
`01536f1d1df938ae611eba20d6349e0de7a99b6ecdee1549427a0b01b8301e28`.
Its Apache-2.0 license is retained in `source-builder-seccomp.LICENSE`.
The additional rules permit namespace-only `unshare`, amd64 `clone` with
`CLONE_NEWUSER`, and `mount`, `umount2`, and `pivot_root`. The clone rule does
not restrict all other clone flags. Kernel capability checks still apply;
this expands the available kernel surface compared with Docker's default.

The opt-in also sets `systempaths=unconfined` and masks `/sys` with an empty,
read-only, no-exec tmpfs. Docker's default `/proc` submount masks prevent
fresh procfs mounts in a child user namespace ([Linux procfs rules](https://github.com/torvalds/linux/blob/master/Documentation/filesystems/proc.rst)).
Docker's [systempaths option](https://docs.docker.com/reference/cli/docker/container/run/#security-configuration)
clears both masked and read-only system-path lists. The empty `/sys` does
**not** restore `/proc` masks. Arbitrary repository tests run in this outer
container and can see its unmasked `/proc`; the inner release sandbox does
not protect all outer test code. This profile is not equivalent to Docker's
default restrictions. Supervised installation selects it for the supported
pinned environment; standalone configuration must select it explicitly.
Standard builds and repository builds without this opt-in
retain the default system-path policy.

The runner retains UID 65534, zero capabilities, no-new-privileges, network
none, a read-only root, bounded resources, and no Host bind mounts or sockets.
The live sandbox smoke checks these boundaries and child namespace creation;
it does not prove absence of kernel vulnerabilities or other side channels.

```sh
pnpm --filter @dsh-enhanced/plugin-control-plane build
DSH_SOURCE_BUILD_IMAGE='sha256:<image-content-id>' \
DSH_SOURCE_BUILD_EVIDENCE=/tmp/source-sandbox-evidence.json \
node scripts/e2e/source-repository-sandbox-smoke.mjs
```

## Full repository acceptance

To verify the complete current workspace with the production source runner,
build the control-plane package, then use the returned immutable `image`:

```sh
pnpm --filter @dsh-enhanced/plugin-control-plane build
DSH_SOURCE_REPOSITORY_LIVE=1 \
DSH_SOURCE_BUILD_IMAGE='sha256:<image-content-id>' \
DSH_SOURCE_BUILD_EVIDENCE=/tmp/source-repository-evidence.json \
node scripts/e2e/source-repository-smoke.mjs
```

This owner-invoked engineering check snapshots the entire current workspace,
including uncommitted, non-ignored files. It runs the unchanged root
`pnpm check` and packs plugin-control-plane. Its repository profile allows
30 minutes, 16 GiB memory, 8 CPUs, 1024 PIDs, 4 GiB workspace, and 2 GiB `/tmp`.
Both tmpfs mounts permit execution of build tools and test fixtures; the root
remains read-only, with no capabilities or network. The evidence records actual Docker arguments and the immutable archived Git
tree label. Normal conditional integration skips remain in force (for example,
there is no Docker socket or nested-container authority). Physical recovery
tests also require a visible supervisor cgroup hierarchy; the masked `/sys`
does not provide it. Those cases run on a capable host, while rejection of an
invisible hierarchy remains covered inside this container. Container success
does not replace the host's physical recovery checks. This does not create
a source plan, invoke a model, publish packages, or activate a deployment.

Image construction needs Docker-daemon access and network access to the public
Debian/npm registries. Candidate execution stays offline. The image content ID
pins the resulting tools and store; rebuilding can produce a new ID because
Debian package repositories can change. Rebuild when the lockfile changes, and
retain the returned lock hash/context inventory beside the check evidence.
