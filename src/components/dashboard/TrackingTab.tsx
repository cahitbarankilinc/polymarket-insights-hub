import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Filter, Trash2, BarChart3, Copy, ChevronRight, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';
import AddressAnalysis from './AddressAnalysis';
import { getProfileTrades, getWalletEvents, listTrackedWallets, stopWalletTracking, type ClosedTrade, type WalletTrackerEvent, type WalletTrackerInfo } from '@/lib/polymarketTrackerApi';


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

type WinRateBucket = {
  key: string;
  label: string;
  wonCount: number;
  lostCount: number;
  total: number;
  wonRate: number;
};

const WIN_RATE_BUCKETS = [
  { key: '0-15', label: '0-15¢', min: 0, max: 15 },
  { key: '15-35', label: '15-35¢', min: 15, max: 35 },
  { key: '35-65', label: '35-65¢', min: 35, max: 65 },
  { key: '65-85', label: '65-85¢', min: 65, max: 85 },
  { key: '85-100', label: '85-100¢', min: 85, max: 100 },
] as const;

const WIN_RATE_CACHE_STORAGE_KEY = 'pm-win-rate-cache-v1';

type WinRateCachePayload = {
  winRateMap: Record<string, number | null>;
  profileTradesMap: Record<string, ClosedTrade[]>;
};

const readWinRateCache = (): WinRateCachePayload | null => {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(WIN_RATE_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WinRateCachePayload>;

    return {
      winRateMap: parsed.winRateMap && typeof parsed.winRateMap === 'object' ? parsed.winRateMap : {},
      profileTradesMap: parsed.profileTradesMap && typeof parsed.profileTradesMap === 'object' ? parsed.profileTradesMap : {},
    };
  } catch {
    return null;
  }
};

const buildWinRateBuckets = (trades: ClosedTrade[]): WinRateBucket[] => {
  const buckets = WIN_RATE_BUCKETS.map((bucket) => ({ ...bucket, wonCount: 0, lostCount: 0 }));

  for (const trade of trades) {
    const cent = Number(trade.closed_cent);
    if (!Number.isFinite(cent)) continue;
    const bounded = Math.max(0, Math.min(99.999, cent));
    const bucket = buckets.find((item) => bounded >= item.min && bounded < item.max);
    if (!bucket) continue;

    if (trade.closed_result === 'Won') {
      bucket.wonCount += 1;
    } else {
      bucket.lostCount += 1;
    }
  }

  return buckets.map((bucket) => {
    const total = bucket.wonCount + bucket.lostCount;
    const wonRate = total > 0 ? (bucket.wonCount / total) * 100 : 0;
    return {
      key: bucket.key,
      label: bucket.label,
      wonCount: bucket.wonCount,
      lostCount: bucket.lostCount,
      total,
      wonRate,
    };
  });
};

