// ================================================================
// Budget — app shell. Talks to the Budget Apps Script (JSON only) and keeps
// the phone fast:
//   1. CACHE FIRST. The last snapshot renders instantly from localStorage;
//      fresh data swaps in when Apps Script answers (cold starts take seconds).
//   2. OPTIMISTIC WRITES. Every change applies on screen immediately and goes
//      into a saved queue that syncs in the background, in order. Offline
//      changes survive a reload. Adds carry their own id, so retries can't
//      double-write.
//   3. NO RE-RENDER WHILE TYPING. If data lands while an input has focus, the
//      redraw waits until you leave the field — nothing jumps under your thumb.
// ================================================================

const API_URL = 'https://script.google.com/macros/s/AKfycbzRRA1K6H_V3r0xHR5twmWI3myz3evG--FIEm3fhTt87dhJ0mnyeI-DtA25K1uq6XWU/exec';
const LS = { key: 'budget_key', cache: 'budget_cache_v1', queue: 'budget_queue_v1', ui: 'budget_ui_v1' };
const MOCK = new URLSearchParams(location.search).get('mock') === '1';
const SOURCES = ['Fidelity Visa', 'Discover', 'TCT Checking', 'Other card', 'Other bank'];
const SHORT = { 'Fidelity Visa': 'Visa', 'Discover': 'Discover', 'TCT Checking': 'TCT',
                'Manual': 'Cash', 'Other card': 'Card', 'Other bank': 'Bank' };

const $ = (id) => document.getElementById(id);
const S = {
  data: null, view: null, tab: 'cats', open: null, editing: null,
  queue: [], opSeq: 0, flushing: false, fetching: false, lastSync: 0, err: '',
  deferRender: false, sortPattern: {}, sortAlways: {}, delArm: null,
};

/* ---------------- storage (never throws) ---------------- */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function lsJson(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }
function saveCache() { if (!MOCK) lsSet(LS.cache, JSON.stringify(S.data)); }
function saveQueue() { if (!MOCK) lsSet(LS.queue, JSON.stringify(S.queue)); }
function saveUi() { lsSet(LS.ui, JSON.stringify({ tab: S.tab })); }

/* ---------------- formatting ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money0(n) { const v = Math.round(Number(n) || 0); return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US'); }
function money2(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function kfmt(n) { n = Math.round(n); return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function curMonth() { return todayStr().slice(0, 7); }
function newId() {
  const r = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  return 'm-' + r.replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
}

/* ---------------- network ---------------- */
class ApiError extends Error {
  constructor(kind, msg) { super(msg); this.kind = kind; }   // unauthorized | server | network | timeout
}

async function api(payload) {
  if (MOCK) return mockApi(payload);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST', redirect: 'follow', signal: ctl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // simple request: no CORS preflight
      body: JSON.stringify(Object.assign({ key: lsGet(LS.key) || '' }, payload)),
    });
  } catch (e) {
    throw new ApiError(e && e.name === 'AbortError' ? 'timeout' : 'network', 'No connection');
  } finally { clearTimeout(timer); }
  let out;
  try { out = await res.json(); } catch (e) { throw new ApiError('network', 'Unreadable reply'); }
  if (!out.ok) throw new ApiError(out.code === 'unauthorized' ? 'unauthorized' : 'server', out.error || 'Something went wrong');
  return out;
}

async function fetchData() {
  if (S.fetching) return;
  S.fetching = true; stamp();
  const seq = S.opSeq;
  try {
    const r = await api({ op: 'data' });
    if (seq === S.opSeq && !S.queue.length) {   // nothing changed locally while we waited
      S.data = r.data; saveCache(); S.err = ''; S.lastSync = Date.now();
      showApp(); render();
    } else refreshSoon();
  } catch (e) {
    if (e.kind === 'unauthorized') showGate();
    else S.err = 'offline';
  } finally { S.fetching = false; stamp(); }
}

