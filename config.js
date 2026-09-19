/* Vietflex Street View no-key mode.
 * The main viewer does not load the Google Maps JavaScript API.
 * Street View uses a legacy iframe endpoint; Vietflex Map uses Leaflet/OSM.
 */
window.VIETFLEX_CONFIG = Object.freeze({
  googleMapsApiKey: '',
  backendBaseUrl: '',
  adminDataUrl: 'https://vietflexmap.github.io/sapnhap/data/admin.json',
  defaultCenter: { lat: 10.2411753, lng: 106.374835 },
  defaultZoom: 16
});
