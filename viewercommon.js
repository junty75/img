// viewercommon.js — KMZ 뷰어 두 판(index.html 카카오 · index_vworld.html 브이월드) 공통 함수
// 2026-11-23 두 html 에 글자 하나 다르지 않게 똑같이 있던 함수를 옮겨 왔다.
//  - 각 html 의 본문 인라인 스크립트 바로 앞에서 읽는다 → 본문이 로드 중에 불러도 된다.
//  - <head> 의 앞쪽 인라인 스크립트가 로드 중에 쓰는 함수는 html 에 남겼다:
//      _earlyBackHandler
//  - 두 판에 공통인 함수는 여기, 지도 종류를 가리지 않는 드라이브·저장 기능은 gdrive.js.
//  - 두 저장소(junty75/img, junty75/Vmap) 모두에 올리고, sw.js STATIC_ASSETS 에 들어 있어야 한다.

// ─── 검색 (카카오 주소/장소) ──────────────────────────
function showSearchMsg(msg) {
  const box = document.getElementById('searchResults');
  box.innerHTML = '';
  const d = document.createElement('div');
  d.className = 'sr-msg';
  d.textContent = msg;
  box.appendChild(d);
  box.classList.add('show');
}

function hideSearchResults() {
  document.getElementById('searchResults').classList.remove('show');
}

function searchQueries(q) {
  return SEARCH_TIERS.filter(t => !t.names.some(n => q.includes(n))).map(t => t.prefix + ' ' + q).concat([q]);
}

function searchTier(r) {
  const txt = r.region || ((r.title || '') + ' ' + (r.addr || ''));
  const i = SEARCH_TIERS.findIndex(t => t.names.some(n => txt.includes(n)));
  return i < 0 ? SEARCH_TIERS.length : i;
}

function renderSearchResults(list) {
  if (!list.length) { showSearchMsg('검색 결과가 없습니다'); return; }
  const box = document.getElementById('searchResults');
  box.innerHTML = '';
  list.forEach(r => {
    const item = document.createElement('div');
    item.className = 'sr-item';
    const t = document.createElement('div');
    t.className = 'sr-t';
    t.textContent = r.title;
    item.appendChild(t);
    if (r.addr) {
      const a = document.createElement('div');
      a.className = 'sr-a';
      a.textContent = r.addr;
      item.appendChild(a);
    }
    item.addEventListener('click', () => moveToSearchResult(r));
    box.appendChild(item);
  });
  box.classList.add('show');
}

function _histTopUp() {
  try { while (_histDepth < HIST_MAX) history.pushState({ k: ++_histDepth }, '', ''); } catch (_) {}
}

function _armExit() {
  if (_histDepth <= 0) return;
  _exitArmed = true;
  showToastMsg('뒤로가기를 한 번 더 누르면 종료됩니다');
  history.go(-_histDepth);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(ORIG_STORE)) db.createObjectStore(ORIG_STORE);
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function clearOrigs() {
  try { const db = await openDB(); db.transaction(ORIG_STORE, 'readwrite').objectStore(ORIG_STORE).clear(); } catch(e) {}
}

function _initTabChannel() {
  if (!('BroadcastChannel' in window)) return;
  try { _tabBC = new BroadcastChannel('jtymap-tabs:' + location.pathname); } catch (e) { return; }
  _tabBC.onmessage = ev => {
    if (!ev.data || ev.data.t !== 'takeover' || _tabClaimed) return;
    const p = ev.data.payload;
    try { window.close(); } catch (e) {}
    // 브라우저는 '스크립트가 연 탭'만 닫아준다. 직접 주소로 연 탭은 닫기가 거부돼 그대로
    // 남는데, 런처 창이 사라지면 브라우저가 그 탭으로 돌아가 '빈 지도'를 보여주는 일이
    // 생긴다. 그래서 닫히지 않았으면 같은 데이터를 이 탭에도 그린다(중복은 걸러짐).
    setTimeout(() => {
      if (!p) return;
      _tabClaimed = true;
      Promise.resolve(_loadHtmData(p)).then(() => autoSaveToDB()).catch(() => {});
    }, 400);
  };
}

function _claimSingleTab(payload) {
  _tabClaimed = true;   // 동시에 두 탭이 방송해도 서로 닫아버리지 않게
  if (_tabBC) { try { _tabBC.postMessage({ t: 'takeover', payload: payload || null }); } catch (e) {} }
}

function _updateDrawStyleBtn() {
  const el = document.querySelector('#drawStyleBtn .dsb-line');
  if (el) { el.style.background = currentDrawColor; el.style.height = Math.min(10, Math.max(3, currentDrawWidth)) + 'px'; }
}

