# Built only by build-plugin-verifier-image.mjs from manifests, lock and its
# fixed worker. The local source image ID is an explicit immutable build arg.
ARG SOURCE_IMAGE=scratch
FROM ${SOURCE_IMAGE} AS launcher-build
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev
COPY scripts/isolation/plugin-observer-launcher.c /tmp/plugin-observer-launcher.c
RUN cc -std=c11 -O2 -Wall -Wextra -Werror /tmp/plugin-observer-launcher.c -o /tmp/candidate-launcher \
 && cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared -DDSH_PARENT_PRELOAD /tmp/plugin-observer-launcher.c -o /tmp/parent-protect.so \
 && cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared -DDSH_CHILD_PRELOAD /tmp/plugin-observer-launcher.c -o /tmp/child-protect.so \
 && readelf -d /tmp/parent-protect.so | grep -q '(INIT_ARRAY)' \
 && readelf -d /tmp/child-protect.so | grep -q '(INIT_ARRAY)' \
 && cc -std=c11 -O2 -Wall -Wextra -Werror -DDSH_PARENT_PRELOAD_TEST /tmp/plugin-observer-launcher.c -o /tmp/parent-preload-test \
 && cc -std=c11 -O2 -Wall -Wextra -Werror -DDSH_CHILD_PRELOAD_TEST /tmp/plugin-observer-launcher.c -o /tmp/child-preload-test \
 && LD_PRELOAD=/tmp/parent-protect.so /tmp/parent-preload-test \
 && LD_PRELOAD=/tmp/child-protect.so /tmp/child-preload-test
FROM ${SOURCE_IMAGE}
USER root
WORKDIR /opt/dsh-plugin-verifier
COPY . /opt/dsh-plugin-verifier
COPY --from=launcher-build /tmp/candidate-launcher /opt/dsh-plugin-verifier/candidate-launcher
COPY --from=launcher-build /tmp/parent-protect.so /opt/dsh-plugin-verifier/parent-protect.so
COPY --from=launcher-build /tmp/child-protect.so /opt/dsh-plugin-verifier/child-protect.so
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
 && chmod 0755 /opt/dsh-plugin-verifier/worker.mjs /opt/dsh-plugin-verifier/candidate.mjs /opt/dsh-plugin-verifier/candidate-launcher
# The isolation supervisor uses BusyBox for its keeper and stop probes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends busybox \
 && test -x /bin/busybox \
 && rm -rf /var/lib/apt/lists/*
USER 65534:65534
WORKDIR /workspace
RUN test -x /bin/busybox \
 && node -e "for(const n of ['@deepseek-ai/cordis','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-system-prompt']) require.resolve('/opt/dsh-plugin-verifier/node_modules/'+n+'/package.json')"
