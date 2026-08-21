## Purpose

规定 Telegram 锚点送达后实际可执行 entry 与固定时点收益路径的计算口径，防止时钟混用、未闭合 candle、晚到修订和不可执行样本造成绩效虚高。

## ADDED Requirements

### Requirement: entry 必须来自锚点送达后的可执行成交
系统 SHALL 在同一 chain/pool/token 中选择 observed_at 不早于 anchor_delivered_at 且 event_at 通过传输延迟、未来偏差和锚点容忍校验的最早成交，并保存 event/observed time 与 delivery-to-entry latency。

#### Scenario: provider event time 与本机时间偏差过大
- **WHEN** 首个收到的成交超过配置化时间容忍
- **THEN** 系统不将其作为 entry，并按数据完整性规则处理

### Requirement: 执行状态与 horizon 状态必须分离
系统 SHALL 保存整体 execution_status=`executable|not_executable|incomplete` 和逐 horizon evaluation_status=`complete|late_entry|incomplete`；不得用 incomplete 隐藏完整覆盖下无成交或入场过晚。

#### Scenario: 完整覆盖但 entry timeout 无成交
- **WHEN** G2 覆盖完整、同期 REST 证据不冲突且 timeout 前无合格成交
- **THEN** execution_status 为 not_executable 并进入整体可执行率分母

#### Scenario: entry 晚于一分钟终点
- **WHEN** entry 在 1m horizon 之后但在后续 horizon 之前出现
- **THEN** 1m evaluation_status 为 late_entry，后续 horizon 继续独立判断

### Requirement: candle 必须闭合、定向且支持修订
系统 SHALL 从 anchor_delivered_at 开始采集 REST 30 秒 OHLCV，并仅使用 canonical target-token 方向的已闭合 candle；同 identity 相同值去重，值变化时追加 revision，不得覆盖旧行。

#### Scenario: 供应商修订历史 candle
- **WHEN** 相同 network/pool/target_side/interval/open_time 返回不同 OHLC
- **THEN** 系统追加带 observed_at 的新 revision 并保留旧版本

#### Scenario: entry timeout 前没有 G2 成交
- **WHEN** 系统需要判断该 Signal 是 not_executable 还是 G2 数据缺失
- **THEN** 系统只使用 event time 在锚点之后的 REST Trades，或 open time 不早于锚点后首个对齐边界的完整 OHLCV candle 进行冲突检查，不读取包含送达前区间的成交量

### Requirement: 每个 horizon 必须有确定 evaluation cutoff
系统 SHALL 使用 anchor_delivered_at+h+outcome_max_lateness 作为在线 cutoff，并只选择 cutoff 前已观测的最新有效 candle revision；固化后不得由更晚修订改写。

#### Scenario: 修订在 cutoff 后到达
- **WHEN** 供应商在 horizon 固化后返回更优或更差的 candle
- **THEN** 系统保存原始修订但不改变已固化 Outcome

### Requirement: entry partial 不得包含送达前价格
系统 SHALL 用 G2 从 entry 到下一个对齐 30 秒边界构造 entry-partial，之后才接完整 REST candle；覆盖不完整时不得使用包含 entry 前 high/low 的整根 candle。

#### Scenario: entry 位于 candle 中间
- **WHEN** entry 在 30 秒对齐 candle 的中途发生
- **THEN** MFE/MAE 起点只使用 entry 之后且覆盖完整的数据

### Requirement: 收益路径公式必须固定
系统 SHALL 使用同池、同目标方向、canonical USD price 计算 `pre_send_drift=latest_pre_send_price/confirmation_price-1`、`delivery_drift=entry_price/confirmation_price-1`、`forward_return(h)=eligible_evaluation_close(h)/entry_price-1`、`MFE(h)=max(complete_high/entry_price-1)` 和 `MAE(h)=min(complete_low/entry_price-1)`。eligible evaluation close 必须是 close_time 位于 anchor_delivered_at+h 至其后允许迟到范围内、observed_at 不晚于 cutoff 的最早 complete candle close；MFE/MAE 路径从 entry observed_at 到 anchor_delivered_at+h。默认 horizon 为 1m、5m、10m、30m、60m，并允许由唯一配置修改。

#### Scenario: 固定 horizon 缺少合格 close
- **WHEN** anchor_delivered_at+h 到允许迟到范围内没有 complete evaluation close
- **THEN** 该 horizon 为 incomplete，不用更晚价格替代固定时点

#### Scenario: 价格池、方向或单位不一致
- **WHEN** confirmation、pre-send、entry 或 candle 不能转换为同池同方向 canonical USD price
- **THEN** 系统将对应漂移或 Outcome 标记 invalid/incomplete，禁止计算

### Requirement: 报告不得隐藏分母
系统 SHALL 同时报告整体可执行率、逐 horizon 及时可执行率、完整率、not_executable、late_entry、incomplete、forward return、MFE/MAE、delivery drift、credits 和延迟；收益统计只能使用 executable 且 complete 样本。

#### Scenario: 查询绩效报告
- **WHEN** 管理员请求指定时间和配置版本的报告
- **THEN** 报告并列展示收益子样本与所有被排除状态的数量和分母
