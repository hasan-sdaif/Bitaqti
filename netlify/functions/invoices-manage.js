// netlify/functions/invoices-manage.js
// ════════════════════════════════════════════════════════════════
//  إدارة الفواتير على Supabase (CRUD + bulk_sync)
//
//  الإجراءات (action):
//    • list         — جلب كل الفواتير
//    • get          — فاتورة واحدة (by invoice_no)
//    • add          — إضافة فاتورة
//    • update       — تعديل فاتورة (by invoice_no)
//    • delete       — حذف فاتورة
//    • bulk_sync    — مزامنة كاملة (يمسح كل الفواتير ويضيف الجديدة)
//                    — مفيد لرفع الفواتير الموجودة في localStorage إلى Supabase
//    • test         — اختبار اتصال
//
//  كل الإجراءات تتطلب كلمة المرور (INVOICE_PASSWORD).
// ════════════════════════════════════════════════════════════════

exports.config = {
  path: '/.netlify/functions/invoices-manage',
  rateLimit: {
    windowLimit: 60,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const crypto = require('crypto');
const { sbSelectAll, sbInsert, sbUpdateWhere, sbDeleteWhere, sbDeleteAll, sbPing, ConfigError } = require('./lib/supabase');

// أعمدة جدول invoices المسموح كتابتها
const INVOICE_COLUMNS = [
  'invoice_no', 'order_code', 'phone', 'customer_name',
  'issue_date', 'due_date', 'package', 'items_summary',
  'subtotal', 'discount_amount', 'vat_amount', 'total',
  'payment_method', 'payment_status', 'status', 'notes',
];

exports.handler = async (event) => {
  // ── CORS preflight ──
  if(event.httpMethod === 'OPTIONS'){
    return jsonResponse(204, null, corsHeaders());
  }
  if(event.httpMethod !== 'POST'){
    return jsonResponse(405, { error: 'method_not_allowed', message: 'الطريقة غير مسموحة.' }, corsHeaders());
  }

  // parse body
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_){
    return jsonResponse(400, { error: 'invalid_request', message: 'صيغة الطلب غير صحيحة.' }, corsHeaders());
  }

  // ═══ التحقق من كلمة السر ═══
  const adminPassword = String(body.password || '');
  const correctPassword = process.env.INVOICE_PASSWORD;

  if(!correctPassword){
    console.error('[invoices-manage] INVOICE_PASSWORD env var not set');
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'INVOICE_PASSWORD غير مضبوط على الخادم.',
    }, corsHeaders());
  }

  if(!adminPassword){
    return jsonResponse(401, {
      error: 'missing_password',
      message: 'يرجى إدخال رمز الأمان.',
    }, corsHeaders());
  }

  if(!timingSafeStringEqual(adminPassword, correctPassword)){
    console.warn('[invoices-manage] failed admin login attempt');
    return jsonResponse(401, {
      error: 'wrong_password',
      message: 'رمز الأمان غير صحيح.',
    }, corsHeaders());
  }

  const action = String(body.action || '').trim();

  // ═══ وضع اختبار ═══
  if(action === 'test'){
    try {
      await sbPing();
      return jsonResponse(200, {
        ok: true,
        action: 'test',
        message: 'الاتصال بقاعدة البيانات (Supabase) يعمل بشكل صحيح',
      }, corsHeaders());
    } catch(e){
      if(e instanceof ConfigError){
        return jsonResponse(500, { error: 'server_not_configured', message: e.message }, corsHeaders());
      }
      console.error('[invoices-manage] test failed', e);
      return jsonResponse(502, {
        error: 'db_unreachable',
        message: 'تعذّر الوصول إلى قاعدة البيانات. تحقق من SUPABASE_URL و SUPABASE_SERVICE_KEY.',
      }, corsHeaders());
    }
  }

  const validActions = ['list', 'get', 'add', 'update', 'delete', 'bulk_sync'];
  if(!validActions.includes(action)){
    return jsonResponse(400, {
      error: 'invalid_action',
      message: `action يجب أن يكون أحد: ${validActions.join(', ')}`,
    }, corsHeaders());
  }

  // تنظيف سجل الفاتورة: نُبقي فقط الأعمدة المعروفة
  function cleanRecord(rec){
    const out = {};
    INVOICE_COLUMNS.forEach(col => {
      if(rec[col] !== undefined) out[col] = rec[col] === '' ? null : rec[col];
    });
    return out;
  }

  try {
    let dbResponse;

    // ═══ LIST: جلب كل الفواتير ═══
    if(action === 'list'){
      dbResponse = await sbSelectAll('invoices', { order: 'id.desc' });
      return jsonResponse(200, {
        ok: true,
        action: 'list',
        invoices: dbResponse,
        count: dbResponse.length,
        fetched_at: new Date().toISOString(),
      }, corsHeaders());
    }

    // ═══ GET: فاتورة واحدة ═══
    if(action === 'get'){
      const invoiceNo = String(body.invoice_no || '').trim();
      if(!invoiceNo){
        return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب.' }, corsHeaders());
      }
      dbResponse = await sbSelectAll(`invoices?invoice_no=eq.${encodeURIComponent(invoiceNo)}&limit=1`);
      if(!dbResponse || dbResponse.length === 0){
        return jsonResponse(404, { error: 'not_found', message: 'الفاتورة غير موجودة.' }, corsHeaders());
      }
      return jsonResponse(200, {
        ok: true,
        action: 'get',
        invoice: dbResponse[0],
      }, corsHeaders());
    }

    // ═══ ADD: إضافة فاتورة ═══
    if(action === 'add'){
      if(!body.record || typeof body.record !== 'object'){
        return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
      }
      const record = cleanRecord(body.record);
      if(!record.invoice_no){
        return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب.' }, corsHeaders());
      }
      dbResponse = await sbInsert('invoices', record);
      console.log('[invoices-manage] add success:', record.invoice_no);
      return jsonResponse(200, {
        ok: true,
        action: 'add',
        message: 'تمت إضافة الفاتورة بنجاح.',
        invoice: Array.isArray(dbResponse) ? dbResponse[0] : dbResponse,
      }, corsHeaders());
    }

    // ═══ UPDATE: تعديل فاتورة ═══
    if(action === 'update'){
      if(!body.record || typeof body.record !== 'object'){
        return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
      }
      const record = cleanRecord(body.record);
      const invoiceNo = String(body.record.invoice_no || body.invoice_no || '').trim();
      if(!invoiceNo){
        return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب للتعديل.' }, corsHeaders());
      }
      // لو record يحتوي invoice_no جديد، نزيله من قيم التعديل (لا نريد تغيير المفتاح)
      const updateValues = { ...record };
      delete updateValues.invoice_no;
      dbResponse = await sbUpdateWhere('invoices', `invoice_no=eq.${encodeURIComponent(invoiceNo)}`, updateValues);
      if(!dbResponse || dbResponse.length === 0){
        // لم يجد الصف — أضفه بدل أن تضيع البيانات
        dbResponse = await sbInsert('invoices', record);
        console.log('[invoices-manage] update fallback to insert:', invoiceNo);
      } else {
        console.log('[invoices-manage] update success:', invoiceNo);
      }
      return jsonResponse(200, {
        ok: true,
        action: 'update',
        message: 'تم تحديث الفاتورة بنجاح.',
        invoice: Array.isArray(dbResponse) ? dbResponse[0] : dbResponse,
      }, corsHeaders());
    }

    // ═══ DELETE: حذف فاتورة ═══
    if(action === 'delete'){
      const invoiceNo = String(body.invoice_no || (body.record && body.record.invoice_no) || '').trim();
      if(!invoiceNo){
        return jsonResponse(400, { error: 'invalid_request', message: 'invoice_no مطلوب للحذف.' }, corsHeaders());
      }
      dbResponse = await sbDeleteWhere('invoices', `invoice_no=eq.${encodeURIComponent(invoiceNo)}`);
      console.log('[invoices-manage] delete:', invoiceNo);
      return jsonResponse(200, {
        ok: true,
        action: 'delete',
        message: 'تم حذف الفاتورة بنجاح.',
        deleted_count: Array.isArray(dbResponse) ? dbResponse.length : 0,
      }, corsHeaders());
    }

    // ═══ BULK_SYNC: رفع كل الفواتير دفعة واحدة ═══
    if(action === 'bulk_sync'){
      if(!Array.isArray(body.records)){
        return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
      }
      const records = body.records.map(cleanRecord).filter(r => r.invoice_no);
      // امسح القديم وأضف الجديد
      await sbDeleteAll('invoices');
      let inserted = [];
      if(records.length){
        inserted = await sbInsert('invoices', records);
      }
      console.log('[invoices-manage] bulk_sync success:', records.length, 'invoices');
      return jsonResponse(200, {
        ok: true,
        action: 'bulk_sync',
        message: `تمت مزامنة ${records.length} فاتورة بنجاح.`,
        count: records.length,
        synced_at: new Date().toISOString(),
      }, corsHeaders());
    }

  } catch(err){
    console.error('[invoices-manage] internal error', err);
    if(err instanceof ConfigError){
      return jsonResponse(500, { error: 'server_not_configured', message: err.message }, corsHeaders());
    }
    if(err.status === 409){
      return jsonResponse(409, {
        error: 'duplicate',
        message: 'رقم الفاتورة موجود مسبقاً — استخدم رقماً مختلفاً أو حدّث الفاتورة الموجودة.',
      }, corsHeaders());
    }
    return jsonResponse(502, {
      error: 'db_error',
      message: 'خطأ أثناء الاتصال بقاعدة البيانات (Supabase).',
    }, corsHeaders());
  }
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

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
