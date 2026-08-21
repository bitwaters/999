# Meme 信号推送 Bot 开发文档

> 版本：3.11.0
> 状态：开发设计基线；供应商待验证项与参数经 Shadow 评审后方可生产
> 网络：Solana、BSC
> 数据源：GMGN Agent API、CoinGecko Analyst API
> 输出：Telegram 入场信号、按需报告、系统通知

## 1. 产品目标

系统不只寻找“正在上涨的币”，而是识别：

> 注意力正在扩散、真实且分散的买盘正在形成、上涨不是主要由薄池或操纵制造，并且 Telegram 送达后仍有可参与空间的 Meme 代币。

主要评价不绑定某三个固定倍数，而是观察信号送达后的完整收益路径：

- 1m、5m、10m、30m、60m forward return 分布；
- 各时段 MFE、MAE、最大回撤和峰值出现时间；
- 收益先达到某一幅度还是回撤先达到某一幅度的路径概率；
- 正收益率、收益中位数、P25/P75 和尾部亏损；
- confirmation、pre-send、delivery 的价格漂移；
- 信号覆盖率、完整率、推送延迟和每个完整信号的 credits 成本。

倍数或涨幅里程碑不作为第一版实时功能，只可在后续回算中作为研究指标，也不作为产品固定优化目标。
第一版持久化的核心结果只是 forward return、MFE 和 MAE；其他统计在需要时通过 replay 计算，不为此增加常驻服务或专用表。

## 2. 设计原则与范围

1. 安全前置：未通过链原生安全准入的候选不得消耗 CoinGecko 配额。
2. 来源单责：每个业务字段只有一个权威来源；同名字段不合并、不平均、不覆盖。
3. 两链隔离：SOL、BSC 使用独立安全适配器、字段白名单、参数和版本。
4. 分级用数：GMGN 广域发现，CoinGecko 批量筛选，仅少量 Armed 候选使用 G2。
5. 年龄感知：Newborn 不因缺少完整 5m 被拒绝，也不能伪装成完整窗口。
6. 可执行优先：使用送达后的完整收益路径评价信号，不只看瞬时最高价。
7. 配置集中：业务参数只来自一个配置文件，代码无隐藏业务默认值。
8. 确定性决策：评分只调度资源，不能绕过生产硬门槛。
9. 先 Shadow 后生产：初始阈值是假设，必须用数据确认。
10. 保持简单：第一阶段只做 Emerging Breakout，不做自动交易、外部社交抓取或机器学习。
11. 交付受控：代码和业务配置只能在本地修改，经 GitHub main 和 CI 后由服务器拉取部署，禁止服务器热改。

暂不实现 Re-acceleration、里程碑实时提醒、群组命令/Topic、G3 adapter、GMGN Swap/私钥、自动买卖、Twitter 内容模型、所有候选高频 Top Holders/Top Traders。

## 3. 两个 API 的职责

### 3.1 GMGN：发现、语义、钱包身份、安全

负责：

- Trending 榜单已验证窗口严格为 1m/5m/1h/6h/24h；30m、3h 真实 API 返回 400；
- Hot Searches；
- Trenches、毕业、迁移、CTO 等生命周期事件；
- rank、visiting_count、hot_level；
- Smart Money、KOL、dev、sniper、bundler、rat trader、bot degen；
- SOL/BSC 链原生安全与操纵风险；
- Token、creator、launchpad、migration、社交背景；
- 市值、流动性、buys/sells/swaps 的廉价预筛。

GMGN 成交字段不用于最终 Flow 或 Outcome。

GMGN Signals 必须显式传入配置化类型白名单；真实 API 中不传类型会返回空数组，14/15/16 会被拒绝。不得依赖 CLI 声称的默认行为。GMGN Kline 已验证支持 30s/1m/5m/15m/1h/4h/1d，但仍不替代 CoinGecko Outcome。

### 3.2 CoinGecko：池结构、微观成交、结果

负责：

- token 对应池和可订阅主池；
- base/quote、reserve、pool composition；
- m5/m15/m30/h1 buys、sells、buyers、sellers、volume、net buy；
- 最多 50 池/请求的批量快照；
- G2 实时逐笔成交；
- REST 30s OHLCV、回补、校验和 Outcome。

实际 Analyst Key 已验证为 500 RPM、500,000 credits/月；SOL/BSC 的 50 Pool、50 Token 批量、30s OHLCV base/quote、Pool Trades 和 G2 均成功。G2 不含钱包地址。REST Pool Trades 虽包含 `tx_from_address`，但在不同 DEX 中可能是用户、聚合器、路由或程序账户，未验证前不得当作 unique buyer。Top Holders/Top Traders 和 G3 仅保留已验证记录，不进入第一版实现。

### 3.3 权威来源

| 业务含义 | 权威来源 | 另一来源用途 |
|---|---|---|
| 候选、Attention | GMGN | CoinGecko 不替代 |
| 链安全、钱包语义 | GMGN | CoinGecko 不替代 |
| 市值预筛 | GMGN | CoinGecko 仅差异诊断 |
| 分析主池、base/quote | CoinGecko | GMGN 作为解析线索 |
| 批量买卖广度 | CoinGecko REST | GMGN 仅早期预筛 |
| 实时 Conviction | CoinGecko G2 的 net buy/buy share + REST 的 buyers | GMGN 仅辅助证据 |
| 30s OHLCV、Outcome | CoinGecko 同一主池 | GMGN 仅健康诊断 |

关键冲突标记 `conflict` 并暂停生产确认。

## 4. 业务漏斗

```text
GMGN Trending 1m/5m / Hot Searches
                              │
                              ▼
                     Level 0：Candidate
                              │
                              ▼
              Level 0-S：SOL/BSC 前置安全准入
          │ fatal/policy_reject │ incomplete
                  ▼             ▼
               reject       补查/重试/过期
                              │ pass
                              ▼
                  Level 0-M：GMGN 廉价预筛
                              │
                              ▼
             Level 1：CoinGecko 批量池筛选
                              │
                  ┌───────────┴───────────┐
                  ▼                       ▼
             普通观察                  Armed
                                          │
                                          ▼
                         Level 2：短时 G2 精确确认
                                          │
                                          ▼
                     ACE + Organic Growth + 完整性
                                          │
                                          ▼
                           安全 freshness 复核
                                          │
                              reject 或 Signal
                                          │
                                          ▼
                                      Telegram
                                          │
                                          ▼
                       短时 G2 入场 + REST Outcome
```

统一确认表达式：

```text
candidate_is_fresh
AND safety_status = pass
AND pool_status = stable
AND attention_status = pass
AND conviction_status = pass
AND organic_growth_status = pass
AND entry_quality_status = pass
AND evidence_status = complete
```

Signal 固化后、Telegram 实际发送前另执行 dispatch guard：

```text
latest_pool_status = stable
AND latest_safety_status = pass
AND latest_g2_status = complete
AND pre_send_drift_status != overextended
AND delivery_not_expired
```

任何候选来源都不得建立隐藏通过路径。

## 5. Candidate 来源与生命周期

第一版候选只来自两类已验证入口：

1. Trending：1m/5m 榜首次出现或跨窗口 rank 改善；
2. Hot Searches：首次出现或 `visiting_count` 增长。

Smart Money、KOL、Lifecycle、Market Signal 等来源不单独轮询、不创建额外策略。若它们已包含在现有响应中，只保存原始证据，供未来回算决定是否引入。

来源只影响发现原因和优先级，不决定生产通过。

```text
scouting -> safety_pending -> qualified -> armed
        -> confirmed-pending-anchor -> delivered -> completed

任意阶段可进入 rejected / incomplete / expired
```

同一连续 Candidate Cycle 只产生一个 Signal。离开所有发现集合超过配置 TTL 后关闭，再出现时建立新 Cycle。

## 6. 年龄模式与 DataState

| 模式 | 池年龄初始值 | 使用 | 不允许 |
|---|---:|---|---|
| Newborn | 0–2m | GMGN 1m 序列、partial m5、reserve、G2 | 要求完整 m5/m15/m30 |
| Early | 2–5m | partial m5、多个 1m 快照、G2 | 把 partial 当完整 5m |
| Established | >=5m | 完整 m5、m15/m30、历史基线 | 忽略覆盖缺口 |

边界均为配置项。

状态：

