## Purpose

以安全优先、批量广筛和少量真实成交补证降低新代币确认延迟与 CoinGecko 消耗，同时保持两链隔离、证据真实性、确定性回放和单一路由。

## ADDED Requirements

### Requirement: CoinGecko 工作必须继续由链独立安全门禁前置

系统 SHALL 仅把当前 config version 下安全状态为 pass 且仍在有效 Candidate Cycle 内的候选加入 CoinGecko Level 1 调度；SOL 与 BSC MUST 分别组批、解析和判定。

#### Scenario: 安全未通过的候选进入调度时点

- **WHEN** 候选安全状态为 fatal、policy_reject、incomplete、过期或属于旧 config version
- **THEN** 系统不得为该候选调用 CoinGecko 批量池或逐池 trades，并记录可审计的阻塞原因

#### Scenario: 两链候选同时到期

- **WHEN** SOL 与 BSC 均有安全通过且应处理的候选
- **THEN** 系统分别创建 SOL 与 BSC 批次，任何一链的地址、字段或失败不得进入另一链结果

### Requirement: 单请求硬上限与单链调度容量必须分离

系统 SHALL 将 CoinGecko 每请求最多 50 池作为不可突破的硬限制，并用独立配置控制每链内存工作窗口、小并发和每次调度工作量；超过 50 的到期候选 MUST 自动切成多个批次。未进入本次内存工作窗口的有效候选 MUST 继续保留为 SQLite Candidate 事实并保持 due，后续调度重新扫描，不得因内存队列有界而静默丢弃或永久延后。

#### Scenario: 单链有 120 个到期候选

- **WHEN** 120 个去重后的同链候选同时获得处理资格
- **THEN** 系统生成 50、50、20 三个批次，并在配置的小并发与全局限流内执行

#### Scenario: 到期候选超过单次工作预算

- **WHEN** 到期候选数量超过配置的单次调度工作量
- **THEN** 系统按确定性优先级装载允许数量，其余候选继续以 due 状态留在 Candidate 事实源，后续重新扫描，并暴露包含未装载候选的 backlog/oldest-age 指标

### Requirement: Level 1 必须区分批量筛选证据与完整确认快照

系统 SHALL 使用 `/pools/multi` 已验证可返回的池身份、buyers、buys/sells、volume、buy/sell/net-buy volume、reserve、价格、pool age 与 composition 执行批量筛选，并在供应商实际返回或已有身份绑定证据存在时解析条件适用的 migration/graduation 状态；不得假定所有池或响应都存在未验证的 launchpad 字段。批量筛选结果 MUST NOT 因缺少逐笔成交而冒充包含精确最后成交时间的完整 Level 1 快照。

#### Scenario: 批量响应完整但尚无逐笔成交证据

- **WHEN** 候选的批量池字段完整且通过必要门槛，但没有真实 REST trades 或 G2 事件时间
- **THEN** 系统可把候选标记为批量筛选通过，但不得写入伪造的 last_trade_at、不得声明完整确认、不得据此推送

#### Scenario: 批量响应缺少必要字段

- **WHEN** 对应年龄模式或链规则所需的身份、buyers、volume、reserve、价格或窗口字段缺失、类型异常或冲突
- **THEN** 该候选批量筛选为 incomplete，且不得用默认值、另一窗口或另一链字段补齐

### Requirement: 动态市场指标不得在观察前造成永久假阴性

系统 SHALL 只使用安全、Candidate freshness、链/池身份、字段合法性和明确迁移等结构性条件阻止候选进入 finalist 调度；buyers、reserve、volume、net buy 和年龄覆盖等会随时间变化的指标 SHALL 仅用于确定性排序、短周期复查和最终确认，不得因首次不足永久拒绝仍在有效 Cycle 的候选。

#### Scenario: 新币首次快照 buyers 不足

- **WHEN** 安全与结构性证据完整的有效候选首次批量快照低于 buyers 或 reserve 策略阈值
- **THEN** 系统不得把候选永久关闭，而是按动态优先级保留复查资格；若后续快照改善且获得容量，仍可进入 finalist

