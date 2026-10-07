# Spec: Draft Session Runtime Invalidation (3.15.0-alpha.2)

Status: **DRAFT for `3.15.0-alpha.2`（unshipped，spec-first）。本 spec 收编既有失效行为为
不变量——该家族此前是纯代码事实，无 spec 承载；同时新增 MCP 变更源（R1：MCP 设置保存
不失效 pending draft，skills/plugins 均失效，MCP 漏网）。MCP 行红测先行
（`packages/ui/test/mcpStoreDraftInvalidation.test.ts`），实现随本批 W2 落地。**

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

| 变更源                            | 入口                                                                                              | reason                                                              | 备注                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| skills 启停/删除                  | `settings/SkillsSection.tsx:382/:430`                                                             | settings-skill-enabled / settings-skill-delete                      | 既有                                                                        |
| skills 导入/远端同步              | `settings/SkillsSection.tsx:970/:995`                                                             | settings-skill-import / settings-remote-skill-sync                  | 既有                                                                        |
| 远端 skill 同步（sidebar/header） | `WorkspaceSidebarItem.tsx:1165` / `WorkspaceHeaderSections.tsx:729`                               | sidebar- / header-remote-skill-sync                                 | 既有                                                                        |
| 插件安装/卸载/更新/启停           | `settings/PluginStorePage.tsx:259`                                                                | settings-plugin-enabled                                             | refreshAfterPluginChange 统一收尾，三路共用                                 |
| 草稿建议提示插件变更              | `v4/ConversationDraftSuggestedPromptsContainer.tsx:269`                                           | suggested-prompt-plugin-change                                      | 既有                                                                        |
| 远端插件同步刷新                  | `lib/remotePluginSyncRefresh.ts:111`                                                              | 调用方传入                                                          | 既有                                                                        |
| hooks 增删改/启停/导入            | `settings/HooksSection.tsx:354`                                                                   | hook-added / -updated / -deleted / -enabled / -disabled / -imported | logScope=hooks，既有                                                        |
| browser 插件启停                  | `settings/BrowserSettingsSection.tsx:122`                                                         | settings-browser-use-plugin-enabled                                 | 既有                                                                        |
| settings-sync 导入                | `hooks/useSettingsSync.ts:463` 门                                                                 | settings-sync-skill\|mcp\|plugin-import（按首个命中类别）           | 门本批扩为 skills\|mcpServers\|plugins（类别同 union，形状统一）            |
| **MCP 增/存/删/开关（本批新增）** | `store/mcpStore.ts` 四写 action（add :378 / update :392 / delete :405 / toggle :434，store 层缝） | settings-mcp-add / -save / -delete / -enabled                       | 红测先行；四 action 全仓唯一调用方 = McpSettingsSection，无启动期误失效路径 |

## 4. 排除项（守卫行）

- `mergePreloadedMcpServers`（`store/mcpStore.ts:644`）/ `deletePreloadedMcpServer`（:676）：
  今日全仓零调用方（仅 dist 类型产物），不在缝内；**获得调用方时必须纳入 §3 表**，防未来
  静默违反不变量。

## 5. 语义与失败披露

- user-scope 保存只失效当前活跃 workspace——与 skills/plugins 逐字平权（接受）。
- MCP 选 store 层缝（非 UI 调用点）：同时覆盖 settings 页与 `McpServerForm`（经 onSave
  委托父 handler，两方案等价）。
- 失效在持久化之后触发；磁盘持久化失败被 `persistScopedChange`（`store/mcpStore.ts:217`）
  warn 吞掉时失效仍然发生——多余失效 = 一次廉价重建，无害。

## 6. 观测（rig D1 判据）

新 MCP 缝每次触发打一条 `logger.info`（scope `[mcpStore]`，字段
`reason=settings-mcp-save|add|delete|enabled` + `workspacePath`）。因 v4 桌面
draftSessionId 恒 null、helper 自身的 info 行是 legacy-only，无此行 rig 无判据
（**D1 判据 = 此行**；helper 的 "invalidated deferred draft session" 行在 v4 桌面恒不
出现，不得作判据）。

## 7. 验收（红→绿）

- `packages/ui/test/mcpStoreDraftInvalidation.test.ts`：四写 action 各自使
  `draftRuntimeInvalidationVersion` +1（今红）；无变更 action（`updateServerStatus`）
  不 bump（guard，今绿且 W2 后保持绿）。
- settings-sync 导入 `mcpServers`/`plugins` 类别触发同一失效（W2 门扩展后转绿）。
