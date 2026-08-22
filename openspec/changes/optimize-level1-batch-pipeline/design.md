## Context

现有单进程按一次完整 `runOnce` 串行组织 GMGN、CoinGecko pool resolution、Level 1 和 Outcome。Level 1 每链截取最多 50 池，执行一个 `/pools/multi` 后又为每个池串行调用 `/trades`；真实部署曾出现 3 次批量池对应 138 次 trades，首轮约 105 秒。现有批量响应已经包含广筛字段，但完整 `Level1Snapshot` 强制要求仅能从 trades 得到的 `lastTradeAt`，且适配器把成功解析的池固定标为 stable。

系统约束是 SOL/BSC 隔离、安全先于 CoinGecko、集中 YAML 调参、原始证据可回放、SQLite 单机、唯一 main 和服务器只拉取部署。见 proposal.md 与 `specs/adaptive-level1-pipeline/spec.md`。

## Goals / Non-Goals

**Goals:**

- 把“发现后到 G2 订阅”的 CoinGecko 路径从全池逐笔查询缩短为批量广筛加少量精查。
- 在不伪造证据、不放宽 30 秒 G2 窗口和完整确认表达式的前提下，显著降低 REST calls 与 P95 延迟。
- 支持同链超过 50 池的自动切片，并让确认工作优先于后台工作。
- 让历史 raw 可以比较旧路径与新路径，最终线上只保留新路径。

**Non-Goals:**

- 不增加新的信号类型、管理员预警、Telegram 路由或策略阈值。
- 不提高 G2 socket/订阅上限，不改变 Outcome 定义和收益口径。
- 不引入微服务、Redis、消息队列、ORM、新表或服务器热配置。
- 不在本变更中调整 GMGN 轮询间隔；其私人 Key 负载验证作为后续独立优化。

## Decisions

### 1. 使用两种内存证据类型，而不是弱化完整 Level1Snapshot

新增一个不含 `lastTradeAt` 的批量筛选快照，保留现有完整 `Level1Snapshot` 对真实成交时间的要求。批量快照只能用于结构条件判定、排序和调度；候选获得逻辑容量预留后，用一次 REST trades 将其提升为完整快照，先转换为 Armed，再由 Armed 发起 G2 订阅。Armed 后的精确成交时间优先从已持久化 G2 trades 更新，只有初始化、确认补证、证据冲突或恢复才重新调用 REST trades。

选择这一方案是因为把 `lastTradeAt` 改为批量 observedAt 会制造虚假证据；把完整快照的时间字段直接设为 optional 又会把 incomplete 传播到现有确认和 replay。替代方案“所有池继续 trades 但并发化”只能缩短时间，不能解决 credits。

### 2. 结构门槛负责阻断，动态指标只负责排序与复查

逐池 trades 之前，只有安全 pass、Candidate freshness、Attention pass、池身份/链完整、字段类型合法和明确迁移冲突等结构性条件可以阻断。buyers、reserve、volume、net buy 和年龄窗口覆盖会随新币成长而改变，只用于确定性排序和短周期复查；G2 concentration、30 秒 net buy、价格漂移等尚无证据的条件同样不提前判拒绝。

这使批量筛选成为保守的资源门，而不是一套新信号策略。当前响应承诺且结构判定必需的字段缺失为 incomplete；条件不适用的链/launchpad 字段不要求存在。为防止刚创建、初始 buyers 较低的候选被持续排在队尾，排序加入等待年龄提升，并配置最大复查间隔；候选仍须在有效 Cycle 内，最终确认不放宽任何动态阈值。

### 3. 自动切片所有到期候选，但以有界优先队列控制执行

`50` 仅作为 `pool_addresses_per_request` 硬限制。每链到期候选先按持久化状态恢复、去重和确定性优先级排序，再按 50 切片；`max_due_pools_per_chain` 控制一次调度装入内存的工作量。溢出候选仍以 due 状态保留在 SQLite Candidate 事实源，下一轮重新扫描；backlog 与 oldest wait 必须同时统计已装载和未装载工作。

同一进程维护一个 CoinGecko REST scheduler，初始批量并发 2、finalist trades 并发 4，所有任务仍通过统一 token bucket。调度级别和截止时间规则固定在代码中以保证行为一致；容量、并发、扫描间隔、merge delay、cache TTL、复查间隔、截止时间晋升和资源保留比例集中在 `config/bot.yaml`。扫描只重查 SQLite due，供应商请求仍受 due、single-flight、cache TTL 与统一限流约束。不允许各模块自建限流器。

