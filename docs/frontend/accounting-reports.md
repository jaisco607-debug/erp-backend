# Reports: Customer / vendor balances, Trial balance, Profit & loss, Balance sheet, Receivable & payable at cut-off: frontend guide

Written for: the frontend developer (and the AI that helps them). All five are **read only** reports made from the posted entries (the journal); no report saves anything. The Trial Balance did not change: read `trial-balance.md` for it (section 3 below only says how it fits the Reports menu). The Party Ledger, Accounts Payables / Receivables and Bank Summary are in `ledgers.md`.

## 1. Access and menu

- All five reports use the service **`ACC_REPORTS`** (VIEW only). Without it every call answers `403 FORBIDDEN`. Another company's books are never visible. Show the "Reports" menu only when the login `services` list has `ACC_REPORTS`.
- Suggested menu "Reports" (as in the old software): **Customer / vendor balances**, **Trial balance**, **Profit & loss**, **Balance sheet**, **Receivable & payable at cut-off**.
- Base path `/api/v1/accounting`. Money is a **string with 2 decimals** (`"1415523.00"`); a negative amount has a leading `-`. Format it for display; never add numbers up in the browser (the server sends every total).
- A date is `YYYY-MM-DD`. A bad date is `400 VALIDATION_FAILED`, a start after the end `422 BAD_RANGE`.
- **Fiscal year:** the company setting `fiscalYearStartMonth` (default 7 = July). The server uses it for the default start of a period.

## 2. Customer / vendor balances

The old screen: two lists side by side, **Accounts Receivables** (green) and **Accounts Payables** (red), each with a search box, the name with its id, the number of documents (the "Invoices" button) and the amount, and the total at the bottom. A **Refresh** button and an Excel icon (build the Excel in the browser from the answer).

### GET `/accounting/balances`
Query (optional): `date` (as at this day, default today), `search` (name, NTN, CNIC or code; it filters both lists).

```json
{ "date": "2026-10-27",
  "receivables": { "total": "76955121.00", "partyCount": 9, "otherSide": { "count": 1, "total": "1000.00" },
    "rows": [ { "partyId": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2", "cnic": null, "openCount": 46, "balance": "68003793.00" } ] },
  "payables": { "total": "125024643.00", "partyCount": 40, "otherSide": { "count": 0, "total": "0.00" }, "rows": [ { "partyId": "uuid", "code": 179, "name": "ABDUL GHAFOOR COLOUR CO", "ntn": null, "cnic": null, "openCount": 1, "balance": "8500.00" } ] } }
```

- Each row: **VIEW** button, `name` + "ID: `code`", `openCount` (the number on the "Invoices" / "Bills" button), `balance` (the amount; green for receivables, red for payables). Rows are sorted by name. `total` is the "Total Receivables / Total Payables" line.
- **Receivables** = customers who owe us (a debit balance in the ledger). **Payables** = vendors we owe (a credit balance). A customer who has paid in advance, or a vendor we paid in advance, is on the other side: they are **not** in the lists, but `otherSide` says how many there are and how much, so the screen can show a small note ("1 customer has paid 1,000.00 in advance").
- The balance is the party's **ledger balance** on the date: opening balances, invoices, receipts / payments, journal vouchers and advances all count. `openCount` is the number of approved invoices / bills of the party that were still unpaid on that date.
- **VIEW** (the coloured button) opens the **Party Ledger** (`ledgers.md`, `GET /accounting/party-ledger?partyType=CUSTOMER|VENDOR&partyId=...`), exactly like in Accounts Payables.
- The **Invoices / Bills** button opens a popup with the unpaid documents of that party:

### GET `/accounting/balances/open-items`
Query: `partyType` (`CUSTOMER` or `VENDOR`, required), `partyId` (required), `date` (optional).
```json
{ "party": { "type": "CUSTOMER", "id": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2", "cnic": null }, "date": "2026-10-27",
  "totals": { "amount": "11800.00", "balance": "1800.00" },
  "items": [ { "id": "uuid", "kind": "SALES", "no": 2748, "label": "02748", "billNo": null, "date": "2026-10-10", "type": "WITH_TAX", "typeText": "With sales tax",
               "amount": "11800.00", "before": "10000.00", "balance": "1800.00", "after": "0.00", "stillPending": "1800.00", "flagged": false } ] }
```
`kind` is `SALES` or `PURCHASE`: link the row to `/sales-invoices/:id` or `/purchase-invoices/:id`. For a purchase the vendor's bill number is `billNo`. The meaning of the amounts is in section 6. A `404 NOT_FOUND` means the party is not in this company (or `partyType` does not match it).

