# 验收矩阵

更新时间：2026-08-21

| Capability spec | 关键场景 | 自动测试/真实验证证据 | 状态 |
| --- | --- | --- | --- |
| chain-safety-gating | SOL/BSC 字段隔离、S0/S1 不完整、ownership 冲突、freshness | `src/domain/safety.test.ts`；`scripts/provider-preflight.mjs` 的 GMGN SOL/BSC trending 字段检查 | 通过（S0 fixture 与真实字段已覆盖） |
| provider-data-ingestion | 类型漂移、压缩 raw、超大响应、429、G2/OHLCV schema、无 Key 公共端点 | `src/providers/*.test.ts`；`src/persistence/db.test.ts`；`scripts/coingecko-real-contract.mjs` | 通过（CoinGecko 真实合同验收 34/34；合同池按 m5 活跃度选择） |
| emerging-signal-pipeline | age/window coverage、candidate TTL/cooldown、ACE hard gates、G2 duplicate/ambiguous | `src/pipeline/*.test.ts`、`src/market-data/g2.test.ts` | 通过 |
| telegram-delivery | allowlist、群组拒绝、retry/429、sending 恢复、非锚点先送达、原子写 | `src/delivery/*.test.ts`；Telegram `getMe`/admin/channel/supergroup 只读预检 | 部分通过：服务器 `.env` 的四个 Telegram destination bindings 与只读连通性均通过；Shadow 仍只启用 admin private 锚点，未发送真实消息 |
| outcome-evaluation | entry identity/time、entry-partial、revision cutoff、late entry、固定 close、报告分母 | `src/outcomes/*.test.ts` | 通过 |
| deterministic-replay | clean main、config override、TTL 重建、无前视、隔离写入、backup、让步/失败恢复 | `src/replay/*.test.ts` | 通过（未执行服务器大范围 replay） |
| runtime-operations | 10 表边界、health/degrade、backup restore、dirty deploy guard、CI/Docker smoke、长期运行入口 | `src/persistence/db.test.ts`、`src/runtime/*.test.ts`、`src/app/main.ts`、`src/app/provider-probe.ts`、`src/app/live-signal.test.ts`、`src/delivery/worker.test.ts`、`src/outcomes/evaluation.test.ts`、`src/providers/coingecko-ohlcv.test.ts`、`src/domain/safety.test.ts`、`scripts/deploy.sh`、Docker build/run | 部分通过：`deploy.sh` 已通过 shell 语法检查并在无 `origin` 时安全停止；应用容器已具备长期 runtime foundation，并可由 Compose 等待；真实 provider connectivity/discovery probe 可写入 GMGN 原始事件、Candidate Cycle、初始 SOL/BSC safety classification、CoinGecko 主池/Level1 事件，Armed→G2→规范化 trades→闭合 30 秒窗口→Signal/ENTRY outbox→anchor delivery→30 秒 OHLCV revision/cutoff Outcome runtime 与发送前 dispatch guard 已接入，磁盘高水位会阻止新 discovery，独立原始 Shadow sampler 也可运行。但真实 provider 的长期运行、服务器部署和累计 Outcome 样本仍未完成 |

## 真实供应商结果