- `complete`：覆盖整个要求窗口；
- `partial`：池年龄不足，但从创建或订阅起连续覆盖；
- `zero`：覆盖完整且确实无成交；
- `missing/stale/invalid/conflict`；
- `unresolved`：CoinGecko 尚未解析池。

Newborn partial 是有效事实，但只能进入 Newborn 规则。missing/unresolved 不得转成零。

```text
coverage_seconds = max(1, decision_time - max(pool_created_at, window_start))
coverage_ratio   = min(coverage_seconds / window_size, 1)
buy_rate         = buys / coverage_seconds
buyer_rate       = unique_buyers / coverage_seconds
volume_rate      = volume_usd / coverage_seconds
```

`decision_time` 在线路径取当次规则判断的本机观测时间，replay 取当前模拟时点，禁止在回算中读取真实墙钟。`pool_created_at` 晚于 decision time 且超过允许时钟偏差时标记 invalid，不能通过 `max(1, ...)` 掩盖。Newborn/Early 使用单位时间速率、最小绝对样本和 G2 最小观察时间，不使用完整窗口加速倍数。

CoinGecko 未索引时保留 GMGN 低成本观察并退避重试；不进入批量刷新/G2，不用 GMGN 价格代替确认，超时结束本 Cycle。

## 7. Level 0-S：前置安全

```text
GMGN 内联字段完整 -> 本地链适配器判断
字段缺失          -> safety_pending -> GMGN token security
pass              -> 才可进入 CoinGecko
fatal/policy_reject -> 立即 rejected（原因分别保存）
incomplete        -> 重试或过期
```

- `pass`：链必需字段完整且未命中 fatal；
- `fatal`：S0 明确不可交易、权限或合约风险；
- `policy_reject`：已启用 S1 命中本链风险政策阈值；与合约 fatal 分开统计，但同样在 CoinGecko 前结束 Cycle；
- `incomplete`：必需字段缺失、过期、无效或冲突。

GMGN Trending、Token Security、Trenches、Signals 对同一含义可能分别返回 integer、boolean、数字字符串或 `yes/no` 字符串。每个 capability 必须使用独立原始响应 Schema，随后转换成链适配器的 canonical 类型；禁止 JavaScript truthy/falsy 强转。未知枚举、空字符串、`null` 和未识别类型一律为 `incomplete`，不能推断为安全。S0 和已启用 S1 都在 CoinGecko 之前执行；Organic 只引用最终 safety pass，不再重复解释安全字段。

S1 启用语义只有一套：S0 始终启用且必需；每个 S1 字段必须在链独立配置中显式 `enabled`，只有已完成 fixture、方向和量纲验证的字段才允许启用。已启用 S1 缺失、过期或无效时 safety 为 `incomplete`；未启用 S1 和仅观察字段不影响 safety status。Shadow 启动时也必须显式保存当时的 S1 启用集合；production 前必须人工评审并固定首版 S1 集合。

### 7.1 SOL 独立适配器

只读取 SOL 白名单：

- S0 合约安全：`renounced_mint`、`renounced_freeze_account` 必需，明确为否 fatal；
- S1 操纵风险：`top_10_holder_rate`、`dev_team_hold_rate`、`bundler_rate`、`rug_ratio` 在验证字段方向和量纲后，按 SOL 独立阈值产生 policy_reject；
- 仅观察：`is_wash_trading`、`rat_trader_amount_rate`、`top70_sniper_hold_rate` 和新鲜集中分发事件，第一版不参与硬拒绝。

SOL 严禁读取 honeypot、owner、open-source、tax。通用响应占位值必须忽略。

### 7.2 BSC 独立适配器

只读取 BSC 白名单：

- S0 合约安全：`is_honeypot` 必需且明确为是 fatal；canonical `ownership_renounced` 必需且明确为否 fatal；`is_open_source` 和 `buy_tax/sell_tax` 必需，不符合 BSC 独立配置时 fatal。`ownership_renounced` 只能由 BSC adapter 中一个已验证的权威映射产生：优先使用已验证 `is_renounced`，否则使用已验证 owner 语义；两者同时存在但冲突时为 incomplete，禁止用 OR 合并；
- S1 操纵风险：`top_10_holder_rate`、`dev_team_hold_rate`、`rug_ratio` 在验证字段方向和量纲后，按 BSC 独立阈值产生 policy_reject；
- 仅观察：`is_wash_trading`、`rat_trader_amount_rate`、`bundler_rate`、`bot_degen_rate` 和新鲜集中分发事件，第一版不参与硬拒绝。

BSC 严禁读取 mint/freeze。

### 7.3 确认前复核

安全判断保存 `checked_at/expires_at/provider_event_id/config_version_id`。原始响应的 `schema_version` 保存在 `provider_events`，代码版本由 `rule_config_versions.git_commit` 追溯。确认前只有时间仍新鲜且 config version 一致时才能复用 pass；配置升级后必须用已保存 raw 重新判断，raw 不足时重新请求。过期、重算失败或补查失败均不得推送。

## 8. Level 0-M、主池与 Level 1

安全通过后用 GMGN 同一响应预筛：地址/链合法、市值达到观察值、流动性等非 invalid、Attention 有进展且 Candidate 未超龄。操纵风险只由前述 S1 决定，Level 0-M 不再定义隐藏派发规则。

GMGN 主池只作线索。最终池必须由 CoinGecko 支持，身份、base/quote、reserve 有效且支持 REST/G2。

主池确定性排序初始为：

1. 可订阅和身份完整；
2. reserve USD；
3. 近期有效成交量；
4. 近期有效交易数；
5. pool address 字典序。

主池选择由 `config_version_id` 追溯。Cycle 内固定主池；迁移或必须切池时关闭旧 Cycle，禁止拼接两个池。

Level 1 按链分批，每请求最多 50 池，使用事件触发的 200–500ms 合并批次，加 30–60s 定时刷新。读取 reserve、composition、price change、buys/sells、unique buyers/sellers、volume、net buy、pool age、last trade、graduation/migration。通过者进入 Armed；Armed 和 confirmed-pending-anchor 期间仍参加这个批量刷新，直到 Outcome 锚点目的地投递成功或该锚点 outbox 过期。非锚点目的地的成功、失败或延迟都不改变 Level 1 生命周期。确认与每次锚点投递时 buyers/pool 快照必须不超过链独立 freshness，`buyers_freshness_seconds` 初始 Shadow 值 45s。过期或缺失为 incomplete，不得用 trade 数代替 buyer 数。

若完整探测循环长于 freshness，不能简单放宽新鲜度。G2 窗口具备确认价值、Attention/G2 completeness/Organic 等独立门槛没有明确拒绝且仅被 safety/Level 1 过期阻塞时，系统对该候选执行一次按窗口去重的确认前刷新：先请求对应链 GMGN Token Security，安全重新 pass 后才刷新单候选 CoinGecko Level 1，再重跑同一完整确认表达式。仅价格基线缺失不能单独触发刷新。重算必须仍使用触发刷新的原 30s G2 窗口；刷新完成距窗口结束超过 30s 即判 G2 stale。安全失败、候选已过期、刷新失败、窗口过期或重算不通过均不得推送，也不得继续消耗后续 CoinGecko 配额。

CoinGecko 交易计数为 number，但价格、成交额、reserve、balance 等大量金融数值为十进制字符串；provider adapter 必须保留原始字符串，完成格式、finite、正负、范围和单位校验后才转换为规则计算值。无法无损转换的整数使用 `BigInt` 或继续保留字符串；出现下溢、上溢或非法精度时标记 invalid，禁止隐式强转。生产不得使用无 Key GeckoTerminal 公共端点，实测连续请求会返回 429。

## 9. Level 2：G2 与 30s 数据

- socket 常驻，只动态 set/unset pools；
- 只有 Armed 候选可发起新订阅；进入 confirmed-pending-anchor 后保持现有订阅；
- 达到 credits/burn rate 时未订阅候选不能确认；
- 拒绝、Candidate 过期或锚点 ENTRY 投递过期后立即退订；
- confirmed-pending-anchor 期间保持 G2；只有 Outcome 锚点目的地成功送达才开始等待 entry。找到 entry 后 G2 必须保留到 entry 之后的下一个对齐 30s 边界，完成 entry-partial 后退订；若一直没有合格 entry，则保留到配置化 entry timeout 后标记 incomplete 并退订。非锚点投递不触发 entry 或退订。

