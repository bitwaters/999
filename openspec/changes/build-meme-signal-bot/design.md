## Context

项目当前只有开发设计基线、真实 API 契约测试、预检脚本和采样资料，尚无正式应用骨架。详细业务口径以仓库根目录 `Meme信号Bot最终开发文档.md` v3.11.0 为设计依据，以本变更的七份 capability spec 为可验收行为契约。

系统只运行 Solana 与 BSC，外部依赖为 GMGN Agent API、CoinGecko Analyst REST/G2 和 Telegram Bot API。开发与业务配置只能在本地修改，通过 GitHub 单一 `main` 分支和 CI 后由服务器拉取部署；服务器持续积累原始样本，但不得热改代码、配置或数据库。

## Goals / Non-Goals

**Goals:**

- 用一个易调试、易部署的模块化单体完成 discovery、safety、screening、G2、signal、delivery、Outcome 和 replay。
- 让在线判断、Telegram 绩效锚点和 replay 在时间、配置、池方向及完整性方面可确定复现。
- 在供应商异常、SQLite 压力和消息投递不确定时宁可减少信号，也不生成缺证据的生产 ENTRY。
- 保持 SOL/BSC 安全边界和外部 provider protocol 可独立演进。
- 只持久化后续回算确实需要的原始证据和核心在线结果，不增加报表、健康或策略专用表。

**Non-Goals:**

- 不自动交易、不管理钱包或私钥、不调用 GMGN Swap。
- 不实现 Re-acceleration、实时里程碑提醒、群组命令、G3、外部社交抓取或机器学习。
- 不提供 Web 管理后台、动态服务器调参、多分支发布流、微服务或多节点高可用。
- 不在设计阶段固化仍需私人 Key/Shadow 采样决定的供应商上限和业务阈值。

## Decisions

### 1. 采用 Node.js/TypeScript 模块化单体

使用 Node.js 24 LTS、TypeScript 6 strict ESM、npm lockfile 和 `tsc`。应用目录按 `app`、`config`、`domain`、`providers`、`pipeline`、`market-data`、`delivery`、`outcomes`、`persistence`、`observability` 划分，核心规则使用无 I/O 的纯函数，provider 与 repository 通过窄接口隔离。

选择理由：三个外部接口均为 HTTP/WebSocket/Telegram I/O，单进程 Node 足以覆盖第一版负载；模块化边界可以测试和替换 provider，而不会引入跨服务部署、队列和分布式一致性成本。

替代方案：微服务、Redis 队列或 monorepo 会增加部署和故障面；Python 异步栈同样可行，但与已选技术栈及后续单应用 TypeScript 类型复用不一致。

### 2. 使用一个严格 YAML 配置与不可变配置版本

`config/bot.yaml` 是唯一业务配置。Zod Schema 负责类型、必填、白名单、范围和跨字段校验，不提供隐藏业务默认值。SOL/BSC 即使数值相同也分别填写；secrets 由环境变量注入。应用在启动/replay 时规范化配置，计算 hash，并与 Git commit、run mode、完整快照一起写入 `rule_config_versions`。

Shadow 固定以管理员私聊为锚点并关闭频道/群组 ENTRY；production 仍走相同 pipeline、Outbox 和 renderer，只按配置选择锚点与镜像。Telegram chat/user ID 全程使用十进制字符串。

替代方案：环境变量覆盖业务参数会形成不可追溯的第二配置源；把链公共安全字段抽到 common 会增加串链风险；数据库在线调参会破坏本地—main—服务器交付纪律。

### 3. 使用 SQLite WAL、10 张表和短事务单写者

使用 `better-sqlite3`、WAL、编号 SQL migration 和小型 runner。migration 版本写入 SQLite `PRAGMA user_version`，不新增 migration metadata 表。表固定为：

1. `rule_config_versions`
2. `provider_events`
3. `candidates`
4. `trades`
5. `candles_30s`
6. `signals`
7. `delivery_outbox`
8. `outcomes`
9. `replay_runs`
10. `replay_results`