- GMGN 预检：SOL/BSC trending 1m/5m、hot-searches 通过；服务器使用真实 `.env` GMGN Key 完成过完整合同测试 52/52，并通过 `GMGN_FIXTURE_DIR` 生成 6 个脱敏 fixture，鉴权字段审查未发现；有界负载以 2 路并发、随后 5.2 秒 pacing 交替请求 4 次，共并发 2/2、节流 4/4 通过。最终合同重跑在 `token.holders.sol` 收到真实 `HTTP 429 RATE_LIMIT_BANNED` 和 reset 时间，暴露脚本对 ban 重试的缺陷；`a247168` 已改为遇到 429/ban 立即停止并有自动测试。真实 ban 已证实，但未主动触发 reset 边界，保持 Shadow。
- CoinGecko 深测：本次重跑 34/34 通过，覆盖 50 池批量、50 token 批量、REST trades、30 秒 base/quote OHLCV、G2/G3 WebSocket、SOL/BSC 和 credits 计数；REST credit delta=29。合同脚本按池列表 m5 活跃度选取 WebSocket 测试池，避免把无事件的列表首池误判为协议失败。
- Telegram 只读预检：服务器 `.env` 的 `600` 权限和必需变量校验通过；Telegram `getMe`、admin private、channel、supergroup 全部通过，未发送消息；Shadow 仍只启用 admin private 锚点，channel/group 保持禁用。
- Docker smoke：本地容器构建、healthcheck、dirty deploy guard 已通过；历史 smoke 使用 schemaVersion=2，当前服务器部署已通过迁移 003 升级到 schemaVersion=3。Compose 仍包含长期 app、Telegram outbox worker 与带健康检查的原始 Shadow sampler；这不等同于真实 provider 长期运行或 production 放行。
- 服务器检查：SSH `lumi-server` 可达，主机为 `dwhkmZxyd8sskPaG`；本次服务器部署使用提交 `909642b`，最近一次 Compose 构建也由 `909642b` 产生（相对代码提交 `3f48de7` 仅包含验收文档更新），真实 `.env` 配置解析通过，runtime config hash/schemaVersion=3/Shadow 锚点与构建 provenance 均核对一致；GMGN ban 后 sampler 曾因缺少请求超时停滞，部署 timeout 修复后恢复 `running/healthy`，采样卷持久化正常。迁移后的 BSC 未解析候选已持久化 `pool_retry_attempt/pool_retry_at`；app runtime 只读快照显示 provider/safety/Telegram/SQLite/event-loop 正常、Level 1 failed、G2 unknown；候选表中 BSC 有 1,866 个未过期候选、1,476 个已解析池、1,670 个安全通过，现有证据指向候选级 Level 1 部分覆盖而非 API 故障。最新 runtime health 为 `failed`（Level 1/G2 runtime gate 未通过、磁盘高水位为 false），本次 deploy.sh 因健康门禁正确返回失败；这不等同于 production 放行。
- 服务器最新采样只读审计：946 provider calls（GMGN 614/610、CoinGecko REST 312/312、WebSocket 20/20），累计窗口约 107.5 分钟；累计 BSC indexing 186/5126=3.63%、唯一 token 186/2885=6.45%，SOL 3081/3179=96.92%、唯一 token 3081/3087=99.81%；退避后最近 5 分钟 BSC 8/250=3.20%、唯一 token 8/211=3.79%，SOL 167/167=100%。BSC 辅助采样来源 `trenches/new_creation` 36/2926、辅助采样 `trending` 148/203；credits 6 个采样点且剩余 389971。Outcome 表当前为 0 行、参数敏感性不可估计，预算需人工复核，S1 全部保持关闭；replay/report guard 输出 `writes=[]`；审计结论为 `hold_shadow`，不支持 production。
- BSC 低索引率根因与修复：线上 Bot 的 SOL/BSC 主发现源是 `trending 1m/5m`，另加 `hot-searches 1m`；持续采样器为观察 newborn 覆盖额外采集了 `market trenches --type new_creation`，因此审计中的 `trenches` 是辅助采样来源，不是线上 1m/5m 主源。真实 GMGN BSC trending 1m/5m 端点分别可匹配 18/20、17/20，且本轮 GMGN/CoinGecko 请求失败率均为 0，排除 Key、地址大小写和 BSC 解析故障；辅助采样的 `trenches/new_creation` 新生候选低覆盖，说明其 CoinGecko 主池信息存在可观测延迟。此前 sampler 对未解析 token 重复尝试并把重复尝试作为分母，放大了低索引率；`ee42f27` 新增迁移 003 的持久化指数退避、按唯一 token/来源拆分指标，并将采样器重试退避设为 60 秒起、上限 600 秒。当前仍保持 Shadow，等待更长时间窗口验证延迟后补齐池信息。

## 外部验收保留项

服务器 Shadow 部署、持续累计样本、重启恢复、实际 replay 让步、训练/最近验证切片、参数敏感性、预算评审和 production 放行核对需要服务器与持续运行状态，不能由本地静态代码验收替代。当前配置应保持 `run_mode: shadow`。
