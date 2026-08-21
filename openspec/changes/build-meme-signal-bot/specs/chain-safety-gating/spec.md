## Purpose

规定 Solana 与 BSC 候选在消耗 CoinGecko 配额前必须完成的链原生安全准入，确保两条链的字段、类型、阈值、缺失语义和拒绝原因严格隔离且可审计。

## ADDED Requirements

### Requirement: 安全准入必须前置
系统 SHALL 在任何 CoinGecko 请求前完成 GMGN 内联安全判断；字段不足时只允许补查 GMGN 安全 capability，结果为 pass 后才可进入 CoinGecko。

#### Scenario: S0 fatal 或 S1 policy reject
- **WHEN** 候选命中 S0 fatal 或已启用 S1 的 policy_reject
- **THEN** 系统结束 Candidate Cycle、分别保存拒绝原因且不调用 CoinGecko

#### Scenario: 必需安全字段缺失
- **WHEN** 必需字段缺失、过期、无效或冲突
- **THEN** 系统保持 safety incomplete 并重试或过期，不允许继续漏斗

### Requirement: SOL 与 BSC 安全字段必须隔离
系统 SHALL 为 SOL 和 BSC 使用独立 raw Schema、canonical adapter、白名单、参数和 fixture；SOL 不得读取 honeypot/owner/open-source/tax，BSC 不得读取 mint/freeze。

#### Scenario: 响应包含另一链占位字段
- **WHEN** SOL 响应包含 BSC 风格通用占位值或反之
- **THEN** adapter 忽略该字段且不得影响安全结果

### Requirement: S0 与 S1 语义必须分离
系统 SHALL 始终启用链必需 S0，并只允许已完成字段名、方向和量纲验证的 S1 显式启用；S0 合约风险使用 `fatal`，S1 风险政策使用 `policy_reject`，二者不得混为一个统计原因。

#### Scenario: 未验证的 S1 字段
- **WHEN** S1 字段尚未完成真实 fixture 和量纲验证
- **THEN** 系统只保存观察证据且禁止将其配置为启用

#### Scenario: 已启用 S1 缺失
- **WHEN** 已启用 S1 在本次判断中缺失或无效
- **THEN** safety status 为 incomplete，而不是 pass 或 policy_reject

### Requirement: BSC ownership 必须有单一 canonical 语义
系统 SHALL 由一个已验证映射产生 `ownership_renounced`；优先使用已验证 is_renounced，否则使用已验证 owner 语义，两者同时存在且冲突时不得使用 OR 合并。

#### Scenario: ownership 来源冲突
- **WHEN** is_renounced 与 owner 语义给出相反结果
- **THEN** 系统将安全判断标记为 incomplete/conflict 并阻止确认

### Requirement: 安全结果必须具备新鲜度和版本
系统 SHALL 为安全判断保存 checked_at、expires_at、provider_event_id 和 config_version_id；确认前只有未过期且配置版本一致的 pass 才可复用。

#### Scenario: 配置升级后复用旧 pass
- **WHEN** 候选的安全 pass 属于旧 config version
- **THEN** 系统使用保存的 raw 按新版本重算，raw 不足时重新请求，失败则不推送

#### Scenario: 确认窗口到达时安全 pass 已过期
- **WHEN** G2 窗口已具备确认价值，但候选安全 pass 已过期
- **THEN** 系统先按对应链重新请求 GMGN Token Security 并保存新证据；只有新结果为 pass 才允许为该候选刷新 CoinGecko Level 1
