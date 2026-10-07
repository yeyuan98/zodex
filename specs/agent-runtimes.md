# Spec: Agent Runtime Self-Sufficiency（3.16.0 train：pathPrepend 环境缝 + runtime_unavailable 闭环 + bundled 配置/运行时技能）

Status: **DRAFT — 随 `3.16.0-alpha.0` 实现中（spec-first；红测先行）。** 范围 = PR1
（C1 pathPrepend / C2 runtime_unavailable / S1 `zcode-workspace-runtimes` / S2
`zcode-config-reference` + 四清单钉测 + W4 两 rider）；PR2（A1 发布资产 / A2 设置页
下载卡 / C3 app 级 PATH 前插）为后续 PR，本 spec 仅收编语义边界（§2.5 L3、§4.2、§4.6、
§9 残留表），实现契约随 PR2 再修订。依据 = 权威计划 `../ZCode-runtime-plan.md` v3.1
（owner 全裁定 + [ulw] 两轮收口）Part 1/Part 1.5 逐条收编；红测清单见 §8。

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
  经隔离进程 client 发送 ~:2885，该 client 也须能拿到 `runtime/capabilities` —— W2 验证）。
  仅当连接的 CLI 上报 flag 才在 mcpServers payload 中携带 pathPrepend。
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
AbortController 5s），记录 `{candidate, httpCode, latencyMs, ok}`，逐行落日志（技能 →
会话输出；A2 → `logger.lifecycle`）。失败/超时 = 淘汰。**探针版本来源**（消除「探测先于
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
measurements: [...]}`。**重探触发** = probedAt 超 TTL（7d）/ 显式 refresh / 所选源下载
硬失败（此时按 measurements 中的次优顺位重试，全部失败才重新探测）。

### 4.2 版本解析与跨源校验

- **版本解析在探测之后**：node 经 `nodejs.org/dist/index.json`（origin 小文件；失败用
  npmmirror 同名文件）解析精确 `vX.Y.Z`（**npmmirror `latest-*` 目录陈旧——实测坑，禁用**）；
  uv 经 GitHub API latest release；两者钉入 runtime.json 后才构造下载 URL。
- **跨源校验不变量**：tarball 来自 X，校验值必来自**另一源**——node：SHASUMS256.txt 取自
  「nodejs.org ↔ npmmirror 中的另一方」；uv：GitHub API asset digest 恒直连
  `api.github.com`（直连不可达 = 明确报错并提示稍后重试/走 ws 级技能，**不降级为无校验**）；
  gh-proxy 系内容**永不 pipe 进 shell**、永不作为校验来源。
- **自有资产（PR2 A1）校验锚点**：各平台 sha256 由构建期烧录进 app 资源（首装/重新验证
  离线可用）；`runtime-manifest.json` 仅服务「检查更新」的版本发现，其网络获取失败 = 更新
  检查明确报错（不影响已装版本使用）。

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
`command:"npx"/"uvx"` 条目同样补 `pathPrepend`。

### 4.6 生命周期矩阵（收编 runtime-plan 1.5.3）

| 操作    | ws 级（S1 技能，agent 执行）                                                                                                          | app 级（PR2 A2 设置卡，TS 下载器）                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install | 探测→钉版→下载→跨源校验→解压到 `v<ver>/` →写 CURRENT→接线（AGENTS.md 块 + pathPrepend + 镜像 env）                                    | 探测（github/proxy）→经 runtime-manifest.json 解析→下载→sha256→解压 `v<ver>/` →写 CURRENT→`--version` 冒烟                                                                                          |
| status  | runtime.json（版本/镜像/probedAt）；技能教读取与判读命令                                                                              | 卡片：已装版本（CURRENT）+可用版本（manifest）+最近验证结果+探测摘要                                                                                                                                |
| test    | 技能 Verify 节：`node --version` / `npm config get registry`（验镜像 env 生效）/ `uvx --version`；再触发 MCP 设置页 mcp/list 重探     | 「重新验证」按钮：重跑 `--version` 冒烟 + 刷新 MCP 状态列表（复用既有 mcp/list 重探）                                                                                                               |
| update  | 重跑技能→新版本装进**新 `v<ver>/` 目录**→重写 CURRENT（rename 原子）→重写 pathPrepend/AGENTS.md 块/runtime.json→旧目录 best-effort GC | 「检查更新」：比对 manifest 版本→新版本目录就绪→**CURRENT 原子换指针**→旧目录 GC（Windows 文件锁 → 保留、下次启动重试 GC；运行中 MCP 进程 POSIX 下持旧 inode 自然续命，win 下旧目录留存至进程退出） |
| remove  | 技能 Teardown 节：删 `.zcode/.runtime/` + 摘除 AGENTS.md 标记块 + 清 MCP 条目 pathPrepend/镜像 env + 下一任务验证回落                 | 卡片「删除」：确认对话框→删目录与 runtime.json→解析回落（系统 PATH 或 ws 级）；运行中服务器说明（下一任务生效）                                                                                     |

原则：**版本化目录 + CURRENT 原子指针**让 update 永不出现半状态；删除与换版对运行中进程
的影响 = POSIX inode 自然续命 / win 延迟 GC，均无强制重启要求（披露）。**GC 重试归属**：
app 级 = desktop main 启动时扫 `<config>/.runtime/*/` 清理无指针引用且已过宽限期的版本目录；
ws 级 = 技能 best-effort、无重试钩子（披露）。

## 5. S2 — bundled skill `zcode-config-reference` 契约（PR1，W3 实现）

内容 = 配置契约参考（纯文档型 skill，**英文正文**）：

- **MCP 配置路径表**：ws 级 `<ws>/.zcode/config.json`（`mcp.servers`）与
  `<ws>/.agents/mcp.json`（`mcpServers`）、user 级 `~/.zcode/cli/config.json` 与
  `~/.agents/mcp.json`（`mcpSyncService.ts:43-58`）。
- **字段表**：`command` / `args` / `env` / **`pathPrepend`**（C1 新增，含 `~` 展开与绝对
  路径不变量）/ `type` /（http 形态 `url`/`headers`）。
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
- rig：E0-E2 + E4 随 PR1 正文发布（PR2 后补 E3/E5；清单见 runtime-plan Part 3）。E4 =
  破坏 PATH 复现 #27 → 状态行显示新文案（指路 S1）；按 S1 修复后下一任务恢复。

## 9. 残留与不做（披露）

- **remote 不自动供给 app 级运行时**：remote workspace 无桌面设置卡，运行时供给走 ws 级
  S1 技能（agent 执行）；PR2 A2 仅本地 desktop。
- **remote 混版窗口**：desktop 新、远端 CLI 旧 → capability flag falsy → pathPrepend 暂不
  下发（功能缺席但无硬拒）；重连部署匹配 bundle 后自动收敛。已知瞬态（§3e.4 同族）。
- **探针只测传输延迟**，不代表目标版本工件存在（tuna 陈旧坑由「命中须校验版本存在」兜）。
- **GitHub 整体不可达**：app 级**更新**与 uv 新版本安装不可用（ws 级同理受上游限制）；
  uv 校验锚点（api.github.com）不可达 = 明确报错，不降级为无校验。
- **不做**：installer 时间组件勾选（仅 Windows NSIS 可行且需自定义 components 页；
  mac DMG/Linux AppImage-deb 无安装期 UI——跨平台正解 = PR2 按需下载）；volta（官方弃维）、
  corepack（node 26 已不随发行）、fnm/nvm 类（shell 修改或全局 shim，违背零系统修改）；
  静默自动安装运行时（C2 只指路不装）；bot `/status` 增加 MCP 健康行（Beyond 候选池）。
