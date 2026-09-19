# This file is built only from the generated manifest-only context produced by
# build-source-image.mjs. Do not add application source, .npmrc, or a package
# store to that context.
ARG BASE_IMAGE=node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
FROM ${BASE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates coreutils curl git libatomic1 openssl perl python3 strace util-linux \
 && rm -rf /var/lib/apt/lists/*

# Corepack's activation shim keeps its downloaded package in root's cache.
# Copy the exact pnpm program to a world-readable runtime location instead, so
# the forced UID 65534 used by the source runner never needs that cache.
RUN corepack prepare pnpm@11.7.0 --activate \
 && entry="$(find /root/.cache/node/corepack -type f -path '*/bin/pnpm.cjs' -print -quit)" \
 && test -n "$entry" \
 && install -d -m 0755 /opt/pnpm-runtime \
 && cp -a "$(dirname "$(dirname "$entry")")"/. /opt/pnpm-runtime/ \
 && rm -f /usr/local/bin/pnpm \
 && printf '%s\n' '#!/bin/sh' 'exec node /opt/pnpm-runtime/bin/pnpm.cjs "$@"' > /usr/local/bin/pnpm \
 && chmod 0755 /usr/local/bin/pnpm \
 && test "$(/usr/local/bin/pnpm --version)" = 11.7.0

# The release-adapter integration fixture pins an actual native pnpm executable
# and its package root, independently of the source-runner launcher.
RUN npm install --prefix /opt/pnpm-native --ignore-scripts --no-audit --no-fund @pnpm/exe@11.7.0 \
 && native_arch="$(node -p 'process.arch')" \
 && cp "/opt/pnpm-native/node_modules/@pnpm/linux-$native_arch/pnpm" /opt/pnpm-native/node_modules/@pnpm/exe/pnpm \
 && chmod -R a+rX /opt/pnpm-native \
 && test "$(/opt/pnpm-native/node_modules/@pnpm/exe/pnpm --version)" = 11.7.0

ENV DSH_TEST_PNPM_ROOT=/opt/pnpm-native/node_modules/@pnpm/exe

ENV pnpm_config_store_dir=/opt/pnpm-store \
    pnpm_config_cache_dir=/opt/pnpm-cache \
    pnpm_config_package_import_method=copy \
    PNPM_HOME=/tmp/.pnpm \
    HOME=/tmp
WORKDIR /seed
COPY . /seed
RUN pnpm fetch --workspace-root --frozen-lockfile --ignore-scripts \
 && chmod -R a+rX /opt/pnpm-store /opt/pnpm-cache /opt/pnpm-runtime \
 && rm -rf /seed

# pnpm 11's store index is SQLite and must be writable even with --offline.
# Seed only the container's bounded workspace tmpfs, before the first install.
RUN printf '%s\n' '#!/bin/sh' 'set -eu' \
      'store=/workspace/.pnpm-store' \
      'cache=/workspace/.pnpm-cache' \
      'if [ ! -f "$store/.dsh-seed-ready" ]; then' \
      '  mkdir -p "$store" "$cache"' \
      '  cp -R /opt/pnpm-store/. "$store/"' \
      '  cp -R /opt/pnpm-cache/. "$cache/"' \
      '  chmod -R u+rwX "$store" "$cache"' \
      '  touch "$store/.dsh-seed-ready"' \
      'fi' \
      'export pnpm_config_store_dir="$store" pnpm_config_cache_dir="$cache"' \
      'exec node /opt/pnpm-runtime/bin/pnpm.cjs "$@"' > /usr/local/bin/pnpm \
 && chmod 0755 /usr/local/bin/pnpm

# Verify the pnpm program without allocating a build-stage workspace store.
USER 65534:65534
RUN test "$(node /opt/pnpm-runtime/bin/pnpm.cjs --version)" = 11.7.0
WORKDIR /workspace
