// gdrive.js — 구글 드라이브 연동 + 지도 저장(미리 받기·저장 공간) + ⚙ 설정(지도 파일 가져오기). index.html(카카오)·index_vworld.html(브이월드) 공통.
// 두 페이지의 </body> 바로 앞에서 <script src="gdrive.js"> 로 불러온다(예전 인라인 블록과 같은 자리·같은 실행 시점).
// 지도 어댑터(getBounds/fitBounds/isVw…)가 vmap(브이월드)·map(카카오)을 런타임에 구분한다.
// 배포: /img/ 와 /Vmap/ 두 저장소에 같은 파일을 올릴 것.
(function () {
  // 클라이언트 ID 를 여기에 고정해 두면 사용자 입력 없이 동작 (비워 두면 처음 한 번 입력받음)
  var GDRIVE_CLIENT_ID = '680805135587-9ttr17d5u8t1h93hb05u0je7c62p3b2a.apps.googleusercontent.com';
  var SCOPE = 'https://www.googleapis.com/auth/drive';
  var LS_CID = 'gdrive_client_id', LS_TOK = 'gdrive_token', LS_PEND = 'gdrive_pending',
      LS_STATE = 'gdrive_state', LS_CACHE = 'gdrive_list_cache2', LS_FOLDER = 'gdrive_folder',
      LS_UPF = 'gdrive_up_folder', LS_UPNET = 'gdrive_up_net', LS_UPQ = 'gdrive_up_q', LS_CAMSAVE = 'gdrive_cam_save', LS_METAP = 'gdrive_meta_pend';
  // 업로드 사진 용량 (map.html 의 사진용량 선택과 같은 단계). 0 = 원본. 고른 값은 LS_UPQ 에 기억
  var UPQ_OPTS = [[100, '100KB↓'], [200, '200KB↓'], [300, '300KB↓'], [500, '500KB↓'], [800, '800KB↓'], [1024, '1MB↓'], [0, '원본']];
  try { localStorage.removeItem('gdrive_list_cache'); } catch (e) {}   // 폴더 정보 없는 옛 캐시 (2026-10-03)
  var CACHE_MS = 6 * 3600 * 1000;      // 목록 캐시 6시간 (새로 올린 사진은 '목록 새로 받기')
  var FILE_RE = /\.(kmz|kml|zip|gpx|bgpx|htm|html)$/i;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function lsJson(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }
  function clientId() { return lsGet(LS_CID) || GDRIVE_CLIENT_ID || ''; }
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html?$/i, ''); }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ── OAuth 리디렉트 복귀 처리 (#access_token=...) — 다른 코드가 해시를 쓰기 전에 즉시 ──
  var _returned = false;
  (function () {
    var h = location.hash || '';
    if (!/(^#|&)(access_token|error)=/.test(h)) return;
    var p = {};
    h.slice(1).split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); });
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) {}
    var st = lsGet(LS_STATE); lsDel(LS_STATE);
    if (p.state !== st) return;                                   // 우리가 보낸 요청이 아님
    if (p.access_token) {
      lsSet(LS_TOK, JSON.stringify({ t: p.access_token, s: p.scope || '', exp: Date.now() + (parseInt(p.expires_in, 10) || 3600) * 1000 - 60000 }));
      _returned = true;
    } else if (p.error) {
      lsDel(LS_PEND);
      setTimeout(function () { alert('구글 로그인이 취소됐거나 실패했습니다.\n(' + p.error + ')'); }, 500);
    }
  })();

  // write=true 면 쓰기 권한(drive) 있는 토큰만 — 읽기 전용 시절 토큰이면 null
  function getToken(write) {
    var o = lsJson(LS_TOK);
    if (!o || !o.t || o.exp <= Date.now()) return null;
    if (write && !/auth\/drive(\s|$)/.test(o.s || '')) return null;
    return o.t;
  }
  function login(pending) {
    var cid = clientId();
    if (!cid) { showCidForm(); return; }
    var st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    lsSet(LS_STATE, st);
    if (pending) lsSet(LS_PEND, JSON.stringify(pending));
    try { autoSaveToDB(); } catch (e) {}                          // 페이지 이동 전 현재 객체 보존
    location.href = 'https://accounts.google.com/o/oauth2/v2/auth'
      + '?client_id=' + encodeURIComponent(cid)
      + '&redirect_uri=' + encodeURIComponent(redirectUri())
      + '&response_type=token'
      + '&scope=' + encodeURIComponent(SCOPE)
      + '&include_granted_scopes=true'
      + '&state=' + encodeURIComponent(st);
  }

  // ── 지도 어댑터: 카카오(map) / 브이월드(vmap) 공통 ──
  function getBounds() {     // {s,w,n,e} (위경도) 또는 null
    try {
      if (typeof vmap !== 'undefined' && vmap && vmap.getView) {
        var v = vmap.getView(), sz = vmap.getSize(); if (!sz) return null;
        var ex = ol.proj.transformExtent(v.calculateExtent(sz), v.getProjection(), 'EPSG:4326');
        return { w: ex[0], s: ex[1], e: ex[2], n: ex[3] };
      }
    } catch (e) {}
    try {
      if (typeof map !== 'undefined' && map && map.getBounds && window.kakao) {
        var b = map.getBounds(); if (!b) return null;
        var sw = b.getSouthWest(), ne = b.getNorthEast();
        return { s: sw.getLat(), w: sw.getLng(), n: ne.getLat(), e: ne.getLng() };
      }
    } catch (e) {}
    return null;
  }
  function fitBounds(b) {
    try {
      if (typeof vmap !== 'undefined' && vmap && vmap.getView) {
        var v = vmap.getView();
        // 브이월드는 OpenLayers 3 이라 view.fit 시그니처가 신버전과 다르다 → 중심·해상도를 직접 계산
        var ex = ol.proj.transformExtent([b.w, b.s, b.e, b.n], 'EPSG:4326', v.getProjection()), sz = vmap.getSize() || [innerWidth, innerHeight];
        v.setCenter([(ex[0] + ex[2]) / 2, (ex[1] + ex[3]) / 2]);
        v.setResolution(Math.max((ex[2] - ex[0]) / sz[0], (ex[3] - ex[1]) / sz[1]));
        return;
      }
    } catch (e) {}
    try {
      if (typeof map !== 'undefined' && map && window.kakao)
        map.setBounds(new kakao.maps.LatLngBounds(new kakao.maps.LatLng(b.s, b.w), new kakao.maps.LatLng(b.n, b.e)), 0, 0, 0, 0);
    } catch (e) {}
  }

  // ── 지도 저장: 지금 화면을 더 확대한 단계까지 미리 받아 두기 (2026-10-04) ──
  // 타일 주소를 직접 계산하지 않고 지도를 실제로 그 자리·그 단계로 옮겨 지도가 스스로 타일을 받게 한다
  // → 카카오(위성+하이브리드 두 겹)·브이월드·항공사진 어느 지도든 같은 코드. 받은 타일은 sw.js 가 map-tiles-v1 에 저장.
  var TILE_CACHE = 'map-tiles-v1';          // sw.js 의 TILE_CACHE 와 같은 이름
  var TILE_AVG_KB = 20;                     // 저장 용량 어림 (위성 JPG + 하이브리드 PNG 평균)
  function isVw() { return typeof vmap !== 'undefined' && vmap && vmap.getView; }
  function getViewState() {
    if (isVw()) { var v = vmap.getView(); return { c: v.getCenter().slice(), z: v.getZoom() }; }
    return { c: map.getCenter(), z: map.getLevel() };
  }
  function setViewState(st) {
    if (isVw()) { var v = vmap.getView(); v.setZoom(st.z); v.setCenter(st.c); }
    else { map.setLevel(st.z); map.setCenter(st.c); }
  }
  // 지금 단계에서 k 단계 더 확대한 레벨(카카오)·줌(브이월드). 더 못 가면 null
  function zoomStep(base, k) {
    if (isVw()) { var z = Math.round(base) + k; return z > 19 ? null : z; }
    var L = base - k; return L < 1 ? null : L;
  }
  function gotoLL(lat, lng, z) {
    if (isVw()) { var v = vmap.getView(); v.setZoom(z); v.setCenter(ol.proj.transform([lng, lat], 'EPSG:4326', v.getProjection())); }
    else { map.setLevel(z); map.setCenter(new kakao.maps.LatLng(lat, lng)); }
  }
  // 브이월드: 타일 소스마다 받는 중인 개수를 센다 (OL3 tileloadstart/end/error)
  var _olPend = 0, _olHooked = [];
  function hookOlTiles() {
    function walk(coll) {
      coll.forEach(function (l) {
        if (l.getLayers) { walk(l.getLayers()); return; }
        var s = l.getSource && l.getSource();
        if (!s || !s.on || _olHooked.indexOf(s) >= 0) return;
        if (!(ol.source.TileImage && s instanceof ol.source.TileImage)) return;
        _olHooked.push(s);
        s.on('tileloadstart', function () { _olPend++; });
        s.on('tileloadend', function () { _olPend = Math.max(0, _olPend - 1); });
        s.on('tileloaderror', function () { _olPend = Math.max(0, _olPend - 1); });
      });
    }
    walk(vmap.getLayers());
  }
  // 지금 화면 타일을 다 받을 때까지 (최대 6초)
  function waitTiles() {
    return new Promise(function (res) {
      var t0 = Date.now();
      if (isVw()) {
        var calm = 0;
        (function tick() {
          calm = _olPend === 0 ? calm + 1 : 0;
          if (calm >= 3 || Date.now() - t0 > 6000) return res();
          setTimeout(tick, 150);
        })();
      } else {
        var fin = false;
        var h = function () { if (fin) return; fin = true; try { kakao.maps.event.removeListener(map, 'tilesloaded', h); } catch (e) {} res(); };
        kakao.maps.event.addListener(map, 'tilesloaded', h);
        setTimeout(h, 6000);
      }
    });
  }
  function tileCount() {
    try {
      return caches.open(TILE_CACHE).then(function (c) { return c.keys(); })
        .then(function (k) { return k.length; }).catch(function () { return 0; });
    } catch (e) { return Promise.resolve(0); }
  }
  function tileInfoText(n) { return '저장된 지도 ' + n + '장 (약 ' + (n ? Math.max(1, Math.round(n * TILE_AVG_KB / 1024)) : 0) + 'MB)'; }
  function preloadSteps(b, st, extra) {
    var steps = [];
    for (var k = 1; k <= extra; k++) {
      var z = zoomStep(st.z, k); if (z == null) break;
      var n = Math.pow(2, k);
      for (var j = 0; j < n; j++) for (var i = 0; i < n; i++)
        steps.push({ z: z, lat: b.n - (j + 0.5) * (b.n - b.s) / n, lng: b.w + (i + 0.5) * (b.e - b.w) / n });
    }
    return steps;
  }
  function preloadTiles(extra) {
    if (_busy) return;
    if (!('caches' in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) {
      alert('지도 저장 기능이 아직 준비되지 않았습니다.\n앱을 한 번 껐다 켠 뒤 다시 해 보세요.'); return;
    }
    var b = getBounds(); if (!b) return;
    var st = getViewState();
    var steps = preloadSteps(b, st, extra);
    if (!steps.length) { alert('이미 가장 크게 확대된 화면이라 더 받을 단계가 없습니다.'); return; }
    if (netLabel() === '데이터' && !confirm('지금 모바일 데이터로 연결돼 있습니다.\n' + steps.length + '화면(약 ' + Math.round(steps.length * 30 * TILE_AVG_KB / 1024) + 'MB까지)을 받을까요?\n(이미 저장된 부분은 데이터를 쓰지 않습니다)')) return;
    try { if (typeof locationMode !== 'undefined' && locationMode === 2) { locationMode = 1; applyLocationMode(); } } catch (e) {}
    closePanel();
    _busy = true;
    var job = startJob();
    window._tileDl = true;
    if (isVw()) { try { hookOlTiles(); } catch (e) {} }
    var idx = 0;
    function fin(msg) {
      window._tileDl = false;
      try { setViewState(st); } catch (e) {}
      done();
      tileCount().then(function (n) { toast(msg + '<br>' + tileInfoText(n), 5000); });
    }
    (function next() {
      if (job.cancelled) { fin('지도 받기를 멈췄습니다 (' + (idx - 1 < 0 ? 0 : idx - 1) + '/' + steps.length + '화면).'); return; }
      if (idx >= steps.length) { fin('지금 화면 지도를 다 받았습니다 (' + steps.length + '화면).'); return; }
      var s = steps[idx++];
      status('지도 받는 중... ' + idx + ' / ' + steps.length + '화면');
      try { gotoLL(s.lat, s.lng, s.z); } catch (e) {}
      if (!isVw() && map.getLevel() !== s.z) { setTimeout(next, 0); return; }   // 이 기기에서 안 되는 레벨(모바일 0)은 건너뜀
      waitTiles().then(next);
    })();
  }
  function clearTiles(after) {
    if (!confirm('저장된 지도를 모두 지울까요?\n(다음에 볼 때 다시 받습니다)')) return;
    try {
      caches.delete(TILE_CACHE).then(function () { toast('저장된 지도를 비웠습니다.', 3000); if (after) after(); });
    } catch (e) {}
  }

  // ── 스타일 + 버튼 + 패널 ──
  var css = document.createElement('style');
  css.textContent =
    '#gdriveBtn{top:72px;right:72px;padding:0;}' +
    // 길게 누를 때 크롬이 버튼 글자(📷)를 선택하거나 메뉴를 띄우며 터치를 취소해 버리던 것 막기
    '#gdriveBtn,#gdCamBtn{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:none;}' +
    // 📍 마커 버튼을 뺀 자리(2026-10-17, 마커는 지도 길게 누르기 메뉴로)
    '#gdCamBtn{top:184px;right:16px;padding:0;font-size:22px;}' +
    '#gdriveBtn .gdq{position:absolute;top:-6px;left:-6px;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;border-radius:9px;background:#e53935;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center;display:none;}' +
    '#gdriveBtn .gdq.show{display:block;}' +
    '#gdriveBtn.gd-folder::after{content:"\\1F4C1";position:absolute;right:-5px;bottom:-5px;font-size:15px;line-height:1;}' +
    '#gdPanel{position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.45);display:none;align-items:flex-end;justify-content:center;}' +
    '#gdPanel.show{display:flex;}' +
    '#gdBox{background:#fff;color:#222;width:100%;max-width:560px;max-height:88vh;overflow-y:auto;border-radius:14px 14px 0 0;padding:14px 14px calc(14px + env(safe-area-inset-bottom));box-sizing:border-box;font-size:13px;line-height:1.55;box-shadow:0 -4px 16px rgba(0,0,0,.3);}' +
    '#gdBox input[type=text],#gdBox textarea{width:100%;box-sizing:border-box;font-size:15px;padding:9px;border:1px solid #ccc;border-radius:8px;margin:4px 0 8px;font-family:inherit;}' +
    '#gdBox textarea{min-height:70px;resize:vertical;}' +
    '#gdBox code{background:#f1f3f4;padding:1px 4px;border-radius:4px;word-break:break-all;}' +
    '#gdBox button{border:none;border-radius:8px;padding:9px 14px;font-size:14px;font-weight:600;cursor:pointer;background:#eee;color:#222;}' +
    '#gdBox button.pri{background:#1a73e8;color:#fff;}' +
    '#gdBox .sec{border-top:1px solid #eee;margin-top:12px;padding-top:10px;}' +
    '#gdBox .fl{max-height:46vh;overflow-y:auto;border:1px solid #eee;border-radius:8px;margin:8px 0;}' +
    '#gdBox .fr{display:flex;align-items:center;gap:8px;padding:11px 10px;border-bottom:1px solid #f0f0f0;font-size:15px;cursor:pointer;}' +
    '#gdBox .fr:active{background:#e8f0fe;}' +
    '#gdBox .fr .nm{flex:1;word-break:break-all;}' +
    '#gdBox .fr .ct{color:#888;font-size:12px;white-space:nowrap;}' +
    '#gdBox .path{font-size:14px;font-weight:600;color:#1a73e8;word-break:break-all;}' +
    '#gdBox .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}' +
    '#gdBox .net label{display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:14px;}' +
    '#gdBox .prev{display:block;max-width:100%;max-height:30vh;margin:6px auto 10px;border-radius:8px;}';
  document.head.appendChild(css);

  var btn = document.createElement('button');
  btn.className = 'btn'; btn.id = 'gdriveBtn';
  btn.innerHTML = '<svg viewBox="0 0 87.3 78" width="26" height="24"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg><span class="gdq"></span>';
  document.body.appendChild(btn);

  var camBtn = document.createElement('button');
  camBtn.className = 'btn'; camBtn.id = 'gdCamBtn'; camBtn.title = '사진 찍기 (제목·설명 입력 → 지도에 올림 → 드라이브 자동 업로드)';
  camBtn.textContent = '📷';
  document.body.appendChild(camBtn);
  var camInput = document.createElement('input');
  camInput.type = 'file'; camInput.accept = 'image/*'; camInput.setAttribute('capture', 'environment');
  camInput.style.display = 'none';
  document.body.appendChild(camInput);

  var panel = document.createElement('div');
  panel.id = 'gdPanel';
  panel.innerHTML = '<div id="gdBox"></div>';
  document.body.appendChild(panel);
  var _panelGuard = null;          // 바깥을 눌러 닫을 때 확인이 필요한 화면(촬영 메타 입력)
  panel.addEventListener('click', function (e) { if (e.target === panel && !_panelGuard) closePanel(); });
  var _panelBack = null;           // 뒤로가기 때 할 일 (없으면 그냥 닫기) — 입력 중인 화면은 각자의 '닫기/취소' 동작
  function openPanel(html) { panel.classList.add('show'); _panelBack = null; $('gdBox').innerHTML = html; $('gdBox').scrollTop = 0; }
  function closePanel() { panel.classList.remove('show'); _panelGuard = null; _panelBack = null; }
  // 휴대폰 뒤로가기 — 지도 쪽 popstate 처리가 맨 먼저 부른다(히스토리는 지도 쪽 버퍼가 관리, 여기선 건드리지 않음)
  window.gdOnBack = function () {
    if (panel.classList.contains('show')) {
      if (_panelBack) _panelBack(); else closePanel();
      return true;
    }
    if (_job && cancelBtn.style.display !== 'none') { cancelBtn.click(); return true; }   // 드라이브 불러오는 중이면 취소
    return false;
  };
  var $ = function (id) { return document.getElementById(id); };

  var _busy = false;
  // 지금 지도에 있는 드라이브 사진인지 — 세션 기억이 아니라 실제 마커로 판단(지운 사진은 다시 올림)
  // driveId 없는 옛 마커는 같은 이름·약 1km 안이면 같은 사진으로 본다
  function onMapTest() {
    var ids = {}, olds = [];
    try {
      (markers || []).forEach(function (m) {
        if (!m || !m.imgSrc) return;
        if (m.driveId) ids[m.driveId] = 1;
        else olds.push(m);
      });
    } catch (e) {}
    return function (f) {
      if (ids[f[0]]) return true;
      var nm = String(f[1]).replace(/\.[^.]+$/, '');
      return olds.some(function (m) {
        if (m.name !== nm) return false;
        var ll = entryLL(m);
        return !ll || Math.abs(f[2] - ll.lat) + Math.abs(f[3] - ll.lng) < 0.01;
      });
    };
  }
  function status(t) { try { showLoading(t); } catch (e) {} }
  function done() { try { hideLoading(); } catch (e) {} _busy = false; endJob(); }

  // ── 취소할 수 있는 작업 (드라이브 사진 불러오기·파일 열기·폴더 목록) ──
  // 로딩 화면에 '취소' 버튼을 붙인다. 누르면 받는 중인 요청을 끊고, 지도에 올리는 중이면 지금 묶음(5장)까지만 올리고 멈춘다.
  var _job = null;
  var cancelBtn = document.createElement('button');
  cancelBtn.id = 'gdLoadCancel'; cancelBtn.textContent = '취소';
  cancelBtn.style.cssText = 'display:none;margin-top:6px;padding:9px 26px;font-size:15px;font-weight:600;border:none;border-radius:8px;background:#fff;color:#c62828;cursor:pointer;';
  try { document.getElementById('loading').appendChild(cancelBtn); } catch (e) {}
  function startJob() {
    endJob();
    _job = { cancelled: false, ac: (window.AbortController ? new AbortController() : null) };
    cancelBtn.style.display = '';
    return _job;
  }
  function endJob() { _job = null; cancelBtn.style.display = 'none'; }
  cancelBtn.onclick = function (e) {
    e.stopPropagation();
    if (!_job) return;
    _job.cancelled = true;
    try { _job.ac && _job.ac.abort(); } catch (er) {}
    cancelBtn.style.display = 'none';
    try { showLoading('취소하는 중...'); } catch (er) {}
  };
  function jobSignal(job) { return job && job.ac ? job.ac.signal : undefined; }
  // 취소됐으면 화면 정리 후 true
  function cancelled(job, msg) {
    if (!job || !job.cancelled) return false;
    if (_job === job) done(); else { try { hideLoading(); } catch (e) {} _busy = false; }
    toast(msg || '취소했습니다.', 3000);
    return true;
  }

  // ── 폴더 설정 (검색 폴더 / 업로드 폴더) ──
  // 사진 찾기 폴더 = 여러 개 (예전 저장값은 폴더 1개 객체)
  function getFolders() { var v = lsJson(LS_FOLDER); return Array.isArray(v) ? v : v ? [v] : []; }
  function setFolders(a) { if (a && a.length) lsSet(LS_FOLDER, JSON.stringify(a)); else lsDel(LS_FOLDER); updBtn(); }
  function folderLabel(a) { return a.length ? a.map(function (f) { return f.path || f.name; }).join(', ') : '전체 드라이브'; }
  function getUpFolder() { return lsJson(LS_UPF); }
  function getUpNet() { return lsGet(LS_UPNET) || 'off'; }      // off | wifi | any
  function uploadOn() { return getUpNet() !== 'off' && !!getUpFolder(); }
  function getUpKB() { var v = parseInt(lsGet(LS_UPQ) || '0', 10); return v > 0 ? v : 0; }
  function camSaveOn() { return lsGet(LS_CAMSAVE) !== '0'; }        // 찍은 사진 휴대폰 저장 (기본 켬)
  function updBtn() {
    var fs = getFolders();
    btn.classList.toggle('gd-folder', fs.length > 0);
    btn.title = '구글 드라이브에서 지금 화면 안에서 찍은 사진을 찾아 지도에 올리기\n검색 폴더: '
      + folderLabel(fs) + '\n(길게 누르면 폴더·파일·업로드 설정)';
  }
  // 폴더 id → 그 폴더와 모든 하위 폴더 id 집합
  function subtree(rootId, folders) {
    var kids = {}, set = {}, q = [rootId];
    folders.forEach(function (f) { (kids[f[2]] = kids[f[2]] || []).push(f[0]); });
    set[rootId] = 1;
    while (q.length) { (kids[q.pop()] || []).forEach(function (k) { if (!set[k]) { set[k] = 1; q.push(k); } }); }
    return set;
  }
  function folderPath(id, byId) {
    var parts = [], guard = 0;
    while (id && byId[id] && guard++ < 50) { parts.unshift(byId[id][1]); id = byId[id][2]; }
    return parts.join(' / ');
  }

  // ── 설정 (드라이브 버튼 길게 누르기) ──
  function showSetup() {
    if (!clientId()) { showCidForm(); return; }
    var fs = getFolders(), uf = getUpFolder(), net = getUpNet();
    countQueue().then(function (q) {
      openPanel(
        '<b style="font-size:15px;">구글 드라이브 설정</b>' +
        '<div style="margin-top:8px;">사진 찾기 폴더 (하위 폴더 포함)</div>' +
        (fs.length ? fs.map(function (f, i) {
            return '<div class="path" style="display:flex;align-items:center;gap:6px;">📁 <span style="flex:1;">' + esc(f.path || f.name) + '</span>' +
              '<button data-rmf="' + i + '" style="padding:3px 9px;font-size:13px;">✕</button></div>';
          }).join('') : '<div class="path">📁 전체 드라이브</div>') +
        '<div class="btns"><button class="pri" id="gdPick">' + (fs.length ? '폴더 추가 · 파일 열기' : '폴더 고르기 · 파일 열기') + '</button>' +
          (fs.length ? '<button id="gdAllDrive">전체 드라이브로</button>' : '') + '</div>' +
        '<div style="color:#888;font-size:12px;margin-top:4px;">폴더 화면에서 KMZ·GPX·BGPX·HTM 파일을 누르면 지도에 불러옵니다. 왼쪽 칸을 체크하면 여러 개를 한 번에 엽니다. 찾기 폴더는 여러 개 추가할 수 있습니다.</div>' +
        '<div class="sec"><b>자동 업로드</b> (📷 촬영 사진 + 📂 로 넣은 휴대폰 사진)' +
          '<div class="path" style="margin-top:4px;">⬆ ' + esc(uf ? uf.path || uf.name : '업로드 폴더 없음') + '</div>' +
          '<div class="btns"><button id="gdUpPick">업로드 폴더 고르기</button></div>' +
          '<div class="net" style="margin-top:8px;">' +
            '<label><input type="radio" name="gdnet" value="off"' + (net === 'off' ? ' checked' : '') + '>끔</label>' +
            '<label><input type="radio" name="gdnet" value="wifi"' + (net === 'wifi' ? ' checked' : '') + '>와이파이만</label>' +
            '<label><input type="radio" name="gdnet" value="any"' + (net === 'any' ? ' checked' : '') + '>와이파이+데이터</label></div>' +
          '<div style="margin-top:8px;">올리는 사진 용량 <select id="gdUpQ" style="font-size:14px;padding:5px;border-radius:6px;">' +
            UPQ_OPTS.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === getUpKB() ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
          '</select> <span style="color:#888;font-size:12px;">(줄이면 긴 변 1920px 이하 · 위치·날짜·제목 유지)</span></div>' +
          '<label style="display:block;margin-top:6px;font-size:14px;"><input type="checkbox" id="gdCamSave"' + (camSaveOn() ? ' checked' : '') + '> 📷 찍은 사진을 휴대폰에도 저장 (원본 화질 · 다운로드 폴더)</label>' +
          '<div style="margin-top:6px;">대기 ' + q.wait + '장' + (q.fail ? ' · 실패 ' + q.fail + '장' : '') + ' · 올림 ' + q.done + '장' +
            (metaPendCount() ? ' · 드라이브 수정 대기 ' + metaPendCount() + '건' : '') +
            ' <span style="color:#888;font-size:12px;">(지금 연결: ' + netLabel() + ')</span></div>' +
          '<div class="btns">' + (q.wait + q.fail + metaPendCount() ? '<button id="gdUpNow">지금 올리기</button>' : '') +
            '<button id="gdShots">📷 찍은 사진 업로드 기록</button></div>' +
        '</div>' +
        '<div class="sec"><b>사진 정보 보기 · 수정</b>' +
          '<div class="btns"><button class="pri" id="gdMapPhotos">🖼 지금 화면 안의 사진 목록</button></div>' +
          '<div style="color:#888;font-size:12px;">📷 버튼을 길게 눌러도 열립니다. 사진 말풍선의 📝 로도 고칠 수 있습니다.</div>' +
        '</div>' +
        '<div class="sec" style="color:#888;font-size:12px;">지도 미리 받기·지도 파일 가져오기는 ⚙️ 설정 버튼으로 옮겼습니다.</div>' +
        '<div class="sec btns"><button id="gdCacheClr">목록 새로 받기</button>' +
          '<button id="gdCidEdit">클라이언트 ID</button><button id="gdClose">닫기</button></div>' +
        '<div style="color:#888;margin-top:8px;font-size:12px;">드라이브 사진·폴더 목록은 6시간 동안 기억합니다. 그 사이 새로 올린 사진이나 새 폴더는 "목록 새로 받기" 후 찾으세요.<br>' +
          '업로드는 앱이 열려 있을 때만 진행됩니다. 닫으면 다음에 열 때 이어서 올립니다.</div>');
      $('gdPick').onclick = function () { openPicker('browse', null); };
      if ($('gdAllDrive')) $('gdAllDrive').onclick = function () { setFolders([]); showSetup(); };
      Array.prototype.forEach.call($('gdBox').querySelectorAll('button[data-rmf]'), function (b2) {
        b2.onclick = function () { var a = getFolders(); a.splice(+b2.getAttribute('data-rmf'), 1); setFolders(a); showSetup(); };
      });
      $('gdUpPick').onclick = function () { openPicker('upload', uf && uf.id !== 'root' ? uf.id : null); };
      Array.prototype.forEach.call(document.querySelectorAll('input[name=gdnet]'), function (r) {
        r.onchange = function () {
          lsSet(LS_UPNET, r.value);
          if (r.value !== 'off' && !getUpFolder()) alert('업로드 폴더를 먼저 골라 주세요.');
          pump();
        };
      });
      $('gdUpQ').onchange = function () { lsSet(LS_UPQ, this.value); };
      $('gdCamSave').onchange = function () { lsSet(LS_CAMSAVE, this.checked ? '1' : '0'); };
      $('gdMapPhotos').onclick = function () { showMapPhotos(showSetup); };
      if ($('gdUpNow')) $('gdUpNow').onclick = function () { closePanel(); pump(true); };
      $('gdShots').onclick = showShots;
      $('gdCacheClr').onclick = function () { lsDel(LS_CACHE); closePanel(); alert('다음 검색 때 드라이브 목록을 새로 받습니다.'); };
      $('gdCidEdit').onclick = showCidForm;
      $('gdClose').onclick = closePanel;
    });
  }

  // ── 폴더 고르기 / 파일 열기 ── mode: 'browse'(사진 찾기 폴더 + 파일 열기) | 'upload'(업로드 폴더)
  // 폴더 트리는 캐시된 색인에서, 파일 목록은 폴더마다 그때그때 조회
  function openPicker(mode, startId) {
    if (_busy) return;
    var tok = mode === 'upload' ? getToken(true) : getToken();
    if (!tok) { login({ picker: mode }); return; }
    _busy = true;
    closePanel();
    var job = startJob();
    status('드라이브 목록 받는 중...');
    loadIndex(tok, false).then(function (idx) {
      if (cancelled(job)) return;
      done();
      renderPicker(mode, idx, startId);
    }).catch(function (e) {
      if (cancelled(job)) return;
      done();
      if (e.auth) { login({ picker: mode }); return; }
      alert('드라이브 폴더 조회 실패: ' + e.message);
    });
  }
  function renderPicker(mode, idx, cur) {
    var byId = {};
    idx.folders.forEach(function (f) { byId[f[0]] = f; });
    if (cur && !byId[cur]) cur = null;
    function count(id) {        // 이 폴더(하위 포함)의 위치 있는 사진 수 — 고르는 데 참고
      var set = subtree(id, idx.folders), n = 0;
      idx.files.forEach(function (p) { if (set[p[6]]) n++; });
      return n;
    }
    // 최상위 = 부모가 폴더 목록에 없는 폴더 (내 드라이브 바로 아래 + 공유받은 폴더)
    var kids = idx.folders.filter(function (f) { return cur ? f[2] === cur : !byId[f[2]]; })
      .sort(function (a, c) { return a[1].localeCompare(c[1], 'ko'); });
    var browse = mode === 'browse';
    var chosen = {};
    if (browse) getFolders().forEach(function (f) { chosen[f.id] = 1; });
    openPanel('<b style="font-size:15px;">' + (browse ? '폴더 고르기 · 파일 열기' : '업로드 폴더 고르기') + '</b>' +
      '<div class="path" style="margin-top:6px;">📁 ' + esc(cur ? folderPath(cur, byId) : '내 드라이브 (최상위)') + '</div>' +
      (cur && browse ? '<div style="color:#666;font-size:12px;">이 폴더와 하위 폴더의 위치 있는 사진: ' + count(cur) + '장</div>' : '') +
      '<div class="fl" id="gdList">' +
        (cur ? '<div class="fr" data-up="1"><span>⬆</span><span class="nm">상위 폴더로</span></div>' : '') +
        kids.map(function (f) {
          return '<div class="fr" data-id="' + esc(f[0]) + '"><span>📁</span><span class="nm">' + esc(f[1]) +
            (chosen[f[0]] ? ' <span style="color:#1a73e8;font-size:12px;">✔ 찾기 폴더</span>' : '') + '</span><span class="ct">›</span></div>';
        }).join('') +
        (browse ? '<div id="gdFiles" style="padding:10px;color:#888;">파일 목록 받는 중...</div>'
                : (kids.length ? '' : '<div style="padding:12px;color:#888;">하위 폴더 없음</div>')) +
      '</div>' +
      '<div class="btns">' +
        (browse ? '<button class="pri" id="gdOpenSel" style="display:none;"></button>' +
                  (cur ? (chosen[cur] ? '<button id="gdUnuse">이 폴더 빼기</button>' : '<button class="pri" id="gdUse">＋ 사진 찾기 폴더에 추가</button>') : '') +
                  '<button id="gdUseAll">전체 드라이브</button>'
                : '<button class="pri" id="gdUseUp">이 폴더에 올리기</button>') +
        '<button id="gdBack">닫기</button><button id="gdToSetup">설정으로</button></div>');
    Array.prototype.forEach.call($('gdBox').querySelectorAll('.fr[data-id],.fr[data-up]'), function (row) {
      row.onclick = function () {
        if (row.getAttribute('data-up')) renderPicker(mode, idx, byId[cur] && byId[byId[cur][2]] ? byId[cur][2] : null);
        else renderPicker(mode, idx, row.getAttribute('data-id'));
      };
    });
    $('gdBack').onclick = closePanel;
    $('gdToSetup').onclick = showSetup;                    // 취소 = 창 닫기 (예전엔 설정 화면으로 돌아가 반응 없는 것처럼 보였음)
    if (browse) {
      if ($('gdUse')) $('gdUse').onclick = function () {
        var a = getFolders().filter(function (f) { return f.id !== cur; });
        a.push({ id: cur, name: byId[cur][1], path: folderPath(cur, byId) });
        setFolders(a);
        if (confirm('사진 찾기 폴더 (' + a.length + '개, 하위 폴더 포함):\n- ' + a.map(function (f) { return f.path || f.name; }).join('\n- ') +
          '\n\n폴더를 더 추가할까요?\n(확인 = 계속 고르기, 취소 = 끝)')) renderPicker(mode, idx, byId[cur] && byId[byId[cur][2]] ? byId[cur][2] : null);
        else showSetup();
      };
      if ($('gdUnuse')) $('gdUnuse').onclick = function () {
        setFolders(getFolders().filter(function (f) { return f.id !== cur; }));
        renderPicker(mode, idx, cur);
      };
      $('gdUseAll').onclick = function () { setFolders([]); closePanel(); alert('사진 찾기 폴더: 전체 드라이브'); };
      listFiles(cur || 'root').then(function (files) {
        var box = $('gdFiles'); if (!box) return;
        if (!files.length) { box.textContent = '이 폴더에 불러올 파일(KMZ·GPX·BGPX·HTM) 없음'; return; }
        box.outerHTML = files.map(function (f) {
          var ic = /\.(gpx|bgpx)$/i.test(f.name) ? '〰️' : /\.html?$/i.test(f.name) ? '📄' : '🗺️';
          var sz = f.size ? (f.size > 1048576 ? (f.size / 1048576).toFixed(1) + 'MB' : Math.ceil(f.size / 1024) + 'KB') : '';
          return '<div class="fr" data-file="' + esc(f.id) + '"><input type="checkbox" class="gdChk" style="width:20px;height:20px;flex-shrink:0;">' +
            '<span>' + ic + '</span><span class="nm">' + esc(f.name) + '</span><span class="ct">' + sz + '</span></div>';
        }).join('');
        // 체크 = 여러 개 골라 한 번에 열기, 이름 누르기 = 그 파일만 바로 열기
        var selBtn = $('gdOpenSel');
        function picked() {
          return Array.prototype.filter.call($('gdBox').querySelectorAll('.fr[data-file]'), function (r) { return r.querySelector('.gdChk').checked; })
            .map(function (r) { return files.filter(function (x) { return x.id === r.getAttribute('data-file'); })[0]; });
        }
        function updSel() { var n = picked().length; selBtn.style.display = n ? '' : 'none'; selBtn.textContent = '선택한 파일 ' + n + '개 열기'; }
        selBtn.onclick = function () { var a = picked(); if (a.length) { closePanel(); openDriveFiles(a); } };
        Array.prototype.forEach.call($('gdBox').querySelectorAll('.fr[data-file]'), function (row) {
          var chk = row.querySelector('.gdChk');
          chk.onclick = function (e) { e.stopPropagation(); updSel(); };
          row.onclick = function () {
            if (picked().length) { chk.checked = !chk.checked; updSel(); return; }     // 고르는 중이면 누르기 = 체크
            var f = files.filter(function (x) { return x.id === row.getAttribute('data-file'); })[0];
            closePanel(); openDriveFiles([f]);
          };
        });
      }).catch(function (e) {
        var box = $('gdFiles'); if (box) box.textContent = '파일 목록 실패: ' + (e.auth ? '로그인 만료 — 다시 열어 주세요' : e.message);
        if (e.auth) lsDel(LS_TOK);
      });
    } else {
      $('gdUseUp').onclick = function () {
        var f = cur ? { id: cur, name: byId[cur][1], path: folderPath(cur, byId) } : { id: 'root', name: '내 드라이브', path: '내 드라이브' };
        lsSet(LS_UPF, JSON.stringify(f));
        if (getUpNet() === 'off') lsSet(LS_UPNET, 'wifi');       // 폴더를 고르면 기본 '와이파이만'으로 켬
        showSetup();
        pump();
      };
    }
  }
  function listFiles(parentId) {
    var tok = getToken(); if (!tok) { var e = new Error('auth'); e.auth = true; return Promise.reject(e); }
    var out = [];
    return listPaged(tok, "'" + parentId + "' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'",
      'id,name,mimeType,size', function (arr) { arr.forEach(function (f) { if (FILE_RE.test(f.name)) out.push({ id: f.id, name: f.name, size: +f.size || 0 }); }); }
    ).then(function () { return out.sort(function (a, c) { return a.name.localeCompare(c.name, 'ko'); }); });
  }
  // 드라이브 파일 여러 개를 받아 한 번에 지도에 불러오기
  async function openDriveFiles(list) {
    var tok = getToken(); if (!tok) { login({ picker: 'browse' }); return; }
    var out = [], bad = [], job = startJob();
    try {
      for (var i = 0; i < list.length; i++) {
        var f = list[i];
        if (job.cancelled) break;
        status('드라이브에서 받는 중... (' + (i + 1) + '/' + list.length + ') ' + f.name);
        try {
          var bl = await (await api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?alt=media', tok, { signal: jobSignal(job) })).blob();
          var file = new File([bl], f.name, { type: bl.type || '' });
          file._fromDrive = true;
          file._gdId = f.id;                               // 사진 정보 수정 때 드라이브 파일도 고치려고
          out.push(file);
        } catch (e) { if (e.auth) throw e; if (job.cancelled) break; bad.push(f.name); }
      }
      if (cancelled(job, '파일 열기를 중단했습니다.')) return;
      endJob(); hideLoading();
      if (out.length) await feedFiles(out);
      if (bad.length) alert('받지 못한 파일:\n' + bad.join('\n'));
    } catch (e) { if (cancelled(job, '파일 열기를 중단했습니다.')) return; endJob(); hideLoading(); if (e.auth) { login({ picker: 'browse' }); return; } alert('파일 받기 실패: ' + e.message); }
  }

  function showCidForm() {
    openPanel(
      '<b style="font-size:15px;">구글 드라이브 연결 (클라이언트 ID)</b><br>' +
      '1. <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank">Google Cloud 콘솔</a>에서 프로젝트를 만들고 <b>Google Drive API</b> 사용 설정<br>' +
      '2. API 및 서비스 → OAuth 동의 화면: 외부 / 테스트 상태, 테스트 사용자에 본인 Gmail 추가<br>' +
      '3. 사용자 인증 정보 → OAuth 클라이언트 ID → <b>웹 애플리케이션</b><br>' +
      '&nbsp;&nbsp;· 승인된 JavaScript 원본: <code>' + location.origin + '</code><br>' +
      '&nbsp;&nbsp;· 승인된 리디렉션 URI: <code>' + location.origin + '/img/</code> , <code>' + location.origin + '/Vmap/</code><br>' +
      '4. 만들어진 클라이언트 ID 를 아래에 붙여넣기' +
      '<input type="text" id="gdCid" placeholder="xxxx.apps.googleusercontent.com" value="' + esc(clientId()) + '">' +
      '<div class="btns"><button class="pri" id="gdCidSave">저장</button><button id="gdCidClose">닫기</button></div>' +
      '<div style="color:#888;margin-top:8px;">로그인 때 "확인되지 않은 앱" 경고가 나오면 고급 → 계속 을 누르세요 (본인이 만든 앱).</div>');
    $('gdCidClose').onclick = closePanel;
    $('gdCidSave').onclick = function () {
      var v = ($('gdCid').value || '').trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) { alert('클라이언트 ID 형식이 아닙니다.\n(....apps.googleusercontent.com 으로 끝나야 함)'); return; }
      if (v !== clientId()) { lsSet(LS_CID, v); lsDel(LS_TOK); lsDel(LS_CACHE); setFolders([]); lsDel(LS_UPF); }
      closePanel();
      alert('저장했습니다. 지도를 찾을 영역에 맞추고 드라이브 버튼을 누르세요.');
    };
  }

  // ── 길게 누르기 (드라이브·📷 버튼 공용) ──
  // 0.55초 누르고 있으면 onLong, 짧게 떼면 onShort. 길게 누른 뒤 따라오는 click 은 버린다.
  // 크롬은 0.5초쯤 지나면 글자 선택·메뉴를 띄우며 pointercancel 을 보내 타이머가 꺼졌다 → CSS(user-select·touch-callout·
  // touch-action) + contextmenu/selectstart 차단으로 막는다. 손가락이 조금 흔들려도(12px 안) 유지.
  // 길게 누르기로 창을 연 직후, 손을 떼며 생기는 click 이 막 열린 창의 바깥 배경(= 닫기)에 떨어져
  // 창이 열리자마자 닫히던 문제 → 실행 직후 0.7초 동안은 화면 어디의 click 이든 버린다(캡처 단계).
  var _swallowClickUntil = 0;
  document.addEventListener('click', function (e) {
    if (Date.now() < _swallowClickUntil) { _swallowClickUntil = 0; e.preventDefault(); e.stopPropagation(); }
  }, true);
  function longPress(el, onLong, onShort) {
    var timer = null, fired = false, x0 = 0, y0 = 0, down = false;
    function stop() { clearTimeout(timer); timer = null; down = false; }
    el.addEventListener('pointerdown', function (e) {
      fired = false; down = true; x0 = e.clientX; y0 = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null; if (!down) return; fired = true; down = false;
        _swallowClickUntil = Date.now() + 700;
        onLong();
      }, 550);
    });
    el.addEventListener('pointermove', function (e) {
      if (down && (Math.abs(e.clientX - x0) > 12 || Math.abs(e.clientY - y0) > 12)) stop();
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) { el.addEventListener(ev, stop); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    el.addEventListener('selectstart', function (e) { e.preventDefault(); });
    el.addEventListener('click', function (e) {
      if (fired) { fired = false; e.preventDefault(); e.stopImmediatePropagation(); return; }
      onShort(e);
    });
  }

  // 드라이브 버튼: 길게 = 설정 열기, 짧게 = 검색
  longPress(btn, function () { showSetup(); }, function () { search(false); });

  // ── 드라이브 API ──
  function api(url, tok, opt) {
    opt = opt || {};
    var headers = opt.headers || {}; headers.Authorization = 'Bearer ' + tok;
    return fetch(url, { method: opt.method || 'GET', headers: headers, body: opt.body, signal: opt.signal }).then(function (r) {
      if (r.status === 401) { lsDel(LS_TOK); var e = new Error('auth'); e.auth = true; throw e; }
      if (!r.ok) return r.text().then(function (t) { var e = new Error('HTTP ' + r.status + ' ' + t.slice(0, 200)); e.status = r.status; throw e; });
      return r;
    });
  }
  // 드라이브 색인 = { files: 위치 있는 사진 [id, name, lat, lng, 'YYYY-MM-DD HH:MM', mime, 부모폴더id],
  //                  folders: [id, name, 부모폴더id] }  — 둘 다 받아 6시간 캐시
  function listPaged(tok, q, fields, onPage) {
    function page(pt) {
      var url = 'https://www.googleapis.com/drive/v3/files?pageSize=1000&spaces=drive'
        + '&q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('nextPageToken,files(' + fields + ')')
        + (pt ? '&pageToken=' + encodeURIComponent(pt) : '');
      return api(url, tok).then(function (r) { return r.json(); }).then(function (j) {
        onPage(j.files || []);
        return j.nextPageToken ? page(j.nextPageToken) : null;
      });
    }
    return page(null);
  }
  function loadIndex(tok, force) {
    if (!force) {
      var c = lsJson(LS_CACHE);
      if (c && c.cid === clientId() && Date.now() - c.at < CACHE_MS && c.folders) return Promise.resolve(c);
    }
    var files = [], folders = [], scanned = 0;
    return listPaged(tok, "mimeType='application/vnd.google-apps.folder' and trashed=false", 'id,name,parents', function (arr) {
      arr.forEach(function (f) { folders.push([f.id, f.name, (f.parents && f.parents[0]) || '']); });
      status('드라이브 폴더 목록 받는 중... ' + folders.length + '개');
    }).then(function () {
      return listPaged(tok, "(mimeType='image/jpeg' or mimeType='image/png') and trashed=false",
        'id,name,mimeType,createdTime,parents,imageMediaMetadata(location,time)', function (arr) {
        arr.forEach(function (f) {
          scanned++;
          var m = f.imageMediaMetadata || {}, loc = m.location;
          if (!loc || typeof loc.latitude !== 'number' || (loc.latitude === 0 && loc.longitude === 0)) return;
          var t = m.time ? m.time.replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3').slice(0, 16)
                         : (f.createdTime || '').replace('T', ' ').slice(0, 16);
          files.push([f.id, f.name, loc.latitude, loc.longitude, t, f.mimeType, (f.parents && f.parents[0]) || '']);
        });
        status('드라이브 사진 목록 받는 중... ' + scanned + '장 확인, 위치 있는 사진 ' + files.length + '장');
      });
    }).then(function () {
      var idx = { cid: clientId(), at: Date.now(), files: files, folders: folders };
      lsSet(LS_CACHE, JSON.stringify(idx));
      return idx;
    });
  }

  // ── 영역 사진 찾기 → 바로 받아서 지도에 올리기 ──
  function search(force, b) {
    if (_busy) return;
    if (!clientId()) { showCidForm(); return; }
    b = b || getBounds();
    if (!b) { alert('지도가 아직 준비되지 않았습니다. 잠시 후 다시 누르세요.'); return; }
    var tok = getToken();
    if (!tok) { login({ b: b, force: !!force }); return; }
    _busy = true;
    status('드라이브 사진 목록 받는 중...');
    var fds = getFolders();
    var job = startJob();
    loadIndex(tok, force).then(function (idx) {
      if (cancelled(job)) return;
      var files = idx.files, where = '';
      if (fds.length) {
        var ok = fds.filter(function (fd) { return idx.folders.some(function (f) { return f[0] === fd.id; }); });
        var gone = fds.filter(function (fd) { return ok.indexOf(fd) < 0; });
        if (!ok.length) {
          done();
          alert('검색 폴더 "' + folderLabel(fds) + '" 를 드라이브에서 찾을 수 없습니다.\n(삭제·이동됐거나 목록이 오래됨)\n\n드라이브 버튼을 길게 눌러 폴더를 다시 고르거나 "목록 새로 받기" 하세요.');
          return;
        }
        var set = {};                                     // 고른 폴더들 + 각각의 하위 폴더
        ok.forEach(function (fd) { var s1 = subtree(fd.id, idx.folders); for (var k in s1) set[k] = 1; });
        files = files.filter(function (f) { return set[f[6]]; });
        where = '\n(검색 폴더: ' + folderLabel(ok) + ' + 하위 폴더)' + (gone.length ? '\n(못 찾은 폴더: ' + folderLabel(gone) + ')' : '');
      }
      var hit = files.filter(function (f) { return f[2] >= b.s && f[2] <= b.n && f[3] >= b.w && f[3] <= b.e; });
      var onMap = onMapTest();
      var list = hit.filter(function (f) { return !onMap(f); });
      if (!hit.length) {
        done();
        alert('이 화면 안에서 찍힌 드라이브 사진이 없습니다.' + where + '\n(위치 있는 사진 ' + files.length + '장 중)\n\n'
          + '지도를 넓혀 보거나, 최근에 올린 사진이면 드라이브 버튼을 길게 눌러 "목록 새로 받기" 하세요.');
        return;
      }
      if (!list.length) { done(); alert('이 화면의 드라이브 사진 ' + hit.length + '장은 이미 지도에 올렸습니다.' + where); return; }
      if (list.length > 30) {
        hideLoading();
        if (!confirm('이 화면 안에 드라이브 사진 ' + list.length + '장이 있습니다.' + where + '\n모두 내려받아 지도에 올릴까요? (데이터를 많이 쓸 수 있음)\n\n'
          + '취소하고 지도를 확대해 영역을 좁힐 수도 있습니다.')) { done(); return; }
      }
      return download(list, tok, job, b);
    }).catch(function (e) {
      if (cancelled(job, '사진 불러오기를 중단했습니다.')) return;
      done();
      if (e.auth) { login({ b: b, force: !!force }); return; }
      alert('드라이브 조회 실패: ' + e.message + '\n\n클라이언트 ID·Drive API 사용 설정·테스트 사용자 등록을 확인하세요.\n(드라이브 버튼을 길게 누르면 설정)');
    });
  }

  function download(list, tok, job, b) {
    var got = [], fail = 0, n = 0, idx = 0;
    status('드라이브에서 사진 받는 중... (0/' + list.length + ')');
    function worker() {
      if (idx >= list.length || (job && job.cancelled)) return Promise.resolve();
      var f = list[idx++];
      return api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f[0]) + '?alt=media', tok, { signal: jobSignal(job) })
        .then(function (r) { return r.blob(); })
        .then(function (bl) {
                var file = new File([bl], f[1], { type: f[5] || bl.type || 'image/jpeg' });
                file._fromDrive = true;                       // 드라이브에서 온 사진은 다시 업로드하지 않음
                file._gdId = f[0];
                got.push({ f: f, file: file });
              }, function () { fail++; })
        .then(function () { n++; if (!(job && job.cancelled)) status('드라이브에서 사진 받는 중... (' + n + '/' + list.length + ')'); return worker(); });
    }
    return Promise.all([worker(), worker(), worker()]).then(function () {
      if (cancelled(job, '사진 불러오기를 중단했습니다. (지도에 올린 사진 없음)')) return;
      hideLoading();
      if (!got.length) { lsDel(LS_TOK); _busy = false; alert('사진을 받지 못했습니다. 다시 눌러 로그인 후 시도하세요.'); return; }
      // 촬영 순서대로 올림 (기존 📂 불러오기 처리에 그대로 넘김 → 마커·자동저장 동일)
      got.sort(function (a, c) { return (a.f[4] || '').localeCompare(c.f[4] || ''); });
      return feedFiles(got.map(function (g) { return g.file; }), job).then(function (nOk) {
        if (b) fitBounds(b);                              // 묶음별로 움직인 지도를 검색했던 화면으로
        if (cancelled(job, '사진 불러오기를 중단했습니다. (' + nOk + '/' + got.length + '장 올림)')) return;
        done();
        if (fail) alert(got.length + '장을 올렸고, ' + fail + '장은 받지 못했습니다.');
      });
    }).catch(function (e) { if (cancelled(job)) return; done(); alert('올리기 실패: ' + e.message); });
  }

  // ════ GPX / BGPX → KML (map_kmz/map.html 의 _bgpxToGpx·_gpxToKml 과 같은 코드 — 고치면 같이) ════
  // .bgpx(이진 GPX, 'Bgpx' 헤더): 'Bgpx' + 크기(4) + 가변정수 [2,0,1] + 문자열 2개(트랙 이름, 종류) 뒤
  //  (2023년 무렵 파일은 머리말이 [0] 하나뿐 — 나머지 구조는 같다. 2026-10-03 track20231114_613.bgpx 로 확인.
  //   map.html·사진위치표시.py 는 [2,0,1] 만 가정해 옛 파일을 못 읽는다 → 여기선 둘 다 시도해 좌표가 정상인 쪽을 쓴다)
  //  가변정수 [기준시각,0,1,점수,사진수?,1,점수,위도,경도,고도,시각] 다음 점마다 차분 [?,d위도,d경도,d고도,d시각].
  //  가변정수 = 큰 쪽부터 7비트씩(0x80 이어짐). 부호 있는 값은 첫 바이트 0x40 이 음수. 위경도 1e-7도, 고도 0.1m, 시각 2020-01-01 UTC 부터 초.
  function _bgpxToGpx(u8) {
    var T0 = Date.UTC(2020, 0, 1) / 1000;
    function pt(la, lo, el, t) {
      return '<trkpt lat="' + (la / 1e7).toFixed(7) + '" lon="' + (lo / 1e7).toFixed(7) + '"><ele>' + (el / 10).toFixed(1) + '</ele><time>'
        + new Date((T0 + t) * 1000).toISOString().replace('.000Z', 'Z') + '</time></trkpt>';
    }
    function parse(prefix) {        // prefix = 이름 앞 가변정수 개수 (새 형식 3, 옛 형식 1)
      var pos = 8;
      function vlq(signed) {
        if (signed === undefined) signed = true;
        if (pos >= u8.length) throw new RangeError('bgpx 끝');
        var b = u8[pos++], neg = signed && (b & 0x40), v = b & (signed ? 0x3f : 0x7f);
        while (b & 0x80) { if (pos >= u8.length) throw new RangeError('bgpx 끝'); b = u8[pos++]; v = v * 128 + (b & 0x7f); }
        return neg ? -v : v;
      }
      function str() { var n = vlq(false); if (n > 200) throw new Error('이름 길이 이상'); var s = new TextDecoder('utf-8', { fatal: true }).decode(u8.subarray(pos, pos + n)); pos += n; return s; }
      var name = '', pts = [];
      try {
        for (var p = 0; p < prefix; p++) vlq(false);
        name = str(); str();                                              // 트랙 이름 + 종류
        var h = []; for (var i = 0; i < 11; i++) h.push(vlq(i >= 7));       // 앞 7개(시각·개수)는 부호 없음
        var n = h[3], lat = h[7], lon = h[8], ele = h[9], t = h[10];
        if (!n || Math.abs(lat) > 9e8 || Math.abs(lon) > 18e8 || (!lat && !lon)) return null;
        pts.push(pt(lat, lon, ele, t));
        for (var k = 1; k < n; k++) {
          var r = [vlq(), vlq(), vlq(), vlq(), vlq()];
          lat += r[1]; lon += r[2]; ele += r[3]; t += r[4];
          pts.push(pt(lat, lon, ele, t));
        }
      } catch (e) { if (!(e instanceof RangeError)) return null; }        // 잘린 파일 — 읽은 데까지만
      return pts.length ? { name: name, pts: pts } : null;
    }
    var r = parse(3) || parse(1) || parse(2);
    if (!r) throw new Error('bgpx 형식을 읽지 못했습니다');
    return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="bgpx" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>'
      + esc(r.name || '트랙') + '</name><trkseg>\n' + r.pts.join('\n') + '\n</trkseg></trk>\n</gpx>\n';
  }
  // GPX → KML: 트랙(trk/trkseg)·경로(rte) → LineString, 웨이포인트(wpt) → Point. gpx_style 색·굵기 확장은 살린다.
  function _gpxToKml(text) {
    var xml = new DOMParser().parseFromString(text, 'application/xml');
    function child(el, tag) { return Array.prototype.filter.call(el.children, function (c) { return c.localName === tag; })[0]; }
    function all(el, tag) { return Array.prototype.slice.call(el.getElementsByTagNameNS('*', tag)); }
    function ll(p) { return p.getAttribute('lon') + ',' + p.getAttribute('lat') + ',0'; }
    var styles = '', pms = '', sn = 0;
    function line(el, segs, idx) {
      segs = segs.filter(function (s) { return s.length >= 2; });
      if (!segs.length) return;
      var su = '', ex = child(el, 'extensions');
      if (ex) {
        var c = ((all(ex, 'color')[0] || {}).textContent || '').trim().replace('#', '');
        var w = parseFloat((all(ex, 'width')[0] || {}).textContent) || 3;
        if (/^[0-9a-f]{6}$/i.test(c)) {
          var id = 'gs' + (sn++);
          styles += '<Style id="' + id + '"><LineStyle><color>ff' + c.slice(4, 6) + c.slice(2, 4) + c.slice(0, 2) + '</color><width>' + w + '</width></LineStyle></Style>\n';
          su = '<styleUrl>#' + id + '</styleUrl>';
        }
      }
      var g = segs.map(function (s) { return '<LineString><coordinates>' + s.map(ll).join(' ') + '</coordinates></LineString>'; });
      var nm = esc((child(el, 'name') || {}).textContent || ('경로' + idx));
      pms += '<Placemark><name>' + nm + '</name>' + su + (g.length === 1 ? g[0] : '<MultiGeometry>' + g.join('') + '</MultiGeometry>') + '</Placemark>\n';
    }
    all(xml, 'trk').forEach(function (t, i) { line(t, all(t, 'trkseg').map(function (s) { return all(s, 'trkpt'); }), i + 1); });
    all(xml, 'rte').forEach(function (r, i) { line(r, [all(r, 'rtept')], i + 1); });
    all(xml, 'wpt').forEach(function (p) {
      pms += '<Placemark><name>' + esc((child(p, 'name') || {}).textContent || '') + '</name><Point><coordinates>' + ll(p) + '</coordinates></Point></Placemark>\n';
    });
    return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n' + styles + pms + '</Document></kml>';
  }
  async function trackToKmlFile(file) {
    var u8 = new Uint8Array(await file.arrayBuffer());
    var gpx = (u8[0] === 0x42 && u8[1] === 0x67) ? _bgpxToGpx(u8) : new TextDecoder('utf-8').decode(u8);   // 'Bg' = bgpx
    var kml = _gpxToKml(gpx);
    if (!/<Placemark>/.test(kml)) throw new Error('트랙·웨이포인트가 없습니다');
    return new File([kml], file.name.replace(/\.(b?gpx)$/i, '') + '.kml', { type: 'application/vnd.google-earth.kml+xml' });
  }

  // ════ 📂 불러오기 가로채기: GPX/BGPX 변환 + 휴대폰 사진 업로드 대기열 ════
  // 원래 처리(_origLoad)는 그대로 두고 앞단만 끼운다 — 마커·자동저장 로직은 지도별 원래 코드.
  var fileInput = document.getElementById('fileInput');
  var _origLoad = fileInput && fileInput.onchange;
  if (fileInput) {
    fileInput.accept = (fileInput.accept || '') + ',.gpx,.bgpx';
    fileInput.onchange = function (e) {
      var files = Array.prototype.slice.call(e.target.files || []);
      try { e.target.value = ''; } catch (er) {}
      return feedFiles(files);
    };
  }
  function isImage(f) { return /\.(jpe?g|png)$/i.test(f.name) || /^image\//.test(f.type || ''); }
  async function feedFiles(files, job) {
    if (!files.length || !_origLoad) return 0;
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (/\.b?gpx$/i.test(f.name)) {
        try { out.push(await trackToKmlFile(f)); } catch (er) { alert(f.name + ' 을(를) 읽지 못했습니다.\n(' + er.message + ')'); }
      } else out.push(f);
    }
    // 휴대폰에서 고른 사진 → 업로드 대기열 (드라이브에서 온 것·촬영 버튼 사진은 제외 — 촬영은 따로 넣음)
    if (uploadOn()) {
      var imgs = out.filter(function (f) { return isImage(f) && !f._fromDrive && !f._fromCam; });
      for (var j = 0; j < imgs.length; j++) imgs[j]._gdRec = await enqueue({ blob: imgs[j], name: imgs[j].name, key: imgs[j].name + '|' + imgs[j].size + '|' + (imgs[j].lastModified || 0) });
    }
    if (!out.length) return 0;
    if (!job) {
      await _origLoad.call(fileInput, { target: { files: out, value: '' } });
      pump();
      return out.length;
    }
    var nOk = 0, B = 5;
    for (var k = 0; k < out.length; k += B) {
      if (job.cancelled) break;
      await _origLoad.call(fileInput, { target: { files: out.slice(k, k + B), value: '' } });
      nOk = Math.min(out.length, k + B);
      if (!job.cancelled && nOk < out.length) status('지도에 사진 올리는 중... (' + nOk + '/' + out.length + ')');
    }
    pump();
    return nOk;
  }

  // ════ EXIF 기록 워커 — 페이지(메인 스레드)에서 큰 사진을 다루면 지도 백화가 났던 이력 ════
  // 지도 쪽 writePhotoMeta 와 보조 함수를 그대로 워커에 옮겨 같은 결과를 낸다(_fixExif 정규화 포함).
  var _exW = null, _exSeq = 0, _exCb = {};
  function exifWorker() {
    if (_exW) return _exW;
    var fns = ['_xpBytes', '_xpStr', '_gpsRat', 'exifNow', '_fixExif', '_exifSafeCarry', 'writePhotoMeta'];
    var src = 'self.window = self; importScripts("https://cdn.jsdelivr.net/npm/piexifjs");\n'
      + fns.map(function (n) { return String(window[n] || eval(n)); }).join('\n') + '\n'
      + 'function _rd(b) { return new FileReaderSync().readAsDataURL(new Blob([b], { type: "image/jpeg" })); }\n'   // 형식 표시가 비면 piexif 가 JPEG 아님으로 거부
      // 용량 줄이기 (map.html 사진용량과 같은 방식: 긴 변 1920 → 화질을 낮춰 목표 이하. 그래도 크면 크기를 더 줄임)
      + 'async function _shrink(blob, kb) {'
      + '  var bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }), T = kb * 1024;'
      + '  var s = Math.min(1, 1920 / Math.max(bmp.width, bmp.height)), out = null;'
      + '  for (var k = 0; k < 6; k++) {'
      + '    var cw = Math.max(1, Math.round(bmp.width * s)), ch = Math.max(1, Math.round(bmp.height * s)), c = new OffscreenCanvas(cw, ch);'
      + '    c.getContext("2d").drawImage(bmp, 0, 0, cw, ch);'
      + '    for (var q = 0.92; q >= 0.4; q = Math.round((q - 0.1) * 100) / 100) {'
      + '      out = await c.convertToBlob({ type: "image/jpeg", quality: q });'
      + '      if (out.size <= T) { bmp.close(); return out; }'
      + '    }'
      + '    s *= 0.75;'
      + '  }'
      + '  bmp.close(); return out;'
      + '}\n'
      + 'onmessage = async function (e) { var d = e.data; try {'
      + '  var url = _rd(d.blob);'
      + '  if (d.kb > 0) {'
      + '    var cu = _rd(await _shrink(d.blob, d.kb)), ex = null;'
      + '    try { ex = piexif.load(url); } catch (er) {}'
      // 원본 EXIF(위치·날짜·기종) 를 줄인 사진에 옮긴다. 회전은 픽셀에 반영됐으므로 1, 원본 썸네일은 버림
      + '    if (ex) { ex["0th"] = ex["0th"] || {}; ex["0th"][piexif.ImageIFD.Orientation] = 1; delete ex["1st"]; delete ex.thumbnail; url = _exifSafeCarry(ex, cu); }'
      + '    else url = cu;'
      + '  }'
      + '  var out = writePhotoMeta(url, d.meta);'
      + '  var bin = atob(out.slice(out.indexOf(",") + 1)), u8 = new Uint8Array(bin.length);'
      + '  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);'
      + '  postMessage({ id: d.id, blob: new Blob([u8], { type: "image/jpeg" }) });'
      + '} catch (er) { postMessage({ id: d.id, err: String(er) }); } };';
    _exW = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    _exW.onmessage = function (e) { var cb = _exCb[e.data.id]; delete _exCb[e.data.id]; if (cb) cb(e.data); };
    // piexif 를 못 받으면(오프라인에서 처음 띄울 때) 워커가 죽는다 → 기다리던 작업을 바로 실패시키고 다음에 새로 띄움
    _exW.onerror = function (ev) {
      try { ev.preventDefault(); } catch (e) {}
      var cbs = _exCb; _exCb = {}; _exW = null;
      Object.keys(cbs).forEach(function (k) { cbs[k]({ err: 'EXIF 도구를 못 불러옴(오프라인?)' }); });
    };
    return _exW;
  }
  // 인터넷 될 때 미리 띄워 둔다 — 띄울 때 piexif 를 받아 두므로 나중에 산속(오프라인)에서 찍어도 동작
  setTimeout(function () { try { if (navigator.onLine) exifWorker(); } catch (e) {} }, 3000);
  window.addEventListener('online', function () { try { exifWorker(); } catch (e) {} });
  // meta = { title, desc, lat, lng, taken } — 주는 항목만 기록, 나머지 EXIF 는 유지.
  // kb > 0 이면 그 용량 이하 JPEG 로 줄인 뒤 기록(이땐 PNG 등도 가능), 0 이면 JPEG 만.
  function writeMetaBlob(blob, meta, kb) {
    return new Promise(function (res, rej) {
      var w; try { w = exifWorker(); } catch (er) { rej(er); return; }
      var id = ++_exSeq;
      var to = setTimeout(function () { delete _exCb[id]; rej(new Error('EXIF 기록 시간 초과')); }, 60000);
      _exCb[id] = function (d) { clearTimeout(to); if (d.err) rej(new Error(d.err)); else res(d.blob); };
      w.postMessage({ id: id, blob: blob, meta: meta || {}, kb: kb || 0 });
    });
  }

  // ════ 📷 촬영 → 제목·설명 → EXIF → 지도 + 업로드 대기열 ════
  var _geoP = null;
  // 📷 버튼: 길게 = 지금 화면 안의 사진 목록(만), 짧게 = 촬영
  longPress(camBtn, function () { showMapPhotos(); }, function () { startCamera(); });
  function startCamera() {
    // 카메라가 열려 있는 동안 현재 위치를 미리 잡아 둔다 (사진에 GPS 가 없을 때 사용)
    _geoP = new Promise(function (res) {
      if (!navigator.geolocation) { res(null); return; }
      navigator.geolocation.getCurrentPosition(function (p) { res({ lat: p.coords.latitude, lng: p.coords.longitude }); },
        function () { res(null); }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 60000 });
    });
    camInput.value = '';
    camInput.click();
  }
  camInput.onchange = function () {
    var file = camInput.files && camInput.files[0];
    if (!file) return;
    askMeta({ title: '', desc: '', preview: file, isNew: true }, function (meta) {
      if (meta) processShot(file, meta);
    });
  };
  // 제목·설명 입력 창 (촬영 직후 / 찍은 사진 목록에서 수정)
  function askMeta(o, cb) {
    var url = o.preview ? URL.createObjectURL(o.preview) : '';
    _panelGuard = true;
    openPanel('<b style="font-size:15px;">' + (o.isNew ? '사진 정보 입력' : '사진 정보 수정') + '</b>' +
      (url ? '<img class="prev" src="' + url + '">' : '') +
      '<div>제목</div><input type="text" id="gdMtTitle" value="' + esc(o.title) + '" placeholder="예: 3번 맨홀 침하">' +
      '<div>설명 / 메모</div><textarea id="gdMtDesc" placeholder="자유 메모">' + esc(o.desc) + '</textarea>' +
      (o.isNew ? '<div style="margin-bottom:8px;">사진 용량 <select id="gdMtQ" style="font-size:14px;padding:5px;border-radius:6px;">' +
        UPQ_OPTS.map(function (q) { return '<option value="' + q[0] + '"' + (q[0] === getUpKB() ? ' selected' : '') + '>' + q[1] + '</option>'; }).join('') +
        '</select> <span style="color:#888;font-size:12px;">(드라이브에 이 용량으로 올림 · 다음에도 기억)</span></div>' +
        '<label style="display:block;margin-bottom:8px;font-size:14px;"><input type="checkbox" id="gdMtSave"' + (camSaveOn() ? ' checked' : '') + '> 휴대폰에도 저장 (원본 화질)</label>' : '') +
      '<div class="btns"><button class="pri" id="gdMtOk">' + (o.isNew ? '지도에 올리기' : '저장') + '</button>' +
      '<button id="gdMtCancel">' + (o.isNew ? '사진 버리기' : '취소') + '</button></div>' +
      (o.isNew ? '<div style="color:#888;font-size:12px;margin-top:6px;">제목·설명은 사진 파일(EXIF)에 들어가 탐색기·드라이브에서도 보입니다. 비워 둬도 됩니다.</div>' : ''));
    setTimeout(function () { try { $('gdMtTitle').focus(); } catch (e) {} }, 150);
    function finish(v) { if (url) URL.revokeObjectURL(url); closePanel(); cb(v); }
    if ($('gdMtQ')) $('gdMtQ').onchange = function () { lsSet(LS_UPQ, this.value); };
    if ($('gdMtSave')) $('gdMtSave').onchange = function () { lsSet(LS_CAMSAVE, this.checked ? '1' : '0'); };
    $('gdMtOk').onclick = function () { finish({ title: $('gdMtTitle').value.trim(), desc: $('gdMtDesc').value.trim() }); };
    _panelBack = function () { $('gdMtCancel').click(); };    // 찍은 직후면 '사진 버리기' 확인을 거친다
    $('gdMtCancel').onclick = function () {
      if (o.isNew && !confirm('찍은 사진을 버릴까요?')) return;
      finish(null);
    };
  }
  function shotName(title) {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    var stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    var t = (title || '').replace(/[\\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 60);
    return (t ? t + '_' : 'IMG_') + stamp + '.jpg';
  }
  async function processShot(file, meta) {
    status('사진 정리 중...');
    try {
      var m = { title: meta.title, desc: meta.desc };
      var fb = null;
      try { fb = await readPhotoMetaFallback(file); } catch (e) {}
      if (!fb || fb.lat == null) {
        var g = await Promise.race([_geoP || Promise.resolve(null), new Promise(function (r) { setTimeout(function () { r(null); }, 8000); })]);
        if (g) { m.lat = g.lat; m.lng = g.lng; }
      }
      if (!fb || !fb.taken) m.taken = exifNow();
      var out = file, full = file, kb = getUpKB(), isJpg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name);
      var name = shotName(meta.title);
      // 휴대폰 저장용 = 원본 화질 + 제목·설명·위치 EXIF. 드라이브가 와이파이 대기 중일 때 지도에서 지워도 남도록
      if (isJpg) { try { full = await writeMetaBlob(file, m, 0); } catch (e) { console.warn('EXIF 기록 실패 — 원본 사용', e); } }
      if (camSaveOn()) {
        try { var su = URL.createObjectURL(full); await downloadPhoto(su, name); setTimeout(function () { URL.revokeObjectURL(su); }, 15000); }
        catch (e) { console.warn('휴대폰 저장 실패', e); }
      }
      out = full;
      if (kb) {
        status('사진 용량 줄이는 중...');
        try { out = await writeMetaBlob(file, m, kb); } catch (e) { console.warn('용량 줄이기 실패 — 원본 사용', e); }
      }
      var f2 = new File([out], name, { type: 'image/jpeg' });
      f2._fromCam = true;
      hideLoading();
      if (m.lat == null && (!fb || fb.lat == null)) alert('사진 위치를 못 잡았습니다 (GPS 꺼짐?). 지도 가운데에 놓습니다.\n마커를 길게 눌러 위치를 옮길 수 있습니다.');
      // 대기열에 먼저 넣어 번호를 받고, 마커에 그 번호를 달아 둔다(사진 정보 수정 때 드라이브 파일을 찾으려고)
      f2._gdRec = await enqueue({ blob: f2, name: name, title: meta.title, desc: meta.desc, cam: true, hold: !uploadOn() });
      await feedFiles([f2]);
      pump();
    } catch (e) { hideLoading(); alert('사진 처리 실패: ' + e.message); }
  }

  // ════ 업로드 대기열 (IndexedDB 'gdrive_up') ════
  // 기록: { id, name, blob, key, cam, title, desc, st: 'wait'|'done'|'fail'|'hold', driveId, err, at }
  //  - hold: 업로드가 꺼진 동안 찍은 사진(목록·메타 수정용). 업로드를 켜도 자동으로 올리지 않는다.
  //  - 올리고 나면 blob 은 지운다(휴대폰 저장공간). 이후 메타 수정은 드라이브에서 받아 고쳐 다시 올린다.
  var _db = null;
  function upDB() {
    if (_db) return _db;
    _db = new Promise(function (res, rej) {
      var rq = indexedDB.open('gdrive_up', 1);
      rq.onupgradeneeded = function () { var s = rq.result.createObjectStore('q', { keyPath: 'id', autoIncrement: true }); s.createIndex('key', 'key'); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
    return _db;
  }
  function tx(mode, fn) {
    return upDB().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction('q', mode), s = t.objectStore('q'), r = fn(s);
        t.oncomplete = function () { res(r && r.result); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  function allRecs() { return tx('readonly', function (s) { return s.getAll(); }).then(function (a) { return a || []; }); }
  function putRec(r) { return tx('readwrite', function (s) { return s.put(r); }); }
  async function enqueue(r) {
    try {
      if (r.key) {
        var dup = await tx('readonly', function (s) { return s.index('key').get(r.key); });
        if (dup) return;                                           // 같은 사진을 또 불러온 경우
      }
      r.st = r.hold ? 'hold' : 'wait'; delete r.hold;
      r.at = Date.now();
      r.folder = getUpFolder();
      var id = await putRec(r);
      updBadge();
      return id;
    } catch (e) { console.warn('업로드 대기열 저장 실패', e); }
  }
  function countQueue() {
    return allRecs().then(function (a) {
      var c = { wait: 0, fail: 0, done: 0 };
      a.forEach(function (r) { if (c[r.st] != null) c[r.st]++; });
      return c;
    }).catch(function () { return { wait: 0, fail: 0, done: 0 }; });
  }
  function updBadge() {
    countQueue().then(function (c) {
      var n = c.wait + c.fail, el = btn.querySelector('.gdq');
      el.textContent = n > 99 ? '99+' : String(n);
      el.classList.toggle('show', n > 0 && uploadOn());
    });
  }
  function netType() { var c = navigator.connection; return c && c.type ? c.type : ''; }
  function netLabel() {
    var t = netType();
    return !navigator.onLine ? '오프라인' : t === 'wifi' || t === 'ethernet' ? '와이파이' : t === 'cellular' ? '데이터' : t ? t : '구분 불가';
  }
  // 아이폰·PC 처럼 연결 종류를 알 수 없으면 허용(와이파이로 간주)
  function netAllowed() {
    if (!navigator.onLine) return false;
    var p = getUpNet();
    if (p === 'off') return false;
    if (p === 'any') return true;
    var t = netType();
    return t !== 'cellular' && t !== 'wimax' && t !== 'bluetooth' && t !== 'none';
  }
  var _pumping = false, _toldLogin = false;
  function toast(html, ms) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:3100;background:rgba(0,0,0,.82);color:#fff;'
      + 'padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;max-width:86vw;text-align:center;';
    t.innerHTML = html;
    t.onclick = function () { t.remove(); showSetup(); };
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, ms || 5000);
  }
  // force=true(설정의 '지금 올리기'): 로그인이 필요하면 로그인으로 보낸다. 평소엔 조용히 대기.
  async function pump(force) {
    if (_pumping) return;
    updBadge();
    var hadPend = metaPendCount();
    if ((await flushMetaPend(force)) === 'login') return;
    if (!uploadOn()) {
      if (force && hadPend) return;                          // 드라이브 수정만 남았던 경우 — 위에서 처리
      if (force) alert('업로드 폴더와 네트워크(와이파이만/와이파이+데이터)를 먼저 설정하세요.'); return; }
    if (!netAllowed()) { if (force) alert('지금 연결(' + netLabel() + ')에서는 업로드하지 않도록 설정돼 있습니다.'); return; }
    var recs = (await allRecs()).filter(function (r) { return (r.st === 'wait' || (force && r.st === 'fail')) && r.blob; });
    if (!recs.length) return;
    var tok = getToken(true);
    if (!tok) {
      if (force) login({ pump: true });
      else if (!_toldLogin) {
        _toldLogin = true;
        toast('☁️ 드라이브 업로드 대기 ' + recs.length + '장 — 로그인이 만료돼 멈춤.<br>드라이브 버튼 길게 누르기 → "지금 올리기"', 8000);
      }
      return;
    }
    _pumping = true;
    var ok = 0, bad = 0;
    try {
      for (var i = 0; i < recs.length; i++) {
        if (!netAllowed()) break;
        var r = recs[i], fd = r.folder || getUpFolder();
        try {
          var ub = r.blob, un = r.name, kb = getUpKB();
          // 용량보다 크면 올릴 때 줄인다 — 📂 사진, 그리고 찍을 때 못 줄인 📷 사진(오프라인 등)
          if (kb && isImage({ name: r.name || '', type: r.blob.type }) && r.blob.size > kb * 1024 * 1.1) {
            try {
              var pm = r.cam ? { title: r.title || '', desc: r.desc || '' } : {}, fb = null;
              try { fb = await readPhotoMetaFallback(r.blob); } catch (e2) {}
              if (fb && fb.lat != null) { pm.lat = fb.lat; pm.lng = fb.lng; }   // piexif 가 못 여는 원본이어도 위치는 남긴다
              ub = await writeMetaBlob(r.blob, pm, kb);
              un = (r.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
            } catch (e3) { console.warn('용량 줄이기 실패 — 원본으로 올림', e3); ub = r.blob; un = r.name; }
          }
          var id = await uploadBlob(tok, ub, un, fd && fd.id, r.desc);
          r.st = 'done'; r.driveId = id; r.blob = null; r.err = '';
          ok++;
        } catch (e) {
          if (e.auth) break;
          r.st = 'fail'; r.err = e.message; bad++;
        }
        await putRec(r);
        updBadge();
      }
    } finally { _pumping = false; updBadge(); }
    if (force) alert('업로드: ' + ok + '장 완료' + (bad ? ', ' + bad + '장 실패' : ''));
    if (ok) lsDel(LS_CACHE);          // 새 사진이 영역 검색에 잡히도록
  }
  // 드라이브 재개 가능 업로드(resumable) — multipart 는 5MB 한계라 휴대폰 원본이 걸린다
  async function uploadBlob(tok, blob, name, folderId, desc) {
    var metaBody = { name: name, parents: [folderId || 'root'] };
    if (desc) metaBody.description = desc;
    var r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', tok, {
      method: 'POST', body: JSON.stringify(metaBody),
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'image/jpeg' } });
    var loc = r.headers.get('Location');
    if (!loc) throw new Error('업로드 주소를 받지 못함');
    var r2 = await api(loc, tok, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg' } });
    return (await r2.json()).id;
  }

  // ── 찍은 사진 목록 · 메타 수정 ──
  async function showShots() {
    var recs = (await allRecs()).filter(function (r) { return r.cam; }).sort(function (a, c) { return c.at - a.at; }).slice(0, 100);
    var stTxt = { wait: '⏳ 대기', done: '✅ 올림', fail: '⚠️ 실패', hold: '📱 업로드 안 함' };
    openPanel('<b style="font-size:15px;">📷 찍은 사진 (최근 100장)</b>' +
      '<div style="color:#888;font-size:12px;">누르면 제목·설명을 고칩니다. 올린 사진은 드라이브 파일도 함께 고칩니다.</div>' +
      '<div class="fl">' + (recs.length ? recs.map(function (r) {
        var d = new Date(r.at);
        return '<div class="fr" data-rid="' + r.id + '"><span class="nm"><b>' + esc(r.title || r.name) + '</b><br><span style="color:#888;font-size:12px;">'
          + d.toLocaleString('ko-KR') + (r.desc ? ' · ' + esc(r.desc.slice(0, 40)) : '') + '</span></span><span class="ct">' + (stTxt[r.st] || r.st) + '</span></div>';
      }).join('') : '<div style="padding:12px;color:#888;">아직 📷 버튼으로 찍은 사진이 없습니다.</div>') + '</div>' +
      '<div class="btns"><button id="gdShotsBack">뒤로</button></div>');
    $('gdShotsBack').onclick = showSetup;
    Array.prototype.forEach.call($('gdBox').querySelectorAll('.fr[data-rid]'), function (row) {
      row.onclick = function () {
        var r = recs.filter(function (x) { return String(x.id) === row.getAttribute('data-rid'); })[0];
        var en = findEntry(r);
        if (en) { photoInfo(en, showShots); return; }        // 지도에 있는 사진이면 전체 정보 화면으로
        askMeta({ title: r.title || '', desc: r.desc || '', preview: r.blob || null }, function (v) {
          if (v) editShot(r, v); else showShots();
        });
      };
    });
  }
  async function editShot(r, v) {
    status('사진 정보 고치는 중...');
    try {
      if (r.blob) {
        // 아직 안 올린 사진 — 보관 중인 파일의 EXIF 를 고친다
        try { r.blob = await writeMetaBlob(r.blob, { title: v.title, desc: v.desc }); } catch (e) { console.warn(e); }
      } else if (r.driveId) {
        // 이미 올린 사진 — 드라이브에서 받아 EXIF 를 고쳐 같은 파일로 다시 올린다 (설명은 드라이브 '설명' 칸에도)
        var tok = getToken(true);
        if (!tok) { hideLoading(); alert('드라이브 파일을 고치려면 로그인이 필요합니다.\n드라이브 버튼 → 설정 → "지금 올리기" 또는 사진 찾기로 로그인한 뒤 다시 하세요.'); return; }
        await driveMeta(tok, r.driveId, { title: v.title, desc: v.desc });
      }
      r.title = v.title; r.desc = v.desc;
      await putRec(r);
      hideLoading();
      alert('사진 정보를 고쳤습니다.' + (r.driveId ? '\n(드라이브 파일도 고침)' : '') + '\n\n지도 마커 이름은 마커를 길게 눌러 바꿀 수 있습니다.');
      showShots();
    } catch (e) { hideLoading(); alert('수정 실패: ' + e.message); }
  }

  // 드라이브 파일의 EXIF(제목·설명·날짜·위치) 와 드라이브 '설명' 칸을 고친다 — 받아서 고쳐 같은 파일로 다시 올림
  async function driveMeta(tok, id, m) {
    var u = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id);
    var bl = await (await api(u + '?alt=media', tok)).blob();
    if (!/png|heic|heif|webp/i.test(bl.type || '')) {          // EXIF 는 JPEG 만 — 그 외는 설명 칸만 고친다
      var nb = await writeMetaBlob(bl, m, 0);
      await api('https://www.googleapis.com/upload/drive/v3/files/' + encodeURIComponent(id) + '?uploadType=media', tok,
        { method: 'PATCH', body: nb, headers: { 'Content-Type': 'image/jpeg' } });
    }
    if (m.desc != null)
      await api(u, tok, { method: 'PATCH', body: JSON.stringify({ description: m.desc || '' }), headers: { 'Content-Type': 'application/json; charset=UTF-8' } });
  }

  // ════ 드라이브 파일 수정 대기열 — 인터넷·로그인이 안 될 때 📝 로 고친 내용을 기억했다가 나중에 반영 ════
  // { driveId: { title, desc, taken, lat, lng } } — 같은 파일을 여러 번 고치면 합친다(나중 값 우선)
  function metaPend() { return lsJson(LS_METAP) || {}; }
  function addMetaPend(id, v) { var a = metaPend(); a[id] = Object.assign(a[id] || {}, v); lsSet(LS_METAP, JSON.stringify(a)); }
  function metaPendCount() { return Object.keys(metaPend()).length; }
  function editNetOk() {                // 업로드 '끔'이어도 수정은 반영, '와이파이만'이면 데이터에선 미룸
    if (!navigator.onLine) return false;
    return getUpNet() === 'wifi' ? netAllowed() : true;
  }
  var _flushing = false;
  // 반환: 'login' 이면 로그인 화면으로 이동 중
  async function flushMetaPend(force) {
    if (_flushing || !metaPendCount() || !editNetOk()) return;
    var tok = getToken(true);
    if (!tok) {
      if (force) { login({ pump: true }); return 'login'; }
      if (!_toldLogin) { _toldLogin = true; toast('☁️ 드라이브 사진 수정 대기 ' + metaPendCount() + '건 — 로그인이 만료돼 멈춤.<br>드라이브 버튼 길게 누르기 → "지금 올리기"', 8000); }
      return;
    }
    _flushing = true;
    var ok = 0;
    try {
      var a = metaPend(), ids = Object.keys(a);
      for (var i = 0; i < ids.length; i++) {
        if (!editNetOk()) break;
        try {
          await driveMeta(tok, ids[i], a[ids[i]]);
          ok++;
        } catch (e) {
          if (e.auth || !e.status) break;                 // 로그인 만료·연결 끊김 → 다음 기회에
          console.warn('드라이브 수정 포기 (' + ids[i] + ')', e);   // 파일이 지워졌거나(404) 권한 없음
        }
        var cur = metaPend(); delete cur[ids[i]];
        if (Object.keys(cur).length) lsSet(LS_METAP, JSON.stringify(cur)); else lsDel(LS_METAP);
      }
    } finally { _flushing = false; }
    if (ok) toast('☁️ 드라이브 사진 정보 ' + ok + '건 반영', 4000);
  }

  // ════ 지도에서 사진 마커를 지울 때 — 아직 안 올라간 사진이면 업로드도 취소할지 묻는다 ════
  // (마커와 업로드 대기열은 따로라, 묻지 않으면 지워도 나중에 드라이브에 올라간다)
  window.gdPhotoDeleted = async function (list) {
    try {
      var ids = (list || []).filter(function (m) { return m && m.imgSrc && m.gdRec; }).map(function (m) { return m.gdRec; });
      if (!ids.length) return;
      var recs = (await allRecs()).filter(function (r) { return ids.indexOf(r.id) >= 0 && r.blob && r.st !== 'done'; });
      if (!recs.length) return;
      if (!confirm('지운 사진 ' + recs.length + '장이 아직 드라이브에 안 올라갔습니다.\n\n드라이브 업로드도 취소할까요?\n(확인 = 업로드 취소 / 취소 = 그래도 드라이브에 올림)'
        + (camSaveOn() ? '\n\n휴대폰 다운로드 폴더에 저장된 사진은 그대로 남습니다.' : ''))) return;
      await tx('readwrite', function (s) { recs.forEach(function (r) { s.delete(r.id); }); return null; });
      updBadge();
    } catch (e) { console.warn('업로드 취소 실패', e); }
  };

  // ════ 📝 사진 정보 보기·수정 (지도 사진 말풍선의 📝 버튼) ════
  // 마커 기록(entry) 의 표시본 EXIF 에서 읽고, 고치면 표시본 + 대기열 파일 + 드라이브 파일을 함께 고친다.
  // entry.driveId: 드라이브에서 불러온 사진 / entry.gdRec: 이 기기 업로드 대기열 번호(📷·📂 사진, 올린 뒤엔 driveId 를 가짐)
  function getRec(id) { return tx('readonly', function (s) { return s.get(id); }); }
  function findEntry(r) {
    try { return (markers || []).filter(function (m) { return m.imgSrc && m.gdRec === r.id; })[0] || null; } catch (e) { return null; }
  }
  // 예전에 불러와 driveId 가 없는 마커 — 드라이브 목록 캐시에서 같은 이름·가까운 위치의 파일을 찾는다
  function guessDriveId(en, ll) {
    var c = lsJson(LS_CACHE); if (!c || !c.files) return '';
    var best = '', bd = 1e9;
    c.files.forEach(function (f) {
      if (String(f[1]).replace(/\.[^.]+$/, '') !== en.name) return;
      var d = ll ? Math.abs(f[2] - ll.lat) + Math.abs(f[3] - ll.lng) : 0;
      if (d < bd) { bd = d; best = f[0]; }
    });
    return bd < 0.01 ? best : '';                                   // 약 1km 안 (마커를 옮겼을 수 있음)
  }
  // 📂 로 넣었지만 대기열 번호가 없는 옛 마커 — 같은 이름의 대기열 기록
  async function guessRec(en) {
    try { return (await allRecs()).filter(function (r) { return String(r.name || '').replace(/\.[^.]+$/, '') === en.name; }).pop() || null; } catch (e) { return null; }
  }
  // ── 🖼 지금 화면 안의 사진 목록 → 누르면 📝 사진 정보 ──
  function showMapPhotos(back) {
    var b = getBounds(), all = [];
    try { all = (markers || []).filter(function (m) { return m.imgSrc; }); } catch (e) {}
    var list = all.filter(function (m) {
      var ll = entryLL(m);
      return ll && (!b || (ll.lat >= b.s && ll.lat <= b.n && ll.lng >= b.w && ll.lng <= b.e));
    }).slice(0, 300);
    var rows = list.map(function (m, i) {
      var x = { title: '', desc: '', taken: '' };
      try { x = readPhotoMeta(m.imgSrc); } catch (e) {}
      var t = x.taken || m.taken || '', d = x.desc || m.desc || '';
      return '<div class="fr" data-i="' + i + '"><img src="' + m.imgSrc + '" style="width:56px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0;">' +
        '<span class="nm"><b>' + esc(x.title || m.name || '(이름 없음)') + '</b><br><span style="color:#888;font-size:12px;">' +
        esc(String(t).replace(/^(\d{4}):(\d\d):(\d\d)/, '$1-$2-$3').slice(0, 16)) + (d ? ' · ' + esc(d.slice(0, 40)) : '') + '</span></span>' +
        '<span class="ct">' + (m.driveId || m.gdRec ? '☁️' : '') + '</span></div>';
    });
    openPanel('<b style="font-size:15px;">🖼 화면 안의 사진 ' + list.length + '장</b>' +
      (all.length > list.length ? ' <span style="color:#888;font-size:12px;">(지도 전체 ' + all.length + '장 — 지도를 옮기거나 축소하면 더 보입니다)</span>' : '') +
      '<div style="color:#888;font-size:12px;">누르면 제목·설명·촬영일시를 보고 고칩니다.</div>' +
      '<div class="fl">' + (rows.join('') || '<div style="padding:12px;color:#888;">지금 화면 안에 사진이 없습니다.</div>') + '</div>' +
      '<div class="btns"><button id="gdMpBack">' + (back ? '뒤로' : '닫기') + '</button></div>');
    $('gdMpBack').onclick = function () { closePanel(); if (back) back(); };
    _panelBack = $('gdMpBack').onclick;
    Array.prototype.forEach.call($('gdBox').querySelectorAll('.fr[data-i]'), function (row) {
      row.onclick = function () { photoInfo(list[+row.getAttribute('data-i')], function () { showMapPhotos(back); }); };
    });
  }
  function entryLL(en) {
    try {
      if (en.marker && en.marker.getPosition) { var p = en.marker.getPosition(); return { lat: p.getLat(), lng: p.getLng() }; }
      if (en.feat && typeof fromMerc === 'function') { var c = fromMerc(en.feat.getGeometry().getCoordinates()); return { lat: c[1], lng: c[0] }; }
    } catch (e) {}
    return null;
  }
  function blobToUrl(b) {
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { rej(fr.error); }; fr.readAsDataURL(b); });
  }
  // EXIF 'YYYY:MM:DD HH:MM:SS' ↔ <input type=datetime-local> 'YYYY-MM-DDTHH:MM:SS'
  function takenToInput(t) { var m = String(t || '').match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/); return m ? m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') : ''; }
  function inputToTaken(v) { var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/); return m ? m[1] + ':' + m[2] + ':' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00') : ''; }

  async function photoInfo(en, back) {
    var ex = { title: '', desc: '', taken: '', lat: null, lng: null };
    try { ex = readPhotoMeta(en.imgSrc); } catch (e) {}
    var title = ex.title || '', desc = ex.desc || en.desc || '', taken = ex.taken || en.taken || '';
    var ll = entryLL(en);
    var moved = ll && ex.lat != null && (Math.abs(ll.lat - ex.lat) > 1e-6 || Math.abs(ll.lng - ex.lng) > 1e-6);
    var rec = null;
    if (en.gdRec) { try { rec = await getRec(en.gdRec); } catch (e) {} }
    if (!rec && !en.driveId) { rec = await guessRec(en); if (rec) en.gdRec = rec.id; }
    var did = en.driveId || (rec && rec.driveId) || guessDriveId(en, ll) || '';
    var stTxt = { wait: '⏳ 업로드 대기', done: '✅ 드라이브에 올림', fail: '⚠️ 업로드 실패', hold: '📱 업로드 안 함(이 기기에만)' };
    var where = did ? (rec ? stTxt[rec.st] || '✅ 드라이브에 올림' : '☁️ 드라이브 사진') : rec ? (stTxt[rec.st] || rec.st) : '📱 이 기기 사진(드라이브와 연결 없음)';
    var kb = 0;
    try { kb = Math.round((en.imgSrc.length - en.imgSrc.indexOf(',') - 1) * 0.75 / 1024); } catch (e) {}
    _panelGuard = true;
    openPanel('<b style="font-size:15px;">📝 사진 정보</b>' +
      '<img class="prev" src="' + en.imgSrc + '">' +
      '<div>제목</div><input type="text" id="gdPiTitle" value="' + esc(title) + '" placeholder="(없음)">' +
      '<div>설명 / 메모</div><textarea id="gdPiDesc" placeholder="(없음)">' + esc(desc) + '</textarea>' +
      '<div>촬영일시</div><input type="datetime-local" step="1" id="gdPiTaken" value="' + takenToInput(taken) + '" style="width:100%;box-sizing:border-box;font-size:15px;padding:8px;border:1px solid #ccc;border-radius:8px;margin:4px 0 8px;">' +
      '<div style="line-height:1.8;">' +
        '<div>📍 위치 ' + (ll ? ll.lat.toFixed(6) + ', ' + ll.lng.toFixed(6) : '-') +
          (ex.lat == null ? ' <span style="color:#c62828;font-size:12px;">(사진에 위치 기록 없음)</span>' : '') + '</div>' +
        ((moved || (ll && ex.lat == null)) ? '<label style="font-size:13px;"><input type="checkbox" id="gdPiPos" checked> 사진 위치를 지금 마커 위치로 기록' +
          (moved ? ' <span style="color:#888;">(사진 기록: ' + ex.lat.toFixed(6) + ', ' + ex.lng.toFixed(6) + ')</span>' : '') + '</label>' : '') +
        '<div>🖼 지도 이름: ' + esc(en.name || '') + ' <span style="color:#888;font-size:12px;">(표시본 ' + kb + 'KB)</span></div>' +
        '<div>☁️ ' + esc(where) + '</div>' +
        '<div id="gdPiDrive" style="color:#888;font-size:12px;"></div>' +
      '</div>' +
      '<div class="btns"><button class="pri" id="gdPiSave">저장</button><button id="gdPiClose">' + (back ? '뒤로' : '닫기') + '</button></div>' +
      '<div style="color:#888;font-size:12px;margin-top:6px;">저장하면 지도 사진' + (did ? '과 드라이브 파일(EXIF·설명 칸)' : rec && rec.blob ? '과 업로드 대기 중인 파일' : '') +
        '을 함께 고칩니다. 마커 이름·위치는 마커를 길게 눌러 바꿉니다.</div>');
    // 드라이브 쪽 파일 정보 (로그인돼 있을 때만)
    var tk = getToken();
    if (did && tk) {
      api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(did) + '?fields=name,size,description,modifiedTime', tk)
        .then(function (r) { return r.json(); })
        .then(function (f) {
          var el = $('gdPiDrive'); if (!el) return;
          el.textContent = '드라이브 파일: ' + f.name + ' · ' + Math.round((+f.size || 0) / 1024) + 'KB · 수정 ' + new Date(f.modifiedTime).toLocaleString('ko-KR');
        }).catch(function () {});
    }
    $('gdPiClose').onclick = function () { closePanel(); if (back) back(); };
    _panelBack = $('gdPiClose').onclick;                   // 목록에서 열었으면 목록으로
    $('gdPiSave').onclick = function () {
      var v = { title: $('gdPiTitle').value.trim(), desc: $('gdPiDesc').value.trim() };
      var t = inputToTaken($('gdPiTaken').value);
      if (t && t !== String(taken).slice(0, 19)) v.taken = t;
      if ($('gdPiPos') && $('gdPiPos').checked && ll) { v.lat = ll.lat; v.lng = ll.lng; }
      closePanel();
      savePhotoInfo(en, v, rec, did).then(function () { if (back) back(); });
    };
  }
  window.gdPhotoInfo = function (en) { if (en && en.imgSrc) photoInfo(en); };

  async function savePhotoInfo(en, v, rec, did) {
    status('사진 정보 저장 중...');
    var msg = '';
    try {
      // 1) 지도 표시본 (자동저장·KMZ/HTM 저장에 들어가는 사진)
      if (/^data:image\/jpe?g/i.test(en.imgSrc)) {
        var nb = await writeMetaBlob(await (await fetch(en.imgSrc)).blob(), v, 0);
        en.imgSrc = await blobToUrl(nb);
        try { var im = en.iw && en.iw.getContent().querySelector('img'); if (im) im.src = en.imgSrc; } catch (e) {}
      }
      en.desc = v.desc;
      if (v.taken) en.taken = v.taken;
      // 2) 업로드 대기열 (아직 안 올린 파일은 여기서 고쳐 두면 고친 채로 올라감)
      if (rec) {
        if (rec.blob) { try { rec.blob = await writeMetaBlob(rec.blob, v, 0); } catch (e) { console.warn(e); } }
        rec.title = v.title; rec.desc = v.desc;
        await putRec(rec);
      }
      // 3) 드라이브 파일 — 지금 못 고치면 기억했다가 인터넷·로그인이 되면 자동으로 고친다
      if (did) {
        en.driveId = did;
        var tok = getToken(true), why = !navigator.onLine ? '인터넷이 안 돼서' : !tok ? '로그인이 만료돼서' : '';
        if (!why) {
          try { await driveMeta(tok, did, v); msg = '\n(드라이브 파일도 고침)'; }
          catch (e) { if (e.auth) why = '로그인이 만료돼서'; else if (!e.status) why = '연결이 끊겨서'; else throw e; }
        }
        if (why) {
          addMetaPend(did, v);
          msg = '\n\n드라이브 파일은 ' + why + ' 아직 못 고쳤습니다.\n고친 내용을 기억해 두었다가 인터넷' + (tok ? '' : '·로그인') + '이 되면 자동으로 고칩니다.'
            + (tok ? '' : '\n(로그인: 드라이브 버튼 길게 누르기 → "지금 올리기")');
        }
      }
      try { autoSaveToDB(); } catch (e) {}
      hideLoading();
      alert('사진 정보를 저장했습니다.' + msg);
    } catch (e) {
      hideLoading();
      alert('드라이브 파일 수정 실패: ' + e.message + '\n(지도 사진은 고쳐졌습니다)');
    }
  }

  // 연결이 바뀌거나 앱으로 돌아오면 대기열을 이어서 올린다
  window.addEventListener('online', function () { pump(); });
  try { navigator.connection && navigator.connection.addEventListener('change', function () { pump(); }); } catch (e) {}
  document.addEventListener('visibilitychange', function () { if (!document.hidden) pump(); });

  // ── 로그인에서 돌아왔으면: 지도·복원 준비를 기다린 뒤 하던 일을 이어서 ──
  var pend = lsJson(LS_PEND);
  lsDel(LS_PEND);
  updBtn();
  setTimeout(function () { pump(); }, 4000);
  if (_returned && pend && pend.picker) {
    setTimeout(function () { openPicker(pend.picker, null); }, 800);
  } else if (_returned && pend && (pend.mbtiles || pend.mbtilesResume)) {   // ☁ 드라이브 지도 파일 가져오기 (앱 안 저장소가 열린 뒤)
    (function wait(n) {
      if (!_fsDir && n < 40) { setTimeout(function () { wait(n + 1); }, 250); return; }
      var dl = lsJson(LS_MBDL);
      if (pend.mbtilesResume && dl) fsDriveImport(dl, true); else fsDriveList();
    })(0);
  } else if (_returned && pend && pend.pump) {
    setTimeout(function () { pump(true); }, 1500);
  } else if (_returned && pend && pend.b) {
    var t0 = Date.now();
    (function wait() {
      if (!getBounds() && Date.now() - t0 < 20000) { setTimeout(wait, 300); return; }
      Promise.resolve(window._restoreReady).catch(function () {}).then(function () {
        fitBounds(pend.b);
        search(pend.force, pend.b);
      });
    })();
  }
  // ══════════════════════════════════════════════════
  //  ⚙ 설정 버튼 + 지도 파일 가져오기 (2026-10-22, 2026-10-24 바꿈)
  //  · ⚙ 버튼(📷 왼쪽) → 설정 창. 지금 항목: 지도 파일 · 지도 미리 받기. 다른 설정도 여기에 덧붙인다(SETTINGS_SECTIONS).
  //  · 지도 파일 = PC 지도저장 파일(*.mbtiles, 사진위치표시 '🛰 지도저장')을 골라 앱 안 저장소(OPFS '지도타일')의 「합친 지도」 한 파일에 합쳐 넣은 것
  //    (2026-10-24 오후 — 처음 판은 가져온 파일마다 따로 복사했다. 남아 있으면 열 때 합친다. 아래 '합친 지도 한 파일').
  //    브이월드 위성 타일을 거기서 읽는다(읽기만). 2026-10-24: PC 지도 다운로더(htm/img/지도다운로더) 파일의 카카오 위성·하이브리드·일반,
  //    브이월드 하이브리드·일반(jty_layers 표)도 읽는다 → 카카오 앱도 오프라인 지도 파일을 쓴다. 같은 이름을 다시 가져오면 새 파일로 바꾼다(PC 는 같은 파일에 계속 더하므로 = 합치기).
  //  · 2026-10-24: 예전 '지도 저장 폴더'(사용자가 고른 휴대폰 폴더, File System Access)는 뺐다 —
  //    브라우저가 폴더 권한을 기억 못 해 앱을 열 때마다 허용 창이 떴고, 브이월드 타일이 수천 개 조각 파일로 쌓였다.
  //    앱 안 저장소는 권한 창이 없다. 보면서 받은 타일은 브이월드도 카카오처럼 브라우저 안(Cache Storage) 한 덩어리에만 둔다.
  //  · 서비스워커(sw.js)는 브라우저 캐시 → 인터넷 순으로 먼저 보여 주고, 인터넷이 1초 넘게 늦거나 끊겼을 때만 'fsget' 으로 여기 묻는다.
  //    켜짐 표시('on' = 지도 파일이 있음)는 IndexedDB 'jty-fs' 에 — sw.js 가 읽는다.
  // ══════════════════════════════════════════════════
  var FS_DB = 'jty-fs', FS_ROOT = '지도타일';
  var _fsDir = null, _fsStat = { hit: 0 };
  function fsSupported() { return !!(navigator.storage && navigator.storage.getDirectory); }
  function fsIdb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(FS_DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function fsTellSw(on) { try { navigator.serviceWorker.controller.postMessage({ t: 'fs-on', on: !!on }); } catch (e) {} }
  function fsKv(key, val) {           // val 생략 = 읽기, null = 지우기
    return fsIdb().then(function (db) {
      return new Promise(function (res) {
        var tx = db.transaction('kv', val === undefined ? 'readonly' : 'readwrite'), st = tx.objectStore('kv');
        var rq = val === undefined ? st.get(key) : (val === null ? st.delete(key) : st.put(val, key));
        rq.onsuccess = function () { res(val === undefined ? rq.result : true); };
        rq.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  // 앱 안 저장소 열기 → 합친 지도 + (아직 안 합친) 지도 파일 읽을 준비. 켜짐 = 읽을 타일이 있음
  function fsInit() {
    if (!fsSupported()) return Promise.resolve();
    return navigator.storage.getDirectory().then(function (root) { return root.getDirectoryHandle(FS_ROOT, { create: true }); })
      .then(function (d) { _fsDir = d; return pkOpen().catch(function (e) { console.warn('[지도 파일] 합친 지도를 못 엶', e); }); })
      .then(function () { return _mbOpenAll(); })
      .then(function () { if (!_merging && !lsGet(LS_MBDL)) return _fsDir.removeEntry(FS_TMP).catch(function () {}); })   // 끊긴 가져오기의 복사본 (드라이브 이어 받기 중이면 둠)
      .catch(function (e) { console.warn('[지도 파일] 앱 저장소를 못 엶', e); })
      .then(function () { fsOnUpdate(); if (_mb.length) fsMergeLeft(); });
  }
  function fsOnUpdate() {
    var on = !!(_pk && _pk.n) || _mb.length > 0;
    fsKv('on', on); fsTellSw(on); osmLayerSync();
  }
  function fsErrText(e) { return (e && e.name === 'QuotaExceededError') ? '저장 공간 부족' : ((e && (e.name || e.message)) || '오류'); }
  // 바깥 지도 파일(.mbtiles) 골라 합친 지도 한 파일에 넣기 — 큰 파일이라 통째로 메모리에 올리지 않고 조금씩 읽어 붙인다
  function fsImport() {
    if (!_fsDir) { alert('이 브라우저는 앱 안 저장소를 지원하지 않습니다.\n(크롬에서 열면 쓸 수 있습니다)'); return; }
    if (_merging) { toast('지도 파일을 합치는 중입니다. 끝난 뒤 다시 해 주세요.', 3000); return; }
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.mbtiles'; inp.multiple = true;
    inp.onchange = function () {
      var files = Array.prototype.filter.call(inp.files || [], function (f) { return /\.mbtiles$/i.test(f.name); });
      if (!files.length) { if (inp.files && inp.files.length) alert('.mbtiles 파일만 가져올 수 있습니다.'); return; }
      fsImportFiles(files);
    };
    inp.click();
  }
  async function fsImportFiles(files) {
    try { navigator.storage.persist && navigator.storage.persist(); } catch (e) {}   // 저장 공간이 모자라도 브라우저가 지우지 않게
    var job = startJob(), ok = [], bad = [];
    _merging = true;
    for (var i = 0; i < files.length && !job.cancelled; i++) {
      var f = files[i], label = '지도 파일 가져오는 중 (' + (i + 1) + '/' + files.length + ')<br>' + esc(f.name);
      try { await fsImportOne(f, job, label); ok.push(f.name); }
      catch (e) { if (!job.cancelled) { bad.push(f.name + '(' + (e && e.why || fsErrText(e)) + ')'); console.warn('[지도 파일] 가져오기 실패', f.name, e); } }
    }
    try { await _fsDir.removeEntry(FS_TMP); } catch (e) {}
    if (!job.cancelled) { try { await pkCompact(job); } catch (e) { console.warn('[지도 파일] 정리 실패', e); } }
    _merging = false;
    fsOnUpdate();
    if (cancelled(job, '가져오기를 멈췄습니다.' + (ok.length ? '<br>' + ok.length + '개는 넣었습니다.' : ''))) return;
    done();
    toast((ok.length ? '🗺 지도 파일 ' + ok.length + '개를 합친 지도에 넣었습니다' : '') + (bad.length ? (ok.length ? '<br>' : '') + '못 가져옴: ' + bad.map(esc).join(', ') : ''), 6000);
    showSettings();
  }
  window._jtyImportFiles = fsImportFiles;   // 시험용
  // 파일 하나 가져오기. 먼저 바로 읽어 합치고, 읽기가 안 되면(구글 드라이브에서 고른 파일 등 — 휴대폰이 처음부터 차례로만 읽게 줌,
  // 2026-10-24 사용자 기기에서 실패) 앱 안에 차례로 통째 복사한 뒤 그 복사본에서 합친다(끝나면 지움).
  var FS_TMP = '가져오는중.tmp';
  async function fsImportOne(f, job, label) {
    var m = null, why = null;
    try { m = await _mbOpen(f); } catch (e) { why = e; }
    if (!m && !why) throw { why: '지도 파일 형식 아님' };            // SQLite 이지만 tiles / jty_layers 표가 없음
    if (m) {
      try { await fsRoomCheck(f.size, m.name, false); await pkMerge(m, job, label); return; }
      catch (e) { if (job.cancelled || (e && (e.why || e.name === 'QuotaExceededError'))) throw e; why = e; }
    }
    console.warn('[지도 파일] 바로 읽기 실패 → 앱 안에 복사해서 다시', f.name, why);
    await fsRoomCheck(f.size, f.name, true);
    var tf = await fsCopyTmp(f, job, label);
    if (job.cancelled) throw { name: '취소' };
    m = await _mbOpen(tf);
    if (!m) throw { why: '지도 파일 형식 아님' };
    m.name = f.name;
    try { await pkMerge(m, job, label); } finally { try { await _fsDir.removeEntry(FS_TMP); } catch (e) {} }
  }
  // 남은 공간 확인 — 합친 지도에 붙일 만큼(+복사본, +브라우저가 닫을 때 기존 합친 지도를 한 번 복사하는 만큼)
  async function fsRoomCheck(size, name, copy) {
    if (!(navigator.storage && navigator.storage.estimate)) return;
    var est = await navigator.storage.estimate().catch(function () { return null; });
    if (!est || !est.quota) return;
    var keep = _pk && !pkOnlySrc(name) ? _pk.file.size : 0;
    var need = size * (copy ? 2 : 1) + keep + 20 * P2, free = est.quota - est.usage;
    if (free < need) throw { why: '저장 공간 부족 — ' + (need / 1073741824).toFixed(1) + 'GB 필요, ' + (free / 1073741824).toFixed(1) + 'GB 남음' };
  }
  function pkOnlySrc(name) {            // 합친 지도에 이 이름 파일 몫만 있음 → 바꿀 때 처음부터 새로 씀
    return !!_pk && _pk.srcs.every(function (s) { return !s || s.name === name; });
  }
  async function fsCopyTmp(f, job, label) {
    var fh = await _fsDir.getFileHandle(FS_TMP, { create: true }), w = await fh.createWritable(), rd = f.stream().getReader(), got = 0, t0 = 0;
    try {
      for (;;) {
        if (job.cancelled) throw { name: '취소' };
        var r = await rd.read();
        if (r.done) break;
        await w.write(r.value); got += r.value.byteLength;
        if (Date.now() - t0 > 400) { t0 = Date.now(); status(label + '<br>앱 안으로 옮기는 중 ' + (got / P2).toFixed(0) + ' / ' + (f.size / P2).toFixed(0) + 'MB'); }
      }
      await w.close(); w = null;
    } finally {
      if (w) { try { await w.abort(); } catch (e) {} try { await rd.cancel(); } catch (e) {} }
    }
    return fh.getFile();
  }
  // ── ☁ 구글 드라이브에서 바로 가져오기 (2026-10-24) ──
  //  큰 파일(1.6GB)은 휴대폰 파일 고르기 창에서 드라이브 파일을 눌러도 반응이 없었다(드라이브 앱이 통째로 받은 뒤에야 넘겨줌 — 진행 표시도 없음, 작은 파일은 됨).
  //  → 드라이브 API(alt=media)로 앱 안 FS_TMP 에 직접 받고(진행 MB·취소), 다 받으면 그 복사본에서 합친다.
  //  끊기면 Range 로 받은 곳부터 다시(최대 30번). 로그인 만료(1시간)면 받은 데까지 닫아 두고 LS_MBDL 에 기억 → 다시 로그인하고 돌아와 이어 받음.
  var LS_MBDL = 'gdrive_mb_dl';
  function fsDriveList() {
    if (!_fsDir) { alert('이 브라우저는 앱 안 저장소를 지원하지 않습니다.\n(크롬에서 열면 쓸 수 있습니다)'); return; }
    if (_merging) { toast('지도 파일을 합치는 중입니다. 끝난 뒤 다시 해 주세요.', 3000); return; }
    var tok = getToken(); if (!tok) { login({ mbtiles: 1 }); return; }
    status('드라이브에서 지도 파일 찾는 중...');
    var out = [];
    listPaged(tok, "name contains '.mbtiles' and trashed=false and mimeType!='application/vnd.google-apps.folder'", 'id,name,size,modifiedTime',
      function (arr) { arr.forEach(function (f) { if (/\.mbtiles$/i.test(f.name)) out.push({ id: f.id, name: f.name, size: +f.size || 0, t: f.modifiedTime || '' }); }); }
    ).then(function () {
      hideLoading();
      out.sort(function (a, b) { return a.t < b.t ? 1 : -1; });
      var h = '<b style="font-size:15px;">☁ 구글 드라이브의 지도 파일</b>';
      h += out.length ? out.map(function (f, i) {
        return '<div style="display:flex;align-items:center;gap:6px;margin:6px 0;"><span style="flex:1;word-break:break-all;">📦 ' + esc(f.name) +
          '<br><span style="color:#888;font-size:12px;">' + (f.size / P2).toFixed(f.size < 10 * P2 ? 1 : 0) + 'MB · ' + esc(f.t.slice(0, 10)) + '</span></span>' +
          '<button class="pri gsDrvGet" data-i="' + i + '" style="padding:6px 12px;">가져오기</button></div>';
      }).join('') : '<div style="margin:8px 0;color:#888;">드라이브에 .mbtiles 파일이 없습니다.</div>';
      h += '<div style="color:#888;font-size:12px;">앱 안으로 바로 받아 「합친 지도」에 넣습니다. 큰 파일은 와이파이에서 받으세요(받는 동안 화면을 켜 두면 빠릅니다).</div>' +
           '<div class="sec btns"><button id="gsDrvBack">← 설정</button></div>';
      openPanel(h);
      $('gsDrvBack').onclick = showSettings;
      Array.prototype.forEach.call(document.querySelectorAll('.gsDrvGet'), function (b) {
        b.onclick = function () { fsDriveImport(out[+b.getAttribute('data-i')]); };
      });
    }).catch(function (e) {
      hideLoading();
      if (e && e.auth) { login({ mbtiles: 1 }); return; }
      alert('드라이브 목록을 못 받았습니다: ' + e.message);
    });
  }
  async function fsDriveImport(f, resume) {
    if (_merging) { toast('지도 파일을 합치는 중입니다. 끝난 뒤 다시 해 주세요.', 3000); return; }
    if (!resume && netType() === 'cellular' && !confirm('지금 모바일 데이터입니다. ' + (f.size / P2).toFixed(0) + 'MB 를 받을까요?')) return;
    closePanel();
    try { navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    var job = startJob(), label = '드라이브에서 받는 중<br>' + esc(f.name), why = null;
    _merging = true;
    try {
      if (!resume) await fsRoomCheck(f.size, f.name, true);
      var got = await fsDriveDownload(f, job, label, resume);
      if (got === 'login') return;                                  // 로그인하러 떠남 — 돌아와 이어 받음
      lsDel(LS_MBDL);
      if (job.cancelled) throw { name: '취소' };
      var tf = await (await _fsDir.getFileHandle(FS_TMP)).getFile();
      var m = await _mbOpen(tf);
      if (!m) throw { why: '지도 파일 형식 아님' };
      m.name = f.name;
      await pkMerge(m, job, label.replace('받는 중', '합치는 중'));
      await pkCompact(job);
    } catch (e) { why = e; if (!job.cancelled) console.warn('[지도 파일] 드라이브 가져오기 실패', f.name, e); }
    if (!lsGet(LS_MBDL)) { try { await _fsDir.removeEntry(FS_TMP); } catch (e) {} }
    _merging = false;
    fsOnUpdate();
    if (cancelled(job, '가져오기를 멈췄습니다.')) { lsDel(LS_MBDL); try { await _fsDir.removeEntry(FS_TMP); } catch (e) {} return; }
    done();
    if (why) alert('못 가져왔습니다: ' + f.name + '\n(' + (why.why || fsErrText(why)) + ')');
    else toast('🗺 ' + esc(f.name) + ' 을(를) 합친 지도에 넣었습니다.', 4000);
    showSettings();
  }
  // FS_TMP 에 받기 → 받은 바이트 수, 로그인하러 떠나면 'login'
  async function fsDriveDownload(f, job, label, resume) {
    var fh = await _fsDir.getFileHandle(FS_TMP, { create: true });
    var got = 0;
    if (resume) { got = (await fh.getFile()).size; if (got > f.size) got = 0; }
    var w = await fh.createWritable({ keepExistingData: got > 0 });
    if (got) await w.seek(got);
    var tries = 0, t0 = 0, tS = Date.now(), g0 = got;
    try {
      while (got < f.size) {
        if (job.cancelled) throw { name: '취소' };
        var tok = getToken();
        if (!tok) {                                                 // 로그인 만료 — 받은 데까지 남기고 다시 로그인
          await w.close(); w = null;
          lsSet(LS_MBDL, JSON.stringify(f));
          alert('구글 로그인 시간이 끝났습니다. 다시 로그인하면 받은 곳(' + (got / P2).toFixed(0) + 'MB)부터 이어 받습니다.');
          login({ mbtilesResume: 1 });
          return 'login';
        }
        try {
          var r = await api('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(f.id) + '?alt=media', tok,
                            { headers: got ? { Range: 'bytes=' + got + '-' } : {}, signal: jobSignal(job) });
          if (got && r.status !== 206) throw { name: 'Range 안 됨' };
          var rd = r.body.getReader();
          for (;;) {
            var c = await rd.read();
            if (c.done) break;
            await w.write(c.value); got += c.value.byteLength; tries = 0;
            if (Date.now() - t0 > 500) {
              t0 = Date.now();
              var sp = (got - g0) / Math.max(1, (Date.now() - tS) / 1000);
              status(label + '<br>' + (got / P2).toFixed(0) + ' / ' + (f.size / P2).toFixed(0) + 'MB · ' + (sp / P2).toFixed(1) + 'MB/초' +
                     (sp > 0 ? ' · 남은 ' + Math.ceil((f.size - got) / sp / 60) + '분' : ''));
            }
          }
        } catch (e) {
          if (job.cancelled) throw { name: '취소' };
          if (e && e.auth) continue;                               // 토큰 지움 → 위에서 다시 로그인
          if (e && (e.name === 'Range 안 됨' || e.status === 404 || e.status === 403)) throw e;
          if (++tries > 30) throw e;
          status(label + '<br>연결이 끊겨 다시 잇는 중... (' + tries + ')<br>' + (got / P2).toFixed(0) + ' / ' + (f.size / P2).toFixed(0) + 'MB');
          await new Promise(function (res) { setTimeout(res, Math.min(30000, 2000 * tries)); });
        }
      }
      await w.close(); w = null;
      return got;
    } finally { if (w) { try { await w.abort(); } catch (e) {} } }
  }
  // 예전처럼 따로 복사해 둔 .mbtiles(2026-10-24 오전 판)가 남아 있으면 합친 지도로 옮기고 지운다 — 열고 3초 뒤, 취소하면 다음에 이어서
  var _merging = false;
  function fsMergeLeft() {
    if (_merging) return;
    _merging = true;
    setTimeout(async function () {
      var list = _mb.slice(), job = startJob(), ok = 0;
      try {
        for (var i = 0; i < list.length && !job.cancelled; i++) {
          await pkMerge(list[i], job, '지도 파일을 한 파일로 합치는 중 (' + (i + 1) + '/' + list.length + ')<br>' + esc(list[i].name));
          if (job.cancelled) break;
          try { await _fsDir.removeEntry(list[i].name); } catch (e) {}
          ok++;
        }
        if (!job.cancelled) await pkCompact(job);
      } catch (e) { if (!job.cancelled) { console.warn('[지도 파일] 합치기 실패', e); toast('지도 파일 합치기 실패: ' + esc(fsErrText(e)), 4000); } }
      await _mbOpenAll();
      _merging = false;
      fsOnUpdate();
      if (cancelled(job, '합치기를 멈췄습니다. 다음에 열 때 이어서 합칩니다.')) return;
      done();
      if (ok) toast('🗺 지도 파일 ' + ok + '개를 한 파일로 합쳤습니다.', 3000);
    }, 3000);
  }
  async function fsDelete(sid) {
    var s = _pk && _pk.srcs[sid]; if (!s) return;
    if (!confirm('합친 지도에서 ' + s.name + ' 몫을 지울까요?\n(나중에 넣은 다른 파일과 겹치는 곳은 그 파일 것이 남습니다. PC 의 원본은 그대로입니다)')) return;
    if (_merging) { toast('지도 파일을 합치는 중입니다. 끝난 뒤 다시 해 주세요.', 3000); return; }
    var job = startJob(); _merging = true;
    try { status('지우는 중...'); await pkDropSrc(sid); await pkCompact(job); }
    catch (e) { console.warn('[지도 파일] 지우기 실패', e); }
    _merging = false; fsOnUpdate();
    if (!cancelled(job)) done();
    showSettings();
  }

  // ── 합친 지도 한 파일 (2026-10-24) ──
  //  가져온 .mbtiles 들을 따로 두지 않고 '합친지도.pack' 한 파일에 타일 바이트만 이어 붙이고, 찾아보기표 '합친지도.idx' 를 둔다.
  //  pack = 'JTYPACK1' + 세대번호(f64) + 타일 바이트들.
  //  idx  = 'JTYIDX01' + JSON 길이(u32) + JSON{gen,end,layers,meta,srcs} + 개수(u32) + keys(f64)·offs(f64)·lens(u32)·src(u16) — 모두 little-endian, keys 오름차순.
  //  key = ((층번호×32 + z)×2^20 + x)×2^20 + y (층 이름은 JSON layers). vw_sat 의 y 는 XYZ(위에서부터), 그 밖은 주소 숫자 그대로(_tileKey 와 같음).
  //  · 같은 자리 타일은 나중에 넣은 것이 이긴다. 같은 이름 파일을 다시 넣으면 그 파일 몫을 먼저 빼고 넣는다(= 바꾸기, PC 는 같은 파일에 계속 더함).
  //  · 쓰기는 createWritable(닫을 때 한꺼번에 바뀜) → 중간에 끊기거나 취소하면 예전 그대로. 붙이기는 pack 을 닫은 뒤 idx 를 쓴다(그 사이 끊기면 끝 뒤 찌꺼기만 남음).
  //  · 버린 바이트가 50MB 넘고 남은 것보다 많으면 새로 써서 줄인다(pkCompact) — 세대번호 +1, idx.new → pack → idx 순서라 끊겨도 pack 과 세대가 맞는 표를 고른다.
  var PK_NAME = '합친지도.pack', PX_NAME = '합친지도.idx', PK_HEAD = 16, P2 = 1048576;
  var _pk = null;                      // {file, gen, end, layers, lmap, meta, srcs, n, keys, offs, lens, src, live}
  function pkKey(li, z, x, y) { return ((li * 32 + z) * P2 + x) * P2 + y; }
  function pkHead(gen) {
    var b = new ArrayBuffer(PK_HEAD);
    new Uint8Array(b).set(new TextEncoder().encode('JTYPACK1')); new DataView(b).setFloat64(8, gen, true);
    return b;
  }
  async function pkReadIdx(name) {
    try {
      var f = await (await _fsDir.getFileHandle(name)).getFile(), b = await f.arrayBuffer(), u = new Uint8Array(b);
      if (b.byteLength < 16 || String.fromCharCode.apply(null, u.subarray(0, 8)) !== 'JTYIDX01') return null;
      var dv = new DataView(b), jl = dv.getUint32(8, true);
      var j = JSON.parse(new TextDecoder().decode(u.subarray(12, 12 + jl)));
      var p = 12 + jl, n = dv.getUint32(p, true); p += 4;
      j.n = n;
      j.keys = new Float64Array(b.slice(p, p + 8 * n)); p += 8 * n;
      j.offs = new Float64Array(b.slice(p, p + 8 * n)); p += 8 * n;
      j.lens = new Uint32Array(b.slice(p, p + 4 * n)); p += 4 * n;
      j.src = new Uint16Array(b.slice(p, p + 2 * n));
      return j;
    } catch (e) { return null; }
  }
  async function pkWriteIdx(P, name) {
    var j = new TextEncoder().encode(JSON.stringify({ gen: P.gen, end: P.end, layers: P.layers, meta: P.meta, srcs: P.srcs }));
    var hd = new ArrayBuffer(16), dv = new DataView(hd), n = P.n;
    new Uint8Array(hd).set(new TextEncoder().encode('JTYIDX01')); dv.setUint32(8, j.length, true);
    var jb = new Uint8Array(j.length + 4); jb.set(j); new DataView(jb.buffer).setUint32(j.length, n, true);
    var w = await (await _fsDir.getFileHandle(name || PX_NAME, { create: true })).createWritable();
    await w.write(new Blob([hd.slice(0, 12), jb, P.keys.subarray(0, n), P.offs.subarray(0, n), P.lens.subarray(0, n), P.src.subarray(0, n)]));
    await w.close();
  }
  function pkLive(P) { var s = 0; for (var i = 0; i < P.n; i++) s += P.lens[i]; return s; }
  async function pkOpen() {
    _pk = null;
    var fh; try { fh = await _fsDir.getFileHandle(PK_NAME); } catch (e) { return; }
    var file = await fh.getFile();
    if (file.size < PK_HEAD) return;
    var gen = new DataView(await file.slice(0, PK_HEAD).arrayBuffer()).getFloat64(8, true);
    var ix = await pkReadIdx(PX_NAME);
    if (!ix || ix.gen !== gen) {
      var ix2 = await pkReadIdx(PX_NAME + '.new');                // 줄이기 중에 끊겼던 것
      if (ix2 && ix2.gen === gen) { ix = ix2; await pkWriteIdx(ix); }
      else { console.warn('[지도 파일] 합친 지도의 찾아보기표가 안 맞아 못 씀'); return; }
    }
    try { await _fsDir.removeEntry(PX_NAME + '.new'); } catch (e) {}
    ix.file = file; ix.lmap = {}; ix.layers.forEach(function (l, i) { ix.lmap[l] = i; });
    ix.live = pkLive(ix);
    _pk = ix;
  }
  function pkFind(lay, z, x, y) {      // → 자리 번호, 없으면 -1
    var P = _pk; if (!P || !P.n || x >= P2 || y >= P2) return -1;
    var li = P.lmap[lay]; if (li === undefined) return -1;
    var k = pkKey(li, z, x, y), lo = 0, hi = P.n - 1;
    while (lo <= hi) { var mid = (lo + hi) >> 1, v = P.keys[mid]; if (v === k) return mid; if (v < k) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }
  function pkGet(t) {
    var P = _pk; if (!P) return Promise.resolve(null);
    for (var i = 0; i < t.lays.length; i++) {
      var k = pkFind(t.lays[i], t.z, t.x, t.y);
      if (k < 0) continue;
      var lay = t.lays[i];
      return P.file.slice(P.offs[k], P.offs[k] + P.lens[k]).arrayBuffer().then(function (b) {
        return { buf: b, type: new Uint8Array(b, 0, 1)[0] === 0x89 ? 'image/png' : 'image/jpeg', t: P.file.lastModified, mb: PK_NAME, lay: lay };
      }).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }
  // 지도 파일 하나(m = _mbOpen 결과)를 합친 지도에 넣는다. 돌려주는 값 = 넣은 장수
  async function pkMerge(m, job, label) {
    // 합친 지도에 이 파일 몫만 있으면(같은 파일을 다시 가져옴) 처음부터 새로 쓴다 — 옛 것을 이어 쓰면 닫을 때 브라우저가 옛 합친 지도를 통째로 한 번 더 복사해 공간이 두 배로 듦
    var fresh = !_pk || pkOnlySrc(m.name);
    var P = fresh ? { gen: _pk ? _pk.gen + 1 : 1, end: PK_HEAD, layers: [], meta: {}, srcs: [], n: 0, live: 0,
                     keys: new Float64Array(0), offs: new Float64Array(0), lens: new Uint32Array(0), src: new Uint16Array(0) } : _pk;
    var layers = P.layers.slice(), lmap = {}, srcs = P.srcs.slice(), sid = -1;
    layers.forEach(function (l, i) { lmap[l] = i; });
    srcs.forEach(function (s, i) { if (s && s.name === m.name) sid = i; });
    if (sid < 0) { sid = srcs.indexOf(null); if (sid < 0) { sid = srcs.length; srcs.push(null); } }
    if (sid > 65534) throw { name: '파일 수 초과' };
    var fh = await _fsDir.getFileHandle(PK_NAME, { create: true });
    var w = await fh.createWritable({ keepExistingData: !fresh });
    try {
      if (!fresh) { await w.truncate(P.end); await w.seek(P.end); }   // 끊긴 가져오기의 찌꺼기는 잘라냄
      else await w.write(pkHead(P.gen));
      var pos = P.end, nk = [], no = [], nl = [], parts = [], pb = 0, cnt = 0, t0 = 0;
      var add = async function (lay, z, x, y, d) {
        if (!d || !d.byteLength || !(z >= 0 && z < 32 && x >= 0 && y >= 0 && x < P2 && y < P2)) return;
        var li = lmap[lay];
        if (li === undefined) { if (layers.length > 255) return; li = layers.length; layers.push(lay); lmap[lay] = li; }
        nk.push(pkKey(li, z, x, y)); no.push(pos); nl.push(d.byteLength);
        parts.push(d); pos += d.byteLength; pb += d.byteLength; cnt++;
        if (pb > 4 * P2) { await w.write(new Blob(parts)); parts = []; pb = 0; }
        if (Date.now() - t0 > 400) { t0 = Date.now(); status(label + '<br>' + cnt + '장 · ' + ((pos - P.end) / P2).toFixed(0) + 'MB'); }
      };
      status(label);
      m.bulk = true;
      if (m.tblRoot) await _mbEach(m, m.tblRoot, function (v) { return add('vw_sat', v[0], v[1], Math.pow(2, v[0]) - 1 - v[2], v[3]); }, job);
      if (m.layTblRoot && !(job && job.cancelled)) await _mbEach(m, m.layTblRoot, function (v) { return add(String(v[0]), v[1], v[2], v[3], v[4]); }, job);
      if (job && job.cancelled) throw { name: '취소' };
      if (parts.length) await w.write(new Blob(parts));
      // 찾아보기표 합치기 — 옛 표(그 파일 옛 몫은 뺌) + 새 것(정렬, 같은 자리는 새 것)
      var N = nk.length, ord = new Array(N);
      for (var i = 0; i < N; i++) ord[i] = i;
      ord.sort(function (a, b) { return nk[a] - nk[b] || a - b; });
      var tot = P.n + N, K = new Float64Array(tot), O = new Float64Array(tot), L = new Uint32Array(tot), S = new Uint16Array(tot);
      var a = 0, j = 0, c = 0, live = 0, nIn = 0;
      while (a < P.n || j < N) {
        if (a < P.n && P.src[a] === sid) { a++; continue; }
        if (j + 1 < N && nk[ord[j]] === nk[ord[j + 1]]) { j++; continue; }   // 한 파일 안 같은 자리 → 뒤의 것
        var kn = j < N ? nk[ord[j]] : Infinity, ko = a < P.n ? P.keys[a] : Infinity;
        if (ko < kn) { K[c] = ko; O[c] = P.offs[a]; L[c] = P.lens[a]; S[c] = P.src[a]; live += P.lens[a]; c++; a++; continue; }
        if (ko === kn) a++;
        var q = ord[j++];
        K[c] = kn; O[c] = no[q]; L[c] = nl[q]; S[c] = sid; live += nl[q]; c++; nIn++;
      }
      var meta = JSON.parse(JSON.stringify(P.meta || {}));
      var num = function (v) { return typeof v === 'number' && isFinite(v); };
      Object.keys(m.layers || {}).forEach(function (k) {
        var A = meta[k], B = m.layers[k] || {};
        if (!A) { meta[k] = B; return; }
        var C = Object.assign({}, A, B);
        if (num(A.minzoom) && num(B.minzoom)) C.minzoom = Math.min(A.minzoom, B.minzoom);
        if (num(A.maxzoom) && num(B.maxzoom)) C.maxzoom = Math.max(A.maxzoom, B.maxzoom);
        meta[k] = C;
      });
      srcs[sid] = { name: m.name, size: m.file.size, n: nIn, t: Date.now() };
      var NP = { gen: P.gen, end: pos, layers: layers, lmap: lmap, meta: meta, srcs: srcs, n: c, live: live,
                 keys: K.subarray(0, c), offs: O.subarray(0, c), lens: L.subarray(0, c), src: S.subarray(0, c) };
      await w.close(); w = null;
      NP.file = await fh.getFile();
      _pk = NP;
      await pkWriteIdx(NP);
      return nIn;
    } finally {
      m.bulk = false;
      if (w) { try { await w.abort(); } catch (e) {} }
    }
  }
  // 한 파일 몫 빼기(표에서만 — 바이트는 버린 곳이 되어 pkCompact 가 줄임)
  async function pkDropSrc(sid) {
    var P = _pk; if (!P) return;
    var K = new Float64Array(P.n), O = new Float64Array(P.n), L = new Uint32Array(P.n), S = new Uint16Array(P.n), c = 0, live = 0;
    for (var i = 0; i < P.n; i++) {
      if (P.src[i] === sid) continue;
      K[c] = P.keys[i]; O[c] = P.offs[i]; L[c] = P.lens[i]; S[c] = P.src[i]; live += P.lens[i]; c++;
    }
    var srcs = P.srcs.slice(); srcs[sid] = null;
    if (!c) { await pkClear(); return; }
    var NP = Object.assign({}, P, { n: c, live: live, srcs: srcs,
      keys: K.subarray(0, c), offs: O.subarray(0, c), lens: L.subarray(0, c), src: S.subarray(0, c) });
    _pk = NP;
    await pkWriteIdx(NP);
  }
  async function pkClear() {
    _pk = null;
    for (var nm of [PX_NAME, PX_NAME + '.new', PK_NAME]) { try { await _fsDir.removeEntry(nm); } catch (e) {} }
  }
  // 버린 곳이 많으면 남은 타일만 새로 써서 줄이기 — 파일 조각(Blob)으로 옮겨 메모리에 안 올림
  async function pkCompact(job, force) {
    var P = _pk; if (!P) return;
    var waste = P.end - PK_HEAD - P.live;
    if (!force && (waste < 50 * P2 || waste < P.live)) return;
    status('합친 지도 정리하는 중...');
    var n = P.n, ord = new Array(n), NO = new Float64Array(n), pos = PK_HEAD, gen = P.gen + 1;
    for (var i = 0; i < n; i++) ord[i] = i;
    ord.sort(function (a, b) { return P.offs[a] - P.offs[b]; });
    for (i = 0; i < n; i++) { NO[ord[i]] = pos; pos += P.lens[ord[i]]; }
    var NP = Object.assign({}, P, { gen: gen, end: pos, offs: NO });
    await pkWriteIdx(NP, PX_NAME + '.new');
    var fh = await _fsDir.getFileHandle(PK_NAME), srcF = P.file;
    var w = await fh.createWritable();                           // 닫기 전까지 옛 파일은 그대로 읽힌다
    try {
      await w.write(pkHead(gen));
      var parts = [], pb = 0;
      for (i = 0; i < n; i++) {
        var q = ord[i];
        parts.push(srcF.slice(P.offs[q], P.offs[q] + P.lens[q])); pb += P.lens[q];
        if (pb > 8 * P2) {
          await w.write(new Blob(parts)); parts = []; pb = 0;
          if (job && job.cancelled) throw { name: '취소' };
          status('합친 지도 정리하는 중... ' + Math.round(i * 100 / n) + '%');
        }
      }
      if (parts.length) await w.write(new Blob(parts));
      await w.close(); w = null;
    } finally { if (w) { try { await w.abort(); } catch (e) {} } }
    NP.file = await fh.getFile();
    _pk = NP;
    await pkWriteIdx(NP);
    try { await _fsDir.removeEntry(PX_NAME + '.new'); } catch (e) {}
  }
  window._jtyPack = function () { return _pk; };   // 시험용
  window._jtyPackCompact = function () { return pkCompact(null, true).then(done, done); };

  // ── PC 지도저장 파일(MBTiles = SQLite) 읽기 — 필요한 쪽만 잘라 읽는다(파일 전체를 올리지 않음) ──
  //  사진위치표시가 만드는 형태: tiles(zoom_level, tile_column, tile_row, tile_data, PRIMARY KEY(z,x,row)) → 자동 색인으로 찾는다.
  //  지도 다운로더는 그 밖 층을 jty_layers(layer, zoom_level, tile_column, tile_row, tile_data, PK(layer,z,x,row)) 에 — 번호는 타일 주소 숫자 그대로.
  //  다른 프로그램이 만든 MBTiles 는 tiles 가 표가 아니면(view) 못 읽고 건너뛴다.
  var _mb = [];                        // [{name, file, ps, us, tblRoot, idxRoot, layTblRoot, layIdxRoot, cache}]
  function _mbOpenAll() {
    if (!_fsDir || !_fsDir.values) return Promise.resolve();
    var list = [];
    return (function walk(it) {
      return it.next().then(function (r) {
        if (r.done) return;
        var h = r.value;
        var p = (h.kind === 'file' && /\.mbtiles$/i.test(h.name))
          ? h.getFile().then(_mbOpen).then(function (m) { if (m) list.push(m); }).catch(function () {}) : null;
        return Promise.resolve(p).then(function () { return walk(it); });
      });
    })(_fsDir.values()).catch(function () {}).then(function () {
      list.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      _mb = list;
    });
  }
  function _mbOpen(file) {
    var m = { name: file.name, file: file, cache: new Map() };
    return file.slice(0, 100).arrayBuffer().then(function (b) {
      var dv = new DataView(b);
      if (String.fromCharCode.apply(null, new Uint8Array(b, 0, 15)) !== 'SQLite format 3') return null;
      m.ps = dv.getUint16(16); if (m.ps === 1) m.ps = 65536;
      m.us = m.ps - dv.getUint8(20);
      return _mbScanAll(m, 1).then(function (rows) {     // sqlite_master
        rows.forEach(function (r) {
          var v = r.vals;
          if (v[0] === 'table' && v[1] === 'tiles') m.tblRoot = v[3];
          if (v[0] === 'index' && v[2] === 'tiles' && /^sqlite_autoindex_tiles|tile_index/i.test(v[1])) m.idxRoot = v[3];
          // PC 지도 다운로더(htm/img/지도다운로더)의 그 밖 층 — jty_layers(layer, z, x, row, data), 숫자는 타일 주소 그대로
          if (v[0] === 'table' && v[1] === 'jty_layers') m.layTblRoot = v[3];
          if (v[0] === 'index' && v[2] === 'jty_layers' && /^sqlite_autoindex_jty_layers/i.test(v[1])) m.layIdxRoot = v[3];
          if (v[0] === 'table' && v[1] === 'metadata') m.metaRoot = v[3];
        });
        if (!(m.layTblRoot && m.layIdxRoot)) m.layTblRoot = m.layIdxRoot = 0;
        if (!((m.tblRoot && m.idxRoot) || m.layTblRoot)) return null;
        m.layers = {};                   // metadata 'jty_layers' = {층: {minzoom, maxzoom, …}} — 해외 일반지도(osm) 줌 범위에 씀
        if (!m.layTblRoot || !m.metaRoot) return m;
        return _mbScanAll(m, m.metaRoot).then(function (rows) {
          rows.forEach(function (r) { if (r.vals[0] === 'jty_layers') { try { m.layers = JSON.parse(r.vals[1]) || {}; } catch (e) {} } });
          return m;
        }, function () { return m; });
      });
    });
  }
  function _mbPage(m, no) {
    var c = m.cache.get(no); if (c) return Promise.resolve(c);
    // 합치기(m.bulk)는 파일을 차례로 훑으므로 1MB 씩 읽어 둔다 — 한 장씩 읽으면 휴대폰에서 아주 느림
    var per = m.bulk ? Math.max(1, Math.floor(P2 / m.ps)) : 1, first = m.bulk ? Math.floor((no - 1) / per) * per + 1 : no;
    return m.file.slice((first - 1) * m.ps, (first - 1 + per) * m.ps).arrayBuffer().then(function (b) {
      if (m.cache.size > Math.max(3000, 32 * P2 / m.ps)) m.cache.clear();
      for (var k = 0; k * m.ps < b.byteLength; k++) m.cache.set(first + k, new Uint8Array(b, k * m.ps, Math.min(m.ps, b.byteLength - k * m.ps)));
      return m.cache.get(no);
    });
  }
  // 표 B-tree 를 처음부터 끝까지 차례로 — 줄마다 fn(값들). 합치기용(큰 파일도 메모리에 다 올리지 않고, 약속 사슬도 안 쌓음)
  async function _mbEach(m, root, fn, job) {
    var stack = [root];
    while (stack.length) {
      var no = stack.pop(), u = await _mbPage(m, no), hd = _hdr(u, no);
      if (hd.t === 5) {                // 안쪽 쪽: 자식들을 차례로 (스택이라 거꾸로 넣음)
        stack.push(hd.right);
        for (var i = hd.n - 1; i >= 0; i--) stack.push(_u32(u, _cellPtr(u, hd, i)));
        continue;
      }
      if (hd.t !== 13) continue;
      for (i = 0; i < hd.n; i++) {
        var p = _cellPtr(u, hd, i), a = _vint(u, p), b = _vint(u, a[1]);
        await fn(_record(await _payload(m, u, b[1], a[0], true)));
      }
      if (job && job.cancelled) return;
    }
  }
  function _vint(u, p) {               // [값, 다음 위치]
    var v = 0;
    for (var i = 0; i < 8; i++) { var c = u[p + i]; v = v * 128 + (c & 127); if (!(c & 128)) return [v, p + i + 1]; }
    return [v * 256 + u[p + 8], p + 9];
  }
  function _u32(u, p) { return ((u[p] << 24) >>> 0) + (u[p + 1] << 16) + (u[p + 2] << 8) + u[p + 3]; }
  function _hdr(u, no) { var o = no === 1 ? 100 : 0, t = u[o]; return { o: o, t: t, n: (u[o + 3] << 8) | u[o + 4], h: (t === 2 || t === 5) ? 12 : 8, right: (t === 2 || t === 5) ? _u32(u, o + 8) : 0 }; }
  function _cellPtr(u, hd, i) { var p = hd.o + hd.h + i * 2; return (u[p] << 8) | u[p + 1]; }
  // 페이로드 전체 (넘침 페이지까지)
  function _payload(m, u, p, size, isTable) {
    var U = m.us, X = isTable ? U - 35 : Math.floor((U - 12) * 64 / 255) - 23;
    if (size <= X) return Promise.resolve(u.subarray(p, p + size));
    var M = Math.floor((U - 12) * 32 / 255) - 23, K = M + ((size - M) % (U - 4)), local = K <= X ? K : M;
    var out = new Uint8Array(size); out.set(u.subarray(p, p + local), 0);
    var got = local, next = _u32(u, p + local);
    function more() {
      if (got >= size || !next) return Promise.resolve(out);
      return _mbPage(m, next).then(function (pg) {
        var n = Math.min(U - 4, size - got); out.set(pg.subarray(4, 4 + n), got); got += n; next = _u32(pg, 0); return more();
      });
    }
    return more();
  }
  function _record(b) {                // 레코드 → 값 배열
    var r = _vint(b, 0), hs = r[0], p = r[1], types = [];
    while (p < hs) { r = _vint(b, p); types.push(r[0]); p = r[1]; }
    var vals = [], q = hs;
    types.forEach(function (t) {
      var n = t === 0 || t === 8 || t === 9 ? 0 : t <= 4 ? t : t === 5 ? 6 : t <= 7 ? 8 : (t - (t % 2 ? 13 : 12)) / 2;
      if (t === 0) vals.push(null);
      else if (t === 8) vals.push(0); else if (t === 9) vals.push(1);
      else if (t <= 6) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + b[q + i]; if (b[q] & 128) v -= Math.pow(2, 8 * n); vals.push(v); }
      else if (t === 7) vals.push(new DataView(b.buffer, b.byteOffset + q, 8).getFloat64(0));
      else if (t % 2) vals.push(new TextDecoder().decode(b.subarray(q, q + n)));
      else vals.push(b.subarray(q, q + n));
      q += n;
    });
    return vals;
  }
  function _mbScanAll(m, root) {       // 작은 표(sqlite_master) 전체 읽기
    var rows = [];
    function walk(no) {
      return _mbPage(m, no).then(function (u) {
        var hd = _hdr(u, no), ps = [];
        for (var i = 0; i < hd.n; i++) {
          var p = _cellPtr(u, hd, i);
          if (hd.t === 5) ps.push(walk(_u32(u, p)));
          else if (hd.t === 13) {
            var a = _vint(u, p), b = _vint(u, a[1]);
            ps.push(_payload(m, u, b[1], a[0], true).then(function (pl) { rows.push({ vals: _record(pl) }); }));
          }
        }
        if (hd.t === 5) ps.push(walk(hd.right));
        return Promise.all(ps);
      });
    }
    return walk(root).then(function () { return rows; });
  }
  function _cmpKey(vals, key) { for (var i = 0; i < key.length; i++) { if (vals[i] < key[i]) return -1; if (vals[i] > key[i]) return 1; } return 0; }
  function _mbRowid(m, key, root) {    // 색인 (z, x, row) 또는 (layer, z, x, row) → rowid
    function walk(no) {
      return _mbPage(m, no).then(function (u) {
        var hd = _hdr(u, no), i = 0;
        function cell(i) {
          var p = _cellPtr(u, hd, i), child = 0;
          if (hd.t === 2) { child = _u32(u, p); p += 4; }
          var a = _vint(u, p);
          return _payload(m, u, a[1], a[0], false).then(function (pl) { return { child: child, vals: _record(pl) }; });
        }
        function step() {
          if (i >= hd.n) return hd.t === 2 ? walk(hd.right) : null;
          return cell(i).then(function (c) {
            var k = _cmpKey(c.vals, key);
            if (k === 0) return c.vals[c.vals.length - 1];
            if (k > 0) return hd.t === 2 ? walk(c.child) : null;
            i++; return step();
          });
        }
        return step();
      });
    }
    return walk(root || m.idxRoot);
  }
  function _mbRow(m, rowid, root) {    // 표 rowid → 값
    function walk(no) {
      return _mbPage(m, no).then(function (u) {
        var hd = _hdr(u, no);
        for (var i = 0; i < hd.n; i++) {
          var p = _cellPtr(u, hd, i);
          if (hd.t === 5) { var k = _vint(u, p + 4)[0]; if (rowid <= k) return walk(_u32(u, p)); }
          else {
            var a = _vint(u, p), b = _vint(u, a[1]);
            if (b[0] === rowid) return _payload(m, u, b[1], a[0], true).then(_record);
          }
        }
        return hd.t === 5 ? walk(hd.right) : null;
      });
    }
    return walk(root || m.tblRoot);
  }
  // 타일 주소 → {lays: 찾을 층(앞이 우선), z, x, y} — 숫자는 주소에 든 그대로(카카오 x=열, y=아래부터 행)
  //  vw_sat 은 표준 tiles 표(TMS 뒤집힌 행), 그 밖은 jty_layers 표. sw.js isFileTile 과 같은 주소들.
  //  카카오는 휴대폰(고해상도)이 HD 주소를 요청 — HD 가 없으면 일반, 일반이 없으면 HD 로 대신(같은 격자, 크기만 다름)
  function _tileKey(url) {
    var a = /cdn\.vworld\.kr\/2d\/(Satellite|Hybrid|Base)\/[^/]+\/(\d+)\/(\d+)\/(\d+)\./.exec(url);
    if (a) return { lays: [{ Satellite: 'vw_sat', Hybrid: 'vw_hybrid', Base: 'vw_base' }[a[1]]], z: +a[2], x: +a[3], y: +a[4] };
    a = /api\.vworld\.kr\/req\/wmts\/1\.0\.0\/[^/]+\/Satellite\/(\d+)\/(\d+)\/(\d+)\./.exec(url);
    if (a) return { lays: ['vw_sat'], z: +a[1], x: +a[3], y: +a[2] };
    a = /map\d*\.(?:kakaocdn|daumcdn)\.net\/map_skyview(_hd)?\/L(\d+)\/(\d+)\/(\d+)\./.exec(url);
    if (a) return { lays: a[1] ? ['kakao_sky_hd', 'kakao_sky'] : ['kakao_sky', 'kakao_sky_hd'], z: +a[2], x: +a[4], y: +a[3] };
    a = /mts\.(?:kakaocdn|daumcdn)\.net\/api\/v1\/tile\/(PNG_SKYH02|PNGSD_SKYH02|PNG02|PNGSD02)\/[^/]+\/[^/]+\/(\d+)\/(\d+)\/(\d+)\./.exec(url);
    if (a) {
      var hd = a[1].indexOf('PNGSD') !== 0, k = /SKYH/.test(a[1]) ? 'kakao_hybrid' : 'kakao_road';
      return { lays: hd ? [k + '_hd', k] : [k, k + '_hd'], z: +a[2], x: +a[4], y: +a[3] };
    }
    return null;
  }
  function mbRead(url) {
    return _mbFind(_tileKey(url));
  }
  function _mbFind(t) {                // t = {lays, z, x, y} — 합친 지도 먼저, 없으면 아직 안 합친 지도 파일
    if (!t) return Promise.resolve(null);
    return pkGet(t).then(function (r) { return r || _mbFindOld(t); });
  }
  function _mbFindOld(t) {
    if (!_mb.length) return Promise.resolve(null);
    var tries = [];                    // [지도 파일, 층] — 우선 층부터 모든 파일
    t.lays.forEach(function (lay) { _mb.forEach(function (m) { if (lay === 'vw_sat' ? m.tblRoot : m.layTblRoot) tries.push([m, lay]); }); });
    var i = 0;
    function next() {
      if (i >= tries.length) return null;
      var m = tries[i][0], lay = tries[i++][1], sat = lay === 'vw_sat';
      var key = sat ? [t.z, t.x, Math.pow(2, t.z) - 1 - t.y] : [lay, t.z, t.x, t.y];
      return _mbRowid(m, key, sat ? m.idxRoot : m.layIdxRoot)
        .then(function (rid) { return rid == null ? null : _mbRow(m, rid, sat ? m.tblRoot : m.layTblRoot); })
        .then(function (v) {
          var d = v && v[sat ? 3 : 4];
          if (!d || !d.buffer) return next();
          return { buf: d.slice().buffer, type: d[0] === 0x89 ? 'image/png' : 'image/jpeg', t: m.file.lastModified, mb: m.name, lay: lay };
        }, function () { return next(); });
    }
    return Promise.resolve(next());
  }
  window._jtyMbRead = mbRead; window._jtyFsStat = _fsStat;   // 시험용

  // ── 해외 일반지도(OSM) — 지도 다운로더가 Protomaps 데이터로 그려 넣은 'osm' 층 (브이월드 앱만, 2026-10-24) ──
  //  인터넷 타일이 아니라 지도 파일에만 있으므로 sw 를 거치지 않고 페이지가 직접 읽어 OpenLayers 층으로 그린다.
  //  512px(HD) 그림 → tilePixelRatio 2. 한국 안(대략 33~38.7N, 124.5~131.9E)에서는 숨김 — 국내는 브이월드 지도가 낫다.
  //  카카오 앱은 카카오 격자(EPSG:5181)라 한국 밖을 못 그려 안 함.
  var _osmLyr = null, OSM_EMPTY = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  function _osmZooms() {
    var zs = null;
    _mb.map(function (m) { return m.layers; }).concat(_pk ? [_pk.meta] : []).forEach(function (ls) {
      var L = ls && ls.osm; if (!L) return;
      zs = zs ? [Math.min(zs[0], L.minzoom), Math.max(zs[1], L.maxzoom)] : [L.minzoom, L.maxzoom];
    });
    return zs;
  }
  function _osmVis() {
    if (!_osmLyr) return;
    var c = ol.proj.transform(vmap.getView().getCenter(), vmap.getView().getProjection(), 'EPSG:4326');
    var inKr = c[1] > 33 && c[1] < 38.7 && c[0] > 124.5 && c[0] < 131.9;
    if (_osmLyr.getVisible() === inKr) _osmLyr.setVisible(!inKr);
  }
  function osmLayerSync(tries) {
    if (!isVw() || typeof ol === 'undefined') {           // 브이월드 지도가 아직 안 만들어졌으면 잠깐 기다림 (카카오 앱이면 끝내 안 생김)
      if ((tries || 0) < 60 && typeof map === 'undefined') setTimeout(function () { osmLayerSync((tries || 0) + 1); }, 1000);
      return;
    }
    if (_osmLyr) { try { vmap.removeLayer(_osmLyr); } catch (e) {} _osmLyr = null; }
    var zs = _osmZooms(); if (!zs) return;
    var attr;
    try { attr = (typeof ol.Attribution === 'function') ? [new ol.Attribution({ html: '© OpenStreetMap contributors, Protomaps' })] : ['© OpenStreetMap contributors, Protomaps']; } catch (e) {}
    var src = new ol.source.XYZ({
      url: 'jtymb:{z}/{x}/{y}', minZoom: zs[0], maxZoom: zs[1], tilePixelRatio: 2, wrapX: false, attributions: attr,
      tileLoadFunction: function (tile, u) {
        var img = tile.getImage(), a = /(\d+)\/(\d+)\/(\d+)$/.exec(u);
        if (!a) { img.src = OSM_EMPTY; return; }
        _mbFind({ lays: ['osm'], z: +a[1], x: +a[2], y: +a[3] }).then(function (r) {
          if (!r) { img.src = OSM_EMPTY; return; }
          var ou = URL.createObjectURL(new Blob([r.buf], { type: r.type }));
          img.addEventListener('load', function () { URL.revokeObjectURL(ou); }, { once: true });
          img.src = ou;
        }, function () { img.src = OSM_EMPTY; });
      }
    });
    _osmLyr = new ol.layer.Tile({ source: src, zIndex: 3 });   // 브이월드 배경(0~2) 위, 항공사진(49·50)·도형(100+) 아래
    vmap.addLayer(_osmLyr);
    if (!osmLayerSync._hooked) { osmLayerSync._hooked = true; vmap.on('moveend', _osmVis); }
    _osmVis();
  }
  window._jtyOsmLayer = function () { return _osmLyr; };   // 시험용

  // ── 서비스워커 질문 받기 ──
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data || {}, port = e.ports && e.ports[0];
    if (d.t === 'fsget' && port) {
      if (!_mb.length && !(_pk && _pk.n)) { port.postMessage({ off: true }); return; }
      mbRead(d.url).then(function (r) {
        if (r) { _fsStat.hit++; port.postMessage({ buf: r.buf, type: r.type, t: r.t }, [r.buf]); }
        else port.postMessage({ miss: true });
      }).catch(function () { port.postMessage({ miss: true }); });
    }
  });
  // 시작: 예전 '지도 저장 폴더' 손잡이는 지우고(권한 창 안 뜨게) 앱 안 저장소를 연다
  fsKv('dir', null).then(fsInit);

  // ── ⚙ 버튼 + 설정 창 ──
  var gear = document.createElement('button');
  gear.className = 'btn'; gear.id = 'gdGearBtn'; gear.title = '설정 — 지도 파일 가져오기 · 지도 미리 받기';
  gear.innerHTML = '⚙️';
  document.body.appendChild(gear);
  var gcss = document.createElement('style');
  gcss.textContent = '#gdGearBtn{top:184px;right:72px;padding:0;font-size:22px;position:absolute;}';
  document.head.appendChild(gcss);
  gear.onclick = function () { showSettings(); };

  // 설정 창의 섹션들 — 다른 설정을 넣을 땐 여기에 {html, bind} 를 하나 더 (위에서부터 차례로 보인다)
  var SETTINGS_SECTIONS = [
    { html: function () {
        var h = '<div class="sec" style="border-top:none;margin-top:4px;padding-top:0;"><b>🗺 지도 파일</b> <span style="color:#888;font-size:12px;">(PC 「🛰 지도저장」·지도 다운로더 .mbtiles)</span>';
        if (!fsSupported()) {
          h += '<div style="margin-top:4px;color:#c62828;">이 브라우저는 앱 안 저장소를 지원하지 않습니다.</div>' +
               '<div style="color:#888;font-size:12px;">크롬으로 열면 쓸 수 있습니다.</div>';
        } else {
          var mbS = function (b) { return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + 'MB'; };
          var srcs = _pk ? _pk.srcs.map(function (s, i) { return s ? { s: s, i: i } : null; }).filter(Boolean) : [];
          h += '<div style="margin-top:4px;">';
          if (_pk && _pk.n) {
            h += '<div>📦 <b>합친 지도</b> 한 파일 — ' + _pk.n.toLocaleString() + '장 · ' + mbS(_pk.file.size) + '</div>';
            h += srcs.map(function (o) {
              return '<div style="display:flex;align-items:center;gap:6px;margin:3px 0 3px 14px;"><span style="flex:1;word-break:break-all;">└ ' + esc(o.s.name) +
                ' <span style="color:#888;">' + (o.s.n || 0).toLocaleString() + '장</span></span>' +
                '<button class="gsMbDel" data-i="' + o.i + '" style="padding:4px 10px;">🗑</button></div>';
            }).join('');
          }
          if (_mb.length) h += '<div style="color:#888;">합치기 기다림: ' + _mb.map(function (m) { return esc(m.name); }).join(', ') + '</div>';
          if (!(_pk && _pk.n) && !_mb.length) h += '<span style="color:#888;">없음</span>';
          h += '</div>';
          if (_fsStat.hit) h += '<div style="margin-top:2px;">이번에 지도 파일에서 읽음 ' + _fsStat.hit + '장</div>';
          var dl = lsJson(LS_MBDL);
          if (dl) h += '<div style="margin-top:4px;color:#c62828;">드라이브에서 받다 멈춤: ' + esc(dl.name) + ' <button id="gsDrvResume" style="padding:4px 10px;">이어 받기</button></div>';
          h += '<div class="btns"><button class="pri" id="gsMbAdd">➕ 지도 파일 가져오기</button><button class="pri" id="gsMbDrv">☁ 구글 드라이브에서</button></div>' +
               '<div style="color:#888;font-size:12px;">큰 파일(수백 MB 넘음)은 「☁ 구글 드라이브에서」로 — 휴대폰 파일 고르기 창에서는 드라이브의 큰 파일이 안 눌립니다.</div>' +
               '<div style="color:#888;font-size:12px;margin-top:4px;">고른 파일을 앱 안에 복사해 두고, 인터넷이 느리거나 끊기면 지도(브이월드·카카오 위성·하이브리드·일반)를 거기서 보여 줍니다. ' +
               '해외 일반지도(OSM)는 브이월드 앱에서 한국 밖을 볼 때 나옵니다. ' +
               '가져온 파일은 모두 「합친 지도」 한 파일에 합칩니다(겹치는 곳은 나중에 가져온 것). 같은 이름을 다시 가져오면 그 몫을 새것으로 바꿉니다. 가져온 뒤 휴대폰의 원본은 지워도 됩니다.' +
               (isVw() ? '' : '<br>※ 카카오 앱은 카카오 타일(PC 지도 다운로더에서 카카오로 받은 것)만 씁니다. 브이월드 타일·해외 지도는 브이월드 앱(/Vmap/)에서.') + '</div>';
        }
        return h + '</div>';
      },
      bind: function () {
        if ($('gsMbAdd')) $('gsMbAdd').onclick = fsImport;
        if ($('gsMbDrv')) $('gsMbDrv').onclick = fsDriveList;
        if ($('gsDrvResume')) $('gsDrvResume').onclick = function () { var dl = lsJson(LS_MBDL); if (dl) fsDriveImport(dl, true); };
        Array.prototype.forEach.call(document.querySelectorAll('.gsMbDel'), function (b) {
          b.onclick = function () { fsDelete(+b.getAttribute('data-i')); };
        });
      } },
    { html: function () {
        return '<div class="sec"><b>🗺 지도 미리 받기</b> <span style="color:#888;font-size:12px;">(데이터 절약 · 신호 없는 곳에서도 보기)</span>' +
          '<div id="gdTileInfo" style="margin-top:4px;">저장된 지도 확인 중...</div>' +
          '<div style="margin-top:6px;">지금 화면을 <select id="gdPreLv" style="font-size:14px;padding:5px;border-radius:6px;">' +
            '<option value="1">1단계 더 확대까지 (4화면)</option>' +
            '<option value="2" selected>2단계 더 확대까지 (20화면)</option>' +
            '<option value="3">3단계 더 확대까지 (84화면)</option></select></div>' +
          '<div class="btns"><button class="pri" id="gdPre">지금 화면 지도 미리 받기</button><button id="gdTileClr">브라우저 안 저장 지도 비우기</button></div>' +
          '<div style="color:#888;font-size:12px;">와이파이에서 받으세요. 받는 동안 지도가 저절로 움직이고, 끝나면 원래 화면으로 돌아옵니다. ' +
            '브라우저 안에는 최대 8000장까지 저장하고, 넘으면 먼저 저장된 것부터 지웁니다(위 지도 파일은 한도 없음).</div></div>';
      },
      bind: function () {
        tileCount().then(function (n) { var el = $('gdTileInfo'); if (el) el.textContent = tileInfoText(n); });
        $('gdPre').onclick = function () { preloadTiles(+$('gdPreLv').value); };
        $('gdTileClr').onclick = function () { clearTiles(showSettings); };
      } }
  ];
  function showSettings() {
    openPanel('<b style="font-size:15px;">⚙️ 설정</b>' + SETTINGS_SECTIONS.map(function (s) { return s.html(); }).join('') +
      '<div class="sec btns"><button id="gsClose">닫기</button></div>');
    SETTINGS_SECTIONS.forEach(function (s) { s.bind(); });
    $('gsClose').onclick = closePanel;
  }
  window.gdShowSettings = showSettings;


})();

// ── 지도 빈 곳 길게 누르기 메뉴 + 거리·면적 재기 (2026-10-17) ──
// 두 지도 공통. 지도 쪽은 길게 누르면 window.openPressMenu(lat, lng, 화면x, 화면y) 를 부르고,
// 지도 탭은 window.measureTap(lat, lng) 이 true 면 거기서 끝, 뒤로가기는 window.measureOnBack() 을 먼저 묻는다.
// 메뉴: 마커 입력(기존 마커 이름 창) · 문자 입력(addTextLabel/addTextLabelV) · 거리 재기 · 면적 재기 · 길찾기 · 공유하기(openShareLocation).
// 재기·길찾기는 💾 저장 때만 보통 선 + 값 글자로 남는다(✕ 취소 = 지움).
// 문자 위를 길게 누르면 메뉴 대신 문자 수정 창(수정·삭제) — findTextAt (2026-10-17).
(function () {
  function isVw() { return typeof vmap !== 'undefined' && vmap && vmap.getView; }
  function toProj(lat, lng) { return ol.proj.transform([lng, lat], 'EPSG:4326', vmap.getView().getProjection()); }
  function saved() {
    try { document.getElementById('saveBtn').disabled = false; } catch (e) {}
    try { autoSaveToDB(); } catch (e) {}
  }

  var css = document.createElement('style');
  css.textContent =
    '.pm-bg{position:fixed;inset:0;z-index:9000;background:transparent;}' +
    '.pm-dot{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#ff3d00;border:2px solid #fff;box-shadow:0 0 0 2px rgba(255,61,0,.35);pointer-events:none;}' +
    '.pm-box{position:fixed;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.3);padding:6px 0;min-width:150px;' +
      '-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}' +
    '.pm-box button{display:block;width:100%;border:none;background:none;text-align:left;padding:12px 18px;font-size:15px;color:#222;cursor:pointer;white-space:nowrap;}' +
    '.pm-box button:active{background:#f1f3f4;}' +
    // 왼쪽 위 주소 줄 아래 — 오른쪽 버튼 줄·아래 +/−·나침반을 가리지 않게
    '#measBar{position:fixed;left:10px;top:86px;z-index:2500;display:none;flex-direction:column;gap:8px;' +
      'background:rgba(0,0,0,.82);color:#fff;border-radius:12px;padding:10px 12px;font-size:14px;line-height:1.4;width:calc(100vw - 160px);max-width:300px;box-sizing:border-box;}' +
    '#measBar.show{display:flex;}' +
    '#measBar .mb-t{word-break:keep-all;white-space:pre-line;}' +
    '#measBar .mb-b{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;}' +
    // 문자 라벨을 길게 누를 때 크롬이 글자를 선택해 버리던 것 막기
    '#map,#vmap{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;}' +
    '#measBar button{border:none;border-radius:18px;background:#fff;color:#222;font-size:14px;font-weight:600;padding:7px 12px;cursor:pointer;flex:none;}' +
    '.meas-lbl{background:#fff;color:#d32f2f;border:2px solid #ff3d00;border-radius:6px;padding:2px 6px;font-size:12px;font-weight:700;white-space:nowrap;pointer-events:none;}' +
    '.meas-pt{width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #ff3d00;box-sizing:border-box;pointer-events:none;}';
  document.head.appendChild(css);

  // ── 거리·면적 계산 ──
  function dist(a, b) {        // a,b = [lat,lng] → m (하버사인)
    var R = 6371008.8, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
    var s = Math.sin(dLa / 2) * Math.sin(dLa / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) * Math.sin(dLo / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function pathLen(p, close) {
    var d = 0; for (var i = 1; i < p.length; i++) d += dist(p[i - 1], p[i]);
    if (close && p.length > 2) d += dist(p[p.length - 1], p[0]);
    return d;
  }
  function area(p) {           // 중심 기준 평면 근사 + 신발끈 공식 (측량 범위에선 오차 무시 가능)
    if (p.length < 3) return 0;
    var la0 = 0, lo0 = 0; p.forEach(function (q) { la0 += q[0]; lo0 += q[1]; }); la0 /= p.length; lo0 /= p.length;
    var r = Math.PI / 180, R = 6371008.8, k = Math.cos(la0 * r);
    var xy = p.map(function (q) { return [(q[1] - lo0) * r * R * k, (q[0] - la0) * r * R]; });
    var s = 0; for (var i = 0; i < xy.length; i++) { var j = (i + 1) % xy.length; s += xy[i][0] * xy[j][1] - xy[j][0] * xy[i][1]; }
    return Math.abs(s) / 2;
  }
  function fmtLen(d) { return d < 1000 ? Math.round(d) + 'm' : (d / 1000).toFixed(2) + 'km'; }
  function fmtArea(a) {
    var py = Math.round(a / 3.305785).toLocaleString() + '평';
    if (a >= 10000) return (a / 10000).toFixed(2) + 'ha (' + Math.round(a).toLocaleString() + '㎡, ' + py + ')';
    return Math.round(a).toLocaleString() + '㎡ (' + py + ')';
  }

  // ── 그리기 어댑터 (카카오 / 브이월드) ──
  var K = { line: null, poly: null, pts: [], lbl: null };
  var V = { lyr: null, ov: null };
  function drawMeas(p, kind, label, dots) {   // dots: 동그라미 찍을 점(기본 = 모든 점, 길찾기 = 찍은 지점만)
    dots = dots || p;
    if (isVw()) {
      if (!V.lyr) {
        V.lyr = new ol.layer.Vector({ source: new ol.source.Vector(), zIndex: 160 });
        vmap.addLayer(V.lyr);
      }
      var src = V.lyr.getSource(); src.clear();
      var cs = p.map(function (q) { return toProj(q[0], q[1]); });
      var stroke = new ol.style.Stroke({ color: '#ff3d00', width: 3 });
      if (kind === 'area' && cs.length >= 3) {
        var pf = new ol.Feature(new ol.geom.Polygon([cs.concat([cs[0]])]));
        pf.setStyle(new ol.style.Style({ stroke: stroke, fill: new ol.style.Fill({ color: 'rgba(255,61,0,0.18)' }) }));
        src.addFeature(pf);
      } else if (cs.length >= 2) {
        var lf = new ol.Feature(new ol.geom.LineString(cs));
        lf.setStyle(new ol.style.Style({ stroke: stroke }));
        src.addFeature(lf);
      }
      var ptSt = new ol.style.Style({ image: new ol.style.Circle({ radius: 5, fill: new ol.style.Fill({ color: '#fff' }), stroke: new ol.style.Stroke({ color: '#ff3d00', width: 2 }) }) });
      dots.forEach(function (q) { var f = new ol.Feature(new ol.geom.Point(toProj(q[0], q[1]))); f.setStyle(ptSt); src.addFeature(f); });
      if (!V.ov) {
        var el = document.createElement('div'); el.className = 'meas-lbl';
        V.ov = new ol.Overlay({ element: el, positioning: 'bottom-center', offset: [0, -10], stopEvent: false });
        vmap.addOverlay(V.ov);
      }
      if (label && cs.length) { V.ov.getElement().textContent = label; V.ov.getElement().style.display = ''; V.ov.setPosition(cs[cs.length - 1]); }
      else V.ov.getElement().style.display = 'none';
      return;
    }
    var ll = p.map(function (q) { return new kakao.maps.LatLng(q[0], q[1]); });
    if (K.line) { K.line.setMap(null); K.line = null; }
    if (K.poly) { K.poly.setMap(null); K.poly = null; }
    K.pts.forEach(function (o) { o.setMap(null); }); K.pts = [];
    if (kind === 'area' && ll.length >= 3) {
      K.poly = new kakao.maps.Polygon({ map: map, path: ll, strokeWeight: 3, strokeColor: '#ff3d00', strokeOpacity: 1, fillColor: '#ff3d00', fillOpacity: 0.18, zIndex: 8 });
    } else if (ll.length >= 2) {
      K.line = new kakao.maps.Polyline({ map: map, path: ll, strokeWeight: 3, strokeColor: '#ff3d00', strokeOpacity: 1, zIndex: 8 });
    }
    dots.forEach(function (q) {
      var d = document.createElement('div'); d.className = 'meas-pt';
      K.pts.push(new kakao.maps.CustomOverlay({ map: map, content: d, position: new kakao.maps.LatLng(q[0], q[1]), xAnchor: 0.5, yAnchor: 0.5, zIndex: 9 }));
    });
    if (K.lbl) { K.lbl.setMap(null); K.lbl = null; }
    if (label && ll.length) {
      var e = document.createElement('div'); e.className = 'meas-lbl'; e.textContent = label;
      K.lbl = new kakao.maps.CustomOverlay({ map: map, content: e, position: ll[ll.length - 1], xAnchor: 0.5, yAnchor: 1.6, zIndex: 10 });
    }
  }
  function clearMeas() {
    if (isVw()) {
      if (V.lyr) V.lyr.getSource().clear();
      if (V.ov) V.ov.getElement().style.display = 'none';
      return;
    }
    if (K.line) K.line.setMap(null);
    if (K.poly) K.poly.setMap(null);
    if (K.lbl) K.lbl.setMap(null);
    K.pts.forEach(function (o) { o.setMap(null); });
    K = { line: null, poly: null, pts: [], lbl: null };
  }

  // ── 재기 모드 ──
  var M = null;   // { kind:'dist'|'area'|'route', p:[[lat,lng],...] } — 길찾기는 wps(찍은 지점)·segs(구간별 점 수)·busy 도
  var bar = document.createElement('div'); bar.id = 'measBar';
  bar.innerHTML = '<div class="mb-t"></div><div class="mb-b"><button class="mb-p" style="display:none"></button><button class="mb-u">↩</button><button class="mb-s">💾 저장</button><button class="mb-x">✕ 취소</button></div>';
  document.body.appendChild(bar);
  bar.querySelector('.mb-u').onclick = function () { undoPt(); };
  bar.querySelector('.mb-p').onclick = function () { setRouteProf(routeProf() === 'car' ? 'foot' : 'car'); };

  // ── 🧭 길찾기 (2026-10-17) — 누른 곳이 출발, 지도를 누를 때마다 앞 지점→새 지점을 길 따라 잇는다 ──
  // 길찾기 서버는 OpenStreetMap 도로(OSRM routing.openstreetmap.de → BRouter brouter.de, 키 없음).
  // PC 지도처럼 카카오 길찾기는 못 쓴다(REST 비밀키 필요 — 휴대폰엔 PC 서버가 없음) → OSM 에 없는 농로는 브이월드 도로중심선으로 보충(아래 vwSeg).
  var ROUTE_NAME = { car: '🚗 자동차', foot: '🚶 도보' };
  var _rGen = 0;
  function routeProf() { try { return localStorage.getItem('m_route_prof') === 'foot' ? 'foot' : 'car'; } catch (e) { return 'car'; } }
  async function getJson(url, ms) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ms);
    try { var r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
    catch (e) { return null; } finally { clearTimeout(t); }
  }
  // ── 브이월드 도로중심선 길찾기 (2026-10-17) ──
  // OSM 에 없는 농로용. 연속수치지형도 도로중심선(LT_L_N3A0020000)을 JSONP 로 받아(CORS 없음) 앱 안에서 최단경로(A*).
  // 꼭짓점 = 노드(1m 안 끝점은 하나로), 끝점이 다른 선 중간 2m 안에 닿으면 그 자리를 잘라 잇는다(T자 길).
  // a·b 는 가장 가까운 선분에 붙인다 — b 쪽은 a 에서 갈 수 있는 선 중 가장 가까운 곳(끊긴 길 조각에 붙지 않게).
  function vwGraphRoute(feats, a, b) {
    var lat0 = (a[0] + b[0]) / 2, KX = 111320 * Math.cos(lat0 * Math.PI / 180), KY = 110540;
    var xy = function (ll) { return [(ll[1] - a[1]) * KX, (ll[0] - a[0]) * KY]; };
    var ll = function (p) { return [a[0] + p[1] / KY, a[1] + p[0] / KX]; };
    var P = [], adj = [], grid = {};
    var gk = function (x, y) { return Math.floor(x / 2) + ',' + Math.floor(y / 2); };
    function node(p, tol) {
      var cx = Math.floor(p[0] / 2), cy = Math.floor(p[1] / 2);
      for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) {
        var c = grid[(cx + i) + ',' + (cy + j)]; if (!c) continue;
        for (var k = 0; k < c.length; k++) { var q = P[c[k]]; if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol) return c[k]; }
      }
      P.push(p); adj.push([]); var key = gk(p[0], p[1]); (grid[key] = grid[key] || []).push(P.length - 1);
      return P.length - 1;
    }
    var E = [];   // [u,v]
    function edge(u, v) { if (u === v) return; var w = Math.hypot(P[u][0] - P[v][0], P[u][1] - P[v][1]); adj[u].push([v, w]); adj[v].push([u, w]); E.push([u, v]); }
    var lines = [];
    feats.forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var ls = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
      ls.forEach(function (l) { if (l.length >= 2) lines.push(l.map(function (c) { return xy([c[1], c[0]]); })); });
    });
    // 끝점부터 노드로(1m 병합), 그다음 중간 꼭짓점(같은 자리만)
    var ends = lines.map(function (l) { return [node(l[0], 1), node(l[l.length - 1], 1)]; });
    lines.forEach(function (l, i) {
      var prev = ends[i][0];
      for (var k = 1; k < l.length; k++) {
        var cur = k === l.length - 1 ? ends[i][1] : node(l[k], 0.01);
        edge(prev, cur); prev = cur;
      }
    });
    if (!E.length) return null;
    // 가장 가까운 선분 위 점
    function proj(p, e) {
      var A = P[e[0]], B = P[e[1]], dx = B[0] - A[0], dy = B[1] - A[1], L = dx * dx + dy * dy;
      var t = L ? Math.max(0, Math.min(1, ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / L)) : 0;
      var q = [A[0] + t * dx, A[1] + t * dy];
      return { q: q, t: t, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
    }
    // T자 길: 연결이 하나뿐인 끝점이 다른 선분 중간 2m 안이면 그 선분을 잘라 잇는다
    for (var n = 0, nP = P.length; n < nP; n++) {
      if (adj[n].length !== 1) continue;
      for (var ei = 0; ei < E.length; ei++) {
        var e = E[ei]; if (!e || e[0] === n || e[1] === n) continue;
        var r = proj(P[n], e);
        if (r.d <= 2 && r.t > 0 && r.t < 1) { splitAt(ei, n); break; }
      }
    }
    function unlink(u, v) { adj[u] = adj[u].filter(function (x) { return x[0] !== v; }); adj[v] = adj[v].filter(function (x) { return x[0] !== u; }); }
    function splitAt(ei, m) { var e = E[ei]; unlink(e[0], e[1]); E[ei] = null; edge(e[0], m); edge(m, e[1]); }
    function nearestEdge(p, ok) {
      var best = null;
      for (var i = 0; i < E.length; i++) {
        var e = E[i]; if (!e || (ok && !ok(e))) continue;
        var r = proj(p, e); if (!best || r.d < best.d) { best = r; best.i = i; }
      }
      return best;
    }
    function insert(s) {   // 선분 위 점을 노드로
      var e = E[s.i];
      if (s.t <= 0) return e[0]; if (s.t >= 1) return e[1];
      P.push(s.q); adj.push([]); var m = P.length - 1; splitAt(s.i, m); return m;
    }
    var pa = xy(a), pb = xy(b);
    var sa = nearestEdge(pa); var na = insert(sa);
    // a 에서 갈 수 있는 곳 전부 (다익스트라)
    var D = new Float64Array(P.length).fill(Infinity), prv = new Int32Array(P.length).fill(-1), done = new Uint8Array(P.length);
    D[na] = 0;
    var heap = [[0, na]];
    function push(x) { heap.push(x); var i = heap.length - 1; while (i) { var p = (i - 1) >> 1; if (heap[p][0] <= x[0]) break; heap[i] = heap[p]; i = p; } heap[i] = x; }
    function pop() { var top = heap[0], x = heap.pop(); if (heap.length) { var i = 0, n = heap.length; for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < n && heap[l][0] < (m === i ? x[0] : heap[m][0])) m = l; if (r < n && heap[r][0] < (m === i ? x[0] : heap[m][0])) m = r; if (m === i) break; heap[i] = heap[m]; i = m; } heap[i] = x; } return top; }
    while (heap.length) {
      var t = pop(), u = t[1]; if (done[u]) continue; done[u] = 1;
      adj[u].forEach(function (x) { var nd = D[u] + x[1]; if (nd < D[x[0]]) { D[x[0]] = nd; prv[x[0]] = u; push([nd, x[0]]); } });
    }
    var sb = nearestEdge(pb, function (e) { return D[e[0]] < Infinity; });
    if (!sb) return null;
    var e = E[sb.i], A = P[e[0]], B = P[e[1]];
    var ca = D[e[0]] + Math.hypot(sb.q[0] - A[0], sb.q[1] - A[1]), cb = D[e[1]] + Math.hypot(sb.q[0] - B[0], sb.q[1] - B[1]);
    var path = [sb.q], v = ca <= cb ? e[0] : e[1];
    if (Math.hypot(P[v][0] - sb.q[0], P[v][1] - sb.q[1]) > 0.01) path.push(P[v]);
    while (prv[v] >= 0) { v = prv[v]; path.push(P[v]); }
    path.reverse();
    return { pts: path.map(ll), gapA: sa.d, gapB: sb.d };
  }
  var VW_DATA_KEY = (typeof VWORLD_KEY !== 'undefined' && VWORLD_KEY) || '55FD7275-A6F5-3B69-9966-CD4BFA2FD35F';   // github.io 도메인 등록 키(브이월드 판과 같음)
  var _vwCache = [];   // 최근 받은 상자 [url, feats] — 경로 다시 잇기 때 다시 안 받게
  function vwJsonp(url, ms) {
    return new Promise(function (res) {
      var cb = '_vwcb' + Date.now().toString(36) + Math.floor(Math.random() * 1e6), s = document.createElement('script');
      var end = function (v) { clearTimeout(t); try { delete window[cb]; } catch (e) { window[cb] = undefined; } s.remove(); res(v); };
      var t = setTimeout(function () { window[cb] = function () {}; end(null); }, ms);
      window[cb] = function (j) { end(j); };
      s.onerror = function () { end(null); };
      s.src = url + '&callback=' + cb;
      document.head.appendChild(s);
    });
  }
  async function vwRoads(box) {   // box=[minLng,minLat,maxLng,maxLat] → features 또는 null
    var base = 'https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_L_N3A0020000&key=' + VW_DATA_KEY
      + '&domain=' + encodeURIComponent(location.origin) + '&geomFilter=BOX(' + box.map(function (v) { return v.toFixed(6); }).join(',')
      + ')&crs=EPSG:4326&format=json&size=1000';
    var hit = _vwCache.find(function (c) { return c[0] === base; }); if (hit) return hit[1];
    var all = [];
    for (var pg = 1; pg <= 4; pg++) {
      var j = await vwJsonp(base + '&page=' + pg, 10000), r = j && j.response;
      if (!r) return null;
      if (r.status === 'NOT_FOUND') break;
      if (r.status !== 'OK') return null;
      all = all.concat(r.result.featureCollection.features || []);
      if (pg >= +(r.page && r.page.total || 1)) break;
    }
    _vwCache.push([base, all]); if (_vwCache.length > 8) _vwCache.shift();
    return all;
  }
  async function vwSeg(a, b) {    // 브이월드 도로중심선으로 a→b → { pts, gap } 또는 null
    var d = dist(a, b);
    if (d > 4000 || navigator.onLine === false) return null;    // 너무 멀면 받는 양이 많아 안 한다
    var m = Math.max(250, d * 0.2), dLat = m / 110540, dLng = m / (111320 * Math.cos(a[0] * Math.PI / 180));
    var box = [Math.min(a[1], b[1]) - dLng, Math.min(a[0], b[0]) - dLat, Math.max(a[1], b[1]) + dLng, Math.max(a[0], b[0]) + dLat];
    try {
      var f = await vwRoads(box); if (!f || !f.length) return null;
      var r = vwGraphRoute(f, a, b); if (!r || r.pts.length < 2) return null;
      return { pts: r.pts, gap: r.gapA + r.gapB };
    } catch (e) { console.warn('[route] vworld', e); return null; }
  }
  // 구간 a→b: OSM 길이 찍은 점에서 30m 넘게 떨어지면(또는 못 찾으면) 브이월드 도로중심선으로도 찾아 빈 거리가 짧은 쪽을 쓴다.
  // 브이월드 실패·오프라인이면 OSM 결과 그대로.
  async function fetchSeg(a, b, prof) {   // a,b=[lat,lng] → [[lat,lng],..] 또는 null
    var o = await fetchOsm(a, b, prof);
    var og = o ? dist(o[0], a) + dist(o[o.length - 1], b) : Infinity;
    if (og <= 30) return o;
    var v = await vwSeg(a, b);
    if (v && v.gap < og) { console.log('[route] 브이월드 도로중심선 사용 — 빈 거리 ' + Math.round(og) + 'm → ' + Math.round(v.gap) + 'm'); return v.pts; }
    return o;
  }
  async function fetchOsm(a, b, prof) {
    var j = await getJson('https://routing.openstreetmap.de/routed-' + prof + '/route/v1/driving/'
      + a[1] + ',' + a[0] + ';' + b[1] + ',' + b[0] + '?overview=full&geometries=geojson', 15000);
    if (j && j.code === 'Ok' && j.routes && j.routes[0] && j.routes[0].geometry.coordinates.length >= 2)
      return j.routes[0].geometry.coordinates.map(function (q) { return [q[1], q[0]]; });
    j = await getJson('https://brouter.de/brouter?lonlats=' + a[1] + ',' + a[0] + '|' + b[1] + ',' + b[0]
      + '&profile=' + (prof === 'foot' ? 'shortest' : 'car-fast') + '&alternativeidx=0&format=geojson', 20000);
    var c = j && j.features && j.features[0] && j.features[0].geometry && j.features[0].geometry.coordinates;
    return c && c.length >= 2 ? c.map(function (q) { return [q[1], q[0]]; }) : null;
  }
  // 한 구간 받아서 M.p 에 붙이기 (요청 순서대로 — M.q 줄)
  function queueSeg(a, b) {
    var gen = _rGen;
    M.busy++;
    M.q = M.q.then(async function () {
      var pts = await fetchSeg(a, b, routeProf());
      if (gen !== _rGen || !M) return;
      var seg = pts ? pts.slice() : [];
      if (seg.length && dist(seg[0], a) < 1) seg.shift();
      var gap = seg.length ? dist(seg[seg.length - 1], b) : 0;
      if (!seg.length || gap > 1) seg.push(b);
      M.fail = !pts; M.gap = pts && gap > 30 ? gap : 0;
      M.p = M.p.concat(seg); M.segs.push(seg.length); M.busy--;
      render();
    });
  }
  function setRouteProf(v) {
    try { localStorage.setItem('m_route_prof', v); } catch (e) {}
    if (!M || M.kind !== 'route') return;
    rebuildRoute();
  }
  // 찍은 지점(M.wps) 전체를 처음부터 다시 잇기 — 받던 구간은 버린다
  function rebuildRoute() {
    _rGen++;
    var w = M.wps;
    M.p = [w[0]]; M.segs = []; M.busy = 0; M.q = Promise.resolve(); M.fail = false; M.gap = 0;
    for (var i = 1; i < w.length; i++) queueSeg(w[i - 1], w[i]);
    render();
  }

  // ── 길찾기 중 길게 누르기 → 경로 편집 메뉴 (2026-10-17) ──
  // 경유지 추가(돌아가는 거리가 가장 적게 늘어나는 구간에) · 지점 삭제(가장 가까운 지점) · 출발지 변경 · 도착지 변경 → 처음부터 다시 잇기
  var _swallowTap = false;   // 길게 누른 손을 뗄 때 지도가 받는 탭은 지점으로 넣지 않는다
  document.addEventListener('pointerdown', function () { _swallowTap = false; }, true);
  function viaIndex(w, p) {
    if (w.length < 2) return w.length;
    var best = 1, bd = 1e18;
    for (var i = 0; i < w.length - 1; i++) {
      var add = dist(w[i], p) + dist(p, w[i + 1]) - dist(w[i], w[i + 1]);
      if (add < bd) { bd = add; best = i + 1; }
    }
    return best;
  }
  function routeEdit(kind, p) {
    if (!M || M.kind !== 'route') return;
    var w = M.wps;
    if (kind === 'via') w.splice(viaIndex(w, p), 0, p);
    else if (kind === 'del') {
      if (w.length <= 1) { alert('지울 지점이 없습니다.'); return; }
      var k = 0; w.forEach(function (q, i) { if (dist(q, p) < dist(w[k], p)) k = i; });
      w.splice(k, 1);
    }
    else if (kind === 'start') w[0] = p;
    else if (w.length < 2) w.push(p); else w[w.length - 1] = p;
    rebuildRoute();
  }
  function openRouteMenu(lat, lng, cx, cy) {
    _swallowTap = true;
    var p = [lat, lng];
    var bg = document.createElement('div'); bg.className = 'pm-bg';
    var dot = document.createElement('div'); dot.className = 'pm-dot';
    dot.style.left = cx + 'px'; dot.style.top = cy + 'px';
    var box = document.createElement('div'); box.className = 'pm-box';
    var head = document.createElement('div');
    head.style.cssText = 'padding:6px 18px 8px;color:#666;font-size:12px;border-bottom:1px solid #eee;';
    head.textContent = '🧭 길찾기 · 지점 ' + M.wps.length + '개';
    box.appendChild(head);
    var armed = false;
    [['📍 경유지 추가', 'via'], ['❌ 지점 삭제', 'del'], ['🚩 출발지 변경', 'start'], ['🏁 도착지 변경', 'end'], ['✕ 취소', '']].forEach(function (it) {
      var b = document.createElement('button'); b.textContent = it[0];
      b.onclick = function (e) { e.stopPropagation(); if (!armed) return; bg.remove(); if (it[1]) routeEdit(it[1], p); };
      box.appendChild(b);
    });
    bg.appendChild(dot); bg.appendChild(box);
    document.body.appendChild(bg);
    var w = box.offsetWidth, h = box.offsetHeight, W = innerWidth, H = innerHeight;
    var x = cx + 18; if (x + w > W - 8) x = cx - 18 - w; x = Math.max(8, Math.min(x, W - w - 8));
    var y = cy - h / 2; y = Math.max(8, Math.min(y, H - h - 8));
    box.style.left = x + 'px'; box.style.top = y + 'px';
    bg.addEventListener('pointerdown', function () { armed = true; });
    bg.addEventListener('click', function (e) { if (armed && e.target === bg) bg.remove(); });
    bg.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // ── 저장한 경로 다시 고치기 (2026-10-17) ──
  // 저장할 때 찍은 지점·옵션을 선에 붙여 둔다(카카오 entry.rwps/rprof, 브이월드 lyr._rwps/_rprof → 자동저장·KMZ 의 ExtendedData).
  // 선 메뉴의 '🧭 경로 고치기' → 그 지점들로 길찾기를 다시 열고, 💾 저장하면 옛 선·값 글자를 바꾼다(✕ 취소면 그대로).
  function routeDataOf(o) {
    if (!o) return null;
    var w = isVw() ? o._rwps : o.rwps, pf = isVw() ? o._rprof : o.rprof;
    return w && w.length >= 2 ? { wps: w.map(function (q) { return q.slice(); }), prof: pf === 'foot' ? 'foot' : 'car' } : null;
  }
  function lastPtOf(o) {   // 선의 끝점 [lat,lng]
    try {
      if (isVw()) { var cs = coordParts(o); var c = cs[cs.length - 1]; var ll = fromMerc(c[c.length - 1]); return [ll[1], ll[0]]; }
      var p = o.path[o.path.length - 1]; return [p.getLat(), p.getLng()];
    } catch (e) { return null; }
  }
  // 저장 때 같이 넣은 값 글자 찾기 (같은 글자 + 선 끝점 10m 안)
  function findValueLabel(o) {
    var nm = String(isVw() ? o._name : o.name || ''), val = nm.replace(/^경로\s*/, ''), end = lastPtOf(o);
    if (!val || !end) return null;
    var list = isVw() ? (typeof textLabelsV !== 'undefined' ? textLabelsV : []) : (typeof textLabels !== 'undefined' ? textLabels : []);
    for (var i = 0; i < list.length; i++) {
      var t = list[i]; if (t.name !== val) continue;
      var q;
      if (isVw()) { var ll = fromMerc(t.coord); q = [ll[1], ll[0]]; } else q = [t.pos.getLat(), t.pos.getLng()];
      if (dist(q, end) < 10) return t;
    }
    return null;
  }
  function removeLine(o) {
    try {
      if (isVw()) { removeLyr(o); polylines = polylines.filter(function (x) { return x !== o; }); }
      else { o.poly.setMap(null); polylines = polylines.filter(function (x) { return x !== o; }); }
    } catch (e) {}
  }
  function startRouteEdit(o) {
    var d = routeDataOf(o);
    if (!d) return;
    try { localStorage.setItem('m_route_prof', d.prof); } catch (e) {}
    startMeasure('route', d.wps[0][0], d.wps[0][1]);
    M.wps = d.wps; M.replace = o;
    rebuildRoute();
  }
  // 선 메뉴(#polyMenu)에 '🧭 경로 고치기' — 찍은 지점이 있는 선일 때만 보인다
  (function () {
    var pm = document.getElementById('polyMenu'); if (!pm) return;
    var rb = document.createElement('button'); rb.id = 'polyRouteBtn'; rb.textContent = '🧭 경로 고치기'; rb.style.display = 'none';
    pm.insertBefore(rb, document.getElementById('polyEditBtn'));
    var cur = function () { try { return isVw() ? polyTarget : (polyMenuTarget && polyMenuTarget.entry); } catch (e) { return null; } };
    rb.onclick = function () { var o = cur(); hidePolyMenu(); if (o) startRouteEdit(o); };
    var orig = window.showPolyMenu;
    if (typeof orig === 'function') window.showPolyMenu = function () {
      var r = orig.apply(this, arguments);
      var o = cur(); if (!isVw() && !o && polyMenuTarget) o = polylines.find(function (x) { return x.poly === polyMenuTarget.poly; });
      rb.style.display = routeDataOf(o) ? '' : 'none';
      return r;
    };
  })();
  bar.querySelector('.mb-s').onclick = function () { saveMeasure(); };
  bar.querySelector('.mb-x').onclick = function () { stopMeasure(); };

  // 💾 저장 — 잰 것을 보통 선(면적은 닫힌 선) + 값 글자로 바꿔 넣는다 → 자동저장·내보내기·지우개 그대로 (2026-10-17)
  // 면의 채움색은 선 구조라 저장되지 않는다.
  var MEAS_COLOR = '#FF3D00', MEAS_WIDTH = 3;
  function saveMeasure() {
    if (!M) return;
    var p = M.p.slice(), isArea = M.kind === 'area', isRoute = M.kind === 'route';
    if (isRoute && M.busy) { alert('경로를 찾는 중입니다. 잠시 뒤에 저장하세요.'); return; }
    if (p.length < (isArea ? 3 : 2)) { alert(isArea ? '점을 3개 이상 찍어야 저장됩니다.' : '점을 2개 이상 찍어야 저장됩니다.'); return; }
    var val = isArea ? fmtArea(area(p)) : fmtLen(pathLen(p));
    var name = (isArea ? '면적 ' : isRoute ? '경로 ' : '거리 ') + val;
    var line = isArea ? p.concat([p[0]]) : p;
    var at = p[p.length - 1];
    if (isArea) {   // 면적 글자는 꼭짓점 평균 자리에
      var la = 0, lo = 0; p.forEach(function (q) { la += q[0]; lo += q[1]; });
      at = [la / p.length, lo / p.length];
    }
    var rdata = isRoute ? { wps: M.wps.map(function (q) { return q.slice(); }), prof: routeProf() } : null;
    var old = isRoute ? M.replace : null;
    stopMeasure();
    try {
      if (old) {                                   // 경로 고치기 — 옛 선과 그 값 글자를 바꾼다
        var ol = findValueLabel(old);
        removeLine(old);
        if (ol) replaceText(ol, '');
      }
      if (isVw()) {
        var lyr = mkLineLyr(line.map(function (q) { return toProj(q[0], q[1]); }), MEAS_COLOR, MEAS_WIDTH);
        lyr._name = name;
        if (rdata) { lyr._rwps = rdata.wps; lyr._rprof = rdata.prof; }
        addLyr(lyr); polylines.push(lyr);
        addTextLabelV(toProj(at[0], at[1]), val, 0, MEAS_COLOR, 0);
      } else {
        var path = line.map(function (q) { return new kakao.maps.LatLng(q[0], q[1]); });
        var poly = new kakao.maps.Polyline({ map: map, path: path, strokeWeight: MEAS_WIDTH, strokeColor: MEAS_COLOR, strokeOpacity: 1 });
        var entry = { poly: poly, name: name, path: path, color: MEAS_COLOR, width: MEAS_WIDTH };
        if (rdata) { entry.rwps = rdata.wps; entry.rprof = rdata.prof; }
        attachPolylineDelete(poly, entry);
        polylines.push(entry);
        addTextLabel(new kakao.maps.LatLng(at[0], at[1]), val, 0, MEAS_COLOR, 0);
      }
      saved();
    } catch (e) { console.warn('재기 저장 실패', e); }
  }
  function render() {
    if (!M) return;
    var p = M.p, txt, lbl = '';
    var pb = bar.querySelector('.mb-p');
    pb.style.display = M.kind === 'route' ? '' : 'none';
    if (M.kind === 'route') {
      pb.textContent = ROUTE_NAME[routeProf()];
      if (p.length >= 2) lbl = fmtLen(pathLen(p));
      txt = '🧭 길찾기' + (M.busy ? ' — 길 찾는 중…' : '') + '\n'
        + (M.wps.length < 2 ? '지도를 눌러 다음 지점을 찍으세요' : '총 ' + (lbl || '0m') + ' · 지점 ' + M.wps.length + '개 · 길게 누르면 편집')
        + (M.fail ? '\n⚠️ 길을 못 찾아 마지막 구간은 직선' : M.gap ? '\n⚠️ 끝 ' + Math.round(M.gap) + 'm 는 지도에 길이 없어 직선' : '');
      bar.querySelector('.mb-t').textContent = txt;
      drawMeas(p, 'dist', lbl, M.wps);
      return;
    }
    if (M.kind === 'area') {
      if (p.length < 3) txt = '📐 면적 — 지도를 눌러 점 ' + (3 - p.length) + '개 더';
      else { lbl = fmtArea(area(p)); txt = '📐 면적 ' + lbl + '\n둘레 ' + fmtLen(pathLen(p, true)) + ' · 점 ' + p.length + '개'; }
    } else {
      if (p.length < 2) txt = '📏 거리 — 지도를 눌러 점 찍기';
      else { lbl = fmtLen(pathLen(p)); txt = '📏 총 ' + lbl + ' · 점 ' + p.length + '개'; }
    }
    bar.querySelector('.mb-t').textContent = txt;
    drawMeas(p, M.kind, lbl);
  }
  function startMeasure(kind, lat, lng) {
    try { if (typeof drawingMode !== 'undefined' && drawingMode) stopDrawing(); } catch (e) {}
    try { if (typeof drawing !== 'undefined' && drawing) endDraw(); } catch (e) {}
    try { if (typeof eraseMode !== 'undefined' && eraseMode) setEraseMode(false); } catch (e) {}
    clearMeas();
    M = { kind: kind, p: [[lat, lng]] };
    if (kind === 'route') { _rGen++; M.wps = [[lat, lng]]; M.segs = []; M.busy = 0; M.q = Promise.resolve(); }
    window._routeMode = kind === 'route';   // 길찾기 중엔 길게 누르기 = 경로 편집 메뉴
    window._measuring = true;
    bar.classList.add('show');
    render();
  }
  function undoPt() {
    if (!M) return;
    if (M.kind === 'route') {                  // 길찾기: 마지막 지점과 그 구간 통째로
      if (M.busy) return;                      // 받는 중에는 기다림
      if (M.segs.length) { M.p.splice(M.p.length - M.segs.pop()); M.wps.pop(); M.fail = false; M.gap = 0; render(); }
      else stopMeasure();
      return;
    }
    M.p.pop();
    if (!M.p.length) { stopMeasure(); return; }
    render();
  }
  function stopMeasure() {
    _rGen++;
    M = null; window._measuring = false; window._routeMode = false;
    bar.classList.remove('show');
    clearMeas();
  }
  window.measureTap = function (lat, lng) {
    if (!M || !isFinite(lat) || !isFinite(lng)) return false;
    if (M.kind === 'route') {
      if (_swallowTap) { _swallowTap = false; return true; }   // 길게 누른 손을 뗀 탭
      var a = M.wps[M.wps.length - 1], b = [lat, lng];
      M.wps.push(b); queueSeg(a, b); render();
      return true;
    }
    M.p.push([lat, lng]); render();
    return true;
  };
  // 뒤로가기 = 점 하나 되돌리기, 다 지우면 재기 끝
  window.measureOnBack = function () { if (!M) return false; undoPt(); return true; };

  // ── 문자 찾기·바꾸기 (길게 누른 곳의 문자 → 수정 창) ──
  // 카카오 라벨은 pointer-events:none 이라 누르면 지도가 받는다 → 화면 좌표로 직접 찾는다.
  function findTextAt(cx, cy) {
    var best = null, bd = 1e9;
    try {
      if (isVw()) {
        if (typeof textLabelsV === 'undefined') return null;
        var r = vmap.getViewport().getBoundingClientRect();
        textLabelsV.forEach(function (o) {
          if (window.isCadText && isCadText(o)) return;     // 지적도 지번은 따로 고르지 않음(지적도 선 메뉴로 색·삭제)
          var px = vmap.getPixelFromCoordinate(o.coord); if (!px) return;
          var dx = Math.abs(cx - (r.left + px[0])), dy = Math.abs(cy - (r.top + px[1]));
          var hw = Math.max(24, String(o.name).length * 9);   // 캔버스 글자라 크기를 어림 (13px 굵은 글씨)
          if (dx <= hw && dy <= 22 && dx + dy < bd) { bd = dx + dy; best = o; }
        });
        return best;
      }
      if (typeof textLabels === 'undefined') return null;
      textLabels.forEach(function (o) {
        if (!o.ov.getMap() || o.el.style.display === 'none') return;
        if (window.isCadText && isCadText(o)) return;       // 지적도 지번은 따로 고르지 않음
        var b = o.el.getBoundingClientRect(), m = 12;
        if (cx < b.left - m || cx > b.right + m || cy < b.top - m || cy > b.bottom + m) return;
        var d = Math.abs(cx - (b.left + b.right) / 2) + Math.abs(cy - (b.top + b.bottom) / 2);
        if (d < bd) { bd = d; best = o; }
      });
    } catch (e) {}
    return best;
  }
  // t 가 빈 문자열이면 삭제. 같은 자리·각도·색·크기로 다시 만든다
  function replaceText(o, t) {
    try {
      if (isVw()) {
        textLabelLyr.getSource().removeFeature(o.feat);
        textLabelsV.splice(textLabelsV.indexOf(o), 1);
        if (t) addTextLabelV(o.coord, t, o.rot, o.color, o.h, o.ax, o.ay);
        try { _syncSaveBtnV(); } catch (e) {}
      } else {
        o.ov.setMap(null);
        textLabels.splice(textLabels.indexOf(o), 1);
        if (t) addTextLabel(o.pos, t, o.rot, o.color, o.h, o.ax, o.ay);
        try { _syncSaveBtn(); } catch (e) {}
      }
      autoSaveToDB();
    } catch (e) { console.warn('문자 수정 실패', e); }
  }

  // ── 문자 입력 창 (edit = 기존 문자 객체면 수정 창: 수정·삭제·취소) ──
  function openTextInput(lat, lng, edit) {
    var bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9000;display:flex;align-items:center;justify-content:center;';
    var btn = 'flex:1;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;';
    bg.innerHTML =
      '<div style="background:white;border-radius:14px;padding:20px;width:290px;box-shadow:0 4px 24px rgba(0,0,0,0.25);">' +
      '<h3 style="margin:0 0 10px;font-size:16px;color:#333;">' + (edit ? '🔤 문자 수정' : '🔤 문자 입력') + '</h3>' +
      '<input class="ti-in" type="text" placeholder="지도에 쓸 글자" style="width:100%;box-sizing:border-box;font-size:15px;padding:10px;border:1px solid #ccc;border-radius:8px;margin-bottom:14px;">' +
      '<div style="display:flex;gap:8px;">' +
      '<button class="ti-ok" style="' + btn + 'background:#1a73e8;color:white;">' + (edit ? '수정' : '추가') + '</button>' +
      (edit ? '<button class="ti-del" style="' + btn + 'background:#e53935;color:white;">삭제</button>' : '') +
      '<button class="ti-no" style="' + btn + 'background:#f1f3f4;color:#555;">취소</button>' +
      '</div></div>';
    document.body.appendChild(bg);
    var inp = bg.querySelector('.ti-in');
    if (edit) inp.value = edit.name || '';
    setTimeout(function () { inp.focus(); if (edit) inp.select(); }, 100);
    function ok() {
      var t = inp.value.trim();
      if (!t) { inp.focus(); return; }
      bg.remove();
      if (edit) { if (t !== edit.name) replaceText(edit, t); return; }
      try {
        if (isVw()) addTextLabelV(toProj(lat, lng), t, 0, '', 0);
        else addTextLabel(new kakao.maps.LatLng(lat, lng), t, 0, '', 0);
        saved();
      } catch (e) { console.warn('문자 입력 실패', e); }
    }
    if (edit) bg.querySelector('.ti-del').onclick = function () { bg.remove(); replaceText(edit, ''); };
    bg.querySelector('.ti-ok').onclick = ok;
    bg.querySelector('.ti-no').onclick = function () { bg.remove(); };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ok(); if (e.key === 'Escape') bg.remove(); });
    // 길게 눌러 연 수정 창은 손을 뗄 때의 click 이 바깥(=닫기)에 떨어진다 → 새로 누른 뒤의 click 만 받는다
    var armed = !edit;
    bg.addEventListener('pointerdown', function () { armed = true; });
    bg.addEventListener('click', function (e) { if (armed && e.target === bg) bg.remove(); });
  }

  function addMarkerAt(lat, lng) {
    try {
      if (isVw()) { pendingMarkerCoord = toProj(lat, lng); openMarkerModal(); }
      else openMarkerModal(new kakao.maps.LatLng(lat, lng));
    } catch (e) { console.warn('마커 입력 실패', e); }
  }

  // ── 길게 누르기 메뉴 ──
  window.openPressMenu = function (lat, lng, cx, cy) {
    if (M && M.kind === 'route') { openRouteMenu(lat, lng, cx, cy); return; }   // 길찾기 중 → 경로 편집 메뉴
    var tx = findTextAt(cx, cy);                        // 문자 위를 길게 누름 → 수정 창
    if (tx) { openTextInput(lat, lng, tx); return; }
    // 화면 전체를 덮는 id 없는 창 → 뒤로가기(_closeTopPopup)로 닫힌다
    var bg = document.createElement('div'); bg.className = 'pm-bg';
    var dot = document.createElement('div'); dot.className = 'pm-dot';
    dot.style.left = cx + 'px'; dot.style.top = cy + 'px';
    var box = document.createElement('div'); box.className = 'pm-box';
    // 길게 누른 손을 뗄 때의 click 이 메뉴를 바로 닫거나 고르지 않게 — 새로 누른 뒤의 click 만 받는다
    var armed = false;
    var items = [
      ['📍 마커 입력', function () { addMarkerAt(lat, lng); }],
      ['🔤 문자 입력', function () { openTextInput(lat, lng); }],
      ['📏 거리 재기', function () { startMeasure('dist', lat, lng); }],
      ['📐 면적 재기', function () { startMeasure('area', lat, lng); }],
      ['🧭 길찾기', function () { startMeasure('route', lat, lng); }],
      ['🗺 지적도 불러오기', function () { window.loadCadastralAt(lat, lng); }],
      ['📤 공유하기', function () { openShareLocation(lat, lng); }]
    ];
    items.forEach(function (it) {
      var b = document.createElement('button'); b.textContent = it[0];
      b.onclick = function (e) {
        e.stopPropagation();
        if (!armed) return;
        bg.remove(); it[1]();
      };
      box.appendChild(b);
    });
    bg.appendChild(dot); bg.appendChild(box);
    document.body.appendChild(bg);
    // 손가락 옆(가리지 않게)에 띄우고 화면 안으로 맞춤
    var w = box.offsetWidth, h = box.offsetHeight, W = innerWidth, H = innerHeight;
    var x = cx + 18; if (x + w > W - 8) x = cx - 18 - w; x = Math.max(8, Math.min(x, W - w - 8));
    var y = cy - h / 2; y = Math.max(8, Math.min(y, H - h - 8));
    box.style.left = x + 'px'; box.style.top = y + 'px';
    bg.addEventListener('pointerdown', function () { armed = true; });
    bg.addEventListener('click', function (e) { if (armed && e.target === bg) bg.remove(); });
    bg.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  };

})();

