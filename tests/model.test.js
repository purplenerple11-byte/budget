// node tests/model.test.js — synthetic data only (this repo is public; real transactions never go here)
const M = require('../model.js'), assert = require('assert');
const data = {
  householdLabel: 'Phone line',
  budgets: [{ name: 'Groceries', budget: 400 }, { name: 'Dining', budget: 50 }, { name: 'Household', budget: 35 }],
  tx: [
    { id: 'a', date: '2026-09-02', description: 'CORNER MARKET #12 ANYTOWN NY', amount: 60, category: 'Groceries', source: 'Fidelity Visa', type: 'expense' },
    { id: 'b', date: '2026-09-03', description: 'CORNER MARKET #12 ANYTOWN NY', amount: -10, category: 'Groceries', source: 'Fidelity Visa', type: 'expense' },
    { id: 'c', date: '2026-09-04', description: 'PAYMENT THANK YOU', amount: -500, category: 'Skip', source: 'Fidelity Visa', type: 'expense' },
    { id: 'd', date: '2026-09-05', description: 'BIG BOX #4403 ANYTOWN NY', amount: 20, category: '', source: 'Discover', type: 'expense' },
    { id: 'e', date: '2026-09-06', description: 'BIG BOX #2116 ANYTOWN NY', amount: 5, category: '', source: 'Discover', type: 'expense' },
    { id: 'f', date: '2026-09-30', description: 'Paycheck', amount: 1000, category: 'Income', source: 'Manual', type: 'income' },
    { id: 'g', date: '2026-08-10', description: 'TACO PLACE 77', amount: 30, category: 'Dining', source: 'Discover', type: 'expense' },
  ],
};
let s = M.summarize(data, '2026-09');
assert.strictEqual(s.spent, 75);            // 60 - 10 refund + 25 unsorted; Skip and income excluded
assert.strictEqual(s.income, 1000);
assert.strictEqual(s.budget, 485);
assert.strictEqual(s.left, 410);
assert.strictEqual(s.unsorted.length, 2);
// house = groceries for the house (60 - 10 refund) + Household entries (none yet)
assert.deepStrictEqual(s.house, { groceries: 50, logged: 0, total: 50, planned: 35 });
assert.deepStrictEqual(M.series(data, '2026-09', 3).map(x => x.spent), [0, 30, 75]);

M.applyOp(data, { op: 'categorize', id: 'd', category: 'Groceries', pattern: 'BIG BOX' });
s = M.summarize(data, '2026-09');
assert.strictEqual(s.unsorted.length, 0, 'pattern sorts the matching row too');
M.applyOp(data, { op: 'add', entry: { id: 'm-x1', date: '2026-09-07', amount: '12.5', category: 'Dining', type: 'expense', note: '' } });
M.applyOp(data, { op: 'add', entry: { id: 'm-x1', date: '2026-09-07', amount: '12.5', category: 'Dining', type: 'expense', note: '' } });
assert.strictEqual(M.summarize(data, '2026-09').cats.find(c => c.name === 'Dining').spent, 12.5, 'add is idempotent');
M.applyOp(data, { op: 'delete', id: 'm-x1' });
M.applyOp(data, { op: 'budget', category: 'Dining', amount: 75 });
M.applyOp(data, { op: 'house', id: 'a', personal: true });            // that grocery run was just me
M.applyOp(data, { op: 'add', entry: { id: 'm-r1', date: '2026-09-01', amount: 300, category: 'Household', type: 'expense', note: 'House: Rent' } });
s = M.summarize(data, '2026-09');
assert.deepStrictEqual(s.house, { groceries: 15, logged: 300, total: 315, planned: 35 });  // -10 refund + 20 + 5 sorted BIG BOX
M.applyOp(data, { op: 'house', id: 'a', personal: false });
assert.strictEqual(M.isPersonal(data.tx.find(t => t.id === 'a')), false);
const subs = M.groupCharges([
  { id: 's1', date: '2026-08-12', description: 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM CA', amount: 21.4, source: 'Fidelity Visa' },
  { id: 's2', date: '2026-08-27', description: 'ANTHROPIC* CLAUDE SUB 4152360599 CA', amount: 21.4, source: 'Discover' },
  { id: 's3', date: '2026-08-03', description: 'Google YouTube 650-2530000 CA', amount: 8.99, source: 'Fidelity Visa' },
]);
assert.strictEqual(subs[0].total, 42.8);
assert.deepStrictEqual(subs[0].cards, ['Fidelity Visa', 'Discover']);   // same sub on two cards → flagged
assert.strictEqual(subs[0].repeat, true);
assert.strictEqual(subs[1].repeat, false);
assert.strictEqual(data.budgets.find(b => b.name === 'Dining').budget, 75);

assert.strictEqual(M.merchant('HANNAFORD #8333 GREENWICH NY'), 'Hannaford Greenwich');
assert.strictEqual(M.merchant('Withdrawal ATM: TELLO MOBILE'), 'Tello Mobile');
assert.strictEqual(M.suggestPattern('SARATOGA SPA SP PKHB SARATOGA SPRI NY'), 'SARATOGA SPA');
assert.strictEqual(M.suggestPattern('WAL-MART #4403 QUEENSBURY NY'), 'WAL-MART');
assert.strictEqual(M.shiftMonth('2026-01', -1), '2025-12');
console.log('model tests: all passed');
