'use strict';
/* Lead CRM — одностраничный интерфейс (без сборки и фреймворков). */

const CURRENCY = 'сум';
const COL_PAGE = 50;

const S = {
  boot: null,
  view: null,
  leadsMode: lsGet('leadsMode', 'kanban'),
  filters: {q: '', responsible_id: '', task: '', city: '', job_id: ''},
  listPage: 1,
  listSort: 'created',
  selected: new Set(),
  colLimit: {},
  taskUser: 'me',
  taskDone: false,
  anFrom: '', anTo: '',
  activeJob: null,
  lead: null,
};

// ---------------- утилиты ----------------
function lsGet(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const toLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const nowStr = () => toLocal(new Date());
const dayStr = d => toLocal(d).slice(0, 10);
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function money(n) { n = +n || 0; return n ? n.toLocaleString('ru-RU') + ' ' + CURRENCY : ''; }
function plural(n, a, b, c) { n = Math.abs(n) % 100; const m = n % 10; return n > 10 && n < 20 ? c : m > 1 && m < 5 ? b : m === 1 ? a : c; }

function relDay(dateOnly) {
  const t = new Date(), today = dayStr(t);
  const y = new Date(t); y.setDate(t.getDate() - 1);
  const tm = new Date(t); tm.setDate(t.getDate() + 1);
  if (dateOnly === today) return 'Сегодня';
  if (dateOnly === dayStr(y)) return 'Вчера';
  if (dateOnly === dayStr(tm)) return 'Завтра';
  const [Y, M, D] = dateOnly.split('-');
  return `${+D} ${MONTHS[+M - 1]}` + (+Y !== t.getFullYear() ? ' ' + Y : '');
}
function fmtTs(ts) { if (!ts) return ''; return relDay(ts.slice(0, 10)) + ' ' + ts.slice(11, 16); }

function taskChip(next) {
  if (!next) return '<span class="tchip none">Нет задач</span>';
  const n = nowStr();
  if (next < n) return `<span class="tchip over">⏰ ${esc(fmtTs(next))}</span>`;
  if (next.slice(0, 10) === n.slice(0, 10)) return `<span class="tchip today">${esc(fmtTs(next))}</span>`;
  return `<span class="tchip">${esc(fmtTs(next))}</span>`;
}

const stage = id => S.boot.stages.find(s => s.id === +id);
const userName = id => (S.boot.users.find(u => u.id === +id) || {}).name || '';
const isAdmin = () => S.boot.me.role === 'admin';
const activeUsers = () => S.boot.users.filter(u => u.active);

function userOptions(sel, withEmpty = '') {
  return (withEmpty ? `<option value="">${withEmpty}</option>` : '') +
    activeUsers().map(u => `<option value="${u.id}" ${+sel === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
}
function stageOptions(sel) {
  return S.boot.stages.map(s => `<option value="${s.id}" ${+sel === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
}

let toastT;
function toast(msg, err = false) {
  $('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 2600);
}

async function api(url, {method = 'GET', body} = {}) {
  const r = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  if (r.status === 401) { location.href = '/login'; throw new Error('auth'); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { toast(d.error || 'Ошибка ' + r.status, true); throw new Error(d.error || r.status); }
  return d;
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// модальное окно-вопрос (вместо prompt/confirm)
function ask({title, text = '', input = false, placeholder = '', ok = 'OK', danger = false}) {
  return new Promise(resolve => {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="box"><h3>${esc(title)}</h3>${text ? `<div class="muted">${esc(text)}</div>` : ''}
      ${input ? `<textarea rows="3" placeholder="${esc(placeholder)}"></textarea>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-a="no">Отмена</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="ok">${esc(ok)}</button></div></div>`;
    document.body.appendChild(m);
    const ta = $('textarea', m);
    (ta || $('[data-a=ok]', m)).focus();
    const done = v => { m.remove(); resolve(v); };
    m.onclick = e => {
      if (e.target === m || e.target.dataset.a === 'no') done(null);
      else if (e.target.dataset.a === 'ok') done(input ? ta.value.trim() : true);
    };
    m.onkeydown = e => {
      if (e.key === 'Escape') done(null);
      if (e.key === 'Enter' && (e.ctrlKey || !input)) done(input ? ta.value.trim() : true);
    };
  });
}

// ---------------- роутер ----------------
const views = {leads: viewLeads, tasks: viewTasks, analytics: viewAnalytics, parser: viewParser, settings: viewSettings};

function route() {
  const [name, arg] = (location.hash.slice(2) || 'leads').split('/');
  if (name === 'lead' && arg) {
    if (!S.view) renderView('leads');
    openLead(+arg);
    return;
  }
  closeLeadOverlay();
  renderView(views[name] ? name : 'leads');
}

function renderView(name) {
  S.view = name;
  $$('.side a[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === name));
  const c = $('#content');
  c.className = 'content';
  c.innerHTML = '';
  $('#topbar').innerHTML = '';
  views[name]();
}

function backToView() { location.hash = '#/' + (S.view || 'leads'); }

async function refreshTaskCount() {
  const tasks = await api('/api/tasks?user=me');
  const today = nowStr().slice(0, 10);
  const n = tasks.filter(t => t.due_at.slice(0, 10) <= today).length;
  const el = $('#taskcnt');
  el.hidden = !n;
  el.textContent = n;
}

// ---------------- СДЕЛКИ ----------------
function leadQuery(extra = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({...S.filters, ...extra})) if (v !== '' && v != null) p.set(k, v);
  return p;
}

function viewLeads() {
  const f = S.filters;
  $('#topbar').innerHTML = `
    <h1>Сделки</h1>
    <div class="seg"><button data-mode="kanban" class="${S.leadsMode === 'kanban' ? 'on' : ''}">Воронка</button><button data-mode="list" class="${S.leadsMode === 'list' ? 'on' : ''}">Список</button></div>
    <div class="search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input id="f_q" placeholder="Поиск: название, телефон, адрес…" value="${esc(f.q)}"></div>
    <select id="f_resp"><option value="">Все ответственные</option><option value="me" ${f.responsible_id === 'me' ? 'selected' : ''}>Мои сделки</option>
      ${activeUsers().map(u => `<option value="${u.id}" ${f.responsible_id == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      <option value="none" ${f.responsible_id === 'none' ? 'selected' : ''}>Без ответственного</option></select>
    <select id="f_task"><option value="">Все задачи</option><option value="none" ${f.task === 'none' ? 'selected' : ''}>Без задач</option><option value="overdue" ${f.task === 'overdue' ? 'selected' : ''}>Просроченные</option></select>
    <select id="f_city"><option value="">Все города</option>${S.boot.cities.map(c => `<option ${c === f.city ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    ${f.job_id ? `<span class="badge">Поиск #${esc(f.job_id)} <a href="#" id="f_job_x">✕</a></span>` : ''}
    <span class="grow"></span>
    <button class="btn" id="exportbtn" title="Скачать в Excel текущую выборку">⬇ Excel</button>
    <button class="btn btn-primary" id="newlead">+ Новая сделка</button>`;
  $$('#topbar [data-mode]').forEach(b => b.onclick = () => { S.leadsMode = b.dataset.mode; lsSet('leadsMode', S.leadsMode); viewLeads(); });
  $('#f_q').oninput = debounce(e => { f.q = e.target.value; S.listPage = 1; loadLeads(); }, 300);
  $('#f_resp').onchange = e => { f.responsible_id = e.target.value; S.listPage = 1; loadLeads(); };
  $('#f_task').onchange = e => { f.task = e.target.value; S.listPage = 1; loadLeads(); };
  $('#f_city').onchange = e => { f.city = e.target.value; S.listPage = 1; loadLeads(); };
  if (f.job_id) $('#f_job_x').onclick = e => { e.preventDefault(); f.job_id = ''; viewLeads(); };
  $('#exportbtn').onclick = () => { location.href = '/export.xlsx?' + leadQuery(); };
  $('#newlead').onclick = () => newLeadModal();
  loadLeads();
}

function loadLeads() { return S.leadsMode === 'kanban' ? loadKanban() : loadList(); }

// ---- воронка ----
async function loadKanban() {
  const d = await api('/api/leads?' + leadQuery({view: 'kanban'}));
  if (S.view !== 'leads' || S.leadsMode !== 'kanban') return;
  const c = $('#content');
  c.className = 'content kanban-wrap';
  const by = {};
  for (const l of d.items) (by[l.stage_id] ||= []).push(l);
  const scroll = $('.kanban')?.scrollLeft || 0;
  c.innerHTML = `<div class="kanban">${S.boot.stages.map(s => {
    const items = by[s.id] || [];
    const sum = items.reduce((a, l) => a + (+l.budget || 0), 0);
    const lim = S.colLimit[s.id] || COL_PAGE;
    return `<div class="col" data-stage="${s.id}">
      <div class="col-head"><div class="t" title="${esc(s.name)}">${esc(s.name)}</div>
        <div class="s">${items.length} ${plural(items.length, 'сделка', 'сделки', 'сделок')}${sum ? ': ' + money(sum) : ''}</div>
        <div class="bar" style="background:${esc(s.color)}"></div></div>
      <div class="col-body" data-stage="${s.id}">
        <button class="quick" data-stage="${s.id}">+ Быстрое добавление</button>
        ${items.slice(0, lim).map(cardHtml).join('')}
        ${items.length > lim ? `<button class="btn btn-sm more" data-more="${s.id}">Показать ещё ${items.length - lim}</button>` : ''}
      </div></div>`;
  }).join('')}</div>`;
  $('.kanban').scrollLeft = scroll;
  bindKanban();
}

function cardHtml(l) {
  const s = stage(l.stage_id);
  return `<div class="lc" draggable="true" data-id="${l.id}" style="border-left-color:${esc(s?.color || 'transparent')}">
    <span class="n">${esc(l.name || 'Без названия')}</span>
    ${l.phones ? `<div class="ph">${esc(l.phones.split(';')[0])}</div>` : ''}
    <div class="meta"><span>${esc(l.responsible_name || 'Без ответственного')}</span><span class="budget">${money(l.budget)}</span></div>
    <div class="foot">${s && s.kind !== 'open' ? `<span class="muted">${esc(fmtTs(l.closed_at || l.updated_at))}</span>` : taskChip(l.next_task)}
      <span class="muted">${esc(l.city || '')}</span></div></div>`;
}

function bindKanban() {
  const k = $('.kanban');
  k.onclick = e => {
    const card = e.target.closest('.lc');
    if (card) { location.hash = '#/lead/' + card.dataset.id; return; }
    const more = e.target.closest('[data-more]');
    if (more) { const id = more.dataset.more; S.colLimit[id] = (S.colLimit[id] || COL_PAGE) + COL_PAGE; loadKanban(); return; }
    const q = e.target.closest('.quick');
    if (q) quickForm(q);
  };
  let dragId = null;
  k.ondragstart = e => {
    const card = e.target.closest('.lc');
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  };
  k.ondragend = e => { e.target.closest('.lc')?.classList.remove('dragging'); $$('.col-body.over').forEach(x => x.classList.remove('over')); };
  k.ondragover = e => {
    const body = e.target.closest('.col-body');
    if (!body || !dragId) return;
    e.preventDefault();
    $$('.col-body.over').forEach(x => x !== body && x.classList.remove('over'));
    body.classList.add('over');
  };
  k.ondrop = async e => {
    const body = e.target.closest('.col-body');
    if (!body || !dragId) return;
    e.preventDefault();
    body.classList.remove('over');
    const id = dragId; dragId = null;
    const card = $(`.lc[data-id="${id}"]`);
    if (card.closest('.col-body') === body) return;
    await moveLead(id, +body.dataset.stage, () => { body.insertBefore(card, body.querySelector('.lc')); });
    loadKanban();
  };
}

// смена этапа с вопросом о причине при закрытии «не реализовано»
async function moveLead(id, stageId, optimistic) {
  const st = stage(stageId);
  let reason = null;
  if (st.kind === 'lost') {
    reason = await ask({title: 'Причина отказа', input: true, placeholder: 'Например: дорого, уже есть подрядчик…', ok: 'Закрыть сделку'});
    if (reason === null) return false;
  }
  optimistic && optimistic();
  await api('/api/leads/' + id, {method: 'PATCH', body: {stage_id: stageId}});
  if (reason) await api(`/api/leads/${id}/notes`, {method: 'POST', body: {text: 'Причина отказа: ' + reason}});
  if (st.kind === 'won') toast('🎉 Сделка успешно реализована!');
  return true;
}

function quickForm(btn) {
  const sid = btn.dataset.stage;
  const f = document.createElement('form');
  f.className = 'quick-form';
  f.innerHTML = `<input name="name" placeholder="Название" required>
    <input name="phones" placeholder="Телефон">
    <div class="row"><input name="budget" placeholder="Бюджет" inputmode="numeric"><button class="btn btn-primary btn-sm">Добавить</button></div>`;
  btn.replaceWith(f);
  f.name.focus();
  f.onsubmit = async e => {
    e.preventDefault();
    await api('/api/leads', {method: 'POST', body: {name: f.name.value, phones: f.phones.value, budget: f.budget.value, stage_id: sid}});
    loadKanban();
  };
  f.onkeydown = e => { if (e.key === 'Escape') loadKanban(); };
}

async function newLeadModal() {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<form class="box"><h3>Новая сделка</h3>
    <input name="name" placeholder="Название компании / сделки" required>
    <input name="contact_person" placeholder="Контактное лицо">
    <input name="phones" placeholder="Телефон">
    <input name="budget" placeholder="Бюджет" inputmode="numeric">
    <select name="stage_id">${stageOptions(S.boot.stages[0]?.id)}</select>
    <select name="responsible_id">${userOptions(S.boot.me.id)}</select>
    <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn" data-x>Отмена</button><button class="btn btn-primary">Создать</button></div></form>`;
  document.body.appendChild(m);
  const f = $('form', m);
  f.name.focus();
  m.onclick = e => { if (e.target === m || e.target.hasAttribute('data-x')) m.remove(); };
  f.onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    const r = await api('/api/leads', {method: 'POST', body});
    m.remove();
    location.hash = '#/lead/' + r.id;
  };
}

// ---- список ----
async function loadList() {
  const d = await api('/api/leads?' + leadQuery({page: S.listPage, sort: S.listSort}));
  if (S.view !== 'leads' || S.leadsMode !== 'list') return;
  const c = $('#content');
  c.className = 'content';
  const pages = Math.max(1, Math.ceil(d.total / d.size));
  const ids = d.items.map(l => l.id);
  const allOn = ids.length && ids.every(i => S.selected.has(i));
  c.innerHTML = `
    ${S.selected.size ? `<div class="bulk"><b>Выбрано: ${S.selected.size}</b>
      <select id="b_stage"><option value="">Сменить этап…</option>${stageOptions()}</select>
      <select id="b_resp"><option value="">Сменить ответственного…</option>${userOptions()}</select>
      <button class="btn btn-sm btn-danger" id="b_del">Удалить</button>
      <button class="btn btn-sm btn-ghost" id="b_clear">Снять выделение</button></div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap">
      <span class="muted">${d.total} ${plural(d.total, 'сделка', 'сделки', 'сделок')}</span>
      <label class="muted small">Сортировка: <select id="l_sort" style="width:auto">
        <option value="created">Сначала новые</option><option value="updated">Недавно изменённые</option>
        <option value="budget">По бюджету</option><option value="name">По названию</option></select></label></div>
    <div class="tbl-wrap"><table>
      <thead><tr><th style="width:30px"><input type="checkbox" id="l_all" ${allOn ? 'checked' : ''}></th>
        <th>Название</th><th>Этап</th><th>Бюджет</th><th>Ответственный</th><th>Телефон</th><th>Город</th><th>Задача</th><th>Создана</th></tr></thead>
      <tbody>${d.items.map(l => {
        const s = stage(l.stage_id);
        return `<tr class="clk" data-id="${l.id}">
          <td><input type="checkbox" class="l_chk" ${S.selected.has(l.id) ? 'checked' : ''}></td>
          <td><b>${esc(l.name)}</b><div class="muted small">${esc(l.yandex_category || l.contact_person || '')}</div></td>
          <td><span class="pill" style="background:${esc(s?.color || '#eee')}">${esc(s?.name || '—')}</span></td>
          <td>${money(l.budget) || '<span class="muted">—</span>'}</td>
          <td>${esc(l.responsible_name || '—')}</td>
          <td>${esc((l.phones || '').split(';')[0]) || '<span class="muted">—</span>'}</td>
          <td>${esc(l.city || '')}</td>
          <td>${s && s.kind !== 'open' ? '' : taskChip(l.next_task)}</td>
          <td class="muted small">${esc(fmtTs(l.created_at))}</td></tr>`;
      }).join('')}</tbody></table>
      ${d.items.length ? '' : '<div class="empty">Ничего не найдено</div>'}</div>
    <div class="pager"><button class="btn btn-sm" id="l_prev" ${S.listPage <= 1 ? 'disabled' : ''}>←</button>
      <span class="muted">${S.listPage} / ${pages}</span><button class="btn btn-sm" id="l_next" ${S.listPage >= pages ? 'disabled' : ''}>→</button></div>`;
  $('#l_sort').value = S.listSort;
  $('#l_sort').onchange = e => { S.listSort = e.target.value; loadList(); };
  $('#l_prev').onclick = () => { S.listPage--; loadList(); };
  $('#l_next').onclick = () => { S.listPage++; loadList(); };
  $('#l_all').onchange = e => { ids.forEach(i => e.target.checked ? S.selected.add(i) : S.selected.delete(i)); loadList(); };
  $('tbody', c).onclick = e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const id = +tr.dataset.id;
    if (e.target.classList.contains('l_chk')) { e.target.checked ? S.selected.add(id) : S.selected.delete(id); loadList(); return; }
    location.hash = '#/lead/' + id;
  };
  if (S.selected.size) {
    const bulk = async (action, value) => {
      await api('/api/leads/bulk', {method: 'POST', body: {ids: [...S.selected], action, value}});
      S.selected.clear(); toast('Готово'); loadList();
    };
    $('#b_stage').onchange = e => e.target.value && bulk('stage', e.target.value);
    $('#b_resp').onchange = e => e.target.value && bulk('responsible', e.target.value);
    $('#b_del').onclick = async () => {
      if (await ask({title: `Удалить ${S.selected.size} ${plural(S.selected.size, 'сделку', 'сделки', 'сделок')}?`, text: 'Вместе с историей и задачами. Отменить нельзя.', ok: 'Удалить', danger: true})) bulk('delete');
    };
    $('#b_clear').onclick = () => { S.selected.clear(); loadList(); };
  }
}

// ---------------- КАРТОЧКА СДЕЛКИ ----------------
function closeLeadOverlay() { $('#overlay-root').innerHTML = ''; S.lead = null; }

async function openLead(id) {
  let d;
  try { d = await api('/api/leads/' + id); } catch { backToView(); return; }
  S.lead = d;
  const root = $('#overlay-root');
  root.innerHTML = `<div class="overlay"><div class="lead"><div class="lead-left"></div>
    <div class="lead-right"><div class="feed"></div><div class="ptasks"></div><div class="composer"></div></div></div></div>`;
  $('.overlay').onclick = e => { if (e.target.classList.contains('overlay')) backToView(); };
  document.onkeydown = e => { if (e.key === 'Escape' && S.lead && !$('.modal')) backToView(); };
  renderLeadLeft();
  renderFeed();
  renderComposer();
}

async function reloadLead(left = false) {
  if (!S.lead) return;
  S.lead = await api('/api/leads/' + S.lead.lead.id);
  if (left) renderLeadLeft();
  renderFeed();
}

function fieldRow(key, label, val, type = 'text') {
  return `<div class="f"><label>${label}</label><input data-k="${key}" type="${type}" value="${esc(val ?? '')}" placeholder="…"></div>`;
}

function renderLeadLeft() {
  const l = S.lead.lead;
  const cur = stage(l.stage_id);
  const prog = S.boot.stages.filter(s => s.kind !== 'lost');
  const curIdx = prog.findIndex(s => s.id === l.stage_id);
  const phones = (l.phones || '').split(';').map(p => p.trim()).filter(Boolean);
  const el = $('.lead-left');
  el.innerHTML = `
    <div class="lead-head">
      <div class="top"><button class="close" title="Закрыть (Esc)">←</button><span class="id">Сделка #${l.id}</span></div>
      <input class="title" data-k="name" value="${esc(l.name)}">
      <div class="progress">${prog.map((s, i) => `<span title="${esc(s.name)}" data-stage="${s.id}"
        style="${cur?.kind === 'lost' ? '' : i <= curIdx ? 'background:' + esc(cur.color) : ''}"></span>`).join('')}</div>
      <select id="ld_stage">${stageOptions(l.stage_id)}</select>
      <div class="since">На этапе с ${esc(fmtTs(l.stage_changed_at || l.created_at))}</div>
    </div>
    <div class="fields">
      <div class="f"><label>Ответственный</label><select data-k="responsible_id">${userOptions(l.responsible_id, 'Не назначен')}</select></div>
      ${fieldRow('budget', 'Бюджет, ' + CURRENCY, l.budget || '', 'text')}
      ${fieldRow('tags', 'Теги', l.tags)}
      <div class="sect">Контакт</div>
      ${fieldRow('contact_person', 'Контактное лицо', l.contact_person)}
      ${fieldRow('phones', 'Телефон', l.phones)}
      ${phones.length ? `<div class="f"><span></span><div class="links">${phones.map(p => {
        const digits = p.replace(/[^\d]/g, '');
        return `<a href="tel:${esc(p.replace(/[^+\d]/g, ''))}">📞 ${esc(p)}</a><a href="https://wa.me/${esc(digits)}" target="_blank" rel="noopener">WhatsApp</a>`;
      }).join('')}</div></div>` : ''}
      ${fieldRow('email', 'Email', l.email, 'email')}
      <div class="sect">Компания</div>
      ${fieldRow('city', 'Город', l.city)}
      ${fieldRow('address', 'Адрес', l.address)}
      ${fieldRow('yandex_category', 'Рубрика', l.yandex_category)}
      ${fieldRow('website', 'Сайт', l.website)}
      <div class="sect">Источник</div>
      <div class="f"><label>Источник</label><span style="padding:0 8px">${esc(l.source || '—')}</span></div>
      ${l.rating ? `<div class="f"><label>Рейтинг</label><span style="padding:0 8px">★ ${esc(l.rating)}${l.reviews ? ` · ${esc(l.reviews)} ${plural(+l.reviews, 'отзыв', 'отзыва', 'отзывов')}` : ''}</span></div>` : ''}
      ${l.url ? `<div class="f"><label>Яндекс.Карты</label><a style="padding:0 8px" href="${esc(l.url)}" target="_blank" rel="noopener">Открыть карточку ↗</a></div>` : ''}
      <div class="f"><label>Создана</label><span style="padding:0 8px" class="muted">${esc(fmtTs(l.created_at))}</span></div>
    </div>
    <div class="lead-actions"><button class="btn btn-danger btn-sm" id="ld_del">Удалить сделку</button></div>`;

  $('.close', el).onclick = backToView;
  const setStage = async sid => {
    if (+sid === l.stage_id) return;
    if (await moveLead(l.id, +sid)) reloadLead(true);
    else $('#ld_stage').value = l.stage_id;
  };
  $('#ld_stage').onchange = e => setStage(e.target.value);
  $$('.progress span', el).forEach(sp => sp.onclick = () => setStage(sp.dataset.stage));
  $$('[data-k]', el).forEach(inp => inp.onchange = async () => {
    const r = await api('/api/leads/' + l.id, {method: 'PATCH', body: {[inp.dataset.k]: inp.value}});
    S.lead.lead = r.lead;
    toast('Сохранено');
    if (['phones', 'budget'].includes(inp.dataset.k)) renderLeadLeft();
    reloadLead();
  });
  $('.title', el).onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
  $('#ld_del').onclick = async () => {
    if (!await ask({title: 'Удалить сделку?', text: 'История и задачи тоже удалятся. Отменить нельзя.', ok: 'Удалить', danger: true})) return;
    await api('/api/leads/' + l.id, {method: 'DELETE'});
    toast('Сделка удалена');
    backToView();
  };
}

const EV_ICON = {note: '📝', stage: '➜', task_done: '✔', field: '✎', system: '⚙'};

function renderFeed() {
  const {events, tasks} = S.lead;
  const feed = $('.feed');
  const sorted = [...events].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  let lastDay = '';
  feed.innerHTML = sorted.map(e => {
    const day = e.created_at.slice(0, 10);
    const div = day !== lastDay ? `<div class="day"><span>${esc(relDay(day))}</span></div>` : '';
    lastDay = day;
    const sys = ['stage', 'field', 'system'].includes(e.kind);
    return div + `<div class="ev ${e.kind} ${sys ? 'sys' : ''}"><div class="ic">${EV_ICON[e.kind] || '•'}</div><div class="bd">
      ${sys ? `<span>${esc(e.created_at.slice(11, 16))} · ${e.user_name ? esc(e.user_name) + ': ' : ''}${esc(e.text)}</span>` :
      `<div class="who"><span><b>${esc(e.user_name || 'Система')}</b> · ${esc(e.created_at.slice(11, 16))}</span>
        ${e.kind === 'note' && (e.user_id === S.boot.me.id || isAdmin()) ? `<button class="del" data-ev="${e.id}" title="Удалить">✕</button>` : ''}</div>
       <div class="tx">${esc(e.text)}</div>`}</div></div>`;
  }).join('') || '<div class="empty">История пуста</div>';
  $$('[data-ev]', feed).forEach(b => b.onclick = async () => {
    await api('/api/events/' + b.dataset.ev, {method: 'DELETE'});
    reloadLead();
  });
  feed.scrollTop = feed.scrollHeight;

  const pending = tasks.filter(t => !t.done).sort((a, b) => a.due_at.localeCompare(b.due_at));
  const n = nowStr();
  const pt = $('.ptasks');
  pt.innerHTML = pending.map(t => `<div class="ptask ${t.due_at < n ? 'over' : ''}" data-t="${t.id}">
    <div class="body"><div><span class="due">${esc(fmtTs(t.due_at))}</span> · ${esc(S.boot.task_kinds[t.kind] || 'Задача')} · <span class="muted">для ${esc(t.user_name || '—')}</span></div>
      ${t.text ? `<div>${esc(t.text)}</div>` : ''}
      <div class="done-form" hidden><input placeholder="Результат (необязательно)"><button class="btn btn-primary btn-sm" data-ok>Готово</button></div></div>
    <button class="btn btn-sm" data-done>Выполнить</button><button class="btn btn-sm btn-ghost" data-tdel title="Удалить задачу">✕</button></div>`).join('');
  $$('.ptask', pt).forEach(row => {
    const id = row.dataset.t, form = $('.done-form', row), inp = $('input', form);
    const finish = async () => {
      await api('/api/tasks/' + id, {method: 'PATCH', body: {done: true, result: inp.value}});
      toast('Задача выполнена'); reloadLead(); refreshTaskCount();
    };
    $('[data-done]', row).onclick = () => { form.hidden = false; inp.focus(); };
    $('[data-ok]', row).onclick = finish;
    inp.onkeydown = e => { if (e.key === 'Enter') finish(); };
    $('[data-tdel]', row).onclick = async () => { await api('/api/tasks/' + id, {method: 'DELETE'}); reloadLead(); refreshTaskCount(); };
  });
}

function quickDue(kind) {
  const d = new Date();
  if (kind === '1h') d.setHours(d.getHours() + 1, 0);
  if (kind === 'today') d.setHours(18, 0);
  if (kind === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(10, 0); }
  if (kind === '3d') { d.setDate(d.getDate() + 3); d.setHours(10, 0); }
  if (kind === 'week') { d.setDate(d.getDate() + 7); d.setHours(10, 0); }
  return toLocal(d).replace(' ', 'T');
}

function renderComposer(tab = 'note') {
  const c = $('.composer');
  const l = S.lead.lead;
  c.innerHTML = `<div class="tabs"><button data-tab="note" class="${tab === 'note' ? 'on' : ''}">Примечание</button>
    <button data-tab="task" class="${tab === 'task' ? 'on' : ''}">Задача</button></div>
    ${tab === 'note' ? `<textarea id="cm_text" rows="2" placeholder="Напишите примечание… (Ctrl+Enter — отправить)"></textarea>
      <div class="send"><button class="btn btn-primary" id="cm_send">Добавить</button></div>` : `
      <div class="row"><select id="tk_kind">${Object.entries(S.boot.task_kinds).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <input type="datetime-local" id="tk_due" value="${quickDue('tomorrow')}">
        <span class="muted small">для</span><select id="tk_user">${userOptions(l.responsible_id || S.boot.me.id)}</select></div>
      <div class="row chips"><button data-q="1h">Через час</button><button data-q="today">Сегодня 18:00</button><button data-q="tomorrow">Завтра</button><button data-q="3d">Через 3 дня</button><button data-q="week">Через неделю</button></div>
      <textarea id="cm_text" rows="2" placeholder="Что нужно сделать? Например: перезвонить, отправить КП"></textarea>
      <div class="send"><button class="btn btn-primary" id="cm_send">Поставить задачу</button></div>`}`;
  $$('[data-tab]', c).forEach(b => b.onclick = () => renderComposer(b.dataset.tab));
  $$('[data-q]', c).forEach(b => b.onclick = () => { $('#tk_due').value = quickDue(b.dataset.q); });
  const send = async () => {
    const text = $('#cm_text').value.trim();
    if (tab === 'note') {
      if (!text) return;
      await api(`/api/leads/${l.id}/notes`, {method: 'POST', body: {text}});
    } else {
      await api(`/api/leads/${l.id}/tasks`, {method: 'POST', body: {kind: $('#tk_kind').value, due_at: $('#tk_due').value, user_id: $('#tk_user').value, text}});
      toast('Задача поставлена');
      refreshTaskCount();
    }
    $('#cm_text').value = '';
    reloadLead();
  };
  $('#cm_send').onclick = send;
  $('#cm_text').onkeydown = e => { if (e.key === 'Enter' && e.ctrlKey) send(); };
}

// ---------------- ЗАДАЧИ ----------------
function viewTasks() {
  $('#topbar').innerHTML = `<h1>Задачи</h1>
    <div class="seg"><button data-d="0" class="${!S.taskDone ? 'on' : ''}">Активные</button><button data-d="1" class="${S.taskDone ? 'on' : ''}">Выполненные</button></div>
    <select id="t_user"><option value="me">Мои задачи</option><option value="all" ${S.taskUser === 'all' ? 'selected' : ''}>Все задачи</option>
      ${activeUsers().filter(u => u.id !== S.boot.me.id).map(u => `<option value="${u.id}" ${S.taskUser == u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
  $$('[data-d]').forEach(b => b.onclick = () => { S.taskDone = b.dataset.d === '1'; viewTasks(); });
  $('#t_user').onchange = e => { S.taskUser = e.target.value; loadTasks(); };
  loadTasks();
}

async function loadTasks() {
  const tasks = await api(`/api/tasks?user=${S.taskUser}&done=${S.taskDone ? 1 : 0}`);
  if (S.view !== 'tasks') return;
  const c = $('#content');
  if (!tasks.length) { c.innerHTML = `<div class="empty">${S.taskDone ? 'Выполненных задач пока нет' : 'Задач нет 🎉 Поставьте задачу в карточке сделки'}</div>`; return; }
  const row = t => `<div class="trow" data-t="${t.id}" data-lead="${t.lead_id}">
    ${S.taskDone ? '<span>✔</span>' : '<button class="chk" title="Выполнить"></button>'}
    <span class="when">${esc(S.taskDone ? fmtTs(t.done_at) : fmtTs(t.due_at))}</span>
    <div class="what"><b>${esc(S.boot.task_kinds[t.kind] || 'Задача')}${t.text ? ': ' + esc(t.text) : ''}</b>
      <a href="#/lead/${t.lead_id}">${esc(t.lead_name)}</a> <span class="muted small">${esc((t.lead_phones || '').split(';')[0])}</span>
      ${t.result ? `<div class="muted small">Результат: ${esc(t.result)}</div>` : ''}</div>
    <span class="r muted small">${esc(t.user_name || '')}<br><span class="pill" style="background:${esc(t.stage_color || '#eee')}">${esc(t.stage_name || '')}</span></span>
    <div class="res" hidden><input placeholder="Результат (необязательно), Enter — выполнить"><button class="btn btn-primary btn-sm">Готово</button></div></div>`;
  if (S.taskDone) { c.innerHTML = `<div class="tgroup">${tasks.map(row).join('')}</div>`; }
  else {
    const n = nowStr(), today = n.slice(0, 10);
    const tm = new Date(); tm.setDate(tm.getDate() + 1);
    const tomorrow = dayStr(tm);
    const groups = [
      ['over', 'Просрочены', tasks.filter(t => t.due_at < n)],
      ['', 'Сегодня', tasks.filter(t => t.due_at >= n && t.due_at.slice(0, 10) === today)],
      ['', 'Завтра', tasks.filter(t => t.due_at.slice(0, 10) === tomorrow)],
      ['', 'Позже', tasks.filter(t => t.due_at.slice(0, 10) > tomorrow)],
    ];
    c.innerHTML = groups.filter(g => g[2].length).map(([cls, title, list]) =>
      `<div class="tgroup ${cls}"><h4>${title} <span class="c">${list.length}</span></h4>${list.map(row).join('')}</div>`).join('');
  }
  $$('.trow', c).forEach(r => {
    const chk = $('.chk', r); if (!chk) return;
    const res = $('.res', r), inp = $('input', res);
    const finish = async () => {
      await api('/api/tasks/' + r.dataset.t, {method: 'PATCH', body: {done: true, result: inp.value}});
      toast('Задача выполнена'); refreshTaskCount(); loadTasks();
    };
    chk.onclick = () => { res.hidden = false; inp.focus(); };
    $('button', res).onclick = finish;
    inp.onkeydown = e => { if (e.key === 'Enter') finish(); if (e.key === 'Escape') res.hidden = true; };
  });
}

// ---------------- АНАЛИТИКА ----------------
function viewAnalytics() {
  const t = new Date();
  if (!S.anFrom) { S.anFrom = dayStr(new Date(t.getFullYear(), t.getMonth(), 1)); S.anTo = dayStr(t); }
  $('#topbar').innerHTML = `<h1>Аналитика</h1>
    <input type="date" id="a_from" value="${S.anFrom}" style="width:auto"> — <input type="date" id="a_to" value="${S.anTo}" style="width:auto">
    <div class="seg"><button data-p="today">Сегодня</button><button data-p="week">7 дней</button><button data-p="month">Месяц</button><button data-p="year">Год</button></div>`;
  $('#a_from').onchange = e => { S.anFrom = e.target.value; loadAnalytics(); };
  $('#a_to').onchange = e => { S.anTo = e.target.value; loadAnalytics(); };
  $$('[data-p]').forEach(b => b.onclick = () => {
    const now = new Date(), from = new Date();
    if (b.dataset.p === 'week') from.setDate(now.getDate() - 6);
    if (b.dataset.p === 'month') from.setDate(1);
    if (b.dataset.p === 'year') from.setMonth(0, 1);
    S.anFrom = dayStr(from); S.anTo = dayStr(now);
    viewAnalytics();
  });
  loadAnalytics();
}

async function loadAnalytics() {
  const d = await api(`/api/analytics?from=${S.anFrom}&to=${S.anTo}`);
  if (S.view !== 'analytics') return;
  const maxN = Math.max(1, ...d.funnel.map(f => f.n));
  const inWork = d.funnel.filter(f => f.kind === 'open');
  const days = [];
  for (let x = new Date(S.anFrom); dayStr(x) <= S.anTo && days.length < 400; x.setDate(x.getDate() + 1)) days.push(dayStr(x));
  const dmap = Object.fromEntries(d.daily.map(r => [r.d, r.n]));
  const maxD = Math.max(1, ...d.daily.map(r => r.n));
  $('#content').innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="l">Новых сделок</div><div class="v">${d.created}</div><div class="s">за период</div></div>
      <div class="kpi"><div class="l">В работе сейчас</div><div class="v">${inWork.reduce((a, f) => a + f.n, 0)}</div><div class="s">${money(inWork.reduce((a, f) => a + f.budget, 0)) || '&nbsp;'}</div></div>
      <div class="kpi"><div class="l">Успешно</div><div class="v" style="color:var(--green)">${d.won.n}</div><div class="s">${money(d.won.budget) || '&nbsp;'}</div></div>
      <div class="kpi"><div class="l">Не реализовано</div><div class="v" style="color:var(--red)">${d.lost.n}</div><div class="s">за период</div></div>
      <div class="kpi"><div class="l">Конверсия в успех</div><div class="v">${d.conversion == null ? '—' : d.conversion + '%'}</div><div class="s">из закрытых сделок</div></div>
      <div class="kpi"><div class="l">Сделок без задач</div><div class="v" style="color:${d.no_tasks ? 'var(--orange)' : 'inherit'}">${d.no_tasks}</div><div class="s"><a href="#/leads" id="a_notask">показать</a></div></div>
    </div>
    <div class="grid2">
      <div class="panel funnel"><h3>Воронка (сейчас)</h3>${d.funnel.map(f => `<div class="fr"><span>${esc(f.name)}</span>
        <div><div class="fb" style="width:${Math.round(f.n / maxN * 100)}%;background:${esc(f.color)}"></div></div>
        <span class="fv"><b>${f.n}</b> ${f.budget ? '· ' + money(f.budget) : ''}</span></div>`).join('')}</div>
      <div class="panel"><h3>Новые сделки по дням</h3>
        <div class="chart">${days.map(x => `<div title="${relDay(x)}: ${dmap[x] || 0}" style="height:${(dmap[x] || 0) / maxD * 100}%"></div>`).join('')}</div>
        <div style="display:flex;justify-content:space-between" class="muted small"><span>${relDay(S.anFrom)}</span><span>${relDay(S.anTo)}</span></div></div>
    </div>
    <div class="panel"><h3>Менеджеры</h3><div class="tbl-wrap" style="box-shadow:none"><table>
      <thead><tr><th>Менеджер</th><th>В работе</th><th>Успешно</th><th>Сумма успешных</th><th>Отказ</th><th>Задач выполнено</th><th>Просрочено задач</th><th>Примечаний</th></tr></thead>
      <tbody>${d.managers.map(m => `<tr><td><b>${esc(m.name)}</b></td><td>${m.in_work}</td><td>${m.won}</td><td>${money(m.won_budget) || '—'}</td><td>${m.lost}</td>
        <td>${m.tasks_done}</td><td style="color:${m.tasks_overdue ? 'var(--red)' : 'inherit'}">${m.tasks_overdue}</td><td>${m.notes}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#a_notask').onclick = () => { S.filters.task = 'none'; };
}

// ---------------- ПАРСЕР ----------------
const JSTAT = {queued: 'В очереди', running: 'Идёт парсинг', captcha: 'Нужна капча', done: 'Готово', stopped: 'Остановлено', error: 'Ошибка'};
let pollT;

function viewParser() {
  $('#topbar').innerHTML = '<h1>Парсер Яндекс.Карт</h1><span class="muted">Новые компании попадают в этап «' + esc(S.boot.stages[0]?.name || '') + '» и назначаются на вас</span>';
  if (!S.boot.parser_enabled) {
    $('#content').innerHTML = `<div class="panel"><h3>Парсер запускается на компьютере</h3>
      <p class="muted" style="margin:0">Яндекс.Карты пускают только настоящий браузер, поэтому парсер не работает в облаке.
      Запустите <b>python app.py</b> на компьютере с Edge (с тем же DATABASE_URL в файле .env), откройте http://127.0.0.1:5000 →
      «Парсер». Найденные компании сразу появятся здесь в этапе «${esc(S.boot.stages[0]?.name || '')}».</p></div>
      <div class="panel"><h3>История поисков</h3><div id="jobs"></div></div>`;
    loadJobs();
    return;
  }
  $('#content').innerHTML = `
    <div class="panel"><h3>Новый поиск</h3>
      <form id="pform"><div class="form-grid">
        <div><span class="lbl">Категории (по одной в строке)</span><textarea id="p_cat" rows="3" placeholder="частная школа&#10;стоматология&#10;автосервис"></textarea></div>
        <div><span class="lbl">Город</span><select id="p_city">${S.boot.city_presets.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}<option value="">Другой (по ссылке)…</option></select>
          <div id="p_custom" hidden style="margin-top:6px;display:grid;gap:6px"><input id="p_url" placeholder="https://yandex.ru/maps/10335/tashkent/…"><input id="p_cname" placeholder="Название города"></div></div>
        <div><span class="lbl">Карточек на категорию</span><input id="p_max" type="number" min="1" max="300" value="60"><div class="muted small" style="margin-top:4px">≈3 сек на карточку</div></div>
        <div><button class="btn btn-primary">Найти</button></div></div>
        <label style="display:flex;gap:6px;align-items:center;margin-top:10px"><input type="checkbox" id="p_nosite" checked> Только компании без сайта</label>
        <div class="muted small" style="margin-top:6px">Откроется окно Edge — не закрывайте его. Если Яндекс покажет капчу, решите её там и нажмите «Капча пройдена» здесь.</div>
      </form></div>
    <div class="panel" id="jobpanel" hidden></div>
    <div class="panel"><h3>История поисков</h3><div id="jobs"></div></div>`;
  $('#p_city').onchange = e => { $('#p_custom').hidden = e.target.value !== ''; };
  $('#pform').onsubmit = async e => {
    e.preventDefault();
    const custom = $('#p_city').value === '';
    const r = await api('/api/jobs', {method: 'POST', body: {
      categories: $('#p_cat').value, city_id: $('#p_city').value, city_url: custom ? $('#p_url').value : '',
      city_name: $('#p_cname').value, max_results: $('#p_max').value, only_no_site: $('#p_nosite').checked}});
    S.activeJob = r.id;
    toast('Поиск запущен');
    pollJob(); loadJobs();
  };
  loadJobs().then(() => S.activeJob && pollJob());
}

async function loadJobs() {
  const js = await api('/api/jobs');
  if (S.view !== 'parser') return;
  const live = js.find(j => ['queued', 'running', 'captcha'].includes(j.status));
  if (live && !S.activeJob) S.activeJob = live.id;
  $('#jobs').innerHTML = js.length ? `<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th>#</th><th>Категории</th><th>Город</th><th>Статус</th><th>Новых сделок</th><th>Запущен</th><th></th></tr></thead><tbody>
    ${js.map(j => `<tr><td>${j.id}</td><td>${esc(j.params.categories.join(', '))}</td><td>${esc(j.params.city.name)}</td>
      <td><span class="badge b-${j.status}">${JSTAT[j.status] || j.status}</span></td><td><b>${j.found}</b> <span class="muted small">из ${j.processed}</span></td>
      <td class="muted small">${esc(fmtTs(j.created_at))}</td><td>${j.found ? `<a href="#" data-job="${j.id}">Показать сделки</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="muted">Пока нет запусков</div>';
  $$('[data-job]').forEach(a => a.onclick = e => {
    e.preventDefault();
    Object.assign(S.filters, {job_id: a.dataset.job, q: '', responsible_id: '', task: '', city: ''});
    S.leadsMode = 'list'; S.listPage = 1;
    location.hash = '#/leads';
  });
}

async function pollJob() {
  clearTimeout(pollT);
  if (!S.activeJob || S.view !== 'parser') return;
  const j = await api('/api/jobs/' + S.activeJob);
  if (S.view !== 'parser') return;
  const live = ['queued', 'running', 'captcha'].includes(j.status);
  const p = $('#jobpanel');
  const logEl = $('.log', p), atBottom = !logEl || logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  p.hidden = false;
  p.innerHTML = `<h3>Поиск #${j.id} <span class="badge b-${j.status}">${JSTAT[j.status] || j.status}</span></h3>
    <div class="muted">Обработано ${j.processed} из ${j.total || '…'} · новых сделок: <b>${j.found}</b>${j.error ? ' · ' + esc(j.error) : ''}</div>
    <div class="pbar"><i style="width:${j.total ? Math.round(j.processed / j.total * 100) : 0}%"></i></div>
    ${j.status === 'captcha' ? '<div class="warn">⚠ Яндекс показал капчу. Решите её в окне браузера. <button class="btn btn-primary btn-sm" id="j_cap">Капча пройдена</button></div>' : ''}
    <div class="log">${esc((j.logs || []).join('\n')) || 'Журнал появится после запуска…'}</div>
    ${live ? '<div style="margin-top:10px"><button class="btn btn-danger btn-sm" id="j_stop">Остановить</button></div>' : ''}`;
  const lg = $('.log', p);
  if (atBottom) lg.scrollTop = lg.scrollHeight;
  if ($('#j_cap')) $('#j_cap').onclick = async () => { await api(`/api/jobs/${j.id}/captcha`, {method: 'POST'}); pollJob(); };
  if ($('#j_stop')) $('#j_stop').onclick = async () => { await api(`/api/jobs/${j.id}/stop`, {method: 'POST'}); pollJob(); };
  if (live) pollT = setTimeout(() => { pollJob(); loadJobs(); }, 1500);
  else { loadJobs(); bootstrap(); }
}

// ---------------- НАСТРОЙКИ ----------------
function viewSettings() {
  $('#topbar').innerHTML = '<h1>Настройки</h1>';
  const c = $('#content');
  c.innerHTML = `${isAdmin() ? `
    <div class="panel"><h3>Этапы воронки</h3><div id="stages"></div>
      <form id="st_add" style="display:flex;gap:8px;margin-top:10px"><input type="color" id="st_color" value="#8fd3ff"><input id="st_name" placeholder="Новый этап" style="max-width:300px"><button class="btn">+ Добавить этап</button></form></div>
    <div class="panel"><h3>Пользователи</h3><div id="users"></div>
      <form id="u_add" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <input name="name" placeholder="Имя" required style="max-width:200px"><input name="login" placeholder="Логин" required style="max-width:160px">
        <input name="password" type="password" placeholder="Пароль (от 6)" required minlength="6" style="max-width:180px">
        <select name="role" style="width:auto"><option value="manager">Менеджер</option><option value="admin">Администратор</option></select>
        <button class="btn btn-primary">Добавить</button></form></div>` : ''}
    <div class="panel"><h3>Мой пароль</h3>
      <form id="pw" style="display:flex;gap:8px;flex-wrap:wrap"><input type="password" name="old" placeholder="Текущий пароль" required style="max-width:200px">
        <input type="password" name="new" placeholder="Новый пароль" required minlength="6" style="max-width:200px"><button class="btn">Сменить</button></form></div>`;
  $('#pw').onsubmit = async e => {
    e.preventDefault();
    await api('/api/me/password', {method: 'POST', body: Object.fromEntries(new FormData(e.target))});
    e.target.reset(); toast('Пароль изменён');
  };
  if (!isAdmin()) return;
  renderStages();
  loadUsers();
  $('#st_add').onsubmit = async e => {
    e.preventDefault();
    await api('/api/stages', {method: 'POST', body: {name: $('#st_name').value, color: $('#st_color').value}});
    await bootstrap(); renderStages();
  };
  $('#u_add').onsubmit = async e => {
    e.preventDefault();
    await api('/api/users', {method: 'POST', body: Object.fromEntries(new FormData(e.target))});
    e.target.reset(); toast('Пользователь добавлен'); await bootstrap(); loadUsers();
  };
}

function renderStages() {
  const KIND = {open: '', won: '<span class="badge b-done">успех</span>', lost: '<span class="badge b-error">отказ</span>'};
  const list = S.boot.stages;
  $('#stages').innerHTML = list.map((s, i) => `<div class="srow" data-id="${s.id}">
    <input type="color" value="${esc(s.color)}" data-f="color"><input type="text" value="${esc(s.name)}" data-f="name">${KIND[s.kind]}
    <button class="btn btn-sm btn-ghost" data-mv="-1" ${i === 0 ? 'disabled' : ''}>↑</button><button class="btn btn-sm btn-ghost" data-mv="1" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
    ${s.kind === 'open' ? '<button class="btn btn-sm btn-ghost btn-danger" data-del>✕</button>' : '<span style="width:34px"></span>'}</div>`).join('');
  $$('#stages .srow').forEach(r => {
    const id = +r.dataset.id;
    $$('[data-f]', r).forEach(inp => inp.onchange = async () => {
      await api('/api/stages/' + id, {method: 'PATCH', body: {[inp.dataset.f]: inp.value}});
      await bootstrap(); toast('Сохранено');
    });
    $$('[data-mv]', r).forEach(b => b.onclick = async () => {
      const ids = list.map(s => s.id), i = ids.indexOf(id), j = i + +b.dataset.mv;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await api('/api/stages/order', {method: 'PUT', body: {ids}});
      await bootstrap(); renderStages();
    });
    const del = $('[data-del]', r);
    if (del) del.onclick = async () => {
      if (!await ask({title: 'Удалить этап?', text: `Сделки с этапа перейдут в «${list.find(s => s.kind === 'open' && s.id !== id)?.name || 'первый этап'}».`, ok: 'Удалить', danger: true})) return;
      await api('/api/stages/' + id, {method: 'DELETE'});
      await bootstrap(); renderStages();
    };
  });
}

async function loadUsers() {
  const users = await api('/api/users');
  $('#users').innerHTML = `<div class="tbl-wrap" style="box-shadow:none"><table><thead><tr><th>Имя</th><th>Логин</th><th>Роль</th><th>Доступ</th><th></th></tr></thead><tbody>
    ${users.map(u => `<tr data-id="${u.id}"><td><input value="${esc(u.name)}" data-f="name"></td><td>${esc(u.login)}</td>
      <td><select data-f="role"><option value="manager">Менеджер</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Администратор</option></select></td>
      <td><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-f="active" ${u.active ? 'checked' : ''}> активен</label></td>
      <td><button class="btn btn-sm" data-pw>Сменить пароль</button></td></tr>`).join('')}</tbody></table></div>`;
  $$('#users tr[data-id]').forEach(r => {
    const id = r.dataset.id;
    $$('[data-f]', r).forEach(inp => inp.onchange = async () => {
      const v = inp.type === 'checkbox' ? inp.checked : inp.value;
      try { await api('/api/users/' + id, {method: 'PATCH', body: {[inp.dataset.f]: v}}); toast('Сохранено'); await bootstrap(); }
      catch { loadUsers(); }
    });
    $('[data-pw]', r).onclick = async () => {
      const pw = await ask({title: 'Новый пароль', input: true, placeholder: 'От 6 символов', ok: 'Сохранить'});
      if (pw) { await api('/api/users/' + id, {method: 'PATCH', body: {password: pw}}); toast('Пароль изменён'); }
    };
  });
}

// ---------------- старт ----------------
async function bootstrap() {
  S.boot = await api('/api/bootstrap');
  $('#username').textContent = S.boot.me.name;
}

bootstrap().then(() => {
  window.addEventListener('hashchange', route);
  route();
  refreshTaskCount();
  setInterval(refreshTaskCount, 60000);
});
