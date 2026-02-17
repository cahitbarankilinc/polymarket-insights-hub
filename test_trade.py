import argparse
import json
from pprint import pprint

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

MARKET_SLUG = "btc-updown-15m-1771281000"
OUTCOME = "UP"
ASSET_ID = (
    "14758085229624116374287908106326470782344944951281435922292073838136696315974"
)
SIDE = "BUY"  # "BUY" veya "SELL"
PRICE = 0.99  # 0.95 = 95¢
SIZE = 2  # kaç adet token
PRIVATE_KEY = ""

SIGNATURE_TYPE = 1
FUNDER_ADDRESS = ""

CLOB_API = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Polymarket limit order test")
    parser.add_argument("--market-slug", default=MARKET_SLUG)
    parser.add_argument("--outcome", default=OUTCOME)
    parser.add_argument("--asset-id", default=ASSET_ID)
    parser.add_argument("--side", default=SIDE)
    parser.add_argument("--price", type=float, default=PRICE)
    parser.add_argument("--size", type=float, default=SIZE)
    parser.add_argument("--private-key", default=PRIVATE_KEY)
    parser.add_argument("--signature-type", type=int, default=SIGNATURE_TYPE)
    parser.add_argument("--funder-address", default=FUNDER_ADDRESS)
    parser.add_argument("--json", action="store_true", help="Print JSON-only response")
    return parser.parse_args()


def main():
    args = parse_args()

    if not args.json:
        print("====================================")
        print(" POLYMARKET LIMIT ORDER TEST")
        print("====================================")
        print(f"Market:        {args.market_slug}")
        print(f"Outcome:       {args.outcome}")
        print(f"Asset ID:      {args.asset_id}")
        print(f"Side:          {args.side}")
        print(f"Limit Price:   {args.price}")
        print(f"Size:          {args.size}")
        print(f"SignatureType: {args.signature_type}")
        print(f"Funder:        {args.funder_address if args.funder_address else '(none)'}")
        print("====================================\n")

    if args.side.upper() not in ("BUY", "SELL"):
        raise ValueError('SIDE must be "BUY" or "SELL"')

    side_const = BUY if args.side.upper() == "BUY" else SELL

    clob_kwargs = dict(
        host=CLOB_API,
        key=args.private_key,
        chain_id=CHAIN_ID,
        signature_type=args.signature_type,
    )
    if args.funder_address.strip():
        clob_kwargs["funder"] = args.funder_address.strip()

    auth_client = ClobClient(**clob_kwargs)

    if not args.json:
        print("🔐 Deriving API key / setting creds ...")
    creds = auth_client.derive_api_key()
    auth_client.set_api_creds(creds)

    limit_order = OrderArgs(
        token_id=args.asset_id, price=float(args.price), size=float(args.size), side=side_const
    )

    if not args.json:
        print("✍️  Signing limit order ...")
    signed_order = auth_client.create_order(limit_order)

    if not args.json:
        print("📤 Posting order (GTC) ...")
    resp = auth_client.post_order(signed_order, OrderType.GTC)

    if args.json:
        print(json.dumps(resp))
        return

    print("\n✅ Response:")
    pprint(resp)


if __name__ == "__main__":
    main()
