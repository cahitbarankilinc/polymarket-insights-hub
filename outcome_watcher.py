#!/usr/bin/env python3
"""Polymarket Outcome Watcher (market/event slug + outcome)

Goal
- Your activity feed gives: market slug + outcome label.
- Resolve that to the *single* CLOB token (asset_id) for that outcome.
- Show best bid/ask live via the public Market WebSocket.

Slug resolution strategy
1) GET Gamma market by slug
2) If that fails, GET Gamma event by slug (pick a market containing the outcome)
3) If that fails, Gamma public-search fallback

Data feed strategy
- Fetch an initial snapshot from the public CLOB REST endpoint (/book) so output isn't blank.
- Subscribe to WS events that are documented and commonly available:
  - book (initial snapshot + trade-affecting book updates)
  - price_change (best_bid / best_ask per asset)
- Some deployments may also emit level1; we parse it if present.

Usage
  python outcome_watcher.py <market_or_event_slug> <outcome>
  python outcome_watcher.py --market <slug> --outcome <outcome>
  echo '{"market":"...","outcome":"Over"}' | python outcome_watcher.py --stdin

"""

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import aiohttp
import websockets
from dateutil import parser as dtparser
from urllib.parse import quote_plus

GAMMA_MARKET_BY_SLUG = "https://gamma-api.polymarket.com/markets/slug/{slug}"
GAMMA_EVENT_BY_SLUG = "https://gamma-api.polymarket.com/events/slug/{slug}"
GAMMA_PUBLIC_SEARCH = "https://gamma-api.polymarket.com/public-search?q={q}"

# Public CLOB endpoints (no auth)
CLOB_BOOK = "https://clob.polymarket.com/book?token_id={token_id}"

# Public market websocket channel
WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"


def _maybe_json(v: Any) -> Any:
    """Gamma sometimes returns lists as JSON-encoded strings; parse when appropriate."""
    if v is None:
        return None
    if isinstance(v, (list, dict)):
        return v
    if isinstance(v, str):
        s = v.strip()
        if (s.startswith("[") and s.endswith("]")) or (s.startswith("{") and s.endswith("}")):
            try:
                return json.loads(s)
            except Exception:
                return v
    return v


def _norm(s: str) -> str:
    return " ".join(str(s).strip().lower().split())


@dataclass
class SelectedOutcome:
    market_slug: str
    title: str
    condition_id: str
    end_time: Optional[datetime]

    outcome: str
    asset_id: str
    outcome_index: int

    outcomes: List[str]
    asset_ids: List[str]


async def _get_json(session: aiohttp.ClientSession, url: str) -> Tuple[int, Any, str]:
    async with session.get(url) as resp:
        text = await resp.text()
        ctype = resp.headers.get("content-type", "")
        data = None
        if ctype.startswith("application/json"):
            try:
                data = json.loads(text)
            except Exception:
                data = None
        return resp.status, data, text


def _extract_market_fields(
    m: Dict[str, Any], default_slug: str
) -> Tuple[str, str, str, Optional[datetime], List[str], List[str]]:
    """Return (slug, title, condition_id, end_time, outcomes, asset_ids)."""
    slug = m.get("slug") or default_slug
    title = m.get("question") or m.get("title") or slug
    condition_id = m.get("conditionId") or m.get("conditionID") or m.get("condition_id") or ""

    end_date = (
        m.get("endDate")
        or m.get("endDateIso")
        or m.get("end_date")
        or m.get("endTime")
        or m.get("end_time")
    )

    end_time = None
    if end_date:
        try:
            end_time = dtparser.isoparse(end_date)
        except Exception:
            end_time = None

    token_ids = _maybe_json(m.get("clobTokenIds"))
    if not isinstance(token_ids, list):
        token_ids = []

    outcomes = _maybe_json(m.get("outcomes"))
    if isinstance(outcomes, list):
        outcomes = [str(x) for x in outcomes]
    else:
        outcomes = []

    asset_ids = [str(x) for x in token_ids]
    return slug, title, condition_id, end_time, outcomes, asset_ids


