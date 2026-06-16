// Thin wrapper around @actual-app/api shared by the bot and the migration script.
import http from 'node:http';
import fs from 'node:fs';

// undici's pooled keep-alive sockets get closed by actual-server between
// requests, causing EPIPE / UND_ERR_SOCKET on sync POSTs. Replace fetch with
// a plain node:http client (agent:false = fresh connection per request) for
// http:// URLs. Must be installed before @actual-app/api captures fetch.
const origFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const urlStr = typeof input === 'string' ? input : input.url;
  if (!urlStr.startsWith('http://')) return origFetch(input, init);
  return new Promise((resolve, reject) => {
    const req = http.request(
      urlStr,
      { method: init.method || 'GET', headers: init.headers || {}, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })),
        );
      },
    );
    req.on('error', (e) => reject(new TypeError('fetch failed', { cause: e })));
    if (init.body) req.write(Buffer.from(init.body));
    req.end();
  });
};

const { default: api } = await import('@actual-app/api');

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

// Returns the n most recent transactions across all open accounts, newest
// first: [{ id, date, payee, label, amount }] with amount in major units
// (negative = spent). Looks back 90 days to avoid scanning migration history.
export async function recentTransactions(n = 5) {
  await freshen();
  const accounts = await api.getAccounts();
  const open = accounts.filter((a) => !a.closed);

  const end = todayISO();
  const start = (() => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 90);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  })();

  const payees = await api.getPayees();
  const payeeName = new Map(payees.map((p) => [p.id, p.name]));
  const categories = await listCategories();
  const catLabel = new Map(categories.map((c) => [c.id, c.label]));

  const all = [];
  for (const a of open) {
    const txns = await api.getTransactions(a.id, start, end);
    all.push(...txns);
  }

  all.sort((x, y) => (y.date < x.date ? -1 : y.date > x.date ? 1 : (y.sort_order ?? 0) - (x.sort_order ?? 0)));

  return all.slice(0, n).map((t) => ({
    id: t.id,
    date: t.date,
    payee: t.payee_name || payeeName.get(t.payee) || 'Unknown',
    label: catLabel.get(t.category) || 'Uncategorized',
    amount: api.utils.integerToAmount(t.amount ?? 0),
  }));
}

export async function deleteTransaction(id) {
  await open();
  await api.deleteTransaction(id);
  await api.sync();
  lastSync = Date.now();
}

export { api };
