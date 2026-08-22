## 1. 真实合同与优化基线

- [x] 1.1 从累计 provider_events 和日志固化 SOL/BSC 当前每轮 batches、trades、完整率、P50/P95/max、429、credits burn rate 与 backlog 基线，不修改服务器数据。（只读固化于 `evidence/level1-baseline.json`：236 个完整串行轮次 P50/P95/max=77.075/106.332/260.284 秒，普通 SOL/BSC trades=8,855/9,535，429=0，服务器仍为 `9e5819e`）
- [x] 1.2 使用私人 CoinGecko Key 有界实测两链 50 池批量字段、地址未收录行为、约 10 秒更新频率、并发 2/4 和 `/key` 真实 RPM/月度额度，明确 migration/launchpad 字段的实际存在条件，保存脱敏 fixture 与合同结论；未验证字段不得成为全池必填。（`evidence/coingecko-level1-contract.json`：26/26 通过；未知地址被省略、11 秒后两链 payload 均变化、并发 2/4 成功、launchpad_details 100 池均未出现、26 请求实扣 66 credits）
- [x] 1.3 用现有 raw 统计 Attention pass、结构门槛 pass、动态指标分布/复查改善率和 G2 容量入选比例，形成“每 100 池预计需要多少 finalist trades”的分链预算模型；不得把首次 buyers/reserve 不足计为永久淘汰。（`evidence/level1-budget-model.json`：严格限制 Cycle+TTL 内证据；buyers 首次不足后恢复 SOL/BSC=19.13%/14.84%；Attention 上界=24.18/23.29 每百池，历史 G2 入选=0.06/0.76，证明 trades 必须绑定真实空闲 reservation）

## 2. 集中配置与证据模型

- [x] 2.1 在 config/bot.yaml 同一区域增加并校验批量硬上限 50、每链到期取量、批量/逐池并发、扫描间隔、merge delay、cache TTL、动态复查/最大等待、reservation TTL/重试、deadline promotion、确认与 Outcome 保留份额和 backlog 水位；禁止在代码或其他文件复制可调值。（集中于 `providers.coingecko.scheduler`，扫描间隔与供应商 cache TTL 独立且不得更长；移除 SOL/BSC 重复 merge delay）
- [x] 2.2 新增不含 lastTradeAt 的批量筛选快照和 DataState，解析两链身份、m5/m15/m30 buyers/buys/sells/volume、net buy、reserve、价格、年龄、composition，以及真实返回或已有证据中的条件适用 migration；合同承诺且适用的字段缺失/冲突 fail-closed，未验证字段不得成为全池必填，非 launchpad 普通池不得因缺少 launchpad 字段失败。（新增 `level1-screening.ts` 与 CoinGecko 批量映射；普通池不要求 launchpad/migration）
- [x] 2.3 实现链独立池稳定性判定，比较绑定池身份、base/quote、target side、REST/G2 能力和适用的 migration/graduation，移除固定 stable；证明合法 reserve/composition 变化不触发 unstable。（SOL 精确/BSC 大小写无关身份检查；明确迁移/身份/能力冲突 unstable，缺字段 incomplete，正常数值变化 stable）
- [x] 2.4 保留完整 Level1Snapshot 的真实 lastTradeAt 要求，增加由身份匹配 REST trades/G2 提升批量快照的纯函数，并测试 observedAt 绝不冒充成交时间。（`promoteLevel1ScreeningSnapshot` 仅接受匹配 REST/G2 事件；10 项针对性测试与 typecheck 通过）

## 3. 单进程 CoinGecko 调度器