## 3. Trial Balance
Unchanged. `GET /accounting/trial-balance` (see `trial-balance.md`). The screen of the old software has: a header with **CSV** and **PDF** buttons (build them in the browser from the answer), the date range and **Refresh**, a search box ("Find account", filter the rows already received), the quick ranges **This financial year**, **This month**, **Last month**, **This calendar year** (just fill in the two dates: the first one is the first day of the fiscal year from the company setting `fiscalYearStartMonth`), four cards **PERIOD DEBIT**, **PERIOD CREDIT**, **CLOSING DEBIT**, **CLOSING CREDIT** (the `totals` object), a **Status** card (`balanced`: "Balanced" with a tick, otherwise "Not balanced" and `difference`), and the table grouped by account type (`sections` give the totals per type; each row has its opening, period and closing debit and credit; the account number is the link to the account ledger). The server's `checks` (section 5 of that guide) can be shown as a small "Books check" panel under the cards.

## 4. Profit & loss

The old screen: a tree: **GROSS PROFIT / (LOSS)** with Revenue and Cost of Sale (folders with accounts inside and an amount on every line), "Total Gross Profit / (Loss)", then **EXPENSES** with their folders, "Total Expenses", and **NET PROFIT / (LOSS)** (red when it is a loss). Every account is a link to its ledger.

### GET `/accounting/profit-loss`
Query (optional): `dateFrom`, `dateTo` (default: first day of the fiscal year to today), `fiscalYear` (a whole year; `2026` = the fiscal year that **starts** in 2026), `includeZero` (`true` also lists accounts and folders with nothing in them; default `false`).

```json
{ "dateFrom": "2026-07-01", "dateTo": "2026-10-31",
  "revenue":     { "total": "9500.00", "nodes": [ { "accountId": "uuid", "code": "4000", "name": "Revenue", "isGroup": true, "amount": "9500.00", "children": [
                     { "accountId": "uuid", "code": "4001", "name": "Sales", "isGroup": false, "isContra": false, "amount": "10000.00", "children": [] },
                     { "accountId": "uuid", "code": "4002", "name": "Sales Returns", "isGroup": false, "isContra": true, "amount": "-500.00", "children": [] } ] } ] },
  "costOfSales": { "total": "4000.00", "nodes": [ ... ] },
  "grossProfit": { "amount": "5500.00", "result": "PROFIT" },
  "expenses":    { "total": "1000.00", "nodes": [ ... ] },
  "netProfit":   { "amount": "4500.00", "result": "PROFIT" } }
```

- **Reading it:** `revenue.total` less `costOfSales.total` = `grossProfit`; less `expenses.total` = `netProfit`. `result` is `PROFIT`, `LOSS` or `null` (exactly zero). `amount` of a profit / loss is always positive: show the word (and red for `LOSS`).
- The sections are made from the Chart of Accounts: income accounts are **Revenue**; expense accounts under the cost-of-sales folder (code 5000 in the standard chart) are **Cost of Sale**; all other expense accounts are **Expenses**.
- A **node** is a folder (`isGroup: true`, its `amount` is the total of its `children`) or an account (`isGroup: false`). Draw the nodes as an indented tree with a collapse arrow on the folders, folder name with its code in brackets ("Revenue (4000)"), accounts as links. The nesting depth is the real depth of the chart.
- **Signs:** every amount is in the natural direction of its section (revenue: credit less debit; expenses: debit less credit). A negative amount means the unusual side, for example "Sales Returns" `-500.00` inside Revenue (it reduces the revenue). Show negatives with a minus sign.
- Only the period's movement counts; the opening balances entry is not part of a profit.
- The link of an account opens the account ledger: `GET /accounting/ledger?accountId=...&dateFrom=...&dateTo=...` (see `trial-balance.md`).
- **Refresh** = the call again with the chosen dates. Excel / PDF: build them in the browser.

## 5. Balance sheet

The old screen: **ASSETS** (Current Asset folder with Trade & Other Receivables, Bank and Cash ...; Non-Current Asset), **Total Assets**, **LIABILITIES** (folders), **Total Liability**, **EQUITY** (Capital, Drawings ...), **Total Equity**, **Profit / (Loss)**, **EQUITY + LIABILITY** and **DIFF**. The same tree look as Profit & loss.

