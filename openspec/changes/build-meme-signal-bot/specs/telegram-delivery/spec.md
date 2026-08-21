## Purpose

规定 Telegram 三种消息、三个目的地、权限边界和投递生命周期，使 Shadow 与 production 共用同一实现，同时保证唯一锚点、失败恢复和绩效起点不会因多目的地而混乱。

## ADDED Requirements

### Requirement: 消息类型和目的地能力必须受限
系统 SHALL 只发送 ENTRY_SIGNAL、REPORT、SYSTEM_ALERT；管理员私聊可接收三类消息并执行只读命令，频道只接收简洁 ENTRY，群组只可镜像 ENTRY 且不得执行命令。

#### Scenario: 群组发送管理命令
- **WHEN** 用户在群组调用 status、health、credits 或 report
- **THEN** 系统拒绝执行且不泄露诊断信息

### Requirement: Shadow 与 production 必须共用一套路由
系统 SHALL 使用同一 pipeline、Outbox 和 renderer；Shadow 必须以 admin_private 为锚点并禁用 channel/group ENTRY，production 按配置启用锚点与镜像。

#### Scenario: Shadow 启用频道 ENTRY
- **WHEN** Shadow 配置启用 channel 或 group ENTRY
- **THEN** 配置校验失败且应用不得启动

### Requirement: Outbox 写入必须原子且幂等
系统 SHALL 在同一事务内写入 Signal 和所有“已启用且未被非锚点冷却抑制”目的地的 ENTRY rows；锚点冷却已在 Signal 创建前阻止确认。每条消息使用非空 dedupe_key，并以 destination、message_type、dedupe_key 唯一约束防止数据库重复事件。

#### Scenario: 同一 Signal 被重复处理
- **WHEN** pipeline 对相同 signal_id 再次请求创建 ENTRY
- **THEN** 数据库保持每个目的地最多一条有效 ENTRY outbox

### Requirement: ENTRY 投递必须有固定过期时间和发送前复核
系统 SHALL 在创建时固定 ENTRY expires_at，重试不得延长；每次发送前检查 safety freshness、Level 1 pool、G2 completeness、pre-send drift 和 TTL。

#### Scenario: ENTRY 重试时证据已过期
- **WHEN** Telegram 首次失败且重试前 safety 或 buyers/pool 快照已过期
- **THEN** 系统不发送，等待现有刷新恢复或在固定 TTL 到达后过期

### Requirement: 投递不确定性必须诚实记录
系统 SHALL 在请求前将 outbox 标记 sending；重启发现遗留 sending 时标记 delivery_uncertain，并只在各消息允许的年龄/尝试范围内重试。系统不得承诺 exactly-once。

#### Scenario: 锚点请求成功后进程崩溃
- **WHEN** Telegram 可能已接受消息但 sent_at 未落库
- **THEN** 锚点 Signal 退出主要绩效 cohort，但可保留诊断 Outcome

### Requirement: 只有唯一锚点控制 Outcome 生命周期
系统 SHALL 以配置指定目的地的 Telegram 成功响应本地时间作为 anchor_delivered_at；非锚点成功、失败或不确定不得触发 entry、退订或重复 Outcome。

#### Scenario: 非锚点先于锚点送达
- **WHEN** 管理员或群组镜像先成功而锚点仍待发送
- **THEN** 系统继续 Level 1/G2 且不启动 entry/Outcome

#### Scenario: 锚点过期
- **WHEN** 锚点 ENTRY 到达固定 expires_at 仍未成功
- **THEN** 系统停止补发、退订对应 G2 且不启动正式 Outcome
