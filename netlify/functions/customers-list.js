// netlify/functions/customers-list.js

exports.config = {
  path: '/.netlify/functions/customers-list',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const crypto = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, null, corsHeaders());
  }
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, corsHeaders());
  }

  // ── التحقق من التوكن ──
  const authHeader = (event.headers.authorization || event.headers.Authorization || '');
  let token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token && event.queryStringParameters && event.queryStringParameters.token) {
    token = event.queryStringParameters.token;
  }
  if (!token && event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      if (body.token) token = body.token;
    } catch(_) {}
  }

  const secret = process.env.INVOICE_PASSWORD;
  if (!secret) {
    console.error('[customers-list] INVOICE_PASSWORD env var not set');
    return jsonResponse(500, { error: 'server_not_configured' }, corsHeaders());
  }
  if (!token) {
    return jsonResponse(401, { error: 'unauthorized', message: 'توكن مفقود.' }, corsHeaders());
  }
  if (!verifyToken(token, secret)) {
    return jsonResponse(401, { error: 'unauthorized', message: 'توكن غير صالح أو منتهي.' }, corsHeaders());
  }

  const SHEET_ID = process.env.ORDERS_SHEET_ID;
  if (!SHEET_ID) {
    console.error('[customers-list] ORDERS_SHEET_ID not configured');
    return jsonResponse(500, { error: 'server_not_configured' }, corsHeaders());
  }

  let opts = { filter_status: '', filter_payment: '', search: '' };
  if (event.httpMethod === 'GET' && event.queryStringParameters) {
    opts.filter_status  = (event.queryStringParameters.filter_status || '').trim();
    opts.filter_payment = (event.queryStringParameters.filter_payment || '').trim();
    opts.search         = (event.queryStringParameters.search || '').trim().toLowerCase();
  } else if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body || '{}');
      opts.filter_status  = String(body.filter_status  || '').trim();
      opts.filter_payment = String(body.filter_payment || '').trim();
      opts.search         = String(body.search         || '').trim().toLowerCase();
    } catch(_) {}
  }

  // ═══ بناء URL التصدير (بدون gid إن لم يُحدّد لتجنب HTTP 400) ═══
  // ملاحظة: بعض أوراق Google Sheets المنشورة لا تقبل gid=0 وتُرجع HTTP 400.
  const SHEET_GID = process.env.ORDERS_SHEET_GID || '';
  const csvUrl = SHEET_GID && SHEET_GID !== '0'
    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`
    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

  try {
    const sheetRes = await fetch(csvUrl, { signal: AbortSignal.timeout(10000) });
    if (!sheetRes.ok) {
      console.error('[customers-list] sheet fetch failed', sheetRes.status, csvUrl);
      const msg = sheetRes.status === 400
        ? 'تعذّر الوصول إلى Google Sheets (HTTP 400). تأكد أن الشيت منشور للعامة.'
        : sheetRes.status === 404
        ? 'الشيت غير موجود — تحقق من ORDERS_SHEET_ID.'
        : `تعذّر الوصول إلى Google Sheets (HTTP ${sheetRes.status}).`;
      return jsonResponse(502, { error: 'source_unavailable', message: msg }, corsHeaders());
    }

    const csvText = await sheetRes.text();

    // تحقق إن كان الرد HTML (خطأ) بدلاً من CSV
    if (csvText.trimStart().startsWith('<!DOCTYPE') || csvText.trimStart().startsWith('<html')) {
      console.error('[customers-list] got HTML instead of CSV');
      return jsonResponse(502, {
        error: 'source_unavailable',
        message: 'الشيت غير منشور للعامة. افتح Google Sheets → File → Share → Publish to web.',
      }, corsHeaders());
    }

    const rows = parseCSV(csvText);

    // نُصفّي الصفوف التي تحتوي على رقم هاتف صالح فقط (نتخطّي صف العناوين العربية)
    let dataRows = rows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    });

    // ═══ تطبيع كل صف: تنظيف أرقام الهواتف والرموز والتواريخ ═══
    dataRows = dataRows.map(r => normalizeRow(r));

    // فلترة اختيارية
    if (opts.filter_status) {
      dataRows = dataRows.filter(r => String(r.status || '').trim() === opts.filter_status);
    }
    if (opts.filter_payment) {
      dataRows = dataRows.filter(r => String(r.payment_status || '').trim() === opts.filter_payment);
    }
    if (opts.search) {
      dataRows = dataRows.filter(r => {
        const haystack = [
          r.customer_name, r.phone, r.order_code, r.package,
          r.customer_email, r.cv_link, r.assigned_designer
        ].map(v => String(v || '').toLowerCase()).join(' ');
        return haystack.includes(opts.search);
      });
    }

    // ترتيب حسب التاريخ تنازلياً
    dataRows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));

    // إحصائيات سريعة
    const stats = computeStats(dataRows);

    return jsonResponse(200, {
      ok: true,
      customers: dataRows,
      count: dataRows.length,
      stats,
      fetched_at: new Date().toISOString(),
    }, corsHeaders());
  } catch (err) {
    console.error('[customers-list] internal error', err);
    return jsonResponse(500, { error: 'internal_error', message: 'خطأ داخلي.' }, corsHeaders());
  }
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

const DATE_FIELDS = ['order_date', 'payment_date', 'delivery_date', 'last_updated'];
const NUM_FIELDS  = ['price', 'vat_amount', 'discount_amount', 'total_with_vat', 'order_count'];

function normalizeRow(r){
  const out = { ...r };
  // تنظيف رقم الهاتف
  out.phone = cleanPhone(out.phone);
  // تنظيف رمز التحقق
  out.code  = cleanCode(out.code);
  // تطبيع التواريخ
  DATE_FIELDS.forEach(f => {
    if (out[f] !== undefined && out[f] !== '') out[f] = normalizeDate(out[f]);
  });
  // تطبيع الأرقام
  NUM_FIELDS.forEach(f => {
    if (out[f] !== undefined && out[f] !== '') {
      const n = Number(String(out[f]).replace(/[^0-9.\-]/g, ''));
      if (!isNaN(n)) out[f] = n;
    }
  });
  return out;
}

function cleanPhone(rawPhone){
  if (rawPhone === undefined || rawPhone === null) return '';
  let p = String(rawPhone).trim();
  // إزالة .0 من نهاية الأرقام (Excel)
  if (/^[\d.]+$/.test(p) && p.endsWith('.0')) {
    p = p.slice(0, -2);
  }
  // إزالة المسافات والشرطات
  p = p.replace(/[\s\-()]/g, '');
  // توحيد 00973 → +973
  if (p.startsWith('00')) p = '+' + p.slice(2);
  // إزالة أي + غير أول
  p = p.replace(/(?!^)\+/g, '');
  return p;
}

function cleanCode(rawCode){
  if (rawCode === undefined || rawCode === null) return '';
  let c = String(rawCode).trim();
  // إزالة .0
  if (/^[\d.]+$/.test(c) && c.endsWith('.0')) {
    c = c.slice(0, -2);
  }
  // إن كان رقمياً، نحوّله إلى number ثم نص
  if (/^\d+$/.test(c)) return String(Number(c));
  return c;
}

function normalizeDate(value){
  if (value === undefined || value === null || value === '') return '';
  const s = String(value).trim();

  // ISO datetime
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if (isoMatch) {
    return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  }

  // dd/mm/yyyy
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${d.padStart(2,'0')}/${m.padStart(2,'0')}/${y}`;
  }

  return s;
}

