const CACHE_NAME = 'kmz-viewer-v35';   // ⚙ 설정 · 지도 저장 폴더 (2026-10-22)
const SHARE_CACHE = 'shared-files';   // 공유받은 파일 임시 보관 (index.html이 소비 후 삭제)
const TILE_CACHE  = 'map-tiles-v1';   // 지도 타일 (버전 올려도 지우지 않음 — 데이터 절약)
const LIB_CACHE   = 'map-libs-v1';    // 지도 SDK·CDN 라이브러리
const KEEP_CACHES = [CACHE_NAME, SHARE_CACHE, TILE_CACHE, LIB_CACHE];
const STATIC_ASSETS = ['./index.html', './gdrive.js', './manifest.json'];

const TILE_MAX = 8000;                 // 타일 최대 개수 (평균 20KB → 약 160MB, '지도 미리 받기' 3단계 한 번 ≈ 2500장). 넘으면 오래 저장된 것부터 삭제
const DAY = 86400000;
const TILE_FRESH_DAYS  = 60;           // 버전 없는 타일(브이월드·항공사진)은 60일 지나면 다시 받음
const CADAS_FRESH_DAYS = 30;           // 지적도는 바뀔 수 있어 30일
const LIB_FRESH_DAYS   = 7;            // 버전 없는 라이브러리 주소는 7일마다 뒤에서 조용히 갱신

// 설치: 정적 파일 캐시 (하나 실패해도 설치는 되게)
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(STATIC_ASSETS.map(u => cache.add(u).catch(() => {}))))
  );
  self.skipWaiting();
});

// 활성화: 이전 버전 캐시 삭제 (타일·라이브러리 캐시는 유지)
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !KEEP_CACHES.includes(k)).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── 요청 분류 ──
// 지도 타일: 카카오(mts/mapN.daumcdn.net), 브이월드 배경(cdn/xdworld), 브이월드 WMTS·지적도 WMS, 국토정보원 항공사진
function tileKind(u) {
  const h = u.hostname, p = u.pathname;
  if (h === 'mts.daumcdn.net' && p.startsWith('/api/v1/tile/')) return 'tile';
  if (/^map\d*\.daumcdn\.net$/.test(h)) return 'tile';
  if (h === 'cdn.vworld.kr' && p.startsWith('/2d/')) return 'tile';
  if (h === 'xdworld.vworld.kr') return 'tile';
  if (h === '2d.vworld.kr' && p.includes('/2DCache/tile')) return 'tile';
  if (h === 'api.vworld.kr' && p.startsWith('/req/wmts/')) return 'tile';
  if (h === 'api.vworld.kr' && p === '/req/wms') return 'cadastral';
  if (h === 'map.ngii.go.kr' && p.startsWith('/airmapprime/map/wmts')) return 'tile';
  return null;
}
// 라이브러리: 카카오 지도 SDK 본체, 브이월드 OpenLayers·jQuery·CSS(ol.js 만 2.4MB), CDN
function isLib(u) {
  const h = u.hostname, p = u.pathname;
  if (h === 't1.daumcdn.net' && p.startsWith('/mapjsapi/')) return true;
  if (h === 'map.vworld.kr' && /\.(js|css|png|gif|jpe?g|svg)$/i.test(p)) return true;
  if (h === 'cdn.jsdelivr.net' || h === 'unpkg.com') return true;
  return false;
}
// 이 서버들은 CORS 를 허용 → 'cors' 로 다시 받아 저장 (저장 시각을 기록할 수 있고 용량도 정확히 잡힘)
const CORS_HOSTS = ['cdn.vworld.kr', 'xdworld.vworld.kr', 'api.vworld.kr', 'map.vworld.kr', 'map.ngii.go.kr',
                    'cdn.jsdelivr.net', 'unpkg.com'];
// 주소에 버전이 박혀 있으면 내용이 안 바뀜 → 영구 보관
const isVersioned = s => /@\d|\d+\.\d+\.\d+|[?&]v=/.test(s);

function netFetch(req, u) {
  if (req.mode === 'no-cors' && CORS_HOSTS.includes(u.hostname)) {
    return fetch(u.href, { mode: 'cors', credentials: 'omit',
                           referrer: req.referrer, referrerPolicy: req.referrerPolicy })
      .catch(() => fetch(req));
  }
  return fetch(req);
}