function _spMarkSelected(color, width) {
  document.querySelectorAll('#spGrid .sp-swatch').forEach(b =>
    b.classList.toggle('sel', b.dataset.color.toUpperCase() === String(color || '').toUpperCase()));
  document.querySelectorAll('#spWidths .sp-w').forEach(b =>
    b.classList.toggle('sel', +b.dataset.width === +width));
}

function closeStylePicker() {
  document.getElementById('stylePicker').classList.remove('show');
  _styleTarget = null;
}

function updateUndoBtn() {
  document.getElementById('undoBtn')
    .classList.toggle('show', eraseMode && eraseHistory.length > 0);
}

// 삭제한 객체 묶음을 기록 (배열이 비면 기록하지 않음)
function pushEraseBatch(batch) {
  if (!batch.length) return;
  // 지운 사진 중 아직 드라이브에 안 올라간 것 — 업로드도 취소할지 묻는다 (되돌리기로 마커를 살려도 취소한 업로드는 안 돌아옴)
  if (window.gdPhotoDeleted) window.gdPhotoDeleted(batch.filter(it => it.kind === 'marker').map(it => it.obj));
  eraseHistory.push(batch);
  while (eraseHistory.length > ERASE_HISTORY_MAX) eraseHistory.shift();
  updateUndoBtn();
}

function showToastMsg(msg) {
  const el = document.getElementById('deleteHint');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function autoSaveToDB() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(_autoSaveNow, 400);
}

function showViewerAddr(ll) {
  const el = document.getElementById('viewerAddr');
  el.textContent = '';
  el._key = '';
  if (!ll || ll.lat == null || ll.lng == null) return;
  const key = ll.lat.toFixed(5) + ',' + ll.lng.toFixed(5);
  el._key = key;
  if (_viewerAddrs.has(key)) { el.textContent = _viewerAddrs.get(key); return; }
  lookupViewerAddr(ll.lat, ll.lng).then(t => {
    if (t) _viewerAddrs.set(key, t);
    if (el._key === key) el.textContent = t;   // 그새 다른 사진을 열었으면 안 넣음
  });
}

// ─── 위치 마커 HTML (방향 화살표) ─────────────────────
// 내 위치 마커 SVG — 보라색(설명=빨강·사진=파랑 원과 구분). 방향 있으면 내비 화살표, 없으면 흰 점 박힌 고리
function locMarkerSvg(heading) {
  const hasH = heading != null && !isNaN(heading) && heading >= 0;
  const body = hasH
    ? '<polygon points="20,4 31,32 20,26 9,32" fill="#8e24aa" stroke="white" stroke-width="2.5" stroke-linejoin="round"/>'
    : '<circle cx="20" cy="20" r="9" fill="#8e24aa" stroke="white" stroke-width="3"/><circle cx="20" cy="20" r="3" fill="white"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
    '<circle cx="20" cy="20" r="18" fill="rgba(142,36,170,0.18)" stroke="rgba(142,36,170,0.45)" stroke-width="1"/>' +
    body + '</svg>';
}

function _screenAngle() {
  try { if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle; } catch (e) {}
  return typeof window.orientation === 'number' ? window.orientation : 0;
}

function _headingFromEuler(a, b, g) {   // W3C ZXY 오일러각(alpha,beta,gamma) → 방위
  const r = Math.PI / 180;
  const sa = Math.sin(a * r), ca = Math.cos(a * r), sb = Math.sin(b * r), cb = Math.cos(b * r),
        sg = Math.sin(g * r), cg = Math.cos(g * r), s = _screenAngle() * r, ss = Math.sin(s), cs = Math.cos(s);
  // 기기 X(오른쪽)·Y(위쪽)·-Z(뒷면) 축의 동(E)·북(N)·위(U) 성분
  const xE = ca * cg - sa * sb * sg,  xN = sa * cg + ca * sb * sg,  xU = -cb * sg;
  const yE = -sa * cb,                yN = ca * cb,                 yU = sb;
  const zE = -ca * sg - sa * sb * cg, zN = -sa * sg + ca * sb * cg;
  // 화면 위쪽 = 화면 회전각만큼 돌린 기기 축. 세운 정도(w)만큼 뒷면 방향을 더한다
  // w 는 화면 위쪽이 '들렸을 때'만(2026-10-27). 예전 Math.abs 는 위쪽을 아래로 52° 넘게 숙이면
  // 뒷면 성분이 화면 위쪽 성분을 이겨 방향이 180° 뒤집혔다(시뮬레이션으로 확인).
  const uE = ss * xE + cs * yE, uN = ss * xN + cs * yN, w = Math.max(0, ss * xU + cs * yU);
  const E = uE + w * zE, N = uN + w * zN;
  if (Math.hypot(E, N) < 1e-6) return null;
  return (Math.atan2(E, N) * 180 / Math.PI + 360) % 360;
}

