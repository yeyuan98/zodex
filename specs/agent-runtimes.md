# Spec: Agent Runtime Self-Sufficiency（3.16.0 train：pathPrepend 环境缝 + runtime_unavailable 闭环 + bundled 配置/运行时技能）

Status: **SHIPPED in `3.16.0-alpha.1`（PR #40，release `bb40344`，tag
`v3.16.0-alpha.1`，2026-10-07）——rig T0-T9 PENDING（owner 裁定延后；随 PR #40
正文执行）。** alpha.1 范围 = `.agents/mcp.json` 运行时腿接线：
§5.1-§5.5 为**权威节**（四源逐名合并 + 全序钉死 + 同一 strict schema + hook 接缝钉死 +
desktop 三位点共享 helper + §7.40 fold-in 披露）+ S1/S2/isolation 行技能修正；依据 =
权威计划 `../ZCode-runtime-alpha1-plan.md` v1（EXECUTED；owner GO = Option A 使等价
成立 + [ulw] 计划评审折叠账全收，handoff §7.39/§7.40）。**§5 alpha.0 版的「四文件合并/
两腿等价/isolation 由 `.agents` 腿携带」表述已被 alpha.0 rig postmortem（handoff
§2m）证伪，随本修订废除——勿据旧版实现。** 原 PR2（A1 发布资产 / A2 设置页下载卡 /
C3 app 级 PATH 前插）**顺延 alpha.2+**（重编号记账，[ulw] n2）。
**alpha.2 范围（in progress）= A2′（上游直采下载器）+ 设置页 MCP 区「运行时环境」卡
（生命周期 + 镜像速率排名展示与切换）+ C3（app 级 L3 前插 + 镜像缺省填空 + Bash 腿）**；
A1（自有 release 资产）**整体废除**（owner 裁定 2026-10-08，`../ZCode-runtime-alpha2-plan.md`
§2.0——运行时工件不经我们的发布渠道再分发，下载器直采上游）。本修订收编其语义边界
（§2.5 L3、§4.2、§4.6、§9 残留表）并落定实现契约（§2.5 L3 实现契约、§4.7）。
红测清单见 §8（alpha.2 批）。

Owners:

- **stdio spawn env 漏斗唯一所有者** = `apps/zcode-cli/packages/adapters/src/mcp/index.ts`
  `createTransport`（L5 pathPrepend 前插点）+ `adapters/src/mcp/network.ts`
  `buildMcpStdioEnv`（L2；PR2 C3 的 L3 同漏斗）。spawn 失败分类（C2 producer）同文件
  `connectWithStatus` 一带。
- **协议契约** = `packages/shared/src/zcode-protocol/index.ts`
  （`zcodeProtocolMcpServerSchema` strict 增量 + `zcodeRuntimeCapabilitiesSchema`
  capability flag）；`packages/shared/src/mcp.ts`（`McpServerConfig` TS 面）。
- **CLI 配置装载腿** = `apps/zcode-cli/packages/adapters/src/config/schema.ts`
  （`mcpStdioServerSchema` strict 增量 + 既有 per-server 丢警告环复用）；
  **下行 mapper** = `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/protocol-mcp-config.ts`
  （逐字段拷贝补 `pathPrepend`）；**运行时类型** =
  `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts`。
- **runtime.json / CURRENT 指针 = 文件系统所有者**：ws 级 = `<ws>/.zcode/.runtime/`
  （S1 技能写入）；app 级 = `<config>/.runtime/`（PR2 A2 写入，`setDataBaseDir()`/
  `ZCODE_DATA_BASE_DIR` 解析，与 C3 读取同源）。
- **desktop 设置表单 = FormState 所有者** = `packages/ui/src/settings/mcpSettingsShared.ts`
  （FormState 显式承载 pathPrepend + 表单↔JSON 往返契约）；**三个下发点门** =
  `packages/services/src/zcode-agent/zcodeAgentService.ts`（session create / session
  resume / mcp/list，capability-gated）。
- **bundled skills 四清单** = `apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts`、
  `apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs`、
  `scripts/prepare-prebuilds.mjs`、`packages/desktop/scripts/prepare-agent-node-bundle.mjs`；
  **钉测** = `packages/desktop/test/bundledSkillsPin.test.ts`（本 spec 新增，此前无任何
  测试钉 bundled-skills）。
- **Riders（W4 独立 commit）**：logger 三缝 = `packages/ui/src/store/mcpStore.ts` +
  `packages/ui/src/lib/zcodeDraftSkillInvalidation.ts`；/mode 文案 =
  `packages/services/src/bots/botsService.ts` + `packages/services/src/bots/messages.ts`。
- **`.agents` 运行时腿（alpha.1）四源装载唯一所有者** =
  `apps/zcode-cli/packages/adapters/src/config/config-factory.ts`（`createConfig` /
  `resolveEffectiveMcpServers`：project `.zcode`（沿 `discoverWorkspaceHookConfigPaths`
  既有候选）+ project `.agents` + user `.zcode` + user `.agents` 逐名合并，§5.1）；
  **hook 接缝所有者** = `packages/shared/src/workspace-hook-config.ts`
  （`buildWorkspaceHookCandidatePaths` 不得引入 `.agents/mcp.json`，§5.3）。
- **desktop 显示合并（alpha.1）共享纯函数 helper**：三位点统一调用——
  `packages/services/src/mcp-sync/mcpSyncService.ts`
  （`readDirectoryServersFromPreferredSources` + `collectEffectiveUserMcpRecords`）与
  desktop main 孪生 `packages/desktop/src/main/mcpUserDirectory/index.ts`（§5.4；禁止
  孪生复制粘贴）。

Related: `draft-session-invalidation.md`（MCP 写缝失效 + §6 logger.lifecycle 披露 =
rider A 前科）、`bot-permissions.md` §8.4（F4 mode 选项源 = rider B 同缝）、
`log-diagnostics-hygiene.md`（logger 分级惯例）。

## 1. 动机

3.15.0 后「聊天即配置」成为受支持姿势（权限面落地），但存在三缺口：

1. **agent 不知道配置文件契约**：`.zcode/config.json` 的 `mcp.servers`、`.agents/mcp.json`
   的 `mcpServers`、SKILL.md frontmatter——系统提示与 bundled skills 均无文档，模型只能
   靠训练记忆猜（`.agents` 惯例命中率尚可、`.zcode` 专有路径几乎必错）。
2. **issue #27**：无系统 Node/uv 的机器上 npx/uvx 类 MCP 全灭，且
   `runtime_unavailable` 枚举有值、i18n 有文案、**无 producer**——用户看到的只是泛化的
   「进程启动失败」。
3. **中国大陆网络**：nodejs.org / GitHub / PyPI / npm registry 直连慢或不稳，需要镜像
   探测-择优-固化，且校验必须跨源（代理永不作校验来源）。

