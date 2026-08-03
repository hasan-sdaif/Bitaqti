// netlify/functions/reviews-manage.js


exports.config = {
  path: '/.netlify/functions/reviews-manage',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

const crypto = require('crypto');

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
  if(body) headers['Prefer'] = 'return=representation';
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
    throw Object.assign(new Error(`Supabase HTTP ${res.status}: ${detail.slice(0,100)}`), { code: 'db_error', status: res.status });
  }
  if(res.status === 204) return [];
  return await res.json().catch(() => []);
}

// ═══ Hash IP for spam prevention ═══
function hashIP(ip){
  if(!ip) return '';
  return crypto.createHash('sha256').update(ip + 'bitaqti_salt_v1').digest('hex').slice(0, 16);
}

// ═══ Verify customer via track-order (phone + verification code) ═══
async function verifyCustomerViaTrackOrder(phone, code){
  // استدعاء track-order بوضع customer_track للتحقق من العميل
  try {
    const res = await fetch('https://' + (process.env.URL || 'bitaqti.netlify.app') + '/.netlify/functions/track-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code }),
    });
    if(res.status === 200){
      const data = await res.json();
      return data.order || data;
    }
  } catch(e) {
    // fallback: تحقق مباشر من جدول customers
    const cfg = getCfg();
    try {
      const rows = await sbRequest(`customers?phone=eq.${encodeURIComponent(phone)}&limit=1`, 'GET');
      if(rows && rows.length > 0){
        const c = rows[0];
        // تحقق من رمز التحقق
        if(String(c.code || '').trim() === String(code || '').trim()){
          return c;
        }
      }
    } catch(e2) {}
  }
  return null;
}

// ═══ Generate review code ═══
function genReviewCode(){
  const year = new Date().getFullYear();
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `REV-${year}-${rand}`;
}

// ═══ Sanitize input ═══
function sanitize(str, maxLen = 8000){
  if(!str) return '';
  let s = String(str).trim().slice(0, maxLen);
  // إزالة وسوم HTML خطيرة (نُبقي النص فقط)
  s = s.replace(/<script[^>]*>.*?<\/script>/gis, '');
  s = s.replace(/<iframe[^>]*>.*?<\/iframe>/gis, '');
  s = s.replace(/<[^>]+>/g, ''); // إزالة كل وسوم HTML
  return s;
}

function sanitizeRating(r){
  const n = parseInt(r, 10);
  if(isNaN(n)) return 5;
  return Math.max(1, Math.min(5, n));
}

