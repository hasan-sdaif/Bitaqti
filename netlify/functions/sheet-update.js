// netlify/functions/sheet-update.js
// ════════════════════════════════════════════════════════════════
//  يدعم مصدرين للكتابة:
//    1. Google Sheets Webhook (افتراضي — يستخدم SHEETS_WEBHOOK_URL)
//    2. Supabase (اختياري — يستخدم SUPABASE_URL + SUPABASE_SERVICE_KEY)
//  لو Supabase مهيأ وصالح → يستخدمه. وإلا → يستخدم Google Sheets.
// ════════════════════════════════════════════════════════════════

exports.config = {
  path: '/.netlify/functions/sheet-update',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const crypto = require('crypto');

// ═══ أعمدة جدول customers المسموح كتابتها ═══
const CUSTOMER_COLUMNS = [
  'phone', 'code', 'package', 'price', 'order_date', 'status', 'order_count',
  'cv_link', 'actions_log', 'subpage_content', 'order_code',
  'customer_name', 'customer_email', 'customer_country', 'customer_language',
  'payment_method', 'payment_status', 'payment_date',
  'vat_amount', 'discount_amount', 'total_with_vat',
  'delivery_date', 'assigned_designer', 'design_link', 'qr_code_path',
  'invoice_notes', 'last_updated', 'invoice_status',
  'referral_code', 'referral_points', 'referred_by',
];

// ─────────────────────────────────────────────────────────────
//  كشف المصدر + طبقة Supabase
// ─────────────────────────────────────────────────────────────
function isSupabaseConfigured(){
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  return !!(url && key && /^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(url) && key.length > 30);
}

function getSupabaseConfig(){
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  return { url, key };
}

async function sbInsert(record){
  const cfg = getSupabaseConfig();
  const res = await fetch(`${cfg.url}/rest/v1/customers`, {
    method: 'POST',
    headers: {
      'apikey': cfg.key, 'Authorization': `Bearer ${cfg.key}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation',
    },
    body: JSON.stringify(record),
  });
  if(!res.ok) throw new Error(`Supabase insert HTTP ${res.status}`);
  return await res.json().catch(() => []);
}

async function sbUpdate(orderCode, phone, code, record){
  const cfg = getSupabaseConfig();
  let filter = '';
  if(orderCode) filter = `order_code=eq.${encodeURIComponent(orderCode)}`;
  else if(phone && code) filter = `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`;
  else throw new Error('No filter for update');
  const res = await fetch(`${cfg.url}/rest/v1/customers?${filter}`, {
    method: 'PATCH',
    headers: {
      'apikey': cfg.key, 'Authorization': `Bearer ${cfg.key}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation',
    },
    body: JSON.stringify(record),
  });
  if(!res.ok) throw new Error(`Supabase update HTTP ${res.status}`);
  const result = await res.json().catch(() => []);
  // لو لم يجد الصف، أدرجه بدلاً من فقدان البيانات
  if(!result || result.length === 0){
    return await sbInsert(record);
  }
  return result;
}

async function sbDelete(orderCode, phone, code){
  const cfg = getSupabaseConfig();
  let filter = '';
  if(orderCode) filter = `order_code=eq.${encodeURIComponent(orderCode)}`;
  else if(phone && code) filter = `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`;
  else throw new Error('No filter for delete');
  const res = await fetch(`${cfg.url}/rest/v1/customers?${filter}`, {
    method: 'DELETE',
    headers: {
      'apikey': cfg.key, 'Authorization': `Bearer ${cfg.key}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation',
    },
  });
  if(!res.ok) throw new Error(`Supabase delete HTTP ${res.status}`);
  return await res.json().catch(() => []);
}

async function sbPing(){
  const cfg = getSupabaseConfig();
  const res = await fetch(`${cfg.url}/rest/v1/customers?select=id&limit=1`, {
    method: 'GET',
    headers: { 'apikey': cfg.key, 'Authorization': `Bearer ${cfg.key}` },
  });
  if(!res.ok) throw new Error(`Supabase ping HTTP ${res.status}`);
  return true;
}

function cleanRecord(rec){
  const out = {};
  CUSTOMER_COLUMNS.forEach(col => {
    if(rec[col] !== undefined) out[col] = rec[col] === '' ? null : rec[col];
  });
  return out;
}

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

  // ═══ التحقق من المصدر (Supabase أو Google Sheets) ═══
  const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
  const useSupabase = isSupabaseConfigured();

  if (!webhookUrl && !useSupabase) {
    console.error('[sheet-update] no data source configured');
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'لا يوجد مصدر بيانات مهيأ. اضبط SHEETS_WEBHOOK_URL أو SUPABASE_URL+SUPABASE_SERVICE_KEY في Netlify.',
    }, corsHeaders());
  }

  const action = String(body.action || '').trim();

  // ═══ وضع اختبار ═══
  if(action === 'test'){
    // لو Supabase مهيأ، اختبره
    if(useSupabase){
      try {
        await sbPing();
        return jsonResponse(200, {
          ok: true, action: 'test',
          message: 'الاتصال بقاعدة البيانات (Supabase) يعمل بشكل صحيح',
        }, corsHeaders());
      } catch(e) {
        return jsonResponse(502, {
          error: 'db_unreachable',
          message: 'تعذّر الوصول إلى Supabase: ' + e.message,
        }, corsHeaders());
      }
    }
    // وإلا اختبر Webhook
    try {
      const testRes = await fetch(webhookUrl, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      const testText = await testRes.text();
      let testData;
      try { testData = JSON.parse(testText); }
      catch(_) { testData = { raw: testText.slice(0, 200) }; }

      if(testData.ok === true || testData.message){
        return jsonResponse(200, {
          ok: true, action: 'test',
          message: 'Webhook يعمل بشكل صحيح',
          webhook_response: testData,
        }, corsHeaders());
      }
      return jsonResponse(200, {
        ok: true, action: 'test',
        message: 'Webhook متصل',
        webhook_response: testData,
      }, corsHeaders());
    } catch(e) {
      return jsonResponse(502, {
        error: 'webhook_unreachable',
        message: 'تعذّر الوصول إلى Apps Script Webhook. تحقق من الرابط.',
      }, corsHeaders());
    }
  }

  const validActions = ['add', 'update', 'delete', 'bulk_replace'];
  if (!validActions.includes(action)) {
    return jsonResponse(400, {
      error: 'invalid_action',
      message: `action يجب أن يكون أحد: ${validActions.join(', ')}`,
    }, corsHeaders());
  }

  // ═══ تنفيذ العملية ═══
  // لو Supabase مهيأ، استخدمه مباشرة
  if(useSupabase){
    try {
      let result;
      if(action === 'add'){
        if (!body.record || typeof body.record !== 'object') {
          return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
        }
        result = await sbInsert(cleanRecord(body.record));
      } else if(action === 'update'){
        if (!body.record || typeof body.record !== 'object') {
          return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
        }
        const r = body.record;
        result = await sbUpdate(r.order_code, r.phone, r.code, cleanRecord(r));
      } else if(action === 'delete'){
        const r = body.record || {};
        result = await sbDelete(r.order_code, r.phone, r.code);
      } else if(action === 'bulk_replace'){
        if (!Array.isArray(body.records)) {
          return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
        }
        // ملاحظة: bulk_replace على Supabase يتطلب حذف الكل ثم إدراج الجديد
        // لكن هذا خطر — نتجاهله هنا ونرجع خطأ واضح
        return jsonResponse(400, { error: 'not_supported', message: 'bulk_replace غير مدعوم على Supabase مباشرة. استخدم add/update/delete.' }, corsHeaders());
      }
      console.log(`[sheet-update] ${action} success via Supabase`);
      return jsonResponse(200, {
        ok: true,
        action: action,
        message: getSuccessMessage(action),
        db_response: result,
      }, corsHeaders());
    } catch(err){
      console.error('[sheet-update] Supabase error:', err.message);
      // لو Supabase فشل ولم يكن webhookUrl موجوداً، أرجع خطأ
      if(!webhookUrl){
        return jsonResponse(502, { error: 'db_error', message: 'خطأ في Supabase: ' + err.message }, corsHeaders());
      }
      // وإلا استمر لمحاولة Google Sheets
      console.warn('[sheet-update] falling back to Google Sheets');
    }
  }

  // ═══ تنفيذ العملية عبر Apps Script Webhook (النسخة الأصلية) ═══
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
