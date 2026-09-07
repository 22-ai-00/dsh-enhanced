# @dsh-enhanced/assistant-web-owner

将现有 DSH Web 聊天接到一个已配对的 Delivery owner，让原生用户文本回合能够使用 `assistant-goals` 等依赖可信人类回合的能力。沿用原生 `SessionController`、Typert、Goal UI 和 AgentLoop。

## 安装与配置

兼容 DSH `0.1.2-rc.1`。这是可选实验性 bundle，尚未正式发布。本地源码安装可使用现有安装器的显式 Web 场景；默认 `core` 不会自动启用它：

```sh
./scripts/install/install-local.sh --scenario web --workspace /absolute/workspace --yes --no-service
```

该入口安装 core、Delivery、Goals 和 Web owner；先通过本地 `dsh-web-owner-setup` 初始化 owner 与完整 profile 配置，再探测真实 Host 激活。它复用有效 Delivery 数据库路径，固定 principal 为 `web/<profile>/local/operator`。不配置飞书或常驻服务，不会自行更改全局模型/权限选择；模型设置和验证仍沿现有安装器选项。完整目标执行、独立验收和隔离配置并未因此自动完成。

单独使用 CLI 时先安装这些 bundle，停止目标 Host，再运行 `dsh-web-owner-setup --profile web --workspace /absolute/workspace`。它保留 YAML 标签、自定义配置和 Policy 规则；重复运行保留 owner ID/version、已有绑定和任务。修改过的受管规则或不同 owner/scope 会拒绝覆盖。新增精确 owner 的外部 ingest/capability 规则只提供能力可达性，现有 deny、原生 sandbox 和审批约束仍生效。

Web principal 必须是 `channel: web`，其 account、tenant、user 由可信本地安装者固定。安装器使用 `ensurePrincipalLocally()`：只在空库初始化，或原样保留完全匹配的 active owner，不替换其他 owner、不复活已撤权身份。已有 Lark 或不同 owner 使用同一数据库时会拒绝，可为独立部署选择另一个 `DSH_HOME`。高级离线交接 API `pairPrincipalLocally()` 仍保留其原本的显式交接语义；本安装器不调用它。当前不支持跨渠道 owner 别名或多用户 Web 身份映射。

本 bundle patch 先禁用上游 `session-controller` 行，再插入 `dsh-enhanced-assistant-web-owner`。在该 bundle 后追加完整配置 patch：

```yaml
- id: dsh-enhanced-assistant-web-owner
  name: '@dsh-enhanced/assistant-web-owner'
  config:
    principal: { account: local, tenant: local, user: operator }
    workspace: /absolute/workspace
    preset: standard
    maxExecutionMs: 300000
```

安装后用 `dsh --profile <测试配置> --dump-config` 检查：只有本 bundle 的 Controller 激活，owner 和作用域与本地配对一致。卸载 bundle 会移除本层禁用 patch，恢复原 Controller；Delivery 的持久 Session 归属保护仍生效。

`workspace` 必须是绝对路径，`preset` 必须与实际原生 preset 一致。`maxExecutionMs` 为每次 Agent 激活的最大时间，范围 1–300000 毫秒，默认 300000。原生 factory 的冷加载也使用这一取消期限。空闲 Agent 清理后释放 Session 给 Delivery/Automations；未证明完成清理的执行保持 unknown。

原生 Goal 仍为 `active` 且 `armed` 时，即使 Agent 暂时 idle，也会保留它和原 Session lease，等待宿主 GoalRoundDriver 完成保存并续跑。目标终态或 disarm 后再释放；执行期限、撤权和卸载仍优先生效，不因新目标轮重置。缺少 GoalRoundDriver 时最多保持到原执行期限，此检查不另行调度任务。

Policy 至少需要显式允许该 `web/account/tenant/user` 的 `ingest`，以及该 principal、workspace、preset 下需要的 Agent `reply`、工具执行和 Goals/Memory 操作。配对不会自动放宽 Policy。

## 当前行为与限制

- 启动时在 owner 已证明后解析或注册配置 workspace；配置路径必须是实际路径（`realpath`），避免 Delivery scope key 漂移。原生界面使用该 workspaceId，Controller 保留工作区与会话关联；直接调用可省略位置或提供相同 cwd。其他 workspaceId、不同 cwd/preset 或外部 Session ID 均拒绝。同一请求不能同时提供 cwd 和 workspaceId。
- 文本先以确切 Inbox 原子领取，再通过原生 `source.kind=user`、requestId、内容和实际 inserted/claimed 消息对象建立一次性证明。只复制来源标签或重发相同文本不能获得第二次准入。
- Session 列表、搜索、历史、控制流、技能目录及 `api-session/*` 广播过滤非 owner 会话；原生 Goal RPC 的 Agent lookup 使用同一受限入口。
- 空闲释放只回收内存 Agent，保留已持久化的会话和界面选择；再次输入沿原生恢复路径执行。不会把原生 `session/disposed` 当作持久会话删除。
- 忙时拒绝新的输入，当前不支持输入图片、fork、子 Agent 历史地址或任意宿主路径打开。排队/steer 的完整交互、附件的一次性准入与长期跨日运行仍待完成。
- 中断的 native Inbox 不转成普通 Delivery 消息重放，包括尚未调用原生 prompt 的崩溃窗口。已有 Session/Goal/业务记录保留。

