import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { componentTagger } from "lovable-tagger";
import type { IncomingMessage } from "http";

const POLL_INTERVAL_MS = 3000;
const MAX_EVENTS = 200;
const ACTIVITY_URL = "https://data-api.polymarket.com/activity";
const TRADES_URL = "https://data-api.polymarket.com/trades";
const TRACKING_ROOT = path.resolve(process.cwd(), "tracked_wallets");
const PROFILE_SCRIPT_PATH = path.resolve(process.cwd(), "polymarket_profile_extract.py");
const OPENAI_MODEL = "gpt-5-mini-2025-08-07";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "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";
const OPENAI_SYSTEM_INSTRUCTIONS = `Sen deneyimli bir risk yöneticisi + trade analisti gibi davranan bir asistansın.
Görevin: Kullanıcının paylaştığı Polymarket trade geçmişini ve ilgili bağlamı analiz etmek ve
kullanıcının bu trader'ı KOPYALARKEN izlemesi gereken yöntemi açık ve uygulanabilir şekilde önermek.
- Özet (profil)
- Kopyalama stratejisi (en az 3 ölçekleme yöntemi + artı/eksi)
- Risk yönetimi + otomasyona uygun kural seti
- Veri eksikse belirt, varsayım yapıyorsan açıkla
Dil: Türkçe.`;

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
};

const runtimes = new Map<string, TrackerRuntime>();

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

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  runtimes.set(normalizedAddress, { timer, state });
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
Bu trader'ı kopyalamak istiyorum.

Lütfen verileri analiz et ve bana:
1) Trader davranış özeti
2) Kopyalama stratejisi (ölçekleme yöntemleri + net öneri)
3) Risk kuralları + otomasyona uygun kural seti

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
