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

export async function startWalletTracking(address: string) {
  const response = await fetch('/api/tracker/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Takip başlatılamadı');
  }
  return response.json();
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
