import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface TrackedAddress {
  id: string;
  address: string;
  category: string;
  addedAt: Date;
  label?: string;
}

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
  status: 'active' | 'closed';
}

interface DashboardContextType {
  addresses: TrackedAddress[];
  categories: string[];
  paperTrades: PaperTrade[];
  addAddress: (address: string, category: string) => void;
  removeAddress: (id: string) => void;
  addCategory: (category: string) => void;
  addToPaperTrade: (addressId: string) => void;
  startPaperTrade: (addressId: string, strategy: string, direction: 'long' | 'short', amount: number) => void;
  closePaperTrade: (tradeId: string) => void;
}

const DashboardContext = createContext<DashboardContextType | undefined>(undefined);

const DEFAULT_CATEGORIES = ['Whales', 'Smart Money', 'Market Makers', 'Influencers', 'DeFi Protocols'];

// Mock price generation
const randomPrice = () => +(Math.random() * 100000 + 20000).toFixed(2);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const [addresses, setAddresses] = useState<TrackedAddress[]>([
    { id: '1', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', category: 'Whales', addedAt: new Date('2025-01-15'), label: 'Whale Alpha' },
    { id: '2', address: 'bc1q9h5yjqka3rr4m3hazfc9kzadu7gj4x2h9ja5gy', category: 'Smart Money', addedAt: new Date('2025-02-01'), label: 'SM Trader' },
    { id: '3', address: '3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5', category: 'Whales', addedAt: new Date('2025-01-20') },
    { id: '4', address: 'bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h', category: 'Market Makers', addedAt: new Date('2025-01-28') },
    { id: '5', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', category: 'DeFi Protocols', addedAt: new Date('2025-02-05'), label: 'Satoshi' },
  ]);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([
    { id: 'pt1', addressId: '1', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', category: 'Whales', strategy: 'Mirror Trading', direction: 'long', entryPrice: 42350, currentPrice: 44120, amount: 0.5, startedAt: new Date('2025-02-01'), status: 'active' },
  ]);

  const addAddress = useCallback((address: string, category: string) => {
    const newAddr: TrackedAddress = {
      id: Date.now().toString(),
      address,
      category,
      addedAt: new Date(),
    };
    setAddresses(prev => [...prev, newAddr]);
  }, []);

  const removeAddress = useCallback((id: string) => {
    setAddresses(prev => prev.filter(a => a.id !== id));
  }, []);

  const addCategory = useCallback((category: string) => {
    setCategories(prev => prev.includes(category) ? prev : [...prev, category]);
  }, []);

  const addToPaperTrade = useCallback((addressId: string) => {
    // Already handled - addresses show in paper trade tab
  }, []);

  const startPaperTrade = useCallback((addressId: string, strategy: string, direction: 'long' | 'short', amount: number) => {
    const addr = addresses.find(a => a.id === addressId);
    if (!addr) return;
    const price = randomPrice();
    const trade: PaperTrade = {
      id: Date.now().toString(),
      addressId,
      address: addr.address,
      category: addr.category,
      strategy,
      direction,
      entryPrice: price,
      currentPrice: price + (Math.random() - 0.45) * 3000,
      amount,
      startedAt: new Date(),
      status: 'active',
    };
    setPaperTrades(prev => [...prev, trade]);
  }, [addresses]);

  const closePaperTrade = useCallback((tradeId: string) => {
    setPaperTrades(prev => prev.map(t => t.id === tradeId ? { ...t, status: 'closed' as const } : t));
  }, []);

  return (
    <DashboardContext.Provider value={{
      addresses, categories, paperTrades,
      addAddress, removeAddress, addCategory, addToPaperTrade,
      startPaperTrade, closePaperTrade,
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