所有同步写事务设置配置化行数和耗时上界，G2 原始事件批量写入；持续测量 event-loop lag，超限窗口直接 incomplete。索引优先覆盖 provider observed time、candidate active key、outbox due status、Outcome config/time 和 replay run/key。REPORT 使用有时间范围与最大扫描行数的查询，不建 reports 表。

替代方案：PostgreSQL 对当前单进程单服务器是额外运维负担；ORM 会隐藏金融字符串、索引和 migration 细节；为 health/credits/reports 建表会扩大数据模型但不提供第一版必要能力。

### 4. Provider adapter 先保存 raw，再生成不可变规范化证据

每个 GMGN capability 使用独立 raw Schema，再转换为 canonical 类型；不得用通用 truthy/falsy。CoinGecko adapter 只调用带 Analyst Key 的正式端点，不使用无 Key GeckoTerminal 公共端点；保留金融原始字符串，验证后才生成规则值。G2/OHLCV raw 可使用 Node `zlib` 压缩，规范化 trade/candle 引用 provider_event_id 和 parser_version；升级 parser 只在 replay 中读取 raw，不重写 live 记录。

G2 callback 只固化 observed_at、校验包大小和入队。队列外完成解析、压缩和短批写入。高水位先释放最低优先 Armed；硬上限、event-loop lag、断线或 ambiguous duplicate 令受影响窗口 incomplete。

替代方案：只保存规范化结果无法在供应商 Schema 或 parser 修复后可信回算；在 callback 内解析/压缩/写 SQLite 会增加阻塞和伪造 observed_at 的风险。

### 5. 安全 adapter 在 CoinGecko 前按链独立执行

漏斗顺序固定为 discovery → safety → GMGN 廉价预筛 → CoinGecko 主池/Level 1 → G2。SOL 与 BSC 分别拥有 raw Schema、canonical mapping、S0/S1 配置和测试 fixture。

安全结果使用 `pass|fatal|policy_reject|incomplete`：S0 明确合约风险是 fatal；已验证并显式启用的 S1 超阈值是 policy_reject；缺失、过期、类型异常或冲突是 incomplete。只有 pass 可发起 CoinGecko 请求。确认前按 expires_at 与 config version 复核，配置升级时用 raw 重算。

替代方案：在 Level 1/G2 后查安全会浪费 credits；跨链 common adapter 容易读取无意义占位字段；把 S1 命中也称 fatal 会污染风险审计和回算解释。

### 6. 以 Candidate Cycle 和年龄模式驱动唯一信号

Candidate active key 使用 chain+token，Cycle 由首次允许发现 observed_at 开始，离开全部发现集合超过 TTL 后结束。主池一经选定在 Cycle 内固定，切池必须关闭旧 Cycle。`decision_time` 在线使用当前判断观测时间，replay 使用模拟时间。

Newborn/Early 根据 `coverage_seconds=max(1,decision_time-max(pool_created_at,window_start))` 计算实际覆盖，并使用 buys/buyers/volume 除以 coverage seconds 的单位时间速率、最小绝对样本和 G2 最小观察时间判断；Established 才使用完整 m5/m15/m30。Level 1 批量刷新提供 reserve、pool stability、buyers 和成交广度；Armed 才能新建 G2 订阅。

唯一信号表达式为 safety、pool、Attention、Conviction、Organic Growth、EntryQuality、freshness 和 evidence completeness 的确定 AND。评分只决定订阅资源优先级。锚点冷却在 Signal 创建前检查，避免创建注定不能投递的孤立 Signal。

替代方案：按来源创建多个信号类型会让样本分散且难以比较；把 partial 缩放成完整窗口会夸大 Newborn；允许动态主池拼接会制造不可回放的价格路径。

### 7. 使用事务 Outbox 与唯一 Outcome 锚点

SignalSnapshot 和所有已启用且未被非锚点冷却抑制的 ENTRY outbox 在一个事务中写入；锚点冷却在此前已经阻止 Signal 固化。Outbox 使用 `(destination,message_type,dedupe_key)` 唯一约束：ENTRY=signal_id，REPORT=report_request_id，SYSTEM=`alert_type+scope+coalescing_window`。

