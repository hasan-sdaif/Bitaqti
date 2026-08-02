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
const { sbInsert, sbUpdateWhere, sbDeleteWhere, sbDeleteAll, sbPing, ConfigError } = require('./lib/supabase');

// ═══ أعمدة جدول customers المسموح كتابتها (نفس أعمدة supabase_schema.sql) ═══
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

  const action = String(body.action || '').trim();

  // ═══ وضع اختبار: يتحقق من الاتصال بقاعدة البيانات فقط ═══
  if (action === 'test') {
    try {
      await sbPing();
      return jsonResponse(200, {
        ok: true,
        action: 'test',
        message: 'الاتصال بقاعدة البيانات (Supabase) يعمل بشكل صحيح',
      }, corsHeaders());
    } catch (e) {
      if (e instanceof ConfigError) {
        return jsonResponse(500, { error: 'server_not_configured', message: e.message }, corsHeaders());
      }
      console.error('[sheet-update] test failed', e);
      return jsonResponse(502, {
        error: 'db_unreachable',
        message: 'تعذّر الوصول إلى قاعدة البيانات. تحقق من SUPABASE_URL و SUPABASE_SERVICE_KEY.',
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

  if (action === 'bulk_replace') {
    if (!Array.isArray(body.records)) {
      return jsonResponse(400, { error: 'invalid_request', message: 'records يجب أن تكون مصفوفة.' }, corsHeaders());
    }
  } else {
    if (!body.record || typeof body.record !== 'object') {
      return jsonResponse(400, { error: 'invalid_request', message: 'record يجب أن يكون كائناً.' }, corsHeaders());
    }
  }

  // ═══ تنظيف السجل: نُبقي فقط أعمدة جدول customers المعروفة ═══
  function cleanRecord(rec) {
    const out = {};
    CUSTOMER_COLUMNS.forEach(col => {
      if (rec[col] !== undefined) out[col] = rec[col] === '' ? null : rec[col];
    });
    return out;
  }

  try {
    let dbResponse;

    if (action === 'add') {
      const record = cleanRecord(body.record);
      dbResponse = await sbInsert('customers', record);
    }

    else if (action === 'update') {
      const record = cleanRecord(body.record);
      const orderCode = String(body.record.order_code || '').trim();
      const phone = String(body.record.phone || '').trim();
      const code  = String(body.record.code  || '').trim();

      let updated = [];
      if (orderCode) {
        updated = await sbUpdateWhere('customers', `order_code=eq.${encodeURIComponent(orderCode)}`, record);
      }
      if ((!updated || updated.length === 0) && phone && code) {
        updated = await sbUpdateWhere(
          'customers',
          `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`,
          record
        );
      }
      if (!updated || updated.length === 0) {
        // لم يوجد صف مطابق — نضيفه كصف جديد بدلاً من فقدان البيانات
        dbResponse = await sbInsert('customers', record);
      } else {
        dbResponse = updated;
      }
    }

    else if (action === 'delete') {
      const orderCode = String(body.record.order_code || '').trim();
      const phone = String(body.record.phone || '').trim();
      const code  = String(body.record.code  || '').trim();

      let deleted = [];
      if (orderCode) {
        deleted = await sbDeleteWhere('customers', `order_code=eq.${encodeURIComponent(orderCode)}`);
      }
      if ((!deleted || deleted.length === 0) && phone && code) {
        deleted = await sbDeleteWhere(
          'customers',
          `phone=eq.${encodeURIComponent(phone)}&code=eq.${encodeURIComponent(code)}`
        );
      }
      dbResponse = deleted;
    }

    else if (action === 'bulk_replace') {
      const records = body.records.map(cleanRecord);
      await sbDeleteAll('customers');
      dbResponse = records.length ? await sbInsert('customers', records) : [];
    }

    console.log(`[sheet-update] ${action} success`);

    return jsonResponse(200, {
      ok: true,
      action: action,
      message: getSuccessMessage(action),
      db_response: dbResponse,
    }, corsHeaders());

  } catch (err) {
    console.error('[sheet-update] internal error', err);
    if (err instanceof ConfigError) {
      return jsonResponse(500, { error: 'server_not_configured', message: err.message }, corsHeaders());
    }
    if (err.status === 409) {
      return jsonResponse(409, {
        error: 'duplicate',
        message: 'رمز الطلب (order_code) موجود مسبقاً — استخدم رمزاً مختلفاً أو حدّث السجل الموجود بدل الإضافة.',
      }, corsHeaders());
    }
    return jsonResponse(502, {
      error: 'db_error',
      message: 'خطأ أثناء الاتصال بقاعدة البيانات (Supabase). تحقق من SUPABASE_URL و SUPABASE_SERVICE_KEY في Netlify.',
    }, corsHeaders());
  }
};

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────

function getSuccessMessage(action){
  const messages = {
    'add':           'تمت إضافة العميل بنجاح إلى قاعدة البيانات.',
    'update':        'تم تحديث بيانات العميل بنجاح في قاعدة البيانات.',
    'delete':        'تم حذف العميل بنجاح من قاعدة البيانات.',
    'bulk_replace':  'تم استبدال كل البيانات في قاعدة البيانات بنجاح.',
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