function _feedHeading(h) {
  if (h == null || !isFinite(h)) return;
  const x = Math.sin(h * Math.PI / 180), y = Math.cos(h * Math.PI / 180);
  if (_hdX === null) { _hdX = x; _hdY = y; }
  else { _hdX += (x - _hdX) * 0.2; _hdY += (y - _hdY) * 0.2; }   // 원형 평균(0°/360° 경계에서도 안 튐)
  deviceHeading = (Math.atan2(_hdX, _hdY) * 180 / Math.PI + 360) % 360;
}

function _angDiff(a, b) { if (a == null || b == null) return 360; const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

// ─── EXIF 메타 유틸 (piexif) ─────────────────────────
// XPTitle/XPComment 는 UTF-16LE 바이트 배열 (한글 안전 — 탐색기/데스크톱 뷰어와 동일 필드)
function _xpBytes(str) { const a = []; for (const ch of String(str)) { const c = ch.charCodeAt(0); a.push(c & 0xFF, (c >> 8) & 0xFF); } a.push(0, 0); return a; }

function _xpStr(bytes) { if (!bytes || !bytes.length) return ''; let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) { const c = bytes[i] | (bytes[i+1] << 8); if (!c) break; s += String.fromCharCode(c); } return s; }

function _gpsRat(v) { v = Math.abs(v); const d = Math.floor(v), mF = (v - d) * 60, m = Math.floor(mF), s = Math.round((mF - m) * 60 * 10000); return [[d,1],[m,1],[s,10000]]; }