G2 ingest 只使用一个配置化有界队列。WebSocket callback 执行时立即用本机单调/墙钟组合记录 `observed_at`，然后只校验包大小并入队；raw 压缩、Schema 解析和 SQLite 批量写入在 callback 之外执行，不得用后续处理时间覆盖 `observed_at`。因为 Node 事件循环阻塞会推迟 callback，运行时必须持续测量 event-loop lag；超过配置门槛所覆盖的 G2 窗口标记 timing incomplete，不能确认或投递。所有 `better-sqlite3` 写事务必须有行数/耗时上界并批量执行。队列达到高水位时先退订最低优先 Armed 候选；若仍达到硬上限，受影响的所有订阅窗口立即标记 incomplete，包括 confirmed-pending-anchor；它们不得再确认或投递 ENTRY，并必须告警。禁止静默丢弃或因事件循环阻塞延迟 G2 后继续确认或投递。

订阅优先级第一版只考虑 Attention 速度、Level 1 net buy、候选新鲜度和预计成本。评分只用于调度。

G2 side 根据 CoinGecko metadata 转为目标 token 方向；目标在 quote 时反转。无法确定则 invalid。每条 WebSocket 原始消息先作为不可变 `provider_event` 保存，规范化 live `trades` 引用 `provider_event_id` 并固定 `parser_version`。live trades 永不覆盖或用新 parser 重建；新 parser 只在 replay 进程中直接解析 raw events，结果只写 `replay_results`。

第一版只实现 G2 Schema；G3 不接入运行代码。

去重分两层：

1. 原始消息层使用 provider subscription/session 与 payload hash 识别完全重发的消息；
2. trade 层优先使用 provider trade ID，其次使用 `network + tx_hash + log/leg_index`。

原始消息中的数组顺序 `item_index` 必须保存。若供应商不提供 trade ID 或 log/leg index，先去除 payload hash 完全相同的重发；跨消息出现同 tx/方向/金额/价格/时间指纹时标记 `ambiguous_duplicate`，对应窗口为 incomplete，不擅自合并。同一原始消息内的多个 leg 按 `item_index` 全部保留。

聚合 OHLC、买卖量/数、net buy、buy shares、Top1/Top3 成交占比、成交金额分布、coverage、late、dedup、revision。

实时触发可使用订阅确认后的滚动 30s；对齐闭合窗口用于审计、回放和 Outcome。断线、重连、未确认订阅产生 incomplete，不是零成交。

## 10. ACE 与 Organic Growth

### 10.1 Attention

第一版只使用 Trending 1m/5m rank 变化和 Hot Searches 的 `visiting_count` 增长。hot_level、Search Lead、Smart Money、KOL、生命周期证据只随已有响应原样保存，不新增调用、归一化指标或实时判断。

优先“搜索加速 -> 成交增强 -> 价格突破”，降低“价格先大涨 -> 搜索追入”的优先级。

### 10.2 Conviction

第一版只使用 G2 滚动窗口的 net buy、buy volume share，以及最新 Level 1 REST 快照的 buyers。buyers 只表示对应 m5 或 Newborn partial 窗口的参与广度，不声称来自 G2；超过 freshness 或缺失时 Conviction 为 incomplete。trades per buyer、G2 订单分布、Smart Money/KOL、full open/close 只随已有响应原样保存，不参与实时计算。

### 10.3 Organic Growth

第一版 Organic 只使用 G2 Top1/Top3 单笔成交集中度和已完成的 safety pass。它不重复读取或解释 S0/S1 原始字段；重复等额、price impact、wash、rat、sniper、bot、dev 派发只保留供应商原始字段，后续在 replay 中研究，不进入第一版实时计算。

### 10.4 EntryQuality

EntryQuality 是推送前的可参与空间门槛，只判断 reserve、短期 price extension 和 pre-send drift；它不是第 15 节 Telegram 送达后的实际 `entry` 成交。VWAP、close 位置、突破位、买盘衰减、market cap/reserve、volume/reserve、长上影和高位派发先记录，不参与第一版硬判断。

不设简单涨幅上限，但必须识别 overextension。Signal 固化后、发送前价格漂移过高时，dispatch guard 取消 ENTRY 投递，保留 SignalSnapshot 和未投递原因供后续 replay，不发送“观察、不追”类额外消息。Telegram 已接受后才产生的 delivery drift 只用于 Outcome 和统计，不能反向撤销消息。

## 11. 第一版唯一正式信号

第一版生产入场信号只有 Emerging Breakout。Candidate 来源、Smart Money Cluster、KOL、Graduation、CTO、Boost、ATH、Large Buy 都不是额外的入场信号类型。

### Emerging Breakout

```text
Attention 加速
AND Conviction 通过
AND Organic Growth 通过
AND EntryQuality 通过
AND evidence complete
```

Re-acceleration 只保留为后续扩展方向，等第一波、回撤和二次启动样本足够后再设计，不进入第一版代码和配置。

### 11.1 Telegram 消息类别

第一版只保留三类消息：

| 消息类别 | 是否属于入场信号 | 内容 |
|---|---|---|
| `ENTRY_SIGNAL` | 是 | Emerging Breakout |
| `REPORT` | 否 | 对已保存 Outcome/replay 执行有界汇总，只发管理员 |
| `SYSTEM_ALERT` | 否 | API、credits、数据库预警、投递和健康告警 |

里程碑提醒、定时报表和独立 SHADOW_REVIEW 类型延期；Shadow 内容统一使用 `REPORT`。

## 12. Credits 与限流

Analyst 500,000 credits/月的初始分配：

| 用途 | 比例 |
|---|---:|
| 批量池预筛 | 25% |
| G2 确认 | 35% |
| Outcome | 25% |
| 校验/回补 | 10% |
| 故障余量 | 5% |

```text
allowed_ws_credit_rate =
  remaining_ws_credits / remaining_month_seconds

allowed_message_rate =
  allowed_ws_credit_rate / rolling_credits_per_message
```

`rolling_credits_per_message` 来自真实账单/余额差分的保守滚动估计；尚未得到可信估计时不得把 1 message 当作 1 credit，只能使用配置化保守上界并在 Shadow 报告中标记估算状态。

burn rate 超标时取消低优先候选、降低非必需校验。低水位只保留必要 Outcome 和最高优先候选。

G2 成本按用途而不是按 socket 归属：确认前至锚点送达计入“G2 确认”，锚点送达后为寻找 entry 和补齐 entry-partial 而继续保留的 G2 计入“Outcome”。同一条消息只能记入一个 bucket；计费用途和关联 candidate/signal 随对应 `provider_event` 保存并按需聚合，不新增 credits ledger 表，避免预算报表重复计费。

以上 credits 低水位降级只属于未来 production 保护策略。开发与持续采样阶段不设置剩余 credits 自动停止线，只记录调用量、burn rate 和 `/key` 余额，避免因人为阈值中断样本累计。

GMGN 使用单一加权队列，discovery 和 safety 优先。429 读取 reset 并暂停；异常响应不清空 TTL 内状态。

GMGN 公用 Token 的并发 429 与临时 IP 封禁不能用于推导私人 Key 的生产限制。私人 Key 到位前不固化 GMGN 并发数、RPM 或最小调用间隔；公用 Token 采样器的串行间隔仅是测试保护，不属于正式 Bot 参数。

## 13. 延迟预算

| 步骤 | 典型 | 正常上界 |
|---|---:|---:|
| GMGN 发现 | 3–7s | 10–15s |
| 前置安全 | <0.1s | 补查 1–4s |
| 本地预筛 | <0.1s | <0.5s |
| 主池 + Level 1 | 1–5s | 5–15s |
| G2 订阅 | 0.2–2s | 3–5s |
| 成熟币观察 | 25–65s | 95s |
| Newborn 观察 | 60–90s | 120s |
| 固化 + Telegram | 0.5–3s | 10s |

| 场景 | 目标 |
|---|---:|
| 成熟币 | 50–90s |
| Newborn 已索引 | 75–130s |
| CoinGecko 延迟索引 | 2–5min 或不推送 |

成熟 Emerging：P50<=60s、P90<=85s、P95<=100s。Newborn 不含索引延迟：P50<=100s、P90<=140s、P95<=180s。确认至 Telegram：P50<=1s、P95<=3s。

