## Purpose

规定项目的单一配置、持久化边界、运行模式、健康降级和本地到服务器交付纪律，使系统保持简单、可维护、可恢复并能从版本和原始证据追溯。

## ADDED Requirements

### Requirement: 业务配置必须只有一个来源
系统 SHALL 只从 config/bot.yaml 读取业务参数，严格拒绝未知键、缺失值、越界值和交叉约束冲突；代码不得提供隐藏业务默认值，secrets 只能来自环境变量。

#### Scenario: SOL 或 BSC 缺少独立 safety 配置
- **WHEN** 任一链依赖 common safety 或缺少必填链参数
- **THEN** 启动校验失败

### Requirement: 配置版本必须不可变可追溯
系统 SHALL 在启动和正式 replay 时保存规范化完整配置快照、config hash、Git commit、run mode 和创建时间，并由业务事实引用 config_version_id。

#### Scenario: 查看历史 Signal
- **WHEN** 管理员或 replay 读取某个历史 Signal
- **THEN** 可以定位其完整配置快照、代码 commit 和运行模式

### Requirement: 第一版持久化边界必须固定
系统 SHALL 只使用 rule_config_versions、provider_events、candidates、trades、candles_30s、signals、delivery_outbox、outcomes、replay_runs、replay_results 十张业务表；报告和 provider health 不得新增常驻表。

#### Scenario: 生成按需报告
- **WHEN** 管理员请求 REPORT
- **THEN** 系统从有界 Outcome/replay 汇总生成，不创建 reports 表

### Requirement: 故障必须保守降级
系统 SHALL 在 safety 不可用、Level 1 不可用、G2 断线、时钟偏差、SQLite 锁、磁盘水位或 Telegram 故障时保护现有事实并阻止不完整信号，不得把未知状态解释为通过。

#### Scenario: SQLite 完全不可写
- **WHEN** 系统无法写入同一 Outbox 发送数据库告警
- **THEN** 健康检查失败并输出脱敏高优先级 stderr 日志，不虚假承诺 Telegram 告警

### Requirement: 原始样本必须持续累计
系统 SHALL 不自动删除或薄化主库 provider events、trades、candles 和 Outcome；磁盘水位应提前暂停非必要采样并告警，备份按配置保留。

#### Scenario: 磁盘达到高水位
- **WHEN** 剩余空间低于配置安全水位
- **THEN** 系统停止新 Candidate/G2，优先完成必要 Outcome/outbox 并暴露健康告警

### Requirement: 服务器不得成为开发环境
系统 SHALL 只允许服务器执行 clean main 的 ff-only pull、Docker Compose 构建/重启、健康诊断、备份、样本导出和版本化 replay/report wrapper；不得直接修改代码、bot.yaml、migration、Compose 或数据库。

#### Scenario: 服务器 worktree 存在未跟踪文件
- **WHEN** deploy.sh 检测到 dirty worktree
- **THEN** 部署停止且不得执行 git pull

### Requirement: 质量门槛必须自动验证
系统 SHALL 在本地和 CI 执行 lint、typecheck、test、build，并在部署后执行健康检查；production 启用前必须完成规定的私人 GMGN、供应商 fixture、Shadow 完整性和预算评审。

#### Scenario: CI 或启动健康检查失败
- **WHEN** main commit 未通过自动验证或新容器不健康
- **THEN** 该版本不得被视为可生产运行版本，修复必须回到本地完成