目标：**agent 在任意工作区（含远程、无系统运行时、CN 网络）能自主完成 workspace 级
MCP/skills 配置与 npx/uvx 运行时供给，全程权限门控、零系统修改。**

## 2. C1 — MCP per-server PATH 注入缝（唯一协议/行为改动，PR1）

### 2.1 字段语义

stdio MCP server 配置新增 additive 可选字段 **`pathPrepend?: string[]`**：

- 元素支持 `~` / `~/` 前缀展开（CLI 与 desktop 两腿同一展开规则，展开基准 = 运行用户
  home；`~/...` 相对段照常拼接）。
- **绝对路径不变量**：展开后必须是绝对路径；否则该 server 配置无效（loud，永不静默
  丢弃、永不静默截断该元素）。
- 语义 = spawn 该 server 时把（展开后的）目录列表按序**前插**到最终 PATH 最左侧；
  元素间用平台 path separator 连接。**不变量「pathPrepend 最优先」**：应用点钉死在
  `createTransport` 构造 env 时、`...config.env` spread **之后**（见 §2.5 L5）——即使
  server 显式写了 `env.PATH` 整串替换，pathPrepend 仍然胜出。

理由（调查 A 结论）：现 `config.env.PATH` 是整串替换，教 skill 写全量 PATH 脆弱（杀死
node-dir prepend 与 login-shell PATH）；绝对 `command` 路径可用但对 copy-paste 来的
`command:"npx"` 配置无效，且 npm 子进程仍需 PATH。单一漏斗改动覆盖 CLI/desktop/remote
三形态。

### 2.2 三层层校验语义（必须逐层成立）

| 层                 | 位置                                                                 | 行为                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1) CLI 配置装载腿 | `adapters/src/config/schema.ts` `mcpStdioServerSchema` + :486-500 环 | 相对路径元素 → 该 server 整条**按既有 per-server invalid 机制丢弃 + warning 诊断**（code `config_mcp_server_invalid`，消息点名 pathPrepend/绝对路径语义）；复用现有 drop-with-warning 循环，**不新增第二条丢弃路径**。                |
| (2) desktop 源头腿 | `packages/ui/src/settings/mcpSettingsShared.ts` FormState/JSON draft | 输入时拒绝：JSON 粘贴含相对 pathPrepend 元素 → 校验错误提示（不进 FormState）；表单无自由文本入口（结构化承载）。                                                                                                                     |
| (3) 传输防御腿     | CLI `createTransport`（spawn 前）                                    | 展开（`~`）后非绝对 → **仅该 server 失败**并产出诊断（failureKind `config_invalid` 家族语义），会话其余 server 与整次请求不受影响。**禁止**整会话 `-32602`；**禁止**对 strict 协议 schema 做 value-refine（坏值不得复活整请求硬拒）。 |

### 2.3 六处同步面（任一不开即静默失效；前科 = timeoutMs/oauth/protocolVersion 三次同型剥除）

| #   | 文件                                                                                               | 角色                             | 不开的后果                                                                                         |
| --- | -------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | `packages/shared/src/mcp.ts` `McpServerConfig`（:24-48，有 index signature）                       | TS 契约面（desktop/services 侧） | 上游写入了字段但下游链路类型不可见，靠 `any` 透传                                                  |
| 2   | `packages/shared/src/zcode-protocol/index.ts` `zcodeProtocolMcpServerSchema`（:626-650，strict）   | 下行协议校验                     | 带 pathPrepend 的 mcpServers 触发 strict 未知键 → **整次 session create / mcp/list `-32602` 硬拒** |
| 3   | `apps/zcode-cli/packages/adapters/src/config/schema.ts` `mcpStdioServerSchema`（:74-83，strict）   | CLI 读 `.zcode/config.json`      | **整 server 连同警告被丢弃**（:486-500：unknown key → `config_mcp_server_invalid`）                |
| 4   | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/protocol-mcp-config.ts`（:12-27 逐字段拷贝） | desktop→CLI 下行 mapper          | 下行**静默剥除**（只拷 type/command/args/env/timeoutMs/isolation/protocolVersion）                 |
| 5   | `apps/zcode-cli/packages/contracts/src/interfaces/mcp.port.ts` `McpStdioServerConfig`（:48-54）    | CLI 运行时封闭 TS union          | spawn 侧类型不可见，实现期只能 `as` 突围                                                           |
| 6   | `packages/ui/src/settings/mcpSettingsShared.ts` FormState/formToConfig/jsonDraftToForm             | desktop 设置表单往返             | **用户在设置页改一次 args 保存即剥掉 S1 写入的 pathPrepend**（固定 FormState 重建、未知键全丢）    |

已核实非门（无需改）：`mcpSyncService` 读写为 raw JSON 透传（`mcpSyncService.ts:250-267`/
`:295-303`）；`mcpStore` `persistScopedChange` 无校验。

### 2.4 capability 门（降级语义）

下行 strict schema 命中未知键 = `-32602` 硬拒**整次会话创建**（`server-types.ts:220-231`
parseParams 抛错），非优雅降级——§7.36 先例（非 strict payload 静默剥字段）不适用。缓解 =
**capability-gated 下发**：

- `zcodeRuntimeCapabilitiesSchema`（shared index.ts:75-77，**非 strict** → 未知 flag 解析时
  剥除）新增 additive-optional `mcpPathPrepend?: boolean`；旧 CLI 对 `runtime/capabilities`
  响应不含该 flag → 解析后 falsy → desktop 关闭下发；新 CLI 上报 `true`。
- desktop 在**三个下发点**统一门控：session create（`buildSessionCreateParams`）、session
  resume（`buildSessionResumeParams`）、mcp/list（`listMcpServerStatuses` ~:3529；该命令可能
  经隔离进程 client 发送 ~:2885，该 client 也须能拿到 `runtime/capabilities` —— W2 已验证：
  隔离进程与 chat/plugin 泳道共用同一 app-server 入口，capabilities handler 无 lane 裁剪）。
  仅当连接的 CLI 上报 flag 才在 mcpServers payload 中携带 pathPrepend。
- **V4 载体防御性收口（[ulw] 评审 MAJOR-1 折叠）**：V4 `createSession` 命令 envelope 的
  `mcpServers` 与 v3 下行共用同一 strict 元素 schema（`zcode-protocol-v4/command.ts`），旧
  CLI 未知键同样 -32602 硬拒整条命令——`sendConversationCommandV4` 携带 mcpServers 的
  payload 一律经同一 `gateMcpServersPathPrepend` 门（当前无调用方携带，防御性收口）。
- `convertToZCodeAgentMcpServer` 对非字符串数组的 `pathPrepend` 做形状守卫（静默剥除、
  不整 server 拒绝——timeoutMs 前科同型语义），由 shared 协议契约测试覆盖。
- 本地 desktop 捆绑同版本 CLI（无 skew）；远程混版 = 已知瞬态残留（重连自动收敛，§9）。
- 能力探测沿 `independentPlanSupport.ts` per-client WeakMap 缓存先例。

### 2.5 spawn env 五层解析表（收编 runtime-plan 1.5.2；L3 = PR2 C3、L5 = PR1 C1）

符号约定：`<config>` = `setDataBaseDir()`/`ZCODE_DATA_BASE_DIR` 解析出的基址（默认
`~/.zcode`）；`<ws>` = 工作区根。

```text
L1 SDK getDefaultEnvironment（PATH/HOME/… 从 CLI 进程 env 拷贝）
L2 buildMcpStdioEnv = sanitize(进程 env) + applyNetworkEgressEnv(代理重放)
   + prependRunningNodeDirectory
