# Accounting module: all frontend guides in one file

Order: 1 Chart of Accounts, 2 Sales Invoice, 3 Purchase Invoice, 4 Trial Balance and Ledger, 5 Vouchers (payment, receipt, journal), 6 Party Ledger, Payables / Receivables, Bank Summary, 7 Reports (customer / vendor balances, profit & loss, balance sheet, cut-off), 8 Contra voucher, 9 Default accounts. (The customer form guide is a separate, older file.)

---

# Chart of Accounts: frontend guide (version 2, 2026-10-26)

Written for: the frontend developer (and the AI that helps them). It replaces the first version. The tree, the account fields and the error codes of version 1 still work. What is new is marked **NEW**.

Read section 1 first: it explains the ideas in plain words, so the screens can be written for people who do not know accounting.

## 1. The ideas in plain words

- The **Chart of Accounts** is the list of all the "boxes" in which a company keeps its money story. It is a **tree**.
- A **folder** (`isGroup: true`) only holds other boxes: "Current Assets". Nothing is posted to a folder. Its balance is the total of what is inside it.
- An **account** (`isGroup: false`) is a real box where entries are posted: "Cash in Hand".
- Every account has one of five **types**. In friendly words:

| Type | In plain words | Normal balance |
|---|---|---|
| `ASSET` | What the business **has** (cash, bank, money customers owe us, stock, machines) | Debit |
| `LIABILITY` | What the business **owes** (suppliers, loans, taxes) | Credit |
| `EQUITY` | The owner's share (capital, profit kept in the business) | Credit |
| `INCOME` | What the business **earns** (sales) | Credit |
| `EXPENSE` | What the business **spends** (rent, salaries, cost of goods sold) | Debit |

- A **contra** account (`isContra: true`) works against its type: accumulated depreciation lowers the value of equipment, owner drawings lower the owner's share, sales returns lower sales. The server gives it the **opposite** normal balance by itself.
- A **system account** (`isSystem: true`, with a `systemKey`) is one the software relies on (Accounts Receivable, Sales, Retained Earnings ...). It cannot be deleted, switched off, re-typed or made a folder. It **can be renamed**. Show a lock icon.
- The **balance** of an account comes only from posted entries. `currentBalance` is an exact **string** ("1500.50"), `balanceSide` says whether it is `DEBIT` or `CREDIT` (or `null` when zero). A folder's balance is the total of what is inside it.
- The **opening balance** (what the business had on the day the books start) is **not** a field of the account any more. It is ONE special entry, entered on its own screen (section 8).

### "We have / We owe": how to show a balance to a beginner

Use `accountType` and `balanceSide` together. Do the translation in the frontend:

| Account type | balanceSide `DEBIT` | balanceSide `CREDIT` |
|---|---|---|
| ASSET | "We have" | "Check this: an asset should not be on the credit side" |
| LIABILITY | "Check this" | "We owe" |
| EQUITY | "Check this" | "Owner's share" |
| INCOME | "Check this" | "Earned" |
| EXPENSE | "Spent" | "Check this" |

For a contra account (`isContra: true`) the normal side is the opposite one (its `normalBalance` already says which), so judge it by `normalBalance` instead of the type: if `balanceSide` equals `normalBalance`, the balance is normal.
Show the amount without a minus sign (`currentBalance` is never negative). `balanceSigned` is the same amount with a minus when it is a credit; use it only if you must sort.

## 2. Access

- Service **`ACC_COA`** ("Chart of Accounts"), menu tab **`ACCOUNTS`**. The super admin gives it to a company; the client admin gives it to employees as VIEW or FULL.
- VIEW reads everything. FULL also adds, edits, deletes, applies a template and saves the opening balances.
- Without the service every call answers `403 FORBIDDEN`. Another company's accounts are never visible (`404`).
- Show the menu item only when the login response `services` list contains `ACC_COA`.

Base paths: **`/api/v1/accounts`** and **`/api/v1/accounting`**.

## 3. The account object

```json
{
  "id": "uuid", "code": "1103", "name": "Accounts Receivable",
  "parentId": "uuid|null", "parentCode": "1100", "parentName": "Current Assets", "level": 3, "childCount": 0,
  "isGroup": false, "accountType": "ASSET", "normalBalance": "DEBIT", "subType": "CURRENT_ASSET", "controlType": "CUSTOMERS",
  "isActive": true, "isSystem": true, "systemKey": "AR_CONTROL", "isContra": false, "isLocked": true,
  "currentBalance": "1500.50", "balanceSide": "DEBIT", "balanceSigned": "1500.50",
  "canDelete": false, "deleteReason": "SYSTEM_LOCKED", "canDeactivate": false, "deactivateReason": "SYSTEM_LOCKED",
  "openingBalance": 0, "openingSide": "DEBIT",
  "warnings": []
}
```

| Field | Meaning |
|---|---|
| `code` | The account number, unique inside the company. Optional when adding (the server numbers it, see section 5). Stored in capitals. |
| `isGroup`, `parentId`, `level` | Folder or account, where it sits, how deep (top = 1, max 8). |
| `accountType`, `subType`, `controlType` | See `GET /accounts/options`. |
| `normalBalance` | Worked out by the server: from the type, and the opposite when `isContra`. **Do not send it** (an old client may; then the server sets `isContra` for you). |
| `isContra` | **NEW.** Runs against its type. Can be sent when adding or editing. |
| `isSystem`, `systemKey` | **NEW.** A system account and what it is for (`AR_CONTROL`, `AP_CONTROL`, `DEFAULT_SALES`, `DEFAULT_PURCHASES`, `INPUT_TAX`, `OUTPUT_TAX`, `RETAINED_EARNINGS`, `CURRENT_YEAR_EARNINGS`, `ROUNDING`, `OPENING_BALANCE_EQUITY`). Read only. `isLocked` is the old name of `isSystem`. |
| `currentBalance`, `balanceSide`, `balanceSigned` | **NEW.** The exact balance (strings, never numbers). |
| `canDelete`, `deleteReason` | **NEW.** Whether the Delete button should show. When false, `deleteReason` is `SYSTEM_LOCKED`, `HAS_CHILDREN` or `HAS_ENTRIES`. |
| `canDeactivate`, `deactivateReason` | **NEW.** Whether "Switch off" should show. When false: `SYSTEM_LOCKED`, `HAS_ACTIVE_CHILDREN`, `HAS_BALANCE` or `ALREADY_INACTIVE`. |
| `warnings` | **NEW.** Only in the answer of POST and PATCH: a list of hints, not errors (section 9). |
| `openingBalance`, `openingSide` | Old fields, still readable, always 0 for new accounts. Do not show them. |

Money is always a string with 2 decimals. **Never convert it to a float.** Show it as it is (add thousands separators only).

## 4. The first screen: an empty chart

When `GET /accounts/tree` returns `total: 0`, show two big choices:

1. **"Start with a ready chart"** (recommended). Call `GET /accounts/templates` and show the cards: Shop / Trading, Service business, Restaurant / Food, Manufacturing, Other business. Each card has `label`, `description`, `accountCount` and a preview list `accounts` (code, name, folder, type). When the user picks one, call `POST /accounts/apply-template` (section 6) and then reload the tree.
2. **"Start from zero"**: show the add wizard (section 5). A starter button may create the six top folders one by one (Assets 1000, Liabilities 2000, Equity 3000, Income 4000, Cost of Sales 5000, Operating Expenses 6000) with `POST /accounts` and `isGroup: true`: send `{ "name": "Assets", "accountType": "ASSET", "isGroup": true }` and the server numbers it. For Cost of Sales send `{ "name": "Cost of Sales", "accountType": "EXPENSE", "subType": "COST_OF_SALES", "isGroup": true }` (code 5000) and for Operating Expenses `"subType": "OPERATING_EXPENSE"` (code 6000). Use the constants of `GET /accounts/options` (`topCodes`, `folders`, `expenseRanges`); do not write 5000 / 6000 in the frontend.

**Important:** 5000 = Cost of Goods Sold and 6000 = Operating Expenses. **Both are of type `EXPENSE`.** There is no separate "COGS" type.

## 5. The chart screen and the add wizard

### The tree
`GET /accounts/tree` gives the whole chart, nested. Per node show: code, name, type, a lock icon for `isSystem`, a "contra" tag for `isContra`, and the balance (`currentBalance` + the friendly words of section 1). Folders show the total of what is inside.
Use `canDelete` / `canDeactivate` to show or hide the buttons. When the user hovers a hidden button, the reason explains why:

| reason | Say |
|---|---|
| `SYSTEM_LOCKED` | "The software needs this account. You can rename it." |
| `HAS_CHILDREN` | "It has accounts inside it." |
| `HAS_ENTRIES` | "Entries were posted to it. It can only be switched off." |
| `HAS_ACTIVE_CHILDREN` | "Switch off the accounts inside it first." |
| `HAS_BALANCE` | "It still has a balance. Bring it to zero first." |
| `ALREADY_INACTIVE` | (show "Switch on" instead) |

`GET /accounts/tree?isActive=true` hides switched-off accounts. `GET /accounts` is the flat list (search, filters, paging) and has the same fields.

### The add wizard: "What do you want to add?"
Step 1. Call `GET /accounts/presets` and show the cards (`label`, `description`, `icon`). The user picks one, or "Something else".
Step 2 (preset). Show the name (`defaultName`, editable) and nothing else. Send:

```json
POST /accounts   { "presetKey": "bank_account", "name": "Meezan Bank" }
```
The server fills the type, sub type, control type, `isContra`, the folder and the code. **What you send wins over the preset.**

If the folder the preset sits in does not exist, the server answers `422 PARENT_FOLDER_MISSING`:
```json
{ "error": { "code": "PARENT_FOLDER_MISSING", "message": "...",
  "details": { "suggestedFolder": { "code": "1100", "name": "Current Assets", "accountType": "ASSET", "subType": "CURRENT_ASSET", "isGroup": true, "parentCode": "1000" },
               "missingFolders": [ { "code": "1000", "name": "Assets", "...": "..." }, { "code": "1100", "name": "Current Assets", "...": "..." } ] } } }
```
`missingFolders` is ordered from the top. Ask the user ("The folder Current Assets does not exist yet. Create it?"). If yes, create each missing folder in order with `POST /accounts` (`name`, `accountType`, `subType`, `isGroup: true`, `parentId` of the folder before it, and `code` from the folder), then send the preset again.

Step 2 (something else). Ask in this order: type, folder (a picker of folders of that type: `GET /accounts?isGroup=true&isActive=true&accountType=...`), name. Show the suggested code from `GET /accounts/next-code?parentId=...&isGroup=false` and let the user change it. Optional: "Is it a contra account?" (checkbox with the explanation of section 1).

### Codes
`GET /accounts/next-code?parentId=&accountType=&isGroup=&subType=` returns `{ "code": "1104", "rule": "SIBLING" }`. The rules (the server follows them; you only show the answer):
- a top account: Asset 1000, Liability 2000, Equity 3000, Income 4000, Cost of Sales 5000, Operating Expenses 6000, and +100 until free. For an Expense top account send `subType=COST_OF_SALES` for 5000;
- a folder inside a top account: the top code + 100; an account inside a top account: top code + 1;
- deeper: the highest code among its brothers + 1.

Switched-off accounts count as taken. If the user sends no code, `POST /accounts` gives the next one by itself, and two people adding at the same moment never get the same code. If the user types a taken code: `422 CODE_TAKEN`.

### Editing
`PATCH /accounts/:id` with only what changed: `name`, `code`, `parentId`, `isGroup`, `accountType`, `subType`, `controlType`, `isContra`, `isActive`. A system account answers `SYSTEM_LOCKED` to anything except name, code and place. The type of an account that sits inside a folder follows the folder and cannot change.

### Switch off and delete
- Switch off = `PATCH { "isActive": false }`. If the account has a balance the server answers `422 HAS_BALANCE` with `details: { "amount": "500.00", "side": "DEBIT" }`. Show: "This account still has 500.00 (we have). Bring it to zero first, then switch it off."
- Delete = `DELETE /accounts/:id` (`204`). Only when `canDelete` is true. Otherwise offer "Switch off".

## 6. Templates

`GET /accounts/templates` returns `{ data: [ { key, label, description, accountCount, systemAccounts: [...], accounts: [ { code, name, parentCode, accountType, isGroup, subType, controlType, isContra, isSystem, systemKey } ] } ] }`.
Every template contains all the system accounts: Accounts Receivable, Accounts Payable, Default Sales, Cost of Goods Sold (purchases), Input and Output Sales Tax, Retained Earnings, Current Year Earnings, Rounding Difference and Opening Balance Equity.

`POST /accounts/apply-template { "templateKey": "shop" }` returns `200`:
```json
{ "templateKey": "shop", "label": "Shop / Trading",
  "created": [ { "code": "1000", "name": "Assets" } ],
  "skipped": [ { "code": "1103", "name": "Accounts Receivable", "reason": "CODE_EXISTS" } ],
  "adopted": [ { "code": "9100", "name": "Debtors", "systemKey": "AR_CONTROL" } ] }
```
- It is safe to press twice: accounts whose code already exists are skipped (`reason`: `CODE_EXISTS`, `PARENT_MISSING`, `PARENT_MISMATCH`, `NAME_EXISTS`, `SYSTEM_KEY_EXISTS`, `CONTROL_TAKEN`). Show "created X, skipped Y".
- If the company already has an account that does the job of a system account (for example its own receivable account), that account is **adopted** (it becomes the system account) instead of making a second one.
- After the books have entries it is refused: `422 CHART_HAS_ENTRIES`.

## 7. Presets reference

`GET /accounts/presets` returns `{ data: [ { key, label, description, icon, accountType, subType, controlType, isContra, suggestedParentCode, defaultName } ] }`. Keys: `cash_in_hand`, `bank_account`, `customers_owe_us`, `suppliers_we_owe`, `inventory`, `equipment`, `accumulated_depreciation` (contra), `loan`, `tax_payable`, `owner_investment`, `owner_drawings` (contra), `sales_income`, `sales_returns` (contra), `other_income`, `cost_of_goods_sold`, `rent`, `salaries`, `utilities`, `internet_phone`, `bank_charges`, `transport`, `misc_expense`. `icon` is a plain word (`cash`, `bank`, `users` ...); map it to your icon set.

## 8. Opening balances (a real journal entry)

"What did the business have on the day the books start?" This is **one entry** that the server keeps and replaces as a whole. Menu item: "Opening balances" (same service `ACC_COA`).

### Read
`GET /accounting/opening-balances?date=2026-07-01` (the `date` is optional)
```json
{ "date": "2026-07-01", "entryId": "uuid|null", "entryNo": 1, "fiscalYearStartMonth": 7, "plOpeningAllowed": false,
  "locked": false, "lockedReason": null,
  "lines": [ { "accountId": "uuid", "code": "1102", "name": "Bank Account", "accountType": "ASSET", "isActive": true, "side": "DEBIT", "amount": "5000.50", "partyType": null, "partyId": null } ],
  "totals": { "debit": "25000.50", "credit": "25000.50" }, "balanced": true }
```
`plOpeningAllowed` tells whether income and expense accounts may have an opening amount on this date (see below). `locked: true` means the screen is read only.

### Save (replaces everything)
`PUT /accounting/opening-balances`
```json
{ "date": "2026-07-01",
  "lines": [ { "accountId": "uuid", "amount": "5000.50" }, { "accountId": "uuid", "amount": "20000", "side": "DEBIT" } ],
  "balancingAccountId": "uuid" }
```
- `amount` is a decimal **string** (preferred, "1500.50") or a number with at most 2 decimals. More decimals is a `400`. A line with amount 0 is ignored (so the user can clear a line).
- `side` is optional; the default is the normal balance of the account. Send it only when the user chooses the other side.
- The user enters amounts per account; the screen shows a running total of debit and credit and the difference.
- **Debit must equal credit.** If not, `422 UNBALANCED` with `details: { debit, credit, difference, side }`. If `balancingAccountId` is sent, the server puts the difference on that account (suggest the system account `OPENING_BALANCE_EQUITY`: find it in the tree by its `systemKey`). A customer / supplier control account cannot be the balancing account.
- Switched-off accounts may be in the list and count in the totals.
- The old opening entry is **reversed, not erased**; the new one is posted. Clearing all lines leaves only the reversal.
- Returns the same as GET.

### Rules and errors
| code | Meaning |
|---|---|
| `OPENING_LOCKED` | Another entry (an invoice, a voucher) already exists in the books, so the opening balances can no longer be changed. Show the screen read only (`locked: true` and `lockedReason`). |
| `UNBALANCED` | Debit is not equal to credit (see above). |
| `PL_OPENING_NOT_ALLOWED` | An income or expense account has an amount, but the books start on the **first day of the fiscal year**: income and expenses start from zero then. The user may give them an amount only when the books start in the middle of a year. Use `plOpeningAllowed` to disable those lines. |
| `CONTROL_USES_SUBLEDGER` | Accounts Receivable / Payable when the company has customers / vendors: **each line names the customer or vendor** (`partyId`). Show one line per customer (customer picker + amount). With no customers or vendors, one total is fine. |
| `LINE_BAD_PARTY` | A `partyId` on an account that is not Receivable / Payable. |
| `NOT_POSTING_ACCOUNT` | A folder was used. Only accounts take an amount. |
| `ACCOUNT_NOT_FOUND` / `NOT_FOUND` | Unknown account, customer or vendor. |
| `BAD_DATE`, `BAD_AMOUNT`, `400 VALIDATION_FAILED` | Bad date or amount. |

### Fiscal year setting
`GET /accounting/settings` returns `{ "fiscalYearStartMonth": 7 }` (1 = January ... 12 = December; the default is July). `PUT /accounting/settings { "fiscalYearStartMonth": 10 }` (FULL). Show it as "Our financial year starts in: [month]" on the opening balances screen, and let the user change it before saving.

## 9. Hints and the "Problems" list

### Warnings (in POST and PATCH answers)
`warnings: [ { "code": "NAME_TYPE_HINT", "message": "\"Office Rent\" usually belongs to EXPENSE, but this account is ASSET", "suggestedAccountType": "EXPENSE" } ]`. The save has worked; show the hint in a yellow box with "Change type" (only possible for an empty top account) and "Keep as it is". Contra accounts get no hint.

