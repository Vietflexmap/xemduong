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
  fallbackMap: null,
  fallbackMarker: null,
  googleAuthFailed: false,
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
  setRuntimeStatus('Đang khởi tạo Street View nhúng + Vietflex Map…', 'loading');

  const runtime = await loadRuntimeConfig();
  state.config = { ...state.config, ...runtime };
  if (state.config.defaultCenter) state.position = toLiteral(state.config.defaultCenter) || state.position;

  try {
    await loadAdminData();
    renderAdminSummary('ready', `${number0.format(state.adminUnits.length)} đơn vị đã sẵn sàng`, 'Nguồn dữ liệu hành chính Vietflex · sapnhap');
    renderAdminList();
  } catch (error) {
    renderAdminSummary('error', 'Không tải được dữ liệu hành chính', 'Bản đồ và Street View vẫn hoạt động');
    renderAdminError(error);
  }

  initNoKeyExperience();
  setRuntimeStatus('Street View iframe và Vietflex Map đang đồng bộ', 'ready');
}

async function loadRuntimeConfig() {
  const base = String(state.config.backendBaseUrl || '').replace(/\/$/, '');
  const endpoint = `${base}/api/config`;
  try {
    const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`API config HTTP ${response.status}`);
    const payload = await response.json();
    return {
      ...(payload.adminDataUrl ? { adminDataUrl: payload.adminDataUrl } : {})
    };
  } catch {
    return {};
  }
}

function initNoKeyExperience() {
  state.googleAuthFailed = false;
  state.map = null;
  state.panorama = null;
  state.streetViewService = null;
  state.marker = null;
  state.earth3d = null;
  state.earthMode = 'iframe';

  initVietflexMap();
  renderStreetViewIframe(state.position, true);

  const title = document.querySelector('.viewport-earth .viewport-title strong');
  const subtitle = document.querySelector('.viewport-earth .viewport-title small');
  if (title) title.textContent = 'Vietflex Map';
  if (subtitle) subtitle.textContent = 'OpenStreetMap · tọa độ · đồng bộ Street View';
  if ($('earthFallback')) $('earthFallback').hidden = true;
  if ($('earthModeButton')) {
    $('earthModeButton').textContent = '◎';
    $('earthModeButton').title = 'Đưa bản đồ về vị trí Street View';
  }
  if ($('mapTypeButton')) {
    $('mapTypeButton').textContent = '⌖';
    $('mapTypeButton').title = 'Đưa bản đồ về vị trí hiện tại';
  }
  if ($('panoCompass')) $('panoCompass').style.display = 'none';
  setCoverage('ready', 'Street View nhúng');
  updatePositionUI(state.position);
}

function initVietflexMap() {
  const oldMap = $('earthMap');
  if (!oldMap || !window.L) return;

  try { state.fallbackMap?.remove?.(); } catch {}
  const mapNode = oldMap.cloneNode(false);
  oldMap.replaceWith(mapNode);
  mapNode.className = 'google-canvas';
  mapNode.style.display = 'block';

  const center = state.position;
  const zoom = Number(state.config.defaultZoom || state.zoom || 16);
  const map = window.L.map(mapNode, {
    zoomControl: false,
    attributionControl: true,
    preferCanvas: true
  }).setView([center.lat, center.lng], zoom);

  window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const icon = window.L.divIcon({
    className: '',
    iconSize: [58, 58],
    iconAnchor: [29, 29],
    html: '<div style="width:54px;height:54px;border-radius:50%;border:2px solid #fff;background:rgba(8,37,45,.20);box-shadow:0 2px 12px rgba(0,0,0,.55);position:relative"><div style="position:absolute;left:26px;top:5px;width:2px;height:44px;background:#41e6d0"></div><div style="position:absolute;top:26px;left:5px;width:44px;height:2px;background:#41e6d0"></div><div style="position:absolute;left:21px;top:21px;width:8px;height:8px;border-radius:50%;background:#fff;border:2px solid #ffd35a"></div></div>'
  });

  const marker = window.L.marker([center.lat, center.lng], {
    draggable: true,
    icon,
    title: 'Kéo để đổi điểm Street View'
  }).addTo(map);

  marker.on('drag', () => {
    const p = marker.getLatLng();
    updatePositionUI({ lat: p.lat, lng: p.lng });
  });

  marker.on('dragend', () => {
    const p = marker.getLatLng();
    moveTo({ lat: p.lat, lng: p.lng }, 'fallback-marker', true);
  });

  map.on('click', (event) => {
    moveTo({ lat: event.latlng.lat, lng: event.latlng.lng }, 'fallback-map-click', true);
  });

  map.on('moveend', () => {
    const c = map.getCenter();
    state.zoom = map.getZoom();
    if ($('hudZoom')) $('hudZoom').textContent = String(state.zoom);
    if ($('dragHint')) $('dragHint').classList.add('hidden');
    if (!state.syncing && c) updatePositionUI({ lat: c.lat, lng: c.lng });
  });

  state.fallbackMap = map;
  state.fallbackMarker = marker;
  state.zoom = map.getZoom();
  window.setTimeout(() => map.invalidateSize(), 120);
}