#### Scenario: 动态指标在确认时仍不足

- **WHEN** 候选已完成 G2 观察但最新 buyers、reserve、volume 或其他完整确认门槛仍未通过
- **THEN** 系统按原唯一确认表达式拒绝或标记 incomplete，不得因早期获得观察资格放宽门槛

### Requirement: 逐池 trades 必须只服务获得容量预留的最终候选和恢复

系统 SHALL 仅在初始化候选同时满足安全 pass、Attention pass、结构性批量门槛且获得绑定 Candidate Cycle/池身份的短期 finalist reservation 时请求逐池 REST trades；已有 Armed/anchor 生命周期的候选可按原规则因确认所需补证或明确恢复请求 trades，而不重复占用 finalist reservation。reservation 只预留逻辑 G2 容量，不得在 Armed 前创建或发起实际 G2 订阅。首次补证完成后，系统先按基线规则把候选转换为 Armed，再由 Armed 状态发起实际 G2 订阅；Armed 候选的持续成交证据 SHALL 优先来自 G2。

#### Scenario: 普通候选完成批量筛选

- **WHEN** 候选未通过 Attention、结构性批量门槛或未获得 finalist reservation
- **THEN** 系统不得为该候选请求 `/trades`

#### Scenario: 最终候选准备进入 Armed

- **WHEN** 候选安全、Attention 和结构性批量门槛全部通过且获得未过期的 finalist reservation
- **THEN** 系统同一时刻至多存在一个初始化 `/trades` 请求；临时失败允许按配置有界退避重试，成功补证后先原子转换 reservation 为 Armed 容量，再仅由 Armed 状态发起实际 G2 订阅

#### Scenario: Armed 候选需要确认补证

- **WHEN** 已有 Armed 或 pending anchor 生命周期按基线规则需要确认补证或明确恢复，且安全与 Cycle 仍有效
- **THEN** 系统可在确认保留资源内请求身份匹配的 `/trades`，不得因其没有初始化 reservation 拒绝，也不得创建第二份 G2 占用

#### Scenario: reservation 过期或候选离开 Cycle

- **WHEN** 初始化补证前 reservation 超时、候选过期、身份变化或更高优先候选合法抢占容量
- **THEN** 系统释放预留且不得创建 G2 订阅；仍有效候选可在后续批量快照重新竞争，而不是永久封禁

#### Scenario: Armed 候选正常收到 G2

- **WHEN** Armed 候选已有持续、身份匹配且完整的 G2 成交事件
- **THEN** 周期性 Level 1 刷新只使用批量池快照与真实 G2 事件，不得每轮重新下载该池最近 300 笔 trades

### Requirement: 交易时间和稳定性不得被推测为通过

系统 MUST 只从身份匹配的 REST trades 或 G2 事件读取 last_trade_at；批量请求 observed_at 不得转换为成交时间。池稳定性 MUST 由已绑定 pool/base/quote/target side 身份、REST/G2 能力、条件适用的 migration 状态和证据完整性判定，不得因解析成功固定写为 stable，也不得把正常 reserve/composition 数值变化视为身份冲突。

#### Scenario: 批量快照新鲜但没有成交事件

- **WHEN** 批量请求刚成功且候选没有可验证的 REST/G2 成交时间
- **THEN** last_trade_at 保持缺失或 incomplete，不得等于批量 observed_at

#### Scenario: 池身份或迁移状态变化

- **WHEN** pool/base/quote/target side 与已绑定身份冲突，或适用的 launchpad 字段明确表示迁移中、迁移目标池不同
- **THEN** 系统将池标记为 unstable，关闭旧 Cycle 或停止确认并保留原始证据

#### Scenario: 普通池没有 launchpad 字段

- **WHEN** 非 launchpad/bonding-curve 池未返回 launchpad_details，但身份与通用必需字段完整
- **THEN** 系统不得仅因该条件字段缺失标记 incomplete 或 unstable

#### Scenario: reserve 或 composition 正常变化

- **WHEN** 同一身份池的 reserve/composition 数值发生合法非负变化且没有字段冲突
- **THEN** 系统将数值用于动态排序和最终策略判断，不得把变化本身标记为 unstable；请求承诺的适用字段缺失或非法时才标记 incomplete

