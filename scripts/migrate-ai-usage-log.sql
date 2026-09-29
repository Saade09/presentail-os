CREATE TABLE ai_usage_log (
  id               BIGSERIAL PRIMARY KEY,
  action_key       TEXT NOT NULL,
  surface          TEXT NOT NULL,
  provider         TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  key_source       TEXT NOT NULL,
  was_fallback     BOOLEAN NOT NULL DEFAULT FALSE,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cached_tokens    INTEGER,
  reasoning_tokens INTEGER,
  cost_usd         NUMERIC(12,6),
  latency_ms       INTEGER,
  success          BOOLEAN NOT NULL,
  error_code       TEXT,
  order_id         TEXT,
  session_id       TEXT,
  country          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_usage_created
  ON ai_usage_log (created_at DESC);

CREATE INDEX idx_ai_usage_action
  ON ai_usage_log (action_key, created_at DESC);

CREATE INDEX idx_ai_usage_order
  ON ai_usage_log (order_id)
  WHERE order_id IS NOT NULL;