import { Activity } from 'lucide-react';

interface DashboardHeaderProps {
  activeTab: number;
  onTabChange: (tab: number) => void;
}

const tabs = [
  { label: 'Add Address', icon: '➕' },
  { label: 'Tracking List', icon: '📡' },
  { label: 'Paper Trade', icon: '📊' },
  { label: 'Live Trading', icon: '⚡' },
];

export default function DashboardHeader({ activeTab, onTabChange }: DashboardHeaderProps) {
  return (
    <header className="border-b border-border/50 backdrop-blur-xl bg-background/80 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center glow-border">
              <Activity className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-lg font-bold tracking-tight">
              <span className="gradient-text">Poly</span>
              <span className="text-foreground">Tracker</span>
            </h1>
          </div>

          <nav className="flex items-center gap-1">
            {tabs.map((tab, i) => (
              <button
                key={i}
                onClick={() => onTabChange(i)}
                className={`
                  px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200
                  ${activeTab === i
                    ? 'bg-primary/10 text-primary glow-border'
                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                  }
                `}
              >
                <span className="mr-1.5">{tab.icon}</span>
                <span className="hidden sm:inline">{tab.label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}
