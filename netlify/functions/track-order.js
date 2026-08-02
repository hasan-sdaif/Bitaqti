// netlify/functions/track-order.js — النسخة المدمجة (لا تحتاج lib/)
// ════════════════════════════════════════════════════════════════
//  كل كود الاتصال بـ Supabase مُضمَّن هنا — لا حاجة لمجلد lib/.
//  هذا يحل مشكلة 502 التي كانت تحدث لو لم يُرفع lib/supabase.js.
// ════════════════════════════════════════════════════════════════

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
//  إعداد Supabase (مُضمَّن — لا يعتمد على lib/)
// ─────────────────────────────────────────────────────────────
function getSupabaseConfig(){
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  // ندعم المفاتيح الجديدة (sb_secret_xxx) والقديمة (eyJ... أو service_role)
  // SUPABASE_SERVICE_KEY هو المتغير الأساسي، لكن ندعم أيضاً SUPABASE_SECRET_KEY كبديل
  const serviceKey = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  if(!url || !serviceKey){
    const err = new Error('SUPABASE_URL أو SUPABASE_SERVICE_KEY غير مضبوطين في Netlify.');
    err.code = 'server_not_configured';
    err.name = 'ConfigError';
    throw err;
  }
  // تحقق من صحة الرابط — يجب أن يبدأ بـ https:// وينتهي بـ .supabase.co
  if(!/^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(url)){
    const err = new Error('SUPABASE_URL يجب أن يكون بالصيغة https://xxxxx.supabase.co — راجع SETUP_GUIDE.md');
    err.code = 'server_not_configured';
    err.name = 'ConfigError';
    throw err;
  }
  // تحقق من صحة شكل المفتاح (sb_secret_ أو eyJ أو أي سلسلة طويلة)
  if(serviceKey.length < 30){
    const err = new Error('SUPABASE_SERVICE_KEY يبدو قصيراً جداً — تأكد من نسخ المفتاح كاملاً (sb_secret_xxx أو eyJ...).');
    err.code = 'server_not_configured';
    err.name = 'ConfigError';
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
  const fullUrl = `${url}/rest/v1/${path}`;
  let res;
  try {
    res = await fetch(fullUrl, {
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
  'referral_code', 'referral_points', 'referred_by',
];

const REFERRAL_POINTS_PER_SUCCESS = 100;
const REFERRAL_DISCOUNT_PERCENT = 20;
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
  if(event.httpMethod === 'OPTIONS'){
    return jsonResponse(204, null, corsHeaders());
  }
  if(event.httpMethod !== 'POST'){
    return jsonResponse(405, { error: 'method_not_allowed', message: 'الطريقة غير مسموحة.' }, corsHeaders());
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_){
    return jsonResponse(400, { error: 'invalid_request', message: 'صيغة الطلب غير صحيحة.' }, corsHeaders());
  }

  if(body.admin_password !== undefined) return await handleAdminSync(body);
  if(body.referral_code !== undefined && body.referral_code !== '') return await handleReferralValidate(body);
  return await handleCustomerTrack(body);
};

async function handleAdminSync(body){
  const adminPassword = String(body.admin_password || '').trim();
  const correctPassword = process.env.INVOICE_PASSWORD;
  if(!correctPassword){
    return jsonResponse(500, { error: 'server_not_configured', message: 'INVOICE_PASSWORD غير مضبوط.' }, corsHeaders());
  }
  if(!adminPassword){
    return jsonResponse(401, { error: 'missing_password', message: 'يرجى إدخال رمز الأمان.' }, corsHeaders());
  }
  if(!timingSafeStringEqual(adminPassword, correctPassword)){
    return jsonResponse(401, { error: 'wrong_password', message: 'رمز الأمان غير صحيح.' }, corsHeaders());
  }

  try {
    const rawRows = await sbSelectAll('customers', { order: 'id.desc' });
    let dataRows = rawRows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    });
    dataRows = dataRows.map(r => normalizeRow(r));

    const filterStatus  = String(body.filter_status  || '').trim();
    const filterPayment = String(body.filter_payment || '').trim();
    const search        = String(body.search         || '').trim().toLowerCase();

    if(filterStatus)  dataRows = dataRows.filter(r => String(r.status || '').trim() === filterStatus);
    if(filterPayment) dataRows = dataRows.filter(r => String(r.payment_status || '').trim() === filterPayment);
    if(search){
      dataRows = dataRows.filter(r => {
        const haystack = [r.customer_name, r.phone, r.order_code, r.package, r.customer_email, r.cv_link, r.assigned_designer]
          .map(v => String(v || '').toLowerCase()).join(' ');
        return haystack.includes(search);
      });
    }
    dataRows.sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')));

    const stats = computeStats(dataRows);
    return jsonResponse(200, {
      ok: true, mode: 'admin_sync', customers: dataRows,
      count: dataRows.length, stats, fetched_at: new Date().toISOString(),
    }, corsHeaders());
  } catch(err){
    if(err instanceof ConfigError || err.code === 'server_not_configured'){
      return jsonResponse(500, { error: 'server_not_configured', message: err.message }, corsHeaders());
    }
    return jsonResponse(502, { error: 'source_unavailable', message: 'تعذّر الوصول إلى قاعدة البيانات. تحقق من SUPABASE_URL (يجب أن يبدأ بـ https:// وينتهي بـ .supabase.co) و SUPABASE_SERVICE_KEY في Netlify.' }, corsHeaders());
  }
}

async function handleReferralValidate(body){
  const referralCode = String(body.referral_code || '').trim().toUpperCase();
  if(!referralCode){
    return jsonResponse(400, { ok: false, valid: false, message: 'يرجى إدخال كود الإحالة.' }, corsHeaders());
  }
  try {
    const rawRows = await sbSelectAll('customers');
    const dataRows = rawRows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    }).map(r => normalizeRow(r));

    const referrer = dataRows.find(r => String(r.referral_code || '').trim().toUpperCase() === referralCode);
    if(!referrer){
      return jsonResponse(200, { ok: true, valid: false, message: 'كود الإحالة غير صحيح أو غير موجود.' }, corsHeaders());
    }
    return jsonResponse(200, {
      ok: true, valid: true, discount_percent: REFERRAL_DISCOUNT_PERCENT,
      referrer_name: referrer.customer_name || '', referral_code: referralCode,
    }, corsHeaders());
  } catch(err){
    if(err instanceof ConfigError || err.code === 'server_not_configured'){
      return jsonResponse(500, { ok: false, error: 'server_not_configured', message: 'قاعدة البيانات غير مُعدّة.' }, corsHeaders());
    }
    return jsonResponse(502, { ok: false, valid: false, message: 'تعذّر الوصول إلى قاعدة البيانات.' }, corsHeaders());
  }
}