let retryTimer = null;
async function flush() {
  if (S.flushing) return;
  S.flushing = true; stamp();
  try {
    while (S.queue.length) {
      const op = S.queue[0];
      try { await api(op); }
      catch (e) {
        if (e.kind === 'unauthorized') { showGate(); return; }
        if (e.kind === 'server') {          // a real rejection: drop it and resync to undo the guess
          S.queue.shift(); saveQueue(); toast(e.message, true); continue;
        }
        S.err = 'offline';                  // keep it queued; try again later
        clearTimeout(retryTimer); retryTimer = setTimeout(sync, 20000);
        return;
      }
      S.queue.shift(); saveQueue(); S.err = '';
    }
  } finally { S.flushing = false; stamp(); }
  refreshSoon();
}

let refreshTimer = null;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(fetchData, 1200); }
function sync() { if (S.queue.length) flush(); else fetchData(); }

function enqueue(op, quiet) {
  S.opSeq++;
  Model.applyOp(S.data, op);
  saveCache();
  S.queue.push(op); saveQueue();
  if (!quiet) render();
  flush();
}

/* ---------------- shell ---------------- */
function showGate() {
  $('gate').hidden = false; $('boot').hidden = true; $('app').hidden = true; $('fab').hidden = true;
  S.err = 'key'; stamp();
}
function showApp() {
  $('gate').hidden = true; $('boot').hidden = true; $('app').hidden = false; $('fab').hidden = false;
}

function stamp() {
  const el = $('stamp');
  el.className = 'stamp';
  if (MOCK) { el.textContent = 'demo data'; return; }
  if (S.flushing || S.fetching) { el.textContent = 'syncing…'; el.classList.add('busy'); return; }
  if (S.err === 'key') { el.textContent = 'needs key'; el.classList.add('bad'); return; }
  if (S.queue.length) { el.textContent = S.queue.length + ' unsaved'; el.classList.add('bad'); return; }
  if (S.err === 'offline') { el.textContent = 'offline'; el.classList.add('bad'); return; }
  if (!S.lastSync) { el.textContent = ''; return; }
  const m = Math.round((Date.now() - S.lastSync) / 60000);
  el.textContent = m < 1 ? 'up to date' : 'synced ' + (m < 60 ? m + 'm' : Math.round(m / 60) + 'h') + ' ago';
}

let toastTimer = null;
function toast(msg, bad) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), bad ? 4500 : 2200);
}

