CREATE TABLE rule_config_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_hash TEXT NOT NULL,
  git_commit TEXT NOT NULL,
  run_mode TEXT NOT NULL CHECK (run_mode IN ('shadow', 'production')),
  yaml_snapshot TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (config_hash, git_commit, run_mode)
);

CREATE TABLE provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  capability TEXT NOT NULL,
  chain TEXT,
  token_address TEXT,
  pool_address TEXT,
  event_at INTEGER,
  observed_at INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_encoding TEXT NOT NULL CHECK (payload_encoding IN ('identity', 'gzip')),
  payload BLOB NOT NULL,
  billing_bucket TEXT,
  credits_estimate TEXT,
  request_meta_json TEXT,
  UNIQUE (provider, capability, observed_at, payload_hash)
);

CREATE TABLE candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
  token_address TEXT NOT NULL,
  cycle_started_at INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  pool_address TEXT,
  target_side TEXT,
  safety_status TEXT,
  safety_json TEXT,
  funnel_status TEXT NOT NULL,
  config_version_id INTEGER NOT NULL REFERENCES rule_config_versions(id),
  close_reason TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (chain, token_address, cycle_started_at)
);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_event_id INTEGER NOT NULL REFERENCES provider_events(id),
  chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  raw_side TEXT NOT NULL,
  target_side TEXT NOT NULL,
  token_amount TEXT,
  quote_amount TEXT,
  volume_usd TEXT,
  price_usd TEXT,
  event_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  tx_hash TEXT,
  provider_trade_id TEXT,
  log_index INTEGER,
  leg_index INTEGER,
  item_index INTEGER NOT NULL,
  identity_key TEXT,
  dedup_status TEXT NOT NULL,
  ambiguity_status TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  UNIQUE (chain, pool_address, identity_key)
);

CREATE TABLE candles_30s (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_event_id INTEGER NOT NULL REFERENCES provider_events(id),
  chain TEXT NOT NULL CHECK (chain IN ('sol', 'bsc')),
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  target_side TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds = 30),
  open_time INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  is_closed INTEGER NOT NULL CHECK (is_closed IN (0, 1)),
  open_price TEXT,
  high_price TEXT,
  low_price TEXT,
  close_price TEXT,
  volume TEXT,
  parser_version TEXT NOT NULL,
  UNIQUE (chain, pool_address, target_side, open_time, revision)
);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  config_version_id INTEGER NOT NULL REFERENCES rule_config_versions(id),
  signal_type TEXT NOT NULL CHECK (signal_type = 'Emerging Breakout'),
  confirmed_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  cancel_reason TEXT,
  pre_send_drift TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE delivery_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER REFERENCES signals(id),
  destination TEXT NOT NULL CHECK (destination IN ('admin_private', 'channel', 'group')),
  message_type TEXT NOT NULL CHECK (message_type IN ('ENTRY_SIGNAL', 'REPORT', 'SYSTEM_ALERT')),
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  rendered_payload TEXT NOT NULL,
  expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  attempt_started_at INTEGER,
  sent_at INTEGER,
  message_id TEXT,
  delivery_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (delivery_uncertain IN (0, 1)),
  last_error TEXT,
  UNIQUE (destination, message_type, dedupe_key)
);

CREATE TABLE outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  config_version_id INTEGER NOT NULL REFERENCES rule_config_versions(id),
  anchor_destination TEXT NOT NULL,
  anchor_delivered_at INTEGER,
  execution_status TEXT NOT NULL CHECK (execution_status IN ('executable', 'not_executable', 'incomplete')),
  execution_reason TEXT,
  entry_event_id INTEGER REFERENCES trades(id),
  entry_observed_at INTEGER,
  entry_price TEXT,
  delivery_drift TEXT,
  pre_send_drift TEXT,
  horizon_results_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (signal_id)
);

CREATE TABLE replay_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_version_id INTEGER NOT NULL REFERENCES rule_config_versions(id),
  data_start_at INTEGER,
  data_end_at INTEGER,
  data_cutoff_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  error_message TEXT
);

CREATE TABLE replay_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  replay_run_id INTEGER NOT NULL REFERENCES replay_runs(id),
  simulated_candidate_key TEXT NOT NULL,
  source_live_candidate_ids_json TEXT,
  simulated_signal_json TEXT,
  outcome_json TEXT,
  completeness_status TEXT NOT NULL CHECK (completeness_status IN ('full', 'partial', 'unavailable')),
  created_at INTEGER NOT NULL,
  UNIQUE (replay_run_id, simulated_candidate_key)
);

CREATE INDEX provider_events_observed_idx ON provider_events (observed_at, provider, capability);
CREATE INDEX provider_events_identity_idx ON provider_events (provider, capability, payload_hash);
CREATE INDEX candidates_active_idx ON candidates (chain, token_address, status, last_seen_at);
CREATE INDEX trades_identity_idx ON trades (chain, pool_address, token_address, event_at);
CREATE INDEX candles_identity_idx ON candles_30s (chain, pool_address, target_side, open_time, revision);
CREATE INDEX outbox_due_idx ON delivery_outbox (status, due_at, expires_at);
CREATE INDEX outcomes_config_time_idx ON outcomes (config_version_id, anchor_delivered_at, execution_status);
CREATE INDEX replay_results_run_key_idx ON replay_results (replay_run_id, simulated_candidate_key);
