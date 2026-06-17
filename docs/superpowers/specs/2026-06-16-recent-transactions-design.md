# Recent transactions — design

**Date:** 2026-06-16
**Status:** Approved

## Goal

Let users ask the Telegram bot for their latest activity in natural language
("recent transactions", "what did I spend lately", "show my last few") and get
back the 5 most recent transactions across the whole Actual budget, newest
first.

## Decisions

- **Scope:** all transactions in Actual (web UI, migration, and bot-created),
  not just bot-logged ones — reflects the true latest ledger activity.
- **Trigger:** an LLM tool (`get_recent_transactions`) in the Claude tool-use
  loop, consistent with how balance questions already work. Catches natural
  phrasings; costs one Haiku call.

## Components

### 1. `actual.js` — `recentTransactions(n = 5)`

- `freshen()` first to pull web-UI edits.
- Fetch transactions from each open account over a bounded window (last 90 days)
  via `api.getTransactions(accountId, start, end)`, then merge.
- Sort by `date` descending, with `sort_order` as a tiebreaker for same-day
  entries; take the top `n`.
- Resolve payee names (`api.getPayees()` map) and category labels (reuse the
  `listCategories` id→label map).
- Returns `[{ id, date, payee, label, amount }]` where `amount` is in major
  units (negative = spent).
- The 90-day window avoids scanning the 12 years of Goodbudget migration rows
  while reliably covering real recent activity. If nothing is in range, the bot
  replies "No recent transactions."

### 2. `llm.js` — `get_recent_transactions` tool

- Added in `buildTools`. No required params; optional `limit` (default 5, capped
  at 10).
- Description steers the model to use it for requests about recent / latest /
  last-few transactions.

### 3. `index.js` — routing in `executeTool`

- Handle `get_recent_transactions`: call `actual.recentTransactions(limit)`,
  format the lines, return the text.
- Like balance queries (not expense logging), it does NOT push a deterministic
  confirmation — the formatted list flows back as the model's reply.

## Output format

```
Recent transactions:
Jun 16 · ₱1,500.00 · SM Supermarket → Groceries [#A1B2]
Jun 15 · ₱320.00 · Jollibee → Dining: Out
Jun 14 · +₱5,000.00 · Payroll → Income
```

- Reuses the existing `fmt` helper. Spending shows the amount; income (positive
  amount) gets a `+` prefix.
- The `[#A1B2]` tag appears only when a transaction id is in the undo map
  (reverse txId→code lookup built in `index.js`), so a transaction can be undone
  straight from the list. Web-UI / migration rows have no tag.

## Out of scope (YAGNI)

- Filtering by category / account / date range
- Pagination / "show more"
- Editing or recategorizing from the list
```