## 14. Signal、Telegram 目的地与冷却

不可变 SignalSnapshot 保存 signal/candidate/chain/token/pool/source、age/coverage、各阶段时间、Attention、Level 1、G2 Conviction、Organic、EntryQuality、pre-send drift、安全 freshness、`config_version_id` 和确认价。Telegram 接受时间和 message id 保存到 delivery outbox，之后才能确定的实际 entry 与 delivery drift 保存到 Outcome，不回写 SignalSnapshot。

价格漂移统一使用同一主池、同一目标 token 方向和 canonical USD price：`pre_send_drift = latest_pre_send_price / confirmation_price - 1`，`delivery_drift = entry_price / confirmation_price - 1`。其中 delivery drift 是“首个可执行成交相对确认价”的代理，不声称是 Telegram 接受瞬间的无摩擦报价；同时报告 delivery-to-entry latency。目标 token 位于 quote 时必须先完成方向转换；池、token 方向或价格单位不一致时为 invalid，禁止计算漂移。

Signal 和所有已启用目的地的 ENTRY outbox rows 在同一事务内写入；REPORT/SYSTEM_ALERT 各自在产生事件的事务中写 outbox。所有消息都必须生成非空 `dedupe_key`，由 `destination + message_type + dedupe_key` 唯一约束保证数据库内只有一条有效投递：ENTRY 使用 `signal_id`，REPORT 使用 `report_request_id`，SYSTEM_ALERT 使用 `alert_type + scope + coalescing_window`，其中 scope 至少区分 provider/chain/resource。`signal_id` 可空但 `dedupe_key` 永不可空，禁止依赖 SQLite 对 NULL 的 unique 行为。

Telegram 使用指数退避。ENTRY 的 `expires_at = signal.confirmed_at + entry_delivery_ttl_seconds` 在初始事务内一次生成，重试不得延长。REPORT/SYSTEM_ALERT 使用各自配置化的 `max_delivery_age_seconds` 和最大尝试次数，不能无限重试；其失败只影响该消息，不改变 Signal cohort。outbox 保存 message type、dedupe key、可空 signal id、destination、chat id、已渲染 payload、status、attempts、next retry time、可空 `expires_at`、`attempt_started_at`、`sent_at`、`telegram_message_id`、`delivery_uncertain` 和 `last_error`。重启后继续处理同一 payload，不重新解释旧配置。

ENTRY 每次首发或重试前只使用当前内存状态执行轻量 dispatch guard：未超过 `expires_at`、safety pass 未过期、最新 Level 1 pool 快照仍新鲜且 stable、G2 窗口仍 complete，且最新 G2 价格未超过 pre-send drift。Level 1 使用已有批量刷新，不为单次重试发起专用 API 请求；重启后未恢复必需内存状态时也不得发送。失败持续到过期时标记 `expired`、停止补发、不启动 Outcome，并通知管理员；REPORT/SYSTEM_ALERT 不使用 ENTRY TTL。

Telegram Bot API 不提供业务幂等键，因此投递语义是“至少一次 + 尽力避免重复”，不承诺 exactly-once。每次请求前先将 outbox 置为 `sending` 并保存 `attempt_started_at`；若重启发现遗留 `sending`，表示 Telegram 可能已接受但成功结果未落库，必须置 `delivery_uncertain=true`。ENTRY 仅在其固定 `expires_at` 前重试；REPORT/SYSTEM_ALERT 仅在各自最大投递年龄和尝试次数内重试。只有锚点 ENTRY 的 `delivery_uncertain=true` 会使该 Signal 退出主要绩效 cohort；非锚点或非 ENTRY 消息的不确定只记录目的地诊断。锚点不确定的 Signal 可保留 Outcome 供诊断。可见重复仍可能发生，不为此引入分布式事务。

### 14.1 私人管理员私聊：控制与诊断层

只允许配置中明确列出的 Telegram user ID，并且控制命令只能在一对一私聊执行。自动 ENTRY/REPORT/SYSTEM_ALERT 只发送到单一 `admin_private.chat_id`；`allowed_user_ids` 只是命令权限列表，不代表多个自动投递目的地。

接收：

- 完整版 ENTRY_SIGNAL；
- REPORT；
- SYSTEM_ALERT。

允许的管理命令初始包括：

- `/status`、`/health`、`/credits`、`/report`。

`/report` 只对已保存的 outcomes 和 `replay_runs.summary` 执行有索引、有时间范围和最大扫描行数的有界聚合，不触发 replay 或大范围计算，因此不新建 reports 表。回算通过版本化 CLI 执行，不从 Telegram 启动。Telegram 不允许暂停服务、重试投递、切换 Shadow/production，也不允许修改业务配置、API key、密钥或部署文件。运行模式只由 `config/bot.yaml` 决定。

### 14.2 频道：正式发布层

频道是 production 推荐的正式发布目的地和 Outcome 绩效锚点，但系统不提供默认值；只有配置显式选择后才成为锚点。频道只发布简洁版 ENTRY_SIGNAL。

频道不发布 Shadow、拒绝原因、API 错误、credits、数据库或运维消息。频道消息以可读性为主，展示链、CA、价格、流动性、Attention/Conviction 摘要、S0/S1 通过摘要、时间和 config version。第一版不产生未定义的“置信度”或“风险等级”。

### 14.3 群组：讨论与查询层

群组第一版只可按配置镜像频道的 ENTRY_SIGNAL，不实现命令、Topic、里程碑 reply、限流或管理能力，也不接收 REPORT/SYSTEM_ALERT。

### 14.4 绩效锚点

配置必须显式指定一个 `outcome_anchor_destination`，不提供代码默认值；production 推荐选择正式频道，Shadow 可选择管理员私聊。Outcome 的 `delivered_at`（下文 `anchor_delivered_at`）、entry 和 cohort 均以该目的地 outbox 的 `sent_at` 为准；它的精确语义是 Telegram API 成功接受消息的本地时间，不声称为用户已阅读时间。

- 锚点投递失败：不启动正式 Outcome，不进入生产绩效 cohort；若管理员私聊不是同一个失败目的地，则写入去重后的 SYSTEM_ALERT，否则依靠健康失败和高优先级日志暴露，禁止递归创建告警；
- 其他目的地失败：不影响锚点 Outcome，但分别记录延迟和错误；
- 没有频道的私人部署可显式把管理员私聊设为锚点；
- 同一 Signal 不因多个目的地成功而重复计算主 Outcome。
- 锚点 outbox `delivery_uncertain=true` 的 Signal 可计算诊断 Outcome，但不进入主要绩效 cohort；非锚点不确定不影响主 Outcome。

同一 Cycle 只发一次；每目的地按 `chain + token` 冷却，初始 1h。锚点冷却是确认前硬门槛：仍在冷却时不创建 Signal 或任何 ENTRY outbox；非锚点冷却只抑制该镜像，不影响锚点。离开集合达到重置时间再出现可建立新 Cycle，replay 必须按模拟时间应用相同冷却。首次/再次 Outcome 独立；主 cohort 只统计同一 `config_version_id + chain + token` 的首次合格锚点送达，重复信号单独报告，避免同一代币反复触发放大样本权重。

## 15. Outcome 与报表

锚点目的地送达后继续保留 G2，直到找到 entry 并越过 entry 之后的下一个对齐 30s 边界，或达到 entry timeout。entry 候选必须为同一 chain/pool/token，且本机 `observed_at >= anchor_delivered_at`；同时 provider `event_at` 必须通过配置化的最大传输延迟、未来偏差和相对锚点容忍校验。在合格候选中取 `observed_at` 最早的成交作为 entry，并同时保存 event/observed time、delivery-to-entry latency 和实际传输延迟。不在两个时钟之间直接比较。

Outcome 分两层状态，禁止混成一个枚举：整体 `execution_status` 为 `executable | not_executable | incomplete`。G2 从锚点送达到 entry timeout 覆盖完整、确实没有合格成交且同期已闭合 REST OHLCV/交易证据不冲突时为 `not_executable`，没有收益路径，但必须进入信号可执行率分母；REST 显示成交而 G2 为零属于 conflict/incomplete。断线、queue/lag、时间偏差、identity 冲突或覆盖缺口也都是 `incomplete`。每个 horizon 的 `evaluation_status` 为 `complete | late_entry | incomplete`：找到 entry 且后续窗口完整才是 `complete`；entry 晚于该 horizon 终点为 `late_entry`，表示当时不可执行但数据没有缺失；行情覆盖不足才是 `incomplete`。绩效报告不得只展示 executable/complete 子样本而隐藏 `not_executable`、`late_entry` 或 `incomplete` 比例。

