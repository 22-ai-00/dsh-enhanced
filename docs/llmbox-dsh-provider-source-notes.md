# LLMBox Evolving 接入 DSH：本地源码调研笔记

本文记录本机 DSH/依赖源码可证明的配置契约；不包含任何 token、cookie 或本地鉴权文件的值。文中标为“运行验证”的网关结果由主调查任务的受控请求提供，并非本笔记的源码推导。

## 结论

应把 LLMBox 单独声明为一个 `llm-pi-ai` route，不覆盖现有 `super-relay`。当前 DSH 的通用手写 provider 支持三种精确协议标识：`openai-completions`、`openai-responses` 与 `anthropic-messages`；`anthropic` 不是有效配置值。[`provider.ts:47-63`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/provider.ts:47)

如果网关的 Chat Completions 路径已确认可用，推荐 route 采用 `openai-completions`：该路径从 `apiKeyEnv` 取得的值由 pi-ai 作为 `Authorization: Bearer <value>` 发送（DSH 的集成测试断言了这个请求头）。[`adapter.spec.ts:787-797`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/tests/adapter.spec.ts:787) 因而凭据值应是完整的访问 token（例如具有服务要求的 `at-` 前缀），不应把 `Bearer ` 一并存入值中。

```yaml
# $DSH_HOME/settings.yaml：与现有 llm-pi-ai.providers.* 合并，不替换整个 mappings
llm-pi-ai:
  providers:
    llmbox-evolving:
      displayName: LLMBox Evolving
      apiKeyEnv: LLMBOX_EVOLVING_API_KEY
      api: openai-completions
      baseURL: https://llmbox-global.byteintl.net/v1
      headers:
        x-source: doubao_model_dogfooding
      models:
        - id: doubao-seed-evolving
          name: Doubao Seed Evolving
          contextWindow: 200000
          input: [text]
```

这只注册一个可选择的独立 route，不改变当前默认模型。只有在操作者确认要切换全局默认时，才另行合并以下 settings 段：

```yaml
agent-default-model:
  provider: llmbox-evolving
  model: doubao-seed-evolving
```

`baseURL` 末尾的 `/v1` 是针对 Chat Completions 网关路径的部署选择：`openai-completions` 的模型发现会访问 `{baseURL}/models`，[`discovery.ts:107-121`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/discovery.ts:107)。运行验证：该网关以 Bearer token 和 `x-source` 接受 `/v1/chat/completions`，SSE 正常以 `[DONE]` 结束，并完成了一次 tool call 与 tool-result 回填；故此路线适合作为 Hermes/DSH 的共同默认路线。模型条目中 `contextWindow` 和 `input` 是部署者对网关能力的声明，DSH 不会验证声明的 modality；错误声明会在请求中失败。[`catalog.ts:573-609`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/catalog.ts:573)

## 凭据与附加请求头

`apiKeyEnv` 不是把密钥写进 settings 的字段，而是 POSIX 风格的凭据引用名。每一次 stream request 中，adapter 通过 `ctx.credentials.resolve(ref)` 取值；没有 credentials service 时才从启动环境读取。已命名但未解析的引用会在网络调用前以 `MISSING_CREDENTIAL` 失败，避免误用其他环境变量。[`index.ts:168-190`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/index.ts:168)

当前本机凭据文件已经是 version-1 的 `version`/`refs`/`records` 结构（只检查了键和类型，未读取或输出值）。因此持久引用的正确形状是：

```yaml
# $DSH_HOME/.credentials.yaml
version: 1
refs:
  LLMBOX_EVOLVING_API_KEY: <完整 token，不含 "Bearer ">
records: {}
```

该格式由 credentials-local 的 parser 定义：顶层只接受 `version`、`refs`、`records`，`refs` 的 key 必须是可引用的 POSIX identifier，value 必须是非空字符串。[`credentials-local/src/index.ts:188-226`](/data00/home/jiataorui/work/github/deepseek-harness/packages/credentials/credentials-local/src/index.ts:188) [`credentials-local/src/index.ts:268-286`](/data00/home/jiataorui/work/github/deepseek-harness/packages/credentials/credentials-local/src/index.ts:268) 运行时优先级为继承环境、该文件的 `refs`、再到 `.env` 回退。[`credentials-local/src/index.ts:617-624`](/data00/home/jiataorui/work/github/deepseek-harness/packages/credentials/credentials-local/src/index.ts:617)

`credentials.resolve()` 会在每个 adapter 请求时调用，但 `credentials-local` 读取的是进程内的 values map，而非每次直接打开文件；默认 `watch: true`、`debounceMs: 100`，初次读取后由 watcher 刷新该 map。[`credentials-local/src/index.ts:512-534`](/data00/home/jiataorui/work/github/deepseek-harness/packages/credentials/credentials-local/src/index.ts:512) [`credentials-local/src/index.ts:573-613`](/data00/home/jiataorui/work/github/deepseek-harness/packages/credentials/credentials-local/src/index.ts:573) 这支持直接更新 `$DSH_HOME/.credentials.yaml` 中的同一 `refs` 项后让后续请求取得新值，但 DSH 不会监视或解析 `~/.llmbox/cache/accesstoken`，也不会把已启动进程的环境变量重新读取。

