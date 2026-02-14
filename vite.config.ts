import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { spawnSync, spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { componentTagger } from "lovable-tagger";
import type { IncomingMessage } from "http";

const POLL_INTERVAL_MS = 3000;
const POLL_JITTER_MS = 900;
const MAX_EVENTS = 200;
const ACTIVITY_URL = "https://data-api.polymarket.com/activity";
const TRADES_URL = "https://data-api.polymarket.com/trades";
const TRACKING_ROOT = path.resolve(process.cwd(), "tracked_wallets");
const PROFILE_SCRIPT_PATH = path.resolve(process.cwd(), "polymarket_profile_extract.py");
const WEBHOOKS_FILE = path.resolve(TRACKING_ROOT, "webhooks.json");
const DEFAULT_WEBHOOK_ID = "alchemy-default";
const CALLBACK_PATH = "/api/tracker/webhooks/alchemy-default/callback";
const ALCHEMY_NETWORK = (process.env.ALCHEMY_NETWORK ?? "eth-mainnet").toLowerCase();
const ALCHEMY_WEBHOOK_API_URL = process.env.ALCHEMY_WEBHOOK_API_URL ?? "https://dashboard.alchemy.com/api/create-webhook";
const WEBHOOK_HEALTHCHECK_MS = 60_000;
const WEBHOOK_STALE_MS = 10 * 60 * 1000;
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
  outcome?: string | null;
  price?: number | null;
  size?: number | null;
  value_usd?: number | null;
  tx_hash?: string | null;
  raw_source: "activity" | "trades";
};

type WalletEventStats = {
  total: number;
  last24h: number;
  buyTodayUsd: number;
  sellTodayUsd: number;
};

type TrackerState = {
  seen_ids: string[];
  seen_queue: string[];
  last_check: string | null;
};

type TrackerRuntime = {
  timer: NodeJS.Timeout;
  state: TrackerState;
  tick: () => Promise<void>;
};

type WebhookConfig = {
  id: string;
  label: string;
  callbackPath: string;
  callbackUrl: string | null;
  publicBaseUrl: string | null;
  provider: "alchemy" | "custom";
  alchemyWebhookId?: string;
  status: "active" | "degraded";
  warning?: string;
  lastWebhookAt?: string;
  walletAddresses: string[];
  createdAt: string;
  updatedAt: string;
};

const runtimes = new Map<string, TrackerRuntime>();
let tunnelProcess: ChildProcessWithoutNullStreams | null = null;
let tunnelUrl: string | null = null;
let webhookHealthTimer: NodeJS.Timeout | null = null;

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
      .filter((event): event is NormalizedEvent => event !== null)
      .slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
};

const readWebhookConfigs = (): WebhookConfig[] => {
  try {
    const raw = fs.readFileSync(WEBHOOKS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WebhookConfig => Boolean(item && typeof item === "object")).map((item) => ({
      ...item,
      walletAddresses: Array.isArray(item.walletAddresses) ? item.walletAddresses.map((wallet) => normalizeWallet(String(wallet))) : [],
      lastWebhookAt: typeof item.lastWebhookAt === "string" ? item.lastWebhookAt : undefined,
    }));
  } catch {
    return [];
  }
};

const writeWebhookConfigs = (configs: WebhookConfig[]) => {
  fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(configs, null, 2), "utf-8");
};

const parsePotentialWebhookId = (payload: Record<string, unknown>): string | null => {
  const candidates = [payload.webhookId, payload.webhook_id, payload.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
};


const startTunnel = async (): Promise<string> => {
  if (tunnelUrl) return tunnelUrl;

  tunnelProcess = spawn("ssh", ["-o", "StrictHostKeyChecking=no", "-R", "80:localhost:8080", "nokey@localhost.run"]);

  return await new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error("Tunnel URL alınamadı"));
    }, 20000);

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[\w.-]+\.lhr\.life/);
      if (!match) return;
      tunnelUrl = match[0];
      clearTimeout(timeoutId);
      resolve(tunnelUrl);
    };

    tunnelProcess?.stdout.on("data", handleOutput);
    tunnelProcess?.stderr.on("data", handleOutput);
    tunnelProcess?.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });
    tunnelProcess?.on("close", () => {
      tunnelProcess = null;
      tunnelUrl = null;
    });
  });
};

