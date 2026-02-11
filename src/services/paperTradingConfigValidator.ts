export type PaperTradeSizeMode = "MULTIPLIER" | "FIXED_USD" | "FIXED_SHARES";

export type PaperTradeCopyMode = "INSTANT" | "DELAYED" | "THRESHOLD";

export interface PaperTradingConfig {
  size_mode?: PaperTradeSizeMode;
  multiplier?: number | null;
  fixed_usd?: number | null;
  fixed_shares?: number | null;
  max_market_exposure_pct?: number | null;
  copy_mode?: PaperTradeCopyMode;
  copy_delay_ms?: number | null;
  min_source_trade_usd?: number | null;
  max_price_deviation_pct?: number | null;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function validatePaperTradingConfig(config: PaperTradingConfig): string[] {
  const errors: string[] = [];

  if (config.size_mode === "MULTIPLIER") {
    if (!isFiniteNumber(config.multiplier) || config.multiplier <= 0) {
      errors.push("Size mode MULTIPLIER iken multiplier değeri 0'dan büyük olmalıdır.");
    }
  }

  if (config.size_mode === "FIXED_USD") {
    if (!isFiniteNumber(config.fixed_usd) || config.fixed_usd <= 0) {
      errors.push("Size mode FIXED_USD iken fixed_usd değeri 0'dan büyük olmalıdır.");
    }
  }

  if (config.size_mode === "FIXED_SHARES") {
    if (!isFiniteNumber(config.fixed_shares) || config.fixed_shares <= 0) {
      errors.push("Size mode FIXED_SHARES iken fixed_shares değeri 0'dan büyük olmalıdır.");
    }
  }

  if (
    !isFiniteNumber(config.max_market_exposure_pct) ||
    config.max_market_exposure_pct < 0 ||
    config.max_market_exposure_pct > 100
  ) {
    errors.push("max_market_exposure_pct değeri 0 ile 100 arasında olmalıdır.");
  }

  if (config.copy_mode === "DELAYED") {
    if (!isFiniteNumber(config.copy_delay_ms) || config.copy_delay_ms < 0) {
      errors.push("copy_mode DELAYED iken copy_delay_ms değeri 0 veya daha büyük olmalıdır.");
    }
  }

  if (config.copy_mode === "THRESHOLD") {
    if (!isFiniteNumber(config.min_source_trade_usd) || config.min_source_trade_usd <= 0) {
      errors.push(
        "copy_mode THRESHOLD iken min_source_trade_usd değeri 0'dan büyük olmalıdır.",
      );
    }
  }

  if (
    !isFiniteNumber(config.max_price_deviation_pct) ||
    config.max_price_deviation_pct < 0 ||
    config.max_price_deviation_pct > 20
  ) {
    errors.push("max_price_deviation_pct değeri 0 ile 20 arasında olmalıdır.");
  }

  return errors;
}
