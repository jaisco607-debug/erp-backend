# Trial Balance and Account Ledger: frontend guide

Written for: the frontend developer (and the AI that helps them).

## 1. The idea in plain words

- The **Trial Balance** is a list of every account of the company with how much is **on its debit side** and how much **on its credit side**. It is made only from the posted entries (the ledger), never from the invoices themselves.
- The golden rule of accounting: **the total of all debits is always equal to the total of all credits.** If the Trial Balance does not balance, something is wrong. So after every invoice or voucher, open the Trial Balance: if it balances, the books are consistent.
- For each account it shows three pairs of columns:
  - **Opening** (Dr / Cr): what the account had at the start of the period;
  - **Period** (Dr / Cr): what was posted during the period;
  - **Closing** (Dr / Cr): what it has at the end (opening + period).
- An account's **ledger** is the list of its lines with a running balance. It opens from the Trial Balance when the user clicks an account ("View").
- The server also runs four **checks** and tells the result, so the screen can show a green tick or a red warning (section 5).

## 2. Access

- Service **`ACC_REPORTS`** ("Accounting Reports"), menu tab **`ACCOUNTS`**. It is a report service: **VIEW only** (nobody can have FULL on it).
- The super admin gives it to a company; the client admin gives it to employees.
- Without it every call answers `403 FORBIDDEN`. Another company's books are never visible.
- Show the menu item "Trial Balance" only when the login response `services` list contains `ACC_REPORTS`.

Base path: `/api/v1/accounting`.

## 3. Trial Balance

### GET `/accounting/trial-balance`
Query (all optional):

| Param | Meaning |
|---|---|
| `dateFrom`, `dateTo` | The period (`YYYY-MM-DD`). Default: from the first day of the current fiscal year to today. |
| `fiscalYear` | A whole fiscal year, instead of the dates: `2026` = the year that **starts** in 2026 (with the July start: 1 July 2026 to 30 June 2027). The start month is the company setting `fiscalYearStartMonth` (`GET /accounting/settings`). |
| `includeZero` | `true` also lists accounts with nothing in them. Default `false`. |
| `accountType` | Only `ASSET`, `LIABILITY`, `EQUITY`, `INCOME` or `EXPENSE`. |

A `dateFrom` after `dateTo` answers `422 BAD_RANGE`; a bad date `400`.

Response:
```json
{
  "dateFrom": "2026-08-01", "dateTo": "2026-08-31", "fiscalYearStartMonth": 7,
  "rows": [
    { "accountId": "uuid", "code": "1102", "name": "Bank Account", "accountType": "ASSET", "isActive": true, "isContra": false,
      "level": 3, "parentCode": "1100", "folder": "Assets > Current Assets",
      "openingDebit": "9500.00", "openingCredit": "0.00",
      "periodDebit": "2000.00", "periodCredit": "300.00",
      "closingDebit": "11200.00", "closingCredit": "0.00" }
  ],
  "totals":   { "openingDebit": "10000.00", "openingCredit": "10000.00", "periodDebit": "2300.00", "periodCredit": "2300.00", "closingDebit": "12000.00", "closingCredit": "12000.00" },
  "sections": [ { "accountType": "ASSET", "openingDebit": "...", "...": "..." } ],
  "balanced": true, "difference": "0.00",
  "checks": [ ...section 5... ], "ok": true
}
```

- **Money is a string** with 2 decimals, never a float. Show it as it is (add thousands separators only). Do not add the columns in the browser: use `totals` and `sections`.
- Only **accounts** are rows (not folders). Use `folder` (the path of folders) and `level` to group them if you like. Rows are in code order.
- A balance goes to **one** side: for each account either the Debit or the Credit column of a pair is non-zero. Show `0.00` as a dash if you wish.
- **What counts as "opening":** everything dated before `dateFrom`, plus the **opening balances entry** (the one entered on the Opening Balances screen) whatever its date, as long as it is not after `dateTo`. Entries dated after `dateTo` are left out.
- `sections` gives the same six totals per account type (Assets, Liabilities, Equity, Income, Expenses): use it for the subtotal lines.
- `balanced` is true when debit = credit in all three pairs; `difference` is closing debit minus closing credit (it must be `"0.00"`). `ok` is true only when `balanced` is true **and** every check is ok.

### Screen
1. Filters: Period (two dates, or "Fiscal year" with a year picker), Account type, "Show accounts with no balance" (`includeZero`). A **Refresh** button.
2. A table with the three column pairs, grouped by `accountType` sections with their subtotals, then a **Total** row from `totals`.
3. A banner at the top:
   - green "Trial balance is balanced" when `ok` is true;
   - red "Debit and credit are not equal (difference X)" when `balanced` is false;
   - yellow with the messages of the failed checks when `balanced` is true but `ok` is false.
4. Clicking an account row opens its ledger (section 4).
5. Export (Excel / PDF) and print are done in the browser from the response.

## 4. Account ledger ("View")

### GET `/accounting/ledger?accountId=...&dateFrom=&dateTo=&fiscalYear=`
`accountId` is required and must be an **account** (a folder answers `422 NOT_POSTING_ACCOUNT`). The period works as in the Trial Balance.

