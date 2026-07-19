// netlify/functions/track-order.js

exports.config = {
  path: '/.netlify/functions/track-order',
  rateLimit: {
    windowLimit: 30,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
//  الحقول الآمنة للإرجاع (لا نُرجع رمز التحقق أبداً)
// ─────────────────────────────────────────────────────────────
const SAFE_FIELDS = [
  'order_code', 'order_date', 'package', 'price', 'status',
  'order_count', 'cv_link', 'actions_log', 'subpage_content',
  'customer_name', 'customer_email', 'customer_country', 'customer_language',
  'payment_method', 'payment_status', 'payment_date',
  'vat_amount', 'discount_amount', 'total_with_vat',
  'delivery_date', 'assigned_designer', 'design_link', 'qr_code_path',
  'invoice_notes', 'last_updated', 'invoice_status',
  // ── حقول نظام الإحالة ──
  'referral_code', 'referral_points', 'referred_by',
];

// ─────────────────────────────────────────────────────────────
//  نظام الإحالة — نقاط تكافؤ الإحالات
// ─────────────────────────────────────────────────────────────
const REFERRAL_POINTS_PER_SUCCESS = 100;  // نقطة لكل إحالة ناجحة
const REFERRAL_DISCOUNT_PERCENT = 20;      // خصم 20% للمُحال
const POINTS_REWARDS = {
  'edit_section':    { cost: 50,  label: 'تعديل قسم في البطاقة' },
  'change_design':   { cost: 100, label: 'تغيير التصميم بالكامل' },
  'free_standard':   { cost: 300, label: 'بطاقة مجانية (الباقة القياسية)' },
  'free_premium':    { cost: 500, label: 'بطاقة مجانية (الباقة المميزة)' },
};

const STATUS_PROGRESS = {
  'قيد التنفيذ': 25, 'بانتظار الدفع': 15, 'تم التصميم': 60,
  'تم التسليم': 100, 'ملغي': 0,
};

// ─────────────────────────────────────────────────────────────
//  Handler الرئيسي
// ─────────────────────────────────────────────────────────────
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

  // ═══════════════════════════════════════════════════════════════
  //  الوضع 1: مزامنة الصاحب (admin_password)
  // ═══════════════════════════════════════════════════════════════
  if (body.admin_password !== undefined) {
    return await handleAdminSync(body);
  }

  // ═══════════════════════════════════════════════════════════════
  //  الوضع 3: التحقق من كود إحالة (عام — بدون كلمة سر)
  //  POST { referral_code: "HS1234" }
  //  → يرجع: { ok, valid, discount_percent, referrer_name }
  // ═══════════════════════════════════════════════════════════════
  if (body.referral_code !== undefined && body.referral_code !== '') {
    return await handleReferralValidate(body);
  }

  // ═══════════════════════════════════════════════════════════════
  //  الوضع 2: تتبع العميل (phone + code)
  // ═══════════════════════════════════════════════════════════════
  return await handleCustomerTrack(body);
};

// ─────────────────────────────────────────────────────────────
//  الوضع 1: مزامنة الصاحب (admin)
// ─────────────────────────────────────────────────────────────
async function handleAdminSync(body){
  const adminPassword = String(body.admin_password || '').trim();
  const correctPassword = process.env.INVOICE_PASSWORD;

  if (!correctPassword) {
    console.error('[track-order/admin] INVOICE_PASSWORD env var not set');
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'رمز الأمان غير مُعدّ على الخادم.',
    }, corsHeaders());
  }

  if (!adminPassword) {
    return jsonResponse(401, {
      error: 'missing_password',
      message: 'يرجى إدخال رمز الأمان.',
    }, corsHeaders());
  }

  // مقارنة بزمن ثابت لمنع timing attacks
  if (!timingSafeStringEqual(adminPassword, correctPassword)) {
    console.warn('[track-order/admin] failed admin login attempt');
    return jsonResponse(401, {
      error: 'wrong_password',
      message: 'رمز الأمان غير صحيح.',
    }, corsHeaders());
  }

  const SHEET_ID = process.env.ORDERS_SHEET_ID;
  if (!SHEET_ID) {
    return jsonResponse(500, { error: 'server_not_configured', message: 'ORDERS_SHEET_ID غير مُعدّ.' }, corsHeaders());
  }

  // ═══ بناء URL التصدير ═══
  // ملاحظة مهمة: بعض أوراق Google Sheets المنشورة لا تقبل gid=0 وتُرجع HTTP 400.
  // الحل: نستخدم URL بدون gid إن لم يُحدّد، أو مع gid إن حُدد بقيمة غير 0.
  const SHEET_GID = process.env.ORDERS_SHEET_GID || '';
  const csvUrl = SHEET_GID && SHEET_GID !== '0'
    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`
    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

  try {
    const sheetRes = await fetch(csvUrl, { signal: AbortSignal.timeout(15000) });
    if (!sheetRes.ok) {
      console.error('[track-order/admin] sheet fetch failed', sheetRes.status, csvUrl);
      const msg = sheetRes.status === 400
        ? 'تعذّر الوصول إلى Google Sheets (HTTP 400). تأكد أن الشيت منشور للعامة: File → Share → Publish to web. أو أن ORDERS_SHEET_GID صحيح.'
        : sheetRes.status === 404
        ? 'الشيت غير موجود — تحقق من ORDERS_SHEET_ID.'
        : `تعذّر الوصول إلى Google Sheets (HTTP ${sheetRes.status}).`;
      return jsonResponse(502, { error: 'source_unavailable', message: msg }, corsHeaders());
    }

    const csvText = await sheetRes.text();

    // تحقق إن كان الرد HTML (خطأ) بدلاً من CSV
    if (csvText.trimStart().startsWith('<!DOCTYPE') || csvText.trimStart().startsWith('<html')) {
      console.error('[track-order/admin] got HTML instead of CSV');
      return jsonResponse(502, {
        error: 'source_unavailable',
        message: 'الشيت غير منشور للعامة. افتح Google Sheets → File → Share → Publish to web → Entire document → CSV.',
      }, corsHeaders());
    }

    const rows = parseCSV(csvText);

    // نتخطّى صف العناوين العربية تلقائياً
    let dataRows = rows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    });

    // تطبيع كل صف
    dataRows = dataRows.map(r => normalizeRow(r));

    // فلترة اختيارية (للأدمن أيضاً)
    const filterStatus  = String(body.filter_status  || '').trim();
    const filterPayment = String(body.filter_payment || '').trim();
    const search        = String(body.search         || '').trim().toLowerCase();

    if (filterStatus)  dataRows = dataRows.filter(r => String(r.status || '').trim() === filterStatus);
    if (filterPayment) dataRows = dataRows.filter(r => String(r.payment_status || '').trim() === filterPayment);
    if (search) {
      dataRows = dataRows.filter(r => {
        const haystack = [r.customer_name, r.phone, r.order_code, r.package, r.customer_email, r.cv_link, r.assigned_designer]
          .map(v => String(v || '').toLowerCase()).join(' ');
        return haystack.includes(search);
      });
    }

    // ترتيب حسب التاريخ تنازلياً
    dataRows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));

    const stats = computeStats(dataRows);

    console.log('[track-order/admin] sync success:', { count: dataRows.length });

    return jsonResponse(200, {
      ok: true,
      mode: 'admin_sync',
      customers: dataRows,
      count: dataRows.length,
      stats,
      fetched_at: new Date().toISOString(),
    }, corsHeaders());
  } catch (err) {
    console.error('[track-order/admin] internal error', err);
    return jsonResponse(500, { error: 'internal_error', message: 'خطأ داخلي في الخادم.' }, corsHeaders());
  }
}

// ─────────────────────────────────────────────────────────────
//  الوضع 3: التحقق من كود إحالة (عام)
//  POST { referral_code: "HS1234" }
//  → { ok, valid, discount_percent, referrer_name }
// ─────────────────────────────────────────────────────────────
async function handleReferralValidate(body){
  const referralCode = String(body.referral_code || '').trim().toUpperCase();

  if(!referralCode){
    return jsonResponse(400, { ok: false, valid: false, message: 'يرجى إدخال كود الإحالة.' }, corsHeaders());
  }

  const SHEET_ID = process.env.ORDERS_SHEET_ID;
  if (!SHEET_ID) {
    return jsonResponse(500, { ok: false, error: 'server_not_configured' }, corsHeaders());
  }

  const SHEET_GID = process.env.ORDERS_SHEET_GID || '';
  const csvUrl = SHEET_GID && SHEET_GID !== '0'
    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`
    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

  try {
    const sheetRes = await fetch(csvUrl, { signal: AbortSignal.timeout(10000) });
    if (!sheetRes.ok) {
      return jsonResponse(502, { ok: false, valid: false, message: 'تعذّر الوصول إلى الخادم.' }, corsHeaders());
    }
    const csvText = await sheetRes.text();
    if (csvText.trimStart().startsWith('<!DOCTYPE') || csvText.trimStart().startsWith('<html')) {
      return jsonResponse(502, { ok: false, valid: false, message: 'الشيت غير منشور.' }, corsHeaders());
    }
    const rows = parseCSV(csvText);
    const dataRows = rows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    }).map(r => normalizeRow(r));

    // البحث عن العميل صاحب كود الإحالة
    const referrer = dataRows.find(r => {
      const rc = String(r.referral_code || '').trim().toUpperCase();
      return rc === referralCode;
    });

    if(!referrer){
      return jsonResponse(200, {
        ok: true,
        valid: false,
        message: 'كود الإحالة غير صحيح أو غير موجود.',
      }, corsHeaders());
    }

    return jsonResponse(200, {
      ok: true,
      valid: true,
      discount_percent: REFERRAL_DISCOUNT_PERCENT,
      referrer_name: referrer.customer_name || '',
      referral_code: referralCode,
    }, corsHeaders());

  } catch(err){
    console.error('[track-order/referral] error', err);
    return jsonResponse(500, { ok: false, valid: false, message: 'خطأ داخلي.' }, corsHeaders());
  }
}

