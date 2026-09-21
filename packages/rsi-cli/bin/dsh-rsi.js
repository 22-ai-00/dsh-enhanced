#!/usr/bin/env node
// dsh-rsi 全局命令入口：实现位于 lib/index.js（TypeScript 源码在 src/index.ts）。
import { main } from '../lib/index.js'

main().then(
  code => process.exitCode = code,
  error => {
    process.stderr.write(`dsh-rsi 致命错误：${error?.stack ?? error}\n`)
    process.exitCode = 1
  },
)
