#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
import time
from openai import OpenAI

MODEL = "gpt-5-mini-2025-08-07"

SYSTEM_INSTRUCTIONS = """
Sen deneyimli bir risk yöneticisi + trade analisti gibi davranan bir asistansın.
Görevin: Kullanıcının paylaştığı Polymarket trade geçmişini ve ilgili bağlamı analiz etmek ve
kullanıcının bu trader'ı KOPYALARKEN izlemesi gereken yöntemi açık ve uygulanabilir şekilde önermek.

- Özet (profil)
- Kopyalama stratejisi (en az 3 ölçekleme yöntemi + artı/eksi)
- Risk yönetimi + otomasyona uygun kural seti
- Veri eksikse belirt, varsayım yapıyorsan açıkla
- Finansal tavsiye değildir notu
Dil: Türkçe.
""".strip()

DEMO_CONTEXT = """
[DEMO CONTEXT - GERÇEK VERİ DEĞİL]
Trader: @ExampleUser
- Son 7 günde 12 trade
- Ortalama pozisyon $500, max $3,000
- Market türleri: elections, crypto price, sports
- Serbest bakiye (free balance): yok
""".strip()


def main() -> int:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("HATA: OPENAI_API_KEY environment variable bulunamadı.", file=sys.stderr)
        return 2

    # Timeout: (connect_timeout, read_timeout) saniye
    client = OpenAI(api_key=api_key, timeout=(10.0, 60.0), max_retries=0)

    user_prompt = f"""
Bütçem yaklaşık $100.
Bu trader'ı kopyalamak istiyorum.

Lütfen verileri analiz et ve bana:
1) Trader davranış özeti
2) Kopyalama stratejisi (ölçekleme yöntemleri + net öneri)
3) Risk kuralları + otomasyona uygun kural seti

VERİLER:
{DEMO_CONTEXT}
""".strip()

    print("OpenAI'ye bağlanılıyor... (streaming açık)", flush=True)
    start = time.time()

    try:
        stream = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_INSTRUCTIONS,
            input=user_prompt,
            stream=True,
        )

        print("\n===== MODEL CEVABI (STREAM) =====\n", flush=True)

        for event in stream:
            # Streaming event'lerinde metin parçaları bu tipte gelir:
            if event.type == "response.output_text.delta":
                sys.stdout.write(event.delta)
                sys.stdout.flush()

        print("\n\n===============================\n", flush=True)
        print(f"Tamamlandı. Süre: {time.time() - start:.2f}s", flush=True)
        return 0

    except Exception as e:
        print("\nHATA: OpenAI çağrısı başarısız.", file=sys.stderr)
        print(repr(e), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
