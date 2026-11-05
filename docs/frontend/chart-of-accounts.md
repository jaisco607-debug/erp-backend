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