### GET `/accounting/balance-sheet`
Query (optional): `date` (as at this day, default today), `includeZero` (default `false`).

```json
{ "date": "2026-10-31", "fiscalYearStart": "2026-07-01",
  "assets":      { "total": "62800.00", "nodes": [ ... ] },
  "liabilities": { "total": "4800.00", "nodes": [ ... ] },
  "equity": { "accountsTotal": "50500.00", "nodes": [ ... ],
              "earlierYears": { "amount": "3000.00", "result": "PROFIT" },
              "thisYear":     { "amount": "4500.00", "result": "PROFIT" },
              "total": "58000.00" },
  "liabilitiesAndEquity": "62800.00", "difference": "0.00", "balanced": true }
```

- Same `nodes` as in Profit & loss (folders with `children`, accounts with `amount`). Assets are shown debit less credit; liabilities and equity credit less debit; a contra account (Accumulated Depreciation, Owner Drawings) is negative inside its folder.
- **Equity block:** the equity accounts (`nodes`, `accountsTotal` = "Total Equity" of the old screen), then two computed lines: **Profit / (Loss) of earlier years** (`earlierYears`) and **Profit / (Loss) of this year** (`thisYear`: from `fiscalYearStart` to `date`). The books are not closed at the end of a year, so the server works these two out from the income and expense accounts; they are not accounts. `equity.total` is the three together.
- **EQUITY + LIABILITY** = `liabilitiesAndEquity`; **DIFF** = `difference`. The rule is **assets = liabilities + equity**, so `balanced` must be `true` and `difference` `0.00`. If not, show a red warning "The books do not balance" and point the user to the Trial Balance checks.
- The old software showed a DIFF of 166,345,718: ours must show 0. Do not hide a difference.

## 6. Receivable & payable as on cut-off date

The old screen: a header with **Cut-off date**, a **Category** dropdown (their PB / KB; ours has none), **Show** and **Export to Excel**; two cards (**Receivable as on ...** and **Payable as on ...**) each with the ledger amount, the number of customers / vendors and the unpaid invoices / bills figures; tables "by category" and "by invoice / bill type"; a customers table and a vendors table; the buttons **Show invoice-by-invoice detail** / **Show bill-by-bill detail**; a yellow warning when some documents disagree; and a grey note explaining the columns.

### The idea
Two views of the same money:
- **Ledger view** (the headline): what the books say each customer / vendor owes on the date. It includes everything (opening balances, journal vouchers, advances).
- **Invoice view**: the approved sales invoices / purchase invoices dated **up to the cut-off** that were still **unpaid on that date**, with what was received / paid **before** the cut-off, and **after** it (up to today). So the user can see how much of the old debt was settled since.

### GET `/accounting/cutoff`
Query (optional): `date` (the cut-off, default today), `search` (name, NTN, CNIC; for the detail also the invoice number or bill number), `detail` (`true` also sends every document; default `false`, ask for it when the user opens "Show invoice-by-invoice detail").

```json
{ "cutoffDate": "2026-10-15",
  "receivable": {
    "ledgerBalance": "12300.00", "ledgerPartyCount": 1,
    "invoices": { "count": 1, "amount": "11800.00", "before": "0.00", "balance": "11800.00", "after": "10000.00", "stillPending": "1800.00", "mismatched": 0 },
    "byType": [ { "type": "WITH_TAX", "text": "With sales tax", "count": 1, "amount": "11800.00", "before": "0.00", "balance": "11800.00", "after": "10000.00", "stillPending": "1800.00" } ],
    "otherPostings": "500.00",
    "parties": [ { "partyId": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2", "cnic": null, "count": 1, "amount": "11800.00", "before": "0.00", "balance": "11800.00", "after": "10000.00", "stillPending": "1800.00",
                   "perLedger": "12300.00", "perLedgerSide": "NORMAL", "ledgerLessInvoices": "500.00" } ],
    "documents": [ { "id": "uuid", "kind": "SALES", "no": 2748, "label": "02748", "billNo": null, "date": "2026-10-10", "partyId": "uuid", "partyName": "AZ TEXTILES", "type": "WITH_TAX", "typeText": "With sales tax",
                     "amount": "11800.00", "before": "0.00", "balance": "11800.00", "after": "10000.00", "stillPending": "1800.00", "flagged": false } ] },
  "payable": { "...": "the same shape for vendors and purchase invoices (bills)" } }
```
(`documents` only with `detail=true`.)