// ═══ Handler ═══
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
  const userAgent = String(event.headers['user-agent'] || '').slice(0, 200);

  try {
    // ═══ test ═══
    if(action === 'test'){
      const rows = await sbRequest('review_stats?id=eq.1&limit=1', 'GET');
      return jsonResponse(200, { ok: true, message: 'نظام التقييمات يعمل', stats: rows[0] || null }, corsHeaders());
    }

    // ═══ list_approved — تقييمات موافق عليها (عام) ═══
    if(action === 'list_approved'){
      const limit = Math.min(parseInt(body.limit) || 20, 100);
      const offset = parseInt(body.offset) || 0;
      const rows = await sbRequest(
        `reviews?is_approved=eq.true&is_public=eq.true&order=created_at.desc&limit=${limit}&offset=${offset}`,
        'GET'
      );
      return jsonResponse(200, { ok: true, reviews: rows }, corsHeaders());
    }

    // ═══ stats — إحصائيات ═══
    if(action === 'stats'){
      const rows = await sbRequest('review_stats?id=eq.1&limit=1', 'GET');
      return jsonResponse(200, { ok: true, stats: rows[0] || { total_reviews: 0 } }, corsHeaders());
    }

    // ═══ add_review — إضافة تقييم (عميل موثّق أو زائر) ═══
    if(action === 'add_review'){
      // تطبيع رقم الهاتف — قبول أي صيغة (دولية أو عادية بدون رمز الدولة)
      let phone = String(body.phone || '').trim();
      if(phone){
        // إزالة المسافات والشرط والأقواس
        phone = phone.replace(/[\s\-()]/g, '');
        // لو يبدأ بـ 00 → نحوّل لـ +
        if(phone.startsWith('00')) phone = '+' + phone.slice(2);
        // لو يبدأ بـ 973 → نضيف +
        if(phone.startsWith('973') && phone.length === 11) phone = '+' + phone;
        // لو يبدأ بـ +973 → نتركه
        // لو رقم بحريني 8 أرقام بدون رمز الدولة → نضيف +973
        if(!phone.startsWith('+') && /^\d{8}$/.test(phone)) phone = '+973' + phone;
      }
      const verificationCode = String(body.verification_code || '').trim();
      const bodyText = String(body.body || '').trim();
      
      // التقييم العام إجباري — كل شيء آخر اختياري
      const ratingOverall = parseInt(body.rating_overall);
      if(!ratingOverall || ratingOverall < 1 || ratingOverall > 5){
        return jsonResponse(400, { error: 'invalid_request', message: 'يرجى تقييم التقييم العام.' }, corsHeaders());
      }

      let isVerified = false;
      let customerData = null;

      // لو أرسل رقم هاتف + رمز تحقق → تحقق من العميل
      if(phone && phone.length >= 6 && verificationCode){
        customerData = await verifyCustomerViaTrackOrder(phone, verificationCode);
        if(customerData){
          isVerified = true;
        }
      }

      // لو لم يكن عميلاً موثّقاً → اسمح له كزائر (بدون علامة "عميل موثّق")
      // لكن لا يدخل في التقييم العام إلا بعد موافقة المسؤول
      // لو العميل موثّق → يمكن أن يدخل في التقييم العام مباشرة (is_public)

      // منع تكرار التقييم للعملاء الموثقين فقط (بالبريد/الهاتف)
      if(isVerified && phone){
        const existing = await sbRequest(`reviews?phone=eq.${encodeURIComponent(phone)}&limit=1`, 'GET');
        if(existing && existing.length > 0){
          return jsonResponse(409, { error: 'already_reviewed', message: 'لقد قمت بتقييم بطاقتي مسبقاً. شكراً لك!' }, corsHeaders());
        }
      }

      const review = {
        review_code: genReviewCode(),
        order_code: customerData?.order_code || body.order_code || null,
        phone: phone || null,
        verification_code: verificationCode || null,
        customer_name: body.is_anonymous ? null : (customerData?.customer_name || sanitize(body.name, 100) || (isVerified ? null : 'زائر')),
        package: customerData?.package || null,
        rating_overall: sanitizeRating(body.rating_overall),
        rating_design: sanitizeRating(body.rating_design),
        rating_speed: sanitizeRating(body.rating_speed),
        rating_support: sanitizeRating(body.rating_support),
        rating_value: sanitizeRating(body.rating_value),
        rating_ease: sanitizeRating(body.rating_ease),
        title: sanitize(body.title, 200),
        body: sanitize(body.body || '', 8000) || '—',
        pros: sanitize(body.pros, 2000),
        cons: sanitize(body.cons, 2000),
        is_verified_customer: isVerified,
        is_anonymous: !!body.is_anonymous,
        is_public: body.is_public !== false,
        is_approved: false,
        ip_hash: ipHash,
        user_agent: userAgent,
      };

      const result = await sbRequest('reviews', 'POST', review);
      await updateStats();

      return jsonResponse(200, {
        ok: true,
        message: isVerified 
          ? 'تم استلام تقييمك بنجاح! سيظهر بعد مراجعته من الإدارة.'
          : 'تم استلام تقييمك! سيظهر بعد مراجعته من الإدارة. (تقييم زائر)',
        is_verified: isVerified,
        review: Array.isArray(result) ? result[0] : result,
      }, corsHeaders());
    }

    // ═══ add_comment — إضافة تعليق (من أي زائر) ═══
    if(action === 'add_comment'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId){
        return jsonResponse(400, { error: 'invalid_request', message: 'معرف التقييم مطلوب.' }, corsHeaders());
      }
      if(!body.body || String(body.body).trim().length < 3){
        return jsonResponse(400, { error: 'invalid_request', message: 'التعليق قصير جداً.' }, corsHeaders());
      }
      if(!body.author_name || String(body.author_name).trim().length < 2){
        return jsonResponse(400, { error: 'invalid_request', message: 'يرجى إدخال اسمك.' }, corsHeaders());
      }

      // Rate limit: نفس IP لا يعلق أكثر من 5 مرات في الساعة
      const recentComments = await sbRequest(
        `comments?ip_hash=eq.${ipHash}&created_at=gte.${new Date(Date.now() - 3600000).toISOString()}&limit=6`,
        'GET'
      );
      if(recentComments && recentComments.length >= 5){
        return jsonResponse(429, { error: 'rate_limited', message: 'أنت تعلّق كثيراً. انتظر ساعة.' }, corsHeaders());
      }

      const comment = {
        review_id: reviewId,
        parent_id: body.parent_id || null,
        author_name: sanitize(body.author_name, 100),
        author_email: body.author_email ? sanitize(body.author_email, 200) : null,
        is_admin: false,
        body: sanitize(body.body, 1000),
        is_approved: true,
        is_hidden: false,
        ip_hash: ipHash,
        user_agent: userAgent,
      };

      const result = await sbRequest('comments', 'POST', comment);
      return jsonResponse(200, {
        ok: true,
        message: 'تم نشر تعليقك.',
        comment: Array.isArray(result) ? result[0] : result,
      }, corsHeaders());
    }

    // ═══ list_comments — تعليقات تقييم معين ═══
    if(action === 'list_comments'){
      const reviewId = parseInt(body.review_id);
      if(!reviewId){
        return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      }
      const comments = await sbRequest(
        `comments?review_id=eq.${reviewId}&is_hidden=eq.false&order=created_at.asc`,
        'GET'
      );
      return jsonResponse(200, { ok: true, comments }, corsHeaders());
    }

    // ═══ add_suggestion — إضافة اقتراح ═══
    if(action === 'add_suggestion'){
      if(!body.title || String(body.title).trim().length < 3){
        return jsonResponse(400, { error: 'invalid_request', message: 'عنوان الاقتراح مطلوب.' }, corsHeaders());
      }
      if(!body.body || String(body.body).trim().length < 10){
        return jsonResponse(400, { error: 'invalid_request', message: 'تفاصيل الاقتراح مطلوبة.' }, corsHeaders());
      }
      if(!body.author_name || String(body.author_name).trim().length < 2){
        return jsonResponse(400, { error: 'invalid_request', message: 'يرجى إدخال اسمك.' }, corsHeaders());
      }

      const phone = String(body.phone || '').trim();
      let isCustomer = false;
      if(phone.length >= 6){
        const cust = await verifyCustomer(phone);
        isCustomer = !!cust;
      }

      const suggestion = {
        author_name: sanitize(body.author_name, 100),
        author_email: body.author_email ? sanitize(body.author_email, 200) : null,
        is_customer: isCustomer,
        phone: phone || null,
        category: ['general','feature','bug','improvement','other'].includes(body.category) ? body.category : 'general',
        title: sanitize(body.title, 200),
        body: sanitize(body.body, 3000),
        is_public: !!body.is_public,
        ip_hash: ipHash,
        user_agent: userAgent,
      };

      const result = await sbRequest('suggestions', 'POST', suggestion);
      return jsonResponse(200, {
        ok: true,
        message: suggestion.is_public ? 'تم نشر اقتراحك للعامة.' : 'تم إرسال اقتراحك للإدارة. شكراً لك!',
        suggestion: Array.isArray(result) ? result[0] : result,
      }, corsHeaders());
    }

    // ═══ list_suggestions — عرض الاقتراحات ═══
    if(action === 'list_suggestions'){
      const isAdmin = await checkAdmin(body.password);
      if(isAdmin){
        // الأدمن يرى كل الاقتراحات
        const rows = await sbRequest('suggestions?order=created_at.desc&limit=100', 'GET');
        return jsonResponse(200, { ok: true, suggestions: rows }, corsHeaders());
      } else {
        // العامة يرون الاقتراحات العلنية فقط
        const rows = await sbRequest('suggestions?is_public=eq.true&order=created_at.desc&limit=50', 'GET');
        return jsonResponse(200, { ok: true, suggestions: rows }, corsHeaders());
      }
    }

    // ═══ list_all — كل التقييمات (للأدمن) ═══
    if(action === 'list_all'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin){
        return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      }
      const rows = await sbRequest('reviews?order=created_at.desc&limit=200', 'GET');
      return jsonResponse(200, { ok: true, reviews: rows }, corsHeaders());
    }

    // ═══ moderate — موافقة/إخفاء/حذف (للأدمن) ═══
    if(action === 'moderate'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin){
        return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      }
      const reviewId = parseInt(body.review_id);
      if(!reviewId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());

      const updates = {};
      if(body.approve !== undefined) updates.is_approved = !!body.approve;
      if(body.featured !== undefined) updates.is_featured = !!body.featured;
      if(body.public !== undefined) updates.is_public = !!body.public;

      if(Object.keys(updates).length > 0){
        await sbRequest(`reviews?id=eq.${reviewId}`, 'PATCH', updates);
        await updateStats();
      }

      if(body.delete === true){
        await sbRequest(`reviews?id=eq.${reviewId}`, 'DELETE');
        await updateStats();
      }

      return jsonResponse(200, { ok: true, message: 'تم التحديث.' }, corsHeaders());
    }

    // ═══ moderate_comment — إخفاء/إظهار تعليق (للأدمن) ═══
    if(action === 'moderate_comment'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const commentId = parseInt(body.comment_id);
      if(!commentId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const updates = {};
      if(body.hide !== undefined) updates.is_hidden = !!body.hide;
      await sbRequest(`comments?id=eq.${commentId}`, 'PATCH', updates);
      return jsonResponse(200, { ok: true, message: 'تم التحديث.' }, corsHeaders());
    }

    // ═══ update_suggestion — تحديث حالة اقتراح (للأدمن) ═══
    if(action === 'update_suggestion'){
      const isAdmin = await checkAdmin(body.password);
      if(!isAdmin) return jsonResponse(401, { error: 'unauthorized' }, corsHeaders());
      const sugId = parseInt(body.suggestion_id);
      if(!sugId) return jsonResponse(400, { error: 'invalid_request' }, corsHeaders());
      const updates = {};
      if(body.status) updates.status = body.status;
      if(body.admin_response !== undefined) updates.admin_response = sanitize(body.admin_response, 1000);
      if(body.is_public !== undefined) updates.is_public = !!body.is_public;
      await sbRequest(`suggestions?id=eq.${sugId}`, 'PATCH', updates);
      return jsonResponse(200, { ok: true, message: 'تم التحديث.' }, corsHeaders());
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

// ═══ Helpers ═══
async function checkAdmin(password){
  const correct = process.env.INVOICE_PASSWORD;
  if(!correct || !password) return false;
  return timingSafeEqual(String(password), String(correct));
}

async function updateStats(){
  try {
    const all = await sbRequest('reviews?is_approved=eq.true&select=rating_overall,rating_design,rating_speed,rating_support,rating_value,rating_ease,is_verified_customer', 'GET');
    if(!all.length){
      await sbRequest('review_stats?id=eq.1', 'PATCH', {
        total_reviews: 0, total_verified: 0, total_visitor: 0,
        avg_overall: 0, avg_design: 0, avg_speed: 0, avg_support: 0, avg_value: 0, avg_ease: 0,
        updated_at: new Date().toISOString()
      });
      return;
    }
    const verified = all.filter(r => r.is_verified_customer);
    const visitor = all.filter(r => !r.is_verified_customer);
    const avg = (field) => parseFloat((all.reduce((s, r) => s + (r[field] || 0), 0) / all.length).toFixed(2));
    await sbRequest('review_stats?id=eq.1', 'PATCH', {
      total_reviews: all.length,
      total_verified: verified.length,
      total_visitor: visitor.length,
      avg_overall: avg('rating_overall'),
      avg_design: avg('rating_design'),
      avg_speed: avg('rating_speed'),
      avg_support: avg('rating_support'),
      avg_value: avg('rating_value'),
      avg_ease: avg('rating_ease'),
      updated_at: new Date().toISOString(),
    });
  } catch(e) { /* silent */ }
}

function timingSafeEqual(a, b){
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  const maxLen = Math.max(bufA.length, bufB.length, 1);
  const pA = Buffer.alloc(maxLen), pB = Buffer.alloc(maxLen);
  bufA.copy(pA); bufB.copy(pB);
  return crypto.timingSafeEqual(pA, pB) && bufA.length === bufB.length;
}

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
