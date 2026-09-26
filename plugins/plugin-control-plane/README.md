# @dsh-enhanced/plugin-control-plane

记录能力缺口与 ROI、匹配 owner 固定的 catalog，并在权威审批后执行可恢复的隔离激活。Agent 只能发现候选、记录缺口和创建计划；签名审批、profile 变更和 Host attestation CLI 都不会注册成模型工具。

可选 `runtimeObserver` 提供 owner-only、HMAC 认证的本地 Unix socket，读取实际 Loader/Fiber 与服务归属；socket、连接和密钥缓冲区由 Cordis 注入 Fiber 管理。该配置会读取私有认证 key 并创建本地 socket，不新增模型工具或签名权限；调用方与 Host 共享受信 owner 身份，不构成同 UID/同进程隔离。详见[配置、权限与证据](../../docs/runtime-observer.md)。

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

新 Host request 使用 schema 2，并固定 `predecessor: { operationId, receiptId, phase, receiptDigest, hostGeneration }`（reload 为 `null`）。每个正常后续阶段必须承接同一 activation/fence 中已应用、通过的前一阶段凭证；摘要覆盖完整签名 receipt。账本在调用外部程序前和应用结果时重新核对这条关联及 installation 最新代次。readiness、回放、shadow、canary、soak、health 不允许自行提高或降低 Host generation；换代只能通过 reload/rollback 的显式合同。失败凭证也不能绕过这些检查。该关联不替代独立运行时身份和副作用观测。

Host attestor 与 release adapter 的每次命令共用受控进程组：超时、输出超限及主进程正常/异常退出都会清理同组后代，核对主进程退出，并有界排空 stdout。清理无法证实时返回失败，不以遗留管道的 `close` 无限等待。该机制依赖 runner 存活，不能包含主动 `setsid()` 脱组进程，也不撤回远端已接受的操作；具体期限、恢复边界与回归证据见 [adapter 生命周期](../../docs/control-plane-adapter-lifetime.md)。

随包的 `bin/dsh-systemd-host-attestor.js`（v5）提供 Linux/systemd 的 **reload、readiness 与物理 rollback** 适配：先用 `probe --prepare-only` 取得确切持久请求，再由主人私有配置授权其摘要；重启前记录操作，重复调用仅重放或观测对账。它核验 fresh InvocationID/MainPID 与稳定窗口，按 installation 共享 Host 代次，reload 推进至 `awaiting-readiness`；readiness 再绑定最新已签重启、实际 Loader/Fiber 与服务实例，多次稳定观测后签名，重复请求不重启 Host。稳定、认证通过且身份匹配的 inactive 候选签为 failed readiness；认证错误或状态漂移不签发回执。rollback 在 CLI 恢复原 profile 文件后证明原 Host 就绪，或原本不存在的 profile 已停服；缺少物理恢复凭证时继续保持 pending。部署配置、权限和未覆盖阶段见 [systemd Host attestor](../../docs/systemd-host-attestor.md)。

phase operation 和派发 claim 在子进程启动前持久化。外部执行期间不持有控制面 SQLite 写锁，其他任务可继续写入；同一 operation 的并发或重启调用由持久 claim 拒绝。退出、验签失败或回执丢失后保留 unknown，不自动再次调用通用 attestor。取得原请求的精确签名回执后，用下述 `attest` 对账；未结算的派发也会阻止同计划换代回退，避免旧外部动作与恢复并行。

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

任一有效签名 receipt 返回 `outcome: failed` 时，计划进入 fenced `rollback-pending` 并自动恢复原 profile；一旦进入过 `awaiting-reload`，恢复文件后仍保持 pending，必须由绑定原始 baseline 的 `rollback` 签名回执证明旧 Host 就绪或原本不存在的 profile 已停服，才能结束回退。只有七个部署 phase 全部通过、保存已安装 profile 的核心文件摘要并完成终态 CAS 后才是 `activated`；上一版 backup 保留供使用后回退。格式错误、错误 key/digest/phase/evidence、过期 receipt 或未配置 attestor 都保持当前 awaiting 状态。

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

`attest` 也接受 configured attestor 已生成但未入账的精确回执，不再次执行外部程序。保存已验签事实本身不推进计划；owner 来源已撤回时仍可保存以解除 unknown、进入恢复，前向应用仍须通过当前 Host 来源校验。通用 CLI 不能替代 owner-task 的 live source fence。

## 使用后的退化与物理回退

`watch-observe --receipt <file>` 接受 Host 签名的精确版本观察；healthy 仅记账，regressed 会恢复上一版；同一运行中的 Host 可连续提交不同的签名观察，无需为每次观察重启。`watch-retract --receipt <file>` 接受 owner 签名的撤回并走同一恢复路径。两者输出保留 watch 操作回执，另外返回当前 `activation`。配置了 Host attestor 时，命令继续调用既有 `rollback` phase；只有签名回执证明旧 Host 恢复就绪（或原 profile 不存在时已停服），计划才成为 `rolled-back`。未配置签名器时保留 `rollback-pending`，可通过 `host-request`/`attest` 完成。

