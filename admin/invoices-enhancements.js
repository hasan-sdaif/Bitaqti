// admin/invoices-enhancements.js — تحسينات صفحة الفواتير v2
// ════════════════════════════════════════════════════════════════
//  تحسينات:
//  1. التعرّف التلقائي على العميل عند إدخال الهاتف (من السجل المحلي + Supabase)
//  2. قائمة منسدلة لنوع الطلب (جديد / تجديد / إضافة خدمة)
//  3. تعبئة تلقائية لبنود الفاتورة عند التجديد
//  4. توليد ذكي لأرقام الفواتير مع كشف التسلسل
//  5. كود الإحالة في الفاتورة المطبوعة
//  6. تحسينات التجاوب للجوال العمودي
//
//  هذا الملف يُحمّل بعد السكربت الرئيسي في invoices.html.
//  كل الدوال defensive: لو فشل تحميل الملف، الصفحة تعمل بدونها.
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  // تحقق أن الصفحة هي صفحة الفواتير
  if(!document.getElementById('fPhone') || !document.getElementById('fName')){
    return;
  }

  const $ = id => document.getElementById(id);
  const TRACK_ENDPOINT = '/.netlify/functions/track-order';

  // ════════════════════════════════════════════════════════════════
  //  1) ذاكرة مؤقتة للعملاء المتزامنين من Supabase
  // ════════════════════════════════════════════════════════════════
  let supabaseCustomersCache = [];
  let lastSyncTime = 0;
  const SYNC_CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

  async function syncCustomersFromSupabase(){
    const pwd = (window.BitaqtiAuth && BitaqtiAuth.getSavedPassword()) || '';
    if(!pwd) return [];
    // تجنّب المزامنة المتكررة خلال 5 دقائق
    if(Date.now() - lastSyncTime < SYNC_CACHE_TTL) return supabaseCustomersCache;
    try {
      const res = await fetch(TRACK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ admin_password: pwd, mode: 'sync' }),
      });
      if(res.status === 200){
        const data = await res.json();
        supabaseCustomersCache = data.customers || [];
        lastSyncTime = Date.now();
        return supabaseCustomersCache;
      }
    } catch(e) { /* silent */ }
    return [];
  }

  // ════════════════════════════════════════════════════════════════
  //  2) التعرّف على العميل عند إدخال الهاتف
  // ════════════════════════════════════════════════════════════════
  function normalizePhone(p){
    return String(p || '').replace(/[\s\-()+]/g, '').replace(/^00/, '').replace(/^973/, '');
  }

  function findCustomerByPhone(phone){
    const target = normalizePhone(phone);
    if(!target || target.length < 6) return null;
    // ابحث في Supabase أولاً
    const supaMatch = supabaseCustomersCache.find(c => {
      return normalizePhone(c.phone).endsWith(target) || target.endsWith(normalizePhone(c.phone));
    });
    if(supaMatch) return { source: 'supabase', customer: supaMatch };
    // ثم في الفواتير المحلية
    if(typeof invoices !== 'undefined'){
      const seen = new Set();
      for(const inv of invoices){
        if(inv.customer && inv.customer.phone){
          const invPhone = normalizePhone(inv.customer.phone);
          if(invPhone.endsWith(target) || target.endsWith(invPhone)){
            const key = inv.customer.phone || inv.customer.name;
            if(!seen.has(key)){
              seen.add(key);
              return { source: 'local', customer: inv.customer, lastInvoice: inv };
            }
          }
        }
      }
    }
    return null;
  }

  function findCustomerByName(name){
    const target = String(name || '').toLowerCase().trim();
    if(!target || target.length < 2) return null;
    const supaMatch = supabaseCustomersCache.find(c =>
      String(c.customer_name || '').toLowerCase().includes(target)
    );
    if(supaMatch) return { source: 'supabase', customer: supaMatch };
    if(typeof invoices !== 'undefined'){
      const seen = new Set();
      for(const inv of invoices){
        if(inv.customer && inv.customer.name &&
           inv.customer.name.toLowerCase().includes(target)){
          const key = inv.customer.phone || inv.customer.name;
          if(!seen.has(key)){
            seen.add(key);
            return { source: 'local', customer: inv.customer, lastInvoice: inv };
          }
        }
      }
    }
    return null;
  }

  // عرض مؤشر "عميل معروف" بجانب حقل الهاتف
  function showKnownCustomerBadge(match){
    let badge = $('knownCustomerBadge');
    if(!badge){
      badge = document.createElement('div');
      badge.id = 'knownCustomerBadge';
      badge.style.cssText = 'font-size:11px;padding:4px 8px;border-radius:6px;margin-top:4px;display:none;';
      const phoneInput = $('fPhone');
      if(phoneInput && phoneInput.parentElement){
        phoneInput.parentElement.appendChild(badge);
      }
    }
    if(match){
      const c = match.customer;
      const orderCount = supabaseCustomersCache.filter(x => normalizePhone(x.phone) === normalizePhone(c.phone)).length;
      const labelText = match.source === 'supabase'
        ? `✓ عميل معروف من قاعدة البيانات${orderCount > 0 ? ' (' + orderCount + ' طلب سابق)' : ''}`
        : `✓ عميل معروف من الفواتير السابقة`;
      badge.textContent = labelText;
      badge.style.background = 'var(--green-tint)';
      badge.style.color = 'var(--green)';
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  }

  // تعبئة الحقول تلقائياً من بيانات العميل المعروف
  function fillCustomerFields(match, opts = {}){
    if(!match) return false;
    const c = match.customer;
    // املأ فقط الحقول الفارغة (لا تكتب فوق بيانات موجودة) ما لم يُطلب صراحة
    const force = opts.force || false;
    if(force || !$('fName').value.trim()) $('fName').value = c.customer_name || c.name || '';
    if(force || !$('fCvLink').value.trim()){
      const cvLink = c.cv_link || c.cvLink || '';
      // استخرج اسم المستخدم من الرابط إن كان كاملًا
      const cleanLink = cvLink.replace(/^https?:\/\//, '').replace(/^bitaqti\.com\//, '').replace(/\/+$/, '');
      $('fCvLink').value = cleanLink;
    }
    if($('fCustEmail') && (force || !$('fCustEmail').value.trim())){
      $('fCustEmail').value = c.customer_email || c.email || '';
    }
    if($('fCustCountry') && (force || !$('fCustCountry').value.trim())){
      $('fCustCountry').value = c.customer_country || c.country || 'مملكة البحرين';
    }
    // حفظ كود الإحالة لاستخدامه في المعاينة/الطباعة
    if(c.referral_code){
      window._invoiceCustomerReferralCode = c.referral_code;
    }
    showKnownCustomerBadge(match);
    return true;
  }

  // ════════════════════════════════════════════════════════════════
  //  3) قائمة نوع الطلب (جديد / تجديد / إضافة خدمة)
  // ════════════════════════════════════════════════════════════════
  function addOrderTypeSelector(){
    // تحقق أنها لم تُضَف من قبل
    if($('orderTypeSelector')) return;
    const formSection = $('fName')?.closest('.form-section-title')?.parentElement;
    if(!formSection) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'orderTypeSelector';
    wrapper.style.cssText = 'margin-bottom:14px;padding:10px;background:linear-gradient(135deg,#F4F3EF,#FFFFFF);border-radius:10px;border:1px solid var(--line);';
    wrapper.innerHTML = `
      <label style="font-size:11.5px;font-weight:700;color:var(--ink-soft);display:block;margin-bottom:6px;">
        نوع الطلب (يحديد البنود الافتراضية)
      </label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button type="button" class="ord-type-btn active" data-ordtype="new" style="flex:1;min-width:90px;padding:8px 10px;border:1.5px solid var(--red);background:var(--red-tint);color:var(--red);border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;">
          ✨ طلب جديد
        </button>
        <button type="button" class="ord-type-btn" data-ordtype="renew" style="flex:1;min-width:90px;padding:8px 10px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink-soft);border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;">
          🔄 تجديد / إصدار جديد
        </button>
        <button type="button" class="ord-type-btn" data-ordtype="addon" style="flex:1;min-width:90px;padding:8px 10px;border:1.5px solid var(--line);background:var(--surface);color:var(--ink-soft);border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;">
          ➕ إضافة خدمة
        </button>
      </div>
      <div id="ordTypeHint" style="font-size:10.5px;color:var(--ink-faint);margin-top:6px;line-height:1.5;">
        ابدأ بكتابة الهاتف — لو كان العميل معروفاً، سيُقترح التجديد تلقائياً مع تعبئة آخر بنود.
      </div>
    `;
    formSection.insertBefore(wrapper, formSection.firstChild);

    // ربط الأزرار
    wrapper.querySelectorAll('.ord-type-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        wrapper.querySelectorAll('.ord-type-btn').forEach(b => {
          b.classList.remove('active');
          b.style.background = 'var(--surface)';
          b.style.color = 'var(--ink-soft)';
          b.style.borderColor = 'var(--line)';
        });
        btn.classList.add('active');
        btn.style.background = 'var(--red-tint)';
        btn.style.color = 'var(--red)';
        btn.style.borderColor = 'var(--red)';
        window._currentOrderType = btn.dataset.ordtype;
        const hint = $('ordTypeHint');
        if(hint){
          if(btn.dataset.ordtype === 'new'){
            hint.textContent = '✨ طلب جديد: اكتب بيانات العميل وستُضاف البنود الافتراضية حسب الباقة.';
          } else if(btn.dataset.ordtype === 'renew'){
            hint.textContent = '🔄 تجديد: اكتب هاتف العميل — سيُعبأ آخر طلب له تلقائياً لتجديده.';
            triggerCustomerLookup('renew');
          } else if(btn.dataset.ordtype === 'addon'){
            hint.textContent = '➕ إضافة خدمة: اكتب هاتف العميل — ستُضاف بنود فارغة لإضافة خدمة جديدة.';
            triggerCustomerLookup('addon');
          }
        }
      });
    });
    window._currentOrderType = 'new';
  }

  // ════════════════════════════════════════════════════════════════
  //  4) البحث التلقائي عن العميل عند إدخال الهاتف
  // ════════════════════════════════════════════════════════════════
  let phoneLookupTimer = null;
  function setupPhoneAutoLookup(){
    const phoneInput = $('fPhone');
    if(!phoneInput) return;
    phoneInput.addEventListener('input', () => {
      clearTimeout(phoneLookupTimer);
      phoneLookupTimer = setTimeout(() => triggerCustomerLookup(), 600);
    });
    phoneInput.addEventListener('blur', () => {
      // تأخير قصير للسماح بالنقر على قائمة الإكمال
      setTimeout(() => triggerCustomerLookup(), 200);
    });
  }

  function triggerCustomerLookup(mode){
    const phone = $('fPhone').value.trim();
    const name = $('fName').value.trim();
    if(phone.length < 6 && name.length < 2){
      showKnownCustomerBadge(null);
      return;
    }
    const match = phone.length >= 6 ? findCustomerByPhone(phone) : findCustomerByName(name);
    if(match){
      fillCustomerFields(match);
      // لو طلب التجديد وآخر فاتورة موجودة، املأ البنود
      if(mode === 'renew' && match.lastInvoice){
        renewFromInvoice(match.lastInvoice);
      } else if(window._currentOrderType === 'renew' && match.lastInvoice){
        renewFromInvoice(match.lastInvoice);
      }
    } else {
      showKnownCustomerBadge(null);
      window._invoiceCustomerReferralCode = null;
    }
  }

  function renewFromInvoice(inv){
    if(!inv || typeof items === 'undefined' || typeof renderItemsTable === 'undefined') return;
    // اسأل المستخدم قبل التعبئة (تجنّب فقدان البيانات الحالية)
    if(items.some(i => i.description) && !confirm('هل تريد استبدال البنود الحالية ببنود آخر فاتورة لهذا العميل؟')){
      return;
    }
    items.length = 0;
    if(inv.items && inv.items.length){
      inv.items.forEach(it => {
        items.push({
          description: it.description || '',
          qty: it.qty || 1,
          unitPrice: it.unitPrice || 0,
          itemType: it.itemType || 'regular',
          discount: it.discount || {type:'none', value:0},
          sku: it.sku || '',
          category: it.category || '',
          unit: it.unit || 'piece',
          internalNotes: it.internalNotes || '',
          cost: it.cost || 0,
          originalPrice: it.originalPrice || 0
        });
      });
    }
    // املأ الحقول الأخرى من الفاتورة السابقة
    if(inv.discount){
      $('fDiscountType').value = inv.discount.type || 'none';
      $('fDiscountValue').value = inv.discount.value || '';
      if(typeof updateDiscountFieldState === 'function') updateDiscountFieldState();
    }
    if(inv.vatRate !== undefined) $('fVatRate').value = inv.vatRate;
    if(inv.notes) $('fNotes').value = inv.notes;
    if(typeof renderItemsTable === 'function') renderItemsTable();
    if(typeof updatePreview === 'function') updatePreview();
    if(typeof toast === 'function'){
      toast(`تمت تعبئة الفاتورة ببيانات آخر طلب للعميل (${inv.code || ''})`, 'success');
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  5) كود الإحالة في الفاتورة المطبوعة
  // ════════════════════════════════════════════════════════════════
  function injectReferralIntoPreview(){
    // ابحث عن كود الإحالة من العميل الحالي
    const phone = $('fPhone')?.value.trim() || '';
    const match = phone ? findCustomerByPhone(phone) : null;
    let referralCode = '';
    if(match && match.customer && match.customer.referral_code){
      referralCode = match.customer.referral_code;
    }
    // ابحث عن #pReferralWrap أو أنشئه
    let wrap = $('pReferralWrap');
    if(!referralCode){
      if(wrap) wrap.style.display = 'none';
      return;
    }
    if(!wrap){
      // أضف صندوق كود الإحالة بين الملاحظات ومعلومات الدفع (يظهر في الطباعة أيضاً)
      const notesWrap = $('pNotesWrap');
      wrap = document.createElement('div');
      wrap.id = 'pReferralWrap';
      wrap.style.cssText = 'background:linear-gradient(135deg,#F3ECDD,#FBF8F0);border:1.5px dashed var(--gold);border-radius:10px;padding:12px 14px;margin:12px 0;text-align:center;';
      // ضعه بعد pNotesWrap وقبل pPaymentWrap
      if(notesWrap && notesWrap.nextSibling){
        notesWrap.parentNode.insertBefore(wrap, notesWrap.nextSibling);
      } else {
        const totals = $('pTotals');
        if(totals && totals.nextSibling){
          totals.parentNode.insertBefore(wrap, totals.nextSibling);
        }
      }
    }
    wrap.innerHTML = `
      <div style="font-size:11px;color:var(--gold);font-weight:700;margin-bottom:4px;">🎁 كود الإحالة الخاص بك</div>
      <div style="font-size:18px;font-weight:700;color:var(--ink);font-family:'IBM Plex Mono',monospace;direction:ltr;letter-spacing:1px;">${referralCode}</div>
      <div style="font-size:10.5px;color:var(--ink-soft);margin-top:4px;line-height:1.5;">
        شاركه مع أصدقائك — يحصلون على خصم 20% وأنت تحصل على 100 نقطة لكل إحالة ناجحة!
      </div>
    `;
    wrap.style.display = 'block';
  }

  // ════════════════════════════════════════════════════════════════
  //  6) تحسينات التجاوب للجوال العمودي
  // ════════════════════════════════════════════════════════════════
  function injectResponsiveFixes(){
    let style = document.getElementById('enhancementsResponsiveStyle');
    if(style) return;
    style = document.createElement('style');
    style.id = 'enhancementsResponsiveStyle';
    style.textContent = `
      /* ═══ تحسينات تجاوب إضافية للجوال العمودي ═══ */

      /* الجوال (480px وأقل) — اضمان عدم خروج أي عنصر */
      @media(max-width:480px){
        /* القسم العلوي — تصغير الحشو */
        .inv-layout{padding:0 !important;}
        .inv-form-col, .inv-preview-col{padding:0 !important;}

        /* النموذج — حقول أصغر وعمود واحد */
        .form-row.cols-2, .form-row.cols-3{grid-template-columns:1fr !important;}
        .form-group{margin-bottom:8px !important;}
        .form-control{font-size:14px;padding:8px 10px !important;}

        /* أزرار البنود — تصغير وعمود واحد */
        .items-table th, .items-table td{padding:5px 4px !important;font-size:11px !important;}
        .items-table .col-actions{width:auto !important;}

        /* المعاينة — تصغير الخطوط */
        #sheet{padding:14px !important;font-size:11px !important;}
        #sheet .inv-meta h1{font-size:18px !important;}
        #sheet .inv-brand-text h2{font-size:14px !important;}
        #sheet .inv-brand-text p{font-size:10px !important;}
        #sheet .inv-customer{flex-direction:column !important;gap:8px !important;}
        #sheet .inv-customer .cust-name{font-size:14px !important;}
        #sheet .inv-qr{align-self:flex-start !important;}
        #sheet .inv-qr canvas{width:80px !important;height:80px !important;}
        #sheet .inv-items-table{font-size:10px !important;}
        #sheet .inv-items-table th, #sheet .inv-items-table td{padding:4px 3px !important;}
        #sheet .col-num{width:20px !important;}
        #sheet .col-qty{width:35px !important;}
        #sheet .col-price, #sheet .col-total{width:60px !important;}
        #sheet .inv-totals{font-size:11px !important;}
        #sheet .total-row{padding:3px 0 !important;}
        #sheet .total-row .lbl{font-size:11px !important;}
        #sheet .total-row .val{font-size:11px !important;}
        #sheet .inv-footer{font-size:10px !important;padding-top:8px !important;}
        #sheet .inv-footer .contact-info{flex-direction:column !important;gap:3px !important;font-size:9.5px !important;}

        /* التبويبات — تصغير الحشو */
        .tabs{padding:2px !important;gap:1px !important;}
        .tab{padding:6px 8px !important;font-size:11px !important;}
        .tab svg{width:13px !important;height:13px !important;}

        /* الإحصائيات — عمود واحد */
        .stats-grid{grid-template-columns:1fr !important;gap:8px !important;}
        .stat-card{padding:10px 12px !important;}
        .stat-card .stat-value{font-size:18px !important;}

        /* الإعدادات — عمود واحد */
        .setting-row{grid-template-columns:1fr !important;}
        .setting-actions{flex-direction:column !important;}
        .setting-actions .btn{width:100% !important;}

        /* النوافذ المنبثقة */
        .modal-overlay{padding:4px !important;}
        .modal{max-width:100% !important;max-height:96vh !important;border-radius:10px !important;}
        .modal-body{max-height:calc(96vh - 130px) !important;overflow-y:auto !important;}

        /* أزرار شريط الأدوات */
        .toolbar{flex-direction:column !important;align-items:stretch !important;}
        .toolbar .btn{width:100% !important;justify-content:center !important;}

        /* قائمة الإكمال التلقائي */
        .autocomplete-list{max-height:200px !important;overflow-y:auto !important;font-size:12px !important;}

        /* قائمة نوع الطلب */
        #orderTypeSelector .ord-type-btn{font-size:11px !important;padding:6px 8px !important;min-width:0 !important;}

        /* شبكة تفاصيل البنود */
        .item-details-grid{grid-template-columns:1fr !important;}

        /* المدفوعات والحقول المخصصة */
        .payment-row, .custom-field-row{grid-template-columns:1fr !important;}
      }

      /* تابلت عمودي (768px وأقل) — اضمان عدم خروج العناصر الأفقية */
      @media(max-width:768px){
        .inv-layout{grid-template-columns:1fr !important;}
        .inv-preview-col{position:static !important;max-height:none !important;}
        .form-row.cols-2{grid-template-columns:1fr 1fr;}
        .item-details-grid{grid-template-columns:1fr 1fr;}
      }

      /* الجوال الأفقي (ارتفاع 500px وأقل) */
      @media(max-height:500px) and (orientation:landscape){
        .lock-card{padding:18px 20px !important;}
        .lock-card h1{font-size:16px !important;}
        .lock-card p{font-size:11px !important;margin-bottom:12px !important;}
        .lock-input{padding:10px 12px !important;font-size:13px !important;}
        .lock-btn{padding:10px !important;font-size:12px !important;}
        .topbar{padding:6px 0 !important;}
        .tabs{padding:2px !important;}
        .tab{padding:4px 8px !important;font-size:11px !important;}
      }

      /* منع التمرير الأفقي للصفحة كلها */
      html, body{
        overflow-x:hidden;
        max-width:100vw;
      }
      .main{
        max-width:100%;
        overflow-x:hidden;
      }
      *{
        max-width:100%;
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
    `;
    document.head.appendChild(style);
  }

  // ════════════════════════════════════════════════════════════════
  //  7) تحديث القائمة المنسدلة للإكمال (تشمل عملاء Supabase)
  // ════════════════════════════════════════════════════════════════
  const originalShowAutocomplete = (typeof window.showAutocomplete === 'function') ? window.showAutocomplete : null;
  function enhancedShowAutocomplete(){
    const val = $('fName').value.trim().toLowerCase();
    const list = $('nameAutocomplete');
    if(!val){ list.classList.remove('show'); return; }
    // ادمج عملاء Supabase مع الفواتير المحلية
    const seen = new Set();
    const matches = [];

    // ابدأ بعملاء Supabase (الأحدث)
    supabaseCustomersCache.forEach(c => {
      const name = String(c.customer_name || '').toLowerCase();
      const phone = String(c.phone || '');
      if(name.includes(val) || phone.includes(val)){
        const key = phone || name;
        if(!seen.has(key)){
          seen.add(key);
          matches.push({
            name: c.customer_name || '',
            phone: c.phone || '',
            cvLink: c.cv_link || '',
            email: c.customer_email || '',
            country: c.customer_country || '',
            referral_code: c.referral_code || '',
            _source: 'supabase'
          });
        }
      }
    });

    // ثم الفواتير المحلية
    if(typeof invoices !== 'undefined'){
      for(const inv of invoices){
        if(inv.customer && inv.customer.name){
          const name = inv.customer.name.toLowerCase();
          const phone = inv.customer.phone || '';
          if(name.includes(val) || phone.includes(val)){
            const key = phone || inv.customer.name;
            if(!seen.has(key)){
              seen.add(key);
              matches.push({
                name: inv.customer.name,
                phone: inv.customer.phone || '',
                cvLink: inv.customer.cvLink || '',
                email: inv.customer.email || '',
                country: inv.customer.country || '',
                referral_code: '',
                _source: 'local',
                lastInvoice: inv
              });
            }
          }
        }
      }
    }

    if(matches.length === 0){ list.classList.remove('show'); return; }
    list.innerHTML = matches.slice(0, 8).map((c, i) => `
      <div class="autocomplete-item" data-idx="${i}">
        <span class="ai-name">${escapeHtmlSafe(c.name)}</span>
        <span class="ai-phone">${escapeHtmlSafe(c.phone)}</span>
        ${c._source === 'supabase' ? '<span style="font-size:9px;color:var(--green);font-weight:700;">●</span>' : ''}
      </div>
    `).join('');
    list.classList.add('show');
    if(typeof acSelected !== 'undefined') acSelected = -1;
    list.querySelectorAll('.autocomplete-item').forEach((el, i) => {
      el.addEventListener('click', () => {
        const m = matches[i];
        $('fName').value = m.name;
        $('fPhone').value = m.phone;
        if(m.cvLink){
          $('fCvLink').value = m.cvLink.replace(/^https?:\/\//, '').replace(/^bitaqti\.com\//, '').replace(/\/+$/, '');
        }
        if($('fCustEmail') && m.email) $('fCustEmail').value = m.email;
        if($('fCustCountry') && m.country) $('fCustCountry').value = m.country;
        if(m.referral_code) window._invoiceCustomerReferralCode = m.referral_code;
        list.classList.remove('show');
        // أظهر شارة "عميل معروف"
        showKnownCustomerBadge({ source: m._source, customer: m });
        if(typeof updatePreview === 'function') updatePreview();
        // لو طلب التجديد وفاتورة سابقة موجودة
        if(window._currentOrderType === 'renew' && m.lastInvoice){
          renewFromInvoice(m.lastInvoice);
        }
      });
    });
  }

  function escapeHtmlSafe(s){
    if(typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ════════════════════════════════════════════════════════════════
  //  8) توليد ذكي لأرقام الفواتير (كشف التسلسل الصحيح)
  // ════════════════════════════════════════════════════════════════
  function smartGenerateInvoiceCode(){
    if(typeof settings === 'undefined' || !settings.prefix) return '';
    const year = settings.year || String(new Date().getFullYear());
    const prefix = settings.prefix || 'BH-CV';

    // ابحث عن أعلى رقم تسلسلي مستخدم في هذا العام (محلياً)
    let maxSeq = settings.nextSeq || 1;
    if(typeof invoices !== 'undefined'){
      invoices.forEach(inv => {
        if(inv.code){
          const m = inv.code.match(new RegExp(`^${prefix}-${year}-(\\d+)$`));
          if(m){
            const seq = parseInt(m[1], 10);
            if(seq >= maxSeq) maxSeq = seq + 1;
          }
        }
      });
    }
    return `${prefix}-${year}-${String(maxSeq).padStart(3, '0')}`;
  }

  // ════════════════════════════════════════════════════════════════
  //  9) قراءة بيانات العميل من URL (لو قادم من dashboard.html)
  // ════════════════════════════════════════════════════════════════
  function loadCustomerFromDashboard(){
    // تحقق من URL ?from=customer
    const params = new URLSearchParams(window.location.search);
    if(params.get('from') !== 'customer') return;
    // اقرأ من localStorage
    let c = null;
    try {
      const raw = localStorage.getItem('bitaqti_invoice_customer');
      if(raw) c = JSON.parse(raw);
    } catch(e) {}
    if(!c) return;
    // املأ الحقول
    if($('fName') && c.customer_name) $('fName').value = c.customer_name;
    if($('fPhone') && c.phone) $('fPhone').value = c.phone;
    if($('fCvLink') && c.cv_link){
      $('fCvLink').value = String(c.cv_link).replace(/^https?:\/\//, '').replace(/^bitaqti\.com\//, '').replace(/\/+$/, '');
    }
    if($('fCustEmail') && c.customer_email) $('fCustEmail').value = c.customer_email;
    if($('fCustCountry') && c.customer_country) $('fCustCountry').value = c.customer_country || 'مملكة البحرين';
    if(c.referral_code) window._invoiceCustomerReferralCode = c.referral_code;
    // أظهر شارة "عميل معروف"
    showKnownCustomerBadge({ source: 'dashboard', customer: c });
    // امسح localStorage حتى لا يُعاد التعبئة عند التحديث
    try { localStorage.removeItem('bitaqti_invoice_customer'); } catch(e) {}
    // أضف بنداً افتراضياً بناءً على الباقة
    if(typeof items !== 'undefined' && typeof addItem === 'function' && typeof renderItemsTable === 'function'){
      const packageMap = {
        'الأساسية': { desc: 'بطاقة رقمية أساسية (رابط + QR + 4 أقسام)', price: 5.000 },
        'القياسية': { desc: 'بطاقة رقمية قياسية (رابط + QR + 6 أقسام + معرض صور)', price: 16.500 },
        'المميزة':  { desc: 'بطاقة رقمية مميزة (تصميم مخصص + معرض صور + سيرة ورقية)', price: 15.000 },
      };
      const pkg = packageMap[c.package] || packageMap['الأساسية'];
      items.length = 0;
      addItem(pkg.desc, 1, pkg.price);
      if(c.discount_amount && Number(c.discount_amount) > 0){
        if(typeof $('fDiscountType') !== 'undefined' && $('fDiscountType')){
          $('fDiscountType').value = 'fixed';
          $('fDiscountValue').value = c.discount_amount;
        }
      }
      if(c.vat_amount && Number(c.vat_amount) > 0 && $('fVatRate')){
        $('fVatRate').value = '10'; // VAT rate (10%)
      }
    }
    if(typeof updatePreview === 'function') updatePreview();
    if(typeof toast === 'function'){
      toast(`تمت تعبئة بيانات العميل: ${c.customer_name || c.phone}`, 'success');
    }
    // نظّف URL من المعامل
    try {
      window.history.replaceState({}, document.title, window.location.pathname);
    } catch(e) {}
  }

  // ════════════════════════════════════════════════════════════════
  //  10) ربط الكل بعد تحميل الصفحة
  // ════════════════════════════════════════════════════════════════
  function init(){
    // استبدل showAutocomplete بنسختنا المحسّنة
    window.showAutocomplete = enhancedShowAutocomplete;
    // أضف قائمة نوع الطلب
    addOrderTypeSelector();
    // اربط البحث التلقائي بحقل الهاتف
    setupPhoneAutoLookup();
    // ابدأ بمزامنة العملاء من Supabase (صامتاً)
    setTimeout(() => syncCustomersFromSupabase(), 1500);
    // حقّن تحسينات التجاوب
    injectResponsiveFixes();

    // اربط حقن كود الإحالة بدالة updatePreview
    if(typeof window.updatePreview === 'function'){
      const origUpdatePreview = window.updatePreview;
      window.updatePreview = function(){
        origUpdatePreview.apply(this, arguments);
        injectReferralIntoPreview();
      };
    }

    // استبدل genInvoiceCode بالنسخة الذكية
    if(typeof window.genInvoiceCode === 'function'){
      window.genInvoiceCode = smartGenerateInvoiceCode;
    }

    // عند إعادة تعيين النموذج، حدّث رقم الفاتورة بالنسخة الذكية
    if(typeof window.resetForm === 'function'){
      const origReset = window.resetForm;
      window.resetForm = function(){
        origReset.apply(this, arguments);
        $('fCode').value = smartGenerateInvoiceCode();
        // مسح شارة "عميل معروف" وكود الإحالة
        showKnownCustomerBadge(null);
        window._invoiceCustomerReferralCode = null;
      };
    }

    // عند حفظ الفاتورة، حدّث nextSeq تلقائياً (لو الرقم استُخدم)
    if(typeof window.saveInvoice === 'function'){
      const origSave = window.saveInvoice;
      window.saveInvoice = function(){
        // قبل الحفظ، استخرج الرقم من fCode واحفظه في nextSeq
        const code = $('fCode')?.value.trim() || '';
        const m = code.match(new RegExp(`^${settings.prefix}-${settings.year}-(\\d+)$`));
        if(m){
          const seq = parseInt(m[1], 10);
          if(seq >= settings.nextSeq){
            settings.nextSeq = seq + 1;
            if(typeof saveSettings === 'function') saveSettings();
          }
        }
        return origSave.apply(this, arguments);
      };
    }

    // أعد تعيين رقم الفاتورة الآن بالنسخة الذكية
    if($('fCode')) $('fCode').value = smartGenerateInvoiceCode();

    // اقرأ بيانات العميل لو قادم من dashboard
    setTimeout(loadCustomerFromDashboard, 300);

    console.log('[invoices-enhancements] v1 loaded');
  }

  // شغّل بعد تحميل DOM
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // أعد المزامنة كل 5 دقائق
  setInterval(() => syncCustomersFromSupabase(), 5 * 60 * 1000);

})();
