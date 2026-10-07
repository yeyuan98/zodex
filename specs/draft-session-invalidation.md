# Spec: Draft Session Runtime Invalidation (3.15.0-alpha.2)

Status: **SHIPPED in `3.15.0-alpha.2`（PR #34，release `08089d7`，2026-10-07）——rig
D0-D3 收口（2026-10-07，分级记录见 §7：D0/D2/D3 log-evidenced PASS；D1 行为
PASS 且有 host 侧佐证，日志判据生产不可达 → §6 披露 + post-3.15.0 候选）；随
official `3.15.0` 切版（owner 裁定 2026-10-07：不出观测性 alpha.3，spec 同步
修订保持一致）；**3.16.0 PR1 rider §7.38②（2026-10-07）落地三缝
`logger.lifecycle.*` 修复，§6 观测缺口关闭（红测
`loggerLifecycleDraftInvalidation.test.ts` 3/3 绿）**。本 spec 收编既有失效行为为
不变量——该家族此前是纯代码事实，无 spec 承载；同时新增 MCP 变更源（R1：MCP 设置保存
不失效 pending draft，skills/plugins 均失效，MCP 漏网）。MCP 行红测先行
（`packages/ui/test/mcpStoreDraftInvalidation.test.ts`），实现随本批 W2 落地。[ulw] 评审
NEEDS-REVISION 已折叠（MAJOR：导入/远端同步两源补入；MINOR/NIT 同批）。**

Owners: 共享失效缝 `packages/ui/src/lib/zcodeDraftSkillInvalidation.ts`；消费方 = v4
prewarm coordinator（`packages/ui/src/v4/composer/useDraftSessionPrewarm.ts`）+ legacy
v3 `closeSession` 腿；本批新增 MCP 写缝 = `packages/ui/src/store/mcpStore.ts` 四写
action。Related: `bot-permissions.md`（不共享 seam，仅同批 train）。

## 1. 不变量（invariant）

改变 agent 运行时能力的设置变更必须失效 pending draft session。
`draftRuntimeInvalidationVersion`（`packages/ui/src/store/zcodeSessionStoreTypes.ts:166`，
bump 于 `zcodeSessionStoreWorkspaceSlice.ts:413` `invalidateDraftRuntime`）是**唯一失效
货币**；消费方在下次使用时对账重建：protocol-v4 prewarm coordinator
（`useDraftSessionPrewarm.ts:266-291` reconcile）按版本 retire 预热会话并按最新版本重建；
legacy v3 草稿经 `closeSession` 关闭（仅 web/replayable 受益；桌面 v4 draftSessionId
恒 null）。

## 2. 共享缝

`invalidateDeferredDraftSessionForRuntimeChange`：版本 bump **无条件**；`closeSession`
仅在 legacy draftSessionId 非空时调用（失败仅 warn，既有行为）。skills 家族便捷入口
`invalidateDeferredDraftSessionForSkillChange` 固定 logScope=`skills`。

## 3. 变更源清单（缺行 = 违反不变量；文件均在 packages/ui/src 下）

| 变更源                            | 入口                                                                                              | reason                                                              | 备注                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| skills 启停/删除                  | `settings/SkillsSection.tsx:382/:430`                                                             | settings-skill-enabled / settings-skill-delete                      | 既有                                                                                              |
| skills 导入/远端同步              | `settings/SkillsSection.tsx:970/:995`                                                             | settings-skill-import / settings-remote-skill-sync                  | 既有                                                                                              |
| 远端 skill 同步（sidebar/header） | `WorkspaceSidebarItem.tsx:1169` / `WorkspaceHeaderSections.tsx:733`                               | sidebar- / header-remote-skill-sync                                 | 既有                                                                                              |
| 插件安装/卸载/更新/启停           | `settings/PluginStorePage.tsx:259`                                                                | settings-plugin-enabled                                             | refreshAfterPluginChange 统一收尾，三路共用                                                       |
| 草稿建议提示插件变更              | `v4/ConversationDraftSuggestedPromptsContainer.tsx:269`                                           | suggested-prompt-plugin-change                                      | 既有                                                                                              |
| 远端插件同步刷新                  | `lib/remotePluginSyncRefresh.ts:111`                                                              | 调用方传入                                                          | 既有                                                                                              |
| hooks 增删改/启停/导入            | `settings/HooksSection.tsx:354`                                                                   | hook-added / -updated / -deleted / -enabled / -disabled / -imported | logScope=hooks，既有                                                                              |
| browser 插件启停                  | `settings/BrowserSettingsSection.tsx:122`                                                         | settings-browser-use-plugin-enabled                                 | 既有                                                                                              |
| settings-sync 导入                | `hooks/useSettingsSync.ts:469` 门                                                                 | settings-sync-skill\|mcp\|plugin-import（按首个命中类别）           | 门本批扩为 skills\|mcpServers\|plugins（类别同 union，形状统一；logScope=settings-sync 如实标注） |
| **MCP 增/存/删/开关（本批新增）** | `store/mcpStore.ts` 四写 action（add :416 / update :432 / delete :447 / toggle :479，store 层缝） | settings-mcp-add / -save / -delete / -enabled                       | 红测先行；四 action 全仓唯一调用方 = McpSettingsSection，无启动期误失效路径                       |
| **MCP 导入（本批新增）**          | `settings/McpSettingsSection.tsx` onImported 回调（McpServersImportDialog 直写磁盘）              | settings-mcp-import                                                 | 导入/远端同步不经 store 四写 action，回调补失效（skills 平权；[ulw] 评审 MAJOR 折叠）             |
| **远端 MCP 同步（本批新增）**     | `settings/McpSettingsSection.tsx` onMcpSynced 回调（RemoteSyncDialogs）                           | settings-remote-mcp-sync                                            | 导入/远端同步不经 store 四写 action，回调补失效（skills 平权；[ulw] 评审 MAJOR 折叠）             |

