import { describe, expect, it } from "vitest";
import { calculateTargetOrderSize } from "./paperPositionSizingEngine";

describe("calculateTargetOrderSize", () => {
  const baseInput = {
    sourceTrade: {
      source_trade_usd: 100,
      source_trade_shares: 200,
      price: 0.5,
    },
    walletConfig: {
      mode: "MULTIPLIER" as const,
      multiplier: 2,
      max_trade_usd: 500,
      wallet_budget_cap_usd: 2_000,
    },
    globalProfile: {
      global_total_budget_usd: 10_000,
      daily_limit_usd: 1_000,
    },
    currentExposure: {
      wallet_exposure_usd: 300,
      global_exposure_usd: 1_000,
      daily_used_usd: 100,
    },
  };

  it("calculates MULTIPLIER mode order size", () => {
    const result = calculateTargetOrderSize(baseInput);

    expect(result.final_order_usd).toBe(200);
    expect(result.final_order_shares).toBe(400);
    expect(result.skip_reason).toBeNull();
  });

  it("calculates FIXED_USD mode order size", () => {
    const result = calculateTargetOrderSize({
      ...baseInput,
      walletConfig: {
        ...baseInput.walletConfig,
        mode: "FIXED_USD",
        fixed_usd: 75,
      },
    });

    expect(result.final_order_usd).toBe(75);
    expect(result.final_order_shares).toBe(150);
    expect(result.skip_reason).toBeNull();
  });

  it("calculates FIXED_SHARES mode order size", () => {
    const result = calculateTargetOrderSize({
      ...baseInput,
      sourceTrade: {
        ...baseInput.sourceTrade,
        price: 0.4,
      },
      walletConfig: {
        ...baseInput.walletConfig,
        mode: "FIXED_SHARES",
        fixed_shares: 50,
      },
    });

    expect(result.final_order_usd).toBe(20);
    expect(result.final_order_shares).toBe(50);
    expect(result.skip_reason).toBeNull();
  });

  it("clamps with tightest limit", () => {
    const result = calculateTargetOrderSize({
      ...baseInput,
      walletConfig: {
        ...baseInput.walletConfig,
        multiplier: 10,
      },
      globalProfile: {
        ...baseInput.globalProfile,
        daily_limit_usd: 150,
      },
    });

    expect(result.final_order_usd).toBe(50);
    expect(result.final_order_shares).toBe(100);
    expect(result.skip_reason).toBeNull();
  });

  it("returns skip reason when wallet budget is exhausted", () => {
    const result = calculateTargetOrderSize({
      ...baseInput,
      currentExposure: {
        ...baseInput.currentExposure,
        wallet_exposure_usd: 2_000,
      },
    });

    expect(result.final_order_usd).toBe(0);
    expect(result.final_order_shares).toBe(0);
    expect(result.skip_reason).toBe("WALLET_BUDGET_CAP_REACHED");
  });

  it("returns INVALID_PRICE when price is not positive", () => {
    const result = calculateTargetOrderSize({
      ...baseInput,
      sourceTrade: {
        ...baseInput.sourceTrade,
        price: 0,
      },
    });

    expect(result.final_order_usd).toBe(0);
    expect(result.final_order_shares).toBe(0);
    expect(result.skip_reason).toBe("INVALID_PRICE");
  });
});
