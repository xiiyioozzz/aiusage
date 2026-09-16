CREATE TABLE IF NOT EXISTS hourly_usage_breakdown (
  device_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  usage_hour INTEGER NOT NULL,
  provider TEXT NOT NULL,
  product TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'cli',
  model TEXT NOT NULL DEFAULT 'unknown',
  project TEXT NOT NULL DEFAULT 'unknown',
  project_display TEXT,
  project_alias TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  cost_status TEXT NOT NULL DEFAULT 'exact',
  pricing_version TEXT,
  extra_metrics_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (device_id, usage_date, usage_hour, provider, product, channel, model, project),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
);

CREATE INDEX IF NOT EXISTS idx_hourly_usage_date ON hourly_usage_breakdown(usage_date, usage_hour);
CREATE INDEX IF NOT EXISTS idx_hourly_usage_device_date ON hourly_usage_breakdown(device_id, usage_date, usage_hour);
