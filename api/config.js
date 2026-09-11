const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

export default function handler(_request, response) {
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Cache-Control', 'no-store');
  response.status(200).json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_BROWSER_KEY || '',
    adminDataUrl: process.env.ADMIN_DATA_URL || 'https://vietflexmap.github.io/sapnhap/data/admin.json'
  });
}