async function handleCustomerTrack(body){
  let phone = cleanPhoneInput(String(body.phone || '').trim());
  let code  = cleanCodeInput(String(body.code  || '').trim());
  if(!phone || !code){
    return jsonResponse(400, { error: 'missing_fields', message: 'يرجى إدخال رقم الهاتف ورمز التحقق.' }, corsHeaders());
  }
  try {
    const rawRows = await sbSelectAll('customers');
    const dataRows = rawRows.filter(r => {
      const p = String(r.phone || '').trim();
      return p && /^[\d.+]+$/.test(p);
    });
    if(!dataRows.length){
      return jsonResponse(404, { error: 'not_found', message: 'لا توجد بيانات في قاعدة البيانات بعد.' }, corsHeaders());
    }

    const phoneVariants = buildPhoneVariants(phone);
    const match = dataRows.find(r => {
      const rowPhone = cleanPhoneFromSheet(r.phone);
      const rowCode  = cleanCodeFromSheet(r.code);
      if(!rowPhone || !rowCode) return false;
      const phoneMatch = phoneVariants.includes(rowPhone) || phoneVariants.includes('+' + rowPhone);
      const codeMatch  = rowCode === code;
      return phoneMatch && codeMatch;
    });

    if(!match){
      const phoneExists = dataRows.some(r => {
        const rp = cleanPhoneFromSheet(r.phone);
        return phoneVariants.includes(rp) || phoneVariants.includes('+' + rp);
      });
      if(phoneExists){
        return jsonResponse(404, { error: 'wrong_code', message: 'رمز التحقق غير صحيح لهذا الرقم.' }, corsHeaders());
      }
      return jsonResponse(404, { error: 'not_found', message: 'لم يتم العثور على طلب برقم الهاتف ورمز التحقق المُدخلين.' }, corsHeaders());
    }

    if(!match.referral_code) match.referral_code = generateReferralCode(match.customer_name || match.phone || '');
    if(match.referral_points === undefined || match.referral_points === '') match.referral_points = 0;

    const safeOrder = {};
    for(const k of SAFE_FIELDS){
      if(match[k] !== undefined && match[k] !== '') safeOrder[k] = normalizeValue(k, match[k]);
    }
    ['price', 'vat_amount', 'discount_amount', 'total_with_vat', 'order_count'].forEach(k => {
      if(safeOrder[k] !== undefined && safeOrder[k] !== ''){
        const n = Number(String(safeOrder[k]).replace(/[^0-9.\-]/g, ''));
        if(!isNaN(n)) safeOrder[k] = n;
      }
    });
    safeOrder.progress_percent = STATUS_PROGRESS[safeOrder.status] ?? 0;
    safeOrder.timeline = buildTimeline(match.actions_log);

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
    safeOrder.referral_config = {
      points_per_referral: REFERRAL_POINTS_PER_SUCCESS,
      discount_percent: REFERRAL_DISCOUNT_PERCENT,
      rewards: POINTS_REWARDS,
    };

    return jsonResponse(200, { ok: true, mode: 'customer_track', order: safeOrder, history, fetched_at: new Date().toISOString() }, corsHeaders());
  } catch(err){
    if(err instanceof ConfigError || err.code === 'server_not_configured'){
      return jsonResponse(500, { error: 'server_not_configured', message: 'الخدمة غير مُعدّة.' }, corsHeaders());
    }
    return jsonResponse(502, { error: 'source_unavailable', message: 'تعذّر الاتصال بقاعدة البيانات.' }, corsHeaders());
  }
}

