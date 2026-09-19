# Source builder image

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
pnpm 11 requires a writable SQLite store index even
with `--offline`. The source runner still provides writable workspace and `/tmp` tmpfs mounts and
runs every candidate check offline with a read-only root.

The image also contains native `@pnpm/exe@11.7.0` and its system libraries for
the existing release-adapter integration tests. `DSH_TEST_PNPM_ROOT` points to
that image-local toolchain; it does not select a Host executable or bypass a
test. Image preparation downloads this exact npm version with install scripts
disabled; the returned image digest pins the resulting bytes.

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
default restrictions. The owner must explicitly select it for the pinned
check environment. Standard builds and repository builds without this opt-in
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
there is no Docker socket or nested-container authority). This does not create
a source plan, invoke a model, publish packages, or activate a deployment.

Image construction needs Docker-daemon access and network access to the public
Debian/npm registries. Candidate execution stays offline. The image content ID
pins the resulting tools and store; rebuilding can produce a new ID because
Debian package repositories can change. Rebuild when the lockfile changes, and
retain the returned lock hash/context inventory beside the check evidence.