def _pick_outcome(outcomes: List[str], wanted: str) -> Optional[int]:
    wn = _norm(wanted)
    for i, o in enumerate(outcomes):
        if _norm(o) == wn:
            return i
    for i, o in enumerate(outcomes):
        if wn and wn in _norm(o):
            return i
    return None


async def fetch_selected_outcome(session: aiohttp.ClientSession, slug: str, outcome: str) -> SelectedOutcome:
    # 1) Direct market slug
    status, data, text = await _get_json(session, GAMMA_MARKET_BY_SLUG.format(slug=slug))
    if status == 200 and isinstance(data, dict):
        mslug, title, condition_id, end_time, outcomes, asset_ids = _extract_market_fields(data, slug)
        if not condition_id:
            raise RuntimeError("Gamma market response missing conditionId.")
        if not outcomes:
            outcomes = ["Yes", "No"][: len(asset_ids)]
        idx = _pick_outcome(outcomes, outcome)
        if idx is None:
            raise RuntimeError(f"Outcome '{outcome}' not found in market outcomes: {outcomes}. (market={mslug})")
        if idx >= len(asset_ids):
            raise RuntimeError(f"Outcome index {idx} has no matching asset_id (asset_ids={asset_ids}).")
        return SelectedOutcome(mslug, title, condition_id, end_time, outcomes[idx], asset_ids[idx], idx, outcomes, asset_ids)

    # 2) Event slug
    status, data, _ = await _get_json(session, GAMMA_EVENT_BY_SLUG.format(slug=slug))
    if status == 200 and isinstance(data, dict):
        markets = data.get("markets") or []
        if not isinstance(markets, list) or not markets:
            raise RuntimeError(f"Event '{slug}' has no markets.")

        # Prefer a market whose outcomes contain the wanted outcome
        for m in markets:
            if not isinstance(m, dict):
                continue
            mslug, title, condition_id, end_time, outcomes, asset_ids = _extract_market_fields(m, slug)
            if not outcomes:
                outcomes = ["Yes", "No"][: len(asset_ids)]
            idx = _pick_outcome(outcomes, outcome)
            if idx is not None and idx < len(asset_ids) and condition_id:
                return SelectedOutcome(mslug, title, condition_id, end_time, outcomes[idx], asset_ids[idx], idx, outcomes, asset_ids)

        # Fallback: first market
        m = markets[0]
        mslug, title, condition_id, end_time, outcomes, asset_ids = _extract_market_fields(m, slug)
        if not outcomes:
            outcomes = ["Yes", "No"][: len(asset_ids)]
        idx = _pick_outcome(outcomes, outcome)
        if idx is None:
            raise RuntimeError(f"Outcome '{outcome}' not found in first event market outcomes: {outcomes}.")
        if idx >= len(asset_ids):
            raise RuntimeError(f"Outcome index {idx} has no matching asset_id (asset_ids={asset_ids}).")
        return SelectedOutcome(mslug, title, condition_id, end_time, outcomes[idx], asset_ids[idx], idx, outcomes, asset_ids)

    # 3) Public search fallback
    qurl = GAMMA_PUBLIC_SEARCH.format(q=quote_plus(slug))
    status, data, text3 = await _get_json(session, qurl)
    if status == 200 and isinstance(data, dict):
        events = data.get("events") or []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            markets = ev.get("markets") or []
            if not isinstance(markets, list):
                continue
            for m in markets:
                if not isinstance(m, dict):
                    continue
                mslug, title, condition_id, end_time, outcomes, asset_ids = _extract_market_fields(m, slug)
                if _norm(mslug) != _norm(slug):
                    continue
                if not outcomes:
                    outcomes = ["Yes", "No"][: len(asset_ids)]
                idx = _pick_outcome(outcomes, outcome)
                if idx is None:
                    raise RuntimeError(f"Outcome '{outcome}' not found in market outcomes: {outcomes}.")
                if idx >= len(asset_ids):
                    raise RuntimeError(f"Outcome index {idx} has no matching asset_id (asset_ids={asset_ids}).")
                if not condition_id:
                    raise RuntimeError("Found market but missing conditionId.")
                return SelectedOutcome(mslug, title, condition_id, end_time, outcomes[idx], asset_ids[idx], idx, outcomes, asset_ids)

    detail = (text3 or text or "")[:300].replace("\n", " ")
    raise RuntimeError(
        f"Could not resolve slug='{slug}'. Tried markets/slug, events/slug, and public-search. "
        f"Last response snippet: {detail}"
    )


