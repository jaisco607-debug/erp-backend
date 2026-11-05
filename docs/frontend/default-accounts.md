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

## 7. IMPORTANT: the Chart of Accounts screen no longer makes default accounts (2026-10-28)

Default accounts are made and chosen **only in the Default Accounts tab**. They then show in the Chart of Accounts like any account (locked, with the lock icon). Everything else in the chart works as before. What changed on the Chart of Accounts screen:

- **`GET /accounts/presets`** (the "add account" cards) no longer returns the four cards that were default accounts: `customers_owe_us` (Accounts Receivable), `suppliers_we_owe` (Accounts Payable), `tax_payable` (Sales Tax Payable), `sales_income` (Sales). 18 cards remain. Remove those four cards from the wizard (the server also refuses them: `POST /accounts` with one of these `presetKey`s answers `422 USE_DEFAULT_ACCOUNTS`).
- **`POST /accounts` and `PATCH /accounts/:id`** answer **`422 USE_DEFAULT_ACCOUNTS`** (`details: { controlType }`) when `controlType` is one of the 10 default roles (`SALES`, `OUTPUT_TAX`, `CUSTOMERS`, `PURCHASES`, `INPUT_TAX`, `SUPPLIERS`, `INCOME_TAX_CUSTOMERS`, `INCOME_TAX_VENDORS`, `CUSTOMER_ADVANCES`, `SUPPLIER_ADVANCES`). Do not offer these in the "control type" dropdown of the chart form. `CASH`, `BANK` and `SRB_WITHHOLDING` stay available there (several cash / bank accounts are normal). `GET /accounts/options` still lists all control types; hide the 10 default ones in the account form.
- A default account already in the chart keeps its role; it can only be renamed or moved (unchanged). To make another account the default, use the Default Accounts tab (`PUT /accounts/defaults/:key`).
- In the chart tree and in `GET /accounts/:id` a default account has `isSystem: true` and `controlType` = its role (show the lock). A plain account that the owner wants as a default: make it normally in the chart (without a control type), then choose it in the Default Accounts tab.
- Business **templates** (`POST /accounts/apply-template`) still add the standard chart, including the default accounts, in one step on an empty chart. If the company already chose a default account in the tab, the template keeps it (it is reported in `skipped` with reason `SYSTEM_KEY_EXISTS`) and does not add a second one.
- The server still makes a missing default account by itself the first time an invoice or voucher needs it (so nothing is ever refused for a missing default). The tab is the place to make or choose them before that.

## 8. Where default accounts come from, and how they show in the Chart (summary for the screens)

A default account can appear in **three ways**; in every case it is a normal account of the **Chart of Accounts** (same `id`, shown with the lock icon, `isSystem: true`) and it is listed in the Default Accounts tab:

1. **From the Default Accounts tab** (the main way): `POST /accounts/defaults/:key/create` or `POST /accounts/defaults/create-all`, or the owner chooses an existing account with `PUT /accounts/defaults/:key`. After the call, reload the tab (the answer is the updated item) and, if the Chart of Accounts screen is open, reload the tree (`GET /accounts/tree`).
2. **Automatically by an invoice or voucher:** when a sales / purchase invoice is **saved** (and again when it is approved), or a voucher is saved / confirmed, the server looks for the account of each role it needs. If the role has an account (made in the tab, or chosen by the owner) it is used. If the role has **none, the server makes the standard account by itself** (inside its usual folder; the folders are made too if missing) and posts to it. Nothing is refused for a missing default. So after saving an invoice for the first time, **refresh both the Default Accounts tab and the Chart of Accounts**: new accounts may have appeared. (Tip: reload them when the invoice screen closes, or when the user opens either screen.)
3. **By a business template** applied on an empty chart (`POST /accounts/apply-template`): the template includes the standard default accounts.

Rules that never change: one account per role; an account the owner chose in the tab is always used instead of making a new one; Accounts Receivable / Payable / Advances cannot be swapped once they have entries; the Chart of Accounts screen itself does not assign default roles (section 7).
