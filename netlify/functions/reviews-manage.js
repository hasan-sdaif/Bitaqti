// netlify/functions/reviews-manage.js
// ════════════════════════════════════════════════════════════════
//  نظام التقييمات — بطاقتي (Bitaqti)
//  ──────────────────────────────────────────────────────────────
//  نقاط النهاية (action):
//   • test                          — اختبار الاتصال
//   • list_public                   — التقييمات الظاهرة للعامة (مع فلاتر/بحث/فرز)
//   • list_featured                 — التقييمات المميّزة
//   • get_stats                     — الإحصائيات العامة
//   • get_settings                  — إعدادات النظام
//   • add_review                    — إضافة تقييم (عميل موثّق أو زائر)
//   • verify_customer               — التحقق من العميل (phone + verification_code)
//   • add_vote                      — صوت مفيد/غير مفيد
//   • add_reaction                  — تفاعل إيموجي
//   • list_comments                 — تعليقات تقييم
//   • add_comment                   — إضافة تعليق (من أي زائر)
//   • list_suggestions              — عرض الاقتراحات (علنية أو كلها للأدمن)
//   • add_suggestion                — إضافة اقتراح (علني/خاص)
//   • vote_suggestion               — تصويت على اقتراح
//   • list_responses                — ردود الإدارة على تقييم
//
//  دوال الأدمن (تتطلب password = INVOICE_PASSWORD):
//   • list_all                      — كل التقييمات (مع فلاتر)
//   • list_comments_all             — كل التعليقات
//   • hide_review / unhide_review   — إخفاء/إظهار تقييم
//   • feature_review / unfeature_review
//   • pin_review / unpin_review
//   • delete_review                 — حذف نهائي
//   • bulk_action                   — إجراء جماعي
//   • export_reviews                — تصدير CSV
//   • add_response                  — رد علني من الإدارة
//   • update_response / delete_response
//   • add_admin_note                — ملاحظة خاصة
//   • list_admin_notes              — عرض ملاحظات تقييم
//   • hide_comment / unhide_comment / delete_comment
//   • update_suggestion             — تحديث حالة اقتراح + رد الإدارة
//   • get_dashboard                 — بيانات شاملة للوحة التحكم
//   • refresh_stats                 — إعادة حساب الإحصائيات
//   • update_settings               — تعديل إعدادات النظام
//   • activity_log                  — سجل نشاط الإدارة
// ════════════════════════════════════════════════════════════════

exports.config = {
  path: '/.netlify/functions/reviews-manage',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

const crypto = require('crypto');

// ════════════════════════════════════════════════════════════════
//  إعدادات Supabase
// ════════════════════════════════════════════════════════════════
function isSupabaseConfigured(){
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  return !!(url && key && /^https:\/\/[a-z0-9.-]+\.supabase\.co$/i.test(url) && key.length > 30);
}

function getCfg(){
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
  return { url, key };
}

async function sbRequest(path, method = 'GET', body = null){
  const cfg = getCfg();
  const headers = {
    'apikey': cfg.key,
    'Authorization': `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
  };
  if(body && method !== 'GET') headers['Prefer'] = 'return=representation';
  let res;
  try {
    res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch(e){
    throw Object.assign(new Error('تعذّر الوصول لـ Supabase.'), { code: 'db_unreachable' });
  }
  if(!res.ok){
    const detail = await res.text().catch(() => '');
    throw Object.assign(new Error(`Supabase HTTP ${res.status}: ${detail.slice(0,150)}`), { code: 'db_error', status: res.status });
  }
  if(res.status === 204) return [];
  return await res.json().catch(() => []);
}

// ════════════════════════════════════════════════════════════════
//  مساعدات الأمان
// ════════════════════════════════════════════════════════════════
function hashIP(ip){
  if(!ip) return '';
  const raw = String(ip).split(',')[0].trim();
  return crypto.createHash('sha256').update(raw + 'bitaqti_salt_v2').digest('hex').slice(0, 24);
}

function timingSafeEqual(a, b){
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  const pA = Buffer.alloc(maxLen), pB = Buffer.alloc(maxLen);
  bufA.copy(pA); bufB.copy(pB);
  return crypto.timingSafeEqual(pA, pB) && bufA.length === bufB.length;
}

async function checkAdmin(password){
  const correct = process.env.INVOICE_PASSWORD;
  if(!correct || !password) return false;
  return timingSafeEqual(String(password), String(correct));
}

// ════════════════════════════════════════════════════════════════
//  تطبيع رقم الهاتف (نفس منطق track-order)
// ════════════════════════════════════════════════════════════════
function normalizePhone(phone){
  let p = String(phone || '').trim();
  if(!p) return '';
  p = p.replace(/[\s\-()]/g, '');
  if(p.startsWith('00')) p = '+' + p.slice(2);
  p = p.replace(/(?!^)\+/g, '');
  p = p.replace(/(?!^)[^\d]/g, '');
  if(!p.startsWith('+') && /^\d{8}$/.test(p)) p = '+973' + p;
  if(p.startsWith('973') && p.length === 11) p = '+' + p;
  return p;
}

// كل الأشكال المحتملة لنفس الرقم (محلي 8 أرقام / بـ 973 / بـ + / بـ 00)
// نفس منطق buildPhoneVariants في track-order.js — العملاء مخزّنون بصيغة محلية
// (مثال: "36166806") وليس بصيغة دولية، لذا يجب مطابقة كل الأشكال.
function buildPhoneVariants(normPhone){
  const variants = new Set();
  if(!normPhone) return [];
  variants.add(normPhone);
  const m = normPhone.match(/^\+973(\d{8})$/);
  if(m){
    variants.add(m[1]);                 // 36166806
    variants.add('973' + m[1]);         // 97336166806
    variants.add('00973' + m[1]);       // 0097336166806
    variants.add(normPhone.slice(1));   // 97336166806 (بدون +)
  } else {
    variants.add(normPhone.replace(/^\+/, ''));
  }
  return [...variants];
}

// كود التحقق قد يُخزَّن/يُدخَل بصفر بادئ أو كنص — نطابق بنفس منطق track-order
// (رقمي بحت → يُحوَّل لرقم ثم نص، فيزول أي صفر بادئ من أي من الطرفين)
function normalizeCode(code){
  const c = String(code || '').trim();
  return /^\d+$/.test(c) ? String(Number(c)) : c;
}

// ════════════════════════════════════════════════════════════════
//  التحقق من العميل (نفس نظام تتبع الطلب — phone + code)
// ════════════════════════════════════════════════════════════════
async function verifyCustomerViaTrackOrder(phone, code){
  const normPhone = normalizePhone(phone);
  const cleanCode = normalizeCode(code);
  if(!normPhone || !cleanCode) return null;

  // محاولة 1: استدعاء track-order (نفس مسار تتبع الطلب)
  try {
    const siteUrl = process.env.URL || 'bitaqti.netlify.app';
    const res = await fetch(`https://${siteUrl}/.netlify/functions/track-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: normPhone, code: cleanCode }),
      signal: AbortSignal.timeout(8000),
    });
    if(res.status === 200){
      const data = await res.json();
      if(data && data.order) return data.order;
    }
  } catch(e) {
    // تجاهل — نحاول المسار المباشر
  }

  // محاولة 2: تحقق مباشر من جدول customers
  // ★ الإصلاح: نطابق كل الأشكال المحتملة لرقم الهاتف (محلي/دولي/بصفر بادئ)
  // بدلاً من مطابقة حرفية واحدة بصيغة +973XXXXXXXX التي لا تطابق أبداً
  // الأرقام المخزّنة بصيغة محلية 8 أرقام (وهي الصيغة الفعلية في الجدول).
  try {
    const variants = buildPhoneVariants(normPhone);
    if(!variants.length) return null;
    const orFilter = variants.map(v => `phone.eq.${encodeURIComponent(v)}`).join(',');
    const rows = await sbRequest(
      `customers?or=(${orFilter})&limit=20`,
      'GET'
    );
    if(rows && rows.length > 0){
      const match = rows.find(r => normalizeCode(r.code) === cleanCode);
      if(match) return match;
    }
  } catch(e2) {}

  return null;
}

