# 共享包

此目录存放两个或更多插件复用的普通 TypeScript 库。共享包不得声明 `dsh.bundle`，因此用户安装它时不会向 profile 注入 patch 层。

只有出现真实的第二个消费者后才提取共享包。发布型共享包使用与插件相同的构建、测试和 pack 检查，但由消费插件决定把它列为 dependency 还是 peerDependency。

| 包 | 用途 |
| --- | --- |
| [`@dsh-enhanced/assistant-growth-contract`](assistant-growth-contract) | 为 Delivery、自动化与受监督 growth 实验提供可验证、内容最小化的 workflow/实验契约；不激活 Cordis 插件，也不保存或传递原始 owner 内容。 |
| [`@dsh-enhanced/llm-route-capabilities`](llm-route-capabilities) | 在精确的 DSH `LlmRuntime` 上发布和查询 provider/model 的 tool-call 协议投影方式；不决定 Agent 工具权限，仅用显式 `none` 表达 adapter 未实现统一协议，也不会激活 Cordis 插件。 |
