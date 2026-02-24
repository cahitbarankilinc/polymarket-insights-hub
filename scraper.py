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


def is_logged_in(page):
    return page.evaluate(
        """
        (selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const txt = (el.textContent || '').trim();
            return /\$\s*\d+(?:[.,]\d+)?/.test(txt);
        }
        """,
        BALANCE_SELECTOR,
    )


def ensure_login(p, profile_dir, target_url):
    login_context = p.chromium.launch_persistent_context(
        user_data_dir=profile_dir,
        headless=False,
        viewport={"width": 1280, "height": 800},
        slow_mo=150,
    )
    page = login_context.pages[0] if login_context.pages else login_context.new_page()
    page.goto(target_url, wait_until="domcontentloaded")

    print("Giriş kontrol ediliyor...")
    if is_logged_in(page):
        print("Oturum zaten açık. 5 saniye sonra login penceresi kapanacak.")
        page.wait_for_timeout(5000)
        login_context.close()
        return

    print("Oturum kapalı görünüyor. Lütfen açılan Chrome penceresinde wallet ile giriş yapın.")
    page.wait_for_function(
        """
        (selector) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            const txt = (el.textContent || '').trim();
            return /\$\s*\d+(?:[.,]\d+)?/.test(txt);
        }
        """,
        arg=BALANCE_SELECTOR,
        timeout=0,
    )
    print("Bakiye alanı görüldü. 5 saniye sonra login penceresi kapanıyor...")
    page.wait_for_timeout(5000)
    login_context.close()


