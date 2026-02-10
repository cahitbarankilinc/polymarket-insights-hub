import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TrendingUp, TrendingDown, Activity, Clock, ArrowUpRight, ArrowDownRight, Save } from 'lucide-react';
import { TrackedAddress, useDashboard } from '@/context/DashboardContext';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { getWalletEventsWithStats, type WalletTrackerEvent, type WalletTrackerStats } from '@/lib/polymarketTrackerApi';

// Mock data
const generateChartData = () => {
  const data = [];
  let value = 42000;
  for (let i = 30; i >= 0; i--) {
    value += (Math.random() - 0.48) * 1500;
    const d = new Date();
    d.setDate(d.getDate() - i);
    data.push({
      date: d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short' }),
      balance: Math.round(value * 100) / 100,
      volume: Math.round(Math.random() * 5 * 100) / 100,
    });
  }
  return data;
};

const chartData = generateChartData();

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

const normalizeMarketName = (market: string | null | undefined) => {
  if (!market) return 'Unknown market';

  const trimmed = market.trim();
  if (!trimmed) return 'Unknown market';

  // Human-readable isimlerde sondaki saat parçasını kaldır:
  // "Bitcoin Up Or Down February 10 1pm Et" -> "Bitcoin Up Or Down February 10"
  const withoutPmEtSuffix = trimmed
    .replace(/\s+\d{1,2}\s*(?:am|pm)\s+et$/i, '')
    .trim();

  // Slug formatında zaman damgası parçasını kaldır:
  // "btc-updown-15m-1770746400" -> "btc-updown-15m"
  const slugTokens = withoutPmEtSuffix.split('-').filter(Boolean);
  while (slugTokens.length > 1 && /^\d{9,13}$/.test(slugTokens[slugTokens.length - 1])) {
    slugTokens.pop();
  }

  return (slugTokens.join('-') || withoutPmEtSuffix).replace(/\s+/g, ' ').trim();
};

const normalizeMarketKey = (market: string | null | undefined) => {
  const normalizedName = normalizeMarketName(market).toLowerCase();
  return normalizedName || 'unknown-market';
};

export default function AddressAnalysis({ address, onBack }: Props) {
  const { updateAddressNote } = useDashboard();
  const isPositive = (address.pnl ?? 0) >= 0;
  const [events, setEvents] = useState<WalletTrackerEvent[]>([]);
  const [backendStats, setBackendStats] = useState<WalletTrackerStats | null>(null);
  const [noteDraft, setNoteDraft] = useState(address.note ?? '');

  useEffect(() => {
    setNoteDraft(address.note ?? '');
  }, [address.id, address.note]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const payload = await getWalletEventsWithStats(address.address);
        if (!active) return;
        setEvents(payload.events);
        setBackendStats(payload.stats ?? null);
      } catch {
        if (!active) return;
        setEvents([]);
        setBackendStats(null);
      }
    };

    load();
    const intervalId = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, [address.address]);

  const latest30 = useMemo(() => events.slice(0, 30), [events]);

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
      const label = normalizeMarketName(event.market);
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

    return Array.from(marketMap.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.buyUsd - a.buyUsd || b.totalUsd - a.totalUsd)
      .slice(0, 10);
  }, [events]);

  const handleSaveNote = () => {
    updateAddressNote(address.id, noteDraft);
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

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="glass-card p-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">Bakiye Grafiği (30 gün)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(174, 72%, 50%)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="hsl(174, 72%, 50%)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 18%)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 14%, 22%)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(210, 20%, 92%)',
                }}
              />
              <Area type="monotone" dataKey="balance" stroke="hsl(174, 72%, 50%)" fill="url(#balanceGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="glass-card p-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">İşlem Hacmi (BTC)</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(220, 14%, 18%)" />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: 'hsl(215, 12%, 50%)' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(220, 18%, 10%)',
                  border: '1px solid hsl(220, 14%, 22%)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: 'hsl(210, 20%, 92%)',
                }}
              />
              <Bar dataKey="volume" fill="hsl(155, 60%, 45%)" radius={[4, 4, 0, 0]} opacity={0.8} />
            </BarChart>
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
                <th className="py-2 pr-2 text-xs font-medium">Market</th>
                <th className="py-2 pr-2 text-xs font-medium text-right">BUY USD</th>
                <th className="py-2 pr-2 text-xs font-medium text-right">Toplam USD</th>
                <th className="py-2 text-xs font-medium text-right">İşlem</th>
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
          Not: Market adlarında sondaki zaman parçaları (örn. "1pm Et" veya "-1770746400") kaldırılarak aynı strateji marketleri tek başlıkta birleştirilir.
        </p>
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