REST 30s OHLCV 使用固定分段轮询：0–10m 每 30s，10–30m 每 60s，30–60m 每 120s。

只有已闭合 30s candle 可进入 Outcome，未闭合 candle 只保存 raw 不参与计算。candle identity 为 `network + pool + target_side + interval + open_time`；重复轮询返回完全相同的值时去重，同 identity 值发生变化时不覆盖旧行，而是追加带 `revision` 和 `observed_at` 的新版本。在给定 evaluation cutoff 下只选择该时点前已观测的最新修订，不重复计算同一 candle；时间、OHLC 关系或方向冲突时标记 invalid/conflict。

每个 horizon 有且只有一个确定的 `evaluation_cutoff(h) = anchor_delivered_at + h + outcome_max_lateness_seconds`。在线 Outcome 到达该时刻后固化本 horizon，后续供应商修订只保留为 raw/revision 证据，不回写已固化结果；replay 使用对应的 `simulated_delivered_at` 公式，并要求 evaluation cutoff 不晚于 replay run 的 data cutoff，否则该 horizon 为 partial/unavailable。这样既允许容忍范围内的迟到 candle，又禁止用更晚才出现的修订改善历史结果。

基础收益路径：

```text
forward_return(h) = eligible_evaluation_close(h) / entry_price - 1
MFE(h)            = max(complete_high / entry_price - 1) within h
MAE(h)            = min(complete_low  / entry_price - 1) within h
```

`eligible_evaluation_close(h)` 必须来自 close time 落在 `anchor_delivered_at + h` 到其后 `outcome_max_lateness_seconds` 内、且相应修订在 `evaluation_cutoff(h)` 前已观测的 complete candle；超过容忍延迟只能记 incomplete，不能用更晚价格冒充固定时点。MFE/MAE 和“先收益还是先回撤”要求目标区间 candle 覆盖完整；覆盖不完整时保存缺口并标记 incomplete，不用已观察片段代替完整区间。

MFE/MAE 的起点是 entry `observed_at`，终点是 `anchor_delivered_at + h`，表示用户在送达后可执行入场到固定信号时点的路径。如果 entry 晚于某个评估终点，该 horizon 为 `late_entry`，进入该 horizon 的及时可执行率分母，但不计算负区间、收益或延长终点。

entry 落在对齐 30s candle 中间时，禁止用包含 entry 之前价格的整根 REST candle 计算 MFE/MAE。从 entry 到下一个 30s 边界用 G2 成交构造 entry-partial candle，之后只接入完整 REST candle；entry-partial 只表示起点不对齐，该区间 G2 覆盖完整时可参与 MFE/MAE，覆盖不完整时 Outcome 为 incomplete，不用送达前 high/low 填充。

固定观察时点初始为 1m、5m、10m、30m、60m，可配置但不得因未达到某个倍数而删除样本。

第一版在线 Outcome 只保存 execution/evaluation status、entry、30s candle、forward return、MFE 和 MAE。里程碑、Touch/Actionable、收益/回撤路径网格、小时/日报和复杂分层报告延期，只能通过后续 replay/report CLI 按需计算。

按需报告按配置版本中的 run mode 和锚点 `delivered_at` 隔离，第一版只展示整体可执行率、各 horizon 及时可执行率、forward return、正收益率、MFE/MAE、delivery drift、完整率、credits 和延迟。收益统计只使用 `execution_status=executable AND evaluation_status=complete` 的样本，同时并列展示全部锚点送达信号中的 `not_executable`、各 horizon `late_entry` 与 `incomplete` 数量，禁止隐藏分母。Shadow 与 production 不混合。

### 15.1 最简回算模型

持续采集的原始 discovery、observation、G2 和 OHLCV provider events 只追加、不覆盖，也不因调参复制。正式在线结果只写 `signals/outcomes`；回算只写 `replay_runs/replay_results`，不得生成 outbox 或 Telegram 投递。

```text
同一份原始样本
  -> 当时 config_version 的在线 Signal/Outcome
  -> 新 config_version + 当前 Git/parser 的 replay_run
  -> replay_results
```

`replay_runs` 保存 `config_version_id`、数据起止时间、data cutoff、状态和汇总。每次正式 replay 必须在 clean worktree 下执行。replay CLI 只有两种配置输入：直接使用当前 `config/bot.yaml`，或以一个已保存 `rule_config_version` 为基础，通过显式 `--set path=value` 参数在内存中生成候选快照。后者不读取第二个配置文件；CLI 必须展开为完整配置、执行与启动相同的严格 Schema/交叉校验，并将规范化完整 `yaml_snapshot` 永久写入配置版本。

每次 replay 创建或复用与“本次完整快照 config hash + 当前 Git commit + run mode”完全匹配的 `rule_config_version`；禁止使用指向旧 Git commit 的 config version 在新代码下直接执行。parser 由该 Git commit 确定，因此 replay 不重复保存另一组代码版本字段。replay 直接读取 discovery/G2/OHLCV raw provider events 并在回算进程中解析，不写入、覆盖或追加 live `candidates/trades/candles_30s`。

Candidate TTL、来源规则或年龄边界改变时，replay 必须从原始 discovery 事件按本次配置重建模拟 Cycle，禁止沿用 live `candidate_id` 作为回算边界。`replay_results` 保存 replay run、`simulated_candidate_key`（chain + token + 本次模拟 cycle start）、可选 source live candidate IDs、模拟信号、收益路径和完整性，不重复保存原始行情。候选快照只在 replay 中生效；决定采用后，必须回到本地把完整值写入唯一 `config/bot.yaml`、提交 main 并重新部署，不得直接把 replay snapshot 变成运行配置。

replay 必须使用严格事件时间轴：任一决策只能读取在该模拟时点前已 `observed_at` 的证据，禁止使用后来到达的 REST/G2/安全数据回填早期决策。`simulated_confirmed_at` 是首次满足完整确认表达式的模拟时点；由于 replay 不实际调用 Telegram，`simulated_delivered_at = simulated_confirmed_at + replay_delivery_delay_ms`。`replay_delivery_delay_ms` 是配置版本中显式、确定的保守值，初始根据 Shadow 实测投递延迟 P95 设定，不在每次回算中随机抽样。replay 在模拟送达时点重新执行同一 dispatch guard，再从其后的合格历史成交确定 simulated entry/Outcome；当时未采集所需 Level 1/G2 时必须 partial/unavailable，不得用未来数据或实际 live `sent_at` 替代。报告必须将 actual Outcome 与 simulated Outcome 分开展示。

回算完整性只使用三种状态：

- `full`：所需历史字段和窗口完整，可进入主要统计；
- `partial`：只能计算部分规则或结果，单独统计；
- `unavailable`：当时未采集必要数据，不能当作零或进入命中率分母。

安全未通过的候选不会消耗 CoinGecko，未进入 Armed 的候选通常没有 G2；后续放宽规则时如果缺少这些历史数据，只能标记 partial/unavailable，不能伪造完整回算。

每次参数评估至少区分“用于调参的较早区间”和“未参与本次调参的最近验证区间”，不要求固定自然日或固定样本数。被正式采用的回算永久保留；临时试验可以只保留汇总或删除详细结果，因为可以从原始样本重新计算。

## 16. 单一配置源

唯一静态 live 业务配置：`config/bot.yaml`。replay 的候选快照是数据库中的不可变评估输入，不是第二个运行配置源，也不能覆盖当前 Bot。服务器 Telegram destination binding（管理员用户/私聊、频道、群组 ID）只作为部署接线从 `.env` 注入，不得用于覆盖策略、风控或运行模式；容器化启动要求四个 binding 同时存在。下列 YAML 只表达单一配置的固定顶层结构，故意省略业务值且不能直接启动；实际文件必须通过 Schema 列出的全部必填项，代码不得因这里的 `{}` 或空值补隐藏默认值。