### Requirement: 调度必须同时保护确认与必要 Outcome

系统 SHALL 在单进程内共享一个有界 CoinGecko REST 调度器，为 Outcome 与确认分别保留配置化最低资源；临近 entry/Outcome 最终截止时间的工作 MUST 晋升为最高优先级，其余工作按“确认刷新、新候选批量筛选、Armed 批量刷新、普通复查、非紧急 Outcome”的顺序分配。资源不足时 SHALL 先暂停普通复查和新候选接纳，而不是让必要 Outcome 越过截止时间；相同池和能力在供应商更新窗口内 MUST 合并在途及重复工作。

#### Scenario: 确认与后台 Outcome 同时到期

- **WHEN** 限流窗口只允许执行部分工作且 Outcome 尚未接近最终截止时间
- **THEN** 确认刷新可先获得非保留请求机会，Outcome 使用其最低服务份额或延后

#### Scenario: Outcome 接近最终截止时间

- **WHEN** Outcome 剩余时间达到配置的 deadline promotion 窗口
- **THEN** 该工作晋升到最高优先级并使用 Outcome 保留资源；不足时停止接纳低优先新工作并产生降级告警

#### Scenario: 同一池十秒内重复入队

- **WHEN** 多个事件要求读取相同链、相同池的同一批量能力且已有新鲜结果或在途请求
- **THEN** 系统复用新鲜结果或合并在途请求，不重复消耗 credit

#### Scenario: 普通 Armed 长期占满有限 G2 容量

- **WHEN** 普通 Armed 已连续占用达到集中配置的租约，而其他合格候选正在等待
- **THEN** 系统将其退回既有 Level 1 等待队列并释放 G2，由等待年龄重新竞争；confirmed-pending-anchor 不受普通租约轮换影响，replay 使用同一租约

### Requirement: RPM 与月度 credits 必须同时约束突发和长期消耗

系统 SHALL 以 `/key` 返回的 API-key RPM/月度额度为真实上限，并以集中配置作为更保守的本地上限；确认资源 MUST 保留，开发阶段不得重新引入“剩余低于 100,000 自动停止”的人为阈值。

#### Scenario: 短时大量新候选进入

- **WHEN** 候选批次可以在 RPM 内突发完成但按当前 burn rate 会突破月度预算或挤占确认保留量
- **THEN** 系统允许高优先级确认并延后低优先级扫描，同时暴露 burn-rate、projected-exhaustion 与 backlog

#### Scenario: `/key` 上限低于本地配置

- **WHEN** 供应商报告的 API-key RPM 或月度额度低于配置值
- **THEN** 系统立即采用更低的真实上限，不得继续按配置高值发请求

### Requirement: 优化必须可确定回放并按样本量验收

系统 SHALL 保存批量池、最终候选 trades/G2，以及会改变 live 结果的 scheduler admit/defer/reservation/release 决定，使 replay 能重算批量筛选、最终补证和完整确认。调度决定 SHALL 作为无 billing bucket 的内部 runtime event 写入现有 provider_events，包含 event time、priority、Candidate Cycle 自然键/池身份、config version 和原因；高频无状态轮询不得逐次落库。replay MUST 从 raw provider 时间线与目标配置重新模拟调度，不得复用 live candidate_id 或把旧 config 的 runtime decision 当作新回算输入；内部事件只用于同配置审计比对。切换前 MUST 使用累计 raw 做旧/新路径 A/B 回算，切换后只运行一套自适应 Shadow 路径。

#### Scenario: 使用同一 raw 和配置重复回放

- **WHEN** 对相同 cutoff、config version 与原始事件执行两次 replay
- **THEN** 批次资格、最终候选、阻塞原因和信号结果完全一致，且不会读取 cutoff 之后的证据

#### Scenario: 使用新配置回算旧时间段

- **WHEN** replay 对同一 raw 时间线使用不同于 live 的目标 config version
- **THEN** 系统按目标配置重新模拟队列、reservation 和截止时间决定，只将旧 runtime events 用作差异审计，不得让旧决定控制新结果

