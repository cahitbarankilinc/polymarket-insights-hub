import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { spawn, spawnSync } from "child_process";
import { componentTagger } from "lovable-tagger";
import type { IncomingMessage } from "http";

const POLL_INTERVAL_MS = 1000;
const MAX_RECENT_SEEN_IDS = 5000;
const ACTIVITY_URL = "https://data-api.polymarket.com/activity";
const TRADES_URL = "https://data-api.polymarket.com/trades";
const TRACKING_ROOT = path.resolve(process.cwd(), "tracked_wallets");
const PROFILE_TRADES_ROOT = path.resolve(process.cwd(), "tracked_profiles");
const PROFILE_SCRIPT_PATH = path.resolve(process.cwd(), "polymarket_profile_extract.py");
const SCRAPER_SCRIPT_PATH = path.resolve(process.cwd(), "scrapernew.py");
const PROFILE_TRADES_REFRESH_MS = 60 * 60 * 1000;
const OPENAI_MODEL = "gpt-5-mini-2025-08-07";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "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";
const OPENAI_SYSTEM_INSTRUCTIONS = `Sen bir “Polymarket trade kopyalama analiz motoru”sun. Görevin sadece ANALİZ ve ÖZET üretmektir.
Asla:
- Tavsiye verme, öneri verme, “yapmalısın / dene / test et / paper trading” gibi yönlendirici cümleler kurma.
- Uzun açıklama yazma, gereksiz detay ekleme, eğitim/rehber moduna girme.
- Risk uyarıları, hukuki/finansal disclaimer, “yatırım tavsiyesi değildir” vb. metin yazma.
- Pseudocode, otomasyon adımları, kural listeleri, checklist’ler, simülasyon/deneme önerileri üretme.
- Soru sorma; veri eksikse sadece “Yetersiz veri: …” diye tek satır belirt.

Çıktı formatı KESİN:
1) Trader davranış özeti (profil)
- En fazla 6 madde, her madde 1 satır, sade ve anlaşılır.
- Şunları kapsa (varsa): işlem sıklığı, tipik pozisyon büyüklüğü, market türleri, yönlülük vs market-making, holding süresi izleri, tutarlılık.

2) Net öneri (özet)
- Sadece 3–5 madde.
- “Ölçekleme yaklaşımı”nı tarafsız biçimde seç ve yaz: 
  - “Sabit $”, “Portföy %”, veya “Free balance oranı” (veri varsa).
- Kullanıcının bütçesi (~$100) ile trader’ın ölçeği çok farklıysa bunu 1 cümleyle belirt.
- Her maddede yalnızca net parametre/ilke adı ver (örn: “Sabit $/trade: $X”, “Max açık maruziyet: $Y”, “Günlük toplam: $Z”).
- Gerekçe yazma; sadece net özet.

Dil: Türkçe. Ton: kısa, temiz, doğrudan.`;

type RawEvent = Record<string, unknown>;

type NormalizedEvent = {
  seen_at_utc: string;
  event_time?: string | null;
  type?: string | null;
  side?: string | null;
  market?: string | null;
  market_slug?: string | null;
  outcome?: string | null;
  asset_id?: string | null;
  price?: number | null;
  size?: number | null;
  value_usd?: number | null;
  tx_hash?: string | null;
  raw_source: "activity" | "trades";
};

type MarketQuote = {
  market: string;
  outcome: string;
  assetId: string;
  bid: number | null;
  ask: number | null;
  bidCents: number | null;
  askCents: number | null;
};

type WalletEventStats = {
  total: number;
  last24h: number;
  buyTodayUsd: number;
  sellTodayUsd: number;
};

type ClosedTrade = {
  closed_market: string;
  closed_result: string;
  closed_couldwon: number;
  closed_outcome: string;
  closed_cent: number;
  closed_won: number;
  closed_pnl: number;
  closed_procent: number;
};

type ProfileTradesPayload = {
  username: string;
  trades: ClosedTrade[];
  source: "cache" | "scraped";
  refreshedAt: string | null;
  loading: boolean;
  isRefreshing: boolean;
};

type TrackerState = {
  seen_ids: string[];
  seen_queue: string[];
  last_check: string | null;
};

type TrackerRuntime = {
  stop: () => void;
  state: TrackerState;
};

const runtimes = new Map<string, TrackerRuntime>();
const profileTradeJobs = new Map<string, Promise<void>>();
const quoteCache = new Map<string, { expiresAt: number; value: MarketQuote | null }>();
const QUOTE_TTL_MS = 1500;

