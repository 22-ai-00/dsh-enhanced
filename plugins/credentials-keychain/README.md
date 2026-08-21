# @dsh-enhanced/credentials-keychain

给可信 DSH 插件使用的凭据 handle 服务。配置只保存 locator 与 allowlist，值留在 macOS Keychain、Linux Secret Service、当前 Windows 用户的 DPAPI 加密文件或一个明确命名的进程环境变量中；每次使用都经过 `assistant-policy`、有界 lease 和不含 secret 的 SQLite 审计账本。

它不是密码管理器 UI，也不向 Agent 注册任何 tool。

## 安装

先安装 `@dsh-enhanced/assistant-policy`，再安装：

```sh
dsh plugin --profile web add @dsh-enhanced/credentials-keychain
dsh --profile web --dump-config
```

默认 `handles: []`，不会读取任何凭据。示例：

```yaml
handles:
  - id: lark-app-secret
    provider: macos-keychain
    service: dsh/lark
    account: personal
    consumers: [dsh-enhanced-lark-channel]
    purposes: [connect]
    maxLeaseMs: 86400000
```

相应 policy rule 必须显式允许：

```yaml
- id: lark-credential
  effect: allow
  subject: { kind: background, id: dsh-enhanced-lark-channel }
  actions: [credential.use]
  resource: { kind: credential, id: lark-app-secret }
  context: { initiators: [background] }
```

本地运维撤销还需单独允许 `external/local:<operator>` 的 `credential.revoke`。

## Provider

### macOS Keychain

插件只执行固定命令：

```text
/usr/bin/security find-generic-password -w -s <service> -a <account>
```

先由用户在系统外部写入 Keychain；本插件 v0.1 不创建、修改或删除条目。

### Linux Secret Service

插件只执行：

```text
/usr/bin/secret-tool lookup service <service> account <account>
```

子进程只收到固定 `PATH`，以及宿主已有的 `DBUS_SESSION_BUS_ADDRESS` / `XDG_RUNTIME_DIR`。不继承 `HOME`、token、代理或完整环境。

### Environment

```yaml
- id: lark-app-secret
  provider: environment
  environmentName: LARK_APP_SECRET
  consumers: [dsh-enhanced-lark-channel]
  purposes: [connect]
  maxLeaseMs: 86400000
```

只读取这一项；其他环境值不会复制给 consumer。该 provider 适合由 launchd/systemd/container secret injection 管理的部署，安全性取决于进程启动环境。

### Windows DPAPI（best-effort）

```yaml
- id: lark-app-secret
  provider: windows-dpapi
  path: 'C:\Users\me\.dsh\credentials-keychain\lark-web-primary.clixml'
  consumers: [dsh-enhanced-lark-channel]
  purposes: [connect]
  maxLeaseMs: 86400000
```

插件只执行固定的 Windows PowerShell `Import-Clixml` 解密命令，文件路径作为单独 argv 传入，PowerShell 脚本内容和可执行文件不能由配置覆盖。文件由 `dsh-lark-setup` 使用当前用户 DPAPI 创建，只能由同一 Windows 用户在同一登录上下文解密。Windows 路径已实现但不作跨 Windows/PowerShell/npm 组合的兼容承诺。

## Lease 语义

- consumer id 从调用方 Cordis fiber 的插件 `name` 推导，不能由 request 字符串指定。
- handle 同时校验 consumer、purpose、TTL 上限和 `assistant-policy`；任一未知值默认拒绝。
- `withSecret(caller, request, callback)` 只在 callback 期间传值，并提供 AbortSignal。完成、provider 失败、TTL、运维撤销和服务卸载都会写入 lease/audit ledger。
- idempotency key 只执行一次；已完成/失败/过期请求不会再次调用 callback。
- 运维撤销只中断精确 lease，不自动删除 OS 凭据。
- JavaScript string 无法可靠清零；consumer 必须不缓存、不记录、不返回 secret，并在 AbortSignal 后立即释放持有 secret 的 SDK/连接。

## 权限与数据

- **文件系统：**创建配置指定的绝对 SQLite 文件；父目录 `0700`、文件 `0600`、WAL/FULL、forward-only migration。账本只存 handle id、consumer、purpose、状态和时间，不存 locator 或值。
- **子进程：**仅 OS provider 的固定可执行文件与固定 argv 结构（macOS `security`、Linux `secret-tool`、Windows PowerShell DPAPI）；`shell: false`，5 秒默认超时，stdout/stderr 总量有界，错误文本不回传。
- **环境：**environment provider 读取单个 allowlisted 名称；Linux provider只转交 D-Bus/XDG session 定位。
- **网络：**无。
- **浏览器：**无。
- **凭据：**值只进入可信 consumer callback。`health`、`listHandles`、`listLeases`、异常与 policy audit 均不含值。
- **安装脚本：**无。

Cordis fiber identity 与 callback 是同进程合作式边界，不能阻止恶意插件通过 Node API 自行读环境、文件或其他进程。强隔离需要独立进程/容器和宿主 capability sandbox；本包不作虚假承诺。

## 兼容性

- `@deepseek-ai/cordis ^4.0.1`
- `@dsh-enhanced/assistant-policy >=0.1.0 <0.2.0`
- Node.js `^22.19.0 || >=24.0.0`（使用 `node:sqlite`）

参见仓库的[兼容性基线](../../docs/compatibility.md)。
