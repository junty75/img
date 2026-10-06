// gdrive.js — 구글 드라이브 연동 + 지도 저장(미리 받기·저장 공간). index.html(카카오)·index_vworld.html(브이월드) 공통.
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
    '#gdCamBtn{top:184px;right:72px;padding:0;font-size:22px;}' +
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
        '<div class="sec"><b>지도 저장</b> <span style="color:#888;font-size:12px;">(데이터 절약 · 신호 없는 곳에서도 보기)</span>' +
          '<div id="gdTileInfo" style="margin-top:4px;">저장된 지도 확인 중...</div>' +
          '<div style="margin-top:6px;">지금 화면을 <select id="gdPreLv" style="font-size:14px;padding:5px;border-radius:6px;">' +
            '<option value="1">1단계 더 확대까지 (4화면)</option>' +
            '<option value="2" selected>2단계 더 확대까지 (20화면)</option>' +
            '<option value="3">3단계 더 확대까지 (84화면)</option></select></div>' +
          '<div class="btns"><button class="pri" id="gdPre">지금 화면 지도 미리 받기</button><button id="gdTileClr">저장된 지도 비우기</button></div>' +
          '<div style="color:#888;font-size:12px;">와이파이에서 받으세요. 받는 동안 지도가 저절로 움직이고, 끝나면 원래 화면으로 돌아옵니다. ' +
            '최대 8000장까지 저장하고, 넘으면 먼저 저장된 것부터 지웁니다.</div>' +
        '</div>' +
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
      tileCount().then(function (n) { var el = $('gdTileInfo'); if (el) el.textContent = tileInfoText(n); });
      $('gdPre').onclick = function () { preloadTiles(+$('gdPreLv').value); };
      $('gdTileClr').onclick = function () { clearTiles(showSetup); };
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
})();
