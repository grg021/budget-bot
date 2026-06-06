#!/usr/bin/env node
// Goodbudget -> Actual migration.
//
//   Dry run (no server needed):  node migrate/migrate.js /import/good-budget-trans.csv --dry-run
//   Apply:                       node migrate/migrate.js /import/good-budget-trans.csv
//   With balance overrides:      node migrate/migrate.js gb.csv --overrides=/import/balances.json
//
// Goodbudget mixes three kinds of rows into one CSV:
//   1. real transactions (spends/refunds, some with split Details)
//   2. monthly envelope fills ("June 2023 Budget", Details = envelope|amount||...)
//   3. bookkeeping ([Available] adjustments, "Fill from Available")
// Only (1) becomes Actual transactions. (2)+(3) are used to compute each
// envelope's current balance, which is then applied as this month's budget.

import fs from 'node:fs';
// '../src/actual.js' is imported lazily so --dry-run works without @actual-app/api installed.

// ---- config you may want to edit --------------------------------------
const GROUP_RENAMES = { '(null)': 'Other' }; // GB group -> Actual group
const BARE_GROUP = 'Envelopes'; // group for envelopes without "Group: " prefix
const CATCHALL_ACCOUNT = 'Goodbudget'; // GB transactions with no account go here
const ARCHIVE_GROUP = 'Archive'; // for "DELETED:" envelopes found in splits
const accountType = (name) =>
  /cc|visa|platinum|amore|credit|gsac/i.test(name) ? 'credit' : /saving|\bsa\b/i.test(name) ? 'savings' : 'checking';

// ---- tiny RFC-4180 CSV parser ------------------------------------------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

const money = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const isoDate = (mdy) => {
  const [m, d, y] = mdy.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
};

// "Food: Eats and Treats" -> {group, name, label}; handles DELETED: prefix.
function envelopeToCategory(raw) {
  let env = raw.trim();
  let archived = false;
  if (env.startsWith('DELETED:')) { archived = true; env = env.replace(/^DELETED:\s*/, ''); }
  const idx = env.indexOf(': ');
  let group = idx === -1 ? BARE_GROUP : env.slice(0, idx);
  const name = idx === -1 ? env : env.slice(idx + 2);
  group = GROUP_RENAMES[group] || group;
  if (archived) group = ARCHIVE_GROUP;
  return { group, name, label: `${group}: ${name}`, archived };
}

const parseDetails = (details) =>
  details.split('||').map((leg) => {
    const i = leg.lastIndexOf('|');
    return { env: leg.slice(0, i).trim(), amount: money(leg.slice(i + 1)) };
  });

// ---- classification -----------------------------------------------------
// Row taxonomy learned from a real Goodbudget export:
//   Account == ''      -> envelope transfer: paired rows (-X from A, +X to B),
//                         each with its own Envelope. Imported as offsetting
//                         transactions in the catch-all account (net 0).
//   Account == '[none]'-> pre-accounts-era transaction (or "X Budget" fill row)
//   Envelope == '[Available]' -> unallocated-money bookkeeping, not a transaction
//   Details == 'env|amt||env|amt' -> split legs (expenses, or income to envelopes)
function classify(rows) {
  const txns = []; // {idx,date,accountGB,payee,notes,amount, legs|null, label?, income?}
  const stats = { txns: 0, splits: 0, fills: 0, income: 0, availAdjust: 0, skipped: 0, zero: 0 };
  const labels = new Set();

  rows.forEach((r, idx) => {
    const amount = money(r.Amount);
    const env = (r.Envelope || '').trim();
    const details = (r.Details || '').trim();
    const isTransfer = r.Account === '';
    const base = {
      idx,
      date: isoDate(r.Date),
      accountGB: r.Account && r.Account !== '[none]' && r.Account !== '' ? r.Account : CATCHALL_ACCOUNT,
      payee: r.Name || 'Unknown',
      notes: r.Notes || '',
      amount,
    };

    if (env === '[Available]') {
      stats.availAdjust++; // "Adjust Unallocated Money" etc. — bookkeeping only
      return;
    }

    if (!env && details) {
      const legs = parseDetails(details);
      if (legs.length === 1 && legs[0].env === '[Available]') {
        // Income deposited to Available: real transaction, no envelope.
        txns.push({ ...base, income: true, legs: null });
        stats.income++;
        return;
      }
      if (!isTransfer && legs.every((l) => l.amount >= 0) && /budget|fill/i.test(r.Name)) {
        // Monthly envelope fill: a budget allocation, not a transaction.
        stats.fills++;
        return;
      }
      // Split transaction or envelope transfer. [Available] legs -> income category.
      const mapped = legs.map((l) =>
        l.env === '[Available]'
          ? { label: '[INCOME]', amount: l.amount }
          : { ...envelopeToCategory(l.env), amount: l.amount },
      );
      for (const l of mapped) if (l.label !== '[INCOME]') labels.add(l.label);
      txns.push({ ...base, amount: mapped.reduce((s, l) => s + l.amount, 0), legs: mapped });
      stats.splits++;
      return;
    }

    if (env) {
      if (amount === 0) { stats.zero++; return; }
      const cat = envelopeToCategory(env);
      labels.add(cat.label);
      txns.push({ ...base, label: cat.label, legs: null });
      stats.txns++;
      return;
    }

    stats.skipped++; // no envelope, no details (e.g. "Fill from Available 0.00")
  });

  return { txns, labels, stats };
}

