# @dsh-enhanced/plugin-control-plane

记录能力缺口与 ROI、匹配 owner 固定的 catalog，并在权威审批后执行可恢复的隔离激活。Agent 只能发现候选、记录缺口和创建计划；签名审批、profile 变更和 Host attestation CLI 都不会注册成模型工具。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/plugin-control-plane
dsh --profile web --dump-config
```

插件服务读取配置中的 `catalogPath`、`statePath` 和 `trustPath`。owner CLI 固定从 `$DSH_HOME/plugin-control/trust.json` 读取信任配置；`--trust`、`--state`、`--dsh-home`、公钥、authority、key id、attestor path 等命令参数都会被拒绝。trust 文件必须是 canonical、owner-owned `0600` 普通文件，其目录必须是 owner-owned `0700`，不能经过符号链接。

基础 Host attestation 部署可使用 trust schema v2；启用 source release lane 时使用 schema v4，并额外配置 owner release-authorization 公钥、owner catalog/registry 以及八个 release adapter。每个 adapter 都固定 canonical executable/interpreter path、SHA-256、receipt authority/key、超时和唯一的 phase-specific config 环境变量，例如 DSH_RELEASE_PR_CONFIG。下面保留 Host 配置示例：

```json
{
  "schemaVersion": 2,
  "installationId": "018f4f6e-7b21-7cc8-9235-8b1c4e6d9f00",
  "dshHome": "/srv/dsh",
  "ledger": {
    "id": "018f4f6e-7b21-7cc8-9235-8b1c4e6d9f01",
    "path": "/srv/dsh/plugin-control/plans/control.sqlite"
  },
  "executor": {
    "id": "dsh",
    "version": "0.1.2-rc.1",
    "path": "/usr/local/bin/dsh",
    "sha256": "64-hex",
    "environmentAllowlist": ["PATH"]
  },
  "hostPolicy": {
    "readinessMinimumChecks": 2,
    "effectBlockedMinimumDeliveryAttempts": 2,
    "effectBlockedMinimumToolExecutionAttempts": 2,
    "shadowMinimumSamples": 20,
    "shadowMaximumMismatches": 0,
    "canaryMinimumSamples": 5,
    "canaryMaximumFailures": 0,
    "soakMinimumWindowMs": 300000,
    "soakMinimumSamples": 50,
    "soakMaximumFailureRate": 0.01,
    "healthMinimumChecks": 3,
    "healthMaximumFailures": 0,
    "receiptTtlMs": 30000
  },
  "hostAttestor": {
    "id": "production-host-attestor",
    "version": "1.0.0",
    "path": "/usr/local/libexec/dsh-host-attestor",
    "sha256": "64-hex",
    "interpreter": null,
    "environmentAllowlist": [],
    "authority": "host-runtime",
    "keyId": "host-key-1",
    "timeoutMs": 60000
  },
  "approvalKeys": [
    { "authority": "owner-policy", "keyId": "owner-key-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----..." }
  ],
  "hostAttestationKeys": [
    { "authority": "host-runtime", "keyId": "host-key-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----..." }
  ]
}
```

`hostAttestor` 可以为 `null`。这种部署只能走人工 attestation，不会自签或自动越过任何 `awaiting-*` 状态。旧 trust schema v1 仍可读取，但被规范化成保守的默认 `hostPolicy` 且不配置可执行 attestor，因此也是 manual-only。

Control Plane 只保存 Ed25519 公钥，不读取、接收、生成或持有 Host attestation / release 私钥。

## 能力闭环

Agent 工具：

- `plugin_capability_gap`：用幂等键记录能力缺口、上下文、价值、频率、成本和风险。
- `plugin_gap_rankings`：读取按 ROI 排序的开放缺口。
- `plugin_discover`：只读匹配 owner-provided、完整性固定的 catalog。
- `plugin_activation_plan`：为一个精确 gap/candidate/profile 创建不可变、待审批计划，不安装任何内容。

计划、审批、phase operation、签名 receipt 和终态 receipt 都写入 owner-private SQLite。幂等键、revision CAS、activation id 和递增 fence 共同阻止旧 worker、ABA 和跨计划重放。

## 审批和 staging

审批系统针对 `show` 返回的精确 plan id/digest 生成 Ed25519 receipt，然后由 owner 应用：

```sh
dsh-plugin-control show --plan-id plugin-...
dsh-plugin-control approve --kind activation \
  --plan-id plugin-... --expected-revision 1 \
  --approval-receipt ./owner-receipt.json
