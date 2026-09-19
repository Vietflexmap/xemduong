const $ = (id) => document.getElementById(id);
const number0 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const number2 = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

const state = {
  config: { ...(window.VIETFLEX_CONFIG || {}) },
  map: null,
  panorama: null,
  streetViewService: null,
  marker: null,
  earth3d: null,
  earthMode: 'satellite',
  position: { lat: 10.2415, lng: 106.3750 },
  heading: 0,
  pitch: 0,
  zoom: 16,
  syncing: false,
  streetRequestId: 0,
  adminUnits: [],
  provinces: [],
  visibleUnits: [],
  selectedUnit: null,
  mapType: 'roadmap'
};

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  bindUI();
  setRuntimeStatus('Đang nạp dữ liệu Vietflex…', 'loading');

  const runtime = await loadRuntimeConfig();
  state.config = { ...state.config, ...runtime };
  if (state.config.defaultCenter) state.position = toLiteral(state.config.defaultCenter) || state.position;

  const [adminResult, mapsResult] = await Promise.allSettled([
    loadAdminData(),
    loadGoogleMaps(state.config.googleMapsApiKey)
  ]);

  if (adminResult.status === 'fulfilled') {
    renderAdminSummary('ready', `${number0.format(state.adminUnits.length)} đơn vị đã sẵn sàng`, 'Nguồn dữ liệu hành chính Vietflex · sapnhap');
    renderAdminList();
  } else {
    renderAdminSummary('error', 'Không tải được dữ liệu hành chính', 'Bạn vẫn có thể kéo bản đồ để xem 360°');
    renderAdminError(adminResult.reason);
  }

  if (mapsResult.status === 'fulfilled') {
    try {
      await initGoogleExperience();
      setRuntimeStatus('Street View và bản đồ đang đồng bộ', 'ready');
    } catch (error) {
      console.error('Vietflex map initialization failed.', error);
      setRuntimeStatus('Google Maps đã tải nhưng khởi tạo không thành công', 'error');
      showMapError(error);
    }
  } else {
    setRuntimeStatus('Chưa kết nối được Google Maps API', 'error');
    showMapError(mapsResult.reason);
  }
}

async function loadRuntimeConfig() {
  const base = String(state.config.backendBaseUrl || '').replace(/\/$/, '');
  const endpoint = `${base}/api/config`;
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`API config HTTP ${response.status}`);
    const payload = await response.json();
    return {
      ...(payload.googleMapsApiKey ? { googleMapsApiKey: payload.googleMapsApiKey } : {}),
      ...(payload.adminDataUrl ? { adminDataUrl: payload.adminDataUrl } : {})
    };
  } catch {
    return {};
  }
}

function loadGoogleMaps(apiKey) {
  if (window.google?.maps) return Promise.resolve(window.google.maps);
  if (!apiKey) return Promise.reject(new Error('Thiếu googleMapsApiKey trong config.js hoặc /api/config.'));

  return new Promise((resolve, reject) => {
    const callbackName = `__vietflexMapsReady_${Date.now()}`;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      delete window[callbackName];
      callback(value);
    };
    const timeout = window.setTimeout(() => finish(reject, new Error('Google Maps API timeout.')), 22000);
    window[callbackName] = () => finish(resolve, window.google.maps);
    const script = document.createElement('script');
    script.async = true;
    script.defer = true;
    script.referrerPolicy = 'no-referrer-when-downgrade';

    window.gm_authFailure = () => {
      const error = new Error('Google Maps API từ chối khóa hoặc HTTP referrer. Hãy kiểm tra Maps JavaScript API, billing và giới hạn domain cho vietflexmap.github.io.');
      setRuntimeStatus('Google Maps API bị từ chối quyền truy cập', 'error');
      showMapError(error);
      finish(reject, error);
    };

    // Pin the stable API version instead of the mutable beta channel.
    // 3D is loaded separately with importLibrary('maps3d') and may fall back
    // without blocking the 2D map or Street View.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=3.65&language=vi&region=VN&loading=async&callback=${callbackName}`;
    script.onerror = () => finish(reject, new Error('Không thể tải Google Maps JavaScript API.'));
    document.head.appendChild(script);
  });
}