/* ---------------- render ---------------- */
function typing() {
  const a = document.activeElement;
  return a && $('app').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

function render() {
  if (!S.data) return;
  if (typing()) { S.deferRender = true; return; }
  S.deferRender = false;
  const cur = curMonth();
  if (!S.view) S.view = cur;
  const sum = Model.summarize(S.data, S.view);
  const endYm = S.view < Model.shiftMonth(cur, -5) ? Model.shiftMonth(S.view, 5) : cur;
  const ser = Model.series(S.data, endYm, 6);

  let h = '';
  h += '<div class="monthbar"><button data-act="prev" aria-label="Previous month">‹</button>' +
       '<h2>' + esc(Model.monthLabel(S.view)) + '</h2>' +
       '<button data-act="next" aria-label="Next month"' + (S.view >= cur ? ' disabled' : '') + '>›</button></div>';

  h += '<div class="cards">' +
    '<div class="card"><div class="k">Left to spend</div><div class="v' + (sum.left < 0 ? ' neg' : '') + '">' +
      money0(sum.left) + '</div><div class="s">of ' + money0(sum.budget) + ' budget</div></div>' +
    '<div class="card"><div class="k">Spent</div><div class="v">' + money0(sum.spent) + '</div><div class="s">' +
      (sum.income ? 'earned ' + money0(sum.income) : 'no income logged') + '</div></div></div>';

  const hh = sum.household;
  if (hh.planned > 0) {
    const status = hh.paid >= hh.planned ? '<span class="ok">paid ✓</span>'
      : hh.covered ? '<span class="ok">covered</span>' : '<span class="no">not covered yet</span>';
    h += '<div class="hh"><span><b>' + esc(hh.label) + '</b> · ' + money0(hh.planned) + '/mo</span>' + status + '</div>';
  } else {
    h += '<button class="hh" data-act="hh-set" style="width:100%;border:none;text-align:left">' +
         '<span>Household contribution isn\'t set</span><span class="no">set it ›</span></button>';
  }

  // chart: monthly spending, dashed line = total monthly budget
  const max = Math.max(1, sum.budget, ...ser.map(s => s.spent));
  const H = 100;
  h += '<div class="chart">';
  if (sum.budget > 0) {
    h += '<div class="line" style="bottom:' + Math.round(sum.budget / max * H) + 'px"><span>budget ' + kfmt(sum.budget) + '</span></div>';
  }
  ser.forEach(s => {
    h += '<button class="col' + (s.ym === S.view ? ' on' : '') + '" data-act="month" data-ym="' + s.ym + '" aria-label="' +
         esc(Model.monthLabel(s.ym)) + '"><div class="val">' + (s.spent ? kfmt(s.spent) : '') + '</div>' +
         '<div class="bar" style="height:' + Math.max(2, Math.round(s.spent / max * H)) + 'px"></div></button>';
  });
  h += '</div><div class="xlab">' + ser.map(s => '<div' + (s.ym === S.view ? ' class="on"' : '') + '>' +
       Model.monthShort(s.ym) + '</div>').join('') + '</div>';

  const nSort = sum.unsorted.length;
  h += '<div class="seg" role="group">' +
    tabBtn('cats', 'Categories') + tabBtn('tx', 'Activity') +
    tabBtn('sort', 'To sort' + (nSort ? '<span class="badge">' + nSort + '</span>' : '')) + '</div>';

  if (S.tab === 'cats') h += renderCats(sum);
  else if (S.tab === 'tx') h += renderTx(sum.recent, false);
  else h += renderSort(sum.unsorted);

  $('app').innerHTML = h;

  if (S.editing) {
    const inp = $('app').querySelector('.lim-in');
    if (inp && document.activeElement !== inp) {
      inp.focus({ preventScroll: true }); inp.select();
      if (S.scrollToEdit) { S.scrollToEdit = false; inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }
  stamp();
}

function tabBtn(id, label) {
  return '<button data-act="tab" data-tab="' + id + '" aria-pressed="' + (S.tab === id) + '">' + label + '</button>';
}

function renderCats(sum) {
  const counts = {};
  sum.recent.forEach(t => { if (Model.isSpend(t)) { const c = t.category || 'Unsorted'; counts[c] = (counts[c] || 0) + 1; } });
  return sum.cats.map(c => {
    const over = c.budget > 0 && c.spent > c.budget;
    const pct = c.budget > 0 ? Math.min(100, c.spent / c.budget * 100) : (c.spent > 0 ? 100 : 0);
    const n = counts[c.name] || 0;
    const sub = c.budget > 0
      ? (over ? money0(c.spent - c.budget) + ' over' : money0(c.budget - c.spent) + ' left')
      : (c.spent > 0 ? 'no limit set' : 'no limit');
    const limit = c.name === 'Unsorted' ? '' :
      (S.editing === c.name
        ? '<input class="lim-in" inputmode="decimal" enterkeyhint="done" data-cat="' + esc(c.name) + '" value="' + (c.budget || '') + '" aria-label="Monthly limit">'
        : '<button class="lim" data-act="limit" data-cat="' + esc(c.name) + '">' + (c.budget ? money0(c.budget) : 'set') + '</button>');
    let out = '<div class="cat"><div class="cat-head">' +
      '<button class="cat-name" data-act="cat-open" data-cat="' + esc(c.name) + '">' + esc(c.name) + '</button>' +
      '<div class="cat-amt"><span class="sp' + (over ? ' over' : '') + '">' + money0(c.spent) + '</span>' +
      (limit ? ' / ' + limit : '') + '</div></div>' +
      '<div class="meter"><i class="' + (over || (c.budget === 0 && c.spent > 0) ? 'over' : '') + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="cat-sub">' + sub + (n ? ' · ' + n + ' charge' + (n > 1 ? 's' : '') : '') + '</div>';
    if (S.open === 'cat:' + c.name) {
      const list = sum.recent.filter(t => Model.isSpend(t) && (t.category || 'Unsorted') === c.name);
      out += '<div class="cat-list">' + (list.length ? renderTx(list, true) : '<div class="msg" style="padding:10px">Nothing this month.</div>') + '</div>';
    }
    return out + '</div>';
  }).join('');
}

function renderTx(list, mini) {
  if (!list.length) return '<div class="msg">Nothing logged this month yet.<br>Tap + to add, or import a CSV.</div>';
  return list.map(t => {
    const income = t.type === 'income';
    const skip = t.category === 'Skip';
    const cat = income ? 'Income' : (t.category || 'To sort');
    const cls = 'row' + (mini ? ' mini' : '') + (skip ? ' skip' : '') + (!t.category && !income ? ' unsorted' : '');
    const amtCls = income ? ' in' : (t.amount < 0 && !skip ? ' ref' : '');
    const amt = income ? '+' + money2(t.amount) : money2(t.amount);
    let out = '<button class="' + cls + '" data-act="tx" data-id="' + esc(t.id) + '">' +
      '<span><span class="d">' + esc(Model.merchant(t.description)) + '</span>' +
      '<span class="m">' + Model.dayLabel(t.date) + ' · ' + esc(cat) + ' · ' + esc(SHORT[t.source] || t.source) + '</span></span>' +
      '<span class="amt' + amtCls + '">' + amt + '</span></button>';
    if (S.open === t.id) out += renderDetail(t);
    return out;
  }).join('');
}

function catChips(t, act) {
  const names = (S.data.budgets || []).map(b => b.name);
  return '<div class="chips">' + names.map(n =>
    '<button class="chip" data-act="' + act + '" data-id="' + esc(t.id) + '" data-cat="' + esc(n) + '" aria-pressed="' + (t.category === n) + '">' + esc(n) + '</button>'
  ).join('') +
    '<button class="chip skip" data-act="' + act + '" data-id="' + esc(t.id) + '" data-cat="Skip" aria-pressed="' + (t.category === 'Skip') + '">Not spending</button></div>';
}

function renderDetail(t) {
  let out = '<div class="detail"><div class="full">' + esc(t.description) + ' · ' + esc(t.date) + '</div>';
  if (t.type !== 'income') out += catChips(t, 'setcat');
  if (t.source === 'Manual') {
    out += '<button class="danger" data-act="del" data-id="' + esc(t.id) + '">' +
           (S.delArm === t.id ? 'Tap again to delete' : 'Delete') + '</button>';
  }
  return out + '</div>';
}

function renderSort(list) {
  if (!list.length) return '<div class="msg">All sorted.</div>';
  return list.map(t => {
    const pat = S.sortPattern[t.id] != null ? S.sortPattern[t.id] : Model.suggestPattern(t.description);
    const always = !!S.sortAlways[t.id];
    return '<div class="sort-item"><div class="top-line"><div><div class="d">' + esc(Model.merchant(t.description)) + '</div>' +
      '<div class="m">' + Model.dayLabel(t.date) + ' · ' + esc(SHORT[t.source] || t.source) + ' · ' + esc(t.description) + '</div></div>' +
      '<div class="amt">' + money2(t.amount) + '</div></div>' +
      catChips(t, 'sortcat') +
      '<label class="always"><input type="checkbox" data-act="always" data-id="' + esc(t.id) + '"' + (always ? ' checked' : '') + '>' +
      'Always, when it contains</label>' +
      (always ? '<div class="always"><input type="text" data-act="pattern" data-id="' + esc(t.id) + '" value="' + esc(pat) + '" autocapitalize="characters" spellcheck="false"></div>' : '') +
      '</div>';
  }).join('');
}

/* ---------------- interactions ---------------- */
// Swap the input back to a button in place (no full redraw), so the tap that
// closed the field still lands on whatever it was aimed at.
function commitLimit(inp) {
  const name = inp.dataset.cat;
  if (S.editing !== name) return;
  S.editing = null;
  const v = Math.abs(parseFloat(String(inp.value).replace(/[$,\s]/g, ''))) || 0;
  const cur = ((S.data.budgets || []).filter(b => b.name === name)[0] || {}).budget || 0;
  const changed = Math.round(v * 100) !== Math.round(cur * 100);
  if (changed) enqueue({ op: 'budget', category: name, amount: v }, true);
  if (inp.isConnected) {
    const b = document.createElement('button');
    b.className = 'lim'; b.dataset.act = 'limit'; b.dataset.cat = name;
    b.textContent = (changed ? v : cur) ? money0(changed ? v : cur) : 'set';
    inp.replaceWith(b);
  }
  if (changed) setTimeout(() => { if (!typing()) render(); }, 450);
}

$('app').addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act !== 'del') S.delArm = null;
  switch (act) {
    case 'prev': S.view = Model.shiftMonth(S.view, -1); S.open = null; render(); break;
    case 'next': if (S.view < curMonth()) { S.view = Model.shiftMonth(S.view, 1); S.open = null; render(); } break;
    case 'month': S.view = el.dataset.ym; S.open = null; render(); break;
    case 'tab': S.tab = el.dataset.tab; S.open = null; saveUi(); render(); break;
    case 'cat-open': { const k = 'cat:' + el.dataset.cat; S.open = S.open === k ? null : k; render(); break; }
    case 'limit': S.editing = el.dataset.cat; render(); break;
    case 'hh-set': S.tab = 'cats'; S.editing = 'Household'; S.scrollToEdit = true; render(); break;
    case 'tx': S.open = S.open === el.dataset.id ? null : el.dataset.id; render(); break;
    case 'setcat': {
      const t = S.data.tx.filter(x => x.id === el.dataset.id)[0];
      if (t && t.category !== el.dataset.cat) enqueue({ op: 'categorize', id: t.id, category: el.dataset.cat, pattern: '' });
      break;
    }
    case 'sortcat': {
      const id = el.dataset.id;
      const t = S.data.tx.filter(x => x.id === id)[0];
      if (!t) break;
      const pat = S.sortAlways[id]
        ? String(S.sortPattern[id] != null ? S.sortPattern[id] : Model.suggestPattern(t.description)).trim().toUpperCase() : '';
      const before = Model.summarize(S.data, S.view).unsorted.length;
      enqueue({ op: 'categorize', id, category: el.dataset.cat, pattern: pat });
      const extra = before - 1 - Model.summarize(S.data, S.view).unsorted.length;
      toast(Model.merchant(t.description) + ' → ' + el.dataset.cat + (extra > 0 ? ' (+' + extra + ' more)' : '') + (pat ? ' · rule saved' : ''));
      break;
    }
    case 'del': {
      if (S.delArm !== el.dataset.id) { S.delArm = el.dataset.id; render(); break; }
      S.delArm = null; S.open = null;
      enqueue({ op: 'delete', id: el.dataset.id }); toast('Deleted');
      break;
    }
  }
});

