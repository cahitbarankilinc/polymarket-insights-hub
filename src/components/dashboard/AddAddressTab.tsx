import { useState } from 'react';
import { Plus, Wallet, Tag, Check } from 'lucide-react';
import { useDashboard } from '@/context/DashboardContext';
import { toast } from 'sonner';
import { startWalletTracking } from '@/lib/polymarketTrackerApi';

export default function AddAddressTab() {
  const { categories, addAddress, addCategory } = useDashboard();
  const [address, setAddress] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [isAddingCategory, setIsAddingCategory] = useState(false);

  const isValidEthAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value);

  const handleSubmit = async () => {
    if (!address.trim()) {
      toast.error('Lütfen bir wallet adresi girin');
      return;
    }
    if (!isValidEthAddress(address.trim())) {
      toast.error('Lütfen geçerli bir Ethereum adresi girin (0x...)');
      return;
    }
    const cat = isAddingCategory ? newCategory.trim() : selectedCategory;
    if (!cat) {
      toast.error('Lütfen bir kategori seçin veya ekleyin');
      return;
    }
    if (isAddingCategory && newCategory.trim()) {
      addCategory(newCategory.trim());
    }
    const normalizedAddress = address.trim().toLowerCase();
    addAddress(normalizedAddress, cat);

    try {
      await startWalletTracking(normalizedAddress);
    } catch {
      toast.error('Adres eklendi ama local takip başlatılamadı');
    }

    setAddress('');
    setSelectedCategory('');
    setNewCategory('');
    setIsAddingCategory(false);
    toast.success('Adres başarıyla eklendi!');
  };

  return (
    <div className="max-w-2xl mx-auto animate-slide-up">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold mb-2">
          <span className="gradient-text">Yeni Adres</span> Takibe Al
        </h2>
        <p className="text-muted-foreground text-sm">Polymarket cüzdan adresini ekle, local klasörde NDJSON olarak takip et</p>
      </div>

      <div className="glass-card p-6 space-y-6">
        {/* Address Input */}
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Wallet className="w-4 h-4 text-primary" />
            Wallet Adresi
          </label>
          <input
            type="text"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x23cb796cf58bfa12352f0164f479deedbd50658e"
            className="w-full px-4 py-3 rounded-lg bg-secondary/50 border border-border/50 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 font-mono text-sm transition-all"
          />
        </div>

        {/* Category Section */}
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Tag className="w-4 h-4 text-primary" />
            Kategori <span className="text-destructive">*</span>
          </label>

          {/* Existing Categories */}
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

          {/* New Category Input */}
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

        {/* Submit */}
        <button
          onClick={handleSubmit}
          className="w-full py-3 rounded-lg font-semibold text-sm transition-all duration-300 bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 hover:shadow-[0_0_20px_hsl(174_72%_50%/0.2)] active:scale-[0.98]"
        >
          <Plus className="w-4 h-4 inline mr-2" />
          Adresi Takibe Al
        </button>
      </div>

      {/* Info cards */}
      <div className="grid grid-cols-3 gap-3 mt-6">
        {[
          { label: 'Anlık Takip', desc: 'Tüm işlemler canlı' },
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
