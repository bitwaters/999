## Purpose

规定 GMGN 与 CoinGecko 数据接入的权威边界、原始证据、类型解析、实时完整性和成本保护，使所有信号与回算都能基于可追溯且不静默失真的供应商数据运行。

## ADDED Requirements

### Requirement: 供应商职责必须单一
系统 SHALL 使用 GMGN 作为候选、Attention、链安全和钱包语义的权威来源，使用 CoinGecko 作为分析主池、成交广度、G2 成交和 30 秒 OHLCV Outcome 的权威来源；同一业务字段不得跨来源平均、覆盖或拼接。

#### Scenario: 同义字段发生冲突
- **WHEN** 两个供应商对主池或方向等关键身份给出不兼容结果
- **THEN** 系统将证据标记为 `conflict` 并阻止生产确认

### Requirement: 原始事件必须可追溯且不泄密
系统 SHALL 只追加保存 discovery、安全、池快照、G2 和 OHLCV 的原始响应及 provider、capability、chain、token/pool、event_at、observed_at、schema_version、payload hash 和计费用途；不得保存 Authorization、API key、完整鉴权 URL 或请求 headers。HTTP 与 WebSocket 响应都必须执行配置化压缩前/解压后大小上限，超限证据不得进入确认。

#### Scenario: 接收到供应商响应
- **WHEN** 任一已接入 capability 返回响应或 WebSocket 消息
- **THEN** 系统保存一次不可变原始事件并可由规范化记录反向定位

#### Scenario: 请求包含密钥
- **WHEN** adapter 记录请求和响应诊断信息
- **THEN** 持久化与日志内容不包含密钥或鉴权 header

#### Scenario: 供应商返回超大响应
- **WHEN** HTTP body、WebSocket packet 或解压后的 payload 超过配置上限
- **THEN** 系统中止解析、标记对应请求/窗口 incomplete 并产生限频告警

### Requirement: 数据状态与数值解析必须保守
系统 SHALL 区分 `complete`、`partial`、`zero`、`missing`、`stale`、`invalid`、`conflict` 和 `unresolved`；金融十进制字符串必须先校验格式、有限性、范围、精度和单位，未知类型不得通过隐式强转参与规则。

#### Scenario: Newborn 只有部分窗口
- **WHEN** 池年龄不足以覆盖完整 m5 但从池创建起数据连续
- **THEN** 系统标记 `partial` 而不是 `zero` 或 `missing`

#### Scenario: 字段类型漂移
- **WHEN** 数值字段变为 null、空字符串、未知枚举或非法精度
- **THEN** 系统标记相应证据 `invalid` 或 `incomplete`，不得按零处理

### Requirement: G2 实时证据不得静默缺失
系统 SHALL 在 callback 入队前固化 observed_at，并对队列水位、event-loop lag、断线、订阅确认、重复、乱序和无法判定的重复成交进行完整性管理；任何可能丢失证据的窗口不得继续确认或投递。

#### Scenario: ingest 达到高水位
- **WHEN** G2 有界队列达到配置化高水位
- **THEN** 系统先退订最低优先 Armed 候选并保留 pending anchor 候选

#### Scenario: ingest 达到硬上限或事件循环超限
- **WHEN** 队列仍达到硬上限或 event-loop lag 超过门槛
- **THEN** 系统将受影响窗口标记 incomplete、取消其 pending ENTRY 并产生告警

### Requirement: G2 方向与去重必须确定
系统 SHALL 根据 CoinGecko pool metadata 将成交转换为目标 token 方向，目标位于 quote 时反转；去重优先使用 provider trade ID，其次使用 network、tx hash 和 log/leg index，无法确定的跨消息碰撞必须标记 ambiguous duplicate。

#### Scenario: 同一交易包含多个 leg
- **WHEN** 一个原始消息包含同 tx 的多个有效 leg
- **THEN** 系统按 item_index 保留每个 leg，不把它们误合并

#### Scenario: 无唯一 leg 标识发生碰撞
- **WHEN** 跨消息成交指纹相同且无法确认是否重复
- **THEN** 系统保留证据、标记 ambiguous duplicate，并令对应窗口 incomplete

### Requirement: 限流与 credits 必须按真实成本保护
系统 SHALL 分别执行供应商限流，并用剩余 credits、剩余月份时间和保守 rolling credits per message 估计 G2 允许速率；无法得到可信单位成本时不得假设一条消息等于一个 credit。

#### Scenario: production burn rate 超标
- **WHEN** 实际或保守估计 burn rate 超过配置预算
- **THEN** 系统取消低优先订阅并优先保留必要 Outcome

#### Scenario: 开发持续采样
- **WHEN** run mode 为开发或 Shadow 采样且没有供应商硬性限制
- **THEN** 系统只记录余额和 burn rate，不因人为 100,000 credits 阈值自动停止
