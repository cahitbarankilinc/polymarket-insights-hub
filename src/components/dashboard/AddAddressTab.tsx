import { useState } from 'react';
import { Plus, Link as LinkIcon, Tag, Check } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';
import { resolvePolymarketProfile, startWalletTracking } from '@/lib/polymarketTrackerApi';

export default function AddAddressTab() {
  const { categories, addAddress, addCategory } = useDashboard();
  const [profileUrl, setProfileUrl] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [note, setNote] = useState('');
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isProbablyUrl = (value: string) => /^https?:\/\/.+/i.test(value.trim());

  const handleSubmit = async () => {
    if (!profileUrl.trim()) {
      toast.error('Please enter a Polymarket profile URL');
      return;
    }
    if (!isProbablyUrl(profileUrl)) {
      toast.error('Please enter a valid profile URL (https://...)');
      return;
    }

    const cat = isAddingCategory ? newCategory.trim() : selectedCategory;
    if (!cat) {
      toast.error('Please select or add a category');
      return;
    }

    setIsSubmitting(true);
    try {
      const resolvedProfile = await resolvePolymarketProfile(profileUrl.trim());
      const normalizedAddress = resolvedProfile.proxyWallet?.trim().toLowerCase();

      if (!normalizedAddress || !/^0x[a-fA-F0-9]{40}$/.test(normalizedAddress)) {
        toast.error('Could not resolve a valid proxy wallet address from this URL');
        return;
      }

      if (isAddingCategory && newCategory.trim()) {
        addCategory(newCategory.trim());
      }

      addAddress(normalizedAddress, cat, {
        note: note.trim() || undefined,
        profileUrl: profileUrl.trim(),
        username: resolvedProfile.username ?? undefined,
        trades: typeof resolvedProfile.trades === 'number' ? resolvedProfile.trades : undefined,
        largestWin: typeof resolvedProfile.largestWin === 'number' ? resolvedProfile.largestWin : undefined,
        views: typeof resolvedProfile.views === 'number' ? resolvedProfile.views : undefined,
        amount: typeof resolvedProfile.amount === 'number' ? resolvedProfile.amount : undefined,
        pnl: typeof resolvedProfile.pnl === 'number' ? resolvedProfile.pnl : undefined,
        polygonscanTopTotalValText: resolvedProfile.polygonscanTopTotalValText ?? null,
      });

      try {
        await startWalletTracking(normalizedAddress);
      } catch {
        toast.error('Address added, but local tracking could not be started');
      }

      setProfileUrl('');
      setSelectedCategory('');
      setNewCategory('');
      setNote('');
      setIsAddingCategory(false);
      toast.success('Profile added successfully!');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to fetch profile data');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto animate-slide-up">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">
          <span className="gradient-text">New Address</span> Start Tracking
        </h2>
        <p className="text-muted-foreground text-sm">Add a Polymarket profile URL and start NDJSON tracking locally using the proxy wallet</p>
      </div>

      <div className="glass-card p-6 space-y-6">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LinkIcon className="w-4 h-4 text-primary" />
            Polymarket Profile URL
          </label>
          <input
            type="text"
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="https://polymarket.com/@username?tab=activity"
            className="w-full px-4 py-3 rounded-lg bg-secondary/50 border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 text-sm transition-all"
          />
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Tag className="w-4 h-4 text-primary" />
            Category <span className="text-destructive">*</span>
          </label>

          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => {
                  setSelectedCategory(cat);
                  setIsAddingCategory(false);
                }}
                className={`
                  px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200
                  ${selectedCategory === cat && !isAddingCategory
                    ? 'bg-primary/20 text-primary border border-primary/40'
                    : 'bg-secondary/50 text-muted-foreground border border-border/30 hover:border-primary/20 hover:text-foreground'
                  }
                `}
              >
                {selectedCategory === cat && !isAddingCategory && <Check className="w-3 h-3 inline mr-1" />}
                {cat}
              </button>
            ))}
            <button
              onClick={() => {
                setIsAddingCategory(true);
                setSelectedCategory('');
              }}
              className={`
                px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 flex items-center gap-1
                ${isAddingCategory
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-secondary/30 text-muted-foreground border border-dashed border-border/50 hover:border-primary/30'
                }
              `}
            >
              <Plus className="w-3 h-3" /> New Category
            </button>
          </div>

          {isAddingCategory && (
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="New category name..."
              autoFocus
              className="w-full px-4 py-3 rounded-lg bg-secondary/50 border border-accent/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 text-sm transition-all animate-fade-in"
            />
          )}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            Wallet Note <span className="text-muted-foreground text-xs">(Optional)</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Add short notes about this wallet..."
            rows={3}
            className="w-full px-4 py-3 rounded-lg bg-secondary/50 border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 text-sm transition-all resize-y"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={isSubmitting}
          className="w-full py-3 rounded-lg font-semibold text-sm transition-all duration-300 bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 hover:shadow-[0_0_20px_hsl(174_72%_50%/0.2)] active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4 inline mr-2" />
          {isSubmitting ? 'Resolving profile...' : 'Track Address'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-6">
        {[
          { label: 'Real-time Tracking', desc: 'All trades live' },
          { label: 'Smart Analysis', desc: 'AI-powered insights' },
          { label: 'Paper Trade', desc: 'Risk-free strategy testing' },
        ].map((item, i) => (
          <div key={i} className="stat-card text-center">
            <p className="text-xs font-semibold text-primary mb-1">{item.label}</p>
            <p className="text-[10px] text-muted-foreground">{item.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