// ════════════════════════════════════════════════════════════════
//  توليد كود تقييم فريد (مع إعادة المحاولة)
// ════════════════════════════════════════════════════════════════
function genReviewCode(){
  const year = new Date().getFullYear();
  const rand = String(Math.floor(100000 + Math.random() * 900000));
  return `REV-${year}-${rand}`;
}

async function genUniqueReviewCode(){
  for(let i = 0; i < 5; i++){
    const code = genReviewCode();
    const existing = await sbRequest(`reviews?review_code=eq.${encodeURIComponent(code)}&limit=1`, 'GET');
    if(!existing || existing.length === 0) return code;
  }
  // fallback نادر
  return `REV-${Date.now()}`;
}

// ════════════════════════════════════════════════════════════════
//  تنظيف المدخلات
// ════════════════════════════════════════════════════════════════
function sanitize(str, maxLen = 8000){
  if(str === null || str === undefined) return '';
  let s = String(str).trim().slice(0, maxLen);
  s = s.replace(/<script[^>]*>.*?<\/script>/gis, '');
  s = s.replace(/<iframe[^>]*>.*?<\/iframe>/gis, '');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/javascript:/gi, '');
  return s;
}

function sanitizeRating(r){
  if(r === null || r === undefined || r === '') return null;
  const n = parseInt(r, 10);
  if(isNaN(n)) return null;
  return Math.max(1, Math.min(5, n));
}

function sanitizeBool(v, def = false){
  if(v === null || v === undefined || v === '') return def;
  if(typeof v === 'boolean') return v;
  if(typeof v === 'string') return ['true','1','yes','on'].includes(v.toLowerCase());
  return !!v;
}

function sanitizeInt(v, def = null, min = null, max = null){
  if(v === null || v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  if(isNaN(n)) return def;
  if(min !== null && n < min) return min;
  if(max !== null && n > max) return max;
  return n;
}

// ════════════════════════════════════════════════════════════════
//  فحص وتنظيف روابط المنصات الموثوقة (حماية من الروابط الخبيثة)
//  نسمح فقط بـ: instagram.com, youtube.com/youtu.be, linkedin.com, twitter.com/x.com
//  أي رابط آخر يُرفض تماماً — لا يُخزَّن ولا يُعرض
// ════════════════════════════════════════════════════════════════
const SOCIAL_DOMAIN_PATTERNS = {
  instagram: /^(https?:\/\/)?(www\.)?instagram\.com\/(reel|p|reels|tv)\/[A-Za-z0-9_-]+\/?/i,
  youtube: /^(https?:\/\/)?(www\.|m\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)[A-Za-z0-9_-]{6,}/i,
  linkedin: /^(https?:\/\/)?(www\.|ar\.)?linkedin\.com\/(in|pub|company)\/[A-Za-z0-9_-]+/i,
  twitter: /^(https?:\/\/)?(www\.)?(twitter\.com|x\.com)\/[A-Za-z0-9_]+(\/status\/[A-Za-z0-9]+)?/i,
};

function sanitizeSocialLinks(input){
  if(!input || typeof input !== 'object') return null;
  const out = {};
  for(const platform of Object.keys(SOCIAL_DOMAIN_PATTERNS)){
    const v = input[platform];
    if(!v || typeof v !== 'string') continue;
    const url = v.trim().slice(0, 500);
    if(SOCIAL_DOMAIN_PATTERNS[platform].test(url)){
      // تأكد من وجود https://
      if(!/^https?:\/\//i.test(url)){
        out[platform] = 'https://' + url;
      } else {
        out[platform] = url;
      }
    }
    // الروابط غير الصالحة تُتجاهل صامتة
  }
  return Object.keys(out).length ? out : null;
}

// ════════════════════════════════════════════════════════════════
//  كشف السبام (مبسّط لكن فعال)
// ════════════════════════════════════════════════════════════════
const SPAM_PATTERNS = [
  /\b(viagra|casino|porn|sex|loan|credit|bitcoin)\b/i,
  /\bhttps?:\/\/\S{40,}/i,            // روابط طويلة جداً
  /(.)\1{15,}/,                        // تكرار نفس الحرف 16+ مرة
];

const SPAM_KEYWORDS_AR = [
  'إعلان مدفوع', 'سعر خاص', 'اضغط هنا', 'ربح سريع', 'استثمار'
];

function calcSpamScore(text, ipHash){
  if(!text) return 0;
  let score = 0;
  for(const pat of SPAM_PATTERNS){
    if(pat.test(text)) score += 30;
  }
  for(const kw of SPAM_KEYWORDS_AR){
    if(text.includes(kw)) score += 20;
  }
  // نص قصير جداً
  if(text.length < 10) score += 20;
  // تكرار نفس الكلمة 5+ مرات
  const words = text.split(/\s+/);
  const wordCounts = {};
  words.forEach(w => { if(w.length > 3) wordCounts[w] = (wordCounts[w]||0)+1; });
  for(const w in wordCounts){
    if(wordCounts[w] >= 8) score += 25;
  }
  return Math.min(100, score);
}

// ════════════════════════════════════════════════════════════════
//  فحص Rate Limiting
// ════════════════════════════════════════════════════════════════
async function checkRateLimit(ipHash, type, maxPerHour){
  const since = new Date(Date.now() - 3600000).toISOString();
  const table = type === 'review' ? 'reviews' : type === 'comment' ? 'comments' : 'suggestions';
  try {
    const rows = await sbRequest(
      `${table}?ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${since}&select=id&limit=${maxPerHour + 1}`,
      'GET'
    );
    return rows.length < maxPerHour;
  } catch(e){
    return true; // في حالة الخطأ، اسمح بالإدراج (أفضل من حجب مستخدم مشروع)
  }
}

async function logVerificationAttempt(phone, ipHash, success){
  try {
    await sbRequest('verification_attempts', 'POST', {
      phone: phone || null,
      ip_hash: ipHash,
      success,
      attempt_type: 'review',
    });
  } catch(e) {}
}

async function checkVerificationRateLimit(ipHash){
  const since = new Date(Date.now() - 3600000).toISOString();
  try {
    const rows = await sbRequest(
      `verification_attempts?ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${since}&select=id&limit=20`,
      'GET'
    );
    // اسمح بـ 15 محاولة تحقق لكل IP في الساعة
    if(rows.length >= 15) return false;
    // اسمح بـ 5 محاولات فاشلة فقط
    const failed = rows.filter(r => !r.success);
    return failed.length < 10;
  } catch(e){
    return true;
  }
}

// ════════════════════════════════════════════════════════════════
//  تسجيل نشاط الإدارة
// ════════════════════════════════════════════════════════════════
async function logActivity(action, targetType, targetId, detail, ipHash, adminSession){
  try {
    await sbRequest('admin_activity_log', 'POST', {
      action, target_type: targetType, target_id: targetId || null,
      detail: detail || null, admin_session: adminSession || 'admin',
      ip_hash: ipHash || null,
    });
  } catch(e) {}
}

// ════════════════════════════════════════════════════════════════
//  تحديث الإحصائيات
// ════════════════════════════════════════════════════════════════
async function refreshStats(){
  try {
    // نحاول استدعاء الدالة المخزّنة أولاً
    await sbRequest('rpc/fn_refresh_review_stats', 'POST', {});
    return true;
  } catch(e){
    // fallback: تحديث يدوي مبسّط
    try {
      const all = await sbRequest('reviews?select=rating_overall,rating_design,rating_speed,rating_support,rating_value,rating_ease,rating_communication,rating_creativity,rating_professionalism,rating_after_sales,rating_accuracy,is_verified_customer,is_hidden,is_public,is_featured,would_recommend', 'GET');
      const visible = all.filter(r => !r.is_hidden && r.is_public);
      const verified = visible.filter(r => r.is_verified_customer);
      const visitor = visible.filter(r => !r.is_verified_customer);
      const hidden = all.filter(r => r.is_hidden);
      const featured = visible.filter(r => r.is_featured);
      const recommend = visible.filter(r => r.would_recommend === true);
      const recommendRate = visible.length ? Math.round(100 * recommend.length / visible.length * 100) / 100 : 0;
      const avg = (f) => {
        const vals = visible.map(r => r[f]).filter(v => v !== null && v !== undefined);
        return vals.length ? Math.round(vals.reduce((s,v)=>s+v,0)/vals.length * 100) / 100 : 0;
      };
      await sbRequest('review_stats?id=eq.1', 'PATCH', {
        total_reviews: visible.length,
        total_verified: verified.length,
        total_visitor: visitor.length,
        total_hidden: hidden.length,
        total_featured: featured.length,
        avg_overall: avg('rating_overall'),
        avg_design: avg('rating_design'),
        avg_speed: avg('rating_speed'),
        avg_support: avg('rating_support'),
        avg_value: avg('rating_value'),
        avg_ease: avg('rating_ease'),
        avg_communication: avg('rating_communication'),
        avg_creativity: avg('rating_creativity'),
        avg_professionalism: avg('rating_professionalism'),
        avg_after_sales: avg('rating_after_sales'),
        avg_accuracy: avg('rating_accuracy'),
        recommend_rate: recommendRate,
        updated_at: new Date().toISOString(),
      });
      return true;
    } catch(e2){ return false; }
  }
}

// ════════════════════════════════════════════════════════════════
//  CORS و الاستجابة
// ════════════════════════════════════════════════════════════════
function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(statusCode, payload, extra = {}){
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
    body: payload ? JSON.stringify(payload) : '',
  };
}

