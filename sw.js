const CACHE_NAME = 'kmz-viewer-v1';
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
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 요청 처리: 캐시 우선, 없으면 네트워크
self.addEventListener('fetch', e => {
  // 카카오맵 API는 항상 네트워크 (오프라인 불가)
  if (e.request.url.includes('dapi.kakao.com') ||
      e.request.url.includes('daumcdn.net') ||
      e.request.url.includes('kakao.com')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
