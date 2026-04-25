const CACHE_NAME = 'kmz-viewer-v12';
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
self.addEventListener('fetch', e => {
  if (e.request.mode === 'navigate') {
    return; // 🔥 중요
  }
  if (e.request.url.includes('kakao.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// 요청 처리: 캐시 우선, 없으면 네트워크
window.addEventListener('popstate', function (e) {
  if (drawingMode) {
    if (currentPath.length > 0) {
      undoLastPoint();
    }
    // 🔥 두 번 넣어서 스택 유지 강화
    history.pushState({ page: 'map' }, null, '');
    history.pushState({ page: 'map2' }, null, '');
  } else {
    history.pushState({ page: 'map' }, null, '');
  }
});