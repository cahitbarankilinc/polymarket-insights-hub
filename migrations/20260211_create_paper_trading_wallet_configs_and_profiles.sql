BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS paper_trading_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  global_total_budget_usd NUMERIC(14, 2) NOT NULL DEFAULT 1000.00,
  daily_budget_usd NUMERIC(14, 2) NOT NULL DEFAULT 200.00,
  max_market_exposure_pct NUMERIC(5, 2) NOT NULL DEFAULT 25.00,
  max_open_positions INTEGER NOT NULL DEFAULT 10,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_trading_wallet_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_wallet TEXT NOT NULL,

  position_sizing_mode TEXT NOT NULL DEFAULT 'multiplier',
  multiplier NUMERIC(10, 4) NOT NULL DEFAULT 1.0000,
  fixed_usd NUMERIC(14, 2) NULL DEFAULT NULL,
  fixed_shares NUMERIC(18, 8) NULL DEFAULT NULL,
  max_trade_usd NUMERIC(14, 2) NOT NULL DEFAULT 50.00,
  wallet_budget_cap_usd NUMERIC(14, 2) NOT NULL DEFAULT 500.00,

  paper_profile_id UUID NULL DEFAULT NULL,

  copy_mode TEXT NOT NULL DEFAULT 'proportional',
  copy_delay_ms INTEGER NOT NULL DEFAULT 0,
  min_source_trade_usd NUMERIC(14, 2) NOT NULL DEFAULT 1.00,
  max_price_deviation_pct NUMERIC(5, 2) NOT NULL DEFAULT 3.00,

  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_paper_trading_wallet_configs_profile
    FOREIGN KEY (paper_profile_id)
    REFERENCES paper_trading_profiles(id)
    ON DELETE SET NULL,

  CONSTRAINT uq_paper_trading_wallet_configs_user_source
    UNIQUE (user_id, source_wallet)
);

COMMIT;
