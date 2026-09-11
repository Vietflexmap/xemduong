const SOURCE_URL = process.env.ADMIN_DATA_URL || 'https://vietflexmap.github.io/sapnhap/data/admin.json';
const CACHE_TTL = 15 * 60 * 1000;
let cache = { expires: 0, payload: null };

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  response.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=900');

  try {
    const payload = await getPayload();
    const query = String(request.query?.q || '').trim().toLocaleLowerCase('vi');
    const type = String(request.query?.type || '').trim().toLocaleLowerCase('vi');
    const province = String(request.query?.province || '').trim().toLocaleLowerCase('vi');
    const limit = Math.min(Math.max(Number(request.query?.limit || 5000), 1), 5000);

    const units = (payload.units || []).filter((unit) => {
      const haystack = [unit.name, unit.full_name, unit.province_name, unit.province_full_name, unit.code].join(' ').toLocaleLowerCase('vi');
      return (!query || haystack.includes(query))
        && (!type || String(unit.type || '').toLocaleLowerCase('vi') === type)
        && (!province || String(unit.province_name || unit.province_full_name || '').toLocaleLowerCase('vi') === province);
    }).slice(0, limit);

    response.status(200).json({
      metadata: payload.metadata || {},
      provinces: payload.provinces || [],
      units
    });
  } catch (error) {
    response.status(502).json({ error: 'Không lấy được dữ liệu hành chính.', detail: error.message });
  }
}

async function getPayload() {
  if (cache.payload && cache.expires > Date.now()) return cache.payload;
  const upstream = await fetch(SOURCE_URL, { headers: { Accept: 'application/json' } });
  if (!upstream.ok) throw new Error(`Nguồn sapnhap HTTP ${upstream.status}`);
  const payload = await upstream.json();
  if (!Array.isArray(payload.units)) throw new Error('Payload không có mảng units.');
  cache = { payload, expires: Date.now() + CACHE_TTL };
  return payload;
}