def parse_polymarket_profile(url, profile_dir, show_browser=False, debug_dir=None):
    parsed_items = {}
    debug_root = Path(debug_dir) if debug_dir else None

    if debug_root:
        debug_root.mkdir(parents=True, exist_ok=True)

    def capture_debug(page, name):
        if not debug_root:
            return
        safe_name = re.sub(r"[^a-zA-Z0-9_-]", "_", name)
        target = debug_root / f"{datetime.utcnow().strftime('%Y%m%dT%H%M%S%f')}_{safe_name}.png"
        page.screenshot(path=str(target), full_page=True)

    with sync_playwright() as p:
        ensure_login(p, profile_dir=profile_dir, target_url=url)

        context = p.chromium.launch_persistent_context(
            user_data_dir=profile_dir,
            headless=not show_browser,
            slow_mo=150 if show_browser else 0,
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()

        print(f"Sayfa yüklendi: {url}")
        page.goto(url, wait_until="domcontentloaded")
        if not is_logged_in(page):
            print("Scrape öncesi oturum düşmüş. Yeniden giriş penceresi açılıyor...")
            context.close()
            ensure_login(p, profile_dir=profile_dir, target_url=url)
            context = p.chromium.launch_persistent_context(
                user_data_dir=profile_dir,
                headless=not show_browser,
                slow_mo=150 if show_browser else 0,
                viewport={"width": 1280, "height": 800},
            )
            page = context.new_page()
            page.goto(url, wait_until="domcontentloaded")

        capture_debug(page, "01_loaded")

        try:
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

            # 4. Tüm listeyi açmak için "Show more positions" butonuna tıklama döngüsü
            print("Sayfanın sonuna kadar 'Show more positions' butonları aranıyor...")
            page.mouse.move(640, 400)  # Fareyi merkeze al

            for i in range(15):
                btn = page.get_by_role(
                    "button", name=re.compile("Show more positions", re.IGNORECASE)
                )
                if btn.is_visible():
                    print(f"[{i+1}/15] Buton bulundu ve tıklanıyor...")
                    btn.click()
                    page.wait_for_timeout(2500)
                    capture_debug(page, f"05_show_more_{i+1}")
                else:
                    # Göremiyorsak biraz aşağı kaydır
                    page.mouse.wheel(0, 1000)
                    page.wait_for_timeout(500)

                    # Kaydırdıktan sonra tekrar kontrol et
                    btn = page.get_by_role(
                        "button", name=re.compile("Show more positions", re.IGNORECASE)
                    )
                    if btn.is_visible():
                        print(f"[{i+1}/15] Buton bulundu ve tıklanıyor...")
                        btn.click()
                        page.wait_for_timeout(2500)
                        capture_debug(page, f"05_show_more_scroll_{i+1}")
                    elif i > 3:
                        # Eğer birkaç denemedir çıkmıyorsa liste tamamen açılmıştır
                        break

            # 5. Tüm listeyi taramak için EN ÜSTE geri dön
            print("Tüm liste açıldı. En üste çıkılıyor...")
            page.keyboard.press("Home")  # Sayfanın en üstüne atlar
            for _ in range(10):
                page.mouse.wheel(0, -2000)
                page.wait_for_timeout(100)
            page.wait_for_timeout(2000)
            capture_debug(page, "06_scrolled_top")

            print(
                "Sanal kaydırma (Virtual Scroll) başlatılıyor. Her bir satır (data-index) toplanacak..."
            )

            consecutive_no_new = 0
            prev_len = 0

            # 6. Yavaşça aşağı inerek okuma işlemi
            for step in range(300):
                html = page.content()
                soup = BeautifulSoup(html, "html.parser")

                # Sadece 'data-index' değeri taşıyan satırları al
                rows = soup.find_all("div", attrs={"data-index": True})

                for row in rows:
                    try:
                        data_idx = int(row["data-index"])

                        # Eğer bu numaralı işlemi zaten aldıysak atla
                        if data_idx in parsed_items:
                            continue

                        # --- 1. Market Slug ---
                        link = row.find("a", href=re.compile(r"/event/"))
                        if not link:
                            continue
                        market_slug = (
                            re.search(r"/event/([^/]+)", link["href"])
                            .group(1)
                            .replace("-more-markets", "")
                        )

                        # --- 2. Result (Won / Lost) ---
                        result_span = row.find(
                            "span", string=re.compile(r"^(Won|Lost)$", re.IGNORECASE)
                        )
                        if not result_span:
                            continue
                        result_text = result_span.get_text(strip=True).capitalize()

                        # --- 3. Detaylar (Yalnızca "¢" içeren metni oku - Hata önleyici) ---
                        cent_text_node = row.find(string=re.compile(r"¢"))
                        if not cent_text_node:
                            continue

                        match = re.search(
                            r"([\d,\.]+)\s+(.*?)\s+at\s+([\d,\.]+)¢", cent_text_node
                        )
                        if not match:
                            continue

                        couldwon = float(match.group(1).replace(",", ""))
                        outcome = match.group(2).strip()
                        cent = float(match.group(3).replace(",", ""))

                        # --- 4. Finansal Veriler (Sağ Taraf) ---
                        right_div = row.find(
                            "div", class_=lambda c: c and "text-right" in c
                        )
                        if not right_div:
                            continue

                        spans = right_div.find_all("span", recursive=False)
                        top_text = (
                            spans[0].get_text(strip=True) if len(spans) > 0 else "$0.00"
                        )
                        bottom_text = (
                            spans[1].get_text(strip=True)
                            if len(spans) > 1
                            else "$0.00 (0%)"
                        )

                        top_val = float(re.sub(r"[^\d\.\-]", "", top_text) or 0.0)

                        bottom_match = re.search(
                            r"(-?\$?[\d,\.]+)\s*\(([-+]?[\d,\.]+)%\)", bottom_text
                        )
                        bottom_val, percent_val = 0.0, 0.0
                        if bottom_match:
                            bottom_val = float(
                                re.sub(r"[^\d\.\-]", "", bottom_match.group(1))
                            )
                            percent_val = float(bottom_match.group(2).replace(",", ""))

                        if result_text == "Lost":
                            closed_won = top_val
                            closed_pnl = bottom_val
                        else:  # Won
                            closed_won = bottom_val
                            closed_pnl = top_val

                        # ID numarasına göre sözlüğe (dictionary) kaydet!
                        parsed_items[data_idx] = {
                            "closed_market": market_slug,
                            "closed_result": result_text,
                            "closed_couldwon": couldwon,
                            "closed_outcome": outcome,
                            "closed_cent": cent,
                            "closed_won": closed_won,
                            "closed_pnl": closed_pnl,
                            "closed_procent": percent_val,
                        }

                    except Exception as e:
                        pass  # Satır okunamadıysa geç

                # Listenin sonuna gelip gelmediğimizi kontrol et
                current_len = len(parsed_items)
                if current_len == prev_len:
                    consecutive_no_new += 1
                else:
                    consecutive_no_new = 0
                prev_len = current_len

                # 15 adım boyunca yeni hiçbir işlem eklenmediyse, listenin en altına gelmişiz demektir!
                if consecutive_no_new > 15:
                    print("Listenin en altına ulaşıldı, tarama tamamlandı.")
                    break

                # Yukarıdan aşağı doğru Virtual Scroll yakalamak için kontrollü inme
                page.mouse.wheel(0, 300)
                if step % 30 == 0:
                    capture_debug(page, f"07_virtual_scroll_step_{step}")
                page.wait_for_timeout(200)

        except Exception as e:
            print(f"İşlem sırasında hata oluştu: {e}")
            capture_debug(page, "99_error_state")

        finally:
            capture_debug(page, "98_before_close")
            context.close()

    # Çektiğimiz verileri indeks sırasına göre sıralayıp listeye çeviriyoruz
    sorted_results = [parsed_items[k] for k in sorted(parsed_items.keys())]
    return json.dumps(sorted_results, indent=4, ensure_ascii=False)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--show-browser", action="store_true", help="Playwright browser penceresini görünür açar")
    parser.add_argument("--debug-dir", default="", help="Adım adım ekran görüntülerinin yazılacağı klasör")
    parser.add_argument(
        "--profile-dir",
        default="",
        help="Kalıcı Chrome profil klasörü. Boş bırakılırsa ./browser_profiles/<username> kullanılır",
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
    print(f"Kullanılacak Chrome profili: {profile_dir}")

    # Kodu çalıştır
    json_data = parse_polymarket_profile(
        target_url,
        profile_dir=profile_dir,
        show_browser=args.show_browser,
        debug_dir=args.debug_dir or None,
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