const upsertDefaultWebhook = async (): Promise<WebhookConfig> => {
  const existing = readWebhookConfigs();
  const now = utcNowIso();
  const baseUrl = await startTunnel();
  const callbackUrl = `${baseUrl}${CALLBACK_PATH}`;
  const next: WebhookConfig = existing.find((hook) => hook.id === DEFAULT_WEBHOOK_ID) ?? {
    id: DEFAULT_WEBHOOK_ID,
    label: "Alchemy Default",
    callbackPath: CALLBACK_PATH,
    callbackUrl,
    publicBaseUrl: baseUrl,
    provider: "alchemy",
    status: "degraded",
    walletAddresses: [],
    createdAt: now,
    updatedAt: now,
  };

  next.callbackUrl = callbackUrl;
  next.publicBaseUrl = baseUrl;
  next.updatedAt = now;

  const apiKey = process.env.ALCHEMY_API_KEY;
  const authToken = process.env.ALCHEMY_AUTH_TOKEN;

  if (apiKey && authToken) {
    try {
      const registerWebhook = async (webhookId?: string) => {
        const response = await fetch(ALCHEMY_WEBHOOK_API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${authToken}`,
            "X-Alchemy-Token": authToken,
          },
          body: JSON.stringify({
            webhook_type: "ADDRESS_ACTIVITY",
            network: ALCHEMY_NETWORK,
            webhook_url: callbackUrl,
            addresses: next.walletAddresses,
            webhook_id: webhookId,
            app_id: apiKey,
          }),
        });

        if (!response.ok) {
          const body = await response.text();
          throw new Error(`Alchemy webhook HTTP ${response.status}: ${body || "unknown error"}`);
        }

        return response.json() as Promise<Record<string, unknown>>;
      };

      let payload: Record<string, unknown>;
      try {
        payload = await registerWebhook(next.alchemyWebhookId);
      } catch (error) {
        const maybeNotFound = error instanceof Error && /404|not\s*found|bulunamad/i.test(error.message);
        if (!maybeNotFound || !next.alchemyWebhookId) {
          throw error;
        }
        next.alchemyWebhookId = undefined;
        payload = await registerWebhook(undefined);
      }

      const resolvedId = payload.id ?? payload.webhook_id;
      if (typeof resolvedId === "string" && resolvedId.trim()) {
        next.alchemyWebhookId = resolvedId;
      }

      next.status = "active";
      next.warning = undefined;
    } catch (error) {
      next.status = "degraded";
      next.warning = error instanceof Error ? error.message : "Alchemy webhook kurulamadı";
    }
  } else {
    next.status = "degraded";
    next.warning = "ALCHEMY_API_KEY veya ALCHEMY_AUTH_TOKEN eksik";
  }

  const withoutDefault = existing.filter((hook) => hook.id !== DEFAULT_WEBHOOK_ID);
  writeWebhookConfigs([...withoutDefault, next]);
  return next;
};

const monitorWebhookHealth = async () => {
  const configs = readWebhookConfigs();
  const target = configs.find((item) => item.id === DEFAULT_WEBHOOK_ID);
  if (!target) {
    await upsertDefaultWebhook();
    return;
  }

  const lastWebhookAtMs = target.lastWebhookAt ? toTimestampMs(target.lastWebhookAt) : null;
  const stale = lastWebhookAtMs === null || (Date.now() - lastWebhookAtMs) > WEBHOOK_STALE_MS;
  if (!stale) return;

  target.status = "degraded";
  target.warning = "Webhook callback uzun süredir alınamadı, yeniden kuruluyor";
  target.updatedAt = utcNowIso();
  writeWebhookConfigs(configs);
  await upsertDefaultWebhook();
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

const writeEvents = (address: string, events: NormalizedEvent[]) => {
  const data = events.slice(0, MAX_EVENTS).map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(eventsFile(address), data ? `${data}\n` : "", "utf-8");
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
    outcome: (raw.outcome ?? raw.outcomeName ?? raw.token ?? null) as string | null,
    price,
    size,
    value_usd: valueFromEvent ?? (price !== null && size !== null ? Number((price * size).toFixed(6)) : null),
    tx_hash: (raw.transactionHash ?? raw.txHash ?? raw.hash ?? null) as string | null,
    raw_source: source,
  };
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
  const response = await fetch(`${url}?user=${address}&limit=50&offset=0`);
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

  const tick = async () => {
    const allEvents = readEvents(normalizedAddress);
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
          while (seenQueue.length > MAX_EVENTS) {
            const oldest = seenQueue.shift();
            if (oldest) seenIds.delete(oldest);
          }
          newEvents.push(normalizeEvent(item, source));
        }
      }

      if (newEvents.length > 0) {
        writeEvents(normalizedAddress, [...newEvents.reverse(), ...allEvents].slice(0, MAX_EVENTS));
      }

      state.seen_ids = [...seenIds];
      state.seen_queue = seenQueue;
      state.last_check = utcNowIso();
      writeState(normalizedAddress, state);
    } catch (error) {
      appendError(normalizedAddress, error instanceof Error ? error.message : "Unknown polling error");
    }
  };

  const initialDelay = Math.floor(Math.random() * POLL_JITTER_MS);
  const startPolling = () => {
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS + Math.floor(Math.random() * POLL_JITTER_MS));
    runtimes.set(normalizedAddress, { timer, state, tick });
  };

  if (initialDelay <= 0) {
    startPolling();
    return;
  }

  const bootstrapTimer = setTimeout(startPolling, initialDelay);
  runtimes.set(normalizedAddress, {
    timer: bootstrapTimer,
    state,
    tick,
  });
};

const refreshWalletNow = async (address: string) => {
  const normalizedAddress = normalizeWallet(address);
  if (!normalizedAddress) return;
  startTracker(normalizedAddress);
  const runtime = runtimes.get(normalizedAddress);
  if (!runtime) return;
  await runtime.tick();
};

const stopTracker = (address: string) => {
  const normalizedAddress = normalizeWallet(address);
  const runtime = runtimes.get(normalizedAddress);
  if (!runtime) return;
  clearInterval(runtime.timer);
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
    void upsertDefaultWebhook();
    if (!webhookHealthTimer) {
      webhookHealthTimer = setInterval(() => {
        void monitorWebhookHealth();
      }, WEBHOOK_HEALTHCHECK_MS);
    }

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
          const parsed = await readJsonBody<{ address?: string; webhookId?: string }>(req);
          const address = normalizeWallet(parsed.address ?? "");
          if (!address) {
            sendJson(400, { error: "address is required" });
            return;
          }

          startTracker(address);

          const webhookId = (parsed.webhookId ?? DEFAULT_WEBHOOK_ID).trim() || DEFAULT_WEBHOOK_ID;
          const configs = readWebhookConfigs();
          const selected = configs.find((item) => item.id === webhookId);
          if (selected) {
            const walletSet = new Set(selected.walletAddresses.map((item) => normalizeWallet(item)));
            walletSet.add(address);
            selected.walletAddresses = [...walletSet];
            selected.updatedAt = utcNowIso();
            writeWebhookConfigs(configs);
            if (selected.id === DEFAULT_WEBHOOK_ID) {
              await upsertDefaultWebhook();
            }
          }

          sendJson(200, { ok: true, address, storagePath: walletDir(address) });
          return;
        }

        if (req.method === "GET" && req.url === "/api/tracker/webhooks") {
          const hooks = await upsertDefaultWebhook();
          const configs = readWebhookConfigs().map((hook) => ({
            ...hook,
            walletCount: hook.walletAddresses.length,
          }));
          sendJson(200, {
            webhooks: configs,
            defaultWebhookId: hooks.id,
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

        if (req.method === "POST" && req.url === CALLBACK_PATH) {
          const payload = await readJsonBody<Record<string, unknown>>(req);
          const incomingWebhookId = parsePotentialWebhookId(payload);
          const configs = readWebhookConfigs();
          let selected = configs.find((item) => item.id === DEFAULT_WEBHOOK_ID);

          if (incomingWebhookId) {
            selected = configs.find((item) => item.id === incomingWebhookId || item.alchemyWebhookId === incomingWebhookId) ?? selected;
          }

          if (!selected) {
            selected = await upsertDefaultWebhook();
          }

          selected.lastWebhookAt = utcNowIso();
          selected.status = "active";
          selected.warning = undefined;
          selected.updatedAt = utcNowIso();
          if (incomingWebhookId && selected.alchemyWebhookId !== incomingWebhookId) {
            selected.alchemyWebhookId = incomingWebhookId;
          }

          const withoutSelected = configs.filter((item) => item.id !== selected?.id);
          writeWebhookConfigs([...withoutSelected, selected]);
          await Promise.all(selected.walletAddresses.map((address) => refreshWalletNow(address)));

          sendJson(200, {
            ok: true,
            webhookId: selected.id,
            refreshedWallets: selected.walletAddresses,
          });
          return;
        }

        if (req.method === "DELETE" && req.url?.startsWith("/api/tracker/")) {
          const address = normalizeWallet(req.url.replace("/api/tracker/", "").split("?")[0]);
          stopTracker(address);
          const configs = readWebhookConfigs();
          for (const hook of configs) {
            hook.walletAddresses = hook.walletAddresses.filter((wallet) => normalizeWallet(wallet) !== address);
            hook.updatedAt = utcNowIso();
          }
          writeWebhookConfigs(configs);
          await upsertDefaultWebhook();
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