替代方案“为每条链创建独立执行器”会使共享 RPM/credits 失真；“无限切批立即 Promise.all”会造成 429 和尾延迟抖动。

### 4. 解耦 CoinGecko 工作完成与发现定时器，但不拆进程

GMGN 发现只更新 Candidate 并把合格工作放入内存调度器，不再等待所有 CoinGecko/Outcome 工作完成后才允许下一次发现。调度器串接现有数据库写入和健康状态，进程重启后从 active candidates、signals/outbox/outcomes 重建到期工作，因此无需持久化队列表。

健康状态分别暴露 discovery、scheduler backlog、oldest wait、batch/trade latency、rate/credit defer 和各优先级失败；只有必要证据完整时才允许 Armed/Signal，排队本身不冒充健康。会改变业务结果的 admit/defer/reservation/release 状态转换写为现有 `provider_events` 的内部 runtime event；普通轮询和未变化的等待状态不逐次落库。重启时不恢复过期预留，而是释放并由事实源重新竞争，避免内存状态被误当作业务事实。

### 5. 批量缓存按供应商更新频率合并，确认证据仍实时

同一链/池的 `/pools/multi` 结果在配置的 10 秒 TTL 内可复用，同能力的在途请求使用 single-flight 合并。缓存只存在内存，原始响应仍按实际请求保存一次。确认刷新不得复用超过链 buyers freshness 的结果；REST trades 和 G2 不使用批量缓存时间替代事件时间。

### 6. 池稳定性只判断身份和适用状态，不把市场波动误判为不稳定

稳定性判断读取已绑定主池身份、base/quote、target side、REST/G2 能力和条件适用且真实可得的 migration/graduation 状态。身份或已取得的适用迁移字段明确冲突为 unstable；真实合同承诺且本次判定适用的字段缺失/非法为 incomplete；身份及适用状态完整一致才 stable。普通池缺少 launchpad 字段是正常情况，未验证为通用能力的字段不得被提升为全池必填；reserve/composition 的合法非负数值变化属于动态市场信息，不是身份冲突。SOL/BSC 使用各自适配器，不共享链特有字段。

### 7. 用短期 finalist reservation 关闭容量竞争窗口

候选只有取得绑定 Candidate Cycle 与主池身份的逻辑容量预留，才允许启动初始化 `/trades`。同一身份只允许一个在途初始化请求；临时错误按集中配置有界重试，成功补证后原子地把预留转换为 Armed 容量，再由 Armed 发起真实 G2 订阅。已有 Armed/pending anchor 的确认补证和明确恢复沿用其实际占用，不重复申请 finalist reservation。预留超时、身份变化、Cycle 结束或合法抢占时立即释放，候选只要仍有效即可在后续批次重新竞争。

配置版本切换时，同一 Candidate Cycle 中尚未确认的旧版本 Armed 必须回到 `scouting/safety_checked`，由新版本重新竞争预留并留下完整事件链；`confirmed-pending-anchor`、`delivered`、`completed` 属于已形成信号/Outcome 的历史锚点，其配置版本和生命周期不可被后续 discovery 覆写。这样既不复制 Candidate Cycle，也不把旧规则状态伪装成新 cohort 样本。

reservation 不预先创建 G2 socket，也不新增持久化表。关键状态转换写内部 runtime event 供审计和 replay；进程重启一律视内存预留失效，再根据 active candidates 和实际 G2 占用重建，从而避免幽灵容量。

普通 Armed 使用集中配置的短租约，初始 120 秒，至少覆盖完整 30 秒确认窗口；只有同链存在合格等待者时，租约到期才复用现有 demote、Level 1 等待年龄和 reservation 流程进行轮换，没有等待者则继续观察，不增加表或第二套队列。`confirmed-pending-anchor` 为信号与 Outcome 保留，不参与普通租约轮换。replay 使用同一租约，避免有限容量被少数持续上榜代币永久垄断，也不通过扩大 G2 并发突破真实 credits 预算。

### 8. 截止时间调度同时保护确认与 Outcome

