// admin/auth.js — وحدة المصادقة المشتركة (نسخة دفاعية v3)
// ════════════════════════════════════════════════════════════════
//  تحسينات v3:
//  • لو فشل تحميل الملف أو حدث خطأ، نُسلّم BitaqtiAuth كوهمي يرجع
//    false/null دائماً — هذا يمنع كسر الصفحة بالكامل ويسمح للمستخدم
//    برؤية شاشة القفل بدلاً من شاشة بيضاء.
//  • رسائل خطأ واضحة في console لمساعدتك على التشخيص.
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  // إذا كان BitaqtiAuth معرّفاً مسبقاً، لا نعيد التعريف
  if(window.BitaqtiAuth && window.BitaqtiAuth._loaded){
    return;
  }

  const TRACK_ENDPOINT = '/.netlify/functions/track-order';
  const PWD_KEY = 'bitaqti_admin_password';
  const SESSION_KEY = 'bitaqti_admin_session';
  const REMEMBER_KEY = 'bitaqti_admin_remember';
  const SESSION_TTL_LONG = 30 * 24 * 60 * 60 * 1000;  // 30 يوم
  const SESSION_TTL_SHORT = 4 * 60 * 60 * 1000;        // 4 ساعات

  // ── تخزين آمن مع fallback ──
  function storageGet(key){
    try {
      const v = localStorage.getItem(key);
      if(v !== null) return v;
    } catch(e) {}
    try {
      const v = sessionStorage.getItem(key);
      if(v !== null) return v;
    } catch(e) {}
    return null;
  }

  function storageSet(key, val){
    try { localStorage.setItem(key, val); } catch(e) {}
    try { sessionStorage.setItem(key, val); } catch(e) {}
  }

  function storageRemove(key){
    try { localStorage.removeItem(key); } catch(e) {}
    try { sessionStorage.removeItem(key); } catch(e) {}
  }

  function getRememberPreference(){
    try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch(e) { return false; }
  }

  function setRememberPreference(remember){
    try { localStorage.setItem(REMEMBER_KEY, remember ? '1' : '0'); } catch(e) {}
  }

  function getTTL(){
    return getRememberPreference() ? SESSION_TTL_LONG : SESSION_TTL_SHORT;
  }

  // ═══ التحقق من الجلسة المحفوظة ═══
  function getSavedPassword(){
    try {
      const sessionRaw = storageGet(SESSION_KEY);
      if(!sessionRaw) return null;
      const session = JSON.parse(sessionRaw);
      if(!session.expiresAt || Date.now() >= session.expiresAt){
        storageRemove(SESSION_KEY);
        storageRemove(PWD_KEY);
        return null;
      }
      return storageGet(PWD_KEY) || null;
    } catch(e) {
      console.warn('[BitaqtiAuth] getSavedPassword error:', e);
      return null;
    }
  }

  function getSessionInfo(){
    try {
      const sessionRaw = storageGet(SESSION_KEY);
      if(!sessionRaw) return null;
      const session = JSON.parse(sessionRaw);
      if(!session.expiresAt || Date.now() >= session.expiresAt) return null;
      return {
        createdAt: session.createdAt || 0,
        expiresAt: session.expiresAt,
        remainingMs: session.expiresAt - Date.now(),
        remember: getRememberPreference(),
      };
    } catch(e) { return null; }
  }

  function saveSession(password, opts){
    try {
      opts = opts || {};
      const ttl = opts.ttl || getTTL();
      if(opts.remember !== undefined) setRememberPreference(opts.remember);
      storageSet(PWD_KEY, password);
      storageSet(SESSION_KEY, JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + ttl,
      }));
      return true;
    } catch(e) {
      console.error('[BitaqtiAuth] saveSession error:', e);
      return false;
    }
  }

  function extendSession(){
    const pwd = getSavedPassword();
    if(pwd){ saveSession(pwd); return true; }
    return false;
  }

  function clearSession(){
    storageRemove(PWD_KEY);
    storageRemove(SESSION_KEY);
  }

  // ═══ التحقق من الرمز عبر السيرفر ═══
  // مميز بين 3 حالات:
  //   - ok: true → كلمة المرور صحيحة
  //   - ok: false + wrongPassword: true → كلمة المرور خاطئة فعلاً (آمن مسح الجلسة)
  //   - ok: false + wrongPassword: false → خطأ شبكة/خادم (لا تمسح الجلسة)
  async function verifyPassword(password){
    try {
      const res = await fetch(TRACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_password: password, mode: 'sync' }),
      });
      if(res.status === 200) return { ok: true };
      // فقط 401 يعني كلمة المرور خاطئة فعلاً
      if(res.status === 401) return { ok: false, wrongPassword: true, message: 'الرمز غير صحيح.' };
      // 429 → محاولات كثيرة (لا نمسح الجلسة، المستخدم سيعيد المحاولة)
      if(res.status === 429) return { ok: false, wrongPassword: false, message: 'محاولات كثيرة جداً. انتظر دقيقة.' };
      // 500 / 502 → خطأ في الخادم أو قاعدة البيانات (لا نمسح الجلسة)
      if(res.status === 500){
        let data = {};
        try { data = await res.json(); } catch(_) {}
        if(data.error === 'server_not_configured'){
          return { ok: false, wrongPassword: false, message: '⚠️ قاعدة البيانات غير مُعدّة على الخادم. تحقق من SUPABASE_URL و SUPABASE_SERVICE_KEY في Netlify. راجع ملف TROUBLESHOOTING.md.' };
        }
        return { ok: false, wrongPassword: false, message: 'الخدمة غير مُعدّة على الخادم.' };
      }
      if(res.status === 502){
        return { ok: false, wrongPassword: false, message: '⚠️ تعذّر الوصول إلى قاعدة البيانات (502). تحقق من صحة SUPABASE_URL (يجب أن يبدأ بـ https:// وينتهي بـ .supabase.co) ومن عدم توقف مشروع Supabase. راجع TROUBLESHOOTING.md.' };
      }
      // أي خطأ HTTP آخر — لا نمسح الجلسة
      return { ok: false, wrongPassword: false, message: `خطأ في الاتصال (${res.status}).` };
    } catch(err){
      console.error('[BitaqtiAuth] verifyPassword network error:', err);
      // خطأ شبكة — لا نمسح الجلسة بالتأكيد
      return { ok: false, wrongPassword: false, message: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت أو من نشر دوال Netlify.' };
    }
  }

  // ═══ إعادة التحقق الصامتة ═══
  // مهم: لا نمسح الجلسة إلا لو تأكدنا أن كلمة المرور خاطئة فعلاً (wrongPassword: true).
  // أخطاء الشبكة/الخادم/Supabase لا تُسقط الجلسة — المستخدم يبقى مسجلاً.
  async function silentRevalidate(){
    const pwd = getSavedPassword();
    if(!pwd) return false;
    const result = await verifyPassword(pwd);
    if(!result.ok){
      // مسح الجلسة فقط لو كلمة المرور خاطئة فعلاً
      if(result.wrongPassword){
        console.warn('[BitaqtiAuth] password rejected by server, clearing session');
        clearSession();
        return false;
      }
      // خطأ مؤقت — نبقي الجلسة، نمدّدها
      console.warn('[BitaqtiAuth] revalidate failed (transient), keeping session:', result.message);
      extendSession();
      return true;  // اعتبر الجلسة فعّالة لتجنّب طرد المستخدم
    }
    extendSession();
    return true;
  }

  // ═══ معالجة bfcache و visibilitychange ═══
  function setupLifecycleHandlers(onRevalidated){
    try {
      window.addEventListener('pageshow', (event) => {
        const pwd = getSavedPassword();
        if(!pwd){
          if(onRevalidated) onRevalidated(false);
        } else if(event.persisted){
          if(onRevalidated) onRevalidated(true);
        }
      });

      let lastVisible = Date.now();
      document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible'){
          const idleMs = Date.now() - lastVisible;
          if(idleMs > 5 * 60 * 1000){
            silentRevalidate().then(ok => {
              if(onRevalidated) onRevalidated(ok);
            });
          }
        } else {
          lastVisible = Date.now();
        }
      });

      window.addEventListener('beforeunload', () => {
        const pwd = getSavedPassword();
        if(pwd){
          try { localStorage.setItem(PWD_KEY, pwd); } catch(e) {}
        }
      });
    } catch(e) {
      console.warn('[BitaqtiAuth] setupLifecycleHandlers error:', e);
    }
  }

  // ═══ API العامة ═══
  window.BitaqtiAuth = {
    _loaded: true,
    _version: '3.0',
    getSavedPassword,
    getSessionInfo,
    saveSession,
    extendSession,
    clearSession,
    verifyPassword,
    silentRevalidate,
    setupLifecycleHandlers,
    getRememberPreference,
    setRememberPreference,
    TTL_LONG: SESSION_TTL_LONG,
    TTL_SHORT: SESSION_TTL_SHORT,
  };

  console.log('[BitaqtiAuth] v3.0 loaded successfully');
})();

