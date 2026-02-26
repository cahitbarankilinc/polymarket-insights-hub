import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { spawn, spawnSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const POLL_INTERVAL_MS = 1000;
const MAX_RECENT_SEEN_IDS = 5000;
const ACTIVITY_URL = "https://data-api.polymarket.com/activity";
const TRADES_URL = "https://data-api.polymarket.com/trades";
const PROFILE_SCRIPT_PATH = path.resolve(projectRoot, "polymarket_profile_extract.py");
const SCRAPER_SCRIPT_PATH = path.resolve(projectRoot, "scrapernew.py");
const SCRAPER_PROFILE_DIR = (process.env.POLYMARKET_SCRAPER_PROFILE_DIR ?? path.resolve(projectRoot, "browser_profiles", "default")).trim();
const PROFILE_TRADES_REFRESH_MS = 60 * 60 * 1000;
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
const profileTradeJobs = new Map();
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
const parseProfileUsername = (profileUrl) => {
  const match = profileUrl.match(/@([^?/#]+)/i);
  return (match?.[1] ?? "unknown_user").replace(/\//g, "").toLowerCase();
};
const normalizeToken = (value) => value.trim().toLowerCase().replace(/\s+/g, " ");

const maybeJson = (value) => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) || typeof value === "object") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
};

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

const parseClosedTrade = (value) => {
  if (!value || typeof value !== "object") return null;
  const row = value;
  return {
    closed_market: typeof row.closed_market === "string" ? row.closed_market : "",
    closed_result: typeof row.closed_result === "string" ? row.closed_result : "",
    closed_outcome: typeof row.closed_outcome === "string" ? row.closed_outcome : "",
    closed_couldwon: toFloat(row.closed_couldwon) ?? 0,
    closed_cent: toFloat(row.closed_cent) ?? 0,
    closed_won: toFloat(row.closed_won) ?? 0,
    closed_pnl: toFloat(row.closed_pnl) ?? 0,
    closed_procent: toFloat(row.closed_procent) ?? 0,
  };
};

const runPythonCommand = async (args, cwd, stream = false) => {
  const candidates = ["python3", "python"];
  let commandNotFoundCount = 0;
  let lastError = "Python script failed";

  for (const bin of candidates) {
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(bin, args, { cwd, stdio: stream ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (c) => (stdout += c.toString()));
        child.stderr.on("data", (c) => (stderr += c.toString()));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) return resolve({ stdout, stderr, bin });
          reject(new Error((stderr || stdout || `${bin} exited with ${code}`).trim()));
        });
      });
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("ENOENT")) commandNotFoundCount += 1;
      lastError = msg;
    }
  }

  if (commandNotFoundCount === candidates.length) {
    throw new Error("Python bulunamadı. Lütfen Python 3 kurup uygulamayı yeniden başlatın.");
  }
  throw new Error(`Python script hatası: ${lastError}`);
};

