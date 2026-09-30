# Built only by build-plugin-verifier-image.mjs from manifests, lock and its
# fixed worker. The local source image ID is an explicit immutable build arg.
ARG SOURCE_IMAGE=scratch
FROM ${SOURCE_IMAGE}
USER root
WORKDIR /opt/dsh-plugin-verifier
COPY . /opt/dsh-plugin-verifier
RUN test "$(node -p 'require("./package.json").packageManager')" = pnpm@11.7.0 \
 && cmp pnpm-lock.yaml /opt/dsh-source-baseline/pnpm-lock.yaml \
 && mkdir -p /workspace/.pnpm-store /workspace/.pnpm-cache \
 && cp -R /opt/pnpm-store/. /workspace/.pnpm-store/ \
 && cp -R /opt/pnpm-cache/. /workspace/.pnpm-cache/ \
 && pnpm install --offline --frozen-lockfile --ignore-scripts --trust-lockfile \
 && rm -rf /workspace/.pnpm-store /workspace/.pnpm-cache \
 && ln -s ../../plugins/assistant-verifier/node_modules/@deepseek-ai/dsh-tools node_modules/@deepseek-ai/dsh-tools \
 && ln -s ../../plugins/assistant-verifier/node_modules/@deepseek-ai/dsh-system-prompt node_modules/@deepseek-ai/dsh-system-prompt \
 && test "$(node -p 'require("./node_modules/@deepseek-ai/cordis/package.json").version')" = 4.0.2 \
 && test "$(node -p 'require("./node_modules/@deepseek-ai/dsh-tools/package.json").version')" = 0.1.5-rc.3 \
 && test "$(node -p 'require("./node_modules/@deepseek-ai/dsh-system-prompt/package.json").version')" = 0.1.5-rc.3 \
 && test "$(node --version)" = v22.23.2 \
 && chmod -R a+rX /opt/dsh-plugin-verifier \
 && chmod 0755 /opt/dsh-plugin-verifier/worker.mjs
# The isolation supervisor uses BusyBox for its keeper and stop probes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends busybox \
 && test -x /bin/busybox \
 && rm -rf /var/lib/apt/lists/*
USER 65534:65534
WORKDIR /workspace
RUN test -x /bin/busybox \
 && node -e "for(const n of ['@deepseek-ai/cordis','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-system-prompt']) require.resolve('/opt/dsh-plugin-verifier/node_modules/'+n+'/package.json')"
