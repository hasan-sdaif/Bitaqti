// netlify/functions/lib/supabase.js
// ─────────────────────────────────────────────────────────────
//  طبقة مساعدة رفيعة للاتصال بـ Supabase من داخل Netlify Functions.
//  تستخدم fetch الأصلي (متوفر في Node 18+) — لا حاجة لأي npm package.
//  الوصول الوحيد يكون عبر مفتاح service_role السرّي الذي يبقى على الخادم
//  ولا يصل أبداً إلى المتصفح. RLS مفعّل في قاعدة البيانات بدون أي policy
//  عامة، لذلك مفتاح anon العام لا يستطيع فعل شيء — وهذا مقصود.
// ─────────────────────────────────────────────────────────────

class ConfigError extends Error {
  constructor(msg){
    super(msg);
    this.name = 'ConfigError';
    this.code = 'server_not_configured';
  }
}

// ─────────────────────────────────────────────────────────────
//  إعداد المفاتيح من متغيرات البيئة في Netlify
// ─────────────────────────────────────────────────────────────
function getConfig(){
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

  if(!url || !serviceKey){
    throw new ConfigError(
      'SUPABASE_URL أو SUPABASE_SERVICE_KEY غير مضبوطين في Netlify. ' +
      'راجع دليل الإعداد في SETUP_GUIDE.md.'
    );
  }

  // التحقق من صحة شكل URL
  try {
    new URL(url);
  } catch(_) {
    throw new ConfigError('SUPABASE_URL ليس رابطاً صالحاً. تأكد أنه يبدأ بـ https://');
  }

  return { url, serviceKey };
}

// ─────────────────────────────────────────────────────────────
//  تنفيذ طلب REST على Supabase (PostgREST)
//  الوثائق: https://supabase.com/docs/reference/api
// ─────────────────────────────────────────────────────────────
async function request(path, options = {}){
  const { url, serviceKey } = getConfig();

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'Prefer': options.prefer || 'return=representation',
    ...options.headers,
  };

  const fullUrl = `${url}/rest/v1/${path}`;

  let res;
  try {
    res = await fetch(fullUrl, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch(networkErr){
    // خطأ شبكة — لا يمكن الوصول لـ Supabase إطلاقاً
    const err = new Error('تعذّر الاتصال بـ Supabase. تحقق من SUPABASE_URL ومن اتصال الإنترنت.');
    err.code = 'db_unreachable';
    err.cause = networkErr;
    throw err;
  }

  // 401 / 403 → مشكلة في المفتاح
  if(res.status === 401 || res.status === 403){
    const err = new Error('مفتاح Supabase السرّي غير صالح أو لا يملك صلاحيات.');
    err.code = 'auth_error';
    err.status = res.status;
    throw err;
  }

  // 409 → تضارب (مثل تكرار order_code)
  if(res.status === 409){
    const err = new Error('تضارب في البيانات — قد يكون السجل موجوداً مسبقاً.');
    err.code = 'duplicate';
    err.status = 409;
    throw err;
  }

  // 4xx / 5xx أخرى
  if(!res.ok){
    let detail = '';
    try { detail = await res.text(); } catch(_) {}
    const err = new Error(`خطأ من Supabase (HTTP ${res.status}): ${detail.slice(0, 300)}`);
    err.code = 'db_error';
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  // 204 No Content (يحدث أحياناً مع DELETE بدون return=representation)
  if(res.status === 204) return [];

  // parse JSON
  let json;
  try {
    json = await res.json();
  } catch(_) {
    json = [];
  }
  return json;
}

// ─────────────────────────────────────────────────────────────
//  الدوال المُصدَّرة — تُستورد باسم sbXxx في الدوال الأخرى
// ─────────────────────────────────────────────────────────────

/**
 * جلب كل صفوف جدول.
 * @param {string} table  اسم الجدول (مثل 'customers')
 * @param {object} opts   { order: 'id.desc', limit: 1000 }
 * @returns {Promise<Array>}
 */
async function sbSelectAll(table, opts = {}){
  let path = encodeURIComponent(table);

  // نطلب فقط الصفوف المرئية (آلاف الصفوف لا مشكلة في الباقة المجانية)
  const params = [];
  if(opts.order)   params.push(`order=${encodeURIComponent(opts.order)}`);
  if(opts.limit)   params.push(`limit=${parseInt(opts.limit, 10)}`);
  else             params.push('limit=100000');  // حد آمن جدّاً
  if(params.length) path += '?' + params.join('&');

  return await request(path, { method: 'GET' });
}

/**
 * إضافة صف (أو صفوف) جديدة.
 * @param {string} table
 * @param {object|object[]} record
 * @returns {Promise<object|object[]>}  الصف المُدرج كما أعاده Supabase
 */
async function sbInsert(table, record){
  const path = encodeURIComponent(table);
  return await request(path, {
    method: 'POST',
    prefer: 'return=representation',
    body: record,
  });
}

/**
 * تحديث الصفوف المطابقة لشرط معين.
 * @param {string} table
 * @param {string} filter  صيغة PostgREST (مثل 'order_code=eq.BH-CV-2026-0001')
 * @param {object} values
 * @returns {Promise<object[]>}  الصفوف المحدّثة
 */
async function sbUpdateWhere(table, filter, values){
  const path = `${encodeURIComponent(table)}?${filter}`;
  return await request(path, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: values,
  });
}

/**
 * حذف الصفوف المطابقة لشرط معين.
 * @param {string} table
 * @param {string} filter
 * @returns {Promise<object[]>}  الصفوف المحذوفة
 */
async function sbDeleteWhere(table, filter){
  const path = `${encodeURIComponent(table)}?${filter}`;
  return await request(path, {
    method: 'DELETE',
    prefer: 'return=representation',
  });
}

/**
 * حذف كل صفوف الجدول.
 * WARNING: تستخدم فقط في bulk_replace.
 */
async function sbDeleteAll(table){
  const path = `${encodeURIComponent(table)}?id=gte.0`;
  return await request(path, {
    method: 'DELETE',
    prefer: 'return=representation',
  });
}

/**
 * اختبار الاتصال بقاعدة البيانات.
 * نطلب أول صف من جدول customers فقط للتأكد أن المفتاح يعمل.
 */
async function sbPing(){
  const path = `${encodeURIComponent('customers')}?select=id&limit=1`;
  await request(path, { method: 'GET' });
  return true;
}

module.exports = {
  ConfigError,
  getConfig,
  sbSelectAll,
  sbInsert,
  sbUpdateWhere,
  sbDeleteWhere,
  sbDeleteAll,
  sbPing,
};
