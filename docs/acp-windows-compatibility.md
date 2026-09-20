# ACP 插件 Windows 兼容性

更新：2026-09-20。以下按当前工作区代码和 CI 配置整理；发布版本与 DSH 支持范围统一见[兼容性基线](compatibility.md)。

## 当前边界

ACP 提供实验性原生 Windows 支持。当前源码与自动化检查覆盖如下；配置了 CI 不代表每次运行都通过，也不能替代真实 Windows 客户端验证。

| 项目 | 当前行为与依据 |
| --- | --- |
| 运行环境 | Node `^22.19.0 || >=24.0.0`；DSH peer 范围 `>=0.1.2-rc.1 <0.2.0`，见[包清单](../plugins/acp/package.json)。 |
| 默认模式 | `standard`；ACP 的 `code` 映射到 DSH 原生 `ptc`，另有 `cordis`，见[模式实现](../plugins/acp/src/control.ts)。 |
| `minimal` | 在 win32 隐藏并拒绝；不能把安装 Git Bash 或 WSL 当作原生 Windows 支持证明。 |
| stdio 与路径 | 使用 Node Web Stream 桥接 ACP；cwd 使用运行平台的绝对路径判断，见[入口实现](../plugins/acp/src/index.ts)。 |
| CI | Windows Server 2025 + Node 24：ACP 插件测试、tarball 打包、干净 profile 安装、peer 检查、`--dump-config` 和真实 stdio initialize，见[CI 定义](../.github/workflows/ci.yml)与[握手脚本](../plugins/acp/scripts/stdio-smoke.mjs)。 |

Windows CI 只覆盖 ACP 对应门禁；Linux/macOS 的仓库检查不能推导为所有插件均支持 Windows。

## 客户端验证

ACP 客户端须使用其支持的 Windows npm-bin 启动配置。若裸 `dsh` 无法启动，核对客户端对 `.cmd` shim 的处理；不要向 ACP stdout 写入额外提示。

在宣称主流客户端已验证前，仍需从 registry 安装发布版，在真实 Windows 10/11 客户端中完成 initialize、newSession、prompt、cancel、closeSession 和 EOF 清理，并验证模式切换、工具审批和模型选择。当前仓库文档不宣称这些用户环境验收已经完成。
