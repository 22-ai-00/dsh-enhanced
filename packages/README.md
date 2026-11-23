# 共享包与工具包

此目录存放不自动激活的 TypeScript 包：供插件复用的共享库，以及安装/管理命令。共享包不得声明 `dsh.bundle`，因此用户安装它时不会向 profile 注入 patch 层。可独立启用的插件包见[插件目录](../plugins/README.md)，统一版本见[发布账本](../release-manifest.json)。

共享库只在出现真实的第二个消费者后才提取。发布型共享包使用与插件相同的构建、测试和 pack 检查，但由消费插件决定把它列为 dependency 还是 peerDependency。

| 包 | 用途 |
| --- | --- |
| [`@dsh-enhanced/assistant-growth-contract`](assistant-growth-contract) | 为 Delivery、自动化与受监督 growth 实验提供可验证、内容最小化的 workflow/实验契约；不激活 Cordis 插件，也不保存或传递原始 owner 内容。 |
| [`@dsh-enhanced/dsh-rsi-cli`](dsh-rsi-cli) | 全局 `dsh-rsi` 命令：安装、打开控制台（`open`）、状态与只读诊断（`status`/`doctor`）、成长计分卡（`growth-report`）、日志与 Web URL、就地升级（`upgrade`/`update`）、运维结算（`maintenance`）和卸载（`purge`）；管理 macOS/Linux 的 Home、profile 与服务，不声明 `dsh.bundle`，也不向 profile 注入 patch 层。 |
| [`@dsh-enhanced/llm-route-capabilities`](llm-route-capabilities) | 在精确的 DSH `LlmRuntime` 上发布和查询 provider/model 的 tool-call 协议投影方式；不决定 Agent 工具权限，仅用显式 `none` 表达 adapter 未实现统一协议，也不会激活 Cordis 插件。 |
| [`@dsh-enhanced/task-acceptance-contract`](task-acceptance-contract) | 为任务验收合同与独立验证回执提供严格、不可变的 wire 契约；只做 JSON 校验、路径规范化与规范 SHA-256 摘要，不激活服务、工具、网络、文件或子进程。 |
