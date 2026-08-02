// admin/lock.js — شاشة قفل موحدة تستخدم BitaqtiAuth
// (يُحمّل بعد auth.js)
// ════════════════════════════════════════════════════════════════
//  يوفر شاشة قفل مرئية (overlay) قابلة لإعادة الاستخدام في أي
//  صفحة إدارية. يتحقق من الجلسة المحفوظة تلقائياً، ويعرض شاشة
//  القفل فقط عند الحاجة. يدعم خيار "تذكّرني لمدة 30 يوماً".
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  if(!window.BitaqtiAuth){
    console.error('[lock.js] BitaqtiAuth not loaded — load auth.js before lock.js');
    return;
  }

  let onUnlockedCallback = null;
  let lockOverlay = null;
  let pendingAuth = false;

  // ═══ التحقق من الرمز عبر السيرفر ═══
  async function verifyPassword(password, remember){
    const result = await BitaqtiAuth.verifyPassword(password);
    if(result.ok){
      BitaqtiAuth.saveSession(password, { remember: !!remember });
    }
    return result;
  }

  // ═══ بناء شاشة القفل (مرة واحدة) ═══
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
          background:#fff;border-radius:20px;padding:32px 28px;
          max-width:400px;width:100%;text-align:center;
          box-shadow:0 24px 60px rgba(0,0,0,.4);
          max-height:92vh;overflow-y:auto;
        }
        #bitaqtiLockIcon{
          width:64px;height:64px;border-radius:50%;
          background:#FBE9EA;color:#CE1126;
          display:flex;align-items:center;justify-content:center;
          margin:0 auto 18px;flex-shrink:0;
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
        #bitaqtiLockRemember{
          display:flex;align-items:center;justify-content:center;gap:8px;
          margin-bottom:14px;font-size:12.5px;color:#53565C;cursor:pointer;
        }
        #bitaqtiLockRemember input{cursor:pointer;width:16px;height:16px;}
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
          <label id="bitaqtiLockRemember">
            <input type="checkbox" id="bitaqtiLockRememberChk">
            <span>تذكّرني على هذا الجهاز لمدة 30 يوماً</span>
          </label>
          <button type="submit" id="bitaqtiLockSubmit">
            <span class="spinner"></span>
            <span class="lock-btn-text">متابعة</span>
          </button>
        </form>
        <div id="bitaqtiLockError"></div>
        <div id="bitaqtiLockHint">
          🔒 هذه المنطقة مخصصة لصاحب المشروع فقط. الرمز هو نفسه المستخدم في صفحة الفواتير.
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
    const rememberChk = overlay.querySelector('#bitaqtiLockRememberChk');
    const submitBtn = overlay.querySelector('#bitaqtiLockSubmit');
    const errorEl = overlay.querySelector('#bitaqtiLockError');

    // استعادة تفضيل "تذكّرني" السابق
    rememberChk.checked = BitaqtiAuth.getRememberPreference();

    toggleBtn.addEventListener('click', () => {
      passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if(pendingAuth) return;
      const password = passwordInput.value;
      if(!password) return;

      pendingAuth = true;
      submitBtn.disabled = true;
      submitBtn.classList.add('loading');
      errorEl.classList.remove('show');

      const result = await verifyPassword(password, rememberChk.checked);

      if(result.ok){
        hideLockScreen();
        if(onUnlockedCallback) onUnlockedCallback();
      } else {
        errorEl.textContent = result.message || 'الرمز غير صحيح.';
        errorEl.classList.add('show');
        passwordInput.value = '';
        passwordInput.focus();
      }

      pendingAuth = false;
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
  window.BitaqtiLock = {
    /**
     * يفرض تسجيل الدخول إن لم تكن الجلسة فعّالة.
     * @param {Object} opts - {title, subtitle, onUnlocked}
     */
    requireAuth(opts = {}){
      onUnlockedCallback = opts.onUnlocked || null;
      const savedPwd = BitaqtiAuth.getSavedPassword();
      if(savedPwd){
        // الجلسة فعّالة — لا حاجة لشاشة القفل
        hideLockScreen();
        if(onUnlockedCallback) onUnlockedCallback();
        return true;
      }
      // لا توجد جلسة فعّالة — أظهر شاشة القفل
      showLockScreen(opts.title, opts.subtitle);
      return false;
    },

    /** يرجع الرمز المحفوظ أو null */
    getPassword(){
      return BitaqtiAuth.getSavedPassword();
    },

    /** يتحقق إن كانت الجلسة فعّالة */
    isAuthenticated(){
      return BitaqtiAuth.getSavedPassword() !== null;
    },

    /** معلومات الجلسة للعرض (مثل الوقت المتبقي) */
    getSessionInfo(){
      return BitaqtiAuth.getSessionInfo();
    },

    /** يمدّد الجلسة (نشاط المستخدم) */
    extendSession(){
      return BitaqtiAuth.extendSession();
    },

    /** إعادة تحقق صامتة من الخادم */
    async silentRevalidate(){
      return await BitaqtiAuth.silentRevalidate();
    },

    /** تسجيل خروج */
    logout(){
      BitaqtiAuth.clearSession();
      window.location.reload();
    },

    /** يضبط callback يُستدعى عند فتح القفل */
    onUnlocked(callback){
      onUnlockedCallback = callback;
    },
  };
})();