async function loadAdminData() {
  const base = String(state.config.backendBaseUrl || '').replace(/\/$/, '');
  const endpoints = [];
  if (base) endpoints.push(`${base}/api/admin?limit=5000`);
  if (state.config.adminDataUrl) endpoints.push(state.config.adminDataUrl);
  endpoints.push('./data/admin.json');

  let lastError = new Error('Không có nguồn dữ liệu hành chính khả dụng.');
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'force-cache' });
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
    state.provinces = names.map((name, index) => ({ id: `province-${index}`, name, full_name: name, order: index + 1 }));
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
  $('resetPanoButton')?.addEventListener('click', resetPanorama);
  $('fullscreenPanoButton')?.addEventListener('click', () => toggleFullscreen($('panoPanel')));
  $('openEarthButton')?.addEventListener('click', openInGoogleEarth);
  $('earthModeButton')?.addEventListener('click', toggleEarthMode);
  $('zoomInButton')?.addEventListener('click', () => state.map?.setZoom((state.map.getZoom() || state.zoom) + 1));
  $('zoomOutButton')?.addEventListener('click', () => state.map?.setZoom(Math.max(3, (state.map.getZoom() || state.zoom) - 1)));
  $('mapTypeButton')?.addEventListener('click', toggleMapType);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('workspace')?.classList.contains('drawer-open')) toggleDrawer(false);
  });
}

async function initGoogleExperience() {
  const maps = window.google.maps;
  const center = state.position;
  state.map = new maps.Map($('earthMap'), {
    center,
    zoom: Number(state.config.defaultZoom || 16),
    mapTypeId: 'roadmap',
    streetViewControl: false,
    fullscreenControl: false,
    mapTypeControl: false,
    clickableIcons: false,
    gestureHandling: 'greedy',
    keyboardShortcuts: true,
    zoomControl: false,
    styles: [
      { featureType: 'poi', stylers: [{ visibility: 'simplified' }] }
    ]
  });
  state.zoom = state.map.getZoom();
  state.streetViewService = new maps.StreetViewService();
  state.panorama = new maps.StreetViewPanorama($('pano'), {
    position: center,
    pov: { heading: 0, pitch: 0 },
    zoom: 1,
    addressControl: false,
    linksControl: true,
    panControl: true,
    fullscreenControl: false,
    motionTracking: false,
    enableCloseButton: false,
    showRoadLabels: true,
    clickToGo: true,
    visible: true
  });
  state.map.setStreetView(null);
  state.marker = new maps.Marker({
    map: state.map,
    position: center,
    draggable: true,
    title: 'Kéo vòng tròn để đổi điểm 360°',
    icon: reticleIcon(false),
    zIndex: 99
  });

  attachGoogleListeners();
  updatePositionUI(center);

  // Street View is the primary experience: start it immediately.
  // Earth 3D is progressive enhancement and must never block the viewer.
  requestStreetView(center);
  void initEarth3D(center);
}

function attachGoogleListeners() {
  state.map.addListener('click', (event) => {
    if (event.latLng) moveTo(event.latLng, 'map-click', true);
  });
  state.map.addListener('dragstart', () => {
    $('dragHint')?.classList.add('hidden');
  });
  state.map.addListener('dragend', () => {
    if (!state.syncing) moveTo(state.map.getCenter(), 'map', true);
  });
  state.map.addListener('zoom_changed', () => {
    state.zoom = state.map.getZoom() || state.zoom;
    $('hudZoom').textContent = String(state.zoom);
  });
  state.map.addListener('maptypeid_changed', () => {
    state.mapType = state.map.getMapTypeId();
    $('mapTypeButton').textContent = state.mapType === 'satellite' ? '▤' : '▧';
  });

  state.marker.addListener('dragstart', () => {
    $('reticleGuide')?.classList.add('dragging');
    $('dragHint')?.classList.add('hidden');
    state.marker.setIcon(reticleIcon(true));
  });
  state.marker.addListener('drag', () => {
    const position = state.marker.getPosition();
    if (position) updatePositionUI(position);
  });
  state.marker.addListener('dragend', () => {
    $('reticleGuide')?.classList.remove('dragging');
    state.marker.setIcon(reticleIcon(false));
    const position = state.marker.getPosition();
    if (position) moveTo(position, 'marker', true);
  });

  state.panorama.addListener('position_changed', () => {
    const position = state.panorama.getPosition();
    if (position && !state.syncing) updateFromStreetView(position);
  });
  state.panorama.addListener('pov_changed', () => {
    const pov = state.panorama.getPov();
    if (!pov) return;
    state.heading = Number(pov.heading || 0);
    state.pitch = Number(pov.pitch || 0);
    $('panoCompass').style.setProperty('--heading', `${state.heading}deg`);
    $('panoCompass .compass-arrow').style.transform = `rotate(${state.heading}deg)`;
    if (state.earth3d && !state.syncing) state.earth3d.heading = state.heading;
  });
  state.panorama.addListener('pano_changed', () => {
    const location = state.panorama.getLocation?.();
    if (location?.description) $('panoAddress').textContent = location.description;
  });
}

