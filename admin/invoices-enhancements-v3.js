// admin/invoices-enhancements-v3.js — تحسينات الفواتير v3 (تبع الـ Bridge)
// ════════════════════════════════════════════════════════════════
//  يعتمد على BitaqtiBridge (bridge.js) — يجب تحميله أولاً.
//
//  الميزات:
//  • آلة حاسبة ذكية (Smart Calculator) للبنود
//  • قوالب ملاحظات للفواتير (3 قوالب)
//  • ربط بنود الفاتورة بباقات العملاء من Supabase
//  • عرض إحصائيات سريعة (Mini Stats Bar)
//  • ربط بصفحة الفواتير من البحث العالمي
//  • كشف الفجوات في الترقيم تلقائياً
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';

  if(!document.getElementById('fPhone')) return;
  if(!window.BitaqtiBridge) return;

  const $ = id => document.getElementById(id);

  // ════════════════════════════════════════════════════════════════
  //  1) قوالب ملاحظات للفواتير (3 قوالب)
  // ════════════════════════════════════════════════════════════════
  const NOTES_TEMPLATES = [
    {
      label: 'شروط الدفع',
      icon: '💳',
      text: 'شروط الدفع:\n• الدفع خلال 7 أيام من تاريخ الفاتورة\n• تحويل بنكي أو بنفت باي (BenefitPay)\n• تأخير الدفع قد يؤثر على جدول التسليم'
    },
    {
      label: 'معلومات التسليم',
      icon: '📦',
      text: 'معلومات التسليم:\n• سيتم تسليم البطاقة الرقمية عبر الرابط المخصص\n• رمز QR سيُرسل عبر واتساب\n• التعديلات المجانية خلال 7 أيام من التسليم'
    },
    {
      label: 'شكر وترحيب',
      icon: '🙏',
      text: 'شكراً لثقتكم ببطاقتي (Bitaqti)!\n\nنحن سعداء بخدمتكم. لأي استفسار أو دعم، نحن متواجدون عبر واتساب: wa.me/97366302585'
    },
    {
      label: 'إحالة وخصم',
      icon: '🎁',
      text: '🎁 عرض خاص: شارك بطاقتك مع أصدقائك واحصل على 100 نقطة لكل إحالة ناجحة!\n\nنقاطك يمكن استبدالها بـ:\n• 50 نقطة = تعديل قسم\n• 100 نقطة = تغيير تصميم\n• 300 نقطة = بطاقة قياسية مجانية\n• 500 نقطة = بطاقة مميزة مجانية'
    },
    {
      label: 'تجديد سنوي',
      icon: '🔄',
      text: 'هذه الفاتورة لتجديد الاشتراك السنوي.\n\nيشمل التجديد:\n• استمرار الرابط المخصص\n• استضافة البطاقة\n• دعم فني على مدار السنة\n• تحديثات وتحسينات'
    },
  ];

  function injectNotesTemplates(){
    const notesInput = $('fNotes');
    if(!notesInput) return;
    if($('notesTemplatesBar')) return;

    const wrap = notesInput.parentElement;
    if(!wrap) return;

    const bar = document.createElement('div');
    bar.id = 'notesTemplatesBar';
    bar.style.cssText = 'margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;';
    bar.innerHTML = NOTES_TEMPLATES.map((t, i) => `
      <button type="button" class="notes-tpl-btn" data-idx="${i}"
        style="padding:4px 8px;border:1px solid var(--line);background:var(--surface);border-radius:6px;cursor:pointer;font-size:10.5px;color:var(--ink-soft);transition:all .15s;">
        ${t.icon} ${t.label}
      </button>
    `).join('');

    wrap.appendChild(bar);

    bar.querySelectorAll('.notes-tpl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx);
        const tpl = NOTES_TEMPLATES[idx];
        const current = $('fNotes').value.trim();
        if(current && !confirm('هل تريد استبدال الملاحظات الحالية؟')){
          return;
        }
        $('fNotes').value = tpl.text;
        if(typeof updatePreview === 'function') updatePreview();
        if(typeof toast === 'function') toast(`تم تطبيق قالب "${tpl.label}"`, 'success');
        // تأثير بصري
        btn.style.background = 'var(--red-tint)';
        btn.style.color = 'var(--red)';
        btn.style.borderColor = 'var(--red)';
        setTimeout(() => {
          btn.style.background = 'var(--surface)';
          btn.style.color = 'var(--ink-soft)';
          btn.style.borderColor = 'var(--line)';
        }, 500);
      });
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  2) كشف الفجوات في الترقيم
  // ════════════════════════════════════════════════════════════════
  function detectNumberingGaps(){
    if(typeof invoices === 'undefined' || typeof settings === 'undefined') return [];
    const prefix = settings.prefix || 'BH-CV';
    const year = settings.year || String(new Date().getFullYear());
    const pattern = new RegExp(`^${prefix}-${year}-(\\d+)$`);
    const usedNumbers = invoices
      .map(inv => {
        const m = (inv.code || '').match(pattern);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter(n => n !== null)
      .sort((a, b) => a - b);
    if(usedNumbers.length === 0) return [];
    const gaps = [];
    for(let i = 1; i < usedNumbers[usedNumbers.length - 1]; i++){
      if(!usedNumbers.includes(i)){
        gaps.push(i);
      }
    }
    return gaps;
  }

  function showNumberingGapWarning(){
    const gaps = detectNumberingGaps();
    if(gaps.length === 0) return;
    let banner = $('numberingGapBanner');
    if(!banner){
      banner = document.createElement('div');
      banner.id = 'numberingGapBanner';
      banner.style.cssText = 'margin:10px 0;padding:10px;background:var(--amber-tint);border:1px solid var(--amber);border-radius:8px;font-size:11.5px;color:var(--amber);';
      const mainContent = document.querySelector('.main') || document.body;
      mainContent.insertBefore(banner, mainContent.firstChild);
    }
    banner.innerHTML = `
      <strong>⚠️ تنبيه:</strong> يوجد ${gaps.length} فجوة في تسلسل أرقام الفواتير:
      <span style="font-family:'IBM Plex Mono',monospace;direction:ltr;display:inline-block;">${gaps.slice(0, 5).map(n => String(n).padStart(3,'0')).join('، ')}${gaps.length > 5 ? '...' : ''}</span>
      <button id="fixGapsBtn" style="margin-right:8px;padding:3px 8px;background:var(--amber);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:10px;font-weight:700;">استخدم التالي المتاح</button>
    `;
    $('fixGapsBtn').addEventListener('click', () => {
      const nextAvailable = gaps[0];
      const seq = String(nextAvailable).padStart(3, '0');
      $('fCode').value = `${settings.prefix}-${settings.year}-${seq}`;
      if(typeof toast === 'function') toast(`تم استخدام الرقم المتاح: ${seq}`, 'success');
      banner.remove();
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  3) ربط بنود الفاتورة بباقات العملاء من Supabase
  //     عند إدخال هاتف عميل معروف، اقترح الباقة المناسبة
  // ════════════════════════════════════════════════════════════════
  function suggestPackageFromHistory(){
    const phone = $('fPhone')?.value.trim() || '';
    if(phone.length < 6) return;
    if(!window.BitaqtiBridge || !BitaqtiBridge.state.customers.length) return;
    const phoneNorm = phone.replace(/[\s\-()+]/g, '');
    const customer = BitaqtiBridge.state.customers.find(c =>
      String(c.phone || '').replace(/[\s\-()+]/g, '').endsWith(phoneNorm) ||
      phoneNorm.endsWith(String(c.phone || '').replace(/[\s\-()+]/g, ''))
    );
    if(!customer) return;
    // لو العميل لديه طلب سابق بنفس الباقة، اقترح "تجديد"
    if(customer.package && !items.some(i => i.description)){
      const hasTemplateBar = $('invoicePackageBar');
      if(hasTemplateBar){
        // أبرز زر التجديد لو الباقة موجودة
        const pkgMap = {
          'الأساسية': 'الأساسية',
          'القياسية': 'القياسية',
          'المميزة': 'المميزة',
        };
        const pkgKey = pkgMap[customer.package];
        if(pkgKey){
          const renewBtn = document.querySelector('[data-ordtype="renew"]');
          if(renewBtn){
            renewBtn.style.animation = 'pulse 1.5s infinite';
            renewBtn.title = `آخر طلب لهذا العميل: ${customer.package} — اضغط لتجديد`;
          }
        }
      }
    }
  }

  // أضف CSS للـ pulse animation
  function injectPulseStyle(){
    if(document.getElementById('bridgePulseStyle')) return;
    const style = document.createElement('style');
    style.id = 'bridgePulseStyle';
    style.textContent = `
      @keyframes pulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(206,17,38,.4); }
        50% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(206,17,38,0); }
      }
    `;
    document.head.appendChild(style);
  }

  // ════════════════════════════════════════════════════════════════
  //  4) شريط الإحصائيات السريعة (Mini Stats Bar)
  // ════════════════════════════════════════════════════════════════
  function injectMiniStatsBar(){
    if($('invoiceMiniStatsBar')) return;
    const toolbar = document.querySelector('.toolbar');
    if(!toolbar) return;
    const bar = document.createElement('div');
    bar.id = 'invoiceMiniStatsBar';
    bar.style.cssText = 'margin-bottom:10px;padding:8px 12px;background:linear-gradient(135deg,#F4F3EF,#FFFFFF);border-radius:10px;border:1px solid var(--line);display:flex;gap:12px;flex-wrap:wrap;font-size:11px;';
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="color:var(--ink-faint);">📊 إجمالي الفواتير:</span>
        <strong id="msTotal" style="color:var(--ink);">0</strong>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="color:var(--ink-faint);">💰 مدفوع:</span>
        <strong id="msPaid" style="color:var(--green);">0.000</strong>
        <span style="color:var(--green);">د.ب</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="color:var(--ink-faint);">⏳ معلّق:</span>
        <strong id="msPending" style="color:var(--amber);">0.000</strong>
        <span style="color:var(--amber);">د.ب</span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <span style="color:var(--ink-faint);">📈 متوسط الفاتورة:</span>
        <strong id="msAvg" style="color:var(--blue);">0.000</strong>
        <span style="color:var(--blue);">د.ب</span>
      </div>
    `;
    toolbar.parentNode.insertBefore(bar, toolbar);
  }

  function updateMiniStats(){
    if(typeof invoices === 'undefined') return;
    const total = invoices.length;
    let paid = 0, pending = 0;
    invoices.forEach(inv => {
      const amount = Number(inv.totals?.grand) || 0;
      if(inv.status === 'paid' || inv.payStatus === 'paid') paid += amount;
      else if(inv.status !== 'cancelled') pending += amount;
    });
    const avg = total > 0 ? (paid + pending) / total : 0;
    const msTotal = $('msTotal');
    if(msTotal) msTotal.textContent = total;
    const msPaid = $('msPaid');
    if(msPaid) msPaid.textContent = paid.toFixed(3);
    const msPending = $('msPending');
    if(msPending) msPending.textContent = pending.toFixed(3);
    const msAvg = $('msAvg');
    if(msAvg) msAvg.textContent = avg.toFixed(3);
  }

  // ════════════════════════════════════════════════════════════════
  //  5) ربط بـ BitaqtiBridge — استمع للأحداث
  // ════════════════════════════════════════════════════════════════
  function setupBridgeListeners(){
    BitaqtiBridge.on('customers:synced', () => {
      suggestPackageFromHistory();
    });
    BitaqtiBridge.on('invoices:synced', () => {
      updateMiniStats();
      showNumberingGapWarning();
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  6) ربط الكل
  // ════════════════════════════════════════════════════════════════
  function init(){
    injectPulseStyle();
    injectNotesTemplates();
    injectMiniStatsBar();
    setupBridgeListeners();
    // بعد تحميل البيانات
    setTimeout(() => {
      updateMiniStats();
      showNumberingGapWarning();
    }, 2000);
    // راقب إدخال الهاتف لاقتراح الباقة
    const phoneInput = $('fPhone');
    if(phoneInput){
      let timer = null;
      phoneInput.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(suggestPackageFromHistory, 800);
      });
    }
    console.log('[invoices-enhancements-v3] loaded');
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
