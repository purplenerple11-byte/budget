// ================================================================
// Budget — pure model. No DOM, no network. Loaded by index.html and by node tests.
//
// The server sends every row once (snapshot); all month math happens here so
// switching months, editing limits and sorting are instant on the phone.
// Rules mirror the old Apps Script getData() so the numbers don't move:
//   - type 'income' rows are earnings, never spending
//   - category 'Skip' is not spending (card payments, transfers, ATM cash)
//   - expense rows with no category count as 'Unsorted' and show in To sort
//   - negative expense amounts are refunds and reduce that category
// ================================================================

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
               'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function shiftMonth(ym, d) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + d;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}

function monthLabel(ym)  { const [y, m] = ym.split('-').map(Number); return MONTH[m - 1] + ' ' + y; }
function monthShort(ym)  { return MON[Number(ym.slice(5, 7)) - 1]; }

function dayLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return DOW[dt.getDay()] + ' ' + MON[m - 1] + ' ' + d;
}

function isSpend(t) { return t.type !== 'income' && t.category !== 'Skip'; }
function isPersonal(t) { return /(^|\s)personal(\s|$)/.test(t.note || ''); }

// Readable merchant name from a raw card/bank description.
function merchant(desc) {
  let s = String(desc || '')
    .replace(/^(withdrawal|deposit)\s+(ach|atm|pos|debit card)?:?\s*/i, '')
    .replace(/(google|apple) pay ending in \d+/ig, ' ')
    .replace(/amzn\.com\/bill/ig, ' ')
    .replace(/\bwww\.\S+/ig, ' ')
    .replace(/^(sp|tst|sq|pt|pp)(\s*\*\s*|\s+)/i, '')
    .replace(/\b(sp|tst|sq|pt|pp)\s?\*/ig, ' ')
    .replace(/\.(com|org|net)\b(\/\S*)?/ig, '')
    .replace(/[#*@]\S*/g, ' ')
    .replace(/\S*\d{3,}\S*/g, ' ')
    .replace(/\S*(?=\S*\d)(?=\S*[a-z])[a-z0-9]{8,}\S*/ig, ' ')
    .replace(/\S+\.\S+/g, ' ')
    .replace(/(^|\s)[A-Za-z](?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/\s+[A-Z]{2}$/, '');
  if (!s) s = String(desc || '').trim();
  s = s.split(' ').slice(0, 4).join(' ');
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  }
  return s.length > 30 ? s.slice(0, 29) + '…' : s;
}

// Default "always" pattern for a To-sort row. One word when it's distinctive,
// two when the first word is a town or generic ("SARATOGA SPA", not "SARATOGA",
// which would also swallow the YMCA). Rules match on "description contains".
const GENERIC = ['SARATOGA', 'CITY', 'THE', 'PAYMENT', 'TRANSFER', 'STORE', 'SHOP', 'GOOGLE',
  'APPLE', 'PAYPAL', 'DOLLAR', 'FIVE', 'PRICE', 'HOME', 'BEST', 'NEW', 'NORTH', 'SOUTH', 'EAST',
  'WEST', 'ALBANY', 'GREENWICH', 'QUEENSBURY', 'GLENS', 'TROY', 'ONLINE', 'AMAZON'];
function suggestPattern(desc) {
  const words = String(desc || '').toUpperCase()
    .replace(/^(WITHDRAWAL|DEPOSIT)\s+(ACH|ATM|POS)?:?\s*/, '')
    .split(/[\s*@]+/).map(w => w.replace(/\.(COM|ORG|NET)\b.*$/, '').replace(/^[#*]+|[#*,]+$/g, ''))
    .filter(w => w && !/\d{2,}/.test(w) && !/^(SP|TST|PT|SQ|PP)$/.test(w) && !/\./.test(w));
  if (!words.length) return '';
  if (words.length > 1 && (words[0].length < 4 || GENERIC.indexOf(words[0]) >= 0)) return words[0] + ' ' + words[1];
  return words[0];
}

function summarize(data, ym) {
  const budgets = data.budgets || [];
  const by = {};
  let income = 0;
  const recent = [];
  const unsorted = [];

  (data.tx || []).forEach(t => {
    const inMonth = t.date.slice(0, 7) === ym;
    if (t.type === 'income') {
      if (inMonth) { income += t.amount; recent.push(t); }
      return;
    }
    if (t.category === 'Skip') { if (inMonth) recent.push(t); return; }
    if (!t.category) unsorted.push(t);
    if (!inMonth) return;
    const c = t.category || 'Unsorted';
    by[c] = (by[c] || 0) + t.amount;
    recent.push(t);
  });

  const names = budgets.map(b => b.name);
  Object.keys(by).forEach(c => { if (names.indexOf(c) < 0 && c !== 'Unsorted') names.push(c); });
  if (by.Unsorted) names.push('Unsorted');
  const limit = {};
  budgets.forEach(b => { limit[b.name] = b.budget; });

  const cats = names.map(n => ({ name: n, budget: r2(limit[n] || 0), spent: r2(by[n] || 0) }));
  const spent = r2(cats.reduce((s, c) => s + c.spent, 0));
  const budget = r2(cats.reduce((s, c) => s + c.budget, 0));
  // What Pablo gives the house: groceries (unless a charge is marked "just me")
  // plus anything logged under Household (rent, extras).
  const hhBudget = limit.Household || 0;
  let houseGroceries = 0;
  (data.tx || []).forEach(t => {
    if (t.date.slice(0, 7) === ym && isSpend(t) && t.category === 'Groceries' && !isPersonal(t)) houseGroceries += t.amount;
  });
  const houseLogged = by.Household || 0;

  const byNewest = (a, b) => (b.date + b.id).localeCompare(a.date + a.id);
  recent.sort(byNewest);
  unsorted.sort(byNewest);

  return {
    ym, income: r2(income), spent, budget, left: r2(budget - spent), cats, recent, unsorted,
    house: {
      groceries: r2(houseGroceries), logged: r2(houseLogged),
      total: r2(houseGroceries + houseLogged), planned: r2(hhBudget),
    },
  };
}

// Charges grouped by merchant (rule-style key), biggest first. A merchant that
// hits more than once in the month, or on more than one card, is flagged so a
// doubled subscription stands out.
function groupCharges(list) {
  const g = {};
  list.forEach(t => {
    const k = suggestPattern(t.description) || t.description;
    const x = g[k] || (g[k] = { key: k, name: merchant(t.description), total: 0, items: [], cards: {} });
    x.total += t.amount; x.items.push(t); x.cards[t.source] = true;
  });
  return Object.keys(g).map(k => {
    const x = g[k];
    const charges = x.items.filter(t => t.amount > 0).length;
    return { key: k, name: x.name, total: r2(x.total), items: x.items, count: x.items.length,
             cards: Object.keys(x.cards), repeat: charges > 1 };
  }).sort((a, b) => b.total - a.total);
}

// Monthly spending for the chart: n months ending at endYm.
function series(data, endYm, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ ym: shiftMonth(endYm, -i), spent: 0 });
  const idx = {};
  out.forEach((o, i) => { idx[o.ym] = i; });
  (data.tx || []).forEach(t => {
    if (!isSpend(t)) return;
    const i = idx[t.date.slice(0, 7)];
    if (i !== undefined) out[i].spent += t.amount;
  });
  out.forEach(o => { o.spent = r2(o.spent); });
  return out;
}

// Optimistic local copy of what the server will do for each queued op.
function applyOp(data, op) {
  const tx = data.tx || (data.tx = []);
  if (op.op === 'add') {
    const e = op.entry;
    if (tx.some(t => t.id === e.id)) return data;
    const income = e.type === 'income';
    tx.push({
      id: e.id, date: e.date, description: (e.note || '').trim() || (income ? 'Earned' : 'Cash'),
      amount: r2(Math.abs(Number(e.amount))), category: income ? 'Income' : e.category,
      source: 'Manual', type: income ? 'income' : 'expense', note: '',
    });
  } else if (op.op === 'delete') {
    data.tx = tx.filter(t => t.id !== op.id);
  } else if (op.op === 'categorize') {
    const p = String(op.pattern || '').trim().toUpperCase();
    tx.forEach(t => {
      if (t.id === op.id) t.category = op.category;
      else if (p && !t.category && t.type !== 'income' && t.description.toUpperCase().indexOf(p) >= 0) t.category = op.category;
    });
  } else if (op.op === 'house') {
    tx.forEach(t => {
      if (t.id !== op.id) return;
      const toks = String(t.note || '').split(/\s+/).filter(w => w && w !== 'personal');
      if (op.personal) toks.push('personal');
      t.note = toks.join(' ');
    });
  } else if (op.op === 'budget') {
    const b = (data.budgets || (data.budgets = [])).filter(x => x.name === op.category)[0];
    const v = r2(Math.abs(Number(op.amount)) || 0);
    if (b) b.budget = v; else data.budgets.push({ name: op.category, budget: v });
  }
  return data;
}

var Model = { r2, shiftMonth, monthLabel, monthShort, dayLabel, merchant, suggestPattern,
              summarize, series, applyOp, isSpend, isPersonal, groupCharges };
if (typeof module !== 'undefined') module.exports = Model;
