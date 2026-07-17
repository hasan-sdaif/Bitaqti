// netlify/functions/track-order.js
//
// وظيفة هذه الدالة: تستقبل رقم الهاتف ورمز التحقق من المتصفح، وتتحقق من
// تطابقهما مع سجل الطلبات من طرف السيرفر فقط. المتصفح لا يتصل أبداً بمصدر
// البيانات مباشرة ولا يرى سوى نتيجة التحقق لطلبه هو تحديداً — مهما كانت
// الحالة، لا تُعاد أي بيانات تخص طلبات عملاء آخرين.
//
// الإعداد على Netlify (Site settings → Environment variables):
//   ORDERS_SHEET_ID   = المعرّف (ID) الخاص بملف تتبع الطلبات
//   ORDERS_SHEET_GID  = رقم الشيت الفرعي (اختياري، الافتراضي 0)
//
// هذه القيم تبقى على السيرفر فقط ولا تصل إلى كود المتصفح إطلاقاً.
//
// ═══ الحماية من محاولات التخمين الآلي (Rate Limiting) ═══
// نحدّ كل IP بحد أقصى 5 طلبات كل 60 ثانية على هذه الدالة تحديداً.
// هذا يمنع أي محاولة تخمين آلية لأرقام هواتف/رموز تحقق عملاء آخرين،
// بينما يبقى أكثر من كافٍ لأي عميل حقيقي يدخل رقمه ورمزه (حتى لو أخطأ
// مرتين أو ثلاث بالكتابة). القيمة تُقرأ وتُفعَّل تلقائياً من Netlify
// عند الرفع (deploy) — لا حاجة لأي إعداد إضافي بالواجهة.
exports.config = {
  path: '/.netlify/functions/track-order',
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  let phone = '';
  let code = '';
  try {
    const body = JSON.parse(event.body || '{}');
    phone = String(body.phone || '').trim();
    code = String(body.code || '').trim();
  } catch (err) {
    return jsonResponse(400, { error: 'invalid_request' });
  }

  if (!phone || !code) {
    return jsonResponse(400, { error: 'missing_fields' });
  }

  const SHEET_ID = process.env.ORDERS_SHEET_ID;
  const SHEET_GID = process.env.ORDERS_SHEET_GID || '0';

  if (!SHEET_ID) {
    return jsonResponse(500, { error: 'server_not_configured' });
  }

  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
    const sheetRes = await fetch(csvUrl);
    if (!sheetRes.ok) {
      return jsonResponse(502, { error: 'source_unavailable' });
    }

    const rows = parseCSV(await sheetRes.text());
    const match = rows.find((r) => r.phone === phone && r.code === code);

    if (!match) {
      return jsonResponse(404, { error: 'not_found' });
    }

    // نُعيد فقط الحقول اللازمة لعرض الفاتورة على الواجهة.
    // لا نُعيد رقم الهاتف ولا رمز التحقق ولا أي صف آخر من السجل.
    const safeResult = {
      order_code: match.order_code || '',
      order_date: match.order_date || '',
      package: match.package || '',
      price: match.price || '',
      status: match.status || '',
      order_count: match.order_count || '',
      cv_link: match.cv_link || '',
      actions_log: match.actions_log || '',
      subpage_content: match.subpage_content || '',
    };

    return jsonResponse(200, safeResult);
  } catch (err) {
    return jsonResponse(500, { error: 'internal_error' });
  }
};

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function parseCSVLine(line) {
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

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map((h) => h.trim());
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const values = parseCSVLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()]));
    });
}