- [x] 3.1 实现共享有界 deadline-aware 优先队列与统一 token bucket；非紧急工作按确认、新候选批量、Armed 批量、普通复查、Outcome 排序，达到 latest-start 的确认或 Outcome 晋升最高优先级，并将 `/key` 实际上限与配置上限取较小值。（所有 CoinGecko REST 能力统一入队，含 `/key`、池解析、批量、初始化、确认和 Outcome）
- [x] 3.2 实现 SOL/BSC 独立去重和任意数量的 50/50/余数切片；内存窗口外候选保持 SQLite due 并由后续循环重扫，输出同时覆盖已装载/未装载工作的 backlog、oldest-age 和各优先级计数。（边界测试覆盖 0/1/49/50/51/120；同池双目标只去重请求、不丢 Candidate）
- [x] 3.3 实现批量池 10 秒内存 TTL、同能力 single-flight 和有界并发；只有真实供应商请求写一份 raw event，复用不得伪造新 observedAt。（缓存/在途复用不写供应商 raw 或伪造完成事件）
- [x] 3.4 为确认与必要 Outcome 分别保留请求/RPM 和 monthly-credit 资源，实现 429/reset 退避、并发自动收敛、burn-rate/projected-exhaustion 保护；过载时先停止复查和新候选接纳，并测试 latest-start 防饿死。（无 100,000 人为阈值；credit defer 立即返回 SQLite due，避免队列自锁；供应商只有 Key 级总账单，因此删除未接入的 per-message 估算器，production 总 burn 超预算时退出普通 Armed、停止新 G2 admission 并保留 pending anchor，Shadow 只记录）
- [x] 3.5 调度循环和进程启动均从现有 active candidates、signals/outbox/outcomes 重建/补装到期工作；停止时有界排空，不新增队列表或业务表。（10 秒重扫事实源，内存 reservation 重启清空，停止先关闭调度器）

## 4. 自适应 Level 1 路径

- [x] 4.1 将 GMGN 发现、Attention 便宜预筛和链安全门禁接入调度，证明安全非 pass、旧 config 或过期 Candidate 不产生 CoinGecko 调用。（普通候选同时限制 safety pass、当前 config 与分链 TTL；anchor 生命周期单独保留）
- [x] 4.2 用批量筛选快照替代全池 `/trades` 普查；安全、Attention、Candidate freshness 与结构门槛负责资格，buyers/reserve/volume/net-buy/年龄覆盖只参与排序和有界复查，并用等待年龄提升防止新币永久饥饿。（首次动态不足不关闭 Cycle，等待超限先提升）
- [x] 4.3 按 G2 容量与确定性优先级签发绑定 Cycle/池身份且带 TTL 的 finalist reservation；每身份只允许一个初始化 `/trades` 在途请求，临时失败有界重试，成功后先原子转换为 Armed 容量再由 Armed 发起 G2；已有 Armed/pending anchor 的确认补证与恢复不重复预留，过期/离开 Cycle/身份变化时释放并允许重新竞争。（过期转换失败会回退 DB，G2 拒绝会释放实际占用；配置切换会重排旧 Armed，但不覆写已确认/交付/完成的历史锚点）
- [x] 4.4 Armed 周期刷新改用批量池 + 已持久化 G2，只有初始化、确认补证、冲突或明确恢复允许 REST trades；验证正常 Armed 不再每轮下载 300 笔 trades。（普通/Armed 周期批量路径已无 per-pool trades；普通 Armed 以集中配置租约公平轮换，pending anchor 不轮换，replay 同口径）
- [x] 4.5 将现有确认前“安全→单候选 Level 1→完整表达式”接入最高优先级，并保证原 30 秒 G2 窗口、freshness、EntryQuality 和 Telegram 路由均不放宽。（确认 pool+trades 使用 deadline 和 confirmation reserve，原表达式未改）
- [x] 4.6 解耦发现定时器与 CoinGecko/Outcome 工作完成，保持单进程和一套运行时路径，并扩展健康状态覆盖 scheduler latency/backlog/defer/failure。（GMGN 60 秒与 CoinGecko 5 秒 due 扫描独立；CoinGecko 10 秒供应商缓存不变；状态含排队/持久化 backlog、延迟、失败、拒绝和 credits）

## 5. 原始证据与确定性回放

- [x] 5.1 复用现有 provider_events/candidates/trades 结构保存批量、finalist trades/G2，并把改变业务结果的 scheduler admit/defer/reservation/release 写成无 billing bucket 的内部 runtime event；验证事件时间、优先级、身份/Cycle、原因、config version 和 cutoff 完整，不持久化无状态轮询且不增加 migration。（`runtime.scheduler.decision.v1`；缓存命中不伪造供应商完成事件）
- [x] 5.2 扩展 replay 以从 raw 时间线与目标配置重新模拟调度并重算批量筛选、finalist 资格、真实成交补证、稳定性、Armed 和完整信号；live runtime events 只作同配置审计，不复用 live candidate_id，重复回放一致且不读取未来证据。（按目标配置重算 safety/Attention/结构筛选、容量、REST 提升与 Armed；缺少替代路径原始成交时保守 unavailable，不发明证据；runtime decision 明确忽略）
- [x] 5.3 对全部累计 raw 生成 SOL/BSC 旧/新 A/B 报告，列出候选保留、无法解释的旧 pass 丢失、预计 trades/credits 降幅和延迟；任何无法解释的回归阻止部署。（`evidence/level1-ab-report.json`：旧 Armed 无解释丢失两链均 0，观察容量口径 REST 降幅 SOL/BSC=97.97%/97.29%；真实新路径延迟仍留给 Shadow cohort）