function exifNow(d = new Date()) { const p = n => String(n).padStart(2,'0'); return `${d.getFullYear()}:${p(d.getMonth()+1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }

// piexif.dump() 출력의 TIFF 사양 위반을 표준 구조로 재조립:
//  - IFD 엔트리 태그 오름차순 정렬 (piexif 는 Exif/GPS 포인터를 맨 뒤에 붙여 미정렬 —
//    안드로이드 등 엄격한 파서는 정렬을 가정해 GPS 포인터를 못 찾을 수 있음)
//  - 모든 IFD 뒤에 next-IFD 오프셋 기록 (piexif 는 서브 IFD 종결자 누락 → 뒤 4바이트가
//    쓰레기 오프셋으로 읽혀 체인 파서가 EXIF 전체를 버림) — 폰 갤러리 위치 미인식의 원인
// 실패 시 원본 그대로 반환 (안전).
function _fixExif(exifStr) {
  try {
    if (exifStr.slice(0, 6) !== 'Exif\x00\x00') return exifStr;
    const t = exifStr.slice(6);
    const le = t.slice(0, 2) === 'II';
    if (!le && t.slice(0, 2) !== 'MM') return exifStr;
    const b = o => t.charCodeAt(o) & 0xFF;
    const u16 = o => le ? b(o) | (b(o+1) << 8) : (b(o) << 8) | b(o+1);
    const u32 = o => le ? (u16(o) | (u16(o+2) * 0x10000)) : (u16(o) * 0x10000 + u16(o+2));
    const SZ = { 1:1, 2:1, 3:2, 4:4, 5:8, 6:1, 7:1, 8:2, 9:4, 10:8, 11:4, 12:8 };
    const valU32 = s => { const c = i => s.charCodeAt(i) & 0xFF; return le ? c(0) + c(1)*0x100 + c(2)*0x10000 + c(3)*0x1000000 : c(0)*0x1000000 + c(1)*0x10000 + c(2)*0x100 + c(3); };

    function readIFD(off) {
      if (off <= 0 || off + 2 > t.length) return null;
      const n = u16(off), entries = [];
      if (off + 2 + 12*n > t.length) return null;
      for (let k = 0; k < n; k++) {
        const p = off + 2 + 12*k, tag = u16(p), typ = u16(p+2), cnt = u32(p+4);
        if (!SZ[typ]) continue;
        const size = SZ[typ] * cnt;
        let val;
        if (size <= 4) val = t.slice(p+8, p+12);
        else { const vo = u32(p+8); if (vo + size > t.length) continue; val = t.slice(vo, vo + size); }
        entries.push({ tag, typ, cnt, val });
      }
      const nx = off + 2 + 12*n + 4 <= t.length ? u32(off + 2 + 12*n) : 0;
      return { entries, next: nx };
    }
    const take = (list, tag) => { const i = list.findIndex(e => e.tag === tag); return i < 0 ? null : list.splice(i, 1)[0]; };

    const ifd0 = readIFD(u32(4));
    if (!ifd0) return exifStr;
    const pExif = take(ifd0.entries, 0x8769), pGPS = take(ifd0.entries, 0x8825);
    const exifIFD = pExif ? readIFD(valU32(pExif.val)) : null;
    let interopIFD = null;
    if (exifIFD) { const pI = take(exifIFD.entries, 0xA005); interopIFD = pI ? readIFD(valU32(pI.val)) : null; }
    const gpsIFD = pGPS ? readIFD(valU32(pGPS.val)) : null;
    let ifd1 = ifd0.next ? readIFD(ifd0.next) : null, thumb = '';
    if (ifd1) {
      const pT = take(ifd1.entries, 0x0201), pL = take(ifd1.entries, 0x0202);
      if (pT && pL) {
        const to = valU32(pT.val), tl = valU32(pL.val);
        if (to + tl <= t.length) thumb = t.slice(to, to + tl);
      }
      if (!thumb) ifd1 = null;   // 썸네일 없는 IFD1 은 버림
    }

    // ── 재조립 ──
    const chr = String.fromCharCode;
    const p16 = v => le ? chr(v & 255) + chr((v >> 8) & 255) : chr((v >> 8) & 255) + chr(v & 255);
    const p32 = v => le ? p16(v & 0xFFFF) + p16((v / 0x10000) & 0xFFFF) : p16((v / 0x10000) & 0xFFFF) + p16(v & 0xFFFF);
    function prep(ifd) {   // 정렬 + 중복 제거 + 크기 계산
      const seen = {};
      ifd.entries = ifd.entries.filter(e => seen[e.tag] ? false : (seen[e.tag] = 1)).sort((a, b) => a.tag - b.tag);
      ifd.valSize = ifd.entries.reduce((s, e) => s + (e.val.length > 4 ? e.val.length + (e.val.length & 1) : 0), 0);
      ifd.tblSize = 2 + 12 * ifd.entries.length + 4;
      return ifd;
    }
    function serIFD(ifd, tblOff, next) {
      let vo = tblOff + ifd.tblSize, tbl = p16(ifd.entries.length), vals = '';
      for (const e of ifd.entries) {
        tbl += p16(e.tag) + p16(e.typ) + p32(e.cnt);
        if (e.val.length <= 4) tbl += (e.val + '\x00\x00\x00\x00').slice(0, 4);
        else { tbl += p32(vo); vals += e.val + (e.val.length & 1 ? '\x00' : ''); vo += e.val.length + (e.val.length & 1); }
      }
      return tbl + p32(next) + vals;
    }

    const mkPtr = tag => ({ tag, typ: 4, cnt: 1, val: '\x00\x00\x00\x00' });
    if (exifIFD) ifd0.entries.push(mkPtr(0x8769));
    if (gpsIFD) ifd0.entries.push(mkPtr(0x8825));
    if (exifIFD && interopIFD) exifIFD.entries.push(mkPtr(0xA005));
    if (ifd1) { ifd1.entries.push(mkPtr(0x0201)); ifd1.entries.push({ tag: 0x0202, typ: 4, cnt: 1, val: p32(thumb.length) }); }

    [ifd0, exifIFD, interopIFD, gpsIFD, ifd1].forEach(f => f && prep(f));

    // 순차 배치: IFD0 → Exif → Interop → GPS → IFD1 → 썸네일
    let cur = 8 + ifd0.tblSize + ifd0.valSize;
    const at = {};
    if (exifIFD) { at.exif = cur; cur += exifIFD.tblSize + exifIFD.valSize; }
    if (interopIFD) { at.interop = cur; cur += interopIFD.tblSize + interopIFD.valSize; }
    if (gpsIFD) { at.gps = cur; cur += gpsIFD.tblSize + gpsIFD.valSize; }
    if (ifd1) { at.ifd1 = cur; cur += ifd1.tblSize + ifd1.valSize; at.thumb = cur; }

    const setPtr = (ifd, tag, v) => { const e = ifd.entries.find(x => x.tag === tag); if (e) e.val = p32(v); };
    setPtr(ifd0, 0x8769, at.exif || 0); setPtr(ifd0, 0x8825, at.gps || 0);
    if (exifIFD) setPtr(exifIFD, 0xA005, at.interop || 0);
    if (ifd1) setPtr(ifd1, 0x0201, at.thumb || 0);

    let out = (le ? 'II' : 'MM') + p16(42) + p32(8);
    out += serIFD(ifd0, 8, at.ifd1 || 0);
    if (exifIFD) out += serIFD(exifIFD, at.exif, 0);
    if (interopIFD) out += serIFD(interopIFD, at.interop, 0);
    if (gpsIFD) out += serIFD(gpsIFD, at.gps, 0);
    if (ifd1) out += serIFD(ifd1, at.ifd1, 0) + thumb;
    return 'Exif\x00\x00' + out;
  } catch (e) { console.warn('EXIF 정규화 실패', e); return exifStr; }
}

// EXIF 를 통째로 재직렬화(dump)하다 실패하면(일부 폰 MakerNote 등)
// 핵심 필드(날짜·GPS·제목·설명)만이라도 옮겨서 기록한다 — 실패 시 메타가 통째로 사라지던 문제 방지.
function _exifSafeCarry(exif, jpegDataUrl) {
  try { return piexif.insert(_fixExif(piexif.dump(exif)), jpegDataUrl); }
  catch(e) {
    try {
      const fresh = { '0th':{}, 'Exif':{}, 'GPS':{}, '1st':{}, 'thumbnail':null };
      const o = exif['0th'] || {}, x = exif['Exif'] || {}, g = exif['GPS'] || {};
      const dt = x[piexif.ExifIFD.DateTimeOriginal] || o[piexif.ImageIFD.DateTime];
      if (dt) { fresh['Exif'][piexif.ExifIFD.DateTimeOriginal] = dt; fresh['0th'][piexif.ImageIFD.DateTime] = dt; }
      if (g[piexif.GPSIFD.GPSLatitude]) {
        fresh['GPS'][piexif.GPSIFD.GPSVersionID]    = g[piexif.GPSIFD.GPSVersionID]    || [2, 3, 0, 0];
        fresh['GPS'][piexif.GPSIFD.GPSLatitudeRef]  = g[piexif.GPSIFD.GPSLatitudeRef]  || 'N';
        fresh['GPS'][piexif.GPSIFD.GPSLatitude]     = g[piexif.GPSIFD.GPSLatitude];
        fresh['GPS'][piexif.GPSIFD.GPSLongitudeRef] = g[piexif.GPSIFD.GPSLongitudeRef] || 'E';
        fresh['GPS'][piexif.GPSIFD.GPSLongitude]    = g[piexif.GPSIFD.GPSLongitude];
      }
      if (o[piexif.ImageIFD.XPTitle])   fresh['0th'][piexif.ImageIFD.XPTitle]   = o[piexif.ImageIFD.XPTitle];
      if (o[piexif.ImageIFD.XPComment]) fresh['0th'][piexif.ImageIFD.XPComment] = o[piexif.ImageIFD.XPComment];
      if (o[piexif.ImageIFD.ImageDescription]) fresh['0th'][piexif.ImageIFD.ImageDescription] = o[piexif.ImageIFD.ImageDescription];
      return piexif.insert(_fixExif(piexif.dump(fresh)), jpegDataUrl);
    } catch(e2) { console.warn('EXIF 기록 실패', e2); return jpegDataUrl; }
  }
}

// 사진 dataURL 에서 제목/설명/촬영일시/GPS 읽기
function readPhotoMeta(imgSrc) {
  const out = { title:'', desc:'', taken:'', lat:null, lng:null };
  try {
    const ex = piexif.load(imgSrc);
    out.title = _xpStr(ex['0th'][piexif.ImageIFD.XPTitle]);
    out.desc  = _xpStr(ex['0th'][piexif.ImageIFD.XPComment]);
    out.taken = (ex['Exif'] && ex['Exif'][piexif.ExifIFD.DateTimeOriginal]) || ex['0th'][piexif.ImageIFD.DateTime] || '';
    const gps = ex['GPS'];
    if (gps && gps[piexif.GPSIFD.GPSLatitude] && gps[piexif.GPSIFD.GPSLongitude]) {
      const toDec = (dms, ref) => { const d = dms[0][0]/dms[0][1], m = dms[1][0]/dms[1][1], s = dms[2][0]/dms[2][1]; return (d + m/60 + s/3600) * ((ref === 'S' || ref === 'W') ? -1 : 1); };
      const la = toDec(gps[piexif.GPSIFD.GPSLatitude],  gps[piexif.GPSIFD.GPSLatitudeRef]  || 'N');
      const lo = toDec(gps[piexif.GPSIFD.GPSLongitude], gps[piexif.GPSIFD.GPSLongitudeRef] || 'E');
      if (!isNaN(la) && !isNaN(lo) && (la !== 0 || lo !== 0)) { out.lat = la; out.lng = lo; }
    }
  } catch(e) {}
  return out;
}

// ─── EXIF 읽기 폴백 (exifr) ──────────────────────────
// piexif 는 JPEG 의 APP1 을 자체 파서로 훑기 때문에, 아래 경우 GPS 를 통째로 놓친다.
// 다른 사진앱들은 잘 읽는데 이 뷰어만 못 읽던 원인:
//   · 삼성/아이폰의 큰 MakerNote·다중 APP1 → piexif.load 가 예외 → catch(e){} 로 조용히 삼켜짐
//   · HEIC/HEIF (아이폰 기본), PNG, WebP → piexif 는 JPEG 전용이라 아예 못 읽음
//   · 위치가 EXIF 가 아니라 XMP 에 들어 있는 사진
// exifr 은 원본 File/Blob 을 청크 단위로 직접 읽어 위 경우를 모두 처리한다.
// (스크립트는 예전부터 로드돼 있었지만 실제로 호출하는 곳이 없었다 — 2026-08-11 연결)
async function readPhotoMetaFallback(file) {
  const out = { taken:'', lat:null, lng:null, diag:'' };
  if (!file) { out.diag = '파일 없음'; return out; }
  if (!window.exifr) { out.diag = 'exifr 미로드 — CDN 차단/오프라인'; return out; }
  let ex = null;
  try {
    try { ex = await exifr.parse(file, { tiff:true, ifd0:true, exif:true, gps:true, xmp:true }); } catch(e) {}
    let la = ex && ex.latitude, lo = ex && ex.longitude;
    if (la == null || lo == null) {                       // gps() 는 더 관대한 경로 — 한 번 더 시도
      try { const g = await exifr.gps(file); if (g) { la = g.latitude; lo = g.longitude; } } catch(e) {}
    }
    if (typeof la === 'number' && typeof lo === 'number' &&
        !isNaN(la) && !isNaN(lo) && (la !== 0 || lo !== 0)) { out.lat = la; out.lng = lo; }
    const d = ex && (ex.DateTimeOriginal || ex.CreateDate || ex.ModifyDate);
    if (d instanceof Date && !isNaN(d)) out.taken = exifNow(d);
    else if (typeof d === 'string') out.taken = d;
  } catch(e) { console.warn('exifr 폴백 실패', e); }
  out.diag = out.lat != null ? 'GPS 읽음'
    : (!ex || Object.keys(ex).length === 0)
      ? 'EXIF 자체가 없음 — 사진이 재저장(스크린샷·메신저 경유 등)된 파일'
      : 'EXIF 는 있는데 GPS 만 없음 — 안드로이드가 넘겨줄 때 위치를 지운 것.\n고르는 창에서 다른 파일 앱(예: 「파일관리자」)으로 사진을 고르세요.\n(「사진 및 동영상」·갤러리·「내 파일」은 위치가 지워짐)';
  return out;
}

// GPS/촬영일시 등을 JPEG dataURL 의 EXIF 에 기록 (전달 안 한 항목은 유지)
function writePhotoMeta(imgSrc, { title, desc, lat, lng, taken } = {}) {
  try {
    let ex; try { ex = piexif.load(imgSrc); } catch(e) { ex = { '0th':{}, 'Exif':{}, 'GPS':{}, '1st':{}, 'thumbnail':null }; }
    ex['0th'] = ex['0th'] || {}; ex['Exif'] = ex['Exif'] || {}; ex['GPS'] = ex['GPS'] || {};
    if (title != null) {
      ex['0th'][piexif.ImageIFD.XPTitle] = _xpBytes(title);
      // ImageDescription 은 ASCII 필드 — 한글이면 기록 안 함 (외부 뷰어 인코딩 깨짐 방지)
      if (/^[\x00-\x7F]*$/.test(title)) ex['0th'][piexif.ImageIFD.ImageDescription] = title;
      else delete ex['0th'][piexif.ImageIFD.ImageDescription];
    }
    if (desc != null) ex['0th'][piexif.ImageIFD.XPComment] = _xpBytes(desc);
    if (taken) { ex['Exif'][piexif.ExifIFD.DateTimeOriginal] = taken; ex['0th'][piexif.ImageIFD.DateTime] = taken; }
    // 카메라 파일과 유사하게 기본 태그 보강 (없을 때만)
    ex['0th'][piexif.ImageIFD.Orientation] = ex['0th'][piexif.ImageIFD.Orientation] || 1;
    ex['Exif'][piexif.ExifIFD.ExifVersion] = ex['Exif'][piexif.ExifIFD.ExifVersion] || '0231';
    if (lat != null && lng != null) {
      // 카메라 앱과 동일한 GPS 블록 구성 (VersionID·고도·날짜/시간스탬프 포함)
      ex['GPS'][piexif.GPSIFD.GPSVersionID]    = ex['GPS'][piexif.GPSIFD.GPSVersionID] || [2, 3, 0, 0];
      ex['GPS'][piexif.GPSIFD.GPSLatitudeRef]  = lat >= 0 ? 'N' : 'S';
      ex['GPS'][piexif.GPSIFD.GPSLatitude]     = _gpsRat(lat);
      ex['GPS'][piexif.GPSIFD.GPSLongitudeRef] = lng >= 0 ? 'E' : 'W';
      ex['GPS'][piexif.GPSIFD.GPSLongitude]    = _gpsRat(lng);
      ex['GPS'][piexif.GPSIFD.GPSAltitudeRef]  = ex['GPS'][piexif.GPSIFD.GPSAltitudeRef] || 0;
      ex['GPS'][piexif.GPSIFD.GPSAltitude]     = ex['GPS'][piexif.GPSIFD.GPSAltitude] || [0, 1];
      const _ts = taken || ex['Exif'][piexif.ExifIFD.DateTimeOriginal] || exifNow();
      const _md = String(_ts).match(/^(\d{4}:\d{2}:\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (_md && !ex['GPS'][piexif.GPSIFD.GPSDateStamp]) {
        ex['GPS'][piexif.GPSIFD.GPSDateStamp] = _md[1];
        ex['GPS'][piexif.GPSIFD.GPSTimeStamp] = [[+_md[2], 1], [+_md[3], 1], [+_md[4], 1]];
      }
    }
    return _exifSafeCarry(ex, imgSrc);
  } catch(e) { console.warn('EXIF 기록 실패', e); return imgSrc; }
}

// JFIF(APP0) 세그먼트 제거 — 카메라 파일과 동일한 'SOI + APP1' 구조로 정리
function _stripApp0(u8) {
  try {
    if (u8[0] !== 0xFF || u8[1] !== 0xD8) return u8;
    let i = 2, app0 = null, hasExif = false;
    while (i + 3 < u8.length && u8[i] === 0xFF) {
      const m = u8[i + 1];
      if (m === 0xDA) break;
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (m === 0xE0) app0 = [i, i + 2 + len];
      if (m === 0xE1 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78) hasExif = true;   // 'Ex'if
      i += 2 + len;
    }
    if (app0 && hasExif) {
      const o = new Uint8Array(u8.length - (app0[1] - app0[0]));
      o.set(u8.subarray(0, app0[0]), 0);
      o.set(u8.subarray(app0[1]), app0[0]);
      return o;
    }
  } catch(e) {}
  return u8;
}

// 사진을 기기에 저장 (안드로이드: 다운로드 폴더 → 갤러리에 표시됨)
// data: URL 은 용량이 크면 안드로이드 크롬에서 다운로드가 '조용히' 실패 → Blob 으로 변환해 저장.
// 바이트 변환은 fetch(dataURL) 네이티브 경로 사용 — 수백만 회 charCodeAt 루프가
// 메인 스레드를 1~2초 막아 지도가 하얗게 멈추던 원인이었음.
async function downloadPhoto(imgSrc, name) {
  const nm0 = (name || 'photo').replace(/[\\/:*?"<>|]/g, '_');
  const nm = /\.jpe?g$/i.test(nm0) ? nm0 : nm0 + '.jpg';
  let href = imgSrc, revoke = null;
  try {
    const blob = await (await fetch(imgSrc)).blob();
    const mime = blob.type || 'image/jpeg';
    let u8 = new Uint8Array(await blob.arrayBuffer());
    if (/jpe?g$/i.test(mime)) u8 = _stripApp0(u8);
    href = URL.createObjectURL(new Blob([u8], { type: mime }));
    revoke = href;
  } catch(e) {}
  const a = document.createElement('a');
  a.href = href; a.download = nm;
  document.body.appendChild(a); a.click(); a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 10000);
}

// ─── 저장(KMZ 내보내기) ───────────────────────────────
// ─── 저장 범위 선택 (현재영역/전체영역) ───────────────
function askSaveScope() {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9000;display:flex;align-items:center;justify-content:center;';
    const btnCss = 'display:block;width:100%;padding:12px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px;';
    bg.innerHTML =
      '<div style="background:white;border-radius:14px;padding:20px;width:270px;box-shadow:0 4px 24px rgba(0,0,0,0.25);">' +
      '<h3 style="margin:0 0 14px;font-size:15px;color:#333;text-align:center;">저장 범위 선택</h3>' +
      `<button data-scope="view" style="${btnCss}background:#1a73e8;color:white;">📺 현재영역<br><span style="font-size:11px;font-weight:400;">화면에 보이는 객체만</span></button>` +
      `<button data-scope="all" style="${btnCss}background:#00897b;color:white;">🌍 전체영역<br><span style="font-size:11px;font-weight:400;">모든 객체</span></button>` +
      `<button data-scope="" style="${btnCss}background:#f1f3f4;color:#555;margin-bottom:0;">취소</button>` +
      '</div>';
    bg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b && e.target !== bg) return;   // 박스 안 여백 클릭은 무시
      bg.remove();
      resolve(b ? (b.dataset.scope || null) : null);
    });
    document.body.appendChild(bg);
  });
}

function _getImgWorker() {
  if (_imgWorker !== null) return _imgWorker;
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined' || typeof Worker === 'undefined') { _imgWorker = false; return false; }
    _imgWorker = new Worker(URL.createObjectURL(new Blob([_imgWorkerCode], { type: 'text/javascript' })));
    _imgWorker.onmessage = e => { const j = _imgJobs.get(e.data.id); if (j) { _imgJobs.delete(e.data.id); j(e.data); } };
    _imgWorker.onerror = () => { _imgJobs.forEach(j => j({ ok: false })); _imgJobs.clear(); };
  } catch(e) { _imgWorker = false; }
  return _imgWorker;
}

// 파일을 워커에서 압축해 JPEG dataURL 로 반환. 실패/미지원이면 null (호출측이 원본 사용).
function compressFileInWorker(file) {
  return new Promise(resolve => {
    const w = _getImgWorker();
    if (!w) return resolve(null);
    const id = ++_imgJobId;
    const to = setTimeout(() => { _imgJobs.delete(id); resolve(null); }, 20000);
    _imgJobs.set(id, d => {
      clearTimeout(to);
      if (!d.ok || !d.buf) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(new Blob([d.buf], { type: 'image/jpeg' }));
    });
    try { w.postMessage({ id, file, max: 1920, target: COMPRESS_TARGET - EXIF_MARGIN }); }
    catch(e) { clearTimeout(to); _imgJobs.delete(id); resolve(null); }
  });
}

// JPEG 인코딩을 toBlob(비동기)으로 — toDataURL 은 메인 스레드를 수백 ms 씩 막아
// 사진 불러올 때 지도가 하얗게 멈추는 원인이었음. 실패 시 toDataURL 폴백.
function _canvasJpeg(cv, q) {
  return new Promise(res => {
    if (!cv.toBlob) return res(cv.toDataURL('image/jpeg', q));
    cv.toBlob(b => {
      if (!b) return res(cv.toDataURL('image/jpeg', q));
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => res(cv.toDataURL('image/jpeg', q));
      fr.readAsDataURL(b);
    }, 'image/jpeg', q);
  });
}

// ─── KMZ 불러오기 ─────────────────────────────────────
// ─── HTM 불러오기 (KMZ → HTM 변환 뷰어 파일) ──────────
// 파일 안의 var LINES / POLYS / TEXTS / MARKERS / PHOTOS 배열을 그대로 읽어 옴.
// 좌표는 [lat, lng] 순서, 색은 #RRGGBB, 사진은 data:URL.
function _htmArr(text, name) {
  // 각 배열은 한 줄에 하나씩 기록돼 있음 → 개행을 안 넘는 greedy 매칭이 안전
  const m = text.match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\[.*\\])\\s*;'));
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch(e) { return []; }
}

function _isHtmFile(f) { return /\.html?$/i.test(f.name); }

function _ptKey(kind, name) { return kind + '|' + (name == null ? '' : name); }

function _hasPt(store, kind, lat, lng, name) {
  const a = store.pts.get(_ptKey(kind, name));
  if (!a) return false;
  for (const p of a) if (Math.abs(p[0] - lat) < _PT_EPS && Math.abs(p[1] - lng) < _PT_EPS) return true;
  return false;
}

function _addPt(store, kind, lat, lng, name) {
  const k = _ptKey(kind, name);
  const a = store.pts.get(k);
  if (a) a.push([lat, lng]); else store.pts.set(k, [[lat, lng]]);
}

async function loadHTM(file) {
  showLoading('HTM 읽는 중...');
  let D;
  try {
    const text = await file.text();
    D = { LINES:  _htmArr(text, 'LINES'),  POLYS:   _htmArr(text, 'POLYS'),
          TEXTS:  _htmArr(text, 'TEXTS'),  MARKERS: _htmArr(text, 'MARKERS'),
          PHOTOS: _htmArr(text, 'PHOTOS') };
  } catch (err) { hideLoading(); alert('HTM 오류: ' + err.message); return; }
  return _loadHtmData(D);
}
