#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import re
import sys
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

try:
    from bs4 import BeautifulSoup  # pip install beautifulsoup4
except ImportError:
    BeautifulSoup = None


DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
)


def assert_polymarket_url(url: str) -> str:
    u = urlparse(url)
    if u.scheme not in ("http", "https"):
        raise ValueError("URL http/https olmalı")
    if u.netloc != "polymarket.com":
        raise ValueError("Sadece polymarket.com kabul ediyorum")

    p = (u.path or "").lower()
    ok = (
        p.startswith("/@")
        or p.startswith("/profile/")
        or p.startswith("/en/profile/")
        or p.startswith("/de/profile/")
    )
    if not ok:
        raise ValueError("Bu URL bir kullanıcı profili gibi görünmüyor")
    return url


def http_get(url: str, timeout: int = 30) -> str:
    r = requests.get(
        url,
        headers={
            "User-Agent": DEFAULT_UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=timeout,
    )
    r.raise_for_status()
    return r.text


def extract_next_data_json(html: str) -> Dict[str, Any]:
    m = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>',
        html,
        flags=re.IGNORECASE,
    )
    if not m:
        raise ValueError("__NEXT_DATA__ script tag bulunamadı")
    raw = m.group(1).strip()
    try:
        return json.loads(raw)
    except Exception as e:
        raise ValueError(f"__NEXT_DATA__ JSON parse edilemedi: {e}")


def find_first_by_key(obj: Any, key: str) -> Any:
    stack = [obj]
    seen = set()
    while stack:
        cur = stack.pop()
        if cur is None or not isinstance(cur, (dict, list)):
            continue
        oid = id(cur)
        if oid in seen:
            continue
        seen.add(oid)

        if isinstance(cur, dict):
            if key in cur:
                return cur[key]
            stack.extend(cur.values())
        else:
            stack.extend(cur)
    return None


def find_dehydrated_queries(next_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    dehydrated = find_first_by_key(next_data, "dehydratedState")
    if isinstance(dehydrated, dict) and isinstance(dehydrated.get("queries"), list):
        return dehydrated["queries"]

    q = find_first_by_key(next_data, "queries")
    if isinstance(q, list):
        return q
    return []


def pick_query_data(queries: List[Dict[str, Any]], predicate) -> Any:
    for q in queries:
        qk = q.get("queryKey")
        if predicate(qk, q):
            state = q.get("state") or {}
            return state.get("data")
    return None


def extract_polymarket_profile(profile_url: str) -> Dict[str, Any]:
    html = http_get(profile_url)
    next_data = extract_next_data_json(html)

    queries = find_dehydrated_queries(next_data)

    username = find_first_by_key(next_data, "username")
    proxy_wallet = (
        find_first_by_key(next_data, "proxyAddress")
        or find_first_by_key(next_data, "primaryAddress")
        or find_first_by_key(next_data, "baseAddress")
        or find_first_by_key(next_data, "proxyWallet")
    )

    stats = pick_query_data(
        queries,
        lambda qk, _q: isinstance(qk, list) and len(qk) > 0 and qk[0] == "user-stats",
    )

    volume = pick_query_data(
        queries,
        lambda qk, _q: isinstance(qk, list)
        and len(qk) > 0
        and isinstance(qk[0], str)
        and "/api/profile/volume" in qk[0],
    )

    out: Dict[str, Any] = {
        "proxyWallet": proxy_wallet,
        "username": username,
    }

    if isinstance(stats, dict):
        for k in ("trades", "largestWin", "views", "joinDate"):
            out[k] = stats.get(k)

    if isinstance(volume, dict):
        for k in ("amount", "pnl", "realized", "unrealized"):
            out[k] = volume.get(k)

    return out


def extract_polygonscan_totalvals(address: str) -> Dict[str, Any]:
    url = f"https://polygonscan.com/address/{address}"
    html = http_get(url)

    items: List[Dict[str, Any]] = []
    total_sum = 0.0

    if BeautifulSoup is not None:
        soup = BeautifulSoup(html, "html.parser")
        for td in soup.select("td[data-totalval]"):
            val_attr = td.get("data-totalval")
            text = td.get_text(strip=True)

            totalval = None
            if val_attr is not None:
                try:
                    totalval = float(val_attr)
                    total_sum += totalval
                except Exception:
                    totalval = None

            items.append({"valueText": text, "valueTotalVal": totalval})
    else:
        # fallback regex
        for m in re.finditer(r'data-totalval="([^"]+)"\s*>\s*([^<]+)\s*<', html):
            val_attr = m.group(1)
            text = m.group(2).strip()
            totalval = None
            try:
                totalval = float(val_attr)
                total_sum += totalval
            except Exception:
                pass
            items.append({"valueText": text, "valueTotalVal": totalval})

    # En büyük item (varsa)
    top_text = None
    top_val = None
    for it in items:
        v = it.get("valueTotalVal")
        if isinstance(v, (int, float)):
            if top_val is None or v > top_val:
                top_val = v
                top_text = it.get("valueText")

    return {
        "polygonscanUrl": url,
        "polygonscanTotalValItems": items,
        "polygonscanTotalValSum": round(total_sum, 6),
        "polygonscanTopTotalValText": top_text,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "url",
        help='Polymarket profil linki (örn: "https://polymarket.com/@wzbbb?tab=activity")',
    )
    ap.add_argument("--pretty", action="store_true")
    args = ap.parse_args()

    profile_url = assert_polymarket_url(args.url)
    out = extract_polymarket_profile(profile_url)

    proxy = out.get("proxyWallet")
    if isinstance(proxy, str) and proxy.startswith("0x") and len(proxy) == 42:
        out.update(extract_polygonscan_totalvals(proxy))
    else:
        out["polygonscanUrl"] = None
        out["polygonscanTotalValItems"] = []
        out["polygonscanTotalValSum"] = 0.0
        out["polygonscanTopTotalValText"] = None

    # === OUTPUT FILTER ===
    REMOVE_KEYS = {
        "realized",
        "unrealized",
        "polygonscanTotalValItems",
        "polygonscanTotalValSum",
    }
    for k in REMOVE_KEYS:
        out.pop(k, None)

    if args.pretty:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
