// admin/bridge.js — نظام الربط الموحد بين الصفحات الإدارية v1
// ════════════════════════════════════════════════════════════════
//  يوفّر:
//  • BitaqtiBridge — حالة مشتركة + أحداث + تنبيهات + بحث عالمي
//  • BitaqtiQuickNav — شريط تنقل سريع عائم بين الصفحات
//  • BitaqtiNotifications — نظام إشعارات ذكي (تنبيهات تلقائية)
//  • BitaqtiActivity — سجل نشاط موحد
//
//  يُحمّل أولاً (قبل أي enhancements أخرى) في كل صفحة إدارية.
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  if(window.BitaqtiBridge && window.BitaqtiBridge._loaded) return;

  const TRACK_ENDPOINT = '/.netlify/functions/track-order';
  const INVOICES_ENDPOINT = '/.netlify/functions/invoices-manage';
  const ACTIVITY_KEY = 'bitaqti_global_activity_log';
  const NOTIFICATIONS_KEY = 'bitaqti_notifications_v1';
  const LAST_SEEN_NOTIF_KEY = 'bitaqti_last_seen_notif';

  // ════════════════════════════════════════════════════════════════
  //  BitaqtiBridge — الحالة المشتركة
  // ════════════════════════════════════════════════════════════════
  const state = {
    customers: [],          // من Supabase
    invoices: [],           // من Supabase أو localStorage
    lastCustomersSync: 0,
    lastInvoicesSync: 0,
    currentPage: null,      // 'dashboard' | 'invoices' | 'settings' | 'index'
    adminPassword: null,
  };

  // نظام الأحداث البسيط
  const listeners = {};
  function on(event, cb){
    (listeners[event] = listeners[event] || []).push(cb);
    return () => {
      listeners[event] = listeners[event]?.filter(c => c !== cb);
    };
  }
  function emit(event, data){
    (listeners[event] || []).forEach(cb => {
      try { cb(data); } catch(e) { console.warn('[Bridge] listener error', e); }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  المزامنة المشتركة (تستخدمها كل الصفحات)
  // ════════════════════════════════════════════════════════════════
  async function syncCustomers(force = false){
    if(!force && Date.now() - state.lastCustomersSync < 60000){
      return state.customers;
    }
    const pwd = state.adminPassword || (window.BitaqtiAuth && BitaqtiAuth.getSavedPassword()) || '';
    if(!pwd) return state.customers;
    try {
      const res = await fetch(TRACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_password: pwd, mode: 'sync' }),
      });
      if(res.status === 200){
        const data = await res.json();
        state.customers = data.customers || [];
        state.lastCustomersSync = Date.now();
        emit('customers:synced', state.customers);
        return state.customers;
      }
    } catch(e) {}
    return state.customers;
  }

  async function syncInvoices(force = false){
    if(!force && Date.now() - state.lastInvoicesSync < 60000){
      return state.invoices;
    }
    const pwd = state.adminPassword || (window.BitaqtiAuth && BitaqtiAuth.getSavedPassword()) || '';
    if(!pwd) return state.invoices;
    try {
      const res = await fetch(INVOICES_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd, action: 'list' }),
      });
      if(res.status === 200){
        const data = await res.json();
        state.invoices = data.invoices || [];
        state.lastInvoicesSync = Date.now();
        emit('invoices:synced', state.invoices);
        return state.invoices;
      }
    } catch(e) {}
    return state.invoices;
  }

  // ════════════════════════════════════════════════════════════════
  //  البحث العالمي
  // ════════════════════════════════════════════════════════════════
  function globalSearch(query){
    const q = String(query || '').toLowerCase().trim();
    if(!q || q.length < 2) return { customers: [], invoices: [] };
    const phoneQ = q.replace(/[\s\-()+]/g, '');

    const customerMatches = state.customers.filter(c => {
      return [c.customer_name, c.phone, c.order_code, c.package, c.customer_email,
              c.referral_code, c.referred_by, c.cv_link, c.assigned_designer]
        .some(v => String(v || '').toLowerCase().includes(q)) ||
        String(c.phone || '').replace(/[\s\-()+]/g, '').includes(phoneQ);
    }).slice(0, 10);

    const invoiceMatches = state.invoices.filter(inv => {
      return [inv.invoice_no, inv.customer_name, inv.phone, inv.order_code, inv.package]
        .some(v => String(v || '').toLowerCase().includes(q)) ||
        String(inv.phone || '').replace(/[\s\-()+]/g, '').includes(phoneQ);
    }).slice(0, 10);

    return { customers: customerMatches, invoices: invoiceMatches };
  }

  // ════════════════════════════════════════════════════════════════
  //  سجل النشاط الموحد
  // ════════════════════════════════════════════════════════════════
  function logActivity(type, title, details = '', page = null){
    try {
      const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
      log.unshift({
        type, title, details,
        page: page || state.currentPage,
        time: Date.now(),
      });
      // احتفظ بآخر 100 نشاط فقط
      localStorage.setItem(ACTIVITY_KEY, JSON.stringify(log.slice(0, 100)));
      emit('activity:added', log[0]);
    } catch(e) {}
  }

  function getActivityLog(limit = 20){
    try {
      const log = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
      return log.slice(0, limit);
    } catch(e) { return []; }
  }

  function clearActivityLog(){
    try { localStorage.removeItem(ACTIVITY_KEY); } catch(e) {}
    emit('activity:cleared');
  }

  // ════════════════════════════════════════════════════════════════
  //  نظام الإشعارات الذكي
  // ════════════════════════════════════════════════════════════════
  function generateNotifications(){
    const notifs = [];
    const today = new Date().toLocaleDateString('en-GB').split('/').join('/');
    const now = new Date();

    // 1. طلبات يجب تسليمها اليوم
    state.customers.forEach(c => {
      if(c.delivery_date === today && c.status !== 'تم التسليم' && c.status !== 'ملغي'){
        notifs.push({
          id: 'delivery_today_' + c.order_code,
          type: 'urgent',
          icon: '📦',
          title: 'تسليم اليوم',
          message: `${c.customer_name || c.phone} — ${c.order_code}`,
          action: { type: 'open_customer', data: c.phone },
          time: Date.now(),
        });
      }
    });

    // 2. طلبات متأخرة عن التسليم
    state.customers.forEach(c => {
      if(c.delivery_date && c.status !== 'تم التسليم' && c.status !== 'ملغي'){
        const d = parseDDMMYYYY(c.delivery_date);
        if(d && d < now && c.delivery_date !== today){
          const daysLate = Math.floor((now - d) / (24*60*60*1000));
          notifs.push({
            id: 'late_delivery_' + c.order_code,
            type: 'warning',
            icon: '⏰',
            title: `متأخر ${daysLate} يوم`,
            message: `${c.customer_name || c.phone} — ${c.order_code}`,
            action: { type: 'open_customer', data: c.phone },
            time: Date.now(),
          });
        }
      }
    });

    // 3. مدفوعات معلّقة (غير مدفوع)
    state.customers.filter(c => c.payment_status === 'غير مدفوع' && c.status !== 'ملغي').slice(0, 5).forEach(c => {
      notifs.push({
        id: 'pending_payment_' + c.order_code,
        type: 'warning',
        icon: '💰',
        title: 'دفعة معلّقة',
        message: `${c.customer_name || c.phone} — ${(Number(c.total_with_vat)||0).toFixed(3)} د.ب`,
        action: { type: 'open_customer', data: c.phone },
        time: Date.now(),
      });
    });

    // 4. عملاء بدون كود إحالة
    const noReferral = state.customers.filter(c => !c.referral_code).length;
    if(noReferral > 0){
      notifs.push({
        id: 'no_referral_codes',
        type: 'info',
        icon: '🎁',
        title: 'أكواد إحالة ناقصة',
        message: `${noReferral} عميل بدون كود إحالة — سيتم توليدها تلقائياً عند الحفظ`,
        time: Date.now(),
      });
    }

    return notifs;
  }

  function parseDDMMYYYY(s){
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(!m) return null;
    return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]));
  }

  // ════════════════════════════════════════════════════════════════
  //  واجهة المستخدم — شريط التنقل السريع + البحث العالمي + الإشعارات
  // ════════════════════════════════════════════════════════════════
  function detectCurrentPage(){
    const path = window.location.pathname.split('/').pop().toLowerCase();
    if(path.includes('dashboard')) return 'dashboard';
    if(path.includes('invoice')) return 'invoices';
    if(path.includes('setting')) return 'settings';
    if(path === 'index.html' || path === '') return 'index';
    return 'dashboard';
  }

  function injectQuickNav(){
    if(document.getElementById('bitaqtiQuickNav')) return;

    const nav = document.createElement('div');
    nav.id = 'bitaqtiQuickNav';
    nav.style.cssText = `
      position:fixed;
      bottom:16px;
      left:16px;
      z-index:1000;
      background:rgba(23,24,28,.95);
      backdrop-filter:blur(12px);
      border-radius:14px;
      padding:6px;
      display:flex;
      gap:4px;
      box-shadow:0 8px 24px rgba(0,0,0,.25);
      direction:rtl;
      font-family:'IBM Plex Sans Arabic',sans-serif;
    `;

    const pages = [
      { id: 'index',     icon: '🏠', label: 'الرئيسية',     url: 'index.html' },
      { id: 'dashboard', icon: '📊', label: 'لوحة التحكم', url: 'dashboard.html' },
      { id: 'invoices',  icon: '🧾', label: 'الفواتير',     url: 'invoices.html' },
      { id: 'settings',  icon: '⚙️', label: 'الإعدادات',    url: 'settings.html' },
    ];

    const current = state.currentPage;
    nav.innerHTML = pages.map(p => `
      <button class="qn-btn" data-url="${p.url}" title="${p.label}"
        style="padding:8px 12px;border:none;border-radius:10px;cursor:pointer;font-size:14px;font-weight:700;
        background:${p.id === current ? 'var(--red,#CE1126)' : 'transparent'};
        color:${p.id === current ? '#fff' : 'rgba(255,255,255,.7)'};
        display:flex;align-items:center;gap:4px;transition:all .15s;">
        <span>${p.icon}</span>
        <span style="font-size:11px;">${p.label}</span>
      </button>
    `).join('');

    // أزرار إضافية: بحث + إشعارات
    const extraBtns = document.createElement('div');
    extraBtns.style.cssText = 'display:flex;gap:4px;border-right:1px solid rgba(255,255,255,.15);padding-right:6px;margin-right:2px;';
    extraBtns.innerHTML = `
      <button id="qnSearch" title="بحث عالمي (Ctrl+K)"
        style="padding:8px 10px;border:none;border-radius:10px;cursor:pointer;font-size:14px;background:transparent;color:rgba(255,255,255,.7);position:relative;">
        🔍
        <span id="qnSearchHint" style="position:absolute;bottom:-2px;right:-2px;background:var(--blue,#2563EB);color:#fff;font-size:8px;padding:1px 3px;border-radius:4px;font-weight:700;">K</span>
      </button>
      <button id="qnNotifs" title="الإشعارات"
        style="padding:8px 10px;border:none;border-radius:10px;cursor:pointer;font-size:14px;background:transparent;color:rgba(255,255,255,.7);position:relative;">
        🔔
        <span id="qnNotifBadge" style="position:absolute;top:2px;left:2px;background:var(--red,#CE1126);color:#fff;font-size:9px;min-width:14px;height:14px;border-radius:7px;display:none;align-items:center;justify-content:center;font-weight:700;padding:0 3px;">0</span>
      </button>
    `;
    nav.insertBefore(extraBtns, nav.firstChild);

    document.body.appendChild(nav);

    // ربط التنقل
    nav.querySelectorAll('.qn-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.href = btn.dataset.url;
      });
      btn.addEventListener('mouseenter', () => {
        if(!btn.classList.contains('active')) btn.style.background = 'rgba(255,255,255,.1)';
      });
      btn.addEventListener('mouseleave', () => {
        if(btn.dataset.url !== pages.find(p => p.id === current).url){
          btn.style.background = 'transparent';
        }
      });
    });

    // ربط البحث
    $('qnSearch').addEventListener('click', openGlobalSearch);

    // ربط الإشعارات
    $('qnNotifs').addEventListener('click', openNotificationsPanel);

    // اختصار Ctrl+K للبحث
    document.addEventListener('keydown', (e) => {
      if((e.ctrlKey || e.metaKey) && e.key === 'k'){
        e.preventDefault();
        openGlobalSearch();
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  البحث العالمي
  // ════════════════════════════════════════════════════════════════
  function openGlobalSearch(){
    let overlay = document.getElementById('bitaqtiGlobalSearch');
    if(overlay){
      overlay.style.display = 'flex';
      setTimeout(() => $('gsInput')?.focus(), 50);
      return;
    }
    overlay = document.createElement('div');
    overlay.id = 'bitaqtiGlobalSearch';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;background:rgba(23,24,28,.6);backdrop-filter:blur(6px);
      display:flex;align-items:flex-start;justify-content:center;padding:60px 16px 16px;
      direction:rtl;font-family:'IBM Plex Sans Arabic',sans-serif;
    `;
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:600px;width:100%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.3);">
        <div style="padding:14px 16px;border-bottom:1px solid #E3E1D9;display:flex;align-items:center;gap:10px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="#53565C" stroke-width="2" style="width:20px;height:20px;"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input id="gsInput" type="text" placeholder="ابحث في كل العملاء والفواتير... (Esc للإغلاق)"
            style="flex:1;border:none;outline:none;font-size:15px;font-family:inherit;background:transparent;">
          <kbd style="background:#F4F3EF;padding:2px 6px;border-radius:4px;font-size:10px;color:#53565C;">Esc</kbd>
        </div>
        <div id="gsResults" style="overflow-y:auto;flex:1;padding:8px;">
          <div style="text-align:center;color:#8A8D93;font-size:12px;padding:30px;">ابدأ الكتابة للبحث في كل الأنظمة...</div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if(e.target === overlay) overlay.style.display = 'none';
    });

    const input = $('gsInput');
    let timer = null;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => updateSearchResults(input.value), 200);
    });

    // ESC للإغلاق
    input.addEventListener('keydown', (e) => {
      if(e.key === 'Escape'){
        overlay.style.display = 'none';
      }
    });

    setTimeout(() => input.focus(), 50);
  }

  function updateSearchResults(query){
    const results = globalSearch(query);
    const container = $('gsResults');
    if(!container) return;

    if(!query || query.length < 2){
      container.innerHTML = '<div style="text-align:center;color:#8A8D93;font-size:12px;padding:30px;">ابدأ الكتابة للبحث في كل الأنظمة...</div>';
      return;
    }

    if(results.customers.length === 0 && results.invoices.length === 0){
      container.innerHTML = '<div style="text-align:center;color:#8A8D93;font-size:12px;padding:30px;">لا توجد نتائج مطابقة</div>';
      return;
    }

    let html = '';
    if(results.customers.length > 0){
      html += `<div style="font-size:11px;font-weight:700;color:#53565C;padding:6px 10px;">العملاء (${results.customers.length})</div>`;
      html += results.customers.map(c => {
        const total = Number(c.total_with_vat) || 0;
        return `
          <div class="gs-item" data-type="customer" data-phone="${escapeAttr(c.phone)}"
            style="padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;border:1px solid transparent;margin-bottom:2px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <div style="width:32px;height:32px;border-radius:8px;background:#FBE9EA;color:#CE1126;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;">👤</div>
              <div>
                <div style="font-size:13px;font-weight:700;color:#17181C;">${escapeHtml(c.customer_name || '—')}</div>
                <div style="font-size:10px;color:#8A8D93;" dir="ltr">${escapeHtml(c.phone || '—')} · ${escapeHtml(c.order_code || '—')}</div>
              </div>
            </div>
            <div style="text-align:left;">
              <div style="font-size:11px;font-weight:700;color:#17181C;">${total.toFixed(3)} د.ب</div>
              <div style="font-size:9px;color:${c.payment_status === 'مدفوع' ? '#0C9A63' : '#D97706'};">${escapeHtml(c.payment_status || '—')}</div>
            </div>
          </div>
        `;
      }).join('');
    }

    if(results.invoices.length > 0){
      html += `<div style="font-size:11px;font-weight:700;color:#53565C;padding:6px 10px;margin-top:8px;">الفواتير (${results.invoices.length})</div>`;
      html += results.invoices.map(inv => `
        <div class="gs-item" data-type="invoice" data-id="${escapeAttr(inv.invoice_no)}"
          style="padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:8px;border:1px solid transparent;margin-bottom:2px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="width:32px;height:32px;border-radius:8px;background:#DBEAFE;color:#2563EB;display:flex;align-items:center;justify-content:center;font-size:14px;">🧾</div>
            <div>
              <div style="font-size:13px;font-weight:700;color:#17181C;font-family:'IBM Plex Mono',monospace;" dir="ltr">${escapeHtml(inv.invoice_no || '—')}</div>
              <div style="font-size:10px;color:#8A8D93;">${escapeHtml(inv.customer_name || '—')}</div>
            </div>
          </div>
          <div style="text-align:left;">
            <div style="font-size:11px;font-weight:700;color:#17181C;">${(Number(inv.total)||0).toFixed(3)} د.ب</div>
            <div style="font-size:9px;color:#53565C;">${escapeHtml(inv.status || '—')}</div>
          </div>
        </div>
      `).join('');
    }

    container.innerHTML = html;

    // تأثير hover
    container.querySelectorAll('.gs-item').forEach(item => {
      item.addEventListener('mouseenter', () => {
        item.style.background = '#F4F3EF';
        item.style.borderColor = '#E3E1D9';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
        item.style.borderColor = 'transparent';
      });
      item.addEventListener('click', () => {
        const type = item.dataset.type;
        if(type === 'customer'){
          // لو في dashboard، افتح العميل. وإلا اذهب لـ dashboard
          if(state.currentPage === 'dashboard' && typeof viewCustomer === 'function'){
            const phone = item.dataset.phone;
            const c = state.customers.find(x => String(x.phone) === String(phone));
            if(c) viewCustomer(c);
            overlay.style.display = 'none';
          } else {
            // احفظ العميل وانتقل لـ dashboard
            try {
              const phone = item.dataset.phone;
              const c = state.customers.find(x => String(x.phone) === String(phone));
              if(c){
                localStorage.setItem('bitaqti_pending_customer', JSON.stringify(c));
              }
            } catch(e) {}
            window.location.href = 'dashboard.html?from=search';
          }
        } else if(type === 'invoice'){
          if(state.currentPage === 'invoices'){
            // ابحث عن الفاتورة محلياً وافتحها
            const id = item.dataset.id;
            if(typeof invoices !== 'undefined' && typeof loadInvoice === 'function'){
              const inv = invoices.find(i => i.invoiceNo === id || i.code === id);
              if(inv) loadInvoice(inv.id);
              overlay.style.display = 'none';
            }
          } else {
            try {
              localStorage.setItem('bitaqti_pending_invoice', item.dataset.id);
            } catch(e) {}
            window.location.href = 'invoices.html?from=search';
          }
        }
      });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  لوحة الإشعارات
  // ════════════════════════════════════════════════════════════════
  function openNotificationsPanel(){
    let overlay = document.getElementById('bitaqtiNotifPanel');
    if(overlay){
      overlay.style.display = 'flex';
      // علّم الكل كمقروء
      try { localStorage.setItem(LAST_SEEN_NOTIF_KEY, Date.now().toString()); } catch(e) {}
      updateNotifBadge();
      return;
    }
    overlay = document.createElement('div');
    overlay.id = 'bitaqtiNotifPanel';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;background:rgba(23,24,28,.6);backdrop-filter:blur(6px);
      display:flex;align-items:flex-start;justify-content:center;padding:60px 16px 16px;
      direction:rtl;font-family:'IBM Plex Sans Arabic',sans-serif;
    `;
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;max-width:500px;width:100%;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.3);">
        <div style="padding:14px 16px;border-bottom:1px solid #E3E1D9;display:flex;justify-content:space-between;align-items:center;">
          <h3 style="font-size:15px;font-weight:700;color:#17181C;display:flex;align-items:center;gap:6px;">🔔 الإشعارات</h3>
          <button id="npClose" style="background:none;border:none;font-size:20px;cursor:pointer;color:#8A8D93;">×</button>
        </div>
        <div id="npList" style="overflow-y:auto;flex:1;padding:8px;"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if(e.target === overlay || e.target.id === 'npClose'){
        overlay.style.display = 'none';
        try { localStorage.setItem(LAST_SEEN_NOTIF_KEY, Date.now().toString()); } catch(e) {}
        updateNotifBadge();
      }
    });

    const notifs = generateNotifications();
    const list = $('npList');
    if(notifs.length === 0){
      list.innerHTML = `
        <div style="text-align:center;padding:40px 20px;">
          <div style="font-size:36px;margin-bottom:8px;">✅</div>
          <div style="font-size:13px;color:#53565C;font-weight:700;">لا توجد إشعارات</div>
          <div style="font-size:11px;color:#8A8D93;margin-top:4px;">كل شيء على ما يرام!</div>
        </div>
      `;
    } else {
      const typeColors = {
        urgent: { bg: '#FBE9EA', color: '#CE1126', border: '#CE1126' },
        warning: { bg: '#FEF3C7', color: '#D97706', border: '#D97706' },
        info: { bg: '#DBEAFE', color: '#2563EB', border: '#2563EB' },
      };
      list.innerHTML = notifs.map(n => {
        const c = typeColors[n.type] || typeColors.info;
        return `
          <div class="notif-item" style="padding:12px;background:${c.bg};border-right:3px solid ${c.border};border-radius:8px;margin-bottom:6px;cursor:${n.action ? 'pointer' : 'default'};">
            <div style="display:flex;align-items:flex-start;gap:8px;">
              <span style="font-size:18px;flex-shrink:0;">${n.icon}</span>
              <div style="flex:1;">
                <div style="font-size:12px;font-weight:700;color:${c.color};">${escapeHtml(n.title)}</div>
                <div style="font-size:11px;color:#17181C;margin-top:2px;">${escapeHtml(n.message)}</div>
              </div>
            </div>
          </div>
        `;
      }).join('');
      // ربط النقر
      list.querySelectorAll('.notif-item').forEach((item, i) => {
        const n = notifs[i];
        if(n.action){
          item.addEventListener('click', () => {
            if(n.action.type === 'open_customer'){
              if(state.currentPage === 'dashboard' && typeof viewCustomer === 'function'){
                const c = state.customers.find(x => String(x.phone) === String(n.action.data));
                if(c) viewCustomer(c);
                overlay.style.display = 'none';
              } else {
                window.location.href = 'dashboard.html?phone=' + encodeURIComponent(n.action.data);
              }
            }
          });
        }
      });
    }
    try { localStorage.setItem(LAST_SEEN_NOTIF_KEY, Date.now().toString()); } catch(e) {}
    updateNotifBadge();
  }

  function updateNotifBadge(){
    const notifs = generateNotifications();
    const badge = $('qnNotifBadge');
    if(!badge) return;
    if(notifs.length > 0){
      badge.style.display = 'flex';
      badge.textContent = notifs.length > 9 ? '9+' : notifs.length;
    } else {
      badge.style.display = 'none';
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  Helpers
  // ════════════════════════════════════════════════════════════════
  function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s){
    return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  }

  // ════════════════════════════════════════════════════════════════
  //  التهيئة
  // ════════════════════════════════════════════════════════════════
  function init(){
    state.currentPage = detectCurrentPage();
    state.adminPassword = (window.BitaqtiAuth && BitaqtiAuth.getSavedPassword()) || '';

    // حقن شريط التنقل السريع
    setTimeout(() => {
      injectQuickNav();
      // بدأ المزامنة بشكل صامت
      syncCustomers(true).then(() => {
        updateNotifBadge();
      });
      // محاولة مزامنة الفواتير (لو Supabase مهيّأ)
      syncInvoices(true);
    }, 800);

    // اقرأ عميل/فاتورة معلّقة من البحث العالمي
    const params = new URLSearchParams(window.location.search);
    if(params.get('from') === 'search'){
      const pendingCustomer = localStorage.getItem('bitaqti_pending_customer');
      const pendingInvoice = localStorage.getItem('bitaqti_pending_invoice');
      if(pendingCustomer && state.currentPage === 'dashboard'){
        try {
          const c = JSON.parse(pendingCustomer);
          localStorage.removeItem('bitaqti_pending_customer');
          // انتظر تحميل الصفحة ثم افتح العميل
          setTimeout(() => {
            if(typeof viewCustomer === 'function') viewCustomer(c);
            else if(typeof openEditModal === 'function') openEditModal(c);
          }, 1500);
        } catch(e) {}
      }
      if(pendingInvoice && state.currentPage === 'invoices'){
        try {
          const id = pendingInvoice;
          localStorage.removeItem('bitaqti_pending_invoice');
          setTimeout(() => {
            if(typeof invoices !== 'undefined' && typeof loadInvoice === 'function'){
              const inv = invoices.find(i => i.invoiceNo === id || i.code === id);
              if(inv) loadInvoice(inv.id);
            }
          }, 1500);
        } catch(e) {}
      }
    }

    // اقرأ ?phone=XXXX
    if(params.get('phone') && state.currentPage === 'dashboard'){
      const phone = params.get('phone');
      setTimeout(() => {
        // انتظر تحميل العملاء
        const checkInterval = setInterval(() => {
          if(state.customers.length > 0){
            clearInterval(checkInterval);
            const c = state.customers.find(x => String(x.phone) === String(phone));
            if(c && typeof viewCustomer === 'function') viewCustomer(c);
          }
        }, 500);
        // أوقف الفحص بعد 10 ثوان
        setTimeout(() => clearInterval(checkInterval), 10000);
      }, 1000);
    }

    // اقرأ ?invoice=XXXX
    if(params.get('invoice') && state.currentPage === 'invoices'){
      const id = params.get('invoice');
      setTimeout(() => {
        if(typeof invoices !== 'undefined' && typeof loadInvoice === 'function'){
          const inv = invoices.find(i => i.invoiceNo === id || i.code === id);
          if(inv) loadInvoice(inv.id);
        }
      }, 1500);
    }

    console.log('[BitaqtiBridge] v1 loaded on page:', state.currentPage);
  }

  // ════════════════════════════════════════════════════════════════
  //  API العامة
  // ════════════════════════════════════════════════════════════════
  window.BitaqtiBridge = {
    _loaded: true,
    _version: '1.0',
    state,
    on,
    emit,
    syncCustomers,
    syncInvoices,
    globalSearch,
    logActivity,
    getActivityLog,
    clearActivityLog,
    generateNotifications,
    openGlobalSearch,
    openNotificationsPanel,
    updateNotifBadge,
  };

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
