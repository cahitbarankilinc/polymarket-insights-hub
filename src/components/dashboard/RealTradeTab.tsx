import { Zap, Lock } from 'lucide-react';

export default function RealTradeTab() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] animate-slide-up">
      <div className="glass-card p-8 max-w-md text-center glow-border">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Zap className="w-8 h-8 text-primary animate-pulse-glow" />
        </div>
        <h2 className="text-xl font-bold text-foreground mb-2">Gerçek Trade</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Bu bölüm yakında aktif olacak. Gerçek trade özellikleri üzerinde çalışılıyor.
        </p>
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground/60">
          <Lock className="w-3.5 h-3.5" />
          <span>Yakında...</span>
        </div>
      </div>
    </div>
  );
}
