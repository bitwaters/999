# 验收矩阵

更新时间：2026-08-21

| Capability spec | 关键场景 | 自动测试/真实验证证据 | 状态 |
| --- | --- | --- | --- |
| chain-safety-gating | SOL/BSC 字段隔离、S0/S1 不完整、ownership 冲突、freshness | `src/domain/safety.test.ts`；`scripts/provider-preflight.mjs` 的 GMGN SOL/BSC trending 字段检查 | 通过（S0 fixture 与真实字段已覆盖） |
| provider-data-ingestion | 类型漂移、压缩 raw、超大响应、429、G2/OHLCV schema、无 Key 公共端点 | `src/providers/*.test.ts`；`src/persistence/db.test.ts`；`scripts/coingecko-real-contract.mjs` | 通过（CoinGecko 真实脚本 34/34） |
| emerging-signal-pipeline | age/window coverage、candidate TTL/cooldown、ACE hard gates、G2 duplicate/ambiguous | `src/pipeline/*.test.ts`、`src/market-data/g2.test.ts` | 通过 |
| telegram-delivery | allowlist、群组拒绝、retry/429、sending 恢复、非锚点先送达、原子写 | `src/delivery/*.test.ts`；Telegram `getMe`/admin/group 只读预检 | 部分通过：配置频道 chat 不存在 |
| outcome-evaluation | entry identity/time、entry-partial、revision cutoff、late entry、固定 close、报告分母 | `src/outcomes/*.test.ts` | 通过 |
| deterministic-replay | clean main、config override、TTL 重建、无前视、隔离写入、backup、让步/失败恢复 | `src/replay/*.test.ts` | 通过（未执行服务器大范围 replay） |
| runtime-operations | 10 表边界、health/degrade、backup restore、dirty deploy guard、CI/Docker smoke、长期运行入口 | `src/persistence/db.test.ts`、`src/runtime/*.test.ts`、`scripts/deploy.sh` dirty guard、Docker build/run | 部分通过：Compose 已可启动并等待独立原始 Shadow sampler，应用容器仍只有一次性 healthcheck；没有正式长期 Signal/Outcome Bot runtime |

## 真实供应商结果

- GMGN 预检：SOL/BSC trending 1m/5m、hot-searches 通过；修正 interval 与 1000ms pacing 后深测 52/52 通过。受控负载探针以 2 路并发和 5.2 秒间隔各链交替 4 次全部通过，未观察到 reset/429；此前观察到真实 rate-limit ban，因此未执行会主动扩大封禁风险的压力测试，RPM 上限和 reset 边界仍未证实。
- CoinGecko 深测：34/34 通过，覆盖 50 池批量、50 token 批量、REST trades、30 秒 base/quote OHLCV、G2/G3 WebSocket、SOL/BSC 和 credits 计数。
- Telegram 只读预检：`getMe`、admin private、group 通过；配置的 channel chat 返回 `chat not found`，未发送消息。
- Docker smoke：`meme-signal-bot:local` 构建成功；一次性容器 healthcheck 通过，SQLite schemaVersion=1、status=healthy；dirty deploy guard 在未提交工作树下于 `git pull` 前以 exit=1 拒绝。Compose 现在包含带健康检查的原始 Shadow sampler，并由 `deploy.sh` 使用 `up -d --wait` 启动；该结果仍不证明长期 Signal/Outcome Bot 已启动，需正式 runtime 后重验。
- 服务器检查：SSH `lumi-server` 可达，但未发现本项目 Git 根目录、Compose 文件或对应容器；现有 `/www/wwwroot/818`、`/www/wwwroot/dianzigou`、`/www/wwwroot/dianzigoubot` 均为其他项目，未执行任何远端写入；本地仓库也未配置 `origin`，因此无法伪造 `git pull`/服务器部署放行。
- 累计采样只读审计：145 provider calls、GMGN 84 calls/16 failures（429/temporary ban）、CoinGecko REST 45/0 failures、BSC indexing 40/460（8.7%）、SOL indexing 306/310、WebSocket 353 events、credits 仅 4 个采样点；最近 5 分钟切片 GMGN 35/0 失败但 BSC indexing 仅 7/300（2.33%）；Outcome 标签缺失、参数敏感性不可估计，S1 全部保持关闭；审计结论为 `hold_shadow`，不支持 production。

## 外部验收保留项

服务器 Shadow 部署、持续累计样本、重启恢复、实际 replay 让步、训练/最近验证切片、参数敏感性、预算评审和 production 放行核对需要服务器与持续运行状态，不能由本地静态代码验收替代。当前配置应保持 `run_mode: shadow`。
