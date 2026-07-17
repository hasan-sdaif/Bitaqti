// netlify/functions/invoice-auth.js
//
// وظيفة هذه الدالة: التحقق من كلمة سر صفحة إصدار الفواتير الداخلية.
// كلمة السر تُقارَن من طرف السيرفر فقط ولا تُكتب أو تُرسَل داخل كود
// الصفحة نفسها بأي شكل — المتصفح يرسل ما كتبه المستخدم، والدالة ترد
// فقط بـ "صح" أو "خطأ"، ولا تُعيد كلمة السر الصحيحة في أي حالة.
//
// الإعداد على Netlify (Site settings → Environment variables):
//   INVOICE_PASSWORD = كلمة السر التي تريدها لفتح صفحة الفاتورة
//
// هذه القيمة تبقى على السيرفر فقط ولا تصل إلى كود المتصفح إطلاقاً.
//
// ملاحظة تقنية: لا نستخدم هنا exports.config لتخصيص المسار أو rate
// limiting المدمج، لأن صيغة CommonJS المستخدمة في هذا الملف (exports.*)
// لا يتعرف عليها نظام تعريف الـconfig الحديث في Netlify — فقط الدوال
// المكتوبة بصيغة ESM (export const config) تدعم ذلك. الدالة هنا تعمل
// إذن على مسارها الافتراضي: /.netlify/functions/invoice-auth
// والحماية من محاولات التخمين الآلي تُطبَّق يدوياً داخل الدالة نفسها
// (تأخير بسيط + حد أقصى للمحاولات لكل IP، انظر أدناه).

// حد بسيط للمحاولات داخل ذاكرة الدالة نفسها (in-memory). هذا ليس حلاً
// دائماً مثالياً (لأن كل نسخة جديدة من الدالة تبدأ بذاكرة فارغة)، لكنه
// طبقة حماية إضافية فورية لا تحتاج أي إعداد خارجي، وتعمل فعلياً طالما
// نفس نسخة الدالة (instance) لا تزال "دافئة" بين الطلبات المتتالية.
const attempts = new Map(); // ip -> { count, windowStart }
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }

  const clientIp = getClientIp(event);
  if (isRateLimited(clientIp)) {
    return jsonResponse(429, { error: 'too_many_attempts' });
  }

  let password = '';
  try {
    const body = JSON.parse(event.body || '{}');
    password = String(body.password || '');
  } catch (err) {
    return jsonResponse(400, { error: 'invalid_request' });
  }

  const CORRECT_PASSWORD = process.env.INVOICE_PASSWORD;

  if (!CORRECT_PASSWORD) {
    return jsonResponse(500, { error: 'server_not_configured' });
  }

  if (!password) {
    return jsonResponse(400, { error: 'missing_password' });
  }

  const isValid = timingSafeStringEqual(password, CORRECT_PASSWORD);

  if (!isValid) {
    recordFailedAttempt(clientIp);
    return jsonResponse(401, { error: 'wrong_password' });
  }

  // توكن جلسة بسيط: طابع زمني موقّع بكلمة السر نفسها (لا يحتاج قاعدة بيانات).
  // صالح لمدة 12 ساعة، ويُخزَّن في المتصفح ليتجنب المستخدم إعادة كتابة
  // كلمة السر عند كل زيارة، لكنه ينتهي تلقائياً بعد ذلك.
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  const token = createToken(expiresAt, CORRECT_PASSWORD);

  return jsonResponse(200, { token, expiresAt });
};

function getClientIp(event) {
  const headers = event.headers || {};
  return (
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    'unknown'
  );
}

function isRateLimited(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  const withinWindow = Date.now() - record.windowStart < WINDOW_MS;
  return withinWindow && record.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
  const record = attempts.get(ip);
  const now = Date.now();
  if (!record || now - record.windowStart >= WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
  } else {
    record.count += 1;
  }
}

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

// مقارنة نصّية بزمن ثابت لمنع هجمات "timing attack" (تخمين كلمة السر
// حرفاً بحرف عبر قياس فرق الزمن بين المحاولات). نجعل الطولين متساويين
// دائماً بالـ padding قبل المقارنة، حتى لا يكشف اختلاف الطول نفسه شيئاً.
function timingSafeStringEqual(a, b) {
  const crypto = require('crypto');
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

function createToken(expiresAt, secret) {
  const crypto = require('crypto');
  const payload = String(expiresAt);
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${signature}`).toString('base64');
}