```yaml
meta: {}
global:
  run_mode: shadow
providers:
  gmgn: {}
  coingecko: {}
chains:
  sol:
    discovery: {}
    safety: {}
    newborn: {}
    established: {}
  bsc:
    discovery: {}
    safety: {}
    newborn: {}
    established: {}
strategies:
  emerging_breakout: {}
outcomes: {}
storage: {}
delivery:
  outcome_anchor_destination: "<required: admin_private|channel|group>"
  entry_delivery_ttl_seconds: 30
  admin_private:
    enabled: false
    chat_id: "<required when enabled>"
    allowed_user_ids: []
  channel:
    enabled: false
    chat_id: "<required when enabled>"
  group:
    enabled: false
    chat_id: "<required when enabled>"
```

- SOL/BSC 即使值相同也分别填写；
- 不使用隐藏 common safety；
- Schema 只校验类型、必填、范围、白名单和交叉约束，不提供业务默认值；
- 未知键启动失败；
- `outcome_anchor_destination` 必须是 `admin_private|channel|group` 之一，并指向且只指向一个已启用 ENTRY chat id；锚点未启用、chat id 空、指向不支持的类型或 Shadow/production 投递策略不允许时启动失败；`admin_private.chat_id` 必须对应 `allowed_user_ids` 中的一个用户；
- Shadow 必须以 `admin_private` 为锚点并禁用 channel/group ENTRY；production 可显式选择任一已启用锚点，其他已启用目的地只作镜像。两种 run mode 共用同一 pipeline/outbox/renderer 代码，不建立两套路由；
- 所有 Telegram chat/user ID 在 YAML、领域对象和数据库中均保存为十进制字符串，不转 JavaScript `number`；
- credits 比例合计 100%；
- 所有窗口、阈值、TTL、冷却、风险策略配置化；ENTRY 投递 TTL 初始 Shadow 值 30s；REPORT/SYSTEM 最大投递年龄与尝试次数、G2 ingest 队列水位、event-loop lag 门槛、单次 SQLite 写事务行数/耗时上界、entry 时间容忍、`outcome_max_lateness_seconds`、`replay_delivery_delay_ms`、replay 写入批次/busy timeout 也只来自该配置；
- API secrets 和服务器 Telegram destination binding 只来自环境变量；环境变量不得覆盖业务策略、风控参数或 `global.run_mode`；
- `global.run_mode` 只能在本地配置文件中修改并重新部署，Telegram 和服务器环境变量不能覆盖；
- storage 统一定义备份频率/保留、临时 replay snapshot 目录、磁盘水位和最大允许时钟偏差；第一版不自动删除或薄化主库的 provider events、trades、candles 和 Outcome 样本，磁盘水位触发暂停与告警而不是删数据；路径本身由部署接线提供，不能在业务代码写死；
- 启动和正式 replay 时规范化并写入 `rule_config_versions(id, config_hash, git_commit, run_mode, yaml_snapshot, created_at)`，身份由 `config_hash + git_commit + run_mode` 确定；
- Candidate、Signal、Delivery、Outcome 和 replay 只保存 `config_version_id`，hash、Git commit 和 run mode 通过配置版本关联，不重复保存。

## 17. 技术架构、数据与交付纪律

### 17.1 技术栈

采用单进程模块化单体，第一阶段不引入微服务、monorepo、Redis、消息队列、ORM、PostgreSQL、Kubernetes 或 Web 管理后台。

| 范围 | 选择 | 约束 |
|---|---|---|
| 运行时 | Node.js 24 LTS | 本地、CI、镜像使用同一 major；不使用 Current 版本 |
| 语言 | TypeScript 6、strict、ESM | `module/moduleResolution=NodeNext`，不使用路径别名 |
| 包管理 | npm + `package-lock.json` | CI 使用 `npm ci`，依赖升级必须经本地测试和 CI |
| 编译 | `tsc` | 不使用应用打包器；production 只运行编译后的 `dist` |
| HTTP | Node 原生 `fetch` | 超时、重试、429 和限流在 provider adapter 统一实现 |
| WebSocket | `ws` | 只供 CoinGecko G2 adapter 使用 |
| Telegram | `grammy` long polling | 无公网 webhook 入口；私聊、频道、群组共用 SignalSnapshot，renderer 与权限隔离 |
| 配置 | YAML + Zod | 唯一业务配置为 `config/bot.yaml`；启动严格校验 |
| 数据库 | `better-sqlite3` + WAL | 单写者、短事务、批量写入、显式索引 |
| migration | 编号 SQL + 小型 runner | 不使用 ORM migration；默认使用可向后兼容的 expand-first 变更 |
| 日志 | `pino` JSON | 本地可格式化，服务器保存结构化日志 |
| 测试 | Node `node:test` | 统一放在 `test/`，按用例测试而不搭建多套框架 |
| 代码规范 | ESLint + Prettier | 配置保持最小，不承担业务正确性校验 |
| 交付 | Dockerfile + Docker Compose | 单应用容器和持久化数据卷 |
| CI | GitHub Actions | push 后执行 lint、typecheck、test 和 build |

不使用 Node 24 内置 `node:sqlite` 作为第一版生产驱动，直至其稳定级别和实际负载验证满足要求。只有出现多进程/多服务器写入、高并发写入或 SQLite 体积与备份窗口不可接受时，才评审迁移 PostgreSQL；通过 persistence repository 边界隔离迁移影响。

本地开发直接使用 Node.js 以缩短调试循环；提交前使用 Docker Compose 完成 smoke test。服务器宿主机不直接安装 Node 依赖，只通过 Docker Compose 构建和运行当前 `main` 代码。

### 17.2 模块边界

```text
src/
  app/                         启停、调度、生命周期
  config/                      YAML、Zod、配置快照
  domain/                      核心对象与纯规则
  providers/{gmgn,coingecko}/  外部协议与 raw schema
  pipeline/
    discovery/                 候选发现与 Candidate Cycle
    safety/{sol,bsc}/          两链独立安全适配器
    screening/                 Level 0-M、Level 1
    signal/                    ACE 与 Emerging Breakout
  market-data/                 G2、30s candle、覆盖与去重
  delivery/                    outbox、Telegram、renderer
  outcomes/                    entry、return、MFE、MAE
  persistence/                 repository、SQL、migration
  observability/               日志、健康、指标快照

config/bot.yaml                唯一业务配置
migrations/*.sql               编号数据库变更
test/                           按功能命名的测试文件
fixtures/{gmgn,coingecko}/      脱敏契约样本
deploy/                         Docker Compose 与版本化部署脚本
```

核心对象只保留 Candidate、Signal、Delivery、Outcome。安全、年龄、ACE、Emerging、Outcome 和 replay 规则为纯函数。

### 17.3 数据与迁移

第一版数据库只保留 10 张表：`rule_config_versions`、`provider_events`、`candidates`、`trades`、`candles_30s`、`signals`、`delivery_outbox`、`outcomes`、`replay_runs`、`replay_results`。

- SQLite 文件、WAL、备份和运行日志位于服务器持久化目录，不进入 Git 或容器镜像；
- `provider_events` 统一保存 discovery、安全、池快照、G2 WebSocket 和 REST OHLCV 原始响应的 provider、capability、chain、token/pool、event_at、observed_at、schema_version、payload hash、计费用途/估算状态和 raw payload；G2/OHLCV raw 可用 Node 内置 `zlib` 压缩为 BLOB，每条原始消息/响应只保存一次。只持久化响应 payload 和必要的非敏感元数据，禁止保存 Authorization、API key、完整鉴权 URL 或请求 headers；
- `trades` 只保存当时 live parser 生成的不可变规范化成交并引用 `provider_event_id`，包含 raw side、canonical target side、原始数值字符串、event time、tx hash、provider trade/log/leg ID、item index、dedup/revision/ambiguity 状态和 parser version；新 parser 不得重写或追加另一套 live trades；
- `candles_30s` 只保存当时 live parser 生成的不可变 canonical target-token candle，引用 OHLCV `provider_event_id` 并保留 candle identity、revision、observed time、原始 OHLC/时间字符串、base/quote 方向和 parser version；新 parser 不得改写 live candles，replay 从 OHLCV raw response 重新解析；
- `candidates` 保存当前 Cycle、规范化安全结果、主池和漏斗状态；历史事实仍引用对应 provider event；
- `outcomes` 保存整体 execution status、逐 horizon evaluation status、entry 与核心收益路径；not_executable/late_entry/incomplete 原因使用受控枚举，不靠自由文本参与统计；
- provider health 使用结构化日志和当前内存状态，不建表；报告从 Outcome/replay 按需计算，不建 reports 表；
- migration 在应用接收新任务前自动执行并记录 schema version；
- 金融原始十进制值保留字符串；进入规则计算前统一解析并校验 finite、范围和单位，不做隐式类型转换；
- 时间内部统一使用 UTC epoch milliseconds，展示层再转换时区；
- 实时路径只使用有界查询、短事务和批量写入；大范围 replay 启动时先通过 SQLite online backup API 以配置化 page batch 增量制作一个固定 data cutoff 的临时一致副本，每批之间检查 live 写入积压并允许让步/中止，完成后立即释放主库读连接。后续计算只读临时副本，禁止长时间读事务阻止主库 WAL checkpoint。启动前校验副本所需磁盘，完成/失败后由 wrapper 清理仅属于该 run id 的临时副本；`replay_results` 只使用配置化小批次和短事务写回主库。检测到 live 写入积压、busy timeout 或 G2 ingest 高水位时 replay 必须让步并退避，不得影响 trades/outbox/Outcome 实时写入；
- 记录数据库大小和磁盘剩余量，达到配置水位时告警并暂停非必要采样；
- SQLite 定时备份，备份和恢复方式在部署手册中说明。