因此首次接入或每次重启的安全操作方式是用 LLMBox 的既有 helper 在 `exec dsh` 之前刷新 token 并只导出到子进程，例如：

```sh
source ~/.llmbox/lib/_common.sh
ensure_token
export LLMBOX_EVOLVING_API_KEY="$(get_api_key)"
exec dsh --profile web
```

该 wrapper 不复制 token 到 DSH 文件；其限制是运行中 token 续期仍需要重启，或由外部受控续期程序把新值写入 DSH 的 `refs.LLMBOX_EVOLVING_API_KEY` 以触发 watcher。哪一种凭据生命周期合规，应由 LLMBox token 的有效期和部署者策略决定。

`headers` 是独立的明文字典。DSH 将其带入每个请求，但 Harness attribution headers 会覆盖同名项；测试证明自定义 header 能通过，且 `User-Agent` 会被 Harness 覆盖。[`adapter.ts:380-389`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts:380) [`adapter.spec.ts:116-124`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/tests/adapter.spec.ts:116) 所以 `x-source` 适合放在这里；不要把长期 token 放在 `headers.Authorization`，该字段不走 credentials redaction/rotation 语义，源码 README 也明确指出这个限制。[`README.md:219-224`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/README.md:219)

## Anthropic Messages 备选方案

LLMBox 的 `POST /v1/messages` 已运行验证可接受 `x-api-key`（值为完整 `at-…` token）和 `x-source`，并在 `stream: true`、强制 tool 的请求中以 `message_stop` 正常结束，产出 thinking 与 `tool_use` block。因此也可建立第二条 Anthropic route（不必替换推荐的 Chat route），将上例的 `api` 改为 `anthropic-messages`，并把 `baseURL` 改为 API 根（通常不带 `/v1`）：

```yaml
      api: anthropic-messages
      baseURL: https://llmbox-global.byteintl.net
```

这不是仅仅更换 URL：pi-ai 的 Anthropic adapter 将普通 `apiKey` 传给 Anthropic SDK 的 `apiKey` 选项，而不是 `authToken`。[`anthropic-messages.js:681-695`](/data00/home/jiataorui/work/github/deepseek-harness/node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_@modelcontextprotocol+sdk@1.29.0_zod@4.4.3__ws@8.21.0_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js:681) DSH 的 discovery test shows this protocol sends `x-api-key` and `anthropic-version`, with no Authorization header.[`discovery.spec.ts:168-212`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/tests/discovery.spec.ts:168) Therefore a gateway that accepts only `Authorization: Bearer …` should use `openai-completions`; a dynamic conversion from `apiKeyEnv` into a Bearer header is not an exposed DSH profile feature.

## Registration, selection, and tools

The `llm-pi-ai` bundle is mounted in the current web profile: a read-only `dsh --profile web --dump-config` returned rows `llm`, `agent-default-model`, and `llm-pi-ai` (exit 0). An empty bundle config is expected: it is a dormant adapter which registers routes from the `llm-pi-ai` settings section as soon as they exist.[`config.ts:220-228`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/config.ts:220) [`index.ts:279-290`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/index.ts:279) No new Cordis patch row is needed for this provider instance; the already-mounted `llm-pi-ai` row owns all routes.

`agent-default-model` is a global settings selection, while provider routes are available only in profiles mounting `llm-pi-ai`. The setting itself is exactly `{ provider, model }`; the project’s setup implementation writes those two keys and separately writes a custom gateway profile beneath `llm-pi-ai.providers.<route>`.[`model-setup.ts:275-295`](/data00/home/jiataorui/work/github/dsh-enhanced/plugins/assistant-policy/src/model-setup.ts:275)

DSH’s streaming bridge emits text, reasoning, usage and tool-call chunks. It forwards tool-call deltas and turns the completed pi-ai parsed arguments back into raw JSON for the Harness tool protocol.[`stream.ts:142-233`](/data00/home/jiataorui/work/github/deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts:142) The separate gateway runs described above exercised tool streaming on both protocols, which supplies endpoint evidence in addition to this bridge’s source contract.

## Version and verification boundary

Observed versions: globally installed `@deepseek-ai/dsh` is `0.1.5-rc.1`, but its actually resolved dependencies `dsh-llm-pi-ai`, `dsh-llm`, and `dsh-credentials-local` are each `0.1.5-rc.2`; the global pi-ai dependency is `0.82.1`. The adjacent source checkout is also `0.1.5-rc.2`. Directly importing the global `dsh-llm-pi-ai/lib/index.js` returned the three protocol names above. Its exported `Config`, resolved through that same global schemastery runtime, accepted the minimal Chat route exactly as shown (`schema=PASS`, exit 0); this is an offline schema validation with no Host boot and no credential value.

No credentials or settings were modified, and this investigation itself issued no model request. Gateway tests owned by the concurrent main investigation verified auth forms, `x-source`, endpoint joining, SSE completion, and basic tool flow. The remaining target-profile check is to add the route in a disposable/approved DSH configuration, run `dsh --profile web --dump-config`, then perform one non-destructive tool round to confirm DSH’s exact pi-ai version and the selected route behave together.
