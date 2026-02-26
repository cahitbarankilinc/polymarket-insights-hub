# Polymarket Insights Hub

Polymarket takip ve analiz uygulamasının masaüstü (Electron) sürümüdür. Amaç, terminal kullanmadan Windows/macOS üzerinde kurulup açılabilen tek-parça kurulum deneyimi sunmaktır.

## Son kullanıcı kurulumu

### Windows
1. GitHub Releases sayfasından `Polymarket Insights Hub Setup x.y.z.exe` (veya `.msi`) dosyasını indirin.
2. Kurulumu çift tıklayarak başlatın.
3. Kurulum tamamlandıktan sonra uygulamayı Başlat menüsünden açın.

### macOS
1. GitHub Releases sayfasından `Polymarket Insights Hub-x.y.z.dmg` dosyasını indirin.
2. DMG dosyasını açın ve uygulamayı `Applications` klasörüne sürükleyin.
3. Uygulamayı Launchpad/Applications içinden açın.

> İlk açılışta scraper fonksiyonları için sistemde **Python 3** gerekir. Python yoksa uygulama anlaşılır bir hata mesajı döndürür.

## Geliştirici build alma

### Gereksinimler
- Node.js 20+
- npm
- Python 3 (profile/trade scraper için)

### Local geliştirme (web + API + Electron)
```bash
npm install
npm run app:dev
```

Bu komut şunları birlikte çalıştırır:
- Node backend (`server/index.mjs`)
- Vite frontend (`localhost:8080`)
- Electron shell

### Üretim build
```bash
npm run app:build
```

### Paketleme
```bash
# Windows installer/artifact
npm run app:dist:win

# macOS dmg/app artifact
npm run app:dist:mac
```

Artifact çıktıları `release/` klasörüne yazılır.

## Mimari

- `server/trackerServer.mjs`: Vite middleware içindeki `/api/tracker/*` endpointlerinin production-ready Node backend karşılığı.
- `desktop/main.mjs`: Electron ana süreç. Uygulama açılırken backend’i ayağa kaldırır ve frontend’i yükler.
- `src/lib/polymarketTrackerApi.ts`: API çağrıları `VITE_API_BASE_URL` + relative route mantığıyla dev/prod uyumlu hale getirildi.

## Veri kalıcılığı

Desktop build’de takip verileri proje klasörüne değil, işletim sisteminin kullanıcı data dizinine yazılır:
- `tracked_wallets/`
- `tracked_profiles/`

Klasörler yoksa uygulama açılışında otomatik oluşturulur.

## Güvenlik / konfigurasyon

- `OPENAI_API_KEY` hardcoded değildir.
- `POST /api/tracker/copytrade-advisor` endpoint’i key yoksa kullanıcı dostu hata döner.
- Ortam değişkenleri:
  - `OPENAI_API_KEY`
  - `SERVER_PORT` (varsayılan: `8787`)
  - `POLYMARKET_DATA_DIR` (local server çalıştırırken)
  - `VITE_API_BASE_URL` (opsiyonel)

## Python scraper stratejisi

Bu repo şu an **sistem Python** stratejisi kullanır:
1. `python3`, sonra `python` komutu denenir.
2. İkisi de yoksa: “Python bulunamadı. Lütfen Python 3 kurup uygulamayı yeniden başlatın.”
3. Script runtime hatalarında hata metni sadeleştirilerek API cevabına döner.

## CI/CD (opsiyonel ama hazır)

GitHub Actions workflow (`.github/workflows/desktop-release.yml`) ile:
- Ubuntu: lint/test/build
- Windows: `app:dist:win`
- macOS: `app:dist:mac`
- Üretilen artifactler workflow çıktısı olarak yüklenir.
