ALTER TABLE candidates ADD COLUMN pool_retry_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE candidates ADD COLUMN pool_retry_at INTEGER;

CREATE INDEX idx_candidates_pool_retry
  ON candidates (chain, pool_address, pool_retry_at, updated_at);
