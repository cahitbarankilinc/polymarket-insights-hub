import { useEffect, useMemo, useState } from 'react';
import { Play, X, TrendingUp, TrendingDown, Wallet, ChevronUp, ChevronDown } from 'lucide-react';
import { useDashboard, type CopyMode } from '@/context/DashboardContext';
import { getWalletEventsWithStats, type WalletTrackerEvent } from '@/lib/polymarketTrackerApi';
import { toast } from 'sonner';

const COPY_MODE_OPTIONS: Array<{ value: CopyMode; label: string; description: string }> = [
  { value: 'notional', label: '1:1 Notional Copy', description: 'Onun aldığı USD kadar al.' },
  { value: 'proportional', label: 'Proportional to Free Balance', description: 'Boştaki bakiyeye göre oranla.' },
  { value: 'multiplier', label: 'Multiplier Mode', description: 'Onun trade tutarı × k.' },
  { value: 'fixed-amount', label: 'Fixed Amount per Trade', description: 'Her işlemde sabit USD.' },
];

interface WalletModeConfig {
  mode: CopyMode;
  sourceTradeUsd: string;
  leaderFreeBalance: string;
  multiplier: string;
  fixedAmount: string;
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
  fixedShares: '50',
  sharePrice: '1',
  strategy: 'Copy Trading',
  direction: 'long',
};