Web client 在构建时复用 DSH `0.1.2-rc.1` Session Controller 的浏览器 bundle，只将 ModuleLoader 注册 id 改为本包 id；不会重新实现 session RPC 或 UI 状态。构建脚本会验证上游版本、完整 `dsh.client` 元数据、MIT 许可证、单一注册 id 和无自引用 require，格式变化时失败。生成产物携带上游完整 MIT 文本于 `lib/THIRD_PARTY_LICENSES`，并保留 client 文件的版权 notice；该方案依赖当前 DSH UI bundles 不通过 ModuleLoader require 原 Controller client id。其他 UI manifest 的旧 inject 边在该版本只影响 graph 到达顺序，Cordis client service injection 仍等待本 clone 提供 `sessions`。

## 权限与数据

运行时不创建监听端口、凭证或浏览器认证，复用已有的已认证单 owner Web 控制面。离线 setup CLI 调用本机 `dsh --dump-config` 读取配置，不执行任意 YAML JS；写入目标 profile patch、Delivery owner 数据库和所选工作区目录，使用安装锁与原子文件替换。配对与 YAML 不能跨库原子提交，写文件失败可能留下尚未启用的首次身份；同身份重试不会轮换权限。CLI 不读取凭证存储、不发模型请求，也无安装生命周期脚本。

运行时通过宿主服务驱动 Agent 已有的文件、网络、子进程、凭证和浏览器能力，仍受 Policy 与原生审批约束。

Delivery 保存 Web owner/binding、Inbox 文本、内容摘要、尝试与租约；原生 Session 保存实际对话。返回的固定 capability 只给受信 Host 配置使用，并非对同进程插件或同 UID 进程的 OS 隔离边界。

单元与组合测试覆盖实际 AgentLoop、SessionController、Typert Gateway、双事件订阅、SQLite、业务 Goal 及空闲后恢复。另有独立浏览器命令 `CI=true pnpm test:web-owner`：全新临时 profile 安装、真实认证/HTTP/WS、原生审批、Goal 落库、Host 重启后新浏览器上下文恢复同一会话，详见仓库 `scripts/e2e/README.md`。模型仍为确定性 adapter；这些证据不证明真实模型收益、可信目标达成或长期自治。该命令需要本地 DSH 与 Chromium，不包含在普通 `pnpm check` 中。

可选的 `CI=true pnpm test:web-owner:real` 使用现有 Codex subscription 登录，验证真实模型生成程序、原生目标续跑、独立步骤/整体回执以及最终释放。它有精确工具范围和模型调用/时间上限，属于有引导的小任务实验，不证明长期自治、生产 token/费用硬预算或 OS 隔离；前置条件与证据边界见同一浏览器说明。

## 有限离线执行安装

仓库安装器 `--scenario autonomy` 调用本包 setup 的可选 `--isolation-image`、`--isolation-max-runs`、`--isolation-lease-ms`、`--isolation-runtime-ms`。普通 Web setup 不加载 Isolation；显式选择时需安装匹配版本的 Isolation、Actions 和 Keychain。

该路径先验证最终合并配置，再使用实际配置的 Docker executable 和生产 supervisor 做固定任务探测，成功后初始化本机 owner 并原子写入有限 grant。重复执行不延长 grant、不重置账本、不替换或复活 owner；冲突配置拒绝并要求明确迁移。支持每 profile 独立状态路径，保留合法自定义 literal 路径；不执行自定义 YAML JS 路径表达式。setup 在失败前可能创建工作区目录，owner 数据库与 patch 也不能跨库原子提交。

此选项额外使用本机 Docker、子进程和私有临时 staging；不拉取镜像或配置外部凭据。未知清理状态的探测目录保留以供排查。具体参数、前置条件和未完成的自治能力见[安装说明](../../scripts/install/README.md)。

发布文件同时包含 `dsh-autonomy-doctor --profile web`。此 CLI 读取有效 profile 和当前 Delivery owner、Isolation grant/累计预算快照，再运行独立的固定 Docker 探测，最后复核配置/授权没有失效；不会开启第二个 Host、配对 owner、迁移数据库、续期 grant 或重置预算。使用 SQLite 只读连接，不读取凭据/业务产物，也不请求模型。缺失或不支持的 schema、owner 版本改变、撤销、过期、耗尽和配置不一致都失败。当前支持 Delivery schema 19、Isolation schema 6 和安装器的单一受管 grant；要求匹配本批源码的 Isolation diagnostics API，缺失该 API 时明确要求升级，不回退到忽略持久授权的探测。新 bundle 尚未发布，正式发布时需保持实际首发版本与 peer 下界一致。

结果只说明有限隔离检查，不能替代动态 Policy、实时资源准入、模型硬预算、Goal 验收或外部 Actions 检查。该 CLI 的临时探测使用现有 Isolation 资源边界和清理规则；未知清理保留证据，不消耗业务 grant。
