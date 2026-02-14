import { useEffect, useState } from 'react';
import { Plus, Link as LinkIcon, Tag, Check, Webhook, RefreshCcw } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';
import {
  createTrackerWebhook,
  getTrackerWebhookConfig,
  listTrackerWebhooks,
  resolvePolymarketProfile,
  startWalletTracking,
  type TrackerWebhook,
} from '@/lib/polymarketTrackerApi';

export default function AddAddressTab() {
  const { categories, addAddress, addCategory } = useDashboard();
  const [profileUrl, setProfileUrl] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [note, setNote] = useState('');
  const [isAddingCategory, setIsAddingCategory] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [webhooks, setWebhooks] = useState<TrackerWebhook[]>([]);
  const [selectedWebhookId, setSelectedWebhookId] = useState('');
  const [newWebhookName, setNewWebhookName] = useState('');
  const [isCreatingWebhook, setIsCreatingWebhook] = useState(false);
  const [publicWebhookBase, setPublicWebhookBase] = useState<string | null>(null);
  const [isPublicWebhookReady, setIsPublicWebhookReady] = useState(false);

  const isProbablyUrl = (value: string) => /^https?:\/\/.+/i.test(value.trim());

  const loadWebhooks = async () => {
    try {
      const [availableHooks, webhookConfig] = await Promise.all([
        listTrackerWebhooks(),
        getTrackerWebhookConfig(),
      ]);
      setWebhooks(availableHooks);
      setPublicWebhookBase(webhookConfig.publicBaseUrl ?? null);
      setIsPublicWebhookReady(Boolean(webhookConfig.isPublicReachable));

      if (!selectedWebhookId && availableHooks[0]) {
        setSelectedWebhookId(availableHooks[0].id);
      }
    } catch {
      toast.error('Webhook listesi alınamadı');
    }
  };

  useEffect(() => {
    loadWebhooks();
  }, []);

  const handleCreateWebhook = async () => {
    setIsCreatingWebhook(true);
    try {
      const created = await createTrackerWebhook(newWebhookName.trim() || undefined);
      setWebhooks((prev) => [...prev, created]);
      setSelectedWebhookId(created.id);
      setNewWebhookName('');
      toast.success('Webhook oluşturuldu');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Webhook oluşturulamadı');
    } finally {
      setIsCreatingWebhook(false);
    }
  };

  const handleSubmit = async () => {
    if (!profileUrl.trim()) {
      toast.error('Lütfen bir Polymarket profil linki girin');
      return;
    }
    if (!isProbablyUrl(profileUrl)) {
      toast.error('Lütfen geçerli bir profil linki girin (https://...)');
      return;
    }

    const cat = isAddingCategory ? newCategory.trim() : selectedCategory;
    if (!cat) {
      toast.error('Lütfen bir kategori seçin veya ekleyin');
      return;
    }

    setIsSubmitting(true);
    try {
      const resolvedProfile = await resolvePolymarketProfile(profileUrl.trim());
      const normalizedAddress = resolvedProfile.proxyWallet?.trim().toLowerCase();

      if (!normalizedAddress || !/^0x[a-fA-F0-9]{40}$/.test(normalizedAddress)) {
        toast.error('Linkten geçerli bir proxy wallet adresi alınamadı');
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
        await startWalletTracking(normalizedAddress, selectedWebhookId || undefined);
      } catch {
        toast.error('Adres eklendi ama local takip başlatılamadı');
      }

      setProfileUrl('');
      setSelectedCategory('');
      setNewCategory('');
      setNote('');
      setIsAddingCategory(false);
      await loadWebhooks();
      toast.success('Profil başarıyla eklendi!');
      if (!isPublicWebhookReady) {
        toast.warning('Wallet eklendi, fakat webhook henüz internete açık değil.');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Profil verisi alınamadı');
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedWebhook = webhooks.find((item) => item.id === selectedWebhookId) ?? webhooks[0];

  return (
    <div className="max-w-2xl mx-auto animate-slide-up">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">
          <span className="gradient-text">Yeni Adres</span> Takibe Al
        </h2>
        <p className="text-muted-foreground text-sm">Polymarket profil linkini ekle, proxy wallet ile local klasörde NDJSON takip başlat</p>
      </div>

      <div className="glass-card p-6 space-y-6">
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <LinkIcon className="w-4 h-4 text-primary" />
            Polymarket Profil Linki
          </label>
          <input
            type="text"
            value={profileUrl}
            onChange={(e) => setProfileUrl(e.target.value)}
            placeholder="https://polymarket.com/@kullanici?tab=activity"
            className="w-full px-4 py-3 rounded-lg bg-secondary/50 border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 text-sm transition-all"
          />
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Webhook className="w-4 h-4 text-primary" />
            Webhook <span className="text-muted-foreground text-xs">(Bildirim tetikleyici)</span>
          </label>

          <div className="space-y-2">
            <div className="flex gap-2">
              <select
                value={selectedWebhookId}
                onChange={(e) => setSelectedWebhookId(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-secondary/50 border border-border/50 text-sm"
              >
                {webhooks.map((hook) => (
                  <option key={hook.id} value={hook.id}>
                    {hook.name?.trim() || `Webhook ${hook.id.slice(-6)}`} • {hook.walletCount} wallet
                  </option>
                ))}
              </select>
              <button
                onClick={loadWebhooks}
                type="button"
                className="px-3 py-2 rounded-lg border border-border/50 hover:border-primary/30"
                title="Webhook listesini yenile"
              >
                <RefreshCcw className="w-4 h-4" />
              </button>
            </div>

            {selectedWebhook && (
              <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary/90 break-all">
                Alchemy için URL: {selectedWebhook.publicUrl ?? 'Tanımsız'}
                <br />
                Local URL: {selectedWebhook.localUrl ?? selectedWebhook.url}
              </div>
            )}

            {!isPublicWebhookReady && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                İnternete açık webhook tanımlı değil. Alchemy POST alabilmek için sunucuda
                <span className="font-semibold"> PUBLIC_WEBHOOK_BASE_URL</span> (https://...) ayarlayın.
                {publicWebhookBase ? ` (Mevcut: ${publicWebhookBase})` : ''}
              </div>
            )}

            <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border/60 p-3">
              <p className="text-xs text-muted-foreground">Yeni webhook oluştur (isteğe bağlı isim):</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newWebhookName}
                  onChange={(e) => setNewWebhookName(e.target.value)}
                  placeholder="Örn: Whale notifier"
                  className="flex-1 px-3 py-2 rounded-lg bg-secondary/50 border border-border/50 text-sm"
                />
                <button
                  type="button"
                  onClick={handleCreateWebhook}
                  disabled={isCreatingWebhook}
                  className="px-3 py-2 rounded-lg border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-60"
                >
                  Oluştur
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Tag className="w-4 h-4 text-primary" />
            Kategori <span className="text-destructive">*</span>
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
              <Plus className="w-3 h-3" /> Yeni Kategori
            </button>
          </div>

          {isAddingCategory && (
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="Yeni kategori adı..."
              autoFocus
              className="w-full px-4 py-3 rounded-lg bg-secondary/50 border border-accent/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/30 text-sm transition-all animate-fade-in"
            />
          )}
        </div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            Cüzdan Notu <span className="text-muted-foreground text-xs">(Opsiyonel)</span>
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Bu cüzdan hakkında kısa notlar..."
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
          {isSubmitting ? 'Profil Çözümleniyor...' : 'Adresi Takibe Al'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3 mt-6">
        {[
          { label: 'Anlık Takip', desc: 'Webhook + polling hibrit' },
          { label: 'Akıllı Analiz', desc: 'AI destekli insight' },
          { label: 'Paper Trade', desc: 'Risksiz strateji test' },
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
