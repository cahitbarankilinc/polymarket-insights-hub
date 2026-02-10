import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TrendingUp, TrendingDown, Activity, Clock, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { TrackedAddress } from '@/context/DashboardContext';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { getWalletEvents, type WalletTrackerEvent } from '@/lib/polymarketTrackerApi';

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

const formatBerlin = (seenAt: string) => {
  const parsed = toDateFromSeen(seenAt);
  if (!parsed) return '-';
  return berlinDateFormat.format(parsed);
};

const formatUsd = (value: number) => `$${value.toLocaleString('tr-TR', { maximumFractionDigits: 6 })}`;

export default function AddressAnalysis({ address, onBack }: Props) {
  const totalBalance = chartData[chartData.length - 1].balance;
  const prevBalance = chartData[chartData.length - 2].balance;
  const change = ((totalBalance - prevBalance) / prevBalance) * 100;
  const isPositive = change > 0;

  const [events, setEvents] = useState<WalletTrackerEvent[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const payload = await getWalletEvents(address.address);
        if (!active) return;
        setEvents(payload);
      } catch {
        if (!active) return;
        setEvents([]);
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
    const now = Date.now();
    const last24HoursMs = 24 * 60 * 60 * 1000;

    const total = events.length;
    const last24h = events.filter((event) => {
      const seen = toDateFromSeen(event.seen_at_utc);
      if (!seen) return false;
      return now - seen.getTime() <= last24HoursMs;
    }).length;

    const last24hEvents = events.filter((event) => {
      const seen = toDateFromSeen(event.seen_at_utc);
      if (!seen) return false;
      return now - seen.getTime() <= last24HoursMs;
    });

    const incoming = last24hEvents
      .filter((event) => (event.side ?? '').toUpperCase() === 'BUY')
      .reduce((sum, event) => sum + toNumber(event.value_usd), 0);

    const outgoing = last24hEvents
      .filter((event) => (event.side ?? '').toUpperCase() === 'SELL')
      .reduce((sum, event) => sum + toNumber(event.value_usd), 0);

    return { total, last24h, incoming, outgoing };
  }, [events]);

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
              <h2 className="text-lg font-bold text-foreground">{address.label || 'Anonim Adres'}</h2>
              <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20">
                {address.category}
              </span>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{address.address}</p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-foreground">${totalBalance.toLocaleString()}</p>
            <p className={`text-sm font-medium flex items-center justify-end gap-1 ${isPositive ? 'text-accent' : 'text-destructive'}`}>
              {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
              {isPositive ? '+' : ''}{change.toFixed(2)}%
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        {[
          { label: 'Toplam İşlem', value: String(stats.total), icon: Activity },
          { label: 'Son 24s', value: String(stats.last24h), icon: Clock },
          { label: 'BUY Today', value: formatUsd(stats.incoming), icon: ArrowDownRight, color: 'text-accent' },
          { label: 'SELL Today', value: formatUsd(stats.outgoing), icon: ArrowUpRight, color: 'text-warning' },
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
