import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Play,
  Wallet,
} from 'lucide-react';
import { useDashboard, type CopyMode } from '@/context/DashboardContext';
import { getWalletEventsWithStats, type WalletTrackerEvent } from '@/lib/polymarketTrackerApi';
import { Scatter, ScatterChart, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { toast } from 'sonner';

const COPY_MODE_OPTIONS: Array<{ value: CopyMode; label: string; description: string }> = [
  { value: 'notional', label: '1:1 Notional Copy', description: 'Onun aldığı USD kadar al.' },
  { value: 'proportional', label: 'Proportional to Free Balance', description: 'Boştaki bakiyeye göre oranla.' },
  { value: 'multiplier', label: 'Multiplier Mode', description: 'Onun trade tutarı × k.' },
  { value: 'fixed-amount', label: 'Fixed Amount per Trade', description: 'Her işlemde sabit USD.' },
  { value: 'buy-wait', label: 'Al Bekle', description: 'Her markette ilk N alımı sabit USD ile kopyala.' },
];

interface WalletModeConfig {
  mode: CopyMode;
  sourceTradeUsd: string;
  leaderFreeBalance: string;
  multiplier: string;
  fixedAmount: string;
  buyWaitLimit: string;
  fixedShares: string;
  sharePrice: string;
  strategy: string;
  direction: 'long' | 'short';
}

const defaultConfig: WalletModeConfig = {
  mode: 'notional',
  sourceTradeUsd: '100',
  leaderFreeBalance: '1000',
  multiplier: '1',
  fixedAmount: '20',
  buyWaitLimit: '2',
  fixedShares: '50',
  sharePrice: '1',
  strategy: 'Copy Trading',
  direction: 'long',
};

const formatUsd = (value: number) => `$${value.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;
const formatDate = (value: Date) => value.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const parseNumberFromText = (value?: string | null): number | undefined => {
  if (!value) return undefined;
  const match = value.match(/[-+]?\d[\d.,]*/g);
  if (!match?.length) return undefined;

  const raw = match[match.length - 1].replace(/[^\d.,-]/g, '');
  if (!raw) return undefined;

  const commaCount = (raw.match(/,/g) || []).length;
  const dotCount = (raw.match(/\./g) || []).length;

  let normalized = raw;

  if (commaCount > 0 && dotCount > 0) {
    const lastComma = raw.lastIndexOf(',');
    const lastDot = raw.lastIndexOf('.');

    normalized = lastDot > lastComma
      ? raw.replace(/,/g, '')
      : raw.replace(/\./g, '').replace(',', '.');
  } else if (commaCount > 0) {
    if (commaCount > 1) {
      normalized = raw.replace(/,/g, '');
    } else {
      const [, fraction = ''] = raw.split(',');
      normalized = fraction.length === 3 ? raw.replace(/,/g, '') : raw.replace(',', '.');
    }
  } else if (dotCount > 1) {
    normalized = raw.replace(/\./g, '');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const resolveLeaderFreeBalance = (value?: string | null): number | undefined => parseNumberFromText(value);

const resolveDirection = (event: WalletTrackerEvent | undefined): 'long' | 'short' | undefined => {
  if (!event) return undefined;
  const outcome = (event.outcome ?? '').toLowerCase();
  if (outcome.includes('down') || outcome.includes('no')) return 'short';
  if (outcome.includes('up') || outcome.includes('yes')) return 'long';

  const side = (event.side ?? '').toLowerCase();
  if (side === 'sell') return 'short';
  if (side === 'buy') return 'long';
  return undefined;
};

const resolveEventSide = (event: WalletTrackerEvent | undefined): 'BUY' | 'SELL' | undefined => {
  if (!event?.side) return undefined;
  const side = event.side.toUpperCase();
  if (side === 'BUY' || side === 'SELL') return side;
  return undefined;
};

interface PaperTradePrefill {
  sourceTradeUsd?: number;
  sharePrice?: number;
  fixedShares?: number;
  direction?: 'long' | 'short';
  leaderFreeBalance?: number;
}

interface BudgetDraft {
  mode: 'unlimited' | 'limited';
  type: 'daily' | 'total';
  amount: number;
}

interface TradeActivity {
  id: string;
  side: 'BUY' | 'SELL';
  occurredAt: Date;
  marketLabel: string;
  price: number;
  share: number;
  usd: number;
}

interface CopySessionState {
  status: 'idle' | 'running' | 'syncing';
  lastEventKey?: string;
  marketBuyCounts?: Record<string, number>;
}

const resolveMarketKey = (event: WalletTrackerEvent): string | null => {
  const market = typeof event.market === 'string' ? event.market.trim().toLowerCase() : '';
  return market || null;
};

const TRACKER_POLL_MS = 1000;

const toEventTimestamp = (event: WalletTrackerEvent): number => {
  const candidates = [event.event_time, event.seen_at_utc];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = typeof candidate === 'string' ? candidate.trim() : String(candidate);
    if (!normalized) continue;

    if (/^\d+(?:\.\d+)?$/.test(normalized)) {
      const numeric = Number(normalized);
      if (!Number.isFinite(numeric)) continue;
      return numeric > 1e12 ? numeric : numeric * 1000;
    }

    const parsed = new Date(normalized).getTime();
    if (!Number.isNaN(parsed)) return parsed;
  }

  return 0;
};

const sortEventsOldestFirst = (events: WalletTrackerEvent[]) => (
  [...events].sort((a, b) => toEventTimestamp(a) - toEventTimestamp(b))
);

const getLatestEvent = (events: WalletTrackerEvent[]) => {
  if (!events.length) return undefined;
  return sortEventsOldestFirst(events).at(-1);
};

const toPositiveNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
};

const resolveEventTradeUsd = (event: WalletTrackerEvent, fallbackUsd: number): number => {
  const directUsd = toPositiveNumber(event.value_usd);
  if (directUsd > 0) return directUsd;

  const size = toPositiveNumber(event.size);
  const price = toPositiveNumber(event.price);
  const calculatedUsd = size * price;
  if (calculatedUsd > 0) return calculatedUsd;

  return fallbackUsd > 0 ? fallbackUsd : 0;
};

const getEventKey = (event: WalletTrackerEvent): string => (
  event.tx_hash
  || `${event.seen_at_utc}:${event.market ?? ''}:${event.side ?? ''}:${event.value_usd ?? ''}:${event.price ?? ''}`
);

export default function PaperTradeTab({ preselectedId, prefill }: { preselectedId?: string | null; prefill?: PaperTradePrefill | null }) {
  const { addresses, paperTrades, startPaperTrade, paperBudget, setPaperBudget } = useDashboard();
  const [setupId, setSetupId] = useState<string | null>(preselectedId || null);
  const [collapsed, setCollapsed] = useState(false);
  const [budgetMode, setBudgetMode] = useState<'unlimited' | 'limited'>(paperBudget.mode);
  const [budgetType, setBudgetType] = useState<'daily' | 'total'>(paperBudget.type);
  const [budgetAmount, setBudgetAmount] = useState(paperBudget.amount > 0 ? String(paperBudget.amount) : '1000');
  const [virtualFreeBalance, setVirtualFreeBalance] = useState('1000');
  const [walletConfigs, setWalletConfigs] = useState<Record<string, WalletModeConfig>>({});
  const [copySessions, setCopySessions] = useState<Record<string, CopySessionState>>({});
  const [copySessionErrors, setCopySessionErrors] = useState<Record<string, string | null>>({});
  const [view, setView] = useState<'paper' | 'analysis'>('paper');
  const [analysisAddressId, setAnalysisAddressId] = useState<string | null>(null);
  const copySessionsRef = useRef(copySessions);
  const syncingWalletsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    copySessionsRef.current = copySessions;
  }, [copySessions]);

  const loadAutoConfig = async (addressId: string): Promise<WalletModeConfig | null> => {
    const targetAddress = addresses.find((address) => address.id === addressId);
    if (!targetAddress) return null;

    const baseConfig = walletConfigs[addressId] || defaultConfig;

    try {
      const payload = await getWalletEventsWithStats(targetAddress.address);
      const latestEvent = getLatestEvent(payload.events);
      const nextConfig: WalletModeConfig = {
        ...baseConfig,
        sourceTradeUsd: String(latestEvent?.value_usd ?? baseConfig.sourceTradeUsd),
        sharePrice: String(latestEvent?.price ?? baseConfig.sharePrice),
        fixedShares: String(latestEvent?.size ?? baseConfig.fixedShares),
        direction: resolveDirection(latestEvent) ?? baseConfig.direction,
        leaderFreeBalance: String(resolveLeaderFreeBalance(targetAddress.polygonscanTopTotalValText) ?? baseConfig.leaderFreeBalance),
      };

      setWalletConfigs((prev) => ({ ...prev, [addressId]: nextConfig }));
      return nextConfig;
    } catch {
      const nextConfig: WalletModeConfig = {
        ...baseConfig,
        leaderFreeBalance: String(resolveLeaderFreeBalance(targetAddress.polygonscanTopTotalValText) ?? baseConfig.leaderFreeBalance),
      };
      setWalletConfigs((prev) => ({ ...prev, [addressId]: nextConfig }));
      return nextConfig;
    }
  };

  useEffect(() => {
    if (preselectedId) {
      setSetupId(preselectedId);
      setCollapsed(false);
      setView('paper');
    }
  }, [preselectedId]);

  useEffect(() => {
    if (!setupId || !prefill) return;

    const patch: Partial<WalletModeConfig> = {};
    if (typeof prefill.sourceTradeUsd === 'number' && Number.isFinite(prefill.sourceTradeUsd)) patch.sourceTradeUsd = String(prefill.sourceTradeUsd);
    if (typeof prefill.sharePrice === 'number' && Number.isFinite(prefill.sharePrice)) patch.sharePrice = String(prefill.sharePrice);
    if (typeof prefill.fixedShares === 'number' && Number.isFinite(prefill.fixedShares)) patch.fixedShares = String(prefill.fixedShares);
    if (typeof prefill.leaderFreeBalance === 'number' && Number.isFinite(prefill.leaderFreeBalance)) patch.leaderFreeBalance = String(prefill.leaderFreeBalance);
    if (prefill.direction) patch.direction = prefill.direction;

    if (Object.keys(patch).length) {
      setWalletConfigs(prev => ({ ...prev, [setupId]: { ...(prev[setupId] || defaultConfig), ...patch } }));
    }
  }, [setupId, prefill]);

  useEffect(() => {
    if (!setupId) return;
    loadAutoConfig(setupId);
  }, [setupId, addresses]);

  const currentConfig = setupId ? (walletConfigs[setupId] || defaultConfig) : defaultConfig;

  useEffect(() => {
    if (currentConfig.mode !== 'proportional') return;

    if (budgetMode !== 'limited') setBudgetMode('limited');

    const parsedBudgetAmount = parseFloat(budgetAmount) || 0;
    if (parsedBudgetAmount <= 0 || budgetAmount === '1000') setBudgetAmount('100');
  }, [budgetAmount, budgetMode, currentConfig.mode]);

  const myDynamicFreeBalance = useMemo(() => {
    if (paperBudget.mode === 'limited') return paperBudget.remaining;
    return parseFloat(virtualFreeBalance) || 0;
  }, [paperBudget.mode, paperBudget.remaining, virtualFreeBalance]);

  const tradesWithAddress = useMemo(() => paperTrades.map((trade) => {
    const wallet = addresses.find((addr) => addr.id === trade.addressId);
    const walletName = wallet?.username || wallet?.label || trade.address;
    const spendUsd = trade.spentUsd || 0;
    const isSellSide = trade.side === 'SELL';
    return {
      ...trade,
      walletName,
      marketLabel: `${trade.strategy || 'Copy Trading'} • ${walletName}`,
      buyUsd: isSellSide ? 0 : spendUsd,
      sellUsd: isSellSide ? spendUsd : (trade.status === 'closed' ? trade.currentPrice * trade.amount : 0),
    };
  }), [addresses, paperTrades]);

  const activeTrades = tradesWithAddress.filter(t => t.status === 'active');
  const closedTrades = tradesWithAddress.filter(t => t.status === 'closed');
  const runningSessions = useMemo(() => Object.entries(copySessions)
    .filter(([, session]) => session.status !== 'idle')
    .map(([addressId, session]) => {
      const wallet = addresses.find((addr) => addr.id === addressId);
      return {
        addressId,
        session,
        walletName: wallet?.username || wallet?.label || wallet?.address || addressId,
        walletAddress: wallet?.address,
      };
    }), [addresses, copySessions]);
  const passiveSessions = useMemo(() => addresses
    .filter((wallet) => copySessions[wallet.id]?.status !== 'running' && copySessions[wallet.id]?.status !== 'syncing')
    .map((wallet) => ({
      addressId: wallet.id,
      walletName: wallet.username || wallet.label || wallet.address || wallet.id,
      walletAddress: wallet.address,
    })), [addresses, copySessions]);

  const analysisTrades = useMemo(
    () => tradesWithAddress.filter((trade) => trade.addressId === analysisAddressId),
    [analysisAddressId, tradesWithAddress],
  );

  const analysisWalletName = useMemo(() => {
    if (!analysisAddressId) return '';
    const wallet = addresses.find((addr) => addr.id === analysisAddressId);
    return wallet?.username || wallet?.label || wallet?.address || '';
  }, [addresses, analysisAddressId]);

  const buyActivities = useMemo<TradeActivity[]>(() => analysisTrades
    .filter((trade) => trade.side !== 'SELL')
    .map((trade) => ({
    id: `${trade.id}-buy`,
    side: 'BUY',
    occurredAt: new Date(trade.startedAt),
    marketLabel: trade.marketLabel,
    price: trade.entryPrice,
    share: trade.amount,
    usd: trade.buyUsd,
  })), [analysisTrades]);

  const sellActivities = useMemo<TradeActivity[]>(() => analysisTrades
    .filter((trade) => trade.side === 'SELL' || trade.status === 'closed')
    .map((trade) => ({
      id: `${trade.id}-sell`,
      side: 'SELL',
      occurredAt: new Date(trade.side === 'SELL' ? trade.startedAt : (trade.closedAt || trade.startedAt)),
      marketLabel: trade.marketLabel,
      price: trade.side === 'SELL' ? trade.entryPrice : trade.currentPrice,
      share: trade.amount,
      usd: trade.sellUsd,
    })), [analysisTrades]);

  const myActivities = useMemo(
    () => [...buyActivities, ...sellActivities].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()),
    [buyActivities, sellActivities],
  );

  const analysisStats = useMemo(() => {
    if (analysisTrades.length === 0) return null;

    const startTimestamp = Math.min(...analysisTrades.map((trade) => new Date(trade.startedAt).getTime()));
    const totalBuy = analysisTrades.reduce((sum, trade) => sum + trade.buyUsd, 0);
    const totalSell = analysisTrades.reduce((sum, trade) => sum + trade.sellUsd, 0);
    const inGameMoney = analysisTrades.filter((trade) => trade.status === 'active').reduce((sum, trade) => sum + trade.buyUsd, 0);


    return {
      startAt: new Date(startTimestamp),
      totalBudgetText: paperBudget.mode === 'limited' ? `${formatUsd(paperBudget.amount)} (${paperBudget.type === 'daily' ? 'günlük' : 'toplam'})` : 'Sınırsız',
      freeBudgetText: paperBudget.mode === 'limited' ? formatUsd(paperBudget.remaining) : 'Sınırsız',
      inGameMoney,
      totalTransactions: myActivities.length,
      totalBuy,
      totalSell,
    };
  }, [analysisTrades, myActivities.length, paperBudget.amount, paperBudget.mode, paperBudget.remaining, paperBudget.type]);

  const sharePriceData = useMemo(() => {
    const grouped = new Map<number, { share: number; usdSpent: number }>();
    for (const trade of analysisTrades) {
      const bucket = Number(trade.entryPrice.toFixed(2));
      const row = grouped.get(bucket) || { share: 0, usdSpent: 0 };
      row.share += trade.amount;
      row.usdSpent += trade.buyUsd;
      grouped.set(bucket, row);
    }
    return Array.from(grouped.entries()).map(([price, values]) => ({ price, ...values })).sort((a, b) => a.price - b.price);
  }, [analysisTrades]);

  const setConfig = (patch: Partial<WalletModeConfig>) => {
    if (!setupId) return;
    setWalletConfigs(prev => ({ ...prev, [setupId]: { ...(prev[setupId] || defaultConfig), ...patch } }));
  };

  const resolveBudgetDraft = (): BudgetDraft => ({
    mode: budgetMode,
    type: budgetType,
    amount: Math.max(0, parseFloat(budgetAmount) || 0),
  });

  const applyBudget = () => {
    const nextBudget = resolveBudgetDraft();
    setPaperBudget(nextBudget);
    toast.success('Bütçe ayarları güncellendi');
  };

  const calculateTradeUsd = (config: WalletModeConfig, budgetDraft?: BudgetDraft) => {
    const sourceTradeUsd = parseFloat(config.sourceTradeUsd) || 0;
    const leaderFree = parseFloat(config.leaderFreeBalance) || 0;
    const multiplier = parseFloat(config.multiplier) || 1;
    const fixedAmount = parseFloat(config.fixedAmount) || 0;
    const fixedShares = parseFloat(config.fixedShares) || 0;
    const sharePrice = parseFloat(config.sharePrice) || 1;

    const activeBudget = budgetDraft ?? paperBudget;
    const proportionalBudgetBase = activeBudget.mode === 'limited'
      ? Math.max(activeBudget.amount, 0)
      : Math.max(myDynamicFreeBalance, 0);

    switch (config.mode) {
      case 'notional': return sourceTradeUsd;
      case 'proportional': {
        if (sourceTradeUsd <= 0 || leaderFree <= 0 || proportionalBudgetBase <= 0) return 0;
        const sourceTradeRatio = sourceTradeUsd / leaderFree;
        return sourceTradeRatio * proportionalBudgetBase;
      }
      case 'multiplier': return sourceTradeUsd * multiplier;
      case 'fixed-amount': return fixedAmount;
      case 'buy-wait': return fixedAmount;
      case 'fixed-shares': return fixedShares * sharePrice;
      default: return sourceTradeUsd;
    }
  };



  const syncWalletCopyTrades = useCallback(async (addressId: string) => {
    if (syncingWalletsRef.current.has(addressId)) return;
    syncingWalletsRef.current.add(addressId);

    const targetAddress = addresses.find((address) => address.id === addressId);
    if (!targetAddress) {
      syncingWalletsRef.current.delete(addressId);
      return;
    }

    setCopySessions((prev) => {
      const current = prev[addressId];
      if (!current || current.status === 'idle') return prev;
      return { ...prev, [addressId]: { ...current, status: 'syncing' } };
    });

    try {
      const payload = await getWalletEventsWithStats(targetAddress.address);
      const events = sortEventsOldestFirst(payload.events);
      const latestEvent = events.at(-1);

      setWalletConfigs((prev) => {
        const baseConfig = prev[addressId] || defaultConfig;
        return {
          ...prev,
          [addressId]: {
            ...baseConfig,
            sourceTradeUsd: String(latestEvent?.value_usd ?? baseConfig.sourceTradeUsd),
            sharePrice: String(latestEvent?.price ?? baseConfig.sharePrice),
            fixedShares: String(latestEvent?.size ?? baseConfig.fixedShares),
            direction: resolveDirection(latestEvent) ?? baseConfig.direction,
            leaderFreeBalance: String(resolveLeaderFreeBalance(targetAddress.polygonscanTopTotalValText) ?? baseConfig.leaderFreeBalance),
          },
        };
      });

      const session = copySessionsRef.current[addressId];
      if (!session || session.status === 'idle') return;
      if (!events.length) {
        setCopySessions((prev) => ({ ...prev, [addressId]: { ...prev[addressId], status: 'running' } }));
        return;
      }

      const latestEventKey = getEventKey(events[events.length - 1]);
      if (!session.lastEventKey) {
        setCopySessions((prev) => ({ ...prev, [addressId]: { ...prev[addressId], status: 'running', lastEventKey: latestEventKey } }));
        return;
      }

      const seenIndex = events.findIndex((event) => getEventKey(event) === session.lastEventKey);
      const freshEvents = seenIndex === -1 ? events : events.slice(seenIndex + 1);

      if (freshEvents.length === 0) {
        setCopySessions((prev) => ({ ...prev, [addressId]: { ...prev[addressId], status: 'running', lastEventKey: latestEventKey } }));
        return;
      }

      const cfg = walletConfigs[addressId] || defaultConfig;
      let openedTrades = 0;
      const nextMarketBuyCounts: Record<string, number> = { ...(session.marketBuyCounts || {}) };

      for (const event of freshEvents) {
        const eventSide = resolveEventSide(event);
        if (!eventSide) continue;

        if (cfg.mode === 'buy-wait' && eventSide !== 'BUY') continue;

        const eventPrice = toPositiveNumber(event.price);
        const eventSize = toPositiveNumber(event.size);
        if (eventPrice <= 0 || eventSize <= 0) continue;

        const sourceTradeUsd = resolveEventTradeUsd(event, toPositiveNumber(cfg.sourceTradeUsd));
        const eventConfig: WalletModeConfig = {
          ...cfg,
          sourceTradeUsd: String(sourceTradeUsd || cfg.sourceTradeUsd),
          sharePrice: String(eventPrice),
          fixedShares: String(eventSize),
          direction: resolveDirection(event) ?? cfg.direction,
        };
        const tradeUsd = calculateTradeUsd(eventConfig);
        if (tradeUsd <= 0) continue;

        if (eventConfig.mode === 'buy-wait') {
          const buyLimit = Math.floor(parseFloat(eventConfig.buyWaitLimit) || 0);
          if (buyLimit <= 0) continue;

          const marketKey = resolveMarketKey(event);
          if (!marketKey) continue;

          const copiedCount = nextMarketBuyCounts[marketKey] || 0;
          if (copiedCount >= buyLimit) continue;
        }

        const shouldUseSourceShares = eventConfig.mode === 'notional';

        const result = startPaperTrade(addressId, {
          strategy: eventConfig.strategy || 'Copy Trading',
          direction: eventSide === 'BUY' ? 'long' : 'short',
          spendUsd: tradeUsd,
          copyMode: eventConfig.mode,
          entryPrice: eventPrice,
          shareAmount: shouldUseSourceShares ? eventSize : undefined,
          side: eventSide,
        });

        if (result.ok) {
          openedTrades += 1;
          if (eventConfig.mode === 'buy-wait') {
            const marketKey = resolveMarketKey(event);
            if (marketKey) {
              nextMarketBuyCounts[marketKey] = (nextMarketBuyCounts[marketKey] || 0) + 1;
            }
          }
        }
      }

      setCopySessions((prev) => ({
        ...prev,
        [addressId]: {
          ...prev[addressId],
          status: 'running',
          lastEventKey: latestEventKey,
          marketBuyCounts: nextMarketBuyCounts,
        },
      }));

      setCopySessionErrors((prev) => ({ ...prev, [addressId]: null }));

      if (openedTrades > 0) {
        toast.success(`${openedTrades} yeni aktivite kopyalandı`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Copy trade senkronizasyonu sırasında hata oluştu';
      setCopySessionErrors((prev) => ({ ...prev, [addressId]: message }));
      toast.error(message);
      setCopySessions((prev) => {
        const current = prev[addressId];
        if (!current || current.status === 'idle') return prev;
        return { ...prev, [addressId]: { ...current, status: 'running' } };
      });
    } finally {
      syncingWalletsRef.current.delete(addressId);
    }
  }, [addresses, calculateTradeUsd, startPaperTrade, walletConfigs]);

  useEffect(() => {
    const runningWalletIds = Object.entries(copySessions)
      .filter(([, session]) => session.status !== 'idle')
      .map(([walletId]) => walletId);

    if (!runningWalletIds.length) return;

    let active = true;
    let timeoutId: number | undefined;

    const tick = async () => {
      const startedAt = Date.now();
      const currentlyRunningIds = Object.entries(copySessionsRef.current)
        .filter(([, session]) => session.status !== 'idle')
        .map(([walletId]) => walletId);

      await Promise.all(currentlyRunningIds.map(async (walletId) => {
        await syncWalletCopyTrades(walletId);
      }));

      if (!active) return;
      const elapsedMs = Date.now() - startedAt;
      const nextDelayMs = Math.max(0, TRACKER_POLL_MS - elapsedMs);
      timeoutId = window.setTimeout(() => {
        void tick();
      }, nextDelayMs);
    };

    void tick();

    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [copySessions, syncWalletCopyTrades]);

  const handleStart = async () => {
    if (!setupId) return toast.error('Önce bir cüzdan seçin');

    const nextBudget = resolveBudgetDraft();
    if (currentConfig.mode === 'proportional' && nextBudget.mode !== 'limited') {
      return toast.error('Proportional modunda bütçe tipi Limitli olmalı');
    }

    setPaperBudget(nextBudget);

    const latestConfig = await loadAutoConfig(setupId) || currentConfig;
    const tradeUsd = calculateTradeUsd(latestConfig, nextBudget);
    if (tradeUsd <= 0) return toast.error('Trade tutarı 0 dan büyük olmalı');

    const selectedAddress = addresses.find((address) => address.id === setupId);
    if (!selectedAddress) return toast.error('Cüzdan bulunamadı');

    try {
      const payload = await getWalletEventsWithStats(selectedAddress.address);
      const latestEvent = getLatestEvent(payload.events);
      const latestEventKey = latestEvent ? getEventKey(latestEvent) : undefined;

      setCopySessions((prev) => ({
        ...prev,
        [setupId]: {
          status: 'running',
          lastEventKey: latestEventKey,
          marketBuyCounts: {},
        },
      }));
      setCopySessionErrors((prev) => ({ ...prev, [setupId]: null }));

      toast.success('Copy trade takip sistemi başlatıldı. Yeni aktiviteler otomatik kopyalanacak.');
      setCollapsed(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Takip başlatılırken event verisi alınamadı';
      setCopySessionErrors((prev) => ({ ...prev, [setupId]: message }));
      toast.error(message);
    }
  };

  const handleStop = (addressId: string) => {
    setCopySessions((prev) => ({
      ...prev,
      [addressId]: {
        ...prev[addressId],
        status: 'idle',
      },
    }));
    setCopySessionErrors((prev) => ({ ...prev, [addressId]: null }));
    toast.success('Copy trade takibi durduruldu');
  };

  const openAnalysis = (addressId: string) => {
    setAnalysisAddressId(addressId);
    setView('analysis');
  };

  const selectedSession = setupId ? copySessions[setupId] : undefined;
  const isSelectedRunning = selectedSession?.status === 'running' || selectedSession?.status === 'syncing';

  return (
    <div className="animate-slide-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-foreground">Paper Trading</h2>
          <p className="text-xs text-muted-foreground">Bütçe + cüzdan bazlı copy trade test ortamı</p>
        </div>
        {view === 'analysis' && (
          <button
            onClick={() => setView('paper')}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-border/30 bg-secondary/40 hover:bg-secondary/70"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Paper Trade ekranına dön
          </button>
        )}
      </div>

      {view === 'paper' && (
        <>
          <div className="glass-card p-5 mb-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Takip Edilen Cüzdanlar</h3>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Copy trade için cüzdan seç</label>
            <div className="flex items-center gap-3">
              <Wallet className="w-4 h-4 text-primary" />
              <select
                value={setupId || ''}
                onChange={(e) => { setSetupId(e.target.value || null); setCollapsed(false); }}
                className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm"
              >
                <option value="">Cüzdan seçin...</option>
                {addresses.map((addr) => (
                  <option key={addr.id} value={addr.id}>{(addr.username || addr.label || addr.address)} • {addr.category}</option>
                ))}
              </select>
            </div>
            {Object.entries(copySessions).some(([, session]) => session.status !== 'idle') && (
              <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-2 text-xs text-primary">
                Takip aktif: {Object.entries(copySessions)
                  .filter(([, session]) => session.status !== 'idle')
                  .map(([walletId]) => addresses.find((addr) => addr.id === walletId)?.username || addresses.find((addr) => addr.id === walletId)?.label || walletId)
                  .join(', ')}
              </div>
            )}
          </div>

          <div className="glass-card p-5 mb-6">
            <h3 className="text-sm font-semibold text-foreground mb-4">Bütçe Yönetimi</h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">Bütçe Tipi</label>
                <div className="flex gap-2 mb-2">
                  <button
                    onClick={() => setBudgetMode('unlimited')}
                    disabled={currentConfig.mode === 'proportional'}
                    className={`px-3 py-2 rounded-lg text-xs border ${budgetMode === 'unlimited' ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/40 border-border/30 text-muted-foreground'} disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    Sınırsız
                  </button>
                  <button onClick={() => setBudgetMode('limited')} className={`px-3 py-2 rounded-lg text-xs border ${budgetMode === 'limited' ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/40 border-border/30 text-muted-foreground'}`}>Limitli</button>
                </div>
                {currentConfig.mode === 'proportional' && (
                  <p className="text-[11px] text-muted-foreground mb-2">
                    Proportional modunda bütçe tipi otomatik olarak <span className="font-semibold text-foreground">Limitli</span> tutulur.
                  </p>
                )}
                {budgetMode === 'limited' && (
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <select value={budgetType} onChange={(e) => setBudgetType(e.target.value as 'daily' | 'total')} className="px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm">
                      <option value="daily">Günlük</option>
                      <option value="total">Toplam</option>
                    </select>
                    <input type="number" value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} className="px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" placeholder="USD" />
                  </div>
                )}
                <button onClick={applyBudget} className="px-3 py-2 rounded-lg text-xs bg-primary/10 text-primary border border-primary/30">Bütçeyi Kaydet</button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-medium text-muted-foreground">Copy Trade Setup</label>
                  <button onClick={() => setCollapsed(!collapsed)} className="text-xs text-muted-foreground inline-flex items-center gap-1">{collapsed ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />} {collapsed ? 'Aç' : 'Daralt'}</button>
                </div>
                {!collapsed && (
                  <div className="space-y-2">
                    <select
                      value={currentConfig.mode}
                      onChange={(e) => {
                        const nextMode = e.target.value as CopyMode;
                        setConfig({ mode: nextMode });
                        if (nextMode === 'proportional') {
                          setBudgetMode('limited');
                          setBudgetAmount('100');
                          setPaperBudget({ mode: 'limited', type: budgetType, amount: 100 });
                        }
                      }}
                      className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm"
                    >
                      {COPY_MODE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                    </select>
                    <p className="text-[11px] text-muted-foreground">{COPY_MODE_OPTIONS.find((item) => item.value === currentConfig.mode)?.description}</p>
                    <div className="rounded-lg bg-secondary/20 border border-border/20 p-2 text-[11px] text-muted-foreground">
                      Source USD ve Leader bakiye değerleri otomatik olarak takip edilen cüzdandan çekilir.
                    </div>
                    {currentConfig.mode === 'multiplier' && (
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted-foreground">Multiplier değeri (k)</span>
                        <input type="number" step="0.1" value={currentConfig.multiplier} onChange={(e) => setConfig({ multiplier: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" placeholder="Örn: 1.5" />
                      </label>
                    )}
                    {currentConfig.mode === 'fixed-amount' && (
                      <label className="block">
                        <span className="mb-1 block text-[11px] text-muted-foreground">Her işlem için sabit alım tutarı (USD)</span>
                        <input type="number" min="0" value={currentConfig.fixedAmount} onChange={(e) => setConfig({ fixedAmount: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" placeholder="Örn: 50" />
                      </label>
                    )}
                    {currentConfig.mode === 'buy-wait' && (
                      <>
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted-foreground">Market başına kopyalanacak maksimum alım adedi</span>
                          <input type="number" min="1" value={currentConfig.buyWaitLimit} onChange={(e) => setConfig({ buyWaitLimit: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" placeholder="Örn: 2" />
                        </label>
                        <label className="block">
                          <span className="mb-1 block text-[11px] text-muted-foreground">Her alımda kullanılacak sabit tutar (USD)</span>
                          <input type="number" min="0" value={currentConfig.fixedAmount} onChange={(e) => setConfig({ fixedAmount: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" placeholder="Örn: 50" />
                        </label>
                      </>
                    )}
                    <input type="text" value={currentConfig.strategy} onChange={(e) => setConfig({ strategy: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" placeholder="Strateji" />
                    <p className="text-xs text-muted-foreground">Hesaplanan trade tutarı: <span className="font-mono text-foreground">${calculateTradeUsd(currentConfig, resolveBudgetDraft()).toFixed(2)}</span></p>
                  </div>
                )}
                {!isSelectedRunning ? (
                  <button onClick={handleStart} className="mt-3 w-full py-3 rounded-lg font-semibold text-sm bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20">
                    <Play className="w-4 h-4 inline mr-2" /> {(addresses.find(a => a.id === setupId)?.username || addresses.find(a => a.id === setupId)?.label || 'Seçili cüzdan')} için Takibi Başlat
                  </button>
                ) : (
                  <button onClick={() => setupId && handleStop(setupId)} className="mt-3 w-full py-3 rounded-lg font-semibold text-sm bg-warning/10 text-warning border border-warning/30 hover:bg-warning/20">
                    {(addresses.find(a => a.id === setupId)?.username || addresses.find(a => a.id === setupId)?.label || 'Seçili cüzdan')} için Takibi Durdur
                  </button>
                )}
              </div>
            </div>
          </div>

          {runningSessions.length > 0 && (
            <div className="mb-6">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">AKTİF TAKİPLER ({runningSessions.length})</h3>
              <div className="space-y-2">
                {runningSessions.map(({ addressId, session, walletName, walletAddress }) => {
                  const activeTradeCount = activeTrades.filter((trade) => trade.addressId === addressId).length;
                  const statusLabel = session.status === 'syncing' ? 'SENKRONİZE EDİLİYOR' : 'TAKİP AKTİF';
                  return (
                    <div key={addressId} className="glass-card p-4 border border-primary/20">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-xs font-semibold text-foreground">{walletName}</p>
                          <p className="font-mono text-[10px] text-muted-foreground truncate">{walletAddress || addressId}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">Bu cüzdan takip ediliyor. Yeni aktivite geldiğinde trade otomatik oluşacak.</p>
                          {copySessionErrors[addressId] && (
                            <p className="mt-2 text-[11px] text-destructive">Hata: {copySessionErrors[addressId]}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 rounded text-[10px] font-semibold bg-primary/15 text-primary">{statusLabel}</span>
                          <span className="px-2 py-1 rounded text-[10px] font-semibold bg-secondary/60 text-foreground">Aktif Trade: {activeTradeCount}</span>
                          <button
                            type="button"
                            onClick={() => openAnalysis(addressId)}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium border border-primary/40 text-primary hover:bg-primary/10"
                          >
                            Analize Git
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mb-6">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Pasif Tradeler ({passiveSessions.length})</h3>
            {passiveSessions.length === 0 ? (
              <div className="glass-card p-6 text-center text-muted-foreground text-sm">Takip edilmeyen cüzdan yok</div>
            ) : (
              <div className="space-y-2">
                {passiveSessions.map(({ addressId, walletName, walletAddress }) => {
                  const activeTradeCount = activeTrades.filter((trade) => trade.addressId === addressId).length;
                  return (
                    <div key={addressId} className="glass-card p-4 border border-border/30">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-xs font-semibold text-foreground">{walletName}</p>
                          <p className="font-mono text-[10px] text-muted-foreground truncate">{walletAddress || addressId}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">Bu cüzdan şu an takip edilmiyor. Takibi başlatmadan yeni trade otomatik oluşmaz.</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="px-2 py-1 rounded text-[10px] font-semibold bg-secondary/60 text-foreground">TAKİP PASİF</span>
                          <span className="px-2 py-1 rounded text-[10px] font-semibold bg-secondary/60 text-foreground">Aktif Trade: {activeTradeCount}</span>
                          <button
                            type="button"
                            onClick={() => openAnalysis(addressId)}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-medium border border-primary/40 text-primary hover:bg-primary/10"
                          >
                            Analize Git
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {closedTrades.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Kapatılan Tradeler ({closedTrades.length})</h3>
              <div className="space-y-2 opacity-60">
                {closedTrades.map(trade => {
                  const pnl = (trade.currentPrice - trade.entryPrice) * trade.amount * (trade.direction === 'long' ? 1 : -1);
                  return (
                    <div key={trade.id} className="glass-card p-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${trade.direction === 'long' ? 'bg-accent/15 text-accent' : 'bg-destructive/15 text-destructive'}`}>{trade.direction.toUpperCase()}</span>
                        <span className="text-xs text-foreground">{trade.strategy}</span>
                      </div>
                      <span className={`text-sm font-bold ${pnl > 0 ? 'text-accent' : 'text-destructive'}`}>{pnl > 0 ? '+' : ''}{pnl.toFixed(2)} $</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'analysis' && (
        <div className="glass-card p-4 mb-6">
          {!analysisStats ? (
            <div className="text-center py-2">
              <h3 className="text-sm font-semibold text-foreground mb-2">Copy Trade Analizi • {analysisWalletName || 'Seçili cüzdan'}</h3>
              <p className="text-sm text-muted-foreground">Henüz bu cüzdan için oluşmuş trade yok. Takip aktifse yeni işlem geldiğinde burada görünecek.</p>
            </div>
          ) : (
            <>
              <h3 className="text-sm font-semibold text-foreground mb-3">Copy Trade Analizi • {analysisWalletName}</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                {[
                  { label: 'TRADE BAŞLANGIÇ', value: formatDate(analysisStats.startAt) },
                  { label: 'TOTAL BUDGET', value: analysisStats.totalBudgetText },
                  { label: 'SERBEST PARA', value: analysisStats.freeBudgetText },
                  { label: 'OYUNDAKİ PARA', value: formatUsd(analysisStats.inGameMoney) },
                  { label: 'TOPLAM İŞLEM', value: String(analysisStats.totalTransactions) },
                  { label: 'TOTAL BUY', value: formatUsd(analysisStats.totalBuy) },
                  { label: 'TOTAL SELL', value: formatUsd(analysisStats.totalSell) },
                ].map((stat) => (
                  <div key={stat.label} className="stat-card"><p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-2">{stat.label}</p><p className="text-sm font-bold text-foreground break-words">{stat.value}</p></div>
                ))}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4">
                <div className="p-3 rounded-lg border border-border/30 bg-secondary/10">
                  <h4 className="text-xs font-semibold text-foreground mb-3">Share/Adet Grafiği</h4>
                  <div className="h-64"><ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.4)" /><XAxis dataKey="price" type="number" name="Price" tickFormatter={(v) => Number(v).toFixed(2)} stroke="hsl(var(--muted-foreground))" /><YAxis dataKey="share" type="number" name="Share" stroke="hsl(var(--muted-foreground))" /><Tooltip cursor={{ strokeDasharray: '4 4' }} formatter={(value: number) => Number(value).toLocaleString('tr-TR', { maximumFractionDigits: 6 })} /><Scatter data={sharePriceData.map((item) => ({ price: item.price, share: item.share }))} fill="hsl(var(--primary))" /></ScatterChart></ResponsiveContainer></div>
                </div>
                <div className="p-3 rounded-lg border border-border/30 bg-secondary/10">
                  <h4 className="text-xs font-semibold text-foreground mb-3">Price/Adet Grafiği</h4>
                  <div className="h-64"><ResponsiveContainer width="100%" height="100%"><ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border) / 0.4)" /><XAxis dataKey="price" type="number" name="Price" tickFormatter={(v) => Number(v).toFixed(2)} stroke="hsl(var(--muted-foreground))" /><YAxis dataKey="usdSpent" type="number" name="USD" stroke="hsl(var(--muted-foreground))" /><Tooltip cursor={{ strokeDasharray: '4 4' }} formatter={(value: number) => Number(value).toLocaleString('tr-TR', { style: 'currency', currency: 'USD' })} /><Scatter data={sharePriceData.map((item) => ({ price: item.price, usdSpent: item.usdSpent }))} fill="hsl(var(--accent))" /></ScatterChart></ResponsiveContainer></div>
                </div>
              </div>


              <div className="p-3 rounded-lg border border-border/30 bg-secondary/10">
                <h4 className="text-xs font-semibold text-foreground mb-2">Son Aktiviteler</h4>
                <div className="space-y-2">
                  {myActivities.slice(0, 30).map((activity) => (
                    <div key={activity.id} className="flex items-center justify-between border-b border-border/20 pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${activity.side === 'BUY' ? 'bg-accent/10' : 'bg-warning/10'}`}>
                          {activity.side === 'BUY' ? <ArrowDownRight className="w-4 h-4 text-accent" /> : <ArrowUpRight className="w-4 h-4 text-warning" />}
                        </div>
                        <div><p className="text-xs font-medium text-foreground">{activity.marketLabel}</p><p className="text-[10px] text-muted-foreground">{activity.side} • {formatDate(activity.occurredAt)}</p></div>
                      </div>
                      <p className="text-xs text-foreground text-right">Price: {activity.price.toLocaleString('tr-TR', { maximumFractionDigits: 2 })} • Share: {activity.share.toLocaleString('tr-TR', { maximumFractionDigits: 6 })} • USD: {activity.usd.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}</p>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
