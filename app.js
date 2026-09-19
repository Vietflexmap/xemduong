const $ = (id) => document.getElementById(id);
const number0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });

const state = {
  config: { ...(window.VIETFLEX_CONFIG || {}) },
  position: { lat: 10.2411753, lng: 106.374835 },
  zoom: 16,
  heading: 90,
  mapType: 'roadmap',
  adminUnits: [],
  provinces: [],
  visibleUnits: [],
  selectedUnit: null,
  mapInteraction: null,
  syncTimer: 0
};

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  bindUI();
  setRuntimeStatus('Đang khởi tạo Google Street View + Google Map…', 'loading');

  if (state.config.defaultCenter) {
    state.position = toLiteral(state.config.defaultCenter) || state.position;
  }
  state.zoom = Number(state.config.defaultZoom || state.zoom);

  try {
    await loadAdminData();
    renderAdminSummary(
      'ready',
      `${number0.format(state.adminUnits.length)} đơn vị đã sẵn sàng`,
      'Nguồn dữ liệu hành chính Vietflex · sapnhap'
    );
    renderAdminList();
  } catch (error) {
    renderAdminSummary('error', 'Không tải được dữ liệu hành chính', 'Google Map và Street View vẫn hoạt động');
    renderAdminError(error);
  }

  renderGooglePair({ street: true, map: true });
  installMapSyncLayer();
  updateMapModeUI();
  setRuntimeStatus('Google Street View và Google Map đang đồng bộ', 'ready');
}

async function loadAdminData() {
  const endpoints = [];
  if (state.config.adminDataUrl) endpoints.push(state.config.adminDataUrl);
  endpoints.push('./data/admin.json');

  let lastError = new Error('Không có nguồn dữ liệu hành chính khả dụng.');
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: { Accept: 'application/json' },
        cache: 'force-cache'
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      normalizeAdminPayload(payload);
      if (state.adminUnits.length) return;
    } catch (error) {
      lastError = new Error(`${endpoint}: ${error.message}`);
    }
  }
  throw lastError;
}

function normalizeAdminPayload(payload) {
  const rawUnits = Array.isArray(payload?.units) ? payload.units
    : Array.isArray(payload?.items) ? payload.items
      : Array.isArray(payload?.records) ? payload.records : [];
  const rawProvinces = Array.isArray(payload?.provinces) ? payload.provinces : [];

  state.provinces = rawProvinces.map((province, index) => ({
    ...province,
    id: province.id || `province-${index}`,
    name: province.name || province.full_name || '',
    full_name: province.full_name || province.name || '',
    order: Number(province.order || index + 1)
  })).filter((item) => item.name).sort((a, b) => a.order - b.order);

  state.adminUnits = rawUnits.map((unit, index) => {
    const fullName = unit.full_name || unit.name || '';
    const type = normalizeType(unit.type || fullName);
    const shortName = unit.name || fullName.replace(/^(Phường|Xã|Đặc khu)\s+/i, '');
    const province = unit.province_name || unit.province_full_name || unit.province || '';
    return {
      ...unit,
      id: unit.id || `unit-${unit.code || index}`,
      name: shortName,
      full_name: fullName || `${type} ${shortName}`,
      type,
      code: unit.code == null ? '' : String(unit.code),
      province_name: province,
      province_full_name: unit.province_full_name || province,
      lat: numberOrNull(unit.centroid_lat ?? unit.lat ?? unit.latitude),
      lng: numberOrNull(unit.centroid_lon ?? unit.lng ?? unit.longitude)
    };
  }).filter((item) => item.name || item.full_name);

  if (!state.provinces.length) {
    const names = [...new Set(state.adminUnits.map((item) => item.province_name).filter(Boolean))];
    state.provinces = names.map((name, index) => ({
      id: `province-${index}`,
      name,
      full_name: name,
      order: index + 1
    }));
  }
  populateProvinceFilter();
}

