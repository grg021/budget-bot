import { Bot } from 'grammy';
import fs from 'node:fs';
import * as actual from './actual.js';
import { parseMessage, NEEDS_REVIEW } from './llm.js';

const CUR = process.env.CURRENCY_SYMBOL || '₱';
const UNDO_FILE = '/data/undo.json';
const UNDO_WINDOW_MS = 48 * 60 * 60 * 1000;

const allowed = new Set(
  (process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);

const fmt = (n) =>
  `${CUR}${Math.abs(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ---- undo store -------------------------------------------------------
function loadUndo() {
  try {
    return JSON.parse(fs.readFileSync(UNDO_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveUndo(map) {
  fs.writeFileSync(UNDO_FILE, JSON.stringify(map));
}
function rememberTx(txId, desc) {
  const map = loadUndo();
  const short = Math.random().toString(36).slice(2, 6).toUpperCase();
  map[short] = { txId, desc, ts: Date.now() };
  // prune old entries
  for (const [k, v] of Object.entries(map)) {
    if (Date.now() - v.ts > UNDO_WINDOW_MS) delete map[k];
  }
  saveUndo(map);
  return short;
}

// ---- bot --------------------------------------------------------------
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (!ctx.from || !allowed.has(ctx.from.id)) {
    if (ctx.message) await ctx.reply(`Sorry, this is a private family bot. (Your ID: ${ctx.from?.id})`);
    return;
  }
  await next();
});

bot.command('start', (ctx) =>
  ctx.reply(
    'Hi! Tell me what you spent, e.g.\n' +
      '"Spent 1,500 at SM Supermarket for groceries"\n\n' +
      'You can also ask:\n' +
      '"How much is left in Groceries?"\n' +
      '/balances — all envelopes\n' +
      'undo #ID — remove a logged entry',
  ),
);

bot.command('balances', async (ctx) => {
  const balances = await actual.allCategoryBalances();
  const lines = balances
    .filter((b) => b.balance !== 0)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((b) => `${b.balance < 0 ? '⚠️ ' : ''}${b.label}: ${b.balance < 0 ? '-' : ''}${fmt(b.balance)}`);
  await ctx.reply(lines.length ? lines.join('\n') : 'No envelope balances yet.');
});

bot.on('message:voice', (ctx) =>
  ctx.reply('Voice notes aren’t supported yet — use your keyboard’s dictation (mic) button instead.'),
);

bot.on('message:text', async (ctx) => {
  const text = ctx.message.text.trim();

  // undo #ID — handled without the LLM
  const undoMatch = text.match(/^\/?undo\s*#?([a-z0-9]{3,6})$/i);
  if (undoMatch) {
    const map = loadUndo();
    const key = undoMatch[1].toUpperCase();
    const entry = map[key];
    if (!entry) return ctx.reply(`I don't have #${key} (undo works for 48h on entries I created).`);
    await actual.deleteTransaction(entry.txId);
    delete map[key];
    saveUndo(map);
    return ctx.reply(`Removed: ${entry.desc}`);
  }

  await ctx.replyWithChatAction('typing');
  try {
    const categories = await actual.listCategories();
    const accounts = await actual.listAccounts();
    const spendCats = categories.filter((c) => !c.isIncome);
    const byLabel = new Map(spendCats.map((c) => [c.label, c]));
    const accByName = new Map(accounts.map((a) => [a.name, a]));
    const confirmations = [];

    const executeTool = async (name, input) => {
      if (name === 'log_expense') {
        const label = byLabel.has(input.category) ? input.category : NEEDS_REVIEW;
        const cat = byLabel.get(label);
        if (!cat) return 'Error: category not found (is the Needs Review envelope set up?)';
        const account =
          accByName.get(input.account) ||
          accByName.get(process.env.DEFAULT_ACCOUNT) ||
          accounts[0];
        if (!account) return 'Error: no accounts exist in Actual yet.';
        const txId = await actual.logExpense({
          accountId: account.id,
          categoryId: cat.id,
          payee: input.payee,
          amountSpent: input.amount,
          date: input.date || actual.todayISO(),
          note: input.note,
        });
        const short = rememberTx(txId, `${fmt(input.amount)} ${input.payee} → ${label}`);
        const status = await actual.categoryMonthStatus(cat.id);
        let msg = `Logged ${fmt(input.amount)} — ${input.payee} → ${label}.`;
        if (status) {
          msg +=
            status.balance < 0
              ? ` ⚠️ ${label} is over by ${fmt(status.balance)}.`
              : ` ${fmt(status.balance)} left.`;
        }
        if (label === NEEDS_REVIEW) msg += ' (Couldn’t pick an envelope — recategorize it later.)';
        msg += ` [#${short}]`;
        confirmations.push(msg);
        return msg;
      }
      if (name === 'get_balance' || name === 'get_spending') {
        const cat = byLabel.get(input.category);
        if (!cat) return 'Category not found.';
        const s = await actual.categoryMonthStatus(cat.id);
        if (!s) return 'No data for this month.';
        return name === 'get_balance'
          ? `${input.category}: budgeted ${fmt(s.budgeted)}, spent ${fmt(s.spent)}, remaining ${s.balance < 0 ? '-' : ''}${fmt(s.balance)}`
          : `${input.category}: spent ${fmt(s.spent)} so far this month.`;
      }
      return 'Unknown tool';
    };

    const reply = await parseMessage({
      text,
      categoryLabels: spendCats.map((c) => c.label),
      accountNames: accounts.map((a) => a.name),
      today: actual.todayISO(),
      executeTool,
    });

    // Deterministic confirmations win over the model's own phrasing.
    await ctx.reply(confirmations.length ? confirmations.join('\n') : reply || 'Hmm, I had trouble with that one.');
  } catch (err) {
    console.error(err);
    await ctx.reply(`Something went wrong: ${err.message}`);
  }
});

// ---- startup ----------------------------------------------------------
const main = async () => {
  await actual.open();
  // Ensure the Needs Review envelope exists (group "Inbox", category "Needs Review").
  const cats = await actual.listCategories();
  if (!cats.some((c) => c.label === NEEDS_REVIEW)) {
    const groups = await actual.api.getCategoryGroups();
    let inbox = groups.find((g) => g.name === 'Inbox');
    const groupId = inbox ? inbox.id : await actual.api.createCategoryGroup({ name: 'Inbox' });
    await actual.api.createCategory({ name: 'Needs Review', group_id: groupId });
  }
  console.log('Connected to Actual. Starting bot...');
  await bot.start();
};

const shutdown = async () => {
  await actual.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
