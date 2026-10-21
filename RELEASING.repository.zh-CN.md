# codex-desktop-linux 仓库补充

本文件仅定义本仓库的分支、版本映射与上游例外；与通用规范一并读取。具体任务、检查结果和整改进度不写在本文件。

## 分支映射
- 维护入口为 `main`；独立长期开发线未约定，专项用 `docs/`、`fix/`、`feat/` 等。

## 版本与产物映射
- 社区发布 SemVer 与 OpenAI 官方原生版本分开记录；Debian/RPM/pacman/Nix 的升级排序须有明确映射，不以截断日期版本完成转换。
- 用户界面名为 ChatGPT Community，包/路径身份为 `codex-desktop`；DEB 文件结构为 `codex-desktop_<包版本>_<架构>.deb`。
- 支持架构身份为 amd64 / arm64；这是社区再打包项目，不是单纯汉化包，不机械加 `-zh-CN`。

## 上游与适用例外
- 源码上游为 [ilysenko/codex-desktop-linux](https://github.com/ilysenko/codex-desktop-linux)。运行时来源只能是经签名与哈希验证的官方 Linux `chatgpt` 包。
- 保留根 AGENTS 的签名链、原始运行时、包身份和不执行上游维护脚本等约束。
- 产品本身含 Codex 的名称应保留；不把删除 AI 任务署名解释成改产品名称。
