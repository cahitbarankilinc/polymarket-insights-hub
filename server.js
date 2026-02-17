import { createServer } from "http";
import path from "path";
import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLL_INTERVAL_MS = 1000;
const MAX_EVENTS = 5000;
const ACTIVITY_URL = "https://data-api.polymarket.com/activity";
const TRADES_URL = "https://data-api.polymarket.com/trades";
const TRACKING_ROOT = path.resolve(process.cwd(), "tracked_wallets");
const PROFILE_SCRIPT_PATH = path.resolve(process.cwd(), "polymarket_profile_extract.py");
const OPENAI_MODEL = "gpt-5-mini-2025-08-07";
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

const runtimes = new Map();
const quoteCache = new Map();
const QUOTE_TTL_MS = 1500;

const utcNowIso = () => new Date().toISOString();
const toFloat = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const normalizeWallet = (address) => address.trim().toLowerCase();
const toTimestampMs = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? (value > 1e12 ? value : value * 1000) : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? (numeric > 1e12 ? numeric : numeric * 1000) : null;
    }
    const parsed = new Date(trimmed).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};
const walletDir = (address) => path.join(TRACKING_ROOT, normalizeWallet(address));
const stateFile = (address) => path.join(walletDir(address), "state.json");
const eventsFile = (address) => path.join(walletDir(address), "events.ndjson");
const errorsFile = (address) => path.join(walletDir(address), "errors.log");
const ensureWalletDir = (address) => fs.mkdirSync(walletDir(address), { recursive: true });
const readState = (address) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(address), "utf-8"));
    return {
      seen_ids: Array.isArray(parsed.seen_ids) ? parsed.seen_ids : [],
      seen_queue: Array.isArray(parsed.seen_queue) ? parsed.seen_queue : [],
      last_check: typeof parsed.last_check === "string" ? parsed.last_check : null,
    };
  } catch {
    return { seen_ids: [], seen_queue: [], last_check: null };
  }
};
const writeState = (address, state) => fs.writeFileSync(stateFile(address), JSON.stringify(state, null, 2), "utf-8");
const readEvents = (address) => {
  try {
    return fs.readFileSync(eventsFile(address), "utf-8").split("\n").filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((event) => event !== null).slice(0, MAX_EVENTS);
  } catch {
    return [];
  }
};
const computeEventStats = (events) => {
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
  return { total: events.length, last24h, buyTodayUsd, sellTodayUsd };
};
const writeEvents = (address, events) => {
  const data = events.slice(0, MAX_EVENTS).map((event) => JSON.stringify(event)).join("\n");
  fs.writeFileSync(eventsFile(address), data ? `${data}\n` : "", "utf-8");
};
const appendError = (address, message) => fs.appendFileSync(errorsFile(address), `[${utcNowIso()}] ${message}\n`, "utf-8");
const generateEventId = (raw, source) => {
  const txHash = raw.transactionHash ?? raw.txHash ?? raw.hash;
  if (txHash) return String(txHash);
  return `${source}:${String(raw.timestamp ?? raw.createdAt ?? raw.time ?? raw.eventTime)}|${String(raw.question ?? raw.slug ?? raw.market ?? raw.marketId)}|${String(raw.side ?? raw.action ?? "")}|${String(raw.size ?? raw.amount ?? raw.shares ?? "")}`;
};
const normalizeEvent = (raw, source) => {
  const price = toFloat(raw.price ?? raw.avgPrice);
  const size = toFloat(raw.size ?? raw.amount ?? raw.shares);
  const valueFromEvent = toFloat(raw.value ?? raw.valueUSD);
  const normalizedEventTime = toTimestampMs(raw.timestamp ?? raw.createdAt ?? raw.time ?? raw.eventTime);
  return {
    seen_at_utc: utcNowIso(), event_time: normalizedEventTime === null ? null : new Date(normalizedEventTime).toISOString(),
    type: raw.type ?? raw.eventType ?? (source === "trades" ? "TRADE" : null), side: raw.side ?? raw.action ?? null,
    market: raw.question ?? raw.slug ?? raw.market ?? raw.marketId ?? null, market_slug: raw.slug ?? raw.marketSlug ?? raw.market_slug ?? null,
    outcome: raw.outcome ?? raw.outcomeName ?? raw.token ?? null, asset_id: raw.asset_id ?? raw.assetId ?? raw.tokenId ?? raw.token_id ?? null,
    price, size, value_usd: valueFromEvent ?? (price !== null && size !== null ? Number((price * size).toFixed(6)) : null),
    tx_hash: raw.transactionHash ?? raw.txHash ?? raw.hash ?? null, raw_source: source,
  };
};
const maybeJson = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || typeof value === "object" || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}")))) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
};
const normalizeToken = (value) => value.trim().toLowerCase();
const resolveQuoteFromMarket = async (marketSlug, outcome) => {
  const marketResponse = await fetch(`https://gamma-api.polymarket.com/markets/slug/${encodeURIComponent(marketSlug)}`, { cache: "no-store" });
  if (!marketResponse.ok) return null;
  const marketPayload = await marketResponse.json();
  const tokenIds = maybeJson(marketPayload.clobTokenIds);
  const outcomes = maybeJson(marketPayload.outcomes);
  if (!Array.isArray(tokenIds) || !tokenIds.length || !Array.isArray(outcomes) || !outcomes.length) return null;
  const normalizedOutcome = normalizeToken(outcome);
  let outcomeIndex = outcomes.findIndex((candidate) => normalizeToken(String(candidate)) === normalizedOutcome);
  if (outcomeIndex === -1) outcomeIndex = outcomes.findIndex((candidate) => normalizeToken(String(candidate)).includes(normalizedOutcome));
  if (outcomeIndex === -1 || outcomeIndex >= tokenIds.length) return null;
  const assetId = String(tokenIds[outcomeIndex]);
  const bookResponse = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(assetId)}`, { cache: "no-store" });
  if (!bookResponse.ok) return null;
  const bookPayload = await bookResponse.json();
  const bids = Array.isArray(bookPayload.bids) ? bookPayload.bids : [];
  const asks = Array.isArray(bookPayload.asks) ? bookPayload.asks : [];
  const bidPrices = bids.map((row) => (row && typeof row === "object" ? toFloat(row.price) : null)).filter((price) => typeof price === "number");
  const askPrices = asks.map((row) => (row && typeof row === "object" ? toFloat(row.price) : null)).filter((price) => typeof price === "number");
  const bid = bidPrices.length ? Math.max(...bidPrices) : null;
  const ask = askPrices.length ? Math.min(...askPrices) : null;
  return { market: marketSlug, outcome, assetId, bid, ask, bidCents: bid === null ? null : Number((bid * 100).toFixed(4)), askCents: ask === null ? null : Number((ask * 100).toFixed(4)) };
};
const getLiveQuote = async (marketSlug, outcome) => {
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
const resolveProfileFromUrl = (profileUrl) => {
  const safeUrl = profileUrl.trim();
  if (!safeUrl) throw new Error("profileUrl is required");
  let lastError = "Python command failed";
  for (const bin of ["python3", "python"]) {
    const result = spawnSync(bin, [PROFILE_SCRIPT_PATH, safeUrl], { encoding: "utf-8" });
    if (result.error) { lastError = result.error.message; continue; }
    if (result.status !== 0) { lastError = (result.stderr || result.stdout || `${bin} exited with ${result.status}`).trim(); continue; }
    const output = result.stdout.trim();
    if (!output) throw new Error("Profil scripti boş cevap döndü");
    const parsed = JSON.parse(output);
    const proxyWallet = typeof parsed.proxyWallet === "string" ? normalizeWallet(parsed.proxyWallet) : "";
    if (!proxyWallet) throw new Error("Profil çıktısında proxyWallet bulunamadı");
    return { ...parsed, proxyWallet };
  }
  throw new Error(lastError);
};
const fetchEndpoint = async (url, address) => {
  const response = await fetch(`${url}?user=${address}&limit=50&offset=0&_=${Date.now()}`, { cache: "no-store", headers: { "cache-control": "no-cache", pragma: "no-cache" } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  const payload = await response.json();
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const key of ["data", "activities", "trades", "activity"]) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  return [];
};
const startTracker = (address) => {
  const normalizedAddress = normalizeWallet(address);
  if (!normalizedAddress || runtimes.has(normalizedAddress)) return;
  ensureWalletDir(normalizedAddress);
  const state = readState(normalizedAddress);
  let active = true;
  let timeout = null;
  const tick = async () => {
    const startedAt = Date.now();
    const allEvents = readEvents(normalizedAddress);
    const seenIds = new Set(state.seen_ids);
    const seenQueue = [...state.seen_queue];
    try {
      const [activity, trades] = await Promise.all([fetchEndpoint(ACTIVITY_URL, normalizedAddress), fetchEndpoint(TRADES_URL, normalizedAddress)]);
      const newEvents = [];
      for (const [payload, source] of [[activity, "activity"], [trades, "trades"]]) {
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
      if (newEvents.length) writeEvents(normalizedAddress, [...newEvents.reverse(), ...allEvents].slice(0, MAX_EVENTS));
      if (!active) return;
      state.seen_ids = [...seenIds];
      state.seen_queue = seenQueue;
      state.last_check = utcNowIso();
      writeState(normalizedAddress, state);
    } catch (error) {
      appendError(normalizedAddress, error instanceof Error ? error.message : "Unknown polling error");
    } finally {
      if (!active) return;
      timeout = setTimeout(() => { void tick(); }, Math.max(0, POLL_INTERVAL_MS - (Date.now() - startedAt)));
    }
  };
  void tick();
  runtimes.set(normalizedAddress, { stop: () => { active = false; if (timeout) clearTimeout(timeout); } });
};
const stopTracker = (address) => {
  const runtime = runtimes.get(normalizeWallet(address));
  if (!runtime) return;
  runtime.stop();
  runtimes.delete(normalizeWallet(address));
};
const extractResponseText = (payload) => {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (Array.isArray(payload.output)) {
    const textChunks = [];
    for (const item of payload.output) {
      if (!item || typeof item !== "object" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && typeof part === "object" && typeof part.text === "string") textChunks.push(part.text);
      }
    }
    if (textChunks.length) return textChunks.join("\n").trim();
  }
  return "Model boş yanıt döndürdü.";
};
const readJsonBody = async (req) => {
  let rawBody = "";
  await new Promise((resolve) => {
    req.on("data", (chunk) => { rawBody += chunk.toString(); });
    req.on("end", resolve);
  });
  return rawBody ? JSON.parse(rawBody) : {};
};
const sendJson = (res, code, payload) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
};
const handleApi = async (req, res, pathname, searchParams) => {
  try {
    if (req.method === "POST" && pathname === "/api/tracker/profile") {
      const parsed = await readJsonBody(req);
      sendJson(res, 200, resolveProfileFromUrl(parsed.profileUrl ?? ""));
      return;
    }
    if (req.method === "POST" && pathname === "/api/tracker/start") {
      const parsed = await readJsonBody(req);
      const address = normalizeWallet(parsed.address ?? "");
      if (!address) return sendJson(res, 400, { error: "address is required" });
      startTracker(address);
      sendJson(res, 200, { ok: true, address, storagePath: walletDir(address) });
      return;
    }
    if (req.method === "GET" && pathname === "/api/tracker/list") {
      const wallets = fs.readdirSync(TRACKING_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
        const address = entry.name;
        const events = readEvents(address);
        const state = readState(address);
        return { address, eventCount: events.length, latestEvent: events[0] ?? null, lastCheck: state.last_check, isActive: runtimes.has(address), storagePath: walletDir(address) };
      });
      sendJson(res, 200, { wallets });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/api/tracker/events/")) {
      const address = normalizeWallet(pathname.replace("/api/tracker/events/", ""));
      const events = readEvents(address);
      sendJson(res, 200, { address, events, stats: computeEventStats(events) });
      return;
    }
    if (req.method === "GET" && pathname === "/api/tracker/quote") {
      const market = searchParams.get("market") ?? "";
      const outcome = searchParams.get("outcome") ?? "";
      if (!market || !outcome) return sendJson(res, 400, { error: "market and outcome are required" });
      const quote = await getLiveQuote(market, outcome);
      if (!quote) return sendJson(res, 404, { error: "quote could not be resolved" });
      sendJson(res, 200, quote);
      return;
    }
    if (req.method === "POST" && pathname === "/api/tracker/copytrade-advisor") {
      const parsed = await readJsonBody(req);
      const context = typeof parsed.context === "string" ? parsed.context.trim() : "";
      if (!context) return sendJson(res, 400, { error: "context is required" });
      const openAiApiKey = process.env.OPENAI_API_KEY;
      if (!openAiApiKey) return sendJson(res, 500, { error: "OPENAI_API_KEY is required" });
      const userPrompt = `Bütçem yaklaşık $100.\n\nAşağıdaki veri bir Polymarket kullanıcısının trade/aktivite geçmişidir. \nBu trader’ı kopyalamayı planlıyorum. Sadece istenen formatta, kısa çıktı üret.\n\nVERİLER:\n${context}`;
      const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openAiApiKey}` },
        body: JSON.stringify({ model: OPENAI_MODEL, instructions: OPENAI_SYSTEM_INSTRUCTIONS, input: userPrompt }),
      });
      if (!openAiResponse.ok) {
        const errorText = await openAiResponse.text();
        return sendJson(res, openAiResponse.status, { error: errorText || "OpenAI request failed" });
      }
      const payload = await openAiResponse.json();
      sendJson(res, 200, { model: OPENAI_MODEL, analysis: extractResponseText(payload) });
      return;
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/tracker/")) {
      const address = normalizeWallet(pathname.replace("/api/tracker/", ""));
      stopTracker(address);
      sendJson(res, 200, { ok: true, address });
      return;
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Server error" });
  }
};

fs.mkdirSync(TRACKING_ROOT, { recursive: true });
const distPath = path.resolve(__dirname, "dist");
const mimeTypes = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname.startsWith("/api/tracker")) {
    await handleApi(req, res, pathname, requestUrl.searchParams);
    return;
  }

  const safePath = path.normalize(pathname).replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(distPath, safePath === "/" ? "index.html" : safePath);
  const exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  const target = exists ? filePath : path.join(distPath, "index.html");

  if (!fs.existsSync(target)) {
    res.statusCode = 503;
    res.end("Build output not found. Run npm run build first.");
    return;
  }

  const ext = path.extname(target).toLowerCase();
  res.setHeader("Content-Type", mimeTypes[ext] ?? "application/octet-stream");
  fs.createReadStream(target).pipe(res);
}).listen(Number(process.env.PORT) || 8080, "0.0.0.0", () => {
  console.log(`Server running on port ${Number(process.env.PORT) || 8080}`);
});
