# Budget Bot — self-hosted envelope budgeting with a Telegram AI front end

Actual Budget (the ledger) + Caddy (HTTPS) + a Telegram bot that logs expenses
via Claude Haiku. Includes a Goodbudget migration script.

## 1. DigitalOcean droplet

- Create the cheapest droplet ($6/mo, 1GB) — Ubuntu 24.04, your SSH key.
- Point a DNS A record (e.g. `budget.yourdomain.com`) at the droplet IP.
- SSH in and install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

- Copy this folder to the server (e.g. `scp -r budget-bot root@<ip>:~/`).

## 2. Actual server

```bash
cd ~/budget-bot
cp .env.example .env        # fill in DOMAIN first
docker compose up -d actual_server caddy
```

Open `https://budget.yourdomain.com`:

1. Set the server password → put it in `.env` as `ACTUAL_PASSWORD`.
2. Create a budget file (skip the setup wizard's demo data).
3. Settings → Show advanced settings → copy the **Sync ID** → `ACTUAL_SYNC_ID` in `.env`.
4. (Skip end-to-end encryption for now, or set `ACTUAL_FILE_PASSWORD` if you enable it.)

## 3. Migrate from Goodbudget

Export your transaction CSV from Goodbudget (Transactions → Export CSV) and put
it in `./import/good-budget-trans.csv` on the server.

```bash
# 1. Dry run: parses the CSV, prints what will be imported. Nothing is written.
docker compose run --rm bot node migrate/migrate.js /import/good-budget-trans.csv --dry-run

# 2. Generate the balances template:
docker compose run --rm bot node migrate/migrate.js /import/good-budget-trans.csv --template > import/balances.json
```

Edit `import/balances.json`: set every envelope to its **current balance as
shown in the Goodbudget app** (and `[Available]` to your unallocated amount).
This is the source of truth for the cutover — the CSV export doesn't contain
enough fill history to compute balances. ~10 minutes for 50 envelopes.

```bash
# 3. Apply: creates categories + accounts, imports ~8.5k transactions, sets this
#    month's budget so every envelope balance matches Goodbudget.
docker compose run --rm bot node migrate/migrate.js /import/good-budget-trans.csv --balances=/import/balances.json
```

The script is idempotent — rerunning won't duplicate transactions.

Notes:

- Goodbudget transactions without an account land in a catch-all account named
  **Goodbudget**. Its balance is synthetic — a single "balancing entry" makes the
  envelope math work. Ignore its balance, or stop using it after cutover.
- Real accounts (Greg Cash, Darla BPI, ...) only contain the transactions GB had
  for them. To make their balances real, use Actual's **reconcile** tool on each
  account once, after migration.
- Old months will show red overspending (no historical budgets exist). Cosmetic.

## 4. Telegram bot

1. Message **@BotFather** → `/newbot` → copy the token → `TELEGRAM_BOT_TOKEN`.
2. You and your wife each message **@userinfobot** to get your numeric IDs →
   `ALLOWED_TELEGRAM_IDS=111111,222222`.
3. Set `ANTHROPIC_API_KEY` (console.anthropic.com).
4. `docker compose up -d --build bot`

Usage:

- "Spent 1,500 at SM Supermarket for groceries" → logged, replies with remaining balance + undo ID
- "How much is left in Recreation?"
- `/balances` — every envelope with a non-zero balance
- `undo #A3F2` — delete an entry the bot created (48h window)

Ambiguous expenses go to the **Inbox: Needs Review** envelope — recategorize
them in the Actual web UI.

## 5. Phones

Open `https://budget.yourdomain.com` in the phone browser → "Add to Home
Screen" — Actual installs as a PWA for the full envelope view. Daily logging
happens in Telegram.

## Operations

```bash
docker compose logs -f bot        # bot logs
docker compose pull && docker compose up -d   # update Actual
```

Back up the `actual-data` volume (it contains the budget):

```bash
docker run --rm -v budget-bot_actual-data:/data -v ~/backups:/backup alpine \
  tar czf /backup/actual-$(date +%F).tar.gz /data
```

Run that weekly via cron. Your budget also lives as a synced copy on every
device that has opened it, so a dead droplet is recoverable.
