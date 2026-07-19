// netlify/functions/sheet-update.js

exports.config = {
  path: '/.netlify/functions/sheet-update',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const crypto = require('crypto');

exports.handler = async (event) => {
  // ── CORS preflight ──
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, null, corsHeaders());
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed', message: 'الطريقة غير مسموحة.' }, corsHeaders());
  }

  // parse body
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {
    return jsonResponse(400, { error: 'invalid_request', message: 'صيغة الطلب غير صحيحة.' }, corsHeaders());
  }

  // ═══ التحقق من كلمة السر (نفس INVOICE_PASSWORD) ═══
  const adminPassword = String(body.password || '');
  const correctPassword = process.env.INVOICE_PASSWORD;

  if (!correctPassword) {
    console.error('[sheet-update] INVOICE_PASSWORD env var not set');
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'INVOICE_PASSWORD غير مضبوط على الخادم.',
    }, corsHeaders());
  }

  if (!adminPassword) {
    return jsonResponse(401, {
      error: 'missing_password',
      message: 'يرجى إدخال رمز الأمان.',
    }, corsHeaders());
  }

  if (!timingSafeStringEqual(adminPassword, correctPassword)) {
    console.warn('[sheet-update] failed admin login attempt');
    return jsonResponse(401, {
      error: 'wrong_password',
      message: 'رمز الأمان غير صحيح.',
    }, corsHeaders());
  }

  // ═══ التحقق من رابط الـ Webhook ═══
  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error('[sheet-update] SHEETS_WEBHOOK_URL env var not set');
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'SHEETS_WEBHOOK_URL غير مضبوط. اتبع تعليمات الإعداد في ملف sheet-update.js.',
    }, corsHeaders());
  }

  const action = String(body.action || '').trim();
  const validActions = ['add', 'update', 'delete', 'bulk_replace'];
  if (!validActions.includes(action)) {
    return jsonResponse(400, {
      error: 'invalid_action',
      message: `action يجب أن يكون أحد: ${validActions.join(', ')}`,
    }, corsHeaders());
  }

  // ═══ تنفيذ العملية عبر Apps Script Webhook ═══
  // نرسل الطلب إلى Apps Script مع كلمة السر (للتحقق المزدوج)
  // ملاحظة: Apps Script لا يقبل Content-Type: application/json مع POST مباشرة
  //         لذا نرسله كنص عادي ونحلله يدوياً في الـ Script
  const payload = {
    password: adminPassword,
    action: action,
  };

  if (action === 'bulk_replace') {
    if (!Array.isArray(body.records)) {
      return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
    }
    payload.records = body.records;
  } else {
    if (!body.record || typeof body.record !== 'object') {
      return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
    }
    payload.record = body.record;
  }

  try {
    console.log(`[sheet-update] forwarding ${action} to Apps Script`);
    const bodyStr = JSON.stringify(payload);

    // ═══ Google Apps Script Web Apps تعمل بـ POST ثم GET ═══
    // 1) POST إلى /exec يعالج البيانات ويُعيد 302 redirect
    // 2) GET على رابط الـ redirect يُرجع نتيجة المعالجة (JSON)
    const postRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: bodyStr,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });

    // استخراج رابط الـ redirect
    let finalText = '';
    if([301, 302, 303, 307, 308].includes(postRes.status)){
      const location = postRes.headers.get('location');
      console.log(`[sheet-update] redirect ${postRes.status} → ${location ? location.substring(0, 80) + '...' : 'null'}`);
      if(location){
        // GET على رابط الـ redirect لاستلام النتيجة
        const getRes = await fetch(location, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(30000),
        });
        finalText = await getRes.text();
      } else {
        // لا يوجد Location — نقرأ من الاستجابة الأصلية
        finalText = await postRes.text();
      }
    } else {
      // لم يكن redirect — نقرأ الاستجابة مباشرة
      finalText = await postRes.text();
    }

    // تحليل النتيجة
    let webhookData;
    try {
      webhookData = JSON.parse(finalText);
    } catch(_) {
      webhookData = { ok: false, raw: finalText.slice(0, 500) };
    }

    if (webhookData.ok === false) {
      const errMsg = webhookData.error || 'خطأ غير معروف من Apps Script';
      const userMsg = errMsg === 'unauthorized'
        ? 'الرمز في Apps Script لا يطابق INVOICE_PASSWORD. تحقق من Script properties → ADMIN_PASSWORD.'
        : `خطأ من Apps Script: ${errMsg}`;
      console.error('[sheet-update] script error:', errMsg);
      return jsonResponse(400, {
        error: 'script_error',
        message: userMsg,
      }, corsHeaders());
    }

    console.log(`[sheet-update] ${action} success`);

    return jsonResponse(200, {
      ok: true,
      action: action,
      message: getSuccessMessage(action),
      webhook_response: webhookData,
    }, corsHeaders());

  } catch (err) {
    console.error('[sheet-update] internal error', err);
    return jsonResponse(500, {
      error: 'internal_error',
      message: 'خطأ داخلي أثناء الاتصال بـ Google Sheets. تحقق من SHEETS_WEBHOOK_URL.',
    }, corsHeaders());
  }
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function getSuccessMessage(action){
  const messages = {
    'add':           'تمت إضافة العميل بنجاح إلى Google Sheets.',
    'update':        'تم تحديث بيانات العميل بنجاح في Google Sheets.',
    'delete':        'تم حذف العميل بنجاح من Google Sheets.',
    'bulk_replace':  'تم استبدال كل البيانات في Google Sheets بنجاح.',
  };
  return messages[action] || 'تمت العملية بنجاح.';
}

function timingSafeStringEqual(a, b){
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  const buffersMatch = crypto.timingSafeEqual(paddedA, paddedB);
  return buffersMatch && bufA.length === bufB.length;
}

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