调度器分别为确认和必要 Outcome 保留请求/RPM 份额及月度 credit bucket。正常情况下按确认刷新、新候选批量、Armed 批量、动态复查、非紧急 Outcome 分配非保留容量；一旦工作到达 `latest_start_at = final_deadline - timeout_and_retry_budget`，即晋升最高优先级并使用对应保留资源。发生过载时先停止动态复查和新候选接纳，不允许已知必要 Outcome 因永久排在队尾而越过最终 cutoff。

### 9. 以离线 A/B 和单一 Shadow 路径迁移

先在累计 raw 上运行旧逻辑基线与新批量筛选模拟，输出两链候选保留率、旧路径可通过但新路径丢失的差异、预计 trades 调用数、credits 和延迟分布。实现不保留运行时 feature flag 双路由；通过本地测试后直接按现有 main/deploy.sh 部署到 Shadow/admin anchor，失败使用 Git 回滚。

工程验收按 chain + git commit + config version cohort 累计，每链同一 cohort 至少 500 个有效 batch candidates 与 50 个 finalists 为首个评审批次，不按自然日清零或停止历史累计。以 safety-pass 后首次 due 到批量完成、reservation 到 Armed 后 G2 发起两段计时；无 rate/credit defer 的成功样本两段 P95 均须不超过 10 秒，同语料 REST calls 至少下降 80%，且不得出现本地并发/限流错误造成的 429。修复可进入新 cohort 重新评审，旧异常仍保留在累计报告。所有 defer 单列进入端到端和 backlog 报告，不能用过滤掩盖。若真实 Signal/Outcome 尚无足够样本，只能确认工程指标，不能宣称 production 可用。

本变更以 `build-meme-signal-bot` 为基线依赖。实施时遵循其已批准的硬约束；归档时必须先将基线变更归档为 canonical specs，再复核重叠条款并把本变更转换为相应 capability 的 MODIFIED delta，避免两个活动变更各自成为事实源。

## Risks / Trade-offs

- [批量字段与真实响应偶发不一致] → SOL/BSC 分链契约 fixture、identity 检查、缺失即 incomplete，并保留原始响应。
- [必要门槛设得过强造成假阴性] → 只前置数学上必要的现有条件；先用累计 raw A/B 检查所有旧路径 pass 差异。
- [Attention pass 候选过多，finalist trades 仍然昂贵] → G2 容量预留、初始化 trades single-flight、动态指标排序、等待年龄提升和有界复查；不得用首次 buyers/reserve 不足永久缩小候选集。
- [内存队列重启丢失] → 不把队列当业务事实；启动时由现有 active rows 和 due timestamps 重建，原始事件/候选状态仍是事实源。
- [有界内存窗口溢出造成静默漏检] → 未装载候选保持 SQLite due，调度循环重扫，健康统计包含内外两部分 backlog。
- [优先 Outcome 被长期饿死] → 分别保留请求与 credits，以 latest-start 而非最终时刻晋升；过载时暂停低优先接纳。
- [reservation 因崩溃形成幽灵容量] → 预留仅存内存并有 TTL；状态转换留审计事件，重启释放后按真实 G2 占用重新竞争。
- [缓存降低 freshness] → cache TTL 不得大于供应商更新频率和链 freshness，确认阶段重新校验 observedAt。
- [真实 RPM 与配置漂移] → `/key` 动态上限与本地配置取较小值，429 退避并降低并发。

## Migration Plan

1. 固化当前 raw 基线、调用数、延迟和两链完整率；验证 50 池批量、字段、缓存频率与小并发真实合同，并确认 `build-meme-signal-bot` 基线约束。
2. 引入纯批量筛选证据与稳定性计算，先通过单元/fixture/replay，不接入推送。
3. 增加统一调度器、自动切片、single-flight、finalist reservation 与 deadline-aware 优先级，使用故障注入验证重启、429、credits、确认和 Outcome 截止时间。
4. 用全部累计 raw 执行旧/新 A/B；调度按目标配置重新模拟，live runtime events 只作同配置审计，任何旧路径 pass 被新路径无解释丢失都阻止部署。
5. 按本地修改、main、服务器 `deploy.sh` 部署到 Shadow/admin anchor，核对 commit/config/schema/健康和分链工程指标。
6. 达到约定样本量后评审 production；不足则持续 Shadow，不按自然日强制放行。

回滚使用上一已知良好 Git commit 经 main/deploy.sh 重新部署；本变更不新增业务表或 schema migration，新增的内部 runtime events 可以保留作为审计事实，无需回滚数据库。