schema 17 在成功启用前保存 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 的摘要，恢复前同时核对当前版与保留的原版核心文件。核心文件漂移、较新的部署已生效、目标存在进行中的部署或旧计划缺少恢复检查点时，拒绝覆盖。摘要不是整个目录的不可变证明，也不替代进程、凭据与文件写权限隔离。回退按 rename 分步恢复；相同签名触发可在重启后继续，未知的 Host 外部操作仍须原有对账，不创建新 operation 绕过。

成功部署保留自己的上一版备份，并清理同一目标已被它取代的旧备份；新部署失败不会提前删除旧备份。最初的 `activated` 回执保留，后续回退另存终态记录。迁移不为历史部署捏造备份或摘要。此入口接收可信签名观察；普通用户任务的版本归因和自动观察签发仍需接线；已发布 owner 修复可通过下述有限采用配置接入。

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

可选 `sourceBuild.versioning: patch` 让 Host 在冻结检查树前，从基准 Git 提交生成当前插件的下一补丁版本，同时更新 `package.json` 与 `src/version.ts`。只支持稳定 `x.y.z`；模型不得提交这两个保留文件。生成的版本变化与源码一起接受离线检查、打包和摘要绑定，检查后再次核对文件及制品版本。持久作业冻结此配置，重启不会改用新的版本策略。

使用有限审批器时还须显式配置 `grant.versioning: "patch"`。审批器独立核对基准与候选，manifest 除版本外的名称、依赖、脚本等字段必须完全一致，运行时版本文件只允许规范常量；生成的两个文件计入文件数及字节预算。未启用该 grant 时仍拒绝 manifest 修改。变更已有不可变 grant 配置须使用新 grant id；变更持久作业授权须使用新的 `sourceJobs.authorityId`。

同一基准的多个候选会得到相同下一版本，不提供覆盖已发布版本的权限。后续采用流程须串行推进获准源码基准；现有 registry/catalog 冲突检查继续拒绝版本复用。此选项只准备可区分版本的候选，自动发布和采用需显式启用下述有限授权与执行配置，不会为每次修复发布公共 npm 包。

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

还需安装兼容的 `assistant-delivery` 和 `assistant-automations` Host peers；后者显式开启现有 scheduler，Policy 允许该 scope 下的 `plugin-control-plane-source` reconcile 及对应后台任务 execute，并配置 `source-check-runs` 的 `automation-runs` 预算。此预算计源码检查和后续恢复轮次，不代表模型 token/费用预算；希望所有作业共享额度时用 Policy 的 `global` 或 `workspace` scope，`subject` 按 automation 分开计费。缺少 peer 或授权时不执行。`sourceBuild` 决定镜像和检查上限，模型不能改写队列权限、owner、路径或构建限制。

任务先冻结完整 Delivery v2 回执、trust 摘要、gap revision/digest、read base、文件内容及构建配置，再以 **paused → 绑定规范化 definition hash → active** 注册到 Automations 的一次性 Host executor。源码只存控制面私有 SQLite；Automation definition 和模型状态投影不包含文件内容。相同 authority 的期限、配置和累计提交上限不可重置；同 key 不同内容拒绝。全账本同时最多一个 `queued/running/unknown` 任务。

模型回合结束不会取消已接受的 Host 任务。Host 自己受授权绝对期限、构建时限、Automations lease、取消和 Cordis provider 生命周期约束。成功时，job `prepared`、gap claim 和已有 `pending-approval` plan 在同一 SQLite 事务提交。原模型授权仍最多 300 秒；不新增模型循环或调度器。

配置审批、发布或采用后，临时失败的 `prepared` 作业由原生每分钟 cron 接续，无须重启 Host。独立 Host executor `plugin-control-plane-source-continuations-v1` 使用同一 system owner，持久 automation ID 为 `source-job-prepared-continuations`；如 Policy 采用精确 ID 规则，须覆盖它。每轮最多处理一个当前可推进作业，仍走生产 Policy/预算准入、原 owner/反馈/trust 校验和既有外部操作 claim。重启只注册恢复任务，不在启动时直接调用授权器；unknown 外部动作不重新派发。无可推进作业时暂停，新的已检查候选可重新激活。卸载暂停当前代次、取消并等待已有调用；旧代次不能暂停新实例。

每次恢复轮次消耗 `sourceJobs.budgetAmount`。Policy 预算按配置的时间窗口计算，窗口耗尽会拒绝执行；它不是终身重试次数上限。前向推进还受原授权与计划期限约束；已暴露版本的恢复义务可在旧来源失效后继续，但仍需预算和原部署权限。调用结果不明会留在原生执行记录中，不能算成功。独立模型审查仍使用原有冻结模型及预算；此接续不建立新的模型循环。

