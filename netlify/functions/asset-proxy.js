exports.config = {
  path: '/.netlify/functions/asset-proxy/*',
};

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

const PREFIX = '/.netlify/functions/asset-proxy/';

exports.handler = async (event) => {
  try {
    const rawPath = event.path || '';
    if (!rawPath.startsWith(PREFIX)) {
      return { statusCode: 400, body: 'Bad request' };
    }

    const rest = decodeURIComponent(rawPath.slice(PREFIX.length));
    const parts = rest.split('/').filter(Boolean);

    if (parts.length < 2 || parts.some((p) => p === '..')) {
      return { statusCode: 400, body: 'Missing user or file parameter' };
    }

    const user = parts[0];
    const file = parts.slice(1).join('/');

    const owner  = process.env.ASSETS_GITHUB_OWNER;
    const repo   = process.env.ASSETS_GITHUB_REPO;
    const branch = process.env.ASSETS_GITHUB_BRANCH || 'main';
    const token  = process.env.ASSETS_GITHUB_TOKEN;

    if (!owner || !repo || !token) {
      return { statusCode: 500, body: 'Asset storage is not configured' };
    }

    const ghPath = `${user}/${file}`;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(ghPath)}?ref=${encodeURIComponent(branch)}`;

    const ghRes = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'bitaqti-asset-proxy',
      },
    });

    if (ghRes.status === 404) {
      return { statusCode: 404, body: 'File not found' };
    }
    if (!ghRes.ok) {
      return { statusCode: 502, body: 'Upstream storage error' };
    }

    const buffer = Buffer.from(await ghRes.arrayBuffer());
    const ext = file.split('.').pop().toLowerCase();
    const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
    const displayName = file.split('/').pop();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        'Content-Disposition': `inline; filename="${displayName}"`,
      },
      body: buffer.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: 'Server error' };
  }
};
