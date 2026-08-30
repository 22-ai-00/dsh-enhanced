# 分级自治成长激活器

`dsh-supervised-growth-setup --profile web` 只能在完成 Lark onboarding 后使用。它只读取 Delivery/Automations 的本地 SQLite 控制面，不解析或执行任何模型输入；首先等待一条与 profile 中 account、tenant、默认 workspace 和 preset 完全一致的 active owner 私聊 binding。没有匹配时会要求 owner 再发一条普通私聊并进行有界轮询；超时、存在多个匹配或 binding 不一致时均不修改 profile。

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
- Delivery 中非空的 provider/model，以及 heartbeat 与该 route 的精确一致性；
- `automation-runs` budget；
- heartbeat；
- Preference Learning 已启用，Evolution 的低风险自动回滚开关已打开；
- 每条 setup 托管的 Policy rule。

如果 home/profile 的高优先级 layer 覆盖任何受管值，写入会立即恢复。激活器在写入前和重启前都会重读同一 owner binding 的完整 route、status 与 version；version 变化、撤销或多个 binding 均 fail closed。

## 模型 route、工具协议与常驻健康门

激活器把有效 Delivery 配置中的 `agentProvider` / `agentModel` 原样用于受管 heartbeat，不改写 Delivery，也不硬编码或优先选择 TraeX。后台默认 route 由 profile owner 的既有 Delivery 配置决定；要切换它，应先修改并验证该 profile 的 Delivery 默认 route，而不是让后台任务猜测 provider。会话级 `/model` 覆盖不会被误当成后台默认值。

激活器自身不发送模型 prompt，也不会用某个 provider 的私有 readiness API 作为通用真源。每次 heartbeat 真正执行时，`assistant-automations` 会在模型请求前解析 live provider/model 协议元数据：最终工具集非空时，只有 adapter 明确声明 `toolCalls: none` 才 fail closed；缺失声明、`native` 和 `bridge` 均使用同一 Agent/preset 工具面、Policy 与审计。这一预检只判断统一 DSH tool-call 协议是否实现，不授予工具权限，也不把模型 route 当作能力边界。

模型登录和实际可调用性属于独立运行条件；安装器的 `--model-route verify` 可对 DSH headless route 主动消耗一次最小调用，但不替代当前 Delivery route 的 provider 登录与运行检查。重启后还必须通过 resident running health gate，否则恢复旧 profile 和旧服务。

Windows Task Scheduler 没有该实现所需的可验证健康信号，因此 supervised growth 在 Windows 拒绝激活，不会把 best-effort 启动伪装成常驻成功。

## 生成的受控任务

受管 overlay 只允许精确 workspace/preset 的后台 heartbeat：

- 08:00–22:00 每 120 分钟执行一次，恰好每天 7 次；
- 每轮先用 Evaluation 找出至多一条未自评结果；只按其 exact run 读取 Automation 历史，并只引用检索到的 owner-confirmed Memory；证据足够时可追加一次 `self-reported` objective 判断；
- 调用 `preference_review`；只有 Host 固定目录中证据已达标的 T1 shadow 假设，才可精确调用一次 `preference_activate`。它仍是带 TTL、可衰减、可回滚且服从当前指令的 tentative overlay，不会伪装成 owner-confirmed Memory；
- 之后调用 `evolution_review`。若 Host 能独立证明某条 active guidance 在 exact exposure 后出现可信回归，可精确 `evolution_rollback` 一次；否则最多提出一条仍需 owner 审批的 `evolution_propose`；
- 每轮最多 8 次工具调用、120 秒和 1024 个输出 token；
- Policy budget 使用 `automation-runs`，每天最多 7 次、每次固定计 1；1024 是输出上限，不是不具备可验证性的总 token 预算；
- pending Evolution proposal 的审批卡只允许固定 Evolution 后台主体投递到这个 exact owner binding；自由文本 guidance、外部动作和其他高影响变更仍只能经 owner approval apply，确定性低风险回滚不需要逐次审批；
- scratch 禁止 decide/apply、修改代码、凭据、Policy 或已有 automation；没有候选时必须精确输出 `HEARTBEAT_OK`；
- overlay 不授予 shell、文件系统、网络或凭据权限。

`supervised` 安装场景会把 `assistant-evaluation`、`preference-learning`、`assistant-evolution` 和 `assistant-heartbeat` 作为必需顶层 bundle 一同安装；`assistant-health` 当前只读检测且不参与激活或自动修复，因此保持显式可选。
TraeX 也不是激活器依赖，不会由该场景默认安装；确实把 Delivery 默认 route 配成 TraeX 时，应在安装器中显式使用 `--with traex`。

## 升级与 legacy binding

升级前已有的 conversation binding 会继续固定旧 preset/workspace；旧安装常见 preset 为 `primary`。新 binding 使用 Delivery 当前默认身份。

执行 `dsh-lark-setup --profile web --refresh-agent-policy --allow-agent-tools` 时，setup 会按完整 preset + workspace 保留精确 legacy 规则，并把主规则更新到当前默认身份。refresh 会清除所有历史 account id 的 setup-managed external reply/capability/tool 规则，只为当前 account 的 canonical owner principal 重建。

Delivery 外部规则的 principal、preset 和 workspace 始终精确；capability 的 action/resource 使用 `*`，以覆盖该身份已挂载的动态工具和插件内部 Policy 动作。外部工具规则仍以工具 id `*` 配合可选显式 deny。本地 `foreground` 规则则有意对 preset/workspace 使用 `*`，支持 Web/direct 中的用户切换。
