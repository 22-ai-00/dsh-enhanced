# @dsh-enhanced/hello

最小 DSH bundle 示例：加载时写入一条日志，用来验证安装、patch 和构建链路。

## 在 dsh 中使用

本仓库本地开发：

```sh
pnpm build
dsh plugin --profile web add ./plugins/hello
dsh --profile web --dump-config
dsh web
```

发布后可把本地路径换成 `@dsh-enhanced/hello`。

权限与数据：不访问文件、网络、子进程、凭据或浏览器数据。
