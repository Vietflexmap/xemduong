const ALLOWED_HOSTS = [
  'google.com',
  'www.google.com',
  'maps.google.com',
  'maps.app.goo.gl',
  'goo.gl',
  'zalo.me',
  'www.zalo.me',
  'zaloapp.com',
  'www.zaloapp.com'
];

export default async function handler(request, response) {
  response.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  response.setHeader('Cache-Control', 'no-store');

  if (request.method && request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }

  const raw = String(request.query?.url || '').trim();
  if (!raw) return response.status(400).json({ error: 'Thiếu tham số url.' });

  let start;
  try {
    start = new URL(raw);
  } catch {
    return response.status(400).json({ error: 'URL không hợp lệ.' });
  }

  if (!isAllowedUrl(start)) {
    return response.status(400).json({ error: 'Chỉ hỗ trợ liên kết Google Maps hoặc Zalo.' });
  }

  try {
    const direct = parseCoordinates(start.href);
    if (direct) return response.status(200).json({ ...direct, source: 'url', finalUrl: start.href });

    const result = await expandAndResolve(start);
    if (!result.coords) {
      return response.status(422).json({
        error: 'Không tìm thấy tọa độ trong liên kết này.',
        finalUrl: result.finalUrl
      });
    }

    return response.status(200).json({
      ...result.coords,
      source: 'resolved-url',
      finalUrl: result.finalUrl
    });
  } catch (error) {
    return response.status(502).json({
      error: 'Không thể giải mã liên kết vị trí.',
      detail: error?.message || String(error)
    });
  }
}

async function expandAndResolve(start) {
  let current = start;
  let finalUrl = current.href;

  for (let hop = 0; hop < 6; hop += 1) {
    if (!isAllowedUrl(current)) throw new Error('Redirect sang host không được phép.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    let upstream;
    try {
      upstream = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 Vietflex-Link2Map/1.0',
          Accept: 'text/html,application/xhtml+xml'
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    const location = upstream.headers.get('location');
    if (location && upstream.status >= 300 && upstream.status < 400) {
      const next = new URL(location, current);
      if (!isAllowedUrl(next)) throw new Error('Redirect sang host không được phép.');
      current = next;
      finalUrl = next.href;

      const fromRedirect = parseCoordinates(finalUrl);
      if (fromRedirect) return { coords: fromRedirect, finalUrl };
      continue;
    }

    finalUrl = upstream.url || current.href;
    const fromFinalUrl = parseCoordinates(finalUrl);
    if (fromFinalUrl) return { coords: fromFinalUrl, finalUrl };

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('text/')) return { coords: null, finalUrl };

    const html = (await upstream.text()).slice(0, 2500000);
    const fromHtml = parseCoordinates(html);
    if (fromHtml) return { coords: fromHtml, finalUrl };

    const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i)?.[1];

    if (canonical) {
      const canonicalUrl = new URL(decodeHtml(canonical), finalUrl);
      if (isAllowedUrl(canonicalUrl)) {
        const fromCanonical = parseCoordinates(canonicalUrl.href);
        if (fromCanonical) return { coords: fromCanonical, finalUrl: canonicalUrl.href };
      }
    }

    return { coords: null, finalUrl };
  }

  return { coords: null, finalUrl };
}

function parseCoordinates(value = '') {
  let text = String(value);
  try { text = decodeURIComponent(text); } catch {}

  // In a Google /maps/place URL the final !3d..!4d pair represents
  // the place itself; earlier pairs can refer to route/context points.
  const placePairs = [...text.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)];
  if (placePairs.length) {
    const match = placePairs[placePairs.length - 1];
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }

  const patterns = [
    /(?:[?&](?:query|q|ll|center|viewpoint)=)(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/i,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /"latitude"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    /"lat"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    /\[null,null,(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\]/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  return null;
}

function isAllowedUrl(url) {
  if (!(url instanceof URL)) return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOSTS.includes(host)
    || host.endsWith('.google.com')
    || host.endsWith('.zalo.me')
    || host.endsWith('.zaloapp.com');
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"');
}
