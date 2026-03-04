import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright


BALANCE_SELECTOR = "#__next > div > div.bg-\\(--color-background\\) > nav > div.max-w-\\[1350px\\].w-full.py-3.pb-1.md\\:pb-2.z-\\[31\\].flex.gap-4.mx-auto.items-center.px-4.lg\\:px-6.justify-between.md\\:min-h-\\[68px\\] > div.shrink.min-w-0.md\\:shrink-0.md\\:min-w-fit > div > div.flex.items-center.gap-x-2.min-w-0 > div > a.text-inherit.\\[-webkit-tap-highlight-color\\:rgba\\(0\\,0\\,0\\,0\\.2\\)\\] > button > p"

TABLE_CONTAINER_SELECTOR = "#__pm_layout > div > div.flex.flex-col > div > div.min-h-screen > div > div > div.bg-background.relative"
ROW_SELECTOR = f"{TABLE_CONTAINER_SELECTOR} div[data-index]"


LOGIN_UI_RETRY_LIMIT = 4
LOGIN_UI_RETRY_WAIT_MS = 4000
LOGIN_CONFIRM_TIMEOUT_MS = 180000


def has_auth_cta(page) -> bool:
    ctas = page.get_by_role("button", name=re.compile(r"Log In|Sign In|Sign Up", re.IGNORECASE))
    return ctas.count() > 0 and ctas.first.is_visible()


def wait_for_auth_ui(page, max_wait_ms: int = 25000) -> str:
    """Polymarket auth UI skeleton durumda kalırsa sonsuza dek beklemeyi engeller."""
    for attempt in range(LOGIN_UI_RETRY_LIMIT):
        try:
            page.wait_for_load_state("domcontentloaded", timeout=max_wait_ms)
        except Exception:
            pass

        waited = 0
        while waited < max_wait_ms:
            if is_logged_in(page):
                return "logged_in"
            if has_auth_cta(page) or is_logged_out(page):
                return "logged_out"
            page.wait_for_timeout(250)
            waited += 250

        if attempt < LOGIN_UI_RETRY_LIMIT - 1:
            page.reload(wait_until="domcontentloaded")
            page.wait_for_timeout(LOGIN_UI_RETRY_WAIT_MS)

    raise RuntimeError(
        "Polymarket auth UI yüklenemedi. Chrome profil çakışması/extension engeli olabilir."
    )


def is_logged_out(page) -> bool:
    """
    Logout ise navbar'da 'Sign Up' görünür.
    Kullanıcının verdiği selector'a göre kontrol eder.
    """
    sign_up_btn = page.locator(
        "#__next > div > div.bg-\\(--color-background\\) > nav > div.max-w-\\[1350px\\].w-full.py-3.pb-1.md\\:pb-2.z-\\[31\\].flex.gap-4.mx-auto.items-center.px-4.lg\\:px-6.justify-between.md\\:min-h-\\[68px\\] > div.shrink.min-w-0.md\\:shrink-0.md\\:min-w-fit > div > div.flex.items-center.gap-x-2.min-w-0 > div > button.inline-flex.items-center.cursor-pointer.active\\:scale-\\[97\\%\\].transition.duration-150.justify-center.gap-2.whitespace-nowrap.rounded-sm.text-body-base.font-semibold.focus-visible\\:outline-none.focus-visible\\:ring-1.focus-visible\\:ring-ring.disabled\\:pointer-events-none.disabled\\:opacity-50.\\[\\&_svg\\]\\:pointer-events-none.\\[\\&_svg\\]\\:shrink-0.bg-button-primary-bg.text-button-primary-text.hover\\:bg-button-primary-bg-hover.h-9.px-4.py-2.shrink.min-w-0.md\\:shrink-0.md\\:min-w-fit > span"
    )
    if not sign_up_btn.count():
        return False

    if not sign_up_btn.first.is_visible():
        return False

    txt = (sign_up_btn.first.text_content() or "").strip()
    return txt.lower() == "sign up"