export function createTrackerServer({ dataDir, staticDir } = {}) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  const rootDataDir = path.resolve(dataDir ?? path.resolve(projectRoot, "app_data"));
  const trackingRoot = path.join(rootDataDir, "tracked_wallets");
  const profileTradesRoot = path.join(rootDataDir, "tracked_profiles");
  fs.mkdirSync(trackingRoot, { recursive: true });
  fs.mkdirSync(profileTradesRoot, { recursive: true });

  const profileTradesPath = (username) => path.join(profileTradesRoot, `${username}_trades.json`);
  const walletDir = (address) => path.join(trackingRoot, normalizeWallet(address));
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
      return fs.readFileSync(eventsFile(address), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const appendEvents = (address, events) => {
    if (!events.length) return;
    fs.appendFileSync(eventsFile(address), `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf-8");
  };
  const appendError = (address, message) => fs.appendFileSync(errorsFile(address), `[${utcNowIso()}] ${message}\n`, "utf-8");

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

  const generateEventId = (raw, source) => {
    const txHash = raw.transactionHash ?? raw.txHash ?? raw.hash;
    if (txHash) return String(txHash);
    const eventTime = raw.timestamp ?? raw.createdAt ?? raw.time ?? raw.eventTime;
    const market = raw.question ?? raw.slug ?? raw.market ?? raw.marketId;
    const side = raw.side ?? raw.action ?? "";
    const size = raw.size ?? raw.amount ?? raw.shares ?? "";
    return `${source}:${String(eventTime)}|${String(market)}|${String(side)}|${String(size)}`;
  };

  const normalizeEvent = (raw, source) => {
    const price = toFloat(raw.price ?? raw.avgPrice);
    const size = toFloat(raw.size ?? raw.amount ?? raw.shares);
    const valueFromEvent = toFloat(raw.value ?? raw.valueUSD);
    const normalizedEventTime = toTimestampMs(raw.timestamp ?? raw.createdAt ?? raw.time ?? raw.eventTime);

    return {
      seen_at_utc: utcNowIso(),
      event_time: normalizedEventTime === null ? null : new Date(normalizedEventTime).toISOString(),
      type: raw.type ?? raw.eventType ?? (source === "trades" ? "TRADE" : null),
      side: raw.side ?? raw.action ?? null,
      market: raw.question ?? raw.slug ?? raw.market ?? raw.marketId ?? null,
      market_slug: raw.slug ?? raw.marketSlug ?? raw.market_slug ?? null,
      outcome: raw.outcome ?? raw.outcomeName ?? raw.token ?? null,
      asset_id: raw.asset_id ?? raw.assetId ?? raw.tokenId ?? raw.token_id ?? null,
      price,
      size,
      value_usd: valueFromEvent ?? (price !== null && size !== null ? Number((price * size).toFixed(6)) : null),
      tx_hash: raw.transactionHash ?? raw.txHash ?? raw.hash ?? null,
      raw_source: source,
    };
  };

  const fetchEndpoint = async (url, address) => {
    const requestTs = Date.now();
    const response = await fetch(`${url}?user=${address}&limit=50&offset=0&_=${requestTs}`, {
      cache: "no-store",
      headers: { "cache-control": "no-cache", pragma: "no-cache" },
    });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    const payload = await response.json();
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === "object") {
      for (const key of ["data", "activities", "trades", "activity"]) {
        const candidate = payload[key];
        if (Array.isArray(candidate)) return candidate;
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
      const seenIds = new Set(state.seen_ids);
      const seenQueue = [...state.seen_queue];
      try {
        const [activity, trades] = await Promise.all([
          fetchEndpoint(ACTIVITY_URL, normalizedAddress),
          fetchEndpoint(TRADES_URL, normalizedAddress),
        ]);
        const newEvents = [];
        for (const [payload, source] of [[activity, "activity"], [trades, "trades"]]) {
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
        if (newEvents.length > 0) appendEvents(normalizedAddress, newEvents.reverse());
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
        timeout = setTimeout(() => void tick(), Math.max(0, POLL_INTERVAL_MS - elapsedMs));
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

  const stopTracker = (address) => {
    const normalizedAddress = normalizeWallet(address);
    const runtime = runtimes.get(normalizedAddress);
    if (!runtime) return;
    runtime.stop();
    runtimes.delete(normalizedAddress);
  };

  const resolveProfileFromUrl = (profileUrl) => {
    const safeUrl = profileUrl.trim();
    if (!safeUrl) throw new Error("profileUrl is required");

    for (const bin of ["python3", "python"]) {
      const result = spawnSync(bin, [PROFILE_SCRIPT_PATH, safeUrl], { encoding: "utf-8" });
      if (result.error) {
        if (result.error.message.includes("ENOENT")) continue;
        throw new Error(result.error.message);
      }
      if (result.status !== 0) {
        throw new Error((result.stderr || result.stdout || `${bin} exited with ${result.status}`).trim());
      }
      const output = result.stdout.trim();
      if (!output) throw new Error("Profil scripti boş cevap döndü");
      const parsed = JSON.parse(output);
      const proxyWallet = typeof parsed.proxyWallet === "string" ? normalizeWallet(parsed.proxyWallet) : "";
      if (!proxyWallet) throw new Error("Profil çıktısında proxyWallet bulunamadı");
      return { ...parsed, proxyWallet };
    }

    throw new Error("Python bulunamadı. Lütfen Python 3 kurup tekrar deneyin.");
  };

  const readCachedProfileTrades = (username) => {
    const parsed = JSON.parse(fs.readFileSync(profileTradesPath(username), "utf-8"));
    return Array.isArray(parsed) ? parsed.map(parseClosedTrade).filter(Boolean) : [];
  };

  const runScraperForProfile = async (profileUrl) => {
    const safeUrl = profileUrl.trim();
    if (!safeUrl) throw new Error("profileUrl is required");
    const username = parseProfileUsername(safeUrl);
    const outputPath = profileTradesPath(username);

    fs.mkdirSync(SCRAPER_PROFILE_DIR, { recursive: true });
    await runPythonCommand([SCRAPER_SCRIPT_PATH, safeUrl, "--profile-dir", SCRAPER_PROFILE_DIR], projectRoot, true);

    const generatedOutputPath = path.resolve(projectRoot, `${username}_trades.json`);
    if (!fs.existsSync(generatedOutputPath)) throw new Error(`Scraper çıktısı bulunamadı: ${generatedOutputPath}`);

    fs.copyFileSync(generatedOutputPath, outputPath);
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("Scraper çıktısı geçerli bir liste değil");
    return parsed.map(parseClosedTrade).filter(Boolean);
  };

  const scheduleProfileTradesRefresh = (username, profileUrl) => {
    if (profileTradeJobs.has(username)) return;
    const job = Promise.resolve().then(async () => {
      await runScraperForProfile(profileUrl);
    }).catch(() => {
      // no-op
    }).finally(() => {
      profileTradeJobs.delete(username);
    });
    profileTradeJobs.set(username, job);
  };

  const getProfileTradesPayload = (profileUrl) => {
    const safeUrl = profileUrl.trim();
    if (!safeUrl) throw new Error("profileUrl is required");
    const username = parseProfileUsername(safeUrl);
    const targetPath = profileTradesPath(username);
    const hasFile = fs.existsSync(targetPath);
    const hasRunningJob = profileTradeJobs.has(username);

    if (!hasFile) {
      if (!hasRunningJob) scheduleProfileTradesRefresh(username, safeUrl);
      return { username, trades: [], source: "scraped", refreshedAt: null, loading: true, isRefreshing: true };
    }

    const stat = fs.statSync(targetPath);
    const stale = Date.now() - stat.mtimeMs >= PROFILE_TRADES_REFRESH_MS;
    if (stale && !hasRunningJob) scheduleProfileTradesRefresh(username, safeUrl);

    return {
      username,
      trades: readCachedProfileTrades(username),
      source: "cache",
      refreshedAt: stat.mtime.toISOString(),
      loading: false,
      isRefreshing: stale || hasRunningJob,
    };
  };

  const resolveQuoteFromMarket = async (marketSlug, outcome) => {
    const response = await fetch(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(marketSlug)}&closed=false`, { cache: "no-store" });
    if (!response.ok) return null;
    const payload = await response.json();
    if (!Array.isArray(payload) || payload.length === 0) return null;

    const tokenIds = maybeJson(payload[0].clobTokenIds);
    const outcomes = maybeJson(payload[0].outcomes);
    if (!Array.isArray(tokenIds) || !tokenIds.length || !Array.isArray(outcomes) || !outcomes.length) return null;

    const normalizedOutcome = normalizeToken(outcome);
    let outcomeIndex = outcomes.findIndex((c) => normalizeToken(String(c)) === normalizedOutcome);
    if (outcomeIndex === -1) outcomeIndex = outcomes.findIndex((c) => normalizeToken(String(c)).includes(normalizedOutcome));
    if (outcomeIndex === -1 || outcomeIndex >= tokenIds.length) return null;

    const assetId = String(tokenIds[outcomeIndex]);
    const bookResponse = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(assetId)}`, { cache: "no-store" });
    if (!bookResponse.ok) return null;

    const bookPayload = await bookResponse.json();
    const bids = Array.isArray(bookPayload.bids) ? bookPayload.bids : [];
    const asks = Array.isArray(bookPayload.asks) ? bookPayload.asks : [];

    const bidPrices = bids.map((row) => (row && typeof row === "object" ? toFloat(row.price) : null)).filter((p) => typeof p === "number");
    const askPrices = asks.map((row) => (row && typeof row === "object" ? toFloat(row.price) : null)).filter((p) => typeof p === "number");
    const bid = bidPrices.length ? Math.max(...bidPrices) : null;
    const ask = askPrices.length ? Math.min(...askPrices) : null;

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
      if (textChunks.length > 0) return textChunks.join("\n").trim();
    }
    return "Model boş yanıt döndürdü.";
  };

  app.post("/api/tracker/profile", (req, res) => {
    try {
      res.json(resolveProfileFromUrl(req.body?.profileUrl ?? ""));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Server error" });
    }
  });

  app.post("/api/tracker/start", (req, res) => {
    const address = normalizeWallet(req.body?.address ?? "");
    if (!address) return res.status(400).json({ error: "address is required" });
    startTracker(address);
    return res.json({ ok: true, address, storagePath: walletDir(address) });
  });

  app.get("/api/tracker/profile-trades", (req, res) => {
    const profileUrl = String(req.query.profileUrl ?? "");
    if (!profileUrl.trim()) return res.status(400).json({ error: "profileUrl is required" });
    try {
      const payload = getProfileTradesPayload(profileUrl);
      return res.json({ profileUrl, ...payload });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : "Server error" });
    }
  });

  app.get("/api/tracker/list", (_req, res) => {
    const wallets = fs.readdirSync(trackingRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((entry) => {
      const address = entry.name;
      const events = readEvents(address);
      const state = readState(address);
      return { address, eventCount: events.length, latestEvent: events[0] ?? null, lastCheck: state.last_check, isActive: runtimes.has(address), storagePath: walletDir(address) };
    });
    res.json({ wallets });
  });

  app.get("/api/tracker/events/:address", (req, res) => {
    const address = normalizeWallet(req.params.address ?? "");
    const events = readEvents(address);
    const stats = computeEventStats(events);
    res.json({ address, events, stats });
  });

  app.get("/api/tracker/quote", async (req, res) => {
    const market = String(req.query.market ?? "");
    const outcome = String(req.query.outcome ?? "");
    if (!market || !outcome) return res.status(400).json({ error: "market and outcome are required" });
    const quote = await getLiveQuote(market, outcome);
    if (!quote) return res.status(404).json({ error: "quote could not be resolved" });
    return res.json(quote);
  });

  app.post("/api/tracker/copytrade-advisor", async (req, res) => {
    const context = typeof req.body?.context === "string" ? req.body.context.trim() : "";
    if (!context) return res.status(400).json({ error: "context is required" });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY ayarlı değil. Ayarlardan/deployment env'den API key ekleyin.",
      });
    }

    const userPrompt = `Bütçem yaklaşık $100.\n\nAşağıdaki veri bir Polymarket kullanıcısının trade/aktivite geçmişidir.\nBu trader’ı kopyalamayı planlıyorum. Sadece istenen formatta, kısa çıktı üret.\n\nVERİLER:\n${context}`;

    const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: OPENAI_MODEL, instructions: OPENAI_SYSTEM_INSTRUCTIONS, input: userPrompt }),
    });

    if (!openAiResponse.ok) {
      const errorText = await openAiResponse.text();
      return res.status(openAiResponse.status).json({ error: errorText || "OpenAI request failed" });
    }

    const payload = await openAiResponse.json();
    return res.json({ model: OPENAI_MODEL, analysis: extractResponseText(payload) });
  });

  app.delete("/api/tracker/:address", (req, res) => {
    const address = normalizeWallet(req.params.address ?? "");
    stopTracker(address);
    res.json({ ok: true, address });
  });

  if (staticDir) {
    app.use(express.static(staticDir));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  return app;
}

export function startTrackerServer({ port = Number(process.env.SERVER_PORT ?? 8787), dataDir, staticDir } = {}) {
  const app = createTrackerServer({ dataDir, staticDir });
  return app.listen(port, "127.0.0.1", () => {
    console.log(`Tracker server running on http://127.0.0.1:${port}`);
  });
}

if (process.argv[1] === __filename) {
  startTrackerServer();
}
