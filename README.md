## How can I edit this code?

There are several ways of editing your application.

**Use your preferred IDE**

The only requirement is having Node.js & npm installed - [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating)

Follow these steps:

```sh
# Step 1: Clone the repository using the project's Git URL.
git clone <YOUR_GIT_URL>

# Step 2: Navigate to the project directory.
cd <YOUR_PROJECT_NAME>

# Step 3: Install the necessary dependencies.
npm i

# Step 4: Start the development server with auto-reloading and an instant preview.
npm run dev
```

**Edit a file directly in GitHub**

- Navigate to the desired file(s).
- Click the "Edit" button (pencil icon) at the top right of the file view.
- Make your changes and commit the changes.

**Use GitHub Codespaces**

- Navigate to the main page of your repository.
- Click on the "Code" button (green button) near the top right.
- Select the "Codespaces" tab.
- Click on "New codespace" to launch a new Codespace environment.
- Edit files directly within the Codespace and commit and push your changes once you're done.

## What technologies are used for this project?

This project is built with:

- Vite
- TypeScript
- React
- shadcn-ui
- Tailwind CSS


## Local Polymarket tracking workflow

Bu proje artık `➕ Adres Ekle` tabından girilen **Ethereum wallet** adresleri için local takip başlatır.

- Takip başlatma endpointi: `POST /api/tracker/start`
- Takip listesi endpointi: `GET /api/tracker/list`
- Wallet event endpointi: `GET /api/tracker/events/:address`

Veriler proje kökünde bu klasöre yazılır:

```txt
tracked_wallets/<wallet_address>/
  - events.ndjson
  - state.json
  - errors.log
```

Geliştirme ortamında çalıştırmak için:

```sh
npm i
npm run dev
```

Sonra arayüzden `➕ Adres Ekle` tabında bir `0x...` adresi ekleyin; takip sonuçlarını `Takip Listesi` içinde görebilirsiniz.

## Windows 10 için hızlı sorun tespiti

Aşağıdaki adımlar özellikle `wallet verileri güncellenmiyor` ve `scraping için login penceresi açılmıyor` durumlarını ayıklamak içindir.

1. **Önce CSS uyarısını temizle**
   - `@import must precede all other statements` uyarısı kritik olmasa da derleme çıktısını kirletir.
   - Son sürümde bu sıra düzeltildi; `npm run dev` tekrar çalıştırıp bu uyarının kaybolduğunu doğrulayın.

2. **Tracker gerçekten veri çekiyor mu kontrol et**
   - Bir adres ekledikten sonra proje kökünde şu dosyaları kontrol edin:

```powershell
Get-ChildItem .\tracked_wallets
Get-Content .\tracked_wallets\<wallet>\errors.log -Tail 50
Get-Content .\tracked_wallets\<wallet>\events.ndjson -Tail 20
```

- `errors.log` içinde `HTTP 4xx/5xx` veya timeout görürseniz ağ / API erişim sorunu vardır.
- `events.ndjson` boş kalıyorsa adres için yeni activity/trade dönmüyor olabilir veya istekler engelleniyordur.

3. **Dev sunucuda API endpointlerini doğrudan test et**

```powershell
Invoke-RestMethod http://localhost:8080/api/tracker/list
Invoke-RestMethod http://localhost:8080/api/tracker/events/<wallet>
```

- `list` yanıtı dönüyor ama event sayısı artmıyorsa polling başarısız olabilir; `errors.log` ile birlikte inceleyin.

4. **Scraping login penceresi neden bazen açılmaz?**
   - `scrapernew.py` oturum zaten geçerliyse önce **headless** (görünmez) kontrol yapar.
   - Session geçerliyse ekstra login penceresi açmadan scraping'e devam eder.
   - Login penceresi ancak session geçersizse açılır.

5. **Windows'ta Playwright/Chrome doğrulaması**

```powershell
python --version
python -m pip show playwright
python -m playwright install chromium
```

- Bunlardan biri yoksa scraping tarafı sessizce başarısız olabilir.

6. **Temiz başlangıç (profil bozulduysa)**

```powershell
Remove-Item -Recurse -Force .\browser_profiles\default
npm run dev
```

- Sonraki scraping denemesinde login penceresinin yeniden açılması gerekir.

Bu adımlardan sonra hâlâ düzelmiyorsa `tracked_wallets/<wallet>/errors.log` ve terminal hatasını paylaşarak daha net kök neden analizi yapabilirsiniz.
