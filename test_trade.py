MARKET_SLUG = "btc-updown-15m-1771281000"
OUTCOME = "UP"
ASSET_ID = (
    "14758085229624116374287908106326470782344944951281435922292073838136696315974"
)
SIDE = "BUY"  # "BUY" veya "SELL"
PRICE = 0.99  # 0.95 = 95¢
SIZE = 2  # kaç adet token
PRIVATE_KEY = ""

# ==============================

SIGNATURE_TYPE = 1
FUNDER_ADDRESS = ""

# ==============================

from pprint import pprint
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import OrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

CLOB_API = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet


def main():
    print("====================================")
    print(" POLYMARKET LIMIT ORDER TEST")
    print("====================================")
    print(f"Market:        {MARKET_SLUG}")
    print(f"Outcome:       {OUTCOME}")
    print(f"Asset ID:      {ASSET_ID}")
    print(f"Side:          {SIDE}")
    print(f"Limit Price:   {PRICE}")
    print(f"Size:          {SIZE}")
    print(f"SignatureType: {SIGNATURE_TYPE}")
    print(f"Funder:        {FUNDER_ADDRESS if FUNDER_ADDRESS else '(none)'}")
    print("====================================\n")

    if SIDE.upper() not in ("BUY", "SELL"):
        raise ValueError('SIDE must be "BUY" or "SELL"')

    side_const = BUY if SIDE.upper() == "BUY" else SELL

    # Auth client (notebook’taki gibi)
    clob_kwargs = dict(
        host=CLOB_API,
        key=PRIVATE_KEY,
        chain_id=CHAIN_ID,
        signature_type=SIGNATURE_TYPE,
    )
    if FUNDER_ADDRESS.strip():
        clob_kwargs["funder"] = FUNDER_ADDRESS.strip()

    auth_client = ClobClient(**clob_kwargs)

    print("🔐 Deriving API key / setting creds ...")
    creds = auth_client.derive_api_key()
    auth_client.set_api_creds(creds)

    # Limit order
    limit_order = OrderArgs(
        token_id=ASSET_ID, price=float(PRICE), size=float(SIZE), side=side_const
    )

    print("✍️  Signing limit order ...")
    signed_order = auth_client.create_order(limit_order)

    print("📤 Posting order (GTC) ...")
    resp = auth_client.post_order(signed_order, OrderType.GTC)

    print("\n✅ Response:")
    pprint(resp)


if __name__ == "__main__":
    main()
