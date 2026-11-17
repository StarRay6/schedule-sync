/* 日程同步 · 前端应用逻辑（无框架，纯原生） */
(() => {
  'use strict';

  /* ==================== 常量 ==================== */
  const CATS = [
    { key: 'work',  label: '工作', color: '#0f766e', line: '#0d9488', tint: 'rgba(13,148,136,.13)', soft: '#e7f4f1' },
    { key: 'study', label: '学习', color: '#2563eb', line: '#3b82f6', tint: 'rgba(59,130,246,.12)', soft: '#e9effd' },
    { key: 'life',  label: '生活', color: '#d97706', line: '#e08e2a', tint: 'rgba(224,142,42,.14)', soft: '#fdf2e0' },
    { key: 'sport', label: '运动', color: '#16a34a', line: '#2eb85c', tint: 'rgba(46,184,92,.13)', soft: '#e8f6ec' },
    { key: 'other', label: '其他', color: '#be123c', line: '#e11d48', tint: 'rgba(225,29,72,.12)', soft: '#fdedf0' },
  ];
  const CAT_MAP = Object.fromEntries(CATS.map(c => [c.key, c]));
  const WEEK_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
  const WEEK_FULL = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const STORE_KEY = 'sched.doc.v1';
  const VIEW_KEY = 'sched.view.v1';
  const SENT_KEY = 'sched.sent.v1';
  const GRID_START_HOUR = 6;
  const GRID_END_HOUR = 24;
  const HOUR_PX = 52;

  /* ==================== 状态 ==================== */
  let items = new Map();       // id -> item（含 tombstone）
  let rev = 0;
  let online = false;
  let serverInfo = null;
  let view = localStorage.getItem(VIEW_KEY) || 'month';
  let cursor = new Date();
  let editing = null;          // { kind, id }
  let es = null;
  let dirty = new Set();
  let flushTimer = null;
  let reconnectTimer = null;
  let todoFilter = 'open';
  let selectedDate = null;

  /* ==================== 小工具 ==================== */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const pad2 = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hm = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const parseDT = (dateStr, timeStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
    return new Date(y, m - 1, d, hh || 0, mm || 0, 0, 0);
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => { const t = new Date(d.getFullYear(), d.getMonth() + n, 1); const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate(); t.setDate(Math.min(d.getDate(), dim)); return t; };
  const startOfWeek = d => { const t = new Date(d.getFullYear(), d.getMonth(), d.getDate()); const off = (t.getDay() + 6) % 7; t.setDate(t.getDate() - off); return t; };
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const mins = (dateStr, timeStr) => { const d = parseDT(dateStr, timeStr); return d.getHours() * 60 + d.getMinutes(); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const catOf = key => CAT_MAP[key] || CATS[0];

  function toast(title, sub, opts = {}) {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `<span class="ico">${opts.icon || '🔔'}</span><span class="txt"><b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span>${opts.action ? `<span class="act">${esc(opts.action)}</span>` : ''}`;
    wrap.appendChild(el);
    if (opts.onClick) el.addEventListener('click', () => { opts.onClick(); el.remove(); });
    setTimeout(() => { el.style.transition = 'opacity .3s, transform .3s'; el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; setTimeout(() => el.remove(), 320); }, opts.ms || 4500);
  }

  let audioCtx = null;
  function unlockAudio() { try { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {} }
  function beep() {
    try {
      unlockAudio();
      if (!audioCtx) return;
      const t0 = audioCtx.currentTime;
      [0, 0.18].forEach((off, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = i === 0 ? 880 : 1046;
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + off); o.stop(t0 + off + 0.2);
      });
    } catch (e) {}
  }

  /* ==================== 本地存储 ==================== */
  const saveLocal = debounce(() => {
    try {
      const arr = Array.from(items.values());
      localStorage.setItem(STORE_KEY, JSON.stringify({ rev, items: arr, savedAt: Date.now() }));
    } catch (e) { console.warn('本地保存失败', e); }
  }, 120);

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.items)) {
        items = new Map(d.items.map(i => [i.id, i]));
        rev = d.rev || 0;
      }
    } catch (e) {}
  }

  /* ==================== 同步层 ==================== */
  function setStatus(kind, text) {
    const el = $('#status');
    el.className = 'status ' + kind;
    $('.status-text', el).textContent = text;
    el.title = text;
  }

  async function fetchJSON(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 8000);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  async function connect() {
    setStatus('busy', '连接中…');
    try {
      const info = await fetchJSON('/api/info', { timeout: 4000 });
      serverInfo = info;
      online = true;
      await pullAll(true);
      openStream();
      $('#offlineBanner').hidden = true;
      setStatus('ok', '已连接');
      if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
    } catch (e) {
      online = false;
      setStatus('off', '离线模式');
      $('#offlineBanner').hidden = false;
      if (!reconnectTimer) reconnectTimer = setInterval(() => { if (!online) connect(); }, 15000);
    }
  }

  function openStream() {
    if (es) { try { es.close(); } catch (e) {} es = null; }
    try {
      es = new EventSource('/api/stream');
      es.onopen = () => {
        const wasOffline = !online;
        online = true;
        setStatus('ok', '已连接');
        $('#offlineBanner').hidden = true;
        if (wasOffline) pullAll(false);
      };
      es.onmessage = ev => {
        let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d && d.rev && d.rev !== rev) pullAll(false);
      };
      es.onerror = () => {
        $('#offlineBanner').hidden = false;
        if (es && es.readyState === 2) { setStatus('bad', '连接断开'); online = false; }
        else setStatus('busy', '重连中…');
      };
    } catch (e) {}
  }

  async function pullAll(firstLoad) {
    if (!online) return;
    try {
      const doc = await fetchJSON('/api/data');
      reconcile(doc);
      if (firstLoad) setStatus('ok', '已连接');
    } catch (e) {
      setStatus('busy', '同步失败');
      if (firstLoad) { online = false; $('#offlineBanner').hidden = false; }
    }
  }

  /* 以 updatedAt 为准则合并；本地较新的条目回推服务器 */
  function reconcile(doc) {
    const serverMap = new Map((doc.items || []).map(i => [i.id, i]));
    const toPush = [];
    for (const [id, local] of items) {
      const s = serverMap.get(id);
      if (!s || (local.updatedAt || 0) > (s.updatedAt || 0)) {
        serverMap.set(id, local);
        if (s && (local.updatedAt || 0) > (s.updatedAt || 0)) toPush.push(local);
        if (!s) toPush.push(local);
      }
    }
    // 服务器上多出来的条目（本机没有）直接吸收
    items = serverMap;
    rev = doc.rev || rev;
    saveLocal();
    render();
    if (toPush.length) pushPatch(toPush);
  }

  function queuePush(item) {
    dirty.add(item);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPush, 220);
  }

  async function flushPush() {
    if (!online) { setStatus('off', '离线模式'); return; }
    if (!dirty.size) return;
    const batch = Array.from(dirty);
    dirty.clear();
    setStatus('busy', '同步中…');
    try {
      const res = await fetchJSON('/api/patch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: batch }),
      });
      rev = res.rev || rev;
      setStatus('ok', '已同步');
      saveLocal();
    } catch (e) {
      batch.forEach(i => dirty.add(i));
      setStatus('bad', '同步失败');
      setTimeout(flushPush, 3000);
    }
  }

  /* 写入条目（新增/更新/删除共用） */
  function upsert(patch) {
    const now = Date.now();
    let item = { ...patch, updatedAt: now };
    items.set(item.id, item);
    saveLocal();
    render();
    queuePush(item);
    return item;
  }

  function removeItem(id) {
    const it = items.get(id);
    if (!it) return;
    upsert({ ...it, deleted: true, updatedAt: Date.now() });
  }

  /* ==================== 数据读取 ==================== */
  const live = () => Array.from(items.values()).filter(i => !i.deleted);
  const eventsOn = dateStr => live().filter(i => i.kind === 'event' && i.date === dateStr)
    .sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || (a.start || '').localeCompare(b.start || ''));
  const todos = () => live().filter(i => i.kind === 'todo');

  /* ==================== 标题 / 导航 ==================== */
  function updateTitle() {
    const t = $('#title');
    if (view === 'month') t.textContent = `${cursor.getFullYear()}年${cursor.getMonth() + 1}月`;
    else if (view === 'week') {
      const s = startOfWeek(cursor), e = addDays(s, 6);
      t.textContent = s.getMonth() === e.getMonth()
        ? `${s.getMonth() + 1}月${s.getDate()}日 – ${e.getDate()}日`
        : `${s.getMonth() + 1}月${s.getDate()}日 – ${e.getMonth() + 1}月${e.getDate()}日`;
    } else if (view === 'day') {
      t.textContent = `${cursor.getMonth() + 1}月${cursor.getDate()}日 ${WEEK_FULL[(cursor.getDay() + 6) % 7]}`;
    } else {
      const open = todos().filter(t => !t.done).length;
      t.textContent = `待办 · ${open} 项未完成`;
    }
    $('#btnPrev').style.visibility = view === 'todo' ? 'hidden' : 'visible';
    $('#btnNext').style.visibility = view === 'todo' ? 'hidden' : 'visible';
    $('#btnToday').style.visibility = view === 'todo' ? 'hidden' : 'visible';
  }

  function switchView(v) {
    view = v;
    localStorage.setItem(VIEW_KEY, v);
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    render();
  }

  /* ==================== 渲染 ==================== */
  let raf = 0;
  function render() {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      updateTitle();
      const main = $('#main');
      if (view === 'month') renderMonth(main);
      else if (view === 'week') renderWeek(main);
      else if (view === 'day') renderDay(main);
      else renderTodo(main);
    });
  }

  /* ---------- 月视图 ---------- */
  function renderMonth(main) {
    const y = cursor.getFullYear(), m = cursor.getMonth();
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const gridStart = addDays(first, -offset);
    const todayD = today();

    let cellsHtml = '';
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const ds = ymd(d);
      const out = d.getMonth() !== m;
      const isToday = sameDay(d, todayD);
      const isSel = selectedDate === ds;
      const evs = eventsOn(ds);
      const chips = evs.slice(0, 3).map(ev => {
        const c = catOf(ev.color);
        const time = ev.allDay ? '全天' : (ev.start || '');
        return `<div class="chip${ev.done ? ' done' : ''}" data-open="${ev.id}" style="--c-line:${c.line};--c-soft:${c.tint}"><span class="t">${esc(time)}</span>${esc(ev.title)}</div>`;
      }).join('');
      const more = evs.length > 3 ? `<div class="more">还有 ${evs.length - 3} 项</div>` : '';
      cellsHtml += `<div class="day-cell${out ? ' out' : ''}${isToday ? ' today' : ''}${isSel ? ' selected' : ''}" data-date="${ds}">
        <div class="day-num"><span>${d.getDate()}</span>${evs.length ? `<i class="more">${evs.length}</i>` : ''}</div>
        ${chips}${more}
      </div>`;
    }

    main.innerHTML = `<div class="month-wrap">
      <div class="weekdays">${WEEK_NAMES.map((n, i) => `<div class="${i > 4 ? 'weekend' : ''}">${n}</div>`).join('')}</div>
      <div class="month-grid">${cellsHtml}</div>
    </div>`;
  }

  /* ---------- 周视图 ---------- */
  function layoutDay(evs) {
    const blocks = evs.filter(e => !e.allDay).map(e => {
      const s = mins(e.date, e.start || '00:00');
      let en = mins(e.date, e.end || e.start || '23:59');
      if (en <= s) en = s + 30;
      return { ev: e, s, en };
    }).sort((a, b) => a.s - b.s || a.en - b.en);

    const groups = [];
    let cur = null;
    for (const b of blocks) {
      if (!cur || b.s >= cur.end) { cur = { items: [b], end: b.en }; groups.push(cur); }
      else { cur.items.push(b); cur.end = Math.max(cur.end, b.en); }
    }
    for (const g of groups) {
      const cols = [];
      for (const b of g.items) {
        let idx = cols.findIndex(end => end <= b.s);
        if (idx === -1) { cols.push(b.en); idx = cols.length - 1; }
        else cols[idx] = b.en;
        b.col = idx;
      }
      g.items.forEach(b => { b.cols = cols.length; });
    }
    return blocks;
  }

  function renderWeek(main) {
    const ws = startOfWeek(cursor);
    const todayD = today();
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const heights = (GRID_END_HOUR - GRID_START_HOUR) * HOUR_PX;

    let headHtml = '<div class="corner"></div>';
    days.forEach(d => {
      const isT = sameDay(d, todayD);
      headHtml += `<div class="week-day-head${isT ? ' today' : ''}"><div class="wd">${WEEK_FULL[(d.getDay() + 6) % 7]}</div><div class="dn">${d.getDate()}</div></div>`;
    });

    let axisHtml = '';
    for (let h = GRID_START_HOUR; h < GRID_END_HOUR; h++) axisHtml += `<div class="h">${pad2(h)}:00</div>`;

    let colsHtml = '';
    days.forEach(d => {
      const ds = ymd(d);
      const isT = sameDay(d, todayD);
      const blocks = layoutDay(eventsOn(ds));
      let inner = '';
      blocks.forEach(b => {
        const c = catOf(b.ev.color);
        const top = Math.max(0, (b.s - GRID_START_HOUR * 60) / 60 * HOUR_PX);
        const hgt = Math.max(20, (b.en - b.s) / 60 * HOUR_PX - 2);
        if (top + hgt < 0) return;
        const w = 100 / b.cols;
        inner += `<div class="ev-block${b.ev.done ? ' done' : ''}" data-open="${b.ev.id}" style="top:${top}px;height:${Math.min(hgt, heights - top)}px;left:calc(${b.col * w}% + 2px);width:calc(${w}% - 4px);--c-line:${c.line};--c-soft:${c.tint}">
          <div class="ev-title">${esc(b.ev.title)}</div>
          <div class="ev-time">${esc(b.ev.start)}–${esc(b.ev.end || '')}</div>
        </div>`;
      });
      const allDay = eventsOn(ds).filter(e => e.allDay);
      colsHtml += `<div class="day-col${isT ? ' today' : ''}" data-day="${ds}" style="height:${heights}px">${inner}${allDay.map(e => {
        const c = catOf(e.color);
        return `<div class="chip" data-open="${e.id}" style="position:absolute;top:4px;left:2px;right:2px;z-index:3;--c-line:${c.line};--c-soft:${c.tint}">全天 ${esc(e.title)}</div>`;
      }).join('')}</div>`;
    });

    const bodyH = Math.min(heights + 10, Math.max(320, window.innerHeight - 230));
    main.innerHTML = `<div class="week-wrap" style="max-height:${bodyH}px">
      <div class="week-head-row">${headHtml}</div>
      <div class="week-body">
        <div class="time-axis">${axisHtml}</div>
        ${colsHtml}
      </div>
    </div>`;
  }

  /* ---------- 日视图 ---------- */
  function renderDay(main) {
    const ds = ymd(cursor);
    const evs = eventsOn(ds);
    const dayTodos = todos().filter(t => t.due === ds);
    const nowTag = sameDay(cursor, today()) ? `<span class="badge" style="--c-line:var(--accent-deep);--c-soft:var(--accent-soft)">今天</span>` : '';

    let rows = evs.map(e => {
      const c = catOf(e.color);
      const timeHtml = e.allDay ? '全天' : `<b>${esc(e.start || '')}</b>${e.end ? esc(e.end) : ''}`;
      return `<div class="day-row" data-open="${e.id}">
        <div class="time">${timeHtml}</div>
        <div class="bar" style="background:${c.color}"></div>
        <div class="body">
          <div class="t${e.done ? ' done' : ''}">${esc(e.title)}</div>
          ${e.note ? `<div class="n">${esc(e.note)}</div>` : ''}
          <div class="tags"><span class="badge" style="--c-line:${c.line};--c-soft:${c.tint}">${esc(c.label)}</span>${e.remind !== '' && e.remind != null ? `<span class="badge">提前 ${e.remind === 0 ? '准时' : e.remind + ' 分钟'}提醒</span>` : ''}${e.done ? '<span class="badge">已完成</span>' : ''}</div>
        </div>
      </div>`;
    }).join('');

    const todoHtml = dayTodos.length ? `<div class="day-wrap" style="margin-top:12px">
      <div class="day-row" style="cursor:default;border-bottom:1px solid var(--line-2)"><div class="body"><div class="t" style="font-size:13px;color:var(--ink-2)">当天待办</div></div></div>
      ${dayTodos.map(t => `<div class="day-row" data-open="${t.id}"><div class="time">${t.done ? '✓' : '待'}</div><div class="bar" style="background:${t.done ? '#cbd5d0' : '#d97706'}"></div><div class="body"><div class="t${t.done ? ' done' : ''}">${esc(t.title)}</div>${t.note ? `<div class="n">${esc(t.note)}</div>` : ''}</div></div>`).join('')}
    </div>` : '';

    const doneCount = evs.filter(e => e.done).length;
    main.innerHTML = `
      <div class="day-summary">
        <div class="stat"><div class="k">日程</div><div class="v">${evs.length}<small>项</small></div></div>
        <div class="stat"><div class="k">已完成</div><div class="v">${doneCount}<small>项</small></div></div>
        <div class="stat"><div class="k">当天待办</div><div class="v">${dayTodos.filter(t => !t.done).length}<small>项未完成</small></div></div>
      </div>
      <div class="day-wrap" style="margin-top:12px">
        ${evs.length ? rows : `<div class="day-empty">这一天还没有日程<br><span style="font-size:12px">点右下角 + 新建一条</span></div>`}
      </div>
      ${todoHtml}`;
  }

  /* ---------- 待办视图 ---------- */
  function renderTodo(main) {
    const all = todos().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if ((b.priority || 2) !== (a.priority || 2)) return (b.priority || 2) - (a.priority || 2);
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    const filtered = all.filter(t => todoFilter === 'all' ? true : todoFilter === 'done' ? t.done : !t.done);
    const t0 = today();
    const todayStr = ymd(t0);

    const rows = filtered.map(t => {
      const p = t.priority || 2;
      const overdue = !t.done && t.due && t.due < todayStr;
      const dueTxt = t.due ? (t.due === todayStr ? '今天' : t.due === ymd(addDays(t0, 1)) ? '明天' : t.due.slice(5).replace('-', '/')) : '';
      return `<div class="todo-row${t.done ? ' done' : ''}" data-open="${t.id}">
        <span class="check${t.done ? ' on' : ''}" data-toggle="${t.id}"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg></span>
        <div class="tt"><div class="t">${esc(t.title)}</div><div class="m">
          <span class="prio p${p}">${p === 3 ? '高' : p === 1 ? '低' : '中'}</span>
          ${dueTxt ? `<span class="due${overdue ? ' overdue' : ''}">${overdue ? '已逾期 · ' : ''}${esc(dueTxt)}</span>` : ''}
          ${t.note ? `<span class="due">${esc(t.note.slice(0, 20))}${t.note.length > 20 ? '…' : ''}</span>` : ''}
        </div></div>
      </div>`;
    }).join('');

    main.innerHTML = `<div class="todo-wrap">
      <div class="todo-head">
        <div class="quick-add">
          <input type="text" id="quickTodo" placeholder="加一条待办，回车即可" maxlength="60" autocomplete="off">
          <button class="btn primary" id="quickAddBtn">添加</button>
        </div>
        <div class="quick-meta">
          <label>截止 <input type="date" id="quickDue"></label>
          <label>优先级 <select id="quickPrio"><option value="3">高</option><option value="2" selected>中</option><option value="1">低</option></select></label>
        </div>
      </div>
      <div class="todo-filters">
        <button class="filter-pill${todoFilter === 'open' ? ' active' : ''}" data-filter="open">未完成 ${all.filter(t => !t.done).length}</button>
        <button class="filter-pill${todoFilter === 'done' ? ' active' : ''}" data-filter="done">已完成 ${all.filter(t => t.done).length}</button>
        <button class="filter-pill${todoFilter === 'all' ? ' active' : ''}" data-filter="all">全部 ${all.length}</button>
      </div>
      <div class="todo-list">${filtered.length ? rows : `<div class="empty"><div class="icon">☕</div><h3>${todoFilter === 'done' ? '还没有完成的事' : '没有待办，清爽'}</h3><p>在上方输入框加一条吧</p></div>`}</div>
    </div>`;
  }

  /* ==================== 编辑弹层 ==================== */
  function openEditor(kind, id, defaults = {}) {
    editing = { kind, id: id || null };
    const existing = id ? items.get(id) : null;
    const isEvent = kind === 'event';

    $('#sheetKind').textContent = isEvent ? '日程' : '待办';
    $('#sheetTitle').textContent = existing ? '编辑' + (isEvent ? '日程' : '待办') : '新建' + (isEvent ? '日程' : '待办');
    $('#colorField').hidden = !isEvent;
    $('#remindField').hidden = !isEvent;
    $('#dateRow').hidden = !isEvent;
    $('#timeRow').hidden = !isEvent || (existing && existing.allDay);
    $('#todoExtra').hidden = isEvent;
    $('#btnDelete').hidden = !existing;

    const d = existing ? existing : defaults;
    $('#fTitle').value = existing ? existing.title : (d.title || '');
    $('#fDate').value = existing ? (existing.date || ymd(cursor)) : (d.date || ymd(cursor));
    $('#fStart').value = existing ? (existing.start || '09:00') : (d.start || '09:00');
    $('#fEnd').value = existing ? (existing.end || '10:00') : (d.end || '10:00');
    $('#fAllDay').checked = !!(existing ? existing.allDay : d.allDay);
    $('#fRemind').value = existing ? String(existing.remind == null ? '' : existing.remind) : (d.remind == null ? '' : String(d.remind));
    $('#fNote').value = existing ? (existing.note || '') : '';
    $('#fDue').value = existing ? (existing.due || '') : '';
    $('#fPriority').value = String(existing ? (existing.priority || 2) : 2);
    $('#fDone').checked = !!(existing && existing.done);

    const colorKey = existing ? (existing.color || 'work') : (d.color || 'work');
    $$('.color-dot').forEach(b => b.classList.toggle('on', b.dataset.color === colorKey));

    $('#sheetWrap').hidden = false;
    setTimeout(() => $('#fTitle').focus(), 60);
  }

  function closeSheet() { $('#sheetWrap').hidden = true; editing = null; }

  function saveEditor() {
    if (!editing) return;
    const kind = editing.kind;
    const id = editing.id || uid();
    const old = editing.id ? items.get(editing.id) : null;
    const title = $('#fTitle').value.trim();
    if (!title) { toast('请输入标题', '标题不能为空', { icon: '⚠️' }); $('#fTitle').focus(); return; }

    if (kind === 'event') {
      const allday = $('#fAllDay').checked;
      let start = $('#fStart').value || '09:00';
      let end = $('#fEnd').value || '';
      if (!allday && end && end <= start) {
        const s = parseDT('2000-01-01', start); const e2 = new Date(s.getTime() + 60 * 60000); end = hm(e2);
      }
      upsert({
        id, kind, title,
        date: $('#fDate').value || ymd(cursor),
        start: allday ? '' : start,
        end: allday ? '' : end,
        allDay: allday,
        color: ($('.color-dot.on') || { dataset: { color: 'work' } }).dataset.color,
        remind: $('#fRemind').value === '' ? '' : Number($('#fRemind').value),
        note: $('#fNote').value.trim(),
        done: old ? !!old.done : false,
        deleted: false,
      });
    } else {
      upsert({
        id, kind, title,
        due: $('#fDue').value || '',
        priority: Number($('#fPriority').value || 2),
        done: $('#fDone').checked,
        note: $('#fNote').value.trim(),
        deleted: false,
      });
    }
    closeSheet();
    toast(kind === 'event' ? '已保存日程' : '已保存待办', title, { icon: '✓', ms: 2200 });
  }

  /* ==================== 提醒 ==================== */
  function loadSent() { try { return JSON.parse(localStorage.getItem(SENT_KEY) || '{}'); } catch (e) { return {}; } }
  function saveSent(o) { try { localStorage.setItem(SENT_KEY, JSON.stringify(o)); } catch (e) {} }

  function tickReminders() {
    const now = Date.now();
    const sent = loadSent();
    let changed = false;

    for (const ev of live()) {
      if (ev.kind !== 'event') continue;
      if (ev.remind === '' || ev.remind == null || ev.allDay) continue;
      if (!ev.date || !ev.start) continue;
      const startMs = parseDT(ev.date, ev.start).getTime();
      if (!startMs) continue;
      const trigMs = startMs - Number(ev.remind) * 60000;
      const key = `${ev.id}@${ev.date}${ev.start}`;
      if (sent[key]) continue;
      // 触发窗口：到点起，直到日程开始后 5 分钟
      if (now >= trigMs && now <= startMs + 5 * 60000) {
        sent[key] = now;
        changed = true;
        fireReminder(ev);
      }
      // 太早的（超过 5 分钟前）直接标记，避免打开页面时补炸一堆
      if (now > startMs + 5 * 60000 && now - startMs < 2 * 86400000) { sent[key] = -1; changed = true; }
    }

    // 清理 10 天前的记录
    for (const k of Object.keys(sent)) { if (typeof sent[k] === 'number' && now - sent[k] > 10 * 86400000) { delete sent[k]; changed = true; } }
    if (changed) saveSent(sent);
  }

  function fireReminder(ev) {
    const when = ev.remind === 0 ? '现在开始' : `还有 ${ev.remind} 分钟`;
    const body = `${ev.start}${ev.end ? '–' + ev.end : ''} · ${when}`;
    toast(ev.title, body, { icon: '⏰', ms: 8000, action: '知道了', onClick: () => {} });
    beep();
    try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) {}
    try {
      if ('Notification' in window && Notification.permission === 'granted' && window.isSecureContext) {
        const n = new Notification('日程提醒 · ' + ev.title, { body, tag: ev.id });
        n.onclick = () => { window.focus(); n.close(); };
      }
    } catch (e) {}
  }

  /* ==================== 导出 / 导入 ==================== */
  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3500);
  }

  function icsEsc(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n'); }
  function icsDT(dateStr, timeStr) { return dateStr.replace(/-/g, '') + 'T' + (timeStr || '00:00').replace(':', '') + '00'; }

  function exportIcs() {
    const t = new Date();
    const stamp = t.getUTCFullYear() + pad2(t.getUTCMonth() + 1) + pad2(t.getUTCDate()) + 'T' + pad2(t.getUTCHours()) + pad2(t.getUTCMinutes()) + pad2(t.getUTCSeconds()) + 'Z';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//schedule-sync//CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:我的日程', 'X-WR-TIMEZONE:Asia/Shanghai'];
    for (const ev of live().filter(i => i.kind === 'event')) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + ev.id + '@schedule-sync');
      lines.push('DTSTAMP:' + stamp);
      if (ev.allDay) {
        lines.push('DTSTART;VALUE=DATE:' + ev.date.replace(/-/g, ''));
        lines.push('DTEND;VALUE=DATE:' + ymd(addDays(parseDate(ev.date), 1)).replace(/-/g, ''));
      } else {
        lines.push('DTSTART:' + icsDT(ev.date, ev.start || '00:00'));
        lines.push('DTEND:' + icsDT(ev.date, ev.end || ev.start || '23:59'));
      }
      lines.push('SUMMARY:' + icsEsc(ev.title));
      if (ev.note) lines.push('DESCRIPTION:' + icsEsc(ev.note));
      lines.push('CATEGORIES:' + icsEsc(catOf(ev.color).label));
      if (ev.remind !== '' && ev.remind != null) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:' + icsEsc(ev.title), 'TRIGGER:-PT' + Number(ev.remind) + 'M', 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    download('我的日程.ics', lines.join('\r\n'), 'text/calendar;charset=utf-8');
    toast('已导出 .ics', '导入手机日历 App 可获得锁屏提醒', { icon: '📅', ms: 3000 });
  }

  function exportJson() {
    download(`日程备份-${ymd(new Date())}.json`, JSON.stringify({ app: 'schedule-sync', exportedAt: Date.now(), rev, items: Array.from(items.values()) }, null, 2), 'application/json');
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        const arr = Array.isArray(d) ? d : d.items;
        if (!Array.isArray(arr)) throw new Error('格式不对');
        let n = 0;
        arr.forEach(it => {
          if (!it || !it.id || !it.kind) return;
          const old = items.get(it.id);
          if (!old || (it.updatedAt || 0) >= (old.updatedAt || 0)) { items.set(it.id, it); n++; }
        });
        saveLocal(); render();
        Array.from(items.values()).forEach(it => { if (it.updatedAt > (rev || 0)) queuePush(it); });
        toast('已导入', `合并 ${n} 条数据`, { icon: '✓' });
      } catch (e) { toast('导入失败', '文件不是有效的备份', { icon: '⚠️' }); }
    };
    reader.readAsText(file);
  }

  /* ==================== 设置面板 ==================== */
  function openSettings() {
    const wrap = $('#settingsWrap');
    wrap.hidden = false;
    const list = $('#urlList');
    const qrBox = $('#qrBox');
    const hint = $('#connectHint');
    const btnCopy = $('#btnCopyUrl');
    list.innerHTML = '';
    qrBox.hidden = true;
    btnCopy.hidden = true;

    if (!online || !serverInfo) {
      hint.textContent = '当前是离线模式（数据只在本机）。请在运行服务的电脑上打开程序，按设置里的局域网地址在手机浏览器访问。';
      $('#connectBlock h3').textContent = '同步状态';
      return;
    }
    $('#connectBlock h3').textContent = '手机连接地址';
    hint.textContent = '手机和电脑连同一个 Wi-Fi，用手机浏览器打开下面任一地址；加到桌面就像 App 一样用。';
    const urls = (serverInfo.urls || []).slice();
    urls.forEach((u, i) => {
      const div = document.createElement('div');
      div.className = 'url-item';
      div.innerHTML = `<span style="flex:1">${esc(u)}</span>`;
      list.appendChild(div);
    });
    btnCopy.hidden = !urls.length;
    btnCopy.onclick = async () => {
      try { await navigator.clipboard.writeText(urls[0]); toast('已复制', urls[0], { icon: '✓', ms: 2000 }); }
      catch (e) { toast('复制失败', '请手动长按地址复制', { icon: '⚠️' }); }
    };
    if (urls.length && window.qrcode) {
      try {
        const qr = window.qrcode(0, 'M');
        qr.addData(urls[0]); qr.make();
        $('#qrcode').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
        qrBox.hidden = false;
      } catch (e) {}
    }

    const nb = $('#btnNotify');
    if (!('Notification' in window)) { nb.textContent = '此浏览器不支持系统通知'; nb.disabled = true; }
    else if (Notification.permission === 'granted') { nb.textContent = '通知已开启'; nb.disabled = true; }
    else nb.textContent = '开启浏览器通知';
  }

  /* ==================== 主题 ==================== */
  const THEME_KEY = 'sched.theme.v1';

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#11171a' : '#0f766e');
  }

  function initTheme() {
    let mode = null;
    try { mode = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (mode !== 'dark' && mode !== 'light') {
      mode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(mode);
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
    toast(next === 'dark' ? '夜间模式' : '白天模式', next === 'dark' ? '配色已调暗，弱光环境下更护眼' : '已切回明亮配色', { icon: next === 'dark' ? '🌙' : '☀️', ms: 1600 });
  }

  /* ==================== 事件绑定 ==================== */
  function buildColors() {
    $('#colorRow').innerHTML = CATS.map((c, i) => `<button type="button" class="color-dot${i === 0 ? ' on' : ''}" data-color="${c.key}" style="background:${c.color};color:${c.color}" aria-label="${c.label}" title="${c.label}"></button>`).join('');
  }

  function bind() {
    $('#btnPrev').onclick = () => {
      cursor = view === 'month' ? addMonths(cursor, -1) : view === 'week' ? addDays(cursor, -7) : addDays(cursor, -1);
      render();
    };
    $('#btnNext').onclick = () => {
      cursor = view === 'month' ? addMonths(cursor, 1) : view === 'week' ? addDays(cursor, 7) : addDays(cursor, 1);
      render();
    };
    $('#btnToday').onclick = () => { cursor = today(); selectedDate = null; render(); };
    $('#tabs').onclick = e => {
      const b = e.target.closest('button[data-view]');
      if (b) switchView(b.dataset.view);
    };
    $('#btnTheme').onclick = toggleTheme;
    $('#btnMenu').onclick = openSettings;
    $('#btnAdd').onclick = () => {
      if (view === 'todo') openEditor('todo');
      else openEditor('event', null, { date: view === 'day' ? ymd(cursor) : ymd(cursor) });
    };

    // 主内容区域事件代理
    $('#main').addEventListener('click', e => {
      const openBtn = e.target.closest('[data-open]');
      if (openBtn) { const it = items.get(openBtn.dataset.open); if (it) openEditor(it.kind, it.id); return; }

      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        const it = items.get(toggle.dataset.toggle);
        if (it) { upsert({ ...it, done: !it.done }); }
        return;
      }

      const filter = e.target.closest('[data-filter]');
      if (filter) { todoFilter = filter.dataset.filter; render(); return; }

      if (e.target.closest('#quickAddBtn') || e.target.id === 'quickAddBtn') { quickAddTodo(); return; }

      const dayCell = e.target.closest('.day-cell[data-date]');
      if (dayCell) { cursor = parseDate(dayCell.dataset.date); selectedDate = dayCell.dataset.date; switchView('day'); return; }

      // 周视图空白处点击 → 新建
      const col = e.target.closest('.day-col[data-day]');
      if (col && !e.target.closest('.ev-block')) {
        const rect = col.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const hour = Math.floor(y / HOUR_PX) + GRID_START_HOUR;
        if (hour >= GRID_START_HOUR && hour < GRID_END_HOUR) {
          openEditor('event', null, { date: col.dataset.day, start: pad2(hour) + ':00', end: pad2(hour + 1) + ':00' });
        }
      }
    });

    $('#main').addEventListener('keydown', e => {
      if (e.target.id === 'quickTodo' && e.key === 'Enter') { e.preventDefault(); quickAddTodo(); }
    });

    // 编辑弹层
    $('#colorRow').addEventListener('click', e => {
      const b = e.target.closest('.color-dot');
      if (!b) return;
      $$('.color-dot').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
    $('#fAllDay').onchange = e => { $('#timeRow').hidden = e.target.checked; };
    $('#btnSave').onclick = saveEditor;
    $('#btnDelete').onclick = () => {
      if (!editing || !editing.id) return;
      const it = items.get(editing.id);
      if (!it) return;
      if (!confirm('删除这' + (it.kind === 'event' ? '条日程' : '条待办') + '？')) return;
      removeItem(editing.id);
      closeSheet();
      toast('已删除', it.title, { icon: '🗑', ms: 2200 });
    };
    $$('[data-close]').forEach(el => { el.onclick = () => { $('#sheetWrap').hidden = true; $('#settingsWrap').hidden = true; editing = null; }; });

    // 设置面板
    $('#btnNotify').onclick = async () => {
      try {
        const p = await Notification.requestPermission();
        if (p === 'granted') { $('#btnNotify').textContent = '通知已开启'; $('#btnNotify').disabled = true; toast('已开启通知', '页面在前台时可弹系统提醒', { icon: '🔔' }); }
        else toast('未获得通知权限', '可在浏览器设置里允许通知', { icon: '⚠️' });
      } catch (e) { toast('开启失败', String(e.message || e), { icon: '⚠️' }); }
    };
    $('#btnExportIcs').onclick = exportIcs;
    $('#btnExportJson').onclick = exportJson;
    $('#btnImportJson').onclick = () => $('#fileJson').click();
    $('#fileJson').onchange = e => { const f = e.target.files[0]; if (f) importJson(f); e.target.value = ''; };
    $('#offlineHelp').onclick = e => { e.preventDefault(); openSettings(); };

    // 全局：首个点击解锁音频，便于提醒发声
    document.addEventListener('pointerdown', unlockAudio, { once: true });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { $('#sheetWrap').hidden = true; $('#settingsWrap').hidden = true; editing = null; }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !$('#sheetWrap').hidden) saveEditor();
      if (e.key === 'n' && !e.target.matches('input,textarea,select') && $('#sheetWrap').hidden && $('#settingsWrap').hidden) { $('#btnAdd').click(); }
    });

    // 回到前台时拉取一次
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickReminders(); pullAll(false); } });
    window.addEventListener('online', () => { if (online) pullAll(false); });
  }

  function quickAddTodo() {
    const inp = $('#quickTodo');
    if (!inp) return;
    const title = inp.value.trim();
    if (!title) { inp.focus(); return; }
    upsert({ id: uid(), kind: 'todo', title, due: $('#quickDue') ? $('#quickDue').value : '', priority: Number($('#quickPrio') ? $('#quickPrio').value : 2), done: false, note: '', deleted: false, updatedAt: Date.now() });
    inp.value = '';
    if ($('#quickDue')) $('#quickDue').value = '';
    render();
  }

  /* ==================== 启动 ==================== */
  function boot() {
    initTheme();
    loadLocal();
    buildColors();
    $$('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    bind();
    render();
    tickReminders();
    setInterval(tickReminders, 20000);
    connect();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
