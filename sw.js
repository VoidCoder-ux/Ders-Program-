const CACHE_NAME = 'ogrenci-asistani-v10';
// Yazı tanıma motoru büyük (~10 MB) ve sürümlüdür: uygulama güncellemelerinde silinmeyen ayrı bir önbellekte tutulur,
// böylece her güncellemede yeniden inmez ve bir kez indikten sonra internetsiz çalışır.
const VENDOR_CACHE = 'ogrenci-asistani-tesseract-5.1.1';
const NAV_TIMEOUT = 8000;

function timeout(ms) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('network-timeout')), ms));
}
const ASSETS = [
    './',
    './index.html',
    './schedule-reader.js',
    './manifest.json',
    './icon.svg',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME && k !== VENDOR_CACHE).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    const url = new URL(e.request.url);
    const sameOrigin = url.origin === self.location.origin;

    // Yazı tanıma dosyaları değişmez: önbellekte varsa doğrudan oradan, yoksa bir kez indirip sakla.
    // (Zaman aşımı uygulanmaz: yavaş bağlantıda büyük dosyanın inmesi yarıda kesilmesin.)
    if (sameOrigin && url.pathname.includes('/vendor/')) {
        e.respondWith(caches.open(VENDOR_CACHE).then(async cache => {
            const hit = await cache.match(e.request);
            if (hit) return hit;
            const res = await fetch(e.request);
            if (res && res.status === 200) cache.put(e.request, res.clone());
            return res;
        }));
        return;
    }

    e.respondWith(
        caches.match(e.request).then(cached => {
            // Önbellekteki sürümü hemen ver, arka planda güncelle
            const network = fetch(e.request).then(res => {
                if (res && res.status === 200 && sameOrigin) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                }
                return res;
            });
            if (cached) { network.catch(() => {}); return cached; }

            // Sayfa gezinmesi: ağ yavaşsa ya da yoksa uygulamanın kendisini aç
            if (e.request.mode === 'navigate') {
                return Promise.race([network, timeout(NAV_TIMEOUT)])
                    .catch(() => null)
                    .then(res => res || caches.match('./index.html'));
            }
            return network.catch(() => new Response('Çevrimdışı: içerik bulunamadı.', {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            }));
        })
    );
});