// ─────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────
const DATE_FIELDS = ['order_date', 'payment_date', 'delivery_date', 'last_updated'];
const NUM_FIELDS  = ['price', 'vat_amount', 'discount_amount', 'total_with_vat', 'order_count', 'referral_points'];

function normalizeRow(r){
  const out = { ...r };
  out.phone = cleanPhoneFromSheet(out.phone);
  out.code  = cleanCodeFromSheet(out.code);
  DATE_FIELDS.forEach(f => { if(out[f] !== undefined && out[f] !== '') out[f] = normalizeDate(out[f]); });
  NUM_FIELDS.forEach(f => {
    if(out[f] !== undefined && out[f] !== ''){
      const n = Number(String(out[f]).replace(/[^0-9.\-]/g, ''));
      if(!isNaN(n)) out[f] = n;
    }
  });
  if(!out.referral_code) out.referral_code = generateReferralCode(out.customer_name || out.phone || '');
  if(out.referral_points === undefined || out.referral_points === '') out.referral_points = 0;
  return out;
}

function generateReferralCode(name){
  const cleanName = String(name || '').replace(/[^\u0600-\u06FFa-zA-Z]/g, '');
  let letters = '';
  if(/[\u0600-\u06FF]/.test(cleanName)){
    const map = {'ا':'A','ب':'B','ت':'T','ث':'S','ج':'J','ح':'H','خ':'K','د':'D','ذ':'Z','ر':'R','ز':'Z','س':'S','ش':'X','ص':'C','ض':'D','ط':'T','ظ':'Z','ع':'A','غ':'G','ف':'F','ق':'Q','ك':'K','ل':'L','م':'M','ن':'N','ه':'H','و':'W','ي':'Y','ى':'Y','ء':'A','أ':'A','إ':'I','آ':'A','ؤ':'W','ئ':'Y','ة':'T'};
    const chars = cleanName.split('').filter(c => map[c]);
    letters = (map[chars[0]] || 'X') + (map[chars[1]] || 'X') + (map[chars[2]] || 'X');
  } else {
    letters = cleanName.substring(0, 3).toUpperCase().padEnd(3, 'X');
  }
  const digits = String(Math.floor(100 + Math.random() * 900));
  return letters.toUpperCase() + digits;
}