dsh-plugin-control activate \
  --plan-id plugin-... --expected-revision 2
```

`activate` 只完成 staging：固定 DSH executable 的 canonical path、owner/root ownership、不可被 group/other 写入、inode 和 SHA-256；用无 shell 的 argv 安装 dossier 中精确 `package@version`；结构化核对 lockfile integrity；保留原 profile backup；最后停在 `awaiting-reload`。

### 从 npm 下载已批准制品

trust schema v3/v4 的 `releaseRegistry` 可以显式选择 npm 读取协议：

```json
{
  "id": "npm-public",
  "locator": "https://registry.npmjs.org",
  "protocol": "npm",
  "tokenEnvironment": null
}
```

catalog 中的 registry id/locator 必须与 owner trust 相同，并预先固定精确包版本及 SHA-512 integrity。CLI 读取 npm 的 `/{encoded-package}/{version}` 元数据，核对 name/version 与该 integrity，再从元数据的 `dist.tarball` 独立下载和计算摘要。元数据不能更换已批准摘要；不使用 tag、版本范围或 SHA-1 回退。校验后的字节进入既有 `0400` 缓存和打开的文件描述符，再由固定 DSH executor 安装并核对 lockfile。成功仍停在 `awaiting-reload`，后续使用原有 Host attestation、有限试用和观察流程。

下载只允许同一 HTTPS origin 且位于 locator 路径下的地址；重定向、跨域/CDN、查询参数、URL 凭据和路径混淆均拒绝。整个元数据与 tarball 下载共用 120 秒期限，元数据最多 2 MiB，tarball 最多 256 MiB。可选 `caPins` 配置可信 CA；省略时使用系统 TLS 信任。私有 registry 可绑定 `tokenEnvironment`，token 仅从 owner 进程该变量读取，不读取 `.npmrc`，不传给 DSH executor。需要其他 origin 的 registry 尚不支持此模式。

省略 `protocol` 或设为 `dsh` 保持原有 `/packages/<分段编码包名>/<version>/package.tgz` 布局；省略字段也保持旧 trust 的规范化摘要不变。协议不会自动探测或失败降级。

本能力支持现有 catalog 的 npm 制品下载，不签发 source-release receipt、不发布包，也不验证 npm/Sigstore provenance。后续远端 release adapter 必须分别绑定 owner 签名证据与 npm 实际观测，不能把本地预期签名冒充 registry 返回的签名。可复现的只读验证见 [npm readback](../../docs/npm-registry-readback.md)。

## 固定 Host attestor 执行契约

配置 `hostAttestor` 后，每个 awaited phase 由 owner CLI 单步推进。可执行 attestor 与已固定摘要的解释器会以 `O_NOFOLLOW` 打开，贯穿版本探测和实际 attestation 保持相同文件描述符，并通过 Linux `/proc/self/fd` 启动；结束后复核 inode 与摘要。缺少 Linux/procfs 时拒绝执行，不回退到可被替换的 pathname，其他平台可使用人工 attestation。描述符固定防止路径替换选中另一 inode，不能隔离同 UID 进程对文件内容或信任配置的修改，生产信任根仍需独立 owner/broker 权限边界。

执行步骤：

```sh
dsh-plugin-control probe \
  --plan-id plugin-... --expected-revision 4 --expected-fence 1
