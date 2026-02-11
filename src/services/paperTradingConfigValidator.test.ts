import { describe, expect, it } from "vitest";

import { validatePaperTradingConfig } from "@/services/paperTradingConfigValidator";

describe("validatePaperTradingConfig", () => {
  it("returns no errors for a valid MULTIPLIER + DELAYED config", () => {
    const errors = validatePaperTradingConfig({
      size_mode: "MULTIPLIER",
      multiplier: 1.5,
      max_market_exposure_pct: 25,
      copy_mode: "DELAYED",
      copy_delay_ms: 0,
      max_price_deviation_pct: 3,
    });

    expect(errors).toEqual([]);
  });

  it("returns all relevant user-facing messages for invalid values", () => {
    const errors = validatePaperTradingConfig({
      size_mode: "FIXED_USD",
      fixed_usd: 0,
      max_market_exposure_pct: 120,
      copy_mode: "THRESHOLD",
      min_source_trade_usd: 0,
      max_price_deviation_pct: 30,
    });

    expect(errors).toEqual([
      "Size mode FIXED_USD iken fixed_usd değeri 0'dan büyük olmalıdır.",
      "max_market_exposure_pct değeri 0 ile 100 arasında olmalıdır.",
      "copy_mode THRESHOLD iken min_source_trade_usd değeri 0'dan büyük olmalıdır.",
      "max_price_deviation_pct değeri 0 ile 20 arasında olmalıdır.",
    ]);
  });

  it("requires fixed_shares to be positive when size mode is FIXED_SHARES", () => {
    const errors = validatePaperTradingConfig({
      size_mode: "FIXED_SHARES",
      fixed_shares: -1,
      max_market_exposure_pct: 80,
      copy_mode: "INSTANT",
      max_price_deviation_pct: 10,
    });

    expect(errors).toContain(
      "Size mode FIXED_SHARES iken fixed_shares değeri 0'dan büyük olmalıdır.",
    );
  });

  it("requires multiplier to be positive when size mode is MULTIPLIER", () => {
    const errors = validatePaperTradingConfig({
      size_mode: "MULTIPLIER",
      multiplier: 0,
      max_market_exposure_pct: 80,
      copy_mode: "INSTANT",
      max_price_deviation_pct: 10,
    });

    expect(errors).toContain(
      "Size mode MULTIPLIER iken multiplier değeri 0'dan büyük olmalıdır.",
    );
  });

  it("requires non-negative delay when copy mode is DELAYED", () => {
    const errors = validatePaperTradingConfig({
      size_mode: "MULTIPLIER",
      multiplier: 1,
      max_market_exposure_pct: 80,
      copy_mode: "DELAYED",
      copy_delay_ms: -5,
      max_price_deviation_pct: 10,
    });

    expect(errors).toContain(
      "copy_mode DELAYED iken copy_delay_ms değeri 0 veya daha büyük olmalıdır.",
    );
  });
});