function cleanPhoneInput(phone){
  let p = String(phone || '').replace(/[\s\-()]/g, '');
  if(p.startsWith('00')) p = '+' + p.slice(2);
  p = p.replace(/(?!^)\+/g, '');
  p = p.replace(/(?!^)[^\d]/g, '');
  return p;
}
function cleanCodeInput(code){
  let c = String(code || '').trim();
  if(/^\d+$/.test(c)) return String(Number(c));
  return c;
}
function cleanPhoneFromSheet(rawPhone){
  if(rawPhone === undefined || rawPhone === null) return '';
  let p = String(rawPhone).trim();
  if(/^[\d.]+$/.test(p) && p.endsWith('.0')) p = p.slice(0, -2);
  p = p.replace(/[\s\-()]/g, '');
  if(p.startsWith('00')) p = '+' + p.slice(2);
  p = p.replace(/(?!^)\+/g, '');
  return p;
}
function cleanCodeFromSheet(rawCode){
  if(rawCode === undefined || rawCode === null) return '';
  let c = String(rawCode).trim();
  if(/^[\d.]+$/.test(c) && c.endsWith('.0')) c = c.slice(0, -2);
  if(/^\d+$/.test(c)) return String(Number(c));
  return c;
}
function buildPhoneVariants(phone){
  const variants = new Set();
  const cleaned = cleanPhoneInput(phone);
  if(!cleaned) return [];
  variants.add(cleaned);
  if(cleaned.startsWith('+')){
    variants.add(cleaned.slice(1));
    const m = cleaned.match(/^\+973(\d{8})$/);
    if(m){ variants.add(m[1]); variants.add('973' + m[1]); variants.add('00973' + m[1]); }
  } else {
    variants.add('+' + cleaned);
    if(/^\d{8}$/.test(cleaned)){ variants.add('973' + cleaned); variants.add('+973' + cleaned); variants.add('00973' + cleaned); }
    if(/^973\d{8}$/.test(cleaned)){ const last8 = cleaned.slice(3); variants.add(last8); variants.add('+' + cleaned); variants.add('00' + cleaned); }
  }
  return [...variants];
}
function normalizeValue(field, value){
  if(value === undefined || value === null || value === '') return '';
  if(DATE_FIELDS.includes(field)) return normalizeDate(value);
  return String(value).trim();
}
function normalizeDate(value){
  if(value === undefined || value === null || value === '') return '';
  const s = String(value).trim();
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})(T.*)?$/);
  if(isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;
  if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)){
    const [d, m, y] = s.split('/');
    return `${d.padStart(2,'0')}/${m.padStart(2,'0')}/${y}`;
  }
  return s;
}
function numOrEmpty(v){
  if(v === undefined || v === null || v === '') return '';
  let s = String(v).trim();
  if(s.endsWith('.0')) s = s.slice(0, -2);
  const n = Number(s.replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? '' : n;
}
function buildTimeline(actionsLog){
  if(!actionsLog || typeof actionsLog !== 'string') return [];
  return String(actionsLog)
    .split('|')
    .map(s => s.trim())
    .filter(Boolean)
    .map(step => {
      const idx = step.indexOf(' - ');
      let date = '', desc = step;
      if(idx > -1){ date = step.slice(0, idx).trim(); desc = step.slice(idx + 3).trim(); }
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
    if(status === 'ملغي') { cancelledCount++; return; }
    if(payment === 'مدفوع') { totalRevenue += total; paidCount++; }
    else if(payment === 'غير مدفوع') { pendingAmount += total; unpaidCount++; }
    else if(payment === 'مدفوع جزئياً') { totalRevenue += total * 0.5; pendingAmount += total * 0.5; }
    const dateStr = String(r.order_date || '');
    const m = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if(m){ const monthKey = `${m[3]}-${m[2].padStart(2, '0')}`; byMonth[monthKey] = (byMonth[monthKey] || 0) + total; }
    const points = Number(r.referral_points || 0);
    if(!isNaN(points)) totalReferralPoints += points;
    if(r.referred_by) totalReferrals++;
  });
  return {
    total_customers: rows.length,
    total_revenue: Math.round(totalRevenue * 1000) / 1000,
    pending_amount: Math.round(pendingAmount * 1000) / 1000,
    paid_count: paidCount, unpaid_count: unpaidCount, cancelled_count: cancelledCount,
    by_package: byPackage, by_status: byStatus, by_month: byMonth,
    total_referral_points: totalReferralPoints, total_referrals: totalReferrals,
    referral_config: { points_per_referral: REFERRAL_POINTS_PER_SUCCESS, discount_percent: REFERRAL_DISCOUNT_PERCENT, rewards: POINTS_REWARDS },
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
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    body: payload ? JSON.stringify(payload) : '',
  };
}