// 저장할 응답에 저장 시각 헤더를 붙인다 (opaque 응답은 헤더를 못 붙여 시각 없이 저장 → 만료 없음)
async function stamped(res) {
  if (res.type === 'opaque') return res;
  const h = new Headers(res.headers);
  h.set('x-sw-time', String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: h });
}
function ageDays(res) {
  const t = Number(res.headers.get('x-sw-time'));
  return t ? (Date.now() - t) / DAY : 0;
}
const storable = res => res && (res.ok || res.type === 'opaque');

// ── 타일 개수 제한 (오래 저장된 것부터 삭제) ──
let _puts = 0, _trimming = false;
async function trimTiles(keepRatio) {
  if (_trimming) return;
  _trimming = true;
  try {
    const c = await caches.open(TILE_CACHE);
    const keys = await c.keys();                         // 저장 순서대로 나옴
    const limit = Math.floor(TILE_MAX * (keepRatio || 1));
    if (keys.length > limit) {
      const n = keys.length - Math.floor(limit * 0.9);   // 한 번에 10% 여유를 더 비움
      for (let i = 0; i < n; i++) await c.delete(keys[i]);
    }
  } catch (err) {} finally { _trimming = false; }
}
async function putTile(key, res) {
  const c = await caches.open(TILE_CACHE);
  try { await c.put(key, await stamped(res)); }
  catch (err) { await trimTiles(0.5); return; }          // 저장 공간 부족 → 절반으로 줄임
  if (++_puts % 100 === 0) await trimTiles();
}

