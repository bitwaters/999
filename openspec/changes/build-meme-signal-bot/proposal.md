## Why

当前项目已经完成 GMGN Agent API 与 CoinGecko Analyst API 的基础真实性验证，并形成了稳定的开发设计基线，但尚缺少一份可由开发任务直接追踪、可通过验收场景验证的正式变更提案。现在需要把设计基线转化为清晰的能力契约和实施清单，避免在开发过程中重新解释安全顺序、两链字段、信号口径、Telegram 生命周期和回算规则，从而减少返工。

## What Changes

- 建立一个仅覆盖 Solana 与 BSC 的 Meme 代币 Emerging Breakout 信号 Bot。
- 使用 GMGN 负责候选发现、链原生安全和辅助语义；使用 CoinGecko 负责主池、批量成交广度、G2 实时成交及 30 秒 OHLCV Outcome。
- 在任何 CoinGecko 请求前完成 SOL/BSC 独立安全准入，严格区分 S0 `fatal`、S1 `policy_reject` 与数据 `incomplete`。
- 建立年龄感知的 Candidate 漏斗，正确处理 Newborn/Early/Established 及 complete/partial/zero/missing/unresolved 等数据状态。
- 只实现一种正式入场信号 `Emerging Breakout`，使用 Attention、Conviction、Organic Growth、EntryQuality 和完整性硬门槛确认。
- 通过单一有界 G2 ingest 队列、事件循环延迟保护、原始事件留存、确定性方向转换和去重规则保证实时证据可审计。
- 使用事务 Outbox 向管理员私聊、频道和群组发送不同内容，并由唯一锚点目的地控制 entry 与 Outcome 生命周期。
- 按 Telegram 锚点送达后的首个可执行成交计算 entry，保存完整收益路径，并明确区分 `not_executable`、`late_entry` 与数据 `incomplete`。
- 使用同一份持续累计的原始样本进行确定性 replay；回算不得改写在线事实、不得产生 Telegram 消息，也不得读取模拟时点之后的数据。
- 使用一个 `config/bot.yaml` 管理全部业务参数，SOL/BSC 参数分别填写；使用单体 Node.js/TypeScript、SQLite、Docker Compose 和单一 `main` 分支完成本地到服务器的交付闭环。
- 第一版不包含自动交易、第二种信号、外部社交抓取、机器学习、Web 管理后台、微服务或服务器热改配置。

## Capabilities

### New Capabilities

- `provider-data-ingestion`: GMGN/CoinGecko 数据接入、原始事件留存、数据状态、限流、G2 队列、去重与完整性保护。
- `chain-safety-gating`: SOL/BSC 独立安全 Schema、S0/S1 判定、安全新鲜度和 CoinGecko 前置准入。
- `emerging-signal-pipeline`: Candidate Cycle、年龄模式、主池、Level 1/Level 2、ACE、EntryQuality 和唯一 Emerging Breakout 确认流程。
- `telegram-delivery`: 三类消息、三个目的地、事务 Outbox、冷却、投递过期、唯一 Outcome 锚点及权限边界。
- `outcome-evaluation`: 送达后 entry、30 秒 candle 修订、收益路径、evaluation cutoff 和可执行性/完整性状态。
- `deterministic-replay`: 配置与 Git 版本追溯、模拟 Candidate Cycle、无前视回算、在线/模拟结果隔离和 SQLite 让步机制。
- `runtime-operations`: 单一配置源、10 表持久化边界、健康降级、Shadow/production 运行模式和 main 分支部署纪律。

### Modified Capabilities

无。当前项目不存在需要修改的既有 OpenSpec capability。

## Impact

- 新增 Node.js/TypeScript 模块化单体应用、测试、迁移、Docker Compose、CI 与部署脚本。
- 接入 GMGN Agent API、CoinGecko Analyst REST/G2 和 Telegram Bot API。
- 新增唯一业务配置 `config/bot.yaml`，API key 与 Bot token 继续由环境变量提供。
- 新增 SQLite 持久化，共 10 张表；原始供应商事件持续追加，在线事实与 replay 结果隔离。
- 服务器只拉取 GitHub `main` 并重新构建部署，不允许直接修改代码、业务配置或数据库。
- production 启用仍受私人 GMGN Key 验证、供应商契约 fixture、持续 Shadow 样本和参数评审约束。
