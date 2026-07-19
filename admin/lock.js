
(function(){
  'use strict';

  // ═══ ثوابت ═══
  const TRACK_ENDPOINT = '/.netlify/functions/track-order';
  const PWD_KEY = 'bitaqti_admin_password';
  const SESSION_KEY = 'bitaqti_admin_session';
  const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 ساعة

  // ═══ حالة المكوّن ═══
  let onUnlockedCallback = null;
  let lockOverlay = null;

  // ═══ التحقق من الجلسة المحفوظة ═══
  function getSavedPassword(){
    try {
      // تحقق من صلاحية الجلسة
      const sessionRaw = sessionStorage.getItem(SESSION_KEY);
      if(sessionRaw){
        const session = JSON.parse(sessionRaw);
        if(session.expiresAt && Date.now() < session.expiresAt){
          return sessionStorage.getItem(PWD_KEY) || null;
        }
        // الجلسة منتهية
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(PWD_KEY);
      }
    } catch(e) {}
    return null;
  }

  function saveSession(password){
    try {
      sessionStorage.setItem(PWD_KEY, password);
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL,
      }));
    } catch(e) {}
  }

  function clearSession(){
    try {
      sessionStorage.removeItem(PWD_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch(e) {}
  }

  // ═══ التحقق من الرمز عبر السيرفر ═══
  async function verifyPassword(password){
    try {
      const res = await fetch(TRACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_password: password, mode: 'sync' }),
      });
      if(res.status === 200){
        return { ok: true };
      }
      if(res.status === 401){
        return { ok: false, message: 'الرمز غير صحيح.' };
      }
      if(res.status === 429){
        return { ok: false, message: 'محاولات كثيرة جداً. انتظر دقيقة.' };
      }
      if(res.status === 500){
        return { ok: false, message: 'الخدمة غير مُعدّة على الخادم.' };
      }
      return { ok: false, message: `خطأ في الاتصال (${res.status}).` };
    } catch(err){
      return { ok: false, message: 'تعذّر الاتصال بالخادم. تحقق من الإنترنت.' };
    }
  }

  // ═══ بناء شاشة القفل ═══
  function createLockScreen(){
    if(lockOverlay) return lockOverlay;

    const overlay = document.createElement('div');
    overlay.id = 'bitaqtiLockScreen';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:99999;
      background:linear-gradient(135deg,#17181C 0%,#0a0a0f 100%);
      display:flex;align-items:center;justify-content:center;padding:20px;
      direction:rtl;font-family:'IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif;
    `;
    overlay.innerHTML = `
      <style>
        #bitaqtiLockScreen *{box-sizing:border-box;}
        #bitaqtiLockCard{
          background:#fff;border-radius:20px;padding:36px 32px;
          max-width:400px;width:100%;text-align:center;
          box-shadow:0 24px 60px rgba(0,0,0,.4);
        }
        #bitaqtiLockIcon{
          width:64px;height:64px;border-radius:50%;
          background:#FBE9EA;color:#CE1126;
          display:flex;align-items:center;justify-content:center;
          margin:0 auto 18px;
        }
        #bitaqtiLockIcon svg{width:30px;height:30px;}
        #bitaqtiLockScreen h1{
          font-family:'El Messiri','Segoe UI',Tahoma,sans-serif;
          font-size:22px;font-weight:700;margin-bottom:6px;color:#17181C;
        }
        #bitaqtiLockScreen p{font-size:13px;color:#53565C;margin-bottom:22px;line-height:1.6;}
        #bitaqtiLockInputWrap{position:relative;margin-bottom:14px;}
        #bitaqtiLockPassword{
          width:100%;padding:14px 48px 14px 16px;border:1.5px solid #E3E1D9;
          border-radius:10px;background:#F4F3EF;font-size:16px;
          text-align:center;letter-spacing:2px;direction:ltr;
          font-family:'IBM Plex Mono','Courier New',monospace;
        }
        #bitaqtiLockPassword:focus{outline:none;border-color:#CE1126;box-shadow:0 0 0 3px #FBE9EA;}
        #bitaqtiLockToggle{
          position:absolute;left:8px;top:50%;transform:translateY(-50%);
          background:none;border:none;color:#8A8D93;cursor:pointer;padding:8px;border-radius:8px;
        }
        #bitaqtiLockToggle:hover{color:#17181C;}
        #bitaqtiLockToggle svg{width:18px;height:18px;}
        #bitaqtiLockSubmit{
          width:100%;padding:14px;border:none;border-radius:10px;
          background:#17181C;color:#fff;font-size:14px;font-weight:700;
          cursor:pointer;transition:background .2s;
          display:flex;align-items:center;justify-content:center;gap:8px;
          font-family:inherit;
        }
        #bitaqtiLockSubmit:hover{background:#000;}
        #bitaqtiLockSubmit:disabled{opacity:.6;cursor:not-allowed;}
        #bitaqtiLockSubmit .spinner{
          width:16px;height:16px;border:2px solid rgba(255,255,255,.3);
          border-top-color:#fff;border-radius:50%;animation:bitaqtiLockSpin .6s linear infinite;display:none;
        }
        #bitaqtiLockSubmit.loading .spinner{display:block;}
        #bitaqtiLockSubmit.loading .lock-btn-text{display:none;}
        @keyframes bitaqtiLockSpin{to{transform:rotate(360deg);}}
        #bitaqtiLockError{
          margin-top:14px;padding:10px 14px;background:#FBE9EA;
          color:#9C0E1E;border-radius:8px;font-size:12.5px;font-weight:600;display:none;
        }
        #bitaqtiLockError.show{display:block;}
        #bitaqtiLockHint{
          margin-top:18px;padding:10px 14px;background:#DBEAFE;
          color:#1E3A8A;border-radius:8px;font-size:11.5px;line-height:1.6;text-align:right;
        }
        #bitaqtiLockBack{
          display:inline-block;margin-top:14px;font-size:12.5px;color:#8A8D93;
          text-decoration:none;font-weight:700;
        }
        #bitaqtiLockBack:hover{color:#CE1126;}
      </style>
      <div id="bitaqtiLockCard">
        <div id="bitaqtiLockIcon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
        </div>
        <h1 id="bitaqtiLockTitle">بطاقتي — المنطقة الإدارية</h1>
        <p id="bitaqtiLockSubtitle">هذه المنطقة محمية. أدخل الرمز للمتابعة.</p>
        <form id="bitaqtiLockForm">
          <div id="bitaqtiLockInputWrap">
            <input type="password" id="bitaqtiLockPassword" placeholder="••••••••" autocomplete="current-password" required>
            <button type="button" id="bitaqtiLockToggle" aria-label="إظهار">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <button type="submit" id="bitaqtiLockSubmit">
            <span class="spinner"></span>
            <span class="lock-btn-text">متابعة</span>
          </button>
        </form>
        <div id="bitaqtiLockError"></div>
        <div id="bitaqtiLockHint">
          🔒 هذه المنطقة مخصصة لصاحب المشروع فقط.
        </div>
        <a href="../index.html" id="bitaqtiLockBack">
          ← العودة إلى الموقع العام
        </a>
      </div>
    `;
    document.body.appendChild(overlay);
    lockOverlay = overlay;

    // ربط الأحداث
    const form = overlay.querySelector('#bitaqtiLockForm');
    const passwordInput = overlay.querySelector('#bitaqtiLockPassword');
    const toggleBtn = overlay.querySelector('#bitaqtiLockToggle');
    const submitBtn = overlay.querySelector('#bitaqtiLockSubmit');
    const errorEl = overlay.querySelector('#bitaqtiLockError');

    toggleBtn.addEventListener('click', () => {
      passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = passwordInput.value;
      if(!password) return;

      submitBtn.disabled = true;
      submitBtn.classList.add('loading');
      errorEl.classList.remove('show');

      const result = await verifyPassword(password);

      if(result.ok){
        saveSession(password);
        hideLockScreen();
        if(onUnlockedCallback) onUnlockedCallback();
      } else {
        errorEl.textContent = result.message || 'الرمز غير صحيح.';
        errorEl.classList.add('show');
        passwordInput.value = '';
        passwordInput.focus();
      }

      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
    });

    // تركيز تلقائي على حقل الرمز
    setTimeout(() => passwordInput.focus(), 100);

    return overlay;
  }

  function showLockScreen(title, subtitle){
    const overlay = createLockScreen();
    if(title){
      const t = overlay.querySelector('#bitaqtiLockTitle');
      if(t) t.textContent = title;
    }
    if(subtitle){
      const s = overlay.querySelector('#bitaqtiLockSubtitle');
      if(s) s.textContent = subtitle;
    }
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function hideLockScreen(){
    if(lockOverlay){
      lockOverlay.style.display = 'none';
      document.body.style.overflow = '';
    }
  }

  // ═══ API العامة ═══
  const BitaqtiLock = {
    /**
     * يفرض تسجيل الدخول إن لم تكن الجلسة فعّالة.
     * @param {Object} opts - {title, subtitle, onUnlocked}
     */
    requireAuth(opts = {}){
      onUnlockedCallback = opts.onUnlocked || null;
      const savedPwd = getSavedPassword();
      if(savedPwd){
        // الجلسة فعّالة
        hideLockScreen();
        if(onUnlockedCallback) onUnlockedCallback();
        return true;
      }
      // لا توجد جلسة فعّالة — أظهر شاشة القفل
      // نخفي محتوى الصفحة حتى لا يُرى قبل التحقق
      showLockScreen(opts.title, opts.subtitle);
      return false;
    },

    /** يرجع الرمز المحفوظ أو null */
    getPassword(){
      return getSavedPassword();
    },

    /** يتحقق إن كانت الجلسة فعّالة */
    isAuthenticated(){
      return getSavedPassword() !== null;
    },

    /** تسجيل خروج */
    logout(){
      clearSession();
      // إعادة تحميل الصفحة لإظهار شاشة القفل
      window.location.reload();
    },

    /** يضبط callback يُستدعى عند فتح القفل */
    onUnlocked(callback){
      onUnlockedCallback = callback;
    },
  };

  // تصدير العام
  window.BitaqtiLock = BitaqtiLock;
})();
