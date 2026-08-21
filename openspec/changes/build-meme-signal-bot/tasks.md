## 1. 工程与配置基础

- [x] 1.1 创建 Node.js 24、TypeScript 6 strict ESM、npm lockfile、ESLint、Prettier、node:test 和 `src/test/fixtures` 基础结构，并通过空项目 lint/typecheck/test/build。
- [x] 1.2 按设计建立 app、config、domain、providers、pipeline、market-data、delivery、outcomes、persistence、observability 模块边界，禁止路径别名和跨层反向依赖。
- [x] 1.3 定义完整 `config/bot.yaml` Zod Schema，覆盖所有窗口、阈值、TTL、队列、SQLite、replay、delivery 和 SOL/BSC 独立参数，未知键、缺失值和交叉冲突必须启动失败。
- [x] 1.4 实现配置规范化、hash、Git commit/run mode 读取与 secrets 环境变量校验，确认环境变量不能覆盖业务配置。
- [x] 1.5 增加配置测试：SOL/BSC 串链、Shadow 路由、Telegram 字符串 ID、credits 合计、锚点、队列水位和非法 run mode。

## 2. SQLite 与可追溯数据模型

- [x] 2.1 建立 better-sqlite3 WAL 连接、busy timeout、单写者 repository 边界、编号 migration runner，并用 `PRAGMA user_version` 提供 schema version 健康信息而不新增表。
- [x] 2.2 创建 10 张表及外键/唯一约束，不创建 reports、health、credits 或额外策略表。
- [x] 2.3 为 provider observed time、active Candidate、trade/candle identity、due outbox、Outcome config/time 和 replay run/key 建立并用查询计划验证索引。
- [x] 2.4 实现不可变 rule_config_version repository，并在启动时保存或复用 `config_hash + git_commit + run_mode` 完全匹配的配置版本。
- [x] 2.5 实现 provider_events 原始 payload 压缩、hash、敏感请求元数据剔除和只追加写入；增加 API key/header 不落库测试。
- [x] 2.6 实现配置化批量写入、事务行数/耗时上界和 event-loop lag 监控，超限时向上层返回可判定的 timing incomplete。

## 3. Provider 公共能力

- [x] 3.1 实现统一 HTTP adapter 基础设施：超时、取消、有限重试、429 reset、压缩前/解压后响应大小上限、provider/capability 诊断和脱敏日志。
- [x] 3.2 为每个 GMGN capability 建立独立 raw Schema 与脱敏 fixture，覆盖 boolean/integer/数字字符串/yes-no/null/空字符串/未知枚举。
- [x] 3.3 为 CoinGecko Analyst pool、50 Pool/Token 批量、G2、30s OHLCV 和 REST Trades 建立独立 raw Schema 与 fixture，并测试运行代码不调用无 Key GeckoTerminal 公共端点。
- [x] 3.4 实现金融十进制字符串、整数、时间戳、地址、单位和 DataState 解析器，并测试下溢、上溢、非法精度、future pool time 与 partial/zero/missing/unresolved。
- [x] 3.5 实现 GMGN 加权请求队列和 CoinGecko REST 限流/credits 记录，开发/Shadow 不使用 100,000 credits 人为停止线。
- [x] 3.6 实现 provider contract 测试命令，允许用真实 Key 刷新脱敏 fixture，但禁止 fixture 和日志包含 secrets。

## 4. SOL/BSC 前置安全

- [x] 4.1 实现 SOL raw-to-canonical safety adapter，只允许 mint/freeze S0 与已验证 SOL S1 白名单。
- [x] 4.2 实现 BSC raw-to-canonical safety adapter，只允许 honeypot、ownership、open-source、tax S0 与已验证 BSC S1 白名单。
- [x] 4.3 实现 BSC `ownership_renounced` 单一权威映射和冲突处理，不使用 OR 合并 is_renounced/owner。
- [x] 4.4 实现 `pass|fatal|policy_reject|incomplete` 判定、字段级原因、checked/expires/provider_event/config_version 追溯和配置升级重算。
- [x] 4.5 用 spy/fake provider 验证 fatal/policy_reject 不产生任何 CoinGecko 请求，已启用 S1 缺失为 incomplete，观察字段不改变结果。
- [x] 4.6 完成 SOL/BSC 串链与类型漂移契约测试；未有真实 fixture 的 S0 阻止 production，未验证 S1 无法启用。

## 5. Candidate、主池与 Level 1

- [x] 5.1 实现 Trending 1m/5m 和 Hot Searches discovery observed event、允许触发条件、Candidate Cycle TTL 与重复来源合并。
- [x] 5.2 实现 safety 后 GMGN 廉价预筛和 CoinGecko unresolved 退避，不允许未索引候选进入批量刷新或 G2。
- [x] 5.3 实现 Newborn/Early/Established、decision_time、coverage/rate 和最小样本规则，验证只有 1m 的 Newborn 可继续评估。
- [x] 5.4 实现 CoinGecko 主池解析、base/quote/target side 验证和确定排序；切池必须关闭旧 Cycle。
- [x] 5.5 实现按链 50 池上限的事件合批与周期刷新，保存 buyers、sellers、buys/sells、volume、net buy、reserve、pool age 和 freshness。
- [x] 5.6 实现 Armed 进入/退出、confirmed-pending-anchor 持续 Level 1 刷新和锚点冷却前置检查。