def _fmt_tminus(end_time: Optional[datetime]) -> str:
    if not end_time:
        return "T-??"
    now = datetime.now(timezone.utc)
    et = end_time.astimezone(timezone.utc)
    delta = et - now
    s = int(delta.total_seconds())
    if s < 0:
        return "ENDED"
    h = s // 3600
    m = (s % 3600) // 60
    sec = s % 60
    if h:
        return f"T-{h:02d}:{m:02d}:{sec:02d}"
    return f"T-{m:02d}:{sec:02d}"


async def _fetch_book_snapshot(session: aiohttp.ClientSession, token_id: str) -> Tuple[Optional[float], Optional[float]]:
    """Return (best_bid, best_ask) from /book if available."""
    status, data, _ = await _get_json(session, CLOB_BOOK.format(token_id=token_id))
    if status != 200 or not isinstance(data, dict):
        return None, None

    bids = data.get("bids") if isinstance(data.get("bids"), list) else []
    asks = data.get("asks") if isinstance(data.get("asks"), list) else []

    best_bid = None
    best_ask = None

    try:
        prices = [float(x["price"]) for x in bids if isinstance(x, dict) and x.get("price") is not None]
        best_bid = max(prices) if prices else None
    except Exception:
        best_bid = None

    try:
        prices = [float(x["price"]) for x in asks if isinstance(x, dict) and x.get("price") is not None]
        best_ask = min(prices) if prices else None
    except Exception:
        best_ask = None

    return best_bid, best_ask