function buildStreetViewEmbedUrl(position) {
  const p = toLiteral(position) || state.position;
  const bearing = Number.isFinite(state.heading) ? state.heading : 90;
  // Legacy Google Street View iframe endpoint. It does not use the Maps JS API.
  return `https://maps.google.com/maps?layer=c&cbll=${p.lat.toFixed(7)},${p.lng.toFixed(7)}&cbp=12,${bearing},0,0,5&source=embed&output=svembed`;
}

function renderStreetViewIframe(position, initial = false) {
  const p = toLiteral(position);
  if (!p) return;

  state.position = p;
  const host = $('pano');
  if (!host) return;
  host.innerHTML = '';

  const frame = document.createElement('iframe');
  frame.id = 'streetViewFrame';
  frame.title = 'Google Street View';
  frame.src = buildStreetViewEmbedUrl(p);
  frame.allowFullscreen = true;
  frame.loading = initial ? 'eager' : 'lazy';
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#000;';
  frame.setAttribute('allow', 'fullscreen; geolocation');

  const loading = $('panoLoading');
  if (loading) {
    loading.classList.remove('hidden');
    loading.innerHTML = '<span class="loading-ring"></span><strong>Đang tải Street View nhúng</strong><small>Đồng bộ theo điểm trên Vietflex Map</small>';
  }

  frame.addEventListener('load', () => {
    loading?.classList.add('hidden');
    setCoverage('ready', 'Street View nhúng');
    if ($('panoAddress')) $('panoAddress').textContent = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)} · iframe`;
  }, { once: true });

  host.appendChild(frame);
  window.setTimeout(() => loading?.classList.add('hidden'), 4500);
  updatePositionUI(p);
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
      state.googleAuthFailed = true;
      const error = new Error('Google Maps Platform từ chối xác thực. Hãy kiểm tra billing, Maps JavaScript API và HTTP referrer https://vietflexmap.github.io/xemduong/* trong Google Cloud Console.');
      setRuntimeStatus('Google Maps API bị từ chối · đã chuyển sang Vietflex fallback', 'error');
      activateFallbackExperience(error);
      finish(reject, error);
    };

    // Pin the stable API version instead of the mutable beta channel.
    // 3D is loaded separately with importLibrary('maps3d') and may fall back
    // without blocking the 2D map or Street View.
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places,geometry&language=vi&region=VN&callback=${callbackName}`;
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
  $('zoomInButton')?.addEventListener('click', () => changeZoom(1));
  $('zoomOutButton')?.addEventListener('click', () => changeZoom(-1));
  $('mapTypeButton')?.addEventListener('click', toggleMapType);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('workspace')?.classList.contains('drawer-open')) toggleDrawer(false);
  });
}

async function initGoogleExperience() {
  if (state.googleAuthFailed) {
    activateFallbackExperience(new Error('Google Maps Platform chưa xác thực được.'));
    return;
  }
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
  if (state.googleAuthFailed || !state.streetViewService || !state.panorama) return;
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
  if (state.fallbackMarker && source !== 'fallback-marker') {
    state.fallbackMarker.setLatLng([location.lat, location.lng]);
  }
  if (state.fallbackMap && source !== 'fallback-map-click') {
    state.fallbackMap.panTo([location.lat, location.lng]);
  }
  updatePositionUI(location);
  state.syncing = false;
  if (findStreetView) renderStreetViewIframe(location);
}

function updateFromStreetView(position) {
  const location = toLiteral(position);
  if (!location) return;
  state.position = location;
  state.syncing = true;
  state.marker?.setPosition(location);
  state.map?.panTo(location);
  state.fallbackMarker?.setLatLng([location.lat, location.lng]);
  state.fallbackMap?.panTo([location.lat, location.lng]);
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
  $('hudZoom').textContent = String(state.fallbackMap?.getZoom?.() || state.zoom || 16);
}

function getEarthCenter() {
  if (state.earth3d && state.earthMode === '3d') {
    const center = state.earth3d.center;
    return toLiteral(center);
  }
  return toLiteral(state.map?.getCenter?.()) || toLiteral(state.fallbackMap?.getCenter?.());
}

function toggleEarthMode() {
  if (!state.fallbackMap) return;
  state.fallbackMap.setView([state.position.lat, state.position.lng], state.zoom || 16);
  window.setTimeout(() => state.fallbackMap.invalidateSize(), 50);
}

function toggleMapType() {
  if (!state.fallbackMap) return;
  state.fallbackMap.setView([state.position.lat, state.position.lng], state.fallbackMap.getZoom());
}