L3 [C3/PR2] app 运行时版本化 bin 目录前插（读 <config>/.runtime/*/CURRENT）
   + 镜像 env 缺省填空（见下）
L4 config.env 逐键 spread（显式 env.PATH = 整串替换——既有语义，用户逃逸口）
L5 [C1/PR1] pathPrepend 目录前插（~ 展开后绝对路径）
最终 PATH 从左到右（两分支）：
  无 L4：L5 → L3 → L2(running-node 目录 → 系统 PATH)
  有 L4：L5 → L4（L3/L2 段已被整串替换消灭——既有语义，用户自担）
```

- **优先级不变量**：per-server `pathPrepend` >（PR2 起）ws `.zcode/.runtime` > app
  `~/.zcode/.runtime` > 系统 PATH。project 存在 → project 胜；`command:"npx"/"uvx"` 沿最终
  PATH 左→右找首个可执行，按命令自然混搭（ws 只装 node → `npx` 命中 ws、`uvx` 穿透
  app/系统），无需配置声明。
- **镜像缺省填空（PR2 C3 实现语义，此处收编边界）**：L3 不检查 config.env（其时不可见）
  ——「逐 server 可覆盖」由 L4 spread 顺序**结构性达成**（config.env 键后到即胜）；对进程
  env 的存在性检查须**大小写不敏感**（win `NPM_CONFIG_REGISTRY`）。
  「`sanitizeZCodeRuntimeEnv` 不剥 `npm_config_registry` 与 `UV_*`（仅剥 \*\_proxy/ca 族）」
  钉为单测事实，防未来 sanitize 扩名单悄悄破坏用户偏好。
- **Bash 工具（非 MCP spawn）**：ws 级 = agent 按 AGENTS.md 标记块自行 export（天然最高
  优先）；app 级 = host 侧 `buildRuntimeProcessEnvPatch` 追加（PR2）——两级不冲突。
- **L3 实现契约（alpha.2 C3）**：
  - **应用点** = `adapters/src/mcp/index.ts` `createTransport` 调用点，
    `buildMcpStdioEnv(...)` 输出**之后**、`...config.env` spread **之前**（外层包裹，形制同
    `applyPathPrependToEnv`；不改 `buildMcpStdioEnv` 内部——保持 `prependRunningNodeDirectory`
    守卫语义）。
  - **`<config>` 解析（adapters 不依赖 services）**：`env.ZCODE_DATA_BASE_DIR ?? homedir()`
    - `.zcode/.runtime`——与 A2′ 写入（services `paths.ts` 同一解析）**同源**；homedir
      fallback 必须保留（desktop 默认不注入该 env）。
  - **每次 spawn 同步读 CURRENT + runtime.json，不跨 spawn 缓存**（镜像切换/换版后下一次
    spawn 生效；`accessSync` 同步 IO 先例）。
  - **CURRENT 读端容错** = §4.3 同规：缺失/垃圾/悬空（指向已 GC 目录）→ L3 缺席 + warn，
    **禁止**回退扫描最高 `v<ver>` 目录。
  - **镜像缺省填空**：存在性检查在 **L2 输出 env** 上**大小写不敏感**进行；键已存在不覆盖；
    `config.env` 胜出由 L4 spread 顺序结构性达成；**填空值 = effective decision（§4.7
    override ?? probed）**。

## 3. C2 — `runtime_unavailable` producer（issue #27 的 UX 闭环，PR1）

- **触发条件**：stdio spawn 失败且 (a) 错误为 ENOENT 类、(b) command base-name ∈
  `{npx, npm, node, uvx, uv, python, python3}`（Windows `.cmd`/`.exe` 变体按 base name
  匹配）→ `failureKind: "runtime_unavailable"`。其余 stdio spawn 失败维持现状默认
  `process_start_failed`（`adapters/src/mcp/index.ts:806-807` 一带，producer 唯一缺失点；
  枚举 `MCP_SERVER_FAILURE_KINDS` 与 i18n 键 `settings.mcp.failure.runtime_unavailable` 均已存在）。
- **i18n 文案升级为可行动指引**：zh-CN + en-US 双语，指向 bundled skill
  **`zcode-workspace-runtimes`**（提示用户让 agent 执行该技能完成 ws 级运行时供给）。
  **不指向设置页运行时卡**——那是 PR2 A2 的产物，PR2 落地时再改写指路（本 spec 记账）。
- **不做**：自动安装（agent/用户决策，不静默下载）；`process_start_failed` 等其余分类的
  语义不动。

## 4. S1 — bundled skill `zcode-workspace-runtimes` 契约（PR1，W3 实现）

内容 = 一份可执行 playbook（SKILL.md + patterns.md + examples.md，沿 dynamic-workflows
结构；**英文正文**——owner 裁定，agent-facing 惯例）。以下语义为契约（技能文案必须
忠实承载，不得弱化）：

### 4.1 镜像探测与择优（收编 runtime-plan 1.5.1；同一算法双实现：S1 curl 版 / A2 TS 版）

**候选表**（五类工件**各自独立探测**——最快 PyPI ≠ 最快 node dist；origin = 官方源；
proxy = 仅传输层，永不作校验来源）：

| 工件类                | 候选顺序                                                                                                         | 探测路径（小字节 Range GET）              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| node dist             | `nodejs.org/dist`（origin）→ `registry.npmmirror.com/-/binary/node` → tuna（陈旧，仅探测位，命中须校验版本存在） | `<base>/v<pinned>/SHASUMS256.txt` 前 64KB |
| uv release            | `github.com/astral-sh/uv/releases/download`（origin）→ `gh-proxy.com/<origin-url>` → `ghfast.top/<origin-url>`   | `<base>/<ver>/sha256.sum` 前 64KB         |
| PyPI index            | `pypi.org/simple`（origin）→ tuna → aliyun → tencent                                                             | `/simple/` 首 64KB（206/200 皆可）        |
| npm registry          | `registry.npmjs.org`（origin）→ `registry.npmmirror.com`                                                         | `/react` 首 64KB 或 `/-/ping`             |
| PBS（uv 托管 python） | `registry.npmmirror.com/-/binary/python-build-standalone`（首选）→ origin GitHub                                 | 目录 JSON 首 64KB                         |

**探测**：每候选一次 Range GET（`curl -r 0-65536 --max-time 5` 形；TS 版 = fetch +
AbortController 5s），记录 `{candidate, httpCode, latencyMs, ok}`，落日志（ws 级技能 →
会话输出逐行；app 级 A2′ = services 侧实现 → `createServiceLogger`（info/warn/error，经
host log relay 生产落盘），卡片/renderer 侧行 → `logger.lifecycle`）。**app 级探测日志
粒度 = 每轮探测一行汇总**（不逐候选刷屏）。失败/超时 = 淘汰。**探针版本来源**（消除「探测先于
钉版」循环依赖）：探针 URL 中的版本号 = runtime.json 上一轮钉住版本；首轮无记录时用
技能/下载器**内置 known-good tag**。探针只测传输延迟，不代表目标版本工件存在（tuna 陈旧行
「命中须校验版本存在」语义保留——版本不存在 = 该候选按失败处理）。

**择优规则（确定性）**：

1. origin 存活时，mirror/proxy 仅当 `latency(mirror) ≤ 0.6 × latency(origin)` 才胜出；
   否则 origin 胜（防「两者都快时白白信任第三方」）。
2. origin 失败/超时 → 存活候选中最快者胜。
3. 平局（±10%）→ 候选表顺序靠前者胜。
4. 全灭 → 明确报错并给出手工 `--base <url>` 覆盖位（技能参数 / runtime.json 手改字段），
   不静默选不可用源。

**固化与复用**：结果写 `<rt>/runtime.json`（两级各自一份）：
`{probedAt, ttlDays: 7, decisions: {nodeDist, uvRelease, pypiIndex, npmRegistry, pbsMirror},
measurements: [...]}`。**app 级 runtime.json = 本 schema 的扩展**（见 §4.7：另含
`overrides` 与 `pinned`，键名尽量与 S1 ws 级的 `versions.node/uv` 对齐）。**schema 分叉
披露**：S1 ws 级用 `versions.node/uv` + `manual` 决策旗标，app 级用 §4.7 扩展——两级文件
互不相通、读者不相交（实证 L3 只读 app 级），无互操作义务。**重探触发** = probedAt 超
TTL（7d）/ 显式 refresh / 所选源下载硬失败（此时按 measurements 中的次优顺位重试，全部
失败才重新探测）。

### 4.2 版本解析与跨源校验

- **版本解析在探测之后**：node 经 `nodejs.org/dist/index.json`（origin 小文件；失败用
  npmmirror 同名文件）解析精确 `vX.Y.Z`（**npmmirror `latest-*` 目录陈旧——实测坑，禁用**）；
  uv 经 GitHub API latest release；两者钉入 runtime.json 后才构造下载 URL。
- **跨源校验不变量**：tarball 来自 X，校验值必来自**另一源**——node：SHASUMS256.txt 取自
  「nodejs.org ↔ npmmirror 中的另一方」（tuna **永不作校验来源**）；uv：GitHub API asset
  digest 恒直连 `api.github.com`（直连不可达 = 明确报错并提示稍后重试/走 ws 级技能，
  **不降级为无校验**）；gh-proxy 系内容**永不 pipe 进 shell**、永不作为校验来源。
- **两级同一条不变量（alpha.2 起）**：app 级（A2′ 下载器）与 ws 级（S1 技能）使用**同一条**
  跨源校验不变量——本节上一条对两级均适用。原「自有资产（PR2 A1）校验锚点：构建期烧录
  sha256 进 app 资源」段随 A1 废除（owner 裁定 2026-10-08，plan §2.0）删除：运行时工件不经
  我们的发布渠道再分发，下载器直采上游，校验值 = 上游官方 sha（node SHASUMS256 跨源 / uv
  GitHub API digest），无 `runtime-manifest.json`、无烧录常量。

### 4.3 安装布局（版本化目录 + CURRENT 原子指针）

- `<ws>/.zcode/.runtime/node/v<X.Y.Z>/`（node+npm+npx 就位，win 平铺 / unix 保持 `bin/`）；
  `<ws>/.zcode/.runtime/uv/v<ver>/`（uvx 与 uv 同目录；win 平铺、unix 剥掉
  `uv-<triple>/` 顶层）。
- 各自同级写 `CURRENT` 纯文本指针文件（内容 = 版本目录名，写 `CURRENT.tmp*` →
  `fs.rename` 原子替换 = 同卷原子；win 侧 libuv rename = MoveFileExW
  REPLACE_EXISTING，读者只见旧或新、无半写）。
- **`pathPrepend` 与 AGENTS.md 块引用版本化 bin 目录**（绝对确定性，不依赖指针）。
- **CURRENT 读端容错**：缺失/不可解析/指向已 GC 目录 = L3 视为缺席 + `lifecycle.warn`，
  **禁止**回退扫描最高 `v<ver>`（会复活待 GC 版本）；启动时清理残留 `CURRENT.tmp*`。
- Windows 用系统自带 tar.exe 解压 `.zip`/`.tar.xz`；解压先落 `tmp` 临时目录再就位，成功后
  清理。

### 4.4 env 固化与 AGENTS.md 注记

- `UV_CACHE_DIR/UV_PYTHON_INSTALL_DIR/UV_TOOL_DIR/UV_TOOL_BIN_DIR` 收敛到
  `<rt>/uv/…`；`UV_PYTHON_INSTALL_MIRROR=npmmirror PBS`、`UV_DEFAULT_INDEX=<择优 pypi>`、
  `npm_config_registry=<择优 registry>`（**小写优先**——npm env 大小写不敏感但 run-script
  内小写胜出，实测结论）。
- 成功后向 `<ws>/AGENTS.md` 追加**幂等标记块**（`<!-- zcode-runtime:start/end -->`），内容 =
  每次 agent 会话使用运行时的 PATH/env 指引（per-OS 三段：bash/PS/cmd）；尊重 100KB 上限
  （接近时提示，不静默截断）。

### 4.5 MCP 接线

新写/改写 `.agents/mcp.json` 条目带 `pathPrepend`（C1）+ 镜像 env；对存量
`command:"npx"/"uvx"` 条目同样补 `pathPrepend`。目标文件两腿任一（alpha.1 起等价，
§5.1）；同名冲突时 `.zcode` 腿逐名胜出、user 级遮蔽 workspace 级——S1 文案必须
携带该冲突注记。

### 4.6 生命周期矩阵（收编 runtime-plan 1.5.3）

| 操作    | ws 级（S1 技能，agent 执行）                                                                                                          | app 级（PR2 A2 设置卡，TS 下载器）                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install | 探测→钉版→下载→跨源校验→解压到 `v<ver>/` →写 CURRENT→接线（AGENTS.md 块 + pathPrepend + 镜像 env）                                    | 探测（五类工件候选表，§4.1）→经上游版本解析（node dist `index.json` / uv GitHub API latest）→下载→跨源校验（§4.2 同一条不变量）→解压 `v<ver>/` →写 CURRENT→`--version` 冒烟                                                                                                                                             |
| status  | runtime.json（版本/镜像/probedAt）；技能教读取与判读命令                                                                              | 卡片：已装版本（CURRENT）+可用版本（上游解析）+最近验证结果+探测摘要（五类 × 候选延迟排名）+镜像切换                                                                                                                                                                                                                    |
| test    | 技能 Verify 节：`node --version` / `npm config get registry`（验镜像 env 生效）/ `uvx --version`；再触发 MCP 设置页 mcp/list 重探     | 「重新验证」按钮：重跑 `--version` 冒烟 + 刷新 MCP 状态列表（复用既有 mcp/list 重探）                                                                                                                                                                                                                                   |
| update  | 重跑技能→新版本装进**新 `v<ver>/` 目录**→重写 CURRENT（rename 原子）→重写 pathPrepend/AGENTS.md 块/runtime.json→旧目录 best-effort GC | 「检查更新」：重解析上游 latest（node index.json / uv GitHub API）与 runtime.json `pinned` 比对→新版本目录就绪→**CURRENT 原子换指针**→旧目录 GC（Windows 文件锁 → 保留、下次启动重试 GC；运行中 MCP 进程 POSIX 下持旧 inode 自然续命，win 下旧目录留存至进程退出）。**运行时更新不随 app 版本**——上游发现任意时刻可进行 |
| remove  | 技能 Teardown 节：删 `.zcode/.runtime/` + 摘除 AGENTS.md 标记块 + 清 MCP 条目 pathPrepend/镜像 env + 下一任务验证回落                 | 卡片「删除」：确认对话框→删目录与 runtime.json→解析回落（系统 PATH 或 ws 级）；运行中服务器说明（下一任务生效）                                                                                                                                                                                                         |

原则：**版本化目录 + CURRENT 原子指针**让 update 永不出现半状态；删除与换版对运行中进程
的影响 = POSIX inode 自然续命 / win 延迟 GC，均无强制重启要求（披露）。**GC 重试归属**：
app 级 = desktop main 启动时扫 `<config>/.runtime/*/` 清理无指针引用且已过宽限期的版本目录；
ws 级 = 技能 best-effort、无重试钩子（披露）。

### 4.7 A2′ 实现契约（app 级上游直采下载器；alpha.2）

- **归属**：`packages/services/src/runtime-tools/` 新子模块 `local-runtime/`（探测/版本解析/
  下载/跨源校验/解压归一化/CURRENT/更新/GC/重验 + runtime.json 读写）。UI 卡经服务 seam
  消费；adapters 的 L3 读取**不 import services**（§2.5 `<config>` 解析同源约束）。
- **app 级 runtime.json = 决策与状态唯一持久层**（`<config>/.runtime/runtime.json`），
  schema = §4.1 的扩展：`{probedAt, ttlDays: 7, decisions: {nodeDist, uvRelease, pypiIndex,
npmRegistry, pbsMirror}, overrides: {…同形，用户切换项}, measurements: [...], pinned:
{node, uv}}`（键名对齐披露见 §4.1 固化与复用）。
- **effective decision = `override ?? probed`**：卡内镜像切换 = 写 `overrides`，优先于探测
  决策。重探触发（TTL 7d / 显式 refresh / 所选源下载硬失败按次优顺位重试）**只作用于无
  override 的决策位**。
- **写读契约**：(i) runtime.json 写入 = tmp + rename 原子（L3 每 spawn 解析，半写 JSON
  不可见）；(ii) 读端容错与 CURRENT 同规——缺失/损坏 = treat-as-absent + warn，**不猜**；
  (iii) **更新顺序不变量**：新 `v<ver>/` 目录就绪 → 写 runtime.json（pinned）→ CURRENT
  原子换指针 → 旧目录 GC（stale pinned 只影响卡片/检查更新显示，有界）；(iv) **override
  源硬失败 = 明确报错 + 保留 override**，绝不静默回落到用户已弃用的源。
- **探测全五类工件**：install 相关（nodeDist/uvRelease）+ 填空相关（npmRegistry/pypiIndex/
  pbsMirror）——镜像切换与 L3 缺省填空依赖后三类。
- **校验锚点**：tuna 永不作校验来源；node 双锚点（nodejs.org + npmmirror）均不可达 =
  明确报错，不降级为无校验（与 uv `api.github.com` 规则**对称**）；uv digest 恒直连
  `api.github.com`，不可达 = 明确报错。
- **GitHub API 匿名调用**：匿名限流（60 req/h）对偶发检查足够；命中限流 = 明确报错稍后
  重试。
- **日志通道**：services 侧 `createServiceLogger`（info/warn/error；每轮探测一行汇总，
  经 host log relay 生产落盘），renderer 卡片行 `logger.lifecycle`（§4.1）。

## 5. S2 — bundled skill `zcode-config-reference` 契约（alpha.0 落地；alpha.1 修正假等价）

内容 = 配置契约参考（纯文档型 skill，**英文正文**）。MCP 文件腿的读取、合并与冲突
语义以 §5.1-§5.5 为**权威**（skill 文案必须忠实承载，不得弱化；技能内容测试钉不变量
而非逐字）：

- **MCP 配置路径表**：四文件 = ws 级 `<ws>/.zcode/config.json`（`mcp.servers`）与
  `<ws>/.agents/mcp.json`（`mcpServers`）、user 级 `~/.zcode/cli/config.json` 与
  `~/.agents/mcp.json`（描述符 `mcpSyncService.ts:43-59`）。四文件**都被读取并参与
  逐名合并**（§5.1）；skill 必须陈述**同名冲突规则**：同 scope 内 `.zcode` 腿胜出、
  user 级同名条目遮蔽 workspace 级（= S1 事故模式，明说）。
- **字段表**：`command` / `args` / `env` / **`pathPrepend`**（C1，含 `~` 展开与绝对
  路径不变量）/ `type` /（http 形态 `url`/`headers`）；**isolation 行**：仅协议形状
  （`zcodeProtocolMcpServerSchema`）携带，**两条文件腿 strict schema
  （`mcpStdioServerSchema`）均不接受**——写入任一文件 = 整 server 丢警告（§5.2）。
- **下一任务生效语义**：MCP server 配置改动对**下一次任务**生效（运行中任务保持其已装配
  能力集）。
- **prewarm 失效边界**：agent 直改文件**不触发**桌面 draft 失效缝
  （`draft-session-invalidation.md` 的缝在桌面写 action / 设置页回调上）——已知残余
  （3.15.0-alpha.2 起登记），技能建议「改完配置后开新任务」。
- **Skills 契约**：`<ws>/.zcode/skills/` 与 `<ws>/.agents/skills/`（+user 两根）；SKILL.md
  frontmatter 契约（`name` 必填、`description` 存在 frontmatter 时必填且 ≤1024、
  `when_to_use` 可选——`adapters/src/skills/index.ts:21-27` SAFE_FRONTMATTER_KEYS =
  name/description/when_to_use/license/metadata）；新技能下一会话出现在技能清单。
- **Plugins vendoring 边界**：插件携带的 MCP 定义与 skills 可 vendoring 到 ws 级配置
  （等价生效），但插件本体安装依赖 zodex 全局（`~/.zcode/cli/plugins` +
  `installed_plugins.json` 注册表，marketplace 来源），手改不安全不支持的结论**明说**；
  指引 =「要 MCP/skills 能力 → ws 级 vendoring；要插件完整体验 → 桌面插件商店」。
- **交叉引用 S1**（需要 npx/uvx 运行时时）。

### 5.1 「`.agents` 运行时腿」— 四源发现与逐名全序（权威）

CLI 运行时（spawn MCP server 的进程）的 MCP 配置装载 = **四源逐名合并**，
owner = `config-factory.ts`（沿既有 `resolveEffectiveMcpServers` 的
user-shadows-project 扩展）：

- **四源**：project scope = `<ws>/.zcode/config.json`（含既有 `zcode.json` 候选与
  文件内顺序，沿 `discoverWorkspaceHookConfigPaths` 祖先向上发现）+
  `<ws>/.agents/mcp.json`（键 `mcpServers`）；user scope =
  `~/.zcode/cli/config.json` + `~/.agents/mcp.json`。
- **逐名合并（merge-not-fallback；先例 `skills/roots.ts:99`）+ 全序钉死**：
  `project .agents < project .zcode（zcode.json → .zcode/config.json，既有顺序）<