### Requirement: Shadow 工程验收必须有明确时钟与样本口径

系统 SHALL 按 chain + git commit + config version cohort 累计工程样本，并以安全 pass 后 CoinGecko 工作首次 due 为 Level 1 计时起点、以成功批量快照完成为 Level 1 终点、以 finalist reservation 创建为补证起点、以 Armed 后 G2 订阅发起为补证终点。未受供应商 rate/credit defer 的成功样本中，Level 1 P95 与 finalist-to-G2 P95 MUST 分别不超过 10 秒；同一 cohort 候选语料下 CoinGecko REST 请求数 MUST 比旧全池 trades 路径减少至少 80%，且不得出现由本地并发/限流错误造成的 429。修复后可用新 commit/config cohort 重新评审，但旧异常必须保留在累计报告。样本不足时只能保持 Shadow，不得用运行天数替代。

#### Scenario: 工程样本达到评审批次

- **WHEN** SOL 或 BSC 在同一 git/config cohort 累计达到至少 500 个有效 batch candidates 且至少 50 个 finalists
- **THEN** 系统分别报告该链的两段 P50/P95/max、defer 分层、REST calls 降幅、429、credits 和 backlog；任一硬门槛失败均不得进入 production 评审

#### Scenario: 供应商主动延后样本

- **WHEN** 工作因真实 RPM、月度 credits 或 429 backoff 被 defer
- **THEN** 该样本必须单独计入 defer/backlog 与端到端延迟报告，不混入“无 defer 的处理耗时”掩盖问题，也不得被删除

#### Scenario: 尚未达到分链样本验收量

- **WHEN** SOL 或 BSC 的有效批量候选、最终候选或真实 Signal/Outcome 样本不足以评估决策一致性、延迟和 credits
- **THEN** 系统继续保持 Shadow，不以自然日、零错误或代码测试通过替代样本验收

### Requirement: 首轮产品评审必须使用固定的分链样本结构

系统 SHALL 仅在同一 Shadow config version 下每链至少 100 个首次合格锚点已送达且 60m 状态已固化，并且其中至少 60 个为 executable 且 60m complete 时进入首轮产品评审。每链 SHALL 按锚点送达时间以前 70% 为研究段、后 30% 为验证段；验证段 MUST 至少包含 30 个锚点和 18 个 executable+complete 样本。未达到门槛时 MUST 冻结收益参数，只允许修复数据或工程缺陷。达到门槛只触发人工评审，不得自动切 production；全部 not_executable、late_entry 与 incomplete MUST 保留在对应分母。

#### Scenario: 小样本尚不足以调参

- **WHEN** 任一链不足 100 个已固化锚点、60 个 executable+complete，或验证段不足 30/18 个对应样本
- **THEN** 系统保持 Shadow 和当前收益参数，只继续积累样本或修复可证明的数据/工程缺陷

#### Scenario: 达到首轮产品评审门槛

- **WHEN** 两链均达到完整分层样本门槛
- **THEN** 人工评审可执行率与正收益率的 Wilson 95% 区间、研究/验证切片稳定性、完整率、尾部亏损、延迟和 credits 预算；不得以固定倍数命中率或单一均值自动放行

### Requirement: 优化不得增加运行拓扑和生产路由

系统 SHALL 保持现有单进程、SQLite、单一 main 分支和单套 Shadow/production 业务路径，不得为本优化新增微服务、消息中间件、业务表或长期 legacy/adaptive 双路由。

#### Scenario: 自适应路径验收失败

- **WHEN** Shadow 发现回归、预算异常或两链证据不一致
- **THEN** 系统通过 Git 回滚并按既有 deploy.sh 重新部署，不得在服务器热改或依赖常驻第二套路由兜底

#### Scenario: 基线 capability 尚未归档

- **WHEN** 本变更准备归档但 `build-meme-signal-bot` 仍未形成 canonical specs
- **THEN** 系统不得先归档本变更；必须先完成基线归档并复核重叠条款，必要时转换为对应 canonical capability 的 MODIFIED delta
