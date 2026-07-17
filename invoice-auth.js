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
// ═══ الحماية من محاولات التخمين الآلي (Rate Limiting) ═══
// نحدّ كل IP بحد أقصى 5 محاولات كل 60 ثانية على هذه الدالة تحديداً،
// لمنع أي محاولة تخمين آلية لكلمة السر. هذا أكثر من كافٍ لأي محاولة
// دخول حقيقية منك، حتى لو أخطأت بالكتابة مرتين أو ثلاث.
exports.config = {
  path: '/.netlify/functions/invoice-auth',
  rateLimit: {
    windowLimit: 5,
    windowSize: 60,
    aggregateBy: ['ip', 'domain'],
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
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
    return jsonResponse(401, { error: 'wrong_password' });
  }

  // توكن جلسة بسيط: طابع زمني موقّع بكلمة السر نفسها (لا يحتاج قاعدة بيانات).
  // صالح لمدة 12 ساعة، ويُخزَّن في المتصفح ليتجنب المستخدم إعادة كتابة
  // كلمة السر عند كل زيارة، لكنه ينتهي تلقائياً بعد ذلك.
  const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
  const token = createToken(expiresAt, CORRECT_PASSWORD);

  return jsonResponse(200, { token, expiresAt });
};

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
