# 验收矩阵

更新时间：2026-08-21

| Capability spec | 关键场景 | 自动测试/真实验证证据 | 状态 |
| --- | --- | --- | --- |
| chain-safety-gating | SOL/BSC 字段隔离、S0/S1 不完整、ownership 冲突、freshness | `src/domain/safety.test.ts`；`scripts/provider-preflight.mjs` 的 GMGN SOL/BSC trending 字段检查 | 通过（S0 fixture 与真实字段已覆盖） |
| provider-data-ingestion | 类型漂移、压缩 raw、超大响应、429、G2/OHLCV schema、无 Key 公共端点 | `src/providers/*.test.ts`；`src/persistence/db.test.ts`；`scripts/coingecko-real-contract.mjs` | 通过（CoinGecko 真实合同验收 34/34；合同池按 m5 活跃度选择） |
| emerging-signal-pipeline | age/window coverage、candidate TTL/cooldown、ACE hard gates、G2 duplicate/ambiguous | `src/pipeline/*.test.ts`、`src/market-data/g2.test.ts` | 通过 |
| telegram-delivery | allowlist、群组拒绝、retry/429、sending 恢复、非锚点先送达、原子写 | `src/delivery/*.test.ts`；Telegram `getMe`/admin/group 只读预检 | 部分通过：配置频道 chat 不存在 |
| outcome-evaluation | entry identity/time、entry-partial、revision cutoff、late entry、固定 close、报告分母 | `src/outcomes/*.test.ts` | 通过 |
| deterministic-replay | clean main、config override、TTL 重建、无前视、隔离写入、backup、让步/失败恢复 | `src/replay/*.test.ts` | 通过（未执行服务器大范围 replay） |
| runtime-operations | 10 表边界、health/degrade、backup restore、dirty deploy guard、CI/Docker smoke、长期运行入口 | `src/persistence/db.test.ts`、`src/runtime/*.test.ts`、`src/app/main.ts`、`src/app/provider-probe.ts`、`src/app/live-signal.test.ts`、`src/delivery/worker.test.ts`、`src/outcomes/evaluation.test.ts`、`src/providers/coingecko-ohlcv.test.ts`、`src/domain/safety.test.ts`、`scripts/deploy.sh`、Docker build/run | 部分通过：`deploy.sh` 已通过 shell 语法检查并在无 `origin` 时安全停止；应用容器已具备长期 runtime foundation，并可由 Compose 等待；真实 provider connectivity/discovery probe 可写入 GMGN 原始事件、Candidate Cycle、初始 SOL/BSC safety classification、CoinGecko 主池/Level1 事件，Armed→G2→规范化 trades→闭合 30 秒窗口→Signal/ENTRY outbox→anchor delivery→30 秒 OHLCV revision/cutoff Outcome runtime 与发送前 dispatch guard 已接入，磁盘高水位会阻止新 discovery，独立原始 Shadow sampler 也可运行。但真实 provider 的长期运行、服务器部署和累计 Outcome 样本仍未完成 |

## 真实供应商结果

- GMGN 预检：SOL/BSC trending 1m/5m、hot-searches 通过；修正 interval 与 1000ms pacing 后深测 52/52 通过。最新有界边界探针以 4 路并发、随后 1 秒 pacing 交替请求 10 次，共 14/14 通过，未观察到 reset/429/封禁；此前观察到真实 rate-limit ban，因此未主动扩大压力，服务端 reset/封禁边界仍未证实。
- CoinGecko 深测：本次重跑 34/34 通过，覆盖 50 池批量、50 token 批量、REST trades、30 秒 base/quote OHLCV、G2/G3 WebSocket、SOL/BSC 和 credits 计数；REST credit delta=29。合同脚本按池列表 m5 活跃度选取 WebSocket 测试池，避免把无事件的列表首池误判为协议失败。
- Telegram 只读预检：GMGN/CoinGecko 通过；Telegram `getMe` 因到 Telegram IP 的 `ETIMEDOUT/EHOSTUNREACH` 失败，未发送消息；此前成功记录仍显示 admin private/group 通过、配置 channel 为 `chat not found`。
- Docker smoke：当前提交镜像 `999-app:acceptance` 重建成功，容器 healthcheck 输出 healthy，SQLite schemaVersion=2；宿主机 healthcheck 因磁盘高水位而诚实失败；dirty deploy guard 在未提交工作树下于 `git pull` 前以 exit=1 拒绝。Compose 仍包含长期 app、Telegram outbox worker 与带健康检查的原始 Shadow sampler；本次结果证明容器可构建和健康检查通过，但不等同于真实 provider 长期运行或服务器部署。
- 服务器检查：SSH `lumi-server` 可达，主机为 `dwhkmZxyd8sskPaG`；本地 `main` 已推送到 `https://github.com/bitwaters/999.git`，服务器 `/www/wwwroot/999` 通过 Git 克隆到同一提交，Compose 配置校验和 Docker 构建均通过，临时凭据的容器 healthcheck 输出 healthy、schemaVersion=2。服务器尚未配置真实 `.env`，未启动真实 provider/Telegram/Shadow 长期采样，也未使用占位凭据启动服务。
- 累计采样只读审计：145 provider calls、GMGN 84 calls/16 failures（429/temporary ban）、CoinGecko REST 45/0 failures、BSC indexing 40/460（8.7%）、SOL indexing 306/310、WebSocket 353 events、credits 仅 4 个采样点；最近 5 分钟切片 GMGN 35/0 失败但 BSC indexing 仅 7/300（2.33%）；Outcome 标签缺失、参数敏感性不可估计，S1 全部保持关闭；审计结论为 `hold_shadow`，不支持 production。

## 外部验收保留项

服务器 Shadow 部署、持续累计样本、重启恢复、实际 replay 让步、训练/最近验证切片、参数敏感性、预算评审和 production 放行核对需要服务器与持续运行状态，不能由本地静态代码验收替代。当前配置应保持 `run_mode: shadow`。
