// netlify/functions/sheet-update.js
// ════════════════════════════════════════════════════════════════
//  يدعم مصدرين للكتابة تلقائياً:
//    1. Supabase (لو SUPABASE_URL + SUPABASE_SERVICE_KEY موجودان) — مُفضّل
//    2. Google Sheets Webhook (لو SHEETS_WEBHOOK_URL موجود) — احتياطي
//  هذا يضمن أن الكتابة تعمل سواء أتممت إعداد Supabase أم لا.
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
//  كشف المصدر النشط
// ─────────────────────────────────────────────────────────────
function getDataSource(){
  const supaUrl = (process.env.SUPABASE_URL || '').trim();
  const supaKey = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  if(supaUrl && supaKey && /^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(supaUrl) && supaKey.length > 30){
    return 'supabase';
  }
  if(process.env.SHEETS_WEBHOOK_URL){
    return 'sheets';
  }
  return 'none';
}

// ─────────────────────────────────────────────────────────────
//  طبقة Supabase للكتابة
// ─────────────────────────────────────────────────────────────
function getSupabaseConfig(){
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  if(!url || !serviceKey) return null;
  return { url, serviceKey };
}

async function sbRequest(path, options = {}){
  const cfg = getSupabaseConfig();
  if(!cfg) throw Object.assign(new Error('Supabase not configured'), { code: 'server_not_configured' });
  let res;
  try {
    res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method: options.method || 'GET',
      headers: {
        'apikey': cfg.serviceKey,
        'Authorization': `Bearer ${cfg.serviceKey}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Prefer': options.prefer || 'return=representation',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch(networkErr){
    throw Object.assign(new Error('تعذّر الوصول إلى Supabase.'), { code: 'source_unavailable' });
  }
  if(res.status === 401 || res.status === 403){
    throw Object.assign(new Error('مفتاح Supabase غير صالح.'), { code: 'auth_error' });
  }
  if(res.status === 409){
    throw Object.assign(new Error('تضارب — السجل موجود مسبقاً.'), { code: 'duplicate', status: 409 });
  }
  if(!res.ok){
    throw Object.assign(new Error(`خطأ من Supabase (HTTP ${res.status})`), { code: 'db_error' });
  }
  if(res.status === 204) return [];
  return await res.json().catch(() => []);
}

async function sbInsert(table, record){ return await sbRequest(encodeURIComponent(table), { method: 'POST', prefer: 'return=representation', body: record }); }
async function sbUpdateWhere(table, filter, values){ return await sbRequest(`${encodeURIComponent(table)}?${filter}`, { method: 'PATCH', prefer: 'return=representation', body: values }); }
async function sbDeleteWhere(table, filter){ return await sbRequest(`${encodeURIComponent(table)}?${filter}`, { method: 'DELETE', prefer: 'return=representation' }); }
async function sbDeleteAll(table){ return await sbRequest(`${encodeURIComponent(table)}?id=gte.0`, { method: 'DELETE', prefer: 'return=representation' }); }
async function sbPing(){ await sbRequest(`${encodeURIComponent('customers')}?select=id&limit=1`, { method: 'GET' }); return true; }

// ─────────────────────────────────────────────────────────────
//  Handler الرئيسي
// ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return jsonResponse(204, null, corsHeaders());
  }
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed', message: 'الطريقة غير مسموحة.' }, corsHeaders());
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {
    return jsonResponse(400, { error: 'invalid_request', message: 'صيغة الطلب غير صحيحة.' }, corsHeaders());
  }

  // ═══ التحقق من كلمة السر ═══
  const adminPassword = String(body.password || '');
  const correctPassword = process.env.INVOICE_PASSWORD;
  if (!correctPassword) {
    return jsonResponse(500, { error: 'server_not_configured', message: 'INVOICE_PASSWORD غير مضبوط على الخادم.' }, corsHeaders());
  }
  if (!adminPassword) {
    return jsonResponse(401, { error: 'missing_password', message: 'يرجى إدخال رمز الأمان.' }, corsHeaders());
  }
  if (!timingSafeStringEqual(adminPassword, correctPassword)) {
    return jsonResponse(401, { error: 'wrong_password', message: 'رمز الأمان غير صحيح.' }, corsHeaders());
  }

  const action = String(body.action || '').trim();
  const source = getDataSource();

  if (source === 'none') {
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'لا يوجد مصدر بيانات مهيأ. اضبط SUPABASE_URL+SUPABASE_SERVICE_KEY أو SHEETS_WEBHOOK_URL في Netlify.',
    }, corsHeaders());
  }

  // ═══ وضع اختبار ═══
  if (action === 'test') {
    if (source === 'supabase') {
      try {
        await sbPing();
        return jsonResponse(200, { ok: true, action: 'test', message: 'الاتصال بقاعدة البيانات (Supabase) يعمل بشكل صحيح' }, corsHeaders());
      } catch (e) {
        return jsonResponse(502, { error: 'db_unreachable', message: e.message }, corsHeaders());
      }
    }
    // sheets
    try {
      const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
      const testRes = await fetch(webhookUrl, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000) });
      const testText = await testRes.text();
      let testData;
      try { testData = JSON.parse(testText); } catch(_) { testData = { raw: testText.slice(0, 200) }; }
      return jsonResponse(200, { ok: true, action: 'test', message: 'Webhook يعمل بشكل صحيح', webhook_response: testData }, corsHeaders());
    } catch(e) {
      return jsonResponse(502, { error: 'webhook_unreachable', message: 'تعذّر الوصول إلى Apps Script Webhook.' }, corsHeaders());
    }
  }

  const validActions = ['add', 'update', 'delete', 'bulk_replace'];
  if (!validActions.includes(action)) {
    return jsonResponse(400, { error: 'invalid_action', message: `action يجب أن يكون أحد: ${validActions.join(', ')}` }, corsHeaders());
  }

  // تنسيق السجلات
  if (action === 'bulk_replace') {
    if (!Array.isArray(body.records)) {
      return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
    }
  } else {
    if (!body.record || typeof body.record !== 'object') {
      return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
    }
  }

  function cleanRecord(rec){
    const out = {};
    CUSTOMER_COLUMNS.forEach(col => {
      if(rec[col] !== undefined) out[col] = rec[col] === '' ? null : rec[col];
    });
    return out;
  }

  // ═══ تنفيذ العملية ═══
  try {
    let dbResponse;

    if (source === 'supabase') {
      // ── Supabase path ──
      if (action === 'add') {
        const record = cleanRecord(body.record);
        dbResponse = await sbInsert('customers', record);
      } else if (action === 'update') {
        const record = cleanRecord(body.record);
        const orderCode = String(body.record.order_code || '').trim();
        const phone = String(body.record.phone || '').trim();
        const code  = String(body.record.code  || '').trim();
        let updated = [];
        if (orderCode) updated = await sbUpdateWhere('customers', `order_code=eq.${encodeURIComponent(orderCode)}`, record);
        if ((!updated || updated.length === 0) && phone && code) {
          updated = await sbUpdateWhere('customers', `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`, record);
        }
        if (!updated || updated.length === 0) {
          // لم يجد الصف — أضفه بدل أن تضيع البيانات
          dbResponse = await sbInsert('customers', record);
        } else {
          dbResponse = updated;
        }
      } else if (action === 'delete') {
        const orderCode = String(body.record.order_code || '').trim();
        const phone = String(body.record.phone || '').trim();
        const code  = String(body.record.code  || '').trim();
        let deleted = [];
        if (orderCode) deleted = await sbDeleteWhere('customers', `order_code=eq.${encodeURIComponent(orderCode)}`);
        if ((!deleted || deleted.length === 0) && phone && code) {
          deleted = await sbDeleteWhere('customers', `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`);
        }
        dbResponse = deleted;
      } else if (action === 'bulk_replace') {
        const records = body.records.map(cleanRecord);
        await sbDeleteAll('customers');
        dbResponse = records.length ? await sbInsert('customers', records) : [];
      }

      console.log(`[sheet-update] ${action} success via Supabase`);
      return jsonResponse(200, {
        ok: true,
        action: action,
        message: getSuccessMessage(action),
        db_response: dbResponse,
      }, corsHeaders());

    } else {
      // ── Google Sheets Webhook path (الأصلي) ──
      const webhookUrl = process.env.SHEETS_WEBHOOK_URL;
      const payload = { password: adminPassword, action: action };
      if (action === 'bulk_replace') {
        payload.records = body.records;
      } else {
        payload.record = body.record;
      }

      console.log(`[sheet-update] forwarding ${action} to Apps Script`);
      const bodyStr = JSON.stringify(payload);

      const postRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: bodyStr,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });

      let finalText = '';
      if([301, 302, 303, 307, 308].includes(postRes.status)){
        const location = postRes.headers.get('location');
        if(location){
          const getRes = await fetch(location, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30000) });
          finalText = await getRes.text();
        } else {
          finalText = await postRes.text();
        }
      } else {
        finalText = await postRes.text();
      }

      let webhookData;
      try { webhookData = JSON.parse(finalText); }
      catch(_) { webhookData = { ok: false, raw: finalText.slice(0, 500) }; }

      if (webhookData.ok === false) {
        const errMsg = webhookData.error || 'خطأ غير معروف من Apps Script';
        const userMsg = errMsg === 'unauthorized'
          ? 'الرمز في Apps Script لا يطابق INVOICE_PASSWORD.'
          : `خطأ من Apps Script: ${errMsg}`;
        return jsonResponse(400, { error: 'script_error', message: userMsg }, corsHeaders());
      }

      console.log(`[sheet-update] ${action} success via Google Sheets`);
      return jsonResponse(200, {
        ok: true,
        action: action,
        message: getSuccessMessage(action),
        webhook_response: webhookData,
      }, corsHeaders());
    }

  } catch (err) {
    console.error('[sheet-update] error:', err.message);
    if(err.code === 'server_not_configured'){
      return jsonResponse(500, { error: 'server_not_configured', message: err.message }, corsHeaders());
    }
    if(err.code === 'duplicate' || err.status === 409){
      return jsonResponse(409, { error: 'duplicate', message: 'رمز الطلب (order_code) موجود مسبقاً.' }, corsHeaders());
    }
    if(err.code === 'source_unavailable' || err.code === 'db_error' || err.code === 'auth_error'){
      return jsonResponse(502, { error: 'db_error', message: 'خطأ أثناء الاتصال بقاعدة البيانات: ' + err.message }, corsHeaders());
    }
    return jsonResponse(500, { error: 'internal_error', message: 'خطأ داخلي: ' + err.message }, corsHeaders());
  }
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
function getSuccessMessage(action){
  const messages = {
    'add':           'تمت إضافة العميل بنجاح.',
    'update':        'تم تحديث بيانات العميل بنجاح.',
    'delete':        'تم حذف العميل بنجاح.',
    'bulk_replace':  'تم استبدال كل البيانات بنجاح.',
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