// ════════════════════════════════════════════════════════════════
//  FALLBACK آمن: لو فشل تحميل BitaqtiAuth لأي سبب (مثلاً الملف
//  لم يُرفع)، نُسلّم نسخة وهمية ترجع null/false دائماً بدلاً من
//  رمي ReferenceError الذي يكسر الصفحة كلها. هذا يضمن أن المستخدم
//  يرى شاشة القفل على الأقل، بدلاً من شاشة بيضاء.
// ════════════════════════════════════════════════════════════════
if(!window.BitaqtiAuth){
  console.error('[BitaqtiAuth] FAILED to load — using emergency fallback');
  window.BitaqtiAuth = {
    _loaded: false,
    _version: 'fallback',
    getSavedPassword: () => null,
    getSessionInfo: () => null,
    saveSession: () => false,
    extendSession: () => false,
    clearSession: () => {},
    verifyPassword: async (pwd) => {
      // Fallback: تحقق مباشرة عبر track-order
      try {
        const res = await fetch('/.netlify/functions/track-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ admin_password: pwd, mode: 'sync' }),
        });
        if(res.status === 200) return { ok: true };
        if(res.status === 401) return { ok: false, wrongPassword: true, message: 'الرمز غير صحيح.' };
        if(res.status === 502) return { ok: false, wrongPassword: false, message: 'تعذّر الوصول لقاعدة البيانات (502). راجع TROUBLESHOOTING.md.' };
        return { ok: false, wrongPassword: false, message: `خطأ (${res.status}).` };
      } catch(e){
        return { ok: false, wrongPassword: false, message: 'تعذّر الاتصال بالخادم.' };
      }
    },
    silentRevalidate: async () => false,
    setupLifecycleHandlers: () => {},
    getRememberPreference: () => false,
    setRememberPreference: () => {},
  };
}
