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

### Scraper için mevcut Chrome profili kullanımı (Baran)

Wallet scrape sırasında mevcut login oturumunu kullanmak için aşağıdaki env değişkenlerini set edebilirsiniz:

```sh
export POLYMARKET_CHROME_USER_DATA_DIR="$HOME/.config/google-chrome"
export POLYMARKET_CHROME_PROFILE_NAME="Baran"
```

Bu ayar aktifken scraper login gerekiyorsa yeni bir sekme açar; login tamamlandıktan sonra scraping arka planda devam eder.