重启重接尚未 claim 的任务；已 claim 的任务转为 `unknown`，保留资源槽且不自动重跑。状态回读、入队和启动时核对 Automations 的精确生产终态，将预算/Policy 等在 executor 前发生的终结写回 `failed`。Host-only `reconcileSourceJob({id, owner})` 可对 `unknown` 进行资源核对：按容器标签、镜像、ID 删除并证明不存在，验证 worktree 的 Git 注册、base 和仓库归属后删除。归属不明、daemon 不可达或残留路径未注册时保留 `unknown`，需要 operator 检查；同一 route/principal record/version/workspace/preset 的新会话绑定仍可查看和清理旧任务；执行继续要求原完整回执精确匹配。该方法不暴露给模型，也不重跑候选。每个 statePath 使用单一控制面 Host 实例。

默认只准备待审批提案；配置下述有限审批后，真实 owner 失败来源的持久作业可继续审批。工程层 native scheduler/Policy/SQLite 集成测试不等于真实模型执行整仓修复或生产发布验收。

成功准备返回 `pending-approval`，不会自动发布。普通 gap 可用已有签名审批流程；owner 任务来源必须通过 Host 当前来源 fence 审批，离线 CLI 签名本身不能代替该校验。审批后，普通 gap 用 `dsh-plugin-control source verify-prepared --plan-id <id> --expected-revision <revision>` 重读同一 worktree 并核对 digest；owner 来源由下述 Host 发布接续入口完成复核，才能进入 review/release。修改 worktree 会使复核失败；旧 `create` 计划仍走 `scaffold`。`dsh-plugin-control source gc` 将已过 TTL、仍 pending/approved 的计划以版本 CAS 转为 `expired`，释放该计划的 gap 占用，再清理控制面登记的 modify worktree；已经 `expired` 的计划可重试物理清理，已经进入 review/release 的 worktree 保留。

### 普通任务修复的有限审批

可选 `sourceApprovals` 将持久 `sourceJobs` 的准备结果接到 owner 配置的有限签名器：

```yaml
sourceApprovals:
  executable:
    path: /opt/dsh/control-plane/bin/dsh-source-approval-authority.js
    sha256: <wrapper-sha256>
  interpreter:
    path: /opt/node/bin/node
    sha256: <node-sha256>
  configPath: /private/owner/source-approval.json
  timeoutMs: 10000
```

签名器配置示例（所有占位符须替换；配置、私钥、账本及其父目录由 owner 私有持有；仓库可为不可被其他用户写入的 0755 目录）：

```json
{
  "schemaVersion": 1,
  "authority": "owner-source",
  "keyId": "source-key",
  "keyPath": "/private/owner/source-key.pem",
  "statePath": "/private/owner/source-approval.sqlite",
  "controlDatabasePath": "/private/dsh/control/control.sqlite",
  "grant": {
    "id": "tool-repair-1",
    "expiresAt": 1800000000000,
    "maxApprovals": 5,
    "repository": "/work/dsh-enhanced",
    "worktreeRoot": "/private/dsh/control/source-worktrees",
    "owner": {
      "authorityId": "<delivery-route>",
      "authorityHash": "<route-sha256>",
      "principalId": "<owner>",
      "principalRecordId": "<principal-record>",
      "principalVersion": 1,
      "workspace": "/work/user",
      "agentPreset": "primary"
    },
    "plugins": ["personal-memory"],
    "maxChangedFiles": 4,
    "maxChangedBytes": 65536,
    "receiptTtlMs": 60000
  }
}
```

在 Control Plane trust 的 `approvalKeys` 登记对应 Ed25519 公钥；该 key 不用于 release authorization、发布或 Host attestation。owner 字段取实际 Delivery 回执，不由模型生成。grant id 的配置与 key 指纹不可变，额度和已签回执落入独立 SQLite；重启及同一请求重试不重置额度、不延长签名期限。

签名器只读当前 schema 20 控制面库，重新验证完整来源摘要、owner、期限、仓库及 worktree 归属、检查证据和当前 tree/patch。默认只允许白名单非保护插件 `src/` 下的普通 `.ts/.js/.mts/.mjs` 源文件修改；`grant.versioning: "patch"` 仅额外允许上述 Host 管理的 manifest 版本变化。测试目录、其他 manifest 字段、脚本、lockfile 和保护插件不在授权范围。工程检查证据不构成业务目标达成证明。

持久作业在 `prepared` 落账后调用审批，Host 在验签后以 Delivery/Evaluation 当前来源 writer fence 提交 `approved`。纠正、撤回、身份/会话换代、取消或 trust 变化均阻止提交。审批失败保留 pending 计划和已完成构建；重启恢复最多 1000 个 pending 的 owner 作业，仍核对原 sourceJobs 授权和 owner，只重试审批。单次 helper 至多 10 秒；卸载会等待子进程清理并丢弃迟到结果。Host 可调用 `requestOwnerSourceApproval({planId, signal?})` 显式重试；该方法不暴露为模型工具。inline 准备仍只返回 pending。

