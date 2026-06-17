# budget-bot

Self-hosted envelope budgeting for our household (Greg + Darla): Actual Budget
as the ledger, a Telegram bot as the daily logging interface, Claude Haiku for
natural-language expense parsing. Replaced Goodbudget ($80/yr) in June 2026.

## Architecture

```
Telegram (Greg & Darla phones)
        │
        ▼
  bot (Node 22, grammY, long-polling — no inbound port)
        │  ├── Claude API (claude-haiku-4-5, tool use) → parses "spent 1500 at SM for groceries"
        │  └── @actual-app/api → writes/reads the budget
        ▼
  actual_server (actualbudget/actual-server:latest, port 5006, internal only)
        ▲
        │  HTTPS via Caddy (auto-TLS)
  Web UI / PWA on phones & browsers (power view: reconciling, moving money, reports)
```

All three services run via docker-compose on a DigitalOcean droplet
(Ubuntu 24.04, 1GB, user `greg`, repo at `~/budget-bot`). The web UI is the
only public surface, behind Caddy on 80/443 using `DOMAIN` from `.env`.

## Components

- `docker-compose.yml` — actual_server + caddy + bot. actual_server has raised
  `ACTUAL_UPLOAD_*` limits (200MB) from migration debugging.
- `bot/src/index.js` — Telegram bot. Auth = `ALLOWED_TELEGRAM_IDS` allowlist.
  Commands: free-text expense logging, balance questions, `/balances`,
  `undo #ID` (48h window, only deletes transactions the bot created; undo map
  in `/data/undo.json` on the `bot-data` volume).
- `bot/src/llm.js` — Claude tool-use parsing. Category enum is built per
  request from live Actual categories as "Group: Name" labels, plus
  `Inbox: Needs Review` fallback for ambiguous expenses (never guess).
- `bot/src/actual.js` — shared Actual API wrapper. **Contains a critical fetch
  shim**: replaces global fetch with plain node:http (agent:false, no
  keep-alive) for http:// URLs. Without it, undici's pooled sockets get closed
  by actual-server and sync POSTs fail with EPIPE / UND_ERR_SOCKET. The shim
  must be installed before `@actual-app/api` is imported.
- `bot/migrate/migrate.js` — one-time Goodbudget CSV migration (done, kept for
  reference). Idempotent via `imported_id`. Syncs in ≤30-transaction chunks
  (large sync batches trigger the same socket failures). Envelope balances
  could NOT be computed from the GB export (incomplete fill history) — they
  were supplied via `import/balances.json` copied from the GB app.
- `scripts/backup.sh` — weekly tar of the `actual-data` volume to `~/backups`
  on the droplet, 8-week retention. Cron: `0 3 * * 0` as user greg.

## Data model notes

- Envelope = Actual category, addressed as "Group: Name" everywhere.
- The **Goodbudget** account is a synthetic catch-all: 12 years of GB
  transactions had no account, and one large "balancing entry" income
  transaction makes total money = Σ envelope balances + Available. Its balance
  is meaningless by design — never "fix" it.
- Old months show red overspending (no historical budgets) — cosmetic.
- Amounts in the API are integer minor units; use `api.utils.amountToInteger`.

## Environments

- **Prod**: the droplet. Deploy = `git push` (GitHub, private repo) then on the
  droplet: `cd ~/budget-bot && git pull && docker compose build bot && docker compose up -d`.
- **Local** (`~/Developer/budget-bot`): code editing only; nothing runs locally.
- Secrets live ONLY in `.env` on the droplet (gitignored): ACTUAL_PASSWORD,
  ACTUAL_SYNC_ID, TELEGRAM_BOT_TOKEN, ALLOWED_TELEGRAM_IDS, ANTHROPIC_API_KEY,
  DOMAIN. `.env` changes need `docker compose up -d` (recreate), not `restart`.
- `import/` is gitignored (contains real financial data).

## Gotchas / hard-won lessons

1. Keep `@actual-app/api` (`bot/package.json`) in lockstep with the actual-server
   image tag (`docker-compose.yml`) — both are pinned to the SAME version
   (currently 26.6.0). Version skew causes "Database is out of sync with
   migrations" on downloadBudget: a `:latest` server silently migrates the DB
   past the bot's pinned API. To upgrade, bump both to the same new version
   together, regenerate `bot/package-lock.json`, then rebuild the bot.
2. Never remove the fetch shim in `bot/src/actual.js` (see above).
3. Sync payloads must stay small; if bulk-writing transactions, sync every few
   hundred messages (see migrate.js chunking).
4. The bot's budget cache lives on the `bot-data` volume; it can be safely
   deleted (`docker volume rm budget-bot_bot-data`) — it re-downloads from the
   server on next start. Do this if the bot's local state ever wedges.
5. The Telegram bot uses long polling — only one bot process may run at a time
   (a second poller causes 409 conflicts). Don't scale the bot service.

## Roadmap context

This is Phase 0+1 of a larger experiment (validated migration + working bot).
Phase 2 = one-month household trial with a friction log. Phase 3 gate decides:
keep as personal tool, build backlog features (splits, envelope transfers,
voice notes), or pursue a SaaS product (chat-first envelope budgeting for
couples). Possible future: custom multi-tenant ledger (Laravel) replacing
Actual if productized.
