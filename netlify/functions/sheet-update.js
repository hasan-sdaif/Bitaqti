// netlify/functions/sheet-update.js — النسخة المدمجة (لا تحتاج lib/)
// ════════════════════════════════════════════════════════════════

exports.config = {
  path: '/.netlify/functions/sheet-update',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
//  Supabase config + request (مُضمَّن)
// ─────────────────────────────────────────────────────────────
function getSupabaseConfig(){
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();
  if(!url || !serviceKey){
    const err = new Error('SUPABASE_URL أو SUPABASE_SERVICE_KEY غير مضبوطين في Netlify.');
    err.code = 'server_not_configured'; err.name = 'ConfigError';
    throw err;
  }
  if(!/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(url)){
    const err = new Error('SUPABASE_URL يجب أن يكون بالصيغة https://xxxxx.supabase.co');
    err.code = 'server_not_configured'; err.name = 'ConfigError';
    throw err;
  }
  return { url, serviceKey };
}

class ConfigError extends Error {
  constructor(msg){ super(msg); this.name = 'ConfigError'; this.code = 'server_not_configured'; }
}

async function sbRequest(path, options = {}){
  const { url, serviceKey } = getSupabaseConfig();
  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'Prefer': options.prefer || 'return=representation',
  };
  let res;
  try {
    res = await fetch(`${url}/rest/v1/${path}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch(networkErr){
    const err = new Error('تعذّر الاتصال بـ Supabase.');
    err.code = 'db_unreachable';
    throw err;
  }
  if(res.status === 401 || res.status === 403){
    const err = new Error('مفتاح Supabase غير صالح.');
    err.code = 'auth_error'; err.status = res.status;
    throw err;
  }
  if(res.status === 409){
    const err = new Error('تضارب — السجل موجود مسبقاً.');
    err.code = 'duplicate'; err.status = 409;
    throw err;
  }
  if(!res.ok){
    let detail = '';
    try { detail = await res.text(); } catch(_) {}
    const err = new Error(`خطأ من Supabase (HTTP ${res.status}): ${detail.slice(0, 200)}`);
    err.code = 'db_error'; err.status = res.status;
    throw err;
  }
  if(res.status === 204) return [];
  let json;
  try { json = await res.json(); } catch(_) { json = []; }
  return json;
}

async function sbInsert(table, record){ return await sbRequest(encodeURIComponent(table), { method: 'POST', prefer: 'return=representation', body: record }); }
async function sbUpdateWhere(table, filter, values){ return await sbRequest(`${encodeURIComponent(table)}?${filter}`, { method: 'PATCH', prefer: 'return=representation', body: values }); }
async function sbDeleteWhere(table, filter){ return await sbRequest(`${encodeURIComponent(table)}?${filter}`, { method: 'DELETE', prefer: 'return=representation' }); }
async function sbDeleteAll(table){ return await sbRequest(`${encodeURIComponent(table)}?id=gte.0`, { method: 'DELETE', prefer: 'return=representation' }); }
async function sbPing(){ await sbRequest(`${encodeURIComponent('customers')}?select=id&limit=1`, { method: 'GET' }); return true; }

// ═══ أعمدة جدول customers ═══
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

exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return jsonResponse(204, null, corsHeaders());
  if(event.httpMethod !== 'POST') return jsonResponse(405, { error: 'method_not_allowed', message: 'الطريقة غير مسموحة.' }, corsHeaders());

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_){
    return jsonResponse(400, { error: 'invalid_request', message: 'صيغة الطلب غير صحيحة.' }, corsHeaders());
  }

  const adminPassword = String(body.password || '');
  const correctPassword = process.env.INVOICE_PASSWORD;

  if(!correctPassword){
    return jsonResponse(500, { error: 'server_not_configured', message: 'INVOICE_PASSWORD غير مضبوط على الخادم.' }, corsHeaders());
  }
  if(!adminPassword){
    return jsonResponse(401, { error: 'missing_password', message: 'يرجى إدخال رمز الأمان.' }, corsHeaders());
  }
  if(!timingSafeStringEqual(adminPassword, correctPassword)){
    return jsonResponse(401, { error: 'wrong_password', message: 'رمز الأمان غير صحيح.' }, corsHeaders());
  }

  const action = String(body.action || '').trim();

  if(action === 'test'){
    try {
      await sbPing();
      return jsonResponse(200, { ok: true, action: 'test', message: 'الاتصال بقاعدة البيانات (Supabase) يعمل.' }, corsHeaders());
    } catch(e){
      if(e instanceof ConfigError || e.code === 'server_not_configured'){
        return jsonResponse(500, { error: 'server_not_configured', message: e.message }, corsHeaders());
      }
      return jsonResponse(502, { error: 'db_unreachable', message: 'تعذّر الوصول إلى قاعدة البيانات. تحقق من SUPABASE_URL و SUPABASE_SERVICE_KEY.' }, corsHeaders());
    }
  }

  const validActions = ['add', 'update', 'delete', 'bulk_replace'];
  if(!validActions.includes(action)){
    return jsonResponse(400, { error: 'invalid_action', message: `action يجب أن يكون أحد: ${validActions.join(', ')}` }, corsHeaders());
  }

  if(action === 'bulk_replace'){
    if(!Array.isArray(body.records)) return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
  } else {
    if(!body.record || typeof body.record !== 'object') return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
  }

  function cleanRecord(rec){
    const out = {};
    CUSTOMER_COLUMNS.forEach(col => {
      if(rec[col] !== undefined) out[col] = rec[col] === '' ? null : rec[col];
    });
    return out;
  }

  try {
    let dbResponse;
    if(action === 'add'){
      const record = cleanRecord(body.record);
      dbResponse = await sbInsert('customers', record);
    } else if(action === 'update'){
      const record = cleanRecord(body.record);
      const orderCode = String(body.record.order_code || '').trim();
      const phone = String(body.record.phone || '').trim();
      const code  = String(body.record.code  || '').trim();
      let updated = [];
      if(orderCode) updated = await sbUpdateWhere('customers', `order_code=eq.${encodeURIComponent(orderCode)}`, record);
      if((!updated || updated.length === 0) && phone && code){
        updated = await sbUpdateWhere('customers', `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`, record);
      }
      if(!updated || updated.length === 0){
        dbResponse = await sbInsert('customers', record);
      } else {
        dbResponse = updated;
      }
    } else if(action === 'delete'){
      const orderCode = String(body.record.order_code || '').trim();
      const phone = String(body.record.phone || '').trim();
      const code  = String(body.record.code  || '').trim();
      let deleted = [];
      if(orderCode) deleted = await sbDeleteWhere('customers', `order_code=eq.${encodeURIComponent(orderCode)}`);
      if((!deleted || deleted.length === 0) && phone && code){
        deleted = await sbDeleteWhere('customers', `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`);
      }
      dbResponse = deleted;
    } else if(action === 'bulk_replace'){
      const records = body.records.map(cleanRecord);
      await sbDeleteAll('customers');
      dbResponse = records.length ? await sbInsert('customers', records) : [];
    }

    return jsonResponse(200, { ok: true, action, message: getSuccessMessage(action), db_response: dbResponse }, corsHeaders());
  } catch(err){
    if(err instanceof ConfigError || err.code === 'server_not_configured') return jsonResponse(500, { error: 'server_not_configured', message: err.message }, corsHeaders());
    if(err.status === 409) return jsonResponse(409, { error: 'duplicate', message: 'رمز الطلب (order_code) موجود مسبقاً.' }, corsHeaders());
    return jsonResponse(502, { error: 'db_error', message: 'خطأ أثناء الاتصال بقاعدة البيانات (Supabase).' }, corsHeaders());
  }
};

function getSuccessMessage(action){
  const messages = {
    'add': 'تمت إضافة العميل بنجاح إلى قاعدة البيانات.',
    'update': 'تم تحديث بيانات العميل بنجاح في قاعدة البيانات.',
    'delete': 'تم حذف العميل بنجاح من قاعدة البيانات.',
    'bulk_replace': 'تم استبدال كل البيانات في قاعدة البيانات بنجاح.',
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
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}

function jsonResponse(statusCode, payload, extraHeaders = {}){
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    body: payload ? JSON.stringify(payload) : '',
  };
}