### The problems list
`GET /accounts/issues`
```json
{ "data": [ { "accountId": "uuid|null", "ruleKey": "INACTIVE_WITH_BALANCE", "severity": "ERROR", "message": "...",
              "suggestedFix": { "action": "PATCH_ACCOUNT", "accountId": "uuid", "payload": { "isActive": true } } } ],
  "total": 1, "summary": { "ERROR": 1, "WARNING": 0, "INFO": 0 },
  "rules": [ { "key": "...", "severity": "...", "label": "..." } ] }
```
Worst first. Show a "Problems (3)" badge and a list; each row has the message and a **Fix it** button when `suggestedFix` is not null:
- `action: "PATCH_ACCOUNT"`: send `PATCH /accounts/{accountId}` with `payload`.
- `action: "APPLY_TEMPLATE"`: send `POST /accounts/apply-template` with `payload`.
- `suggestedFix: null`: only a person can decide; show the message.

| ruleKey | Severity | What it means |
|---|---|---|
| `OPENING_WRONG_SIDE` | WARNING | The opening balance is on the opposite side of the account's normal balance (contra accounts are skipped). |
| `BALANCE_WRONG_SIDE` | WARNING | The balance now is on the opposite side (for example cash with a credit balance). Contra accounts are skipped. |
| `INACTIVE_WITH_BALANCE` | ERROR | A switched-off account still has a balance. Fix: switch it on. |
| `NAME_TYPE_MISMATCH` | INFO | The name looks like another type. Fix: change the type, only for an empty top account. |
| `SYSTEM_ACCOUNT_MISSING` | WARNING | A system account does not exist (`systemKey` tells which). Fix: apply the template "other". |
| `EMPTY_FOLDER` | INFO | A folder with nothing inside. Fix: switch it off. |

## 10. All endpoints

| Method and path | Access | What |
|---|---|---|
| `GET /accounts/options` | VIEW | Dropdown values and constants: `accountTypes`, `normalBalance`, `subTypes`, `controlTypes`, `maxLevels`, `topCodes`, `expenseRanges`, `folders`, `systemKeys`. Do not hard-code them. |
| `GET /accounts/tree?isActive=` | VIEW | The nested tree with balances. |
| `GET /accounts` | VIEW | Flat list: `search`, `accountType`, `isGroup`, `isActive`, `parentId`, `page`, `limit` (default 200, max 1000). |
| `GET /accounts/next-code` | VIEW | The next free code. |
| `GET /accounts/presets` | VIEW | The cards of the wizard. |
| `GET /accounts/templates` | VIEW | The business templates with a preview. |
| `GET /accounts/issues` | VIEW | The problems list. |
| `GET /accounts/:id` | VIEW | One account. |
| `POST /accounts` | FULL | Add (`name`, optional `code`, `parentId`, `accountType`, `isGroup`, `subType`, `controlType`, `isContra`, `presetKey`). `201`. |
| `PATCH /accounts/:id` | FULL | Edit. `200`. |
| `DELETE /accounts/:id` | FULL | Delete. `204`. |
| `POST /accounts/apply-template` | FULL | Apply a template. `200`. |
| `GET /accounting/opening-balances` | VIEW | The opening entry. |
| `PUT /accounting/opening-balances` | FULL | Replace the opening entry. |
| `GET /accounting/settings`, `PUT /accounting/settings` | VIEW / FULL | The fiscal year start month. |

## 11. All error codes

Errors look like `{ "error": { "code", "message", "details?" } }`. `400 VALIDATION_FAILED` is a bad value (`details` lists the fields); `403` no access; `404` not found; the rest are `422`.

| code | When |
|---|---|
| `CODE_TAKEN`, `NAME_TAKEN`, `NAME_REQUIRED` | The code or the name is already used at this place, or no name was given (and no preset). |
| `TYPE_REQUIRED`, `TYPE_MISMATCH`, `TYPE_LOCKED` | A top account needs a type; the type differs from the folder's; the type cannot change once the account is in a folder or has accounts / entries. |
| `PARENT_NOT_GROUP`, `PARENT_INACTIVE`, `CYCLE`, `TOO_DEEP` | The folder rules (a parent must be an active folder; no loops; at most 8 levels). |
| `PARENT_FOLDER_MISSING` | **NEW.** A preset's folder does not exist (`details.suggestedFolder`, `details.missingFolders`). |
| `GROUP_CANNOT_BE_CONTROL`, `CONTROL_TYPE_MISMATCH`, `CONTROL_TAKEN`, `BAD_SUB_TYPE` | Control type and sub type rules. |
| `SYSTEM_LOCKED` | **NEW** (it replaces `ACCOUNT_LOCKED`). A system account cannot be deleted, switched off, re-typed, made a folder or have its control type or contra flag changed. |
| `HAS_BALANCE` | **NEW.** Switch off refused: the account has a balance (`details.amount`, `details.side`). |
| `HAS_CHILDREN`, `HAS_ACTIVE_CHILDREN`, `HAS_ENTRIES` | Delete / switch off / re-group refused because of what is inside or posted. |
| `USE_OPENING_BALANCES` | **NEW.** An opening balance was sent on the account. Use the opening balances screen. |
| `OPENING_LOCKED`, `PL_OPENING_NOT_ALLOWED`, `CONTROL_USES_SUBLEDGER`, `UNBALANCED` | **NEW.** Opening balances (section 8). |
| `CHART_HAS_ENTRIES` | **NEW.** A template cannot be applied once entries exist. |
| `UNKNOWN_PRESET` | The preset key does not exist (the validator already answers 400). |

## 12. Step by step: what to build, in order

1. Menu item "Chart of Accounts" (service `ACC_COA`) and "Opening balances".
2. Load `GET /accounts/options` once and keep it.
3. The tree screen with balances, lock and contra marks, and the buttons driven by `canDelete` / `canDeactivate`.
4. The empty-chart screen with the template cards (section 4) and "Apply".
5. The add wizard (presets, then "something else") with `next-code` and the `PARENT_FOLDER_MISSING` flow.
6. The edit form (name, code, folder, contra) and the switch-off / delete flows with the reasons.
7. The hint box for `warnings`.
8. The "Problems" badge and list with "Fix it" buttons.
9. The opening balances screen (read, edit lines, totals and difference, balancing account, save, the locked state, the fiscal year month).
10. Test with an empty company: apply a template; add an account from a preset; try to switch off an account with a balance; enter opening balances; see the Problems list.

## 13. Notes

- The default accounts of a Sales Invoice (Accounts Receivable, Sales, Output Sales Tax) are system accounts. They come from a template, or the server makes them **when the first invoice is saved** (so they appear in the chart as soon as the first invoice exists, with a zero balance until an invoice is approved). See `sales-invoice.md`. The balance of every account can be checked in the Trial Balance (`trial-balance.md`).
- Edit locks are not used for accounts. The server serialises changes inside a company.

---

# Sales Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). Read section 1 first; it explains the idea in plain words.

## 1. The idea in plain words

- A **Sales Invoice** is a bill to **one customer** ("Billed to"): the customer whose cloth we processed.
- The invoice is made of **gate passes**. Every gate pass already has a packing list, and the packing list already has the meters of A, B and CP and the rate of each. So the user does **not type quantities or rates**. He picks the gate passes, and the server fills the lines.
- Different gate passes of the same customer can go to different places ("Delivered to" = the destination written on the gate pass). They can all be on one invoice, or the user can pick only some of them.
- A gate pass can be on **one invoice only**.
- **Two steps:**
  1. **Save** makes the invoice **Un-approved** (a draft). It can be changed or deleted. It has **no effect on the accounts**.
  2. **Approve** posts the **accounting entry** (journal): the money is recorded in the books. After this the invoice is **locked**.
- To change an approved invoice: **Un-approve** it (the server posts a reverse entry, nothing is erased), change it, **Approve** again.
- **The accounts entry** (the "Accounts" button) shows the entry of the invoice. It always balances: Debit = Credit.

The accounting entry made on Approve (example from the real screens: 143,200 + 18 % tax):

| Account | Debit | Credit |
|---|---|---|
| Accounts Receivable | 168,976 | |
| Sales | | 143,200 |
| Output Sales Tax | | 25,776 |
| **Total** | **168,976** | **168,976** |

The three accounts are found by the server in the Chart of Accounts. If the company does not have them yet, the server **makes them when the first invoice is saved** (Accounts Receivable, Sales and Output Sales Tax, as locked system accounts, with the folders above them). A company's own account of the same name is used instead of a new one. The accounts appear in the Chart of Accounts at once, but a draft posts nothing to them (their balances stay zero until an invoice is approved). The frontend does nothing for this; after the first Save, reload the Chart of Accounts if it is open. See `chart-of-accounts.md`, section 13.

**Checking the books:** after every approve / un-approve, open the Trial Balance (see `trial-balance.md`). It must show debit = credit, and its "checks" confirm that every approved invoice agrees with the ledger and that Accounts Receivable agrees with what the customers owe.

## 2. Access

- New service **`ACC_SALES`** ("Sales Invoice"), menu tab **`ACCOUNTS`** (the same tab as Chart of Accounts).
- The super admin gives it to a company; the client admin gives it to employees as VIEW or FULL.
- VIEW: list, open an invoice, see the accounts entry. FULL: also create, edit, delete, approve, un-approve.
- Without the service every call answers `403 FORBIDDEN`. Another company's data is never visible (`404`).
- Show the menu item only when the login response `services` list contains `ACC_SALES`.

Base path: `/api/v1/sales-invoices`.

## 3. The invoice object

```json
{
  "id": "uuid",
  "voucherNo": 1623, "voucherLabel": "01623",
  "invoiceNo": 2748, "invoiceLabel": "02748",
  "invoiceDate": "2026-09-30",
  "customer": { "id": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2", "address": null, "city": "Karachi" },
  "notes": "SMELL BLACK 31583/628", "invoiceDetails": "SMELL BLACK 31583/628", "hsCode": "5208.1100",
  "taxRate": 18,
  "qty": 12962, "gross": 518480, "tax": 93326.4, "net": 611806.4, "received": 0, "balance": 611806.4,
  "status": "UNAPPROVED", "statusText": "Un-approved",
  "approvedAt": null, "approvedBy": null,
  "canEdit": true, "canDelete": true, "canApprove": true, "canUnapprove": false,
  "fbrStatus": null,
  "lines": [ ...see section 4... ]
}
```

| Field | Meaning |
|---|---|
| `voucherNo` | The internal voucher number ("Voucher ID" on the screen). Given by the server, never typed. |
| `invoiceNo` | The invoice number printed on the invoice. Left empty, the server gives the next number. The user may type one to continue his old numbering. Unique per company. |
| `*Label` | The same number with leading zeros (`02748`). Show these. |
| `qty` | Billed quantity (meters) of the whole invoice. |
| `gross` | Amount before tax (sum of the lines). |
| `taxRate` / `tax` | Sales tax percentage (default 18) and its amount: `gross x taxRate / 100`, rounded to 2 decimals. |
| `net` | `gross + tax`. This is what the customer owes. |
| `received` / `balance` | Money received so far (always 0 for now; payments come in a later step) and `net - received`. |
| `status` | `UNAPPROVED` or `APPROVED`. |
| `canEdit`, `canDelete`, `canApprove`, `canUnapprove` | Use these to show or hide buttons. Do not work them out yourself. |
| `fbrStatus` | Always `null` for now. The FBR / Billora upload comes later. Keep the "Upload FBR" button disabled. |

`notes`, `invoiceDetails` and `hsCode` are free text (max 300 / 300 / 20). `hsCode` defaults to `5208.1100`.

All money values are plain JSON numbers with at most 2 decimals. Show them as received (format with thousands separators only). Do not add or multiply them in the browser.

## 4. The lines (one per gate pass)

```json
{
  "lineNo": 1,
  "gatePassId": "uuid", "gatePassNo": 515, "gatePassLabel": "00515", "passDate": "2026-10-08",
  "packingListId": "uuid", "listNo": 12, "soCardId": "uuid", "soLabel": "SO 4871",
  "dcNo": "3105", "quality": "10X7/72X30 BLACK SMELL FABRIC", "colour": "BLACK",
  "deliveredTo": "Lahore", "vehicleNo": "LEA-1234",
  "qtyA": 12962, "qtyB": 235, "qtyCP": 70, "totalQty": 13267,
  "billedQty": 12962, "rateA": 40, "rateB": 0, "rateCP": 0, "amount": 518480
}
```

- This matches the table of the screens: SR (gate pass no), DC#, SO, DATE, QUALITY, COLOUR, DELIVERED TO, A, B, CP, TOTAL, BILLED QTY, RATE, AMOUNT. There is no PO in our data, so leave that column out.
- **Billed qty = the meters of the grades that have a rate.** In the example only grade A has a rate (40), so the B and CP meters are shown but not billed. If a list has rates for A and B, both are billed. `amount = sum over the grades of (meters x rate)`, rounded to 2 decimals per packing line, exactly as on the packing list.
- If `rateA`, `rateB` and `rateCP` are different, show the three rates (or "A 50 / B 25"). If only one grade is billed, show that rate.
- The numbers of an invoice are saved on the invoice. Only the descriptions (quality, colour, deliveredTo ...) are read from the gate pass.
- Lines are read only. The user changes them only by choosing other gate passes.

## 5. Endpoints

### GET `/sales-invoices/options`
```json
{ "statuses": [{ "code": "UNAPPROVED", "text": "Un-approved" }, { "code": "APPROVED", "text": "Approved" }],
  "taxRates": [0, 5, 10, 15, 18], "defaultTaxRate": 18, "defaultHsCode": "5208.1100" }
```
`taxRates` are only suggestions for the Sales Tax dropdown. Any number from 0 to 100 (2 decimals) is accepted.

### GET `/sales-invoices/gate-passes?customerId=...`  (the "Select packing list" dropdown)
The gate passes the user may still put on an invoice: of this customer, not yet on any invoice. Query: `customerId` (required), `destination` (optional, exact venue name, not case sensitive), `search` (gate pass no, packing list no, SO no, destination or vehicle), `invoiceId` (when **editing**, so that the gate passes of this invoice stay in the list), `limit` (default 200).

```json
{ "data": [ { ...line fields (section 4) without lineNo..., "canBill": true, "blockedReason": null } ],
  "total": 2, "destinations": ["Karachi", "Lahore"] }
```
- `destinations` = the venues of the available gate passes (before the `destination` filter). Use it for a "Delivered to" filter dropdown: the user can pick all gate passes of one venue, or tick gate passes of several venues.
- Fabric returns (cloth that was not processed) are never offered.
- `canBill: false` (with `blockedReason`) means the packing list has no rates. Show it greyed out; the server refuses it anyway.

Flow of the form: pick the customer, then call this endpoint, then the user ticks one or more gate passes. Changing the customer clears the ticked gate passes.

### GET `/sales-invoices`  (the Sales Invoices list / summary)
Query (all optional): `status` (`APPROVED` | `UNAPPROVED`; leave out for all), `dateFrom`, `dateTo` (YYYY-MM-DD), `customerId`, `search` (invoice no, voucher no, customer name, NTN, HS code, details, notes), `page` (default 1), `limit` (default 50, max 500).
```json
{ "data": [ { ...invoice without lines... } ], "page": 1, "limit": 50, "total": 50,
  "summary": { "invoices": 50, "amount": 43420343, "tax": 7815662, "net": 51236005, "received": 17215008, "balance": 34020997 } }
```
- `summary` is for **all** invoices that match the filters (not just this page). It gives the six cards at the top: INVOICES, AMOUNT (= gross), SALES TAX, NET AMOUNT, RECEIVED, BALANCE.
- Newest invoice number first.

### GET `/sales-invoices/:id`
One invoice with `lines`.

### POST `/sales-invoices`  (Save, makes an Un-approved invoice)
```json
{ "customerId": "uuid", "gatePassIds": ["uuid", "uuid"], "invoiceDate": "2026-10-24",
  "invoiceNo": 2749, "notes": "...", "invoiceDetails": "...", "hsCode": "5208.1100", "taxRate": 18 }
```
- Required: `customerId`, `gatePassIds` (at least one). Everything else is optional (`invoiceDate` = today, `invoiceNo` = next number, `taxRate` = 18).
- Returns `201` with the invoice (with lines). The amounts in the response are the final ones; show them.

### PATCH `/sales-invoices/:id`  (Update, only while Un-approved)
Send only what changed. Any of: `gatePassIds` (replaces the lines), `taxRate`, `invoiceDate`, `invoiceNo`, `notes`, `invoiceDetails`, `hsCode`, `customerId` (then `gatePassIds` of the new customer are required). The amounts are always worked out again by the server. Returns `200` with the invoice.

### DELETE `/sales-invoices/:id`
Only while Un-approved. `204`. Its gate passes become free again.

### POST `/sales-invoices/:id/approve`  (no body)
Posts the accounting entry. Returns `200` with the invoice (`status: APPROVED`). The amounts are worked out once more from the gate passes before posting.

### POST `/sales-invoices/:id/unapprove`  (optional body `{ "reason": "wrong rate" }`)
Posts the reverse entry and returns the invoice to `UNAPPROVED`. Not possible after money was received (later step). Returns `200` with the invoice.

### GET `/sales-invoices/:id/accounts-entry`  (the "Accounts" button)
```json
{
  "invoiceId": "uuid", "invoiceLabel": "01620", "status": "APPROVED", "posted": true,
  "current": {
    "entryNo": 41, "entryDate": "2026-09-30", "status": "POSTED", "narration": "Sales invoice 01620 - HAMID ENTERPRISES",
    "lines": [ { "lineNo": 1, "account": { "id": "uuid", "code": "1003", "name": "Accounts Receivable" }, "debit": 168976, "credit": 0, "partyType": "CUSTOMER", "partyId": "uuid" },
               { "lineNo": 2, "account": { "code": "4001", "name": "Sales" }, "debit": 0, "credit": 143200 },
               { "lineNo": 3, "account": { "code": "1010", "name": "Output Sales Tax" }, "debit": 0, "credit": 25776 } ],
    "totals": { "debit": 168976, "credit": 168976 }, "balanced": true
  },
  "entries": [ ...every entry of this invoice, oldest first (see below)... ]
}
```
- Show `current` in the "Accounts entry" popup (title "Accounts entry", subtitle "Posted to the ledger"): the table Account / Debit / Credit, the Total row, and the green line "Debit equals credit." when `balanced` is true.
- `current` is `null` and `posted` is `false` while the invoice is Un-approved. Then show "Not posted yet. Approve the invoice to post it to the ledger."
- `entries` is the full history: after an un-approve you see the first entry (`status: REVERSED`) and the reverse entry (`reversalOfId` set). Optional: show it under "History".

## 6. Rules and errors

Errors look like `{ "error": { "code", "message", "details?" } }`. `400 VALIDATION_FAILED` is a bad value. The codes below are `422` unless written otherwise. Show `message` to the user.