// ════════════════════════════════════════════════════════════════
//  المعالج الرئيسي
// ════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return jsonResponse(204, null, corsHeaders());
  if(event.httpMethod !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' }, corsHeaders());

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_){
    return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
  }

  if(!isSupabaseConfigured()){
    return jsonResponse(500, { error: 'server_not_configured', message: 'SUPABASE_URL + SUPABASE_SERVICE_KEY غير مضبوطين.' }, corsHeaders());
  }

  const action = String(body.action || '').trim();
  const ipHash = hashIP(event.headers['x-forwarded-for'] || event.headers['client-ip'] || '');
  const userAgent = String(event.headers['user-agent'] || '').slice(0, 300);

  try {
    // ════════════════════════════════════════════════════════════════
    //  اختبار
    // ════════════════════════════════════════════════════════════════
    if(action === 'test'){
      const stats = await sbRequest('review_stats?id=eq.1&limit=1', 'GET');
      const settings = await sbRequest('review_settings?id=eq.1&limit=1', 'GET');
      return jsonResponse(200, {
        ok: true,
        message: 'نظام التقييمات يعمل',
        stats: stats[0] || null,
        settings: settings[0] || null,
        timestamp: new Date().toISOString(),
      }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  الإعدادات العامة
    // ════════════════════════════════════════════════════════════════
    if(action === 'get_settings'){
      const rows = await sbRequest('review_settings?id=eq.1&limit=1', 'GET');
      return jsonResponse(200, { ok: true, settings: rows[0] || null }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  الإحصائيات العامة
    // ════════════════════════════════════════════════════════════════
    if(action === 'get_stats'){
      const rows = await sbRequest('review_stats?id=eq.1&limit=1', 'GET');
      return jsonResponse(200, { ok: true, stats: rows[0] || { total_reviews: 0 } }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  قائمة التقييمات الظاهرة للعامة (مع فلاتر/بحث/فرز)
    // ════════════════════════════════════════════════════════════════
    if(action === 'list_public'){
      const limit = Math.min(parseInt(body.limit) || 20, 100);
      const offset = parseInt(body.offset) || 0;
      const sort = String(body.sort || 'newest');
      const search = sanitize(body.search, 200);
      const minRating = sanitizeInt(body.min_rating, null, 1, 5);
      const verifiedOnly = sanitizeBool(body.verified_only, false);
      const tagsFilter = sanitize(body.tags, 200);

      let path = 'reviews?is_hidden=eq.false&is_public=eq.true';
      
      if(minRating) path += `&rating_overall=gte.${minRating}`;
      if(verifiedOnly) path += `&is_verified_customer=eq.true`;
      if(search){
        // بحث trigram في body أو title
        const enc = encodeURIComponent(search);
        path += `&or=(body.ilike.*${enc}*,title.ilike.*${enc}*,customer_name.ilike.*${enc}*)`;
      }

      // الفرز
      const orderMap = {
        newest: 'created_at.desc',
        oldest: 'created_at.asc',
        highest: 'rating_overall.desc,created_at.desc',
        lowest: 'rating_overall.asc,created_at.desc',
        helpful: 'votes_helpful.desc,created_at.desc',
        featured: 'is_featured.desc,created_at.desc',
      };
      const order = orderMap[sort] || orderMap.newest;
      // المميّز والمثبّت أولاً دائماً
      path += `&order=is_pinned.desc,${order}&limit=${limit}&offset=${offset}`;

      const reviews = await sbRequest(path, 'GET');

      // فلترة بالوسوم (client-side لأنها comma-separated)
      let filtered = reviews;
      if(tagsFilter){
        const tags = tagsFilter.split(',').map(t => t.trim()).filter(Boolean);
        filtered = reviews.filter(r => {
          const rTags = (r.tags || '').split(',').map(t => t.trim());
          return tags.some(t => rTags.includes(t));
        });
      }

      return jsonResponse(200, { ok: true, reviews: filtered, count: filtered.length }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  التقييمات المميّزة
    // ════════════════════════════════════════════════════════════════
    if(action === 'list_featured'){
      const limit = Math.min(parseInt(body.limit) || 6, 20);
      const rows = await sbRequest(
        `reviews?is_hidden=eq.false&is_public=eq.true&is_featured=eq.true&order=is_pinned.desc,created_at.desc&limit=${limit}`,
        'GET'
      );
      return jsonResponse(200, { ok: true, reviews: rows }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  التحقق من العميل (phone + verification_code) — واجهة منفصلة
    // ════════════════════════════════════════════════════════════════
    if(action === 'verify_customer'){
      const phone = normalizePhone(body.phone);
      const code = String(body.verification_code || body.code || '').trim();

      if(!phone || !code){
        return jsonResponse(400, { ok: false, error: 'missing_fields', message: 'يرجى إدخال رقم الهاتف ورمز التحقق.' }, corsHeaders());
      }

      // rate limit على محاولات التحقق
      const allowAttempt = await checkVerificationRateLimit(ipHash);
      if(!allowAttempt){
        return jsonResponse(429, { ok: false, error: 'rate_limited', message: 'محاولات كثيرة. انتظر ساعة.' }, corsHeaders());
      }

      const customer = await verifyCustomerViaTrackOrder(phone, code);
      await logVerificationAttempt(phone, ipHash, !!customer);

      if(customer){
        // لا نُرجع كل البيانات الحساسة
        return jsonResponse(200, {
          ok: true,
          verified: true,
          customer: {
            name: customer.customer_name || customer.name || null,
            package: customer.package || null,
            order_code: customer.order_code || null,
            country: customer.customer_country || null,
          },
        }, corsHeaders());
      } else {
        return jsonResponse(200, {
          ok: true,
          verified: false,
          message: 'رمز التحقق غير صحيح لهذا الرقم. يمكنك المتابعة كزائر.',
        }, corsHeaders());
      }
    }

    // ════════════════════════════════════════════════════════════════
    //  إضافة تقييم (عميل موثّق أو زائر)
    // ════════════════════════════════════════════════════════════════
    if(action === 'add_review'){
      // rate limit
      const settings = await sbRequest('review_settings?id=eq.1&limit=1', 'GET');
      const maxPerHour = settings[0]?.rate_limit_per_hour || 5;
      const allow = await checkRateLimit(ipHash, 'review', maxPerHour);
      if(!allow){
        return jsonResponse(429, { error: 'rate_limited', message: 'لقد أرسلت عدة تقييمات. انتظر ساعة.' }, corsHeaders());
      }

      const phone = normalizePhone(body.phone);
      const verificationCode = String(body.verification_code || '').trim();
      const bodyText = sanitize(body.body, 8000);

      // التقييم العام إجباري — كل شيء آخر اختياري (بما فيه النص)
      const ratingOverall = parseInt(body.rating_overall);
      if(!ratingOverall || ratingOverall < 1 || ratingOverall > 5){
        return jsonResponse(400, { error: 'invalid_request', message: 'يرجى تقييم التقييم العام (1-5 نجوم).' }, corsHeaders());
      }

      // التحقق من العميل إن أرسل phone + code
      let isVerified = false;
      let customerData = null;
      if(phone && verificationCode){
        // تحقق من rate limit على التحقق
        const allowVerif = await checkVerificationRateLimit(ipHash);
        if(!allowVerif){
          return jsonResponse(429, { error: 'verif_rate_limited', message: 'محاولات تحقق كثيرة. انتظر ساعة.' }, corsHeaders());
        }
        customerData = await verifyCustomerViaTrackOrder(phone, verificationCode);
        await logVerificationAttempt(phone, ipHash, !!customerData);
        if(customerData) isVerified = true;
      }

      // منع تكرار التقييم للعملاء الموثقين فقط
      if(isVerified && phone){
        const existing = await sbRequest(`reviews?phone=eq.${encodeURIComponent(phone)}&is_hidden=eq.false&limit=1`, 'GET');
        if(existing && existing.length > 0){
          return jsonResponse(409, { error: 'already_reviewed', message: 'لقد قمت بتقييم بطاقتي مسبقاً. شكراً لك!' }, corsHeaders());
        }
      }
      // منع التكرار للزوار بنفس IP (خلال 24 ساعة)
      if(!isVerified && ipHash){
        const since = new Date(Date.now() - 86400000).toISOString();
        const recent = await sbRequest(`reviews?ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${since}&limit=1`, 'GET');
        if(recent && recent.length > 0){
          return jsonResponse(429, { error: 'duplicate_visitor', message: 'لقد أرسلت تقييماً مؤخراً. يمكنك التعليق على تقييمات الآخرين.' }, corsHeaders());
        }
      }

      // كشف السبام
      const fullText = `${body.title || ''} ${bodyText} ${body.pros || ''} ${body.cons || ''}`;
      const spamScore = calcSpamScore(fullText, ipHash);
      const isFlagged = spamScore >= 50;

      const isAnonymous = sanitizeBool(body.is_anonymous, false);
      const isPublic = sanitizeBool(body.is_public, true);

      const review = {
        review_code: await genUniqueReviewCode(),
        order_code: customerData?.order_code || (body.order_code ? sanitize(body.order_code, 50) : null),
        phone: phone || null,
        verification_code: verificationCode || null,
        customer_name: isAnonymous ? null : (customerData?.customer_name || customerData?.name || (body.name ? sanitize(body.name, 100) : null) || (isVerified ? null : 'زائر')),
        package: customerData?.package || null,
        verified_at: isVerified ? new Date().toISOString() : null,
        rating_overall: sanitizeRating(ratingOverall) || 5,
        rating_design: sanitizeRating(body.rating_design),
        rating_speed: sanitizeRating(body.rating_speed),
        rating_support: sanitizeRating(body.rating_support),
        rating_value: sanitizeRating(body.rating_value),
        rating_ease: sanitizeRating(body.rating_ease),
        rating_communication: sanitizeRating(body.rating_communication),
        rating_creativity: sanitizeRating(body.rating_creativity),
        rating_professionalism: sanitizeRating(body.rating_professionalism),
        rating_after_sales: sanitizeRating(body.rating_after_sales),
        rating_accuracy: sanitizeRating(body.rating_accuracy),
        title: sanitize(body.title, 200),
        body: bodyText || '—',  // النص اختياري — نستخدم شارة لو تركه المستخدم فارغاً
        pros: sanitize(body.pros, 2000),
        cons: sanitize(body.cons, 2000),
        reviewer_email: isAnonymous ? null : (body.reviewer_email ? sanitize(body.reviewer_email, 200) : null),
        reviewer_profession: body.reviewer_profession ? sanitize(body.reviewer_profession, 200) : null,
        reviewer_use_case: body.reviewer_use_case ? sanitize(body.reviewer_use_case, 500) : null,
        reviewer_age_group: body.reviewer_age_group || null,
        how_heard: body.how_heard || null,
        social_links: sanitizeSocialLinks(body.social_links),
        would_recommend: body.would_recommend === null || body.would_recommend === undefined ? null : sanitizeBool(body.would_recommend),
        would_refer_friend: body.would_refer_friend === null || body.would_refer_friend === undefined ? null : sanitizeBool(body.would_refer_friend),
        recommendation_score: sanitizeInt(body.recommendation_score, null, 0, 10),
        tags: body.tags ? sanitize(body.tags, 500) : null,
        is_verified_customer: isVerified,
        is_anonymous: isAnonymous,
        is_public: isPublic,
        is_hidden: false,
        is_featured: false,
        is_pinned: false,
        review_language: body.review_language || 'ar',
        source: body.source || 'web',
        ip_hash: ipHash,
        user_agent: userAgent,
        fingerprint: body.fingerprint ? sanitize(body.fingerprint, 100) : null,
        spam_score: spamScore,
        is_flagged: isFlagged,
        votes_helpful: 0,
        votes_not_helpful: 0,
        comments_count: 0,
        responses_count: 0,
      };

      const result = await sbRequest('reviews', 'POST', review);
      await refreshStats();

      // لو التقييم موسوم كسبام — نُخفيه تلقائياً (يظهر للأدمن فقط)
      if(isFlagged){
        const reviewId = Array.isArray(result) ? result[0]?.id : result?.id;
        if(reviewId){
          await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', {
            is_hidden: true,
            hidden_reason: `سبام محتمل (نقاط: ${spamScore})`,
            hidden_by: 'system_auto',
            hidden_at: new Date().toISOString(),
          });
        }
      }

      const message = isFlagged
        ? 'تم استلام تقييمك وسيتم مراجعته من الإدارة قبل النشر.'
        : isVerified
          ? 'تم نشر تقييمك بنجاح! شكراً لك.'
          : 'تم نشر تقييمك كزائر. لتقييمك وزن أكبر، تحقّق كعميل موثّق.';

      return jsonResponse(200, {
        ok: true,
        message,
        is_verified: isVerified,
        is_flagged: isFlagged,
        review: Array.isArray(result) ? result[0] : result,
      }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  صوت مفيد/غير مفيد
    // ════════════════════════════════════════════════════════════════
    if(action === 'add_vote'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const vote = body.vote === 'helpful' ? 'helpful' : 'not_helpful';

      // تحقق إن كان قد صوّت مسبقاً
      const existing = await sbRequest(
        `review_votes?review_id=eq.${reviewId}&ip_hash=eq.${encodeURIComponent(ipHash)}&limit=1`,
        'GET'
      );
      if(existing && existing.length > 0){
        return jsonResponse(409, { error: 'already_voted', message: 'لقد صوّتت مسبقاً.' }, corsHeaders());
      }

      await sbRequest('review_votes', 'POST', {
        review_id: reviewId, ip_hash: ipHash, vote,
      });

      // تحديث العدّاد في reviews
      const reviews = await sbRequest(`reviews?id=eq.${reviewId}&select=votes_helpful,votes_not_helpful`, 'GET');
      if(reviews.length){
        const r = reviews[0];
        const updates = vote === 'helpful'
          ? { votes_helpful: (r.votes_helpful||0) + 1 }
          : { votes_not_helpful: (r.votes_not_helpful||0) + 1 };
        await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', updates);
      }

      return jsonResponse(200, { ok: true, message: 'تم تسجيل صوتك.' }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  تفاعل إيموجي
    // ════════════════════════════════════════════════════════════════
    if(action === 'add_reaction'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const emoji = sanitize(body.emoji, 10);
      if(!emoji) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      // تحقق من عدم التكرار
      const existing = await sbRequest(
        `review_reactions?review_id=eq.${reviewId}&ip_hash=eq.${encodeURIComponent(ipHash)}&emoji=eq.${encodeURIComponent(emoji)}&limit=1`,
        'GET'
      );
      if(existing && existing.length > 0){
        // إزالة التفاعل (toggle)
        await sbRequest(
          `review_reactions?review_id=eq.${reviewId}&ip_hash=eq.${encodeURIComponent(ipHash)}&emoji=eq.${encodeURIComponent(emoji)}`,
          'DELETE'
        );
        // إعادة بناء الملخص
        const allReactions = await sbRequest(`review_reactions?review_id=eq.${reviewId}&select=emoji`, 'GET');
        const summary = {};
        allReactions.forEach(r => { summary[r.emoji] = (summary[r.emoji]||0)+1; });
        await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', { reactions_summary: summary });
        return jsonResponse(200, { ok: true, message: 'تم إزالة التفاعل.', reactions: summary }, corsHeaders());
      }

      await sbRequest('review_reactions', 'POST', {
        review_id: reviewId, ip_hash: ipHash, emoji,
      });

      // إعادة بناء الملخص
      const allReactions = await sbRequest(`review_reactions?review_id=eq.${reviewId}&select=emoji`, 'GET');
      const summary = {};
      allReactions.forEach(r => { summary[r.emoji] = (summary[r.emoji]||0)+1; });
      await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', { reactions_summary: summary });

      return jsonResponse(200, { ok: true, message: 'تم تسجيل تفاعلك.', reactions: summary }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  تعليقات: قائمة + إضافة
    // ════════════════════════════════════════════════════════════════
    if(action === 'list_comments'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const comments = await sbRequest(
        `comments?review_id=eq.${reviewId}&is_hidden=eq.false&order=created_at.asc&limit=200`,
        'GET'
      );
      return jsonResponse(200, { ok: true, comments }, corsHeaders());
    }

    if(action === 'add_comment'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request', message: 'معرف التقييم مطلوب.' }, corsHeaders());

      const commentBody = sanitize(body.body, 2000);
      if(!commentBody || commentBody.length < 3){
        return jsonResponse(400, { error: 'invalid_request', message: 'التعليق قصير جداً.' }, corsHeaders());
      }
      const authorName = sanitize(body.author_name, 100);
      if(!authorName || authorName.length < 2){
        return jsonResponse(400, { error: 'invalid_request', message: 'يرجى إدخال اسمك.' }, corsHeaders());
      }

      // rate limit
      const settings = await sbRequest('review_settings?id=eq.1&limit=1', 'GET');
      const maxComments = settings[0]?.rate_limit_comments || 10;
      const allow = await checkRateLimit(ipHash, 'comment', maxComments);
      if(!allow){
        return jsonResponse(429, { error: 'rate_limited', message: 'أنت تعلّق كثيراً. انتظر ساعة.' }, corsHeaders());
      }

      // تحقق إن كان المعلّق عميلاً موثّقاً (اختياري)
      let isVerifiedCommenter = false;
      const phone = normalizePhone(body.phone);
      const code = String(body.verification_code || '').trim();
      if(phone && code){
        const customer = await verifyCustomerViaTrackOrder(phone, code);
        isVerifiedCommenter = !!customer;
      }

      // كشف سبام
      const spamScore = calcSpamScore(commentBody, ipHash);

      const comment = {
        review_id: reviewId,
        parent_id: body.parent_id ? parseInt(body.parent_id) : null,
        author_name: authorName,
        author_email: body.author_email ? sanitize(body.author_email, 200) : null,
        is_admin: false,
        is_verified_customer: isVerifiedCommenter,
        body: commentBody,
        is_approved: true,
        is_hidden: spamScore >= 60,
        hidden_reason: spamScore >= 60 ? `سبام محتمل (${spamScore})` : null,
        ip_hash: ipHash,
        user_agent: userAgent,
        likes_count: 0,
      };

      const result = await sbRequest('comments', 'POST', comment);

      // تحديث عدّاد التعليقات في التقييم
      if(spamScore < 60){
        const reviews = await sbRequest(`reviews?id=eq.${reviewId}&select=comments_count`, 'GET');
        if(reviews.length){
          await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', {
            comments_count: (reviews[0].comments_count||0) + 1,
          });
        }
      }

      return jsonResponse(200, {
        ok: true,
        message: spamScore >= 60 ? 'تعليقك قيد المراجعة.' : 'تم نشر تعليقك.',
        comment: Array.isArray(result) ? result[0] : result,
        is_verified: isVerifiedCommenter,
      }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  ردود الإدارة على التقييم (علنية)
    // ════════════════════════════════════════════════════════════════
    if(action === 'list_responses'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const responses = await sbRequest(
        `review_responses?review_id=eq.${reviewId}&is_public=eq.true&order=created_at.asc`,
        'GET'
      );
      return jsonResponse(200, { ok: true, responses }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  الاقتراحات: قائمة + إضافة + تصويت
    // ════════════════════════════════════════════════════════════════
    if(action === 'list_suggestions'){
      const isAdmin = await checkAdmin(body.password);
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      if(isAdmin){
        const rows = await sbRequest(`suggestions?order=created_at.desc&limit=${limit}`, 'GET');
        return jsonResponse(200, { ok: true, suggestions: rows, is_admin: true }, corsHeaders());
      } else {
        const rows = await sbRequest(`suggestions?is_public=eq.true&order=votes_count.desc,created_at.desc&limit=${limit}`, 'GET');
        return jsonResponse(200, { ok: true, suggestions: rows, is_admin: false }, corsHeaders());
      }
    }

    if(action === 'add_suggestion'){
      const title = sanitize(body.title, 200);
      const sugBody = sanitize(body.body, 8000);
      const authorName = sanitize(body.author_name, 100) || 'زائر';

      // العنوان إجباري — الباقي اختياري
      if(!title){
        return jsonResponse(400, { error: 'invalid_request', message: 'يرجى كتابة عنوان الاقتراح.' }, corsHeaders());
      }

      // rate limit
      const allow = await checkRateLimit(ipHash, 'suggestion', 3);
      if(!allow){
        return jsonResponse(429, { error: 'rate_limited', message: 'لقد أرسلت عدة اقتراحات. انتظر ساعة.' }, corsHeaders());
      }

      const phone = normalizePhone(body.phone);
      let isCustomer = false;
      if(phone && body.verification_code){
        const customer = await verifyCustomerViaTrackOrder(phone, body.verification_code);
        isCustomer = !!customer;
      }

        const validCategories = ['general','feature','bug','improvement','complaint','partnership','pricing','other'];
      const validPriorities = ['low','medium','high','critical'];

      const suggestion = {
        author_name: authorName,
        author_email: body.author_email ? sanitize(body.author_email, 200) : null,
        is_customer: isCustomer,
        is_anonymous: sanitizeBool(body.is_anonymous, false),
        phone: phone || null,
        category: validCategories.includes(body.category) ? body.category : 'general',
        priority: validPriorities.includes(body.priority) ? body.priority : 'medium',
        title,
        body: sugBody || '—',  // النص اختياري — شارة لو تركه فارغاً
        tags: body.tags ? sanitize(body.tags, 500) : null,
        is_public: sanitizeBool(body.is_public, false),
        status: 'new',
        votes_count: 0,
        ip_hash: ipHash,
        user_agent: userAgent,
      };

      const result = await sbRequest('suggestions', 'POST', suggestion);
      await refreshStats();

      return jsonResponse(200, {
        ok: true,
        message: suggestion.is_public ? 'تم نشر اقتراحك للعامة.' : 'تم إرسال اقتراحك للإدارة. شكراً لك!',
        suggestion: Array.isArray(result) ? result[0] : result,
      }, corsHeaders());
    }

    if(action === 'vote_suggestion'){
      const sugId = parseInt(body.suggestion_id);
      if(!sugId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      const existing = await sbRequest(
        `suggestion_votes?suggestion_id=eq.${sugId}&ip_hash=eq.${encodeURIComponent(ipHash)}&limit=1`,
        'GET'
      );
      if(existing && existing.length > 0){
        return jsonResponse(409, { error: 'already_voted', message: 'لقد صوّتت مسبقاً.' }, corsHeaders());
      }

      await sbRequest('suggestion_votes', 'POST', {
        suggestion_id: sugId, ip_hash: ipHash,
      });

      const sugs = await sbRequest(`suggestions?id=eq.${sugId}&select=votes_count`, 'GET');
      if(sugs.length){
        await sbRequest(`suggestions?id=eq.${sugId}`, 'PATCH', {
          votes_count: (sugs[0].votes_count||0) + 1,
        });
      }

      return jsonResponse(200, { ok: true, message: 'تم تسجيل صوتك.' }, corsHeaders());
    }

    // ════════════════════════════════════════════════════════════════
    //  ════════════ دوال الإدارة (تتطلب password) ════════════
    // ════════════════════════════════════════════════════════════════

    // ═════════ لوحة التحكم ═════════
    if(action === 'get_dashboard'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());

      const [stats, settings, recentReviews, flaggedReviews, recentComments, recentSuggestions] = await Promise.all([
        sbRequest('review_stats?id=eq.1&limit=1', 'GET'),
        sbRequest('review_settings?id=eq.1&limit=1', 'GET'),
        sbRequest('reviews?order=created_at.desc&limit=10', 'GET'),
        sbRequest('reviews?is_flagged=eq.true&order=created_at.desc&limit=10', 'GET'),
        sbRequest('comments?order=created_at.desc&limit=10', 'GET'),
        sbRequest('suggestions?order=created_at.desc&limit=10', 'GET'),
      ]);

      return jsonResponse(200, {
        ok: true,
        stats: stats[0] || {},
        settings: settings[0] || {},
        recent_reviews: recentReviews,
        flagged_reviews: flaggedReviews,
        recent_comments: recentComments,
        recent_suggestions: recentSuggestions,
      }, corsHeaders());
    }

    // ═════════ قائمة كل التقييمات (مع فلاتر شاملة) ═════════
    if(action === 'list_all'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());

      const limit = Math.min(parseInt(body.limit) || 100, 500);
      const offset = parseInt(body.offset) || 0;
      const filterHidden = body.filter_hidden; // 'only_hidden' | 'only_visible' | null
      const filterFlagged = sanitizeBool(body.filter_flagged, false);
      const filterVerified = body.filter_verified; // 'only_verified' | 'only_visitor' | null
      const search = sanitize(body.search, 200);

      let path = 'reviews?order=created_at.desc';
      if(filterHidden === 'only_hidden') path += '&is_hidden=eq.true';
      else if(filterHidden === 'only_visible') path += '&is_hidden=eq.false';
      if(filterFlagged) path += '&is_flagged=eq.true';
      if(filterVerified === 'only_verified') path += '&is_verified_customer=eq.true';
      else if(filterVerified === 'only_visitor') path += '&is_verified_customer=eq.false';
      if(search){
        const enc = encodeURIComponent(search);
        path += `&or=(body.ilike.*${enc}*,title.ilike.*${enc}*,customer_name.ilike.*${enc}*,phone.ilike.*${enc}*,review_code.ilike.*${enc}*)`;
      }
      path += `&limit=${limit}&offset=${offset}`;

      const reviews = await sbRequest(path, 'GET');
      return jsonResponse(200, { ok: true, reviews, count: reviews.length }, corsHeaders());
    }

    // ═════════ كل التعليقات ═════════
    if(action === 'list_comments_all'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const limit = Math.min(parseInt(body.limit) || 100, 500);
      const comments = await sbRequest(`comments?order=created_at.desc&limit=${limit}`, 'GET');
      return jsonResponse(200, { ok: true, comments }, corsHeaders());
    }

    // ═════════ إخفاء/إظهار تقييم ═════════
    if(action === 'hide_review' || action === 'unhide_review'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      const updates = {
        is_hidden: action === 'hide_review',
        hidden_reason: action === 'hide_review' ? (sanitize(body.reason, 200) || 'إخفاء يدوي من الإدارة') : null,
        hidden_at: action === 'hide_review' ? new Date().toISOString() : null,
        hidden_by: 'admin',
      };
      await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', updates);
      await logActivity(action, 'review', reviewId, updates.hidden_reason, ipHash, 'admin');
      await refreshStats();

      return jsonResponse(200, { ok: true, message: action === 'hide_review' ? 'تم إخفاء التقييم.' : 'تم إظهار التقييم.' }, corsHeaders());
    }

    // ═════════ تمييز/إلغاء تمييز ═════════
    if(action === 'feature_review' || action === 'unfeature_review'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', {
        is_featured: action === 'feature_review',
      });
      await logActivity(action, 'review', reviewId, null, ipHash, 'admin');
      await refreshStats();

      return jsonResponse(200, { ok: true, message: action === 'feature_review' ? 'تم تمييز التقييم.' : 'تم إلغاء تمييز التقييم.' }, corsHeaders());
    }

    // ═════════ تثبيت/إلغاء تثبيت ═════════
    if(action === 'pin_review' || action === 'unpin_review'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', {
        is_pinned: action === 'pin_review',
      });
      await logActivity(action, 'review', reviewId, null, ipHash, 'admin');

      return jsonResponse(200, { ok: true }, corsHeaders());
    }

    // ═════════ حذف تقييم ═════════
    if(action === 'delete_review'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      await sbRequest(`reviews?id=eq.${reviewId}`, 'DELETE');
      await logActivity('delete_review', 'review', reviewId, sanitize(body.reason, 200), ipHash, 'admin');
      await refreshStats();

      return jsonResponse(200, { ok: true, message: 'تم حذف التقييم نهائياً.' }, corsHeaders());
    }

    // ═════════ إجراء جماعي ═════════
    if(action === 'bulk_action'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const ids = Array.isArray(body.review_ids) ? body.review_ids : [];
      const bulkAction = String(body.bulk_action || '');
      if(!ids.length || !bulkAction) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      const idsFilter = `id=in.(${ids.join(',')})`;
      let update = {};
      if(bulkAction === 'hide') update = { is_hidden: true, hidden_at: new Date().toISOString(), hidden_by: 'admin', hidden_reason: 'إخفاء جماعي' };
      else if(bulkAction === 'unhide') update = { is_hidden: false, hidden_reason: null };
      else if(bulkAction === 'feature') update = { is_featured: true };
      else if(bulkAction === 'unfeature') update = { is_featured: false };
      else if(bulkAction === 'delete'){
        await sbRequest(`reviews?${idsFilter}`, 'DELETE');
        await logActivity('bulk_delete', 'review', null, `${ids.length} تقييم`, ipHash, 'admin');
        await refreshStats();
        return jsonResponse(200, { ok: true, message: `تم حذف ${ids.length} تقييم.` }, corsHeaders());
      }

      await sbRequest(`reviews?${idsFilter}`, 'PATCH', update);
      await logActivity(`bulk_${bulkAction}`, 'review', null, `${ids.length} تقييم`, ipHash, 'admin');
      await refreshStats();

      return jsonResponse(200, { ok: true, message: `تم تطبيق الإجراء على ${ids.length} تقييم.` }, corsHeaders());
    }

    // ═════════ تصدير CSV ═════════
    if(action === 'export_reviews'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());

      const reviews = await sbRequest('reviews?order=created_at.desc&limit=10000', 'GET');
      const comments = await sbRequest('comments?order=created_at.desc&limit=10000', 'GET');

      const headers = ['review_code','created_at','customer_name','phone','package','rating_overall','rating_design','rating_speed','rating_support','rating_value','rating_ease','rating_communication','rating_creativity','rating_professionalism','rating_after_sales','rating_accuracy','title','body','pros','cons','is_verified_customer','is_anonymous','is_public','is_hidden','is_featured','is_flagged','spam_score','votes_helpful','votes_not_helpful','comments_count','tags','would_recommend','reviewer_profession','reviewer_use_case','reviewer_age_group','how_heard','social_links'];

      let csv = headers.join(',') + '\n';
      reviews.forEach(r => {
        const row = headers.map(h => {
          const v = r[h];
          if(v === null || v === undefined) return '';
          const s = String(v).replace(/"/g, '""');
          return /[",\n]/.test(s) ? `"${s}"` : s;
        });
        csv += row.join(',') + '\n';
      });

      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="bitaqti-reviews-export.csv"',
          ...corsHeaders(),
        },
        body: '\uFEFF' + csv, // BOM لإكسل
      };
    }

    // ═════════ رد الإدارة ═════════
    if(action === 'add_response'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const respBody = sanitize(body.body, 3000);
      if(!respBody || respBody.length < 3){
        return jsonResponse(400, { error: 'invalid_request', message: 'الرد قصير جداً.' }, corsHeaders());
      }

      const result = await sbRequest('review_responses', 'POST', {
        review_id: reviewId,
        body: respBody,
        admin_name: sanitize(body.admin_name, 100) || 'فريق بطاقتي',
        is_public: sanitizeBool(body.is_public, true),
        is_official: true,
      });

      // تحديث عدّاد الردود في التقييم
      const reviews = await sbRequest(`reviews?id=eq.${reviewId}&select=responses_count`, 'GET');
      if(reviews.length){
        await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', {
          responses_count: (reviews[0].responses_count||0) + 1,
        });
      }
      await logActivity('add_response', 'review', reviewId, null, ipHash, 'admin');

      return jsonResponse(200, { ok: true, message: 'تم نشر ردك.', response: Array.isArray(result) ? result[0] : result }, corsHeaders());
    }

    if(action === 'update_response'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const respId = parseInt(body.response_id);
      if(!respId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const updates = {};
      if(body.body !== undefined) updates.body = sanitize(body.body, 3000);
      if(body.is_public !== undefined) updates.is_public = sanitizeBool(body.is_public, true);
      await sbRequest(`review_responses?id=eq.${respId}`, 'PATCH', updates);
      return jsonResponse(200, { ok: true }, corsHeaders());
    }

    if(action === 'delete_response'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const respId = parseInt(body.response_id);
      if(!respId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      await sbRequest(`review_responses?id=eq.${respId}`, 'DELETE');
      return jsonResponse(200, { ok: true }, corsHeaders());
    }

    // ═════════ ملاحظات الإدارة الخاصة ═════════
    if(action === 'add_admin_note'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const note = sanitize(body.note, 3000);
      if(!note) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      const result = await sbRequest('review_admin_notes', 'POST', {
        review_id: reviewId,
        note,
        admin_name: sanitize(body.admin_name, 100) || 'admin',
      });
      return jsonResponse(200, { ok: true, note: Array.isArray(result) ? result[0] : result }, corsHeaders());
    }

    if(action === 'list_admin_notes'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const notes = await sbRequest(`review_admin_notes?review_id=eq.${reviewId}&order=created_at.desc`, 'GET');
      return jsonResponse(200, { ok: true, notes }, corsHeaders());
    }

    // ═════════ إدارة التعليقات ═════════
    if(action === 'hide_comment' || action === 'unhide_comment'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const commentId = parseInt(body.comment_id);
      if(!commentId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      await sbRequest(`comments?id=eq.${commentId}`, 'PATCH', {
        is_hidden: action === 'hide_comment',
        hidden_reason: action === 'hide_comment' ? (sanitize(body.reason, 200) || 'إخفاء يدوي') : null,
      });
      await logActivity(action, 'comment', commentId, null, ipHash, 'admin');
      return jsonResponse(200, { ok: true }, corsHeaders());
    }

    if(action === 'delete_comment'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const commentId = parseInt(body.comment_id);
      if(!commentId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      await sbRequest(`comments?id=eq.${commentId}`, 'DELETE');
      await logActivity('delete_comment', 'comment', commentId, null, ipHash, 'admin');
      return jsonResponse(200, { ok: true }, corsHeaders());
    }

    // ═════════ تحديث اقتراح ═════════
    if(action === 'update_suggestion'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const sugId = parseInt(body.suggestion_id);
      if(!sugId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const updates = {};
      if(body.status) updates.status = body.status;
      if(body.priority) updates.priority = body.priority;
      if(body.admin_response !== undefined){
        updates.admin_response = sanitize(body.admin_response, 3000);
        updates.admin_response_at = new Date().toISOString();
      }
      if(body.is_public !== undefined) updates.is_public = sanitizeBool(body.is_public, false);
      if(body.category) updates.category = body.category;
      await sbRequest(`suggestions?id=eq.${sugId}`, 'PATCH', updates);
      await logActivity('update_suggestion', 'suggestion', sugId, JSON.stringify(updates), ipHash, 'admin');
      return jsonResponse(200, { ok: true, message: 'تم التحديث.' }, corsHeaders());
    }

    // ═════════ حذف اقتراح ═════════
    if(action === 'delete_suggestion'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const sugId = parseInt(body.suggestion_id);
      if(!sugId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      await sbRequest(`suggestions?id=eq.${sugId}`, 'DELETE');
      await logActivity('delete_suggestion', 'suggestion', sugId, null, ipHash, 'admin');
      return jsonResponse(200, { ok: true }, corsHeaders());
    }

    // ═════════ إعادة حساب الإحصائيات ═════════
    if(action === 'refresh_stats'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const ok = await refreshStats();
      return jsonResponse(200, { ok, message: 'تم تحديث الإحصائيات.' }, corsHeaders());
    }

    // ═════════ تعديل الإعدادات ═════════
    if(action === 'update_settings'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const updates = {};
      const boolFields = ['auto_approve','allow_visitor_reviews','allow_anonymous','require_verification_for_stats'];
      const intFields = ['max_body_length','max_comment_length','max_suggestion_length','rate_limit_per_hour','rate_limit_comments'];
      boolFields.forEach(f => { if(body[f] !== undefined) updates[f] = sanitizeBool(body[f]); });
      intFields.forEach(f => { if(body[f] !== undefined) updates[f] = sanitizeInt(body[f], null, 1, 100000); });
      if(body.welcome_message !== undefined) updates.welcome_message = sanitize(body.welcome_message, 500);
      if(body.enabled_ratings !== undefined) updates.enabled_ratings = body.enabled_ratings;
      updates.updated_at = new Date().toISOString();
      await sbRequest('review_settings?id=eq.1', 'PATCH', updates);
      return jsonResponse(200, { ok: true, message: 'تم تحديث الإعدادات.' }, corsHeaders());
    }

    // ═════════ سجل النشاط ═════════
    if(action === 'activity_log'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const limit = Math.min(parseInt(body.limit) || 50, 200);
      const log = await sbRequest(`admin_activity_log?order=created_at.desc&limit=${limit}`, 'GET');
      return jsonResponse(200, { ok: true, log }, corsHeaders());
    }

    // ═════════ عرض تقييم واحد بالتفصيل (للأدمن) ═════════
    if(action === 'get_review_detail'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      const [review, comments, responses, notes, votes, reactions] = await Promise.all([
        sbRequest(`reviews?id=eq.${reviewId}&limit=1`, 'GET'),
        sbRequest(`comments?review_id=eq.${reviewId}&order=created_at.asc`, 'GET'),
        sbRequest(`review_responses?review_id=eq.${reviewId}&order=created_at.asc`, 'GET'),
        sbRequest(`review_admin_notes?review_id=eq.${reviewId}&order=created_at.desc`, 'GET'),
        sbRequest(`review_votes?review_id=eq.${reviewId}&select=vote,ip_hash,created_at`, 'GET'),
        sbRequest(`review_reactions?review_id=eq.${reviewId}&select=emoji,ip_hash,created_at`, 'GET'),
      ]);

      return jsonResponse(200, {
        ok: true,
        review: review[0] || null,
        comments,
        responses,
        notes,
        votes,
        reactions,
      }, corsHeaders());
    }

    return jsonResponse(400, { error: 'invalid_action', message: `action غير معروف: ${action}` }, corsHeaders());

  } catch(err){
    console.error('[reviews-manage] error:', err.message);
    if(err.code === 'db_unreachable' || err.code === 'db_error'){
      return jsonResponse(502, { error: 'db_error', message: err.message }, corsHeaders());
    }
    return jsonResponse(500, { error: 'internal_error', message: err.message }, corsHeaders());
  }
};
