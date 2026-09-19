/*
 * Vietflex Street View — browser configuration.
 *
 * Google Maps JavaScript API keys are public by design because the browser
 * must load the Maps/Street View/3D libraries. Restrict this key in Google
 * Cloud Console by HTTP referrer and API scope (Maps JavaScript API,
 * Street View Static API if used, and Maps 3D where enabled).
 *
 * When deployed with the included backend, /api/config is checked first and
 * may override the browser key with GOOGLE_MAPS_BROWSER_KEY.
 */
window.VIETFLEX_CONFIG = Object.freeze({
  googleMapsApiKey: 'AIzaSyAYf2UqbwgIw0x3113SZQv3OUg1JKTqVI',
  backendBaseUrl: '',
  adminDataUrl: 'https://vietflexmap.github.io/sapnhap/data/admin.json',
  defaultCenter: { lat: 10.2415, lng: 106.3750 },
  defaultZoom: 16
});
