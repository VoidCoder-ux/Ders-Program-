# Yerel yazı tanıma (Tesseract)

Fotoğraftan ders programı okuma özelliği (`schedule-reader.js`) bu klasördeki dosyalarla **tamamen cihazda** çalışır.
Hiçbir dış servise istek atılmaz ve API anahtarı gerekmez.

| Dosya | Kaynak | Sürüm | Lisans |
|---|---|---|---|
| `tesseract.min.js`, `worker.min.js` | npm `tesseract.js` | 5.1.1 | Apache-2.0 (`LICENSE`) |
| `core/tesseract-core-lstm.wasm.js`, `core/tesseract-core-simd-lstm.wasm.js` | npm `tesseract.js-core` | 5.1.1 | Apache-2.0 |
| `lang/tur.traineddata.gz` | npm `@tesseract.js-data/tur` (`4.0.0_best_int`) | 1.0.0 | Apache-2.0 |

İki çekirdek dosyası vardır: SIMD destekleyen yeni cihazlar `simd` sürümünü, eskiler diğerini kullanır.
Sürüm yükseltilirse `sw.js` içindeki `VENDOR_CACHE` adı da değiştirilmelidir.