### 17.4 单一 main 分支与开发闭环

项目只使用一个 `main` 分支，不建立 `develop`、release 或长期 feature 分支。

```text
本地修改代码或 config/bot.yaml
  -> 本地 lint、typecheck、test、Docker smoke test
  -> commit 并 push 到 GitHub main
  -> GitHub Actions 自动验证
  -> CI 通过后，在服务器执行 deploy.sh
  -> deploy.sh: git pull --ff-only origin main
  -> docker compose up -d --build
  -> 查看健康状态和日志
  -> 有问题只回本地修改，再重复以上流程
```

服务器样本或日志需要用于复现时，下载回本地并脱敏；运行数据库和大样本不提交 Git，小型脱敏 fixture 可以在本地加入仓库。

### 17.5 服务器规则

服务器只负责运行和采样。允许 `git pull --ff-only`、Docker Compose 构建/重启、查看日志与健康、备份数据库、导出样本，以及通过仓库内版本化 wrapper 在当前 clean main 代码/容器中执行 replay/report CLI。CLI 只能通过应用 repository 写入 `rule_config_versions/replay_runs/replay_results`，不允许直接执行 SQL 或修改运行配置文件。

服务器禁止：

- 直接修改代码、`config/bot.yaml`、migration、Compose 或部署脚本；
- 进入容器修改文件；
- 直接修改数据库来绕过程序问题；
- 运行未提交到 GitHub main 的代码。

部署前只做一个保护：工作区存在未提交或未跟踪文件时停止部署，避免 `git pull` 覆盖服务器修改。正常部署脚本保持简短，只负责拉取、构建、启动和健康检查。

API key、Telegram token 和 Telegram destination binding 保存在服务器 `.env` 或 secret store，不进入 Git；`.env*`、数据库、WAL、日志和备份必须在 `.gitignore` 中，仓库只提供无真实值的 `.env.example`。

部署失败时不在服务器修代码。回到本地修复或执行 `git revert`，push main 后让服务器重新拉取部署。

## 18. 降级、健康与日志

- GMGN discovery 失败：不清 TTL 内候选；
- GMGN safety 不可用：未知候选不得进入 CoinGecko；
- Level 1 不可用：保持 qualified，不进入 armed；
- G2 断线：窗口 incomplete，重连恢复；
- credits 低水位：取消低优先候选，保留必要 Outcome；
- Telegram 失败：outbox 重试，不提前启动 Outcome；
- SQLite 锁等可恢复预警：有界重试并在仍可写时通过 outbox 发 SYSTEM_ALERT；SQLite 完全不可写时不可能依赖同一 outbox 承诺 Telegram 告警，必须使健康检查失败并输出脱敏 stderr 高优先日志；
- 服务器时钟偏差超过配置阈值：停止 production 确认和新的 Outcome 锚定，原始观察标记 timing invalid，恢复并重新满足 freshness 后才继续；
- 磁盘临界：停止新 Candidate/G2，保留必要 Outcome/outbox 并通知管理员。

健康检查返回 run mode、Git commit、config hash、schema version、server clock offset、GMGN 能力时间/429、safety 状态、池解析率/索引延迟、socket/订阅/message rate/credits、窗口覆盖、漏斗数量、outbox、Outcome、SQLite、磁盘和 Telegram 延迟。日志保存 provider、capability、chain、token、candidate、signal、config hash、eventAt、observedAt、latency、DataState、result，且 secrets 脱敏。

## 19. 测试与 Shadow

所有测试放在一个 `test/` 目录，按功能命名，不为测试类型建立多层目录。

必测：

1. 配置未知、缺失、串链或 run mode 非法时启动失败；
2. provider 类型漂移、null、空字符串和未知枚举进入 incomplete；
3. safety fatal/policy_reject 都不产生 CoinGecko 请求且分别统计，SOL/BSC 字段互不读取；
4. partial、zero、missing、unresolved 和未来 pool time 不混淆；
5. 只有 1m 数据的 Newborn 仍可按 Newborn 规则判断；
6. G2 callback 在入队前固化 observed time；event-loop lag 或同步写事务超限时相应窗口 timing incomplete；同 tx 多 leg、原始消息重发、无唯一 leg ID 的指纹碰撞、断线重连和 quote 方向正确；新 parser 从 G2/OHLCV raw events 生成 replay 结果但不改写 live trades/candles；ingest 队列溢出时退订低优先候选、将受影响窗口标记 incomplete 并取消 pending ENTRY；
7. 高成交低 buyers 不能通过 Conviction，薄池或 Top1/Top3 单笔成交集中不能通过对应 EntryQuality/Organic；
8. pre-send drift 过高、G2 窗口 incomplete 或 ENTRY 超过 TTL 时不投递，delivery drift 只进入 Outcome；
9. burn rate 超标时按优先级退订；
10. Signal + 全部已启用 ENTRY outbox 原子写入；ENTRY/REPORT/SYSTEM 的非空 dedupe key 分别防止重复事件，SYSTEM scope 不得错误合并不同 provider/chain/resource；`expires_at` 不因重试延长，成功响应保存 sent time/message id，遗留 sending 恢复为 delivery uncertain；非锚点不确定不影响主 cohort；
11. confirmed-pending-anchor 持续保留 G2/Level 1，非锚点先送达不得触发退订或 Outcome；锚点后保留 G2 至 entry 后下一 30s 边界或 entry timeout；锚点失败/过期不启动主要 Outcome，重启后未完成 Outcome/outbox 可恢复；
12. entry 必须同时通过 observed/event 时间和传输延迟校验；完整覆盖、REST 不冲突且 entry timeout 无成交为 not_executable，entry 晚于单个 horizon 为 late_entry，两者进入对应可执行率分母，只有数据缺口/冲突才是 incomplete；价格漂移只使用同池、同方向、同单位；未闭合 candle 不进 Outcome，重复/修订 candle 在各 horizon 的 evaluation cutoff 下只选唯一有效版本，晚到修订不得改写已固化结果；固定时点数据缺口为 incomplete，entry 落在对齐 candle 中间时不读取送达前 high/low；
13. 配置升级后旧 safety pass 按新 config version 重算；
14. 正式 replay 在 dirty worktree 或 snapshot/Git/run mode 版本不匹配时拒绝执行；`--set` 只生成并保存完整候选快照，不改写 live config；replay 使用临时 online-backup 副本而不长持主库读事务，不写 live candidates/trades/signals/outcomes/outbox，Candidate TTL 改变时从 raw discovery 正确重建 simulated cycles；所有模拟决策无 look-ahead，使用固定 replay delivery delay 且 actual/simulated Outcome 分开；在 live 写积压时让步，partial/unavailable 不进入完整样本分母；
15. 只有 allowlist 私聊可执行管理员只读命令，群组只能接收 ENTRY 镜像；`/report` 只执行有界索引聚合；
16. deploy.sh 在 dirty worktree 时拒绝拉取，正常情况下完成 pull、build、启动和健康检查；服务器 replay wrapper 只运行 clean main 容器中的版本化 CLI，不修改文件或直接写 SQL。

