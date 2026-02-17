# Polymarket Insights Hub

## Local development

```bash
npm install
npm run dev
```

- Frontend: Vite dev server
- API: Vite middleware üzerinden `/api/tracker/*`

## Production (Render) deployment

Bu projede production için Vite dev server kullanılmaz.

```bash
npm run build
npm start
```

- `npm run build` ile `dist/` oluşturulur.
- `npm start` ile `server.js` çalışır.
- `server.js` hem `dist/` dosyalarını serve eder hem `/api/tracker/*` endpoint'lerini çalıştırır.

## Required Environment Variables

- `OPENAI_API_KEY` (zorunlu, `/api/tracker/copytrade-advisor` için)
- `PORT` (opsiyonel, Render tarafından otomatik verilir)

## Render ayarları (Build & Start commands)

### En güvenli yöntem (önerilen): `render.yaml` kullan

Repo içinde `render.yaml` hazır gelir. Render üzerinde **New + > Blueprint** ile bu dosyadan servis oluştur.

Bu şekilde otomatik olarak:
- **Build Command:** `npm install --include=dev && npm run build`
- **Start Command:** `npm start`
- **Node Version:** `20`

### Elle oluşturacaksan

Render > Web Service ayarlarına şunları gir:
- **Build Command:** `npm install --include=dev && npm run build`
- **Start Command:** `npm start`
- **Node Version (öneri):** `20.x` (veya en az `18+`)
- **Environment Variable:** `OPENAI_API_KEY=...`

## Render hata notu (`vite: not found`)

Eğer log’da `sh: 1: vite: not found` görürsen, build aşamasında devDependencies kurulmamıştır.

Çözüm:
- Build komutunu mutlaka `npm install --include=dev && npm run build` yap.
- Sonra yeni deploy başlat.

## Free plan notu

- Render Free plan servisleri boşta kaldığında spin-down yapar.
- İlk istekte cold start gecikmesi olabilir.

## Dosya yapısı açıklaması

- `src/`: React + TypeScript frontend
- `vite.config.ts`: Local development ayarları ve dev middleware API
- `server.js`: Production HTTP server (SPA serve + `/api/tracker/*`)
- `render.yaml`: Render blueprint (build/start/env ayarları)
- `polymarket_profile_extract.py`: Tracker profile çıkarımı için Python script
- `tracked_wallets/`: Takip verilerinin runtime yazıldığı klasör

## tracked_wallets klasörü hakkında not

`tracked_wallets/` klasörü runtime'da otomatik oluşturulur ve wallet bazlı dosyaları yazar:

```txt
tracked_wallets/<wallet_address>/
  - events.ndjson
  - state.json
  - errors.log
```

Production'da bu klasör sunucu dosya sistemi üzerinde yazılabilir olmalıdır.