| code | When |
|---|---|
| `GATE_PASS_OTHER_CUSTOMER` | A chosen gate pass belongs to another customer. |
| `GATE_PASS_TAKEN` | The gate pass is already on another invoice (the message names it). |
| `GREY_RETURN_NOT_SOLD` | Fabric return cloth is not sold. |
| `NO_RATES` | The packing list of the gate pass has no rates, so there is nothing to bill. |
| `GATE_PASSES_REQUIRED` | The customer was changed without choosing gate passes. |
| `INVOICE_NO_TAKEN` | The typed invoice number is already used. |
| `INVOICE_APPROVED` | An approved invoice cannot be edited or deleted. Un-approve it first. |
| `ALREADY_APPROVED` / `NOT_APPROVED` | Approve on an approved invoice / un-approve on one that is not approved. |
| `NOTHING_TO_BILL` | The invoice amount is zero. |
| `HAS_RECEIPTS` | Money was received against the invoice; it cannot be un-approved. |
| `DEFAULT_ACCOUNT_INACTIVE` | One of the default accounts (Accounts Receivable, Sales, Output Sales Tax) was switched off in the Chart of Accounts. The message names it. Ask the user to switch it on. |
| `PARENT_INACTIVE` | While making a missing default account: a header it must sit in is switched off (the message names it). |
| `NOT_FOUND` (404) | The invoice, customer or gate pass does not exist in this company. |
| `FORBIDDEN` (403) | No `ACC_SALES` service, or VIEW only. |

## 7. What to build

1. **Sales Invoices screen** (list): the six summary cards, the filters (Show: All / Approved / Un-approved, Period or dates, Search, Apply, Clear), the table (Invoice, ID = voucher, Date, Customer + invoice details in grey, Qty, Amount, Tax, Net, Received), and the "New invoice" and "Export" buttons. Clicking a row opens the invoice. Export can be done in the browser from the loaded list.
2. **Invoice form** (new and open): header with status badge (Un-approved / Approved) and the buttons from `canEdit`, `canApprove`, `canUnapprove`, `canDelete`. Fields: Billed to (customer picker), NTN / Address (read only from `customer`), Invoice # (empty = automatic), Date, Notes, Invoice details, HS Code, FBR status (disabled for now). The "Sales details" tab holds the lines table and **Select packing list** (the gate pass dropdown described above). The totals bar shows GROSS, SALES TAX (with the rate dropdown), NET, RECEIVED, BALANCE. The **Payments** tab is empty for now (receipts come in a later step).
3. **Buttons:** Save (new) / Update (edit) ; Approve ; Un-approve (ask for an optional reason) ; Delete (confirm) ; Accounts (opens the popup) ; Print (the frontend makes the print layout) ; Upload FBR (disabled) ; Close.
4. After every Save, Update, Approve or Un-approve, replace the whole screen with the invoice returned by the server.
5. Totals shown while the user is still choosing gate passes (before Save) may be worked out in the browser from the gate pass `amount` values and the tax rate for display only. The server's numbers after Save are the real ones.

## 8. Notes

- **Dates:** `invoiceDate` is a plain date `YYYY-MM-DD`. The books use the invoice date.
- **One invoice, one customer.** If the user needs two customers, he makes two invoices.
- **Nothing is deleted from the books.** Un-approve posts a reverse entry; the Chart of Accounts shows the account balances only through entries, never through the invoice.
- Payments (Receipt Voucher), FBR upload and purchase invoices come in later steps. Keep their buttons visible but disabled where the screens show them.

---

# Purchase Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). It is the mirror of the Sales Invoice (`sales-invoice.md`): read that first if you can, most things work the same way. Read section 1 here first; it explains the idea in plain words.

## 1. The idea in plain words

- A **Purchase Invoice** is the **bill of one vendor** (supplier): what we bought from him and now **owe** him. (A Sales Invoice is the opposite: what a customer owes us.)
- It is made of the vendor's **purchases from the store**: the approved entries of the **Chemical Store** and the **General Store** (each of them has a vendor, the items and the amount; a Chemical Store purchase on a GST bill also carries the sales tax; a General Store purchase never carries sales tax). The user does **not type amounts**. He picks the vendor, ticks the store purchases the bill is for, and the server fills the lines.
- A store purchase can be on **one purchase invoice only**.
- **Two steps:**
  1. **Save** makes the invoice **Un-approved** (a draft). It can be changed or deleted. It has **no effect on the accounts**.
  2. **Approve** posts the **accounting entry**: the debt to the vendor is recorded in the books. After this the invoice is **locked**.
- To change an approved invoice: **Un-approve** it (the server posts a reverse entry, nothing is erased), change it, **Approve** again.
- **The accounts entry** (the "Accounts" button) shows the entry of the invoice. It always balances: Debit = Credit.

The accounting entry made on Approve (example: purchases of 5,700 and sales tax of 990):

| Account | Debit | Credit |
|---|---|---|
| Purchases | 5,700 | |
| Input Sales Tax | 990 | |
| Accounts Payable (the vendor is named on the line) | | 6,690 |
| **Total** | **6,690** | **6,690** |

In plain words: the purchases are a cost (Purchases); the sales tax the vendor charged us can be claimed back from the government (Input Sales Tax, an asset); and we now owe the vendor 6,690 (Accounts Payable).

The three accounts are found by the server in the Chart of Accounts. If the company does not have them yet, the server **makes them when the first purchase invoice is saved**: Purchases (in the folder Cost of Sales), Input Sales Tax (in Assets / Current Assets) and Accounts Payable (in Liabilities / Current Liabilities), as locked system accounts. A company's own account of the same name is used instead of a new one. A draft posts nothing to them (balances stay zero until an invoice is approved). The frontend does nothing for this; after the first Save, reload the Chart of Accounts if it is open.

**Checking the books:** after every approve / un-approve, open the Trial Balance (`trial-balance.md`). It must show debit = credit; its checks confirm that every approved purchase invoice agrees with the ledger, and that Accounts Payable agrees with what we owe each vendor.

**A purchase that is on an invoice is locked in the store.** While a store purchase is on a purchase invoice (draft or approved), the store screens cannot "Correct" or "Un-approve" it: the server answers `ENTRY_ON_PURCHASE_INVOICE` (section 6). Show that message in the store screens. To change the purchase, the invoice is un-approved (if needed) or deleted first; when the invoice is saved or approved again it takes the new amounts.

## 2. Access

- New service **`ACC_PURCHASES`** ("Purchase Invoice"), menu tab **`ACCOUNTS`** (with Chart of Accounts and Sales Invoice).
- The super admin gives it to a company; the client admin gives it to employees as VIEW or FULL.
- VIEW: list, open an invoice, see the accounts entry. FULL: also create, edit, delete, approve, un-approve.
- Without the service every call answers `403 FORBIDDEN`. Another company's data is never visible (`404`).
- Show the menu item only when the login response `services` list contains `ACC_PURCHASES`.

Base path: `/api/v1/purchase-invoices`.

## 3. The invoice object

```json
{
  "id": "uuid",
  "voucherNo": 12, "voucherLabel": "00012",
  "billNo": "S-SES2358",
  "invoiceDate": "2026-10-24", "dueDate": "2026-11-23",
  "vendor": { "id": "uuid", "code": 7, "name": "NEXUS CHEMICAL", "ntn": "1234567-8", "address": null, "city": "Karachi" },
  "notes": "October chemicals", "billDetails": null,
  "inwardCount": 3,
  "gross": 5700, "tax": 990, "net": 6690, "paid": 0, "balance": 6690,
  "status": "UNAPPROVED", "statusText": "Un-approved",
  "approvedAt": null, "approvedBy": null,
  "canEdit": true, "canDelete": true, "canApprove": true, "canUnapprove": false,
  "lines": [ "...see section 4..." ]
}
```

| Field | Meaning |
|---|---|
| `voucherNo` | Our own number of the invoice ("Voucher ID"). Given by the server, never typed. |
| `billNo` | The number printed on the **vendor's own bill** (text, optional, max 50). A vendor's bill number can be entered only once (not case sensitive): a second time answers `BILL_NO_TAKEN`. Two different vendors may have the same number. |
| `invoiceDate`, `dueDate` | The bill date (default today) and the day it must be paid (optional, not before the bill date). The books use `invoiceDate`. |
| `inwardCount` | How many store purchases are on the invoice. |
| `gross` | The purchases without tax (sum of the lines). |
| `tax` | The sales tax of the purchases (sum of the lines). There is no tax rate to choose: the tax is what the store purchases carry. |
| `net` | `gross + tax`: what we owe the vendor. |
| `paid`, `balance` | Money paid to the vendor so far (always 0 for now; payments come in a later step) and `net - paid`. |
| `status` | `UNAPPROVED` or `APPROVED`. |
| `canEdit`, `canDelete`, `canApprove`, `canUnapprove` | Use these to show or hide buttons. Do not work them out yourself. |

All money values are plain JSON numbers with at most 2 decimals. Show them as received (format with thousands separators only). Do not add or multiply them in the browser.

## 4. The lines (one per store purchase)

```json
{
  "lineNo": 1,
  "inwardId": "uuid", "store": "CHEMICAL", "storeText": "Chemical Store",
  "idNo": 909, "idLabel": "00909", "ipNo": 805, "ipLabel": "00805",
  "inwardDate": "2026-10-10", "billType": "GST", "grnNo": "G-55", "dcNo": "DC-1", "notes": null,
  "items": "Caustic Soda, Acetic Acid", "gstPercent": 18,
  "amount": 5000, "salesTax": 900, "net": 5900
}
```

