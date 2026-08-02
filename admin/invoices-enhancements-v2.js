// admin/invoices-enhancements-v2.js — تحسينات متقدمة v2
// ════════════════════════════════════════════════════════════════
//  قوالب فواتير جاهزة حسب الباقة + عرض سجل العميل + زر تكرار سريع
//  + قوالب رسائل واتساب للفواتير
//
//  يُحمّل بعد invoices-enhancements.js
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  if(!document.getElementById('fPhone') || !document.getElementById('fName')){
    return;
  }

  const $ = id => document.getElementById(id);

  // ════════════════════════════════════════════════════════════════
  //  1) قوالب الباقات للفواتير — تعبئة البنود بضغطة زر
  // ════════════════════════════════════════════════════════════════
  const INVOICE_PACKAGE_TEMPLATES = {
    'الأساسية': {
      label: 'باقة أساسية',
      icon: '⭐',
      items: [
        { desc: 'بطاقة رقمية أساسية (رابط + QR + 4 أقسام)', qty: 1, price: 5.000 },
      ],
      vatRate: 10,
      notes: 'تشمل: رابط مخصص، رمز QR، 4 أقسام رئيسية، صفحة واحدة.\nالمدة المتوقعة: 1 يوم عمل.',
    },
    'القياسية': {
      label: 'باقة قياسية',
      icon: '🌟',
      items: [
        { desc: 'بطاقة رقمية قياسية (رابط + QR + 6 أقسام + معرض صور)', qty: 1, price: 15.000 },
      ],
      vatRate: 10,
      notes: 'تشمل: رابط مخصص، رمز QR، 6 أقسام رئيسية، معرض صور، قسم للتواصل.\nالمدة المتوقعة: 2 يوم عمل.',
    },
    'المميزة': {
      label: 'باقة مميزة',
      icon: '💎',
      items: [
        { desc: 'بطاقة رقمية مميزة (تصميم مخصص بالكامل)', qty: 1, price: 15.000 },
        { desc: 'سيرة ورقية PDF احترافية', qty: 1, price: 0, type: 'gift' },
      ],
      vatRate: 10,
      discount: 3.000,
      notes: 'تشمل: تصميم مخصص بالكامل، رمز QR، أقسام غير محدودة، معرض صور احترافي، سيرة ورقية PDF، تعديلات مجانية.\nالمدة المتوقعة: 3 أيام عمل.',
    },
    'تجديد': {
      label: 'تجديد سنوي',
      icon: '🔄',
      items: [
        { desc: 'تجديد اشتراك بطاقة رقمية (سنة كاملة)', qty: 1, price: 3.000 },
      ],
      vatRate: 10,
      notes: 'تجديد الاشتراك السنوي يشمل: استمرار الرابط، استضافة، دعم فني، تحديثات.',
    },
    'إضافة خدمة': {
      label: 'إضافة خدمة',
      icon: '➕',
      items: [
        { desc: 'إضافة قسم جديد للبطاقة', qty: 1, price: 2.000 },
      ],
      vatRate: 10,
      notes: 'خدمة إضافية للبطاقة الحالية.',
    },
    'تعديل': {
      label: 'تعديل تصميم',
      icon: '✏️',
      items: [
        { desc: 'تعديل تصميم البطاقة (تغيير ألوان، خطوط، تخطيط)', qty: 1, price: 1.500 },
      ],
      vatRate: 10,
      notes: 'تشمل تعديل التصميم مع الحفاظ على المحتوى.',
    },
  };

  // ════════════════════════════════════════════════════════════════
  //  2) قوالب رسائل واتساب للفواتير
  // ════════════════════════════════════════════════════════════════
  const INVOICE_WHATSAPP_TEMPLATES = {
    'invoice_ready': {
      label: 'فاتورة جاهزة',
      icon: '🧾',
      msg: () => `مرحباً!

فاتورتكم من بطاقتي (Bitaqti) جاهزة.

يمكنكم الاطلاع عليها والاطلاع على التفاصيل عبر رابط الفاتورة.
لأي استفسار، نحن في الخدمة.

شكراً لثقتكم! 🙏`
    },
    'payment_confirm': {
      label: 'تأكيد دفع',
      icon: '✅',
      msg: () => `شكراً لك! ✅

تم استلام دفعتك بنجاح. 

نشكرك على ثقتك ببطاقتي (Bitaqti). سنببدأ العمل على طلبك فوراً.`
    },
    'overdue': {
      label: 'تذكير فاتورة متأخرة',
      icon: '⏰',
      msg: () => `مرحباً! 👋

تذكير ودي: فاتورتك من بطاقتي (Bitaqti) متأخرة.

نرجو تسوية المبلغ في أقرب وقت ممكن. لأي استفسار أو ترتيب دفع، نحن في الخدمة.`
    },
  };

  // ════════════════════════════════════════════════════════════════
  //  3) حقن شريط قوالب الباقات في صفحة الفواتير
  // ════════════════════════════════════════════════════════════════
  function injectPackageTemplateBar(){
    const formSection = $('fName')?.closest('.form-section-title')?.parentElement;
    if(!formSection) return;
    if($('invoicePackageBar')) return;

    const bar = document.createElement('div');
    bar.id = 'invoicePackageBar';
    bar.style.cssText = 'margin-bottom:14px;padding:10px;background:linear-gradient(135deg,#F3ECDD,#FBF8F0);border-radius:10px;border:1.5px solid var(--gold);';
    bar.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--gold);margin-bottom:8px;display:flex;align-items:center;gap:4px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
        قوالب الفواتير الجاهزة (اضغط لتعبئة البنود تلقائياً)
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${Object.entries(INVOICE_PACKAGE_TEMPLATES).map(([key, tpl]) => `
          <button type="button" class="inv-pkg-btn" data-pkg="${key}" style="flex:1;min-width:110px;padding:8px 10px;border:1.5px solid var(--line);background:var(--surface);border-radius:8px;cursor:pointer;font-size:11px;font-weight:700;text-align:center;transition:all .2s;">
            <div style="font-size:14px;">${tpl.icon}</div>
            <div style="color:var(--ink);margin-top:2px;">${tpl.label}</div>
          </button>
        `).join('')}
      </div>
    `;

    // ضعها قبل قسم بيانات العميل
    const orderTypeSelector = $('orderTypeSelector');
    if(orderTypeSelector){
      orderTypeSelector.parentNode.insertBefore(bar, orderTypeSelector.nextSibling);
    } else {
      formSection.insertBefore(bar, formSection.firstChild);
    }

    // ربط الأزرار
    bar.querySelectorAll('.inv-pkg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.pkg;
        const tpl = INVOICE_PACKAGE_TEMPLATES[key];
        if(!tpl) return;
        applyInvoiceTemplate(tpl, key);
      });
    });
  }

  function applyInvoiceTemplate(tpl, key){
    if(typeof items === 'undefined' || typeof renderItemsTable !== 'function') return;
    // اسأل قبل الاستبدال لو يوجد بنود
    if(items.some(i => i.description) && !confirm(`هل تريد استبدال البنود الحالية بقالب "${tpl.label}"؟`)){
      return;
    }
    // امسح البنود الحالية
    items.length = 0;
    // أضف بنود القالب
    tpl.items.forEach(it => {
      items.push({
        description: it.desc,
        qty: it.qty || 1,
        unitPrice: it.price,
        itemType: it.type === 'gift' ? 'gift' : 'regular',
        discount: { type: 'none', value: 0 },
        sku: '',
        category: key,
        unit: 'piece',
        internalNotes: '',
        cost: 0,
        originalPrice: it.type === 'gift' ? it.price : 0
      });
    });
    // اضبط VAT
    if($('fVatRate')) $('fVatRate').value = tpl.vatRate || 0;
    // اضبط الخصم
    if(tpl.discount && $('fDiscountType')){
      $('fDiscountType').value = 'fixed';
      $('fDiscountValue').value = tpl.discount;
    }
    // اضبط الملاحظات
    if(tpl.notes && $('fNotes')){
      $('fNotes').value = tpl.notes;
    }
    // اضبط نوع الطلب
    if(key === 'تجديد' && window._currentOrderType !== undefined){
      const renewBtn = document.querySelector('[data-ordtype="renew"]');
      if(renewBtn) renewBtn.click();
    } else if(key === 'إضافة خدمة'){
      const addonBtn = document.querySelector('[data-ordtype="addon"]');
      if(addonBtn) addonBtn.click();
    } else if(key === 'تعديل'){
      const addonBtn = document.querySelector('[data-ordtype="addon"]');
      if(addonBtn) addonBtn.click();
    } else {
      const newBtn = document.querySelector('[data-ordtype="new"]');
      if(newBtn) newBtn.click();
    }
    renderItemsTable();
    if(typeof updatePreview === 'function') updatePreview();
    if(typeof toast === 'function'){
      toast(`تم تطبيق قالب "${tpl.label}"`, 'success');
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  4) عرض سجل العميل السابق عند إدخال الهاتف
  // ════════════════════════════════════════════════════════════════
  function injectCustomerHistoryPanel(){
    if($('customerHistoryPanel')) return;
    const phoneInput = $('fPhone');
    if(!phoneInput) return;
    const formGroup = phoneInput.closest('.form-group');
    if(!formGroup) return;

    const panel = document.createElement('div');
    panel.id = 'customerHistoryPanel';
    panel.style.cssText = 'margin-top:10px;padding:10px;background:var(--paper);border-radius:8px;border:1px solid var(--line);display:none;';
    panel.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--ink-soft);margin-bottom:8px;display:flex;align-items:center;gap:4px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;color:var(--blue);"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
        سجل الفواتير السابقة
        <span id="historyCount" style="background:var(--blue-tint);color:var(--blue);padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;margin-right:4px;">0</span>
      </div>
      <div id="historyList" style="display:flex;flex-direction:column;gap:5px;max-height:150px;overflow-y:auto;"></div>
      <button type="button" id="btnDuplicateLast" style="margin-top:8px;padding:6px 10px;border:1px solid var(--blue);background:var(--blue-tint);color:var(--blue);border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;display:none;">
        📋 تكرار آخر فاتورة لهذا العميل
      </button>
    `;
    formGroup.appendChild(panel);
  }

  function updateCustomerHistoryPanel(phone){
    const panel = $('customerHistoryPanel');
    if(!panel) return;
    const target = String(phone || '').replace(/[\s\-()+]/g, '');
    if(target.length < 6){
      panel.style.display = 'none';
      return;
    }
    if(typeof invoices === 'undefined') return;
    const matches = invoices.filter(inv =>
      inv.customer && inv.customer.phone &&
      String(inv.customer.phone).replace(/[\s\-()+]/g, '').endsWith(target)
    ).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    if(matches.length === 0){
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    $('historyCount').textContent = matches.length;
    const list = $('historyList');
    list.innerHTML = matches.slice(0, 5).map(inv => `
      <div style="background:var(--surface);padding:6px 8px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:6px;cursor:pointer;" data-invid="${inv.id}">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--red);font-family:'IBM Plex Mono',monospace;" dir="ltr">${inv.code || '—'}</div>
          <div style="font-size:10px;color:var(--ink-faint);">${inv.date || ''} · ${inv.customer.name || ''}</div>
        </div>
        <div style="text-align:left;">
          <div style="font-size:11px;font-weight:700;color:var(--ink);">${(Number(inv.totals?.grand)||0).toFixed(3)} د.ب</div>
          <div style="font-size:9px;color:${inv.status === 'paid' ? 'var(--green)' : 'var(--amber)'};">${inv.status === 'paid' ? 'مدفوع' : inv.status === 'sent' ? 'مُرسلة' : 'مسودة'}</div>
        </div>
      </div>
    `).join('');
    // ربط النقر لتحميل الفاتورة
    list.querySelectorAll('[data-invid]').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.invid;
        if(typeof loadInvoice === 'function') loadInvoice(id);
        if(typeof toast === 'function') toast('تم تحميل الفاتورة السابقة', 'info');
      });
    });
    // زر تكرار آخر فاتورة
    const dupBtn = $('btnDuplicateLast');
    if(dupBtn){
      dupBtn.style.display = matches.length > 0 ? 'inline-block' : 'none';
      dupBtn.onclick = () => {
        if(matches[0] && typeof renewFromInvoice === 'function'){
          renewFromInvoice(matches[0]);
        }
      };
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  5) ربط البحث عن السجل عند إدخال الهاتف
  // ════════════════════════════════════════════════════════════════
  function setupHistoryLookup(){
    let timer = null;
    const phoneInput = $('fPhone');
    if(!phoneInput) return;
    phoneInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        updateCustomerHistoryPanel(phoneInput.value);
      }, 500);
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  6) زر سريع: رسائل واتساب للفواتير
  // ════════════════════════════════════════════════════════════════
  function injectWhatsappButton(){
    const toolbar = document.querySelector('.toolbar');
    if(!toolbar || $('btnQuickWhatsapp')) return;
    const btn = document.createElement('button');
    btn.id = 'btnQuickWhatsapp';
    btn.className = 'btn btn-outline btn-sm';
    btn.style.cssText = 'background:var(--green-tint);color:var(--green);border-color:var(--green);';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.4 1.26 4.83L2 22l5.4-1.41a9.9 9.9 0 004.64 1.18h.01c5.46 0 9.9-4.45 9.9-9.91S17.5 2 12.04 2z"/></svg>
      رسالة واتساب
    `;
    btn.addEventListener('click', () => {
      showWhatsappTemplateMenu();
    });
    toolbar.appendChild(btn);
  }

  function showWhatsappTemplateMenu(){
    const name = $('fName')?.value.trim() || '';
    const phone = $('fPhone')?.value.trim() || '';
    if(!phone){
      if(typeof toast === 'function') toast('أدخل رقم هاتف العميل أولاً', 'error');
      return;
    }
    const cleanPhone = phone.replace(/[\s\-()+]/g, '').replace(/^00/, '').replace(/^973/, '');
    const menuHtml = `
      <div style="text-align:right;">
        <p style="font-size:12px;color:var(--ink-soft);margin-bottom:10px;">اختر قالب رسالة واتساب لإرساله إلى ${name || cleanPhone}:</p>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${Object.entries(INVOICE_WHATSAPP_TEMPLATES).map(([key, tpl]) => `
            <button type="button" class="wa-menu-btn" data-wa="${key}" style="padding:10px;border:1px solid var(--line);background:var(--surface);border-radius:8px;cursor:pointer;text-align:right;font-size:12px;color:var(--ink);">
              <span style="font-size:14px;margin-left:6px;">${tpl.icon}</span>
              <strong>${tpl.label}</strong>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    if(typeof showModal === 'function'){
      showModal({
        type: 'info',
        title: 'رسالة واتساب',
        bodyHtml: menuHtml,
        confirmText: 'إغلاق',
        hideCancel: true,
      });
      setTimeout(() => {
        document.querySelectorAll('.wa-menu-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const key = btn.dataset.wa;
            const tpl = INVOICE_WHATSAPP_TEMPLATES[key];
            if(!tpl) return;
            const msg = tpl.msg();
            const url = `https://wa.me/973${cleanPhone}?text=${encodeURIComponent(msg)}`;
            window.open(url, '_blank', 'noopener');
            if(typeof closeModal === 'function') closeModal();
          });
        });
      }, 300);
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  7) ربط الكل
  // ════════════════════════════════════════════════════════════════
  function init(){
    injectPackageTemplateBar();
    injectCustomerHistoryPanel();
    setupHistoryLookup();
    injectWhatsappButton();
    console.log('[invoices-enhancements-v2] loaded');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