// ── 🗺 지적도 불러오기 (2026-10-24) — PC 지도의 '지적도 삽입'과 같은 모양, 단 지금 화면 안 필지만 ──
// 길게 누르기 메뉴 → 지금 화면에 걸친 필지(여러 리에 걸쳐도)를 흰색 1px 묶음선 한 항목 「○○리 지적도」 + 지번 문자(높이 2m)로 넣는다.
//   · 최대 확대에서 4단계 안에서만(브이월드 줌 16 이상, 휴대폰 카카오 레벨 5 이하) — 넓은 화면은 필지가 너무 많아 오래 걸린다.
//   · 이미 넣은 필지(같은 지번 글자가 같은 자리에 있음)는 건너뛰어, 화면을 옮겨 가며 여러 번 불러도 겹치지 않는다.
//   · 지번 문자는 선 항목에 딸린다(ExtendedData owner = 항목 이름) — 따로 선택·수정·지우개 안 됨, 선 색을 바꾸면 같이, 선을 지우면 같이.
// 데이터는 지적도_생성.py 가 연속지적도 SHP 를 리별로 나눈 /img/cad/<PNU 10자리>.json (브이월드 판도 같은 사이트의 /img/cad/ 를 씀).
//   index.json = {q, src, li:[{li, emd, ri, n, kb, b:[남,서,북,동](위경도×q)}]}
//   리 파일 = {li, emd, ri, p:[[지번, 중심위도, 중심경도, 링(첫 점+차이값, [위,경,위,경…])…]…]}
// 받은 파일은 캐시 'cad-v1' 에 두어 다시 받지 않는다(index.json 은 하루 한 번 새로, 리 파일 주소에 src 를 붙여 새 데이터면 새로 받음).
// 지도에는 KML 로 만들어 loadKMZ 로 넣는다(자동저장·내보내기 그대로). 넣은 뒤 보던 화면 그대로.
(function () {
  var CAD_BASE = location.origin + '/img/cad/', CAD_CACHE = 'cad-v1';
  var CAD_COLOR = '#FFFFFF';                 // 기본 색 (선·지번 같은 색)
  var VW_MIN_ZOOM = 16, KAKAO_MAX_LEVEL = 5; // 최대(브이월드 20 · 휴대폰 카카오 1)에서 4단계
  var _idx = null;
  function isVw() { return typeof vmap !== 'undefined' && vmap && vmap.getView; }
  async function cget(url, key, fresh) {
    var c = null; try { c = await caches.open(CAD_CACHE); } catch (e) {}
    if (c && !fresh) { var hit = await c.match(key); if (hit) return hit.json(); }
    try {
      var r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (c) { try { await c.put(key, r.clone()); } catch (e) {} }
      return await r.json();
    } catch (e) {
      if (c) { var old = await c.match(key); if (old) return old.json(); }
      throw e;
    }
  }
  async function getIndex() {
    if (_idx) return _idx;
    var d = new Date(), day = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    _idx = await cget(CAD_BASE + 'index.json?d=' + day, CAD_BASE + 'index.json', true);
    return _idx;
  }
  function rings(p) {           // 리 파일 한 필지 → 링 [[위,경]…] (정수)
    var out = [];
    for (var k = 3; k < p.length; k++) {
      var f = p[k], r = [], a = 0, b = 0;
      for (var i = 0; i < f.length; i += 2) { a += f[i]; b += f[i + 1]; r.push([a, b]); }
      out.push(r);
    }
    return out;
  }
  function viewBox() {          // 지금 화면 [남,서,북,동] (위경도)
    if (isVw()) {
      var v = vmap.getView(), ex = ol.proj.transformExtent(v.calculateExtent(vmap.getSize()), v.getProjection(), 'EPSG:4326');
      return [ex[1], ex[0], ex[3], ex[2]];
    }
    var b = map.getBounds(), sw = b.getSouthWest(), ne = b.getNorthEast();
    return [sw.getLat(), sw.getLng(), ne.getLat(), ne.getLng()];
  }
  function tooWide() { return isVw() ? vmap.getView().getZoom() < VW_MIN_ZOOM - 0.01 : map.getLevel() > KAKAO_MAX_LEVEL; }
  // 지적도 지번 문자인가 — 딸린 문자(owner) 또는 예전 저장본의 노랑 2m 문자. 지도 쪽 지우개도 이걸로 건너뜀
  function isCadText(t) { return !!(t && (t.owner || (t.h === 2 && /^#ffff00$/i.test(t.color || '')))); }
  window.isCadText = isCadText;
  function cadTexts() {         // 지도에 이미 있는 지적도 지번 [위,경,글자]
    var out = [];
    try {
      if (isVw()) textLabelsV.forEach(function (t) { if (isCadText(t)) { var ll = ol.proj.toLonLat(t.coord); out.push([ll[1], ll[0], t.name]); } });
      else textLabels.forEach(function (t) { if (isCadText(t)) out.push([t.pos.getLat(), t.pos.getLng(), t.name]); });
    } catch (e) {}
    return out;
  }
  function itemNames() {
    try { return polylines.map(function (p) { return p.name || p._name; }); } catch (e) { return []; }
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function toKml(name, ps, q) {
    var f = function (v) { return (v / q).toFixed(7); };
    var kc = 'ff' + CAD_COLOR.slice(5, 7) + CAD_COLOR.slice(3, 5) + CAD_COLOR.slice(1, 3);   // KML 색은 aabbggrr
    var parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>' + esc(name) + '</name>\n'
      + '<Style id="cad"><LineStyle><color>' + kc + '</color><width>1</width></LineStyle></Style>\n'
      + '<Placemark><name>' + esc(name) + '</name><styleUrl>#cad</styleUrl><MultiGeometry>'];
    ps.forEach(function (p) {
      p.r.forEach(function (r) {
        parts.push('<LineString><coordinates>' + r.map(function (c) { return f(c[1]) + ',' + f(c[0]) + ',0'; }).join(' ') + '</coordinates></LineString>');
      });
    });
    parts.push('</MultiGeometry></Placemark>\n');
    ps.forEach(function (p) {
      if (!p.j) return;
      parts.push('<Placemark><name>' + esc(p.j) + '</name><ExtendedData><Data name="kind"><value>text</value></Data><Data name="rot"><value>0</value></Data>'
        + '<Data name="color"><value>' + CAD_COLOR + '</value></Data><Data name="h"><value>2</value></Data><Data name="ax"><value>0.5</value></Data><Data name="ay"><value>0.5</value></Data>'
        + '<Data name="owner"><value>' + esc(name) + '</value></Data>'
        + '</ExtendedData><Point><coordinates>' + f(p.c[1]) + ',' + f(p.c[0]) + ',0</coordinates></Point></Placemark>\n');
    });
    parts.push('</Document></kml>');
    return parts.join('');
  }
  function viewSave() {
    if (isVw()) { var v = vmap.getView(); return { c: v.getCenter().slice(), z: v.getZoom(), r: v.getRotation() }; }
    return { c: map.getCenter(), z: map.getLevel() };
  }
  function viewRestore(st) {
    if (isVw()) { var v = vmap.getView(); v.setZoom(st.z); v.setCenter(st.c); v.setRotation(st.r); }
    else { map.setLevel(st.z); map.setCenter(st.c); }
  }
  var _busy = false;
  window.loadCadastralAt = async function () {
    if (_busy) return;
    if (tooWide()) { showToastMsg('🗺 지도를 더 확대하세요 — 지적도는 최대 확대에서 4단계 안에서 불러옵니다'); return; }
    _busy = true;
    try {
      showLoading('🗺 지적도 찾는 중...');
      var ix = await getIndex(), q = ix.q || 1e6, vb = viewBox();
      var S = Math.round(vb[0] * q), W = Math.round(vb[1] * q), N = Math.round(vb[2] * q), E = Math.round(vb[3] * q);
      var cand = ix.li.filter(function (e) { return e.b[0] <= N && e.b[2] >= S && e.b[1] <= E && e.b[3] >= W; });
      if (!cand.length) { hideLoading(); showToastMsg('🗺 이 화면의 지적도가 없습니다 (' + (ix.src || '') + ' 범위 밖)'); return; }
      var have = new Set(cadTexts().map(function (t) { return t[2] + '|' + Math.round(t[0] * q) + '|' + Math.round(t[1] * q); }));
      var ps = [], ris = [], dup = 0;
      for (var i = 0; i < cand.length; i++) {
        var e = cand[i];
        showLoading('🗺 지적도 받는 중... ' + (e.ri || e.li) + ' (' + e.kb + 'KB)' + (cand.length > 1 ? ' ' + (i + 1) + '/' + cand.length : ''));
        var key = CAD_BASE + e.li + '.json?v=' + encodeURIComponent(ix.src || '');
        var d = await cget(key, key), n0 = ps.length;
        d.p.forEach(function (p) {
          var rs = rings(p), s = Infinity, w = Infinity, n = -Infinity, ea = -Infinity;
          rs.forEach(function (r) { r.forEach(function (c) { if (c[0] < s) s = c[0]; if (c[0] > n) n = c[0]; if (c[1] < w) w = c[1]; if (c[1] > ea) ea = c[1]; }); });
          if (s > N || n < S || w > E || ea < W) return;                       // 화면에 안 걸친 필지
          if (have.has(p[0] + '|' + p[1] + '|' + p[2])) { dup++; return; }     // 이미 넣은 필지
          ps.push({ j: p[0], c: [p[1], p[2]], r: rs });
        });
        if (ps.length > n0) ris.push(e.ri || e.li);
      }
      if (!ps.length) { hideLoading(); showToastMsg(dup ? '🗺 이 화면의 지적도는 이미 불러왔습니다' : '🗺 이 화면에 지적도 필지가 없습니다'); return; }
      var base = (ris.length > 2 ? ris.slice(0, 2).join('·') + ' 외' : ris.join('·')) + ' 지적도', name = base, names = itemNames();
      for (var k = 2; names.indexOf(name) >= 0; k++) name = base + ' ' + k;   // 지번이 이름으로 딸리므로 항목 이름은 겹치지 않게
      showLoading('🗺 ' + name + ' 그리는 중... (' + ps.length.toLocaleString() + '필지)');
      var file = new File([toKml(name, ps, q)], name + '.kml', { type: 'application/vnd.google-earth.kml+xml' });
      var v = viewSave();
      try { await loadKMZ(file); }
      finally { viewRestore(v); setTimeout(function () { viewRestore(v); }, 300); }
      try { autoSaveToDB(); } catch (er) {}
      console.log('[cad]', name, ps.length, '필지', '건너뜀', dup);
      showToastMsg('🗺 ' + name + ' — ' + ps.length.toLocaleString() + '필지' + (dup ? ' (이미 있는 ' + dup.toLocaleString() + '필지 건너뜀)' : ''));
    } catch (er) {
      hideLoading();
      console.warn('[cad] 실패', er);
      showToastMsg('🗺 지적도를 받지 못했습니다' + (navigator.onLine === false ? ' (인터넷 연결 없음)' : '') + ' — ' + (er && er.message || er));
    } finally { _busy = false; }
  };
})();