export default function TrackingTab({ onPaperTrade }: { onPaperTrade: (id: string, prefill?: PaperTradePrefill) => void }) {
  const { addresses, categories, removeAddress } = useDashboard();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [analysisAddress, setAnalysisAddress] = useState<string | null>(null);
  const [trackerMap, setTrackerMap] = useState<Record<string, WalletTrackerInfo>>({});
  const [eventsMap, setEventsMap] = useState<Record<string, WalletTrackerEvent[]>>({});
  const [sortColumn, setSortColumn] = useState<SortColumn>(DEFAULT_SORT.column);
  const [sortDirection, setSortDirection] = useState<SortDirection>(DEFAULT_SORT.direction);
  const [winRateMap, setWinRateMap] = useState<Record<string, number | null>>(() => readWinRateCache()?.winRateMap ?? {});
  const [winRateStatusMap, setWinRateStatusMap] = useState<Record<string, 'beklemede' | 'yükleniyor' | 'hata' | 'tamamlandi'>>({});
  const [profileTradesMap, setProfileTradesMap] = useState<Record<string, ClosedTrade[]>>(() => readWinRateCache()?.profileTradesMap ?? {});
  const [showWinRateList, setShowWinRateList] = useState(false);
  const [profileTradeErrorMap, setProfileTradeErrorMap] = useState<Record<string, string | null>>({});
  const activeScrapeWalletRef = useRef<string | null>(null);
  const winRateStatusRef = useRef<Record<string, 'beklemede' | 'yükleniyor' | 'hata' | 'tamamlandi'>>({});

  const refreshProfileTradesInBackground = async (profileUrl: string, key: string) => {
    try {
      const payload = await getProfileTrades(profileUrl, { forceRefresh: true, showBrowser: false });
      setProfileTradeErrorMap((prev) => ({ ...prev, [key]: payload.lastError ?? null }));
      if (payload.lastError) {
        toast.error(`Arka plan scrape hatası: ${payload.lastError}`);
        return;
      }
      toast.success('Arka planda yenileme başlatıldı.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Arka plan yenileme başlatılamadı');
    }
  };

  useEffect(() => {
    winRateStatusRef.current = winRateStatusMap;
  }, [winRateStatusMap]);

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
    if (typeof window === 'undefined') return;
    const payload: WinRateCachePayload = { winRateMap, profileTradesMap };
    window.localStorage.setItem(WIN_RATE_CACHE_STORAGE_KEY, JSON.stringify(payload));
  }, [winRateMap, profileTradesMap]);

  useEffect(() => {
    let active = true;

    const syncStatuses = (keys: string[]) => {
      const allowed = new Set(keys);
      setWinRateStatusMap((prev) => {
        const next: Record<string, 'beklemede' | 'yükleniyor' | 'hata' | 'tamamlandi'> = {};
        for (const key of keys) {
          next[key] = prev[key] ?? 'beklemede';
        }
        return next;
      });

      if (activeScrapeWalletRef.current && !allowed.has(activeScrapeWalletRef.current)) {
        activeScrapeWalletRef.current = null;
      }
    };

    const processQueue = async () => {
      const withProfile = addresses.filter((address) => !!address.profileUrl);
      if (withProfile.length === 0) return;
      const orderedKeys = withProfile.map((addr) => addr.address.toLowerCase());
      syncStatuses(orderedKeys);

      if (activeScrapeWalletRef.current === null) {
        const nextWallet = withProfile.find((addr) => {
          const key = addr.address.toLowerCase();
          const status = winRateStatusRef.current[key] ?? 'beklemede';
          return status !== 'tamamlandi' && status !== 'hata';
        });

        if (!nextWallet?.profileUrl) return;
        activeScrapeWalletRef.current = nextWallet.address.toLowerCase();
      }

      const key = activeScrapeWalletRef.current;
      if (!key) return;

      const activeWallet = withProfile.find((addr) => addr.address.toLowerCase() === key);
      if (!activeWallet?.profileUrl) {
        activeScrapeWalletRef.current = null;
        return;
      }

      setWinRateStatusMap((prev) => {
        if (prev[key] === 'yükleniyor') return prev;
        const next = { ...prev };
        for (const walletKey of orderedKeys) {
          if (!next[walletKey]) {
            next[walletKey] = 'beklemede';
          }
          if (walletKey !== key && next[walletKey] === 'yükleniyor') {
            next[walletKey] = 'beklemede';
          }
        }
        next[key] = 'yükleniyor';
        return next;
      });

      try {
        const payload = await getProfileTrades(activeWallet.profileUrl);
        if (!active) return;

        if (payload.lastError) {
          setProfileTradeErrorMap((prev) => ({ ...prev, [key]: payload.lastError ?? null }));
          setWinRateStatusMap((prev) => ({ ...prev, [key]: 'hata' }));
          activeScrapeWalletRef.current = null;
          return;
        }

        setProfileTradeErrorMap((prev) => ({ ...prev, [key]: null }));

        setProfileTradesMap((prev) => ({ ...prev, [key]: payload.trades }));

        if (payload.loading || payload.isRefreshing) {
          return;
        }

        if (payload.trades.length === 0) {
          setWinRateMap((prev) => ({ ...prev, [key]: null }));
        } else {
          const won = payload.trades.filter((trade) => trade.closed_result === 'Won').length;
          const rate = (won / payload.trades.length) * 100;
          setWinRateMap((prev) => ({ ...prev, [key]: rate }));
        }

        setWinRateStatusMap((prev) => ({ ...prev, [key]: 'tamamlandi' }));
        activeScrapeWalletRef.current = null;
      } catch {
        if (!active) return;
        setWinRateStatusMap((prev) => ({ ...prev, [key]: 'hata' }));
        activeScrapeWalletRef.current = null;
      }
    };

    void processQueue();
    const intervalId = window.setInterval(() => {
      void processQueue();
    }, 3000);

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
        <div className="mb-4 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Adres ara..."
              className="w-full pl-10 pr-4 py-2.5 rounded-lg bg-secondary/30 border border-border/30 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowWinRateList((prev) => !prev)}
            className={`px-3 py-2.5 rounded-lg text-sm font-medium border transition-all ${showWinRateList ? 'bg-primary/15 text-primary border-primary/40' : 'bg-secondary/40 text-muted-foreground border-border/40 hover:text-foreground'}`}
          >
            Win Rate Liste
          </button>
        </div>

        {!showWinRateList && (
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
                        {(() => {
                          const key = addr.address.toLowerCase();
                          const status = winRateStatusMap[key] ?? 'beklemede';
                          const cachedRate = winRateMap[key];
                          if (typeof cachedRate === 'number' && status !== 'tamamlandi') {
                            return `%${cachedRate.toFixed(2)} (${status})`;
                          }
                          if (status === 'tamamlandi') {
                            return typeof cachedRate === 'number' ? `%${cachedRate.toFixed(2)}` : 'tamamlandi';
                          }
                          return status;
                        })()}
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
        )}

        {showWinRateList && (
          <div className="space-y-3">
            {sorted.map((addr) => {
              const key = addr.address.toLowerCase();
              const buckets = buildWinRateBuckets(profileTradesMap[key] ?? []);
              const winRateValue = winRateMap[key];
              const status = winRateStatusMap[key] ?? 'beklemede';
              const profileTradeError = profileTradeErrorMap[key];

              return (
                <div key={addr.id} className="glass-card p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">{addr.username || addr.label || `${addr.address.slice(0, 6)}...${addr.address.slice(-4)}`}</p>
                      <p className="font-mono text-xs text-muted-foreground truncate">{addr.address}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => addr.profileUrl && void refreshProfileTradesInBackground(addr.profileUrl, key)}
                        disabled={!addr.profileUrl}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all bg-secondary/40 text-muted-foreground border-border/40 hover:text-foreground"
                      >
                        Arka Planda Yenile
                      </button>
                      <p className="text-sm font-semibold text-primary min-w-[95px] text-right">
                        {status === 'tamamlandi'
                          ? (typeof winRateValue === 'number' ? `tamamlandi · Win Rate: %${winRateValue.toFixed(2)}` : 'tamamlandi')
                          : (typeof winRateValue === 'number' ? `${status} · Eski Win Rate: %${winRateValue.toFixed(2)}` : status)}
                      </p>
                    </div>
                  </div>

                  {profileTradeError && (
                    <p className="text-xs text-destructive mb-3">
                      Son scraper hatası: {profileTradeError}
                    </p>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
                    {buckets.map((bucket) => {
                      const isPositive = bucket.wonRate > 50;
                      return (
                        <div key={bucket.key} className={`rounded-lg border p-2 ${isPositive ? 'bg-emerald-500/15 border-emerald-400/40' : 'bg-red-500/15 border-red-400/40'}`}>
                          <p className="text-[11px] font-semibold text-foreground mb-1">{bucket.label}</p>
                          <p className="text-xs font-bold text-foreground">%{bucket.wonRate.toFixed(1)}</p>
                          <p className="text-[11px] text-muted-foreground">Won: {bucket.wonCount}</p>
                          <p className="text-[11px] text-muted-foreground">Lost: {bucket.lostCount}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
