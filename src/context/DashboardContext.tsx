import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface TrackedAddress {
  id: string;
  address: string;
  category: string;
  addedAt: Date;
  note?: string;
  label?: string;
  profileUrl?: string;
  username?: string;
  trades?: number;
  largestWin?: number;
  views?: number;
  amount?: number;
  pnl?: number;
  polygonscanTopTotalValText?: string | null;
}

export type CopyMode =
  | 'notional'
  | 'proportional'
  | 'multiplier'
  | 'fixed-amount'
  | 'fixed-shares'
  | 'buy-wait';

export interface PaperTrade {
  id: string;
  addressId: string;
  address: string;
  category: string;
  strategy: string;
  direction: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  amount: number;
  startedAt: Date;
  closedAt?: Date;
  status: 'active' | 'closed';
  copyMode?: CopyMode;
  spentUsd?: number;
  side?: 'BUY' | 'SELL';
  market?: string;
  marketSlug?: string;
  outcome?: string;
}

export interface PaperBudget {
  mode: 'unlimited' | 'limited';
  type: 'daily' | 'total';
  amount: number;
  remaining: number;
  spentToday: number;
  lastDailyReset: string;
}

interface StartPaperTradeInput {
  strategy: string;
  direction: 'long' | 'short';
  spendUsd: number;
  copyMode?: CopyMode;
  entryPrice?: number;
  shareAmount?: number;
  side?: 'BUY' | 'SELL';
  market?: string;
  marketSlug?: string;
  outcome?: string;
}

interface DashboardContextType {
  addresses: TrackedAddress[];
  categories: string[];
  paperTrades: PaperTrade[];
  paperBudget: PaperBudget;
  addAddress: (address: string, category: string, profile?: Partial<TrackedAddress>) => void;
  updateAddressNote: (id: string, note: string) => void;
  removeAddress: (id: string) => void;
  addCategory: (category: string) => void;
  addToPaperTrade: (addressId: string) => void;
  setPaperBudget: (config: { mode: 'unlimited' | 'limited'; type: 'daily' | 'total'; amount: number }) => void;
  startPaperTrade: (addressId: string, input: StartPaperTradeInput) => { ok: boolean; reason?: string; tradeId?: string };
  closePaperTrade: (tradeId: string) => void;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

const DEFAULT_CATEGORIES = ['Whales', 'Smart Money', 'Market Makers', 'Influencers', 'DeFi Protocols'];

// Mock price generation
const randomPrice = () => +(Math.random() * 100000 + 20000).toFixed(2);
const todayKey = () => new Date().toISOString().slice(0, 10);
const createTradeId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [addresses, setAddresses] = useState<TrackedAddress[]>([]);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([]);
  const [paperBudget, setPaperBudgetState] = useState<PaperBudget>({
    mode: 'unlimited',
    type: 'total',
    amount: 0,
    remaining: Number.POSITIVE_INFINITY,
    spentToday: 0,
    lastDailyReset: todayKey(),
  });

  const addAddress = useCallback((address: string, category: string, profile?: Partial<TrackedAddress>) => {
    const newAddr: TrackedAddress = {
      id: Date.now().toString(),
      address,
      category,
      addedAt: new Date(),
      ...profile,
    };
    setAddresses(prev => [...prev, newAddr]);
  }, []);

  const removeAddress = useCallback((id: string) => {
    setAddresses(prev => prev.filter(a => a.id !== id));
  }, []);

  const updateAddressNote = useCallback((id: string, note: string) => {
    setAddresses(prev => prev.map((address) => (
      address.id === id
        ? { ...address, note: note.trim() || undefined }
        : address
    )));
  }, []);

  const addCategory = useCallback((category: string) => {
    setCategories(prev => prev.includes(category) ? prev : [...prev, category]);
  }, []);

  const addToPaperTrade = useCallback((_addressId: string) => {
    // Already handled - addresses show in paper trade tab
  }, []);

  const setPaperBudget = useCallback((config: { mode: 'unlimited' | 'limited'; type: 'daily' | 'total'; amount: number }) => {
    if (config.mode === 'unlimited') {
      setPaperBudgetState({
        mode: 'unlimited',
        type: config.type,
        amount: 0,
        remaining: Number.POSITIVE_INFINITY,
        spentToday: 0,
        lastDailyReset: todayKey(),
      });
      return;
    }

    const safeAmount = Number.isFinite(config.amount) ? Math.max(0, config.amount) : 0;
    setPaperBudgetState({
      mode: 'limited',
      type: config.type,
      amount: safeAmount,
      remaining: safeAmount,
      spentToday: 0,
      lastDailyReset: todayKey(),
    });
  }, []);

  const startPaperTrade = useCallback((addressId: string, input: StartPaperTradeInput) => {
    const addr = addresses.find(a => a.id === addressId);
    if (!addr) return { ok: false, reason: 'Cüzdan bulunamadı' };

    const spendUsd = Math.max(0, input.spendUsd);

    if (input.direction === 'long' && paperBudget.mode === 'limited') {
      const currentDay = todayKey();

      if (paperBudget.type === 'daily') {
        const spentToday = paperBudget.lastDailyReset === currentDay ? paperBudget.spentToday : 0;
        const remainingDaily = Math.max(0, paperBudget.amount - spentToday);
        if (spendUsd > remainingDaily) {
          return { ok: false, reason: 'Günlük bütçe yetersiz' };
        }
        setPaperBudgetState(prev => {
          const baseSpent = prev.lastDailyReset === currentDay ? prev.spentToday : 0;
          const nextSpent = baseSpent + spendUsd;
          return {
            ...prev,
            spentToday: nextSpent,
            remaining: Math.max(0, prev.amount - nextSpent),
            lastDailyReset: currentDay,
          };
        });
      } else {
        if (spendUsd > paperBudget.remaining) {
          return { ok: false, reason: 'Toplam bütçe yetersiz' };
        }
        setPaperBudgetState(prev => ({
          ...prev,
          remaining: Math.max(0, prev.remaining - spendUsd),
        }));
      }
    }

    const price = input.entryPrice && Number.isFinite(input.entryPrice) && input.entryPrice > 0
      ? input.entryPrice
      : randomPrice();
    const amount = input.shareAmount && Number.isFinite(input.shareAmount) && input.shareAmount > 0
      ? input.shareAmount
      : (spendUsd > 0 ? +(spendUsd / price).toFixed(6) : 0.001);
    const tradeId = createTradeId();
    const trade: PaperTrade = {
      id: tradeId,
      addressId,
      address: addr.address,
      category: addr.category,
      strategy: input.strategy,
      direction: input.direction,
      entryPrice: price,
      currentPrice: price + (Math.random() - 0.45) * 3000,
      amount,
      startedAt: new Date(),
      status: 'active',
      copyMode: input.copyMode,
      spentUsd: spendUsd,
      side: input.side,
      market: input.market,
      marketSlug: input.marketSlug,
      outcome: input.outcome,
    };
    setPaperTrades(prev => [...prev, trade]);
    return { ok: true, tradeId };
  }, [addresses, paperBudget]);

  const closePaperTrade = useCallback((tradeId: string) => {
    setPaperTrades(prev => prev.map(t => (
      t.id === tradeId
        ? { ...t, status: 'closed' as const, closedAt: new Date() }
        : t
    )));
  }, []);

  return (
    <DashboardContext.Provider value={{
      addresses, categories, paperTrades, paperBudget,
      addAddress, updateAddressNote, removeAddress, addCategory, addToPaperTrade,
      setPaperBudget, startPaperTrade, closePaperTrade,
    }}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboard must be used within DashboardProvider');
  return ctx;
}