async function initEarth3D(center) {
  try {
    const library = await window.google.maps.importLibrary('maps3d');
    const Map3DElement = library.Map3DElement;
    if (!Map3DElement) throw new Error('maps3d không trả về Map3DElement');
    const earth = new Map3DElement({
      center: { lat: center.lat, lng: center.lng, altitude: 0 },
      range: 2200,
      tilt: 55,
      heading: 0,
      mode: library.MapMode?.SATELLITE || 'SATELLITE'
    });
    earth.className = 'earth-3d';
    earth.setAttribute('aria-label', 'Google Earth 3D');
    $('earthStage').appendChild(earth);
    $('earthMap').style.display = 'none';
    state.earth3d = earth;
    state.earthMode = '3d';
    $('earthModeButton').textContent = '◒';
    $('earthFallback').hidden = true;

    const centerChanged = () => {
      const current = getEarthCenter();
      if (current && !state.syncing && !samePosition(current, state.position, 0.000001)) moveTo(current, 'earth', true);
    };
    const headingChanged = () => {
      const heading = numberOrNull(earth.heading);
      if (heading == null || state.syncing || !state.panorama) return;
      state.syncing = true;
      state.panorama.setPov({ heading, pitch: state.pitch });
      state.syncing = false;
    };
    ['gmp-centerchange', 'center_changed'].forEach((name) => earth.addEventListener(name, centerChanged));
    ['gmp-headingchange', 'heading_changed'].forEach((name) => earth.addEventListener(name, headingChanged));
  } catch (error) {
    state.earthMode = 'satellite';
    $('earthFallback').hidden = false;
    $('earthFallback').querySelector('strong').textContent = 'Đang dùng Google Maps vệ tinh tương thích';
    $('earthFallback').querySelector('small').textContent = 'Bật Maps 3D trong Google Cloud để nâng cấp sang Earth 3D.';
    state.map.setMapTypeId('satellite');
    console.warn('Google Earth 3D unavailable; satellite fallback enabled.', error);
  }
}

function requestStreetView(position) {
  if (!state.streetViewService || !state.panorama) return;
  const location = toLiteral(position);
  if (!location) return;
  const requestId = ++state.streetRequestId;
  setCoverage('loading', 'Đang tìm ảnh 360°');
  state.streetViewService.getPanorama({
    location,
    radius: 120,
    source: window.google.maps.StreetViewSource.OUTDOOR
  }, (data, status) => {
    if (requestId !== state.streetRequestId) return;
    if (status !== window.google.maps.StreetViewStatus.OK || !data?.location?.latLng) {
      setCoverage('empty', 'Chưa có ảnh 360° gần đây');
      $('panoAddress').textContent = 'Chưa tìm thấy điểm Street View trong bán kính 120 m';
      $('panoLoading').classList.add('hidden');
      return;
    }
    const actual = toLiteral(data.location.latLng);
    state.syncing = true;
    state.panorama.setPano(data.location.pano);
    state.panorama.setPosition(actual);
    state.syncing = false;
    updateFromStreetView(actual);
    $('panoAddress').textContent = data.location.description || 'Google Street View';
    $('panoLoading').classList.add('hidden');
    setCoverage('ready', 'Ảnh 360° sẵn sàng');
  });
}