def wait_for_login_state(
    page, max_wait_ms: int = 20000, interval_ms: int = 500
) -> None:
    """
    Sayfa açıldıktan sonra login UI gecikmeli gelebiliyor.
    Bu fonksiyon, belirli süre boyunca sürekli kontrol eder.
    - 'Sign Up' üst üste birkaç kez görünürse logout kabul eder ve hata fırlatır.
    - Hiç görünmüyorsa işlem devam eder (logged-in varsayılır).
    """
    # Sayfanın JS/hydration sürecini biraz beklemek için:
    try:
        page.wait_for_load_state("networkidle", timeout=max_wait_ms)
    except Exception:
        # networkidle her zaman gelmeyebilir, sorun değil
        pass

    consecutive_logged_out = 0
    waited = 0

    while waited < max_wait_ms:
        if is_logged_out(page):
            consecutive_logged_out += 1
        else:
            consecutive_logged_out = 0

        # 3 kere üst üste logout görünüyorsa kesin logout say
        if consecutive_logged_out >= 3:
            raise RuntimeError("Logout durumundasın (navbar'da 'Sign Up' görünüyor).")

        page.wait_for_timeout(interval_ms)
        waited += interval_ms

    # max_wait dolduysa ve logout kesinleşmediyse devam


def is_logged_in(page):
    return page.evaluate(
        """
        (selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const txt = (el.textContent || '').trim();
            return /\\$\\s*\\d+(?:[.,]\\d+)?/.test(txt);
        }
        """,
        BALANCE_SELECTOR,
    )


def get_primary_page(context):
    pages = context.pages
    page = pages[0] if pages else context.new_page()
    for extra_page in context.pages[1:]:
        extra_page.close()
    return page


def build_launch_kwargs(profile_dir, chrome_user_data_dir=None, chrome_profile_name=None):
    """
    Varsayılan olarak local otomasyon profili kullanır.
    İstenirse gerçek Chrome user-data/profile ile açar (örn: Baran).
    """
    if chrome_user_data_dir:
        args = []
        if chrome_profile_name:
            args.append(f"--profile-directory={chrome_profile_name}")
        return {
            "user_data_dir": chrome_user_data_dir,
            "channel": "chrome",
            "args": args,
        }

    return {"user_data_dir": profile_dir}


def has_valid_session(
    p, profile_dir, target_url, chrome_user_data_dir=None, chrome_profile_name=None
):
    """
    Headless şekilde session kontrolü.
    Polymarket'te balance alanı geç render olabildiği için birkaç saniye boyunca tekrar dener.
    """
    launch_kwargs = build_launch_kwargs(
        profile_dir,
        chrome_user_data_dir=chrome_user_data_dir,
        chrome_profile_name=chrome_profile_name,
    )

    check_context = p.chromium.launch_persistent_context(
        **launch_kwargs,
        headless=True,  # ✅ hiç pencere açma
        viewport={"width": 1280, "height": 800},
    )
    try:
        page = get_primary_page(check_context)
        page.goto(target_url, wait_until="domcontentloaded")

        # ✅ Balance/bakiye UI bazen geç geliyor: 6 sn boyunca 200ms aralıklarla dene
        for _ in range(30):  # 30 * 200ms = 6sn
            try:
                if is_logged_in(page):
                    return True
            except Exception:
                pass
            page.wait_for_timeout(200)

        # ✅ Hâlâ değilse: muhtemelen session yok
        return False
    finally:
        try:
            check_context.close()
        except Exception:
            pass


def ensure_login(
    p, profile_dir, target_url, chrome_user_data_dir=None, chrome_profile_name=None
):
    launch_kwargs = build_launch_kwargs(
        profile_dir,
        chrome_user_data_dir=chrome_user_data_dir,
        chrome_profile_name=chrome_profile_name,
    )

    login_context = p.chromium.launch_persistent_context(
        **launch_kwargs,
        headless=False,
        viewport={"width": 1280, "height": 800},
        slow_mo=150,
    )

    page = get_primary_page(login_context)
    page.goto(target_url, wait_until="domcontentloaded")

    if wait_for_auth_ui(page) == "logged_in":
        print("Oturum zaten açık. 3 saniye sonra scraping başlayacak...")
        page.wait_for_timeout(3000)
        return login_context

    print("Oturum kapalı görünüyor. Login için yeni sekme açılıyor...")

    login_page = login_context.new_page()
    login_page.goto("https://polymarket.com/", wait_until="domcontentloaded")
    login_page.bring_to_front()
    wait_for_auth_ui(login_page)

    print(
        "Lütfen yeni açılan sekmede wallet login yapın. Login sonrası scraping aynı pencerede arka planda devam edecek."
    )

    login_page.wait_for_function(
        """
        (selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const txt = (el.textContent || '').trim();
            return /\$\s*\d+(?:[.,]\d+)?/.test(txt);
        }
        """,
        arg=BALANCE_SELECTOR,
        timeout=LOGIN_CONFIRM_TIMEOUT_MS,
    )

    try:
        login_page.close()
    except Exception:
        pass

    page.bring_to_front()
    page.goto(target_url, wait_until="domcontentloaded")

    print("Login tamam. 3 saniye sonra scraping başlayacak...")
    page.wait_for_timeout(3000)
    return login_context


