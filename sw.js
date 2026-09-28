const CACHE_NAME = 'ogrenci-asistani-v8';
const NETWORK_TIMEOUT = 8000;

function timeout(ms) {
    return new Promise((_, reject) => setTimeout(() => reject(new Error('network-timeout')), ms));
}
const ASSETS = [
    './',
    './index.html',
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
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET') return;
    e.respondWith(
        caches.match(e.request).then(cached => {
            // Ağ yanıtını zaman aşımıyla yarıştır; başarılıysa cache'i güncelle
            const fetchPromise = Promise.race([fetch(e.request), timeout(NETWORK_TIMEOUT)])
                .then(res => {
                    if (res && res.status === 200 && e.request.url.startsWith(self.location.origin)) {
                        const clone = res.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => null);

            if (cached) return cached;
            return fetchPromise.then(res => {
                if (res) return res;
                // Çevrimdışı yedeği: sayfa gezinmelerinde ana uygulamayı döndür
                if (e.request.mode === 'navigate') return caches.match('./index.html');
                return new Response('Çevrimdışı: içerik bulunamadı.', {
                    status: 503,
                    statusText: 'Service Unavailable',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                });
            });
        })
    );
});