```

phase 不能从命令行指定，而是从 durable plan 状态推导。Control Plane 先提交唯一的 phase operation，再执行固定 executable：

1. 校验 canonical path、权限、owner/root ownership、单链接、inode 和 SHA-256。脚本还必须使用无参数的 canonical shebang，并在 trust 中固定 interpreter path/digest；native executable 的 `interpreter` 必须为 `null`。
2. 以严格 allowlist 环境、`shell: false` 调用 `--version`，结果必须等于 trust 中固定版本。
3. 以同样边界调用 `attest`，在 stdin 传入一个精确 JSON request；stdout 只能返回一个有界 JSON receipt，stderr 不回显。
4. 再次校验 executable inode 和 digest。
5. 使用 trust 中预注册的 Ed25519 公钥验证 receipt，并以 plan revision/fence CAS 应用。

request 固定：installation id、ledger id/path、plan id/digest、activation id/fence、profile name/path、attestor identity/path/digest/key、phase、phase requirements、receipt TTL，以及一个 durable operation id。外部 attestor 必须永久把 operation id 当幂等键：相同 id + 相同 request 重放同一 receipt；相同 id + 不同 request 必须拒绝。

phase operation 在子进程启动前持久化。子进程执行期间持有 SQLite 跨进程 writer mutex；成功 receipt 在释放 mutex 前持久化。因此并发 worker 不会创建第二个 canary exposure。若进程在 receipt 提交前崩溃，恢复 worker 使用相同 operation id 重试，依赖上述外部幂等契约取回同一结果。

## Phase proof，而不是命令标签

退出码、命令名称和 `--dump-config` 都不构成 phase 成功证据。v2 receipt 对完整的结构化 evidence 签名，并绑定 request digest：

- `reload`：前一代和新一代 Host generation、新 profile 的 reload 证明。
- `readiness`：实际检查数和失败数。
- `effect-blocked-replay`：delivery 尝试/拦截数、tool-execution 尝试/拦截数以及外部 effect 数；通过必须同时证明两类 effect 全部被拦截且 external effects 为零。
- `shadow`：样本数、mismatch 数和 external effects。
- `canary`：唯一 exposure id、严格一次 exposure、样本数和失败数。
- `soak`：明确的窗口起止、样本、失败数和 owner policy 的失败率阈值。
- `health`：实际健康检查数和失败数。

每类 evidence 还带有探针/回放/trace digest。Control Plane 验证签名、结构、请求绑定、TTL 和 policy 阈值；它不会假装自己能独立观察部署。真正的 reload、流量、effect interception 和健康观测由 owner/deployment-controlled attestor 实现，并由其私钥为声明负责。测试目录中的 fixture attestor 只用于真实子进程集成测试，不进入发布包，也不是生产探针。

任一有效签名 receipt 返回 `outcome: failed` 时，计划进入 fenced `rollback-pending` 并自动恢复原 profile；只有七个 phase 全部通过，backup 清理和终态 CAS 完成后才是 `activated`。格式错误、错误 key/digest/phase/evidence、过期 receipt 或未配置 attestor 都保持当前 awaiting 状态。

## 人工 Host attestation

未配置可执行 attestor，或部署需要人工控制时，先生成同一个 durable request：

```sh
dsh-plugin-control host-request \
  --plan-id plugin-... --expected-revision 4 --expected-fence 1 \
  > host-request.json
```

owner-controlled 外部系统执行 request、产生相同 v2 structured evidence 并签名。receipt 文件必须是私有普通文件，然后应用：

```sh
dsh-plugin-control attest \
  --plan-id plugin-... --expected-revision 4 --expected-fence 1 \
  --receipt ./host-receipt.json
```

人工路径使用相同 operation、evidence validator、Ed25519 verifier 和 CAS，不是弱化旁路。旧的 schema-v1 `evidenceDigest`-only Host receipt 会被拒绝，因为它不能证明 phase 语义。

## 源码能力 lane 和边界

`source-plan` / `scaffold` 只在 owner 审批的 linked、clean worktree 和固定 generator digest 上生成插件并运行 `pnpm check`。local checks 使用临时 Git index 对 exact scope 计算 staged tree/patch digest，不污染工作树的真实 index。owner 必须在 checks 之后为 exact source digests、scope 和 release policy 签发独立 authorization，随后才能执行 `release-start`。

`prepareModifySourcePlan` 是另一条待审批修改路径：它只接受现有非保护插件树内的有界文件集，并用临时 Git index 生成精确 tree 后以 `git archive` stdin 传入 owner 配置的 Docker image。容器没有 Host bind mount、网络、特权或调用者环境，使用只读根、非 root UID、`cap-drop=ALL`、`no-new-privileges`、固定 CPU/内存/PID/tmpfs 限制和离线 `pnpm install --ignore-scripts`、`pnpm check`、`pnpm pack`。镜像必须由 registry manifest digest 或本地 image content ID 固定，并预热离线 pnpm store。控制面在持久化前重算 tree/patch digest；任意漂移、取消、超时或容器失败都会删除 worktree 而不创建计划。`.git`、`.gitattributes` 与 `.gitmodules` 不能通过该路径修改。

`inspectSource` 只从当前 `HEAD` 的 Git objects 读取非保护插件的已跟踪普通文本文件；它不读取工作树。调用者可先请求空 `paths` 获得有界 manifest，再将返回的 `baseCommit` 用作读取和 `prepareModifySourcePlan.expectedBaseCommit` 的精确绑定。HEAD 已移动、二进制/生成/隐藏路径、symlink、submodule 或越界路径都会被拒绝。清单最多 1024 条，内容最多 64 个文件、单文件 64 KiB、合计 256 KiB；返回真实 blob 大小并支持普通可执行文本文件。整个读取请求从服务入口起受 15 秒截止时间控制；取消会终止正在运行的 Git 子进程，异步权限检查的迟到结果不再生效，Fiber 卸载等待请求收尾。

Host patch config 在启用修改准备前必须提供 `sourceBuild`，例如：

```yaml
sourceBuild:
  dockerPath: /usr/bin/docker
  image: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  timeoutMs: 180000
  memoryMiB: 512
  cpus: 1
  pidsLimit: 64
  workspaceMiB: 512
  outputBytes: 65536