- `store` / `storeText` say which store it came from. `idNo` / `ipNo` are the numbers shown in the store screens (ID# and IP#).
- `items` is the names of the items bought, for display.
- `amount` and `salesTax` are the numbers **saved on the invoice**. The descriptions are read from the store entry.
- Lines are read only. The user changes them only by choosing other purchases.

## 5. Endpoints

### GET `/purchase-invoices/options`
`{ "statuses": [ { "code": "UNAPPROVED", "text": "Un-approved" }, { "code": "APPROVED", "text": "Approved" } ], "stores": [ { "code": "CHEMICAL", "text": "Chemical Store" }, { "code": "GENERAL", "text": "General Store" } ] }`

### GET `/purchase-invoices/inwards?vendorId=...`  (the "Select purchases" list)
The approved store purchases of this vendor that can still be put on an invoice. Query: `vendorId` (required), `store` (`CHEMICAL` or `GENERAL`, optional), `search` (ID#, IP#, GRN, DC, notes or item name), `invoiceId` (when **editing**, so that the purchases of this invoice stay in the list), `limit` (default 200).
```json
{ "data": [ { "...line fields (section 4) without lineNo...": "", "canBill": true, "blockedReason": null } ], "total": 3 }
```
- Draft (not approved) store purchases are never listed: the store must approve them first.
- `canBill: false` (with `blockedReason`) means the purchase has no amount. Show it greyed out; the server refuses it anyway.

Flow of the form: pick the vendor, then call this endpoint, then the user ticks one or more purchases. Changing the vendor clears the ticked purchases.

### GET `/purchase-invoices`  (the list / summary)
Query (all optional): `status` (`APPROVED` | `UNAPPROVED`; leave out for all), `dateFrom`, `dateTo` (YYYY-MM-DD), `vendorId`, `search` (voucher no, vendor name, NTN, vendor's bill no, details, notes), `page` (default 1), `limit` (default 50, max 500).
```json
{ "data": [ { "...invoice without lines...": "" } ], "page": 1, "limit": 50, "total": 12,
  "summary": { "invoices": 12, "amount": 1500000, "tax": 120000, "net": 1620000, "paid": 0, "balance": 1620000 } }
```
- `summary` is for **all** invoices that match the filters (not just this page): the cards INVOICES, AMOUNT (= gross), SALES TAX, NET AMOUNT, PAID, BALANCE (what we still owe).
- Newest voucher number first.

### GET `/purchase-invoices/:id`
One invoice with `lines`.

### POST `/purchase-invoices`  (Save, makes an Un-approved invoice)
```json
{ "vendorId": "uuid", "inwardIds": ["uuid", "uuid"], "invoiceDate": "2026-10-24", "dueDate": "2026-11-23",
  "billNo": "S-SES2358", "notes": "...", "billDetails": "..." }
```
- Required: `vendorId`, `inwardIds` (at least one). Everything else is optional.
- Returns `201` with the invoice (with lines). The amounts in the response are the final ones.
- The first Save in a company also makes the default accounts (section 1).

### PATCH `/purchase-invoices/:id`  (Update, only while Un-approved)
Send only what changed. Any of: `inwardIds` (replaces the lines), `invoiceDate`, `dueDate` (send `null` to clear), `billNo`, `notes`, `billDetails`, `vendorId` (then `inwardIds` of the new vendor are required). The amounts are always worked out again by the server. Returns `200` with the invoice.

### DELETE `/purchase-invoices/:id`
Only while Un-approved. `204`. Its store purchases become free again.

### POST `/purchase-invoices/:id/approve`  (no body)
Posts the accounting entry. Returns `200` with the invoice (`status: APPROVED`). The amounts are worked out once more from the store purchases before posting.

### POST `/purchase-invoices/:id/unapprove`  (optional body `{ "reason": "wrong bill" }`)
Posts the reverse entry and returns the invoice to `UNAPPROVED`. Not possible after money was paid (later step). Returns `200` with the invoice.

### GET `/purchase-invoices/:id/accounts-entry`  (the "Accounts" button)
```json
{
  "invoiceId": "uuid", "invoiceLabel": "00012", "status": "APPROVED", "posted": true,
  "current": {
    "entryNo": 41, "entryDate": "2026-10-24", "status": "POSTED", "narration": "Purchase invoice 00012 - NEXUS CHEMICAL (bill S-SES2358)",
    "lines": [ { "lineNo": 1, "account": { "id": "uuid", "code": "5001", "name": "Purchases" }, "debit": 5700, "credit": 0 },
               { "lineNo": 2, "account": { "code": "1104", "name": "Input Sales Tax" }, "debit": 990, "credit": 0 },
               { "lineNo": 3, "account": { "code": "2101", "name": "Accounts Payable" }, "debit": 0, "credit": 6690, "partyType": "VENDOR", "partyId": "uuid" } ],
    "totals": { "debit": 6690, "credit": 6690 }, "balanced": true
  },
  "entries": [ "...every entry of this invoice, oldest first..." ]
}
```
- Show `current` in the "Accounts entry" popup (title "Accounts entry", subtitle "Posted to the ledger"): the table Account / Debit / Credit, the Total row, and the green line "Debit equals credit." when `balanced` is true.
- `current` is `null` and `posted` is `false` while the invoice is Un-approved. Then show "Not posted yet. Approve the invoice to post it to the ledger."
- `entries` is the full history: after an un-approve you see the first entry (`status: REVERSED`) and the reverse entry (`reversalOfId` set). Optional: show it under "History".

## 6. Rules and errors

Errors look like `{ "error": { "code", "message", "details?" } }`. `400 VALIDATION_FAILED` is a bad value. The codes below are `422` unless written otherwise. Show `message` to the user.

| code | When |
|---|---|
| `INWARD_NOT_APPROVED` | A chosen store purchase is not approved in the store yet. |
| `INWARD_OTHER_VENDOR` | A chosen purchase belongs to another vendor; one invoice is for one vendor. |
| `INWARD_TAKEN` | The purchase is already on another purchase invoice (the message names it). |
| `NO_AMOUNT` | The purchase has no amount, so there is nothing to bill. |
| `INWARDS_REQUIRED` | The vendor was changed without choosing the purchases of the new vendor. |
| `BILL_NO_TAKEN` | This vendor's bill number is already entered (the message names the invoice). |
| `DUE_BEFORE_DATE` | The due date is before the invoice date. |
| `INVOICE_APPROVED` | An approved invoice cannot be edited or deleted. Un-approve it first. |
| `ALREADY_APPROVED` / `NOT_APPROVED` | Approve on an approved invoice / un-approve on one that is not approved. |
| `NOTHING_TO_BILL` | The invoice amount is zero. |
| `HAS_PAYMENTS` | Money was paid against the invoice; it cannot be un-approved. |
| `DEFAULT_ACCOUNT_INACTIVE` | One of the default accounts (Purchases, Input Sales Tax, Accounts Payable) was switched off in the Chart of Accounts. The message names it. Ask the user to switch it on. (It can appear on Save and on Approve.) |
| `ENTRY_ON_PURCHASE_INVOICE` | **In the Store screens** (Correct / Un-approve of a purchase): the purchase is on a purchase invoice. Un-approve or delete that invoice first. |
| `NOT_FOUND` (404) | The invoice, vendor or purchase does not exist in this company. |
| `FORBIDDEN` (403) | No `ACC_PURCHASES` service, or VIEW only. |

## 7. What to build

1. **Purchase Invoices screen** (list): the six summary cards, the filters (Show: All / Approved / Un-approved, dates, Search, Apply, Clear), the table (Voucher, Date, Vendor + vendor's bill no, Due date, Amount, Tax, Net, Paid, Balance), and the "New purchase invoice" and "Export" buttons. Clicking a row opens the invoice.
2. **Invoice form** (new and open): header with the status badge and the buttons from `canEdit`, `canApprove`, `canUnapprove`, `canDelete`. Fields: Vendor (picker), NTN / Address (read only from `vendor`), Vendor's bill # , Invoice date, Due date, Notes, Details. The lines table with **Select purchases** (the list above, with a Chemical / General filter). The totals bar shows GROSS, SALES TAX, NET, PAID, BALANCE. The **Payments** tab is empty for now (payments come in a later step).
3. **Buttons:** Save (new) / Update (edit); Approve; Un-approve (ask for an optional reason); Delete (confirm); Accounts (opens the popup); Print (the frontend makes the print layout); Close.
4. After every Save, Update, Approve or Un-approve, replace the whole screen with the invoice returned by the server.
5. Totals shown while the user is still choosing purchases may be worked out in the browser from the `amount` and `salesTax` of the ticked purchases, for display only. The server's numbers after Save are the real ones.
6. After Approve / Un-approve, a small link **"Check the books"** that opens the Trial Balance.
7. In the Store screens, show the `ENTRY_ON_PURCHASE_INVOICE` message when Correct / Un-approve of a purchase is refused.

## 8. Notes

- **Dates:** plain dates `YYYY-MM-DD`. The books use the invoice date.
- **One invoice, one vendor.** For two vendors make two invoices.
- **Nothing is deleted from the books.** Un-approve posts a reverse entry.
- Goods **returned to the vendor** and **payments to the vendor** come in later steps (a debit note and the Payment Voucher). Until then the invoice shows the full amount of the store purchases.
- A bill for services or expenses that did not come through the store (rent, a repair) is not part of this screen yet.

---

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

---

# Vouchers: Payment Voucher, Receipt Voucher, Journal Voucher: frontend guide

Written for: the frontend developer (and the AI that helps them). Read section 1 first: it explains in plain words what each voucher does to the books. The three vouchers work the same way (draft, confirm, move to draft); the parts that differ are in their own sections.

## 1. The ideas in plain words

- A **voucher** is the paper (the screen) for one money event. There are three kinds:
  - **Payment Voucher (VPV)**: we **pay a vendor** (a supplier) from a bank or cash account.
  - **Receipt Voucher (CRV)**: a **customer pays us**, into a bank or cash account.
  - **Journal Voucher (JV)**: everything else, in accountant's form: any debit and credit lines that balance (a cash deposit into the bank, bank charges, the owner's capital, a loan, an adjustment).
- Every voucher goes through the same steps:
  1. **Save** makes a **Draft**. A draft can be changed or deleted and has **no effect** on the books or on the invoices.
  2. **Confirm** posts the **accounting entry** (the books change) and, for payments and receipts, marks the invoices as paid. After this the voucher is **locked**.
  3. **Move to draft** (un-confirm) undoes a confirmed voucher: the server posts a reverse entry (nothing is erased) and the invoices' paid amounts go back. Then the voucher can be changed and confirmed again.
- **Advance**: money paid or received **before** a bill or an invoice exists. The user ticks "Advance" instead of choosing a bill / invoice. It goes to its own account (Supplier Advances: money we gave a vendor in advance, an asset; Customer Advances: money a customer gave us in advance, which we owe him in goods, a liability), with the vendor / customer named, so it can be adjusted later.
- **Income tax withheld.** In Pakistan the payer often keeps back a part of the payment as income tax and pays it to the government:
  - when **we pay a vendor**, we withhold it (we owe it to the government): the vendor receives less;
  - when **a customer pays us**, he withholds it: we receive less, but the whole invoice is settled, and the withheld tax is an amount we can claim back later.

### What each voucher does to the books (the accounting entry)

**Payment Voucher** (example: bills 5,900 + 500, an advance of 600, income tax 0.25 % withheld):

| Account | Debit | Credit |
|---|---|---|
| Accounts Payable (each bill, the vendor is named) | 5,900 + 500 | |
| Supplier Advances (each advance, the vendor is named) | 600 | |
| Income Tax - Vendors (what we withheld) | | 17.50 |
| Bank or Cash (what we really paid) | | 6,982.50 |
| **Total** | **7,000** | **7,000** |

In words: we owe the vendor less (Payable goes down by the bills), we gave him an advance (an asset), we owe the government 17.50, and the bank paid out 6,982.50.

**Receipt Voucher** (example: a cheque of 9,800 with 2 % income tax withheld settles an invoice of 10,000, plus an advance of 1,000):

| Account | Debit | Credit |
|---|---|---|
| Bank or Cash (the cheques) | 10,800 | |
| Income Tax - Customers (what the customer withheld) | 200 | |
| Accounts Receivable (each invoice, the customer is named) | | 10,000 |
| Customer Advances (each advance, the customer is named) | | 1,000 |
| **Total** | **11,000** | **11,000** |

**Journal Voucher** (example: 5,000 cash deposited into the bank):

| Account | Debit | Credit |
|---|---|---|
| Bank Account | 5,000 | |
| Cash in Hand | | 5,000 |

A transfer between cash and bank is **not** income and not expense: it is only a move between two asset accounts.

## 2. Access

| Voucher | Service | Base path |
|---|---|---|
| Payment Voucher | **`ACC_PAYMENTS`** | `/api/v1/payment-vouchers` |
| Receipt Voucher | **`ACC_RECEIPTS`** | `/api/v1/receipt-vouchers` |
| Journal Voucher | **`ACC_JOURNAL`** | `/api/v1/journal-vouchers` |

- Menu tab **`ACCOUNTS`** (with Chart of Accounts, Sales Invoice, Purchase Invoice, reports). Each voucher has its **own** service: the super admin gives them to a company, the client admin gives them to employees as VIEW or FULL.
- VIEW: list, open, see the accounts entry. FULL: also create, edit, delete, confirm, move to draft.
- Without the service every call answers `403 FORBIDDEN` (the service of another voucher does not help). Another company's data is never visible (`404`).
- Show a menu item only when the login response `services` list contains its service code.
- **Numbers:** each voucher type has its **own** number series per company, starting at 1: `voucherNo`, shown with zeros as `voucherLabel` (`00001`). The server gives it; the user never types it.

## 3. Things all three vouchers share

Every voucher answer has:

| Field | Meaning |
|---|---|
| `id`, `voucherNo`, `voucherLabel`, `voucherDate` | Identity and the date of the voucher (the books use it). |
| `status`, `statusText` | `DRAFT` ("Draft") or `CONFIRMED` ("Confirmed"). |
| `confirmedAt`, `confirmedBy` | When and by whom (null for a draft). |
| `canEdit`, `canDelete`, `canConfirm`, `canUnconfirm` | Show or hide the buttons by these. Do not work them out yourself. |
| `lines` | In the single-voucher answer only (not in the list). |

Common endpoints (replace `{path}` by `payment-vouchers`, `receipt-vouchers` or `journal-vouchers`):

| Call | What |
|---|---|
| `GET {path}/options` | Dropdown values (modes, bank and cash accounts, tax rate suggestions ...). |
| `GET {path}` | The list with a `summary` (the cards of the summary screen). Query: `status` (`DRAFT` or `CONFIRMED`), `dateFrom`, `dateTo`, `search`, `page` (default 1), `limit` (default 50), and `vendorId` (payments) / `customerId` (receipts). Newest voucher number first. |
| `GET {path}/:id` | One voucher with its lines. |
| `POST {path}` | Save a draft. `201`. |
| `PATCH {path}/:id` | Change a draft: send only what changed (when you send `lines`, send **all** the lines again). `200`. |
| `DELETE {path}/:id` | Delete a draft. `204`. |
| `POST {path}/:id/confirm` | Confirm (no body). `200` with the voucher. |
| `POST {path}/:id/unconfirm` | Move to draft. Optional body `{ "reason": "wrong cheque" }`. `200` with the voucher. |
| `GET {path}/:id/accounts-entry` | The "Accounts" popup: `{ posted, current, entries }` (the same shape as the invoices: `current` is the live entry with `lines` (account, debit, credit, party) and `totals`, or `null` while a draft; `entries` is the history including reversals). |

Money is a plain JSON number with at most 2 decimals. When **sending** an amount you may use a number (`5900.5`) or a decimal string (`"5900.50"`); more than 2 decimals is an error. Show amounts as received; do not add or multiply them in the browser (see the one allowed exception in section 5).

After **every** Save, Update, Confirm and Move to draft, replace the whole screen with the voucher the server returns.

**Payment modes** (`paymentMode`): `CASH`, `CHEQUE`, `ONLINE` (bank transfer / IBFT), `PAY_ORDER`. `chequeDate` and `chequeNo` are optional text/date; show them when the mode is `CHEQUE`.

## 4. Payment Voucher

### The screen (from the real software)
Header: **Pay from (bank / cash account)** + payment mode; **Pay to (vendor)**; Notes; Date; Cheque date; Cheque #. Then **Add bill payment**: Type ("Advance" tick), Vendor bill (picker), Bill ID, Bill date, Amount to pay, **Add**. A table of the lines (Line, Bill, IP #, Bill #, Bill date, Notes, Amount). Totals: **Bills total**, **Withholding** (income tax), **Net payable**.

### Dropdown data
`GET /payment-vouchers/options`
```json
{ "modes": [ { "code": "CASH", "text": "Cash" }, { "code": "CHEQUE", "text": "Cheque" }, { "code": "ONLINE", "text": "Online / bank transfer" }, { "code": "PAY_ORDER", "text": "Pay order" } ],
  "statuses": [ { "code": "DRAFT", "text": "Draft" }, { "code": "CONFIRMED", "text": "Confirmed" } ],
  "payFromAccounts": [ { "id": "uuid", "code": "1102", "name": "Bank Account", "controlType": "BANK" } ],
  "incomeTaxRates": [ 0, 0.25, 0.5, 1, 1.5, 2, 3, 4.5, 5, 7.5, 10, 15 ] }
```
`payFromAccounts` are the bank and cash accounts of the company (the picker for "Pay from"). `incomeTaxRates` are **suggestions** for the dropdown; any rate from 0 up to 99.99 is accepted.

### The bills picker
`GET /payment-vouchers/bills?vendorId=...` (optional `search`, `limit`): the vendor's **approved purchase invoices that still have something to pay**.
```json
{ "data": [ { "purchaseInvoiceId": "uuid", "voucherNo": 12, "voucherLabel": "00012", "billNo": "S-SES2358", "invoiceDate": "2026-10-10", "dueDate": "2026-11-09",
              "billDetails": null, "net": 5900, "paid": 0, "balance": 5900, "ageDays": 16 } ], "total": 1 }
```
`balance` is what is still unpaid. `ageDays` is how old the bill is in days; the old software warns when a bill is younger than 45 days (optional: show a yellow note, it is your decision).

### Create (Save) and change
`POST /payment-vouchers`
```json
{ "vendorId": "uuid", "payFromAccountId": "uuid", "paymentMode": "CHEQUE", "voucherDate": "2026-10-26", "chequeDate": "2026-10-26", "chequeNo": "000123",
  "notes": "October", "taxSection": "153(1)(a)", "incomeTaxRate": 0.25,
  "lines": [ { "purchaseInvoiceId": "uuid", "amount": "5900.00", "notes": "" },
             { "purchaseInvoiceId": "uuid", "amount": 500 },
             { "advance": true, "amount": 600, "notes": "for the next order" } ] }
```
- Required: `vendorId`, `payFromAccountId`, `paymentMode`, `lines` (at least one). Everything else is optional (`voucherDate` = today, `incomeTaxRate` = 0).
- **A line is either a bill** (`purchaseInvoiceId`) **or an advance** (`"advance": true`), never both. One line per bill (a second line for the same bill answers `DUPLICATE_BILL`). A bill line pays part or all of the bill: `amount` may not be more than the bill's `balance`.
- `incomeTaxRate` is one rate for the **whole voucher** (the "tax section"; `taxSection` is only a text to print). Withholding = bills total x rate / 100, half a paisa up.
- Answer (`201`):
```json
{ "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "voucherDate": "2026-10-26",
  "vendor": { "id": "uuid", "code": 7, "name": "NEXUS CHEMICAL", "ntn": "1234567-8", "bankName": null, "iban": null },
  "payFrom": { "id": "uuid", "code": "1102", "name": "Bank Account", "controlType": "BANK" },
  "paymentMode": "CHEQUE", "paymentModeText": "Cheque", "chequeDate": "2026-10-26", "chequeNo": "000123", "notes": "October",
  "taxSection": "153(1)(a)", "incomeTaxRate": 0.25,
  "billsTotal": 7000, "incomeTax": 17.5, "net": 6982.5, "typeText": "Bill + Advance",
  "status": "DRAFT", "statusText": "Draft", "canEdit": true, "canDelete": true, "canConfirm": true, "canUnconfirm": false,
  "lines": [ { "lineNo": 1, "kind": "BILL", "kindText": "Bill", "purchaseInvoiceId": "uuid", "billVoucherNo": 12, "billVoucherLabel": "00012", "billNo": "S-SES2358", "billDate": "2026-10-10",
               "billNet": 5900, "billBalance": 5900, "amount": 5900, "notes": null },
             { "lineNo": 3, "kind": "ADVANCE", "kindText": "Advance", "purchaseInvoiceId": null, "amount": 600, "notes": "for the next order" } ] }
```
- The totals bar: **Bills total** = `billsTotal`, **Withholding** = `incomeTax`, **Net payable** = `net` (what the bank pays). While the user is still typing (before Save) you may show `billsTotal` as the sum of the amounts; take the withholding and the net from the server's answer.
- The vendor's NTN, bank name and IBAN are in `vendor` (for the print and for the bank transfer file the old software exports).

### List and summary cards
`GET /payment-vouchers` returns `{ data: [ voucher without lines ], page, limit, total, summary }`, `summary = { vouchers, billAmount, withholding, netPaid }`: the four cards VOUCHERS, BILL AMOUNT, WITHHOLDING, NET PAID. The table columns: Voucher, Type (`typeText`), Ref# (use the cheque no / notes), Chq#, Date, Vendor / Bank, Bill amount (`billsTotal`), Withholding (`incomeTax`), Net amount (`net`). Filters: Show (All / Draft / Confirmed), From / To, Search (vendor, bank, cheque no).

### What Confirm does
The server checks every line **again** against the bills as they are at that moment, then posts the entry of section 1 and adds each line's amount to its bill's `paid` (see the invoice changes in section 8). If a bill was paid by another voucher in the meantime, Confirm answers `MORE_THAN_BALANCE` and the voucher stays a draft: tell the user and let him lower the amount.

### Errors (`422` unless written)
| code | When |
|---|---|
| `MORE_THAN_BALANCE` | A line is more than the bill's balance. `details`: `{ purchaseInvoiceId, balance, amount }`. |
| `BILL_OTHER_VENDOR` | The bill belongs to another vendor. |
| `BILL_NOT_APPROVED` | The purchase invoice is not approved yet. |
| `DUPLICATE_BILL` | The same bill on two lines. |
| `NOT_BANK_OR_CASH` | The "pay from" account is not a bank or cash account. |
| `NOT_POSTING_ACCOUNT` / `ACCOUNT_INACTIVE` | A folder was chosen / the account is switched off. |
| `BAD_AMOUNT` | An amount of zero or less, or a bad number. |
| `LINES_REQUIRED` | The vendor was changed without sending the lines again. |
| `NO_LINES` / `NOTHING_TO_PAY` | Confirm of a voucher without lines or with zero amount. |
| `VOUCHER_CONFIRMED` | A confirmed voucher cannot be changed or deleted: move it to draft first. |
| `ALREADY_CONFIRMED` / `NOT_CONFIRMED` | Confirm on a confirmed voucher / move to draft on one that is not confirmed. |
| `DEFAULT_ACCOUNT_INACTIVE` | A default account the voucher needs (Accounts Payable, Supplier Advances, Income Tax - Vendors) was switched off. The message names it. |
| `VALIDATION_FAILED` (400) | A bad value: a line without a bill or `advance`, a rate of 100 or more, an amount with 3 decimals, an empty `lines` ... |
| `NOT_FOUND` (404) | The voucher, vendor, bill or account does not exist in this company. |
| `FORBIDDEN` (403) | No service, or VIEW only. |

## 5. Receipt Voucher

### The screen (from the real software)
Header: **Deposit into (bank / cash account)** + payment mode; **Received from (customer)**; Notes; Date; Cheque date; Cheque #. Then **Add receipt line**: Type ("Advance" tick), Invoice (picker), Invoice ID, Invoice date, **Cheque amount**, **Income tax** (a % dropdown), **Bill amount** (worked out), **Add**. The lines table (Line, Invoice, Invoice #, Invoice date, Bill amount, IT rate, IT amount, Cheque amount). Totals: **Grand total (invoices)**, **Less: income tax**, **Net received (cheque)**.

### How the amounts work (important)
The customer pays a cheque and keeps back income tax; both together settle the invoice:

`bill amount = cheque amount + income tax`, and `income tax = cheque amount x rate / (100 - rate)` (half a paisa up).

Example: a cheque of 9,800 with 2 % gives income tax 200 and a bill amount of 10,000: the invoice is settled by 10,000. The user types the **cheque amount** and picks the **rate** per line; the server works out the income tax and the bill amount. To show the "Bill amount" box while the user types, you may use the same formula (display only); the server's numbers in the answer are the real ones.

### Dropdown data and the invoices picker
`GET /receipt-vouchers/options`: `{ modes, statuses, depositAccounts: [ { id, code, name, controlType } ], incomeTaxRates }` (as for payments).

`GET /receipt-vouchers/invoices?customerId=...` (optional `search`, `limit`): the customer's **approved sales invoices that still have something to receive**.
```json
{ "data": [ { "salesInvoiceId": "uuid", "invoiceNo": 2748, "invoiceLabel": "02748", "voucherNo": 1623, "voucherLabel": "01623", "invoiceDate": "2026-09-30",
              "invoiceDetails": "SMELL BLACK", "net": 611806.4, "received": 0, "balance": 611806.4, "ageDays": 26 } ], "total": 1 }
```

### Create (Save) and change
`POST /receipt-vouchers`
```json
{ "customerId": "uuid", "depositAccountId": "uuid", "paymentMode": "CHEQUE", "voucherDate": "2026-10-26", "chequeDate": "2026-10-26", "chequeNo": "556", "notes": "",
  "lines": [ { "salesInvoiceId": "uuid", "chequeAmount": "9800.00", "incomeTaxRate": 2 },
             { "advance": true, "chequeAmount": 1000 } ] }
```
- Required: `customerId`, `depositAccountId`, `paymentMode`, `lines`. A line is **an invoice** (`salesInvoiceId`) **or an advance** (`"advance": true`). `incomeTaxRate` is per line (0 up to 99.99, default 0). One line per invoice (`DUPLICATE_INVOICE`).
- A line may settle part or all of the invoice: the **bill amount** (cheque + income tax) may not be more than the invoice's `balance`.
- Answer (`201`): the same shape as the payment voucher, with
```json
{ "customer": { "id": "uuid", "code": 130, "name": "AZ TEXTILES", "ntn": "2123864-2" },
  "depositInto": { "id": "uuid", "code": "1102", "name": "Bank Account", "controlType": "BANK" },
  "grandTotal": 11000, "incomeTax": 200, "net": 10800, "typeText": "Invoice + Advance",
  "lines": [ { "lineNo": 1, "kind": "BILL", "kindText": "Invoice", "salesInvoiceId": "uuid", "invoiceNo": 2748, "invoiceLabel": "02748", "invoiceDate": "2026-09-30", "invoiceNet": 11800, "invoiceBalance": 11800,
               "chequeAmount": 9800, "incomeTaxRate": 2, "incomeTax": 200, "billAmount": 10000, "notes": null },
             { "lineNo": 2, "kind": "ADVANCE", "kindText": "Advance", "salesInvoiceId": null, "chequeAmount": 1000, "incomeTaxRate": 0, "incomeTax": 0, "billAmount": 1000 } ] }
```
- Totals bar: **Grand total (invoices)** = `grandTotal` (sum of the bill amounts), **Less: income tax** = `incomeTax`, **Net received (cheque)** = `net` (what goes into the bank).

### List and summary cards
`GET /receipt-vouchers`: `summary = { vouchers, invoiceAmount, withholding, netReceived }`: the cards VOUCHERS, INVOICE AMOUNT, WITHHOLDING, NET RECEIVED. Table: Voucher, Type, Ref#, Chq#, Date, Customer / Bank, Invoice amount (`grandTotal`), Withholding (`incomeTax`), Net amount (`net`).

### Errors
The same as for payments, with: `MORE_THAN_BALANCE` (the bill amount of the line is more than the invoice's balance; `details`: `{ salesInvoiceId, balance, amount }`), `INVOICE_OTHER_CUSTOMER`, `INVOICE_NOT_APPROVED`, `DUPLICATE_INVOICE`, `NOT_BANK_OR_CASH`, `BAD_RATE` (rate outside 0 to 99.99), `NOTHING_TO_RECEIVE`, `DEFAULT_ACCOUNT_INACTIVE` (Accounts Receivable, Customer Advances, Income Tax - Customers).

## 6. Journal Voucher (JV)

### The screen
Header: Date, Reference (text, for example a cheque or slip number), Narration (the reason). Then a table of lines: **Account** (picker of accounts, not folders), **Debit**, **Credit**, Narration, and a **Customer / Vendor** picker that appears only for the accounts that need one. Below: the running **Total debit**, **Total credit** and the **difference**; Save and Confirm are enabled when the difference is 0 and there are at least 2 lines.

### Create (Save)
`POST /journal-vouchers`
```json
{ "voucherDate": "2026-10-26", "reference": "DEP-1", "narration": "Cash deposited in the bank",
  "lines": [ { "accountId": "uuid", "debit": 5000, "narration": "deposit" },
             { "accountId": "uuid", "credit": "5000.00" } ] }
```
- At least **two lines**. **Each line has either a debit or a credit** (more than zero), never both and never none. **Total debit must equal total credit**, else `422 UNBALANCED` with `details: { debit, credit, difference, side }` (`side` is the side that is missing).
- Only accounts (not folders) that are switched on.
- **Customer / vendor rule:** a line on **Accounts Receivable** or **Customer Advances** must name a **customer** (`partyId` = the customer id); a line on **Accounts Payable** or **Supplier Advances** must name a **vendor**. A line on any other account must **not** have a `partyId`. This keeps the customers' and vendors' own totals equal to these accounts. The account object of the Chart of Accounts has `controlType`: `CUSTOMERS` and `CUSTOMER_ADVANCES` need a customer picker; `SUPPLIERS` and `SUPPLIER_ADVANCES` need a vendor picker (`GET /journal-vouchers/options` returns this list as `partyControlTypes`). The server fills `partyType` itself.
- Answer (`201`):
```json
{ "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "voucherDate": "2026-10-26", "reference": "DEP-1", "narration": "Cash deposited in the bank",
  "total": 5000, "lineCount": 2, "balanced": true, "totals": { "debit": 5000, "credit": 5000 },
  "status": "DRAFT", "statusText": "Draft", "canEdit": true, "canDelete": true, "canConfirm": true, "canUnconfirm": false,
  "lines": [ { "lineNo": 1, "account": { "id": "uuid", "code": "1102", "name": "Bank Account", "accountType": "ASSET" }, "debit": 5000, "credit": 0, "narration": "deposit",
               "partyType": null, "partyId": null, "partyName": null } ] }
```

### List and summary
`GET /journal-vouchers`: `summary = { vouchers, totalAmount }`. The table: Voucher, Date, Reference, Narration, Total (`total`), Status. `search` looks in the reference, the narration and the account names of the lines.

### Errors
`UNBALANCED`, `LINE_ONE_SIDE`, `NOT_POSTING_ACCOUNT`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_INACTIVE` (also when Confirm finds an account switched off since the draft was saved), `CONTROL_NEEDS_PARTY` (a receivable / payable / advance line without a customer or vendor), `LINE_BAD_PARTY` (a customer or vendor on another account), `NOT_FOUND` (404: unknown customer or vendor), `VOUCHER_CONFIRMED`, `ALREADY_CONFIRMED`, `NOT_CONFIRMED`, `BAD_AMOUNT`, `400 VALIDATION_FAILED` (fewer than 2 lines, an amount with 3 decimals ...).

**Warning for the screen:** a journal voucher on Accounts Receivable or Payable changes the customer's / vendor's total, but it does **not** mark any invoice as paid. Use the Receipt / Payment Voucher to settle invoices. Tell the user in a small note on the JV screen.

## 7. New system accounts

Vouchers use four accounts besides the bank and cash accounts. They are **system accounts** (locked, see the Chart of Accounts guide): **Income Tax - Customers** (asset), **Income Tax - Vendors** (liability), **Customer Advances** (liability) and **Supplier Advances** (asset). The Chart of Accounts templates contain them, and the server also **makes them when the first voucher that needs them is saved**. The frontend does nothing; after a first Save reload the Chart of Accounts if it is open. A bank or cash account is made by the user (preset "Bank account" / "Cash in hand").

## 8. Changes in the Sales Invoice and Purchase Invoice screens

Receipts and payments now work, so the invoices come alive:

- `received` / `balance` (sales) and `paid` / `balance` (purchase) are **real**: they grow when a voucher is confirmed and shrink when it is moved to draft.
- New field **`paymentStatus`** on every invoice (list and single): `UNPAID`, `PARTIAL` or `PAID`. Show it as a small badge next to the status.
- New array **`payments`** in the single-invoice answer (`GET /sales-invoices/:id`, `GET /purchase-invoices/:id`): the **confirmed** vouchers that paid this invoice. Fill the **Payments** tab with it (the tab counter = its length):
  - sales: `{ voucherId, voucherNo, voucherLabel, voucherDate, paymentMode, chequeNo, chequeAmount, incomeTax, billAmount }`;
  - purchase: `{ voucherId, voucherNo, voucherLabel, voucherDate, paymentMode, chequeNo, amount }`.
  Link each row to its voucher (`/receipt-vouchers/:voucherId` or `/payment-vouchers/:voucherId`).
- **Un-approve** of an invoice is refused once money was received / paid: `HAS_RECEIPTS` (sales) / `HAS_PAYMENTS` (purchase). Move the voucher to draft first.
- Add a button **"Receive payment"** (sales invoice) / **"Pay bill"** (purchase invoice) on an approved invoice with a balance: it opens a new voucher with the customer / vendor and this invoice already chosen.

## 9. Trial Balance changes

The Trial Balance (`trial-balance.md`) has four new checks, so it now has **8 checks** in this order: `TRIAL_BALANCE_BALANCED`, `CONTROL_ACCOUNTS_MATCH_SUBLEDGERS`, `SALES_INVOICES_MATCH_LEDGER`, `PURCHASE_INVOICES_MATCH_LEDGER`, then:

| key | What it checks | When it is red |
|---|---|---|
| `PAYMENT_VOUCHERS_MATCH_LEDGER` | Every **confirmed** payment voucher has exactly one live entry whose debit is its bills total; a **draft** has none | `mismatches[]`: `{ voucherId, voucherNo, reason, message, voucherTotal, ledgerDebit }`, `reason`: `CONFIRMED_WITHOUT_ENTRY`, `CONFIRMED_WITH_MANY_ENTRIES`, `AMOUNT_DIFFERS`, `DRAFT_IN_LEDGER` |
| `RECEIPT_VOUCHERS_MATCH_LEDGER` | The same for receipt vouchers (their grand total) | same shape |
| `JOURNAL_VOUCHERS_MATCH_LEDGER` | The same for journal vouchers (their total) | same shape |
| `INVOICE_PAYMENTS_MATCH_VOUCHERS` | What every invoice says was received / paid equals what its **confirmed** vouchers settled | `mismatches[]`: `{ kind: "SALES" or "PURCHASE", invoiceId, invoiceNo, message, invoiceSays, vouchersSettled }` |

Also, the check `CONTROL_ACCOUNTS_MATCH_SUBLEDGERS` now lists the **advance** accounts too (Customer Advances, Supplier Advances) next to Accounts Receivable and Accounts Payable. Link a voucher mismatch to `/payment-vouchers/:id`, `/receipt-vouchers/:id` or `/journal-vouchers/:id`; in the account ledger the lines of a voucher have `sourceType` `PAYMENT_VOUCHER`, `RECEIPT_VOUCHER` or `JOURNAL_VOUCHER` and `sourceId` = the voucher id.

## 10. Step by step: what to build, in order

1. Menu items Payment Voucher, Receipt Voucher, Journal Voucher (each by its own service).
2. **Payment Voucher** summary screen (cards, filters, table), then the voucher form (header, "Add bill payment" with the bills picker and the Advance tick, the lines table, totals, buttons Save / Confirm / Move to draft / Delete / Accounts / Print / Close), then the "Accounts entry" popup.
3. **Receipt Voucher**: the same screens, with the cheque amount, income tax rate and computed bill amount per line.
4. **Journal Voucher**: summary screen and the form with the balancing table (running totals and difference, party picker only where needed).
5. In the invoice screens: `paymentStatus` badge, the Payments tab from `payments`, and the "Receive payment" / "Pay bill" buttons.
6. In the Trial Balance screen: the four new checks.
7. Test with a company that has a bank account: save a draft (nothing changes in the Trial Balance), confirm it (the Trial Balance moves and still balances), move it to draft (the closing amounts go back), try to pay more than a bill's balance, enter an advance.

## 11. Notes

- **Nothing is deleted from the books.** Moving a voucher to draft posts a reverse entry; both stay in the account ledger.
- Two draft vouchers can both aim at the same bill; the second one fails when it is confirmed if the money is no longer there (`MORE_THAN_BALANCE`).
- **Not built yet:** applying an advance to an invoice later (do it with a Journal Voucher: debit the advance account / credit Accounts Receivable with the customer named, or the other way round for a vendor), a debit note for goods returned to a vendor, bank reconciliation, and attachments (the frontend may keep attachments itself).

---

# Party Ledger, Accounts Payables / Receivables and Bank Summary: frontend guide

Written for: the frontend developer (and the AI that helps them). These are **reports**: they only read the books (the journal), so the screens have no Save button, except the clearing date in the Bank Summary. Nothing here is typed in twice: every number is worked out by the server from the posted entries.

## 1. The ideas in plain words

- **Party** = a customer or a vendor. Every entry that touches Accounts Receivable / Payable (and the advance accounts) names its party, so the books know what each party owes or is owed.
- **Accounts Payables** = the list of **vendors** with how much we owe each. **Accounts Receivables** = the same for **customers**: how much each owes us. One row per party.
- **Party Ledger** = the story of **one** party: every bill, invoice, payment and receipt in date order, with a running balance. It is what opens when the user presses **View** on a row of Accounts Payables / Receivables.
- **Balance side.** Every balance comes as a number plus a side: `CREDIT` (for a vendor: we owe him; for a customer: he paid us more than he owes, an advance) or `DEBIT` (for a customer: he owes us; for a vendor: we paid him more than we owe). Show "1,415,523 Cr" / "Dr"; `null` side = zero, show "-".
- **Bank Summary** = the movements of one bank account, with the date the bank **cleared** each cheque (a cheque we wrote or received is "uncleared" until the bank really moves the money), and the figures that agree our books with the bank statement.

## 2. Access

| Screen | Service | Calls |
|---|---|---|
| Party Ledger, Accounts Payables, Accounts Receivables | **`ACC_REPORTS`** (VIEW) | `/api/v1/accounting/party-ledger`, `/payables`, `/receivables` |
| Bank Summary | **`ACC_BANK`** (new: VIEW reads, FULL sets / removes clearing dates) | `/api/v1/accounting/bank-accounts`, `/bank-summary`, `/bank-clearing` |

Menu group `ACCOUNTS` (sub menu "Ledgers": Accounts Ledger (exists), Bank Summary, Party Ledger, Accounts Payables, and add Accounts Receivables). Show an item only when the login `services` list has its code. Without the service every call answers `403 FORBIDDEN`. Another company's party or account is `404`. The super admin must give `ACC_BANK` to the company; the client admin gives it to users.

All amounts here are **strings with 2 decimals** (`"1415523.00"`), like the Trial Balance. Format them for display; never add them up in the browser.

## 3. Accounts Payables / Receivables

`GET /accounting/payables` (vendors) and `GET /accounting/receivables` (customers). Same answer shape.

Query (all optional): `date` (as at this day, default today), `search` (name, NTN, CNIC or code), `includeZero` (`true` also lists parties whose balance is zero; default `false`), `page` (default 1), `limit` (default 20; the "R: 20" box; max 500).

```json
{ "partyType": "VENDOR", "date": "2026-10-26", "page": 1, "limit": 20, "total": 143,
  "totals": { "debit": "9694220.00", "credit": "11109743.00", "balance": "1415523.00", "balanceSide": "CREDIT" },
  "data": [ { "id": "uuid", "code": 194, "name": "AA MARKETING", "ntn": "E464384-2", "cnic": null,
              "debit": "9694220.00", "credit": "11109743.00", "balance": "1415523.00", "balanceSide": "CREDIT" } ] }
```

- Table columns: **View** (button), **ID** (`code`), **NAME**, **NTN#**, **CNIC#**, **DR AMNT** (`debit`), **CR AMNT** (`credit`), **BALANCE** (`balance` + `balanceSide`). Sorted by name. Pagination links 1 2 3 ... from `total` and `limit`. `total` counts the parties after the filters.
- `debit` and `credit` are everything posted up to `date` (including the opening balances). The footer of the page can show `totals`.
- **View** opens the **Party Ledger** of that row (section 4): `partyType` = `VENDOR` for payables and `CUSTOMER` for receivables, `partyId` = the row's `id`. Pass the dates the user chose; by default the Party Ledger starts at the beginning of the fiscal year.
- **Print**: print what is on screen (or the whole list with a big `limit`).
- Vendors / customers with a balance on the "wrong" side (for example a vendor with a Debit balance) are listed too: the `balanceSide` tells it.

## 4. Party Ledger

`GET /accounting/party-ledger?partyType=VENDOR|CUSTOMER&partyId=...`

Query: `partyType` and `partyId` (required), `dateFrom`, `dateTo` (default: start of the fiscal year to today; or `fiscalYear` = the year it starts in), `search` (the "Find in this ledger" box: narration, cheque no, voucher no, source, account), `kind` (the tab, one of `SALES_INVOICE`, `PURCHASE_INVOICE`, `PAYMENT_VOUCHER`, `RECEIPT_VOUCHER`, `JOURNAL_VOUCHER`; empty = All).

```json
{ "party": { "type": "VENDOR", "id": "uuid", "code": 194, "name": "AA MARKETING", "ntn": "E464384-2", "cnic": null },
  "dateFrom": "2026-07-01", "dateTo": "2026-10-26",
  "opening": { "balance": "0.00", "balanceSide": null },
  "totals": { "debit": "9694220.00", "credit": "11109743.00" },
  "closing": { "balance": "1415523.00", "balanceSide": "CREDIT" },
  "kinds": [ { "code": "PAYMENT_VOUCHER", "text": "Vendor payment", "count": 8 }, { "code": "PURCHASE_INVOICE", "text": "Purchase invoice", "count": 11 } ],
  "total": 19, "shown": 19, "truncated": false,
  "lines": [ { "entryId": "uuid", "entryNo": 12, "date": "2026-07-23",
               "sourceType": "PURCHASE_INVOICE", "sourceText": "Purchase invoice", "sourceId": "uuid", "docNo": 5874, "docLabel": "05874",
               "isReversal": false, "reversed": false,
               "ref": "S-SES2358", "chequeNo": null, "chequeDate": null,
               "particulars": "Purchase invoice 5874", "account": { "code": "2101", "name": "Accounts Payable" },
               "debit": "0.00", "credit": "1415523.00", "balance": "1415523.00", "balanceSide": "CREDIT" } ] }
```

The screen:
- Header cards: **OPENING BALANCE** (`opening`; "-" when `balanceSide` is null), **TOTAL DEBIT**, **TOTAL CREDIT**, **CLOSING BALANCE** (`closing` with Cr / Dr).
- Party line under the title: name, `A/C` = `code`, NTN.
- Tabs: **All** (count = `total`) and one tab per item of `kinds` with its `count` (the old software showed "GRN purchase 11", "Vendor payment 8"). Pressing a tab calls again with `kind=...`; the counts do not change with the tab or the search. `shown` is how many lines are in the table ("19 OF 19 ENTRIES").
- The table: **DATE** (`date`), **VOUCHER** (a **View** button and `sourceText` with `docLabel` below it), **REF / CHQ #** (`ref`: the cheque number of a payment / receipt, or the vendor's bill number of a purchase invoice), **PARTICULARS**, **DEBIT**, **CREDIT**, **BALANCE** (`balance` + side). First row: "Opening balance" with the `opening` figure.
- The **running balance is always the true balance** of the whole period, also when a tab or the search hides some lines.
- **View button on a line** opens the document by `sourceType` and `sourceId`: `SALES_INVOICE` -> `/sales-invoices/:id`, `PURCHASE_INVOICE` -> `/purchase-invoices/:id`, `PAYMENT_VOUCHER` -> `/payment-vouchers/:id`, `RECEIPT_VOUCHER` -> `/receipt-vouchers/:id`, `JOURNAL_VOUCHER` -> `/journal-vouchers/:id`.
- A voucher that was moved to draft stays in the ledger with its reversal: the original has `reversed: true`, the reversal line `isReversal: true`. Show them in grey with a small "reversed" note; the balance already accounts for both.
- `account` says on which account the line sits (for example Accounts Payable or Supplier Advances / Customer Advances). The balance mixes them: it is the party's total position.
- `truncated: true` means the period has more than 5,000 lines and the end is cut off: ask the user to narrow the dates.
- **PDF statement** and **Excel / CSV**: build them in the browser from this answer (there is no server export yet).
- The party picker at the top (the "+" box with the name): use the existing vendor / customer lists. Changing the party or the dates and pressing **Show** calls the endpoint again.

Errors: `404 NOT_FOUND` (the party is not in this company, or `partyType` does not match), `400 VALIDATION_FAILED` (missing `partyType` / `partyId`), `422 BAD_RANGE` (`dateFrom` after `dateTo`).

## 5. Bank Summary

### Picker
`GET /accounting/bank-accounts` -> `{ "data": [ { "id": "uuid", "code": "1102", "name": "Meezan Current" } ] }`: the active bank accounts (the dropdown "MEEZAN-CURRENT"). Cash accounts are not in it.

### The summary
`GET /accounting/bank-summary?accountId=...`

Query: `accountId` (required), `dateFrom`, `dateTo` (default: fiscal year start to today; the old screen defaulted to yesterday and today: send them), `status` (`ALL` default, `CLEARED`, `UNCLEARED`), `search` (narration, cheque no, voucher no).

```json
{ "account": { "id": "uuid", "code": "1102", "name": "Meezan Current" }, "dateFrom": "2026-10-25", "dateTo": "2026-10-26",
  "opening": { "balance": "20000.00", "balanceSide": "DEBIT" },
  "totals": { "debit": "0.00", "credit": "6500.00" }, "closing": { "balance": "13500.00", "balanceSide": "DEBIT" },
  "total": 1, "shown": 1, "truncated": false,
  "lines": [ { "lineId": "uuid", "entryId": "uuid", "date": "2026-10-26", "sourceType": "PAYMENT_VOUCHER", "sourceText": "Vendor payment", "sourceId": "uuid", "docNo": 1, "docLabel": "00001",
               "isReversal": false, "reversed": false, "chequeNo": "000123", "chequeDate": "2026-10-26", "particulars": "Payment voucher 00001 - NEXUS CHEMICAL (cheque 000123)",
               "debit": "0.00", "credit": "6500.00", "balance": "13500.00", "balanceSide": "DEBIT",
               "clearedDate": null, "cleared": false, "canClear": true } ],
  "uncleared": { "count": 1, "totals": { "debit": "0.00", "credit": "6500.00" },
                 "lines": [ { "lineId": "uuid", "date": "2026-10-26", "sourceType": "PAYMENT_VOUCHER", "docLabel": "00001", "chequeNo": "000123", "chequeDate": "2026-10-26", "particulars": "...", "debit": "0.00", "credit": "6500.00" } ] },
  "reconciliation": { "booksBalance": "13500.00", "booksSide": "DEBIT", "unclearedDeposits": "20000.00", "unclearedPayments": "6500.00", "bankBalance": "0.00", "bankSide": null } }
```

The screen (two panels like the old software):
- **Left panel** = `lines`: **Voucher** (`docLabel`, View as in the Party Ledger), **Chq Date** (`chequeDate`, else `date`), **Clr Date** (`clearedDate`), **CHQ#** (`chequeNo`), **Debit (PKR)** = money in, **Credit (PKR)** = money out, **Balance (PKR)** (running, with side), and the buttons: **Update** (set or change the clearing date: a date input, then `PUT /accounting/bank-clearing`) and **Remove** (`DELETE /accounting/bank-clearing/:lineId`). Show the buttons only when `canClear` is true **and** the user has FULL on `ACC_BANK`; remove only when `cleared` is true.
- **Right panel** = `uncleared.lines`: the money the bank has **not cleared yet** (Voucher, Date, CHQ#, Debit, Credit), with the counts and `uncleared.totals`. Its dropdown can filter the left panel with `status`.
- **Agreeing with the bank statement** (`reconciliation`): `booksBalance` (what our books say at `dateTo`) minus `unclearedDeposits` (cheques we received that the bank has not credited) plus `unclearedPayments` (cheques we wrote that the bank has not paid) = `bankBalance`, what the bank statement should show. Show these four lines under the table.
- A line is **uncleared at `dateTo`** when it has no clearing date or its clearing date is after `dateTo`.
- Lines of a reversed voucher (and the reversal lines) have `canClear: false`, are grey, and are never in the uncleared list.

### Setting the clearing date
`PUT /accounting/bank-clearing` body `{ "journalLineId": "<lineId>", "clearedDate": "2026-10-28" }` -> `200 { "journalLineId", "clearedDate" }`. Sets or changes it. After a successful call re-read the summary (or update that row and the totals from the next `GET`).
`DELETE /accounting/bank-clearing/:lineId` -> `204`.
Needs FULL on `ACC_BANK`. This does **not** change the books: it only records the bank's date.

Errors: `NOT_BANK_ACCOUNT` (422: the account or the line is not a bank one), `CLEARED_BEFORE_ENTRY` (422: the cleared date is before the line's own date), `NOT_CLEARABLE` (422: a reversed entry or a reversal), `BAD_DATE` (422), `NOT_FOUND` (404: unknown line, or `DELETE` of a line that has no clearing date), `FORBIDDEN` (403).

## 6. Step by step

1. Menu: Ledgers -> Accounts Ledger, Bank Summary, Party Ledger, Accounts Payables, Accounts Receivables (each by its service).
2. Accounts Payables / Receivables screen (date, rows per page, search, Print, pagination) with **View** opening the Party Ledger of the row.
3. Party Ledger (party picker, dates, Show, cards, tabs, search, table, links to the documents, PDF / Excel from the data).
4. Bank Summary (account picker, dates, two panels, Update / Remove of the clearing date, reconciliation lines).
5. Test: after a confirmed Payment Voucher the vendor's row grows on the Debit side and the Party Ledger shows the payment with its cheque number; the bank line appears uncleared; set the clearing date and it moves out of the right panel.

## 7. Notes

- Nothing is saved on the party screens; they are always live.
- The Party Ledger's closing balance equals the party's row in Accounts Payables / Receivables of the same day.
- Not built yet: server PDF / Excel export, bank statement import and automatic matching, a combined "statement" for customers who are also vendors.

---

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

---

# Contra voucher (direct settlement): frontend guide

Written for: the frontend developer (and the AI that helps them). Read section 1 first. The screens are the three in the owner's pictures: the list, the "choose customer and supplier" step, and the form with the two tables.

## 1. The idea in plain words

- Customer **Hamid owes us 200,000**. We **owe supplier Jamal 200,000**. Instead of Hamid paying us and us paying Jamal, the owner tells Hamid: "pay Jamal directly". No cash and no bank account is touched. A **contra voucher** records this: Hamid's debt to us goes down by 200,000 and our debt to Jamal goes down by 200,000.
- The two sides need not be equal. If Hamid owes us 300,000 but we owe Jamal only 200,000, the contra amount is **200,000** (the smaller one): Hamid still owes us 100,000, Jamal is fully paid. If we owe Jamal 500,000 and Hamid owes only 100,000, the amount is 100,000 and we still owe Jamal 400,000. The user chooses the amount.
- The voucher has **one amount** and **two tables**: the customer's **invoices** it is applied to, and the vendor's **bills** it is applied to. **Each table must add up to exactly the amount** ("Both tables below must add up to exactly the Contra Amount"). One invoice or bill can be settled in part.
- Same life as the other vouchers: **Save** makes a **Draft** (changes nothing); **Confirm** ("Post Contra") posts the accounting entry and settles the invoices and bills; **Move to draft** reverses it (nothing is erased; the invoices and bills get their amounts back).
- What the books get when it is confirmed (the "Accounts" popup): **Debit Accounts Payable** (the vendor named) and **Credit Accounts Receivable** (the customer named), both for the amount. The customer's balance, the vendor's balance, the Party Ledgers, Accounts Receivables / Payables, the Trial Balance and all reports follow automatically. Nothing for you to do.

## 2. Access

- Service **`ACC_CONTRA`** ("Contra (Direct Settlement)"), menu tab `ACCOUNTS`. VIEW: list, open, accounts entry. FULL: also create, edit, delete, confirm, move to draft.
- The super admin gives it to a company; the client admin gives it to employees. Without it every call answers `403 FORBIDDEN`. Another company's data answers `404`.
- Base path **`/api/v1/contra-vouchers`**. Voucher numbers (`voucherNo`, shown as `voucherLabel` `00001`) are the company's own series, given by the server.
- Money: plain JSON numbers with at most 2 decimals in answers. When **sending**, an amount may be a number (`200000`) or a decimal string (`"200000.00"`); more than 2 decimals is an error.

## 3. Calls

| Call | What |
|---|---|
| `GET /contra-vouchers/options` | The two pickers: customers who have unpaid invoices and vendors who have unpaid bills, with how much. |
| `GET /contra-vouchers/invoices?customerId=` | The customer's approved sales invoices that still have something to receive (table 1). |
| `GET /contra-vouchers/bills?vendorId=` | The vendor's approved purchase invoices that still have something to pay (table 2). |
| `GET /contra-vouchers` | The list with a `summary`. Query: `status` (`DRAFT`, `CONFIRMED`), `dateFrom`, `dateTo`, `customerId`, `vendorId`, `search` (voucher no, customer, supplier, reference, narration), `page` (1), `limit` (50, max 500). Newest first. |
| `POST /contra-vouchers` | Save a draft. `201`. |
| `GET /contra-vouchers/:id` | One voucher with both tables. |
| `PATCH /contra-vouchers/:id` | Change a draft. Send only what changed; when you send `invoices` or `bills`, send **all** the lines of that table again. `200`. |
| `DELETE /contra-vouchers/:id` | Delete a draft. `204`. |
| `POST /contra-vouchers/:id/confirm` | Confirm ("Post Contra"). No body. `200` with the voucher. |
| `POST /contra-vouchers/:id/unconfirm` | Move to draft. Optional body `{ "reason": "wrong party" }`. `200` with the voucher. |
| `GET /contra-vouchers/:id/accounts-entry` | The "Accounts" popup: `{ posted, current, entries }` (same shape as the other vouchers). |

After **every** Save, Update, Confirm and Move to draft, replace the screen with the voucher the server returns.

### 3.1 The list screen (picture 1: "Contra (Direct Settlement)")
`GET /contra-vouchers` answers `{ data, page, limit, total, summary: { vouchers, totalAmount } }`. Columns: **VOUCHER #** (`voucherLabel`), **DATE** (`voucherDate`), **CUSTOMER** (`customer.name`), **SUPPLIER** (`vendor.name`), **AMOUNT** (`amount`), **STATUS** (`statusText`). The search box ("Search voucher #, customer or supplier") sends `search`. "No contra vouchers yet." when `data` is empty. The **+ New Contra** button opens the form.

### 3.2 Step 1 of the form (picture 2): customer and supplier
Two dropdowns from `GET /contra-vouchers/options`:
```json
{ "statuses": [ { "code": "DRAFT", "text": "Draft" }, { "code": "CONFIRMED", "text": "Confirmed" } ],
  "customers": [ { "id": "uuid", "code": 1, "name": "Hamid", "openCount": 3, "outstanding": 300000 } ],
  "vendors":   [ { "id": "uuid", "code": 1, "name": "Jamal", "openCount": 2, "outstanding": 200000 } ] }
```
"Customer (who owes us)" = `customers`; "Supplier (who we owe)" = `vendors`. `outstanding` is what the party still owes / is owed on approved invoices / bills, `openCount` how many documents. Show them next to the name ("C-0001 - Hamid  (300,000)"). When both are chosen, load the two tables.

### 3.3 Step 2 (picture 3): the form
Fields: **Date** (`voucherDate`, default today), **Contra Amount** (`amount`), **Reference** (`reference`, free text), **Narration** (`narration`). Under them the note "Both tables below must add up to exactly the Contra Amount." Then two tables:

- **Apply to Hamid's Invoices** (from `GET /contra-vouchers/invoices?customerId=`):
```json
{ "data": [ { "salesInvoiceId": "uuid", "invoiceNo": 2748, "invoiceLabel": "02748", "invoiceDate": "2026-10-10", "invoiceDetails": "SMELL BLACK",
              "net": 200000, "received": 0, "balance": 200000, "ageDays": 16 } ], "total": 1 }
```
columns **INVOICE** (`invoiceLabel`, date), **OUTSTANDING** (`balance`), **APPLY** (an amount box, 0 up to `balance`). "No outstanding invoices for this customer." when empty.
- **Apply to Jamal's Bills** (from `GET /contra-vouchers/bills?vendorId=`):
```json
{ "data": [ { "purchaseInvoiceId": "uuid", "voucherNo": 12, "voucherLabel": "00012", "billNo": "S-SES2358", "invoiceDate": "2026-10-10", "dueDate": "2026-11-09",
              "net": 200000, "paid": 0, "balance": 200000, "ageDays": 16 } ], "total": 1 }
```
columns **BILL** (`billNo`, `voucherLabel`), **OUTSTANDING** (`balance`), **APPLY**.
- Under each table: **Applied to invoices: 0.00** and **Applied to bills: 0.00** (the sums of the boxes; you may add them up in the browser for this running total only). A useful helper: an "Auto fill" that spreads the Contra Amount over the oldest documents first.
- Buttons **Post Contra** and **Cancel**. "Post Contra" = `POST /contra-vouchers` and then, in the same click, `POST /contra-vouchers/:id/confirm`. (If you also want a "Save as draft" button, call only the first one.) Enable the button only when both applied totals are equal to the Contra Amount and the amount is more than zero; the server checks it again anyway.

## 4. Create / change (Save)

`POST /contra-vouchers`
```json
{ "customerId": "uuid", "vendorId": "uuid", "voucherDate": "2026-10-26", "amount": "200000.00", "reference": "CT-1", "narration": "Hamid pays Jamal",
  "invoices": [ { "salesInvoiceId": "uuid", "amount": 200000 } ],
  "bills":    [ { "purchaseInvoiceId": "uuid", "amount": "200000" } ] }
```
- Required: `customerId`, `vendorId`, `amount`, `invoices` (at least one line), `bills` (at least one line). `voucherDate` is today if left out.
- One line per invoice and per bill. A line applies part or all of the document: its `amount` may not be more than the document's `balance`.
- **Each table must add up to `amount`.** Example with unequal debts: the customer owes 300,000 in three invoices and we owe the vendor 200,000 in two bills: `amount` 200000, the invoices lines add up to 200000 (for example 100,000 + 100,000 of the second invoice), the bills lines add up to 200000.

Answer (`201`, and the same shape for `GET /contra-vouchers/:id`):
```json
{ "id": "uuid", "voucherNo": 1, "voucherLabel": "00001", "voucherDate": "2026-10-26",
  "customer": { "id": "uuid", "code": 1, "name": "Hamid", "ntn": null }, "vendor": { "id": "uuid", "code": 1, "name": "Jamal", "ntn": null },
  "amount": 200000, "reference": "CT-1", "narration": "Hamid pays Jamal",
  "status": "DRAFT", "statusText": "Draft", "confirmedAt": null, "confirmedBy": null,
  "canEdit": true, "canDelete": true, "canConfirm": true, "canUnconfirm": false,
  "appliedToInvoices": 200000, "appliedToBills": 200000,
  "invoices": [ { "lineNo": 1, "salesInvoiceId": "uuid", "invoiceNo": 2748, "invoiceLabel": "02748", "invoiceDate": "2026-10-10", "invoiceNet": 200000, "outstanding": 200000, "amount": 200000 } ],
  "bills":    [ { "lineNo": 2, "purchaseInvoiceId": "uuid", "billVoucherNo": 12, "billVoucherLabel": "00012", "billNo": "S-SES2358", "billDate": "2026-10-10", "billNet": 200000, "outstanding": 200000, "amount": 200000 } ] }
```
`outstanding` is what the document has left **now** (after a confirmed voucher it shows 0 for a fully settled document). Show the buttons by `canEdit`, `canDelete`, `canConfirm`, `canUnconfirm`; do not work them out yourself.

`PATCH` changes a draft: `{ "amount": 150000, "narration": "...", "invoices": [ ... ], "bills": [ ... ] }`. If you change the amount you must send both tables again (they must still add up). If you change the customer you must send `invoices`; if you change the vendor you must send `bills` (`LINES_REQUIRED` otherwise).

## 5. What Confirm and Move to draft do

- **Confirm** checks both tables again against the documents as they are at that moment, then posts **Debit Accounts Payable (vendor) / Credit Accounts Receivable (customer)** for the amount, adds the applied amounts to the invoices' **received** and the bills' **paid**, and locks the voucher. If somebody settled a document in the meantime, Confirm answers `MORE_THAN_BALANCE` and the voucher stays a draft: tell the user and let him lower the amounts.
- **Move to draft** posts the reverse entry (both entries stay in the books and in the ledgers; the original is marked reversed), takes the amounts back from the invoices and bills, and the voucher can be edited again.
- An invoice or bill settled (even partly) by a confirmed contra **cannot be un-approved** (`HAS_RECEIPTS` / `HAS_PAYMENTS`). Move the contra to draft first.

## 6. What changes elsewhere (the frontend sees these automatically)

- **Sales invoice and Purchase invoice screens:** `received` / `paid`, `balance` and `paymentStatus` (`UNPAID`, `PARTIAL`, `PAID`) include the contra. The `payments` array of an invoice now has a contra row too. **Every row of `payments` has a new field `voucherType`**: `RECEIPT` or `CONTRA` (sales invoice), `PAYMENT` or `CONTRA` (purchase invoice). A contra row has `paymentMode: "CONTRA"`, `chequeNo: null`; on a sales invoice `chequeAmount` and `billAmount` are the applied amount and `incomeTax` is 0. Link the row by `voucherType`: `RECEIPT` -> `/receipt-vouchers/:voucherId`, `PAYMENT` -> `/payment-vouchers/:voucherId`, `CONTRA` -> `/contra-vouchers/:voucherId`.
- **Party Ledger** (`ledgers.md`): the lines of a contra have `sourceType` **`CONTRA_VOUCHER`**, `sourceText` "Contra", `docLabel` = the contra's voucher number, `sourceId` = the voucher id. A new tab `CONTRA_VOUCHER` appears in `kinds`; the `kind` filter accepts `CONTRA_VOUCHER`. Link its View button to `/contra-vouchers/:sourceId`. A customer's contra line is a **credit** (he owes us less); a vendor's contra line is a **debit** (we owe him less).
- **Accounts Receivables / Payables, Customer / vendor balances, Receivable & payable at cut-off, Trial Balance, Profit & Loss, Balance Sheet:** all follow by themselves. In the cut-off report a contra counts as received / paid on its voucher date.
- **Trial Balance checks** (`trial-balance.md`) now has **9 checks**: the new one is `CONTRA_VOUCHERS_MATCH_LEDGER` (after `JOURNAL_VOUCHERS_MATCH_LEDGER`): every confirmed contra has exactly one live entry for its amount, a draft has none, and both tables of a voucher add up to its amount. `mismatches[]` has the same shape as the other voucher checks (`voucherId`, `voucherNo`, `reason`, `message`, ...), with the extra `reason` `TABLES_DO_NOT_MATCH`. The check `INVOICE_PAYMENTS_MATCH_VOUCHERS` also counts contra settlements. In the account ledger the lines of a contra have `sourceType` `CONTRA_VOUCHER`.

## 7. Errors (`422` unless written)

| code | When |
|---|---|
| `TABLES_DO_NOT_MATCH` | A table does not add up to the amount. `details`: `{ amount, invoicesTotal, billsTotal }`. |
| `MORE_THAN_BALANCE` | A line is more than the document's balance (also at Confirm). `details`: `{ salesInvoiceId or purchaseInvoiceId, balance, amount }`. |
| `INVOICE_OTHER_CUSTOMER` / `BILL_OTHER_VENDOR` | The document belongs to another customer / vendor. |
| `INVOICE_NOT_APPROVED` / `BILL_NOT_APPROVED` | The document is not approved yet. |
| `DUPLICATE_INVOICE` / `DUPLICATE_BILL` | A document is on its table twice. |
| `BAD_AMOUNT` | The amount is zero, negative or not a number with at most 2 decimals. |
| `LINES_REQUIRED` | The customer / vendor was changed without sending its table again. |
| `NO_LINES` | Confirm of a voucher without invoices or without bills. |
| `VOUCHER_CONFIRMED` | A confirmed voucher cannot be changed or deleted: move it to draft first. |
| `ALREADY_CONFIRMED` / `NOT_CONFIRMED` | Confirm on a confirmed voucher / move to draft on one that is not confirmed. |
| `DEFAULT_ACCOUNT_INACTIVE` | Accounts Receivable or Accounts Payable was switched off. |
| `VALIDATION_FAILED` (400) | Missing `customerId` / `vendorId` / `amount` / a table, an empty table, an amount with 3 decimals ... |
| `NOT_FOUND` (404) | The voucher, customer, vendor, invoice or bill does not exist in this company. |
| `FORBIDDEN` (403) | No `ACC_CONTRA` service, or VIEW only. |

## 8. "Receive Money", "Pay Money", "Payment History"

These three screens of the "Money In & Out" menu already exist in the frontend. **Nothing in the backend had to change for them.** They are the existing vouchers:
- **Receive Money** = the Receipt Voucher (`/receipt-vouchers`, service `ACC_RECEIPTS`).
- **Pay Money** = the Payment Voucher (`/payment-vouchers`, service `ACC_PAYMENTS`).
- **Customer Pays Supplier (Contra)** = this guide (`/contra-vouchers`, service `ACC_CONTRA`).
- **Payment History** has no single endpoint. Build it from the three lists (`GET /receipt-vouchers`, `GET /payment-vouchers`, `GET /contra-vouchers`, each with `dateFrom` / `dateTo`, filtered to `status=CONFIRMED`) and merge them by date in the browser, or show the `payments` array of one invoice (it now lists receipts, payments and contras of that document). If a combined, paged "history" endpoint is wanted, tell the backend and it will be added.

## 9. Build order and checks

1. List screen, then the two pickers and the form with the two tables; "Post Contra" (Save then Confirm).
2. The "Accounts" popup and "Move to draft".
3. In the invoice screens: the Payments tab rows with `voucherType`; in the Party Ledger: the contra tab and link.
4. Trial Balance: the new check.
5. Test: customer owes 200,000, vendor owed 200,000: contra of 200,000 -> both invoice and bill become `PAID`, both balances 0, the Trial Balance stays green. Then an unequal case (customer 300,000 / vendor 200,000): contra 200,000 -> the customer still owes 100,000, the vendor is fully paid. Then Move to draft: everything comes back.

---

# Default accounts: frontend guide (a new tab in the Chart of Accounts area)

Written for: the frontend developer (and the AI that helps them). Read section 1 first.

## 1. The idea in plain words

- Every invoice and voucher posts to a few **fixed accounts**: a sales invoice credits "Sales" and "Sales Tax", and debits "Accounts Receivable"; a purchase invoice debits "Purchases" and "Input Sales Tax" and credits "Accounts Payable"; the vouchers use "Income Tax - Customers / Vendors" and "Customer / Supplier Advances". We call them the **default accounts**. There are **10 roles** (section 4).
- Until now the server made a default account **by itself** the first time an invoice or voucher needed it. Now the owner can **see all the defaults in one tab**, and he can **choose, before the first invoice**, which account of his Chart of Accounts fills each role (or ask the server to make the standard one).
- **Rule on the server (nothing for you to do):** when an invoice or voucher is approved or confirmed, the server first looks for the account that fills the role. If there is one (made by the server earlier, or chosen by the owner) it posts **to that account**. It makes a new one **only when the role has none**. So an account chosen in this tab is used, and nothing is auto-generated next to it.
- **The id shown here is the id of the Chart of Accounts.** The account is the same account everywhere: in this tab, in the chart tree (`GET /accounts/:id`), in the ledger, in the invoice's "Accounts" popup.
- A default account is a **system account**: it is marked in the chart (`isSystem: true`, `controlType` = its role), and its type and its on/off switch are locked; it can still be renamed.

## 2. Access

Service **`ACC_COA`** (the Chart of Accounts service): VIEW reads the tab; FULL chooses and makes accounts. Without it `403 FORBIDDEN`. Another company's accounts answer `404`. Base path `/api/v1/accounts/defaults`.

## 3. Calls

| Call | What |
|---|---|
| `GET /accounts/defaults` | All 10 roles with the account that fills each (the tab). |
| `GET /accounts/defaults/:key/candidates` | The accounts of the chart the user may choose for that role (the dropdown). |
| `PUT /accounts/defaults/:key` | Choose an account for the role. Body `{ "accountId": "uuid" }`. Answers the updated role item. |
| `POST /accounts/defaults/:key/create` | Make the standard account of the role (does nothing if the role already has one). Answers the role item. |
| `POST /accounts/defaults/create-all` | Make every default account the company does not have yet ("Create all default accounts"). |

`:key` is one of `SALES`, `OUTPUT_TAX`, `CUSTOMERS`, `PURCHASES`, `INPUT_TAX`, `SUPPLIERS`, `INCOME_TAX_CUSTOMERS`, `INCOME_TAX_VENDORS`, `CUSTOMER_ADVANCES`, `SUPPLIER_ADVANCES` (any other value is `400 VALIDATION_FAILED`).

### 3.1 The tab: `GET /accounts/defaults`
```json
{ "missing": 1, "inactive": 0,
  "groups": [ { "code": "SALES_INVOICE", "text": "Sales invoice" }, { "code": "PURCHASE_INVOICE", "text": "Purchase invoice" }, { "code": "VOUCHERS", "text": "Vouchers" } ],
  "data": [
    { "key": "SALES", "group": "SALES_INVOICE", "groupText": "Sales invoice", "title": "Sales",
      "description": "The income account a sales invoice credits (the invoice amount before tax).", "usedBy": [ "Sales invoice" ],
      "accountType": "INCOME", "holdsParties": null, "standardName": "Sales",
      "status": "SET", "account": { "id": "uuid", "code": "4001", "name": "Sales", "isActive": true, "hasEntries": true }, "canChange": true },
    { "key": "CUSTOMERS", "group": "SALES_INVOICE", "title": "Accounts Receivable", "usedBy": [ "Sales invoice", "Receipt voucher", "Contra voucher" ],
      "accountType": "ASSET", "holdsParties": "CUSTOMER", "standardName": "Accounts Receivable",
      "status": "SET", "account": { "id": "uuid", "code": "1103", "name": "Accounts Receivable", "isActive": true, "hasEntries": true }, "canChange": false },
    { "key": "INPUT_TAX", "group": "PURCHASE_INVOICE", "title": "Sales Tax (Input)", "status": "NOT_SET", "account": null, "canChange": true, "standardName": "Input Sales Tax" }
  ] }
```
- Draw the items **grouped** by `group` (`groups` gives the order and the titles): **Sales invoice** (Sales, Sales Tax (Output), Accounts Receivable), **Purchase invoice** (Purchases / Cost of Goods Sold, Sales Tax (Input), Accounts Payable), **Vouchers** (Income Tax - Customers, Income Tax - Vendors, Customer Advances, Supplier Advances). The order of `data` is already the order of the screen.
- Each row: `title`, a small grey `description`, `usedBy` as chips, the **account**: `account.code` + `account.name` + the **id** (`account.id`; show it, e.g. in a "copy id" or "open in chart" link: opens `GET /accounts/:id` / the chart at that account), and a status badge from `status`:
  - `SET`: green, has an account;
  - `NOT_SET`: grey, `account` is `null`. The role has no account yet: show the two buttons **Choose account** and **Create standard account** (`standardName` is the name that would be made);
  - `INACTIVE`: red. The account that fills the role was switched off (by hand, before it became a default). Invoices that need it will answer `DEFAULT_ACCOUNT_INACTIVE`: tell the user to switch the account on in the chart.
- `missing` = how many roles have no account: show a banner "N default accounts are not set" with the button **Create all default accounts** (`POST /accounts/defaults/create-all`).
- `account.hasEntries`: the account already has postings.
- `canChange`: whether the **Change** button works. It is `false` for the accounts that hold balances of customers / vendors (`holdsParties` is `CUSTOMER` or `VENDOR`: Accounts Receivable, Accounts Payable, Customer Advances, Supplier Advances) **once they have entries**: their balances cannot be split over two accounts. Show the button disabled with the hint "This account already has entries; it cannot be replaced".
- `accountType` is the type the account must have (`ASSET`, `LIABILITY`, `INCOME`, `EXPENSE`).

### 3.2 Choosing an account
1. The user presses **Choose account** or **Change** on a row: call `GET /accounts/defaults/:key/candidates`:
```json
{ "key": "SALES", "title": "Sales", "currentAccountId": "uuid-or-null",
  "data": [ { "id": "uuid", "code": "4001", "name": "Sales", "accountType": "INCOME", "isActive": true, "hasEntries": true, "current": true },
            { "id": "uuid", "code": "4004", "name": "Fabric Sales", "accountType": "INCOME", "isActive": true, "hasEntries": false, "current": false } ] }
```
   The list has only accounts the server will accept (right type, not a folder, switched on, not a contra account, not already another default or a bank / cash account; for the customer / vendor roles also without entries that name nobody). Show `code - name`, mark `current`.
2. The user picks one: `PUT /accounts/defaults/:key` with `{ "accountId": "..." }`. The answer is the updated **role item** (same shape as one item of `data`). Replace the row with it and reload the chart tree if it is open.
3. What happens: the chosen account becomes the default (it is marked as a system account); the **old** default becomes an ordinary account again (it keeps its history and can be used, renamed or switched off like any account). Choosing the account that is already the default changes nothing.
4. To add an account first: the user can make a new account in the chart (`POST /accounts`, existing guide) and then choose it here. The wizard preset cards already exist.

### 3.3 Making the standard account
`POST /accounts/defaults/:key/create` (one role) or `POST /accounts/defaults/create-all` (all that are missing; the answer is `{ created: ["SALES", ...], missing, inactive, groups, data }`). The server makes the account in its usual folder (for example "Sales" inside "Income", "Accounts Payable" inside "Current Liabilities"), making the folders too if they are missing. If an ordinary account of the same name already exists in the chart (for example one the owner made earlier called "Sales") it is **adopted** as the default instead of making a second one. Calling it when the role already has an account changes nothing.

## 4. The 10 roles

| key | title | type | used by |
|---|---|---|---|
| `SALES` | Sales | income | Sales invoice |
| `OUTPUT_TAX` | Sales Tax (Output) | liability | Sales invoice |
| `CUSTOMERS` | Accounts Receivable | asset (holds customers) | Sales invoice, Receipt voucher, Contra voucher |
| `PURCHASES` | Purchases / Cost of Goods Sold | expense | Purchase invoice |
| `INPUT_TAX` | Sales Tax (Input) | asset | Purchase invoice |
| `SUPPLIERS` | Accounts Payable | liability (holds vendors) | Purchase invoice, Payment voucher, Contra voucher |
| `INCOME_TAX_CUSTOMERS` | Income Tax - Customers | asset | Receipt voucher |
| `INCOME_TAX_VENDORS` | Income Tax - Vendors | liability | Payment voucher |
| `CUSTOMER_ADVANCES` | Customer Advances | liability (holds customers) | Receipt voucher |
| `SUPPLIER_ADVANCES` | Supplier Advances | asset (holds vendors) | Payment voucher |

Bank and cash accounts are **not** defaults: the user chooses the bank or cash account on each voucher.

## 5. Errors (`422` unless written)

| code | When |
|---|---|
| `NOT_POSTING_ACCOUNT` | A folder was chosen. |
| `ACCOUNT_INACTIVE` | The account is switched off. |
| `DEFAULT_TYPE_MISMATCH` | The account has the wrong type for the role (for example an asset for Sales). |
| `ACCOUNT_IS_CONTRA` | A contra account (for example Sales Returns). |
| `ACCOUNT_HAS_OTHER_ROLE` | The account is already another default, or a bank / cash account. |
| `ACCOUNT_HAS_ENTRIES` | For a customer / vendor role: the account has entries that do not name a customer / vendor, so it cannot hold their balances. |
| `DEFAULT_IN_USE` | The current account of a customer / vendor role already has entries, so it cannot be replaced. `details`: `{ currentAccountId }`. |
| `DEFAULT_ACCOUNT_INACTIVE` | (From `POST .../create`) the role's account exists but is switched off. |
| `NOT_FOUND` (404) | The account is not in this company. |
| `VALIDATION_FAILED` (400) | Unknown `:key`, or `accountId` missing / not a uuid. |
| `FORBIDDEN` (403) | No `ACC_COA` service, or VIEW only on a write. |

## 6. How it fits the invoices (for the testers)

1. New company, empty chart: open the tab: all roles `NOT_SET`. Press **Create all default accounts** (or choose own accounts one by one).
2. Create and approve a sales invoice: its "Accounts" popup shows the accounts of the tab (same ids). The chart has **no extra accounts** besides the ones the user made or chose.
3. Change a role with no customer / vendor balances (for example `SALES`) to another account: new invoices post to the new account; old invoices stay on the old one (the history never moves).
4. The Accounts Receivable / Payable roles cannot be swapped after their first entry (`canChange: false`).
5. The Trial Balance checks follow the chosen accounts; nothing else to change.

---

## 7. IMPORTANT: the Chart of Accounts screen no longer makes default accounts (2026-10-28)

Default accounts are made and chosen **only in the Default Accounts tab**. They then show in the Chart of Accounts like any account (locked, with the lock icon). Everything else in the chart works as before. What changed on the Chart of Accounts screen:

- **`GET /accounts/presets`** (the "add account" cards) no longer returns the four cards that were default accounts: `customers_owe_us` (Accounts Receivable), `suppliers_we_owe` (Accounts Payable), `tax_payable` (Sales Tax Payable), `sales_income` (Sales). 18 cards remain. Remove those four cards from the wizard (the server also refuses them: `POST /accounts` with one of these `presetKey`s answers `422 USE_DEFAULT_ACCOUNTS`).
- **`POST /accounts` and `PATCH /accounts/:id`** answer **`422 USE_DEFAULT_ACCOUNTS`** (`details: { controlType }`) when `controlType` is one of the 10 default roles (`SALES`, `OUTPUT_TAX`, `CUSTOMERS`, `PURCHASES`, `INPUT_TAX`, `SUPPLIERS`, `INCOME_TAX_CUSTOMERS`, `INCOME_TAX_VENDORS`, `CUSTOMER_ADVANCES`, `SUPPLIER_ADVANCES`). Do not offer these in the "control type" dropdown of the chart form. `CASH`, `BANK` and `SRB_WITHHOLDING` stay available there (several cash / bank accounts are normal). `GET /accounts/options` still lists all control types; hide the 10 default ones in the account form.
- A default account already in the chart keeps its role; it can only be renamed or moved (unchanged). To make another account the default, use the Default Accounts tab (`PUT /accounts/defaults/:key`).
- In the chart tree and in `GET /accounts/:id` a default account has `isSystem: true` and `controlType` = its role (show the lock). A plain account that the owner wants as a default: make it normally in the chart (without a control type), then choose it in the Default Accounts tab.
- Business **templates** (`POST /accounts/apply-template`) still add the standard chart, including the default accounts, in one step on an empty chart. If the company already chose a default account in the tab, the template keeps it (it is reported in `skipped` with reason `SYSTEM_KEY_EXISTS`) and does not add a second one.
- The server still makes a missing default account by itself the first time an invoice or voucher needs it (so nothing is ever refused for a missing default). The tab is the place to make or choose them before that.

---

# Sales tax moves from the Store Inward to the Purchase Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). Small change, two screens: remove the tax option from the **store inward** screens, add a tax-rate field to the **purchase invoice** screen.

## 1. What and why

- Until now the chemical store inward had a bill type (GST / Other) and a GST % (the tax was entered in the store). The store people must not enter tax.
- From now on the **sales tax is chosen on the Purchase Invoice** (in Accounting), when the invoice is made. The invoice has one **Tax rate (%)** and the server works out the tax.
- The server already **ignores** any `billType`, `gstPercent` or `salesTax` sent to the store inward (so an old frontend does not break), but the fields must be removed from the screens.

## 2. Store inward screens (Chemical Store, and General Store if it shows the same fields): REMOVE

On the inward form (create / edit) and the inward list:
1. **Remove** the "Bill type" (GST / Other) dropdown, the **GST %** dropdown, and the **Sales tax** box. Do not send `billType`, `gstPercent`, `salesTax` in `POST /stores/:store/inwards` and `PATCH /stores/:store/inwards/:id` any more (if sent, the server ignores them).
2. `GET /stores/:store/inwards/form-data` now answers `billTypes: ["OTHER"]`, `gstRates: []` and `taxOnInward: false`. Do not build the bill-type or GST dropdowns from them; you can use `taxOnInward === false` to hide the fields.
3. The totals of an inward are now only the **amount** (qty x rate). Fields `salesTax`, `gstPercent`, `billType` still come in the answers (every new inward has `salesTax: 0`, `gstPercent: null`, `billType: "OTHER"`), so `billed` / `balance` equal the amount. Do not show the tax columns for new entries. **Older inwards** (made before this change) can still have a GST amount: if `salesTax > 0` show it as before (read only); do not hide it.
4. The list tabs "GST" / "Other" (`?tab=gst`, `?tab=other`): the GST tab only has older entries now. You may hide the tabs, or keep them for old data.

## 3. Purchase invoice screen (Accounting): ADD the tax rate

1. New field **Tax rate (%)** on the form header (same idea as the sales invoice's tax rate). Dropdown (or typed number): values from `GET /purchase-invoices/options` -> `taxRates: [0, 5, 10, 15, 17, 18]`; default `defaultTaxRate: 0`. Any number from 0 to 100 (2 decimals) is accepted.
2. Send it as a **number** (not a string): `POST /purchase-invoices` and `PATCH /purchase-invoices/:id`:
```json
{ "vendorId": "uuid", "inwardIds": ["uuid", "uuid"], "invoiceDate": "2026-10-24", "billNo": "S-123", "taxRate": 18 }
```
`taxRate` is optional (0 if left out). On `PATCH` it can be changed while the invoice is **un-approved**; after Approve the invoice is locked (`INVOICE_APPROVED`) until it is un-approved.
3. The invoice answers (`GET /purchase-invoices`, `GET /purchase-invoices/:id`, create / update / approve) now have **`taxRate`** next to `gross`, `tax`, `net`. Show `taxRate` in the header and bind the field to it when editing. `gross` = total of the purchase amounts, `tax` = the sales tax, `net` = gross + tax. Show them as received; do not work the tax out in the browser (you may show a live preview, the server's numbers are the real ones).
4. **How the tax is worked out** (for the preview and the explanation):
   - each purchase (store inward) on the invoice that has **no tax of its own** gets `amount x taxRate / 100` (rounded to 2 decimals **per purchase**); the invoice tax is the sum;
   - an **older** inward that still carries its own GST **keeps it** and is **not** taxed again by the invoice rate (no double tax);
   - so for new inwards: `tax = sum of round(amount x rate / 100)` over the lines; every line in `lines[]` shows its own `salesTax` (the tax share of that line) and `net`.
   Example: purchases 200 and 500, rate 18 % -> line taxes 36 and 90 -> tax 126, net 826.
5. **Picker of purchases** (`GET /purchase-invoices/inwards?vendorId=`): each purchase shows `amount`, `salesTax` and `net` of the **inward** only. For new inwards `salesTax` is 0 there; do not show it as the tax of the invoice. The tax appears on the invoice after the rate is chosen. When the user changes the Tax rate, update the totals from the server's answer to `PATCH` (or call it on Save).
6. **Approve** posts the invoice as before: Debit Purchases (gross), Debit Input Sales Tax (tax, only if tax > 0), Credit Accounts Payable (net). Nothing else changes in the accounts, the Trial Balance, ledgers or reports.

## 4. Errors

| code | When |
|---|---|
| `VALIDATION_FAILED` (400) | `taxRate` below 0, above 100, with more than 2 decimals, or sent as text (`"18"`). Send a number. |
| `INVOICE_APPROVED` (422) | Changing the tax rate of an approved invoice: un-approve it first. |

## 5. Build checklist

1. Store inward form: remove Bill type, GST %, Sales tax; stop sending them; hide the tax columns for new entries (still show a tax amount of an older inward when it is more than 0).
2. Purchase invoice form: add Tax rate (default 0), send it on create and update, show `taxRate`, `tax` and `net` from the answer.
3. Test: make a chemical inward without tax (amount 1,000); on a purchase invoice choose 17 % -> tax 170, net 1,170; Approve -> the Accounts popup shows Purchases 1,000, Input Sales Tax 170, Accounts Payable 1,170. Change the rate before approving and the totals follow.

---

# "Others" on the Sales Invoice and the Purchase Invoice: frontend guide

Written for: the frontend developer (and the AI that helps them). Both invoice forms get two new fields: **Others** (an amount) and **Others note** (what it is for).

## 1. The idea in plain words

- **Purchase invoice:** the vendor's goods came damaged or short. The owner types the amount in **Others** and the **bill becomes smaller** by that amount (we pay the vendor less). The note says why ("Damaged bags").
- **Sales invoice:** an extra charge for the customer (packing, freight ...). The owner types the amount in **Others** and the **bill becomes bigger** by that amount. The note says why.
- Both fields are **optional** (0 and empty by default). It is a plain amount, **not a percentage**.
- **No tax is worked out on Others**: the sales tax stays on the goods amount (`gross`) only.

## 2. Fields (both invoices)

Send on `POST /sales-invoices` / `PATCH /sales-invoices/:id` and on `POST /purchase-invoices` / `PATCH /purchase-invoices/:id`:

| Field | Meaning |
|---|---|
| `othersAmount` | The others amount, **zero or more** (never negative: the invoice type decides the direction). A number with at most 2 decimals (`500.5`) or a decimal string (`"500.50"`). More than 2 decimals, a negative number, text or `null` = `400 VALIDATION_FAILED`. To remove it send `0`. |
| `othersNote` | Free text, up to 300 characters: what the amount is for. Optional (you may make it required in the screen when the amount is more than 0; the server does not force it). |

Example (purchase): `{ "othersAmount": 100, "othersNote": "Damaged bags" }`. On `PATCH` send only what changed; `othersNote` stays as it was when you do not send it. Changing it is possible only while the invoice is **un-approved** (after Approve: `422 INVOICE_APPROVED`; un-approve first).

## 3. What the invoice answers (list, `GET /:id`, create, update, approve)

New fields on **both** invoices:
```json
{ "othersAmount": 100, "othersNote": "Damaged bags", "othersEffect": "DEDUCT" }
```
- `othersEffect` is `"DEDUCT"` on a **purchase** invoice (it reduces the bill) and `"ADD"` on a **sales** invoice (it increases the bill). Use it for the label and the sign, e.g. **"Others (deducted)"** with `- 100.00` on purchases, **"Others (added)"** with `+ 100.00` on sales. Show the note next to it.
- Totals (every number is the server's, show them as received):

| Invoice | gross | tax | net (the bill) |
|---|---|---|---|
| Purchase | the purchases | on the purchases only | `gross + tax - othersAmount` |
| Sales | the gate passes | `gross x taxRate / 100` | `gross + tax + othersAmount` |

  Example purchase: gross 700, tax 0, others 100 -> **net 600**. Example sales: gross 11,200, tax 2,016, others 500 -> **net 13,716**.
- `net` is what the customer owes / what we owe the vendor, so `balance`, `paymentStatus`, the payments, the balances and the reports all use `net` (nothing else to change).
- In the totals block of the form add one row **Others** between **Tax** and **Net**. A live preview while typing is fine; the real numbers come from the server's answer to Save.

## 4. The "Accounts" popup (what is posted at Approve)

- **Sales invoice** with others 500 (gross 11,200, tax 2,016): Debit Accounts Receivable 13,716 (customer named); Credit Sales 11,200; **Credit Sales 500** (a separate line, narration "... others - <note>"); Credit Output Sales Tax 2,016.
- **Purchase invoice** with others 100 (gross 700): Debit Purchases 700; **Credit Purchases 100** (a separate line, narration "... others - <note>"); Credit Accounts Payable 600 (vendor named). With tax, the Input Sales Tax debit sits between them.
- Both lines of others are on the same default account (Sales / Purchases), so no new account is needed and the Chart of Accounts does not change. When others is 0 there is no extra line. Show the lines as they come in `accounts-entry` (nothing to compute).

## 5. Errors

| code | When |
|---|---|
| `OTHERS_MORE_THAN_BILL` (422) | **Purchase invoice only:** others is more than the bill (`gross + tax`). `details`: `{ others, bill }`. Show "Others cannot be more than the bill". |
| `VALIDATION_FAILED` (400) | `othersAmount` negative, with more than 2 decimals, not a number, or `null`. |
| `INVOICE_APPROVED` (422) | Changing others of an approved invoice. |

## 6. Build checklist

1. Both invoice forms: add **Others** (number box, default 0) and **Others note** (text) near the totals; send them on create and update; bind to `othersAmount` / `othersNote` when editing.
2. Totals block: a row **Others** with the sign from `othersEffect` (`DEDUCT` = minus, `ADD` = plus); **Net** from the server.
3. Purchase form: handle `OTHERS_MORE_THAN_BILL`.
4. Test: purchase invoice of 700, others 100 "Damaged bags" -> net 600; Approve -> the Accounts popup has Purchases 700 Dr, Purchases 100 Cr, Accounts Payable 600 Cr. Sales invoice of 13,216, others 500 -> net 13,716; Approve -> Accounts Receivable 13,716 Dr, Sales 11,200 Cr, Sales 500 Cr, Output Sales Tax 2,016 Cr. Un-approve, set others to 0, approve again: no extra line.

---

## 8. Where default accounts come from, and how they show in the Chart (summary for the screens)

A default account can appear in **three ways**; in every case it is a normal account of the **Chart of Accounts** (same `id`, shown with the lock icon, `isSystem: true`) and it is listed in the Default Accounts tab:

1. **From the Default Accounts tab** (the main way): `POST /accounts/defaults/:key/create` or `POST /accounts/defaults/create-all`, or the owner chooses an existing account with `PUT /accounts/defaults/:key`. After the call, reload the tab (the answer is the updated item) and, if the Chart of Accounts screen is open, reload the tree (`GET /accounts/tree`).
2. **Automatically by an invoice or voucher:** when a sales / purchase invoice is **saved** (and again when it is approved), or a voucher is saved / confirmed, the server looks for the account of each role it needs. If the role has an account (made in the tab, or chosen by the owner) it is used. If the role has **none, the server makes the standard account by itself** (inside its usual folder; the folders are made too if missing) and posts to it. Nothing is refused for a missing default. So after saving an invoice for the first time, **refresh both the Default Accounts tab and the Chart of Accounts**: new accounts may have appeared. (Tip: reload them when the invoice screen closes, or when the user opens either screen.)
3. **By a business template** applied on an empty chart (`POST /accounts/apply-template`): the template includes the standard default accounts.

Rules that never change: one account per role; an account the owner chose in the tab is always used instead of making a new one; Accounts Receivable / Payable / Advances cannot be swapped once they have entries; the Chart of Accounts screen itself does not assign default roles (section 7).


---

# Credit limit, credit days, due dates and the Due Schedule: frontend guide

Written for: the frontend developer (and the AI that helps them). This adds credit terms to the customer and vendor forms, a due date and a credit-limit warning to both invoices, and one new report ("Due schedule").

## 1. The idea in plain words

- **Credit days** (customers AND vendors): how many days after the invoice date the money is due. A customer with 30 days: invoice of 1 Oct is due on 31 Oct. For a vendor it is how long the vendor gives us.
- **Credit limit** (customers; vendors too but **optional**): the most a party may owe. Empty = no limit.
  - Customer: how much the customer may owe **us**.
  - Vendor: how much **we** may owe the vendor. Most companies leave it empty.
- The credit limit only **WARNS**. It never blocks anything: the invoice is saved and approved, and the server adds a `creditWarning` that the screen shows in yellow.
- Credit terms live on the **party form** (set once). Not on the inward and not on the voucher.

## 2. Customer form and Vendor form

Two new fields on `POST/PATCH /customers` and `POST/PATCH /vendors` (and in every answer of those and in the lists):

| Field | Meaning |
|---|---|
| `creditLimit` | A number with at most 2 decimals, `0` or more, or `null` / empty = no limit. Answer: a number or `null`. |
| `creditDays` | A whole number, `0` to `3650`. `0` = due the same day. Always a number in the answer (default `0`). Not `null`, not a string. |

- Send `creditLimit: null` to clear a limit. `0` is a real limit of zero (every sale warns), so do not send `0` for "empty".
- Wrong values (negative, text, more than 2 decimals, `creditDays` with a fraction) = `400 VALIDATION_FAILED`.
- Show **Credit limit** (optional, hint "empty = no limit") and **Credit days** (default 0) on both forms. For vendors you may keep the limit field small or under "More".

## 3. Sales invoice and Purchase invoice

### 3.1 Due date
- Both invoices have `dueDate` (`YYYY-MM-DD`, always in the answer). Send it on `POST` / `PATCH` to type your own; the server checks `dueDate >= invoiceDate` (else `422 DUE_BEFORE_DATE`).
- **Not sent (or empty)** = the server works it out: `invoiceDate + the party's creditDays`. With `creditDays = 0` the due date is the invoice date.
- On `PATCH`:
  - `dueDate` sent with a date: that date is used.
  - `dueDate` sent as `""` / `null`: worked out again from the credit days.
  - `dueDate` not sent: it stays, **except** when `invoiceDate` or the customer / vendor changes: then it is worked out again.
  - So on an edit form send the `dueDate` the user sees (pre-filled from the invoice); if they change the invoice date, clear the due date field or let it refresh from the answer.
- On the form: when the customer / vendor or the invoice date changes, preview `dueDate = invoiceDate + creditDays` (take `creditDays` from the party or from section 3.3) and let the user override it.
- Lists and `GET /:id` also have **`isOverdue`** (boolean): the invoice is approved, still has a balance and its due date is before today. Use it for a red "Overdue" badge.

### 3.2 Credit-limit warning: `creditWarning`
Every invoice answer (create, update, `GET /:id`, approve) has `creditWarning`:
```json
null
```
or, when the party is over the limit:
```json
{ "code": "CREDIT_LIMIT_EXCEEDED", "message": "This customer is over the credit limit: 13216.00 against a limit of 10000.00",
  "creditLimit": "10000.00", "balance": "0.00", "thisInvoice": "13216.00", "afterInvoice": "13216.00", "exceededBy": "3216.00" }
```
- `balance` = what the party owes us (customer) / we owe the party (vendor) today, from the books (so opening balances, receipts, payments and advances count). `thisInvoice` = this invoice while it is **un-approved** (it is not in the books yet); `0.00` once it is approved (already inside `balance`). `exceededBy` = how much is over the limit.
- `null` = no limit set, or within it. Money values are strings with 2 decimals.
- **Show it** as a yellow banner on the invoice screen ("Credit limit exceeded by 3,216.00") and keep **Save** and **Approve** enabled. Optionally ask "Continue?" before Approve.
- Sales invoice: warning about the **customer**. Purchase invoice: about the **vendor** (only when he has a limit).
- The warning stays on an approved invoice while the party is over the limit, so use it as information in the invoice screen, not as an error.

### 3.3 Credit status for the form (before saving)
- `GET /sales-invoices/credit/:customerId` (service ACC_SALES, VIEW) and `GET /purchase-invoices/credit/:vendorId` (service ACC_PURCHASES, VIEW):
```json
{ "partyType": "CUSTOMER", "partyId": "...", "code": 12, "name": "AZ TEXTILES",
  "creditLimit": "100000.00", "creditDays": 10, "balance": "40000.00", "available": "60000.00", "exceeded": false, "exceededBy": null }
```
- `creditLimit` and `available` are `null` when there is no limit. `available` is negative when the party is already over. Call it when the user picks the customer / vendor and show "Limit 100,000 · Owes 40,000 · Available 60,000 · Credit days 10". `404` = party not found (or of another company).

## 4. New report: Due schedule

`GET /accounting/due-schedule` (service **ACC_REPORTS**, VIEW). It answers "how much money is due to come in and go out in the next 15 days, 30 days ..." and also what is already overdue.

Query (all optional): `date` (default today; the "as of" day), `buckets` (comma list of day limits, default `15,30,60`; 1 to 3650, up to 8 numbers, e.g. `7,14,30`), `search` (party name, NTN, CNIC, code, invoice no, bill no), `detail=true` (also return the document lines).

Only **unpaid balances of approved invoices / bills** are counted (a part-paid invoice counts its remaining balance). The bucket of a document = `dueDate - date` in days.

Answer:
```json
{
  "date": "2026-10-29", "bucketDays": [15, 30, 60],
  "receivable": {
    "total": "63000.00", "count": 6, "overdue": "17000.00", "notYetDue": "46000.00",
    "buckets": [
      { "key": "OVERDUE_OVER_60", "label": "Overdue over 60 days", "side": "OVERDUE", "count": 0, "balance": "0.00" },
      { "key": "OVERDUE_31_60",   "label": "Overdue 31-60 days",   "side": "OVERDUE", "count": 1, "balance": "16000.00" },
      { "key": "OVERDUE_16_30", ... }, { "key": "OVERDUE_1_15", ... },
      { "key": "DUE_TODAY", "label": "Due today", "side": "TODAY", "count": 1, "balance": "8000.00" },
      { "key": "DUE_1_15",  "label": "Due in 1-15 days",  "side": "UPCOMING", "count": 1, "balance": "2000.00", "upToDays": 15, "cumulative": "10000.00" },
      { "key": "DUE_16_30", "label": "Due in 16-30 days", "side": "UPCOMING", "count": 1, "balance": "4000.00", "upToDays": 30, "cumulative": "14000.00" },
      { "key": "DUE_31_60", ... }, { "key": "DUE_AFTER_60", "label": "Due after 60 days", ... }
    ],
    "parties": [ { "partyId": "...", "code": 2, "name": "BILAL", "count": 4, "total": "60000.00", "buckets": { "OVERDUE_31_60": "16000.00", "DUE_TODAY": "8000.00", "DUE_1_15": "0.00", "...": "..." } } ],
    "documents": [ ... only with detail=true ... ]
  },
  "payable": { "...": "the same shape for vendors" },
  "net": [ { "key": "DUE_1_15", "label": "Due in 1-15 days", "balance": "1250.00" } ],
  "netTotal": "62250.00"
}
```
- `receivable` = money to come in from customers, `payable` = money to go out to vendors, `net` = receivable minus payable in every bucket (same order and keys as `buckets`; negative = more to pay than to receive). `netTotal` is the sum.
- **Buckets are in screen order** (oldest overdue first, then today, then the coming ones). Render them as columns; use `side` for the colour (OVERDUE red, TODAY amber, UPCOMING normal). The bucket keys depend on `buckets` (e.g. `DUE_1_7`), so loop over the answer, do not hard-code keys.
- `cumulative` (UPCOMING buckets only) is the running total up to that bucket **including due today**: "next 15 days: 10,000.00", "next 30 days: 14,000.00".
- `parties[].buckets` is an object `{ bucketKey: amount }` (every key present, `"0.00"` when empty): one table row per party with a column per bucket.
- `documents` (only with `detail=true`, otherwise absent), most overdue first: `{ bucket, id, label, billNo, date, dueDate, daysToDue (negative = overdue), partyId, partyName, amount, balance }`. Use it for the click-through list of a bucket (filter by `bucket`) or party (filter by `partyId`); `label` is the invoice no (sales) / voucher no (purchase).
- Suggested screen: date picker + bucket days box, two tables (Receivable / Payable) with the bucket columns and a total row, a third "Net" row, click a number to open the list of that bucket.

`dueDate` was also added to the document lines of `GET /accounting/cutoff?detail=true` and `GET /accounting/balances/open-items` (so those lists can show a Due column).

## 5. Old invoices
- Invoices made before this change have no stored due date: the server shows `invoiceDate + the party's creditDays` (so with `creditDays = 0` they are due on their invoice date and show as overdue once the date passes). Set the credit days on the party and the old invoices follow.

## 6. Build checklist
1. Customer form and vendor form: **Credit limit** (optional) and **Credit days**; show them in the lists if you like.
2. Sales and purchase invoice forms: **Due date** field (pre-filled invoice date + credit days, editable); send it only if the user typed it, or send the shown value.
3. Invoice screens: yellow banner from `creditWarning` (never block Save / Approve); red "Overdue" badge from `isOverdue`; due date column in the invoice lists.
4. On picking a customer / vendor call the `credit/:id` endpoint and show limit, balance, available and credit days.
5. New screen: **Due schedule** (receivable / payable / net by bucket, party rows, click-through with `detail=true`).
6. Test: customer limit 10,000 and 30 days; a sales invoice of 13,216 on 24 Oct -> due date 23 Nov and a warning "exceeded by 3,216"; Save and Approve still work. Vendor with no limit -> never a warning. Due schedule on 29 Oct shows an invoice due 5 Nov under "Due in 1-15 days".
