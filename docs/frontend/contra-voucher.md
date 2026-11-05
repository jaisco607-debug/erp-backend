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
