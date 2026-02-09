import { useState } from 'react';
import { Play, X, TrendingUp, TrendingDown, BarChart3, Wallet } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';

const STRATEGIES = ['Mirror Trading', 'Trend Following', 'Counter Trade', 'DCA Bot', 'Breakout Trading'];
const DIRECTIONS: Array<{ value: 'long' | 'short'; label: string }> = [
  { value: 'long', label: '🟢 Long' },
  { value: 'short', label: '🔴 Short' },
];

export default function PaperTradeTab({ preselectedId }: { preselectedId?: string | null }) {
  const { addresses, paperTrades, startPaperTrade, closePaperTrade } = useDashboard();
  const [setupId, setSetupId] = useState<string | null>(preselectedId || null);
  const [strategy, setStrategy] = useState('');
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [amount, setAmount] = useState('0.1');

  const paperTradeAddresses = addresses; // all addresses available for paper trade

  const handleStart = () => {
    if (!setupId || !strategy) {
      toast.error('Strateji seçmeniz gerekiyor');
      return;
    }
    startPaperTrade(setupId, strategy, direction, parseFloat(amount) || 0.1);
    toast.success('Paper trade başlatıldı!');
    setSetupId(null);
    setStrategy('');
    setAmount('0.1');
  };

  const activeTrades = paperTrades.filter(t => t.status === 'active');
  const closedTrades = paperTrades.filter(t => t.status === 'closed');

  return (
    <div className="animate-slide-up">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-foreground">Paper Trading</h2>
          <p className="text-xs text-muted-foreground">Risksiz strateji test ortamı</p>
        </div>
      </div>

      {/* Setup Modal */}
      {setupId && (
        <div className="glass-card p-5 mb-6 glow-border animate-fade-in">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Trade Ayarları</h3>
            <button onClick={() => setSetupId(null)} className="text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>

          <p className="font-mono text-xs text-muted-foreground mb-4 truncate">
            {addresses.find(a => a.id === setupId)?.address}
          </p>

          {/* Strategy */}
          <div className="mb-4">
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Strateji</label>
            <div className="flex flex-wrap gap-2">
              {STRATEGIES.map(s => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    strategy === s
                      ? 'bg-primary/20 text-primary border border-primary/40'
                      : 'bg-secondary/50 text-muted-foreground border border-border/30 hover:border-primary/20'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Direction */}
          <div className="mb-4">
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Yön</label>
            <div className="flex gap-2">
              {DIRECTIONS.map(d => (
                <button
                  key={d.value}
                  onClick={() => setDirection(d.value)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex-1 ${
                    direction === d.value
                      ? d.value === 'long'
                        ? 'bg-accent/15 text-accent border border-accent/30'
                        : 'bg-destructive/15 text-destructive border border-destructive/30'
                      : 'bg-secondary/50 text-muted-foreground border border-border/30'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          {/* Amount */}
          <div className="mb-4">
            <label className="text-xs font-medium text-muted-foreground mb-2 block">Miktar (BTC)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              step="0.01"
              min="0.001"
              className="w-full px-4 py-2.5 rounded-lg bg-secondary/50 border border-border/30 text-sm text-foreground focus:outline-none focus:border-primary/40 font-mono transition-all"
            />
          </div>

          <button
            onClick={handleStart}
            className="w-full py-3 rounded-lg font-semibold text-sm bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-all active:scale-[0.98]"
          >
            <Play className="w-4 h-4 inline mr-2" /> Başlat
          </button>
        </div>
      )}

      {/* Available Addresses */}
      {!setupId && (
        <div className="mb-6">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Adresler</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {paperTradeAddresses.map(addr => (
              <button
                key={addr.id}
                onClick={() => setSetupId(addr.id)}
                className="glass-card-hover p-3 text-left"
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
      )}

      {/* Active Trades */}
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
                    <span className="text-[10px] text-muted-foreground">{trade.category}</span>
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
                      <p className="text-[10px] text-muted-foreground">Miktar</p>
                      <p className="text-sm font-mono font-medium text-foreground">{trade.amount} BTC</p>
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

      {/* Closed Trades */}
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
