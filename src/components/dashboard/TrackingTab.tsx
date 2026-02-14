import { useEffect, useState } from 'react';
import { Search, Filter, Trash2, BarChart3, Copy, ChevronRight } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';
import AddressAnalysis from './AddressAnalysis';
import { getWalletEvents, listTrackedWallets, stopWalletTracking, type WalletTrackerEvent, type WalletTrackerInfo } from '@/lib/polymarketTrackerApi';


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
export interface PaperTradePrefill {
  sourceTradeUsd?: number;
  sharePrice?: number;
  fixedShares?: number;
  direction?: 'long' | 'short';
  leaderFreeBalance?: number;
}

export default function TrackingTab({ onPaperTrade }: { onPaperTrade: (id: string, prefill?: PaperTradePrefill) => void }) {
  const { addresses, categories, removeAddress } = useDashboard();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [analysisAddress, setAnalysisAddress] = useState<string | null>(null);
  const [trackerMap, setTrackerMap] = useState<Record<string, WalletTrackerInfo>>({});
  const [eventsMap, setEventsMap] = useState<Record<string, WalletTrackerEvent[]>>({});

  const filtered = addresses.filter(a => {
    const matchCat = !selectedCategory || a.category === selectedCategory;
    const matchSearch = !searchQuery || a.address.toLowerCase().includes(searchQuery.toLowerCase());
    return matchCat && matchSearch;
  });

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;

    const runSync = async () => {
      try {
        const wallets = await listTrackedWallets();
        if (!active) return;

        const nextTrackerMap = wallets.reduce<Record<string, WalletTrackerInfo>>((acc, wallet) => {
          acc[wallet.address] = wallet;
          return acc;
        }, {});
        setTrackerMap(nextTrackerMap);

        const trackedAddresses = addresses.map((addr) => addr.address.toLowerCase());
        const eventsPairs = await Promise.all(trackedAddresses.map(async (address) => {
          const events = await getWalletEvents(address);
          return [address, events.slice(0, 3)] as const;
        }));

        if (!active) return;
        setEventsMap(Object.fromEntries(eventsPairs));
      } catch {
        // local tracker dev server kapalı olabilir
      } finally {
        if (!active) return;
        timeoutId = window.setTimeout(() => {
          void runSync();
        }, 1000);
      }
    };

    void runSync();

    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [addresses]);

  if (analysisAddress) {
    const addr = addresses.find(a => a.id === analysisAddress);
    if (addr) {
      return (
        <AddressAnalysis
          address={addr}
          onBack={() => setAnalysisAddress(null)}
        />
      );
    }
  }

  return (
    <div className="flex gap-6 animate-slide-up">
      {/* Sidebar - Categories */}
      <aside className="w-48 shrink-0 hidden lg:block">
        <div className="glass-card p-4 sticky top-24">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            <Filter className="w-3 h-3 inline mr-1" /> Kategoriler
          </h3>
          <div className="space-y-1">
            <button
              onClick={() => setSelectedCategory(null)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${
                !selectedCategory ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
              }`}
            >
              Tümü ({addresses.length})
            </button>
            {categories.map(cat => {
              const count = addresses.filter(a => a.category === cat).length;
              if (count === 0) return null;
              return (
                <button
                  key={cat}
                  onClick={() => setSelectedCategory(cat)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${
                    selectedCategory === cat ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                  }`}
                >
                  {cat} ({count})
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0">
        {/* Mobile category filter */}
        <div className="lg:hidden flex gap-2 mb-4 overflow-x-auto scrollbar-thin pb-2">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              !selectedCategory ? 'bg-primary/15 text-primary border border-primary/30' : 'bg-secondary/50 text-muted-foreground border border-border/30'
            }`}
          >
            Tümü
          </button>
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                selectedCategory === cat ? 'bg-primary/15 text-primary border border-primary/30' : 'bg-secondary/50 text-muted-foreground border border-border/30'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Adres ara..."
            className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-secondary/30 border border-border/30 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all"
          />
        </div>

        {/* Address List */}
        <div className="space-y-2">
          {filtered.length === 0 && (
            <div className="glass-card p-8 text-center text-muted-foreground text-sm">
              Henüz takip edilen adres yok
            </div>
          )}
          {filtered.map((addr) => (
            <div
              key={addr.id}
              className="glass-card-hover p-4 group cursor-pointer"
              onClick={() => setAnalysisAddress(addr.id)}
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    {addr.label && (
                      <span className="text-sm font-semibold text-foreground">{addr.label}</span>
                    )}
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                      {addr.category}
                    </span>
                  </div>
                  <p className="font-mono text-xs text-muted-foreground truncate">{addr.address}</p>
                  <p className="text-[10px] text-muted-foreground/60 mt-1">
                    Eklendi: {addr.addedAt.toLocaleDateString('tr-TR')}
                  </p>
                  {addr.note && (
                    <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">
                      Not: {addr.note}
                    </p>
                  )}
                  {trackerMap[addr.address.toLowerCase()] && (
                    <p className="text-[10px] text-emerald-400/90 mt-1">
                      {trackerMap[addr.address.toLowerCase()].isActive ? 'Takip aktif' : 'Takip pasif'} •
                      {' '}Toplam event: {trackerMap[addr.address.toLowerCase()].eventCount}
                    </p>
                  )}
                  {eventsMap[addr.address.toLowerCase()]?.length ? (
                    <div className="mt-2 space-y-1">
                      {eventsMap[addr.address.toLowerCase()].map((event, index) => (
                        <p key={`${event.tx_hash ?? index}-${event.seen_at_utc}`} className="text-[10px] text-muted-foreground/80 truncate">
                          [{event.raw_source}] {(event.side ?? event.type ?? 'EVENT').toUpperCase()} • {event.market ?? 'Unknown market'}
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(addr.address);
                      toast.success('Adres kopyalandı');
                    }}
                    className="p-2 rounded-lg hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-all"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const latestEvent = trackerMap[addr.address.toLowerCase()]?.latestEvent || eventsMap[addr.address.toLowerCase()]?.[0];
                      onPaperTrade(addr.id, {
                        sourceTradeUsd: latestEvent?.value_usd ?? undefined,
                        sharePrice: latestEvent?.price ?? undefined,
                        fixedShares: latestEvent?.size ?? undefined,
                        direction: resolveDirection(latestEvent),
                        leaderFreeBalance: parseNumberFromText(addr.polygonscanTopTotalValText),
                      });
                    }}
                    className="p-2 rounded-lg hover:bg-accent/10 text-muted-foreground hover:text-accent transition-all"
                    title="Paper Trade"
                  >
                    <BarChart3 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      removeAddress(addr.id);
                      stopWalletTracking(addr.address);
                      toast.success('Adres silindi');
                    }}
                    className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <ChevronRight className="w-4 h-4 text-muted-foreground/40 ml-1" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
