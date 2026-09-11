import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 8787);
const browserKey = process.env.GOOGLE_MAPS_BROWSER_KEY || '';
const adminSource = process.env.ADMIN_DATA_URL || 'https://vietflexmap.github.io/sapnhap/data/admin.json';
let adminCache = { expires: 0, payload: null };

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    response.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');

    if (url.pathname === '/api/config') {
      return sendJson(response, 200, {
        googleMapsApiKey: browserKey,
        adminDataUrl: adminSource
      }, 'no-store');
    }
    if (url.pathname === '/api/admin') return await adminApi(url, response);
    return await staticFile(url.pathname, response);
  } catch (error) {
    sendJson(response, 500, { error: 'Internal server error', detail: error.message });
  }
});

server.listen(port, () => {
  console.log(`Vietflex Street View running at http://localhost:${port}`);
});

async function adminApi(url, response) {
  const payload = await getAdminPayload();
  const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase('vi');
  const type = (url.searchParams.get('type') || '').trim().toLocaleLowerCase('vi');
  const province = (url.searchParams.get('province') || '').trim().toLocaleLowerCase('vi');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 5000), 1), 5000);
  const units = (payload.units || []).filter((unit) => {
    const haystack = [unit.name, unit.full_name, unit.province_name, unit.province_full_name, unit.code].join(' ').toLocaleLowerCase('vi');
    return (!query || haystack.includes(query))
      && (!type || String(unit.type || '').toLocaleLowerCase('vi') === type)
      && (!province || String(unit.province_name || unit.province_full_name || '').toLocaleLowerCase('vi') === province);
  }).slice(0, limit);
  return sendJson(response, 200, { metadata: payload.metadata || {}, provinces: payload.provinces || [], units }, 'public, max-age=300, stale-while-revalidate=900');
}

async function getAdminPayload() {
  if (adminCache.payload && adminCache.expires > Date.now()) return adminCache.payload;
  const upstream = await fetch(adminSource, { headers: { Accept: 'application/json' } });
  if (!upstream.ok) throw new Error(`Nguồn sapnhap HTTP ${upstream.status}`);
  const payload = await upstream.json();
  if (!Array.isArray(payload.units)) throw new Error('Payload không có mảng units.');
  adminCache = { payload, expires: Date.now() + 15 * 60 * 1000 };
  return payload;
}

async function staticFile(requestPath, response) {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return sendJson(response, 403, { error: 'Forbidden' });
  try {
    const content = await fs.readFile(target);
    response.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}

function sendJson(response, status, value, cacheControl = 'no-store') {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl });
  response.end(JSON.stringify(value));
}
