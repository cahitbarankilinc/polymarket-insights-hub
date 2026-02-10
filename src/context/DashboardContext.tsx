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
    { id: '1', address: '0x23cb796cf58bfa12352f0164f479deedbd50658e', category: 'Whales', addedAt: new Date('2025-01-15'), label: 'Whale Alpha' },
    { id: '2', address: '0x8f9f96f5f4f9054f0f665f2f344ecb9ed9f2f9e9', category: 'Smart Money', addedAt: new Date('2025-02-01'), label: 'SM Trader' },
    { id: '3', address: '0x7d7f7f7c1a2f40f4a0c8e510af4f558b5756fa0d', category: 'Whales', addedAt: new Date('2025-01-20') },
    { id: '4', address: '0x4ea5d5e7f8e8ce0c8f9f675e7e5fb42f6a2f7e24', category: 'Market Makers', addedAt: new Date('2025-01-28') },
    { id: '5', address: '0x3f5ce5fbfe3e9af3971dD833D26BA9b5C936f0bE', category: 'DeFi Protocols', addedAt: new Date('2025-02-05'), label: 'Reference Wallet' },
  ]);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [paperTrades, setPaperTrades] = useState<PaperTrade[]>([
    { id: 'pt1', addressId: '1', address: '0x23cb796cf58bfa12352f0164f479deedbd50658e', category: 'Whales', strategy: 'Mirror Trading', direction: 'long', entryPrice: 42350, currentPrice: 44120, amount: 0.5, startedAt: new Date('2025-02-01'), status: 'active' },
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
