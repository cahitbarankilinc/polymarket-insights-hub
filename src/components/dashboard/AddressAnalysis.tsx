import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TrendingUp, TrendingDown, Activity, Clock, ArrowUpRight, ArrowDownRight, Save, Bot } from 'lucide-react';
import { TrackedAddress, useDashboard } from '@/context/DashboardContext';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell, LabelList } from 'recharts';
import { getProfileTrades, getWalletEventsWithStats, requestCopytradeAdvisor, type ClosedTrade, type WalletTrackerEvent, type WalletTrackerStats } from '@/lib/polymarketTrackerApi';

interface Props {
  address: TrackedAddress;
  onBack: () => void;
}

const berlinDateFormat = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const toDateFromSeen = (seenAt: string) => {
  const parsed = new Date(seenAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const toTimestampMs = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      return numeric > 1e12 ? numeric : numeric * 1000;
    }

    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
};

const formatBerlin = (seenAt: string) => {
  const parsed = toDateFromSeen(seenAt);
  if (!parsed) return '-';
  return berlinDateFormat.format(parsed);
};

const toEventDate = (event: WalletTrackerEvent) => {
  const eventTimeMs = toTimestampMs(event.event_time) ?? toTimestampMs(event.seen_at_utc);
  if (eventTimeMs === null) return null;
  return new Date(eventTimeMs);
};

const formatUsd = (value: number) => `$${value.toLocaleString('tr-TR', { maximumFractionDigits: 6 })}`;

