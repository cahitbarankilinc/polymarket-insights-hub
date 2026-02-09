import { ArrowLeft, TrendingUp, TrendingDown, Activity, Clock, Wallet, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { TrackedAddress } from '@/context/DashboardContext';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';

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

const mockActivities = [
  { type: 'in', amount: 2.45, time: '2 saat önce', hash: '0x3f2a...8b1c' },
  { type: 'out', amount: 0.12, time: '5 saat önce', hash: '0x7d1e...4a2f' },
  { type: 'in', amount: 5.80, time: '1 gün önce', hash: '0xab34...9e7d' },
  { type: 'out', amount: 1.23, time: '2 gün önce', hash: '0xc8f2...3b5a' },
  { type: 'in', amount: 0.55, time: '3 gün önce', hash: '0x1e9a...6c4f' },
  { type: 'out', amount: 3.10, time: '4 gün önce', hash: '0xd4b7...2e8c' },
];

const chartData = generateChartData();

interface Props {
  address: TrackedAddress;
  onBack: () => void;
}

export default function AddressAnalysis({ address, onBack }: Props) {
  const totalBalance = chartData[chartData.length - 1].balance;
  const prevBalance = chartData[chartData.length - 2].balance;
  const change = ((totalBalance - prevBalance) / prevBalance) * 100;
  const isPositive = change > 0;

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
          { label: 'Toplam İşlem', value: '247', icon: Activity },
          { label: 'Son 24s', value: '12', icon: Clock },
          { label: 'Gelen', value: '₿ 45.2', icon: ArrowDownRight, color: 'text-accent' },
          { label: 'Giden', value: '₿ 38.7', icon: ArrowUpRight, color: 'text-warning' },
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
          {mockActivities.map((act, i) => (
            <div key={i} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                  act.type === 'in' ? 'bg-accent/10' : 'bg-warning/10'
                }`}>
                  {act.type === 'in'
                    ? <ArrowDownRight className="w-4 h-4 text-accent" />
                    : <ArrowUpRight className="w-4 h-4 text-warning" />
                  }
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {act.type === 'in' ? 'Gelen' : 'Giden'} Transfer
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground">{act.hash}</p>
                </div>
              </div>
              <div className="text-right">
                <p className={`text-sm font-semibold ${act.type === 'in' ? 'text-accent' : 'text-warning'}`}>
                  {act.type === 'in' ? '+' : '-'}{act.amount} BTC
                </p>
                <p className="text-[10px] text-muted-foreground">{act.time}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
