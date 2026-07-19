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

    // ═══ Google Apps Script يُعيد redirect 302 من script.google.com
    //    إلى script.googleusercontent.com. عند متابعة الـ redirect،
    //    يتحوّل POST إلى GET وتضيع البيانات!
    //    الحل: نستخدم redirect:'manual' ثم نُعيد POST يدوياً للرابط الجديد. ═══
    let finalRes = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });

    // إن كان redirect (301/302/303/307/308)، نتبع Location يدوياً مع POST
    if([301, 302, 303, 307, 308].includes(finalRes.status)){
      const location = finalRes.headers.get('location');
      console.log(`[sheet-update] redirect ${finalRes.status} → ${location}`);
      if(location){
        finalRes = await fetch(location, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
        });
      }
    }

    // إن كان redirect مرة أخرى، نتبعه (قد يحصل مرتين)
    if([301, 302, 303, 307, 308].includes(finalRes.status)){
      const location2 = finalRes.headers.get('location');
      if(location2){
        finalRes = await fetch(location2, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyStr,
          redirect: 'follow',
          signal: AbortSignal.timeout(30000),
        });
      }
    }

    const webhookText = await finalRes.text();

    // Apps Script قد يُرجع JSON أو نص عادي
    let webhookData;
    try {
      webhookData = JSON.parse(webhookText);
    } catch(_) {
      webhookData = { ok: false, raw: webhookText.slice(0, 500) };
    }

    if (!finalRes.ok) {
      console.error('[sheet-update] webhook failed', finalRes.status, webhookText.slice(0, 300));
      return jsonResponse(502, {
        error: 'webhook_failed',
        message: `فشل الاتصال بـ Google Apps Script (HTTP ${finalRes.status}). ${webhookData.raw || webhookData.error || ''}`,
        details: webhookData,
      }, corsHeaders());
    }

    if (webhookData.ok === false) {
      const errMsg = webhookData.error || 'خطأ غير معروف من Apps Script';
      const userMsg = errMsg === 'unauthorized'
        ? 'كلمة السر في Apps Script لا تطابق INVOICE_PASSWORD. تحقق من Script properties.'
        : `خطأ من Apps Script: ${errMsg}`;
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