const formatCurrency = (value: number | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return value.toLocaleString('tr-TR', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
};

const formatDecimal = (value: number | undefined) => {
  if (typeof value !== 'number' || Number.isNaN(value)) return '-';
  return value.toLocaleString('tr-TR', { maximumFractionDigits: 2 });
};

const stripEtTimeSuffix = (value: string) => {
  const compact = value.trim();
  if (!compact) return compact;

  const tokens = compact.split(/[\s-]+/).filter(Boolean);
  const meridiemIndex = tokens.findIndex((token) => /^\d{1,2}(?::\d{2})?(?:am|pm)$/i.test(token));
  if (meridiemIndex === -1) return compact;

  return tokens.slice(0, meridiemIndex).join(' ');
};

const stripTimestampSuffix = (value: string) => {
  const tokens = value.split(/[\s-]+/).filter(Boolean);
  while (tokens.length > 1 && /^\d{9,13}$/.test(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ') || value;
};

const toReadableMarketLabel = (value: string) => value.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

const normalizeMarketKey = (market: string | null | undefined) => {
  if (!market) return 'unknown-market';

  const clean = market.trim().toLowerCase();
  if (!clean) return 'unknown-market';

  const withoutEtTime = stripEtTimeSuffix(clean);
  const withoutTimestamp = stripTimestampSuffix(withoutEtTime);
  const normalized = withoutTimestamp || withoutEtTime || clean;

  return normalized.replace(/[\s_]+/g, '-').replace(/-+/g, '-').trim() || clean;
};

const normalizeMarketLabel = (market: string | null | undefined) => {
  if (!market) return 'Unknown market';
  const clean = market.trim();
  if (!clean) return 'Unknown market';

  const withoutEtTime = stripEtTimeSuffix(clean);
  const withoutTimestamp = stripTimestampSuffix(withoutEtTime);
  const readable = toReadableMarketLabel(withoutTimestamp || withoutEtTime || clean);

  return readable || 'Unknown market';
};

type SortColumn = 'label' | 'buyUsd' | 'totalUsd' | 'tradeCount';
type SortDirection = 'asc' | 'desc';

const MAX_EVENTS_FOR_CHART = 100;
const PROFILE_TRADES_REFRESH_MS = 60 * 60 * 1000;

const resolvePriceBucketSize = (buyEventCount: number) => {
  if (buyEventCount > 10000) return 0.02;
  if (buyEventCount > 4000) return 0.01;
  if (buyEventCount > 1500) return 0.005;
  return 0.0025;
};


export default function AddressAnalysis({ address, onBack }: Props) {
  const { updateAddressNote } = useDashboard();
  const isPositive = (address.pnl ?? 0) >= 0;
  const [events, setEvents] = useState<WalletTrackerEvent[]>([]);
  const [backendStats, setBackendStats] = useState<WalletTrackerStats | null>(null);
  const [noteDraft, setNoteDraft] = useState(address.note ?? '');
  const [sortColumn, setSortColumn] = useState<SortColumn>('buyUsd');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [advisorLoading, setAdvisorLoading] = useState(false);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [advisorResult, setAdvisorResult] = useState<string | null>(null);
  const [advisorUpdatedAt, setAdvisorUpdatedAt] = useState<string | null>(null);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[]>([]);
  const [closedTradesLoading, setClosedTradesLoading] = useState(false);

  const advisorStorageKey = useMemo(() => `copytrade-advisor:${address.address.toLowerCase()}`, [address.address]);

  useEffect(() => {
    setNoteDraft(address.note ?? '');
  }, [address.id, address.note]);

  useEffect(() => {
    const raw = localStorage.getItem(advisorStorageKey);
    if (!raw) {
      setAdvisorResult(null);
      setAdvisorUpdatedAt(null);
      setAdvisorError(null);
      return;
    }

    try {
      const parsed = JSON.parse(raw) as { result?: string; updatedAt?: string };
      setAdvisorResult(parsed.result ?? null);
      setAdvisorUpdatedAt(parsed.updatedAt ?? null);
      setAdvisorError(null);
    } catch {
      setAdvisorResult(null);
      setAdvisorUpdatedAt(null);
      setAdvisorError(null);
    }
  }, [advisorStorageKey]);

  useEffect(() => {
    let active = true;
    let timeoutId: number | undefined;

    const load = async () => {
      const startedAt = Date.now();

      try {
        const payload = await getWalletEventsWithStats(address.address);
        if (!active) return;
        setEvents(payload.events);
        setBackendStats(payload.stats ?? null);
      } catch {
        if (!active) return;
        setEvents([]);
        setBackendStats(null);
      } finally {
        if (!active) return;
        const elapsedMs = Date.now() - startedAt;
        const nextDelayMs = Math.max(0, 1000 - elapsedMs);
        timeoutId = window.setTimeout(() => {
          void load();
        }, nextDelayMs);
      }
    };

    void load();
    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [address.address]);

  useEffect(() => {
    if (!address.profileUrl) {
      setClosedTrades([]);
      setClosedTradesLoading(false);
      return;
    }

    let active = true;
    let timeoutId: number | undefined;

    const load = async () => {
      let nextDelay = PROFILE_TRADES_REFRESH_MS;
      try {
        setClosedTradesLoading(true);
        const payload = await getProfileTrades(address.profileUrl as string);
        if (!active) return;
        if (Array.isArray(payload.trades) && payload.trades.length > 0) {
          setClosedTrades(payload.trades);
        }
        setClosedTradesLoading(payload.loading || payload.isRefreshing);
        nextDelay = (payload.loading || payload.isRefreshing) ? 7000 : PROFILE_TRADES_REFRESH_MS;
      } catch {
        if (!active) return;
        setClosedTradesLoading(false);
        nextDelay = 15000;
      } finally {
        if (!active) return;
        timeoutId = window.setTimeout(() => {
          void load();
        }, nextDelay);
      }
    };

    void load();
    return () => {
      active = false;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [address.profileUrl]);

  const latest30 = useMemo(() => [...events]
    .sort((a, b) => {
      const bTs = toTimestampMs(b.event_time) ?? toTimestampMs(b.seen_at_utc) ?? 0;
      const aTs = toTimestampMs(a.event_time) ?? toTimestampMs(a.seen_at_utc) ?? 0;
      return bTs - aTs;
    })
    .slice(0, 30), [events]);

  const { buyPriceShareData, buyPriceUsdData } = useMemo(() => {
    const limitedEvents = [...events]
      .sort((a, b) => (toTimestampMs(b.event_time) ?? toTimestampMs(b.seen_at_utc) ?? 0) - (toTimestampMs(a.event_time) ?? toTimestampMs(a.seen_at_utc) ?? 0))
      .slice(0, MAX_EVENTS_FOR_CHART);
    const buyEventCount = limitedEvents.reduce((count, event) => count + (((event.side ?? '').toUpperCase() === 'BUY') ? 1 : 0), 0);
    const bucketSize = resolvePriceBucketSize(buyEventCount);

    const grouped = new Map<number, { share: number; usdSpent: number }>();

    for (const event of limitedEvents) {
      const side = (event.side ?? '').toUpperCase();
      if (side !== 'BUY') continue;

      const price = toNumber(event.price);
      const share = toNumber(event.size);
      const usdSpent = toNumber(event.value_usd);

      if (!Number.isFinite(price) || price < 0 || price > 1) continue;

      const bucketedPrice = Number((Math.round(price / bucketSize) * bucketSize).toFixed(4));
      const row = grouped.get(bucketedPrice) ?? { share: 0, usdSpent: 0 };

      if (Number.isFinite(share) && share > 0) row.share += share;
      if (Number.isFinite(usdSpent) && usdSpent > 0) row.usdSpent += usdSpent;

      grouped.set(bucketedPrice, row);
    }

    const sorted = Array.from(grouped.entries())
      .map(([price, values]) => ({ price, ...values }))
      .sort((a, b) => a.price - b.price);

    return {
      buyPriceShareData: sorted.map(({ price, share }) => ({ price, share })),
      buyPriceUsdData: sorted.map(({ price, usdSpent }) => ({ price, usdSpent })),
    };
  }, [events]);

  const closedTradeAnalytics = useMemo(() => {
    const total = closedTrades.length;
    const wonCount = closedTrades.filter((trade) => trade.closed_result === 'Won').length;
    const winRate = total > 0 ? (wonCount / total) * 100 : 0;

    const bins = Array.from({ length: 20 }, (_, i) => {
      const from = i * 5;
      const to = from + 5;
      return {
        key: `${from}-${to}`,
        label: `${from}-${to}¢`,
        wonPnl: 0,
        lostPnl: 0,
        wonCount: 0,
        lostCount: 0,
      };
    });

    for (const trade of closedTrades) {
      const cent = Number(trade.closed_cent);
      const pnl = Number(trade.closed_pnl);
      if (!Number.isFinite(cent) || !Number.isFinite(pnl)) continue;
      const bounded = Math.min(99.999, Math.max(0, cent));
      const index = Math.floor(bounded / 5);
      const target = bins[index];
      if (!target) continue;

      if (trade.closed_result === 'Won') {
        target.wonPnl += pnl;
        target.wonCount += 1;
      } else {
        target.lostPnl += pnl;
        target.lostCount += 1;
      }
    }

    return {
      total,
      wonCount,
      winRate,
      bins: bins.map((bin) => {
        const absWon = Math.abs(bin.wonPnl);
        const absLost = Math.abs(bin.lostPnl);
        const absTotal = absWon + absLost;
        const wonPct = absTotal > 0 ? (absWon / absTotal) * 100 : 0;
        const lostPct = absTotal > 0 ? (absLost / absTotal) * 100 : 0;
        const totalCount = bin.wonCount + bin.lostCount;
        const wonLabel = absWon > 0 ? `${wonPct.toFixed(0)}%` : '';
        const lostLabel = absLost > 0 ? `${lostPct.toFixed(0)}%` : '';
        return {
          ...bin,
          totalCount,
          wonPct,
          lostPct,
          wonLabel,
          lostLabel,
          wonPnlAbs: absWon,
          lostPnlAbs: absLost,
        };
      }),
    };
  }, [closedTrades]);

  const stats = useMemo(() => {
    if (backendStats) {
      return {
        total: backendStats.total,
        last24h: backendStats.last24h,
        buyTodayUsd: backendStats.buyTodayUsd,
        sellTodayUsd: backendStats.sellTodayUsd,
      };
    }

    const now = Date.now();
    const last24HoursMs = 24 * 60 * 60 * 1000;

    const total = events.length;
    let last24h = 0;
    let buyTodayUsd = 0;
    let sellTodayUsd = 0;

    for (const event of events) {
      const eventDate = toEventDate(event);
      if (!eventDate || now - eventDate.getTime() > last24HoursMs) continue;

      last24h += 1;
      const side = (event.side ?? '').toUpperCase();
      if (side === 'BUY') buyTodayUsd += toNumber(event.value_usd);
      if (side === 'SELL') sellTodayUsd += toNumber(event.value_usd);
    }

    return { total, last24h, buyTodayUsd, sellTodayUsd };
  }, [backendStats, events]);

  const topMarketSpend = useMemo(() => {
    const marketMap = new Map<string, { label: string; buyUsd: number; totalUsd: number; tradeCount: number }>();

    for (const event of events) {
      const key = normalizeMarketKey(event.market);
      const label = normalizeMarketLabel(event.market);
      const side = (event.side ?? '').toUpperCase();
      const usdValue = toNumber(event.value_usd);
      const row = marketMap.get(key) ?? { label, buyUsd: 0, totalUsd: 0, tradeCount: 0 };

      row.tradeCount += 1;
      row.totalUsd += usdValue;
      if (side === 'BUY') {
        row.buyUsd += usdValue;
      }

      marketMap.set(key, row);
    }

    const aggregated = Array.from(marketMap.entries()).map(([key, value]) => ({ key, ...value }));

    const sorted = aggregated.sort((a, b) => {
      const multiplier = sortDirection === 'asc' ? 1 : -1;

      if (sortColumn === 'label') {
        const byLabel = a.label.localeCompare(b.label, 'tr');
        if (byLabel !== 0) return byLabel * multiplier;
      }

      if (sortColumn === 'buyUsd') {
        const byBuyUsd = a.buyUsd - b.buyUsd;
        if (byBuyUsd !== 0) return byBuyUsd * multiplier;
      }

      if (sortColumn === 'totalUsd') {
        const byTotalUsd = a.totalUsd - b.totalUsd;
        if (byTotalUsd !== 0) return byTotalUsd * multiplier;
      }

      if (sortColumn === 'tradeCount') {
        const byTradeCount = a.tradeCount - b.tradeCount;
        if (byTradeCount !== 0) return byTradeCount * multiplier;
      }

      return (b.buyUsd - a.buyUsd) || (b.totalUsd - a.totalUsd);
    });

    return sorted.slice(0, 10);
  }, [events, sortColumn, sortDirection]);

  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortColumn(column);
    setSortDirection(column === 'label' ? 'asc' : 'desc');
  };

  const sortIndicator = (column: SortColumn) => {
    if (sortColumn !== column) return '↕';
    return sortDirection === 'asc' ? '↑' : '↓';
  };

  const handleSaveNote = () => {
    updateAddressNote(address.id, noteDraft);
  };

  const advisorContext = useMemo(() => JSON.stringify({
    generatedAt: new Date().toISOString(),
    wallet: {
      username: address.username,
      label: address.label,
      category: address.category,
      address: address.address,
      pnl: address.pnl,
      volume: address.volume,
      winRate: address.winRate,
      totalTrades: address.totalTrades,
      note: noteDraft,
    },
    stats,
    topMarketSpend,
    latestActivities: latest30,
  }, null, 2), [address.address, address.category, address.label, address.pnl, address.totalTrades, address.username, address.volume, address.winRate, latest30, noteDraft, stats, topMarketSpend]);

  const runAdvisor = async () => {
    setAdvisorLoading(true);
    setAdvisorError(null);

    try {
      const response = await requestCopytradeAdvisor(advisorContext);
      const updatedAt = new Date().toISOString();
      setAdvisorResult(response.analysis);
      setAdvisorUpdatedAt(updatedAt);
      localStorage.setItem(advisorStorageKey, JSON.stringify({ result: response.analysis, updatedAt }));
    } catch (error) {
      setAdvisorError(error instanceof Error ? error.message : 'OpenAI analizi alınamadı');
    } finally {
      setAdvisorLoading(false);
    }
  };

  return (
    <div className="animate-slide-up">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Takip Listesine Dön
      </button>

      {/* Header */}
      <div className="glass-card p-5 mb-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-lg font-bold text-foreground">{address.username || address.label || 'Anonim Adres'}</h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                {address.category}
              </span>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{address.address}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-foreground">{formatCurrency(address.pnl)}</p>
            <p className={`text-sm font-medium flex items-center justify-end gap-1 ${isPositive ? 'text-accent' : 'text-destructive'}`}>
              {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              PnL
            </p>
          </div>
        </div>
      </div>

      <div className="glass-card p-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-foreground">Cüzdan Notu</h3>
          <button
            onClick={handleSaveNote}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 transition-all"
          >
            <Save className="w-3.5 h-3.5" /> Kaydet
          </button>
        </div>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="Bu wallet için gözlemlerini not al..."
          rows={3}
          className="w-full px-3 py-2 rounded-lg bg-secondary/40 border border-border/40 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/40 resize-y"
        />
      </div>

      {/* Profile Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
        {[
          { label: 'Serbest Para', value: address.polygonscanTopTotalValText || '-' },
          { label: 'Oyundaki Para', value: formatCurrency(address.amount) },
          { label: 'Toplam Oyun', value: formatDecimal(address.trades) },
          { label: 'Biggest Win', value: formatCurrency(address.largestWin) },
          { label: 'Followers', value: formatDecimal(address.views) },
          { label: 'PnL', value: formatCurrency(address.pnl) },
        ].map((stat, i) => (
          <div key={i} className="stat-card">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{stat.label}</span>
            </div>
            <p className="text-lg font-bold text-foreground">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Toplam İşlem', value: String(stats.total), icon: Activity },
          { label: 'Win Rate', value: `%${closedTradeAnalytics.winRate.toFixed(2)}`, icon: TrendingUp, color: 'text-primary' },
          { label: 'Son 24s', value: String(stats.last24h), icon: Clock },
          { label: 'BUY Today', value: formatUsd(stats.buyTodayUsd), icon: ArrowDownRight, color: 'text-accent' },
          { label: 'SELL Today', value: formatUsd(stats.sellTodayUsd), icon: ArrowUpRight, color: 'text-warning' },
        ].map((stat, i) => (
          <div key={i} className="stat-card">
            <div className="flex items-center gap-2 mb-2">
              <stat.icon className={`w-3.5 h-3.5 ${stat.color || 'text-primary'}`} />
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">{stat.label}</span>
            </div>
            <p className="text-lg font-bold text-foreground">{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="glass-card p-4 mb-4">
        <h3 className="text-sm font-semibold text-foreground">Stacked Bar Chart</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Y ekseni dolar değerini, X ekseni 5 cent aralıklı 20 grubu gösterir.
        </p>
        {closedTradesLoading && (
          <p className="text-xs text-primary mb-3">Yükleniyor... scrape tamamlanınca grafik otomatik güncellenecek.</p>
        )}
        <ResponsiveContainer width="100%" height={340}>
          <BarChart
            data={closedTradeAnalytics.bins}
            margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
            barGap={0}
            barCategoryGap="28%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 18%)" />
            <XAxis
              type="category"
              dataKey="label"
              tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }}
              axisLine={false}
              tickLine={false}
              interval={1}
            />
            <YAxis
              type="number"
              tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => formatUsd(Math.abs(Number(value)))}
            />
            <Tooltip
              formatter={(value: number, name: string, item) => {
                const payload = item.payload as { wonPct: number; lostPct: number; wonCount: number; lostCount: number; totalCount: number };
                const isWon = name === 'Won PnL';
                const pct = isWon ? payload.wonPct : payload.lostPct;
                const count = isWon ? payload.wonCount : payload.lostCount;
                return [`${formatUsd(Math.abs(Number(value)))} (${pct.toFixed(2)}%) • Adet: ${count} / Toplam: ${payload.totalCount}`, name];
              }}
              contentStyle={{
                backgroundColor: 'hsl(220, 18%, 10%)',
                border: '1px solid hsl(220, 14%, 22%)',
                borderRadius: '8px',
                fontSize: '12px',
                color: 'hsl(210, 20%, 92%)',
              }}
              labelStyle={{ color: 'hsl(210, 20%, 92%)' }}
              itemStyle={{ color: 'hsl(210, 20%, 92%)' }}
            />
            <Bar dataKey="lostPnlAbs" name="Lost PnL">
              {closedTradeAnalytics.bins.map((entry) => (
                <Cell key={`${entry.key}-lost`} fill="hsl(0, 72%, 52%)" />
              ))}
              <LabelList dataKey="lostLabel" position="top" fill="white" fontSize={11} fontWeight={700} />
            </Bar>
            <Bar dataKey="wonPnlAbs" name="Won PnL">
              {closedTradeAnalytics.bins.map((entry) => (
                <Cell key={`${entry.key}-won`} fill="hsl(155, 60%, 45%)" />
              ))}
              <LabelList dataKey="wonLabel" position="top" fill="white" fontSize={11} fontWeight={700} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="glass-card p-4">
          <h3 className="text-sm font-semibold text-foreground">Share/Adet Grafiği</h3>
          <p className="text-xs text-muted-foreground mb-3">Sadece son 100 trade buy verisi görselleştirilir; bu yüzden grafik daha okunaklı kalır.</p>
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 18%)" />
              <XAxis
                type="number"
                dataKey="price"
                name="Price"
                domain={[0, 1]}
                tickCount={11}
                tickFormatter={(value) => Number(value).toFixed(2)}
                tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="number"
                dataKey="share"
                name="Share"
                tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }}
                axisLine={false}
                tickLine={false}
                domain={[0, 'auto']}
              />
              <Tooltip
                formatter={(value, name) => {
                  if (name === 'Price') {
                    return [Number(value).toLocaleString('tr-TR', { maximumFractionDigits: 2 }), 'Price'];
                  }

                  return [Number(value).toLocaleString('tr-TR', { maximumFractionDigits: 6 }), 'Share'];
                }}
                labelFormatter={() => 'BUY'}
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 14%, 22%)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(210, 20%, 92%)',
                }}
                labelStyle={{ color: 'hsl(210, 20%, 92%)' }}
                itemStyle={{ color: 'hsl(210, 20%, 92%)' }}
              />
              <Scatter
                data={buyPriceShareData}
                fill="hsl(174, 72%, 50%)"
                line={{ stroke: 'hsl(174, 72%, 50%)', strokeWidth: 1.5 }}
                lineType="joint"
                isAnimationActive={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card p-4">
          <h3 className="text-sm font-semibold text-foreground">Price/Adet Grafiği</h3>
          <p className="text-xs text-muted-foreground mb-3">USD dağılımı grafiği de yalnızca son 100 trade buy verisini kullanır.</p>
          <ResponsiveContainer width="100%" height={220}>
            <ScatterChart margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 18%)" />
              <XAxis
                type="number"
                dataKey="price"
                name="Price"
                domain={[0, 1]}
                tickCount={11}
                tickFormatter={(value) => Number(value).toFixed(2)}
                tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                type="number"
                dataKey="usdSpent"
                name="USD"
                tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }}
                axisLine={false}
                tickLine={false}
                domain={[0, 'auto']}
              />
              <Tooltip
                formatter={(value, name) => {
                  if (name === 'Price') {
                    return [Number(value).toLocaleString('tr-TR', { maximumFractionDigits: 2 }), 'Price'];
                  }

                  return [formatUsd(Number(value)), 'Harcanan USD'];
                }}
                labelFormatter={() => 'BUY'}
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 14%, 22%)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(210, 20%, 92%)',
                }}
                labelStyle={{ color: 'hsl(210, 20%, 92%)' }}
                itemStyle={{ color: 'hsl(210, 20%, 92%)' }}
              />
              <Scatter
                data={buyPriceUsdData}
                fill="hsl(155, 60%, 45%)"
                line={{ stroke: 'hsl(155, 60%, 45%)', strokeWidth: 1.5 }}
                lineType="joint"
                isAnimationActive={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="glass-card p-4 mb-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">En Çok Harcama Yapılan İlk 10 Market</h3>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border/40">
                <th className="py-2 pr-2 text-xs font-medium">#</th>
                <th className="py-2 pr-2 text-xs font-medium">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => handleSort('label')}>
                    Market <span className="text-[10px]">{sortIndicator('label')}</span>
                  </button>
                </th>
                <th className="py-2 pr-2 text-xs font-medium text-right">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => handleSort('buyUsd')}>
                    BUY USD <span className="text-[10px]">{sortIndicator('buyUsd')}</span>
                  </button>
                </th>
                <th className="py-2 pr-2 text-xs font-medium text-right">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => handleSort('totalUsd')}>
                    Toplam USD <span className="text-[10px]">{sortIndicator('totalUsd')}</span>
                  </button>
                </th>
                <th className="py-2 text-xs font-medium text-right">
                  <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => handleSort('tradeCount')}>
                    İşlem <span className="text-[10px]">{sortIndicator('tradeCount')}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {topMarketSpend.map((market, index) => (
                <tr key={market.key} className="border-b border-border/20 last:border-0">
                  <td className="py-2 pr-2 text-muted-foreground">{index + 1}</td>
                  <td className="py-2 pr-2 text-foreground">{market.label}</td>
                  <td className="py-2 pr-2 text-right font-medium text-accent">{formatUsd(market.buyUsd)}</td>
                  <td className="py-2 pr-2 text-right text-foreground">{formatUsd(market.totalUsd)}</td>
                  <td className="py-2 text-right text-foreground">{market.tradeCount}</td>
                </tr>
              ))}
              {topMarketSpend.length === 0 && (
                <tr>
                  <td className="py-4 text-center text-muted-foreground" colSpan={5}>Henüz market bazlı işlem verisi yok</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Not: Market adlarının sonundaki zaman damgası parçaları (örn. -1770746400) ve saat eki (örn. 1pm Et) normalize edilerek aynı strateji marketinde birleştirildi.
        </p>
      </div>

      <div className="glass-card p-4 mb-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Bot className="w-4 h-4" /> OpenAI ChatGPT Analizi</h3>
            <p className="text-xs text-muted-foreground">Mevcut wallet sayfası verileri context olarak gönderilir.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 text-xs rounded bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 disabled:opacity-60"
              onClick={runAdvisor}
              disabled={advisorLoading}
            >
              {advisorLoading ? 'Gönderiliyor...' : 'OpenAI ile Analiz Et'}
            </button>
            <button
              type="button"
              className="px-3 py-1.5 text-xs rounded bg-secondary/40 text-foreground border border-border/60 hover:bg-secondary/60 disabled:opacity-60"
              onClick={runAdvisor}
              disabled={advisorLoading}
            >
              Tekrar
            </button>
          </div>
        </div>

        {advisorUpdatedAt && (
          <p className="text-[11px] text-muted-foreground mb-2">Son analiz: {formatBerlin(advisorUpdatedAt)}</p>
        )}
        {advisorError && <p className="text-xs text-destructive mb-2">{advisorError}</p>}
        <div className="rounded-md border border-border/60 bg-background/40 p-3 min-h-[84px]">
          {advisorResult ? (
            <p className="text-sm text-foreground whitespace-pre-wrap">{advisorResult}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Henüz analiz yok. Butona basınca güncel context ile otomatik gönderilir.</p>
          )}
        </div>
      </div>

      {/* Activity */}
      <div className="glass-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-3">Son Aktiviteler</h3>
        <div className="space-y-2">
          {latest30.map((event, i) => {
            const side = (event.side ?? '').toUpperCase();
            const isBuy = side === 'BUY';
            const isSell = side === 'SELL';

            return (
              <div key={`${event.tx_hash ?? i}-${event.seen_at_utc}-${i}`} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                    isBuy ? 'bg-accent/10' : isSell ? 'bg-warning/10' : 'bg-secondary/30'
                  }`}>
                    {isBuy
                      ? <ArrowDownRight className="w-4 h-4 text-accent" />
                      : <ArrowUpRight className={`w-4 h-4 ${isSell ? 'text-warning' : 'text-muted-foreground'}`} />
                    }
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {event.market ?? '-'}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground">{event.outcome ?? '-'}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`text-sm font-semibold ${isBuy ? 'text-accent' : isSell ? 'text-warning' : 'text-foreground'}`}>
                    Price: {toNumber(event.price).toLocaleString('tr-TR', { maximumFractionDigits: 6 })} •
                    {' '}Share: {toNumber(event.size).toLocaleString('tr-TR', { maximumFractionDigits: 6 })} •
                    {' '}USD: {toNumber(event.value_usd).toLocaleString('tr-TR', { maximumFractionDigits: 6 })}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{formatBerlin(event.seen_at_utc)}</p>
                </div>
              </div>
            );
          })}
          {latest30.length === 0 && (
            <div className="py-4 text-sm text-muted-foreground text-center">Henüz takip verisi yok</div>
          )}
        </div>
      </div>
    </div>
  );
}
