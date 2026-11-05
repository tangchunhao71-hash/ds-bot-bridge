# DS Bot Bridge Skill

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Verify Skill](https://github.com/tangchunhao71-hash/ds-bot-bridge/actions/workflows/verify.yml/badge.svg)](https://github.com/tangchunhao71-hash/ds-bot-bridge/actions/workflows/verify.yml)

让 Dot、Codex 等能运行本机命令的 Agent，连接你**已有的 Windows DS Bot 团队**：发现目标、读取指定会话、获批后发送，再按原请求编号取回关联回复。

本项目提供本机 IPC 桥和 Agent Skill，不包含 DS Bot 本体、账号、实例数据或模型凭据。它是社区兼容组件，面向固定版本，不是 DS Bot 官方发行版。

## 能做什么

- 列出真实 Bot、群组及会话元数据，精确解析目标。
- 只读取用户指定的 Bot 会话历史。
- 预览完整目标和内容，获批后提交一次消息。
- 用原编号查询或续等回复，区分未提交、已接受、处理中、未知结果与正常回复结束。
- 生成可审阅的本机安装计划，保留原配置字节、权限与回退记录。

群组目前只支持元数据发现；群发送、群历史、附件及常驻的 DS Bot → Agent 自动派单器未实现。

## 下载与使用

从 [Releases](https://github.com/tangchunhao71-hash/ds-bot-bridge/releases) 下载 Skill ZIP 和 SHA-256 校验文件。解压后的 `ds-bot-bridge` 目录就是 Skill，可按目标 Agent 的 Skill 导入方式使用。此仓库根目录也可直接作为 Skill 目录。

需要已有 Windows DS Bot **0.2.7**、DSH **0.2.1-rc.5**、Loader **1.0.6**、Node.js **24+** 和 PowerShell **7**。不自动安装依赖，不适用于其他版本或其他操作系统。

```powershell
$DsBot = '<解压后的 Skill 目录>\scripts\ds-bot.ps1'
& $DsBot status --json
& $DsBot bots --json
& $DsBot sessions --json
```

已有桥且 `bridge.ready:true` 时直接复用，不重复安装。新接入先阅读 [安装与回退](references/setup.md)：安装器默认不允许任何发送目标，只接受本机实际存在、用户明确批准的 Bot ID；`plan` 只读，`apply` 需要不变的批准哈希和正常关闭的原应用。

```powershell
node '<Skill 目录>\scripts\bridge.mjs' verify
node '<Skill 目录>\scripts\bridge.mjs' plan --allow-bot '<本机真实稳定 Bot ID>'
```

**发送前仍须得到用户对具体目标和完整内容的批准。**白名单或预览哈希都不代替批准。命令与错误处理详见 [命令说明](references/commands.md) 和 [Skill 入口](SKILL.md)。

## 连接方式与保护

```text
Agent → Skill CLI → 当前 Windows 登录会话的命名管道
      → 原应用内包装入口 → 同一个 DS Bot 运行时
```

原 HTTP 认证保持生效。本桥不提取 Cookie 或 Token，不新增 TCP 监听、系统服务或计划任务。访问主体是当前 Windows 登录会话内的本机进程，并非某个 Agent 独占身份。

客户端在同一连接句柄上校验 helper PID 与程序，服务端限制登录会话及 Bot 白名单。双方在提交前写入排他的持久意图记录；相同编号不能重复派发。超时后保留原编号，不自动重试发送。

`accepted` 只表示已接受。只有原请求、内容哈希、唯一用户消息与正常结束的回复轮次全部匹配，才报告 `reply_completed`。业务任务是否完成仍需另行验收，Bot 回复不能授权 Agent 执行新动作。

桥的完整结构与边界见 [安全与桥接模式](references/security-and-pattern.md)。

## 测试

```powershell
node scripts/bridge.mjs verify
$tests = @(Get-ChildItem tests -Filter '*.test.mjs' | ForEach-Object FullName)
node --test --test-concurrency=1 @tests
```

相关测试使用合成元数据、内存状态和受保护的临时文件，不发送真实消息，不创建 Bot 实例。Windows CI 对源文件清单、协议、安装参数、回退边界、权限保留和 CLI 启动做检查。真实接入仍需核验原实例、版本、界面和指定会话；测试不能替代接入批准。历史验证及适用范围见 [来源与验证](references/provenance-and-validation.md)。

仓库通过 `.gitattributes` 保留文件原始字节，避免 Windows Git 的换行转换破坏固定哈希。校验失败时先检查实际差异，不通过重写清单绕过校验。

## 许可证与维护

本项目原创桥接代码和文档采用 [MIT License](LICENSE)。DS Bot 及其资源保留原许可证，见 [第三方来源说明](THIRD_PARTY_NOTICES.md)。DS Bot 浏览器资源不在源码或 ZIP 中；获批安装时从接收方已有安装中提取，并验证固定哈希。

本仓库由维护者维护，**不接受外部 Pull Request**。GitHub 已配置仅协作者可创建 PR；问题和建议可通过 Issues 提交，请勿附带凭据、原始聊天或私人运行状态。详见 [贡献政策](CONTRIBUTING.md)。