function moveTo(position, source = 'system', findStreetView = true) {
  const location = toLiteral(position);
  if (!location) return;
  state.position = location;
  state.syncing = true;
  if (state.marker && source !== 'marker') state.marker.setPosition(location);
  if (state.map && source !== 'map') state.map.panTo(location);
  if (state.earth3d && source !== 'earth') state.earth3d.center = { lat: location.lat, lng: location.lng, altitude: 0 };
  updatePositionUI(location);
  state.syncing = false;
  if (findStreetView) requestStreetView(location);
}

function updateFromStreetView(position) {
  const location = toLiteral(position);
  if (!location) return;
  state.position = location;
  state.syncing = true;
  state.marker?.setPosition(location);
  state.map?.panTo(location);
  if (state.earth3d) state.earth3d.center = { lat: location.lat, lng: location.lng, altitude: 0 };
  updatePositionUI(location);
  state.syncing = false;
  const place = state.panorama?.getLocation?.();
  if (place?.description) $('panoAddress').textContent = place.description;
}

function updatePositionUI(position) {
  const location = toLiteral(position);
  if (!location) return;
  $('hudLat').textContent = location.lat.toFixed(6);
  $('hudLng').textContent = location.lng.toFixed(6);
  $('hudZoom').textContent = String(state.map?.getZoom?.() || state.zoom || 16);
}

function getEarthCenter() {
  if (state.earth3d && state.earthMode === '3d') {
    const center = state.earth3d.center;
    return toLiteral(center);
  }
  return toLiteral(state.map?.getCenter?.());
}

function toggleEarthMode() {
  if (!state.earth3d) {
    state.map?.setMapTypeId(state.mapType === 'satellite' ? 'roadmap' : 'satellite');
    return;
  }
  const earthMap = $('earthMap');
  if (state.earthMode === '3d') {
    state.earthMode = 'satellite';
    state.earth3d.style.display = 'none';
    earthMap.style.display = 'block';
    state.map.setMapTypeId('satellite');
    $('earthModeButton').textContent = '◎';
    $('earthFallback').hidden = true;
  } else {
    state.earthMode = '3d';
    earthMap.style.display = 'none';
    state.earth3d.style.display = 'block';
    state.earth3d.center = { ...state.position, altitude: 0 };
    $('earthModeButton').textContent = '◒';
  }
}

function toggleMapType() {
  if (!state.map) return;
  const next = state.map.getMapTypeId() === 'satellite' ? 'roadmap' : 'satellite';
  state.map.setMapTypeId(next);
  if (state.earthMode === '3d') toggleEarthMode();
}

function resetPanorama() {
  if (!state.panorama) return;
  state.panorama.setPov({ heading: 0, pitch: 0, zoom: 1 });
  requestStreetView(state.position);
}