async def watch(market_slug: str, outcome: str) -> None:
    # Resolve slug+outcome → asset_id
    async with aiohttp.ClientSession() as session:
        sel = await fetch_selected_outcome(session, market_slug, outcome)
        init_bid, init_ask = await _fetch_book_snapshot(session, sel.asset_id)

    print("\n✅ WATCHING (single outcome)\n")
    print(f"Market slug:   {sel.market_slug}")
    print(f"Title:        {sel.title}")
    print(f"ConditionId:  {sel.condition_id}")
    print(f"End time:     {sel.end_time.isoformat() if sel.end_time else '(unknown)'}")
    print(f"Outcome:      {sel.outcome}   (index={sel.outcome_index})")
    print(f"Asset ID:     {sel.asset_id}")
    print("\n--- live ---\n")

    # Subscriptions (documented): book + price_change
    sub_msgs = [
        {"assets_ids": [sel.asset_id], "type": "book"},
        {"assets_ids": [sel.asset_id], "type": "price_change"},
    ]

    best_bid = init_bid
    best_ask = init_ask
    last_ts: Optional[datetime] = datetime.now(timezone.utc) if (best_bid is not None or best_ask is not None) else None

    def render() -> None:
        tminus = _fmt_tminus(sel.end_time)
        bid_s = f"{best_bid*100:.1f}¢" if best_bid is not None else "—"
        ask_s = f"{best_ask*100:.1f}¢" if best_ask is not None else "—"
        age_s = ""
        if last_ts:
            age = int((datetime.now(timezone.utc) - last_ts).total_seconds())
            age_s = f" | age {age}s"
        sys.stdout.write(f"\r{tminus} | {sel.outcome}: bid {bid_s} / ask {ask_s}{age_s}     ")
        sys.stdout.flush()

    # Render initial line
    render()

    backoff = 1
    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=20, ping_timeout=20, close_timeout=5) as ws:
                for sm in sub_msgs:
                    await ws.send(json.dumps(sm))
                backoff = 1

                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                    except Exception:
                        continue

                    if not isinstance(msg, dict):
                        continue

                    mtype = msg.get("type")
                    etype = msg.get("event_type")
                    kind = etype or mtype  # normalize

                    # book message (docs use event_type)
                    if kind == "book":
                        aid = msg.get("asset_id")
                        if aid and str(aid) != str(sel.asset_id):
                            continue
                        bids = msg.get("bids") if isinstance(msg.get("bids"), list) else []
                        asks = msg.get("asks") if isinstance(msg.get("asks"), list) else []
                        try:
                            if bids:
                                best_bid = max(float(x["price"]) for x in bids if isinstance(x, dict) and x.get("price") is not None)
                        except Exception:
                            pass
                        try:
                            if asks:
                                best_ask = min(float(x["price"]) for x in asks if isinstance(x, dict) and x.get("price") is not None)
                        except Exception:
                            pass
                        last_ts = datetime.now(timezone.utc)
                        render()
                        continue

                    # price_change message (docs): has price_changes[] with best_bid/best_ask
                    if kind == "price_change":
                        pcs = msg.get("price_changes") if isinstance(msg.get("price_changes"), list) else []
                        updated = False
                        for pc in pcs:
                            if not isinstance(pc, dict):
                                continue
                            if str(pc.get("asset_id")) != str(sel.asset_id):
                                continue
                            if pc.get("best_bid") is not None:
                                try:
                                    best_bid = float(pc["best_bid"])
                                    updated = True
                                except Exception:
                                    pass
                            if pc.get("best_ask") is not None:
                                try:
                                    best_ask = float(pc["best_ask"])
                                    updated = True
                                except Exception:
                                    pass
                            if updated:
                                last_ts = datetime.now(timezone.utc)
                                render()
                            break
                        continue

                    # level1 (older / alternate deployments)
                    if kind == "level1":
                        if str(msg.get("asset_id")) != str(sel.asset_id):
                            continue
                        updated = False
                        if msg.get("bid") is not None:
                            try:
                                best_bid = float(msg["bid"])
                                updated = True
                            except Exception:
                                pass
                        if msg.get("ask") is not None:
                            try:
                                best_ask = float(msg["ask"])
                                updated = True
                            except Exception:
                                pass
                        if updated:
                            last_ts = datetime.now(timezone.utc)
                            render()
                        continue

        except KeyboardInterrupt:
            print("\n\nStopped.")
            return
        except Exception as e:
            print(f"\n⚠️ WS error: {e}  (reconnecting in {backoff}s)")
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)


def _parse_from_stdin() -> Tuple[str, str]:
    line = sys.stdin.read().strip()
    if not line:
        raise SystemExit("stdin empty. Provide a JSON object with keys: market, outcome")
    try:
        obj = json.loads(line)
    except Exception:
        raise SystemExit("stdin must be valid JSON.")
    market = obj.get("market")
    outcome = obj.get("outcome")
    if not market or not outcome:
        raise SystemExit("stdin JSON must include 'market' and 'outcome'.")
    return str(market), str(outcome)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("market", nargs="?", help="Market slug (or event slug as fallback)")
    ap.add_argument("outcome", nargs="?", help="Outcome label (e.g., Yes/No/Over/Under)")
    ap.add_argument("--market", dest="market_flag", help="Market slug")
    ap.add_argument("--outcome", dest="outcome_flag", help="Outcome label")
    ap.add_argument("--stdin", action="store_true", help="Read a single JSON object from stdin with keys: market,outcome")
    args = ap.parse_args()

    if args.stdin:
        market, outcome = _parse_from_stdin()
    else:
        market = args.market_flag or args.market
        outcome = args.outcome_flag or args.outcome

    if not market or not outcome:
        raise SystemExit("Provide market+outcome (args) or use --stdin.")

    asyncio.run(watch(str(market), str(outcome)))


if __name__ == "__main__":
    main()
