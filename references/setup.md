# 安装计划、启用与回退

先用本包 `scripts/ds-bot.ps1 status --json` 发现原实例。已有桥时直接复用；`PLUGIN_DIRECTORY_EXISTS` 是保护，不通过删除现有插件来绕过。这里的“安装”只给原实例增加桥，不安装 DS Bot 本体或依赖。

## 新实例接入的最小步骤

1. 用 `bots --json` 与 `resolve --bot <准确名称或ID> --json` 确认用户原团队中的真实目标。只发现元数据，不看无关聊天。
2. 校验包，再生成只读安装计划。`plan` 不写文件、不启用桥、不发送消息。

```powershell
node '<本 Skill 目录>\scripts\bridge.mjs' verify
node '<本 Skill 目录>\scripts\bridge.mjs' plan --allow-bot '<真实稳定Bot-ID>'
# 多个目标重复 --allow-bot。省略时允许列表为空，不自动选择任何 Bot。
```

3. 向用户展示计划：实际程序和数据位置、Bot 名称与 ID、配置差异、访问主体、备份与回退。明确该通道让当前 Windows 登录会话内其他本机进程也可使用，不是某个 Agent 专属。取得启用和目标范围的明确批准。
4. 用户正常退出原 DS Bot，并保持关闭。退出前只读和退出后计划的哈希须一致；若用户改了目标、文件、配置或权限，重新对账，不能沿用旧计划。
5. 使用同一列表和用户已批准的 `planHash` 启用：

```powershell
node '<本 Skill 目录>\scripts\bridge.mjs' apply '<已批准的planHash>' --allow-bot '<完全相同的真实稳定Bot-ID>'
```

6. 成功后等待至少两秒，正常打开同一个 DS Bot。先核验原团队界面与 `bridge.ready:true`，再考虑另获精确目标／内容批准的发送测试。接受请求不等于已回复。

没有管理员提权、Token、账号登录、网络修改或自动启动步骤。依赖缺失时说明缺口，不自动下载安装。

## 实际修改

- 只给原 profile 的 `cordis.patch.yml` 追加一个带标记的块：禁用原 Loader 的 Bot 行，由本地包装入口启动同一个原运行时。
- 原 profile 下增加 `local-plugins/ds-dot-bridge`。源码是包内受校验的 `assets/bridge`；前端 `client.js` 从接收机器自己的原 `resources/app.asar` 有界读取，必须命中固定 SHA-256，原 ASAR 不变。
- 原 dataDir 下增加 `integrations/ds-dot-bridge`，存放私有备份及仅含元数据的收据；新目录仅当前用户与 SYSTEM 可访问。现有 profile 权限保持原样。
- `policy.json` 在启用时生成，绑定本机实例与用户批准的 Bot ID。ZIP 不含现成策略、端点或令牌。
- `activation.complete.json` 最后写入，旧 Host 不能靠热重载激活；必须冷启动。运行时检查原配置、源码及单实例条件。

运行时包装包保留原前端注册元数据，不含 `dsh.bundle`，以免额外创建运行时。安装前、运行时或源码校验失败可能使团队暂未加载；保留原备份，按下述回退，不反复启动或另建团队。

## 回退

保存启用结果的 `backupId`。用户明确要求回退后，正常关闭原 DS Bot：

```powershell
node '<本 Skill 目录>\scripts\bridge.mjs' rollback '<本机启用时返回的backupId>'
```

只接受原配置、精确激活配置，或 DSH 对新增块中同一双引号路径做的等价换行与空行。原配置前缀必须逐字节相同；目标路径、禁用字段、其他配置或权限变化都会停止，等待对账。不会覆盖后续工作。

回退恢复原补丁字节和权限，将禁用插件保留到私有备份，保留全部收据与未知发送记录。它不结束或启动应用，不降级 Skill、不清日志、不重放消息。成功后再正常启动原 DS Bot。

权限检查保留原始描述作为备份，严格比较所有者、组、每条权限、继承保护及其他标志。只允许 Windows 在文件替换后单向新增自动继承状态标记 `AI`；删除 `AI`、改变 `P`／`AR` 或任何权限条目均不接受。该边界有正反例及 Windows 原生文件测试，见 [Microsoft 控制标志定义](https://learn.microsoft.com/en-us/windows/win32/secauthz/security-descriptor-control)。

## 常见阻断

| 状态／错误 | 应对 |
| --- | --- |
| 找不到程序、原团队或版本不符 | 停止新接入，让用户提供原实例信息，不创建空实例 |
| `PLUGIN_DIRECTORY_EXISTS` | 复用已配置桥，核对维护归属；不覆盖 |
| `ALLOW_BOT_NOT_FOUND` | 重新读取真实 Bot 元数据，只接受稳定 Bot ID |
| `APPROVED_PLAN_CHANGED` | 重查文件、目标、版本和权限差异，不静默改批准哈希 |
| `CLOSE_EXISTING_DS_BOT_FIRST` | 让用户正常退出，不强杀任务 |
| `PROFILE_CHANGED_SINCE_ACTIVATION` | 保留现场、备份、当前配置与其他任务改动，再决定精确回退 |
| 桥未就绪但 HTTP 401 | 401 不授予绕过登录的权限；检查原应用与桥状态 |