```json
{
  "account": { "id": "uuid", "code": "1102", "name": "Bank Account", "accountType": "ASSET", "normalBalance": "DEBIT", "isContra": false },
  "dateFrom": "2026-08-01", "dateTo": "2026-08-31",
  "opening": { "balance": "9500.00", "balanceSide": "DEBIT" },
  "lines": [
    { "entryId": "uuid", "entryNo": 12, "entryDate": "2026-08-10", "sourceType": "SALES_INVOICE", "sourceId": "uuid", "status": "POSTED", "isReversal": false,
      "narration": "Sales invoice 02748 - AZ TEXTILES", "lineNarration": "...", "debit": "2000.00", "credit": "0.00",
      "balance": "11500.00", "balanceSide": "DEBIT", "partyType": "CUSTOMER", "partyId": "uuid", "partyName": "AZ TEXTILES" }
  ],
  "totals": { "debit": "2000.00", "credit": "300.00" },
  "closing": { "balance": "11200.00", "balanceSide": "DEBIT" },
  "truncated": false
}
```
- `opening` includes the opening balances entry, so that entry is **not** a line.
- Each line has a running `balance` and `balanceSide` (the amount has no minus sign; the side says which way it is).
- `sourceType` + `sourceId` tell where the line comes from. For `SALES_INVOICE`, `sourceId` is the invoice id: link the line to the invoice (`GET /sales-invoices/:id`). A line with `isReversal: true` is the reverse entry made when an invoice was un-approved; show it in grey, with its `narration` ("Reversal of entry 12: ...").
- `partyName` is the customer or vendor named on the line (for Receivable / Payable accounts).
- `truncated: true` means there were more than 5,000 lines: ask the user for a shorter period.

## 5. The checks

`checks` is an array. Show each as a row with a green tick (`ok: true`) or a red cross, its `message`, and (when not ok) its details.

| key | What it checks | When it is red |
|---|---|---|
| `TRIAL_BALANCE_BALANCED` | Debit = credit in the opening, period and closing columns | `details` has the three differences |
| `CONTROL_ACCOUNTS_MATCH_SUBLEDGERS` | Accounts Receivable and Accounts Payable agree with the total that the **customers / vendors** owe (the lines that name a customer / vendor) | `accounts[]` has, per control account, `glBalance`, `subledgerBalance`, `difference` and `ok`. A difference means some amount is on the control account without a customer / vendor name |
| `SALES_INVOICES_MATCH_LEDGER` | Every **approved** sales invoice has exactly one live entry of its own total; a **draft** has none | `mismatches[]`: `{ invoiceId, invoiceNo, reason, message, invoiceNet, ledgerDebit }`. `reason` is `APPROVED_WITHOUT_ENTRY`, `APPROVED_WITH_MANY_ENTRIES`, `AMOUNT_DIFFERS` or `DRAFT_IN_LEDGER` |

| `PURCHASE_INVOICES_MATCH_LEDGER` | The same for **purchase invoices**: every approved one has exactly one live entry of its own total; a draft has none | `mismatches[]`: `{ invoiceId, voucherNo, reason, message, invoiceNet, ledgerCredit }`, with the same `reason` values |

The last two checks look at all invoices (not only the period). For a mismatch, link to the invoice with `invoiceId` (sales invoices: `/sales-invoices/:id`, purchase invoices: `/purchase-invoices/:id`).

## 6. How the Sales Invoice shows up here (use this to test)

An approved invoice of Gross 143,200 with 18 % tax (Net 168,976) makes the Trial Balance show, for its period:

| Account | Period Debit | Period Credit |
|---|---|---|
| Accounts Receivable | 168,976.00 | |
| Sales | | 143,200.00 |
| Output Sales Tax | | 25,776.00 |
| **Total** | **168,976.00** | **168,976.00** |

After the invoice is **un-approved**, the period shows both the entry and its reversal (the totals double), and every **closing** amount is back to zero. A **draft** invoice never appears.

## 6b. How the Purchase Invoice shows up here

An approved purchase invoice of Purchases 5,700 and Input Sales Tax 990 (Net 6,690) shows, for its period:

| Account | Period Debit | Period Credit |
|---|---|---|
| Purchases | 5,700.00 | |
| Input Sales Tax | 990.00 | |
| Accounts Payable | | 6,690.00 |
| **Total** | **6,690.00** | **6,690.00** |

The check `CONTROL_ACCOUNTS_MATCH_SUBLEDGERS` then lists Accounts Payable (`controlType: SUPPLIERS`) next to Accounts Receivable: what the books say we owe all vendors must equal what the vendors' lines add up to. In the ledger of Accounts Payable the lines have `partyType: VENDOR` and the `partyName`; `sourceType` is `PURCHASE_INVOICE` and `sourceId` is the invoice id (link to `/purchase-invoices/:id`).

## 7. Errors

`{ "error": { "code", "message" } }`: `400 VALIDATION_FAILED` (bad date or type), `422 BAD_RANGE`, `422 BAD_DATE`, `422 NOT_POSTING_ACCOUNT` (ledger of a folder), `404 NOT_FOUND` (account of another company or unknown), `403 FORBIDDEN` (no `ACC_REPORTS`).

## 8. What to build

1. Menu item "Trial Balance" (service `ACC_REPORTS`).
2. The Trial Balance screen (filters, grouped table, totals, banner, checks panel, export / print).
3. The account ledger screen or side panel, opened from a row; link `SALES_INVOICE` lines to the invoice.
4. In the Sales Invoice screen, after Approve / Un-approve, a small link "Check the books" that opens the Trial Balance.