```

`sourceBuild.profile` defaults to `standard`, whose existing maximum build timeout is 4 minutes and whose `/tmp` tmpfs is fixed at 32 MiB. An owner may explicitly set `profile: repository` for a full repository `pnpm check`; only that profile permits a timeout up to 30 minutes, memory up to 16 GiB, 16 CPUs, 1024 PIDs, an 8 GiB workspace tmpfs and a 4 GiB `/tmp` tmpfs (default 2 GiB). The repository profile explicitly permits execution from both bounded tmpfs mounts, needed by native build tools and temporary executable test fixtures; the standard profile retains Docker’s default no-exec mounts. The repository profile also fixes `CI=true` and `VITEST_MAX_WORKERS=1` inside the container. The caller cannot select a profile or increase these limits: its timeout is capped by the owner configuration. Cancellation, deadline expiry, output overflow, or Fiber disposal kills the preparation client, waits for archive/build processes, and proves named-container absence before any pending plan is stored. Interrupted builds are never automatically replayed; the optional durable Host lane below records their status and resource identity.

`repositorySandbox: { seccompPath: /absolute/owner/path/source-builder-seccomp.json }` is a separate repository-only opt-in for the existing nested Bubblewrap integration tests. It requires the approved profile digest and Docker Server `29.4.1/linux/amd64`; other bytes or runtimes fail before candidate execution. It permits additional namespace/mount syscalls, removes Docker's masked/read-only system-path lists, and hides `/sys` behind an empty read-only tmpfs. This expands the outer container's `/proc` visibility and kernel surface; it is not equivalent to Docker's default policy. UID 65534, zero capabilities, no-new-privileges, offline execution, read-only root, and no Host bind mounts remain mandatory. See the [profile provenance and limits](../../scripts/isolation/README.md#nested-sandbox-profile). Omitting this option retains Docker's default system-path restrictions, including in repository mode.

`dockerPath` 必须是 canonical、owner/root-owned 且不可被 group/world 写的可执行文件。镜像要包含 UID 65534 可执行的 Node、pnpm 和可用的离线 store；pnpm 的 cache 必须定位到可写 tmpfs；离线 store 由镜像中的只读种子复制到 workspace tmpfs，供 pnpm 11 写入其 SQLite 索引；未配置时 `canPrepareSource()` 返回 false，修改准备请求 fail closed。

完整仓库镜像的 owner 构建脚本见 [source builder](../../scripts/isolation/README.md)。它只传入依赖清单和 lockfile，在联网构建阶段预取依赖；候选源码进入容器时仍禁网、无 Host 挂载。`repository` profile 仅扩大 owner 配置的检查预算，不延长 Growth Driver 的 5 分钟授权。长检查可通过下述持久 Host 任务提交；入队不代表检查通过或源码已改进。

### 持久源码检查任务（可选）

Growth Driver 设置 `pluginSourceProposals.preparationMode: durable` 后，`plugin_source_prepare` 只提交任务，`plugin_source_job_status` 回读当前 owner 的状态。控制面还必须配置独立于模型回合的有限 Host 授权：

```yaml
sourceJobs:
  authorityId: repo-source-checks-2026-09
  expiresAt: 1790000000000 # 示例：替换为 owner 批准的绝对 Unix 毫秒期限
  maxSubmissions: 3
  repository: /absolute/canonical/repository
  ownerRouteId: configured-delivery-owner-route
  principalId: configured-principal
  workspace: /absolute/owner/workspace
  preset: primary
  budgetId: source-check-runs
  budgetAmount: 1