ENTRY 在创建时固化 expires_at 和已渲染 payload；每次发送前只利用当前内存/既有批量刷新结果重跑 dispatch guard，不发起专用 Level 1 请求。请求前状态改为 sending，成功响应本地时间写 sent_at。遗留 sending 标记 delivery_uncertain 后才按年龄规则重试，因此语义是至少一次而非 exactly-once。

只有配置锚点的 sent_at 启动 entry/Outcome。非锚点结果只做目的地诊断。锚点 delivery uncertain 的 Outcome 可保留，但退出主 cohort。

替代方案：为 Shadow/production 或不同目的地建立两套路由会复制生命周期逻辑；直接发送后再写数据库会在崩溃时丢失投递意图；引入分布式事务无法让 Telegram 提供业务幂等键。

### 8. Outcome 使用 observed_at entry、修订 cutoff 与双层状态

锚点送达后继续 G2，选 observed_at 最早且 event_at 通过容忍校验的同池目标成交作为 entry。保留到 entry 后下一 30 秒边界以构造 entry-partial；无 entry 则保留到 timeout。

REST 30 秒 OHLCV 从 anchor_delivered_at 立即开始，按 0–10m/10–30m/30–60m 分段轮询，以便 entry timeout 时也能校验 G2 零成交。冲突检查只使用锚点之后的 REST Trades，或从锚点后首个对齐边界开始的完整 OHLCV candle，禁止把含送达前成交量的重叠 candle 当成冲突。Outcome 只使用闭合 candle；同 identity 的变化追加 revision。每个 horizon 在 `anchor_delivered_at+h+max_lateness` 固化并只使用 cutoff 前最新有效修订。

价格统一转换为同池、目标 token 方向的 canonical USD price：`pre_send_drift=latest_pre_send_price/confirmation_price-1`，`delivery_drift=entry_price/confirmation_price-1`，`forward_return(h)=eligible_close(h)/entry_price-1`，`MFE(h)=max(high/entry_price-1)`，`MAE(h)=min(low/entry_price-1)`。eligible close 选择目标时点至 lateness 容忍范围内最早且在 cutoff 前已观测的 complete candle close。MFE/MAE 区间从 entry observed_at 到 anchor_delivered_at+h；entry 所在的首个非对齐区间只使用 entry 之后 G2 构造的 partial candle。

整体 `execution_status` 和逐 horizon `evaluation_status` 分开保存。完整 G2 且 REST 不冲突的零成交是 not_executable；entry 晚于 horizon 是 late_entry；只有数据缺失/冲突才是 incomplete。收益分布只基于 executable+complete，但报告必须并列显示全部分母。

替代方案：用确认价作为 entry 无法代表用户送达后的可执行价格；用包含 entry 前价格的整根 candle 会夸大 MFE/MAE；把无成交或晚入场记为 incomplete 会系统性美化绩效。

### 9. Replay 重建模拟时间线，不复用 live 派生事实

正式 replay 只在 clean worktree 下运行，以当前 bot.yaml 或已保存完整快照加显式 `--set` 生成新完整配置版本。它从 raw discovery 重建 Candidate Cycle，并从 raw safety、pool/Level 1、G2、OHLCV 按当前 parser/config 重新产生证据；规则只能看到 simulated time 前 observed 的证据，禁止复用 live safety、Candidate、trade、candle 或 Outcome 判断。

`simulated_delivered_at=simulated_confirmed_at+replay_delivery_delay_ms`，随后重跑 dispatch guard、冷却、entry 和 Outcome。没有历史 Level 1/G2 时只能 partial/unavailable。replay 只写 replay_runs/results，不生成 outbox，也不修改 live 表。

大范围 replay 通过 SQLite online backup 增量制作指定 data cutoff 的一致临时副本；计算只读副本，结果小批写回，并在 live backlog/busy/G2 高水位时让步。

替代方案：复用 live candidate_id、signal 或 candle 会让 TTL/parser/参数变化无法真实回算；长时间读取主 WAL 会妨碍 checkpoint；随机模拟 Telegram 延迟会削弱相同输入的确定性。

### 10. 单一 main 与简单服务器部署