$('app').addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'always') { S.sortAlways[el.dataset.id] = el.checked; render(); }
});
$('app').addEventListener('input', (ev) => {
  const el = ev.target;
  if (el.dataset.act === 'pattern') S.sortPattern[el.dataset.id] = el.value;
});
$('app').addEventListener('keydown', (ev) => {
  const el = ev.target;
  if (!el.classList.contains('lim-in')) return;
  if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); }
  else if (ev.key === 'Escape') { el.value = String(((S.data.budgets || []).filter(b => b.name === el.dataset.cat)[0] || {}).budget || ''); commitLimit(el); }
});
$('app').addEventListener('focusout', (ev) => {
  const el = ev.target;
  if (el.classList && el.classList.contains('lim-in')) { commitLimit(el); return; }
  if (S.deferRender) setTimeout(() => { if (!typing()) render(); }, 300);
});

/* ---------------- dialogs ---------------- */
function openDialog(html) {
  const wrap = document.createElement('div');
  wrap.className = 'dlg-wrap';
  wrap.innerHTML = '<div class="dlg" role="dialog" aria-modal="true">' + html + '</div>';
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); wrap.remove(); if (S.deferRender) render(); }
  document.body.appendChild(wrap);
  return { el: wrap.firstChild, close };
}

function openAdd() {
  if (!S.data) return;
  let type = 'expense', cat = '';
  const names = (S.data.budgets || []).map(b => b.name);
  const d = openDialog(
    '<div class="seg" role="group"><button data-t="expense" aria-pressed="true">Spent</button><button data-t="income" aria-pressed="false">Earned</button></div>' +
    '<div class="big-amt"><span>$</span><input id="a-amt" inputmode="decimal" enterkeyhint="next" placeholder="0.00" autocomplete="off"></div>' +
    '<div class="chips" id="a-cats">' + names.map(n => '<button class="chip" data-c="' + esc(n) + '" aria-pressed="false">' + esc(n) + '</button>').join('') + '</div>' +
    '<input id="a-note" class="field" placeholder="What was it? (optional)" autocomplete="off" enterkeyhint="done">' +
    '<input id="a-date" class="field" type="date" value="' + todayStr() + '" max="' + todayStr() + '">' +
    '<div class="dlg-row"><button class="dlg-c" id="a-cancel">Cancel</button><button class="dlg-ok" id="a-save" disabled>Save</button></div>');
  const q = (s) => d.el.querySelector(s);
  const amt = q('#a-amt');
  const valid = () => {
    const v = parseFloat(String(amt.value).replace(/[$,\s]/g, ''));
    q('#a-save').disabled = !(v > 0 && (type === 'income' || cat));
    return v;
  };
  d.el.querySelectorAll('[data-t]').forEach(b => b.addEventListener('click', () => {
    type = b.dataset.t;
    d.el.querySelectorAll('[data-t]').forEach(x => x.setAttribute('aria-pressed', x === b));
    q('#a-cats').hidden = type === 'income';
    valid();
  }));
  q('#a-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]'); if (!b) return;
    cat = b.dataset.c;
    q('#a-cats').querySelectorAll('[data-c]').forEach(x => x.setAttribute('aria-pressed', x === b));
    valid();
  });
  amt.addEventListener('input', valid);
  amt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); amt.blur(); } });
  q('#a-note').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !q('#a-save').disabled) q('#a-save').click(); });
  q('#a-cancel').addEventListener('click', d.close);
  q('#a-save').addEventListener('click', () => {
    const v = valid();
    if (!(v > 0)) return;
    const date = q('#a-date').value || todayStr();
    const entry = { id: newId(), type, amount: v, category: type === 'income' ? 'Income' : cat, note: q('#a-note').value.trim(), date };
    d.close();
    S.view = date.slice(0, 7);
    enqueue({ op: 'add', entry });
    toast((type === 'income' ? 'Earned ' : 'Added ') + money2(v) + (type === 'income' ? '' : ' · ' + cat));
  });
  amt.focus({ preventScroll: true });
}