function locateUser() {
  if (!navigator.geolocation) {
    setRuntimeStatus('Thiết bị không hỗ trợ định vị', 'error');
    return;
  }
  setRuntimeStatus('Đang xin vị trí thiết bị…', 'loading');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      moveTo({ lat: coords.latitude, lng: coords.longitude }, 'device', true);
      setRuntimeStatus('Đã đưa bản đồ đến vị trí của bạn', 'ready');
    },
    () => setRuntimeStatus('Không được cấp quyền vị trí', 'error'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function openInGoogleEarth() {
  const { lat, lng } = state.position;
  const url = `https://earth.google.com/web/@${lat},${lng},1600a,1100d,35y,0h,0t,0r`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function toggleDrawer(force) {
  const shell = $('workspace');
  if (!shell) return;
  const open = typeof force === 'boolean' ? force : !shell.classList.contains('drawer-open');
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

function renderAdminList() {
  if (!state.adminUnits.length) return;
  const query = normalize($('adminSearch')?.value || '');
  const province = $('provinceFilter')?.value || '';
  const type = $('typeFilter')?.value || '';
  state.visibleUnits = state.adminUnits.filter((unit) => {
    const haystack = normalize([unit.name, unit.full_name, unit.province_name, unit.province_full_name, unit.code].join(' '));
    return (!query || haystack.includes(query)) && (!province || unit.province_name === province || unit.province_full_name === province) && (!type || unit.type === type);
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
      <span class="admin-item-copy"><strong>${escapeHtml(unit.full_name || unit.name)}</strong><small>${escapeHtml(unit.province_full_name || unit.province_name || 'Việt Nam')}</small></span>
      <span class="admin-item-code">${escapeHtml(unit.code || '—')}</span>
    </button>`;
  }).join('');
  if (state.visibleUnits.length > display.length) {
    list.insertAdjacentHTML('beforeend', `<div class="list-empty" style="min-height:48px"><span>Hiển thị ${number0.format(display.length)} / ${number0.format(state.visibleUnits.length)} — hãy thu hẹp tìm kiếm.</span></div>`);
  }
  list.querySelectorAll('[data-unit-id]').forEach((button) => button.addEventListener('click', () => {
    const unit = state.adminUnits.find((item) => item.id === button.dataset.unitId);
    if (unit) selectAdminUnit(unit);
  }));
}

function selectAdminUnit(unit) {
  state.selectedUnit = unit;
  const selected = $('selectedAdmin');
  selected.hidden = false;
  selected.innerHTML = `<span class="selected-type">${escapeHtml(unit.type.toUpperCase())} · MÃ ${escapeHtml(unit.code || '—')}</span><strong>${escapeHtml(unit.full_name || unit.name)}</strong><small>${escapeHtml(unit.province_full_name || unit.province_name || 'Việt Nam')}</small>`;
  renderAdminList();
  const location = unit.lat != null && unit.lng != null ? { lat: unit.lat, lng: unit.lng } : null;
  if (location) {
    moveTo(location, 'admin', true);
  } else if (window.google?.maps) {
    const address = `${unit.full_name}, ${unit.province_full_name || unit.province_name}, Việt Nam`;
    new window.google.maps.Geocoder().geocode({ address }, (results, status) => {
      const result = results?.[0]?.geometry?.location;
      if (status === 'OK' && result) moveTo(result, 'admin-geocode', true);
    });
  }
}

function renderAdminSummary(kind, title, detail) {
  const summary = $('adminSummary');
  summary.classList.remove('ready', 'error');
  if (kind) summary.classList.add(kind);
  summary.querySelector('strong').textContent = title;
  summary.querySelector('small').textContent = detail;
}

function renderAdminError(error) {
  $('adminList').innerHTML = `<div class="list-empty"><strong>Chưa có dữ liệu để tra cứu</strong><span>${escapeHtml(error?.message || 'Kiểm tra lại /api/admin hoặc nguồn sapnhap.')}</span></div>`;
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

function showMapError(error) {
  $('panoLoading').classList.remove('hidden');
  $('panoLoading').innerHTML = `<span class="fallback-icon">!</span><strong>Chưa thể tải Google Maps</strong><small>${escapeHtml(error?.message || 'Kiểm tra API key, billing và HTTP referrer.')}</small>`;
  $('coveragePill').classList.add('empty');
  $('coveragePill').innerHTML = '<i></i> Cần cấu hình API';
}

function reticleIcon(dragging) {
  const ring = dragging ? '#41e6d0' : '#ffffff';
  const plus = dragging ? '#ffd35a' : '#41e6d0';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><defs><filter id="s"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#05262c" flood-opacity=".75"/></filter></defs><g filter="url(#s)"><circle cx="36" cy="36" r="27" fill="#08252d" fill-opacity=".23" stroke="${ring}" stroke-width="2"/><circle cx="36" cy="36" r="15" fill="#41e6d0" fill-opacity=".14" stroke="#41e6d0" stroke-width="2"/><path d="M10 36h52M36 10v52" stroke="${plus}" stroke-width="2" stroke-linecap="round"/><circle cx="36" cy="36" r="4" fill="#fff" stroke="#ffd35a" stroke-width="2"/></g></svg>`;
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize: new window.google.maps.Size(72, 72), anchor: new window.google.maps.Point(36, 36) };
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

function samePosition(a, b, epsilon = 0.00001) {
  return Boolean(a && b && Math.abs(a.lat - b.lat) < epsilon && Math.abs(a.lng - b.lng) < epsilon);
}

function normalize(value = '') {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
