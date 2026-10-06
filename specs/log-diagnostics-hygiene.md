# Spec: Log Diagnostics Hygiene (3.14.5-alpha.2)

Status: **SHIPPED in `3.14.5-alpha.2` (PR #15, release `527cce5`) — rig H1–H5
VERIFIED 2026-10-04（§2f.5；H6 部分未行使不阻塞）；train 随 official
`3.14.5`（2026-10-06）收官**. 依据：R1/16:42 两次事故
复盘（../ZCode-handoff.md §2）证明日志无法回答基本问题（失败无 ret/errcode、成功无记录、
bots 计数器恒零），且 63% 日志量为单一轮询 OK 行（2026-10-02 实测 20,442/32,515 行）。
本 spec 只改"写什么日志"；**任何业务行为（flush/drop/notice、typing 节奏、token 处理、
协议 schema）零改动**。行为修复（retain、typing 暂停等）gated on alpha.2 探针，另见
`bot-message-delivery.md`。

Owners:

- 心跳写盘门控/行格式/计数器注册表：`packages/shared/src/memoryDiagnostics.ts`（纯逻辑，四类进程共用）。
- host 心跳定时器与 tick 钩子：`packages/desktop/src/host/hostMemoryDiagnosticsLog.ts`。
- RPC 分级与轮询存活汇总：`packages/desktop/src/host/rpcLogLevel.ts` + `rpcLiveness.ts`（desktop host 装配）。
- 设置日志（每日基线 + 当日增量）：`packages/services/src/setting/settingService.ts`。
- 微信发送失败字段标注/发送结果线/typing 结果线：`packages/services/src/bots/`（provider 契约见
  `bot-provider-network.md` Alpha 2 amendment；回复管道观测线见 `bot-message-delivery.md` F10）。

## D1 — RPC 轮询存活：OK 降级 + 15 分钟存活汇总

1. 高频轮询方法的 `rpc:call … OK` 行降为 debug（不落生产日志）：方法清单
   `bots.getStatus`、`bots.getConfig`、`off-peak-task.list`、`bots.createBindCode`
   （`rpcLogLevel.ts` 方法表；precedent：`zcode-agent.backgroundBashOutputV4`）。
   **FAIL 一律 warn，逐条不降级。** 其余方法 OK 保持 info。
2. 生产存活信号：liveness tracker（desktop host 进程内）在既有 60s 诊断 tick 上挂
   15 分钟边界检查（**不新增 timer**；边界由时间戳比较判定）。到点输出一条 info：
   `[rpc-liveness] bots.getStatus ok=<N> lastOkAge=<s> …`（每个被跟踪方法：区间 OK 数
   与最近一次 OK 距今秒数；零调用也输出 ok=0）。计数在 `logRpc` 侧累加（只加计数，
   不改控制流）；汇总与内存计数器注册表**互不流动**（否则 countersDiffer 会被
   存活计数每分钟触发，架空 D2——评审已确认该耦合必须避免）。

## D2 — 心跳行：更稀 + 只留有信息量的字段

1. `MEMORY_SAMPLE_HEARTBEAT_MS` 默认 300s → 900s；内存比例阈值不变（保留 RSS/external
   突增检测——真机事故注释见 shared/memoryDiagnostics.ts）。
2. 计数器触发提前写盘的键集合收紧为诊断相关键（default predicate）：
   `pendingUserInputs|pendingPermissions|sessionEmitters|seqStates|typingIntervals|
runningTasks|streamSubs|liveStatusProgress`；其余计数器变化不触发写盘，随心跳/其他
   原因落盘。predicate 可注入（测试用）。
3. 行格式：值为 0 的计数器跳过，**但**诊断相关键即使为 0 也输出（回到 0 是恢复信号：
   R1 中 `agent.pendingUserInputs=2 → 0` 正是关键证据）。
4. 四类进程（main/renderer/host/agent CLI）共用同一份门控——这是有意的一次性全局调整。

## D3 — 入站消息文本：完整保留（owner 决定）

`provider callback` 行保持完整 `text=`（agent 应用中具体消息可能触发特定路由导致 bug，
文本是一级证据）。本 spec 不做截断；凭据形字段的其他脱敏规则不变。

## D4 — 设置日志：每日一份全量基线 + 当日只记增量；单日日志自包含

1. 每个本地自然日输出**一次**全量设置快照（脱敏后）。触发（先到先得）：
   (a) 进程内首次设置写盘；(b) 当日首次写盘跨日；(c) 60s 诊断 tick 观察到跨日
   （pull-based：desktop host 调用 services 导出的 `maybeLogSettingsDailyBaseline()`，
   只读内存缓存，无 IO、无新 timer）。
2. 同日后续每次写盘只记**变更键**（`path: old -> new`，脱敏）；无变更键则不输出增量行。
3. 脱敏：路径任一段匹配 `/token|secret|password|passwd|credential|key|proxy|authorization/i`
   的值替换为 `<redacted>`（httpProxy URL 可内嵌凭据——评审修复项）。
4. 自包含不变量：只导出某一天的日志即可获得当天完整设置基线；跨日未完成事件引用的是
   当天基线（跨日即重发）。多窗口/多 host 进程会各出一条基线（每进程一份模块级状态），
   自包含性不受影响——接受并在行内带 pid 前缀。

## 计数器注册表聚合（修复 bots.\* 恒零）

`createMemoryDiagnosticsRegistry` 的同名注册由"后者覆盖"改为**全部保留、collect 时同名
键求和**（R1：同进程存在 >1 个 bots service 实例时，心跳只读到最后注册者，活动实例的
计数器全部不可见）。dispose 按 provider 身份移除。键名不变（`bots.*`）——无迁移负担。
Red-test-first：同名两次注册、各自返回不同计数 → collect 求和。

## 观测线契约（bots 侧；与 bot-message-delivery.md F10 / bot-provider-network.md 互链）

- 微信请求错误（两个 request 助手）：抛出的 Error 标注 `weixinRet`（已有）、新增
  `weixinErrcode`、`weixinHttpStatus`（HTTP !ok 路径）——枚举字段，供上层分支与日志读取；
  message 文本不变。
- `sendOutbound`（两路出站的唯一汇合点，含终态文书路径）：每次调用一条 info 结果线
  `bot outbound send provider=… peer=… bytes=… ok|failed`，weixin 附 `tokenAgeMs=
now−updatedAt`（持久化 token 轮换时间；**永不输出 token 值**）；failed 附 ret/
  errcode/httpStatus 与错误文本。失败仍照常上抛（零行为变化）。
- 微信 typing：成功 debug；失败 warn（按 provider 实例 30s 限频，时间戳比较、非 timer），
  附 ret/errcode；getconfig 响应是否携带 `context_token` 只在**变化时**记一条 info
  布尔（探针判定免费刷新机制的关键观测，永不输出 token 值）。

## Invariants

- 零行为变化：不改任何发送/重试/丢弃/typing 节奏/token/协议逻辑；新增状态仅限日志用途
  （计数、限频时间戳、lastKnownSettings 缓存、日标记）。
- 无新 timer：D1/D4 挂既有 60s 诊断 tick；typing 限频为惰性时间戳比较。
- debug 不落生产日志（AGENTS.md 日志分级）；成功 typing 行为 debug，发送结果线/汇总/快照为 info，
  失败为 warn。凭据/token 值永不入日志；消息全文保留（D3）。
- 不削减已证明证据价值的线（keep-list）：schema 丢弃 warn、bots 生命周期线、cua-pip
  turn-started/ended warn、provider callback（全文）、[memory] 行本身。

## Amendment (3.14.5-alpha.5) — weixin -2 失败行观测增强（log-only，owner 已批准）

仅日志，**零行为变化、无新 timer**（上方 Invariants 原样适用）。作用于「观测线契约」
中 weixin send-outcome **失败**行（`ret=-2` 类，`tokenAgeMs` 已随行的同一行），
新增三个字段：

1. `burstOrdinal`：当前出站波内该 peer 的第几条**发送尝试**（1-based）。波 = 两次归零
   之间的连续出站尝试序列；**每次尝试都计入**——序言、保留积压逐条补发（force 边界
   先补投再 flush 当前缓冲）、正文分块、失败通知，它们都打到同一发送 API（2026-10-04
   实测 -2 正是补发波中段死亡，handoff §2f.1/§2f.10；排除补发会使位次判别在最需要的
   事件类上失明——main-agent 裁定）。计数器为 per-peer lazy 内存状态，在**该 peer 的
   任意入站**与 **M2 token 失效**（`invalidateWeixinContextTokenForPeer` 实际生效）时
   归零重开。
2. `sendCount10s`：该 peer trailing 10 秒窗口内的发送尝试数。由小时间戳环维护，
   发送时**惰性求值**（先裁剪 >10s 的旧戳再计数）——不设 timer/daemon（§5.12
   「无新 timer」先例）。
3. `fp`：peer token 条目**为发送而读取**时随行附带（token 值 SHA-256 前 8 hex）。
   指纹规则与持久化侧独立行归 `specs/bot-provider-network.md` Alpha 5 amendment
   （两文互链）。**回退语义（as-built）**：本次发送未读到条目时（如同波前一次 -2
   已触发 M2 删除），失败线回退携带该 peer 当前波上下文的最近读取指纹——观测连续性
   优先（判别「同指纹自愈 vs 轮换」需要跨失败线的指纹链）；M2 失效实际生效时清除该
   上下文（条目已删，不得再携带旧指纹）。极端角落：持久化条目因 20-peer 上限被逐出
   （非 M2 路径）时上下文可能短暂残留旧指纹，下一次真实读取即刷新——诊断值不受影响。
   **硬不变量：token 值本身永不入任何日志行**（既有规则；测试钉死）。

目的：下次 mid-burst -2 复发时可判别 限速（复发于一致 burst 位次 ≈10–12）vs 瞬态
（随机位次）；入站后 同指纹自愈 vs 轮换。成功行不带上述字段（tokenAgeMs 语义不变）。
测试（red-first）：失败行带 `burstOrdinal>=1`/`sendCount10s>=1`/`fp` 匹配
`^[0-9a-f]{8}$`；不同 token 值指纹不同、同 token 指纹相同；捕获日志中无 token 原值；
连续发送无入站时 burstOrdinal 递增、入站后归零（M2 失效同）；sendCount10s 只计
trailing 10s 内的尝试。

## Amendment (3.14.5-alpha.7) — 死窗失败行限频（§5.12a）

仅日志密度变化，**零行为变化**（上方 Invariants 原样适用：发送/重试/补发/保留/
通知语义一个字不变；§5.12(b) 补发延时维持 §7.25 封锁，不做）。依据：owner rig
实测微信断线窗内任务仍输出时，`bot outbound send … failed` 每分钟约 82 行、可持续
数小时，淹没有用信号（plan Part 1 item 9）。作用对象是 botsService 内两条高频
失败 warn：

1. **合并对象与判死口径**：(a) `sendOutbound` catch 的发送结果失败线
   （`bot outbound send … failed`）与 (b) 任务流事件串行队列 catch 的
   `bot task stream event failed …`。死窗判定复用既有
   `classifyBotSendFailure` === `channel-dead`（weixinRet=-2 / HTTP 5xx /
   AbortError/TimeoutError/ETIMEDOUT / 网络超时文本形状）——**仅死窗内限频**；
   content-poison 失败线（4xx、业务拒绝等）**永不限频**，逐条保全。
2. **限频语义**：per (botId, peerKey) 惰性时间戳比较，最小间隔 30s，**无 timer**
   （先例：weixin typing warn 30s 限频、zcodeTaskIndexSyncer topic-subscribe 60s）。
   窗口内第一条失败线照常输出（alpha.5 的 burstOrdinal/sendCount10s/fp 随行——
   计数语义不变，每次尝试仍计入，只是行的发射被合并）；30s 内的后续失败线合并
   计数不发射。下一条件（30s 到期后的新失败线，或下方汇总行）携带
   `suppressed=<自上一条发射线以来合并的条数>`。
3. **汇总行**：死窗结束时输出一条 info 汇总
   `bot outbound dead-window summary provider=… peer=… suppressed=<total>`（total =
   整窗累计被合并条数，含已在发射线上分段披露的部分——[ulw] 评审 NIT-2 语义
   钉死）并清零。死窗结束的判定 = 该 peer 的 revival（任意入站触发的保留积压
   补发开始投递）或分类窗口变化（下一次发送结果不再判 channel-dead）。仅在
   确有 suppressed 计数时输出。**已知残余（[ulw] NIT-3，接受）**：revival 触发
   点当前仅覆盖"有保留积压的 weixin peer"——非 weixin 或空积压 peer 的死窗
   汇总顺延到下一次发送成功/poison 失败时点（仅影响汇总行时点，不影响限频
   与计数本身）。
4. **不动的线**：`bot retained backlog delivery stopped channel-dead` info 线维持
   once-per-revival-attempt（本就低频）；`bot retained backlog revival attempted`、
   M1/M2 生命周期线、发送成功线全部不变。
5. **迁移注记**：上方 alpha.5 观测测试中「每次尝试一行」的逐线断言在实现落地时
   按新密度改写（burstOrdinal/sendCount10s 计数语义不变，仅行的发射数变化）——
   由实现 PR 一并更新，不视为回归。

测试（red-first，`botMessageDelivery.test.ts`，console 捕获 + ret=-2 failErrorFactory
注入，与 alpha.5 观测用例同款 seam）：死窗内 N 次 channel-dead 失败尝试（30s 内）→
捕获 warn 中该 peer 的失败线恰 1 条；revival（清除失败注入 + 入站 ping）后恰一条
`dead-window summary` 汇总行且 `suppressed>=1`；content-poison 失败线不受限频影响
（守护钉，实现前后都绿）。

## Amendment (3.14.5-alpha.7) — pending 仪表归零（§5.14：agent.pendingPermissions / agent.pendingUserInputs）

归属：D2 心跳诊断键 `agent.pendingPermissions` / `agent.pendingUserInputs` 的**取值
语义**修正（D2 的键集合、节奏与写盘触发不变）。这两个 gauge 计数的是
**UNRESOLVED 交互提示**（zcodeAgentService 内 pendingPermissions / pendingUserInputs
map 的条目数），但今天的 map 只增不减——仅在 client 断连（invalidateWorkspaceClient）
与 disposeAll 清理，交互解决后从不移除；owner 实证：权限全部应答、任务结束半小时后
心跳仍显示 pendingPermissions=3 / pendingUserInputs=2。

1. **归约契约**：交互被解决时，对应条目必须退出 gauge 计数，两条路径都要覆盖：
   (a) **交互应答成功**——`respondPermission` / `respondElicitation` 成功（adapter
   接缝必须触达服务侧 map 的清理；只改 adapter 不清服务侧 map 不算修复）；
   (b) **系统侧解决**——`permission.resolved` / `userInput.resolved` 会话事件到达
   host（覆盖 deny-on-stop / deadline 类：没有 UI 应答也有终局）。
2. **不得复活已广播提示（tombstone 决定）**：`wasPending` 去重（agent 为找回
   protocol id 重发同一业务 requestId 时不重复广播给 UI）依赖 map 键的存在性。
   **裁定：墓碑而非删除**——条目解决后标记 resolved：退出 gauge 计数、不再参与
   应答路由，但保留键使 wasPending 去重继续生效（解决后同 requestId 重发不得
   重新广播）。墓碑随既有 client 断连与 dispose 清理一并清除（这两条清理语义
   不变）。红测守护钉：解决后重发同 requestId → 恰一次广播。
3. **止损条款**（handoff §5.14 / plan Part 1 item 10 保险）：若实现中发现需要跨
   host 重新设计记账所有权（例如手机远控与桌面对同一 prompt 各持一份待决状态），
   立即停下找 owner 拍板，不擅自动。
4. **心跳/UI 零改动**：D2 的诊断键写盘谓词、15 分钟心跳节奏、「诊断键为 0 也输出」
   规则全部不变；唯一变化是这些键在交互解决后回到 0（B2 测试表验证）。

测试（red-first，`packages/services/test/agentPendingGauge.test.ts`：真
createZCodeAgentService + 真 zcodeTaskServiceAdapter（真服务 + 最小 repo/syncer 桩）

- 假 Agent 子进程（stdio ndjson，offPeak wiring harness 同款））：

* 应答路径：agent 反向 `interaction/requestPermission` → 广播 permission.request、
  `collectServiceMemoryDiagnostics()["agent.pendingPermissions"] === 1` → adapter
  `respondPermission` 成功 → 归零（今天恒 1 → 红）。
* deny-on-stop 变体：agent 推送 `permission.resolved` 会话事件（decision=deny）→
  同样归零（今天恒 1 → 红）。
* 墓碑守护钉：解决后 agent 重发同 requestId → 不再广播（今天即绿——钉住
  tombstone 语义，裁定 tombstone vs delete）。