function openImport() {
  let source = lsGet('budget_last_source') || 'Fidelity Visa';
  const d = openDialog(
    '<div class="dlg-t">Import a CSV</div>' +
    '<div class="chips" id="i-src">' + SOURCES.map(s => '<button class="chip" data-s="' + esc(s) + '" aria-pressed="' + (s === source) + '">' + esc(s) + '</button>').join('') + '</div>' +
    '<label class="file-btn" id="i-label">Choose the CSV file<input id="i-file" type="file" accept=".csv,text/csv,text/plain" hidden></label>' +
    '<div id="i-out"></div>' +
    '<p class="note">Overlapping files are fine — anything already in is skipped. Card payments and transfers are filtered out automatically.</p>' +
    '<div class="dlg-row"><button class="dlg-c" id="i-close">Done</button></div>');
  const q = (s) => d.el.querySelector(s);
  q('#i-src').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    source = b.dataset.s;
    q('#i-src').querySelectorAll('[data-s]').forEach(x => x.setAttribute('aria-pressed', x === b));
  });
  q('#i-close').addEventListener('click', d.close);
  q('#i-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const out = q('#i-out');
    out.innerHTML = '<p class="note">Importing ' + esc(f.name) + '…</p>';
    q('#i-label').hidden = true;
    try {
      const csv = await f.text();
      const r = await api({ op: 'import', source, csv });
      lsSet('budget_last_source', source);
      S.opSeq++;
      S.data = r.data;
      S.queue.forEach(op => Model.applyOp(S.data, op));   // keep unsynced local changes on top
      saveCache(); S.lastSync = Date.now();
      const x = r.result;
      out.innerHTML = '<p class="note" style="color:var(--text)">Added <b>' + x.added + '</b>' +
        (x.toSort ? ' · <b>' + x.toSort + '</b> to sort' : '') +
        ' · ' + x.dupes + ' already in' + (x.skipped ? ' · ' + x.skipped + ' payments/transfers skipped' : '') +
        (x.from ? '<br>' + esc(x.from) + ' → ' + esc(x.to) : '') + '</p>';
      if (x.toSort) S.tab = 'sort';
      render();
    } catch (err) {
      out.innerHTML = '<p class="err">' + esc(err.kind === 'network' || err.kind === 'timeout' ? 'Couldn\'t reach the budget sheet. Try again on a better connection.' : err.message) + '</p>';
      if (err.kind === 'unauthorized') showGate();
    }
    q('#i-label').hidden = false;
    e.target.value = '';
  });
}

