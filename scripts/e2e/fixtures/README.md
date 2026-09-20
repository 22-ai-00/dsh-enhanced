# E2E 固定输入

## npm 0.1.32 integrity pins

`npm-release-0.1.32.json` 只保留四个只读 registry 探针需要的两个包名、版本、预期 SRI 和发布源码提交。它从已提交发布记录逐字段提取，来源提交/路径保留在文件中；不包含运行日志、主机身份或凭据。预期摘要不得从被检验的本次网络响应生成。

`sourceRecord` 的 commit/path/sha256 是 Git 历史出处，不要求该原始记录仍存在于当前 checkout。
