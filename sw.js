const CACHE_NAME = 'kmz-viewer-v29';
const SHARE_CACHE = 'shared-files';   // 공유받은 파일 임시 보관 (index.html이 소비 후 삭제)
const STATIC_ASSETS = [
  './index.html',
  './manifest.json',
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
];

// 설치: 정적 파일 캐시
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// 활성화: 이전 캐시 삭제
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== SHARE_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // ── Web Share Target: 파일 앱/갤러리에서 '공유 → KMZ 뷰어'로 보낸 파일 수신 ──
  // (POST 도 navigate 모드라 navigate 조기 return 보다 먼저 처리해야 함)
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const files = form.getAll('file').filter(f => f && f.name);
        const cache = await caches.open(SHARE_CACHE);
        await cache.put('./shared-manifest', new Response(JSON.stringify(files.map(f => f.name))));
        await Promise.all(files.map((f, i) => cache.put('./shared-file-' + i, new Response(f))));
      } catch (err) { /* 파일 없이 열려도 앱은 뜨게 */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (e.request.mode === 'navigate') {
    return; // 🔥 중요
  }
  if (e.request.url.includes('kakao.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