function populateProvinceFilter() {
  const select = $('provinceFilter');
  if (!select) return;
  select.innerHTML = '<option value="">Tất cả 34 tỉnh/thành</option>';
  state.provinces.forEach((province) => {
    const option = document.createElement('option');
    option.value = province.name;
    option.textContent = province.name;
    select.appendChild(option);
  });
}

function bindUI() {
  $('drawerToggle')?.addEventListener('click', () => toggleDrawer());
  $('drawerClose')?.addEventListener('click', () => toggleDrawer(false));

  $('adminSearch')?.addEventListener('input', renderAdminList);
  $('adminSearchClear')?.addEventListener('click', () => {
    $('adminSearch').value = '';
    renderAdminList();
    $('adminSearch').focus();
  });
  $('provinceFilter')?.addEventListener('change', renderAdminList);
  $('typeFilter')?.addEventListener('change', renderAdminList);

  $('locateButton')?.addEventListener('click', locateUser);
  $('resetPanoButton')?.addEventListener('click', () => renderStreetViewIframe());
  $('openStreetButton')?.addEventListener('click', openGoogleStreetView);
  $('fullscreenPanoButton')?.addEventListener('click', () => toggleFullscreen($('panoPanel')));

  $('earthModeButton')?.addEventListener('click', toggleMapType);
  $('mapTypeButton')?.addEventListener('click', toggleMapType);
  $('openEarthButton')?.addEventListener('click', openInGoogleEarth);
  $('zoomInButton')?.addEventListener('click', () => changeZoom(1));
  $('zoomOutButton')?.addEventListener('click', () => changeZoom(-1));

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('workspace')?.classList.contains('drawer-open')) {
      toggleDrawer(false);
    }
  });
}

function buildStreetViewUrl() {
  const { lat, lng } = state.position;
  return `https://maps.google.com/maps?layer=c&cbll=${lat.toFixed(7)},${lng.toFixed(7)}&cbp=12,${state.heading},0,0,5&hl=vi&source=embed&output=svembed`;
}

function buildGoogleMapUrl() {
  const { lat, lng } = state.position;
  const type = state.mapType === 'satellite' ? 'k' : 'm';
  return `https://maps.google.com/maps?ll=${lat.toFixed(7)},${lng.toFixed(7)}&z=${state.zoom}&t=${type}&hl=vi&output=embed`;
}

function renderGooglePair({ street = true, map = true } = {}) {
  if (street) renderStreetViewIframe();
  if (map) renderGoogleMapIframe();
  updatePositionUI(state.position);
}

function renderStreetViewIframe() {
  const host = $('pano');
  if (!host) return;

  const loading = $('panoLoading');
  if (loading) {
    loading.classList.remove('hidden');
    loading.innerHTML = '<span class="loading-ring"></span><strong>Đang tải Google Street View</strong><small>Đồng bộ theo tâm Google Map phía dưới</small>';
  }

  const frame = document.createElement('iframe');
  frame.id = 'streetViewFrame';
  frame.className = 'google-embed-frame';
  frame.title = 'Google Street View';
  frame.src = buildStreetViewUrl();
  frame.allowFullscreen = true;
  frame.loading = 'eager';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.setAttribute('allow', 'fullscreen; geolocation');

  frame.addEventListener('load', () => {
    loading?.classList.add('hidden');
    setCoverage('ready', 'Street View đồng bộ');
  }, { once: true });

  host.replaceChildren(frame);
  if ($('panoAddress')) {
    $('panoAddress').textContent = `${state.position.lat.toFixed(6)}, ${state.position.lng.toFixed(6)}`;
  }
  window.setTimeout(() => loading?.classList.add('hidden'), 4200);
}

function renderGoogleMapIframe() {
  const host = $('earthMap');
  if (!host) return;

  const frame = document.createElement('iframe');
  frame.id = 'googleMapFrame';
  frame.className = 'google-embed-frame';
  frame.title = state.mapType === 'satellite' ? 'Google Satellite / Earth' : 'Google Map';
  frame.src = buildGoogleMapUrl();
  frame.loading = 'eager';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.setAttribute('allow', 'geolocation; fullscreen');
  host.replaceChildren(frame);

  updateMapModeUI();
}