### What every number means
| Field | Meaning |
|---|---|
| `ledgerBalance` | The headline ("RECEIVABLE AS ON 30-JUN-2026", "PAYABLE AS ON ..."): the total ledger balance of all customers (or vendors) on the cut-off date. `ledgerPartyCount` = how many have a balance. |
| `invoices.count` / `amount` | The documents unpaid on the cut-off, and their full amounts (sales tax included). |
| `before` | What was received / paid on them up to the cut-off (confirmed vouchers dated up to the cut-off). |
| `balance` | **Balance at cut-off** = `amount` - `before` (the blue column). |
| `after` | Received / paid **after** the cut-off. |
| `stillPending` | **Still pending today** = `balance` - `after`. |
| `perLedger` (party row) | The party's ledger balance on the cut-off. `perLedgerSide`: `NORMAL`, or `REVERSED` when the party is on the other side (a customer in credit). |
| `ledgerLessInvoices` (party row) | `perLedger` less the party's invoice `balance`: the part of the ledger that is not an unpaid invoice (opening balances, journal vouchers, advances). The old software's "Ledger less invoices". |
| `otherPostings` | The same for the whole side: `ledgerBalance` less `invoices.balance`: the yellow row "Other ledger postings (opening balances / adjustments, not bills)". |
| `byType` | The documents grouped: sales invoices **With sales tax** / **Without sales tax**; purchase bills **Chemicals** / **General items** / **Chemicals and general items** / **Other** (a bill without store lines). `type` is the code, `text` the label. Add the yellow `otherPostings` row and the **Total (= balance per accounts ledger)** row: `ledgerBalance`. |
| `mismatched` | The number of documents whose "received / paid" amount saved on the invoice does not agree with the confirmed vouchers. The figures follow the **vouchers**. If it is more than 0 show the yellow warning "N bills below have a paid amount on the bill record that differs from the payments allocated to them (highlighted). Please check those bills." and highlight the documents with `flagged: true`. |

- **Screen layout:** the cards (ledger amount, `ledgerPartyCount` customers, the invoice-view figures `invoices.balance` "unpaid invoices" and `invoices.stillPending` "still pending today"); the type table (`byType` + other postings + total); the customers table (name, NTN / CNIC, `count` invoices, `amount`, `before` "received before cut-off", `balance`, `after` "received after cut-off", `stillPending`, and for payables also `perLedger` and `ledgerLessInvoices`) with a Total line; the detail table (`documents`) under the "Show ... detail" fold-out; the grey note. Payable uses the words "bills", "paid", "vendor".
- The detail rows link to the document: `SALES` -> `/sales-invoices/:id`, `PURCHASE` -> `/purchase-invoices/:id`. For a bill show the vendor's `billNo` and the voucher number `label`.
- Paid-in-full documents (paid up to the cut-off) are not in the report. Only **approved** invoices count; drafts never do. Advances are not tied to an invoice, so they appear only in the ledger figures.

## 7. Summary of the calls

| Screen | Call |
|---|---|
| Customer / vendor balances | `GET /accounting/balances`, `GET /accounting/balances/open-items` |
| Trial balance | `GET /accounting/trial-balance` (unchanged), `GET /accounting/ledger` |
| Profit & loss | `GET /accounting/profit-loss` |
| Balance sheet | `GET /accounting/balance-sheet` |
| Receivable & payable at cut-off | `GET /accounting/cutoff` |
| Party Ledger (from the balances lists) | `GET /accounting/party-ledger` (`ledgers.md`) |

## 8. Build order and checks

1. Customer / vendor balances (two lists, search, VIEW to the Party Ledger, the Invoices / Bills popup).
2. Profit & loss and Balance sheet (one tree component for both; the same `nodes` shape).
3. Receivable & payable at cut-off.
4. Trial balance: only the extras of section 3 (quick ranges, cards, status).
5. Test with a company that has some invoices and vouchers: the Balance sheet must say `balanced: true` at every date; Profit & loss net profit of the fiscal year equals the "Profit / (Loss) of this year" line of the Balance sheet at the end of the year; the Receivable total of Customer / vendor balances equals `receivable.ledgerBalance` of the cut-off report for the same date and the same list in Accounts Receivables (`ledgers.md`).

## 9. Notes
- Not built yet: server-side PDF / Excel, comparison with a previous period, a cash-flow statement, a year-end closing, a customer category filter (PB / KB of the old software has no equivalent in this chart).
- Everything is live: pressing Refresh recalculates from the books.