此客户端要求 Linux `/proc`；wrapper 和 Node 均须是 canonical 路径、可执行且只有一个硬链接的 owner/root 文件，不能由其他用户写入。按文件描述符固定两者字节；完整已安装库仍须由 owner 控制，wrapper hash 不覆盖导入库。子进程是执行和清理边界，同 UID 运行不构成私钥隔离；若模型可任意执行 Host 代码，应将签名器置于独立身份边界，通过 owner 固定的代理执行文件调用。签名器不执行候选源码。仅启用 `sourceApprovals` 时停在 `approved`；可配置下面的有限发布授权接续，精确制品的验证、采用和观察/回滚仍走各自授权链路。

### 获批源码的有限本地发布授权

同时启用 `sourceApprovals`、`sourceBuild.versioning: patch` 和可选 `sourceReleases` 后，持久源码作业会在获批后自动复核同一 worktree，再请求独立发布授权，进入既有 `awaiting-pr` 状态。继续使用原生 Automations executor 和 `prepared` 作业恢复；不会重复构建。Host 方法 `requestOwnerSourceRelease({ planId, signal?, expectedTrustDigest? })` 也可显式接续已批准的 owner 来源计划，未注册为模型工具。普通 owner 来源的 `verify-prepared` 和 `release-start` 必须通过 Host 当前反馈校验，离线 CLI 不能代替该校验。

```yaml
sourceReleases:
  executable:
    path: /opt/dsh/control-plane/bin/dsh-source-release-authority.js
    sha256: <installed-wrapper-sha256>
  interpreter:
    path: /opt/dsh/node
    sha256: <installed-node-sha256>
  configPath: /private/owner/source-release.json
  timeoutMs: 10000
```

`source-release.json` 沿用上方源码审批配置的 `schemaVersion`、authority/key、私有状态库、控制面库和 owner/repository/worktree/文件预算结构，但须使用独立发布授权私钥和状态库：将 `grant.maxApprovals` 替换为 `grant.maxReleases`，设置 `grant.versioning: "patch"`，并给每个白名单插件配置一条 `grant.policies`。在 trust 的 `releaseAuthorizationKeys` 注册公钥；该 key 与 source approval、adapter receipt keys 分开。策略示例：

```json
{
  "targetBranch": "rsi/repairs",
  "candidateId": "personal-memory",
  "packageName": "@dsh-enhanced/personal-memory",
  "packagePath": "plugins/personal-memory",
  "dshBaseline": "0.1.5-rc.2",
  "capabilities": ["memory"],
  "authorities": ["filesystem"],
  "requires": [],
  "registryId": "local-repairs",
  "registryLocator": "file:///private/owner/registry",
  "catalogId": "owner-catalog",
  "catalogPath": "/private/owner/catalog.json",
  "minimumReproducibleBuilds": 2
}
```

能力、权限和依赖应填写目标部署的精确授权值，数组按既有 release policy 规则排序。registry 目录和 catalog 文件必须已存在且归 owner 私有控制；此授权器仅支持现有本地 file registry。包版本从已检查的 Host 补丁版本推导，制品路径固定为 registry 的 `packages/<编码包名>/<版本>/package.tgz`；调用者不能指定版本、路径或扩大策略。

签名器独立重读当前控制面库、owner 来源、源码范围、构建证据、Git 摘要及版本。grant/config/key 指纹和累计签发数持久保存；重试和进程重启只返回同一回执，不重扣额度、不延长有效期。Host 在最终提交及重放时再检查当前反馈，纠正、撤回、身份变化、取消、trust 漂移均阻止接续。重启可从 `pending-approval`、`approved` 或 `ready-for-human-review` 接续；已进入 release 的计划不重新签发。单次 Host 接续最多 30 秒，卸载等待受控进程清理并丢弃迟到结果。

此授权配置只负责开始既有 release 状态机；自动推进须另行启用下述执行配置。

### 已授权本地发布的自动推进

```yaml
sourceReleaseExecution:
  reviewDecisionRoot: /private/owner/review-decisions
  timeoutMs: 900000
  independentReview: true # 可选；需另配 assistant-verifier.sourceReviews
```

此配置依赖 `sourceReleases`，沿用 trust schema v4 中八个固定 `releaseAdapters` 和本地 `file:` registry。原生 Automations 作业获批后，Host 依次接续 PR、review、merge、build、sign、publish、registry verify 与 catalog admission；最多推进八个既有阶段，不创建额外定时器。`timeoutMs` 为本次接续总上限（1 秒至 30 分钟），各 adapter 保留自身时限。源码检查和 release 构建是两个原有检查阶段，恢复不会重做已完成阶段。

review decision 仍由独立审查方产生：Host 只读 canonical、无 symlink、owner 私有目录下的 `<prId>.json`，其内容须符合现有 local adapter 的 `dsh-local-review-decision` 格式并精确绑定 PR id、base/head commit 和 PR evidence digest。配置的 `reviewDecisionRoot` 须与 review adapter 读取目录一致。缺失时保持 `awaiting-review`，不派发 review；格式错误或绑定变化则拒绝。独立审查方完成后调用 Host-only `advanceOwnerSourceRelease({ planId, signal?, expectedTrustDigest? })` 即可在当前进程继续，不要求重启。该入口不是模型工具；decision 由独立 Verifier 或外部审查方生成。部署须把 decision 写权限、审查输入和审查执行环境与候选写权限分开；同 UID 的目录权限本身不证明进程隔离。

