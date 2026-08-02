// netlify/functions/invoices-manage.js — النسخة المدمجة (لا تحتاج lib/)
// ════════════════════════════════════════════════════════════════

exports.config = {
  path: '/.netlify/functions/invoices-manage',
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

async function sbSelectAll(table, opts = {}){
  let path = encodeURIComponent(table);
  const params = [];
  if(opts.order) params.push(`order=${encodeURIComponent(opts.order)}`);
  params.push('limit=100000');
  if(params.length) path += '?' + params.join('&');
  return await sbRequest(path, { method: 'GET' });
}
async function sbInsert(table, record){ return await sbRequest(encodeURIComponent(table), { method: 'POST', prefer: 'return=representation', body: record }); }
async function sbUpdateWhere(table, filter, values){ return await sbRequest(`${encodeURIComponent(table)}?${filter}`, { method: 'PATCH', prefer: 'return=representation', body: values }); }
async function sbDeleteWhere(table, filter){ return await sbRequest(`${encodeURIComponent(table)}?${filter}`, { method: 'DELETE', prefer: 'return=representation' }); }
async function sbDeleteAll(table){ return await sbRequest(`${encodeURIComponent(table)}?id=gte.0`, { method: 'DELETE', prefer: 'return=representation' }); }
async function sbPing(){ await sbRequest(`${encodeURIComponent('invoices')}?select=id&limit=1`, { method: 'GET' }); return true; }

const INVOICE_COLUMNS = [
  'invoice_no', 'order_code', 'phone', 'customer_name',
  'issue_date', 'due_date', 'package', 'items_summary',
  'subtotal', 'discount_amount', 'vat_amount', 'total',
  'payment_method', 'payment_status', 'status', 'notes',
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
  if(!correctPassword) return jsonResponse(500, { error: 'server_not_configured', message: 'INVOICE_PASSWORD غير مضبوط.' }, corsHeaders());
  if(!adminPassword) return jsonResponse(401, { error: 'missing_password', message: 'يرجى إدخال رمز الأمان.' }, corsHeaders());
  if(!timingSafeStringEqual(adminPassword, correctPassword)) return jsonResponse(401, { error: 'wrong_password', message: 'رمز الأمان غير صحيح.' }, corsHeaders());

  const action = String(body.action || '').trim();

  if(action === 'test'){
    try {
      await sbPing();
      return jsonResponse(200, { ok: true, action: 'test', message: 'الاتصال بقاعدة البيانات (Supabase) يعمل.' }, corsHeaders());
    } catch(e){
      if(e instanceof ConfigError || e.code === 'server_not_configured') return jsonResponse(500, { error: 'server_not_configured', message: e.message }, corsHeaders());
      return jsonResponse(502, { error: 'db_unreachable', message: 'تعذّر الوصول إلى قاعدة البيانات.' }, corsHeaders());
    }
  }

  const validActions = ['list', 'get', 'add', 'update', 'delete', 'bulk_sync'];
  if(!validActions.includes(action)) return jsonResponse(400, { error: 'invalid_action', message: `action يجب أن يكون أحد: ${validActions.join(', ')}` }, corsHeaders());

  function cleanRecord(rec){
    const out = {};
    INVOICE_COLUMNS.forEach(col => { if(rec[col] !== undefined) out[col] = rec[col] === '' ? null : rec[col]; });
    return out;
  }

  try {
    let dbResponse;
    if(action === 'list'){
      dbResponse = await sbSelectAll('invoices', { order: 'id.desc' });
      return jsonResponse(200, { ok: true, action: 'list', invoices: dbResponse, count: dbResponse.length, fetched_at: new Date().toISOString() }, corsHeaders());
    }
    if(action === 'get'){
      const invoiceNo = String(body.invoice_no || '').trim();
      if(!invoiceNo) return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب.' }, corsHeaders());
      dbResponse = await sbSelectAll(`invoices?invoice_no=eq.${encodeURIComponent(invoiceNo)}&limit=1`);
      if(!dbResponse || dbResponse.length === 0) return jsonResponse(404, { error: 'not_found', message: 'الفاتورة غير موجودة.' }, corsHeaders());
      return jsonResponse(200, { ok: true, action: 'get', invoice: dbResponse[0] }, corsHeaders());
    }
    if(action === 'add'){
      if(!body.record || typeof body.record !== 'object') return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
      const record = cleanRecord(body.record);
      if(!record.invoice_no) return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب.' }, corsHeaders());
      dbResponse = await sbInsert('invoices', record);
      return jsonResponse(200, { ok: true, action: 'add', message: 'تمت إضافة الفاتورة بنجاح.', invoice: Array.isArray(dbResponse) ? dbResponse[0] : dbResponse }, corsHeaders());
    }
    if(action === 'update'){
      if(!body.record || typeof body.record !== 'object') return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
      const record = cleanRecord(body.record);
      const invoiceNo = String(body.record.invoice_no || body.invoice_no || '').trim();
      if(!invoiceNo) return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب للتعديل.' }, corsHeaders());
      const updateValues = { ...record };
      delete updateValues.invoice_no;
      dbResponse = await sbUpdateWhere('invoices', `invoice_no=eq.${encodeURIComponent(invoiceNo)}`, updateValues);
      if(!dbResponse || dbResponse.length === 0) dbResponse = await sbInsert('invoices', record);
      return jsonResponse(200, { ok: true, action: 'update', message: 'تم تحديث الفاتورة بنجاح.', invoice: Array.isArray(dbResponse) ? dbResponse[0] : dbResponse }, corsHeaders());
    }
    if(action === 'delete'){
      const invoiceNo = String(body.invoice_no || (body.record && body.record.invoice_no) || '').trim();
      if(!invoiceNo) return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب للحذف.' }, corsHeaders());
      dbResponse = await sbDeleteWhere('invoices', `invoice_no=eq.${encodeURIComponent(invoiceNo)}`);
      return jsonResponse(200, { ok: true, action: 'delete', message: 'تم حذف الفاتورة بنجاح.', deleted_count: Array.isArray(dbResponse) ? dbResponse.length : 0 }, corsHeaders());
    }
    if(action === 'bulk_sync'){
      if(!Array.isArray(body.records)) return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
      const records = body.records.map(cleanRecord).filter(r => r.invoice_no);
      await sbDeleteAll('invoices');
      let inserted = [];
      if(records.length) inserted = await sbInsert('invoices', records);
      return jsonResponse(200, { ok: true, action: 'bulk_sync', message: `تمت مزامنة ${records.length} فاتورة بنجاح.`, count: records.length, synced_at: new Date().toISOString() }, corsHeaders());
    }
  } catch(err){
    if(err instanceof ConfigError || err.code === 'server_not_configured') return jsonResponse(500, { error: 'server_not_configured', message: err.message }, corsHeaders());
    if(err.status === 409) return jsonResponse(409, { error: 'duplicate', message: 'رقم الفاتورة موجود مسبقاً.' }, corsHeaders());
    return jsonResponse(502, { error: 'db_error', message: 'خطأ أثناء الاتصال بقاعدة البيانات (Supabase).' }, corsHeaders());
  }
};

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