function resetPanorama() {
  state.heading = 90;
  renderStreetViewIframe(state.position);
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
      setRuntimeStatus('Đã đồng bộ vị trí với Street View iframe', 'ready');
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
  } else {
    setRuntimeStatus('Đơn vị này chưa có tọa độ tâm trong dữ liệu hành chính', 'error');
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

function activateFallbackExperience(error) {
  state.googleAuthFailed = true;
  state.streetViewService = null;
  state.panorama = null;
  state.map = null;
  state.marker = null;
  state.earth3d = null;
  state.earthMode = 'fallback';

  try { state.fallbackMap?.remove?.(); } catch {}
  state.fallbackMap = null;
  state.fallbackMarker = null;

  const oldPano = $('pano');
  if (oldPano) {
    const pano = oldPano.cloneNode(false);
    oldPano.replaceWith(pano);
    pano.className = 'google-canvas';
    pano.style.display = 'grid';
    pano.style.placeItems = 'center';
    pano.style.background = 'radial-gradient(circle at 50% 45%, #12343d 0, #071923 58%, #02090d 100%)';
    pano.innerHTML = `
      <div style="max-width:620px;margin:24px;padding:28px;border:1px solid rgba(65,230,208,.3);border-radius:20px;background:rgba(4,23,30,.92);box-shadow:0 20px 70px rgba(0,0,0,.35);text-align:center;color:#e9fbf8">
        <div style="font-size:34px;margin-bottom:10px">360°</div>
        <strong style="display:block;font-size:20px;margin-bottom:8px">Google Street View tạm thời chưa xác thực được</strong>
        <span style="display:block;color:#9eb6bd;line-height:1.5;margin-bottom:18px">Trang vẫn dùng được bản đồ và tra cứu. Mở Street View trực tiếp tại tọa độ hiện tại trong Google Maps trong khi API key được cấu hình lại.</span>
        <button id="openStreetFallback" type="button" style="border:0;border-radius:12px;padding:12px 18px;font-weight:700;cursor:pointer;background:#41e6d0;color:#05252b">Mở Google Street View ↗</button>
        <small style="display:block;margin-top:14px;color:#78939a">${escapeHtml(error?.message || 'Google Maps Platform authentication failed.')}</small>
      </div>`;
    pano.querySelector('#openStreetFallback')?.addEventListener('click', openGoogleStreetView);
  }

  $('panoLoading')?.classList.add('hidden');
  if ($('panoAddress')) $('panoAddress').textContent = 'Google API chưa xác thực · dùng nút Mở Street View';
  if ($('panoCompass')) $('panoCompass').style.display = 'none';
  setCoverage('empty', 'Google API cần cấu hình');

  const oldMap = $('earthMap');
  if (oldMap) {
    const mapNode = oldMap.cloneNode(false);
    oldMap.replaceWith(mapNode);
    mapNode.className = 'google-canvas';
    mapNode.style.display = 'block';

    if (window.L) {
      const center = state.position;
      const zoom = Number(state.config.defaultZoom || state.zoom || 16);
      const map = window.L.map(mapNode, { zoomControl: false, attributionControl: true }).setView([center.lat, center.lng], zoom);
      window.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);

      const icon = window.L.divIcon({
        className: '',
        iconSize: [54, 54],
        iconAnchor: [27, 27],
        html: '<div style="width:50px;height:50px;border-radius:50%;border:2px solid #fff;background:rgba(8,37,45,.25);box-shadow:0 2px 10px rgba(0,0,0,.5);position:relative"><div style="position:absolute;left:24px;top:5px;width:2px;height:40px;background:#41e6d0"></div><div style="position:absolute;top:24px;left:5px;width:40px;height:2px;background:#41e6d0"></div><div style="position:absolute;left:20px;top:20px;width:8px;height:8px;border-radius:50%;background:#fff;border:2px solid #ffd35a"></div></div>'
      });
      const marker = window.L.marker([center.lat, center.lng], { draggable: true, icon }).addTo(map);
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        moveTo({ lat: p.lat, lng: p.lng }, 'fallback-marker', false);
      });
      map.on('click', (event) => moveTo({ lat: event.latlng.lat, lng: event.latlng.lng }, 'fallback-map-click', false));
      map.on('zoomend', () => {
        state.zoom = map.getZoom();
        if ($('hudZoom')) $('hudZoom').textContent = String(state.zoom);
      });
      state.fallbackMap = map;
      state.fallbackMarker = marker;
      state.zoom = map.getZoom();
      window.setTimeout(() => map.invalidateSize(), 80);
    } else {
      mapNode.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:#d9ece8;background:#071923">Không tải được thư viện bản đồ fallback.</div>';
    }
  }

  const title = document.querySelector('.viewport-earth .viewport-title strong');
  const subtitle = document.querySelector('.viewport-earth .viewport-title small');
  if (title) title.textContent = 'Vietflex Map fallback';
  if (subtitle) subtitle.textContent = 'OpenStreetMap · tọa độ · tra cứu';
  if ($('earthFallback')) $('earthFallback').hidden = true;
  if ($('earthModeButton')) $('earthModeButton').textContent = '◎';
  if ($('mapTypeButton')) $('mapTypeButton').textContent = '▧';
  setRuntimeStatus('Vietflex Map hoạt động · Google Street View cần cấu hình API', 'error');
  updatePositionUI(state.position);
}

function changeZoom(delta) {
  if (state.fallbackMap) {
    state.fallbackMap.setZoom(Math.max(3, state.fallbackMap.getZoom() + delta));
  }
}

function openGoogleStreetView() {
  const { lat, lng } = state.position;
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  window.open(url, '_blank', 'noopener,noreferrer');
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
