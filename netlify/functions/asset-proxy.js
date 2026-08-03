// netlify/functions/asset-proxy.js
// ════════════════════════════════════════════════════════════════
//  دالة وسيطة (Proxy) تجلب ملفات المستخدمين (PDF / صور / شهادات)
//  من مستودع GitHub خاص منفصل تمامًا عن مستودع الموقع الرئيسي.
//
//  الفكرة:
//   - رفع سيرة ذاتية جديدة = رفع ملف في مستودع GitHub آخر (خاص)
//     لا علاقة له بنشر Netlify إطلاقًا → لا يُشغّل أي بناء جديد للموقع.
//   - الرابط الذي يراه الزائر يبقى: bitaqti.com/username/paper-cv.pdf
//     (نفس الجذر تمامًا)، لأن الجلب من GitHub يحدث من داخل الخادم
//     هنا، ولا يظهر أبدًا في متصفح الزائر.
//   - اسم/رابط المستودع الثاني لا يُكشف أبدًا للزوار.
// ════════════════════════════════════════════════════════════════

exports.config = {
  path: '/.netlify/functions/asset-proxy',
};

const CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

exports.handler = async (event) => {
  try {
    const { user, file } = event.queryStringParameters || {};

    if (!user || !file) {
      return { statusCode: 400, body: 'Missing user or file parameter' };
    }
    // منع محاولات الخروج عن المجلد المسموح به
    if (user.includes('..') || file.includes('..') || user.includes('/')) {
      return { statusCode: 400, body: 'Invalid path' };
    }

    const owner  = process.env.ASSETS_GITHUB_OWNER;   // اسم المستخدم/المنظمة على GitHub
    const repo   = process.env.ASSETS_GITHUB_REPO;    // اسم المستودع الخاص بالملفات
    const branch = process.env.ASSETS_GITHUB_BRANCH || 'main';
    const token  = process.env.ASSETS_GITHUB_TOKEN;   // Personal Access Token (صلاحية قراءة فقط)

    if (!owner || !repo || !token) {
      return { statusCode: 500, body: 'Asset storage is not configured' };
    }

    const path = `${user}/${file}`;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;

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
