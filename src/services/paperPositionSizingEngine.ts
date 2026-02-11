export type PositionSizingMode = "MULTIPLIER" | "FIXED_USD" | "FIXED_SHARES";

export interface SourceTradeInput {
  source_trade_usd: number;
  source_trade_shares: number;
  price: number;
}

export interface WalletConfig {
  mode: PositionSizingMode;
  multiplier?: number;
  fixed_usd?: number;
  fixed_shares?: number;
  max_trade_usd?: number;
  wallet_budget_cap_usd?: number;
}

export interface GlobalProfile {
  global_total_budget_usd?: number;
  daily_limit_usd?: number;
}

export interface CurrentExposure {
  wallet_exposure_usd?: number;
  global_exposure_usd?: number;
  daily_used_usd?: number;
}

export interface CalculateTargetOrderSizeInput {
  sourceTrade: SourceTradeInput;
  walletConfig: WalletConfig;
  globalProfile: GlobalProfile;
  currentExposure: CurrentExposure;
}

export type SkipReason =
  | "INVALID_PRICE"
  | "INVALID_BASE_SIZE"
  | "WALLET_BUDGET_CAP_REACHED"
  | "GLOBAL_BUDGET_CAP_REACHED"
  | "DAILY_LIMIT_REACHED"
  | "MAX_TRADE_LIMIT_REACHED";

export interface TargetOrderSizeResult {
  final_order_usd: number;
  final_order_shares: number;
  skip_reason: SkipReason | null;
}

const toPositiveNumber = (value?: number): number | null => {
  if (value == null || Number.isNaN(value) || value <= 0) {
    return null;
  }

  return value;
};

const getBaseUsdByMode = (input: CalculateTargetOrderSizeInput): number => {
  const { sourceTrade, walletConfig } = input;

  switch (walletConfig.mode) {
    case "MULTIPLIER": {
      const multiplier = walletConfig.multiplier ?? 0;
      return sourceTrade.source_trade_usd * multiplier;
    }
    case "FIXED_USD":
      return walletConfig.fixed_usd ?? 0;
    case "FIXED_SHARES": {
      const fixedShares = walletConfig.fixed_shares ?? 0;
      return fixedShares * sourceTrade.price;
    }
    default:
      return 0;
  }
};

export function calculateTargetOrderSize(
  input: CalculateTargetOrderSizeInput,
): TargetOrderSizeResult {
  const { sourceTrade, walletConfig, globalProfile, currentExposure } = input;

  if (!sourceTrade.price || sourceTrade.price <= 0) {
    return {
      final_order_usd: 0,
      final_order_shares: 0,
      skip_reason: "INVALID_PRICE",
    };
  }

  const baseOrderUsd = getBaseUsdByMode(input);
  if (!Number.isFinite(baseOrderUsd) || baseOrderUsd <= 0) {
    return {
      final_order_usd: 0,
      final_order_shares: 0,
      skip_reason: "INVALID_BASE_SIZE",
    };
  }

  const walletBudgetRemaining = toPositiveNumber(
    (walletConfig.wallet_budget_cap_usd ?? Number.POSITIVE_INFINITY) -
      (currentExposure.wallet_exposure_usd ?? 0),
  );
  const globalBudgetRemaining = toPositiveNumber(
    (globalProfile.global_total_budget_usd ?? Number.POSITIVE_INFINITY) -
      (currentExposure.global_exposure_usd ?? 0),
  );
  const dailyLimitRemaining = toPositiveNumber(
    (globalProfile.daily_limit_usd ?? Number.POSITIVE_INFINITY) -
      (currentExposure.daily_used_usd ?? 0),
  );
  const maxTradeUsd = toPositiveNumber(walletConfig.max_trade_usd);

  const orderedLimits: Array<{ reason: SkipReason; value: number | null }> = [
    { reason: "MAX_TRADE_LIMIT_REACHED", value: maxTradeUsd },
    { reason: "WALLET_BUDGET_CAP_REACHED", value: walletBudgetRemaining },
    { reason: "GLOBAL_BUDGET_CAP_REACHED", value: globalBudgetRemaining },
    { reason: "DAILY_LIMIT_REACHED", value: dailyLimitRemaining },
  ];

  const activeLimits = orderedLimits
    .map((entry) => ({ ...entry, value: entry.value ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.value - b.value);

  const hardStop = activeLimits.find((entry) => entry.value <= 0);
  if (hardStop) {
    return {
      final_order_usd: 0,
      final_order_shares: 0,
      skip_reason: hardStop.reason,
    };
  }

  const tightestLimit = activeLimits[0];
  const finalOrderUsd = Math.max(0, Math.min(baseOrderUsd, tightestLimit.value));

  if (finalOrderUsd <= 0) {
    return {
      final_order_usd: 0,
      final_order_shares: 0,
      skip_reason: tightestLimit.reason,
    };
  }

  return {
    final_order_usd: finalOrderUsd,
    final_order_shares: finalOrderUsd / sourceTrade.price,
    skip_reason: null,
  };
}