// ─────────────────────────────────────────────────────────────
//  الوضع 2: تتبع العميل (phone + code)
// ─────────────────────────────────────────────────────────────
async function handleCustomerTrack(body){
  let phone = String(body.phone || '').trim();
  let code  = String(body.code  || '').trim();

  phone = cleanPhoneInput(phone);
  code  = cleanCodeInput(code);

  if (!phone || !code) {
    return jsonResponse(400, { error: 'missing_fields', message: 'يرجى إدخال رقم الهاتف ورمز التحقق.' }, corsHeaders());
  }

  const SHEET_ID = process.env.ORDERS_SHEET_ID;
  if (!SHEET_ID) {
    return jsonResponse(500, { error: 'server_not_configured', message: 'الخدمة غير مُعدّة بشكل صحيح.' }, corsHeaders());
  }

  // ═══ بناء URL التصدير (بدون gid إن لم يُحدّد لتجنب HTTP 400) ═══
  const SHEET_GID = process.env.ORDERS_SHEET_GID || '';
  const csvUrl = SHEET_GID && SHEET_GID !== '0'
    ? `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`
    : `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

  try {
    const sheetRes = await fetch(csvUrl, { signal: AbortSignal.timeout(10000) });
    if (!sheetRes.ok) {
      console.error('[track-order/customer] sheet fetch failed', sheetRes.status, csvUrl);
      const msg = sheetRes.status === 400
        ? 'تعذّر الوصول إلى Google Sheets (HTTP 400). تأكد أن الشيت منشور للعامة.'
        : sheetRes.status === 404
        ? 'الشيت غير موجود — تحقق من ORDERS_SHEET_ID.'
        : `تعذّر الوصول إلى مصدر البيانات (HTTP ${sheetRes.status}).`;
      return jsonResponse(502, { error: 'source_unavailable', message: msg }, corsHeaders());
    }

    const csvText = await sheetRes.text();

    // تحقق إن كان الرد HTML (خطأ) بدلاً من CSV
    if (csvText.trimStart().startsWith('<!DOCTYPE') || csvText.trimStart().startsWith('<html')) {
      console.error('[track-order/customer] got HTML instead of CSV');
      return jsonResponse(502, {
        error: 'source_unavailable',
        message: 'الشيت غير منشور للعامة. افتح Google Sheets → File → Share → Publish to web.',
      }, corsHeaders());
    }

    const rows = parseCSV(csvText);
    const dataRows = rows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    });

    if (!dataRows.length) {
      return jsonResponse(404, { error: 'not_found', message: 'لا توجد بيانات في قاعدة البيانات بعد.' }, corsHeaders());
    }

    // مطابقة مرنة
    const phoneVariants = buildPhoneVariants(phone);
    const match = dataRows.find(r => {
      const rowPhone = cleanPhoneFromSheet(r.phone);
      const rowCode  = cleanCodeFromSheet(r.code);
      if (!rowPhone || !rowCode) return false;
      const phoneMatch = phoneVariants.includes(rowPhone) || phoneVariants.includes('+' + rowPhone);
      const codeMatch  = rowCode === code;
      return phoneMatch && codeMatch;
    });

    if (!match) {
      const phoneExists = dataRows.some(r => {
        const rp = cleanPhoneFromSheet(r.phone);
        return phoneVariants.includes(rp) || phoneVariants.includes('+' + rp);
      });
      if (phoneExists) {
        return jsonResponse(404, { error: 'wrong_code', message: 'رمز التحقق غير صحيح لهذا الرقم. تأكّد من الرسالة التي استلمتها.' }, corsHeaders());
      }
      return jsonResponse(404, { error: 'not_found', message: 'لم يتم العثور على طلب برقم الهاتف ورمز التحقق المُدخلين.' }, corsHeaders());
    }

    // بناء كائن الطلب الآمن
    const safeOrder = {};
    for (const k of SAFE_FIELDS) {
      if (match[k] !== undefined && match[k] !== '') {
        safeOrder[k] = normalizeValue(k, match[k]);
      }
    }

    // تحويل الأرقام
    ['price', 'vat_amount', 'discount_amount', 'total_with_vat', 'order_count'].forEach(k => {
      if (safeOrder[k] !== undefined && safeOrder[k] !== '') {
        const n = Number(String(safeOrder[k]).replace(/[^0-9.\-]/g, ''));
        if (!isNaN(n)) safeOrder[k] = n;
      }
    });

    safeOrder.progress_percent = STATUS_PROGRESS[safeOrder.status] ?? 0;
    safeOrder.timeline = buildTimeline(match.actions_log);

    // سجل الطلبات السابقة لنفس الرقم
    const history = dataRows
      .filter(r => {
        const rp = cleanPhoneFromSheet(r.phone);
        const rc = cleanCodeFromSheet(r.code);
        return phoneVariants.includes(rp) && rc === code;
      })
      .map(r => ({
        order_code: r.order_code || '',
        order_date: normalizeValue('order_date', r.order_date) || '',
        package: r.package || '',
        status: r.status || '',
        total_with_vat: numOrEmpty(r.total_with_vat || r.price),
        cv_link: r.cv_link || '',
      }))
      .filter(h => h.order_code !== safeOrder.order_code)
      .sort((a, b) => String(b.order_date).localeCompare(String(a.order_date)));

    const orderCount = dataRows.filter(r => {
      const rp = cleanPhoneFromSheet(r.phone);
      return phoneVariants.includes(rp);
    }).length;
    safeOrder.total_orders_for_phone = orderCount;

    // ═══ إضافة معلومات نظام الإحالة للعميل ═══
    safeOrder.referral_config = {
      points_per_referral: REFERRAL_POINTS_PER_SUCCESS,
      discount_percent: REFERRAL_DISCOUNT_PERCENT,
      rewards: POINTS_REWARDS,
    };

    return jsonResponse(200, {
      ok: true,
      mode: 'customer_track',
      order: safeOrder,
      history,
      fetched_at: new Date().toISOString(),
    }, corsHeaders());
  } catch (err) {
    console.error('[track-order/customer] internal error', err);
    return jsonResponse(500, { error: 'internal_error', message: 'خطأ داخلي في الخادم.' }, corsHeaders());
  }
}

// ─────────────────────────────────────────────────────────────
//  Helpers — تنظيف وتطبيع البيانات
// ─────────────────────────────────────────────────────────────

const DATE_FIELDS = ['order_date', 'payment_date', 'delivery_date', 'last_updated'];
const NUM_FIELDS  = ['price', 'vat_amount', 'discount_amount', 'total_with_vat', 'order_count', 'referral_points'];

function normalizeRow(r){
  const out = { ...r };
  out.phone = cleanPhoneFromSheet(out.phone);
  out.code  = cleanCodeFromSheet(out.code);
  DATE_FIELDS.forEach(f => {
    if (out[f] !== undefined && out[f] !== '') out[f] = normalizeDate(out[f]);
  });
  NUM_FIELDS.forEach(f => {
    if (out[f] !== undefined && out[f] !== '') {
      const n = Number(String(out[f]).replace(/[^0-9.\-]/g, ''));
      if (!isNaN(n)) out[f] = n;
    }
  });
  // ═══ توليد كود إحالة تلقائي إن لم يوجد ═══
  if(!out.referral_code){
    out.referral_code = generateReferralCode(out.customer_name || out.phone || '');
  }
  // ضمان أن referral_points رقم
  if(out.referral_points === undefined || out.referral_points === ''){
    out.referral_points = 0;
  }
  return out;
}

/** يولّد كود إحالة من حرفين + 4 أرقام (مثل: HS1234) */
function generateReferralCode(name){
  // استخراج أول حرفين من الاسم (تجاهل المسافات والرموز)
  const cleanName = String(name || '').replace(/[^\u0600-\u06FFa-zA-Z]/g, '');
  let letters = '';
  // إن كان الاسم عربياً، نحوّل أول حرفين لصيغة لاتينية مبسّطة
  if(/[\u0600-\u06FF]/.test(cleanName)){
    // خذ أول حرفين من transliteration بسيط
    const map = {'ا':'A','ب':'B','ت':'T','ث':'S','ج':'J','ح':'H','خ':'K','د':'D','ذ':'Z','ر':'R','ز':'Z','س':'S','ش':'X','ص':'C','ض':'D','ط':'T','ظ':'Z','ع':'A','غ':'G','ف':'F','ق':'Q','ك':'K','ل':'L','م':'M','ن':'N','ه':'H','و':'W','ي':'Y','ى':'Y','ء':'A','أ':'A','إ':'I','آ':'A','ؤ':'W','ئ':'Y','ة':'T'};
    const chars = cleanName.split('').filter(c => map[c]);
    letters = (map[chars[0]] || 'X') + (map[chars[1]] || 'X');
  } else {
    // إن كان لاتينياً، خذ أول حرفين
    letters = cleanName.substring(0, 2).toUpperCase().padEnd(2, 'X');
  }
  // 4 أرقام عشوائية
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return letters.toUpperCase() + digits;
}

function cleanPhoneInput(phone){
  let p = String(phone || '').replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  p = p.replace(/(?!^)\+/g, '');
  p = p.replace(/(?!^)[^\d]/g, '');
  return p;
}

function cleanCodeInput(code){
  let c = String(code || '').trim();
  if (/^\d+$/.test(c)) return String(Number(c));
  return c;
}

function cleanPhoneFromSheet(rawPhone){
  if (rawPhone === undefined || rawPhone === null) return '';
  let p = String(rawPhone).trim();
  if (/^[\d.]+$/.test(p) && p.endsWith('.0')) p = p.slice(0, -2);
  p = p.replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  p = p.replace(/(?!^)\+/g, '');
  return p;
}

function cleanCodeFromSheet(rawCode){
  if (rawCode === undefined || rawCode === null) return '';
  let c = String(rawCode).trim();
  if (/^[\d.]+$/.test(c) && c.endsWith('.0')) c = c.slice(0, -2);
  if (/^\d+$/.test(c)) return String(Number(c));
  return c;
}

function buildPhoneVariants(phone){
  const variants = new Set();
  const cleaned = cleanPhoneInput(phone);
  if (!cleaned) return [];
  variants.add(cleaned);
  if (cleaned.startsWith('+')) {
    variants.add(cleaned.slice(1));
    const m = cleaned.match(/^\+973(\d{8})$/);
    if (m) {
      variants.add(m[1]);
      variants.add('973' + m[1]);
      variants.add('00973' + m[1]);
    }
  } else {
    variants.add('+' + cleaned);
    if (/^\d{8}$/.test(cleaned)) {
      variants.add('973' + cleaned);
      variants.add('+973' + cleaned);
      variants.add('00973' + cleaned);
    }
    if (/^973\d{8}$/.test(cleaned)) {
      const last8 = cleaned.slice(3);
      variants.add(last8);
      variants.add('+' + cleaned);
      variants.add('00' + cleaned);
    }
  }
  return [...variants];
}

function normalizeValue(field, value){
  if (value === undefined || value === null || value === '') return '';
  if (DATE_FIELDS.includes(field)) return normalizeDate(value);
  return String(value).trim();
}

function normalizeDate(value){
  if (value === undefined || value === null || value === '') return '';
  const s = String(value).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/');
    return `${d.padStart(2,'0')}/${m.padStart(2,'0')}/${y}`;
  }
  return s;
}

function numOrEmpty(v){
  if (v === undefined || v === null || v === '') return '';
  let s = String(v).trim();
  if (s.endsWith('.0')) s = s.slice(0, -2);
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}

function buildTimeline(actionsLog){
  if (!actionsLog || typeof actionsLog !== 'string') return [];
  return String(actionsLog)
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .map(step => {
      const idx = step.indexOf(' - ');
      let date = '';
      let desc = step;
      if (idx > -1) {
        date = step.slice(0, idx).trim();
        desc = step.slice(idx + 3).trim();
      }
      return { date, desc, raw: step };
    });
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

function computeStats(rows){
  let totalRevenue = 0, pendingAmount = 0, paidCount = 0, unpaidCount = 0, cancelledCount = 0;
  let totalReferralPoints = 0, totalReferrals = 0;
  const byPackage = {}, byStatus = {}, byMonth = {};
  rows.forEach(r => {
    const total = Number(String(r.total_with_vat || r.price || 0).toString().replace(/[^0-9.\-]/g, '')) || 0;
    const status = String(r.status || '').trim();
    const payment = String(r.payment_status || '').trim();
    const pkg = String(r.package || '').trim() || 'غير محدد';
    byPackage[pkg] = (byPackage[pkg] || 0) + 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    if (status === 'ملغي') { cancelledCount++; return; }
    if (payment === 'مدفوع') { totalRevenue += total; paidCount++; }
    else if (payment === 'غير مدفوع') { pendingAmount += total; unpaidCount++; }
    else if (payment === 'مدفوع جزئياً') { totalRevenue += total * 0.5; pendingAmount += total * 0.5; }
    const dateStr = String(r.order_date || '');
    const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) {
      const monthKey = `${m[3]}-${m[2].padStart(2, '0')}`;
      byMonth[monthKey] = (byMonth[monthKey] || 0) + total;
    }
    // ═══ إحصائيات الإحالة ═══
    const points = Number(r.referral_points || 0);
    if(!isNaN(points)) totalReferralPoints += points;
    if(r.referred_by) totalReferrals++;
  });
  return {
    total_customers: rows.length,
    total_revenue: Math.round(totalRevenue * 1000) / 1000,
    pending_amount: Math.round(pendingAmount * 1000) / 1000,
    paid_count: paidCount,
    unpaid_count: unpaidCount,
    cancelled_count: cancelledCount,
    by_package: byPackage,
    by_status: byStatus,
    by_month: byMonth,
    // إحصائيات الإحالة
    total_referral_points: totalReferralPoints,
    total_referrals: totalReferrals,
    referral_config: {
      points_per_referral: REFERRAL_POINTS_PER_SUCCESS,
      discount_percent: REFERRAL_DISCOUNT_PERCENT,
      rewards: POINTS_REWARDS,
    },
  };
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

function parseCSVLine(line){
  const result = [];
  let current = '';
  let inQuotes = false;
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) { result.push(current); current = ''; }
    else current += char;
  }
  result.push(current);
  return result;
}

function parseCSV(text){
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  return lines
    .slice(1)
    .filter(l => l.trim())
    .map(line => {
      const values = parseCSVLine(line);
      return Object.fromEntries(headers.map((h, i) => [h, (values[i] || '').trim()]));
    });
}
