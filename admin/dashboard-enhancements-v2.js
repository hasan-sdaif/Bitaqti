// admin/dashboard-enhancements-v2.js — تحسينات متقدمة v2
// ════════════════════════════════════════════════════════════════
//  قوالب الباقات + قوالب الإجراءات + حساب تلقائي + رسائل واتساب
//  + عرض تفصيلي للعميل + أزرار سريعة + ودجة مهام اليوم
//
//  يُحمّل بعد dashboard-enhancements.js
//  كل الميزات دفاعية: لو فشل تحميل الملف، الصفحة تعمل بدونها.
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  if(!document.getElementById('customersBody') && !document.getElementById('lockScreen')){
    return;
  }

  const $ = id => document.getElementById(id);

  // ════════════════════════════════════════════════════════════════
  //  1) قوالب الباقات — تعبئة تلقائية بضغطة زر
  // ════════════════════════════════════════════════════════════════
  const PACKAGE_TEMPLATES = {
    'الأساسية': {
      price: 5.500, vat: 0.500, discount: 0, total: 5.500, deliveryDays: 1,
      desc: 'بطاقة رقمية أساسية (رابط + QR + 4 أقسام)',
      features: ['رابط مخصص', 'رمز QR', '4 أقسام رئيسية', 'صفحة واحدة']
    },
    'القياسية': {
      price: 16.500, vat: 1.500, discount: 0, total: 16.500, deliveryDays: 2,
      desc: 'بطاقة رقمية قياسية (رابط + QR + 6 أقسام + معرض صور)',
      features: ['رابط مخصص', 'رمز QR', '6 أقسام رئيسية', 'معرض صور', 'قسم للتواصل']
    },
    'المميزة': {
      price: 15.000, vat: 1.091, discount: 3.000, total: 12.000, deliveryDays: 3,
      desc: 'بطاقة رقمية مميزة (تصميم مخصص + معرض صور + سيرة ورقية)',
      features: ['تصميم مخصص بالكامل', 'رمز QR', 'أقسام غير محدودة', 'معرض صور احترافي', 'سيرة ورقية PDF', 'تعديلات مجانية']
    },
  };

  // ════════════════════════════════════════════════════════════════
  //  2) قوالب سجل الإجراءات
  // ════════════════════════════════════════════════════════════════
  const ACTION_TEMPLATES = [
    { text: 'استلام الطلب', icon: '📝' },
    { text: 'استلام السيرة والصورة والروابط', icon: '📸' },
    { text: 'تصميم البطاقة الرقمية وإرسال معاينة', icon: '🎨' },
    { text: 'نشر الرابط النهائي وإرسال رمز QR', icon: '🚀' },
    { text: 'استلام دفعة العربون', icon: '💰' },
    { text: 'استلام الدفعة الكاملة', icon: '✅' },
    { text: 'تسليم البطاقة النهائية', icon: '📦' },
    { text: 'تعديل بنود البطاقة', icon: '✏️' },
    { text: 'تجديد الاشتراك', icon: '🔄' },
    { text: 'تواصل مع العميل للتأكيد', icon: '📞' },
  ];

  // ════════════════════════════════════════════════════════════════
  //  3) قوالب رسائل واتساب
  // ════════════════════════════════════════════════════════════════
  const WHATSAPP_TEMPLATES = {
    'welcome': {
      label: 'ترحيب بعميل جديد',
      icon: '👋',
      msg: (c) => `مرحباً ${c.customer_name || ''}! 🎉

شكراً لثقتك ببطاقتي (Bitaqti).

رمز طلبك: ${c.order_code || ''}
الباقة: ${c.package || ''}
الإجمالي: ${(Number(c.total_with_vat)||0).toFixed(3)} د.ب

سنبدأ العمل على بطاقتك الرقمية فوراً وسيصلك رابط المعاينة قريباً.

للاستفسار: wa.me/97366302585`
    },
    'preview': {
      label: 'إرسال معاينة التصميم',
      icon: '🎨',
      msg: (c) => `مرحباً ${c.customer_name || ''}! ✨

تم تصميم بطاقتك الرقمية! يمكنك معاينتها عبر الرابط التالي:
${c.design_link || c.cv_link || ''}

أخبرنا بأي تعديلات تريدها قبل النشر النهائي.

رمز طلبك: ${c.order_code || ''}`
    },
    'delivery': {
      label: 'تسليم البطاقة النهائية',
      icon: '🚀',
      msg: (c) => `مرحباً ${c.customer_name || ''}! 🎉

بطاقتك الرقمية جاهزة! 🚀

رابط بطاقتك: ${c.cv_link || ''}
${c.qr_code_path ? 'رمز QR: ' + c.qr_code_path : ''}

يمكنك مشاركة الرابط مع أي شخص. شكراً لثقتك بنا!

${c.referral_code ? '🎁 كود الإحالة الخاص بك: ' + c.referral_code + '\nشاركه مع أصدقائك واحصل على 100 نقطة لكل إحالة ناجحة!' : ''}`
    },
    'payment_reminder': {
      label: 'تذكير بالدفع',
      icon: '💰',
      msg: (c) => `مرحباً ${c.customer_name || ''}! 👋

تذكير ودي: المبلغ المتبقي على طلبك ${c.order_code || ''} هو ${((Number(c.total_with_vat)||0) - (Number(c.discount_amount)||0)).toFixed(3)} د.ب

يمكنك الدفع عبر:
• تحويل بنكي
• بنفت باي (BenefitPay)

شكراً لك! 🙏`
    },
    'referral': {
      label: 'دعوة صديق',
      icon: '🎁',
      msg: (c) => `🎉 ${c.customer_name || ''}، شارك كود الإحالة الخاص بك واحصل على هدايا!

كودك: ${c.referral_code || ''}

أرسله لأصدقائك — يحصلون على خصم 20% وأنت تحصل على 100 نقطة لكل إحالة ناجحة!

النقاط يمكن استبدالها بـ:
• 50 نقطة = تعديل قسم
• 100 نقطة = تغيير تصميم
• 300 نقطة = بطاقة قياسية مجانية
• 500 نقطة = بطاقة مميزة مجانية

شارك الآن: https://bitaqti.com/?ref=${c.referral_code || ''}`
    },
  };

  // ════════════════════════════════════════════════════════════════
  //  4) حقن قوالب الباقات في نافذة التعديل
  // ════════════════════════════════════════════════════════════════
  function injectPackageTemplates(){
    // راقب ظهور نافذة التعديل
    const observer = new MutationObserver(() => {
      const modalBody = document.querySelector('.modal-body');
      const packageInput = $('ef_package');
      if(!modalBody || !packageInput) return;
      if($('packageTemplatesBar')) return; // already injected

      // ابحث عن قسم "تفاصيل الطلب" (حقل ef_package موجود فيه)
      const formGroup = packageInput.closest('.form-group');
      if(!formGroup) return;

      const bar = document.createElement('div');
      bar.id = 'packageTemplatesBar';
      bar.style.cssText = 'margin-bottom:10px;padding:8px;background:linear-gradient(135deg,#F3ECDD,#FBF8F0);border-radius:8px;border:1px solid var(--gold);';
      bar.innerHTML = `
        <div style="font-size:10.5px;font-weight:700;color:var(--gold);margin-bottom:6px;display:flex;align-items:center;gap:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          قوالب الباقات (اضغط للتعبئة التلقائية)
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          ${Object.entries(PACKAGE_TEMPLATES).map(([name, tpl]) => `
            <button type="button" class="pkg-tpl-btn" data-pkg="${name}" style="flex:1;min-width:100px;padding:8px 10px;border:1.5px solid var(--line);background:var(--surface);border-radius:8px;cursor:pointer;font-size:11.5px;font-weight:700;text-align:center;transition:all .2s;">
              <div style="color:var(--ink);">${name}</div>
              <div style="font-size:10px;color:var(--red);font-family:'IBM Plex Mono',monospace;margin-top:2px;">${tpl.total.toFixed(3)} د.ب</div>
            </button>
          `).join('')}
        </div>
      `;

      formGroup.parentNode.insertBefore(bar, formGroup);

      // ربط الأزرار
      bar.querySelectorAll('.pkg-tpl-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const pkgName = btn.dataset.pkg;
          const tpl = PACKAGE_TEMPLATES[pkgName];
          if(!tpl) return;
          // املأ الحقول
          if($('ef_package')) $('ef_package').value = pkgName;
          if($('ef_price')) $('ef_price').value = tpl.price.toFixed(3);
          if($('ef_vat_amount')) $('ef_vat_amount').value = tpl.vat.toFixed(3);
          if($('ef_discount_amount')) $('ef_discount_amount').value = tpl.discount.toFixed(3);
          if($('ef_total_with_vat')) $('ef_total_with_vat').value = tpl.total.toFixed(3);
          // تعبئة تاريخ التسليم
          const orderDate = $('ef_order_date')?.value || '';
          if(orderDate && $('ef_delivery_date')){
            const d = parseDDMMYYYY(orderDate);
            if(d){
              d.setDate(d.getDate() + tpl.deliveryDays);
              $('ef_delivery_date').value = d.toLocaleDateString('en-GB').split('/').join('/');
            }
          }
          // تعبئة subpage_content
          if($('ef_subpage_content') && !$('ef_subpage_content').value.trim()){
            $('ef_subpage_content').value = 'بطاقتك قيد التصميم، سيصلك رابط المعاينة قريباً.';
          }
          // تعبئة actions_log لو فارغ
          const today = new Date().toLocaleDateString('en-GB').split('/').join('/');
          if($('ef_actions_log')){
            const current = $('ef_actions_log').value;
            const entry = `${today} - استلام الطلب لباقة ${pkgName}`;
            if(!current.includes('استلام الطلب')){
              $('ef_actions_log').value = current ? `${current} | ${entry}` : entry;
              updateTimelineHidden();
              // أعد رسم الـ timeline editor لو موجود
              if(typeof refreshTimelineEditor === 'function') refreshTimelineEditor();
            }
          }
          // تأثير بصري
          btn.style.background = 'var(--gold-tint)';
          btn.style.borderColor = 'var(--gold)';
          setTimeout(() => {
            btn.style.background = 'var(--surface)';
            btn.style.borderColor = 'var(--line)';
          }, 600);
          if(typeof toast === 'function'){
            toast(`تم تطبيق قالب "${pkgName}" — السعر ${tpl.total.toFixed(3)} د.ب`, 'success');
          }
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function parseDDMMYYYY(s){
    const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(!m) return null;
    return new Date(parseInt(m[3]), parseInt(m[2])-1, parseInt(m[1]));
  }

  // ════════════════════════════════════════════════════════════════
  //  5) حقن قوالب سجل الإجراءات
  // ════════════════════════════════════════════════════════════════
  function injectActionTemplates(){
    const observer = new MutationObserver(() => {
      const timelineContainer = $('timelineContainer');
      const btnAddTimeline = $('btnAddTimeline');
      if(!timelineContainer || !btnAddTimeline) return;
      if($('actionTemplatesBar')) return;

      const bar = document.createElement('div');
      bar.id = 'actionTemplatesBar';
      bar.style.cssText = 'margin-top:8px;padding:6px;background:var(--paper);border-radius:6px;border:1px dashed var(--line);';
      bar.innerHTML = `
        <div style="font-size:10px;color:var(--ink-faint);margin-bottom:4px;">قوالب سريعة (اضغط لإضافة إجراء بتاريخ اليوم):</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          ${ACTION_TEMPLATES.map((a, i) => `
            <button type="button" class="act-tpl-chip" data-act="${i}" style="padding:4px 8px;border:1px solid var(--line);background:var(--surface);border-radius:12px;cursor:pointer;font-size:10.5px;color:var(--ink-soft);transition:all .15s;">
              ${a.icon} ${a.text}
            </button>
          `).join('')}
        </div>
      `;

      timelineContainer.parentNode.insertBefore(bar, timelineContainer.nextSibling);

      bar.querySelectorAll('.act-tpl-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const idx = parseInt(chip.dataset.act);
          const tpl = ACTION_TEMPLATES[idx];
          const today = new Date().toLocaleDateString('en-GB').split('/').join('/');
          // أضف صف جديد للمحرر
          if(typeof addTimelineRow === 'function'){
            addTimelineRow(today, tpl.text);
          }
          // تأثير بصري
          chip.style.background = 'var(--red-tint)';
          chip.style.color = 'var(--red)';
          chip.style.borderColor = 'var(--red)';
          setTimeout(() => {
            chip.style.background = 'var(--surface)';
            chip.style.color = 'var(--ink-soft)';
            chip.style.borderColor = 'var(--line)';
          }, 500);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ════════════════════════════════════════════════════════════════
  //  6) حساب تلقائي للإجمالي عند تغيير السعر/الخصم
  // ════════════════════════════════════════════════════════════════
  function setupAutoCalcTotal(){
    const observer = new MutationObserver(() => {
      ['ef_price', 'ef_vat_amount', 'ef_discount_amount'].forEach(id => {
        const el = $(id);
        if(el && !el.dataset.autoCalc){
          el.dataset.autoCalc = '1';
          el.addEventListener('input', () => {
            const price = Number(($('ef_price')?.value || '0').replace(/[^0-9.\-]/g,'')) || 0;
            const discount = Number(($('ef_discount_amount')?.value || '0').replace(/[^0-9.\-]/g,'')) || 0;
            // total = price - discount (VAT مُضمّن في السعر)
            const total = Math.max(0, price - discount);
            const totalEl = $('ef_total_with_vat');
            if(totalEl) totalEl.value = total.toFixed(3);
          });
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ════════════════════════════════════════════════════════════════
  //  7) عرض تفصيلي للعميل (Customer Detail Modal)
  // ════════════════════════════════════════════════════════════════
  function showCustomerDetail(c){
    if(!c) return;
    // اجمع طلبات العميل (نفس الهاتف)
    const phone = String(c.phone || '').replace(/[\s\-()+]/g, '');
    const allOrders = (typeof customers !== 'undefined')
      ? customers.filter(x => String(x.phone || '').replace(/[\s\-()+]/g, '') === phone)
      : [c];

    const totalSpent = allOrders.reduce((sum, o) => sum + (Number(o.total_with_vat) || Number(o.price) || 0), 0);
    const paidOrders = allOrders.filter(o => o.payment_status === 'مدفوع').length;
    const pendingAmount = allOrders
      .filter(o => o.payment_status === 'غير مدفوع' || o.payment_status === 'مدفوع جزئياً')
      .reduce((sum, o) => sum + (Number(o.total_with_vat) || 0), 0);

    // تاريخ الإجراءات
    const timeline = (c.actions_log || '').split('|').map(s => s.trim()).filter(Boolean);

    // استخدم showModal لو موجود، وإلا أنشئ نافذة خاصة
    const html = `
      <div style="text-align:right;max-height:65vh;overflow-y:auto;padding:0 4px;">
        <!-- بطاقة معلومات العميل -->
        <div style="background:linear-gradient(135deg,#F4F3EF,#FFFFFF);border-radius:12px;padding:14px;margin-bottom:14px;border:1px solid var(--line);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;">
            <div>
              <div style="font-size:18px;font-weight:700;color:var(--ink);">${escapeHtmlSafe(c.customer_name || '—')}</div>
              <div style="font-size:12px;color:var(--ink-soft);margin-top:3px;" dir="ltr">${escapeHtmlSafe(c.phone || '—')}</div>
              ${c.customer_email ? `<div style="font-size:11px;color:var(--ink-faint);" dir="ltr">${escapeHtmlSafe(c.customer_email)}</div>` : ''}
            </div>
            <div style="text-align:left;">
              <div style="font-size:10px;color:var(--ink-faint);">رمز الطلب</div>
              <div style="font-size:14px;font-weight:700;color:var(--red);font-family:'IBM Plex Mono',monospace;" dir="ltr">${escapeHtmlSafe(c.order_code || '—')}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-top:12px;">
            <div style="background:var(--surface);padding:8px;border-radius:6px;text-align:center;">
              <div style="font-size:10px;color:var(--ink-faint);">الباقة</div>
              <div style="font-size:12px;font-weight:700;color:var(--ink);">${escapeHtmlSafe(c.package || '—')}</div>
            </div>
            <div style="background:var(--surface);padding:8px;border-radius:6px;text-align:center;">
              <div style="font-size:10px;color:var(--ink-faint);">الإجمالي</div>
              <div style="font-size:12px;font-weight:700;color:var(--ink);">${(Number(c.total_with_vat)||0).toFixed(3)} د.ب</div>
            </div>
            <div style="background:var(--surface);padding:8px;border-radius:6px;text-align:center;">
              <div style="font-size:10px;color:var(--ink-faint);">الحالة</div>
              <div style="font-size:11px;font-weight:700;color:var(--ink);">${escapeHtmlSafe(c.status || '—')}</div>
            </div>
            <div style="background:var(--surface);padding:8px;border-radius:6px;text-align:center;">
              <div style="font-size:10px;color:var(--ink-faint);">الدفع</div>
              <div style="font-size:11px;font-weight:700;color:var(--ink);">${escapeHtmlSafe(c.payment_status || '—')}</div>
            </div>
          </div>
        </div>

        <!-- إحصائيات سريعة -->
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">
          <div style="background:var(--green-tint);padding:10px;border-radius:8px;text-align:center;">
            <div style="font-size:10px;color:var(--green);font-weight:700;">إجمالي الإنفاق</div>
            <div style="font-size:16px;font-weight:700;color:var(--green);margin-top:2px;">${totalSpent.toFixed(3)}</div>
            <div style="font-size:9px;color:var(--green);">د.ب</div>
          </div>
          <div style="background:var(--blue-tint);padding:10px;border-radius:8px;text-align:center;">
            <div style="font-size:10px;color:var(--blue);font-weight:700;">عدد الطلبات</div>
            <div style="font-size:16px;font-weight:700;color:var(--blue);margin-top:2px;">${allOrders.length}</div>
            <div style="font-size:9px;color:var(--blue);">${paidOrders} مدفوع</div>
          </div>
          <div style="background:var(--amber-tint);padding:10px;border-radius:8px;text-align:center;">
            <div style="font-size:10px;color:var(--amber);font-weight:700;">مبالغ معلّقة</div>
            <div style="font-size:16px;font-weight:700;color:var(--amber);margin-top:2px;">${pendingAmount.toFixed(3)}</div>
            <div style="font-size:9px;color:var(--amber);">د.ب</div>
          </div>
        </div>

        <!-- معلومات الإحالة -->
        ${c.referral_code ? `
        <div style="background:linear-gradient(135deg,#F3ECDD,#FBF8F0);border:1.5px dashed var(--gold);border-radius:10px;padding:12px;margin-bottom:14px;">
          <div style="font-size:11px;color:var(--gold);font-weight:700;margin-bottom:6px;">🎁 نظام الإحالة</div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
            <div>
              <div style="font-size:10px;color:var(--ink-soft);">كود الإحالة الخاص بالعميل</div>
              <div style="font-size:16px;font-weight:700;color:var(--ink);font-family:'IBM Plex Mono',monospace;direction:ltr;" dir="ltr">${escapeHtmlSafe(c.referral_code)}</div>
            </div>
            <div style="text-align:left;">
              <div style="font-size:10px;color:var(--ink-soft);">النقاط</div>
              <div style="font-size:16px;font-weight:700;color:var(--gold);">${Number(c.referral_points || 0)} نقطة</div>
            </div>
            ${c.referred_by ? `<div style="width:100%;font-size:10px;color:var(--ink-faint);border-top:1px dashed var(--line);padding-top:6px;margin-top:4px;">أُحيل بواسطة: <strong style="color:var(--red);">${escapeHtmlSafe(c.referred_by)}</strong></div>` : ''}
          </div>
        </div>
        ` : ''}

        <!-- تاريخ الإجراءات -->
        ${timeline.length > 0 ? `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px;height:14px;color:var(--red);"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
            تاريخ الإجراءات
          </div>
          <div style="position:relative;padding-right:16px;border-right:2px solid var(--line);">
            ${timeline.map(step => {
              const idx = step.indexOf(' - ');
              const date = idx > -1 ? step.slice(0, idx).trim() : '';
              const desc = idx > -1 ? step.slice(idx + 3).trim() : step;
              return `<div style="margin-bottom:10px;position:relative;">
                <div style="position:absolute;right:-21px;top:4px;width:10px;height:10px;border-radius:50%;background:var(--red);border:2px solid var(--surface);"></div>
                <div style="font-size:10px;color:var(--ink-faint);font-family:'IBM Plex Mono',monospace;" dir="ltr">${escapeHtmlSafe(date)}</div>
                <div style="font-size:12px;color:var(--ink);margin-top:1px;">${escapeHtmlSafe(desc)}</div>
              </div>`;
            }).join('')}
          </div>
        </div>
        ` : ''}

        <!-- الطلبات السابقة -->
        ${allOrders.length > 1 ? `
        <div style="margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;color:var(--ink);margin-bottom:8px;">📋 الطلبات السابقة (${allOrders.length})</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            ${allOrders.map(o => `
              <div style="background:var(--paper);padding:8px 10px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">
                <div>
                  <div style="font-size:11px;font-weight:700;color:var(--red);font-family:'IBM Plex Mono',monospace;" dir="ltr">${escapeHtmlSafe(o.order_code || '—')}</div>
                  <div style="font-size:10px;color:var(--ink-faint);">${escapeHtmlSafe(o.package || '')} · ${escapeHtmlSafe(o.order_date || '')}</div>
                </div>
                <div style="text-align:left;">
                  <div style="font-size:11px;font-weight:700;color:var(--ink);">${(Number(o.total_with_vat)||0).toFixed(3)} د.ب</div>
                  <div style="font-size:9px;color:${o.payment_status === 'مدفوع' ? 'var(--green)' : 'var(--amber)'};">${escapeHtmlSafe(o.payment_status || '')}</div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <!-- معلومات إضافية -->
        <div style="background:var(--paper);padding:10px;border-radius:8px;font-size:11px;line-height:1.7;">
          ${c.cv_link ? `<div><strong>🔗 رابط البطاقة:</strong> <span style="color:var(--red);" dir="ltr">${escapeHtmlSafe(c.cv_link)}</span></div>` : ''}
          ${c.assigned_designer ? `<div><strong>🎨 المصمم:</strong> ${escapeHtmlSafe(c.assigned_designer)}</div>` : ''}
          ${c.delivery_date ? `<div><strong>📦 تاريخ التسليم:</strong> ${escapeHtmlSafe(c.delivery_date)}</div>` : ''}
          ${c.invoice_notes ? `<div><strong>📝 ملاحظات:</strong> ${escapeHtmlSafe(c.invoice_notes)}</div>` : ''}
        </div>
      </div>
    `;

    // استخدم showModal لو موجود
    if(typeof showModal === 'function'){
      showModal({
        type: 'info',
        title: `تفاصيل العميل: ${c.customer_name || c.phone}`,
        wide: true,
        bodyHtml: html,
        confirmText: 'إغلاق',
        cancelText: 'تعديل العميل',
        onConfirm: () => { closeModal(); },
        onCancel: () => {
          closeModal();
          if(typeof openEditModal === 'function') openEditModal(c);
        },
      });
      // أضف أزرار واتساب بعد فتح النافذة
      setTimeout(() => {
        addWhatsappTemplatesToModal(c);
      }, 300);
    }
  }

  function addWhatsappTemplatesToModal(c){
    const modalBody = document.querySelector('.modal-body');
    if(!modalBody) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:10px;padding:10px;background:var(--surface);border-radius:8px;border:1px solid var(--line);';
    wrap.innerHTML = `
      <div style="font-size:11px;font-weight:700;color:var(--green);margin-bottom:8px;display:flex;align-items:center;gap:4px;">
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.4 1.26 4.83L2 22l5.4-1.41a9.9 9.9 0 004.64 1.18h.01c5.46 0 9.9-4.45 9.9-9.91S17.5 2 12.04 2z"/></svg>
        قوالب رسائل واتساب
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;">
        ${Object.entries(WHATSAPP_TEMPLATES).map(([key, tpl]) => `
          <button type="button" class="wa-tpl-btn" data-wa="${key}" style="padding:6px 10px;border:1px solid var(--green);background:var(--green-tint);color:var(--green);border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;">
            ${tpl.icon} ${tpl.label}
          </button>
        `).join('')}
      </div>
    `;
    modalBody.appendChild(wrap);
    wrap.querySelectorAll('.wa-tpl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.wa;
        const tpl = WHATSAPP_TEMPLATES[key];
        if(!tpl) return;
        const msg = tpl.msg(c);
        const phone = String(c.phone || '').replace(/[\s\-()+]/g, '');
        const url = `https://wa.me/973${phone}?text=${encodeURIComponent(msg)}`;
        window.open(url, '_blank', 'noopener');
      });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  8) أزرار سريعة لتغيير الحالة في صف العملاء
  // ════════════════════════════════════════════════════════════════
  function injectQuickStatusButtons(){
    // راقب عرض العملاء
    const observer = new MutationObserver(() => {
      const rows = document.querySelectorAll('#customersBody tr');
      rows.forEach(row => {
        if(row.dataset.quickStatusAdded) return;
        const statusCell = row.querySelector('td:nth-child(7)');
        if(!statusCell) return;
        const phone = row.querySelector('[data-phone]')?.dataset.phone;
        if(!phone) return;
        row.dataset.quickStatusAdded = '1';

        // أضف زر سريع لتقديم الحالة
        const statusText = statusCell.textContent.trim();
        const statusFlow = ['قيد التنفيذ', 'بانتظار الدفع', 'تم التصميم', 'تم التسليم'];
        const currentIdx = statusFlow.indexOf(statusText);
        if(currentIdx >= 0 && currentIdx < statusFlow.length - 1){
          const nextStatus = statusFlow[currentIdx + 1];
          const btn = document.createElement('button');
          btn.className = 'row-action';
          btn.style.cssText = 'background:var(--green-tint);color:var(--green);margin-right:2px;';
          btn.title = `تحويل إلى: ${nextStatus}`;
          btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:11px;height:11px;"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if(typeof customers === 'undefined') return;
            const cust = customers.find(c => String(c.phone) === String(phone));
            if(!cust) return;
            // حدّث الحالة
            cust.status = nextStatus;
            cust.last_updated = new Date().toLocaleDateString('en-GB').split('/').join('/');
            // أضف إجراء للسجل
            const today = new Date().toLocaleDateString('en-GB').split('/').join('/');
            const entry = `${today} - تحويل الحالة إلى: ${nextStatus}`;
            cust.actions_log = cust.actions_log ? `${cust.actions_log} | ${entry}` : entry;
            // اكتب لقاعدة البيانات
            if(typeof writeToSheet === 'function'){
              writeToSheet('update', cust).then(() => {
                if(typeof renderCustomers === 'function') renderCustomers();
                if(typeof toast === 'function') toast(`تم تحويل الحالة إلى: ${nextStatus}`, 'success');
              });
            }
          });
          const actionsCell = row.querySelector('.col-actions');
          if(actionsCell) actionsCell.insertBefore(btn, actionsCell.firstChild);
        }
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ════════════════════════════════════════════════════════════════
  //  9) ودجة مهام اليوم
  // ════════════════════════════════════════════════════════════════
  function injectTodayTasksWidget(){
    const dashboardTab = $('tab-dashboard');
    if(!dashboardTab) return;
    if($('todayTasksWidget')) return;

    const widget = document.createElement('div');
    widget.id = 'todayTasksWidget';
    widget.style.cssText = 'margin-bottom:20px;padding:16px;background:linear-gradient(135deg,#FFFFFF,#F4F3EF);border-radius:14px;border:1px solid var(--line);box-shadow:0 4px 12px rgba(23,24,28,.04);';
    widget.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">
        <div style="width:36px;height:36px;border-radius:10px;background:var(--red-tint);color:var(--red);display:flex;align-items:center;justify-content:center;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
        </div>
        <div>
          <h3 style="font-size:15px;font-weight:700;color:var(--ink);">مهام اليوم</h3>
          <div style="font-size:11px;color:var(--ink-faint);" id="todayDate"></div>
        </div>
      </div>
      <div id="todayTasksContent" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
        <div style="text-align:center;color:var(--ink-faint);font-size:12px;padding:20px;">جارٍ التحميل...</div>
      </div>
    `;

    // ابحث عن مكان مناسب (بعد quick-actions)
    const quickActions = dashboardTab.querySelector('.quick-actions');
    if(quickActions && quickActions.nextSibling){
      quickActions.parentNode.insertBefore(widget, quickActions.nextSibling);
    } else {
      dashboardTab.insertBefore(widget, dashboardTab.firstChild);
    }

    // عرض التاريخ
    const today = new Date();
    const dateEl = widget.querySelector('#todayDate');
    if(dateEl){
      dateEl.textContent = today.toLocaleDateString('ar-EG', {weekday:'long', year:'numeric', month:'long', day:'numeric'});
    }
  }

  function updateTodayTasksContent(){
    const content = $('todayTasksContent');
    if(!content) return;
    if(typeof customers === 'undefined' || !customers.length){
      content.innerHTML = '<div style="text-align:center;color:var(--ink-faint);font-size:12px;padding:20px;">لا توجد بيانات</div>';
      return;
    }
    const today = new Date().toLocaleDateString('en-GB').split('/').join('/');
    const todayOrders = customers.filter(c => c.delivery_date === today && c.status !== 'تم التسليم' && c.status !== 'ملغي');
    const pendingPayments = customers.filter(c => c.payment_status === 'غير مدفوع' && c.status !== 'ملغي');
    const pendingAmount = pendingPayments.reduce((s, c) => s + (Number(c.total_with_vat) || 0), 0);
    const inProgress = customers.filter(c => c.status === 'قيد التنفيذ');
    const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
    const newThisWeek = customers.filter(c => {
      const d = parseDDMMYYYY(c.order_date);
      return d && d >= weekAgo;
    });

    content.innerHTML = `
      <div style="background:var(--red-tint);padding:12px;border-radius:10px;cursor:pointer;" id="taskTodayDelivery">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" style="width:14px;height:14px;"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
          <span style="font-size:11px;font-weight:700;color:var(--red);">تسليم اليوم</span>
        </div>
        <div style="font-size:22px;font-weight:700;color:var(--red);">${todayOrders.length}</div>
        <div style="font-size:10px;color:var(--red);">طلب يجب تسليمه اليوم</div>
      </div>
      <div style="background:var(--amber-tint);padding:12px;border-radius:10px;cursor:pointer;" id="taskPendingPay">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" style="width:14px;height:14px;"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
          <span style="font-size:11px;font-weight:700;color:var(--amber);">مدفوعات معلّقة</span>
        </div>
        <div style="font-size:22px;font-weight:700;color:var(--amber);">${pendingAmount.toFixed(0)}</div>
        <div style="font-size:10px;color:var(--amber);">د.ب من ${pendingPayments.length} عميل</div>
      </div>
      <div style="background:var(--blue-tint);padding:12px;border-radius:10px;cursor:pointer;" id="taskInProgress">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2" style="width:14px;height:14px;"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
          <span style="font-size:11px;font-weight:700;color:var(--blue);">قيد التنفيذ</span>
        </div>
        <div style="font-size:22px;font-weight:700;color:var(--blue);">${inProgress.length}</div>
        <div style="font-size:10px;color:var(--blue);">طلب نشط حالياً</div>
      </div>
      <div style="background:var(--green-tint);padding:12px;border-radius:10px;cursor:pointer;" id="taskNewWeek">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2" style="width:14px;height:14px;"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>
          <span style="font-size:11px;font-weight:700;color:var(--green);">عملاء جدد</span>
        </div>
        <div style="font-size:22px;font-weight:700;color:var(--green);">${newThisWeek.length}</div>
        <div style="font-size:10px;color:var(--green);">هذا الأسبوع</div>
      </div>
    `;

    // ربط النقر
    const taskToday = $('taskTodayDelivery');
    if(taskToday) taskToday.addEventListener('click', () => {
      if(typeof switchTab === 'function') switchTab('customers');
      if(typeof $ === 'function'){
        const search = $('searchInput');
        if(search){ search.value = today; if(typeof renderCustomers === 'function') renderCustomers(); }
      }
    });
    const taskPay = $('taskPendingPay');
    if(taskPay) taskPay.addEventListener('click', () => {
      if(typeof switchTab === 'function') switchTab('customers');
      const filter = $('filterPayment');
      if(filter){ filter.value = 'غير مدفوع'; if(typeof renderCustomers === 'function') renderCustomers(); }
    });
    const taskProgress = $('taskInProgress');
    if(taskProgress) taskProgress.addEventListener('click', () => {
      if(typeof switchTab === 'function') switchTab('customers');
      const filter = $('filterStatus');
      if(filter){ filter.value = 'قيد التنفيذ'; if(typeof renderCustomers === 'function') renderCustomers(); }
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  10) ربط زر "عرض" في صف العملاء بعرض التفصيلي
  // ════════════════════════════════════════════════════════════════
  function hookViewCustomerButton(){
    if(typeof window.viewCustomer === 'function'){
      const orig = window.viewCustomer;
      window.viewCustomer = function(c){
        // استخدم العرض التفصيلي بدلاً من العرض البسيط
        showCustomerDetail(c);
      };
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  11) إعادة رسم محرر الـ Timeline (دالة مساعدة)
  // ════════════════════════════════════════════════════════════════
  function refreshTimelineEditor(){
    const hidden = $('ef_actions_log');
    if(!hidden) return;
    const container = $('timelineContainer');
    if(!container) return;
    // امسح وأعد الرسم
    container.innerHTML = '';
    const entries = (typeof parseTimelineEntries === 'function')
      ? parseTimelineEntries(hidden.value)
      : [];
    if(entries.length === 0){
      container.innerHTML = '<div style="text-align:center;color:var(--ink-faint);font-size:12px;padding:14px;">لا توجد إجراءات بعد. اضغط «إضافة إجراء» للبدء.</div>';
      return;
    }
    entries.forEach((entry, idx) => {
      const row = document.createElement('div');
      row.className = 'timeline-row';
      row.dataset.idx = idx;
      row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:flex-start;flex-wrap:wrap;';
      row.innerHTML = `
        <input type="text" class="form-control mono tl-date" value="${entry.date}" placeholder="DD/MM/YYYY" style="width:120px;flex-shrink:0;font-size:12px;padding:6px 8px;" dir="ltr">
        <input type="text" class="form-control tl-desc" value="${entry.desc}" placeholder="وصف الإجراء" style="flex:1;min-width:200px;font-size:12px;padding:6px 8px;">
        <button type="button" class="btn btn-outline btn-sm tl-remove" style="padding:6px 8px;flex-shrink:0;" title="حذف">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      `;
      container.appendChild(row);
      // ربط الأحداث
      row.querySelector('.tl-remove').onclick = () => { row.remove(); updateTimelineHidden(); };
      row.querySelector('.tl-date').oninput = updateTimelineHidden;
      row.querySelector('.tl-desc').oninput = updateTimelineHidden;
    });
  }

  function escapeHtmlSafe(s){
    if(typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ════════════════════════════════════════════════════════════════
  //  12) ربط الكل بعد تحميل الصفحة
  // ════════════════════════════════════════════════════════════════
  function init(){
    injectPackageTemplates();
    injectActionTemplates();
    setupAutoCalcTotal();
    injectQuickStatusButtons();
    hookViewCustomerButton();

    // أضف ودجة مهام اليوم بعد تحميل البيانات
    setTimeout(() => {
      injectTodayTasksWidget();
      updateTodayTasksContent();
    }, 2000);

    // راقب تحديث قائمة العملاء لتحديث الودجة
    const origRender = window.renderCustomers;
    if(typeof origRender === 'function'){
      window.renderCustomers = function(){
        origRender.apply(this, arguments);
        setTimeout(updateTodayTasksContent, 100);
      };
    }

    // راقب المزامنة لتحديث الودجة
    const origSync = window.syncFromSheet;
    if(typeof origSync === 'function'){
      window.syncFromSheet = function(){
        const result = origSync.apply(this, arguments);
        if(result && typeof result.then === 'function'){
          result.then(() => setTimeout(updateTodayTasksContent, 500));
        }
        return result;
      };
    }

    console.log('[dashboard-enhancements-v2] loaded');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