启用 `independentReview: true` 后，现有持久作业会在缺少 decision 时调用另行有限授权的 [Verifier 源码审查](../assistant-verifier/README.md#独立源码审查)。它使用固定 bare Git 仓库和新的无工具原生 Agent，默认继承来源任务的确切模型，也可固定审查模型。Verifier 的 decision root 必须与这里相同；服务或模型不可用时在 PR 前等待，依赖移除会停止对应作业。审查完成后仍通过原有签名 review adapter 和八阶段检查。后续精确制品采用与普通任务版本观察已有下述可选配置，完整部署仍待验收；这里的 publish 仅面向获准本地 registry，不上传公共 npm。

schema 18 在 adapter 派发前持久登记 operation claim；验签和子进程执行期间不持有 SQLite 写事务。当前 owner 来源、取消、trust 和阶段 CAS 在执行边界及回执应用前重查。超时、崩溃或响应丢失后，已 claim 且无回执的 operation 保持 unknown，重启不重新执行。已完成回执直接接续应用，catalog 已写而账本未确认时也不重新计算旧 preview。独立取得精确签名回执后，可通过 `advanceOwnerSourceRelease({ planId, receipt, ... })` 对账并继续；它只验签回执，不重新运行丢失响应的动作。无法取得可信回执时保留 unknown。

升级到 schema 18 会将历史 pending release operation 保守视为可能已派发，要求回执对账；不会把旧 pending 当作新动作。源码作业的 prepared 恢复覆盖等待中的 release 阶段，并继续检查原 owner 和冻结 trust。Cordis 卸载取消接续、终止并回收 adapter 进程组、等待在途工作后关闭数据库；脱离进程组的进程仍须由部署的 OS 隔离边界管理。

### 已发布 owner 修复的有限采用

在 `sourceReleaseExecution` 之上可选配置：

```yaml
sourceAdoptions:
  profile: assistant
  planTtlMs: 900000
  timeoutMs: 600000
  authority:
    executable: { path: /opt/dsh/bin/dsh-source-adoption-authority.js, sha256: <sha256> }
    interpreter: { path: /usr/bin/node, sha256: <sha256> }
    configPath: /srv/dsh-owner/adoption-authority.json
    timeoutMs: 10000
```

`dsh-source-adoption-authority` 使用独立 owner 私有配置和 Ed25519 key；公钥进入 trust 的 `approvalKeys`。配置为 `schemaVersion: 1`、`authority`、`keyId`、`keyPath`、`statePath`、`controlDatabasePath` 和 `grant`。grant 固定 `id`、`expiresAt`、`maxAdoptions`、稳定 owner 身份（与源码发布授权相同）、`installationId`、完整 `ledger/target/executor`、`catalogPath`、`receiptTtlMs` 和 `policies`。每条 policy 固定 `candidateId/packageName/dshBaseline/capabilities/authorities/requires/registryId/registryLocator`；版本、完整性与 registry reference 从精确完成的 release 读取。保护插件不在此授权范围。相同 grant 的配置/key 不可替换，重试返回同一回执且不延长期限。

原生源码作业在 `release-complete` 后自动接续：绑定原 owner 任务、精确 release 制品与 profile，申请有限采用回执，再调用与 CLI 相同的安装、Host 签名检查和物理回退实现。schema 19 的 `source_adoptions` 保证一条源码计划只对应一条激活计划；普通任务失败无需给插件添加虚假的通用修复 capability。Host 入口 `adoptOwnerSourceRelease({ sourcePlanId, signal?, expectedTrustDigest? })` 可继续已有记录，不暴露为模型工具。恢复不重建已发布制品、不重新审批已批准的激活。

使用 systemd 重启目标 Host 时，控制面应运行在目标 Host 之外，避免目标重启中断自己的部署作业。采用使用独立 SQLite 连接，并复用现有 profile 锁和跨进程文件操作互斥；同一 Service 一次执行一个采用任务。任务来源在异步操作前后重验，取消或失败后保留恢复义务。物理恢复不依赖已撤回的来源授权；已暴露 profile 仍须取得原 Host 的独立 rollback 回执才结算。trust 绑定变化、无法确认资源释放或签名服务不可用时保留待恢复状态。Cordis 卸载取消并等待采用工作，随后关闭其连接。

需要重启目标 Host 的部署，应在目标的 `sourceAdoptions` 中增加以下 `handoff`，并在采用签名器的 `grant.handoff` 配置完全相同的值：

```yaml
handoff:
  schemaVersion: 1
  coordinatorId: assistant-deployer
  maximumWindowMs: 900000
  commit: target-host
```

这些条款进入不可变计划摘要，由现有采用审批签名覆盖。目标在当前 owner 反馈写入屏障内创建持久交接；期限取计划、审批回执和窗口上限的最小值，恢复或重复调用不会续期。外部 Host 共享精确 ledger/trust，单独配置：

```yaml
adoptionCoordinator:
  coordinatorId: assistant-deployer
  budgetId: adoption-coordinator-runs
  budgetAmount: 1
  scope:
    workspace: /srv/dsh/workspace
    preset: assistant
    principalId: owner
    ownerRouteId: owner-route
  timeoutMs: 300000
```

协调器必须运行在另一进程和独立 systemd unit；它不能同时配置目标的 `sourceJobs`、`sourceAdoptions`、`runtimeObserver` 或 `replayEndpoint`。只需连接所在 Host 的 Automations，复用原生每分钟调度、owner/Policy 和预算，每轮至多推进一个交接；空队列仍消耗一次配置的调度预算。`budgetId/budgetAmount` 必填，对应 Policy budget 使用 `automation-runs` metric 与有限周期额度，建议 `subject` scope，以稳定的协调器 automation id 聚合。Policy 账本按 scope、metric 和周期计量，仅换 budget id 不会分池；同一 Host 的其他任务应明确选择共用或分开额度。旧配置升级时须补齐，不能打开 `allowUnbudgetedExecution` 代替。`coordinatorId` 是绑定标识，不提供 OS 隔离或替代 ledger 文件权限。停用调度或耗尽原生预算也会暂停自动恢复，恢复前需先核对未知外部操作。

协调器沿现有安装和签名检查路径推进，到 `commit-pending` 停止。目标恢复后由其原生源码 continuation 重验当前 owner、反馈和信任，再完成启用；已撤销或过期交接只能进入既有回退。目标卸载不会撤销已交出的任务；未知 Host 派发仍须精确签名对账，不能自动重派。目标离线期间无法即时获知反馈纠正，允许暴露的最长授权窗口由上述期限限制；回退完成时间仍取决于协调器可用性和签名服务。

`dsh-rsi-setup` 已提供双 Host 合同编译与校验，实际部署验收尚未完成。现有 systemd attestor 只签发 reload/readiness/rollback；缺省严格合同的其余行为验收阶段仍需要真实独立观测，不能用进程就绪代替。可显式配置下述有限试用合同，由普通任务证据独立签发资格。组件接线不等于生产自动采用闭环，npm 发布仍须等待实际部署验收。

这提供自动采用的执行链。目标 Host 可另配 `foregroundDeployments: { attestorJournalPath: /srv/dsh-owner/supervisor/reload.sqlite }`，同时启用 `runtimeObserver`，并挂载 Delivery。路径须指向 systemd attestor 实际的私有 SQLite journal；配置只授予读取已签名 readiness 记录的权限，不包含签名密钥。目标 Host 与外部部署协调器需使用同一精确控制面账本和 trust 绑定；当前实现要求同 UID 的私有文件读取，不能据此声称独立 UID 隔离。

schema 20 的 `foreground_deployments` 在真实 owner 前台任务开始和完成时保存身份及运行实例。采样复用认证 observer 的同一实例，核对已应用 readiness 的签名、保留观测摘要、PID/InvocationID、profile、Fiber/依赖/服务代次，并关联精确 package/version/integrity。只接受当前最近一次成功部署、已完成 owner 源码采用、且属于同一 owner/workspace/preset 的新任务；未结算部署、重载、实例变化或非静止完成均不产生有效观察。注销/重启中断的记录保持 pending，历史任务不回填。trust 文件改变后需重载配置；观察失败不会中断正常对话。

Host 可用 `inspectOwnerForegroundDeployment()` 按与 Delivery 学习来源查询相同的参数读取归因；它重验当前可信任务，保持原学习来源摘要不变。记录证明该任务处于这一部署实例下，不证明调用过某个工具或该版本导致了结果，也不会把正常结束计作质量成功。读取结果作为质量依据仍需消费当前 canonical 反馈与撤回，并在最终写入时使用 writer fence。可选 `taskObservations` 已接通有限批次的当前反馈、签名观察与物理回退；日常使用配置已可编译，端到端部署验收仍待完成，此能力不代表 npm 发布验收通过。

单个 Service 最多准备一条提案。Cordis 卸载先取消并等待所有准备步骤和容器/worktree 清理，再关闭 SQLite。数据库 schema 24 保留旧 create 摘要和 release 外键；modify 的审批摘要另外绑定 mode、检查结果及构建证据。构建证据证明配置镜像中的检查过程，不证明候选业务质量或独立隐藏评测通过；正式 release 仍需要原有审批、独立 review、构建和签名。

非 owner-task 来源的计划可用 `release-request` 导出当前 durable phase request、用 `release-step` 调用已固定 adapter 并应用 receipt，或用 `release-attest` 应用 owner-controlled 外部系统生成的同协议 receipt。phase 不能由调用者选择，而由 durable source plan 状态决定。adapter 返回签名 publish 歧义回执后进入 `publish-ambiguous`，再由独立 registry verifier 的签名 reconciliation receipt 决定继续验证、以新 fence 重试，或 fail closed。派发后没有签名回执则保持 unknown，不自动重跑；普通 owner-task 来源的全部阶段必须通过 Host 当前来源校验。

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

### 真实任务失败来源

Host-only `recordOwnerTaskFailureGap(source)` 将经 Delivery 再验证的 foreground `not-achieved` 结果，在 Evaluation canonical writer fence 中原子写入 gap 和私有来源引用。schema 16 从 v15 保留原有计划并增加 sidecar；引用只保存完整 owner receipt、outcome/canonical 修订和 source digest，gap 使用固定说明且 ROI 为未知占位 0。模型自报、调用方文案、未结束或截断来源均不能登记，接口不注册为 CLI/模型工具。

这些 gap 不出现在全局 `gaps()` 中。Growth 自动复盘仅看本次来源的 exact gap；同步准备必须提供当前 owner，durable source job 绑定相同 owner。每个检查边界与最终计划提交重新验证来源，最终写入同时持有 Evaluation writer fence 和同步 Store admission；普通 CLI 不能凭 gap id 绕过来源检查。`/new` 的 binding/generation 改变、纠正、撤回或依赖服务不可用会拒绝旧任务，已派发而中断的 job 保留 unknown。历史引用保留以供审计，不自动重放。

该 Host API 使用同批 `assistant-delivery` 与可选 `assistant-evaluation >=0.1.33` 的精确接口；不要求手工 gap 部署安装 Evaluation。它只授权来源绑定的候选准备，pending plan 的后续授权采用、发布与观测仍走独立控制链。

## 权限

- 插件 Host service：启用 `sourceApprovals` 时执行固定的 owner helper（可读其配置、私钥和私有审批账本），Host 只消费签名回执；读取 catalog/trust，写 owner-private SQLite/WAL；启用源码读取或准备时执行受限 Git，启用 `sourceBuild`/`sourceJobs` 时创建隔离 worktree 并调用 owner 配置的离线容器构建。模型不能选择可执行文件、网络或凭据；Host 不使用浏览器。
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

物理 Host 回退使用随包 systemd attestor v5 的 schema-3 配置与 schema-2 请求，复用 `probe --prepare-only` / `probe`。回退前固定原始三份 core 文件摘要；文件恢复后固定 fence，重试同一个持久化操作只重新观察，不再次 restart/stop。原 profile 不存在时只允许 stop。详情与环境约束见[操作文档](../../docs/systemd-host-attestor.md#physical-rollback)。

## 原生阻断回放组件

Host 可显式使用 `EffectBlockedReplayRuntime`，复用当前 Loader、ToolRuntime 和 Delivery，消费专用原生 AgentHandle。固定有限 case 经原生单向 guard 阻止工具 body，或经真实 Delivery reply 准入阻止 Outbox 写入；逐次记录调用摘要，持续核对候选和服务 Fiber 代次，回收 Agent 后才返回。它不调用模型，不自动启用，也不增加模型工具。

可选 `replayEndpoint` 将 owner 固定请求和用例接入独立 HMAC Unix socket；客户端只可执行或查询该操作。SQLite 在创建原生 Agent 前持久准入，未知结果不重跑，缓存结果重验当前 Loader/Fiber；实例重建后返回 stale。配置、状态目录、socket 与 32 字节密钥都由 owner 管理，观测通道与执行通道使用不同密钥。

`replayEndpoint.authority.mode: 'signed'` 支持晚到授权：启动时固定 Ed25519 公钥、installation/ledger/plan/activation/profile 作用域和 cases；readiness 落账后由外部 owner 签署完整 schema-2 请求、端点/用例摘要、PID/InvocationID 与最多 60 秒时窗，再随 execute/query 提交。无须修改部署配置或重启 Host。journal schema 2 在创建 Agent 前原子绑定 scope、operation 和 grant；同一 scope 换 operation 或重新签名均不能绕过 unknown。旧 journal 自动保留 fixed 行，不能转成 signed 准入。私钥不进入 Host；签发方负责核对外部账本和 readiness，端点签名校验不代替这一核对。配置与签名示例见[阻断回放](../../docs/effect-blocked-replay.md)。

回放依赖与 Host AgentLoop 同一模块实例的 `@deepseek-ai/dsh-scope` peer；使用原生 scope 验证 Host/Agent 身份，不能混用工作区和实际 Host 的副本。`agent.preset` 仅写入会话元数据，工具需由 Host 钩子注册。真实 DSH CLI `0.1.5-rc.2` 已验证完成态重启 stale 和 SIGKILL 后 unknown、不重复派发；硬退出留下的 socket 由 supervisor 确认旧进程已停止后清理，journal 保留。

这是未签名的观察组件，不能单独推进启用状态。外部签名器、未知操作的外部对账和独立副作用读回仍需后续接线。权限包括 owner 配置路径/密钥读取、私有 journal 写入、Unix socket、当前 Loader 状态、原生 Agent 创建/回收、工具管线与 Delivery 方法；原生钩子仍有 Host 权限，组件不提供 OS/网络隔离。完整生命周期、边界及示例见[组件契约](../../docs/effect-blocked-replay.md)。


### 真实使用中的部署观察

目标 Host 可启用下面的可选项，依赖同一 profile 的 `foregroundDeployments`、Delivery、Evaluation 和 Automations。调度由原生 Automations 的每分钟 cron 执行；配置期间扫描至多最近 1,000 条有效部署任务，不调用模型，不产生新的 AgentLoop。该窗口之外的任务不参与观察。`budgetId/budgetAmount` 必填，对应有限周期的 Policy `automation-runs` 预算，建议 `subject` scope，以稳定观察任务 id 计量，避免与模型复盘共用 scope/metric/周期；仅换 budget id 不会分池。空队列也消耗一次调度额度。此预算与签名器的 `maximumObservations` 是两种独立限制。预算耗尽会暂停观察签发及其自动回退接续，原恢复义务仍保留；升级旧配置须补齐预算。

```yaml
taskObservations:
  budgetId: plugin-task-observation-runs
  budgetAmount: 1
  policy:
    id: owner-plugin-watch-1
    expiresAt: 1790000000000 # 替换为有限授权截止时间（毫秒）
    maximumObservations: 20
    minimumChecks: 2
    maximumChecks: 8
    lookbackMs: 86400000
  scope:
    ownerRouteId: owner-route
    principalId: owner
    workspace: /srv/dsh-owner/workspace
    preset: primary
  profilePath: /srv/dsh-owner/profiles/web
  timeoutMs: 60000
  authority:
    executable: { path: /srv/dsh-owner/bin/dsh-task-observation-authority.js, sha256: '<固定文件摘要>' }
    interpreter: { path: /usr/bin/node, sha256: '<固定解释器摘要>' }
    configPath: /srv/dsh-owner/private/task-observation.json
    timeoutMs: 10000
```

`dsh-task-observation-authority --config <private-file>` 从 stdin 接收 `{ protocol: "dsh-task-observation/v1", observationId, observationDigest }`，只读控制面账本中的批次。独立私有配置字段为 `schemaVersion: 1`、`authority`、`keyId`、`keyPath`、`statePath`、`controlDatabasePath` 与 `grant`；grant 包含与 Host 完全相同的 `policy`、稳定 `owner`（authorityId/authorityHash/principalId/principalRecordId/principalVersion/workspace/agentPreset）、`installationId`、`ledger: { id, path }`、`profilePath`、允许的 `packages` 数组和 `receiptTtlMs`（1,000–300,000）。Ed25519 公钥进入 trust 的 `hostAttestationKeys`。配置、密钥、数据库路径须为 owner 私有本地文件；固定执行器通过受限环境和描述符执行，无网络或模型凭据。其签名授权不授予候选插件修改控制面或验收器的权限。

每个批次包含同一实际部署下、不同真实任务的当前 `achieved/not-achieved` owner 反馈或独立 verifier 结果；unknown、撤回、截断或非静止任务不计票。批次内任一失败触发 `regressed`，否则为 `healthy`。这是 owner 明确选择的部署任务组策略，不能证明某个工具被调用或该版本造成结果。相同任务的相同 canonical revision 只落账一次；后续纠正可形成新观察。批次身份、grant/key 指纹、签名次数和回执持久化，重启重试复用原回执，不延长期限。政策最多 1,000 次观察、每批 1–32 个任务、回看 1 秒至 30 天。

Host 在冻结批次、签名前后与最终落账时重读来源；最终 Evaluation writer fence 包裹控制面 SQLite 事务，同步写入 watch 和 applied 状态。签名器验证有限策略及已记录部署事实，可信任务质量来自 Host 当前 canonical 读取；它不是另一次独立模型评分，也不构成同 UID 文件隔离。签名期间纠正、撤回或部署变化阻止旧观察落账。已落账的回滚决定保留审计，后续反馈变更不取消恢复义务；cron 复用现有物理恢复/Host attestor 回执链，失败保留待恢复状态。进程重启可继续，主动卸载会暂停对应 cron、取消并等待在途执行，再关闭连接。owner/trust 被撤销、目标 Host 自身重启或资源无法释放时仍需外部控制面/CLI 完成恢复，不能承诺目标 Host 单独完成自重启恢复。

### 有限真实任务试用采用

可显式配置 `sourceAdoptions.liveQualification` 与 `liveQualification`，经独立源码审查和真实 reload/readiness 后，用当前 owner 的普通任务反馈决定采用或回退。合同、独立签名、原生预算、期限、最终 canonical 复核及运行边界见[有限试用采用](../../docs/bounded-live-adoption.md)。缺省严格验收顺序不变；新模式不签发 shadow/零副作用凭证，不限制整个 profile 的曝光次数。
