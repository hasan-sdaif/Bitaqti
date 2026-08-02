// admin/dashboard-enhancements-v3.js — تحسينات لوحة التحكم v3 (تبع الـ Bridge)
// ════════════════════════════════════════════════════════════════
//  يعتمد على BitaqtiBridge (bridge.js) — يجب تحميله أولاً.
//
//  الميزات:
//  • سجل النشاط الموحد (Activity Log) — يعرض أنشطة كل الصفحات
//  • إحصائيات سريعة محسّنة من البيانات المزامنة
//  • ربط بصفحة لوحة التحكم من البحث العالمي والإشعارات
//  • عرض الفجوات في الترقيم
//  • ربط الإحالة بالفواتير
//  • اقتراحات ذكية عند فتح نافذة التعديل
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  if(!document.getElementById('customersBody') && !document.getElementById('lockScreen')) return;
  if(!window.BitaqtiBridge) return;

  const $ = id => document.getElementById(id);

  // ════════════════════════════════════════════════════════════════
  //  1) سجل النشاط الموحد (Activity Log Panel)
  // ════════════════════════════════════════════════════════════════
  function injectActivityLogPanel(){
    if($('bridgeActivityPanel')) return;
    const dashboardTab = $('tab-dashboard');
    if(!dashboardTab) return;

    const panel = document.createElement('div');
    panel.id = 'bridgeActivityPanel';
    panel.className = 'panel';
    panel.style.cssText = 'margin-bottom:20px;';
    panel.innerHTML = `
      <div class="panel-header">
        <h2 style="display:flex;align-items:center;gap:6px;font-size:14px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;color:var(--red);"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
          سجل النشاط الموحد
          <button id="clearActivityBtn" style="margin-right:auto;padding:3px 8px;background:var(--red-tint);color:var(--red);border:1px solid var(--red);border-radius:4px;cursor:pointer;font-size:10px;font-weight:700;">مسح السجل</button>
        </h2>
        <div class="sub" style="font-size:11px;">آخر الأنشطة عبر كل الصفحات الإدارية</div>
      </div>
      <div class="panel-body" style="padding:12px;">
        <div id="bridgeActivityList" style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">
          <div style="text-align:center;color:var(--ink-faint);font-size:12px;padding:20px;">لا توجد أنشطة بعد</div>
        </div>
      </div>
    `;

    // ضعها في نهاية تبويب dashboard
    dashboardTab.appendChild(panel);

    const clearBtn = $('clearActivityBtn');
    if(clearBtn){
      clearBtn.addEventListener('click', () => {
        if(confirm('هل تريد مسح كل سجل النشاط؟')){
          BitaqtiBridge.clearActivityLog();
          renderActivityLog();
        }
      });
    }
  }

  function renderActivityLog(){
    const list = $('bridgeActivityList');
    if(!list) return;
    const log = BitaqtiBridge.getActivityLog(30);
    if(log.length === 0){
      list.innerHTML = '<div style="text-align:center;color:var(--ink-faint);font-size:12px;padding:20px;">لا توجد أنشطة بعد</div>';
      return;
    }
    const typeIcons = {
      'login': '🔐', 'logout': '🚪', 'add': '➕', 'update': '✏️', 'delete': '🗑️',
      'sync': '🔄', 'view': '👁️', 'invoice': '🧾', 'whatsapp': '💬',
      'referral': '🎁', 'payment': '💰', 'status': '📊', 'note': '📝',
    };
    const pageColors = {
      'dashboard': 'var(--red)',
      'invoices': 'var(--blue)',
      'settings': 'var(--gold)',
      'index': 'var(--ink-soft)',
    };
    list.innerHTML = log.map(entry => {
      const icon = typeIcons[entry.type] || '•';
      const pageColor = pageColors[entry.page] || 'var(--ink-faint)';
      const date = new Date(entry.time);
      const timeStr = date.toLocaleString('en-GB', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      return `
        <div style="display:flex;gap:8px;align-items:flex-start;padding:6px 8px;border-radius:6px;background:var(--paper);">
          <span style="font-size:14px;flex-shrink:0;">${icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:11.5px;font-weight:700;color:var(--ink);">${escapeHtmlSafe(entry.title)}</div>
            ${entry.details ? `<div style="font-size:10.5px;color:var(--ink-soft);margin-top:1px;">${escapeHtmlSafe(entry.details)}</div>` : ''}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;">
            <span style="font-size:9px;color:${pageColor};font-weight:700;background:var(--surface);padding:1px 5px;border-radius:4px;">${entry.page || ''}</span>
            <span style="font-size:9px;color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;" dir="ltr">${timeStr}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ════════════════════════════════════════════════════════════════
  //  2) اقتراحات ذكية عند فتح نافذة التعديل
  // ════════════════════════════════════════════════════════════════
  function injectSmartSuggestions(){
    const observer = new MutationObserver(() => {
      const modalBody = document.querySelector('.modal-body');
      if(!modalBody) return;
      if($('smartSuggestionsBar')) return;

      // اعرض اقتراحات فقط في نافذة الإضافة (not edit)
      const titleEl = document.querySelector('.modal h3');
      if(!titleEl || !titleEl.textContent.includes('إضافة')) return;

      const bar = document.createElement('div');
      bar.id = 'smartSuggestionsBar';
      bar.style.cssText = 'margin-bottom:10px;padding:8px 10px;background:linear-gradient(135deg,#DBEAFE,#EFF6FF);border-radius:8px;border:1px solid var(--blue);font-size:11px;color:var(--blue);';
      bar.innerHTML = `
        <div style="font-weight:700;margin-bottom:4px;display:flex;align-items:center;gap:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
          اقتراحات ذكية
        </div>
        <div id="smartSuggestionContent" style="font-size:10.5px;line-height:1.6;">
          جارٍ التحليل...
        </div>
      `;
      modalBody.insertBefore(bar, modalBody.firstChild);

      // حلل البيانات واعرض اقتراحات
      setTimeout(() => updateSmartSuggestions(), 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function updateSmartSuggestions(){
    const content = $('smartSuggestionContent');
    if(!content) return;
    const suggestions = [];

    // 1. اقتراح الرقم التالي
    if(typeof customers !== 'undefined' && customers.length > 0){
      const year = new Date().getFullYear();
      const max = customers
        .map(c => {
          const m = (c.order_code || '').match(new RegExp(`^BH-CV-${year}-(\\d+)$`));
          return m ? parseInt(m[1], 10) : 0;
        })
        .reduce((a, b) => Math.max(a, b), 0);
      suggestions.push(`📝 رقم الطلب التالي: <strong>BH-CV-${year}-${String(max+1).padStart(4,'0')}</strong>`);
    }

    // 2. عدد العملاء اليوم
    const today = new Date().toLocaleDateString('en-GB').split('/').join('/');
    if(typeof customers !== 'undefined'){
      const todayCount = customers.filter(c => c.order_date === today).length;
      if(todayCount > 0){
        suggestions.push(`📅 ${todayCount} عميل أُضيف اليوم`);
      }
    }

    // 3. متوسط السعر
    if(typeof customers !== 'undefined' && customers.length > 0){
      const avg = customers.reduce((s, c) => s + (Number(c.total_with_vat) || 0), 0) / customers.length;
      suggestions.push(`📊 متوسط الإنفاق: <strong>${avg.toFixed(3)} د.ب</strong>`);
    }

    // 4. أكثر باقة شعبية
    if(typeof customers !== 'undefined' && customers.length > 0){
      const pkgCount = {};
      customers.forEach(c => { pkgCount[c.package] = (pkgCount[c.package] || 0) + 1; });
      const top = Object.entries(pkgCount).sort((a,b) => b[1] - a[1])[0];
      if(top){
        suggestions.push(`⭐ الباقة الأكثر طلباً: <strong>${top[0]}</strong> (${top[1]} عميل)`);
      }
    }

    // 5. عملاء بدون كود إحالة
    if(typeof customers !== 'undefined'){
      const noRef = customers.filter(c => !c.referral_code).length;
      if(noRef > 0){
        suggestions.push(`🎁 ${noRef} عميل بدون كود إحالة — سيتم توليدها تلقائياً عند الحفظ`);
      }
    }

    if(suggestions.length === 0){
      content.innerHTML = 'لا توجد اقتراحات حالياً.';
    } else {
      content.innerHTML = suggestions.map(s => `<div style="margin-bottom:3px;">• ${s}</div>`).join('');
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  3) ربط سجل النشاط بالأحداث المهمة
  // ════════════════════════════════════════════════════════════════
  function hookActivityLogging(){
    // راقب الأنشطة المحلية في dashboard
    if(typeof window.logActivity === 'function'){
      const orig = window.logActivity;
      window.logActivity = function(type, title, details){
        // سجّل في السجل المحلي (الأصلي)
        orig.apply(this, arguments);
        // سجّل في السجل الموحد عبر الصفحات
        BitaqtiBridge.logActivity(type, title, details, 'dashboard');
      };
    }

    // رابط المزامنة
    if(typeof window.syncFromSheet === 'function'){
      const origSync = window.syncFromSheet;
      window.syncFromSheet = function(){
        const result = origSync.apply(this, arguments);
        if(result && typeof result.then === 'function'){
          result.then(r => {
            if(r && r.ok){
              BitaqtiBridge.logActivity('sync', 'مزامنة العملاء', `${r.data?.count || 0} عميل`, 'dashboard');
              // حدّث الإحصائيات السريعة
              setTimeout(updateSmartSuggestions, 200);
            }
          });
        }
        return result;
      };
    }

    // رابط الأزرار السريعة لتغيير الحالة
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.row-action');
      if(!btn) return;
      // لو الزر أخضر (تغيير الحالة السريع)
      if(btn.style.background && btn.style.background.includes('var(--green-tint)')){
        const phone = btn.closest('tr')?.querySelector('[data-phone]')?.dataset.phone;
        if(phone){
          setTimeout(() => {
            BitaqtiBridge.logActivity('status', 'تغيير حالة سريع', `الهاتف: ${phone}`, 'dashboard');
          }, 500);
        }
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  4) ربط بـ BitaqtiBridge
  // ════════════════════════════════════════════════════════════════
  function setupBridgeListeners(){
    BitaqtiBridge.on('activity:added', () => {
      renderActivityLog();
    });
    BitaqtiBridge.on('activity:cleared', () => {
      renderActivityLog();
    });
    BitaqtiBridge.on('customers:synced', (customers) => {
      // حدّث state العملاء المحلي لو النظام يستخدمه
      if(typeof window.customers !== 'undefined'){
        // لا نكتب فوق البيانات المحلية — فقط نحدّث الإحصائيات
      }
      setTimeout(updateSmartSuggestions, 200);
    });
  }

  function escapeHtmlSafe(s){
    if(typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ════════════════════════════════════════════════════════════════
  //  5) ربط الكل
  // ════════════════════════════════════════════════════════════════
  function init(){
    injectActivityLogPanel();
    injectSmartSuggestions();
    hookActivityLogging();
    setupBridgeListeners();
    // بعد تحميل الصفحة، اعرض السجل
    setTimeout(renderActivityLog, 1500);
    console.log('[dashboard-enhancements-v3] loaded');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