## 6. 验证与 Review

- [x] 6.1 增加单元/属性测试覆盖 0/1/49/50/51/120 池切片、跨链同地址、deadline 优先级、等待年龄提升、dynamic 首次不足后恢复、single-flight、reservation 竞争/TTL/重试、Armed 后才订阅、确认补证不重复预留、lastTradeAt 来源、普通池缺 launchpad 和稳定性冲突。（相关边界、身份、调度、reservation、证据来源和稳定性测试均通过）
- [x] 6.2 增加集成/故障测试覆盖部分批次失败、未收录池、超时、429/reset、低 RPM/credits、内存窗口溢出后 SQLite due 重扫、重启释放预留并恢复、紧急确认/Outcome 截止、低优先接纳暂停和写预算回滚。（失败批次计入 attempted、HTTP timeout 显式 abort；合同实测确认未收录池省略，其余故障门禁均有自动测试）
- [x] 6.3 执行 lint、typecheck、全量 test、build、OpenSpec strict、migration-from-empty、Docker smoke、重启恢复和 git diff check。（156 tests；schema v3、SQLite integrity=ok；生产镜像构建与容器内空库迁移通过）
- [x] 6.4 按 review skill 反复审查性能、正确性、证据语义、两链隔离、credits 与缺失测试，修复所有 finding 后重新执行全量验证。（最后修复 `/key` 控制面阻断数据面和失败批次健康统计偏乐观；最终 review 无未解决 finding）

## 7. Shadow 部署与样本验收

- [x] 7.1 仅通过本地提交、唯一 main、GitHub 和服务器 deploy.sh 部署自适应 Shadow/admin anchor；核对 commit/config hash/schema/锚点/健康且服务器 worktree clean。（`35b5ce2` 已按规定部署：config hash `ff61b38b…c5c4`、schema v3、Shadow/admin-only、全组件 healthy、服务器 main/worktree clean，sampler 已停止）
- [ ] 7.2 按 chain + git commit + config version cohort 累计，每链同一 cohort 至少 500 个有效 batch candidates 与 50 个 finalists 后进行首轮工程评审：无 rate/credit defer 样本中 safety-pass due→batch complete P95≤10 秒、reservation→Armed 后 G2 发起 P95≤10 秒，同语料 REST calls 降幅≥80%、本地并发/限流错误造成的 429=0；修复后可用新 cohort 重评但旧异常保留，defer 单列端到端延迟、credits 投影与 backlog，不按自然日清零或强制结束。
- [ ] 7.3 在真实 Signal/Outcome 样本不足时仅确认工程指标并继续 Shadow；首轮产品评审要求同一 Shadow config version 下每链至少 100 个首次合格锚点已送达且 60m 状态已固化，其中至少 60 个 executable+complete，并按时间前 70%/后 30% 划分且验证段至少 30/18 个对应样本；未达标冻结收益参数，达标后评审 Wilson 95% 区间、切片稳定性、完整率、尾部亏损和预算，失败则通过 Git main/deploy.sh 回滚。（现有 cohort report 已在本地扩展为分链、多 horizon、70/30、Wilson、收益/MAE 尾部、延迟和严格锚点一致性报告，170/170 测试通过；真实 Signal/Outcome 尚为 0，且为避免报告-only 部署截断 cohort 57，当前仍不勾选、不调参、不重启 Shadow）
- [ ] 7.4 仅在本变更准备归档时，确认 `build-meme-signal-bot` 已先归档为 canonical specs，复核重叠条款并把本变更转换为正确 capability 的 MODIFIED delta；不得阻塞本地实施或 Shadow 验证，实施期间始终以基线硬约束优先。