## 6. G2、ACE 与唯一信号

- [x] 6.1 实现单 socket 动态 set/unset pool、订阅确认、重连恢复、最大订阅预算和 Armed-only 新订阅规则。
- [x] 6.2 实现 callback observed_at 固化、有界 ingest 队列、高水位退订、硬上限窗口失效和 pending ENTRY 取消。
- [x] 6.3 实现 target side 转换、raw message 重发去重、trade ID/tx leg 去重、item_index 和 ambiguous duplicate 处理。
- [x] 6.4 实现滚动 30 秒 G2 聚合：net buy、buy share、Top1/Top3、覆盖、late/dedup/完整性；buyers 只读取 freshness 合格的 Level 1。
- [x] 6.5 将 Attention、Conviction、Organic Growth、EntryQuality 和统一确认表达式实现为带 config version 输入的纯函数。
- [x] 6.6 实现 SignalSnapshot 固化和 dispatch guard，验证任何来源/评分不能绕过 safety、freshness、complete 与 overextension。
- [x] 6.7 覆盖 quote 方向、多 leg、断线、queue/lag、薄池、高成交低 buyers、集中大单和 pre-send drift 的端到端 fixture 测试。

## 7. Telegram 与事务 Outbox

- [x] 7.1 实现 ENTRY/REPORT/SYSTEM renderer，并分别限制管理员、频道、群组可见字段与能力。
- [x] 7.2 实现 Signal 与全部启用且未被非锚点冷却抑制的 ENTRY rows 原子事务，以及三类 dedupe_key 和唯一约束。
- [x] 7.3 实现 Outbox 状态机、指数退避、ENTRY 固定 expires_at、REPORT/SYSTEM 最大年龄/次数和已渲染 payload 重启恢复。
- [x] 7.4 实现发送前 dispatch guard、sending/attempt_started_at/sent_at/message_id 和遗留 sending 的 delivery_uncertain 恢复。
- [x] 7.5 实现唯一 Outcome 锚点生命周期：非锚点不得启动 entry/退订，锚点过期停止补发，锚点 uncertain 退出主 cohort。
- [x] 7.6 实现管理员私聊 allowlist 与只读 `/status`、`/health`、`/credits`、`/report`，群组/频道命令必须拒绝。
- [x] 7.7 使用 Telegram fake server 覆盖成功、429、超时、成功后崩溃、重复事件、非锚点先送达和锚点过期。

## 8. Outcome 与报告

- [x] 8.1 实现锚点后 G2 保留、entry 时间/identity 校验、最早 observed_at 选择、delivery-to-entry latency 和 entry timeout。
- [x] 8.2 实现 `execution_status=executable|not_executable|incomplete`，并只用锚点后 REST Trades 或首个对齐边界后的完整 OHLCV 检查“G2 零成交”冲突。
- [x] 8.3 实现从 anchor_delivered_at 开始的 30 秒 OHLCV 分段轮询、target-token candle identity、闭合判断、完全重复去重和不可变 revision。
- [x] 8.4 实现 entry-partial、每 horizon evaluation cutoff、latest-observed revision 选择和固化后不改写。
- [x] 8.5 实现逐 horizon `complete|late_entry|incomplete`、目标时点后最早合格 close、pre-send/delivery drift、forward return、MFE、MAE 和覆盖缺口原因，并验证全部价格同池同方向同单位。
- [x] 8.6 实现按 config version/run mode/time range 的有界 REPORT，明确展示全部分母、可执行率、完整率、收益、漂移、credits 与延迟。
- [x] 8.7 测试 entry 前 high/low 不泄漏、late revision 不改结果、entry 晚于 horizon、无成交、REST/G2 冲突和固定时点缺口。

## 9. 确定性 Replay

- [x] 9.1 实现 clean worktree 校验、当前 bot.yaml 输入和“保存版本 + 显式 --set”完整候选快照，禁止第二配置文件。
- [x] 9.2 实现 replay_run 生命周期、config/Git/run mode 一致性校验、数据范围/cutoff/完整性和可恢复失败状态。
- [x] 9.3 从 raw discovery 按模拟 decision_time 重建 Candidate Cycle、年龄、TTL 与冷却，不复用 live candidate_id。
- [x] 9.4 从 raw safety、pool/Level 1、G2、OHLCV 使用当前 parser/config 直接重建主池和全部 replay 证据，不复用或写入 live 派生表。
- [x] 9.5 实现严格 observed-at 时间线、simulated confirmation/delivery、dispatch guard、entry、Outcome 和 full/partial/unavailable。
- [x] 9.6 实现 SQLite online backup page batch、一致临时副本、磁盘预检、run-id 清理、live backlog 让步和小批结果写回。
- [x] 9.7 测试 TTL/参数/parser 改变、无历史 G2、cutoff 未覆盖 horizon、无前视、actual/simulated 隔离和 replay 不生成 Outbox。