user .agents < user .zcode < env < cli`。同 scope 内 `.zcode` 胜出 = desktop 强偏好
  语义从**文件级**收窄为**逐名**（`.agents` 独有名不再被同 scope 非空 `.zcode` 整文件
  遮蔽）。**合并键 = 精确 server 名**（与运行时 exact-key 语义一致；不使用
  `normalizeMcpNameKey`）。
- **显式 `params.mcpServers` = 整替语义**：session create 显式携带非空
  `runtimeConfig.mcp.servers` 时**整体替换**全部文件腿（`resolveAppRuntimeConfig`
  `options.runtimeConfig?.mcp?.servers ?? configResult.config.mcp.servers` 缝，
  `bootstrap/src/app/runtime-config.ts:92-96`）——不与文件腿逐名合并。真实非空路径 =
  CUA resolver（`node.ts` 插件门）；desktop 常规会话创建不携带（alpha.0 rig 全天
  `paramMcpServerCount:0`）。
- `enabled:false` 沿既有语义（`mcp/index.ts` + `pool.ts` 已处理，装载保留条目、
  运行时不 spawn）。
- rig 门：E6（owner 场景：S1/S2 写 `.agents` → 下一任务 connected + 模型可见）、
  E7（冲突腿：同名 `.zcode` 胜出 + `.agents` 独有名加载 + user `.agents` vs
  project `.zcode` 全序）、E8（user 级两文件腿 + 设置页列表 = 运行时实际加载集 +
  导出/导入去重含 `.agents` 条目）。

### 5.2 同一 strict schema 解析（逐 server 丢警告）

`.agents` 条目与 `.zcode` 条目走**同一** `mcpStdioServerSchema`（strict）解析：
坏条目（未知键（含 alpha.0 S2 曾教写的 `isolation`）、相对 `pathPrepend` 元素等）
按既有 per-server invalid 机制**逐 server 丢弃 + warning 诊断**（code
`config_mcp_server_invalid`，消息点名文件与 server 名），其余条目照常装载——不新增
第二条丢弃路径，不做字段级 salvage。

### 5.3 与 workspace hook 发现的接缝（信任记录不可失效）

`.agents/mcp.json` 的发现是 **MCP 专用平行发现**，**禁入** hook 发现链：
`buildWorkspaceHookCandidatePaths` / `WorkspaceHookConfigFileKind` /
`projectSummary.hookCandidates` / hook bundle snapshot / digest
（`workspace-hook-digest.ts` 的 `bundleDigest` 以 hookCandidates 为输入）。否则加一个
`.agents/mcp.json` 即改变 `bundleDigest` → 既有 workspace 信任记录全部失效、用户被
重新弹信任。钉测：加/删 `<ws>/.agents/mcp.json` 前后 `bundleDigest` 与
`sources.project.paths` 不变。

### 5.4 desktop 三位点显示合并（共享纯函数 helper）与写路径语义

- **三位点**统一改为逐名合并（同 scope `.zcode` 胜出、`.agents` 独有名可见）：
  `mcpSyncService.readDirectoryServersFromPreferredSources`、
  `mcpSyncService.collectEffectiveUserMcpRecords`（喂 `listLocalUserMcpCandidates` /
  `exportMcpServers` / `listRemoteUserMcpStatuses` / `importMcpServers` 去重）、
  desktop main 孪生 `desktop/src/main/mcpUserDirectory/index.ts`
  `readDirectoryServersFromPreferredSources`。实现 = **一个共享纯函数 helper**
  （services 与 desktop main 共同调用；孪生分叉正是本 bug 类成因，禁止再复制粘贴）。
- **写路径不变**：upsert/delete 恒写 `.zcode` 腿（`saveMcpToUserDirectory` /
  `writeZCodeServersToFile`）；set-enabled 沿 `location` 写回源文件（`.agents` 来源行
  的启停写回 `.agents` 文件）。
- **语义披露**：设置页**删除**一个 `.agents` 来源行 = **僵尸复活**（源文件条目仍在，
  下次读取重新出现；「删除」实际只是把显示列表里的副本拿掉）；**保存副本**落 `.zcode`
  腿即逐名遮蔽源行。彻底移除须删源文件条目本身。

### 5.5 残留与披露（alpha.1 fold-ins，handoff §7.40）

- **(a) settingsSyncService 第四读点边界**：`SUPPORTED_MCP_AGENT_SOURCES` 的
  `.agents` 条目（`settingsSyncService.ts:406-411`）= **外部 agent import 候选**
  语义，不参与本统一。两条互作：① §5.4 合并后，import 去重缝对 `.agents` 条目的
  可见性随逐名合并变化（user `.zcode` 非空不再遮蔽 `.agents` 去重可见性）；② import
  对话框仍以「外部源」形式提供现已原生的 `.agents` 文件——import 恒写 user `.zcode`
  目标 → user 腿遮蔽 project `.agents` 条目。
- **(b) `params.mcpServers` 整替语义**：见 §5.1——显式非空参数替换全部文件腿（含
  W2 后的 `.agents` 条目），非合并。
- **(c) `.agents` 腿自动加载残留（行为变化披露）**：project scope MCP 沿既有自动信任
  语义；接线后 repo 自带 `<ws>/.agents/mcp.json` 与存量 `~/.agents/mcp.json` 将真实
  spawn（含 remote 主机）。此前这些文件从不进入运行时。
- **(d) strict-parse vs raw-read 分歧残留**：desktop 设置页读 `.agents` 为 raw JSON
  透传（无 schema 校验），schema-invalid 条目（含 alpha.0 S2 教写的 `isolation`
  条目）仍**显示**、仍可能被显式探针 connect，而运行时按 §5.2 丢警告——无迁移/
  回填，登记不修（彻底解 = 设置页 schema-invalid 行标红，Beyond 池）。
- **(e) 设置页「已连接」≠ 会话可用**：探针链路（`mcp/list` 显式下发）与运行时装载
  链路分离；§5.4 合并缩窄两者差集（显示集 = 运行时加载集）但探针成功仍不代表下一任务
  会话可用（下一任务生效语义 + (d) 分歧）。
- **(f) mcpId 双身份登记不修**：探针链路 vs CLI 装载链路对同一条目产生不同
  `custom:<hash>` id（归一化化妆差异）；**发现广度不对称**：CLI 沿祖先向上走到
  worktree 根 vs desktop 显示仅读 ws 根——既有行为，披露。

## 6. Bundled skills plumbing（四清单 + 钉测）

- **四清单 = required-asset 门**（每个技能包文件都是必需资产，丢任何一个拒绝整包/中止
  构建，不装出引用文件缺失的技能）：新增 S1/S2 各自的 SKILL.md（S1 另含
  patterns.md + examples.md）后，四处同步追加：
  1. `apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts`
     `BUNDLED_SKILL_PACK_REQUIRED_PATHS`（:27-31）；
  2. `apps/zcode-cli/packages/cli/scripts/sea-bundled-skill-assets.mjs`
     `bundledSkillPackRequiredPaths`（:15-19，SEA 构建中止门）；
  3. `scripts/prepare-prebuilds.mjs` `remoteBundledSkillPack.requiredPaths`（:133-137，
     远端 stage）；
  4. `packages/desktop/scripts/prepare-agent-node-bundle.mjs` `bundledSkillPack.requiredPaths`
     （:118-127，桌面 agent node bundle）。
- **新增 root 级钉测** `packages/desktop/test/bundledSkillsPin.test.ts`（此前无任何测试钉
  bundled-skills）不变量：(a) 四个清单文件文本 ⊇ 全部 bundled 技能的 required 路径
  （磁盘 `apps/zcode-cli/packages/bundled-skills/skills/<name>/` 下每个目录）；(b) 磁盘侧
  每个技能目录有 SKILL.md；(c) 每个 SKILL.md frontmatter `name` 非空 + `description`
  ≤1024 字符。防「新技能上线漏改某条分发链」（dynamic-workflows 单技能时期无漂移风险，
  三技能起为真实回归面）。

## 7. Riders（W4 独立 commit；owner 2026-10-07 裁定随 PR1）

### 7.1 Rider A — logger.lifecycle 三缝（draft-session-invalidation.md §6 观测缺口收口）

三缝从普通 `logger.*`（生产 no-op）切到 `logger.lifecycle.*`（生产经桌面桥落盘）：

1. `packages/ui/src/store/mcpStore.ts:264` `logger.info("[mcpStore] draft runtime invalidated
after MCP settings change", …)` → `logger.lifecycle.info`；
2. `packages/ui/src/lib/zcodeDraftSkillInvalidation.ts:39` `logger.info(…invalidated deferred
draft session…)` → `logger.lifecycle.info`；
3. 同文件 `:46` `logger.warn(…close deferred draft session…failed)` →
   `logger.lifecycle.warn`。

**Scope widening 披露（接受）**：缝 2/3 位于共享 helper
`invalidateDeferredDraftSessionForRuntimeChange`（logScope 参数化），切换后 skills-scope
调用方（`invalidateDeferredDraftSessionForSkillChange` 等）的同类行同样变为生产持久化——
与 mcpStore 缝同族的生命周期事件，持久化面扩大 = 有意接受并在此披露。行为零变化（仅日志
通道）。

### 7.2 Rider B — 无模型草稿 /mode 文案（handoff §7.38③）

- **新消息键 `modeMissingNoModel`**（**不改既有 `modeMissing`**——它是其他空选项路径的
  共享缝）：en = "No model selected yet. Pick a model with /model first, then set the
  collaboration mode."；zh-CN = 「尚未选择模型：请先通过 /model 选择模型，再设置协作模式。」
- 经 draft `/mode` 选项缝的 no-model reason（`listDraftConfigOptions` :3272 `if (!model)
return [];` 一带）插装：无模型时 `getConfigCommandMissingMessageId` 家族按 no-model
  分支返回新键。**空选项行为不变**（仍不列选项——mode 依赖模型已在场，与 thoughtLevel
  平权；改变的只是文案）。
- **Guard test 更新预告**：现有 `botPermissions.test.ts` 场景22a2（:2294-2307）断言今日
  「未找到模式」文案——W4 落地时该断言**有意变更**为 no-model 新文案（行为对 no-model
  场景按裁定改变）；本批红测不修改该既有断言。

## 8. 验收（红→绿 + rig 概要）

- C1 契约红测（本批）：协议 schema 接受并保留 pathPrepend（`zcodeProtocolMcpServerSchema`
  / `zcodeSessionCreateParamsSchema`）；CLI 配置装载保留 server + 字段、相对元素 → 丢
  server + 诊断点名绝对路径语义；protocol-mcp-config mapper 保留字段；FormState↔JSON
  往返保留；capability flag 解析保留。
- C2 红测：两 locale `settings.mcp.failure.runtime_unavailable` 文案含
  `zcode-workspace-runtimes` 指路。W2 实现另配 producer 命令矩阵红测（ENOENT + 白名单 →
  runtime_unavailable；其余 → process_start_failed）。
- S1/S2 钉测（本批红）：四清单 ⊇ 三技能 required 路径；磁盘每技能目录有 SKILL.md +
  frontmatter name/description 契约。
- Riders 红测（本批）：lifecycle.info 收到 `[mcpStore]` 行（helper 腿 + store 写 action
  腿）；/mode no-model 新文案 zh/en。
- **alpha.1 红测（`.agents` 运行时腿，§5.1-§5.5；W1 先红，W2 转绿）**：
  CLI loader 腿——`.agents` ws 条目进入 runtime config（今日红：候选硬编码不含
  `.agents`）；同名双文件 `.zcode` 逐名胜出 + `.agents` 独有名共存；user 级
  `~/.agents/mcp.json` 腿生效 + user `.agents` 遮蔽 project `.zcode`（全序）；坏条目
  逐 server 丢警告且其余照常；`.agents` 条目 `pathPrepend` 保留；`enabled:false`
  保留；hook digest 加/删 `.agents` 前后不变（§5.3 契约钉测，今绿须保持绿）。
  desktop 三位点——`loadMcpFromUserDirectory` / `listLocalUserMcpCandidates` /
  `exportMcpServers` / desktop main 孪生逐名合并可见（今日红：文件级遮蔽）；
  import 去重缝对 `.agents` 条目可见（§5.5(a)）。技能不变量——S2 陈述同名冲突规则、
  S2/S1 无「isolation 被文件腿接受」表述、S1 接线节含冲突注记（今日红：alpha.0
  假等价文案）。契约钉测——`params.mcpServers` 整替语义（§5.1，今绿契约钉）。
- rig：E0-E2 + E4 随 PR1 正文发布（PR2 后补 E3/E5；清单见 runtime-plan Part 3）。E4 =
  破坏 PATH 复现 #27 → 状态行显示新文案（指路 S1）；按 S1 修复后下一任务恢复。
  alpha.1 rig 门 = E6-E8（§5.1；清单细化见 alpha1-plan Part 3）。
- **alpha.2 红测（PR2：A2′ + 镜像卡 + C3；W1 先红，W5/W6 转绿）**：
  1. sanitize 钉测（shared）：`npm_config_registry`/`UV_*`（多大小写形态）不剥；
     `*_proxy/cafile/ca` 族仍剥（含 `pnpm_config_ca` 形态）。
  2. L3 前插纯函数（adapters）：`ZCODE_DATA_BASE_DIR` 优先 + homedir fallback + 拼接
     `.zcode/.runtime`；CURRENT 有效 → PATH 序 L5→L3→L2；缺失/垃圾/悬空 → 无前插 +
     不扫目录。
  3. 镜像缺省填空（adapters）：effective decision（override 胜 probed）填
     `npm_config_registry`/`UV_DEFAULT_INDEX`/`UV_PYTHON_INSTALL_MIRROR`；L2 输出 env
     大小写不敏感存在性；已存在不覆盖。
  4. Bash 腿（services）：app 运行时在场（CURRENT 有效 + bin 存在）→ 追加 bin 目录 +
     填空；缺席 → null/不变。
  5. 探测择优纯函数（services）：origin 存活时 mirror 须 ≤0.6×origin-latency 才胜；
     origin 死 → 存活最快者胜；平局 ±10% → 候选表序；全灭 → 明确报错。
  6. 跨源校验选择（services）：node tarball 自 X → SHASUMS 取 nodejs.org↔npmmirror 另
     一方（tuna 永不作校验来源）；node 双锚点均不可达 = 明确报错；uv digest 恒
     `api.github.com`、不可达 = 明确报错（不降级无校验）。
  7. CURRENT 原子换指针 + GC（services）：tmp+rename（读者无半写）；无引用 + 过宽限期 →
     删除、被引用 → 保留；win 锁模拟 → 保留 + 标记重试。
  8. 解压归一化布局矩阵（services）：node win/unix 顶层剥离、uv win 平铺 / unix 顶层
     剥离、tar.exe 兼 .zip/.tar.xz。
  9. runtime.json 决策与覆盖（services）：override 优先；TTL/硬失败重探只作用于无
     override 位；tmp+rename 原子写 + 读端容错（缺失/损坏 = 缺席 + warn）；override 硬
     失败 = 报错 + 保留；更新顺序不变量（新目录→runtime.json→CURRENT→GC）。
  10. UI 卡（ui）：状态呈现（已装/可用/最近验证/排名）+ 安装/删除流进度事件 + 镜像切换
      写 overrides（沿 mcpStore/pluginManagementStore 测试形制，service seam 可注入）。
  11. C2 文案 pin 更新（ui）：两 locale `runtime_unavailable` 同时指路 S1 技能**与设置
      运行时卡**。
  12. 回归契约：`mcpSettingsPathPrependRoundTrip` 等既有钉测保持绿。

## 9. 残留与不做（披露）

- **alpha.1 残留与 fold-in 披露集中节 = §5.5**（settingsSyncService 第四读点边界 /
  `params.mcpServers` 整替 / `.agents` 自动加载行为变化 / strict-parse vs raw-read
  分歧 / 设置页「已连接」≠ 会话可用 / mcpId 双身份 + 发现广度不对称）。
- **remote 不自动供给 app 级运行时**：remote workspace 无桌面设置卡，运行时供给走 ws 级
  S1 技能（agent 执行）；PR2 A2 仅本地 desktop。
- **remote 混版窗口**：desktop 新、远端 CLI 旧 → capability flag falsy → pathPrepend 暂不
  下发（功能缺席但无硬拒）；重连部署匹配 bundle 后自动收敛。已知瞬态（§3e.4 同族）。
- **探针只测传输延迟**，不代表目标版本工件存在（tuna 陈旧坑由「命中须校验版本存在」兜）。
- **GitHub 整体不可达（对称约束）**：app 级**更新**与 uv 新版本安装不可用，与 ws 级同受
  上游限制（**对称披露**）；uv 校验锚点（api.github.com）不可达 = 明确报错，不降级为无
  校验；GitHub API 匿名限流（60 req/h）命中 = 明确报错稍后重试。
- **Bash 腿池化新鲜度（alpha.2 披露）**：`buildRuntimeProcessEnvPatch` 每 host 进程一次 +
  agent 进程按 workspaceKey 池化 → 安装/换版/**镜像切换**后**新 spawn 的 agent 进程**才
  生效（agent spawn 缝重算 app-bin 追加段**与**镜像填空值两段）；池内复用进程需回收/
  重连后才反映新环境。
- **`ZCODE_DATA_BASE_DIR` shell-export 边角（披露不修）**：settings dataBaseDir 显式 =
  homedir 且 shell 另行 export 自定义值 → main 侧启动 GC 与 host/A2′/C3 解析可能分叉
  （既有链路属性，pre-existing chain property）——登记残留，不加防御代码。
- **dataBaseDir 生命周期中变更（alpha.2 披露）**：运行时卡在操作时点读取当前 dataBaseDir
  （卡 = 本机全局事实源）；变更后已 spawn 进程的环境不回填，语义靠重启收敛。
- **不做**：installer 时间组件勾选（仅 Windows NSIS 可行且需自定义 components 页；
  mac DMG/Linux AppImage-deb 无安装期 UI——跨平台正解 = PR2 按需下载）；volta（官方弃维）、
  corepack（node 26 已不随发行）、fnm/nvm 类（shell 修改或全局 shim，违背零系统修改）；
  静默自动安装运行时（C2 只指路不装）；bot `/status` 增加 MCP 健康行（Beyond 候选池）。