本地执行 lint、typecheck、test、build 和 Docker smoke；提交并 push `main` 后由 GitHub Actions 验证。服务器 `deploy.sh` 先拒绝 dirty worktree，再执行 ff-only pull、Compose rebuild/start 和健康检查。故障修复或 revert 都回到本地完成。

应用启动先严格校验配置、打开数据库、执行 migration，再连接 provider 和接受调度。停机时先停止 discovery/新订阅，再排空有界写队列并保存可恢复状态。SQLite 文件、WAL、日志、备份和 replay 临时副本位于持久化目录，不进入镜像或 Git。

替代方案：服务器热修看似更快，但会造成代码、配置与 Git 版本分离；多分支和镜像晋级流程超出当前单服务器规模。

## Risks / Trade-offs

- [GMGN 公用 Token 无法代表私人 Key 限流] → Provider adapter 先支持配置化限流和 429 reset；私人 Key 到位后用真实 fixture/负载固化参数，未验证前不启用 production。
- [CoinGecko 新池索引或 G2 覆盖延迟] → unresolved/partial/incomplete 保守处理并记录分层延迟，不用 GMGN 价格替代确认。
- [SQLite 同步写阻塞 Node 事件循环] → 有界批次、事务耗时上限、event-loop lag 门槛和 G2 窗口失效；达到实际负载迁移条件后才评审 PostgreSQL。
- [原始样本持续累计导致磁盘增长] → 容量水位、提前暂停非必要采样、定期备份和人工扩容；第一版不自动删除主样本。
- [Telegram 至少一次可能产生可见重复] → 数据库幂等、防重复调度、sending 恢复和 delivery_uncertain cohort 隔离；接受无法做到 exactly-once 的外部限制。
- [安全前置使 S1 拒绝者缺少下游 Outcome] → S1 只按风险政策和字段可靠性评审，不用有偏收益样本优化。
- [Replay 无法评估历史未采集证据的放宽规则] → 明确 partial/unavailable 并公开分母，不用未来数据或替代字段补齐。
- [固定 P95 replay delivery delay 不能模拟完整分布] → 第一版优先确定性和保守比较；保留实际 delivery latency 分布供后续研究，不在本变更引入随机模型。

## Migration Plan

1. 在本地创建应用骨架、唯一配置 Schema、10 张表初始 migration、测试与容器文件。
2. 先以 fixture 完成 provider contract、raw event、DataState 和 SOL/BSC safety adapter；确认 fatal/policy_reject 不产生 CoinGecko 调用。
3. 接入 discovery、主池、Level 1、G2 与唯一信号，但保持 `run_mode=shadow` 且只投递管理员私聊。
4. 接入 Outcome、replay、故障恢复、备份和部署 wrapper，完成自动测试与 Docker smoke。
5. 服务器从 clean main 首次部署，创建持久化卷，运行 Shadow 并持续积累样本。
6. 私人 GMGN Key、供应商边界、字段量纲、G2 limits、完整性和预算验证通过后，在本地确定 production 配置并提交 main。
7. production 首次部署前备份 SQLite 和当前配置版本；部署后核对 health 中的 commit、config hash、schema、socket、outbox 和磁盘状态。

回滚采用 `git revert` 后重新走 main/CI/deploy；数据库 migration 默认 expand-first。若新代码必须回退而 schema 已扩展，旧版本应忽略新增可空字段/表结构；涉及不可向后兼容的数据变更时必须在对应后续变更中单独提供可验证迁移和恢复脚本，本次初始建库不存在历史业务数据迁移。

## Open Questions

以下问题只决定配置值或 production 放行时间，不改变本提案的能力契约和任务结构：

- 私人 GMGN Key 的 RPM、并发、reset 与临时封禁边界。
- CoinGecko 每个 G2 socket 的订阅上限、并发 socket 上限和真实 rolling credits per message。
- SOL/BSC 首版 S1 启用集合及已验证字段的量纲、方向和阈值。
- 两链最低市值/reserve、年龄边界、buyers/net buy/buy share、Top1/Top3、overextension、TTL 与最大 Armed 数。
- 新池索引延迟、缓存延迟、完整率、可执行率和预算满足 production 的人工评审结果。