const parseNumberFromText = (value?: string | null): number | undefined => {
  if (!value) return undefined;
  const match = value.match(/[-+]?\d[\d.,]*/g);
  if (!match?.length) return undefined;
  const raw = match[match.length - 1];
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw.replace(/,/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

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

interface PaperTradePrefill {
  sourceTradeUsd?: number;
  sharePrice?: number;
  fixedShares?: number;
  direction?: 'long' | 'short';
  leaderFreeBalance?: number;
}

export default function PaperTradeTab({ preselectedId, prefill }: { preselectedId?: string | null; prefill?: PaperTradePrefill | null }) {
  const { addresses, paperTrades, startPaperTrade, closePaperTrade, paperBudget, setPaperBudget } = useDashboard();
  const [setupId, setSetupId] = useState<string | null>(preselectedId || null);
  const [collapsed, setCollapsed] = useState(false);
  const [budgetMode, setBudgetMode] = useState<'unlimited' | 'limited'>(paperBudget.mode);
  const [budgetType, setBudgetType] = useState<'daily' | 'total'>(paperBudget.type);
  const [budgetAmount, setBudgetAmount] = useState(paperBudget.amount > 0 ? String(paperBudget.amount) : '1000');
  const [virtualFreeBalance, setVirtualFreeBalance] = useState('1000');
  const [walletConfigs, setWalletConfigs] = useState<Record<string, WalletModeConfig>>({});

  const loadAutoConfig = async (addressId: string): Promise<WalletModeConfig | null> => {
    const targetAddress = addresses.find((address) => address.id === addressId);
    if (!targetAddress) return null;

    const baseConfig = walletConfigs[addressId] || defaultConfig;

    try {
      const payload = await getWalletEventsWithStats(targetAddress.address);
      const latestEvent = payload.events[0];
      const nextConfig: WalletModeConfig = {
        ...baseConfig,
        sourceTradeUsd: String(latestEvent?.value_usd ?? baseConfig.sourceTradeUsd),
        sharePrice: String(latestEvent?.price ?? baseConfig.sharePrice),
        fixedShares: String(latestEvent?.size ?? baseConfig.fixedShares),
        direction: resolveDirection(latestEvent) ?? baseConfig.direction,
        leaderFreeBalance: String(
          parseNumberFromText(targetAddress.polygonscanTopTotalValText)
          ?? baseConfig.leaderFreeBalance,
        ),
      };

      setWalletConfigs((prev) => ({
        ...prev,
        [addressId]: nextConfig,
      }));
      return nextConfig;
    } catch {
      const nextConfig: WalletModeConfig = {
        ...baseConfig,
        leaderFreeBalance: String(
          parseNumberFromText(targetAddress.polygonscanTopTotalValText)
          ?? baseConfig.leaderFreeBalance,
        ),
      };

      setWalletConfigs((prev) => ({
        ...prev,
        [addressId]: nextConfig,
      }));
      return nextConfig;
    }
  };

  useEffect(() => {
    if (preselectedId) {
      setSetupId(preselectedId);
      setCollapsed(false);
    }
  }, [preselectedId]);

  useEffect(() => {
    if (!setupId || !prefill) return;

    const patch: Partial<WalletModeConfig> = {};
    if (typeof prefill.sourceTradeUsd === 'number' && Number.isFinite(prefill.sourceTradeUsd)) {
      patch.sourceTradeUsd = String(prefill.sourceTradeUsd);
    }
    if (typeof prefill.sharePrice === 'number' && Number.isFinite(prefill.sharePrice)) {
      patch.sharePrice = String(prefill.sharePrice);
    }
    if (typeof prefill.fixedShares === 'number' && Number.isFinite(prefill.fixedShares)) {
      patch.fixedShares = String(prefill.fixedShares);
    }
    if (typeof prefill.leaderFreeBalance === 'number' && Number.isFinite(prefill.leaderFreeBalance)) {
      patch.leaderFreeBalance = String(prefill.leaderFreeBalance);
    }
    if (prefill.direction) {
      patch.direction = prefill.direction;
    }

    if (Object.keys(patch).length) {
      setWalletConfigs(prev => ({
        ...prev,
        [setupId]: {
          ...(prev[setupId] || defaultConfig),
          ...patch,
        },
      }));
    }
  }, [setupId, prefill]);

  useEffect(() => {
    if (!setupId) return;
    loadAutoConfig(setupId);
  }, [setupId, addresses]);

  const currentConfig = setupId ? (walletConfigs[setupId] || defaultConfig) : defaultConfig;

  const myDynamicFreeBalance = useMemo(() => {
    if (paperBudget.mode === 'limited') {
      return paperBudget.remaining;
    }
    return parseFloat(virtualFreeBalance) || 0;
  }, [paperBudget.mode, paperBudget.remaining, virtualFreeBalance]);

  const setConfig = (patch: Partial<WalletModeConfig>) => {
    if (!setupId) return;
    setWalletConfigs(prev => ({
      ...prev,
      [setupId]: {
        ...(prev[setupId] || defaultConfig),
        ...patch,
      },
    }));
  };

  const applyBudget = () => {
    const amount = parseFloat(budgetAmount) || 0;
    setPaperBudget({
      mode: budgetMode,
      type: budgetType,
      amount,
    });
    toast.success('Bütçe ayarları güncellendi');
  };

  const calculateTradeUsd = (config: WalletModeConfig) => {
    const sourceTradeUsd = parseFloat(config.sourceTradeUsd) || 0;
    const leaderFree = parseFloat(config.leaderFreeBalance) || 1;
    const multiplier = parseFloat(config.multiplier) || 1;
    const fixedAmount = parseFloat(config.fixedAmount) || 0;
    const fixedShares = parseFloat(config.fixedShares) || 0;
    const sharePrice = parseFloat(config.sharePrice) || 1;

    switch (config.mode) {
      case 'notional':
        return sourceTradeUsd;
      case 'proportional':
        return sourceTradeUsd * (myDynamicFreeBalance / Math.max(leaderFree, 0.0001));
      case 'multiplier':
        return sourceTradeUsd * multiplier;
      case 'fixed-amount':
        return fixedAmount;
      case 'fixed-shares':
        return fixedShares * sharePrice;
      default:
        return sourceTradeUsd;
    }
  };

  const handleStart = async () => {
    if (!setupId) {
      toast.error('Önce bir cüzdan seçin');
      return;
    }

    const latestConfig = await loadAutoConfig(setupId) || currentConfig;
    const tradeUsd = calculateTradeUsd(latestConfig);
    if (tradeUsd <= 0) {
      toast.error('Trade tutarı 0 dan büyük olmalı');
      return;
    }

    const result = startPaperTrade(setupId, {
      strategy: latestConfig.strategy || 'Copy Trading',
      direction: latestConfig.direction,
      spendUsd: tradeUsd,
      copyMode: latestConfig.mode,
    });

    if (!result.ok) {
      toast.error(result.reason || 'Paper trade başlatılamadı');
      return;
    }

    toast.success('Paper copy trade başlatıldı!');
    setCollapsed(true);
  };

  const activeTrades = paperTrades.filter(t => t.status === 'active');
  const closedTrades = paperTrades.filter(t => t.status === 'closed');

  return (
    <div className="animate-slide-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-foreground">Paper Trading</h2>
          <p className="text-xs text-muted-foreground">Bütçe + cüzdan bazlı copy trade test ortamı</p>
        </div>
      </div>

      <div className="glass-card p-5 mb-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">Bütçe Yönetimi</h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Bütçe Tipi</label>
            <div className="flex gap-2">
              <button
                onClick={() => setBudgetMode('unlimited')}
                className={`px-3 py-2 rounded-lg text-xs border ${budgetMode === 'unlimited' ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/40 border-border/30 text-muted-foreground'}`}
              >
                Sınırsız
              </button>
              <button
                onClick={() => setBudgetMode('limited')}
                className={`px-3 py-2 rounded-lg text-xs border ${budgetMode === 'limited' ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/40 border-border/30 text-muted-foreground'}`}
              >
                Bütçe Tanımla
              </button>
            </div>
          </div>

          {budgetMode === 'limited' ? (
            <>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">Bütçe Periyodu</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setBudgetType('daily')}
                    className={`px-3 py-2 rounded-lg text-xs border ${budgetType === 'daily' ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/40 border-border/30 text-muted-foreground'}`}
                  >
                    Günlük
                  </button>
                  <button
                    onClick={() => setBudgetType('total')}
                    className={`px-3 py-2 rounded-lg text-xs border ${budgetType === 'total' ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/40 border-border/30 text-muted-foreground'}`}
                  >
                    Toplam
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-2 block">Bütçe Tutarı ($)</label>
                <input
                  type="number"
                  min="0"
                  value={budgetAmount}
                  onChange={(e) => setBudgetAmount(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Sınırsız modda Free Balance</label>
              <input
                type="number"
                min="0"
                value={virtualFreeBalance}
                onChange={(e) => setVirtualFreeBalance(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm"
              />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Aktif kullanılabilir bakiye:{' '}
            <span className="font-mono text-foreground">
              {paperBudget.mode === 'limited' ? `$${paperBudget.remaining.toFixed(2)}` : `${myDynamicFreeBalance.toFixed(2)} (virtual)`}
            </span>
          </p>
          <button
            onClick={applyBudget}
            className="px-4 py-2 rounded-lg text-xs font-semibold bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            Bütçeyi Uygula
          </button>
        </div>
      </div>

      <div className="mb-6">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Takip edilen cüzdanlar</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {addresses.map(addr => (
            <button
              key={addr.id}
              onClick={() => {
                setSetupId(addr.id);
                setCollapsed(false);
              }}
              className={`glass-card-hover p-3 text-left border ${setupId === addr.id ? 'border-primary/50 bg-primary/5' : 'border-border/20'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <Wallet className="w-3.5 h-3.5 text-primary" />
                <span className="text-sm font-medium text-foreground">{addr.label || addr.category}</span>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground truncate">{addr.address}</p>
            </button>
          ))}
        </div>
      </div>

      {setupId && (
        <div className="glass-card p-5 mb-6 glow-border animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Cüzdan Ayarları</h3>
            <div className="flex gap-2 items-center">
              <button
                onClick={() => setCollapsed((prev) => !prev)}
                className="text-xs px-2 py-1 rounded border border-border/30 text-muted-foreground hover:text-foreground"
              >
                {collapsed ? <><ChevronDown className="w-3 h-3 inline mr-1" />Genişlet</> : <><ChevronUp className="w-3 h-3 inline mr-1" />Küçült</>}
              </button>
              <button onClick={() => setSetupId(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <p className="font-mono text-xs text-muted-foreground mb-4 truncate">
            {addresses.find(a => a.id === setupId)?.address}
          </p>

          {!collapsed && (
            <>
              <div className="mb-4">
                <label className="text-xs font-medium text-muted-foreground mb-2 block">Kopya Modu (wallet bazlı)</label>
                <div className="grid sm:grid-cols-2 gap-2">
                  {COPY_MODE_OPTIONS.map(option => (
                    <button
                      key={option.value}
                      onClick={() => setConfig({ mode: option.value })}
                      className={`p-3 rounded-lg border text-left ${currentConfig.mode === option.value ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary/30 border-border/30 text-muted-foreground'}`}
                    >
                      <p className="text-xs font-semibold">{option.label}</p>
                      <p className="text-[10px] mt-1">{option.description}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                {currentConfig.mode === 'multiplier' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Multiplier k</label>
                    <input type="number" step="0.1" value={currentConfig.multiplier} onChange={(e) => setConfig({ multiplier: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" />
                  </div>
                )}

                {currentConfig.mode === 'fixed-amount' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">Sabit miktar ($)</label>
                    <input type="number" value={currentConfig.fixedAmount} onChange={(e) => setConfig({ fixedAmount: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" />
                  </div>
                )}

                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Etiket/Strateji</label>
                  <input type="text" value={currentConfig.strategy} onChange={(e) => setConfig({ strategy: e.target.value })} className="w-full px-3 py-2 rounded-lg bg-secondary/50 border border-border/30 text-sm" />
                </div>
              </div>

              <div className="mb-4 p-3 rounded-lg bg-secondary/20 border border-border/20">
                <p className="text-xs text-muted-foreground">
                  Hesaplanan trade tutarı: <span className="font-mono text-foreground">${calculateTradeUsd(currentConfig).toFixed(2)}</span>
                </p>
              </div>
            </>
          )}

          <button
            onClick={handleStart}
            className="w-full py-3 rounded-lg font-semibold text-sm bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-all active:scale-[0.98]"
          >
            <Play className="w-4 h-4 inline mr-2" /> {addresses.find(a => a.id === setupId)?.label || 'Seçili cüzdan'} için Başlat
          </button>
        </div>
      )}

      <div className="mb-6">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Aktif Tradeler ({activeTrades.length})
        </h3>
        {activeTrades.length === 0 && (
          <div className="glass-card p-6 text-center text-muted-foreground text-sm">
            Henüz aktif trade yok
          </div>
        )}
        <div className="space-y-2">
          {activeTrades.map(trade => {
            const pnl = (trade.currentPrice - trade.entryPrice) * trade.amount * (trade.direction === 'long' ? 1 : -1);
            const pnlPercent = ((trade.currentPrice - trade.entryPrice) / trade.entryPrice * 100) * (trade.direction === 'long' ? 1 : -1);
            const isProfit = pnl > 0;

            return (
              <div key={trade.id} className="glass-card p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      trade.direction === 'long' ? 'bg-accent/15 text-accent' : 'bg-destructive/15 text-destructive'
                    }`}>
                      {trade.direction.toUpperCase()}
                    </span>
                    <span className="text-xs font-medium text-foreground">{trade.strategy}</span>
                    {trade.copyMode && <span className="text-[10px] text-muted-foreground">mode: {trade.copyMode}</span>}
                  </div>
                  <button
                    onClick={() => {
                      closePaperTrade(trade.id);
                      toast.success('Trade kapatıldı');
                    }}
                    className="px-3 py-1 rounded-lg text-xs font-medium bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20 transition-all"
                  >
                    Kapat
                  </button>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground truncate mb-2">{trade.address}</p>
                <div className="flex items-center justify-between">
                  <div className="flex gap-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground">Giriş</p>
                      <p className="text-sm font-mono font-medium text-foreground">${trade.entryPrice.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Güncel</p>
                      <p className="text-sm font-mono font-medium text-foreground">${trade.currentPrice.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">Tutar</p>
                      <p className="text-sm font-mono font-medium text-foreground">${(trade.spentUsd || 0).toFixed(2)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-lg font-bold ${isProfit ? 'text-accent' : 'text-destructive'}`}>
                      {isProfit ? '+' : ''}{pnl.toFixed(2)} $
                    </p>
                    <p className={`text-xs font-medium ${isProfit ? 'text-accent' : 'text-destructive'}`}>
                      {isProfit ? <TrendingUp className="w-3 h-3 inline" /> : <TrendingDown className="w-3 h-3 inline" />}
                      {' '}{isProfit ? '+' : ''}{pnlPercent.toFixed(2)}%
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {closedTrades.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Kapatılan Tradeler ({closedTrades.length})
          </h3>
          <div className="space-y-2 opacity-60">
            {closedTrades.map(trade => {
              const pnl = (trade.currentPrice - trade.entryPrice) * trade.amount * (trade.direction === 'long' ? 1 : -1);
              const isProfit = pnl > 0;
              return (
                <div key={trade.id} className="glass-card p-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      trade.direction === 'long' ? 'bg-accent/15 text-accent' : 'bg-destructive/15 text-destructive'
                    }`}>{trade.direction.toUpperCase()}</span>
                    <span className="text-xs text-foreground">{trade.strategy}</span>
                  </div>
                  <span className={`text-sm font-bold ${isProfit ? 'text-accent' : 'text-destructive'}`}>
                    {isProfit ? '+' : ''}{pnl.toFixed(2)} $
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
