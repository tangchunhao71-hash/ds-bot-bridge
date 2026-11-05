# 来源与验证范围

本包基于 2026-11-04 在用户既有 Windows DS Bot 0.2.7 上开发并验证的 CLI、管道 helper、回复关联协议及运行时包装入口。四个 CLI 运行模块与五个桥静态文件按哈希原样复制，未携带该用户的访问策略、Bot ID、会话编号、收据、聊天内容、个人路径或批准记录。

原实现曾在真实既有实例上完成：受限发送、短等待超时后新进程按原编号续等、独立查询，以及正式交接的单次实际提交与关联回复。原团队前端启动也已修复并确认。历史整体回归 102 项通过；其后 CLI 的最终相关回归 12 项通过。这些历史结果不表示另一台机器已激活或新目标已获批准。

导出时仅改造安装入口和相对目录，提供：

- 显式 `--allow-bot`，默认空列表，并核对原团队真实 Bot 元数据；移除开发机目标。
- 浏览器资源从接收方已有 ASAR 提取并校验固定哈希，ZIP 不复制原应用、浏览器资源或依赖。
- 回退仅额外接受 DSH 对新增块中同一个双引号路径的等价换行，保持原配置前缀和所有字段；未知变更继续阻断。
- 根目录 `BUILD.json` 覆盖包内静态文件；CLI 的 `bin/SHA256SUMS` 独立覆盖四个运行模块。

包内 `tests` 使用合成元数据、内存状态或临时文件验证协议、前置未提交、重复发送保护、安装参数、源资源读取和回退边界。它们不调用原团队发送，不创建 Bot 实例，不运行真实启用或回退。

2026-11-05 导出验证：78 项相关测试全部通过，无失败或跳过；原安装中的 1,311,029 字节前端资源可由本包的只读提取器正确读取，命中固定哈希，未执行或改写原应用代码。

```powershell
node scripts/bridge.mjs verify
node --test --test-concurrency=1 tests/send-protocol.test.mjs tests/cli-transport.test.mjs tests/bridge.test.mjs tests/activate.test.mjs tests/activation-files.test.mjs tests/export-package.test.mjs
```

安装器、包装入口与 CLI 均只用既有运行环境及 Node／Windows 标准接口。无需 `npm install`；`assets/bridge/package.json` 是原应用内的兼容元数据，不是让外部另装运行时的指令。

本次导出没有在生产实例重新安装、改策略、重启或发送。新机器的实际启用与真实消息验证仍须沿本 Skill 的批准流程完成。安装后必须检查原界面与真实只读链路，不能以合成测试替代。