def parse_polymarket_profile(
    url,
    profile_dir,
    show_browser=False,
    debug_dir=None,
    chrome_user_data_dir=None,
    chrome_profile_name=None,
):
    parsed_items = []  # ✅ sırayla kayıt için liste
    seen_keys = set()  # ✅ tekrarları engellemek için
    debug_root = Path(debug_dir) if debug_dir else None

    if debug_root:
        debug_root.mkdir(parents=True, exist_ok=True)

    def capture_debug(page, name):
        if not debug_root:
            return
        safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", name)
        target = (
            debug_root
            / f"{datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')}_{safe_name}.png"
        )
        page.screenshot(path=str(target), full_page=True)

    with sync_playwright() as p:
        print("Scrape öncesi oturum kontrolü yapılıyor...")

        # 1) Eğer session varsa direkt aç, yoksa login yaptır (aynı profil ile)
        # ✅ Varsayılan: session varsa headless (penceresiz). Sadece login yoksa pencere aç.
        session_ok = has_valid_session(
            p,
            profile_dir=profile_dir,
            target_url=url,
            chrome_user_data_dir=chrome_user_data_dir,
            chrome_profile_name=chrome_profile_name,
        )

        launch_kwargs = build_launch_kwargs(
            profile_dir,
            chrome_user_data_dir=chrome_user_data_dir,
            chrome_profile_name=chrome_profile_name,
        )

        if session_ok:
            context = p.chromium.launch_persistent_context(
                **launch_kwargs,
                headless=(not show_browser),  # --show-browser verirsen görünür
                viewport={"width": 1280, "height": 800},
            )
        else:
            # ✅ Login için görünür aç (zorunlu)
            context = ensure_login(
                p,
                profile_dir=profile_dir,
                target_url=url,
                chrome_user_data_dir=chrome_user_data_dir,
                chrome_profile_name=chrome_profile_name,
            )

            # ✅ Login tamamlandıktan sonra scraping'i penceresiz yapmak için:
            try:
                context.close()
            except Exception:
                pass

            context = p.chromium.launch_persistent_context(
                **launch_kwargs,
                headless=(not show_browser),
                viewport={"width": 1280, "height": 800},
            )

        page = get_primary_page(context)

        try:
            print(f"Sayfa yüklendi: {url}")
            page.goto(url, wait_until="domcontentloaded")

            # Login durumu geç gelebileceği için sürekli kontrol
            wait_for_login_state(page, max_wait_ms=5000, interval_ms=200)
            if not is_logged_in(page):
                raise RuntimeError("Login doğrulanamadı. Lütfen tekrar deneyin.")

            capture_debug(page, "01_loaded")

            # 1. "Closed" butonuna tıkla
            print("'Closed' sekmesine geçiliyor...")
            page.get_by_role("button", name="Closed").click()
            page.wait_for_timeout(2000)
            capture_debug(page, "02_closed_tab")

            # 2. Sort dropdown'unu bul ve tıkla
            print("Sıralama menüsü açılıyor...")
            sort_btn = (
                page.locator('button[aria-haspopup="menu"]:visible')
                .filter(has_text=re.compile(r"Value|Profit/Loss|Date", re.IGNORECASE))
                .first
            )
            sort_btn.click()
            page.wait_for_timeout(1000)
            capture_debug(page, "03_sort_menu")

            # 3. "Date" seçeneğini seç
            print("'Date' seçeneğine tıklanıyor...")
            page.get_by_role("menuitem", name="Date").click()
            page.wait_for_timeout(3000)
            capture_debug(page, "04_sorted_by_date")

            # 4. "Show more positions" butonuna tıklama döngüsü
            print("Sayfanın sonuna kadar 'Show more positions' butonları aranıyor...")
            page.mouse.move(640, 400)

            for i in range(5):

                btn = page.get_by_role(
                    "button", name=re.compile("Show more positions", re.IGNORECASE)
                )
                if btn.is_visible():
                    print(f"[{i+1}/15] Buton bulundu ve tıklanıyor...")
                    btn.click()
                    page.wait_for_timeout(1200)
                    capture_debug(page, f"05_show_more_{i+1}")
                else:
                    page.mouse.wheel(0, 1000)
                    page.wait_for_timeout(500)

                    btn = page.get_by_role(
                        "button", name=re.compile("Show more positions", re.IGNORECASE)
                    )
                    if btn.is_visible():
                        print(f"[{i+1}/15] Buton bulundu ve tıklanıyor...")
                        btn.click()
                        page.wait_for_timeout(2500)
                        capture_debug(page, f"05_show_more_scroll_{i+1}")
                    elif i > 3:
                        break

            # 5. En üste dön
            print("Tüm liste açıldı. En üste çıkılıyor...")

            # ✅ Window/body scroll kullanacağız (senin tespitine göre doğru olan bu)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(1200)
            capture_debug(page, "06_scrolled_top")

            # ✅ Satırlar bu container içinde; ama scroll window'da
            page.wait_for_selector(TABLE_CONTAINER_SELECTOR, timeout=15000)

            TARGET_COUNT = 250
            print(
                f"Toplaya toplaya kaydırma başlıyor. {TARGET_COUNT} işleme ulaşınca duracak..."
            )

            stale_rounds = 0
            prev_len = 0
            seen_fps = set()

            for step in range(2500):
                if step % 10 == 0 and is_logged_out(page):
                    raise RuntimeError(
                        "Scrape sırasında logout oldun (Sign Up göründü)."
                    )

                # ✅ O AN ekranda render edilmiş satırları çek
                row_locs = page.locator(ROW_SELECTOR)
                row_count = row_locs.count()

                for i in range(row_count):
                    row_loc = row_locs.nth(i)
                    try:
                        text = (row_loc.inner_text() or "").strip()
                        if not text:
                            continue

                        # fingerprint (virtualization aynı satırları tekrar gösterebilir)
                        fp = text[:220]
                        if fp in seen_fps:
                            continue
                        seen_fps.add(fp)

                        # --- senin eski parse kuralların ---
                        title_link = row_loc.locator("a:has(h2), a:has(p)")
                        if title_link.count() > 0:
                            a0 = title_link.first
                            href = a0.get_attribute("href") or ""
                            title = (a0.inner_text() or "").strip()
                        else:
                            href = ""
                            title = ""

                        result_m = re.search(r"\b(Won|Lost)\b", text, re.IGNORECASE)
                        if not result_m:
                            continue
                        result_text = result_m.group(1).capitalize()

                        detail_m = re.search(
                            r"([\d,\.]+)\s+(.*?)\s+at\s+([\d,\.]+)¢", text
                        )
                        if not detail_m:
                            continue
                        couldwon = float(detail_m.group(1).replace(",", ""))
                        outcome = detail_m.group(2).strip()
                        cent = float(detail_m.group(3).replace(",", ""))

                        money_vals = re.findall(r"\$-?[\d,]+\.\d{2}", text)
                        top_text = money_vals[0] if len(money_vals) > 0 else "$0.00"
                        bottom_text = money_vals[1] if len(money_vals) > 1 else "$0.00"

                        top_val = float(re.sub(r"[^\d\.\-]", "", top_text) or 0.0)
                        bottom_val = float(re.sub(r"[^\d\.\-]", "", bottom_text) or 0.0)

                        pct_m = re.search(r"\(([-+]?[\d,\.]+)%\)", text)
                        percent_val = (
                            float(pct_m.group(1).replace(",", "")) if pct_m else 0.0
                        )

                        if result_text == "Lost":
                            closed_won = top_val
                            closed_pnl = (
                                -abs(bottom_val) if bottom_val > 0 else bottom_val
                            )
                        else:
                            closed_won = top_val
                            closed_pnl = bottom_val

                        # ✅ key: fp hash (data-index güvenilmez/tekrar edebilir)
                        key = hash(fp)
                        if key in seen_keys:
                            continue
                        seen_keys.add(key)

                        parsed_items.append(
                            {
                                "closed_market": title or href,
                                "closed_href": href,
                                "closed_result": result_text,
                                "closed_couldwon": couldwon,
                                "closed_outcome": outcome,
                                "closed_cent": cent,
                                "closed_won": closed_won,
                                "closed_pnl": closed_pnl,
                                "closed_procent": percent_val,
                            }
                        )

                    except Exception:
                        pass

                # ✅ hedefe ulaştıysak dur
                if len(parsed_items) >= TARGET_COUNT:
                    print(f"Hedefe ulaşıldı: {len(parsed_items)} işlem toplandı.")
                    break

                # ✅ yeni kayıt gelmiyor mu kontrol
                if len(parsed_items) == prev_len:
                    stale_rounds += 1
                else:
                    stale_rounds = 0
                prev_len = len(parsed_items)

                if stale_rounds >= 40:
                    print(
                        f"Yeni satır gelmiyor. Toplam {len(parsed_items)} işlemde duruldu."
                    )
                    break

                # ✅ Window scroll: footer'a “değmeden” azıcık aşağı in
                # (senin dediğin: footer'a gelince içerik yükleniyor; o yüzden küçük adımlarla)
                prev_y = page.evaluate("window.scrollY")
                page.evaluate(
                    "window.scrollBy(0, Math.floor(window.innerHeight * 0.6))"
                )

                # Scroll ilerlemesini kısa süre bekle
                try:
                    page.wait_for_function(
                        "(prev) => window.scrollY > prev", arg=prev_y, timeout=1500
                    )
                except Exception:
                    pass

                # yeni satırların render olması için kısa bekleme
                page.wait_for_timeout(500)

        except Exception as e:
            print(f"İşlem sırasında hata oluştu: {e}")
            try:
                capture_debug(page, "99_error_state")
            except Exception:
                pass

        finally:
            try:
                capture_debug(page, "98_before_close")
            except Exception:
                pass
            context.close()

    return json.dumps(parsed_items, indent=4, ensure_ascii=False)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument(
        "--show-browser",
        action="store_true",
        help="Playwright browser penceresini görünür açar",
    )
    parser.add_argument(
        "--debug-dir",
        default="",
        help="Adım adım ekran görüntülerinin yazılacağı klasör",
    )
    parser.add_argument(
        "--profile-dir",
        default="",
        help="Kalıcı Chrome profil klasörü. Boş bırakılırsa ./browser_profiles/<username> kullanılır",
    )
    parser.add_argument(
        "--chrome-user-data-dir",
        default=os.environ.get("POLYMARKET_CHROME_USER_DATA_DIR", ""),
        help="Gerçek Chrome user data dizini (örn ~/.config/google-chrome)",
    )
    parser.add_argument(
        "--chrome-profile-name",
        default=os.environ.get("POLYMARKET_CHROME_PROFILE_NAME", "Baran"),
        help="Chrome profil adı (örn: Baran, Default, Profile 1)",
    )
    return parser.parse_args()


