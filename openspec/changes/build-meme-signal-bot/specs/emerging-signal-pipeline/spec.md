## Purpose

规定从 GMGN 候选发现到 Emerging Breakout 固化的唯一实时漏斗，确保年龄不足的新币不会被错误拒绝，同时任何来源、评分或数据缺口都不能绕过生产硬门槛。

## ADDED Requirements

### Requirement: 候选来源与 Cycle 必须确定
系统 SHALL 只由 Trending 1m/5m 的首次出现或 rank 改善，以及 Hot Searches 的首次出现或 visiting_count 增长创建 Candidate；离开所有发现集合超过 TTL 后关闭 Cycle，再出现时创建新 Cycle。

#### Scenario: 同一连续 Cycle 重复发现
- **WHEN** 同一 chain/token 在 TTL 内被多个允许来源重复发现
- **THEN** 系统合并发现证据且最多产生一个 Signal

### Requirement: 年龄模式必须正确处理不完整窗口
系统 SHALL 根据配置边界将池划分为 Newborn、Early、Established；Newborn/Early 使用覆盖时间、单位时间速率、最小绝对样本和 G2 最小观察时间，不得把 partial 当完整 m5，也不得仅因不足 5 分钟拒绝。

#### Scenario: 新池只有一分钟历史
- **WHEN** 安全通过的新池只有连续 1m/partial m5 数据
- **THEN** 系统按 Newborn 规则继续评估，而不是要求完整 m5/m15/m30

### Requirement: 主池必须稳定且不可拼接
系统 SHALL 使用 CoinGecko 支持且身份、base/quote、reserve、REST/G2 能力有效的池作为分析主池，并按确定排序选择；Cycle 内不得拼接两个池的数据。

#### Scenario: 主池迁移或必须切换
- **WHEN** 当前主池失效或代币迁移到另一池
- **THEN** 系统关闭旧 Cycle，并为新池重新建立 Cycle 与证据窗口

### Requirement: Level 1 与 Level 2 必须分级使用配额
系统 SHALL 通过 CoinGecko 批量快照筛选安全通过的候选，仅允许 Armed 候选发起 G2 订阅；buyers 必须来自 freshness 合格的 Level 1 REST，不得由 G2 trade 数推断。

#### Scenario: buyers 快照过期
- **WHEN** 候选满足 G2 net buy 但 Level 1 buyers 超过 freshness
- **THEN** Conviction 为 incomplete 且不得直接确认；若其他独立门槛没有明确拒绝，系统在安全重新通过后只刷新该候选 Level 1，并使用新快照重新执行完整确认

#### Scenario: 过期证据伴随明确策略拒绝
- **WHEN** Level 1 或 safety 已过期，同时 Attention、G2 completeness、Organic 或其他独立门槛已经明确拒绝
- **THEN** 系统不得为该候选发起确认专用刷新，避免为注定无法确认的候选消耗供应商配额

#### Scenario: 确认专用刷新跨过有效 G2 窗口
- **WHEN** 确认专用刷新完成时间距离原 30s G2 窗口结束已经超过 30s
- **THEN** 系统将原窗口视为 stale 且不得改用后续窗口拼接确认

### Requirement: Emerging Breakout 必须满足唯一确认表达式
系统 SHALL 仅在 candidate freshness、safety、pool stability、Attention、Conviction、Organic Growth、EntryQuality 和 evidence completeness 全部通过时固化 `Emerging Breakout` Signal；评分只能决定调度优先级。

#### Scenario: 高成交由单笔集中买入造成
- **WHEN** net buy 达标但 Top1/Top3 集中度超过 Organic 阈值
- **THEN** 候选不得生成 Signal

#### Scenario: 推送前价格过度延伸
- **WHEN** Signal 固化后 dispatch guard 判定 pre-send drift overextended
- **THEN** 系统取消 ENTRY 投递并保存未投递原因

### Requirement: 冷却必须在确认前执行
系统 SHALL 将锚点 `chain + token` 冷却作为确认前硬门槛；非锚点冷却只抑制对应镜像。主 cohort 只统计同一 config version、chain、token 的首次合格锚点送达。

#### Scenario: 新 Cycle 仍处于锚点冷却
- **WHEN** 代币重新进入发现集合但锚点冷却未结束
- **THEN** 系统不创建 Signal 或任何 ENTRY outbox
