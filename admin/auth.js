// admin/auth.js — وحدة المصادقة المشتركة
// ════════════════════════════════════════════════════════════════
//  مشكلة كانت: جلسة sessionStorage تُفقد كلما خرج المستخدم من الصفحة
//  قليلاً (تبديل تطبيق على الهاتف، إغلاق التبويب، إلخ)، فيضطر لمسح
//  بيانات الموقع وإعادة تسجيل الدخول.
//
//  الحل: استخدم localStorage مع TTL طويل (30 يوم افتراضياً)، وأضف
//  معالجة صريحة لحدث pageshow (bfcache) و visibilitychange.
//
//  الاستخدام من أي صفحة إدارية:
//    <script src="auth.js"></script>
//    <script>
//      BitaqtiAuth.requireAuth({ onUnlocked: () => { ... } });
//      const pwd = BitaqtiAuth.getPassword();
//      BitaqtiAuth.logout();
//    </script>
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  const TRACK_ENDPOINT = '/.netlify/functions/track-order';
  const PWD_KEY = 'bitaqti_admin_password';
  const SESSION_KEY = 'bitaqti_admin_session';
  const SESSION_TTL_DEFAULT = 30 * 24 * 60 * 60 * 1000; // 30 يوم افتراضياً
  const REMEMBER_KEY = 'bitaqti_admin_remember'; // "1" لو اختار "تذكرني"

  // خلفية متوافقة: sessionStorage → localStorage للحالات القديمة
  function storageGet(key){
    // نحاول localStorage أولاً (الأهم — يستمر عبر إغلاق التبويب)
    try {
      const v = localStorage.getItem(key);
      if(v !== null) return v;
    } catch(e) {}
    // ثم sessionStorage (للجلسات القديمة قبل التحديث)
    try {
      const v = sessionStorage.getItem(key);
      if(v !== null) return v;
    } catch(e) {}
    return null;
  }

  function storageSet(key, val){
    try { localStorage.setItem(key, val); } catch(e) {}
    // نُبقي نسخة في sessionStorage أيضاً للتوافق مع الكود القديم
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
    // لو اختار "تذكرني": 30 يوم. وإلا: 4 ساعات (جلسة عمل يومية).
    return getRememberPreference() ? SESSION_TTL_DEFAULT : (4 * 60 * 60 * 1000);
  }

  // ═══ التحقق من صلاحية الجلسة المحفوظة ═══
  function getSavedPassword(){
    const sessionRaw = storageGet(SESSION_KEY);
    if(!sessionRaw) return null;
    try {
      const session = JSON.parse(sessionRaw);
      if(!session.expiresAt || Date.now() >= session.expiresAt){
        // الجلسة منتهية — نظّف
        storageRemove(SESSION_KEY);
        storageRemove(PWD_KEY);
        return null;
      }
      const pwd = storageGet(PWD_KEY);
      return pwd || null;
    } catch(e) {
      storageRemove(SESSION_KEY);
      storageRemove(PWD_KEY);
      return null;
    }
  }

  function getSessionInfo(){
    const sessionRaw = storageGet(SESSION_KEY);
    if(!sessionRaw) return null;
    try {
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

  function saveSession(password, opts = {}){
    const ttl = opts.ttl || getTTL();
    if(opts.remember !== undefined) setRememberPreference(opts.remember);
    storageSet(PWD_KEY, password);
    storageSet(SESSION_KEY, JSON.stringify({
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    }));
  }

  function extendSession(){
    // مدّد الجلسة بنفس TTL السابق (تجديد النشاط)
    const pwd = getSavedPassword();
    if(pwd){
      saveSession(pwd);
      return true;
    }
    return false;
  }

  function clearSession(){
    storageRemove(PWD_KEY);
    storageRemove(SESSION_KEY);
    // نُبقي تفضيل "تذكرني" حتى لا يضطر المستخدم لإعادة اختياره
  }

  // ═══ التحقق من الرمز عبر السيرفر ═══
  async function verifyPassword(password){
    try {
      const res = await fetch(TRACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_password: password, mode: 'sync' }),
      });
      if(res.status === 200) return { ok: true };
      if(res.status === 401) return { ok: false, message: 'الرمز غير صحيح.' };
      if(res.status === 429) return { ok: false, message: 'محاولات كثيرة جداً. انتظر دقيقة.' };
      if(res.status === 500) return { ok: false, message: 'الخدمة غير مُعدّة على الخادم. تحقق من متغيرات البيئة في Netlify.' };
      return { ok: false, message: `خطأ في الاتصال (${res.status}).` };
    } catch(err){
      return { ok: false, message: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت.' };
    }
  }

  // ═══ إعادة التحقق التلقائي (silent reauth) ═══
  // نتحقق من الخادم أن الرمز لا يزال صالحاً دون إزعاج المستخدم.
  // لو فشل (تغيير الرمز مثلاً)، نطالبه بإعادة الدخول.
  async function silentRevalidate(){
    const pwd = getSavedPassword();
    if(!pwd) return false;
    const result = await verifyPassword(pwd);
    if(!result.ok){
      // الرمز لم يعد صالحاً — امسح الجلسة
      clearSession();
      return false;
    }
    // مدّد الجلسة عند كل نجاح
    extendSession();
    return true;
  }

  // ═══ معالجة bfcache و visibilitychange ═══
  // هذه هي الإصلاحات الحرجة لمشكلة "التعليق بعد الخروج من الصفحة"
  function setupLifecycleHandlers(onRevalidated){
    // bfcache: عندما يعود المستخدم للصفحة عبر زر الرجوع
    window.addEventListener('pageshow', (event) => {
      // بغض النظر عن event.persisted، تأكد من أن الجلسة لا تزال محفوظة
      const pwd = getSavedPassword();
      if(!pwd){
        // الجلسة ضاعت — اطلب إعادة الدخول بصمت
        if(onRevalidated) onRevalidated(false);
      } else if(event.persisted){
        // الصفحة عادت من bfcache — الجلسة لا تزال صالحة
        if(onRevalidated) onRevalidated(true);
      }
    });

    // visibilitychange: عندما يرجع المستخدم للتبويب بعد تبديل تطبيق
    let lastVisible = Date.now();
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible'){
        const idleMs = Date.now() - lastVisible;
        // لو غاب أكثر من 5 دقائق، أعد التحقق من الخادم بصمت
        if(idleMs > 5 * 60 * 1000){
          silentRevalidate().then(ok => {
            if(onRevalidated) onRevalidated(ok);
          });
        }
      } else {
        lastVisible = Date.now();
      }
    });

    // قبل إغلاق الصفحة: تأكد من حفظ الجلسة في localStorage
    // (يحدث تلقائياً، لكن نضمنه كاحتياط)
    window.addEventListener('beforeunload', () => {
      const pwd = getSavedPassword();
      if(pwd){
        try { localStorage.setItem(PWD_KEY, pwd); } catch(e) {}
      }
    });
  }

  // ═══ API العامة ═══
  window.BitaqtiAuth = {
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
    TTL_LONG: SESSION_TTL_DEFAULT,             // 30 يوم
    TTL_SHORT: 4 * 60 * 60 * 1000,             // 4 ساعات
  };
})();