// ── 지도 저장 폴더 (gdrive.js ⚙ 설정, 2026-10-22) ──
// 사용자가 고른 휴대폰 폴더에 타일을 파일로 둔다. 폴더 손잡이·권한은 페이지에 있으므로 페이지에 묻는다:
//   'fsget' {url} → {buf,type,t} | {miss} | {off}   /   'fsput' {url, buf} (받은 타일을 폴더에 씀)
// 켜짐 여부는 페이지가 'fs-on' 으로 알려 주고, 서비스워커가 새로 뜨면 IndexedDB 'jty-fs' 의 'on' 을 읽는다.
// 내용을 못 읽는 서버(카카오 — CORS 없음)는 폴더에 못 넣으므로 묻지 않고 예전 방식(브라우저 캐시).
let _fsOn = null;
self.addEventListener('message', e => { if (e.data && e.data.t === 'fs-on') _fsOn = !!e.data.on; });
function fsOnState() {
  if (_fsOn !== null) return Promise.resolve(_fsOn);
  return new Promise(res => {
    try {
      const r = indexedDB.open('jty-fs', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try {
          const q = r.result.transaction('kv', 'readonly').objectStore('kv').get('on');
          q.onsuccess = () => { _fsOn = !!q.result; res(_fsOn); };
          q.onerror = () => res(false);
        } catch (err) { res(false); }
      };
      r.onerror = () => res(false);
    } catch (err) { res(false); }
  });
}
function askPage(client, msg, ms) {
  return new Promise(res => {
    const ch = new MessageChannel();
    const t = setTimeout(() => res(null), ms);
    ch.port1.onmessage = ev => { clearTimeout(t); res(ev.data); };
    client.postMessage(msg, [ch.port2]);
  });
}
const tileType = u => /\.png($|\?)/i.test(u.href) ? 'image/png' : 'image/jpeg';
async function handleTileFolder(e, u, kind) {
  if (!CORS_HOSTS.includes(u.hostname) || !e.clientId || !(await fsOnState())) return null;
  const client = await self.clients.get(e.clientId);
  if (!client) return null;
  const r = await askPage(client, { t: 'fsget', url: u.href }, 2500);
  if (!r || r.off) return null;                                   // 권한 없음 등 → 예전 방식
  const freshDays = kind === 'cadastral' ? CADAS_FRESH_DAYS : TILE_FRESH_DAYS;
  const fromFolder = () => new Response(r.buf, { headers: { 'Content-Type': r.type || tileType(u) } });
  if (r.buf && ((Date.now() - (r.t || 0)) / DAY < freshDays || !self.navigator.onLine)) return fromFolder();
  try {
    const res = await netFetch(e.request, u);
    if (res.ok && res.type !== 'opaque') {
      const b = await res.clone().arrayBuffer();
      client.postMessage({ t: 'fsput', url: u.href, buf: b }, [b]);
    }
    return res;
  } catch (err) {
    if (r.buf) return fromFolder();
    const cached = await (await caches.open(TILE_CACHE)).match(u.href, { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}

// 타일: 캐시 우선. 저장본이 오래됐고 인터넷이 되면 새로 받고, 못 받으면 저장본 사용
async function handleTile(e, u, kind) {
  try { const f = await handleTileFolder(e, u, kind); if (f) return f; } catch (err) {}
  const key = u.href;
  const c = await caches.open(TILE_CACHE);
  const cached = await c.match(key, { ignoreVary: true });
  const freshDays = kind === 'cadastral' ? CADAS_FRESH_DAYS : TILE_FRESH_DAYS;
  if (cached && (ageDays(cached) < freshDays || !self.navigator.onLine)) return cached;
  try {
    const res = await netFetch(e.request, u);
    if (storable(res)) e.waitUntil(putTile(key, res.clone()).catch(() => {}));
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

// 라이브러리: 캐시 우선. 버전 없는 주소는 7일 지나면 저장본을 주고 뒤에서 갱신
async function handleLib(e, u) {
  const key = u.href;
  const c = await caches.open(LIB_CACHE);
  const cached = await c.match(key, { ignoreVary: true });
  const refresh = () => netFetch(e.request, u).then(async res => {
    if (storable(res)) await c.put(key, await stamped(res.clone()));
    return res;
  });
  if (cached) {
    if (!isVersioned(key) && ageDays(cached) >= LIB_FRESH_DAYS && self.navigator.onLine)
      e.waitUntil(refresh().catch(() => {}));
    return cached;
  }
  return refresh();
}

// 네트워크 우선, 실패(오프라인)하면 저장본
async function networkFirst(e, cacheName, key) {
  const c = await caches.open(cacheName);
  try {
    const res = await fetch(e.request);
    if (storable(res)) e.waitUntil(c.put(key, res.clone()).catch(() => {}));
    return res;
  } catch (err) {
    const cached = await c.match(key, { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  // ── Web Share Target: 파일 앱/갤러리에서 '공유 → KMZ 뷰어'로 보낸 파일 수신 ──
  // (POST 도 navigate 모드라 navigate 처리보다 먼저 처리해야 함)
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
  if (e.request.method !== 'GET') return;

  // 페이지: 항상 서버에서 받는다(새로 올린 파일이 바로 보이게 — 바뀌지 않았으면 304 로 거의 데이터 안 씀).
  // 인터넷이 안 될 때만 저장해 둔 index.html 로 연다.
  if (e.request.mode === 'navigate') {
    const p = url.pathname;
    if (url.origin === location.origin && (p.endsWith('/') || p.endsWith('/index.html'))) {
      e.respondWith(networkFirst(e, CACHE_NAME, './index.html'));
    }
    return;
  }

  const kind = tileKind(url);
  if (kind) { e.respondWith(handleTile(e, url, kind)); return; }
  if (isLib(url)) { e.respondWith(handleLib(e, url)); return; }

  // 지도 SDK 시작 스크립트(키 확인 포함, 작음)는 매번 받되, 오프라인이면 저장본 — 신호 없는 곳에서도 저장된 지도로 열리게
  if ((url.hostname === 'map.vworld.kr' && url.pathname.startsWith('/js/vworldMapInit')) ||
      (url.hostname === 'dapi.kakao.com' && url.pathname === '/v2/maps/sdk.js')) {
    e.respondWith(networkFirst(e, LIB_CACHE, url.href));
    return;
  }

  // 같은 사이트 스크립트(gdrive.js)는 페이지와 같이 네트워크 우선 — 새로 올린 파일이 바로 반영되고, 오프라인이면 저장본
  if (url.origin === location.origin && url.pathname.endsWith('.js') && !url.pathname.endsWith('/sw.js')) {
    e.respondWith(networkFirst(e, CACHE_NAME, './' + url.pathname.split('/').pop()));
    return;
  }

  // 같은 사이트 파일(manifest·아이콘)은 저장본 우선. 그 밖의 API 요청(검색·주소·드라이브·카카오)은 손대지 않음
  if (url.origin === location.origin) {
    e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request)));
  }
});