Shadow 是 production 前的实时验证阶段，它与后续 production 共用一条持续积累的原始样本流。不使用“连续运行若干自然日”作为定义，也不设置一个达到后便停止回算的固定样本边界。

- 新样本写入后即可增量更新统计；
- 任何时点都可按当前全部样本或指定历史切片重新回算；
- 回算必须保存数据截止时间、样本范围、配置版本和结果版本；
- 生产就绪度由有效样本结构、完整性、置信区间、不同时间切片稳定性和预算模拟共同评审，不由单一自然日或单一样本数自动决定；
- 进入 production 后不再并行启动实时 Shadow 路由；相同原始样本继续累计，新配置只通过不产生 outbox 的 replay 做离线 Shadow 比较。

Shadow 报告只包含来源漏斗、安全节省的 credits、两链字段完整率、池解析和索引延迟、核心 ACE 指标、Emerging 可执行率、forward return/MFE/MAE、delivery drift、延迟和 credits。

## 20. 实施顺序

1. 工程骨架、单一配置、10 张表、日志、Docker、main/CI/deploy.sh；
2. GMGN/CoinGecko adapter、provider events、fixture、DataState；
3. discovery、SOL/BSC 前置安全、主池和 Level 1；
4. G2、核心 ACE、Emerging、outbox 和三种 Telegram 消息；
5. Outcome、replay、重启恢复和关键故障测试；
6. 服务器 Shadow、持续回算、参数确认和 production 灰度。

## 21. 仍需 Shadow 决定

- 两链最低市值和 reserve；
- 年龄边界、最小观察秒数；
- unique buyers、net buy、buy share；
- Top1/Top3 集中度；
- SOL/BSC 首版 S1 启用集合和独立阈值；
- overextension、delivery drift；
- 主池排序权重；
- credits 分配、最大 Armed 数；
- Emerging Candidate TTL；
- GMGN Trending、Hot Searches 和 safety 的生产轮询频率与队列权重；
- production 统计的完整性要求。

以上只能先提供 Shadow 初始值，采集分布后决定。Smart Money、KOL、price impact、wash/bot/rat/sniper 联合规则和 Re-acceleration 属于未来扩展，不阻塞第一版。

S1 是安全风险政策，不作为收益率调参器。因为 S1 拒绝者不消耗 CoinGecko，它们没有同等 Outcome；阈值只根据字段可靠性、缺失率、风险分布和明确的风险容忍人工评审，禁止把缺失的下游收益当作“没涨”或用有偏样本优化 S1。

### 21.1 分阶段供应商验证计划

供应商验证不再作为“全部开发开始前一次性完成”的门槛。它分为接入开发前、Provider 搭建期和 production 启用前三个阶段；样本持续累计，任何时点都可重新统计。

#### A. 接入开发前

必须确认会影响基础接口和数据模型的事实：

- SOL/BSC 网络标识、地址格式和 API 鉴权可用；
- GMGN Trending 真实窗口、Hot Searches 外层结构及主要 capability 可访问；
- CoinGecko Analyst 套餐、RPM、月度 credits、50 Pool/Token 批量和 G2 基本访问；
- CoinGecko pool、base/quote、m5/m15/m30、30s OHLCV 和 Trades 的基础响应结构；
- SOL/BSC 安全字段必须使用独立白名单和独立 raw Schema；
- Newborn partial、missing、zero、unresolved 的基本语义；
- 金融数值字符串、时间戳和 nullable 字段的解析规则。

以上已通过真实 API 基础契约验证，可以开始工程、配置、数据库、Provider adapter、采样与回放模块开发。

#### B. Provider 搭建过程中

作为 Provider adapter、契约测试和故障测试的一部分逐步完成：

- 私人 GMGN Key 到位后，重新验证并发、RPM、reset、封禁和权限；公用 Token 结果不外推；
- 使用私人 GMGN Key 固化 SOL/BSC Trending、Hot Searches、Security、Token 和 Pool 脱敏 fixture；
- 验证两链所有比例字段是 0–1、百分数还是其他量纲，并覆盖 null、空字符串、异常值和类型漂移；
- 验证 BSC owner/open-source/tax 的真实字段名、缺失语义和更新时间；
- 验证 bonding curve、迁移池、目标 token 位于 quote、多 token pool；
- 实测 G2 quote 方向转换、去重、乱序、断线、重连和订阅恢复；
- 实测 CoinGecko 每 socket 订阅上限和并发 socket 上限。

未完成验证的字段只能进入 `provider_events`/raw fixture，不能启用为 S1、评分或确认表达式。若它是链必需 S0，未验证或无法解析时 safety 为 `incomplete`；其他未启用字段只作观察，不改变 safety status。

#### C. Shadow 与 production 启用前

依赖持续样本和回算完成，不设置单一自然日或固定样本截止点：

- SOL/BSC 新池索引延迟分布及 P50/P95，并按 launchpad、迁移状态和年龄分层；
- GMGN 1m/5m、Hot Searches 数据延迟及 `visiting_count` 稳定性；
- CoinGecko 批量池缓存延迟、字段缺失率和类型变化率；
- G2 在不同链、池流动性和活跃度下的消息频率、重复率、乱序率与 credits burn；
- REST、WebSocket、Outcome 的实际 monthly burn rate 和预算模拟；
- 50 池批量接近套餐 RPM 时的尾延迟、429 和恢复行为；
- 各链安全字段的缺失率、更新时间与冲突率；
- Organic Growth、EntryQuality、overextension、策略阈值的分布、稳定性和参数敏感性。

样本可随时回算；production 是否启用根据数据完整性、分层覆盖、置信区间、时间切片稳定性、预算模拟和人工评审决定。未经 fixture 和真实套餐验证的供应商字段不得写入 production 硬规则。

## 22. 完成定义

- 功能和测试全部通过；
- fatal/policy_reject 候选都不消耗 CoinGecko，且拒绝原因不混用；
- SOL/BSC 字段、S0/S1 参数和测试完全隔离；已启用 S1 缺失时 incomplete，未启用或观察字段不能改变 safety status；
- 单一配置源无隐藏默认值；
- partial/unresolved/zero/missing 正确；
- G2 credits 在预算内；
- G2 ingest 无静默丢失，队列或订阅缺口会阻止 confirmed-pending-anchor 投递；
- Conviction 的 buyers 只来自 freshness 合格的 Level 1 REST，不从 G2 trade 数推断；
- Emerging Breakout 有确定回放；
- 生产 Signal 必需证据完整率 100%；
- Telegram ENTRY/REPORT/SYSTEM 路由和延迟通过；
- 只有锚点目的地控制 Level 1/G2/entry/Outcome 生命周期；
- 过期锚点 ENTRY 不补发且不启动 Outcome，只有锚点 delivery uncertain 会退出主要绩效 cohort，投递明确采用至少一次语义；
- Outcome 分开保存整体 execution_status 与逐 horizon evaluation_status；完整覆盖下无成交或入场过晚不会被当作数据缺失，也不会从对应可执行率分母消失；
- 429、索引延迟、断线、重启、DB 锁、Telegram 故障通过；
- Shadow 样本、回算和 production 配置已评审；
- 原始样本只追加且不因回算复制或覆盖；
- replay 可用 G2/OHLCV raw events 的新 parser 计算但不改写 live trades/candles，正式 replay 可由 config version 唯一追溯当前 clean Git/parser，Outcome 不使用 entry 之前的 candle high/low；
- replay 候选快照不能覆盖 live config，采用后仍必须通过本地 `config/bot.yaml` -> main -> 服务器拉取流程；
- live Signal/Outcome 与 replay results 隔离，回算不会产生 Telegram outbox；
- 每次回算保存 config version、数据范围、data cutoff 和完整性；
- 项目只有一个 main 分支；
- 本地和 Docker 使用同一 Node major，服务器运行的代码可由 Git commit 追溯；
- 服务器 dirty worktree 时部署失败；
- deploy.sh 可完成 pull、Docker Compose 重建、启动和健康检查；
- 服务器无需修改代码或业务配置即可完成部署、采样和诊断；
- 部署、备份、恢复、预算、回滚手册齐全；
- 独立 review 无 P0/P1。

本文档确认并完成参数评审后，按第 20 节实施。