function verifyToken(token, secret){
  try {
    let b64 = String(token).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const idx = decoded.lastIndexOf('.');
    if (idx < 1) return false;
    const payload = decoded.slice(0, idx);
    const signature = decoded.slice(idx + 1);
    const expiresAt = Number(payload);
    if (!expiresAt || Date.now() > expiresAt) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (err) {
    return false;
  }
}

function computeStats(rows){
  let totalRevenue = 0, pendingAmount = 0, paidCount = 0, unpaidCount = 0, cancelledCount = 0;
  const byPackage = {};
  const byStatus = {};
  const byMonth = {};

  rows.forEach(r => {
    const total = Number(String(r.total_with_vat || r.price || 0).toString().replace(/[^0-9.\-]/g, '')) || 0;
    const status = String(r.status || '').trim();
    const payment = String(r.payment_status || '').trim();
    const pkg = String(r.package || '').trim() || 'غير محدد';

    byPackage[pkg] = (byPackage[pkg] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;

    if (status === 'ملغي') { cancelledCount++; return; }
    if (payment === 'مدفوع') { totalRevenue += total; paidCount++; }
    else if (payment === 'غير مدفوع') { pendingAmount += total; unpaidCount++; }
    else if (payment === 'مدفوع جزئياً') { totalRevenue += total * 0.5; pendingAmount += total * 0.5; }

    const dateStr = String(r.order_date || '');
    const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const monthKey = `${m[3]}-${m[2].padStart(2, '0')}`;
      byMonth[monthKey] = (byMonth[monthKey] || 0) + total;
    } else if (dateStr.length >= 7) {
      const monthKey = dateStr.slice(0, 7);
      byMonth[monthKey] = (byMonth[monthKey] || 0) + total;
    }
  });

  return {
    total_customers: rows.length,
    total_revenue: Math.round(totalRevenue * 1000) / 1000,
    pending_amount: Math.round(pendingAmount * 1000) / 1000,
    paid_count: paidCount,
    unpaid_count: unpaidCount,
    cancelled_count: cancelledCount,
    by_package: byPackage,
    by_status: byStatus,
    by_month: byMonth,
  };
}

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(statusCode, payload, extraHeaders = {}){
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
    body: payload ? JSON.stringify(payload) : '',
  };
}

function parseCSVLine(line){
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function parseCSV(text){
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines
    .slice(1)
    .filter(l => l.trim())
    .map(line => {
      const values = parseCSVLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()]));
    });
}
