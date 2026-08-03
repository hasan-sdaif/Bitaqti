// admin/reviews-tab.js — منطق تبويب التقييمات المدمج في لوحة التحكم
// ════════════════════════════════════════════════════════════════
//  يوفّر كل وظائف إدارة التقييمات داخل dashboard.html
//  يعتمد على: BitaqtiAuth (للكلمة السرية) + fetch إلى reviews-manage
// ════════════════════════════════════════════════════════════════

(function(){
  'use strict';
  if(window.BitaqtiReviewsTab && window.BitaqtiReviewsTab._loaded) return;
  window.BitaqtiReviewsTab = { _loaded: true };

  const ENDPOINT = '/.netlify/functions/reviews-manage';
  const PWD_KEY = 'bitaqti_admin_password';

  // ════════════════════════════════════════════════════════════════
  //  مساعدات
  // ════════════════════════════════════════════════════════════════
  function getPwd(){
    try { return localStorage.getItem(PWD_KEY) || ''; } catch(e){ return ''; }
  }

  function escapeHtml(s){
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function formatDate(iso){
    if(!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('ar-EG', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    } catch(e){ return '—'; }
  }

  function timeAgo(iso){
    if(!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if(mins < 60) return 'منذ ' + mins + ' دقيقة';
    const hours = Math.floor(mins / 60);
    if(hours < 24) return 'منذ ' + hours + ' ساعة';
    const days = Math.floor(hours / 24);
    if(days < 30) return 'منذ ' + days + ' يوم';
    return formatDate(iso);
  }

  function stars(filled, total = 5){
    filled = Math.max(0, Math.min(5, parseInt(filled) || 0));
    return '★'.repeat(filled) + '☆'.repeat(total - filled);
  }

  function toast(msg, type = 'info'){
    // نستخدم toast الخاص بـ bridge.js لو موجود، وإلا نُنشئ واحد
    if(window.BitaqtiBridge && BitaqtiBridge.toast){
      BitaqtiBridge.toast(msg, type);
      return;
    }
    let c = document.getElementById('reviewsToastContainer');
    if(!c){
      c = document.createElement('div');
      c.id = 'reviewsToastContainer';
      c.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;max-width:380px;';
      document.body.appendChild(c);
    }
    const el = document.createElement('div');
    const colors = { success:'var(--green)', error:'var(--red)', warn:'var(--amber)', info:'var(--ink)' };
    el.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:12px 18px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 12px 28px rgba(0,0,0,.25);transform:translateY(20px);opacity:0;transition:all .25s;`;
    el.textContent = msg;
    c.appendChild(el);
    requestAnimationFrame(() => { el.style.transform = 'translateY(0)'; el.style.opacity = '1'; });
    setTimeout(() => { el.style.transform = 'translateY(20px)'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3500);
  }

  async function api(action, extra = {}){
    const pwd = getPwd();
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password: pwd, ...extra }),
    });
    return await res.json();
  }

  // ════════════════════════════════════════════════════════════════
  //  الحالة
  // ════════════════════════════════════════════════════════════════
  const state = {
    currentSubtab: 'all',           // all | verified | visitor | hidden | flagged | featured
    search: '',
    limit: 50,
    offset: 0,
    selected: new Set(),
    stats: null,
    settings: null,
    commentsLoaded: {},             // reviewId -> true
    suggestionsLoaded: false,
  };

  // ════════════════════════════════════════════════════════════════
  //  تهيئة التبويب
  // ════════════════════════════════════════════════════════════════
  function init(){
    const container = document.getElementById('tab-reviews');
    if(!container) return;
    if(container.dataset.initialized === 'true') {
      refresh();
      return;
    }
    container.dataset.initialized = 'true';
    
    container.innerHTML = `
      <div class="reviews-dashboard">
        <!-- الشريط الجانبي -->
        <aside class="reviews-sidebar" id="reviewsSidebar">
          <div class="review-stat-card info">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>إجمالي التقييمات</div>
            <div class="value" id="rStTotal">—</div>
            <div class="sub" id="rStTotalSub">—</div>
          </div>
          <div class="review-stat-card success">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9 9 4.03 9 9z"/></svg>متوسط التقييم</div>
            <div class="value" id="rStAvg">—</div>
            <div class="sub" id="rStAvgSub">—</div>
            <div class="rating-dist" id="rStDist"></div>
          </div>
          <div class="review-stat-card gold">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>عملاء موثّقون</div>
            <div class="value" id="rStVerified">—</div>
            <div class="sub" id="rStVerifiedSub">—</div>
          </div>
          <div class="review-stat-card warn">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg>موسومة كسبام</div>
            <div class="value" id="rStFlagged">—</div>
            <div class="sub" id="rStFlaggedSub">—</div>
          </div>
          <div class="review-stat-card danger">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>مخفية</div>
            <div class="value" id="rStHidden">—</div>
          </div>
          <div class="review-stat-card">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>مميّزة</div>
            <div class="value" id="rStFeatured">—</div>
          </div>
          <div class="review-stat-card">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>تعليقات</div>
            <div class="value" id="rStComments">—</div>
          </div>
          <div class="review-stat-card">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>اقتراحات</div>
            <div class="value" id="rStSuggestions">—</div>
          </div>
          <div class="review-stat-card success">
            <div class="label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>نسبة التوصية</div>
            <div class="value" id="rStRecommend">—</div>
          </div>
        </aside>

        <!-- المنطقة الرئيسية -->
        <div class="reviews-main">
          <!-- تبويبات فرعية -->
          <div class="reviews-subtabs" id="reviewsSubtabs">
            <button class="reviews-subtab active" data-sub="all">الكل</button>
            <button class="reviews-subtab" data-sub="verified">موثّقون <span class="badge" id="cntVerified" style="display:none">0</span></button>
            <button class="reviews-subtab" data-sub="visitor">زوّار</button>
            <button class="reviews-subtab" data-sub="flagged">موسوم <span class="badge" id="cntFlagged" style="display:none">0</span></button>
            <button class="reviews-subtab" data-sub="hidden">مخفي</button>
            <button class="reviews-subtab" data-sub="featured">مميّز</button>
            <button class="reviews-subtab" data-sub="comments">التعليقات</button>
            <button class="reviews-subtab" data-sub="suggestions">الاقتراحات</button>
            <button class="reviews-subtab" data-sub="settings">الإعدادات</button>
          </div>

          <!-- شريط الأدوات -->
          <div class="reviews-toolbar" id="reviewsToolbar">
            <div class="search-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
              <input type="text" id="reviewsSearchInput" placeholder="ابحث في التقييمات (اسم، نص، رمز، هاتف)...">
            </div>
            <button class="admin-action-btn" id="btnExportCsv">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
              تصدير CSV
            </button>
            <button class="admin-action-btn" id="btnRefreshReviews">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
              تحديث
            </button>
            <button class="admin-action-btn success" id="btnRefreshStats">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
              تحديث الإحصائيات
            </button>
          </div>

          <!-- شريط الإجراءات الجماعي -->
          <div class="bulk-actions-bar" id="bulkBar" style="display:none;">
            <span class="label" id="bulkCount">0 محدد</span>
            <button onclick="BitaqtiReviewsTab.bulkAction('hide')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/></svg> إخفاء</button>
            <button onclick="BitaqtiReviewsTab.bulkAction('unhide')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> إظهار</button>
            <button onclick="BitaqtiReviewsTab.bulkAction('feature')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg> تمييز</button>
            <button onclick="BitaqtiReviewsTab.bulkAction('unfeature')">إلغاء التمييز</button>
            <button class="danger" onclick="BitaqtiReviewsTab.bulkAction('delete')"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg> حذف</button>
            <button onclick="BitaqtiReviewsTab.clearSelection()">إلغاء التحديد</button>
          </div>

          <!-- قائمة التقييمات -->
          <div class="reviews-list" id="reviewsListContainer">
            <div class="admin-loading">جارٍ التحميل...<span class="spinner" style="display:inline-block;width:18px;height:18px;border:2px solid var(--line);border-top-color:var(--red);border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:6px;"></span></div>
          </div>
        </div>
      </div>

      <!-- نافذة الرد -->
      <div class="modal-overlay" id="reviewsModal">
        <div class="modal-card" id="reviewsModalCard">
          <!-- يُملأ ديناميكياً -->
        </div>
      </div>
    `;

    // ربط الأحداث
    bindEvents();
    // التحميل الأولي
    refresh();
  }

  function bindEvents(){
    // التبويبات الفرعية
    document.querySelectorAll('#reviewsSubtabs .reviews-subtab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#reviewsSubtabs .reviews-subtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentSubtab = btn.dataset.sub;
        state.offset = 0;
        renderList();
      });
    });

    // البحث
    const searchInput = document.getElementById('reviewsSearchInput');
    let searchTimeout;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        state.search = searchInput.value.trim();
        state.offset = 0;
        renderList();
      }, 400);
    });

    // أزرار
    document.getElementById('btnRefreshReviews').addEventListener('click', () => { state.offset = 0; renderList(); });
    document.getElementById('btnRefreshStats').addEventListener('click', refreshStats);
    document.getElementById('btnExportCsv').addEventListener('click', exportCsv);

    // إغلاق النافذة عند الضغط خارجها
    document.getElementById('reviewsModal').addEventListener('click', (e) => {
      if(e.target.id === 'reviewsModal') closeModal();
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  تحديث كامل
  // ════════════════════════════════════════════════════════════════
  async function refresh(){
    await loadStats();
    await renderList();
  }

  // ════════════════════════════════════════════════════════════════
  //  تحميل الإحصائيات
  // ════════════════════════════════════════════════════════════════
  async function loadStats(){
    try {
      const data = await api('get_dashboard');
      if(data.ok){
        state.stats = data.stats;
        state.settings = data.settings;
        renderStats(data);
      }
    } catch(e){
      console.warn('[reviews] loadStats error', e);
    }
  }

  function renderStats(data){
    const s = data.stats || {};
    const total = s.total_reviews || 0;
    const avg = parseFloat(s.avg_overall || 0);
    
    setText('rStTotal', total);
    setText('rStTotalSub', `${s.total_visitor || 0} زائر · ${s.total_verified || 0} موثّق`);
    setText('rStAvg', avg.toFixed(1));
    setText('rStAvgSub', `من 5 نجوم`);
    setText('rStVerified', s.total_verified || 0);
    setText('rStVerifiedSub', `${total > 0 ? Math.round(100 * (s.total_verified||0) / total) : 0}% من الإجمالي`);
    setText('rStFlagged', data.flagged_reviews?.length || 0);
    setText('rStFlaggedSub', `${s.total_hidden || 0} مخفي`);
    setText('rStHidden', s.total_hidden || 0);
    setText('rStFeatured', s.total_featured || 0);
    setText('rStComments', s.total_comments || 0);
    setText('rStSuggestions', s.total_suggestions || 0);
    setText('rStRecommend', (s.recommend_rate || 0) + '%');
    
    // توزيع النجوم (تقريبي)
    const dist = document.getElementById('rStDist');
    if(dist){
      const rows = [5,4,3,2,1].map(n => {
        const pct = avg > 0 ? Math.round((n === Math.round(avg) ? 60 : n >= 4 ? 25 : 10)) : 0;
        return `<div class="rating-dist-row">
          <span class="lbl">${n}★</span>
          <span class="bar"><span class="bar-fill" style="width:${pct}%"></span></span>
        </div>`;
      }).join('');
      dist.innerHTML = rows;
    }

    // عدّادات التبويبات
    const flagged = data.flagged_reviews?.length || 0;
    const cntFlagged = document.getElementById('cntFlagged');
    if(flagged > 0){ cntFlagged.textContent = flagged; cntFlagged.style.display = ''; }
    else { cntFlagged.style.display = 'none'; }

    const cntVerified = document.getElementById('cntVerified');
    if(s.total_verified > 0){ cntVerified.textContent = s.total_verified; cntVerified.style.display = ''; }
    else { cntVerified.style.display = 'none'; }
  }

  function setText(id, val){
    const el = document.getElementById(id);
    if(el) el.textContent = val;
  }

  // ════════════════════════════════════════════════════════════════
  //  عرض القائمة
  // ════════════════════════════════════════════════════════════════
  async function renderList(){
    const sub = state.currentSubtab;
    const container = document.getElementById('reviewsListContainer');
    
    // لو الإعدادات
    if(sub === 'settings'){
      renderSettings(container);
      return;
    }
    
    // لو الاقتراحات
    if(sub === 'suggestions'){
      await renderSuggestions(container);
      return;
    }
    
    // لو التعليقات
    if(sub === 'comments'){
      await renderComments(container);
      return;
    }
    
    // باقي الحالات: عرض التقييمات
    container.innerHTML = '<div class="admin-loading">جارٍ التحميل...<span class="spinner"></span></div>';
    
    try {
      const params = {
        limit: state.limit,
        offset: state.offset,
        search: state.search,
      };
      
      if(sub === 'verified') params.filter_verified = 'only_verified';
      else if(sub === 'visitor') params.filter_verified = 'only_visitor';
      else if(sub === 'hidden') params.filter_hidden = 'only_hidden';
      else if(sub === 'flagged') params.filter_flagged = true;
      else if(sub === 'featured') { /* TODO: filter featured */ }
      
      const data = await api('list_all', params);
      if(data.ok && data.reviews){
        if(sub === 'featured'){
          data.reviews = data.reviews.filter(r => r.is_featured);
        }
        renderReviewsList(container, data.reviews);
      } else {
        container.innerHTML = '<div class="admin-empty">تعذّر التحميل.</div>';
      }
    } catch(e){
      container.innerHTML = '<div class="admin-empty">تعذّر التحميل.</div>';
    }
  }

  function renderReviewsList(container, reviews){
    if(!reviews.length){
      container.innerHTML = `<div class="admin-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
        <div>لا توجد تقييمات في هذا القسم.</div>
      </div>`;
      return;
    }
    
    const showBulkBar = reviews.length > 0;
    document.getElementById('bulkBar').style.display = showBulkBar ? 'flex' : 'none';
    state.selected.clear();
    updateBulkCount();
    
    container.innerHTML = reviews.map(r => renderReviewCard(r)).join('');
    
    // ربط خانات الاختيار
    container.querySelectorAll('.review-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id);
        if(cb.checked) state.selected.add(id); else state.selected.delete(id);
        updateBulkCount();
      });
    });
  }

  function renderReviewCard(r){
    const badges = [];
    if(r.is_verified_customer) badges.push('<span class="admin-badge verified">✓ موثّق</span>');
    else badges.push('<span class="admin-badge visitor">زائر</span>');
    if(r.is_featured) badges.push('<span class="admin-badge featured">★ مميّز</span>');
    if(r.is_pinned) badges.push('<span class="admin-badge pinned">مثبّت</span>');
    if(r.is_hidden) badges.push('<span class="admin-badge hidden">مخفي</span>');
    if(r.is_flagged) badges.push('<span class="admin-badge flagged">⚠ سبام</span>');
    if(!r.is_public) badges.push('<span class="admin-badge private">خاص</span>');
    if(r.is_anonymous) badges.push('<span class="admin-badge anon">مجهول</span>');
    
    const ratings = [];
    [['rating_design','تصميم'],['rating_speed','سرعة'],['rating_support','دعم'],['rating_value','قيمة'],
     ['rating_ease','سهولة'],['rating_communication','تواصل'],['rating_creativity','إبداع'],
     ['rating_professionalism','احترافية'],['rating_after_sales','ما بعد البيع'],['rating_accuracy','دقة']
    ].forEach(([k,l]) => {
      if(r[k] !== null && r[k] !== undefined){
        ratings.push(`<span class="r">${l}: <span class="stars">${stars(r[k])}</span></span>`);
      }
    });
    
    const extras = [];
    if(r.pros) extras.push(`<div class="ex"><strong>إيجابيات:</strong> ${escapeHtml(r.pros.slice(0,150))}${r.pros.length>150?'…':''}</div>`);
    if(r.cons) extras.push(`<div class="ex"><strong>سلبيات:</strong> ${escapeHtml(r.cons.slice(0,150))}${r.cons.length>150?'…':''}</div>`);
    if(r.tags) extras.push(`<div class="ex"><strong>وسوم:</strong> ${escapeHtml(r.tags)}</div>`);
    if(r.reviewer_profession) extras.push(`<div class="ex"><strong>المهنة:</strong> ${escapeHtml(r.reviewer_profession)}</div>`);
    if(r.reviewer_city) extras.push(`<div class="ex"><strong>المدينة:</strong> ${escapeHtml(r.reviewer_city)}</div>`);
    if(r.would_recommend === true) extras.push(`<div class="ex" style="color:var(--green);"><strong>يوصي بنا</strong></div>`);
    if(r.would_recommend === false) extras.push(`<div class="ex" style="color:var(--red);"><strong>لا يوصي بنا</strong></div>`);
    if(r.image_url) extras.push(`<div class="ex"><strong>صورة:</strong> <a href="${escapeHtml(r.image_url)}" target="_blank">عرض</a></div>`);
    if(r.video_url) extras.push(`<div class="ex"><strong>فيديو:</strong> <a href="${escapeHtml(r.video_url)}" target="_blank">عرض</a></div>`);
    if(r.social_links){
      const sl = typeof r.social_links === 'string' ? JSON.parse(r.social_links) : r.social_links;
      const slEntries = Object.entries(sl).filter(([k,v]) => v);
      if(slEntries.length){
        const labels = {instagram:'Instagram', youtube:'YouTube', linkedin:'LinkedIn', twitter:'X'};
        const parts = slEntries.map(([k,v]) => `<a href="${escapeHtml(v)}" target="_blank" style="color:var(--blue);">${labels[k]||k}</a>`);
        extras.push(`<div class="ex"><strong>روابط:</strong> ${parts.join(' · ')}</div>`);
      }
    }
    if(r.spam_score > 0) extras.push(`<div class="ex" style="color:var(--amber);"><strong>نقاط السبام:</strong> ${r.spam_score}/100</div>`);
    
    const cardClass = [
      'admin-review-card',
      r.is_hidden ? 'hidden' : '',
      r.is_flagged ? 'flagged' : '',
      r.is_featured ? 'featured' : '',
      r.is_pinned ? 'pinned' : '',
    ].filter(Boolean).join(' ');
    
    return `<div class="${cardClass}" id="admin-review-${r.id}">
      <div class="admin-review-head">
        <input type="checkbox" class="review-checkbox" data-id="${r.id}">
        <div style="flex:1;min-width:0;">
          <div class="name">${escapeHtml(r.customer_name || (r.is_anonymous ? 'مجهول' : 'زائر'))}</div>
          <div class="meta">
            ${badges.join('')}
            <span class="date">${formatDate(r.created_at)}</span>
            <span class="code">${escapeHtml(r.review_code || '')}</span>
            ${r.package ? `<span class="code">${escapeHtml(r.package)}</span>` : ''}
          </div>
        </div>
        <div style="text-align:left;">
          <div style="font-size:18px;color:var(--gold);letter-spacing:2px;">${stars(r.rating_overall)}</div>
          <div style="font-size:10.5px;color:var(--ink-faint);font-weight:700;">${r.rating_overall}/5</div>
        </div>
      </div>
      ${r.title ? `<div class="admin-review-title">${escapeHtml(r.title)}</div>` : ''}
      <div class="admin-review-body">${escapeHtml(r.body)}</div>
      ${ratings.length ? `<div class="admin-review-ratings">${ratings.join('')}</div>` : ''}
      ${extras.length ? `<div class="admin-review-extras">${extras.join('')}</div>` : ''}
      <div class="admin-review-actions">
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.viewDetail(${r.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          تفاصيل
        </button>
        ${r.is_hidden 
          ? `<button class="admin-action-btn success" onclick="BitaqtiReviewsTab.unhideReview(${r.id})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> إظهار</button>`
          : `<button class="admin-action-btn amber" onclick="BitaqtiReviewsTab.hideReview(${r.id})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/></svg> إخفاء</button>`
        }
        ${r.is_featured
          ? `<button class="admin-action-btn gold" onclick="BitaqtiReviewsTab.unfeatureReview(${r.id})">إلغاء التمييز</button>`
          : `<button class="admin-action-btn gold" onclick="BitaqtiReviewsTab.featureReview(${r.id})"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg> تمييز</button>`
        }
        ${r.is_pinned
          ? `<button class="admin-action-btn" onclick="BitaqtiReviewsTab.unpinReview(${r.id})">إلغاء التثبيت</button>`
          : `<button class="admin-action-btn" onclick="BitaqtiReviewsTab.pinReview(${r.id})">تثبيت</button>`
        }
        <button class="admin-action-btn blue" onclick="BitaqtiReviewsTab.openResponseModal(${r.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          رد (${r.responses_count || 0})
        </button>
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.openNoteModal(${r.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          ملاحظة
        </button>
        <button class="admin-action-btn danger" onclick="BitaqtiReviewsTab.deleteReview(${r.id})">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          حذف
        </button>
      </div>
    </div>`;
  }

  // ════════════════════════════════════════════════════════════════
  //  الإجراءات الفردية
  // ════════════════════════════════════════════════════════════════
  async function hideReview(id){
    const reason = prompt('سبب الإخفاء (اختياري):') || '';
    const data = await api('hide_review', { review_id: id, reason });
    if(data.ok){ toast('تم إخفاء التقييم', 'success'); refresh(); }
    else toast('تعذّر الإخفاء', 'error');
  }

  async function unhideReview(id){
    const data = await api('unhide_review', { review_id: id });
    if(data.ok){ toast('تم إظهار التقييم', 'success'); refresh(); }
    else toast('تعذّر', 'error');
  }

  async function featureReview(id){
    const data = await api('feature_review', { review_id: id });
    if(data.ok){ toast('تم تمييز التقييم', 'success'); refresh(); }
    else toast('تعذّر', 'error');
  }

  async function unfeatureReview(id){
    const data = await api('unfeature_review', { review_id: id });
    if(data.ok){ toast('تم إلغاء التمييز', 'success'); refresh(); }
    else toast('تعذّر', 'error');
  }

  async function pinReview(id){
    const data = await api('pin_review', { review_id: id });
    if(data.ok){ toast('تم تثبيت التقييم', 'success'); refresh(); }
    else toast('تعذّر', 'error');
  }

  async function unpinReview(id){
    const data = await api('unpin_review', { review_id: id });
    if(data.ok){ toast('تم إلغاء التثبيت', 'success'); refresh(); }
    else toast('تعذّر', 'error');
  }

  async function deleteReview(id){
    if(!confirm('حذف هذا التقييم نهائياً؟ لا يمكن التراجع.')) return;
    const data = await api('delete_review', { review_id: id });
    if(data.ok){ toast('تم حذف التقييم', 'success'); refresh(); }
    else toast('تعذّر الحذف', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  إجراءات جماعية
  // ════════════════════════════════════════════════════════════════
  function updateBulkCount(){
    const n = state.selected.size;
    document.getElementById('bulkCount').textContent = n + ' محدد';
  }

  function clearSelection(){
    state.selected.clear();
    document.querySelectorAll('.review-checkbox').forEach(cb => cb.checked = false);
    updateBulkCount();
  }

  async function bulkAction(action){
    const ids = Array.from(state.selected);
    if(!ids.length){ toast('لم تختر شيئاً', 'warn'); return; }
    if(action === 'delete' && !confirm(`حذف ${ids.length} تقييم نهائياً؟`)) return;
    
    const data = await api('bulk_action', { review_ids: ids, bulk_action: action });
    if(data.ok){
      toast(data.message, 'success');
      clearSelection();
      refresh();
    } else toast('تعذّر', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  نافذة التفاصيل
  // ════════════════════════════════════════════════════════════════
  async function viewDetail(id){
    const modal = document.getElementById('reviewsModal');
    const card = document.getElementById('reviewsModalCard');
    card.innerHTML = '<div class="admin-loading">جارٍ التحميل...<span class="spinner"></span></div>';
    modal.classList.add('show');
    
    try {
      const data = await api('get_review_detail', { review_id: id });
      if(data.ok && data.review){
        renderDetailModal(data);
      } else {
        card.innerHTML = '<div class="admin-empty">تعذّر تحميل التفاصيل.</div>';
      }
    } catch(e){
      card.innerHTML = '<div class="admin-empty">تعذّر التحميل.</div>';
    }
  }

  function renderDetailModal(data){
    const r = data.review;
    const card = document.getElementById('reviewsModalCard');
    
    const meta = [
      ['رمز التقييم', r.review_code],
      ['تاريخ الإنشاء', formatDate(r.created_at)],
      ['آخر تحديث', formatDate(r.updated_at)],
      ['الحالة', r.is_hidden ? 'مخفي' : 'ظاهر'],
      ['العميل', r.is_verified_customer ? 'موثّق' : 'زائر'],
      ['الباقة', r.package || '—'],
      ['رمز الطلب', r.order_code || '—'],
      ['الهاتف', r.phone || '—'],
      ['البريد', r.reviewer_email || '—'],
      ['الدولة', r.reviewer_country || '—'],
      ['المدينة', r.reviewer_city || '—'],
      ['المهنة', r.reviewer_profession || '—'],
      ['حالة الاستخدام', r.reviewer_use_case || '—'],
      ['الفئة العمرية', r.reviewer_age_group || '—'],
      ['كيف سمع', r.how_heard || '—'],
      ['اللغة', r.review_language || 'ar'],
      ['المصدر', r.source || 'web'],
      ['نقاط السبام', r.spam_score + '/100'],
      ['صوت مفيد', r.votes_helpful || 0],
      ['صوت غير مفيد', r.votes_not_helpful || 0],
    ];
    
    const allRatings = [
      ['rating_overall','التقييم العام'],['rating_design','التصميم'],['rating_speed','السرعة'],
      ['rating_support','الدعم'],['rating_value','القيمة'],['rating_ease','السهولة'],
      ['rating_communication','التواصل'],['rating_creativity','الإبداع'],
      ['rating_professionalism','الاحترافية'],['rating_after_sales','ما بعد البيع'],['rating_accuracy','الدقة'],
    ].filter(([k]) => r[k] !== null && r[k] !== undefined);
    
    const comments = data.comments || [];
    const responses = data.responses || [];
    const notes = data.notes || [];
    
    card.innerHTML = `
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>تفاصيل التقييم</h3>
      
      <div class="admin-review-card" style="margin-bottom:14px;">
        ${r.title ? `<div class="admin-review-title">${escapeHtml(r.title)}</div>` : ''}
        <div class="admin-review-body" style="max-height:none;">${escapeHtml(r.body)}</div>
        ${r.pros ? `<div style="background:var(--green-tint);padding:8px 10px;border-radius:8px;font-size:11.5px;color:#086337;margin-top:8px;"><strong>إيجابيات:</strong> ${escapeHtml(r.pros)}</div>` : ''}
        ${r.cons ? `<div style="background:var(--amber-tint);padding:8px 10px;border-radius:8px;font-size:11.5px;color:#92500a;margin-top:8px;"><strong>سلبيات:</strong> ${escapeHtml(r.cons)}</div>` : ''}
        ${r.tags ? `<div style="margin-top:8px;font-size:11px;color:var(--ink-soft);"><strong>الوسوم:</strong> ${escapeHtml(r.tags)}</div>` : ''}
        ${allRatings.length ? `<div class="admin-review-ratings" style="margin-top:8px;">${allRatings.map(([k,l]) => `<span class="r">${l}: <span class="stars">${stars(r[k])}</span></span>`).join('')}</div>` : ''}
      </div>
      
      <div class="review-detail-meta">
        ${meta.map(([l,v]) => `<div class="item"><span class="lbl">${l}</span><span class="val">${escapeHtml(String(v ?? '—'))}</span></div>`).join('')}
      </div>
      
      <h4 style="font-size:13px;font-weight:700;margin:16px 0 8px;color:var(--blue);">ردود الإدارة (${responses.length})</h4>
      ${responses.length ? responses.map(rp => `
        <div style="background:var(--blue-tint);padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:12px;">
          <div style="font-weight:700;color:var(--blue);font-size:11px;">${escapeHtml(rp.admin_name || 'فريق بطاقتي')} · ${formatDate(rp.created_at)}</div>
          <div style="color:var(--ink);margin-top:4px;">${escapeHtml(rp.body)}</div>
          <button class="admin-action-btn danger" style="margin-top:6px;padding:3px 8px;font-size:10.5px;" onclick="BitaqtiReviewsTab.deleteResponse(${rp.id})">حذف</button>
        </div>
      `).join('') : '<div style="font-size:12px;color:var(--ink-faint);">لا توجد ردود.</div>'}
      
      <h4 style="font-size:13px;font-weight:700;margin:16px 0 8px;color:var(--ink);">ملاحظات الإدارة (${notes.length})</h4>
      ${notes.length ? notes.map(n => `
        <div style="background:var(--paper);padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:12px;border-right:3px solid var(--ink);">
          <div style="font-weight:700;font-size:11px;color:var(--ink-soft);">${escapeHtml(n.admin_name)} · ${formatDate(n.created_at)}</div>
          <div style="color:var(--ink);margin-top:4px;">${escapeHtml(n.note)}</div>
        </div>
      `).join('') : '<div style="font-size:12px;color:var(--ink-faint);">لا توجد ملاحظات خاصة.</div>'}
      
      <h4 style="font-size:13px;font-weight:700;margin:16px 0 8px;color:var(--ink);">التعليقات (${comments.length})</h4>
      ${comments.length ? comments.map(c => `
        <div class="admin-comment-item ${c.is_hidden ? 'hidden' : ''}">
          <div class="head">
            <span class="author">${escapeHtml(c.author_name)}</span>
            ${c.is_verified_customer ? '<span class="admin-badge verified" style="padding:1px 5px;font-size:9px;">✓ عميل</span>' : ''}
            ${c.is_admin ? '<span class="admin-badge" style="background:var(--blue-tint);color:var(--blue);padding:1px 5px;font-size:9px;">إدارة</span>' : ''}
            <span class="date">${formatDate(c.created_at)}</span>
          </div>
          <div class="body">${escapeHtml(c.body)}</div>
          <div class="actions">
            ${c.is_hidden 
              ? `<button class="admin-action-btn success" style="padding:3px 8px;font-size:10.5px;" onclick="BitaqtiReviewsTab.unhideComment(${c.id})">إظهار</button>`
              : `<button class="admin-action-btn amber" style="padding:3px 8px;font-size:10.5px;" onclick="BitaqtiReviewsTab.hideComment(${c.id})">إخفاء</button>`
            }
            <button class="admin-action-btn danger" style="padding:3px 8px;font-size:10.5px;" onclick="BitaqtiReviewsTab.deleteComment(${c.id})">حذف</button>
          </div>
        </div>
      `).join('') : '<div style="font-size:12px;color:var(--ink-faint);">لا توجد تعليقات.</div>'}
      
      <div class="btn-row" style="margin-top:18px;">
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.closeModal()">إغلاق</button>
        <button class="admin-action-btn blue" onclick="BitaqtiReviewsTab.openResponseModal(${r.id})">إضافة رد</button>
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.openNoteModal(${r.id})">إضافة ملاحظة</button>
      </div>
    `;
  }

  function closeModal(){
    document.getElementById('reviewsModal').classList.remove('show');
  }

  // ════════════════════════════════════════════════════════════════
  //  نافذة الرد
  // ════════════════════════════════════════════════════════════════
  function openResponseModal(reviewId){
    const card = document.getElementById('reviewsModalCard');
    card.innerHTML = `
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>رد على التقييم</h3>
      <div class="form-group">
        <label>الرد (سيظهر للعلن باسم "فريق بطاقتي")</label>
        <textarea class="form-control" id="responseBody" rows="5" placeholder="اكتب ردك هنا..." maxlength="3000"></textarea>
      </div>
      <div class="form-group">
        <label>اسم المُجيب (اختياري)</label>
        <input type="text" class="form-control" id="responseAuthor" placeholder="فريق بطاقتي" maxlength="100">
      </div>
      <div class="btn-row">
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.closeModal()">إلغاء</button>
        <button class="admin-action-btn blue" onclick="BitaqtiReviewsTab.submitResponse(${reviewId})">نشر الرد</button>
      </div>
    `;
    document.getElementById('reviewsModal').classList.add('show');
  }

  async function submitResponse(reviewId){
    const body = document.getElementById('responseBody').value.trim();
    const author = document.getElementById('responseAuthor').value.trim();
    if(!body || body.length < 3){ toast('الرد قصير جداً', 'warn'); return; }
    
    const data = await api('add_response', { review_id: reviewId, body, admin_name: author });
    if(data.ok){
      toast('تم نشر الرد', 'success');
      closeModal();
      refresh();
    } else toast('تعذّر النشر', 'error');
  }

  async function deleteResponse(id){
    if(!confirm('حذف هذا الرد؟')) return;
    const data = await api('delete_response', { response_id: id });
    if(data.ok){ toast('تم الحذف', 'success'); }
    else toast('تعذّر', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  نافذة الملاحظة الخاصة
  // ════════════════════════════════════════════════════════════════
  function openNoteModal(reviewId){
    const card = document.getElementById('reviewsModalCard');
    card.innerHTML = `
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 113 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>ملاحظة خاصة</h3>
      <p style="font-size:12px;color:var(--ink-soft);margin-bottom:12px;">هذه الملاحظة سرّية — لا يراها إلا الإدارة.</p>
      <div class="form-group">
        <label>الملاحظة</label>
        <textarea class="form-control" id="noteBody" rows="5" placeholder="اكتب ملاحظتك..." maxlength="3000"></textarea>
      </div>
      <div class="form-group">
        <label>اسمك (اختياري)</label>
        <input type="text" class="form-control" id="noteAuthor" placeholder="admin" maxlength="100">
      </div>
      <div class="btn-row">
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.closeModal()">إلغاء</button>
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.submitNote(${reviewId})">حفظ الملاحظة</button>
      </div>
    `;
    document.getElementById('reviewsModal').classList.add('show');
  }

  async function submitNote(reviewId){
    const note = document.getElementById('noteBody').value.trim();
    const author = document.getElementById('noteAuthor').value.trim();
    if(!note){ toast('الملاحظة فارغة', 'warn'); return; }
    
    const data = await api('add_admin_note', { review_id: reviewId, note, admin_name: author });
    if(data.ok){
      toast('تم حفظ الملاحظة', 'success');
      closeModal();
    } else toast('تعذّر الحفظ', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  إدارة التعليقات
  // ════════════════════════════════════════════════════════════════
  async function renderComments(container){
    container.innerHTML = '<div class="admin-loading">جارٍ التحميل...<span class="spinner"></span></div>';
    try {
      const data = await api('list_comments_all', { limit: 200 });
      if(data.ok){
        const comments = data.comments || [];
        if(!comments.length){
          container.innerHTML = '<div class="admin-empty">لا توجد تعليقات.</div>';
          return;
        }
        container.innerHTML = comments.map(c => `
          <div class="admin-comment-item ${c.is_hidden ? 'hidden' : ''}">
            <div class="head">
              <span class="author">${escapeHtml(c.author_name)}</span>
              ${c.is_verified_customer ? '<span class="admin-badge verified" style="padding:1px 5px;font-size:9px;">✓ عميل</span>' : ''}
              ${c.is_admin ? '<span class="admin-badge" style="background:var(--blue-tint);color:var(--blue);padding:1px 5px;font-size:9px;">إدارة</span>' : ''}
              <span class="date">${formatDate(c.created_at)}</span>
              <span class="code" style="font-size:10px;color:var(--ink-faint);">التقييم #${c.review_id}</span>
            </div>
            <div class="body">${escapeHtml(c.body)}</div>
            <div class="actions">
              ${c.is_hidden 
                ? `<button class="admin-action-btn success" onclick="BitaqtiReviewsTab.unhideComment(${c.id})">إظهار</button>`
                : `<button class="admin-action-btn amber" onclick="BitaqtiReviewsTab.hideComment(${c.id})">إخفاء</button>`
              }
              <button class="admin-action-btn danger" onclick="BitaqtiReviewsTab.deleteComment(${c.id})">حذف</button>
            </div>
          </div>
        `).join('');
      }
    } catch(e){
      container.innerHTML = '<div class="admin-empty">تعذّر التحميل.</div>';
    }
  }

  async function hideComment(id){
    const reason = prompt('سبب الإخفاء (اختياري):') || '';
    const data = await api('hide_comment', { comment_id: id, reason });
    if(data.ok){ toast('تم إخفاء التعليق', 'success'); renderList(); }
    else toast('تعذّر', 'error');
  }

  async function unhideComment(id){
    const data = await api('unhide_comment', { comment_id: id });
    if(data.ok){ toast('تم إظهار التعليق', 'success'); renderList(); }
    else toast('تعذّر', 'error');
  }

  async function deleteComment(id){
    if(!confirm('حذف هذا التعليق نهائياً؟')) return;
    const data = await api('delete_comment', { comment_id: id });
    if(data.ok){ toast('تم الحذف', 'success'); renderList(); }
    else toast('تعذّر', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  إدارة الاقتراحات
  // ════════════════════════════════════════════════════════════════
  async function renderSuggestions(container){
    container.innerHTML = '<div class="admin-loading">جارٍ التحميل...<span class="spinner"></span></div>';
    try {
      const data = await api('list_suggestions', { limit: 200 });
      if(data.ok){
        const sugs = data.suggestions || [];
        if(!sugs.length){
          container.innerHTML = '<div class="admin-empty">لا توجد اقتراحات.</div>';
          return;
        }
        const catLabels = { general:'📝 عام', feature:'💡 ميزة', bug:'🐛 مشكلة', improvement:'⚡ تحسين', complaint:'⚠️ شكوى', pricing:'💰 تسعير', partnership:'🤝 شراكة', other:'أخرى' };
        const statusLabels = { new:'جديد', reviewing:'قيد المراجعة', accepted:'مقبول', rejected:'مرفوض', implemented:'منفّذ', deferred:'مؤجل' };
        
        container.innerHTML = sugs.map(s => `
          <div class="admin-suggestion-card">
            <div class="admin-suggestion-head">
              <span class="admin-badge" style="background:var(--blue-tint);color:var(--blue);">${catLabels[s.category] || s.category}</span>
              ${s.is_customer ? '<span class="admin-badge verified">✓ عميل</span>' : ''}
              ${s.is_anonymous ? '<span class="admin-badge anon">مجهول</span>' : ''}
              ${!s.is_public ? '<span class="admin-badge private">خاص</span>' : ''}
              <span style="font-size:10.5px;color:var(--ink-faint);margin-right:auto;">${formatDate(s.created_at)}</span>
            </div>
            <div class="admin-suggestion-title">${escapeHtml(s.title)}</div>
            <div class="admin-suggestion-body">${escapeHtml(s.body)}</div>
            ${s.tags ? `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:8px;"><strong>وسوم:</strong> ${escapeHtml(s.tags)}</div>` : ''}
            ${s.admin_response ? `<div style="background:var(--blue-tint);border-right:3px solid var(--blue);padding:8px 10px;border-radius:8px;margin-bottom:8px;font-size:12px;"><strong style="color:var(--blue);">رد الإدارة:</strong> ${escapeHtml(s.admin_response)}</div>` : ''}
            <div class="admin-suggestion-meta">
              <span>بواسطة: ${escapeHtml(s.author_name)} ${s.phone?'· '+escapeHtml(s.phone):''} ${s.author_email?'· '+escapeHtml(s.author_email):''}</span>
              <span>أصوات: ${s.votes_count || 0}</span>
            </div>
            <div class="admin-suggestion-actions">
              <select onchange="BitaqtiReviewsTab.updateSuggestion(${s.id}, {status: this.value})" style="font-size:11px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;">
                ${Object.entries(statusLabels).map(([v,l]) => `<option value="${v}" ${s.status===v?'selected':''}>${l}</option>`).join('')}
              </select>
              <select onchange="BitaqtiReviewsTab.updateSuggestion(${s.id}, {priority: this.value})" style="font-size:11px;padding:4px 8px;border:1px solid var(--line);border-radius:6px;">
                <option value="low" ${s.priority==='low'?'selected':''}>منخفضة</option>
                <option value="medium" ${s.priority==='medium'?'selected':''}>متوسطة</option>
                <option value="high" ${s.priority==='high'?'selected':''}>عالية</option>
                <option value="critical" ${s.priority==='critical'?'selected':''}>حرجة</option>
              </select>
              <button class="admin-action-btn blue" onclick="BitaqtiReviewsTab.openSuggestionResponseModal(${s.id})">رد إدارة</button>
              <button class="admin-action-btn" onclick="BitaqtiReviewsTab.toggleSuggestionPublic(${s.id}, ${!s.is_public})">${s.is_public?'جعله خاصاً':'جعله علنياً'}</button>
              <button class="admin-action-btn danger" onclick="BitaqtiReviewsTab.deleteSuggestion(${s.id})">حذف</button>
            </div>
          </div>
        `).join('');
      }
    } catch(e){
      container.innerHTML = '<div class="admin-empty">تعذّر التحميل.</div>';
    }
  }

  async function updateSuggestion(id, updates){
    const data = await api('update_suggestion', { suggestion_id: id, ...updates });
    if(data.ok) toast('تم التحديث', 'success');
    else toast('تعذّر التحديث', 'error');
  }

  function openSuggestionResponseModal(id){
    const card = document.getElementById('reviewsModalCard');
    card.innerHTML = `
      <h3><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>رد على الاقتراح</h3>
      <div class="form-group">
        <label>رد الإدارة (سيظهر للعلن إن كان الاقتراح علنياً)</label>
        <textarea class="form-control" id="sugResponse" rows="5" placeholder="اكتب ردك..." maxlength="3000"></textarea>
      </div>
      <div class="btn-row">
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.closeModal()">إلغاء</button>
        <button class="admin-action-btn blue" onclick="BitaqtiReviewsTab.submitSuggestionResponse(${id})">حفظ الرد</button>
      </div>
    `;
    document.getElementById('reviewsModal').classList.add('show');
  }

  async function submitSuggestionResponse(id){
    const text = document.getElementById('sugResponse').value.trim();
    if(!text){ toast('الرد فارغ', 'warn'); return; }
    const data = await api('update_suggestion', { suggestion_id: id, admin_response: text });
    if(data.ok){ toast('تم حفظ الرد', 'success'); closeModal(); renderList(); }
    else toast('تعذّر', 'error');
  }

  async function toggleSuggestionPublic(id, makePublic){
    const data = await api('update_suggestion', { suggestion_id: id, is_public: makePublic });
    if(data.ok){ toast('تم التحديث', 'success'); renderList(); }
    else toast('تعذّر', 'error');
  }

  async function deleteSuggestion(id){
    if(!confirm('حذف هذا الاقتراح نهائياً؟')) return;
    const data = await api('delete_suggestion', { suggestion_id: id });
    if(data.ok){ toast('تم الحذف', 'success'); renderList(); }
    else toast('تعذّر', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  الإعدادات
  // ════════════════════════════════════════════════════════════════
  function renderSettings(container){
    const s = state.settings || {};
    container.innerHTML = `
      <div class="settings-card">
        <h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>إعدادات عامة</h4>
        <div class="setting-row">
          <div><span class="lbl">التقييمات تظهر تلقائياً</span><span class="desc">بدون الحاجة لموافقة — يمكنك إخفاء التقييمات المخالفة لاحقاً.</span></div>
          <label class="switch"><input type="checkbox" id="setAutoApprove" ${s.auto_approve!==false?'checked':''}><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div><span class="lbl">السماح للزوار بالتقييم</span><span class="desc">السماح لأي زائر بإضافة تقييم بدون تسجيل.</span></div>
          <label class="switch"><input type="checkbox" id="setAllowVisitor" ${s.allow_visitor_reviews!==false?'checked':''}><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div><span class="lbl">السماح بالتقييم المجهول</span><span class="desc">السماح بإخفاء اسم المراجع.</span></div>
          <label class="switch"><input type="checkbox" id="setAllowAnon" ${s.allow_anonymous!==false?'checked':''}><span class="slider"></span></label>
        </div>
        <div class="setting-row">
          <div><span class="lbl">إحصاء الموثّقين فقط</span><span class="desc">إدراج تقييمات العملاء الموثّقين فقط في المتوسط العام.</span></div>
          <label class="switch"><input type="checkbox" id="setReqVerif" ${s.require_verification_for_stats?'checked':''}><span class="slider"></span></label>
        </div>
      </div>
      
      <div class="settings-card">
        <h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>حدود الطول</h4>
        <div class="setting-row">
          <div><span class="lbl">حد نص التقييم</span></div>
          <input type="number" id="setMaxBody" value="${s.max_body_length||8000}" min="100" max="20000" style="width:100px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-family:'IBM Plex Mono',monospace;">
        </div>
        <div class="setting-row">
          <div><span class="lbl">حد نص التعليق</span></div>
          <input type="number" id="setMaxComment" value="${s.max_comment_length||2000}" min="100" max="10000" style="width:100px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-family:'IBM Plex Mono',monospace;">
        </div>
        <div class="setting-row">
          <div><span class="lbl">حد نص الاقتراح</span></div>
          <input type="number" id="setMaxSug" value="${s.max_suggestion_length||8000}" min="100" max="20000" style="width:100px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-family:'IBM Plex Mono',monospace;">
        </div>
      </div>
      
      <div class="settings-card">
        <h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>حدود المعدل (Rate Limiting)</h4>
        <div class="setting-row">
          <div><span class="lbl">حد التقييمات لكل IP / ساعة</span></div>
          <input type="number" id="setRateReview" value="${s.rate_limit_per_hour||5}" min="1" max="100" style="width:80px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-family:'IBM Plex Mono',monospace;">
        </div>
        <div class="setting-row">
          <div><span class="lbl">حد التعليقات لكل IP / ساعة</span></div>
          <input type="number" id="setRateComment" value="${s.rate_limit_comments||10}" min="1" max="100" style="width:80px;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font-family:'IBM Plex Mono',monospace;">
        </div>
      </div>
      
      <div class="settings-card">
        <h4><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>رسالة الترحيب</h4>
        <div class="form-group" style="margin:0;">
          <textarea id="setWelcome" rows="3" style="width:100%;padding:8px 12px;border:1px solid var(--line);border-radius:8px;font-family:inherit;font-size:13px;background:var(--paper);">${escapeHtml(s.welcome_message || 'شاركنا رأيك في تجربتك مع بطاقتي')}</textarea>
        </div>
      </div>
      
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="admin-action-btn success" onclick="BitaqtiReviewsTab.saveSettings()" style="padding:10px 22px;font-size:13px;">💾 حفظ الإعدادات</button>
        <button class="admin-action-btn" onclick="BitaqtiReviewsTab.refreshStats()" style="padding:10px 22px;font-size:13px;">⟳ إعادة حساب الإحصائيات</button>
      </div>
    `;
  }

  async function saveSettings(){
    const updates = {
      auto_approve: document.getElementById('setAutoApprove').checked,
      allow_visitor_reviews: document.getElementById('setAllowVisitor').checked,
      allow_anonymous: document.getElementById('setAllowAnon').checked,
      require_verification_for_stats: document.getElementById('setReqVerif').checked,
      max_body_length: parseInt(document.getElementById('setMaxBody').value),
      max_comment_length: parseInt(document.getElementById('setMaxComment').value),
      max_suggestion_length: parseInt(document.getElementById('setMaxSug').value),
      rate_limit_per_hour: parseInt(document.getElementById('setRateReview').value),
      rate_limit_comments: parseInt(document.getElementById('setRateComment').value),
      welcome_message: document.getElementById('setWelcome').value,
    };
    const data = await api('update_settings', updates);
    if(data.ok){ toast('تم حفظ الإعدادات', 'success'); loadStats(); }
    else toast('تعذّر الحفظ', 'error');
  }

  async function refreshStats(){
    const data = await api('refresh_stats');
    if(data.ok){ toast('تم تحديث الإحصائيات', 'success'); loadStats(); }
    else toast('تعذّر', 'error');
  }

  // ════════════════════════════════════════════════════════════════
  //  تصدير CSV
  // ════════════════════════════════════════════════════════════════
  async function exportCsv(){
    try {
      const pwd = getPwd();
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export_reviews', password: pwd }),
      });
      if(!res.ok){ toast('تعذّر التصدير', 'error'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bitaqti-reviews-${new Date().toISOString().slice(0,10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('تم تصدير التقييمات', 'success');
    } catch(e){
      toast('تعذّر التصدير', 'error');
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  واجهة عامة
  // ════════════════════════════════════════════════════════════════
  Object.assign(window.BitaqtiReviewsTab, {
    init,
    refresh,
    loadStats,
    renderList,
    hideReview, unhideReview,
    featureReview, unfeatureReview,
    pinReview, unpinReview,
    deleteReview,
    bulkAction, clearSelection, updateBulkCount,
    viewDetail, closeModal,
    openResponseModal, submitResponse, deleteResponse,
    openNoteModal, submitNote,
    hideComment, unhideComment, deleteComment,
    updateSuggestion, openSuggestionResponseModal, submitSuggestionResponse,
    toggleSuggestionPublic, deleteSuggestion,
    saveSettings, refreshStats,
    exportCsv,
  });

  // ════════════════════════════════════════════════════════════════
  //  الاستماع لأحداث التبويب
  // ════════════════════════════════════════════════════════════════
  // نراقب ظهور التبويب
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab[data-tab="reviews"]');
    if(tab){
      setTimeout(() => init(), 50);
    }
  });
  
  // مراقبة تغيّر className للوحة التبويب
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(m => {
      if(m.attributeName === 'class'){
        const panel = document.getElementById('tab-reviews');
        if(panel && panel.classList.contains('active') && panel.dataset.initialized !== 'pending'){
          panel.dataset.initialized = 'pending';
          setTimeout(() => init(), 50);
        }
      }
    });
  });
  
  function setupObserver(){
    const panel = document.getElementById('tab-reviews');
    if(panel){
      observer.observe(panel, { attributes: true, attributeFilter: ['class'] });
    } else {
      setTimeout(setupObserver, 500);
    }
  }
  setupObserver();

})();