$('fab').addEventListener('click', openAdd);
$('import-btn').addEventListener('click', () => { if (S.data) openImport(); });

$('key-save').addEventListener('click', () => {
  const k = $('key-in').value.trim();
  if (!k) return;
  lsSet(LS.key, k); S.err = '';
  $('gate').hidden = true; $('boot').hidden = !!S.data || false;
  if (S.data) showApp();
  sync();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - S.lastSync > 20000) sync();
});
window.addEventListener('online', sync);
setInterval(stamp, 30000);

/* ---------------- demo data (?mock=1): invented, for screenshots/testing ---------------- */
let MOCK_DATA = null;
function mockApi(p) {
  return new Promise(res => setTimeout(() => {
    if (p.op === 'data') res({ ok: true, data: JSON.parse(JSON.stringify(MOCK_DATA)) });
    else if (p.op === 'import') res({ ok: true, result: { added: 12, skipped: 2, dupes: 30, toSort: 1, from: '2026-09-03', to: '2026-10-10' }, data: S.data });
    else { Model.applyOp(MOCK_DATA, p); res({ ok: true }); }
  }, 400));
}
function makeDemo() {
  const t = todayStr(), ym = t.slice(0, 7);
  const tx = []; let n = 0;
  const add = (m, day, desc, amt, cat, src, type) => {
    const date = Model.shiftMonth(ym, m) + '-' + String(day).padStart(2, '0');
    if (date > t) return;
    tx.push({ id: 'd' + (n++), date, description: desc, amount: amt, category: cat, source: src || 'Fidelity Visa', type: type || 'expense', note: '' });
  };
  for (let m = -3; m <= 0; m++) {
    add(m, 2, 'CORNER MARKET #12 ANYTOWN NY', 64.20 + m * 3, 'Groceries');
    add(m, 9, 'CORNER MARKET #12 ANYTOWN NY', 48.75, 'Groceries');
    add(m, 4, 'FUEL STOP 221 ANYTOWN NY', 41.10, 'Gas & Car', 'Discover');
    add(m, 6, 'STREAMCO MONTHLY', 12.99, 'Subscriptions');
    add(m, 8, 'TACO PLACE 77 ANYTOWN NY', 14.35 - m, 'Dining');
    add(m, 3, 'ONLINE SHOP*AB12CD34', 39.99, 'Shopping');
    add(m, 15, 'CARD PAYMENT THANK YOU', -250, 'Skip');
    add(m, 28, 'Paycheck', 1400 + m * 50, 'Income', 'Manual', 'income');
  }
  add(0, 5, 'HARDWARE CO ANYTOWN NY', 22.40, '');
  add(-1, 21, 'BIG BOX #4403 ANYTOWN NY', 31.18, '');
  return {
    today: t, householdLabel: 'Phone line',
    budgets: [['Groceries', 410], ['Shopping', 200], ['Gas & Car', 150], ['Subscriptions', 60], ['Dining', 50],
              ['Household', 35], ['Other', 0]].map(([name, budget]) => ({ name, budget })),
    tx,
  };
}

/* ---------------- boot ---------------- */
(function boot() {
  const m = location.hash.match(/(?:^#|&)k=([^&]+)/);
  if (m) {
    lsSet(LS.key, decodeURIComponent(m[1]));
    history.replaceState(null, '', location.pathname + location.search);   // don't leave the key in the address bar
  }
  const ui = lsJson(LS.ui);
  if (ui && ['cats', 'tx', 'sort'].indexOf(ui.tab) >= 0) S.tab = ui.tab;

  if (MOCK) {
    MOCK_DATA = makeDemo();
    S.data = JSON.parse(JSON.stringify(MOCK_DATA));
    S.lastSync = Date.now(); showApp(); render();
    return;
  }
  S.queue = lsJson(LS.queue) || [];
  S.data = lsJson(LS.cache);
  if (!lsGet(LS.key)) { showGate(); return; }
  if (S.data) { showApp(); render(); }
  sync();
})();
