import { useEffect, useMemo, useState } from 'react';
import { Search, Filter, Trash2, BarChart3, Copy, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';
import AddressAnalysis from './AddressAnalysis';
import { getProfileTrades, getWalletEvents, listTrackedWallets, stopWalletTracking, type WalletTrackerEvent, type WalletTrackerInfo } from '@/lib/polymarketTrackerApi';


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

const toEventTimestampMs = (event: WalletTrackerEvent | null | undefined): number | null => {
  if (!event) return null;
  const rawDate = event.event_time ?? event.seen_at_utc;
  if (!rawDate) return null;
  const parsed = Date.parse(rawDate);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatLastActivity = (event: WalletTrackerEvent | null | undefined): string => {
  const timestamp = toEventTimestampMs(event);
  if (timestamp === null) return '—';

  const diffMs = Math.max(0, Date.now() - timestamp);
  const hourMs = 1000 * 60 * 60;
  const dayMs = hourMs * 24;

  if (diffMs < hourMs) return '0 saat önce';
  if (diffMs < dayMs) return `${Math.floor(diffMs / hourMs)} saat önce`;
  return `${Math.floor(diffMs / dayMs)} gün önce`;
};

const formatPnl = (pnl?: number): string => {
  if (typeof pnl !== 'number' || Number.isNaN(pnl)) return '—';
  return `${pnl >= 0 ? '+' : ''}${pnl.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
};

type SortColumn = 'wallet' | 'pnl' | 'eventCount' | 'lastActivity' | 'winRate';
type SortDirection = 'asc' | 'desc';

const DEFAULT_SORT: { column: SortColumn; direction: SortDirection } = {
  column: 'lastActivity',
  direction: 'desc',
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
  const [sortColumn, setSortColumn] = useState<SortColumn>(DEFAULT_SORT.column);
  const [sortDirection, setSortDirection] = useState<SortDirection>(DEFAULT_SORT.direction);
  const [winRateMap, setWinRateMap] = useState<Record<string, number | null>>({});
  const [winRateLoadingMap, setWinRateLoadingMap] = useState<Record<string, boolean>>({});

  const filtered = addresses.filter(a => {
    const matchCat = !selectedCategory || a.category === selectedCategory;
    const search = searchQuery.toLowerCase();
    const walletName = (a.username || a.label || '').toLowerCase();
    const matchSearch = !searchQuery || a.address.toLowerCase().includes(search) || walletName.includes(search);
    return matchCat && matchSearch;
  });

  const getLatestEventForAddress = (address: string): WalletTrackerEvent | null | undefined => {
    const normalized = address.toLowerCase();
    return trackerMap[normalized]?.latestEvent || eventsMap[normalized]?.[0];
  };

  const sorted = useMemo(() => {
    const rows = [...filtered];

    rows.sort((a, b) => {
      const aAddress = a.address.toLowerCase();
      const bAddress = b.address.toLowerCase();

      let comparison = 0;
      if (sortColumn === 'wallet') {
        const aName = (a.username || a.label || a.address).toLowerCase();
        const bName = (b.username || b.label || b.address).toLowerCase();
        comparison = aName.localeCompare(bName, 'tr');
      } else if (sortColumn === 'pnl') {
        const aPnl = typeof a.pnl === 'number' ? a.pnl : Number.NEGATIVE_INFINITY;
        const bPnl = typeof b.pnl === 'number' ? b.pnl : Number.NEGATIVE_INFINITY;
        comparison = aPnl - bPnl;
      } else if (sortColumn === 'eventCount') {
        const aCount = trackerMap[aAddress]?.eventCount ?? eventsMap[aAddress]?.length ?? 0;
        const bCount = trackerMap[bAddress]?.eventCount ?? eventsMap[bAddress]?.length ?? 0;
        comparison = aCount - bCount;
      } else if (sortColumn === 'winRate') {
        const aRate = winRateMap[aAddress] ?? Number.NEGATIVE_INFINITY;
        const bRate = winRateMap[bAddress] ?? Number.NEGATIVE_INFINITY;
        comparison = aRate - bRate;
      } else {
        const aLast = toEventTimestampMs(getLatestEventForAddress(a.address)) ?? 0;
        const bLast = toEventTimestampMs(getLatestEventForAddress(b.address)) ?? 0;
        comparison = aLast - bLast;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return rows;
  }, [filtered, sortColumn, sortDirection, trackerMap, eventsMap, winRateMap]);

  useEffect(() => {
    let active = true;

    const loadWinRates = async () => {
      const withProfile = addresses.filter((address) => !!address.profileUrl);
      if (withProfile.length === 0) return;

      for (const addr of withProfile) {
        if (!active || !addr.profileUrl) break;
        const key = addr.address.toLowerCase();

        setWinRateLoadingMap((prev) => ({ ...prev, [key]: true }));
        try {
          const payload = await getProfileTrades(addr.profileUrl);
          if (!active) break;

          if (payload.loading || payload.trades.length === 0) {
            setWinRateMap((prev) => ({ ...prev, [key]: prev[key] ?? null }));
          } else {
            const won = payload.trades.filter((trade) => trade.closed_result === 'Won').length;
            const rate = payload.trades.length > 0 ? (won / payload.trades.length) * 100 : null;
            setWinRateMap((prev) => ({ ...prev, [key]: rate }));
          }
        } catch {
          if (!active) break;
          setWinRateMap((prev) => ({ ...prev, [key]: prev[key] ?? null }));
        } finally {
          if (!active) break;
          setWinRateLoadingMap((prev) => ({ ...prev, [key]: false }));
        }
      }
    };

    void loadWinRates();
    const intervalId = window.setInterval(() => {
      void loadWinRates();
    }, 60000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [addresses]);

  const toggleSort = (column: SortColumn) => {
    if (column === sortColumn) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortColumn(column);
    setSortDirection(column === 'wallet' ? 'asc' : 'desc');
  };

  const renderSortIcon = (column: SortColumn) => {
    if (sortColumn !== column) return <ArrowUpDown className="w-3 h-3" />;
    return sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />;
  };

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;

    const runSync = async () => {
      const startedAt = Date.now();

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
        const elapsedMs = Date.now() - startedAt;
        const nextDelayMs = Math.max(0, 1000 - elapsedMs);
        timeoutId = window.setTimeout(() => {
          void runSync();
        }, nextDelayMs);
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
        <div className="glass-card overflow-x-auto">
          {filtered.length === 0 && (
            <div className="p-8 text-center text-muted-foreground text-sm">
              Henüz takip edilen adres yok
            </div>
          )}
          {filtered.length > 0 && (
            <table className="w-full min-w-[760px]">
              <thead>
                <tr className="border-b border-border/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('wallet')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                      Wallet {renderSortIcon('wallet')}
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('pnl')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                      PNL {renderSortIcon('pnl')}
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('eventCount')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                      Toplam Event {renderSortIcon('eventCount')}
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('winRate')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                      Win Rate {renderSortIcon('winRate')}
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium">
                    <button type="button" onClick={() => toggleSort('lastActivity')} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
                      Son Aktivite {renderSortIcon('lastActivity')}
                    </button>
                  </th>
                  <th className="px-4 py-3 font-medium text-right">İşlemler</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((addr) => {
                  const tracker = trackerMap[addr.address.toLowerCase()];
                  const fallbackLatestEvent = eventsMap[addr.address.toLowerCase()]?.[0];
                  const latestEvent = tracker?.latestEvent || fallbackLatestEvent;

                  return (
                    <tr
                      key={addr.id}
                      className="group border-b border-border/20 last:border-b-0 hover:bg-secondary/20 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setAnalysisAddress(addr.id)}
                          className="text-left"
                        >
                          <p className="text-sm font-semibold text-foreground">
                            {addr.username || addr.label || `${addr.address.slice(0, 6)}...${addr.address.slice(-4)}`}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground truncate max-w-[300px]">{addr.address}</p>
                        </button>
                      </td>
                      <td className={`px-4 py-3 text-sm font-medium ${typeof addr.pnl === 'number' && addr.pnl < 0 ? 'text-destructive' : 'text-emerald-400'}`}>
                        {formatPnl(addr.pnl)}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground">
                        {tracker?.eventCount ?? eventsMap[addr.address.toLowerCase()]?.length ?? 0}
                      </td>
                      <td className="px-4 py-3 text-sm text-foreground">
                        {winRateLoadingMap[addr.address.toLowerCase()]
                          ? 'Yükleniyor...'
                          : (typeof winRateMap[addr.address.toLowerCase()] === 'number'
                            ? `%${(winRateMap[addr.address.toLowerCase()] as number).toFixed(2)}`
                            : '—')}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatLastActivity(latestEvent)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
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
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
