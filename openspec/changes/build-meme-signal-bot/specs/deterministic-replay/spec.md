## Purpose

规定持续累计原始样本的确定性回算、版本追溯、无前视时间线和在线隔离，使参数可以随时重算而不会污染生产事实、配置或 Telegram 投递。

## ADDED Requirements

### Requirement: replay 输入必须可唯一追溯
系统 SHALL 仅允许使用当前完整 bot.yaml，或“已保存完整配置版本 + 显式 --set”在内存生成候选快照；正式 run 必须绑定规范化 config hash、当前 clean Git commit 和 run mode。

#### Scenario: worktree 不干净或版本不匹配
- **WHEN** 正式 replay 在 dirty worktree 或旧 Git config version 下启动
- **THEN** 系统拒绝执行且不创建有效结果

### Requirement: replay 不得改变 live 配置或事实
系统 SHALL 只写 replay_runs、replay_results 和必要的 rule_config_versions；不得写 live candidates、trades、candles、signals、outcomes、outbox，也不得直接把候选快照变成运行配置。

#### Scenario: 采用某组 replay 参数
- **WHEN** 人工决定使用候选参数
- **THEN** 参数必须在本地写回唯一 bot.yaml、提交 main 并由服务器重新部署

### Requirement: Candidate Cycle 必须按模拟配置重建
系统 SHALL 从原始 discovery observed_at 按本次 TTL、来源、年龄和冷却规则重建 simulated cycle，并从 raw safety、pool/Level 1、G2 和 OHLCV 按本次 parser/config 重新产生证据，不得沿用 live candidate_id 或其他 live 派生判断作为回算边界。

#### Scenario: 修改 Candidate TTL
- **WHEN** replay 配置缩短或延长 TTL
- **THEN** simulated candidate key 和 Cycle 边界按新配置重新计算

#### Scenario: 修改安全或 Level 1 阈值
- **WHEN** replay 使用不同的 S1、buyers、reserve 或 net buy 配置
- **THEN** 系统从对应 raw provider events 按模拟 observed-at 时间线重新判断，不复用 live safety/Level 1 结果

### Requirement: replay 必须严格无前视
系统 SHALL 只允许模拟决策读取模拟时点前已 observed_at 的 evidence；simulated delivery 使用确定 replay_delivery_delay，并在该时点重跑 dispatch guard。

#### Scenario: 后到达的安全或 Level 1 数据可补足早期缺口
- **WHEN** 某证据在 simulated_confirmed_at 之后才被观察到
- **THEN** replay 不得将其用于更早决策，结果标记 partial/unavailable 或等待模拟时间推进

### Requirement: 模拟 Outcome 必须遵循同一时间与完整性口径
系统 SHALL 使用 simulated_delivered_at 计算 entry、execution/evaluation status 和 cutoff；actual Outcome 与 simulated Outcome 必须分开存储和报告。

#### Scenario: replay data cutoff 早于某 horizon cutoff
- **WHEN** 历史数据尚未覆盖完整 evaluation cutoff
- **THEN** 该 horizon 标记 partial/unavailable，不使用未来修订补齐

### Requirement: replay 不得阻塞实时写入
系统 SHALL 对大范围 replay 使用固定 data cutoff 的 SQLite 一致副本，计算阶段只读副本，并在 live 写积压、busy 或 G2 高水位时让步；结果以小批短事务写回。

#### Scenario: live G2 写入出现积压
- **WHEN** replay 复制或写回期间检测到实时高水位
- **THEN** replay 退避或中止，实时 trades、outbox 和 Outcome 优先
