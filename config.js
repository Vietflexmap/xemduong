/* Vietflex Street View no-key mode.
 * The main viewer does not load the Google Maps JavaScript API.
 * Street View uses a legacy iframe endpoint; Vietflex Map uses Leaflet/OSM.
 */
window.VIETFLEX_CONFIG = Object.freeze({
  googleMapsApiKey: '',
  backendBaseUrl: '',
  adminDataUrl: 'https://vietflexmap.github.io/sapnhap/data/admin.json',
  defaultCenter: { lat: 10.8259065, lng: 106.6144391 },
  defaultZoom: 16
});