function installMapSyncLayer() {
  const viewport = $('earthViewport');
  if (!viewport) return;

  viewport.querySelector('#mapSyncLayer')?.remove();
  const layer = document.createElement('div');
  layer.id = 'mapSyncLayer';
  layer.className = 'map-sync-layer';
  layer.title = 'Kéo hoặc chạm để đổi vị trí và đồng bộ Street View';

  const hint = document.createElement('div');
  hint.className = 'map-sync-badge';
  hint.innerHTML = '<span>SYNC</span> Kéo/chạm để đổi điểm';
  layer.appendChild(hint);

  viewport.appendChild(layer);

  let gesture = null;

  layer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    layer.setPointerCapture?.(event.pointerId);
    gesture = {
      x: event.clientX,
      y: event.clientY,
      start: { ...state.position },
      moved: false
    };
    layer.classList.add('dragging');
    $('reticleGuide')?.classList.add('dragging');
  });

  layer.addEventListener('pointermove', (event) => {
    if (!gesture) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (Math.hypot(dx, dy) > 4) gesture.moved = true;
  });

  const finish = (event) => {
    if (!gesture) return;
    const rect = layer.getBoundingClientRect();
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;

    if (gesture.moved) {
      const next = panLatLngByPixels(gesture.start, -dx, -dy, state.zoom);
      setPosition(next, { syncStreet: true, syncMap: true });
    } else {
      const offsetX = event.clientX - (rect.left + rect.width / 2);
      const offsetY = event.clientY - (rect.top + rect.height / 2);
      const next = panLatLngByPixels(state.position, offsetX, offsetY, state.zoom);
      setPosition(next, { syncStreet: true, syncMap: true });
    }

    gesture = null;
    layer.classList.remove('dragging');
    $('reticleGuide')?.classList.remove('dragging');
  };

  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', () => {
    gesture = null;
    layer.classList.remove('dragging');
    $('reticleGuide')?.classList.remove('dragging');
  });

  layer.addEventListener('dblclick', (event) => {
    event.preventDefault();
    changeZoom(1);
  });

  layer.addEventListener('wheel', (event) => {
    event.preventDefault();
    changeZoom(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  state.mapInteraction = layer;
}

function panLatLngByPixels(position, dx, dy, zoom) {
  const worldSize = 256 * Math.pow(2, zoom);
  const p = latLngToWorld(position.lat, position.lng, worldSize);
  return worldToLatLng(p.x + dx, p.y + dy, worldSize);
}

function latLngToWorld(lat, lng, worldSize) {
  const sin = Math.sin(lat * Math.PI / 180);
  const x = (lng + 180) / 360 * worldSize;
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize;
  return { x, y };
}

function worldToLatLng(x, y, worldSize) {
  const lng = x / worldSize * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y / worldSize;
  const lat = 180 / Math.PI * Math.atan(Math.sinh(n));
  return {
    lat: Math.max(-85.05112878, Math.min(85.05112878, lat)),
    lng: normalizeLng(lng)
  };
}

function normalizeLng(lng) {
  return ((lng + 540) % 360) - 180;
}

function setPosition(position, { syncStreet = true, syncMap = true } = {}) {
  const literal = toLiteral(position);
  if (!literal) return;

  state.position = literal;
  updatePositionUI(literal);

  window.clearTimeout(state.syncTimer);
  state.syncTimer = window.setTimeout(() => {
    if (syncStreet) renderStreetViewIframe();
    if (syncMap) renderGoogleMapIframe();
    setRuntimeStatus('Google Street View và Google Map đã đồng bộ tọa độ', 'ready');
  }, 90);
}

function changeZoom(delta) {
  state.zoom = Math.max(3, Math.min(20, state.zoom + delta));
  $('hudZoom').textContent = String(state.zoom);
  renderGoogleMapIframe();
}

function toggleMapType() {
  state.mapType = state.mapType === 'roadmap' ? 'satellite' : 'roadmap';
  renderGoogleMapIframe();
  updateMapModeUI();
}

function updateMapModeUI() {
  const satellite = state.mapType === 'satellite';
  const title = document.querySelector('.viewport-earth .viewport-title strong');
  const subtitle = document.querySelector('.viewport-earth .viewport-title small');

  if (title) title.textContent = satellite ? 'Google Earth / Satellite' : 'Google Map';
  if (subtitle) {
    subtitle.textContent = satellite
      ? 'Vệ tinh · tọa độ · đồng bộ Street View'
      : 'Roadmap · tọa độ · đồng bộ Street View';
  }

  if ($('earthModeButton')) {
    $('earthModeButton').textContent = satellite ? '◉' : '◒';
    $('earthModeButton').title = satellite ? 'Chuyển sang Google Map' : 'Chuyển sang Satellite / Earth';
  }
  if ($('mapTypeButton')) {
    $('mapTypeButton').textContent = satellite ? '▤' : '▧';
    $('mapTypeButton').title = satellite ? 'Chuyển sang bản đồ đường phố' : 'Chuyển sang vệ tinh';
  }
}

function locateUser() {
  if (!navigator.geolocation) {
    setRuntimeStatus('Thiết bị không hỗ trợ định vị', 'error');
    return;
  }

  setRuntimeStatus('Đang xin vị trí thiết bị…', 'loading');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      setPosition(
        { lat: coords.latitude, lng: coords.longitude },
        { syncStreet: true, syncMap: true }
      );
    },
    () => setRuntimeStatus('Không được cấp quyền vị trí', 'error'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function openGoogleStreetView() {
  const { lat, lng } = state.position;
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function openInGoogleEarth() {
  const { lat, lng } = state.position;
  const url = `https://earth.google.com/web/@${lat},${lng},1600a,1100d,35y,0h,0t,0r`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function updatePositionUI(position) {
  const location = toLiteral(position);
  if (!location) return;

  $('hudLat').textContent = location.lat.toFixed(6);
  $('hudLng').textContent = location.lng.toFixed(6);
  $('hudZoom').textContent = String(state.zoom);
  if ($('panoAddress')) {
    $('panoAddress').textContent = `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
  }
}

function renderAdminList() {
  if (!state.adminUnits.length) return;

  const query = normalize($('adminSearch')?.value || '');
  const province = $('provinceFilter')?.value || '';
  const type = $('typeFilter')?.value || '';

  state.visibleUnits = state.adminUnits.filter((unit) => {
    const haystack = normalize([
      unit.name,
      unit.full_name,
      unit.province_name,
      unit.province_full_name,
      unit.code
    ].join(' '));

    return (!query || haystack.includes(query))
      && (!province || unit.province_name === province || unit.province_full_name === province)
      && (!type || unit.type === type);
  });

  $('adminCount').textContent = `${number0.format(state.visibleUnits.length)} kết quả`;
  const list = $('adminList');

  if (!state.visibleUnits.length) {
    list.innerHTML = '<div class="list-empty"><strong>Không tìm thấy đơn vị phù hợp</strong><span>Thử tên khác hoặc bỏ bớt bộ lọc.</span></div>';
    return;
  }

  const display = state.visibleUnits.slice(0, 180);
  list.innerHTML = display.map((unit) => {
    const selected = state.selectedUnit?.id === unit.id ? ' active' : '';
    const cssType = normalize(unit.type).replace(/\s/g, '-');

    return `<button class="admin-item${selected}" type="button" data-unit-id="${escapeHtml(unit.id)}" role="option" aria-selected="${selected ? 'true' : 'false'}">
      <span class="admin-symbol ${cssType}">${typeGlyph(unit.type)}</span>
      <span class="admin-item-copy">
        <strong>${escapeHtml(unit.full_name || unit.name)}</strong>
        <small>${escapeHtml(unit.province_full_name || unit.province_name || 'Việt Nam')}</small>
      </span>
      <span class="admin-item-code">${escapeHtml(unit.code || '—')}</span>
    </button>`;
  }).join('');

  if (state.visibleUnits.length > display.length) {
    list.insertAdjacentHTML(
      'beforeend',
      `<div class="list-empty" style="min-height:48px"><span>Hiển thị ${number0.format(display.length)} / ${number0.format(state.visibleUnits.length)} — hãy thu hẹp tìm kiếm.</span></div>`
    );
  }

  list.querySelectorAll('[data-unit-id]').forEach((button) => {
    button.addEventListener('click', () => {
      const unit = state.adminUnits.find((item) => item.id === button.dataset.unitId);
      if (unit) selectAdminUnit(unit);
    });
  });
}

function selectAdminUnit(unit) {
  state.selectedUnit = unit;
  const selected = $('selectedAdmin');
  selected.hidden = false;
  selected.innerHTML = `
    <span class="selected-type">${escapeHtml(unit.type.toUpperCase())} · MÃ ${escapeHtml(unit.code || '—')}</span>
    <strong>${escapeHtml(unit.full_name || unit.name)}</strong>
    <small>${escapeHtml(unit.province_full_name || unit.province_name || 'Việt Nam')}</small>
  `;

  renderAdminList();

  if (unit.lat != null && unit.lng != null) {
    setPosition({ lat: unit.lat, lng: unit.lng }, { syncStreet: true, syncMap: true });
    toggleDrawer(false);
  } else {
    setRuntimeStatus('Đơn vị này chưa có tọa độ tâm trong dữ liệu hành chính', 'error');
  }
}

function toggleDrawer(force) {
  const shell = $('workspace');
  if (!shell) return;

  const open = typeof force === 'boolean'
    ? force
    : !shell.classList.contains('drawer-open');

  shell.classList.toggle('drawer-open', open);
  $('drawerToggle').setAttribute('aria-expanded', String(open));
  $('adminDrawer').setAttribute('aria-hidden', String(!open));

  if (open) window.setTimeout(() => $('adminSearch')?.focus(), 250);
}

function toggleFullscreen(element) {
  if (!element) return;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else element.requestFullscreen?.();
}

function renderAdminSummary(kind, title, detail) {
  const summary = $('adminSummary');
  summary.classList.remove('ready', 'error');
  if (kind) summary.classList.add(kind);
  summary.querySelector('strong').textContent = title;
  summary.querySelector('small').textContent = detail;
}

function renderAdminError(error) {
  $('adminList').innerHTML = `<div class="list-empty"><strong>Chưa có dữ liệu để tra cứu</strong><span>${escapeHtml(error?.message || 'Kiểm tra nguồn dữ liệu hành chính.')}</span></div>`;
}

function setCoverage(kind, text) {
  const pill = $('coveragePill');
  pill.classList.remove('ready', 'empty');
  if (kind) pill.classList.add(kind);
  pill.innerHTML = `<i></i> ${escapeHtml(text)}`;
}

function setRuntimeStatus(text, kind = '') {
  const node = $('runtimeStatus');
  const dot = document.querySelector('.live-dot');
  if (node) node.textContent = text;
  dot?.classList.remove('ready', 'error');
  if (kind) dot?.classList.add(kind);
}

function toLiteral(value) {
  if (!value) return null;
  const lat = numberOrNull(typeof value.lat === 'function' ? value.lat() : value.lat);
  const lng = numberOrNull(typeof value.lng === 'function' ? value.lng() : value.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function numberOrNull(value) {
  const number = Number(value);
  return value === '' || value == null || Number.isNaN(number) ? null : number;
}

function normalize(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeType(value = '') {
  const key = normalize(value);
  if (key.includes('dac khu')) return 'đặc khu';
  if (key.includes('phuong')) return 'phường';
  if (key.includes('xa')) return 'xã';
  return String(value || 'đơn vị').toLowerCase();
}

function typeGlyph(type) {
  if (type === 'đặc khu') return 'Đ';
  if (type === 'phường') return 'P';
  return 'X';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[char]));
}