## 10. 健康、备份与部署

- [x] 10.1 实现结构化脱敏日志和健康快照，覆盖 commit/config/schema/clock/provider/socket/credits/window/funnel/outbox/Outcome/SQLite/disk/Telegram。
- [x] 10.2 实现 safety、Level 1、G2、credits、Telegram、SQLite、时钟和磁盘的保守降级与恢复状态机。
- [x] 10.3 实现 SQLite 定时备份、恢复校验、配置化保留和磁盘水位；完全不可写时健康失败并输出 stderr，而不依赖 Outbox。
- [x] 10.4 创建最小 Dockerfile、Docker Compose、持久化卷、`.env.example` 和 secrets/DB/WAL/log/backup gitignore。
- [x] 10.5 创建 GitHub Actions，执行 npm ci、lint、typecheck、test、build 和 Docker smoke。
- [x] 10.6 创建简短 deploy.sh：dirty 检查、ff-only pull、Compose rebuild/start、健康检查；不得包含服务器代码/配置修改逻辑。（`scripts/deploy.sh` 已通过 `bash -n`，并兼容面板用户持有、root 执行时的 Git safe.directory；服务器前置检查在缺少 `.env` 时按预期停止）
- [x] 10.7 创建版本化 replay/report wrapper，限定 clean main 容器运行并只通过 repository 写允许的表。

## 11. 实施验收与 Shadow 就绪

- [x] 11.1 建立规格到测试的验收矩阵，确保七份 capability spec 的每个 Scenario 至少对应一个自动测试或明确的真实供应商验证记录。
- [x] 11.2 执行全量 lint/typecheck/test/build、migration from empty、Docker smoke、重启恢复、备份恢复和 deploy dirty guard 验收。（本地全量与 Docker smoke 已通过）
- [x] 11.3 使用私人 GMGN Key 固化 SOL/BSC 脱敏 fixture，并验证 RPM、并发、reset、封禁、BSC ownership/open-source/tax 与比例量纲。（服务器曾完成 `.env` GMGN Key 合同测试 52/52；通过 `GMGN_FIXTURE_DIR` 生成 6 个脱敏 fixture，鉴权字段审查未发现；有界负载并发 2/2、5.2 秒 pacing 4/4 通过。真实 `HTTP 429 RATE_LIMIT_BANNED` 返回 reset 时间；未再次主动触发封禁，仅通过只读日志观察到 reset 后约 4 秒首个成功请求，随后 19/19 次 GMGN 请求成功。BSC 9,600 条安全记录均具备 ownership/open-source/buy-tax/sell-tax 字段，税率为十进制 0–0.1，未发现 ownership 冲突。封禁 reset 边界为被动恢复证据，未进行破坏性复测）
- [x] 11.4 实测 CoinGecko G2 quote、多 leg、重复、乱序、重连、每 socket/并发上限、rolling credits per message 和 50 池尾延迟。（按池列表 m5 活跃度选择合同测试池后，真实合同验收 34/34；GMGN 52/52）
- [ ] 11.5 在服务器以 Shadow/admin anchor 部署，持续采集并验证完整率、索引延迟、可执行率、Outcome、credits、磁盘与 replay 让步。（提交 `11f59d1` 已按 Git 流程拉取并由 deploy.sh 重建；sampler `running/healthy`、tick=5、无错误，候选注册表和新调度已生效。正式 app 仍 `unhealthy`，健康检查为 `runtime=failed`；Outcome、replay 让步和更长周期重启恢复仍未完成；用户要求暂跳过 sampler 卡顿原因排查）
- [ ] 11.6 基于累计样本完成训练/最近验证切片、参数敏感性、预算模拟和 S1 风险政策人工评审；未通过前保持 Shadow。（修复后只读审计：BSC 主源 268 个候选、240 个已查询、28 个 `not_attempted`，调度覆盖 89.55%，已查询解析率 88.75%；SOL 为 549/547/2，99.64%/100%。BSC 5/15/30/60/120 分钟成熟解析率为 66.41%/64.37%/63.44%/63.83%/67.86%，SOL 五档均为 100%；GMGN 868 calls/5 failures，CoinGecko REST 441/0、WebSocket 28/0；credits 9 个采样点且剩余 387205；无 Outcome 标签，参数敏感性不可估计，预算需人工复核，S1 全部关闭，结论保持 `hold_shadow`。原因分类和新统计口径已生效，sampler 卡顿原因按用户要求暂不展开）
- [ ] 11.7 production 配置经本地修改、main/CI 和服务器拉取部署后，核对 commit/config hash/schema/锚点/健康并记录放行结果。（服务器仓库与运行镜像 provenance 均为 `11f59d1`，config hash=`30b7b273…`、schemaVersion=3、Shadow 锚点核对一致；sampler healthy，但 app health 为 `failed`/runtime failed，deploy.sh 因健康门禁退出，保持 Shadow，不满足 production 放行）