const utcNowIso = () => new Date().toISOString();

const toFloat = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeWallet = (address: string) => address.trim().toLowerCase();

const parseProfileUsername = (profileUrl: string) => {
  const match = profileUrl.match(/@([^?/#]+)/i);
  return (match?.[1] ?? "unknown_user").replace(/\//g, "").toLowerCase();
};

const profileTradesPath = (username: string) => path.join(PROFILE_TRADES_ROOT, `${username}_trades.json`);

const parseClosedTrade = (value: unknown): ClosedTrade | null => {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;

  const closed_market = typeof row.closed_market === "string" ? row.closed_market : "";
  const closed_result = typeof row.closed_result === "string" ? row.closed_result : "";
  const closed_outcome = typeof row.closed_outcome === "string" ? row.closed_outcome : "";

  return {
    closed_market,
    closed_result,
    closed_outcome,
    closed_couldwon: toFloat(row.closed_couldwon) ?? 0,
    closed_cent: toFloat(row.closed_cent) ?? 0,
    closed_won: toFloat(row.closed_won) ?? 0,
    closed_pnl: toFloat(row.closed_pnl) ?? 0,
    closed_procent: toFloat(row.closed_procent) ?? 0,
  };
};

const runScraperForProfile = async (profileUrl: string): Promise<ClosedTrade[]> => {
  const safeUrl = profileUrl.trim();
  if (!safeUrl) throw new Error("profileUrl is required");

  const username = parseProfileUsername(safeUrl);
  const outputPath = profileTradesPath(username);
  const candidates = ["python3", "python"] as const;
  let lastError = "Scraper command failed";

  for (const bin of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, [SCRAPER_SCRIPT_PATH, safeUrl], {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        let stdout = "";

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("error", (error) => {
          reject(error);
        });

        child.on("close", (code) => {
          if (code === 0) {
            resolve();
            return;
          }
          reject(new Error((stderr || stdout || `${bin} exited with ${code}`).trim()));
        });
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }

    const generatedOutputPath = path.resolve(process.cwd(), `${username}_trades.json`);
    if (!fs.existsSync(generatedOutputPath)) {
      throw new Error(`Scraper çıktısı bulunamadı: ${generatedOutputPath}`);
    }

    fs.copyFileSync(generatedOutputPath, outputPath);

    const raw = fs.readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Scraper çıktısı geçerli bir liste değil");
    }

    return parsed.map(parseClosedTrade).filter((trade): trade is ClosedTrade => trade !== null);
  }

  throw new Error(lastError);
};

const readCachedProfileTrades = (username: string): ClosedTrade[] => {
  const raw = fs.readFileSync(profileTradesPath(username), "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(parseClosedTrade).filter((trade): trade is ClosedTrade => trade !== null);
};

const scheduleProfileTradesRefresh = (username: string, profileUrl: string) => {
  if (profileTradeJobs.has(username)) return;

  const job = Promise.resolve().then(async () => {
    await runScraperForProfile(profileUrl);
  }).catch(() => {
    // no-op: endpoint response should continue serving cache/loading state
  }).finally(() => {
    profileTradeJobs.delete(username);
  });

  profileTradeJobs.set(username, job);
};

const getProfileTradesPayload = (profileUrl: string): ProfileTradesPayload => {
  const safeUrl = profileUrl.trim();
  if (!safeUrl) throw new Error("profileUrl is required");

  fs.mkdirSync(PROFILE_TRADES_ROOT, { recursive: true });
  const username = parseProfileUsername(safeUrl);
  const targetPath = profileTradesPath(username);
  const hasFile = fs.existsSync(targetPath);
  const hasRunningJob = profileTradeJobs.has(username);

  if (!hasFile) {
    if (!hasRunningJob) {
      scheduleProfileTradesRefresh(username, safeUrl);
    }

    return {
      username,
      trades: [],
      source: "scraped",
      refreshedAt: null,
      loading: true,
      isRefreshing: true,
    };
  }

  const stat = fs.statSync(targetPath);
  const ageMs = Date.now() - stat.mtimeMs;
  const stale = ageMs >= PROFILE_TRADES_REFRESH_MS;
  if (stale && !hasRunningJob) {
    scheduleProfileTradesRefresh(username, safeUrl);
  }

  return {
    username,
    trades: readCachedProfileTrades(username),
    source: stale ? "cache" : "cache",
    refreshedAt: stat.mtime.toISOString(),
    loading: false,
    isRefreshing: stale || hasRunningJob,
  };
};

const toTimestampMs = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value === "string") {
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

const walletDir = (address: string) => path.join(TRACKING_ROOT, normalizeWallet(address));
const stateFile = (address: string) => path.join(walletDir(address), "state.json");
const eventsFile = (address: string) => path.join(walletDir(address), "events.ndjson");
const errorsFile = (address: string) => path.join(walletDir(address), "errors.log");

const ensureWalletDir = (address: string) => {
  fs.mkdirSync(walletDir(address), { recursive: true });
};

const readState = (address: string): TrackerState => {
  try {
    const content = fs.readFileSync(stateFile(address), "utf-8");
    const parsed = JSON.parse(content) as Partial<TrackerState>;
    return {
      seen_ids: Array.isArray(parsed.seen_ids) ? parsed.seen_ids : [],
      seen_queue: Array.isArray(parsed.seen_queue) ? parsed.seen_queue : [],
      last_check: typeof parsed.last_check === "string" ? parsed.last_check : null,
    };
  } catch {
    return { seen_ids: [], seen_queue: [], last_check: null };
  }
};

const writeState = (address: string, state: TrackerState) => {
  fs.writeFileSync(stateFile(address), JSON.stringify(state, null, 2), "utf-8");
};

const readEvents = (address: string): NormalizedEvent[] => {
  try {
    const lines = fs.readFileSync(eventsFile(address), "utf-8").split("\n").filter(Boolean);
    return lines
      .map((line) => {
        try {
          return JSON.parse(line) as NormalizedEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is NormalizedEvent => event !== null);
  } catch {
    return [];
  }
};

const computeEventStats = (events: NormalizedEvent[]): WalletEventStats => {
  const now = Date.now();
  const last24HoursMs = 24 * 60 * 60 * 1000;

  let last24h = 0;
  let buyTodayUsd = 0;
  let sellTodayUsd = 0;

  for (const event of events) {
    const eventTime = toTimestampMs(event.event_time) ?? toTimestampMs(event.seen_at_utc);
    if (eventTime === null || now - eventTime > last24HoursMs) continue;

    last24h += 1;
    const value = event.value_usd ?? 0;
    const side = (event.side ?? "").toUpperCase();
    if (side === "BUY") buyTodayUsd += value;
    if (side === "SELL") sellTodayUsd += value;
  }

  return {
    total: events.length,
    last24h,
    buyTodayUsd,
    sellTodayUsd,
  };
};

const appendEvents = (address: string, events: NormalizedEvent[]) => {
  if (events.length === 0) return;
  const data = events.map((event) => JSON.stringify(event)).join("\n");
  fs.appendFileSync(eventsFile(address), `${data}\n`, "utf-8");
};

const appendError = (address: string, message: string) => {
  fs.appendFileSync(errorsFile(address), `[${utcNowIso()}] ${message}\n`, "utf-8");
};

const generateEventId = (raw: RawEvent, source: "activity" | "trades") => {
  const txHash = raw.transactionHash ?? raw.txHash ?? raw.hash;
  if (txHash) return String(txHash);
  const eventTime = raw.timestamp ?? raw.createdAt ?? raw.time ?? raw.eventTime;
  const market = raw.question ?? raw.slug ?? raw.market ?? raw.marketId;
  const side = raw.side ?? raw.action ?? "";
  const size = raw.size ?? raw.amount ?? raw.shares ?? "";
  return `${source}:${String(eventTime)}|${String(market)}|${String(side)}|${String(size)}`;
};

const normalizeEvent = (raw: RawEvent, source: "activity" | "trades"): NormalizedEvent => {
  const price = toFloat(raw.price ?? raw.avgPrice);
  const size = toFloat(raw.size ?? raw.amount ?? raw.shares);
  const valueFromEvent = toFloat(raw.value ?? raw.valueUSD);

  const normalizedEventTime = toTimestampMs(raw.timestamp ?? raw.createdAt ?? raw.time ?? raw.eventTime);

  return {
    seen_at_utc: utcNowIso(),
    event_time: normalizedEventTime === null ? null : new Date(normalizedEventTime).toISOString(),
    type: (raw.type ?? raw.eventType ?? (source === "trades" ? "TRADE" : null)) as string | null,
    side: (raw.side ?? raw.action ?? null) as string | null,
    market: (raw.question ?? raw.slug ?? raw.market ?? raw.marketId ?? null) as string | null,
    market_slug: (raw.slug ?? raw.marketSlug ?? raw.market_slug ?? null) as string | null,
    outcome: (raw.outcome ?? raw.outcomeName ?? raw.token ?? null) as string | null,
    asset_id: (raw.asset_id ?? raw.assetId ?? raw.tokenId ?? raw.token_id ?? null) as string | null,
    price,
    size,
    value_usd: valueFromEvent ?? (price !== null && size !== null ? Number((price * size).toFixed(6)) : null),
    tx_hash: (raw.transactionHash ?? raw.txHash ?? raw.hash ?? null) as string | null,
    raw_source: source,
  };
};

const maybeJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || typeof value === "object") return value;
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}")))) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
};

const normalizeToken = (value: string) => value.trim().toLowerCase();

const resolveQuoteFromMarket = async (marketSlug: string, outcome: string): Promise<MarketQuote | null> => {
  const marketResponse = await fetch(`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(marketSlug)}`, { cache: "no-store" });
  if (!marketResponse.ok) return null;

  const marketPayload = await marketResponse.json() as Record<string, unknown>;
  const tokenIds = maybeJson(marketPayload.clobTokenIds);
  const outcomes = maybeJson(marketPayload.outcomes);

  if (!Array.isArray(tokenIds) || tokenIds.length === 0 || !Array.isArray(outcomes) || outcomes.length === 0) {
    return null;
  }

  const normalizedOutcome = normalizeToken(outcome);
  let outcomeIndex = outcomes.findIndex((candidate) => normalizeToken(String(candidate)) === normalizedOutcome);
  if (outcomeIndex === -1) {
    outcomeIndex = outcomes.findIndex((candidate) => normalizeToken(String(candidate)).includes(normalizedOutcome));
  }
  if (outcomeIndex === -1 || outcomeIndex >= tokenIds.length) return null;

  const assetId = String(tokenIds[outcomeIndex]);
  const bookResponse = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(assetId)}`, { cache: "no-store" });
  if (!bookResponse.ok) return null;

  const bookPayload = await bookResponse.json() as Record<string, unknown>;
  const bids = Array.isArray(bookPayload.bids) ? bookPayload.bids : [];
  const asks = Array.isArray(bookPayload.asks) ? bookPayload.asks : [];

  let bid: number | null = null;
  let ask: number | null = null;

  const bidPrices = bids
    .map((row) => (row && typeof row === "object" ? toFloat((row as Record<string, unknown>).price) : null))
    .filter((price): price is number => typeof price === "number");
  if (bidPrices.length > 0) bid = Math.max(...bidPrices);

  const askPrices = asks
    .map((row) => (row && typeof row === "object" ? toFloat((row as Record<string, unknown>).price) : null))
    .filter((price): price is number => typeof price === "number");
  if (askPrices.length > 0) ask = Math.min(...askPrices);

  return {
    market: marketSlug,
    outcome,
    assetId,
    bid,
    ask,
    bidCents: bid === null ? null : Number((bid * 100).toFixed(4)),
    askCents: ask === null ? null : Number((ask * 100).toFixed(4)),
  };
};

const getLiveQuote = async (marketSlug: string, outcome: string): Promise<MarketQuote | null> => {
  const cleanMarket = marketSlug.trim();
  const cleanOutcome = outcome.trim();
  if (!cleanMarket || !cleanOutcome) return null;

  const cacheKey = `${normalizeToken(cleanMarket)}|${normalizeToken(cleanOutcome)}`;
  const now = Date.now();
  const cached = quoteCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await resolveQuoteFromMarket(cleanMarket, cleanOutcome);
  quoteCache.set(cacheKey, { value, expiresAt: now + QUOTE_TTL_MS });
  return value;
};


const resolveProfileFromUrl = (profileUrl: string) => {
  const safeUrl = profileUrl.trim();
  if (!safeUrl) {
    throw new Error("profileUrl is required");
  }

  const candidates = ["python3", "python"] as const;
  let lastError = "Python command failed";

  for (const bin of candidates) {
    const result = spawnSync(bin, [PROFILE_SCRIPT_PATH, safeUrl], { encoding: "utf-8" });
    if (result.error) {
      lastError = result.error.message;
      continue;
    }

    if (result.status !== 0) {
      lastError = (result.stderr || result.stdout || `${bin} exited with ${result.status}`).trim();
      continue;
    }

    const output = result.stdout.trim();
    if (!output) {
      throw new Error("Profil scripti boş cevap döndü");
    }

    const parsed = JSON.parse(output) as Record<string, unknown>;
    const proxyWallet = typeof parsed.proxyWallet === "string" ? normalizeWallet(parsed.proxyWallet) : "";
    if (!proxyWallet) {
      throw new Error("Profil çıktısında proxyWallet bulunamadı");
    }

    return { ...parsed, proxyWallet };
  }

  throw new Error(lastError);
};

const fetchEndpoint = async (url: string, address: string): Promise<RawEvent[]> => {
  const requestTs = Date.now();
  const response = await fetch(`${url}?user=${address}&limit=50&offset=0&_=${requestTs}`, {
    cache: "no-store",
    headers: {
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!response.ok) {
    throw new Error(`${url} -> HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (Array.isArray(payload)) return payload as RawEvent[];
  if (payload && typeof payload === "object") {
    const keys = ["data", "activities", "trades", "activity"] as const;
    for (const key of keys) {
      const candidate = (payload as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as RawEvent[];
    }
  }
  return [];
};

const startTracker = (address: string) => {
  const normalizedAddress = normalizeWallet(address);
  if (!normalizedAddress) return;
  if (runtimes.has(normalizedAddress)) return;

  ensureWalletDir(normalizedAddress);
  const state = readState(normalizedAddress);

  let active = true;
  let timeout: NodeJS.Timeout | null = null;

  const tick = async () => {
    const startedAt = Date.now();
    const seenIds = new Set(state.seen_ids);
    const seenQueue = [...state.seen_queue];

    try {
      const [activity, trades] = await Promise.all([
        fetchEndpoint(ACTIVITY_URL, normalizedAddress),
        fetchEndpoint(TRADES_URL, normalizedAddress),
      ]);

      const newEvents: NormalizedEvent[] = [];
      for (const [payload, source] of [
        [activity, "activity" as const],
        [trades, "trades" as const],
      ]) {
        for (const item of payload) {
          const eventId = generateEventId(item, source);
          if (seenIds.has(eventId)) continue;
          seenIds.add(eventId);
          seenQueue.push(eventId);
          while (seenQueue.length > MAX_RECENT_SEEN_IDS) {
            const oldest = seenQueue.shift();
            if (oldest) seenIds.delete(oldest);
          }
          newEvents.push(normalizeEvent(item, source));
        }
      }

      if (newEvents.length > 0) {
        appendEvents(normalizedAddress, newEvents.reverse());
      }

      if (!active) return;
      state.seen_ids = [...seenIds];
      state.seen_queue = seenQueue;
      state.last_check = utcNowIso();
      writeState(normalizedAddress, state);
    } catch (error) {
      appendError(normalizedAddress, error instanceof Error ? error.message : "Unknown polling error");
    } finally {
      if (!active) return;
      const elapsedMs = Date.now() - startedAt;
      const nextDelayMs = Math.max(0, POLL_INTERVAL_MS - elapsedMs);
      timeout = setTimeout(() => {
        void tick();
      }, nextDelayMs);
    }
  };

  void tick();
  runtimes.set(normalizedAddress, {
    state,
    stop: () => {
      active = false;
      if (timeout) clearTimeout(timeout);
    },
  });
};

const stopTracker = (address: string) => {
  const normalizedAddress = normalizeWallet(address);
  const runtime = runtimes.get(normalizedAddress);
  if (!runtime) return;
  runtime.stop();
  runtimes.delete(normalizedAddress);
};


const readJsonBody = async <T>(req: IncomingMessage): Promise<T> => {
  let rawBody = "";
  await new Promise<void>((resolve) => {
    req.on("data", (chunk) => {
      rawBody += chunk.toString();
    });
    req.on("end", () => resolve());
  });

  return rawBody ? (JSON.parse(rawBody) as T) : ({} as T);
};

const extractResponseText = (payload: Record<string, unknown>): string => {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (Array.isArray(payload.output)) {
    const textChunks: string[] = [];

    for (const item of payload.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;

      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const maybeText = (part as { text?: unknown }).text;
        if (typeof maybeText === "string") textChunks.push(maybeText);
      }
    }

    if (textChunks.length > 0) return textChunks.join("\n").trim();
  }

  return "Model boş yanıt döndürdü.";
};

const createPolymarketTrackerPlugin = (): Plugin => ({
  name: "polymarket-local-tracker",
  configureServer(server) {
    fs.mkdirSync(TRACKING_ROOT, { recursive: true });
    fs.mkdirSync(PROFILE_TRADES_ROOT, { recursive: true });

    server.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith("/api/tracker")) {
        next();
        return;
      }

      const sendJson = (code: number, payload: unknown) => {
        res.statusCode = code;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };

      try {
        if (req.method === "POST" && req.url === "/api/tracker/profile") {
          const parsed = await readJsonBody<{ profileUrl?: string }>(req);
          const profileData = resolveProfileFromUrl(parsed.profileUrl ?? "");
          sendJson(200, profileData);
          return;
        }

        if (req.method === "POST" && req.url === "/api/tracker/start") {
          const parsed = await readJsonBody<{ address?: string }>(req);
          const address = normalizeWallet(parsed.address ?? "");
          if (!address) {
            sendJson(400, { error: "address is required" });
            return;
          }

          startTracker(address);
          sendJson(200, { ok: true, address, storagePath: walletDir(address) });
          return;
        }

        if (req.method === "GET" && req.url?.startsWith("/api/tracker/profile-trades")) {
          const requestUrl = new URL(req.url, "http://localhost");
          const profileUrl = requestUrl.searchParams.get("profileUrl") ?? "";
          if (!profileUrl.trim()) {
            sendJson(400, { error: "profileUrl is required" });
            return;
          }

          const payload = getProfileTradesPayload(profileUrl);
          sendJson(200, {
            profileUrl,
            username: payload.username,
            trades: payload.trades,
            source: payload.source,
            refreshedAt: payload.refreshedAt,
            loading: payload.loading,
            isRefreshing: payload.isRefreshing,
          });
          return;
        }

        if (req.method === "GET" && req.url === "/api/tracker/list") {
          const wallets = fs
            .readdirSync(TRACKING_ROOT, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
              const address = entry.name;
              const events = readEvents(address);
              const state = readState(address);
              return {
                address,
                eventCount: events.length,
                latestEvent: events[0] ?? null,
                lastCheck: state.last_check,
                isActive: runtimes.has(address),
                storagePath: walletDir(address),
              };
            });
          sendJson(200, { wallets });
          return;
        }

        if (req.method === "GET" && req.url?.startsWith("/api/tracker/events/")) {
          const address = normalizeWallet(req.url.replace("/api/tracker/events/", "").split("?")[0]);
          const events = readEvents(address);
          const stats = computeEventStats(events);
          sendJson(200, { address, events, stats });
          return;
        }

        if (req.method === "GET" && req.url?.startsWith("/api/tracker/quote")) {
          const requestUrl = new URL(req.url, "http://localhost");
          const market = requestUrl.searchParams.get("market") ?? "";
          const outcome = requestUrl.searchParams.get("outcome") ?? "";

          if (!market || !outcome) {
            sendJson(400, { error: "market and outcome are required" });
            return;
          }

          const quote = await getLiveQuote(market, outcome);
          if (!quote) {
            sendJson(404, { error: "quote could not be resolved" });
            return;
          }

          sendJson(200, quote);
          return;
        }

        if (req.method === "POST" && req.url === "/api/tracker/copytrade-advisor") {
          const parsed = await readJsonBody<{ context?: string }>(req);
          const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
          if (!context) {
            sendJson(400, { error: "context is required" });
            return;
          }

          const userPrompt = `Bütçem yaklaşık $100.

Aşağıdaki veri bir Polymarket kullanıcısının trade/aktivite geçmişidir. 
Bu trader’ı kopyalamayı planlıyorum. Sadece istenen formatta, kısa çıktı üret.

VERİLER:
${context}`;

          const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: OPENAI_MODEL,
              instructions: OPENAI_SYSTEM_INSTRUCTIONS,
              input: userPrompt,
            }),
          });

          if (!openAiResponse.ok) {
            const errorText = await openAiResponse.text();
            sendJson(openAiResponse.status, { error: errorText || "OpenAI request failed" });
            return;
          }

          const payload = await openAiResponse.json() as Record<string, unknown>;
          sendJson(200, {
            model: OPENAI_MODEL,
            analysis: extractResponseText(payload),
          });
          return;
        }

        if (req.method === "DELETE" && req.url?.startsWith("/api/tracker/")) {
          const address = normalizeWallet(req.url.replace("/api/tracker/", "").split("?")[0]);
          stopTracker(address);
          sendJson(200, { ok: true, address });
          return;
        }

        sendJson(404, { error: "Not found" });
      } catch (error) {
        sendJson(500, { error: error instanceof Error ? error.message : "Server error" });
      }
    });
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), createPolymarketTrackerPlugin(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