# ÇALIŞTIRMA KISMI
if __name__ == "__main__":
    args = parse_args()
    input_url = args.url

    # 2. Kullanıcı adını '@' ile '?' arasından çek
    # Örneğin: https://polymarket.com/@swisstony?tab=activity -> swisstony
    username_match = re.search(r"@([^?]+)", input_url)
    if username_match:
        username = username_match.group(1).replace(
            "/", ""
        )  # Her ihtimale karşı / işaretlerini temizle
    else:
        username = "unknown_user"
        print("Uyarı: URL'den kullanıcı adı tespit edilemedi.")

    # 3. URL'nin sonunu kesin olarak "?tab=positions" olacak şekilde değiştir
    base_url = input_url.split("?")[0]  # Soru işaretinden önceki kısmı alır
    target_url = f"{base_url}?tab=positions"

    print(f"Girdiğiniz URL: {input_url}")
    print(f"Hedef URL düzenlendi: {target_url}")
    print(f"Kullanıcı adı tespit edildi: {username}")
    print("\nScraping işlemi başlıyor, Chrome açılacak ve otomasyon çalışacak...\n")

    profile_dir = args.profile_dir or str(Path("browser_profiles") / username)
    os.makedirs(profile_dir, exist_ok=True)
    print(f"Kullanılacak otomasyon profili: {profile_dir}")
    if args.chrome_user_data_dir:
        print(
            f"Gerçek Chrome profili kullanılacak: user_data_dir={args.chrome_user_data_dir}, profile={args.chrome_profile_name}"
        )

    # Kodu çalıştır
    json_data = parse_polymarket_profile(
        target_url,
        profile_dir=profile_dir,
        show_browser=args.show_browser,
        debug_dir=args.debug_dir or None,
        chrome_user_data_dir=args.chrome_user_data_dir or None,
        chrome_profile_name=args.chrome_profile_name or None,
    )

    data_list = json.loads(json_data)
    print(
        f"\n--- BAŞARILI: EKSİKSİZ OLARAK TOPLAM {len(data_list)} İŞLEM ÇEKİLDİ ---\n"
    )

    # 4. Verileri kullanıcının adıyla kaydet
    filename = f"{username}_trades.json"
    with open(filename, "w", encoding="utf-8") as f:
        f.write(json_data)

    print(f"Tüm veriler '{filename}' dosyasına eksiksiz olarak kaydedildi!")
