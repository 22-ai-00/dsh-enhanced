# 受监督成长激活器

`dsh-supervised-growth-setup --profile web` 只能在完成 Lark onboarding 后使用。它只读取 Delivery/Automations 的本地 SQLite 控制面，不解析或执行任何模型输入；首先等待一条与 profile 中 account、tenant、默认 workspace 和 preset 完全一致的 active owner 私聊 binding。没有匹配时会要求 owner 再发一条普通私聊并进行有界轮询；超时、存在多个匹配或 route 不一致时均不修改 profile。

```sh
~/.dsh/profiles/web/node_modules/.bin/dsh-supervised-growth-setup --profile web

# 仅当确认已有活动任务可以在 scheduler 开启后继续运行时使用
~/.dsh/profiles/web/node_modules/.bin/dsh-supervised-growth-setup \
  --profile web \
  --ack-existing-automations
```

## 激活前检查

激活器会检查已有 automation。任何 active job（包括旧 `assistant-heartbeat` job）默认都会阻止启用：scheduler 开启后会加载全部 durable row，不能按 owner 名称推测旧 heartbeat 是否安全。

只有在确认所有现存任务都可在 scheduler 启用后继续运行时，才传入 `--ack-existing-automations`。这个确认不会恢复、创建或改写 job 定义，但现有 active job 之后可被 scheduler 领取。

激活器基于 `dsh --dump-config` 的有效组合树生成完整受管 overlay，不假设 raw patch 已含 meta-bundle 配置；Delivery 与 Automations 的数据库路径也从有效树取得。原子写入后，它会再次 dump 并验证：

- scheduler 配置；
- TraeX cwd 与 route；
- `automation-runs` budget；
- heartbeat；
- 每条 setup 托管的 Policy rule。

如果 home/profile 的高优先级 layer 覆盖任何受管值，写入会立即恢复。激活器在写入前和重启前都会重读同一 owner binding 的完整 route、status 与 version；version 变化、撤销或多个 binding 均 fail closed。

## Provider 与常驻健康门

重启 Host 前，激活器调用 TraeX provider 唯一的 installer-only readiness probe：固定的只读 ACP catalog handshake 检查可执行文件、登录状态和至少一个可用模型，但不会发送模型 prompt。

普通 `listModels` / `resolveModel` 不使用这项静态 cwd 例外；真实模型执行仍要求 live loop session 的 canonical cwd 与配置 workspace 完全一致。重启后还必须通过 resident running health gate，否则恢复旧 profile 和旧服务。

Windows Task Scheduler 没有该实现所需的可验证健康信号，因此 supervised growth 在 Windows 拒绝激活，不会把 best-effort 启动伪装成常驻成功。

## 生成的受控任务

受管 overlay 只允许精确 workspace/preset 的后台 heartbeat：

- 08:00–22:00 每 120 分钟执行一次，恰好每天 7 次；
- 每轮先调用 `evolution_review`，之后最多调用一次 `evolution_propose`；
- 每轮最多 2 次工具调用和 512 个输出 token；
- Policy budget 使用 `automation-runs`，每天最多 7 次、每次固定计 1；512 是输出上限，不是不具备可验证性的总 token 预算；
- pending Evolution proposal 的审批卡只允许固定 Evolution 后台主体投递到这个 exact owner binding；owner approval 仍是唯一 apply 门；
- scratch 禁止 decide/apply、修改代码、凭据、Policy 或已有 automation；没有候选时必须精确输出 `HEARTBEAT_OK`；
- overlay 不授予 shell、文件系统、网络或凭据权限。

## 升级与 legacy binding

升级前已有的 conversation binding 会继续固定旧 preset/workspace；旧安装常见 preset 为 `primary`。新 binding 使用 Delivery 当前默认身份。

执行 `dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools` 时，setup 会按完整 preset + workspace 保留精确 legacy 规则，并把主规则更新到当前默认身份。refresh 会清除所有历史 account id 的 setup-managed external reply/capability/tool 规则，只为当前 account 的 canonical owner principal 重建。

Delivery 外部规则的 principal、preset 和 workspace 始终精确；capability 的 action/resource 使用 `*`，以覆盖该身份已挂载的动态工具和插件内部 Policy 动作。外部工具规则仍以工具 id `*` 配合可选显式 deny。本地 `foreground` 规则则有意对 preset/workspace 使用 `*`，支持 Web/direct 中的用户切换。
