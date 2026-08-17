# ACP 插件 Windows 兼容性复查

复查日期：2026-08-17。复查对象是当前 `@dsh-enhanced/acp` 工作区、目标运行时 DSH
`0.1.0-rc.6`，以及官方源码提交
[`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)。

## 结论

当前 `0.0.4` 候选版本应标记为 **提供实验性 Windows 支持，尚未完成真实用户环境和主流 ACP 客户端的充分验证**：

- 插件的安装、ACP stdio 桥接、路径处理，以及 `standard`、`code`、`cordis` 三个模式，
  从源码上具备 Windows 兼容性；默认模式是 `standard`。
- `minimal` 模式不在原生 Windows 上提供。它装配的是 persistent Bash，上游默认执行文件是
  `/bin/bash`，没有像另外三个模式一样切换到 PowerShell；插件会在 win32 隐藏并拒绝该模式。
- 本仓库新增 Windows Server 2025 CI，覆盖完整插件测试、tarball 干净安装、配置组合和真实
  stdio initialize；这些自动化证据仍不能替代真实 Windows 用户环境与主流 ACP 客户端验证。

在取得更广泛的真实客户端反馈之前，不宜在 README 或 npm 文案中写“完整支持 Windows”；遇到问题欢迎在开源仓库提交 issue 或 pull request。

## 分层核查

| 层面 | 判断 | 依据与边界 |
| --- | --- | --- |
| Node 运行时 | 兼容 | 插件只支持 Node `^22.19.0 || >=24.0.0`，与当前 DSH 源码基线一致；见[插件清单](../plugins/acp/package.json)和[上游根清单](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/package.json#L7-L10)。 |
| 插件依赖 | 代码级兼容 | 发布时随包安装的直接依赖只有 ACP SDK、Schemastery 和 Zod；当前安装闭包是 JavaScript 包，清单未声明 `os`/`cpu` 限制，也没有原生构建或安装脚本。宿主 DSH/Cordis 包是可选 peer，由 DSH 安装闭包提供；见[插件清单](../plugins/acp/package.json)、[SDK 0.25.1 清单](https://unpkg.com/@agentclientprotocol/sdk@0.25.1/package.json)和 [pnpm 锁文件](../pnpm-lock.yaml)。这不代表整个 DSH 没有平台专用实现；Windows 沙箱由 DSH 自己提供。 |
| Profile 安装 | 上游明确适配 | `dsh plugin` 在 win32 上通过 shell 调用 pnpm，专门处理 `.cmd` shim；profile 使用 hoisted linker、关闭 peer 自动安装，并用 junction 维护宿主包 fallback。见[插件安装实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts#L127-L133)和 [profile 实现](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/boot/app-boot/src/profile.ts#L133-L143)。Windows 上仍要求 pnpm 可从 PATH 找到。 |
| ACP stdio | 代码级兼容 | 插件以 Node 的 `Readable.toWeb(process.stdin)`、`Writable.toWeb(process.stdout)` 接入 SDK NDJSON stream，没有 shell、子进程或 POSIX signal 逻辑；见[桥接实现](../plugins/acp/src/index.ts)和 [SDK NDJSON 实现](https://github.com/agentclientprotocol/typescript-sdk/blob/v0.25.1/src/stream.ts#L16-L98)。 |
| 工作目录 | 代码级兼容 | `session/new` 使用运行平台的 `node:path.isAbsolute()` 校验 cwd，没有手工拼 `/`；因此原生 Windows drive path 和 UNC path 由 Node 的 win32 路径规则判断。见[会话校验](../plugins/acp/src/index.ts)。 |
| `standard` / `code` / `cordis` | 预期兼容 | 三个上游预设都在 win32 禁用 Bash tool、启用 PowerShell tool；DSH base 同样按平台选择 PowerShell sandbox 和 Windows ACL sandbox。见上游 [`standard`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/standard/agent.cordis.yml#L44-L50)、[`code`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/code/agent.cordis.yml#L51-L57)、[`cordis`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/cordis/agent.cordis.yml#L45-L51) 与 [base patch](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/bundle/base/cordis.patch.yml#L163-L216)。 |
| `minimal` | 原生 Windows 不提供 | 插件在 win32 从 ACP mode 列表隐藏并拒绝 `minimal`；见[模式表](../plugins/acp/src/control.ts)。上游 `minimal` 装配 `dsh-terminal-bash` 与 `dsh-tool-bash-persistent`，其 terminal 默认路径是 `/bin/bash`，对应组合测试也只在 Linux/macOS 运行。见 [`minimal` preset](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/config/agent-presets/minimal/agent.cordis.yml#L15-L38)、[Bash terminal 默认配置](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/terminal/terminal-bash/src/config.ts#L1-L50)和[平台门禁测试](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/shell/tool-bash-persistent/tests/loader-composition.spec.ts#L66-L70)。安装 Git Bash 或 WSL 不能等价证明这套原生 DSH sandbox/PTY 组合受支持。 |
| Windows 测试 | 自动化覆盖，尚无真实客户端验证 | 本仓库在 Windows Server 2025 + Node 24 上运行完整插件测试，打包并安装到隔离 profile，拒绝 peer 警告，检查 `--dump-config` 并进行真实 stdio initialize；见[当前 CI](../.github/workflows/ci.yml)与[握手脚本](../plugins/acp/scripts/stdio-smoke.mjs)。上游还运行 Windows inventory 和官方 built-bin ACP smoke；见[上游 CI](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.github/workflows/ci.yml#L437-L489)与 [built ACP smoke](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/scripts/run-gates.ts#L618-L642)。 |

## 客户端启动边界

PowerShell 或 cmd.exe 通常可以通过 npm 创建的 shim 执行 `dsh`。ACP 客户端如何启动 stdio agent
则属于客户端边界：如果客户端直接调用 Windows `CreateProcess` 或 Node `spawn`，却不处理 `.cmd`
shim，`"command": "dsh"` 可能在进入插件前就失败。上游 DSH 自己正是因为这个差异，在 Windows
调用 pnpm 时显式启用 shell；ACP SDK 示例也单独选择 `npx.cmd`。见
[DSH plugin launcher](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/apps/cli/src/plugin.ts#L127-L133)
和 [ACP SDK Windows 示例](https://github.com/agentclientprotocol/typescript-sdk/blob/v0.25.1/src/examples/client.ts#L99-L120)。

因此 Windows 文档应要求按具体客户端验证启动方式；若裸 `dsh` 失败，应使用客户端支持的
Windows npm-bin 启动配置，而不是在 ACP stdout 外包一层会打印提示文字的脚本。

## 达到“已验证 Windows”还缺什么

自动化 CI 已覆盖干净安装、配置组合、initialize 和模式策略。达到真实客户端“已验证 Windows”
还需要在 Windows 10/11、Node 24、pnpm 11 上执行：

1. 从 registry 安装发布版本，确认用户网络和 npm 配置下没有 missing-peer 警告。
2. 由主流 ACP 客户端进程启动 `dsh --profile acp`，验证 initialize、newSession、prompt、cancel、
   closeSession 和 EOF 清理，且 stdout 每一行都是 JSON-RPC。
3. 分别实际运行 `standard`、`code`、`cordis`，并确认 Windows 不展示且明确拒绝 `minimal`。
