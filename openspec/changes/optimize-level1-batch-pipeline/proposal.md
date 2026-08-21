## Why

当前 CoinGecko Level 1 每轮最多选择 SOL/BSC 各 50 池，随后对每个池串行请求 `/trades`，使一次完整探测常需约 105–120 秒；继续增加 50 池批次只会扩大串行尾延迟和 credits 消耗。CoinGecko 批量池响应已经提供 Level 1 广筛所需的 buyers、buys/sells、volume、net buy、reserve、价格、池年龄与 composition，因此应把逐池 trades 从全量普查降为少量最终候选的真实证据补全。

## What Changes

- 将 Level 1 明确分为批量筛选与最终候选证据补全：批量响应负责广筛，REST trades/G2 只负责真实 `last_trade_at`、微观成交和确认。
- 将“单请求最多 50 池”和“单链每轮最多处理多少池”拆成两个配置概念；候选超过 50 时按链自动切片为多个批次，不再静默截断。
- 使用单进程内的有界、deadline-aware 调度：临近最终截止的必要 Outcome 先晋升，确认刷新使用保留资源，其余新候选筛选、Armed 刷新、普通复查按优先级共享 CoinGecko 真实 RPM/credits 限制。
- 批量请求采用小并发并按供应商约 10 秒更新频率去重；逐池 trades 只对 Attention 与结构性批量门槛通过、获得短期 G2 容量预留或需要恢复证据的候选调用。buyers/reserve 等动态指标只用于排序和复查，不因首次不足永久拒绝。
- 保持安全前置：GMGN 链独立安全未 pass 时不得进入任何 CoinGecko 队列；SOL/BSC 分别组批和解析。
- 禁止用批量快照采集时间伪造 `last_trade_at`，禁止把缺失证据默认为 pass/stable；确认必须使用真实 trades 或 G2 事件时间。
- 通过历史 raw A/B replay 验证决策一致性、调用降幅和 credits 投影，再将唯一自适应路径部署到 Shadow/admin anchor 观察真实延迟与两链字段完整率；不保留两套运行时路由。
- 不新增微服务、消息中间件、数据库表或第二套生产路由。

## Capabilities

### New Capabilities

- `adaptive-level1-pipeline`: 在 `build-meme-signal-bot` 的安全、信号和 Outcome 硬门槛之上，定义多批 Level 1 筛选、最终候选 trades/G2 证据补全、deadline-aware 调度、credits 保护和可回放验收行为。

### Modified Capabilities

无。`build-meme-signal-bot` 尚未归档，当前不存在可合法声明的 canonical MODIFIED delta；本变更显式依赖其规范，发生冲突时原有安全、唯一信号、必要 Outcome 和 fail-closed 要求优先。本变更归档前 MUST 先归档基线变更并复核是否需要把重叠条款转换为 canonical capability 的 MODIFIED delta。

## Impact

- 主要影响 `src/app/provider-probe.ts`、CoinGecko adapter、Level 1 数据状态/批处理器、配置 schema 与相关测试。
- 继续使用 CoinGecko Analyst `/pools/multi`、`/trades`、G2 和 `/key`，不增加供应商或运行时依赖。
- 调度与策略参数仍集中在 `config/bot.yaml`，API 硬限制与项目调度限制分别校验。
- 原始 provider event、候选、Signal、Outcome 和 replay 表结构保持不变；必要的证据阶段通过现有字段/事件能力表达。
- 生产行为保持 Shadow，直到按链样本量验收通过；正式 Emerging Breakout 的 30 秒 G2 观察和完整确认表达式不放宽。
