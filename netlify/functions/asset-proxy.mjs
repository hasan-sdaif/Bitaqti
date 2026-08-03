// netlify/functions/asset-proxy.mjs


const CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
};

// Streaming Functions have a hard 20MB response cap and a 10s execution
// budget — fail fast with a clear message instead of crashing mid-stream.
const MAX_BYTES = 20 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;

function extractUserAndFile(pathname) {
  const marker = 'asset-proxy/';
  const idx = pathname.indexOf(marker);
  let rest = idx !== -1 ? pathname.slice(idx + marker.length) : pathname.replace(/^\//, '');
  rest = decodeURIComponent(rest);
  const parts = rest.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === '..')) {
    return null;
  }
  return { user: parts[0], file: parts.slice(1).join('/') };
}

// Strip characters that could break out of the quoted Content-Disposition value.
function sanitizeFilename(name) {
  return name.replace(/["\r\n]/g, '');
}

export default async (req) => {
  try {
    if (req.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
    }

    const url = new URL(req.url);
    const result = extractUserAndFile(url.pathname);
    if (!result) {
      return new Response('Bad request', { status: 400 });
    }
    const { user, file } = result;

    const owner  = process.env.ASSETS_GITHUB_OWNER;
    const repo   = process.env.ASSETS_GITHUB_REPO;
    const branch = process.env.ASSETS_GITHUB_BRANCH || 'main';
    const token  = process.env.ASSETS_GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return new Response('Asset storage is not configured', { status: 500 });
    }

    const ghPath = `${user}/${file}`;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(ghPath)}?ref=${encodeURIComponent(branch)}`;

    const upstreamHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'bitaqti-asset-proxy',
    };
    // Forward the browser's conditional-GET header — if the file hasn't
    // changed, GitHub answers 304 and it costs nothing (no rate-limit use).
    const ifNoneMatch = req.headers.get('if-none-match');
    if (ifNoneMatch) upstreamHeaders['If-None-Match'] = ifNoneMatch;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let ghRes;
    try {
      ghRes = await fetch(apiUrl, { headers: upstreamHeaders, signal: controller.signal });
    } catch (err) {
      const timedOut = err && err.name === 'AbortError';
      return new Response(timedOut ? 'Upstream storage timed out' : 'Upstream storage error', {
        status: timedOut ? 504 : 502,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (ghRes.status === 304) {
      return new Response(null, { status: 304, headers: { 'Cache-Control': 'public, max-age=3600' } });
    }
    if (ghRes.status === 404) {
      return new Response('File not found', { status: 404 });
    }
    if (!ghRes.ok) {
      return new Response('Upstream storage error', { status: 502 });
    }

    const contentLength = ghRes.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BYTES) {
      return new Response('File too large to proxy (20MB limit)', { status: 413 });
    }

    const ext = file.includes('.') ? file.split('.').pop().toLowerCase() : '';
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    const displayName = sanitizeFilename(file.split('/').pop());

    const outHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
      'Content-Disposition': `inline; filename="${displayName}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    const etag = ghRes.headers.get('etag');
    if (etag) outHeaders['ETag'] = etag;
    if (contentLength) outHeaders['Content-Length'] = contentLength;

    // Stream the upstream body straight through — never buffered in memory.
    return new Response(ghRes.body, { status: 200, headers: outHeaders });
  } catch (err) {
    console.error('asset-proxy error:', err);
    return new Response('Server error', { status: 500 });
  }
};

export const config = {
  path: '/.netlify/functions/asset-proxy/*',
};