```

还需安装兼容的 `assistant-delivery` 和 `assistant-automations` Host peers；后者显式开启现有 scheduler，Policy 允许该 scope 下的 `plugin-control-plane-source` reconcile 及对应后台任务 execute，并配置 `source-check-runs` 的 `automation-runs` 预算。此预算计执行次数，不代表模型 token/费用预算。缺少 peer 或授权时不执行。`sourceBuild` 决定镜像和检查上限，模型不能改写队列权限、owner、路径或构建限制。

任务先冻结完整 Delivery v2 回执、trust 摘要、gap revision/digest、read base、文件内容及构建配置，再以 **paused → 绑定规范化 definition hash → active** 注册到 Automations 的一次性 Host executor。源码只存控制面私有 SQLite；Automation definition 和模型状态投影不包含文件内容。相同 authority 的期限、配置和累计提交上限不可重置；同 key 不同内容拒绝。全账本同时最多一个 `queued/running/unknown` 任务。

模型回合结束不会取消已接受的 Host 任务。Host 自己受授权绝对期限、构建时限、Automations lease、取消和 Cordis provider 生命周期约束。成功时，job `prepared`、gap claim 和已有 `pending-approval` plan 在同一 SQLite 事务提交。原模型授权仍最多 300 秒；不新增模型循环或调度器。

重启重接尚未 claim 的任务；已 claim 的任务转为 `unknown`，保留资源槽且不自动重跑。状态回读、入队和启动时核对 Automations 的精确生产终态，将预算/Policy 等在 executor 前发生的终结写回 `failed`。Host-only `reconcileSourceJob({id, owner})` 可对 `unknown` 进行资源核对：按容器标签、镜像、ID 删除并证明不存在，验证 worktree 的 Git 注册、base 和仓库归属后删除。归属不明、daemon 不可达或残留路径未注册时保留 `unknown`，需要 operator 检查；同一 route/principal record/version/workspace/preset 的新会话绑定仍可查看和清理旧任务；执行继续要求原完整回执精确匹配。该方法不暴露给模型，也不重跑候选。每个 statePath 使用单一控制面 Host 实例。

这些能力只准备待审批提案。工程层 native scheduler/Policy/SQLite 集成测试不等于真实模型执行整仓修复或生产发布验收。

成功准备返回 `pending-approval`，不会自动发布。owner 按已有签名审批流程处理后，用 `dsh-plugin-control source verify-prepared --plan-id <id> --expected-revision <revision>` 重读同一 worktree 并核对 digest，才能进入人工 review/release。修改 worktree 会使复核失败；旧 `create` 计划仍走 `scaffold`。`dsh-plugin-control source gc` 将已过 TTL、仍 pending/approved 的计划以版本 CAS 转为 `expired`，释放该计划的 gap 占用，再清理控制面登记的 modify worktree；已经 `expired` 的计划可重试物理清理，已经进入 review/release 的 worktree 保留。

单个 Service 最多准备一条提案。Cordis 卸载先取消并等待所有准备步骤和容器/worktree 清理，再关闭 SQLite。数据库 schema 14 保留旧 create 摘要和 release 外键；modify 的审批摘要另外绑定 mode、检查结果及构建证据。构建证据证明配置镜像中的检查过程，不证明候选业务质量或独立隐藏评测通过；正式 release 仍需要原有审批、独立 review、构建和签名。

owner 可以用 `release-request` 导出当前 durable phase request、用 `release-step` 调用已固定 adapter 并应用 receipt，或用 `release-attest` 应用 owner-controlled 外部系统生成的同协议 receipt。phase 不能由调用者选择，而由 durable source plan 状态决定。publish 超时等不确定结果必须先进入 `publish-ambiguous`，再由独立 registry verifier 的签名 reconciliation receipt 决定继续验证、以新 fence 重试，或 fail closed。

`bin/dsh-npm-registry-adapter.js` 的独立 verifier 部署提供匿名 npm `registry-verify` / `reconcile`，沿用上述命令与状态机。它在 Linux Host 的固定 adapter/Node 进程中，从已校验字节加载固定下载 helper，读取 owner 私有配置、验签公钥和独立 verifier 私钥，写入私有操作记录；该角色网络权限仅为配置的 HTTPS origin/path 下的 GET，不读取 `.npmrc` 或环境凭据。配置格式、文件权限、预算与退出清理见 [npm verifier 指南](../../docs/npm-release-verifier.md)。npm 对账使用 v2 签名回执，分别记录 owner 预期和实际 metadata/tarball 观测；404 或不完整读取保持 `unknown`，不会据此自动重发发布。旧 v1 回执继续使用原有语义。

同一 npm adapter 可部署为独立 `publish` 角色：固定自己的 executable、receipt key、私有 state/config 与 `lib/npm-publish.js` helper，通过 `DSH_RELEASE_PUBLISH_CONFIG` 指定 owner token 文件和 tag。它重验继承 FD 中的已签 tarball，构造 npm metadata/attachment，再发送一次有界 HTTPS PUT；不执行 npm CLI 或 lifecycle scripts，也不注册模型工具。发送前持久化 dispatch marker；响应丢失、进程取消或重启后，同一操作只返回原 receipt 或发布歧义，不重复上传，由独立 verifier 对账。该角色新增的凭据读取、网络写入、配置与预算见 [npm publish 指南](../../docs/npm-publish-adapter.md)。本地 TLS 验证不代表已完成真实 npm 发布或生产 Host 启用。

随包发布的 `bin/dsh-local-release-adapter.js` 是 local-only 的通用参考 adapter；trust 中每个 phase 必须安装为不同 canonical 文件/inode，并使用不同 adapter id、authority 与 receipt key；脚本副本可以共享同一个固定、只读的 Node interpreter。各副本的 owner-private config 还应给出不同 state directory。它实现：

- local bare Git remote 上的 immutable PR ref、由 owner-private exact review decision 驱动的独立 review receipt，以及 target-ref compare-and-swap merge；
- 从 exact merge commit 做至少两次独立 checkout，并分别复制为新的可写 sandbox workspace；owner 配置固定 Linux bubblewrap、Node、pnpm runtime tree、离线 store 与 tar executable 的 canonical path/摘要。sandbox 使用空 HOME/tmp、无网络的新 user/mount/PID namespace，固定执行 `pnpm install --offline --frozen-lockfile --ignore-scripts --package-import-method=copy`、目标包 `build` 与 `pnpm pack`，最终 artifact 直接采用 package manager pack lifecycle/packlist 生成的 tarball，再生成 CycloneDX SBOM 和 SLSA provenance；
- 独立 signer 对 exact artifact statement 签名；
- local filesystem registry 的 package/version immutable publication；
- 在独立 download root 复制并重新验证 registry bytes；
- 复用 Control Plane catalog helper 执行 request-bound before/after digest CAS admission。

catalog-admission 可显式配置 `registry.protocol: "npm"`，接收独立 npm verifier 的 v1 签名回执并准入其精确 HTTPS tarball 地址。该分支仍只写 owner 本地 catalog，不联网；以继承 FD 重验已签 artifact，固定 `catalog.js` 和 `catalog-interpreter.js` 两份模块字节，在 adapter 进程内调用既有 CAS helper。catalog、verifier、signer 和 owner 使用独立权限配置；catalog receipt key 必须与其他三个角色不同。随后正式 activation 再次下载时，地址和完整性摘要都必须与已批准 catalog 一致。旧 `package@version` 逻辑引用保持兼容。配置与边界见 [npm catalog 指南](../../docs/npm-catalog-admission.md)。

adapter 的 stdout 只有一个签名 JSON receipt，stderr 不打印 request 或 secret；它还会用 config 中固定的 release-authorization 公钥重新验签。每个 phase 在 owner-private state directory 永久绑定 operationId + requestDigest：完全相同请求重放同一 receipt，同 id 不同 payload 拒绝。`registry-verify` 副本还实现 `reconcile`，同时核对 immutable tarball 和 publication record，并用自己的独立 key 签发 `exists-match` / `absent` / `unknown` / `digest-conflict` evidence。该参考实现不访问网络，也不等同于 GitHub/npm adapter；需要远端 PR/registry 的部署应提供遵循相同 request/receipt 与幂等协议的 owner adapter。

## 权限

- 插件 Host service：读取 catalog/trust，写 owner-private SQLite/WAL；不使用网络、浏览器或子进程。
- owner CLI `activate`：读取/复制/rename/恢复 DSH profile，并执行固定 DSH executable。
- owner CLI `probe`：执行固定 Host attestor，只有严格 allowlist 环境；不读取 attestation 私钥，不使用 shell或网络客户端。
- owner CLI `scaffold`：仅在审批绑定的 linked worktree 中运行固定边界内的 `git` / `pnpm`。
- owner CLI release 命令：读取 owner-private release authorization 或人工签名 receipt，写 release operation SQLite 状态，并只执行 trust 中固定的 adapter executable；publish reconciliation 只接受独立 registry verifier 的签名 receipt，不接受裸 observation。
- local release adapter：读取一个 allowlisted、按 phase 命名的配置路径（例如 DSH_RELEASE_PR_CONFIG；连字符转换为下划线）；该配置及其目录、每个 phase 的 Ed25519 私钥、release-authorization 公钥和 state directory 必须 owner-owned private。按 phase 可执行 owner 固定 SHA-256 的 local Git、Node、pnpm、tar 和 bubblewrap executable，读 approved repository/worktree 与继承的只读 artifact/SBOM/provenance fd，写 local bare Git remote、review store、isolated build root、immutable file registry、独立 download root 和 owner catalog。它不内置 key、token、credential、remote URL 或任意 shell command，也不使用 shell、浏览器或网络；依赖安装禁用 lifecycle scripts，只有 owner 固定的目标包 build/pack lifecycle 会执行。
- build adapter 不接受调用方或通用 config 注入任意命令/argv；它只运行固定的 offline frozen install、package build 与 `pnpm pack` 流程。pnpm runtime tree 必须在根目录提供 config 分别固定的 `node` 与 `pnpm` 原生 executable；整棵 runtime tree 和离线 store 再以 canonical owner/root-owned、非 group/world-writable 的递归 inventory digest 固定并只读挂载，因此不依赖宿主 `PATH` 中是否存在 Node。每轮只给 disposable workspace 与 pack output 写权限。私钥路径与 config path 不出现在 durable request。生产部署应为 PR/review、review/merge、build/sign、sign/publish 和 publish/registry-verify 配置独立 executable identity、进程状态目录及 signing authority/key。
- Linux local adapter 对 Git、tar、bubblewrap 及 catalog helper/interpreter 保持 `O_NOFOLLOW` 已验证 descriptor，并通过 `/proc/self/fd` 执行；bubblewrap 的 toolchain/store/workspace/output 也从已打开目录 descriptor 挂载。缺少 Linux `/proc/self/fd` 时 fail closed。catalog helper 在独立 pinned Node 子进程中运行，不会把 mutable helper pathname 动态 import 到签名进程。
- catalog admission 使用同一文件系统的 `O_TMPFILE`、固定系统入口 `/usr/bin/python3` 安全解析出的 Python 3.8+ canonical target，以及跨目录 `renameat2(RENAME_EXCHANGE)` 提交和可验证反向交换。它不查询 `PATH`：入口、canonical target 及目录链必须 root-owned 且不可被 group/other 写，target 以 `O_NOFOLLOW` 打开并通过保留 descriptor 执行，执行前后复验 inode、时间戳与 SHA-256。父目录 descriptor 上的内核 `flock` 覆盖整个事务且随进程崩溃释放；每次 exchange 的确定性私有目录、before/desired/stage inode 与摘要先写入并 fsync 到 request-bound v2 journal。broker 不执行 pathname cleanup，无法归类的文件原样保留供人工 reconcile。缺少 Linux procfs、`O_TMPFILE`、`renameat2`、`flock` 或安全兼容的 interpreter 时 fail closed。Unix 文件 mode 不能隔离持续恶意的同 UID 进程；生产部署必须使用独立 UID 的 commit broker，或确保 worker 对 catalog 父目录无写权限。
- local artifact activation 在安装期间持续持有已验证 cache inode，并把 `/proc/<control-plane-pid>/fd/<n>` reference 交给 DSH；registered DSH executor 及其解释器也从已验证 descriptor 启动。该路径是 Linux-only，且不会把 `release-complete` 视为 activation。

兼容性见仓库 [compatibility baseline](../../docs/compatibility.md)。Node.js 要求 `^22.19.0 || >=24.0.0`（使用 `node:sqlite`）。
