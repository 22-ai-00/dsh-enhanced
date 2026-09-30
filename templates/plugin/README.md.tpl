# {{PACKAGE_NAME}}

{{PLUGIN_TITLE}} plugin for DeepSeek Harness.

## 安装

```sh
dsh plugin --profile web add {{PACKAGE_NAME}}
dsh --profile web --dump-config
```

## 配置与使用

默认 `src/index.ts` 不注册工具，也不在运行时导入 Tools。需要把能力暴露给 DSH 原生工具调用时，在安装了可选的 `@deepseek-ai/dsh-tools` Host service 的 profile 中，用下面的完整示例替换 `src/index.ts`，再运行 `pnpm --dir plugins/{{PLUGIN_NAME}} build`。SDK 版本须符合本包 peer 范围。

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { version } from './version.js'

const echo = defineTool({
  name: '{{PLUGIN_NAME}}_echo',
  description: 'Return the supplied text without external side effects.',
  parameters: { text: { type: 'string', required: true } },
  output: {
    schema: {
      type: 'object', additionalProperties: false,
      properties: { text: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    if (exec.signal.aborted) throw exec.signal.reason ?? new Error('tool call aborted')
    return { text: args.text }
  },
})

export default {
  name: '{{PLUGIN_ID}}',
  version,
  inject: ['tools'],
  apply(ctx: Context) {
    // Native SDK registration is a Cordis effect owned by this mounted plugin.
    ctx.tools.register(echo)
  },
}
```

`inject: ['tools']` 是必需的运行时服务门：Tools 未出现时插件保持 pending，Tools 移除时注册随插件卸载。这里不需要手动重复注册 disposer；SDK 的 `register` 已将 effect 归属到当前 `ctx`。如果添加其他资源或需要按顺序清理，使用 Cordis effect 并返回可等待的 disposer。若新增部署配置，须声明所需 Host 依赖并在挂载的默认对象上提供同步 Standard-Schema `Config`，在获取资源前完成校验。工具的实际权限仍由 Host 的 owner 授权和 Policy 决定；此示例不扩大模型 manifest、lock 或 grant 权限。

替换入口时还要同步替换骨架的 `tests/index.spec.ts`：原测试针对无工具日志入口，不能验证新的默认对象。最小生命周期测试如下，运行 `pnpm --dir plugins/{{PLUGIN_NAME}} typecheck` 和 `pnpm --dir plugins/{{PLUGIN_NAME}} test`：

```ts
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, test } from 'vitest'
import plugin from '../src/index.js'

test('registers and unregisters the native tool with its owning plugin', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    const consumer = ctx.plugin(plugin)
    await consumer.await()
    expect(consumer.state).toBe(0) // pending until Tools appears
    await ctx.plugin(Tools, { mode: 'native' })
    await consumer.await()
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('{{PLUGIN_NAME}}_echo')
    await consumer.dispose()
    expect(ctx.tools.schemas().map(tool => tool.name)).not.toContain('{{PLUGIN_NAME}}_echo')
  } finally {
    await ctx.fiber.dispose()
  }
})
```

## 权限与数据

上面的示例没有文件系统、网络、子进程、凭据或浏览器访问。实际插件须分别记录这些权限及数据去向；未使用的项目写“无”。

## 兼容性

See the repository [compatibility baseline](../../docs/compatibility.md).
