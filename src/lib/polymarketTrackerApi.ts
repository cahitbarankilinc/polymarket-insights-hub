export type WalletTrackerEvent = {
  seen_at_utc: string;
  event_time?: string | null;
  type?: string | null;
  side?: string | null;
  market?: string | null;
  outcome?: string | null;
  price?: number | null;
  size?: number | null;
  value_usd?: number | null;
  tx_hash?: string | null;
  raw_source: 'activity' | 'trades';
};

export type WalletTrackerInfo = {
  address: string;
  eventCount: number;
  latestEvent: WalletTrackerEvent | null;
  lastCheck: string | null;
  isActive: boolean;
  storagePath: string;
};

export type WalletTrackerStats = {
  total: number;
  last24h: number;
  buyTodayUsd: number;
  sellTodayUsd: number;
};

export type WalletEventsResponse = {
  address: string;
  events: WalletTrackerEvent[];
  stats?: WalletTrackerStats;
};

export type CopytradeAdvisorResponse = {
  analysis: string;
  model: string;
};

export type PolymarketProfileResponse = {
  proxyWallet: string;
  username?: string | null;
  trades?: number | null;
  largestWin?: number | null;
  views?: number | null;
  joinDate?: string | null;
  amount?: number | null;
  pnl?: number | null;
  polygonscanUrl?: string | null;
  polygonscanTopTotalValText?: string | null;
};

export type TrackerWebhook = {
  id: string;
  label: string;
  callbackUrl: string | null;
  provider: 'alchemy' | 'custom';
  status: 'active' | 'degraded';
  warning?: string;
  walletCount: number;
};

export async function resolvePolymarketProfile(profileUrl: string): Promise<PolymarketProfileResponse> {
  const response = await fetch('/api/tracker/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileUrl }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Profil verisi alınamadı');
  }
  return response.json() as Promise<PolymarketProfileResponse>;
}

export async function startWalletTracking(address: string, webhookId?: string) {
  const response = await fetch('/api/tracker/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, webhookId }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Takip başlatılamadı');
  }
  return response.json();
}

export async function listTrackerWebhooks(): Promise<{ webhooks: TrackerWebhook[]; defaultWebhookId: string }> {
  const response = await fetch('/api/tracker/webhooks');
  if (!response.ok) {
    throw new Error('Webhook listesi okunamadı');
  }

  return response.json() as Promise<{ webhooks: TrackerWebhook[]; defaultWebhookId: string }>;
}

export async function listTrackedWallets(): Promise<WalletTrackerInfo[]> {
  const response = await fetch('/api/tracker/list');
  if (!response.ok) {
    throw new Error('Takip listesi okunamadı');
  }
  const data = await response.json() as { wallets: WalletTrackerInfo[] };
  return data.wallets;
}

export async function getWalletEventsWithStats(address: string): Promise<WalletEventsResponse> {
  const response = await fetch(`/api/tracker/events/${address.toLowerCase()}`);
  if (!response.ok) {
    throw new Error('Cüzdan eventleri alınamadı');
  }

  const data = await response.json() as WalletEventsResponse | WalletTrackerEvent[];
  if (Array.isArray(data)) {
    return { address: address.toLowerCase(), events: data };
  }

  return {
    address: data.address ?? address.toLowerCase(),
    events: Array.isArray(data.events) ? data.events : [],
    stats: data.stats,
  };
}

export async function getWalletEvents(address: string): Promise<WalletTrackerEvent[]> {
  const payload = await getWalletEventsWithStats(address);
  return payload.events;
}

export async function stopWalletTracking(address: string) {
  await fetch(`/api/tracker/${address.toLowerCase()}`, { method: 'DELETE' });
}

export async function requestCopytradeAdvisor(context: string): Promise<CopytradeAdvisorResponse> {
  const response = await fetch('/api/tracker/copytrade-advisor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'OpenAI analizi alınamadı');
  }

  return response.json() as Promise<CopytradeAdvisorResponse>;
}
