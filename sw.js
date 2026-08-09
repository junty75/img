const CACHE_NAME = 'kmz-viewer-v33';   // install 을 개별 실패에 견디게 수정 → 캐시 갱신
const SHARE_CACHE = 'shared-files';   // 공유받은 파일 임시 보관 (index.html이 소비 후 삭제)
const STATIC_ASSETS = [
  './index.html',
  './manifest.json'
];
const EXTRA_ASSETS = [                                     // 있으면 좋지만 설치를 붙잡진 않는 것
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'
];

// 설치: 정적 파일 캐시
// 설치는 되도록 빨리, 그리고 반드시 끝나야 한다 —
//  · addAll 은 하나라도 실패하면 install 전체가 실패해 워커가 아예 안 남는다.
//  · 워커가 없으면 공유 POST(share-target)를 받아줄 주체가 없어 요청이 깃허브 서버까지
//    가고 '405 Not Allowed' 가 뜬다(정적 호스팅은 POST 를 못 받는다).
//  · 런처 htm 은 지도 페이지를 연 뒤 6초 만에 공유 POST 를 보내므로, 느린 CDN 을
//    기다리다 설치가 늦어지면 그 POST 가 또 405 가 된다.
// 그래서 같은 도메인 파일만 waitUntil 로 담고, CDN 은 실패해도/늦어도 무시한다.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      EXTRA_ASSETS.forEach(u => { cache.add(u).catch(() => {}); });   // 기다리지 않음
      return Promise.all(STATIC_ASSETS.map(u => cache.add(u).catch(() => {})));
    })
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