## 4. 排除项（守卫行）

- `mergePreloadedMcpServers`（`store/mcpStore.ts:692`）/ `deletePreloadedMcpServer`（:724）：
  今日全仓零调用方（仅 dist 类型产物），不在缝内；**获得调用方时必须纳入 §3 表**，防未来
  静默违反不变量。

## 5. 语义与失败披露

- user-scope 保存只失效当前活跃 workspace——与 skills/plugins 逐字平权（接受）。
- MCP 选 store 层缝（非 UI 调用点）：同时覆盖 settings 页与 `McpServerForm`（经 onSave
  委托父 handler，两方案等价）。
- 失效在持久化之后触发；磁盘持久化失败被 `persistScopedChange`（`store/mcpStore.ts:233`）
  warn 吞掉时失效仍然发生——多余失效 = 一次廉价重建，无害。

## 6. 观测（rig D1 判据；2026-10-07 rig 后修订；3.16.0 PR1 rider 后再修订）

新 MCP 缝每次触发打一条 `[mcpStore]` info 行（字段
`reason=settings-mcp-save|add|delete|enabled` + `workspacePath`）。helper 自身的
info 行是 legacy-only（v4 桌面 draftSessionId 恒 null，恒不出现），不得作判据。

**3.16.0 PR1 rider §7.38② 修复（2026-10-07）**：3.15.0 cut 时披露的观测缺口已
关闭——三缝（`mcpStore.ts` MCP 写 action info 行、共享 helper 成功腿 info /
失败腿 warn）全部改走 `logger.lifecycle.*`，经桌面桥**生产可达**（web 无桥
仍 no-op，仅桌面 rig 受益）。**scope widening 披露**：共享 helper 同时服务
skills/hooks/settings-sync 等域调用方（`useSettingsSync.ts`、`HooksSection.tsx`
等），这些域的同类行切换后同样变为生产持久化——owner 已接受（§7.1）。红测
`packages/ui/test/loggerLifecycleDraftInvalidation.test.ts`（3 用例）锁定三缝
判据。以下为历史披露，保留作裁决背景：

**生产可达性披露（alpha.2 rig 实证后修订，rider 前状态）**：`packages/ui/src/logger.ts` 在
生产构建（桌面与 web）对普通 `logger.*` 全级 no-op，仅 `logger.lifecycle.*` 经
桌面桥落盘——本缝现行 info 行**仅 dev 可见**。因此 rig D1 的日志判据在生产
不可达；D1 以行为验证 + host 侧佐证分级关闭（见 §7 rig 记录）。**已知观测
缺口 → post-3.15.0 候选池**：一行修复（`logger.info` → `logger.lifecycle.info`，
含两条回调缝同改），使 `settings-mcp*` 家族在生产可 grep。

## 7. 验收（红→绿 + rig 分级记录）

- `packages/ui/test/mcpStoreDraftInvalidation.test.ts`：四写 action 各自使
  `draftRuntimeInvalidationVersion` +1（今红）；无变更 action（`updateServerStatus`）
  不 bump（guard，今绿且 W2 后保持绿）。
- settings-sync 导入门为谓词级覆盖（`settingsSyncImportInvalidation.test.ts`，含未知
  类别 reason 不误标断言）；hook 缝无组件级测试（与既有 skills 门一致，评审核验）。
- MCP 导入/远端同步回调失效为评审核验（无组件测试基建，与 skills 同型先例一致）。

**rig D0-D3（2026-10-07，bundle zcode-logs-20261007-141821，alpha.2 @ `08089d7`）**：
D0/D2/D3 log-evidenced PASS（/help 576B 含三注记、/mode 选项表 341/340B 渲染并可
选择、两轮权限单提示单确认 pending 清零、附件缓存+sftp+attachmentReadV4 全通、
错误清扫零）。**D1 = 行为 PASS（owner 陈述，§8.1 分级）+ host 侧佐证**
（`mcp-sync.saveMcpToUserDirectory OK` 14:08:28 → 写 action 确证运行 → 失效
bump 按单测锁定的确定性路径随之发生）；指定日志判据行生产不可达（§6 披露）。
owner 裁定（2026-10-07）：不为此出 alpha.3，直接切 official 3.15.0，本 spec
同步修订保持一致。附带登记：无模型草稿上 `/mode` 回复 "Mode option not found."
（选模型后恢复，owner 裁定非阻塞）→ post-3.15.0 候选池。
