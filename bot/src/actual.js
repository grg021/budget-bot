// Thin wrapper around @actual-app/api shared by the bot and the migration script.
import api from '@actual-app/api';
import fs from 'node:fs';

const DATA_DIR = process.env.ACTUAL_DATA_DIR || '/data/actual-cache';

let initialized = false;
let lastSync = 0;

export async function open() {
  if (initialized) return api;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await api.init({
    dataDir: DATA_DIR,
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });
  const opts = {};
  if (process.env.ACTUAL_FILE_PASSWORD) opts.password = process.env.ACTUAL_FILE_PASSWORD;
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID, opts);
  initialized = true;
  lastSync = Date.now();
  return api;
}

// Pull remote changes (e.g. edits made in the web UI), at most every 30s.
export async function freshen() {
  await open();
  if (Date.now() - lastSync > 30_000) {
    await api.sync();
    lastSync = Date.now();
  }
}

export async function close() {
  if (initialized) await api.shutdown();
  initialized = false;
}

export function currentMonth(tz = process.env.TZ || 'UTC') {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function todayISO(tz = process.env.TZ || 'UTC') {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Returns [{id, label, groupName, name, isIncome}] where label is "Group: Name".
export async function listCategories() {
  await freshen();
  const groups = await api.getCategoryGroups();
  const out = [];
  for (const g of groups) {
    for (const c of g.categories || []) {
      out.push({
        id: c.id,
        name: c.name,
        groupName: g.name,
        label: `${g.name}: ${c.name}`,
        isIncome: !!g.is_income,
      });
    }
  }
  return out;
}

export async function listAccounts() {
  await freshen();
  const accounts = await api.getAccounts();
  return accounts.filter((a) => !a.closed);
}

// Current-month status for one category id: {budgeted, spent, balance} in major units.
export async function categoryMonthStatus(categoryId) {
  await freshen();
  const month = await api.getBudgetMonth(currentMonth());
  for (const g of month.categoryGroups || []) {
    for (const c of g.categories || []) {
      if (c.id === categoryId) {
        return {
          budgeted: api.utils.integerToAmount(c.budgeted ?? 0),
          spent: api.utils.integerToAmount(c.spent ?? 0),
          balance: api.utils.integerToAmount(c.balance ?? 0),
        };
      }
    }
  }
  return null;
}

export async function allCategoryBalances() {
  await freshen();
  const month = await api.getBudgetMonth(currentMonth());
  const out = [];
  for (const g of month.categoryGroups || []) {
    if (g.is_income) continue;
    for (const c of g.categories || []) {
      out.push({
        label: `${g.name}: ${c.name}`,
        balance: api.utils.integerToAmount(c.balance ?? 0),
      });
    }
  }
  return out;
}

// amount: major units, positive = money spent. Returns created transaction id.
export async function logExpense({ accountId, categoryId, payee, amountSpent, date, note }) {
  await open();
  const tx = {
    date,
    amount: -api.utils.amountToInteger(amountSpent),
    payee_name: payee,
    category: categoryId,
    notes: note || undefined,
  };
  const ids = await api.addTransactions(accountId, [tx]);
  await api.sync();
  lastSync = Date.now();
  return Array.isArray(ids) ? ids[0] : ids;
}

export async function deleteTransaction(id) {
  await open();
  await api.deleteTransaction(id);
  await api.sync();
  lastSync = Date.now();
}

export { api };