// ---- main ---------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');
  const template = args.includes('--template');
  const balancesPath = (args.find((a) => a.startsWith('--balances=')) || '').split('=')[1];
  if (!csvPath) {
    console.error('Usage: node migrate/migrate.js <goodbudget.csv> [--dry-run | --template | --balances=balances.json]');
    process.exit(1);
  }

  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  const { txns, labels, stats } = classify(rows);
  const accounts = [...new Set(txns.map((t) => t.accountGB))];

  if (template) {
    // Emit a balances template: fill each value with the CURRENT balance shown
    // in the Goodbudget app, then pass it back via --balances=
    const obj = { '[Available]': 0 };
    for (const label of [...labels].sort()) obj[label] = 0;
    console.log(JSON.stringify(obj, null, 2));
    return;
  }

  console.log('--- Classification ---');
  console.log(stats);
  console.log(`transactions to import: ${txns.length}`);
  console.log(`accounts (${accounts.length}): ${accounts.join(', ')}`);
  console.log(`categories (${labels.size}): ${[...labels].sort().join(', ')}`);

  if (dryRun) { console.log('\nDry run only — nothing written.'); return; }

  // The GB export does not contain complete envelope-fill history, so current
  // envelope balances CANNOT be computed from it. They must be supplied,
  // copied from the Goodbudget app (run with --template to get a starter file).
  if (!balancesPath) {
    console.error('\nERROR: --balances=<file> is required to apply.');
    console.error('Run with --template > balances.json, fill in the current balance of each');
    console.error('envelope as shown in Goodbudget, then rerun with --balances=balances.json');
    process.exit(1);
  }
  const balanceFile = JSON.parse(fs.readFileSync(balancesPath, 'utf8'));
  const availableTarget = balanceFile['[Available]'] ?? 0;
  const balances = new Map(Object.entries(balanceFile).filter(([k]) => k !== '[Available]'));
  for (const label of balances.keys()) labels.add(label);

  console.log('\n--- Applying to Actual ---');
  // Debug shim: @actual-app/api wraps fetch failures in PostError('network-failure'),
  // hiding the real cause. Log it before the wrapper eats it.
  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    try {
      return await origFetch(input, init);
    } catch (e) {
      console.error(
        '[fetch-debug]',
        String(input).slice(0, 100),
        'bodyBytes:', init?.body?.byteLength ?? init?.body?.length ?? 0,
        'cause:', e.cause?.code || e.cause?.message || e.message,
      );
      throw e;
    }
  };
  const actual = await import('../src/actual.js');
  const api = await actual.open();
  const toInt = api.utils.amountToInteger;

  // 1. Category groups + categories.
  const existingGroups = await api.getCategoryGroups();
  const groupIds = new Map(existingGroups.map((g) => [g.name, g.id]));
  const catIds = new Map();
  for (const g of existingGroups)
    for (const c of g.categories || []) catIds.set(`${g.name}: ${c.name}`, c.id);

  for (const label of [...labels].sort()) {
    if (catIds.has(label)) continue;
    const [group, name] = [label.slice(0, label.indexOf(': ')), label.slice(label.indexOf(': ') + 2)];
    if (!groupIds.has(group)) groupIds.set(group, await api.createCategoryGroup({ name: group }));
    catIds.set(label, await api.createCategory({ name, group_id: groupIds.get(group) }));
  }

  // Income category for income + balancing entries.
  let incomeGroup = existingGroups.find((g) => g.is_income);
  let incomeCatId = incomeGroup?.categories?.[0]?.id;
  if (!incomeCatId) {
    const gid = await api.createCategoryGroup({ name: 'Income', is_income: true });
    incomeCatId = await api.createCategory({ name: 'Income', group_id: gid, is_income: true });
  }

  // 2. Accounts.
  const existingAccounts = await api.getAccounts();
  const accIds = new Map(existingAccounts.map((a) => [a.name, a.id]));
  for (const name of accounts) {
    if (!accIds.has(name))
      accIds.set(name, await api.createAccount({ name, type: name === CATCHALL_ACCOUNT ? 'checking' : accountType(name) }, 0));
  }
  await api.sync(); // flush category/account creation as its own small batch

  // 3. Transactions (imported_id makes reruns idempotent).
  let totalImported = 0;
  for (const accName of accounts) {
    const list = txns
      .filter((t) => t.accountGB === accName)
      .map((t) => {
        const tx = {
          date: t.date,
          amount: toInt(t.amount),
          payee_name: t.payee,
          notes: t.notes || undefined,
          imported_id: `gb-${t.idx}`,
          cleared: true,
        };
        if (t.income) tx.category = incomeCatId;
        else if (t.legs)
          tx.subtransactions = t.legs.map((l) => ({
            amount: toInt(l.amount),
            category: l.label === '[INCOME]' ? incomeCatId : catIds.get(l.label),
          }));
        else tx.category = catIds.get(t.label);
        return tx;
      });
    if (!list.length) continue;
    // Import + sync in small chunks: the server aborts /sync/sync bodies over
    // ~100KB (EPIPE mid-upload), so keep each sync batch well under that.
    // ~10 CRDT messages per transaction at ~135 bytes each -> 30 txns ≈ 40KB.
    const CHUNK = 30;
    let added = 0, updated = 0;
    for (let i = 0; i < list.length; i += CHUNK) {
      const res = await api.importTransactions(accIds.get(accName), list.slice(i, i + CHUNK));
      added += (res.added || []).length;
      updated += (res.updated || []).length;
      if (res.errors?.length) console.log('  errors:', res.errors);
      await api.sync();
      if (list.length > CHUNK) process.stdout.write(`\r${accName}: ${Math.min(i + CHUNK, list.length)}/${list.length} synced`);
    }
    totalImported += added;
    console.log(`${list.length > CHUNK ? '\n' : ''}${accName}: ${added} added, ${updated} updated`);
  }
  console.log(`imported ${totalImported} transactions`);

  // 4. Balancing entry so that total on-budget money = sum(envelope targets) + Available.
  const txSum = txns.reduce((s, t) => s + t.amount, 0);
  const targetTotal = [...balances.values()].reduce((s, b) => s + b, 0) + availableTarget;
  const balancing = targetTotal - txSum;
  if (Math.abs(balancing) >= 0.01) {
    await api.importTransactions(accIds.get(CATCHALL_ACCOUNT), [{
      date: actual.todayISO(),
      amount: toInt(balancing),
      payee_name: 'Goodbudget migration balancing entry',
      category: incomeCatId,
      imported_id: 'gb-balancing',
      cleared: true,
    }]);
    console.log(`balancing entry: ${balancing.toFixed(2)}`);
  }
  await api.sync();

  // 5. Set this month's budget so each category's available == GB envelope balance.
  const month = actual.currentMonth();
  const readMonth = async () => {
    const m = await api.getBudgetMonth(month);
    const map = new Map();
    for (const g of m.categoryGroups || [])
      for (const c of g.categories || []) map.set(c.id, c);
    return map;
  };
  let monthCats = await readMonth();
  for (const [label, target] of balances.entries()) {
    const id = catIds.get(label);
    const c = monthCats.get(id);
    if (!c) continue;
    const delta = toInt(target) - (c.balance ?? 0);
    if (delta !== 0) await api.setBudgetAmount(month, id, (c.budgeted ?? 0) + delta);
  }
  await api.sync();

  // 6. Verify.
  monthCats = await readMonth();
  console.log('\n--- Verification (target vs Actual available) ---');
  let bad = 0;
  for (const [label, target] of [...balances.entries()].sort()) {
    const c = monthCats.get(catIds.get(label));
    const got = c ? api.utils.integerToAmount(c.balance ?? 0) : NaN;
    const ok = Math.abs(got - target) < 0.01;
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'BAD'} ${label.padEnd(45)} ${target.toFixed(2).padStart(14)} ${String(got.toFixed ? got.toFixed(2) : got).padStart(14)}`);
  }
  console.log(bad ? `\n${bad} categories did not match — investigate before cutover.` : '\nAll envelope balances match. Compare a few against the Goodbudget app, then you are good to cut over.');
  await actual.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
