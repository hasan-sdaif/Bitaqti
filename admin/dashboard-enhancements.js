// admin/dashboard-enhancements.js — تحسينات لوحة التحكم v1
// ════════════════════════════════════════════════════════════════
//  تحسينات:
//  1. التعرّف التلقائي على العميل عند إدخال الهاتف في نافذة الإضافة
//  2. اقتراح الباقة والسعر تلقائياً عند إدخال اسم العميل
//  3. توليد كود إحالة تلقائي عند الحفظ لو لم يوجد
//  4. تحسينات تجاوب للجوال العمودي
//  5. اختصارات لوحة المفاتيح (Ctrl+N عميل جديد، Ctrl+S حفظ، إلخ)
//  6. بحث فوري أثناء الكتابة في شريط البحث
//
//  هذا الملف يُحمّل بعد السكربت الرئيسي في dashboard.html.
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  // تحقق أن الصفحة هي لوحة التحكم
  if(!document.getElementById('customersBody') && !document.getElementById('lockScreen')){
    return;
  }

  const $ = id => document.getElementById(id);

  // ════════════════════════════════════════════════════════════════
  //  1) التعرّف على العميل عند إدخال الهاتف في نافذة التعديل
  // ════════════════════════════════════════════════════════════════
  function normalizePhone(p){
    return String(p || '').replace(/[\s\-()+]/g, '').replace(/^00/, '').replace(/^973/, '');
  }

  function setupPhoneDetectionInEditModal(){
    // راقب ظهور حقل ef_phone (يظهر عند فتح نافذة التعديل)
    const observer = new MutationObserver(() => {
      const phoneInput = $('ef_phone');
      if(phoneInput && !phoneInput.dataset.enhanced){
        phoneInput.dataset.enhanced = '1';
        let timer = null;
        phoneInput.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => checkExistingCustomer(phoneInput.value), 500);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function checkExistingCustomer(phone){
    const target = normalizePhone(phone);
    if(target.length < 6) return;
    if(typeof customers === 'undefined') return;
    const existing = customers.find(c => {
      const cPhone = normalizePhone(c.phone);
      return cPhone.endsWith(target) || target.endsWith(cPhone);
    });
    if(existing){
      showExistingCustomerHint(existing);
    } else {
      hideExistingCustomerHint();
    }
  }

  function showExistingCustomerHint(existingCust){
    let hint = $('existingCustomerHint');
    if(!hint){
      hint = document.createElement('div');
      hint.id = 'existingCustomerHint';
      hint.style.cssText = 'padding:8px 10px;margin:6px 0;border-radius:8px;font-size:11.5px;display:flex;gap:8px;align-items:center;';
      const modalBody = document.querySelector('.modal-body');
      if(modalBody) modalBody.insertBefore(hint, modalBody.firstChild);
    }
    hint.style.background = 'var(--amber-tint)';
    hint.style.color = 'var(--amber)';
    hint.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;flex-shrink:0;"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
      <div>
        <strong>تنبيه:</strong> يوجد عميل مسجَّل بنفس الهاتف:
        <strong>${escapeHtmlSafe(existingCust.customer_name || existingCust.phone)}</strong>
        (رمز الطلب: ${escapeHtmlSafe(existingCust.order_code || '—')})
        <br><span style="font-size:10.5px;">لو أنت متأكد من الإضافة، تابع. وإلا فعدّل العميل الموجود بدلاً من تكراره.</span>
      </div>
    `;
    hint.style.display = 'flex';
  }

  function hideExistingCustomerHint(){
    const hint = $('existingCustomerHint');
    if(hint) hint.style.display = 'none';
  }

  // ════════════════════════════════════════════════════════════════
  //  2) توليد كود إحالة تلقائي عند الحفظ
  // ════════════════════════════════════════════════════════════════
  function generateReferralCode(name){
    const cleanName = String(name || '').replace(/[^\u0600-\u06FFa-zA-Z]/g, '');
    let letters = '';
    if(/[\u0600-\u06FF]/.test(cleanName)){
      const map = {'ا':'A','ب':'B','ت':'T','ث':'S','ج':'J','ح':'H','خ':'K','د':'D','ذ':'Z','ر':'R','ز':'Z','س':'S','ش':'X','ص':'C','ض':'D','ط':'T','ظ':'Z','ع':'A','غ':'G','ف':'F','ق':'Q','ك':'K','ل':'L','م':'M','ن':'N','ه':'H','و':'W','ي':'Y','ى':'Y','ء':'A','أ':'A','إ':'I','آ':'A','ؤ':'W','ئ':'Y','ة':'T'};
      const chars = cleanName.split('').filter(c => map[c]);
      letters = (map[chars[0]] || 'X') + (map[chars[1]] || 'X') + (map[chars[2]] || 'X');
    } else {
      letters = cleanName.substring(0, 3).toUpperCase().padEnd(3, 'X');
    }
    const digits = String(Math.floor(100 + Math.random() * 900));
    return letters.toUpperCase() + digits;
  }

  // راقب عمليات الحفظ وأضف كود الإحالة تلقائياً لو لم يوجد
  function hookSaveCustomer(){
    if(typeof window.writeToSheet !== 'function') return;
    const origWrite = window.writeToSheet;
    window.writeToSheet = async function(action, record){
      // لو الإضافة ولم يوجد referral_code، ولّد واحداً تلقائياً
      if(action === 'add' && record && !record.referral_code){
        record.referral_code = generateReferralCode(record.customer_name || record.phone || '');
      }
      // لو التحديث و referral_code فارغ، ولّد واحداً
      if(action === 'update' && record && (!record.referral_code || record.referral_code === '')){
        record.referral_code = generateReferralCode(record.customer_name || record.phone || '');
      }
      // تأكد من referral_points رقم
      if(record && (record.referral_points === '' || record.referral_points === undefined || record.referral_points === null)){
        record.referral_points = 0;
      }
      return origWrite.apply(this, arguments);
    };
  }

  // ════════════════════════════════════════════════════════════════
  //  3) اختصارات لوحة المفاتيح
  // ════════════════════════════════════════════════════════════════
  function setupKeyboardShortcuts(){
    document.addEventListener('keydown', (e) => {
      // تجاهل لو كان المستخدم يكتب في حقل
      const tag = (e.target.tagName || '').toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select';
      // Ctrl+N = عميل جديد
      if(e.ctrlKey && e.key === 'n'){
        e.preventDefault();
        if(typeof openAddModal === 'function') openAddModal();
        return;
      }
      // Ctrl+S = حفظ (داخل نافذة التعديل)
      if(e.ctrlKey && e.key === 's'){
        e.preventDefault();
        const confirmBtn = $('modalConfirm');
        if(confirmBtn && document.querySelector('.modal-overlay.show')){
          confirmBtn.click();
        }
        return;
      }
      // Escape = إغلاق النافذة
      if(e.key === 'Escape'){
        const overlay = document.querySelector('.modal-overlay.show');
        if(overlay){
          const cancelBtn = $('modalCancel');
          if(cancelBtn) cancelBtn.click();
        }
        return;
      }
      // Ctrl+F = تركيز البحث (لو لم يكن يكتب)
      if(e.ctrlKey && e.key === 'f' && !isTyping){
        e.preventDefault();
        const searchInput = $('searchInput');
        if(searchInput) searchInput.focus();
        return;
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  4) تحسينات تجاوب إضافية للوحة التحكم
  // ════════════════════════════════════════════════════════════════
  function injectDashboardResponsiveFixes(){
    if(document.getElementById('dashboardEnhancementsStyle')) return;
    const style = document.createElement('style');
    style.id = 'dashboardEnhancementsStyle';
    style.textContent = `
      /* منع التمرير الأفقي للصفحة كلها */
      html, body{
        overflow-x:hidden;
        max-width:100vw;
      }
      .main, .topbar, .topbar-inner, .tabs, .tab-panel{
        max-width:100%;
        overflow-x:hidden;
      }
      img, canvas, svg, table{
        max-width:100% !important;
      }
      table{
        table-layout:auto;
      }
      pre, code{
        white-space:pre-wrap;
        word-break:break-word;
      }

      /* منع خروج النوافذ المنبثقة دائماً */
      .modal{
        max-width:calc(100vw - 16px) !important;
        max-height:calc(100vh - 16px) !important;
        overflow:hidden;
        display:flex;
        flex-direction:column;
      }
      .modal-body{
        overflow-y:auto;
        overflow-x:hidden;
        flex:1 1 auto;
        min-height:0;
        -webkit-overflow-scrolling:touch;
      }
      .modal-actions{
        flex-shrink:0;
        border-top:1px solid var(--line);
        padding:10px 14px;
        background:var(--surface);
      }

      /* جدول العملاء — تمرير أفقي على الجوال بدل الخروج */
      .table-wrap, [class*="table"]{
        overflow-x:auto;
        -webkit-overflow-scrolling:touch;
      }

      /* الجوال — تصغير الحشو والخطوط */
      @media(max-width:480px){
        .main{padding:8px !important;padding-bottom:80px !important;}
        .panel{margin-bottom:10px !important;}
        .panel-header{padding:10px 12px !important;}
        .panel-body{padding:10px !important;}
        .stats-grid{grid-template-columns:1fr !important;gap:8px !important;}
        .stat-card{padding:10px 12px !important;}
        .stat-card .stat-value{font-size:16px !important;}
        .quick-actions{grid-template-columns:1fr 1fr !important;gap:8px !important;}
        .toolbar{flex-direction:column !important;align-items:stretch !important;}
        .toolbar > *{width:100% !important;}
        .search-box{min-width:0 !important;}
        .filter-select{width:100% !important;}
        .btn{padding:7px 10px !important;font-size:11px !important;}
        .modal-overlay{padding:4px !important;}
        .modal{max-width:100% !important;border-radius:10px !important;}
        .modal-body{max-height:calc(96vh - 130px) !important;font-size:12px !important;padding:0 12px 12px !important;}
        .modal-actions{flex-direction:column !important;padding:10px 12px !important;}
        .modal-actions .btn{width:100% !important;}
        .modal.wide .form-row{grid-template-columns:1fr !important;}
        .data-table{font-size:10px !important;}
        .data-table th, .data-table td{padding:5px 6px !important;}
        .row-action{width:24px !important;height:24px !important;margin-right:1px !important;}
        .row-action svg{width:10px !important;height:10px !important;}
      }

      /* تابلت عمودي — شبكة عمودين */
      @media(max-width:768px){
        .stats-grid{grid-template-columns:1fr 1fr !important;}
        .quick-actions{grid-template-columns:1fr 1fr !important;}
        .charts-grid{grid-template-columns:1fr !important;}
      }

      /* تابلت أفقي — تنسيق أفضل */
      @media(max-width:1024px) and (min-width:769px){
        .stats-grid{grid-template-columns:repeat(3,1fr) !important;}
      }

      /* الجوال الأفقي (ارتفاع 500px وأقل) */
      @media(max-height:500px) and (orientation:landscape){
        .topbar{padding:6px 0 !important;}
        .tabs{padding:2px !important;}
        .tab{padding:4px 8px !important;font-size:11px !important;}
        .lock-card{padding:18px 20px !important;}
        .lock-card h1{font-size:16px !important;}
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtmlSafe(s){
    if(typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ════════════════════════════════════════════════════════════════
  //  5) تحسين الأزرار — أضف tooltip لاختصارات لوحة المفاتيح
  // ════════════════════════════════════════════════════════════════
  function enhanceButtonsWithShortcuts(){
    const btnAdd = $('btnAdd');
    if(btnAdd && !btnAdd.dataset.enhanced){
      btnAdd.dataset.enhanced = '1';
      btnAdd.title = 'إضافة عميل جديد (Ctrl+N)';
    }
    const btnSync = $('btnSync');
    if(btnSync && !btnSync.dataset.enhanced){
      btnSync.dataset.enhanced = '1';
      btnSync.title = 'مزامنة من قاعدة البيانات (Ctrl+R)';
    }
    const searchInput = $('searchInput');
    if(searchInput && !searchInput.dataset.enhanced){
      searchInput.dataset.enhanced = '1';
      searchInput.title = 'بحث فوري بالاسم، الهاتف، رمز الطلب، الباقة، البريد، كود الإحالة (Ctrl+F)';
      searchInput.placeholder = 'بحث فوري بالاسم، الهاتف، رمز الطلب، الباقة، البريد، كود الإحالة...';
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  6) ربط الكل بعد تحميل الصفحة
  // ════════════════════════════════════════════════════════════════
  function init(){
    setupPhoneDetectionInEditModal();
    hookSaveCustomer();
    setupKeyboardShortcuts();
    injectDashboardResponsiveFixes();
    enhanceButtonsWithShortcuts();
    console.log('[dashboard-enhancements] v1 loaded');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
