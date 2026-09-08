# @dsh-enhanced/assistant-proactive

为已获主人授权的目标事件等待增加机会筛选。事件经过合并窗口、静默时段、收益阈值、冷却及每目标预算判断后，保存静默记录、向主人发送提醒，或交回 Goals 恢复原目标。实际执行继续使用原会话、Policy、预算和独立验收。

## 安装

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-proactive
dsh --profile web --dump-config
```

插件可独立安装；与 `assistant-goals`、`event-triggers` 配合使用时，先按 Goals 文档配置持久化事件等待、主人路由、执行预算与独立验收。安装本插件不会自行创建目标或订阅事件。

## 配置与使用

在本插件的 Cordis 配置行设置（将数据库路径替换为本机私有目录）：

```yaml
databasePath: /home/operator/.dsh/assistant-proactive.sqlite
profiles:
  - id: useful-report
    mode: execute
    expectedBenefit: 100
    successPpm: 900000
    executionCost: 10
    interruptionCost: 5
    possibleLoss: 5
    minimumUtility: 1
    mergeWindowMs: 2000
    cooldownMs: 60000
    rejectionCooldownMs: 3600000
    quietHours:
      timezone: Asia/Shanghai
      startMinute: 1380
      endMinute: 480
    maxDecisionsPerGoal: 20
    maxExecutionsPerGoal: 2
    maxRemindersPerGoal: 0
```

对话示例：`为当前目标等待 report-file 触发器，使用 useful-report 机会策略，截止时间为一小时后。` 模型在当前主人请求中调用 `goal_wait_event`，显式提供 `opportunity_profile: useful-report`，以及实际目标 ID、native revision、触发器 ID 和毫秒时间戳。未知策略在暂停前被拒绝；省略策略保留 Goals 原有行为。

- `execute`：达到条件后返回执行候选；Goals 再次核验当前目标和授权，才能恢复。
- `remind`：向冻结的主人会话投递一条持久提醒，包含目标、事件标识与配置估值；不调用模型，不执行目标。要求 Delivery 支持 `enqueueOwnerNotification`、已配置主人路由，并为背景主体 `assistant-proactive/v1` 授予该会话消息的 `send` 权限。设置 `maxRemindersPerGoal` 为正数；重复处理同一决定复用相同投递键。Web 在原会话输入区显示“主动提醒”，重启后可继续读取；其他渠道通过已有适配器发送。
- `prepare`：只保存目标、事件标识与判断理由，供 `proactive_status` 查询；不生成模型草稿、不修改业务文件。目标继续等待后续事件，直到截止或主人控制。
- `proactive_feedback`：当前已认证主人可以接受或拒绝指定决定；拒绝为该目标/策略的后续决定设置持久冷却。反馈不会撤销已经分派的工作，也不会创建执行授权。

收益值为操作者配置的同一抽象单位，公式为 `floor(expectedBenefit * successPpm / 1000000) - executionCost - interruptionCost - possibleLoss`。它们不是独立测得的成功概率、货币成本或真实效果。策略首次用于目标时冻结；改变部署配置不会放宽该目标已冻结的策略。预算统计覆盖同一主人和目标下的所有策略；执行预算仍由 Goals 单独强制执行。

静默时段按 IANA 时区计算，支持跨午夜。合并等待和静默结束依靠 Goals 的周期核对；重启后继续读取原记录。事件内容不提供权限，也不作为新的目标指令。提醒投递有效期不晚于目标等待期限或下一个静默时段开始；未及时发送的提醒会失效，不跨静默时段补发。发送前及 Web 读取时重查原主人、绑定代次、路由和当前发送权限。Web 接受表示通知已可供读取，不表示用户已阅读。

## 权限与数据

- 文件系统：仅保存配置数据库及 SQLite WAL/SHM；其中含主人身份范围、目标文本、事件标识、判断和反馈。数据库要求私有普通文件及不可由组/其他用户写入的父目录；不读取事件正文或业务文件。
- 网络、子进程、凭据、浏览器、安装脚本：本插件均不直接使用。
- 工具：注册 `proactive_status` 和 `proactive_feedback`，均要求真实 Agent、Delivery 主人身份及 Policy；反馈还要求当前主人请求。Policy 资源为 `goal:proactive-opportunities`，动作分别为 `inspect`、`feedback`；通用工具审批仍由宿主处理。
- 执行：本插件不执行模型调用、不恢复目标；提醒通过 Delivery 的有类型接口持久入队。真正业务操作及消息发送的权限由 Goals、Delivery 与具体工具负责。
- 卸载释放数据库和工具；保留历史数据库，重新安装可继续读取。删除历史数据库会丢失本插件计数和反馈，不应在活跃目标期间清空。

## 当前边界

主动提醒为结构化文本，不生成模型内容；Web 读取继承固定主人会话能力，并重查当前发送权限，不另设独立的消息读取 Policy 动作。静默准备目前是结构化记录，尚不是模型生成的可用草稿。当前提供配置估值的事件筛选，未证明长期主动性收益；长期观察可在交付后的使用中进行。

## 兼容性

遵循仓库 [兼容性基线](../../docs/compatibility.md)。可选服务缺失时不授予执行能力。
