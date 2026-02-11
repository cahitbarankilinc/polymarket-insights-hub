# Paper Trading Config Şeması

Bu doküman, paper trading / copy trading ayarları için backend ve UI tarafında kullanılacak alanları tanımlar.

## Alan Tanımları

| Alan | Tip | Enum Değerleri | Min / Max Validasyon | Default | UI Label Açıklaması | Backend'de Null Olabilir mi? |
|---|---|---|---|---|---|---|
| `position_sizing_mode` | `enum` | `MULTIPLIER`, `FIXED_USD`, `FIXED_SHARES` | Yalnızca enum değerlerinden biri kabul edilir. | `MULTIPLIER` | Pozisyon boyutlandırma yöntemini seçer: kaynak işlemi çarpanla kopyalama, sabit USD ile alma veya sabit adet ile alma. | Hayır |
| `multiplier` | `number` | - | `min: 0`, `max: 100` | `1` | `position_sizing_mode = MULTIPLIER` iken kaynak işlem boyutuna uygulanacak çarpan. | Evet (`position_sizing_mode` farklıysa `null` olabilir) |
| `fixed_usd` | `number` | - | `min: 1`, `max: 1_000_000` | `100` | `position_sizing_mode = FIXED_USD` iken her işlem için kullanılacak sabit USD tutarı. | Evet (`position_sizing_mode` farklıysa `null` olabilir) |
| `fixed_shares` | `number` | - | `min: 1`, `max: 1_000_000` | `10` | `position_sizing_mode = FIXED_SHARES` iken her işlemde alınacak sabit lot/adet. | Evet (`position_sizing_mode` farklıysa `null` olabilir) |
| `max_trade_usd` | `number` | - | `min: 1`, `max: 10_000_000` | `1_000` | Tek bir işlemin USD cinsinden ulaşabileceği üst limit (risk kontrolü). | Hayır |
| `wallet_budget_cap_usd` | `number` | - | `min: 1`, `max: 100_000_000` | `10_000` | Bu strateji için cüzdan bazında ayrılabilecek maksimum bütçe. | Hayır |
| `global_total_budget_usd` | `number` | - | `min: 1`, `max: 1_000_000_000` | `50_000` | Tüm piyasalardaki toplam açık pozisyonlara ayrılacak global bütçe tavanı. | Hayır |
| `daily_budget_usd` | `number` | - | `min: 1`, `max: 100_000_000` | `5_000` | Günlük yeni açılan işlemler için harcanabilecek maksimum USD bütçesi. | Hayır |
| `max_market_exposure_pct` | `number` | - | `min: 0`, `max: 100` | `20` | Tek bir markete ayrılabilecek maksimum bütçe yüzdesi. | Hayır |
| `max_open_positions` | `number` | - | `min: 1`, `max: 10_000` | `25` | Aynı anda açık tutulabilecek toplam pozisyon sayısı. | Hayır |
| `copy_mode` | `enum` | `INSTANT`, `DELAYED`, `THRESHOLD` | Yalnızca enum değerlerinden biri kabul edilir. | `INSTANT` | Kaynak işlemlerin hangi koşulla kopyalanacağını belirler: anlık, gecikmeli veya eşik kontrollü. | Hayır |
| `copy_delay_ms` | `number` | - | `min: 0`, `max: 86_400_000` | `0` | `copy_mode = DELAYED` iken işlemin kaç milisaniye gecikmeyle gönderileceği. | Evet (`copy_mode` farklıysa `null` olabilir) |
| `min_source_trade_usd` | `number` | - | `min: 0`, `max: 10_000_000` | `0` | Kaynak işlem bu USD tutarının altındaysa kopyalanmaz (küçük işlemleri filtreleme). | Hayır |
| `max_price_deviation_pct` | `number` | - | `min: 0`, `max: 100` | `2` | Kaynak fiyat ile hedef fiyat arasındaki izin verilen maksimum sapma yüzdesi. | Hayır |

## Ek Notlar

- `position_sizing_mode` ve `copy_mode`, ilgili koşullu alanların zorunluluğunu belirler.
- Koşullu alanlar (`multiplier`, `fixed_usd`, `fixed_shares`, `copy_delay_ms`) mod dışında kullanıldığında backend tarafında `null` olarak tutulabilir.
- Tüm `number` alanlarında ondalıklı değer desteği, ürün kararına göre backend validatöründe açılıp kapatılmalıdır.

## Örnek JSON Config

```json
{
  "position_sizing_mode": "MULTIPLIER",
  "multiplier": 1.25,
  "fixed_usd": null,
  "fixed_shares": null,
  "max_trade_usd": 1500,
  "wallet_budget_cap_usd": 12000,
  "global_total_budget_usd": 60000,
  "daily_budget_usd": 6000,
  "max_market_exposure_pct": 25,
  "max_open_positions": 30,
  "copy_mode": "DELAYED",
  "copy_delay_ms": 1500,
  "min_source_trade_usd": 50,
  "max_price_deviation_pct": 1.5
}
```
